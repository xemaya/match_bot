import { z } from 'zod';
import type { JudgeReport, Round } from './schema.js';

/** OpenAI-compatible chat completion; the judge is a different model from the generator. */
export interface JudgeClient {
  model: string;
  complete(p: { system: string; user: string }): Promise<string>;
}

export function createJudgeClient(p: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}): JudgeClient {
  const fetchImpl = p.fetchImpl ?? fetch;
  return {
    model: p.model,
    async complete({ system, user }) {
      const res = await fetchImpl(p.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + p.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: p.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok)
        throw new Error('judge_http_' + res.status + ': ' + (await res.text()).slice(0, 200));
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('judge_empty_response');
      return content;
    },
  };
}

/** Deterministic shuffle so a round judged twice mixes the same way. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function parseJson<T>(schema: z.ZodType<T>, raw: string): T {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const start = text.search(/[[{]/);
  return schema.parse(JSON.parse(start >= 0 ? text.slice(start) : text) as unknown);
}

/** Rank-based AUC: probability that a random bot line scores above a random human line. */
export function auc(bot: number[], human: number[]): number {
  if (!bot.length || !human.length) return 0;
  let wins = 0;
  for (const b of bot) for (const h of human) wins += b > h ? 1 : b === h ? 0.5 : 0;
  return wins / (bot.length * human.length);
}

const BLIND_SYSTEM =
  '你是语言风格鉴别员。下面是一个伦敦华人生活群里的消息，每条要么是群成员在手机上随手打的，要么是一个机器人助手发的。' +
  '机器人的内容可能很有用，但请只看说话方式：断句、标点、语气、信息密度、是否像在接话。' +
  '对每条给出"是机器人"的概率 0–100 和一句理由。只输出 JSON 数组：[{"id": "...", "bot_probability": 0-100, "reason": "..."}]，不要其他文字。';

const RATING_SYSTEM =
  '你是群聊语感评审。给你一条群消息和一位热心群友对它的回复。请按"像不像一个住在东伦敦、熟悉本地的朋友随手回的"打 1–5 分：' +
  '5 分完全像群里的人，3 分内容对但口气像客服或信息台，1 分像报告。' +
  '再从这些类别里选一个最主要的问题：信息量过多、汇报检索过程、书面标点、没接情绪、套路句式、过度但书、卡不该出现、答非所问、无明显问题。' +
  '只输出 JSON 数组：[{"id": "...", "score": 1-5, "main_issue": "...", "reason": "一句话"}]。';

const blindSchema = z.array(
  z.object({ id: z.string(), bot_probability: z.number().min(0).max(100), reason: z.string() }),
);
const ratingSchema = z.array(
  z.object({
    id: z.string(),
    score: z.number().min(1).max(5),
    main_issue: z.string(),
    reason: z.string(),
  }),
);

export async function judgeRound(p: {
  round: Round;
  client: JudgeClient;
  seed?: number;
}): Promise<JudgeReport> {
  const seed = p.seed ?? 20261022;
  const bots = p.round.cases.filter((c) => c.line.trim());
  const humansAll = p.round.humans.filter((h) => h.replyLike && h.text.trim().length >= 6);
  const humans = seededShuffle(humansAll, seed).slice(0, bots.length);
  const pool = seededShuffle(
    [
      ...bots.map((c, i) => ({ key: 'b' + i, isBot: true, text: c.line })),
      ...humans.map((h, i) => ({ key: 'h' + i, isBot: false, text: h.text })),
    ],
    seed + 1,
  );
  const blindRaw = await p.client.complete({
    system: BLIND_SYSTEM,
    user: pool.map((x, i) => JSON.stringify({ id: 'm' + (i + 1), text: x.text })).join('\n'),
  });
  const blind = parseJson(blindSchema, blindRaw);
  const byId = new Map(blind.map((b) => [b.id, b]));
  const items = pool.map((x, i) => {
    const v = byId.get('m' + (i + 1));
    return {
      key: x.key,
      isBot: x.isBot,
      text: x.text,
      botProbability: v?.bot_probability ?? 50,
      reason: v?.reason ?? 'missing',
    };
  });
  const botP = items.filter((i) => i.isBot).map((i) => i.botProbability);
  const humanP = items.filter((i) => !i.isBot).map((i) => i.botProbability);
  const correct = items.filter((i) => i.botProbability >= 50 === i.isBot).length;

  const ratingRaw = await p.client.complete({
    system: RATING_SYSTEM,
    user: bots.map((c) => JSON.stringify({ id: c.id, asked: c.asked, reply: c.line })).join('\n'),
  });
  const ratings = parseJson(ratingSchema, ratingRaw).map((r) => ({
    id: r.id,
    score: r.score,
    mainIssue: r.main_issue,
    reason: r.reason,
  }));
  const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  return {
    version: 1,
    round: p.round.name,
    model: p.client.model,
    seed,
    judgedAt: new Date().toISOString(),
    blind: {
      n: items.length,
      accuracy: items.length ? Math.round((correct / items.length) * 1000) / 1000 : 0,
      auc: Math.round(auc(botP, humanP) * 1000) / 1000,
      botMeanProbability: Math.round(mean(botP)),
      humanMeanProbability: Math.round(mean(humanP)),
      items,
    },
    ratings,
    meanScore: Math.round(mean(ratings.map((r) => r.score)) * 100) / 100,
  };
}

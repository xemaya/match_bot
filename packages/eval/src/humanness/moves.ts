import { z } from 'zod';
import { parseJson, type JudgeClient } from './judge.js';
import type { Round } from './schema.js';

/**
 * P53 "群里时刻": was A2H's move (silence, a half line, or an answer) the right one for that moment
 * in the group? The judge sees the recent member lines and the ask, names the ideal move, and says
 * whether A2H's actual move fits. Complements the 1–5 wording score, which only sees replies.
 */
export const MOVES = ['silent', 'react', 'brief', 'refer', 'answer'] as const;
export type Move = (typeof MOVES)[number];

const movesSchema = z.array(
  z.object({
    id: z.string(),
    ideal: z.enum(MOVES),
    fits: z.boolean(),
    reason: z.string(),
  }),
);

export const movesReportSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  recorded: z.string(),
  model: z.string(),
  judgedAt: z.string(),
  n: z.number().int(),
  fitRate: z.number(),
  wrongSpeak: z.number().int(),
  missedAnswer: z.number().int(),
  items: z.array(
    z.object({
      id: z.string(),
      asked: z.string(),
      actual: z.enum(MOVES),
      line: z.string(),
      ideal: z.enum(MOVES),
      fits: z.boolean(),
      reason: z.string(),
    }),
  ),
});
export type MovesReport = z.infer<typeof movesReportSchema>;

const MOVES_SYSTEM = [
  'You judge group-chat manners for A2H, a helper account that sits in a Telegram group of Chinese students in London.',
  'For each item you get the last few member lines before a message, the message itself, and what A2H did (its line, or silence).',
  'Name the ideal move for A2H at that moment: silent (members are handling it, it is chit-chat, or someone already answered), react (a thanks/ok), brief (a short fact-free line: catch the mood, ask back one thing), refer (point the asker to a member who offered or knows), answer (concrete facts or options are what helps).',
  'Then say whether A2H’s actual move fits the moment (a different move can still fit). Judge the move, not the wording.',
  'Reply with JSON only: an array of {"id","ideal","fits","reason"}; reason in Chinese, at most 40 characters.',
].join('\n');

/** A reply with a card, links or more than a short line is an answer; otherwise a half line. */
export function classifyMove(line: string | null, hasCardOrLinks: boolean): Move {
  if (line === null) return 'silent';
  if (/^[\p{Extended_Pictographic}\s]{1,4}$/u.test(line)) return 'react';
  return hasCardOrLinks || line.length > 40 ? 'answer' : 'brief';
}

export async function judgeMoves(p: {
  source: Round;
  recorded: Round;
  client: JudgeClient;
}): Promise<MovesReport> {
  const rows = p.source.cases.map((ask, i) => {
    const reply = p.recorded.cases.find((c) => c.asked === ask.asked);
    const at = ask.askedAt ? Date.parse(ask.askedAt) : NaN;
    const before = p.source.humans
      .filter((h) => {
        const t = Date.parse(h.at);
        return Number.isFinite(at) && t < at && at - t < 30 * 60e3;
      })
      .slice(-8)
      .map((h) => `${h.alias}: ${h.text}`);
    const line = reply ? reply.line : null;
    return {
      id: 'q' + (i + 1),
      asked: ask.asked,
      actual: classifyMove(line, !!reply && (!!reply.card || reply.links.length > 0)),
      line: line ?? '',
      before,
    };
  });
  const raw = await p.client.complete({
    system: MOVES_SYSTEM,
    user: rows
      .map((r) =>
        JSON.stringify({
          id: r.id,
          recentLines: r.before,
          message: r.asked,
          a2h: r.line || '(silent)',
        }),
      )
      .join('\n'),
  });
  const verdicts = new Map(parseJson(movesSchema, raw).map((v) => [v.id, v]));
  const items = rows.map((r) => {
    const v = verdicts.get(r.id);
    return {
      id: r.id,
      asked: r.asked,
      actual: r.actual,
      line: r.line,
      ideal: v?.ideal ?? 'answer',
      fits: v?.fits ?? false,
      reason: v?.reason ?? 'missing',
    };
  });
  return {
    version: 1,
    source: p.source.name,
    recorded: p.recorded.name,
    model: p.client.model,
    judgedAt: new Date().toISOString(),
    n: items.length,
    fitRate: items.length
      ? Math.round((items.filter((i) => i.fits).length / items.length) * 1000) / 1000
      : 0,
    wrongSpeak: items.filter((i) => i.ideal === 'silent' && i.actual !== 'silent' && !i.fits)
      .length,
    missedAnswer: items.filter(
      (i) => (i.ideal === 'answer' || i.ideal === 'refer') && i.actual === 'silent' && !i.fits,
    ).length,
    items,
  };
}

import { describe, expect, it } from 'vitest';
import {
  auc,
  createJudgeClient,
  judgeRound,
  parseJson,
  seededShuffle,
} from '../src/humanness/judge.js';
import type { Round } from '../src/humanness/schema.js';
import { z } from 'zod';

const round: Round = {
  version: 1,
  name: 'r',
  generatedAt: '2026-10-22T00:00:00Z',
  source: 'db',
  agentVersion: '0.33.0',
  window: null,
  cases: [
    {
      id: 'c1',
      sourceMessageId: null,
      asked: '有人出打印机吗',
      askedAt: null,
      authorAlias: null,
      kind: 'recommendation',
      status: 'sent',
      text: 'Mile End 附近这次没刷到。',
      line: 'Mile End 附近这次没刷到。',
      card: null,
      links: [],
    },
    {
      id: 'c2',
      sourceMessageId: null,
      asked: '喂猫',
      askedAt: null,
      authorAlias: null,
      kind: 'recommendation',
      status: 'sent',
      text: '狗岛这边找 Jana 比较对路：',
      line: '狗岛这边找 Jana 比较对路：',
      card: null,
      links: [],
    },
  ],
  humans: [
    {
      alias: 'a',
      at: '2026-10-22T00:00:00Z',
      text: '@老陈 31号有空就过去搭把手 管饭这条我先记着哈',
      replyLike: true,
    },
    {
      alias: 'b',
      at: '2026-10-22T00:00:00Z',
      text: '@小林 我楼里最近没人出打印机 有的话我第一时间喊你',
      replyLike: true,
    },
    { alias: 'c', at: '2026-10-22T00:00:00Z', text: '找房更新一下', replyLike: false },
  ],
};

describe('humanness judge', () => {
  it('shuffles the same way for the same seed and computes a rank AUC', () => {
    expect(seededShuffle([1, 2, 3, 4, 5], 7)).toEqual(seededShuffle([1, 2, 3, 4, 5], 7));
    expect(seededShuffle([1, 2, 3, 4, 5], 7)).not.toEqual([1, 2, 3, 4, 5]);
    expect(auc([90, 80], [10, 20])).toBe(1);
    expect(auc([50], [50])).toBe(0.5);
  });
  it('parses fenced JSON', () => {
    expect(parseJson(z.array(z.number()), '```json\n[1,2]\n```')).toEqual([1, 2]);
  });
  it('mixes bot and member lines, asks the judge twice and scores blind accuracy', async () => {
    const calls: string[] = [];
    const fetchImpl = ((_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { messages: Array<{ content: string }> };
      calls.push(body.messages[0]!.content);
      const user = body.messages[1]!.content;
      const content = user.includes('"reply"')
        ? JSON.stringify([
            { id: 'c1', score: 2, main_issue: '汇报检索过程', reason: 'x' },
            { id: 'c2', score: 3, main_issue: '书面标点', reason: 'y' },
          ])
        : JSON.stringify(
            user.split('\n').map((l) => {
              const { id, text } = JSON.parse(l) as { id: string; text: string };
              return { id, bot_probability: /[。：]/.test(text) ? 90 : 10, reason: 'punct' };
            }),
          );
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content } }] }),
        text: () => Promise.resolve(''),
      };
    }) as unknown as typeof fetch;
    const client = createJudgeClient({
      baseUrl: 'https://judge.test/v1/',
      apiKey: 'k',
      model: 'm',
      fetchImpl,
    });
    const report = await judgeRound({ round, client, seed: 1 });
    expect(calls).toHaveLength(2);
    expect(report.blind.n).toBe(4);
    expect(report.blind.accuracy).toBe(1);
    expect(report.blind.auc).toBe(1);
    expect(report.meanScore).toBe(2.5);
    expect(report.ratings.map((r) => r.mainIssue)).toEqual(['汇报检索过程', '书面标点']);
    const again = await judgeRound({ round, client, seed: 1 });
    expect(again.blind.items.map((i) => i.key)).toEqual(report.blind.items.map((i) => i.key));
  });
});

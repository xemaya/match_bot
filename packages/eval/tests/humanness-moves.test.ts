import { describe, expect, it } from 'vitest';
import { classifyMove, judgeMoves } from '../src/humanness/moves.js';
import type { Round } from '../src/humanness/schema.js';

const round = (name: string, cases: Round['cases']): Round => ({
  version: 1,
  name,
  generatedAt: '2026-10-22T00:00:00Z',
  source: 'db',
  agentVersion: null,
  window: null,
  cases,
  humans: [{ alias: 'a1', at: '2026-10-22T09:59:00Z', text: '我周日有空', replyLike: true }],
});
const ask = (asked: string, line = '', card: string | null = null): Round['cases'][number] => ({
  id: asked,
  sourceMessageId: null,
  asked,
  askedAt: '2026-10-22T10:00:00Z',
  authorAlias: 'b2',
  kind: 'recommendation',
  status: 'sent',
  text: line,
  line,
  card,
  links: [],
});

describe('humanness moves', () => {
  it('classifies silence, reactions, half lines and answers', () => {
    expect(classifyMove(null, false)).toBe('silent');
    expect(classifyMove('👍', false)).toBe('react');
    expect(classifyMove('哈哈 我也想知道', false)).toBe('brief');
    expect(classifyMove('短的', true)).toBe('answer');
  });
  it('counts a reply where silence was ideal and a silence where an answer was', async () => {
    const source = round('src', [ask('周日打球吗'), ask('哪里有便宜打印机？')]);
    const recorded = round('rec', [ask('周日打球吗', '一起呀')]);
    const report = await judgeMoves({
      source,
      recorded,
      client: {
        model: 'stub',
        complete: () =>
          Promise.resolve(
            JSON.stringify([
              { id: 'q1', ideal: 'silent', fits: false, reason: '群友在约' },
              { id: 'q2', ideal: 'answer', fits: false, reason: '该给线索' },
            ]),
          ),
      },
    });
    expect(report.items.map((i) => i.actual)).toEqual(['brief', 'silent']);
    expect(report.wrongSpeak).toBe(1);
    expect(report.missedAnswer).toBe(1);
    expect(report.fitRate).toBe(0);
  });
});

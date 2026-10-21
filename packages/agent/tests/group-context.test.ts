import { describe, expect, it } from 'vitest';
import {
  BOT_SPEAKER,
  CURRENT_AUTHOR_SUFFIX,
  GROUP_TRANSCRIPT_LIMITS,
  buildGroupTranscript,
  memberAlias,
} from '../src/group-context.js';

const at = (secondsAgo: number) => new Date(Date.UTC(2026, 9, 20, 18, 0, 0) - secondsAgo * 1000);

describe('buildGroupTranscript', () => {
  it('renders members by alias, marks the current author, excludes the current message and orders oldest first', () => {
    const lines = buildGroupTranscript({
      members: [
        { id: 'now', userId: 'asker', text: '当前这条', receivedAt: at(0) },
        { id: 'm2', userId: 'asker', text: '我之前问过打印机', receivedAt: at(120) },
        { id: 'm1', userId: 'other', text: '我有台闲置的', receivedAt: at(60) },
      ],
      bot: [{ id: 'o1', text: '可以看看这台', sentAt: at(30) }],
      currentMessageId: 'now',
      currentUserId: 'asker',
    });
    expect(lines.map((l) => l.text)).toEqual(['我之前问过打印机', '我有台闲置的', '可以看看这台']);
    expect(lines[0]!.speaker).toBe(memberAlias('asker') + CURRENT_AUTHOR_SUFFIX);
    expect(lines[1]!.speaker).toBe(memberAlias('other'));
    expect(lines[2]!.speaker).toBe(BOT_SPEAKER);
    expect(lines[0]!.speaker).not.toContain('asker');
    expect(lines[0]!.at).toBe('2026-10-20T17:58Z');
  });
  it('keeps the newest lines within the line and character bounds and skims long posts', () => {
    const members = Array.from({ length: 40 }, (_, i) => ({
      id: 'm' + i,
      userId: 'u' + (i % 3),
      text: 'x'.repeat(300) + i,
      receivedAt: at(40 - i),
    }));
    const lines = buildGroupTranscript({
      members,
      bot: [],
      currentMessageId: 'none',
      currentUserId: 'u0',
    });
    expect(lines.length).toBeLessThanOrEqual(GROUP_TRANSCRIPT_LIMITS.lines);
    expect(lines.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(
      GROUP_TRANSCRIPT_LIMITS.totalChars,
    );
    expect(lines.at(-1)!.text.endsWith('…')).toBe(true);
    expect(lines.at(-1)!.text.length).toBe(GROUP_TRANSCRIPT_LIMITS.lineChars + 1);
    expect(lines[0]!.at <= lines.at(-1)!.at).toBe(true);
  });
});

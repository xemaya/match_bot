import { describe, expect, it } from 'vitest';
import {
  selectMemberNotes,
  selectPeerOffers,
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

describe('P53/P54 group view selection', () => {
  const line = (memberId: string, text: string) => ({
    at: '2026-10-22T10:00Z',
    speaker: memberAlias(memberId),
    text,
    memberId,
  });
  it('picks public offers that touch the topic, never the asker’s own lines or A2H', () => {
    const offers = selectPeerOffers(
      [
        line('m1', '我有多的羽毛球拍 谁要借'),
        line('m2', '周末有空的可以一起去看展'),
        line('asker', '我有多的球拍吗 不记得了'),
        { at: '', speaker: 'A2H', text: '我有多的羽毛球拍' },
      ],
      '周日想打羽毛球 缺个拍子',
      'asker',
    );
    expect(offers).toEqual([{ speaker: memberAlias('m1'), text: '我有多的羽毛球拍 谁要借' }]);
  });
  it('puts the asker’s notes first, then related notes of others, within the budget', () => {
    const notes = selectMemberNotes(
      [
        { userId: 'm1', kind: 'offer', text: '月底有间房空出来 在 Mile End' },
        { userId: 'asker', kind: 'need', text: '在找 Mile End 附近的房' },
        { userId: 'm2', kind: 'offer', text: '有多的羽毛球拍' },
      ],
      'Mile End 找房',
      'asker',
    );
    expect(notes.map((n) => n.memberId)).toEqual(['asker', 'm1']);
    expect(notes[0]!.member).toContain('（当前发言者）');
  });
});

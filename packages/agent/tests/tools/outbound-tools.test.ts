import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { askClarificationTool } from '../../src/tools/ask-clarification.js';
import { notifyUserTool } from '../../src/tools/notify-user.js';
import { pushLeadTool } from '../../src/tools/push-lead.js';
import { replyInGroupTool } from '../../src/tools/reply-in-group.js';
import { referMemberTool, sayBrieflyTool } from '../../src/tools/group-speech.js';

const VAN = { id: 'a', name: 'Van Co', roughPrice: '£40/h', telegram: '@vanco' };
const NO_TG = { id: 'b', name: 'NoTelegram Ltd', roughPrice: null, telegram: null };

function deps(goodVerdict = true) {
  return {
    // 四阶段用例验证「有人值守」语义；无人值守（drop）见下方专门用例
    env: { TELEGRAM_OPS_CHAT_ID: '-100ops', OUTBOUND_UNSURE_ACTION: 'review' },
    repos: {
      outbound: {
        create: vi.fn((d: unknown, status: string) =>
          Promise.resolve({ id: 'om', status, ...(d as object) }),
        ),
        countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
        countMentionsSince: vi.fn(() => Promise.resolve(0)),
      },
      users: { findById: vi.fn(() => Promise.resolve({ id: 'u9', externalId: '99' })) },
      traces: { create: vi.fn(() => Promise.resolve({})) },
      suppliers: {
        findByIds: vi.fn((ids: string[]) =>
          Promise.resolve([VAN, NO_TG].filter((s) => ids.includes(s.id))),
        ),
      },
    },
    jev: { evaluate: vi.fn() },
    evaluateOutbound: vi.fn(() =>
      Promise.resolve(
        goodVerdict
          ? { ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 }
          : { ok: false, reason: 'jev_unavailable' },
      ),
    ),
    thresholds: DEFAULT_THRESHOLDS,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function makeCtx(phase: 0 | 1 | 2): MatchContext {
  return {
    userId: 'u1',
    chatId: '-1',
    groupId: 'g',
    phase,
    recentReplies: [],
    sourceMessageId: 'm1',
    source: { messageId: '77', userId: '42' },
    demand: { category: 'man_and_van', confidence: 0.9 },
    groupTranscript: [{ at: '', speaker: '成员abcd', text: '我有多的拍子', memberId: 'u9' }],
  };
}
const rc = (ctx: MatchContext) => ({ context: ctx }) as never;

const cases = [
  {
    name: 'reply_in_group',
    make: replyInGroupTool,
    args: { text: 'Two options for you', supplierIds: ['a'] },
    target: '-1',
  },
  {
    name: 'notify_user',
    make: notifyUserTool,
    args: { text: 'Found a van for you' },
    target: '42', // 渠道侧 user id，不是库内 userId（u1）
  },
  {
    name: 'ask_clarification',
    make: askClarificationTool,
    args: { question: 'Which date?', missingFields: ['whenAt'] },
    target: '-1',
  },
  {
    name: 'push_lead',
    make: pushLeadTool,
    args: { supplierId: 'a', demandSummary: '8 boxes, E14 to SE1, Sunday' },
    target: '@vanco',
  },
  {
    name: 'say_briefly',
    make: sayBrieflyTool,
    args: { text: '这个我也想知道哈' },
    target: '-1',
  },
  {
    name: 'refer_member',
    make: referMemberTool,
    args: { alias: '成员abcd', text: '你说有多的拍子 能借一把不' },
    target: '-1',
  },
] as const;

describe.each(cases)('$name (出站工具四阶段用例)', ({ make, args, target }) => {
  it('phase 0: no approval, execute writes dry_run', async () => {
    const d = deps();
    const t = make(d as never);
    const ctx = makeCtx(0);
    expect(await t.needsApproval(rc(ctx), args as never, 'c1')).toBe(false);
    await t.invoke(rc(ctx), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ target }),
      'dry_run',
    );
  });

  it('phase 1: needsApproval interrupts; post-approval execute writes pending', async () => {
    const d = deps();
    const t = make(d as never);
    const ctx = makeCtx(1);
    expect(await t.needsApproval(rc(ctx), args as never, 'c1')).toBe(true);
    await t.invoke(rc(ctx), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
  });

  it('phase 2 good verdict: no approval, execute writes pending (auto)', async () => {
    const d = deps(true);
    const t = make(d as never);
    const ctx = makeCtx(2);
    expect(await t.needsApproval(rc(ctx), args as never, 'c1')).toBe(false);
    await t.invoke(rc(ctx), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
  });

  it('phase 2 jev unavailable: needsApproval interrupts', async () => {
    const d = deps(false);
    const t = make(d as never);
    expect(await t.needsApproval(rc(makeCtx(2)), args as never, 'c1')).toBe(true);
  });
});

describe('reply_in_group supplier guard', () => {
  it('rejects supplier ids that find_suppliers never returned', async () => {
    const d = deps();
    const t = replyInGroupTool(d as never);
    const out = await t.invoke(
      rc(makeCtx(1)),
      JSON.stringify({ text: 'x', supplierIds: ['nope'] }),
    );
    expect(out).toContain('unknown supplier id');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

describe('push_lead without supplier telegram', () => {
  it('routes the lead to the ops chat with a manual note', async () => {
    const d = deps();
    const t = pushLeadTool(d as never);
    const out = await t.invoke(
      rc(makeCtx(0)),
      JSON.stringify({ supplierId: 'b', demandSummary: '8 boxes, E14 to SE1' }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ target: '-100ops' }),
      'dry_run',
    );
    expect(out).toContain('ops will send manually');
  });
});

describe('group replies address the asker', () => {
  it.each([
    [
      'ask_clarification',
      askClarificationTool,
      { question: '什么时候搬？', missingFields: ['whenAt'] },
    ],
    ['reply_in_group', replyInGroupTool, { text: 'Two options', supplierIds: ['a'] }],
  ] as const)(
    '%s replies to the source message and @mentions its author',
    async (_n, make, args) => {
      const d = deps();
      await make(d as never).invoke(rc(makeCtx(0)), JSON.stringify(args));
      expect(d.repos.outbound.create).toHaveBeenCalledWith(
        expect.objectContaining({ target: '-1', replyToMessageId: '77', mentionUserId: '42' }),
        'dry_run',
      );
    },
  );

  it('does not @mention in a private chat', async () => {
    const d = deps();
    const ctx = { ...makeCtx(0), chatId: '42', groupId: null };
    await askClarificationTool(d as never).invoke(
      rc(ctx),
      JSON.stringify({ question: 'When?', missingFields: ['whenAt'] }),
    );
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row).toMatchObject({ replyToMessageId: '77' });
    expect(row).not.toHaveProperty('mentionUserId');
  });
});

describe('notify_user without a channel user id', () => {
  it('refuses instead of sending to the internal id', async () => {
    const d = deps();
    const { source: _s, ...ctx } = makeCtx(0);
    const out = await notifyUserTool(d as never).invoke(rc(ctx), JSON.stringify({ text: 'hi' }));
    expect(out).toContain('channel id is unknown');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

describe('unattended phase 2 (OUTBOUND_UNSURE_ACTION = drop)', () => {
  it('a failed Jev evaluation neither interrupts nor writes anything', async () => {
    const d = {
      ...deps(false),
      env: { TELEGRAM_OPS_CHAT_ID: '-100ops', OUTBOUND_UNSURE_ACTION: 'drop' },
    };
    const t = replyInGroupTool(d as never);
    const args = { text: 'Two options', supplierIds: ['a'] };
    expect(await t.needsApproval(rc(makeCtx(2)), args as never, 'c1')).toBe(false);
    const out = await t.invoke(rc(makeCtx(2)), JSON.stringify(args));
    expect(out).toContain('not sent');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

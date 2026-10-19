import { renderRequestStatus } from '../../src/request-status.js';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import {
  decideForOutbound,
  formatOutboundText,
  executeOutbound,
} from '../../src/tools/outbound-gate.js';

function deps() {
  return {
    env: { OUTBOUND_UNSURE_ACTION: 'review' },
    repos: {
      outbound: {
        create: vi.fn((d: unknown, status: string) =>
          Promise.resolve({ id: 'om', status, ...(d as object) }),
        ),
        countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
      },
      traces: { create: vi.fn(() => Promise.resolve({})) },
    },
    jev: { evaluate: vi.fn() },
    evaluateOutbound: vi.fn(() =>
      Promise.resolve({ ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 }),
    ),
    thresholds: DEFAULT_THRESHOLDS,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}
const ctx = (phase: 0 | 1 | 2) =>
  ({
    userId: 'u',
    chatId: '-1',
    groupId: 'g',
    phase,
    recentReplies: [],
    sourceMessageId: 'm1',
    demand: { category: 'man_and_van', confidence: 0.9 },
  }) as never;
const draft = {
  kind: 'recommendation' as const,
  target: '-1',
  text: '3 options',
  supplierSummaries: ['Van Co'],
  inputRef: 'r1',
};

describe('decideForOutbound', () => {
  it('passes selected-task per-item requirements separately when no single shared budget exists', async () => {
    const d = deps();
    const requestContext = '书桌预算£70；办公椅预算£50，均为每件上限';
    const current = {
      ...(ctx(2) as object),
      task: { id: 'selected' },
      currentRequest: {
        text: requestContext,
        demand: { category: 'second_hand', confidence: 1, need: '书桌；办公椅' },
        isActionable: true,
      },
    } as never;
    await decideForOutbound(d as never, current, draft);
    expect(d.evaluateOutbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestContext }),
    );
  });
  it('phase 0 -> dry_run without calling jev, still writes a gate trace', async () => {
    const d = deps();
    expect(await decideForOutbound(d as never, ctx(0), draft)).toBe('dry_run');
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
    expect(d.repos.traces.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'gate', phase: 0 }),
    );
  });
  it('phase 1 -> review', async () => {
    expect(await decideForOutbound(deps() as never, ctx(1), draft)).toBe('review');
  });
  it('phase 2 good verdict -> auto', async () => {
    expect(await decideForOutbound(deps() as never, ctx(2), draft)).toBe('auto');
  });
  it('evaluates a current desk/chair request without inheriting the printer budget', async () => {
    const d = deps();
    const evaluationDemand = {
      category: 'second_hand' as const,
      confidence: 1,
      need: 'desk / office chair',
      fromPostcode: 'E14',
      lang: 'zh',
    };
    const stale = {
      ...(ctx(2) as object),
      demand: { category: 'second_hand', confidence: 1, need: 'laser printer', budgetPence: 6000 },
    } as never;
    expect(await decideForOutbound(d as never, stale, { ...draft, evaluationDemand })).toBe('auto');
    expect(d.evaluateOutbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ demand: evaluationDemand }),
    );
    d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    expect(
      await decideForOutbound(d as never, stale, {
        ...draft,
        text: 'another validated draft',
        evaluationDemand,
      }),
    ).toBe('review');
  });
  it('phase 2 jev down -> review (降级方向固定送审)', async () => {
    const d = deps();
    d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    expect(await decideForOutbound(d as never, ctx(2), draft)).toBe('review');
  });
  it('phase 2 rate limit hit -> review, when the group has a limit', async () => {
    const d = deps();
    d.repos.outbound.countSentToTargetSince.mockResolvedValueOnce(3);
    const limited = { ...(ctx(2) as object), rateLimitPerDay: 3 } as never;
    expect(await decideForOutbound(d as never, limited, draft)).toBe('review');
  });
  it('phase 2 has no daily cap when the group sets none (default)', async () => {
    const d = deps();
    d.repos.outbound.countSentToTargetSince.mockResolvedValue(50);
    expect(await decideForOutbound(d as never, ctx(2), draft)).toBe('auto');
    expect(d.repos.outbound.countSentToTargetSince).not.toHaveBeenCalled();
  });
  it('phase 2 rate limit does not apply to clarifying questions', async () => {
    const d = deps();
    d.repos.outbound.countSentToTargetSince.mockResolvedValue(99);
    const q = { ...draft, kind: 'clarification' as const, supplierSummaries: [] };
    expect(await decideForOutbound(d as never, ctx(2), q)).toBe('auto');
    expect(d.repos.outbound.countSentToTargetSince).not.toHaveBeenCalled();
  });
  it('phase 2 uses the group limit rather than the default 3', async () => {
    const d = deps();
    d.repos.outbound.countSentToTargetSince.mockResolvedValue(4);
    const generous = { ...(ctx(2) as object), rateLimitPerDay: 10 } as never;
    expect(await decideForOutbound(d as never, generous, draft)).toBe('auto');
    const strict = { ...(ctx(2) as object), rateLimitPerDay: 1 } as never;
    d.repos.outbound.countSentToTargetSince.mockResolvedValue(1);
    expect(await decideForOutbound(d as never, strict, { ...draft, text: 'other' })).toBe('review');
  });
  it('records the kind on the outbound row', async () => {
    const d = deps();
    await executeOutbound(d as never, ctx(0), { ...draft, kind: 'clarification' }, 'dry_run');
    expect(d.repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clarification' }),
      'dry_run',
    );
  });
  it('caches the decision within a run (needsApproval + execute 只调一次 Jev)', async () => {
    const d = deps();
    const c = ctx(2);
    await decideForOutbound(d as never, c, draft);
    await decideForOutbound(d as never, c, draft);
    expect(d.evaluateOutbound).toHaveBeenCalledTimes(1);
  });
});

describe('executeOutbound', () => {
  it('writes dry_run row in phase 0 and pending row otherwise, without changing the reviewed wording', async () => {
    const d = deps();
    await executeOutbound(d as never, ctx(0), { ...draft, toolCallId: 'c1' }, 'dry_run');
    await executeOutbound(d as never, ctx(2), { ...draft, toolCallId: 'c2' }, 'auto');
    const create = d.repos.outbound.create;
    const first = create.mock.calls[0] as unknown[];
    const firstDraft = first[0] as { text: string; toolCallId: string };
    expect(firstDraft.text).toBe(draft.text);
    expect(firstDraft.toolCallId).toBe('c1');
    expect(first[1]).toBe('dry_run');
    expect(create).toHaveBeenNthCalledWith(2, expect.anything(), 'pending');
  });
  it('adds no disclaimer to drafts that recommend nobody (clarifying questions)', async () => {
    const d = deps();
    await executeOutbound(
      d as never,
      ctx(0),
      { ...draft, text: '请问您大概什么时候搬？', supplierSummaries: [] },
      'dry_run',
    );
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toBe('请问您大概什么时候搬？');
  });
  it('drop writes nothing', async () => {
    const d = deps();
    const r = await executeOutbound(d as never, ctx(2), draft, 'drop');
    expect(r).toContain('not sent');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

describe('outbound voice', () => {
  it.each([
    '这台价格合适，但帖子没写型号，还不能确定支持 Wi-Fi。\n来源：A2H详情 · 小红书原帖',
    'The model is missing, so Wi-Fi support is still unknown. https://example.com/original',
    'Модель не вказана. https://example.com/original',
    'Modelo não informado. https://example.com/original',
  ])('preserves specific uncertainty and source links without a generic footer: %s', (text) => {
    expect(formatOutboundText(ctx(0), { ...draft, text })).toBe(text);
  });
});

describe('targeted Jev outbound policy', () => {
  it('does not silence a direct reply for low usefulness, but still checks facts', async () => {
    const d = deps();
    Object.assign(d.env, { JEV_POLICY: 'targeted' });
    d.evaluateOutbound.mockResolvedValue({
      ok: true,
      worthReplying: 0,
      languageOk: 1,
      mentionsUnverified: 0,
    });
    expect(
      await decideForOutbound(
        d as never,
        { ...(ctx(2) as object), addressedToBot: true } as never,
        draft,
      ),
    ).toBe('auto');
    expect(d.evaluateOutbound).toHaveBeenCalledOnce();
    d.evaluateOutbound.mockResolvedValue({
      ok: true,
      worthReplying: 0,
      languageOk: 1,
      mentionsUnverified: 1,
    });
    expect(
      await decideForOutbound(
        d as never,
        { ...(ctx(2) as object), addressedToBot: true } as never,
        draft,
      ),
    ).toBe('drop');
  });
  it('still applies usefulness to unsolicited group replies', async () => {
    const d = deps();
    Object.assign(d.env, { JEV_POLICY: 'targeted' });
    d.evaluateOutbound.mockResolvedValue({
      ok: true,
      worthReplying: 0,
      languageOk: 1,
      mentionsUnverified: 0,
    });
    expect(await decideForOutbound(d as never, ctx(2), draft)).toBe('drop');
  });
});

describe('targeted fixed status boundary', () => {
  it.each([0, 1, 2] as const)('preserves phase %i without Jev', async (phase) => {
    const d = deps();
    Object.assign(d.env, { JEV_POLICY: 'targeted' });
    const c = {
      ...(ctx(phase) as object),
      isRequestStatusRun: true,
      currentRequest: { isActionable: true, demand: { category: 'second_hand', confidence: 1 } },
    } as never;
    const status = {
      ...draft,
      kind: 'notification' as const,
      replyPurpose: 'request_status' as const,
      inputRef: 'm1',
      supplierSummaries: [],
      text: renderRequestStatus(c)!,
    };
    expect(await decideForOutbound(d as never, c, status)).toBe(
      ['dry_run', 'review', 'auto'][phase],
    );
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
    expect(
      await decideForOutbound(d as never, c, { ...status, text: status.text + 'guaranteed' }),
    ).toBe('drop');
    expect(await decideForOutbound(d as never, c, { ...status, target: 'another-chat' })).toBe(
      'drop',
    );
  });
});

it('targeted retains unavailable-fact-check fallback and rate limits', async () => {
  const d = deps();
  Object.assign(d.env, { JEV_POLICY: 'targeted' });
  const direct = () =>
    ({ ...(ctx(2) as object), addressedToBot: true, rateLimitPerDay: 1 }) as never;
  d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'not_configured' });
  expect(await decideForOutbound(d as never, direct(), draft)).toBe('review');
  d.repos.outbound.countSentToTargetSince.mockResolvedValue(1);
  expect(await decideForOutbound(d as never, direct(), draft)).toBe('review');
});

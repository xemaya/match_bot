import { describe, expect, it, vi } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import type { AgentDeps, MatchContext } from '../src/context.js';
import { checkMarketOfferConflicts } from '../src/market-offer-conflicts.js';
import { replyToRequestTool } from '../src/tools/reply-to-request.js';

function fixture(score = 0.1) {
  const ctx: MatchContext = {
    userId: 'u',
    chatId: 'g',
    groupId: null,
    phase: 0,
    sourceMessageId: 'message',
    recentReplies: [],
    task: taskSchema.parse({
      id: 'task',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: 'g' },
      category: 'other',
      objective: '找新手羽毛球搭子',
      status: 'active',
      revision: 1,
      goals: [
        {
          id: 'partner',
          title: '羽毛球搭子',
          required: true,
          criteria: [
            {
              id: 'level',
              label: '活动水平',
              constraintKey: 'level',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'level',
          strength: 'hard',
          value: { kind: 'text', text: '初学者' },
          origin: { kind: 'user', sourceMessageId: 'message' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
    marketPlan: {
      intent: 'companion',
      needs: [{ id: 'partner', terms: ['羽毛球'] }],
      preferences: ['初学者'],
    },
    marketListings: [
      {
        id: 'bad',
        ref: 'm1',
        title: 'E14羽毛球招新生',
        description: '要求三年以上打球经验。',
        tradeType: 'PEER',
        status: 'ON_SALE',
        priceLabel: '£8',
        tags: [],
        url: 'https://a2hmarket.ai/listings/bad',
        sourceUrl: null,
        isRepost: false,
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ],
  };
  const evaluate = vi.fn((p: { questions: Record<string, unknown> }) =>
    Promise.resolve({
      ok: true,
      answers: Object.fromEntries(
        Object.keys(p.questions).map((key) => [key, { type: 'noul', noul: score }]),
      ),
    }),
  );
  const traces = { create: vi.fn(() => Promise.resolve({})) };
  const deps = {
    taskRequests: true,
    thresholds: DEFAULT_THRESHOLDS,
    jev: { evaluate },
    repos: { traces },
  } as unknown as AgentDeps;
  return { ctx, deps, evaluate, traces };
}

describe('market offer counter-evidence review', () => {
  it('JEV_POLICY=off establishes no conflict and never calls the model (2026-10-20 runs 2–4 regression)', async () => {
    const { ctx, deps, evaluate } = fixture(0.99);
    Object.assign(deps, { env: { JEV_POLICY: 'off' } });
    expect(await checkMarketOfferConflicts(deps, ctx, ['m1'])).toEqual({ kind: 'clear' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(ctx.task?.goals[0]?.criteria[0]?.status).toBe('unknown');
  });
  it('blocks a conflicting backup before the outbound gate or outbox, rather than silently editing it', async () => {
    const { ctx, deps } = fixture(0.99);
    ctx.taskProgressVersion = ctx.task!.requirementsVersion;
    const create = vi.fn(),
      outboundGate = vi.fn();
    Object.assign(deps.repos, { outbound: { create } });
    Object.assign(deps, { evaluateOutbound: outboundGate });
    const result = await replyToRequestTool(deps).invoke(
      { context: ctx } as never,
      JSON.stringify({ kind: 'partial', refs: ['m1'], text: '这条活动水平还需要确认。' }),
    );
    expect(result).toContain('explicitly conflicts');
    expect(create).not.toHaveBeenCalled();
    expect(outboundGate).not.toHaveBeenCalled();
  });
  it('rejects a source-grounded hard conflict without pretending unknown criteria are verified', async () => {
    const { ctx, deps, evaluate } = fixture(0.99);
    const result = await checkMarketOfferConflicts(deps, ctx, ['m1']);
    expect(result).toMatchObject({
      kind: 'conflict',
      conflicts: [{ ref: 'm1', goalId: 'partner', criterionId: 'level' }],
    });
    expect(ctx.task!.goals[0]!.criteria[0]!.status).toBe('unknown');
    expect(ctx.outboundBlocked).toBeUndefined();
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('does not turn a missing level into a positive match and reuses only identical source/condition checks', async () => {
    const { ctx, deps, evaluate } = fixture(0.1);
    expect(await checkMarketOfferConflicts(deps, ctx, ['m1'])).toEqual({ kind: 'clear' });
    expect(ctx.task!.goals[0]!.criteria[0]!.status).toBe('unknown');
    await checkMarketOfferConflicts(deps, ctx, ['m1']);
    expect(evaluate).toHaveBeenCalledOnce();
    ctx.task!.requirementsVersion++;
    await checkMarketOfferConflicts(deps, ctx, ['m1']);
    expect(evaluate).toHaveBeenCalledTimes(2);
    ctx.marketListings![0]!.description = '新来源文字';
    await checkMarketOfferConflicts(deps, ctx, ['m1']);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });
  it('does not classify unavailable or unreviewed evidence as clear', async () => {
    const { ctx, deps, evaluate } = fixture();
    evaluate.mockResolvedValueOnce({ ok: false, reason: 'timeout' } as never);
    expect(await checkMarketOfferConflicts(deps, ctx, ['m1'])).toMatchObject({
      kind: 'incomplete',
      reason: 'unavailable',
    });
    ctx.taskSourceReviewedClaims = 96;
    expect(await checkMarketOfferConflicts(deps, ctx, ['m1'])).toMatchObject({
      kind: 'incomplete',
      reason: 'budget',
    });
    ctx.taskSourceReviewedClaims = 0;
    ctx.runDeadlineAt = Date.now() - 1;
    expect(await checkMarketOfferConflicts(deps, ctx, ['m1'])).toMatchObject({
      kind: 'incomplete',
      reason: 'deadline',
    });
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('reviews later source passages under the same bounded claim budget', async () => {
    const { ctx, deps, evaluate } = fixture();
    ctx.marketListings![0]!.description = '普通活动说明。'.repeat(1000) + '要求三年以上打球经验';
    evaluate.mockImplementation((p) => {
      const state = (
        p as unknown as {
          state: {
            claims: Array<{ sourceId: string }>;
            sources: Array<{ id: string; text: string }>;
          };
        }
      ).state;
      return Promise.resolve({
        ok: true,
        answers: Object.fromEntries(
          state.claims.map((claim, i) => [
            'is_supported_' + i,
            {
              type: 'noul',
              noul: state.sources.find((s) => s.id === claim.sourceId)!.text.includes('三年以上')
                ? 0.99
                : 0.1,
            },
          ]),
        ),
      });
    });
    expect(await checkMarketOfferConflicts(deps, ctx, ['m1'])).toMatchObject({ kind: 'conflict' });
    expect(ctx.taskSourceReviewedClaims).toBe(2);
  });
  it('leaves legacy mode untouched and rejects an invalid source ref before calling a model', async () => {
    const { ctx, deps, evaluate } = fixture();
    expect(await checkMarketOfferConflicts(deps, ctx, ['m999'])).toMatchObject({
      kind: 'incomplete',
      reason: 'source',
    });
    deps.taskRequests = false;
    expect(await checkMarketOfferConflicts(deps, ctx, ['m1'])).toEqual({ kind: 'clear' });
    expect(evaluate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import type { MatchContext } from '../src/context.js';
import { restoreSearchContext } from '../src/restore-search-context.js';

const ctx: MatchContext = {
  userId: 'u',
  chatId: '-1',
  phase: 1,
  groupId: null,
  sourceMessageId: 'run',
  recentReplies: [],
};
const note = {
  ref: 'x1',
  title: 'title',
  desc: 'evidence',
  author: 'author',
  url: 'https://www.xiaohongshu.com/explore/n1',
  likes: 2,
};
const snapshot = (over: Record<string, unknown>) =>
  JSON.stringify({
    context: {
      context: {
        ...ctx,
        xhsNotes: [note],
        xhsQueries: [
          {
            keyword: '伦敦 看展',
            page: 1,
            sort: 'general',
            timeFilter: '不限',
            entity: null,
            purpose: 'discover',
          },
        ],
        ...over,
      },
    },
  });

describe('restoreSearchContext', () => {
  it('keeps page read limits and discovered links across restoration', () => {
    const pageReads = Array.from({ length: 6 }, (_, i) => 'read-' + i);
    const pageLinks = [{ text: 'Register', url: 'https://clinic.test/register' }];
    const restored = restoreSearchContext(ctx, snapshot({ pageReads, pageLinks }));
    expect(restored.pageReads).toEqual(pageReads);
    expect(restored.pageLinks).toEqual(pageLinks);
    expect(() =>
      restoreSearchContext(ctx, snapshot({ pageReads: [...pageReads, 'over-limit'] })),
    ).toThrow();
  });
  it('preserves the server quiet decision through the encrypted-checkpoint payload shape', () => {
    const restored = restoreSearchContext(
      ctx,
      snapshot({
        quietSupplementTaskId: 'task',
        quietSupplementEvidenceIds: ['e:known'],
        replySuppressed: true,
      }),
    );
    expect(restored.quietSupplementTaskId).toBe('task');
    expect(restored.replySuppressed).toBe(true);
    expect(restored.quietSupplementEvidenceIds).toEqual(['e:known']);
  });
  it('retains server-bound budget units at plan and goal level across approval restoration', () => {
    const rules = { preferences: [], budget: 1600, budgetUnit: 'month' };
    const restored = restoreSearchContext(
      ctx,
      snapshot({
        marketPlan: {
          ...rules,
          intent: 'housing',
          needs: [{ id: 'home', terms: ['一居室'], rules }],
        },
      }),
    );
    expect(restored.marketPlan?.budgetUnit).toBe('month');
    expect(restored.marketPlan?.needs[0]?.rules?.budgetUnit).toBe('month');
  });
  it('restores current request and canonical failure state for approval resumption', () => {
    const currentRequest = {
      text: 'E14找房',
      demand: { category: 'housing', need: 'E14找房', confidence: 1 },
      isActionable: true,
    };
    const restored = restoreSearchContext(
      ctx,
      snapshot({
        currentRequest,
        answerInputExhausted: true,
        isRequestStatusRun: true,
        outboundBlocked: true,
        isAnswerFinalization: true,
        deliverySourceRefs: ['k1', 'm2'],
        sourceFailures: ['processing:invalid_evidence'],
      }),
    );
    expect(restored.currentRequest).toEqual(currentRequest);
    expect(restored.demand).toEqual(currentRequest.demand);
    expect(restored.answerInputExhausted).toBe(true);
    expect(restored.isRequestStatusRun).toBe(true);
    expect(restored.outboundBlocked).toBe(true);
    expect(restored.isAnswerFinalization).toBe(true);
    expect(restored.deliverySourceRefs).toEqual(['k1', 'm2']);
  });
  it('keeps normalized requirements through encrypted approval snapshot reconstruction', () => {
    const plan = {
      intent: 'second_hand',
      needs: [{ id: 'desk', terms: ['书桌', 'desk'] }],
      preferences: ['白色'],
      essentialPreferences: ['白色'],
      requiredTerms: [],
      excludeTerms: [],
      requiredArea: ['E14'],
      budget: 50,
    };
    const restored = restoreSearchContext(ctx, snapshot({ marketPlan: plan }));
    expect(restored.marketPlan).toEqual(plan);
  });
  it('restores evidence, addressing and limits, keeping the latest demand from the database', () => {
    const demand = { category: 'other', confidence: 0.95, lang: 'en' } as const;
    const restored = restoreSearchContext(
      { ...ctx, demand },
      snapshot({
        groupId: 'g',
        sourceMessageId: 'm',
        source: { messageId: '7', userId: '42' },
        rateLimitPerDay: 3,
        xhsNotes: [{ ...note, isDetailLoaded: true }],
        xhsDetailRefs: ['x1'],
        xhsQueries: [
          {
            keyword: '伦敦 看展',
            page: 1,
            sort: 'general',
            timeFilter: '不限',
            entity: null,
            purpose: 'discover',
          },
        ],
        demand: { ...demand, lang: 'zh' },
      }),
    );
    expect(restored).toMatchObject({
      groupId: 'g',
      sourceMessageId: 'm',
      source: { messageId: '7', userId: '42' },
      rateLimitPerDay: 3,
      demand,
      xhsNotes: [{ ...note, isDetailLoaded: true }],
      xhsDetailRefs: ['x1'],
      xhsQueries: [
        {
          keyword: '伦敦 看展',
          page: 1,
          sort: 'general',
          timeFilter: '不限',
          entity: null,
          purpose: 'discover',
        },
      ],
    });
  });

  it.each([
    { userId: 'other' },
    { chatId: '-2' },
    { phase: 2 },
    { xhsNotes: [{ ...note, url: 'not-a-url' }] },
  ])('rejects a mismatched or malformed server context: %j', (over) => {
    expect(() => restoreSearchContext(ctx, snapshot(over))).toThrow();
  });

  it('leaves runs without Xiaohongshu search unchanged', () => {
    expect(restoreSearchContext(ctx, JSON.stringify({ context: { context: ctx } }))).toBe(ctx);
  });
});

import { evaluateSourceSupport, type SourceClaim } from '@matchbot/jev';
import { hashText } from '@matchbot/shared';
import type { AgentDeps, MatchContext } from './context.js';
import { assessMarketListing } from './market-strategy.js';
import { TASK_SOURCE_REVIEW_LIMITS } from './task-source-budget.js';

type Conflict = { ref: string; goalId: string; criterionId: string };
type Result =
  | { kind: 'clear' }
  | { kind: 'conflict'; conflicts: Conflict[] }
  | { kind: 'incomplete'; reason: 'source' | 'unavailable' | 'budget' | 'deadline' };
type Review = {
  ref: string;
  claim: SourceClaim;
  source: { id: string; text: string };
  key: string;
};

/** Negative evidence is checked for each chosen offer; absence of contradiction never verifies a fit. */
export async function checkMarketOfferConflicts(
  deps: AgentDeps,
  ctx: MatchContext,
  refs: string[],
): Promise<Result> {
  if (!deps.taskRequests || !ctx.task || !ctx.marketPlan) return { kind: 'clear' };
  const reviews = buildReviews(ctx, refs);
  const finish = async (result: Result) => {
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: ctx.sourceMessageId,
      phase: ctx.phase,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'market_offer_conflicts',
        decision: result.kind,
        refs,
        ...(result.kind === 'incomplete' ? { reason: result.reason } : {}),
        ...(result.kind === 'conflict' ? { conflicts: result.conflicts } : {}),
        claimsUsed: ctx.taskSourceReviewedClaims ?? 0,
      },
    });
    return result;
  };
  if (reviews === 'source' || reviews === 'budget')
    return finish({ kind: 'incomplete', reason: reviews });
  ctx.sourceReviewCache ??= {};
  const conflicts = () =>
    reviews
      .filter((r) => ctx.sourceReviewCache![r.key] === true)
      .map((r) => ({ ref: r.ref, goalId: r.claim.goalId, criterionId: r.claim.criterionId }));
  if (conflicts().length) return finish({ kind: 'conflict', conflicts: conflicts() });
  for (let offset = 0; offset < reviews.length; offset += TASK_SOURCE_REVIEW_LIMITS.batch) {
    const pending = reviews
      .slice(offset, offset + TASK_SOURCE_REVIEW_LIMITS.batch)
      .filter((r) => ctx.sourceReviewCache![r.key] === undefined);
    if (!pending.length) continue;
    if (ctx.runDeadlineAt !== undefined && Date.now() >= ctx.runDeadlineAt)
      return finish({ kind: 'incomplete', reason: 'deadline' });
    const remaining = TASK_SOURCE_REVIEW_LIMITS.claims - (ctx.taskSourceReviewedClaims ?? 0);
    if (pending.length > remaining) return finish({ kind: 'incomplete', reason: 'budget' });
    ctx.taskSourceReviewedClaims = (ctx.taskSourceReviewedClaims ?? 0) + pending.length;
    if (deps.env?.JEV_POLICY === 'off') {
      // These are refutation claims (true = the source explicitly contradicts a hard condition).
      // Without a second-opinion model nothing is established either way, so no offer is marked
      // conflicting; the code checks and the honest-unknown rules in delivery stand alone.
      for (const r of pending) ctx.sourceReviewCache[r.key] = false;
      continue;
    }
    const response = await evaluateSourceSupport(deps.jev, {
      taskContext: ctx.currentRequest?.text ?? ctx.task.objective,
      claims: pending.map((r) => r.claim),
      sources: [...new Map(pending.map((r) => [r.source.id, r.source])).values()],
      inputRef: ctx.sourceMessageId,
      phase: ctx.phase,
      ...(ctx.runDeadlineAt !== undefined ? { deadlineAt: ctx.runDeadlineAt } : {}),
    });
    if (!response.ok) {
      ctx.sourceFailures ??= [];
      ctx.sourceFailures.push('processing:offer_conflicts_' + response.reason);
      return finish({ kind: 'incomplete', reason: 'unavailable' });
    }
    pending.forEach((r, index) => {
      ctx.sourceReviewCache![r.key] =
        (response.scores[index] ?? 0) >= deps.thresholds.T_SOURCE_SUPPORT_ACCEPT;
    });
    if (conflicts().length) return finish({ kind: 'conflict', conflicts: conflicts() });
  }
  return finish({ kind: 'clear' });
}

function buildReviews(ctx: MatchContext, refs: string[]): Review[] | 'source' | 'budget' {
  const task = ctx.task!,
    plan = ctx.marketPlan!;
  const selected = [...new Set(refs)].map((ref) => ctx.marketListings?.find((n) => n.ref === ref));
  if (selected.some((n) => !n)) return 'source';
  const reviews: Review[] = [];
  for (const listing of selected) {
    if (!listing) continue;
    const needs = assessMarketListing(listing, plan).needs;
    const title = listing.title.slice(0, 300),
      size = 6000 - title.length - 1,
      stride = size - 300;
    for (const goal of task.goals.filter((g) => !g.userConfirmation && needs.includes(g.id))) {
      for (const criterion of goal.criteria.filter(
        (c) =>
          c.strength === 'hard' &&
          c.constraintKey &&
          !['travel_origin', 'role'].includes(c.constraintKey),
      )) {
        const condition =
          task.constraints.find((c) => c.key === criterion.constraintKey && c.goalId === goal.id) ??
          task.constraints.find((c) => c.key === criterion.constraintKey && !c.goalId);
        if (!condition) continue;
        const partCount = Math.max(1, Math.ceil((listing.description.length - size) / stride) + 1);
        if (reviews.length + partCount > TASK_SOURCE_REVIEW_LIMITS.claims) return 'budget';
        for (let part = 0; part < partCount; part++) {
          const source = {
            id: listing.ref + ':p' + part,
            text: title + '\n' + listing.description.slice(part * stride, part * stride + size),
          };
          const claim: SourceClaim = {
            goalId: goal.id,
            criterionId: criterion.id,
            goal: goal.title,
            requirement:
              criterion.label +
              '\nCurrent hard condition: ' +
              JSON.stringify({
                key: condition.key,
                value: condition.value,
                budgetScope: condition.budgetScope,
              }),
            proposedStatus: 'conflict',
            sourceId: source.id,
            quote: source.text.slice(0, 1000),
          };
          reviews.push({
            ref: listing.ref,
            claim,
            source,
            key:
              'offer-conflict:' +
              hashText(JSON.stringify([task.id, task.requirementsVersion, claim, source.text])),
          });
        }
      }
    }
  }
  return reviews;
}

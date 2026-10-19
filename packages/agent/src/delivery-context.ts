import { INFORMATION_LIMITS } from './information-limits.js';
import { pendingResearchConditions } from './research-readiness.js';
import type { MatchContext } from './context.js';
import { buildMarketChoices } from './market-choices.js';
import { marketListingForModel } from './market-research.js';
import { assessMarketListing } from './market-strategy.js';
import { canAskTaskQuestion } from '@matchbot/domain';
import { taskQuestionAnswerType } from './task-outbound.js';

export function scopedDeliveryTask(ctx: MatchContext) {
  const task = ctx.task;
  return task?.ownerUserId === ctx.userId &&
    task.scope.chatId === ctx.chatId &&
    task.scope.channel === (ctx.channel ?? 'telegram')
    ? task
    : undefined;
}
export function requestToolMode(ctx: MatchContext): 'catalogue' | 'market' | 'information' {
  const task = scopedDeliveryTask(ctx);
  const category = task?.category ?? ctx.currentRequest?.demand.category;
  if (category && ['man_and_van', 'eot_cleaning', 'furniture_service'].includes(category))
    return 'catalogue';
  if (
    ctx.marketPlan ||
    category === 'housing' ||
    category === 'second_hand' ||
    task?.counterparty ||
    /帮带|代购|空余行李|搭子|伙伴|carry|luggage space|companion|partner/i.test(
      task?.objective ?? '',
    )
  )
    return 'market';
  return 'information';
}
export function selectRequestToolNames(names: string[], ctx: MatchContext): string[] {
  const mode = requestToolMode(ctx);
  if (mode === 'catalogue') return names;
  const legacy = new Set(['ask_clarification', 'reply_in_group', 'close_demand', 'find_suppliers']);
  const official = /GP|NHS|注册.*医生|机场|heathrow|药|pharmac|painkiller/i.test(
    ctx.currentRequest?.text ?? '',
  );
  return names.filter(
    (name) =>
      !legacy.has(name) &&
      !(
        mode === 'information' &&
        ['market_search', 'market_enrich', 'find_peer_supply'].includes(name)
      ) &&
      !(
        (mode === 'market' || official) &&
        ['xhs_search', 'xhs_read_notes', 'reply_with_xhs_notes'].includes(name)
      ),
  );
}
export function canHandOffToDelivery(ctx: MatchContext): boolean {
  const task = scopedDeliveryTask(ctx);
  if (
    !task ||
    !ctx.currentRequest?.isActionable ||
    task.category === 'job' ||
    requestToolMode(ctx) === 'catalogue' ||
    ctx.outboundBlocked ||
    ctx.answerInputExhausted ||
    ctx.answerRecorded ||
    ctx.replySuppressed ||
    ctx.taskProgressVersion !== task.requirementsVersion ||
    !['deliver', 'ask_user'].includes(task.nextStep?.action ?? '') ||
    (task.nextStep?.action === 'deliver' && pendingResearchConditions(ctx).length > 0)
  )
    return false;
  // The existing structured XHS-only composer remains responsible for note-only research.
  return !(ctx.xhsNotes?.length && !ctx.knowledgeSources?.length && !ctx.marketPlan);
}
function subjectSources(ctx: MatchContext, goalId: string): Set<string> {
  const task = scopedDeliveryTask(ctx),
    goal = task?.goals.find((g) => g.id === goalId && !g.userConfirmation);
  return new Set(
    (goal?.criteria ?? [])
      .filter((c) => c.constraintKey == null && c.status === 'supported')
      .flatMap((c) => c.evidenceRefs)
      .flatMap((id) => {
        const proof = task!.evidence.find((e) => e.id === id);
        const listing = ctx.marketListings?.find((n) => proof?.sourceRef === 'market:' + n.id);
        return proof &&
          listing &&
          (listing.title + '\n' + listing.description).includes(proof.summary)
          ? [listing.ref]
          : [];
      }),
  );
}
export function buildDeliveryPacket(ctx: MatchContext) {
  const task = scopedDeliveryTask(ctx);
  const preferred = new Set(ctx.deliverySourceRefs ?? []);
  const subjects = new Map(
    (ctx.marketPlan?.needs ?? []).map((n) => [n.id, subjectSources(ctx, n.id)]),
  );
  const choices = ctx.marketPlan
    ? buildMarketChoices({
        // Filter before the capped shortlist, so cheap vague offers cannot displace confirmed subjects.
        candidates: (ctx.marketListings ?? []).filter((listing) =>
          assessMarketListing(listing, ctx.marketPlan!).needs.some(
            (id) => !subjects.get(id)?.size || subjects.get(id)!.has(listing.ref),
          ),
        ),
        plan: ctx.marketPlan,
        ...(task && ctx.taskProgressVersion === task.requirementsVersion ? { task } : {}),
      })
    : null;
  const eligible = [...(choices?.primary ?? []), ...(choices?.backup ?? [])].filter((row) =>
    row.assessment.needs.some(
      (id) => !subjects.get(id)?.size || subjects.get(id)!.has(row.listing.ref),
    ),
  );
  const preferredMarket = eligible.filter((row) => preferred.has(row.listing.ref));
  const market = (preferredMarket.length ? preferredMarket : eligible)
    .slice(0, Math.min(3, Math.max(2, ctx.marketPlan?.needs.length ?? 0)))
    .map((row) => ({
      ...marketListingForModel(
        row.listing,
        1800,
        ctx.marketPlan!.needs.flatMap((n) => n.terms),
      ),
      checks: row.assessment.checks,
      unknown: row.essentialMissing,
    }));
  const proofs = (task?.goals ?? [])
    .flatMap((g) => g.criteria.flatMap((c) => c.evidenceRefs))
    .flatMap((id) => task!.evidence.filter((e) => e.id === id));
  const knowledge = market.length
    ? []
    : [...(ctx.knowledgeSources ?? [])]
        .sort(
          (a, b) =>
            Number(preferred.has(b.ref)) - Number(preferred.has(a.ref)) ||
            Number(proofs.some((e) => e.url === b.url)) -
              Number(proofs.some((e) => e.url === a.url)),
        )
        .slice(0, INFORMATION_LIMITS.sources)
        .map((source) => {
          const relevant = source.passages.filter((p) =>
            proofs.some(
              (e) =>
                e.url === source.url && (p.text.includes(e.summary) || e.summary.includes(p.text)),
            ),
          );
          return {
            ref: source.ref,
            title: source.title,
            url: source.url,
            // Evidence preference must not discard another fact on the same page.
            // runtimeContext applies the existing breadth-first 24000-character budget.
            passages: [
              ...relevant,
              ...source.passages.filter((p) => !relevant.some((r) => r.id === p.id)),
            ].slice(0, 12),
          };
        });
  const next = task?.nextStep;
  const nextStep =
    task &&
    next?.action === 'ask_user' &&
    next.constraintKey &&
    !canAskTaskQuestion(task, {
      constraintKey: next.constraintKey,
      answerType: taskQuestionAnswerType(next.constraintKey, next.reason),
      text: next.reason,
      ...(next.goalId ? { goalId: next.goalId } : {}),
    })
      ? {
          action: 'deliver' as const,
          owner: 'agent' as const,
          reason: 'Use the known personal condition; explain source gaps without asking it again.',
        }
      : next;
  return {
    refs: [...market.map((n) => n.ref), ...knowledge.map((n) => n.ref)],
    market,
    knowledge,
    task: task
      ? {
          objective: task.objective,
          constraints: task.constraints.map(({ origin: _origin, ...c }) => c),
          nextStep,
          checks: task.goals.flatMap((g) =>
            g.criteria.map((c) => ({ goal: g.title, condition: c.label, status: c.status })),
          ),
        }
      : null,
    unresearchedConditions: pendingResearchConditions(ctx),
    failures: ctx.sourceFailures ?? [],
  };
}

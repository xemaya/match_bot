import { taskQuestionAnswerType } from '../task-outbound.js';
import {
  assessTaskReadiness,
  recordTaskProgress,
  TaskTransitionError,
  canAskTaskQuestion,
} from '@matchbot/domain';
import { tool, type RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../context.js';
import {
  buildTaskProgress,
  buildTaskSourceReview,
  taskProgressParameters,
  TaskEvidenceError,
} from '../task-source-evidence.js';
import { evaluateSourceSupport } from '@matchbot/jev';
import { hashText } from '@matchbot/shared';
import { marketChoiceFeedback } from '../market-choice-feedback.js';
import { TASK_SOURCE_REVIEW_LIMITS } from '../task-source-budget.js';

/** Source/plan ledger only; sending still uses the original outbound tool and gates. */
export function recordTaskProgressTool(deps: AgentDeps) {
  return tool({
    name: 'record_task_progress',
    description:
      'Record verified source evidence and a responsible next step for the selected task. Use known goal/criterion IDs and source refs. Exact source text may be supplied with status=unknown: the server then checks both support and contradiction, keeping missing/ambiguous/unavailable evidence unknown. Each criterion describes the best coherent option; do not mix rejected alternatives into supporting evidence. Prefer returned passage IDs with quote=null. For a whole-source ref, quote=null selects a bounded server-owned excerpt and still runs semantic/computed checks; supply an exact quote when the relevant fact is deeper in a long source. Never combine different offers, treat public status as guaranteed availability, or mark the user goal complete. Choose research for public facts your tools can retrieve; ask_user only for a missing personal condition or decision that changes your next action. Record internal checks without turning them into a public checklist. Use wait_source only after a real failure, or deliver the useful findings with concrete unknowns. This sends nothing.',
    parameters: taskProgressParameters,
    needsApproval: false,
    errorFunction: async (rc) => {
      const ctx = rc.context as MatchContext;
      ctx.taskProgressCalls = (ctx.taskProgressCalls ?? 0) + 1;
      await trace(deps, ctx, 'invalid_schema');
      return 'invalid task progress: use the small checks/next schema and known IDs; unknown checks use sources=[]';
    },
    execute: async (args, rc, details) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      ctx.taskProgressCalls = (ctx.taskProgressCalls ?? 0) + 1;
      if (ctx.taskProgressCalls > 4) {
        await trace(deps, ctx, 'budget_exhausted');
        return 'task progress budget exhausted; provide the best honest partial answer or request status';
      }
      if (ctx.outboundBlocked) {
        await trace(deps, ctx, 'outbound_declined');
        return 'not allowed: outbound already declined';
      }
      if (ctx.runDeadlineAt !== undefined && Date.now() >= ctx.runDeadlineAt) {
        await trace(deps, ctx, 'deadline');
        return 'research deadline reached; do not start another review';
      }
      try {
        const progress = buildTaskProgress({ ctx, ...args });
        if (
          args.next.action === 'ask_user' &&
          args.next.constraintKey &&
          !canAskTaskQuestion(ctx.task!, {
            constraintKey: args.next.constraintKey,
            answerType: taskQuestionAnswerType(args.next.constraintKey, args.next.reason),
            text: args.next.reason,
            ...(args.next.goalId ? { goalId: args.next.goalId } : {}),
          })
        )
          throw new TaskTransitionError(
            'This personal condition is already known. Use it; choose research for public gaps or deliver useful findings, not another question.',
          );
        const reviews = await reviewSources(deps, ctx, args.checks);
        const checked = applySourceReviews(progress.checks, reviews.decisions);
        progress.checks = checked.checks;
        progress.checks = mergeChecks(ctx, progress);
        progress.coherence = await reviewCoherence(deps, ctx, progress);
        if (ctx.runDeadlineAt !== undefined && Date.now() >= ctx.runDeadlineAt) {
          await trace(deps, ctx, 'deadline');
          return 'research deadline reached; do not continue or save obsolete work';
        }
        const current = ctx.task!;
        recordTaskProgress({ task: current, ...progress });
        const result = await deps.repos.tasks.recordProgress({
          access: {
            userId: ctx.userId,
            scope: {
              channel: ctx.channel ?? 'telegram',
              chatId: ctx.chatId,
              ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
            },
          },
          id: current.id,
          expectedRevision: current.revision,
          sourceMessageId: ctx.sourceMessageId,
          operationKey:
            'progress:' +
            ctx.sourceMessageId +
            ':' +
            hashText(details?.toolCall?.callId ?? String(ctx.taskProgressCalls)).slice(0, 40),
          progress,
        });
        if (result.kind !== 'applied' && result.kind !== 'replayed') {
          await trace(deps, ctx, 'version_conflict');
          return 'task changed while researching; do not overwrite or answer using obsolete conditions';
        }
        ctx.task = result.task;
        ctx.taskProgressVersion = result.task.requirementsVersion;
        if (args.next.action === 'deliver' || args.next.action === 'ask_user')
          ctx.deliverySourceRefs = [
            ...new Set(
              args.checks.flatMap((c) => c.sources.map((s) => s.ref.replace(/:p\d+$/, ''))),
            ),
          ]
            .filter((ref) => /^[km]\d+$/.test(ref))
            .slice(0, 6);
        else delete ctx.deliverySourceRefs;
        await trace(deps, ctx, 'recorded');
        return JSON.stringify({
          recorded: true,
          rejectedCriteria: checked.rejectedCriteria,
          rejectedSourceCount: checked.rejectedCount,
          sourceReviewBudgetExhausted: reviews.exhausted,
          sourceReviewClaimsUsed: ctx.taskSourceReviewedClaims ?? 0,
          readiness: assessTaskReadiness(result.task),
          next: result.task.nextStep,
          marketChoices: marketChoiceFeedback(ctx),
          checks: progress.checks.map((c) => ({
            goalId: c.goalId,
            criterionId: c.criterionId,
            status: c.status,
          })),
        });
      } catch (error) {
        await trace(
          deps,
          ctx,
          error instanceof TaskEvidenceError || error instanceof TaskTransitionError
            ? error.message
            : error instanceof Error
              ? error.name
              : 'unknown_error',
        );
        return error instanceof TaskEvidenceError || error instanceof TaskTransitionError
          ? JSON.stringify({
              error: error.message,
              validRefs: [
                ...(ctx.marketListings ?? []).map((s) => s.ref),
                ...(ctx.knowledgeSources ?? []).map((s) => s.ref),
                ...(ctx.xhsNotes ?? []).filter((n) => n.isDetailLoaded).map((n) => n.ref),
              ],
              passages:
                'Use only exact passage IDs already returned by search_information or xhs_read_notes; quote=null copies their text on the server.',
              next: 'Use an actual returned ref and quote. Unproved checks stay unknown with sources=[]. Do not repeat the same rejected check. Useful partial answers may go directly to reply_to_request; they still pass source and outbound checks.',
            })
          : 'task progress could not be saved; stop and explain the current processing gap';
      }
    },
  });
}
async function reviewCoherence(
  deps: AgentDeps,
  ctx: MatchContext,
  progress: ReturnType<typeof buildTaskProgress>,
) {
  const proposed = recordTaskProgress({ task: ctx.task!, ...progress });
  const goals = proposed.goals.filter((goal) => !goal.userConfirmation);
  const result: Array<{ goalId: string; status: 'unknown' | 'supported' }> = goals.map((goal) => ({
    goalId: goal.id,
    status: 'unknown',
  }));
  const ready = goals.filter((goal) => {
    const hard = goal.criteria.filter((c) => c.strength === 'hard');
    return hard.length && hard.every((c) => c.status === 'supported');
  });
  if (!ready.length) return result;
  const facts = proposed.goals.map((goal) => ({
    goal: goal.title,
    required: goal.required,
    checks: goal.criteria.map((c) => ({
      criterion: c.label,
      strength: c.strength,
      status: c.status,
      sources: c.evidenceRefs
        .map((id) => proposed.evidence.find((e) => e.id === id))
        .filter((e) => !!e)
        .map((e) => ({
          source: e.sourceRef,
          kind: e.kind,
          entity: e.entityKey,
          text: e.summary,
          url: e.url,
        })),
      refutations: (c.conflictingEvidenceRefs ?? [])
        .map((id) => proposed.evidence.find((e) => e.id === id))
        .filter((e) => !!e)
        .map((e) => ({ source: e.sourceRef, entity: e.entityKey, text: e.summary })),
    })),
  }));
  const sourceText = JSON.stringify(facts);
  if (sourceText.length > 6000) return result;
  const cacheKey =
    'coherence:' +
    hashText(
      JSON.stringify([
        proposed.requirementsVersion,
        ctx.currentRequest?.text ?? proposed.objective,
        sourceText,
      ]),
    );
  ctx.sourceReviewCache ??= {};
  if (ctx.sourceReviewCache[cacheKey] !== undefined) {
    for (const row of result)
      if (ctx.sourceReviewCache[cacheKey + ':' + row.goalId]) row.status = 'supported';
    return result;
  }
  const claims = ready.map((goal) => ({
    goalId: goal.id,
    criterionId: '__source_coherence',
    goal: goal.title,
    requirement:
      'Find a coherent option satisfying all HARD criteria and their budgetScope. An unmet/unknown preference is not a veto. Refutations about a DIFFERENT rejected alternative do not invalidate the supported option. Never borrow facts between options; a rent-only quote cannot prove an all-in total.',
    proposedStatus: 'supported' as const,
    sourceId: 'validated_facts',
    quote: goal.title,
  }));
  const response = await evaluateSourceSupport(deps.jev, {
    taskContext:
      'Current date (Europe/London): ' +
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()) +
      '\n' +
      (ctx.currentRequest?.text ?? proposed.objective),
    claims,
    sources: [{ id: 'validated_facts', text: sourceText }],
    inputRef: ctx.sourceMessageId,
    phase: ctx.phase,
    ...(ctx.runDeadlineAt !== undefined ? { deadlineAt: ctx.runDeadlineAt } : {}),
  });
  if (response.ok) {
    for (const [index, goal] of ready.entries())
      if ((response.scores[index] ?? 0) >= deps.thresholds.T_SOURCE_SUPPORT_ACCEPT)
        result.find((r) => r.goalId === goal.id)!.status = 'supported';
  } else {
    ctx.sourceFailures ??= [];
    ctx.sourceFailures.push('processing:jev_coherence_' + response.reason);
  }
  // Only cache collective success/failure when it applies to this same eligible goal set.
  // Per-goal verdicts are retained below, so a partial pass never upgrades the other goals.
  for (const row of result)
    ctx.sourceReviewCache[cacheKey + ':' + row.goalId] = row.status === 'supported';
  ctx.sourceReviewCache[cacheKey] = true;
  return result;
}
function mergeChecks(ctx: MatchContext, progress: ReturnType<typeof buildTaskProgress>) {
  const groups = new Map<string, typeof progress.checks>();
  for (const check of progress.checks) {
    const key = JSON.stringify([check.goalId, check.criterionId]);
    const group = groups.get(key) ?? [];
    group.push(check);
    groups.set(key, group);
  }
  const evidence = [...(ctx.task?.evidence ?? []), ...progress.evidence];
  return [...groups.values()].map((group) => {
    const supported = group.filter((c) => c.status === 'supported' && c.evidenceRefs.length);
    const conflicting = group.filter((c) => c.status === 'conflict' && c.evidenceRefs.length);
    const positive = [...new Set(supported.flatMap((c) => c.evidenceRefs))];
    const positiveSources = new Set(
      positive.map((id) => evidence.find((e) => e.id === id)?.sourceRef),
    );
    const inherited = group
      .flatMap((c) => c.conflictingEvidenceRefs ?? [])
      .filter((id) => !positiveSources.has(evidence.find((e) => e.id === id)?.sourceRef));
    const negative = [...new Set([...inherited, ...conflicting.flatMap((c) => c.evidenceRefs)])];
    const refs = positive.length
      ? positive
      : conflicting.length
        ? [...new Set(conflicting.flatMap((c) => c.evidenceRefs))]
        : [...new Set(group.flatMap((c) => c.evidenceRefs))];
    return {
      ...group[0]!,
      status: positive.length
        ? ('supported' as const)
        : conflicting.length
          ? ('conflict' as const)
          : ('unknown' as const),
      evidenceRefs: refs,
      conflictingEvidenceRefs: negative,
    };
  });
}
async function reviewSources(
  deps: AgentDeps,
  ctx: MatchContext,
  checks: Parameters<typeof buildTaskSourceReview>[1],
) {
  const review = buildTaskSourceReview(ctx, checks);
  ctx.sourceReviewCache ??= {};
  const pending = review.claims.map((claim, index) => ({
    claim,
    index,
    key: hashText(
      JSON.stringify([
        ctx.task?.requirementsVersion,
        claim,
        review.sources.find((s) => s.id === claim.sourceId)?.text,
      ]),
    ),
  }));
  for (const item of pending)
    if (!review.eligible[item.index]) ctx.sourceReviewCache[item.key] = false;
    else if (review.decisive[item.index] !== undefined)
      ctx.sourceReviewCache[item.key] = review.decisive[item.index]!;
  if (review.decisive.some((value) => value !== undefined))
    await trace(deps, ctx, 'explicit_calendar_fact_checked');
  for (let offset = 0; offset < pending.length; offset += TASK_SOURCE_REVIEW_LIMITS.batch) {
    const remaining = Math.max(
      0,
      TASK_SOURCE_REVIEW_LIMITS.claims - (ctx.taskSourceReviewedClaims ?? 0),
    );
    const batch = pending
      .slice(offset, offset + TASK_SOURCE_REVIEW_LIMITS.batch)
      .filter((item) => ctx.sourceReviewCache![item.key] === undefined)
      .slice(0, remaining);
    if (batch.length) {
      ctx.taskSourceReviewedClaims = (ctx.taskSourceReviewedClaims ?? 0) + batch.length;
      const response = await evaluateSourceSupport(deps.jev, {
        taskContext:
          'Current date (Europe/London): ' +
          new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()) +
          '\n' +
          (ctx.currentRequest?.text ?? ctx.task!.objective),
        claims: batch.map((item) => item.claim),
        sources: review.sources.filter((s) => batch.some((item) => item.claim.sourceId === s.id)),
        inputRef: ctx.sourceMessageId,
        phase: ctx.phase,
        ...(ctx.runDeadlineAt !== undefined ? { deadlineAt: ctx.runDeadlineAt } : {}),
      });
      if (!response.ok) {
        ctx.sourceFailures ??= [];
        ctx.sourceFailures.push('processing:jev_source_' + response.reason);
      }
      for (const [index, item] of batch.entries())
        ctx.sourceReviewCache[item.key] =
          response.ok && (response.scores[index] ?? 0) >= deps.thresholds.T_SOURCE_SUPPORT_ACCEPT;
    }
  }
  const decisions = new Map<number, Map<number, Set<'supported' | 'conflict'>>>();
  for (const item of pending) {
    const index = review.indexes[item.index]!,
      sourceIndex = review.sourceIndexes[item.index]!;
    const sources = decisions.get(index) ?? new Map<number, Set<'supported' | 'conflict'>>();
    const statuses = sources.get(sourceIndex) ?? new Set<'supported' | 'conflict'>();
    if (ctx.sourceReviewCache[item.key]) statuses.add(item.claim.proposedStatus);
    sources.set(sourceIndex, statuses);
    decisions.set(index, sources);
  }
  const exhausted = pending.some((item) => ctx.sourceReviewCache![item.key] === undefined);
  if (exhausted) await trace(deps, ctx, 'review_budget_exhausted');
  return {
    exhausted,
    decisions: new Map(
      [...decisions].map(([index, sources]) => [
        index,
        new Map(
          [...sources].map(([sourceIndex, statuses]) => [
            sourceIndex,
            statuses.size === 1 ? [...statuses][0]! : ('unknown' as const),
          ]),
        ),
      ]),
    ),
  };
}
function applySourceReviews(
  checks: ReturnType<typeof buildTaskProgress>['checks'],
  reviews: Awaited<ReturnType<typeof reviewSources>>['decisions'],
) {
  const rejectedCriteria: string[] = [];
  let rejectedCount = 0;
  const checked = checks.flatMap((check, index) => {
    const sources = reviews.get(index);
    if (!sources) return [check];
    const rows: typeof checks = [];
    for (const status of ['supported', 'conflict'] as const) {
      const refs = check.evidenceRefs.filter((_, i) => sources.get(i) === status);
      if (refs.length) rows.push({ ...check, status, evidenceRefs: [...new Set(refs)] });
    }
    rejectedCount += [...sources.values()].filter((status) => status === 'unknown').length;
    if (!rows.length) {
      rejectedCriteria.push(check.criterionId);
      rows.push({ ...check, status: 'unknown', evidenceRefs: [] });
    }
    return rows;
  });
  return { checks: checked, rejectedCriteria, rejectedCount };
}
async function trace(deps: AgentDeps, ctx: MatchContext, result: string) {
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: ctx.sourceMessageId,
    phase: ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: {
      gate: 'task_source_progress',
      result,
      taskId: ctx.task?.id ?? null,
      requirementsVersion: ctx.task?.requirementsVersion ?? null,
      attempt: ctx.taskProgressCalls ?? 0,
    },
  });
}

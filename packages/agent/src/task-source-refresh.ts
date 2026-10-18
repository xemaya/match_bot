import type { AgentDeps, MatchContext } from './context.js';
import { readSavedTaskSources } from './tools/read-task-sources.js';
import { MARKET_RESEARCH_LIMITS } from './market-research.js';
import { saveExecutionCheckpoint } from './execution-checkpoint.js';

/** Refresh useful task memory before generation; old excerpts alone never become current evidence. */
export async function refreshTaskSourceMemory(p: {
  deps: AgentDeps;
  ctx: MatchContext;
  input: string;
  agentVersion: string;
}): Promise<void> {
  const { deps, ctx } = p,
    task = ctx.task;
  if (
    !deps.taskRequests ||
    !deps.marketSearch ||
    !task ||
    ctx.outboundBlocked ||
    task.ownerUserId !== ctx.userId ||
    task.scope.chatId !== ctx.chatId ||
    (task.scope.threadId ?? '') !== (ctx.threadId ?? '') ||
    task.scope.channel !== (ctx.channel ?? 'telegram') ||
    ['completed', 'cancelled', 'expired'].includes(task.status) ||
    ['ambiguous', 'unbound', 'acknowledged', 'completed', 'cancelled'].includes(
      ctx.taskUpdate?.kind ?? '',
    ) ||
    (ctx.runDeadlineAt !== undefined && ctx.runDeadlineAt <= Date.now())
  )
    return;
  const attempted = new Set(ctx.marketDetailIds ?? []);
  const remaining = Math.min(4, MARKET_RESEARCH_LIMITS.details - attempted.size);
  if (remaining <= 0) return;
  const selected = new Set<string>();
  for (const goal of task.goals.filter((g) => !g.userConfirmation)) {
    const negative = new Set(goal.criteria.flatMap((c) => c.conflictingEvidenceRefs ?? []));
    const candidates = task.evidence
      .filter(
        (e) =>
          e.goalId === goal.id &&
          e.kind === 'source_excerpt' &&
          /^market:[A-Za-z0-9_-]{1,100}$/.test(e.sourceRef) &&
          !negative.has(e.id) &&
          !attempted.has(e.sourceRef.slice(7)),
      )
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    if (candidates[0]) selected.add(candidates[0].sourceRef);
    if (selected.size >= remaining) break;
  }
  if (!selected.size) return;
  const before = attempted.size;
  await readSavedTaskSources(deps, ctx, { sources: [...selected] });
  const actualAttempts = (ctx.marketDetailIds?.length ?? 0) - before;
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: ctx.sourceMessageId,
    phase: ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: {
      gate: 'task_source_refresh',
      taskId: task.id,
      requested: selected.size,
      attempted: actualAttempts,
      decision: 'automatic_refresh',
    },
  });
  if (ctx.execution && actualAttempts > 0)
    await saveExecutionCheckpoint(deps, ctx, p.input, p.agentVersion);
}

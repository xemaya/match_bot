import type { MatchContext } from './context.js';

/** Minimum effort gate, not proof of correctness: a fresh query may still return no answer. */
export function pendingResearchConditions(ctx: MatchContext): string[] {
  const task = ctx.task;
  if (
    !task ||
    task.ownerUserId !== ctx.userId ||
    task.scope.chatId !== ctx.chatId ||
    task.scope.channel !== (ctx.channel ?? 'telegram') ||
    ctx.taskUpdate?.kind !== 'continued' ||
    ['completed', 'cancelled', 'expired'].includes(task.status) ||
    ctx.informationQueries?.length ||
    ctx.marketQueries?.length ||
    ctx.xhsQueries?.length ||
    ctx.sourceFailures?.some((f) => f.startsWith('information:') || f === 'market:unavailable') ||
    (ctx.runDeadlineAt !== undefined && ctx.runDeadlineAt - Date.now() <= 30000)
  )
    return [];
  return [
    ...new Set(
      task.constraints
        .filter((c) => {
          if (
            c.strength !== 'hard' ||
            c.origin.kind !== 'user' ||
            c.origin.sourceMessageId !== ctx.sourceMessageId
          )
            return false;
          const goals = task.goals.filter(
            (g) => !g.userConfirmation && (!c.goalId || c.goalId === g.id),
          );
          if (!goals.length) return false;
          return goals.some((g) => {
            const checks = g.criteria.filter((check) => check.constraintKey === c.key);
            return !checks.length || checks.some((check) => check.status === 'unknown');
          });
        })
        .map((c) => c.key),
    ),
  ];
}

export function researchFollowupInstruction(ctx: MatchContext): string {
  return (
    'The new hard conditions below are still unverified. Reading saved sources is not a new search. Use a short focused query for the actual item/venue and missing condition, or search an alternative that explicitly satisfies it. Do not infer facts from a model name. Stay within the remaining tool/time budget; if sources fail or evidence remains missing, deliver an honest partial answer. Condition keys: ' +
    JSON.stringify(pendingResearchConditions(ctx))
  );
}

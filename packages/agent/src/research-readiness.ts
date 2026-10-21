import type { MatchContext } from './context.js';
import { REPLY_TO_REQUEST } from './prompts/tools/reply-to-request.js';

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
    ctx.pageReads?.length ||
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
  return REPLY_TO_REQUEST.feedback.researchFollowup(pendingResearchConditions(ctx));
}

import type { UserTask } from '@matchbot/domain';
import type { MatchContext } from './context.js';
import { isActionableRequestText } from './current-request.js';

/** Quiet is limited to context additions, never a new question or an explicit danger signal. */
export function isContextSupplement(text: string): boolean {
  return (
    text.trim().length <= 60 &&
    !isActionableRequestText(text) &&
    !/突然|剧烈|严重|昏|呼吸|视力|说话困难|无力|出血|麻木|抽搐|意识|看不见|救命|急救|sudden|severe|faint|emergency|breath|vision|weak|numb|seizure|confus|head injury/i.test(
      text,
    )
  );
}
export function canSkipSupplementReply(ctx: MatchContext): boolean {
  const task = ctx.task;
  return (
    !!task &&
    ctx.quietSupplementTaskId === task.id &&
    ctx.taskUpdate?.kind === 'continued' &&
    task.ownerUserId === ctx.userId &&
    task.scope.chatId === ctx.chatId &&
    (task.scope.threadId ?? '') === (ctx.threadId ?? '') &&
    task.scope.channel === (ctx.channel ?? 'telegram') &&
    !['completed', 'cancelled', 'expired'].includes(task.status)
  );
}

function actionConditions(task: UserTask): string {
  return JSON.stringify({
    goals: task.goals.map((g) => [g.id, g.title, g.required, g.userConfirmation]),
    hard: task.constraints
      .filter((c) => c.strength === 'hard')
      .map(({ origin: _origin, ...c }) => c),
    counterparty: task.counterparty,
  });
}
export function hasSameActionConditions(previous: UserTask, current: UserTask): boolean {
  return actionConditions(previous) === actionConditions(current);
}
/** Existing task evidence is a conservative seen-fact baseline, not a semantic quality score. */
export function hasNewSupplementEvidence(ctx: MatchContext, refs: string[]): boolean {
  if (!canSkipSupplementReply(ctx)) return true;
  const knownIds = new Set(ctx.quietSupplementEvidenceIds ?? []);
  const previous = (ctx.task?.evidence ?? []).filter(
    (e) => knownIds.has(e.id) && e.kind === 'source_excerpt',
  );
  const urls = new Set(
    refs.flatMap((ref) => {
      const source = ctx.knowledgeSources?.find(
        (s) => s.ref === ref || s.passages.some((p) => p.id === ref),
      );
      return source ? [source.url] : [];
    }),
  );
  if ([...urls].some((url) => !previous.some((e) => e.url === url))) return true;
  return (ctx.task?.evidence ?? []).some(
    (e) => e.kind === 'source_excerpt' && !!e.url && urls.has(e.url) && !knownIds.has(e.id),
  );
}

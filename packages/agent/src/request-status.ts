import { canAskTaskQuestion } from '@matchbot/domain';
import type { MatchContext } from './context.js';

/**
 * A group message that did not address the assistant is unsolicited participation: it earns a
 * reply only when the reply helps the asker. Private chats and direct replies/@mentions are
 * conversations the user is waiting on.
 */
export function isUnsolicitedGroupTurn(
  ctx: Pick<MatchContext, 'groupId' | 'addressedToBot'>,
): boolean {
  return !!ctx.groupId && ctx.addressedToBot !== true;
}

/** A fixed status helps only when it carries the planned personal question that unblocks the task. */
export function hasStatusValue(ctx: MatchContext, status: string): boolean {
  return !isUnsolicitedGroupTurn(ctx) || status.includes('\n\n');
}

/** Fixed public status, never a rewrite of the rejected recommendation. */
export function renderRequestStatus(ctx: MatchContext): string | null {
  if (
    !ctx.isRequestStatusRun ||
    !ctx.currentRequest?.isActionable ||
    ctx.answerRecorded ||
    ctx.replySuppressed ||
    ctx.currentRequest.demand.category === 'job'
  )
    return null;
  const hasResults = !!(
    ctx.marketListings?.length ||
    ctx.knowledgeSources?.length ||
    ctx.xhsNotes?.length ||
    ctx.searchResults?.length
  );
  const attempted = !!(
    ctx.informationQueries?.length ||
    ctx.marketQueries?.length ||
    ctx.xhsQueries?.length ||
    ctx.supplierSearchEmpty
  );
  const searchFailed = ctx.sourceFailures?.some((f) => !f.startsWith('processing:'));
  const zh = ctx.currentRequest.demand.lang !== 'en';
  const intro = hasResults
    ? zh
      ? '我查到了一些线索，但这次没能整理成可靠的答复。'
      : 'I found some leads, but could not turn them into a reliable answer this time.'
    : searchFailed
      ? zh
        ? '刚才没查成，还没拿到结果。'
        : 'The search ran into a problem before I could get results.'
      : attempted && !ctx.answerInputExhausted
        ? zh
          ? '这轮没搜到合适的线索。'
          : 'This search did not return a suitable lead.'
        : zh
          ? '这次查询没能完成，还不能判断有没有合适的。'
          : 'I could not complete this request, so I cannot tell whether a suitable option is available.';
  const task =
    ctx.task?.ownerUserId === ctx.userId &&
    ctx.task.scope.chatId === ctx.chatId &&
    ctx.task.scope.channel === (ctx.channel ?? 'telegram')
      ? ctx.task
      : undefined;
  const next = task?.nextStep;
  if (!task || next?.action !== 'ask_user' || !next.constraintKey) return intro;
  // A failed search does not create a new user chore. Only an already-planned, unanswered personal constraint can be asked.
  const questions = {
    max_travel_minutes: {
      type: 'duration',
      zh: '单程最多能接受多久？',
      en: 'How long could a one-way trip be?',
    },
    area: { type: 'location', zh: '方便在哪一带？', en: 'Which area works for you?' },
    budget: { type: 'money', zh: '预算大概是多少？', en: 'What budget works for you?' },
    date: { type: 'date', zh: '你打算哪天用？', en: 'Which date do you need it for?' },
  } as const;
  const question = questions[next.constraintKey as keyof typeof questions];
  if (!question) return intro;
  const text = zh ? question.zh : question.en;
  return canAskTaskQuestion(task, {
    constraintKey: next.constraintKey,
    answerType: question.type,
    text,
    ...(next.goalId ? { goalId: next.goalId } : {}),
  })
    ? intro + '\n\n' + text
    : intro;
}

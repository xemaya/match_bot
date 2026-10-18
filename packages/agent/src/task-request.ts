import {
  assessTaskReadiness,
  taskSchema,
  type DemandDraft,
  type TaskConstraint,
} from '@matchbot/domain';
import type { MatchContext } from './context.js';
import type { CurrentRequest } from './current-request.js';

function describeConstraint(constraint: TaskConstraint): string {
  const value = constraint.value;
  switch (value.kind) {
    case 'money':
      return (
        `GBP ${value.amountPence / 100} (${value.unit})` +
        (constraint.budgetScope === 'rent_only'
          ? ' [rent only; bills are separate and total cost is not confirmed]'
          : constraint.budgetScope === 'all_in'
            ? ' [all-in total cost, including required bills/fees]'
            : '')
      );
    case 'duration':
      return (
        `${value.minutes} minutes` +
        (constraint.key === 'max_travel_minutes'
          ? ' [journey duration limit; do not infer a round trip]'
          : '')
      );
    case 'location':
      return value.area;
    case 'date_range':
      return value.from === value.to
        ? `${value.from} [exact requested date]`
        : `${value.from} to ${value.to} [acceptable window; no requirement to use the earliest day]`;
    case 'boolean':
      return value.value ? 'yes' : 'no';
    case 'text':
      return value.text;
  }
}

/** PRD §13: only selected task facts enter this request; unrelated user history stays isolated. */
export function taskCurrentRequest(ctx: MatchContext, input: string): CurrentRequest | null {
  if (!ctx.task) return null;
  const task = taskSchema.parse(ctx.task);
  if (
    task.ownerUserId !== ctx.userId ||
    task.scope.chatId !== ctx.chatId ||
    (task.scope.threadId ?? '') !== (ctx.threadId ?? '') ||
    task.scope.channel !== (ctx.channel ?? 'telegram')
  )
    throw new Error('selected task scope mismatch');
  assessTaskReadiness(task);
  const goals = task.goals.filter((g) => !g.userConfirmation);
  const constraints = task.constraints.filter(
    (c) => !c.goalId || goals.some((g) => g.id === c.goalId),
  );
  const budgets = goals.map(
    (g) =>
      constraints.find((c) => c.goalId === g.id && c.key === 'budget') ??
      constraints.find((c) => !c.goalId && c.key === 'budget'),
  );
  const amounts = new Set(
    budgets.map((c) =>
      c?.value.kind === 'money' && c.strength === 'hard' ? c.value.amountPence : undefined,
    ),
  );
  const budgetPence = amounts.size === 1 ? [...amounts][0] : undefined;
  const scopes = new Set(budgets.map((c) => c?.budgetScope)),
    scope = scopes.size === 1 ? [...scopes][0] : undefined;
  const area =
    constraints.find((c) => !c.goalId && c.key === 'route_from' && c.value.kind === 'location')
      ?.value ??
    constraints.find(
      (c) =>
        !c.goalId && (c.key === 'area' || c.key === 'travel_origin') && c.value.kind === 'location',
    )?.value;
  const outcode =
    area?.kind === 'location' && /^(?:SE|SW|NW|EC|WC|E|W|N)\d{1,2}[A-Z]?$/i.test(area.area)
      ? area.area.toUpperCase()
      : undefined;
  const need = goals.length ? goals.map((g) => g.title).join('；') : task.objective;
  const whenText = constraints
    .filter((c) => !c.goalId && ['date', 'day', 'time', 'move_in_date'].includes(c.key))
    .map((c) => describeConstraint(c))
    .join('; ');
  const destination = constraints.find(
    (c) => !c.goalId && c.key === 'route_to' && c.value.kind === 'location',
  )?.value;
  const toPostcode =
    destination?.kind === 'location' &&
    /^(?:SE|SW|NW|EC|WC|E|W|N)\d{1,2}[A-Z]?$/i.test(destination.area)
      ? destination.area.toUpperCase()
      : undefined;
  const quantity = constraints.find((c) => !c.goalId && c.key === 'quantity')?.value;
  const demand: DemandDraft = {
    category: task.category,
    confidence: 1,
    need: need.slice(0, 80),
    lang: /\p{Script=Han}/u.test(input) ? 'zh' : 'en',
    ...(budgetPence !== undefined ? { budgetPence } : {}),
    ...(scope ? { budgetScope: scope } : {}),
    ...(outcode ? { fromPostcode: outcode } : {}),
    ...(toPostcode ? { toPostcode } : {}),
    ...(whenText ? { whenText } : {}),
    ...(quantity?.kind === 'text' ? { quantity: quantity.text } : {}),
  };
  const text = [
    input,
    '当前目标：' + need,
    ...goals.flatMap((g) =>
      g.criteria.map((c) => `${g.title} / 验收条件 (${c.strength}): ${c.label}`),
    ),
    ...constraints.map((c) => {
      const subject = c.goalId ? goals.find((g) => g.id === c.goalId)?.title : '共同条件';
      return `${subject} / ${c.key} (${c.strength}): ${describeConstraint(c)}`;
    }),
  ].join('\n');
  const acknowledgement =
    /^(?:谢谢(?:你)?|好的|好|明白了|这个挺好|ok|thanks(?: you)?)[！!。.\s]*$/i.test(input.trim());
  return {
    text,
    demand,
    isActionable:
      !acknowledgement &&
      (!task.goals.length || goals.length > 0) &&
      !['completed', 'cancelled', 'expired'].includes(task.status),
  };
}

import {
  DEMAND_CATEGORIES,
  TASK_CONSTRAINT_KEYS,
  taskRequirementPatchSchema,
  type TaskConstraint,
  type TaskRequirementPatch,
  type UserTask,
} from '@matchbot/domain';
import { z } from 'zod';
import { clockNow } from './clock.js';

const reference = z.string().min(1).max(160);
const keySchema = z.union([
  z.enum([
    ...TASK_CONSTRAINT_KEYS,
    'max_price_per_item',
    'monthly_rent',
    'rent',
    'commute_minutes',
  ]),
  z.string().regex(/^custom:[a-z0-9_]{1,40}$/),
]);
const criterionInput = taskRequirementPatchSchema.shape.goals.element.shape.criteria.element.extend(
  { constraintKey: keySchema.nullable().default(null) },
);
export const taskPatchProposalSchema = taskRequirementPatchSchema.extend({
  goals: z
    .array(
      taskRequirementPatchSchema.shape.goals.element.extend({
        title: z.string().min(1).max(60),
        criteria: z.array(criterionInput).min(1).max(8),
      }),
    )
    .max(6),
  constraints: z
    .array(
      taskRequirementPatchSchema.shape.constraints.element.omit({ budgetScope: true }).extend({
        goalId: reference.nullable(),
        key: keySchema,
      }),
    )
    .max(24),
});
export const taskProposalSchema = z.strictObject({
  route: z.enum(['new', 'continue', 'clarify', 'ignore']),
  taskRef: reference.nullable(),
  referenceQuote: z.string().min(1).max(300).nullable(),
  objective: z.string().min(1).max(600).nullable(),
  category: z.enum(DEMAND_CATEGORIES).nullable(),
  patch: taskPatchProposalSchema.nullable(),
  outcome: z
    .strictObject({
      intent: z.enum(['achieved', 'cancelled']),
      goalIds: z.array(reference).max(6),
      quote: z.string().min(1).max(300),
    })
    .nullable(),
});
export type TaskProposal = z.infer<typeof taskProposalSchema>;
export class TaskProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskProposalError';
  }
}
function budgetScope(p: {
  condition: z.infer<typeof taskPatchProposalSchema>['constraints'][number];
  key: string;
  task: UserTask;
  text: string;
}): TaskConstraint['budgetScope'] {
  if (
    p.key !== 'budget' ||
    p.task.category !== 'housing' ||
    p.condition.value.kind !== 'money' ||
    p.condition.value.unit !== 'month'
  )
    return undefined;
  const clause =
    p.text.split(/[，,。；;\n]/).find((part) => part.includes(p.condition.sourceQuote)) ??
    p.condition.sourceQuote;
  if (
    /不(?:含|包).{0,8}(?:账单|水电|bills)|(?:excluding|without)\s+bills|rent[- ]?only/i.test(clause)
  )
    return 'rent_only';
  if (
    /总预算|总费用|总支出|all[- ]?in|total (?:budget|cost)|rent\s*(?:and|\+)\s*bills/i.test(
      clause,
    ) ||
    (!/更好|最好|优先|尽量|prefer|ideally|if possible/i.test(clause) &&
      /(?:包|含).{0,8}(?:账单|水电|bills)|(?:including|with)\s+bills/i.test(clause))
  )
    return 'all_in';
  if (/月租|房租|租金|\brent(?:al)?\b/i.test(clause)) return 'rent_only';
  return (
    p.task.constraints.find((c) => c.key === p.key && (c.goalId ?? null) === p.condition.goalId) ??
    p.task.constraints.find((c) => c.key === p.key && !c.goalId)
  )?.budgetScope;
}
function canonicalKey(key: string): string {
  return /^(?:max_price_per_item|monthly_rent|rent)$/.test(key)
    ? 'budget'
    : key === 'commute_minutes'
      ? 'max_travel_minutes'
      : key;
}
function checkMoney(
  constraint: z.infer<typeof taskPatchProposalSchema>['constraints'][number],
  task: UserTask,
): void {
  if (constraint.value.kind !== 'money') return;
  const sameKey = task.constraints.filter((c) => c.key === canonicalKey(constraint.key));
  const old = (
    sameKey.find((c) => (c.goalId ?? null) === constraint.goalId) ?? sameKey.find((c) => !c.goalId)
  )?.value;
  if (
    old?.kind === 'money' &&
    old.amountPence === constraint.value.amountPence &&
    old.unit === constraint.value.unit
  )
    return;
  const quote = constraint.sourceQuote.replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1');
  const amounts = (quote.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const amount = constraint.value.amountPence / 100;
  if (amounts.includes(amount) || (amount === 0 && /免费|free/i.test(quote))) return;
  if (
    old?.kind === 'money' &&
    old.unit === constraint.value.unit &&
    amounts.length === 1 &&
    !/到|至|\bto\b/i.test(quote)
  ) {
    const direction = /减|降低|少|\b(?:reduce|less)\b/i.test(quote)
      ? -1
      : /加|增加|提高|多|\b(?:increase|raise|more)\b/i.test(quote)
        ? 1
        : 0;
    const delta = quote.includes('%') ? (old.amountPence * amounts[0]!) / 100 : amounts[0]! * 100;
    if (
      direction &&
      Math.round(old.amountPence + direction * delta) === constraint.value.amountPence
    )
      return;
  }
  // Chinese amounts remain a semantic interpretation; do not reject natural-language budgets as missing data.
  if (!amounts.length && /[二两三四五六七八九十百千万]|一\s*(?:英镑|镑|磅)|^一$/.test(quote))
    return;
  throw new TaskProposalError(
    'Changed monetary amount needs the quoted amount or an explicit relative change from the existing budget; vague more/less is a question, not a new number.',
  );
}
function executableValue(p: {
  condition: z.infer<typeof taskPatchProposalSchema>['constraints'][number];
  key: string;
  task: UserTask;
  now: Date;
}): TaskConstraint['value'] {
  const { condition, key, task, now } = p;
  const value = condition.value;
  if ((key === 'area' || key === 'travel_origin') && value.kind === 'text')
    return { kind: 'location', area: value.text };
  if (key !== 'move_in_date' && key !== 'date') return value;
  if (value.kind !== 'text' && value.kind !== 'date_range') return value;
  const source = condition.sourceQuote;
  const explicit =
    !/之前|之后|前后|左右|大约|至|到|—|~/.test(source) && (source.match(/月/g) ?? []).length === 1
      ? source.match(/(?:(20\d{2})年)?(1[0-2]|[1-9])月(?:(3[01]|[12]\d|[1-9])日?)?/)
      : null;
  if (explicit) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now);
    const currentYear = Number(parts.find((p) => p.type === 'year')?.value);
    const currentMonth = Number(parts.find((p) => p.type === 'month')?.value);
    const old = (
      task.constraints.find((c) => c.key === key && (c.goalId ?? null) === condition.goalId) ??
      task.constraints.find((c) => c.key === key && !c.goalId)
    )?.value;
    const month = Number(explicit[2]);
    const year = Number(
      explicit[1] ??
        (old?.kind === 'date_range'
          ? old.from.slice(0, 4)
          : currentYear + Number(month < currentMonth)),
    );
    const start = `${year}-${String(month).padStart(2, '0')}-${explicit[3]?.padStart(2, '0') ?? '01'}`;
    const end = explicit[3]
      ? start
      : `${year}-${String(month).padStart(2, '0')}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`;
    if (!z.iso.date().safeParse(start).success || !z.iso.date().safeParse(end).success)
      throw new TaskProposalError(
        'The supplied calendar date is invalid; clarify it instead of shifting it to another day.',
      );
    return { kind: 'date_range', from: start, to: end };
  }
  const dates =
    (value.kind === 'text' ? value.text : source).match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? [];
  return dates.length && dates.every((date) => z.iso.date().safeParse(date).success)
    ? { kind: 'date_range', from: dates[0]!, to: dates[dates.length - 1]! }
    : value;
}
function checkDateSource(p: {
  value: TaskConstraint['value'];
  condition: z.infer<typeof taskPatchProposalSchema>['constraints'][number];
  key: string;
  task: UserTask;
}): void {
  if (p.value.kind !== 'date_range') return;
  const old = (
    p.task.constraints.find((c) => c.key === p.key && (c.goalId ?? null) === p.condition.goalId) ??
    p.task.constraints.find((c) => c.key === p.key && !c.goalId)
  )?.value;
  if (old?.kind === 'date_range' && old.from === p.value.from && old.to === p.value.to) return;
  const question = p.task.pendingQuestion;
  const answersDate =
    question?.deliveryStatus === 'sent' &&
    question.answerType === 'date' &&
    question.constraintKey === p.key &&
    (question.goalId ?? null) === p.condition.goalId;
  if (
    !answersDate &&
    !/(?:20\d{2}[-/])|\d{1,2}\s*(?:月|日|号|[/.])|明天|后天|今天|本月|下月|这个月|下个月|周|星期|明年|今年|\b(?:tomorrow|today|next|week|month|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      p.condition.sourceQuote,
    )
  )
    throw new TaskProposalError(
      'A changed date needs a current calendar/date statement or an answer to a delivered date question; unrelated conditions cannot move the date.',
    );
}
export function normalizeTaskPatch(p: {
  input: TaskProposal['patch'];
  task: UserTask;
  text: string;
  now?: Date;
}): TaskRequirementPatch | null {
  if (!p.input) return null;
  if (
    p.task.category === 'housing' &&
    p.input.goals.some(
      (goal) =>
        !/房|居室|公寓|住宅|住处|住所|套间|合租|整租|单间|\b(?:home|flat|apartment|studio|room|house)s?\b/i.test(
          goal.title,
        ),
    )
  )
    throw new TaskProposalError(
      'A housing property goal must identify the requested home; pets, budget, dates and bills are constraints/criteria on that home, not independent goals.',
    );
  let convertedOrigin = false;
  const constraints = p.input.constraints.map((c) => {
    if (
      c.value.kind === 'boolean' &&
      /^(?:custom:)?budget_(?:includes_bills|inclusions|scope)$/.test(c.key)
    )
      throw new TaskProposalError(
        'Use the money budget constraint for budget accounting; its scope is derived from the user quote. Do not create a boolean budget accounting requirement. A preference or requirement that the rent itself includes bills belongs in bills, with the user-stated strength.',
      );
    checkMoney(c, p.task);
    let key = canonicalKey(c.key);
    if (
      key === 'area' &&
      /我住|住在|\blive(?: in)?\b/i.test(c.sourceQuote) &&
      !/只在|必须在|只找|限定|\bonly\b/i.test(p.text)
    ) {
      key = 'travel_origin';
      convertedOrigin = true;
    }
    const { goalId, ...value } = c;
    // Qualifiers in the owner's clause outrank the model's proposed strength.
    // Do not propagate a preference across an adversative into another hard condition.
    const sourceClauses = p.text
      .split(/[，,。；;\n]|但是|但|\bbut\b/i)
      .filter((clause) => c.sourceQuote && clause.includes(c.sourceQuote));
    const explicitPreference =
      sourceClauses.length === 1 &&
      /^(?:\s*(?:我|我们)?\s*)(?:最好|尽量|优先|prefer(?:ably)?\b|ideally\b)/i.test(
        sourceClauses[0]!,
      ) &&
      !/必须|一定|不能|不得|\bmust\b|\brequired\b/i.test(sourceClauses[0]!);
    const executable = executableValue({
      condition: c,
      key,
      task: p.task,
      now: p.now ?? clockNow(),
    });
    checkDateSource({ value: executable, condition: c, key, task: p.task });
    const scope = budgetScope({ condition: c, key, task: p.task, text: p.text });
    return {
      ...value,
      ...(explicitPreference ? { strength: 'preference' as const } : {}),
      value: executable,
      ...(scope ? { budgetScope: scope } : {}),
      key,
      ...(goalId ? { goalId } : {}),
    };
  });
  const active = p.task.goals.filter((g) => !g.userConfirmation);
  const clause = p.text
    .split(/[，,。；;\n]/)
    .find((part) =>
      /^(?:(?:我)?(?:要|想要|需要|希望|必须(?:是)?|最好(?:是)?|尽量(?:是)?|优先|prefer|ideally)\s*)?(?:室内|indoor)(?:的|场地|球场|活动)?[.!！]?$/i.test(
        part.trim(),
      ),
    );
  const environment = clause?.match(/室内|\bindoor\b/i);
  if (p.task.counterparty === 'peer' && active.length === 1 && environment) {
    const strength = /最好|尽量|优先|prefer|ideally/i.test(clause!)
      ? ('preference' as const)
      : ('hard' as const);
    if (
      !constraints.some(
        (c) =>
          (c.strength === 'hard' || c.strength === strength) &&
          c.value.kind === 'text' &&
          /室内|\bindoor\b/i.test(c.value.text),
      )
    ) {
      const previous = p.task.constraints.find(
        (c) =>
          c.key === 'feature' &&
          c.value.kind === 'text' &&
          /^(?:室内|室外|室内场地|室外场地|indoor|outdoor)$/i.test(c.value.text),
      );
      constraints.push({
        key: previous?.key ?? 'custom:venue_environment',
        goalId: active[0]!.id,
        strength,
        value: { kind: 'text', text: environment[0] },
        sourceQuote: environment[0],
      });
    }
  }
  // A budget amount can stay unchanged while the owner changes what it must cover.
  const fixedTotal = p.text.match(
    /总(?:预算|费用|支出)(?:不能增加|不增加|不变|不能提高|不提高)/,
  )?.[0];
  const savedMonthly = p.task.constraints.filter(
    (c) =>
      c.key === 'budget' &&
      c.strength === 'hard' &&
      c.value.kind === 'money' &&
      c.value.unit === 'month',
  );
  if (
    p.task.category === 'housing' &&
    fixedTotal &&
    savedMonthly.length === 1 &&
    !constraints.some((c) => c.key === 'budget')
  ) {
    const saved = savedMonthly[0]!;
    constraints.push({
      key: 'budget',
      strength: saved.strength,
      value: saved.value,
      budgetScope: 'all_in',
      sourceQuote: fixedTotal,
      ...(saved.goalId ? { goalId: saved.goalId } : {}),
    });
  }
  const unique = constraints.filter(
    (c, index) =>
      !constraints
        .slice(0, index)
        .some(
          (old) =>
            old.key === c.key &&
            old.goalId === c.goalId &&
            old.strength === c.strength &&
            JSON.stringify(old.value) === JSON.stringify(c.value),
        ),
  );
  const available: Array<Pick<TaskConstraint, 'key' | 'goalId'>> = [
    ...p.task.constraints,
    ...unique,
  ];
  const goals = p.input.goals.map((goal) => {
    let hasSubject = false;
    const criteria = goal.criteria.flatMap((criterion) => {
      let constraintKey = criterion.constraintKey ? canonicalKey(criterion.constraintKey) : null;
      const has = (key: string) =>
        available.some((c) => c.key === key && (!c.goalId || c.goalId === goal.id));
      if (constraintKey === 'area' && convertedOrigin && !has('area') && has('travel_origin'))
        constraintKey = 'travel_origin';
      const optionalGap =
        !!constraintKey && !has(constraintKey) && criterion.strength === 'preference';
      // A3, PS5 and similar source-attested subject identifiers are not mutable budgets/dates.
      // A UK postcode district the user wrote (E14, SE1, SW1A) is a place, not a number, even
      // when the goal title does not repeat it (2026-10-21 run 6: "从E14出发" lost an ask).
      const labelWithoutSubjectCodes = criterion.label.replace(
        /\b(?:[a-z]+[a-z\d-]*\d[a-z\d-]*|\d+[a-z][a-z\d-]*)\b/gi,
        (code) => {
          const inText = (text: string) => new RegExp(`\\b${code}\\b`, 'i').test(text);
          const attested =
            [goal.title, p.text].every(inText) ||
            (/^[a-z]{1,2}\d[a-z\d]?$/i.test(code) && inText(p.text));
          return attested && !/^\d+(?:gbp|pounds?|mins?|minutes?|hours?|days?|months?)$/i.test(code)
            ? ''
            : code;
        },
      );
      if (!constraintKey && /\d/.test(labelWithoutSubjectCodes))
        throw new TaskProposalError(
          'Keep criterion labels parameter-free; bind monetary/date/numeric conditions with constraintKey rather than copying a value into the label.',
        );
      if (!constraintKey) {
        if (hasSubject) return [];
        hasSubject = true;
        return [
          {
            ...criterion,
            strength: 'hard' as const,
            constraintKey: null,
            label: /\p{Script=Han}/u.test(p.text)
              ? '来源描述的对象或邀约：' + goal.title
              : 'Subject described in the source: ' + goal.title,
          },
        ];
      }
      const label = optionalGap
        ? '核对信息：' + constraintKey
        : constraintKey
          ? '核对当前条件：' + constraintKey
          : criterion.label;
      return [{ ...criterion, constraintKey: optionalGap ? null : constraintKey, label }];
    });
    if (!hasSubject)
      criteria.unshift({
        id: 'subject:' + goal.id,
        strength: 'hard',
        constraintKey: null,
        label: /\p{Script=Han}/u.test(p.text)
          ? '来源描述的对象或邀约：' + goal.title
          : 'Subject described in the source: ' + goal.title,
      });
    return { ...goal, criteria };
  });
  return taskRequirementPatchSchema.parse({ goals, constraints: unique });
}

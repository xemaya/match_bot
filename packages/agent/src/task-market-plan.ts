import type { TaskConstraint, UserTask } from '@matchbot/domain';
import { selectMarketTradeType } from '@matchbot/gating';
import {
  getMarketCityAliases,
  normalizeMarketPreference,
  type MarketPlan,
  type MarketRules,
} from './market-strategy.js';

function textValue(c: TaskConstraint): string | null {
  return c.value.kind === 'text' ? c.value.text : c.value.kind === 'location' ? c.value.area : null;
}
export function resolveTaskMarketTarget(
  task: UserTask | undefined,
  input: string,
): 'BUY' | 'SELL' | 'PEER' | 'ANY' {
  if (task?.counterparty === 'demand') return 'BUY';
  if (task?.counterparty === 'supply') return 'SELL';
  if (task?.counterparty === 'peer') return 'PEER';
  return selectMarketTradeType(task?.objective ?? input);
}
function budget(constraints: TaskConstraint[]): number | undefined {
  const value = constraints.find(
    (c) => c.key === 'budget' && c.strength === 'hard' && c.value.kind === 'money',
  )?.value;
  return value?.kind === 'money' ? value.amountPence / 100 : undefined;
}

function rulesForConstraints(
  constraints: TaskConstraint[],
  intent: MarketPlan['intent'],
): MarketRules {
  const shared = constraints;
  const sharedBudget = budget(shared);
  const budgetValue = shared.find((c) => c.key === 'budget' && c.strength === 'hard')?.value;
  const qualitative = constraints.filter((c) =>
    /^(?:level|day|time|room_type|pets|feature|condition|requirements|required_terms)$/.test(c.key),
  );
  const preferences = qualitative.flatMap((c) =>
    textValue(c) ? [normalizeMarketPreference(textValue(c)!)] : [],
  );
  const essentialPreferences = qualitative
    .filter((c) => c.strength === 'hard')
    .flatMap((c) => (textValue(c) ? [normalizeMarketPreference(textValue(c)!)] : []));
  const requiredArea = shared
    .filter((c) => c.key === 'area' && c.strength === 'hard')
    .flatMap((c) => (textValue(c) ? [textValue(c)!] : []));
  const from = shared.find((c) => c.key === 'route_from'),
    to = shared.find((c) => c.key === 'route_to');
  const routeFrom = from ? textValue(from) : null,
    routeTo = to ? textValue(to) : null;
  const date = shared.find(
    (c) =>
      /^(?:date|event_date|date_range)$/.test(c.key) &&
      c.strength === 'hard' &&
      c.value.kind === 'date_range',
  )?.value;
  const capacity = shared.find((c) => /^(?:capacity|capacity_kg)$/.test(c.key));
  const weight = capacity
    ? textValue(capacity)?.match(/^(\d+(?:\.\d+)?)\s*(?:公斤|kg|千克)?$/i)
    : null;
  return {
    preferences: [...new Set(preferences)],
    essentialPreferences: [...new Set(essentialPreferences)],
    requiredArea,
    requiredTerms: constraints
      .filter((c) => /^(?:required_terms|feature)$/.test(c.key) && c.strength === 'hard')
      .flatMap((c) => (textValue(c) ? [textValue(c)!] : [])),
    excludeTerms: constraints
      .filter((c) => /^(?:exclude|exclude_terms|not_allowed)$/.test(c.key))
      .flatMap((c) => (textValue(c) ? [textValue(c)!] : [])),
    ...(sharedBudget !== undefined ? { budget: sharedBudget } : {}),
    ...(budgetValue?.kind === 'money' ? { budgetUnit: budgetValue.unit } : {}),
    ...(shared.find((c) => c.key === 'budget')?.budgetScope
      ? { budgetScope: shared.find((c) => c.key === 'budget')!.budgetScope! }
      : {}),
    ...(routeFrom && routeTo
      ? { route: { from: getMarketCityAliases(routeFrom), to: getMarketCityAliases(routeTo) } }
      : {}),
    ...(intent !== 'housing' && date?.kind === 'date_range'
      ? { dateRange: { from: date.from, to: date.to } }
      : {}),
    ...(weight ? { capacityKg: Number(weight[1]) } : {}),
  };
}

/** PRD §13: evaluate each goal against its own effective conditions, never another item's conditions. */
export function bindTaskMarketPlan(plan: MarketPlan, task: UserTask): MarketPlan {
  const goals = task.goals.filter((g) => !g.userConfirmation);
  const shared = task.constraints.filter((c) => !c.goalId);
  const scoped = (goalId: string) => {
    const effective = new Map(shared.map((c) => [c.key, c]));
    for (const condition of task.constraints.filter((c) => c.goalId === goalId))
      effective.set(condition.key, condition);
    return [...effective.values()];
  };
  const base = goals.length === 1 ? scoped(goals[0]!.id) : shared;
  // The model names its needs itself ("room_share"), the task names goals ("east_london_room").
  // Aliases matched only by id were silently dropped, leaving the goal title and its long search
  // phrases as the only subject terms: 2026-10-20 replay, 109 A2H listings, none judged on-topic.
  const aliasesFor = (goal: UserTask['goals'][number], index: number): string[] => {
    const byId = plan.needs.find((need) => need.id === goal.id);
    if (byId) return byId.terms;
    if (goals.length === 1) return plan.needs.flatMap((need) => need.terms);
    if (plan.needs.length === goals.length) return plan.needs[index]?.terms ?? [];
    return [];
  };
  return {
    intent: plan.intent,
    ...rulesForConstraints(base, plan.intent),
    needs: goals.map((goal, index) => {
      const aliases = aliasesFor(goal, index);
      const conditions = scoped(goal.id);
      const rules = rulesForConstraints(conditions, plan.intent);
      // Activity titles often include scheduling/participant qualifiers. Those are checked
      // independently; requiring the whole phrase as an exact subject loses valid offers.
      let activitySubject = goal.title;
      if (plan.intent === 'companion') {
        for (const c of conditions.filter((c) =>
          ['day', 'time', 'level', 'area'].includes(c.key),
        )) {
          const modifier = textValue(c);
          if (modifier) activitySubject = activitySubject.replaceAll(modifier, '').trim();
        }
        activitySubject = activitySubject.replace(/(?:搭子|球友|伙伴)$/, '').trim();
      }
      return {
        id: goal.id,
        terms: [
          ...new Set([
            goal.title,
            goal.title
              .replace(
                /(?:(?:房源|候选|推荐|信息|线索)|(?:\s+(?:listings?|candidates?|recommendations?|options?)))+$/i,
                '',
              )
              .trim(),
            ...(plan.intent === 'companion' && activitySubject.length >= 2
              ? [activitySubject]
              : []),
            ...aliases,
            ...(goal.searchTerms ?? []),
          ]),
        ]
          .filter(Boolean)
          .slice(0, 12),
        rules,
        ...(rules.budget !== undefined ? { budget: rules.budget } : {}),
      };
    }),
  };
}

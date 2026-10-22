import { isActiveMarketListing, hasLondonEvidence } from '@matchbot/websearch';
import type { MarketCandidate } from './market-research.js';
import type { UserTask } from '@matchbot/domain';
import { assessTaskMarketListing } from './task-market-assessment.js';
import { assessMarketListing, type MarketAssessment, type MarketPlan } from './market-strategy.js';
import { clockNow } from './clock.js';
export type MarketChoice = {
  listing: MarketCandidate;
  assessment: MarketAssessment;
  reasons: string[];
  warning: string | null;
  missing: string[];
  essentialMissing: string[];
};
export type MarketChoices = { primary: MarketChoice[]; backup: MarketChoice[] };
export function getMarketSourceIdentity(listing: MarketCandidate): string {
  if (listing.sourceUrl) {
    const url = new URL(listing.sourceUrl);
    const id = url.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)$/)?.[1];
    if (id && /(^|\.)xiaohongshu\.com$/i.test(url.hostname)) return `xhs:${id}`;
  }
  return listing.id;
}
export function describeMarketCondition(label: string, plan: MarketPlan): string {
  if (label.startsWith('task:')) return label.slice(5);
  if (label.startsWith('preference:')) return label.slice(11);
  const labels: Record<string, string> = {
    budget: plan.intent === 'housing' ? '租金/计价单位' : '价格/计价单位',
    area: '地点',
    route: '路线',
    date: '日期/年份',
    date_conflict: '行程与可用期冲突',
    availability: '可用状态',
    required: '必要条件',
    skill: '活动水平',
    excluded: '排除条件',
  };
  return labels[label] ?? label;
}
function describeReasons(
  assessment: MarketAssessment,
  plan: MarketPlan,
  tradeType: MarketCandidate['tradeType'],
): string[] {
  const labels: Record<string, string> = {
    budget:
      tradeType === 'BUY'
        ? '买家报价达到要求'
        : plan.intent === 'housing'
          ? '月租报价符合预算'
          : '单品报价符合预算',
    area: '地点符合你指定的范围',
    route: '路线方向与你一致',
    date: '时间在你要求的范围内',
    required: '明确要求的条件有原文支持',
  };
  return ['budget', 'area', 'route', 'date', 'required']
    .filter((label) =>
      assessment.checks.some((check) => check.label === label && check.status === 'met'),
    )
    .map((label) => labels[label]!);
}
function itemWarning(n: MarketCandidate, plan: MarketPlan, name?: string): string | null {
  if (plan.intent !== 'second_hand' || n.tradeType !== 'SELL') return null;
  const terms = plan.needs.flatMap((need) => need.terms);
  const normalize = (s: string) => s.toLowerCase().replace(/\s/g, '');
  const matches = (s: string) => terms.some((term) => normalize(s).includes(normalize(term)));
  const lines = n.description
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = lines.filter((line) => /^[-•]/.test(line) && matches(line));
  const warning = /瑕疵|划痕|破损|战损|故障|需要维修|无法使用|两年没用|不工作|not working|broken/i;
  for (const [index, line] of lines.entries()) {
    if (name && bullets.length > 1 ? !normalize(line).includes(normalize(name)) : !matches(line))
      continue;
    const next = lines[index + 1] ?? '';
    const block = line + (/^[-•]|^[0-9]️⃣|^——原帖/.test(next) ? '' : '\n' + next);
    const evidence = block
      .split(/[\n，。;；]/)
      .find(
        (row) =>
          warning.test(row) &&
          !/(?:无|没有|未见|不存在)[^，。;；]{0,6}(?:瑕疵|划痕|破损|故障)/.test(row),
      );
    if (evidence) return evidence;
  }
  return null;
}
export function buildMarketChoices(p: {
  candidates: MarketCandidate[];
  plan: MarketPlan;
  names?: Record<string, string>;
  task?: UserTask;
}): MarketChoices {
  const rows = p.candidates
    .filter(
      (listing) =>
        isActiveMarketListing(listing, clockNow(), { respectAvailability: false }) &&
        hasLondonEvidence(listing),
    )
    .map((listing): MarketChoice => {
      const assessment = p.task
        ? assessTaskMarketListing(listing, p.plan, p.task, p.names?.[listing.ref])
        : assessMarketListing(listing, p.plan, p.names?.[listing.ref]);
      const unknown = assessment.checks.filter((check) => check.status === 'unknown');
      const essentialPreferences = new Set([
        ...(p.plan.essentialPreferences ?? []),
        ...p.plan.needs
          .filter((need) => assessment.needs.includes(need.id))
          .flatMap((need) => need.rules?.essentialPreferences ?? []),
      ]);
      return {
        listing,
        assessment,
        reasons: describeReasons(assessment, p.plan, listing.tradeType),
        warning: itemWarning(
          listing,
          { ...p.plan, needs: p.plan.needs.filter((need) => assessment.needs.includes(need.id)) },
          p.names?.[listing.ref],
        ),
        missing: [...new Set(unknown.map((c) => describeMarketCondition(c.label, p.plan)))],
        essentialMissing: unknown
          .filter(
            (c) =>
              !c.label.startsWith('preference:') || essentialPreferences.has(c.label.slice(11)),
          )
          .map((c) => describeMarketCondition(c.label, p.plan)),
      };
    })
    .filter(
      (row) =>
        row.assessment.needs.length && !row.assessment.checks.some((c) => c.status === 'mismatch'),
    )
    .sort(
      (a, b) =>
        Number(a.essentialMissing.length > 0) - Number(b.essentialMissing.length > 0) ||
        Number(!!a.warning) - Number(!!b.warning) ||
        b.assessment.score - a.assessment.score ||
        compareQuotedPrices(a, b) ||
        a.listing.id.localeCompare(b.listing.id),
    );
  const identities = new Set<string>();
  const unique = rows.filter((row) => {
    const entity = p.names?.[row.listing.ref] ?? (sourceEntity(row, p.plan) || row.listing.id);
    const identity =
      getMarketSourceIdentity(row.listing) +
      ':' +
      entity.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
  const primary = coverNeeds(
    unique.filter((r) => !r.essentialMissing.length),
    p.plan,
    3,
  );
  const backup = coverNeeds(
    unique.filter((r) => r.essentialMissing.length),
    p.plan,
    primary.length ? 2 : 3,
  );
  return { primary, backup };
}
function compareQuotedPrices(a: MarketChoice, b: MarketChoice): number {
  const first = a.assessment.itemPriceGBP,
    second = b.assessment.itemPriceGBP;
  if (!first || !second) return 0;
  return a.listing.tradeType === 'BUY' ? second.min - first.min : first.max - second.max;
}
function coverNeeds(rows: MarketChoice[], plan: MarketPlan, limit: number): MarketChoice[] {
  const selected: MarketChoice[] = [];
  for (const need of plan.needs) {
    const row = rows.find((r) => r.assessment.needs.includes(need.id) && !selected.includes(r));
    if (row && selected.length < limit) selected.push(row);
  }
  for (const row of rows)
    if (!selected.includes(row) && selected.length < limit) selected.push(row);
  return selected;
}
export type MarketResearchTask = {
  ref: string;
  missing: string[];
  action: 'detail' | 'search';
  entity?: string;
  keyword?: string;
};
export function buildMarketResearchTasks(p: {
  choices: MarketChoices;
  plan: MarketPlan;
  detailIds: string[];
  queries: string[];
  remainingDetails: number;
  remainingQueries: number;
}): MarketResearchTask[] {
  const rows = [...p.choices.primary, ...p.choices.backup].filter((r) => r.missing.length);
  const tasks: MarketResearchTask[] = [];
  const knownQueries = new Set(p.queries.map((q) => q.toLocaleLowerCase()));
  let details = p.remainingDetails,
    searches = p.remainingQueries;
  for (const row of rows) {
    if (tasks.length >= 3) break;
    if (!p.detailIds.includes(row.listing.id) && details > 0) {
      tasks.push({ ref: row.listing.ref, missing: row.missing, action: 'detail' });
      details--;
      continue;
    }
    const entity = sourceEntity(row, p.plan);
    const suffix = row.essentialMissing[0] ?? row.missing[0];
    const field =
      suffix === '价格/计价单位' || suffix === '租金/计价单位'
        ? p.plan.intent === 'housing'
          ? '月租'
          : '价格'
        : suffix === '日期/年份' || suffix === '行程与可用期冲突'
          ? '时间'
          : suffix;
    const keyword = `${entity} ${field}`;
    if (
      !entity ||
      !field ||
      keyword.length > 60 ||
      searches <= 0 ||
      knownQueries.has(keyword.toLocaleLowerCase())
    )
      continue;
    tasks.push({ ref: row.listing.ref, missing: row.missing, action: 'search', entity, keyword });
    knownQueries.add(keyword.toLocaleLowerCase());
    searches--;
  }
  return tasks;
}
function sourceEntity(row: MarketChoice, plan: MarketPlan): string {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const terms = plan.needs
    .filter((need) => row.assessment.needs.includes(need.id))
    .flatMap((need) => need.terms);
  const item = row.listing.description
    .split('\n')
    .find(
      (line) =>
        /^\s*[-•]/.test(line) && terms.some((term) => normalize(line).includes(normalize(term))),
    );
  const name = item
    ?.replace(/^\s*[-•]\s*/, '')
    .split('｜')[0]
    ?.trim();
  return name && name.length <= 40
    ? name
    : (terms.find((term) => row.listing.description.includes(term) && term.length >= 2) ?? '');
}

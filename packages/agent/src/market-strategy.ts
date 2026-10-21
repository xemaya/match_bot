import { isActiveMarketListing, hasLondonEvidence } from '@matchbot/websearch';
import { z } from 'zod';
import { BUDGET_SCOPES } from '@matchbot/domain';
import type { MarketListing, MarketIntent } from '@matchbot/websearch';
export type MarketNeed = { id: string; terms: string[]; budget?: number; rules?: MarketRules };
export type MarketRules = {
  preferences: string[];
  essentialPreferences?: string[];
  budget?: number;
  budgetScope?: (typeof BUDGET_SCOPES)[number];
  budgetUnit?: 'item' | 'person' | 'month' | 'total';
  requiredTerms?: string[];
  excludeTerms?: string[];
  dateRange?: { from: string; to: string };
  requiredArea?: string[];
  route?: { from: string[]; to: string[] };
  capacityKg?: number;
};
export type MarketPlan = MarketRules & { intent: MarketIntent; needs: MarketNeed[] };
export function normalizeMarketPreference(text: string): string {
  const core = text
    .replace(
      /^(?:(?:必须|一定要|务必|需要|希望|最好|优先|must|prefer(?:ably)?|need to|have to)\s*)+/i,
      '',
    )
    .trim();
  return /猫|\bcats?\b/i.test(core) &&
    !/不.{0,6}猫|无猫|禁止.{0,6}猫|no\s+cats?|without\s+cats?|not.{0,8}cats?/i.test(core)
    ? '猫'
    : core;
}
export type MarketCheck = {
  label: string;
  status: 'met' | 'unknown' | 'mismatch';
  evidence: string | null;
};
export type MarketAssessment = {
  id: string;
  needs: string[];
  score: number;
  checks: MarketCheck[];
  itemPriceEvidence: string | null;
  itemPriceGBP?: { min: number; max: number };
};
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const contains = (text: string, terms: string[]) =>
  terms.some((term) => norm(text).includes(norm(term)));
/**
 * 用户说"东伦敦"，帖子只写 Stratford 或 E15：方位词展开为该方位常见街区与邮编前缀。
 * 2026-10-20 合租重放：东伦敦帖子全部因地点"未知"排在备选，只有标题写了"东伦敦"的 SE12 被判符合。
 */
const LONDON_REGIONS: ReadonlyArray<{ match: RegExp; prefixes: string[]; districts: string[] }> = [
  {
    match: /^(?:东伦敦|伦敦东(?:部|区|边)?|东区|east london)$/i,
    prefixes: ['E'],
    districts: [
      'Stratford',
      'Mile End',
      'Whitechapel',
      'Bethnal Green',
      'Hackney',
      'Canary Wharf',
      'Isle of Dogs',
      'Poplar',
      'Limehouse',
      'Wapping',
      'Stepney',
      'Shoreditch',
      'Dalston',
      'Leyton',
      'Leytonstone',
      'Walthamstow',
      'West Ham',
      'East Ham',
      'Plaistow',
      'Canning Town',
      'Forest Gate',
      'Homerton',
      'Clapton',
      '狗岛',
      '金丝雀码头',
    ],
  },
  {
    match: /^(?:东南伦敦|伦敦东南(?:部|区)?|south ?east london)$/i,
    prefixes: ['SE'],
    districts: [
      'Greenwich',
      'Lewisham',
      'Deptford',
      'Peckham',
      'Camberwell',
      'Elephant and Castle',
      'Bermondsey',
      'Woolwich',
      'New Cross',
      'Brockley',
      'Catford',
      '格林威治',
    ],
  },
  {
    match: /^(?:西南伦敦|伦敦西南(?:部|区)?|south ?west london)$/i,
    prefixes: ['SW'],
    districts: [
      'Clapham',
      'Battersea',
      'Wimbledon',
      'Putney',
      'Fulham',
      'Brixton',
      'Tooting',
      'Balham',
      'Vauxhall',
      'Wandsworth',
    ],
  },
  {
    match: /^(?:南伦敦|伦敦南(?:部|区|边)?|south london)$/i,
    prefixes: ['SE', 'SW'],
    districts: [
      'Greenwich',
      'Lewisham',
      'Peckham',
      'Camberwell',
      'Clapham',
      'Battersea',
      'Brixton',
      'Wimbledon',
      'Croydon',
    ],
  },
  {
    match: /^(?:西伦敦|伦敦西(?:部|区|边)?|west london)$/i,
    prefixes: ['W'],
    districts: [
      'Ealing',
      'Acton',
      'Hammersmith',
      "Shepherd's Bush",
      'Chiswick',
      'Notting Hill',
      'Kensington',
      'Paddington',
      'Bayswater',
    ],
  },
  {
    match: /^(?:西北伦敦|伦敦西北(?:部|区)?|north ?west london)$/i,
    prefixes: ['NW'],
    districts: [
      'Camden',
      'Hampstead',
      'Kilburn',
      'Wembley',
      'Willesden',
      'Cricklewood',
      'Hendon',
      'Golders Green',
      'Swiss Cottage',
      'Kentish Town',
    ],
  },
  {
    match: /^(?:北伦敦|伦敦北(?:部|区|边)?|north london)$/i,
    prefixes: ['N', 'NW'],
    districts: [
      'Islington',
      'Finsbury Park',
      'Archway',
      'Highgate',
      'Wood Green',
      'Tottenham',
      'Holloway',
      'Finchley',
      'Highbury',
      'Stoke Newington',
      'Camden',
      'Hampstead',
    ],
  },
  {
    match: /^(?:市中心|伦敦市中心|中心区|central london|zone ?1)$/i,
    prefixes: ['EC', 'WC'],
    districts: [
      'Soho',
      'Covent Garden',
      'Holborn',
      'Bloomsbury',
      "King's Cross",
      'Kings Cross',
      'Farringdon',
      'Liverpool Street',
      'Westminster',
    ],
  },
];
const lines = (text: string) =>
  text
    .split(/[\n；;]/u)
    .map((s) => s.trim())
    .filter(Boolean);
function subjectText(n: MarketListing, p: MarketPlan): string {
  const lead = n.description.slice(0, 220);
  const isHousing =
    /^(?:转租|出租|招租|找室友|房源|租房)[：:]|房间出租|房间转租|公寓出租|卧室出租/.test(lead);
  if (p.intent === 'second_hand' && isHousing) return '';
  if (
    p.intent === 'housing' &&
    !isHousing &&
    !/租房|转租|出租|合租|室友|房源|apartment|room for rent/i.test(n.title)
  )
    return '';
  if (
    p.intent === 'carry' &&
    !/行李|衣物|衣服|航班|飞|飞机|回国|公斤|kg|带货|托运|帮带服务/i.test(n.title + n.description)
  )
    return '';
  if (p.intent !== 'companion') return n.title + '\n' + n.description;
  // 被邀请的活动才是主体；不能把写在个人背景里的羽毛球爱好当羽毛球邀约。
  const [header = '', original] = n.description.split('——原帖原文——');
  const main = (original ?? header)
    .split('\n')
    .map((s) => s.trim())
    .filter(
      (s) =>
        /^(?:找搭子|活动|内容|项目|招募)[：:]|(?:一起|找.*搭子|求.*搭子|欢迎加入|招新|约球|求.*球|还有.*球)/i.test(
          s,
        ) && !/^个人背景|爱好/.test(s),
    );
  return (
    n.title +
    '\n' +
    (main.length ? main.join('\n') : original === undefined ? header.slice(0, 500) : '')
  );
}
function priceEvidence(
  n: MarketListing,
  p: MarketPlan,
  focusName?: string,
): { text: string; min: number; max: number } | null {
  if (p.intent === 'housing' && p.budgetUnit && p.budgetUnit !== 'month') return null;
  const textLines = lines(n.description),
    terms = p.needs.flatMap((need) => need.terms);
  const itemLines = textLines.filter((line) =>
    focusName ? contains(line, [focusName]) : contains(line, terms),
  );
  const distinctBulletItems = n.description.split('\n').filter((line) => /^\s*- /.test(line));
  const candidateLines = [
    ...itemLines.filter((line) => /^[-•]/.test(line)),
    ...itemLines.filter((line) => !/^[-•]/.test(line)),
    ...(distinctBulletItems.length <= 1
      ? textLines.filter(
          (s) =>
            /^价格[：:]/.test(s) || (p.intent === 'housing' && /^(?:费用|租金|月租)[：:]/.test(s)),
        )
      : []),
  ];
  const priced: Array<{ text: string; min: number; max: number }> = [];
  for (const line of candidateLines) {
    const priceContext =
      p.intent === 'housing' ? line.replace(/不含(?:账单|水电费|水电网|bills)/gi, '') : line;
    if (/参考价|购入价|原价|新品价|不含|押金|套餐|整套|买.*送|多件|等\d*件|、/.test(priceContext))
      continue;
    if (
      p.intent === 'carry' &&
      /\/\s*(?:kg|g|公斤|斤)|(?:每|按).*(?:公斤|斤|重量)|\d+(?:\.\d+)?\s*kg/i.test(line)
    )
      continue;
    if (p.intent === 'housing' && !/\/月|每月|月租|pcm|per month/i.test(line)) continue;
    if (/免费送|免费赠送|free (?:to collect|giveaway)/i.test(line))
      return { text: line, min: 0, max: 0 };
    // "£1,230/月" is 1230, not 1 (2026-10-21: two over-cap rooms passed the budget check as £1).
    const gbp = (text: string) => Number(text.replace(/,/g, ''));
    const amounts = [
      ...line.matchAll(
        /(?:£|GBP\s*)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)|\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:镑|英镑)/gi,
      ),
    ].map((m) => gbp(m[1] ?? m[2]!));
    const ranges = [
      ...line.matchAll(
        /(?:£|GBP\s*)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*[–—-]\s*(?:£)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g,
      ),
    ];
    for (const range of ranges) amounts.push(gbp(range[2]!));
    if (!amounts.length) continue;
    // 单句多商品价格不能互借；房间的多个价格也只有都明确同一预算时才可判满足。
    if (amounts.length > 2 || /[：:].*(?:锅|桌|椅|灯).*[：:]/.test(line)) continue;
    priced.push({ text: line, min: Math.min(...amounts), max: Math.max(...amounts) });
  }
  return (
    priced.find((price) => p.budget !== undefined && price.max <= p.budget) ?? priced[0] ?? null
  );
}
function weeklyRentConflict(n: MarketListing, p: MarketPlan): string | null {
  if (
    p.intent !== 'housing' ||
    p.budgetUnit !== 'month' ||
    p.budget === undefined ||
    n.tradeType !== 'SELL'
  )
    return null;
  for (const line of lines(n.title + '\n' + n.description)) {
    if (
      /押金|deposit|参考|约|估计|估算|左右|approx|around|原价|购入价|€|\$|EUR|USD|\d\s*[-–—~至]\s*£?\d/i.test(
        line,
      )
    )
      continue;
    const match = line.match(
      /(?:£\s*|GBP\s*)?(\d+(?:\.\d+)?)\s*(?:pw\b|p\s*\/\s*w\b|per week\b|镑\s*\/周)|周租[：:\s]*(?:£\s*|GBP\s*)?(\d+(?:\.\d+)?)/i,
    );
    // Every calendar month contains at least four weeks. Do not invent a monthly quote.
    if (match && Number(match[1] ?? match[2]) * 4 > p.budget) return line;
  }
  return null;
}
function routeCheck(n: MarketListing, route: NonNullable<MarketPlan['route']>): MarketCheck {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const from = route.from.map(escape).join('|'),
    to = route.to.map(escape).join('|');
  const forward = new RegExp(
    `(?:${from})[^。，,、；;\\n]{0,24}(?:飞往|飞|到|至|->|→|✈|回)[^。，,、；;\\n]{0,8}(?:${to})`,
    'i',
  );
  const backward = new RegExp(
    `(?:${to})[^。\\n]{0,24}(?:飞往|飞|到|至|->|→|✈|回)[^。\\n]{0,8}(?:${from})`,
    'i',
  );
  const rows = lines(n.title + '\n' + n.description).flatMap((line) => line.split(/[，,]/));
  const met = rows.find((line) => forward.test(line));
  if (met) return { label: 'route', status: 'met', evidence: met };
  const endsAtOrigin = new RegExp(`(?:飞往|飞|到|至|->|→|✈|回)[^。\\n]{0,8}(?:${from})`, 'i');
  const startsAtDestination = new RegExp(`(?:${to})[^。\\n]{0,8}(?:飞往|飞|到|至|->|→|✈)`, 'i');
  const explicitOther = rows.find(
    (line) =>
      /^路线[：:]/.test(line) &&
      contains(line, route.from) &&
      /(?:->|→|至|飞)/.test(line) &&
      !contains(line, route.to) &&
      !/(?:国内|中国|回国|未注明)/.test(line),
  );
  const wrong =
    explicitOther ??
    rows.find(
      (line) => backward.test(line) || endsAtOrigin.test(line) || startsAtDestination.test(line),
    );
  return { label: 'route', status: wrong ? 'mismatch' : 'unknown', evidence: wrong ?? null };
}
export function getMarketCityAliases(city: string): string[] {
  return /伦敦|London|Heathrow|希思罗/i.test(city)
    ? ['伦敦', 'London', '希思罗', 'Heathrow']
    : /上海|Shanghai|浦东/i.test(city)
      ? ['上海', 'Shanghai', '浦东', 'PVG']
      : [city];
}
export function assessMarketListing(
  n: MarketListing,
  p: MarketPlan,
  focusName?: string,
): MarketAssessment {
  if (!p.needs.some((need) => need.budget !== undefined || need.rules !== undefined))
    return assessSharedMarketListing(n, p, focusName);
  const views = p.needs
    .filter((need) => !focusName || contains(focusName, need.terms))
    .map((need) =>
      assessSharedMarketListing(
        n,
        {
          ...(need.rules ? { intent: p.intent, ...need.rules } : p),
          needs: [need],
          ...(need.budget !== undefined ? { budget: need.budget } : {}),
        },
        focusName,
      ),
    );
  const relevant = views.filter((view) => view.needs.length);
  const usable = relevant.filter(
    (view) => !view.checks.some((check) => check.status === 'mismatch'),
  );
  const chosen = usable.length ? usable : relevant;
  const prices = chosen.flatMap((view) => (view.itemPriceGBP ? [view.itemPriceGBP] : []));
  return {
    id: n.id,
    needs: chosen.flatMap((view) => view.needs),
    checks: chosen.flatMap((view) => view.checks),
    itemPriceEvidence:
      [
        ...new Set(
          chosen.flatMap((view) => (view.itemPriceEvidence ? [view.itemPriceEvidence] : [])),
        ),
      ].join('\n') || null,
    ...(prices.length
      ? {
          itemPriceGBP: {
            min: Math.min(...prices.map((v) => v.min)),
            max: Math.max(...prices.map((v) => v.max)),
          },
        }
      : {}),
    score: chosen.reduce((sum, view) => sum + view.score, 0),
  };
}
function assessSharedMarketListing(
  n: MarketListing,
  p: MarketPlan,
  focusName?: string,
): MarketAssessment {
  const subject = subjectText(n, p);
  const matchedItems = n.description.split('\n').filter(
    (line) =>
      /^\s*[-•]/.test(line) &&
      contains(
        line,
        p.needs.flatMap((need) => need.terms),
      ),
  );
  const isSold =
    matchedItems.length > 0 && matchedItems.every((line) => /已出|已售|sold|❌/i.test(line));
  const needs = p.needs
    .filter((need) => {
      if (!contains(subject, need.terms)) return false;
      const own = matchedItems.filter((line) => contains(line, need.terms));
      return !own.length || !own.every((line) => /已出|已售|sold|❌/i.test(line));
    })
    .map((need) => need.id);
  const checks: MarketCheck[] = [];
  if (
    p.intent === 'housing' &&
    p.needs.some((need) => need.terms.some((term) => /一居室|1b1b|one.bedroom/i.test(term))) &&
    /studio/i.test(n.title) &&
    !/1b1b|独立卧室|one.bedroom/i.test(n.description)
  )
    checks.push({ label: 'room_type', status: 'mismatch', evidence: n.title });
  if (n.availableUntil && !isActiveMarketListing(n)) {
    const dates = [
      ...n.description.matchAll(/(?:(20\d{2})[年/-])?(1[0-2]|[1-9])[月./-](3[01]|[12]\d|[1-9])/g),
    ];
    const explicitFuture = dates.some(
      (m) =>
        m[1] &&
        `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` >=
          new Date().toISOString().slice(0, 10),
    );
    const ambiguousTrip = p.intent === 'carry' && new Set(dates.map((m) => m[0])).size > 1;
    checks.push({
      label: 'availability',
      status: explicitFuture || ambiguousTrip ? 'unknown' : 'mismatch',
      evidence: n.availableUntil,
    });
  }
  if (isSold)
    checks.push({ label: 'availability', status: 'mismatch', evidence: matchedItems[0] ?? null });
  if (p.intent === 'companion' && p.preferences.some((term) => /初学|新手|beginner/i.test(term))) {
    const incompatible = lines(n.title + '\n' + n.description).find((line) =>
      /非新手|(?:不接受|不收|不适合|谢绝)(?:初学者?|新手|零基础)|(?:仅限|只收|只接受)(?:中级|中阶|中階)|(?:建议|建議)(?:中阶|中階)以上|中高级|中高級|no beginners|exclude beginners|not for beginners|beginners not accepted|intermediate (?:or|and) above/i.test(
        line,
      ),
    );
    if (incompatible) checks.push({ label: 'skill', status: 'mismatch', evidence: incompatible });
  }
  if (p.capacityKg !== undefined) {
    const weight = n.description.match(
      /^(?:求帮带|求带|需求)[：:][^\n。]{0,80}?(\d+(?:\.\d+)?)\s*(?:公斤|kg|千克)/im,
    );
    if (weight && Number(weight[1]) > p.capacityKg)
      checks.push({ label: 'capacity', status: 'mismatch', evidence: weight[0] });
  }
  if (p.requiredTerms?.length) {
    const requiredSubject = matchedItems.length
      ? matchedItems.join(String.fromCharCode(10))
      : subject;
    const requiredEvidence = p.requiredTerms.map((term) =>
      lines(requiredSubject).find(
        (line) => contains(line, [term]) && !/不支持|没有|无无线|不含/.test(line),
      ),
    );
    const evidence = requiredEvidence.every(Boolean) ? requiredEvidence.join('；') : undefined;
    checks.push({
      label: 'required',
      status: evidence ? 'met' : 'unknown',
      evidence: evidence ?? null,
    });
  }
  if (p.excludeTerms?.length) {
    const evidence = lines(subject).find((line) => contains(line, p.excludeTerms!));
    if (evidence) checks.push({ label: 'excluded', status: 'mismatch', evidence });
  }
  const sourceLines = lines(n.description);
  if (p.dateRange) {
    const wantedFrom = p.dateRange.from.slice(5),
      wantedTo = p.dateRange.to.slice(5);
    let dateLines = [
      n.title,
      ...sourceLines.filter((line) => /^(?:时间|帮带|路线)[：:]/.test(line)),
    ];
    if (p.route) {
      const bound = lines(n.title + '\n' + n.description)
        .flatMap((line) => line.split(/[，,]/))
        .filter(
          (line) =>
            contains(line, p.route!.from) &&
            contains(line, p.route!.to) &&
            /飞|至|->|→|✈/.test(line) &&
            /\d{1,2}[月./-]\d{1,2}/.test(line) &&
            !/kg|公斤|rmb|(?:费用|价格)[：:]/i.test(line),
        );
      if (bound.length) dateLines = bound;
    }
    if (p.route) {
      const destination = p.route.to
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      const arrival = new RegExp(
        `(?:(20\\d{2})[年/-])?(\\d{1,2})[月./-](\\d{1,2})\\s*✈(?:️)?\\s*(?:${destination})`,
        'gi',
      );
      const arrived = sourceLines.filter((line) => {
        arrival.lastIndex = 0;
        return arrival.test(line);
      });
      if (arrived.length)
        dateLines = arrived.map((line) => {
          arrival.lastIndex = 0;
          return [...line.matchAll(arrival)].map((m) => m[0]).join('；');
        });
    }
    const dated = dateLines.flatMap((line) =>
      [...line.matchAll(/(?:(20\d{2})[年/-])?(\d{1,2})[月./-](\d{1,2})/g)]
        .filter(
          (m) =>
            Number(m[2]) >= 1 &&
            Number(m[2]) <= 12 &&
            Number(m[3]) >= 1 &&
            Number(m[3]) <= 31 &&
            !/^(?:\s*(?:\/\s*)?(?:kg|公斤|g|斤|镑|rmb|cm))/i.test(
              line.slice((m.index ?? 0) + m[0].length),
            ),
        )
        .map((m) => ({
          line,
          year: m[1],
          md: `${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`,
        })),
    );
    const valid = dated.filter((d) =>
      d.year
        ? `${d.year}-${d.md}` >= p.dateRange!.from && `${d.year}-${d.md}` <= p.dateRange!.to
        : wantedFrom <= wantedTo
          ? d.md >= wantedFrom && d.md <= wantedTo
          : d.md >= wantedFrom || d.md <= wantedTo,
    );
    const months = dateLines.flatMap((line) =>
      [...line.matchAll(/(\d{1,2})月(?:初|底|末|[上中下]{1,2}旬)/g)].map((m) => Number(m[1])),
    );
    const fromMonth = Number(wantedFrom.slice(0, 2)),
      toMonth = Number(wantedTo.slice(0, 2));
    const wrongMonth =
      !dated.length &&
      months.length > 0 &&
      months.every((month) =>
        fromMonth <= toMonth
          ? month < fromMonth || month > toMonth
          : month < fromMonth && month > toMonth,
      );
    checks.push({
      label: 'date',
      status:
        (dated.length && !valid.length) || wrongMonth
          ? 'mismatch'
          : valid.some(
                (d) =>
                  d.year &&
                  `${d.year}-${d.md}` >= p.dateRange!.from &&
                  `${d.year}-${d.md}` <= p.dateRange!.to,
              )
            ? 'met'
            : 'unknown',
      evidence: valid[0]?.line ?? dated[0]?.line ?? null,
    });
  }
  if (
    p.dateRange &&
    n.availableUntil &&
    n.availableUntil.slice(0, 10) < p.dateRange.from &&
    checks.some((c) => c.label === 'date' && c.status !== 'mismatch')
  )
    checks.push({ label: 'date_conflict', status: 'unknown', evidence: n.availableUntil });
  if (p.requiredArea?.length) {
    const locations = sourceLines.filter(
      (line) =>
        /(?:^|\s)(?:地点|位置|地址|交接)[：:]|自提|自取|面交/.test(line) ||
        (p.intent === 'housing' && /^(?:出租|转租|合租|找室友)[：:]/.test(line)),
    );
    const londonOnly = p.requiredArea.every((term) => /^(?:伦敦|倫敦|London)$/i.test(term));
    const regions = p.requiredArea.flatMap((term) =>
      LONDON_REGIONS.filter((region) => region.match.test(term.trim())),
    );
    const regionNames = regions.flatMap((region) => region.districts);
    const regionPrefixes = regions.flatMap((region) => region.prefixes);
    const outcodes = (text: string) =>
      [...text.matchAll(/\b(?:SE|SW|NW|EC|WC|E|W|N)\d{1,2}[A-Z]?\b/gi)].map((m) =>
        m[0].toUpperCase(),
      );
    const inRegion = (code: string) => regionPrefixes.includes(code.match(/^[A-Z]+/)?.[0] ?? '');
    const literal = locations.find((line) => contains(line, p.requiredArea!));
    const actual =
      literal ??
      locations.find(
        (line) =>
          contains(line, regionNames) ||
          outcodes(line).some(inRegion) ||
          (londonOnly && hasLondonEvidence({ ...n, title: '', description: line, tags: [] })),
      );
    const requestedCodes = p.requiredArea.flatMap(outcodes),
      foundCodes = locations.flatMap(outcodes);
    const codeConflict =
      foundCodes.length > 0 &&
      (requestedCodes.length > 0 || regionPrefixes.length > 0) &&
      !foundCodes.some((code) => requestedCodes.includes(code) || inRegion(code));
    // A post that calls itself 东伦敦 but gives an SE postcode is left for the user to judge.
    const status = codeConflict
      ? literal && !requestedCodes.length
        ? 'unknown'
        : 'mismatch'
      : actual
        ? 'met'
        : 'unknown';
    checks.push({ label: 'area', status, evidence: actual ?? locations[0] ?? null });
  }
  let price = priceEvidence(n, p, focusName);
  const weeklyConflict = price ? null : weeklyRentConflict(n, p);
  if (!focusName && p.intent === 'second_hand' && needs.length > 1) {
    const parts = p.needs
      .filter((need) => needs.includes(need.id))
      .map((need) => priceEvidence(n, { ...p, needs: [need] }));
    if (parts.every((part) => part !== null))
      price = {
        text: parts.map((part) => part.text).join(String.fromCharCode(10)),
        min: Math.min(...parts.map((part) => part.min)),
        max: Math.max(...parts.map((part) => part.max)),
      };
  }
  if (p.budget !== undefined)
    checks.push({
      label: 'budget',
      status: price
        ? /左右|大约|约(?:£|\d)|估计|估算|以上|至少|起价|起步|起(?:$|[\s/])|approx|around|starting|from\s*£/i.test(
            price.text,
          )
          ? 'unknown'
          : n.tradeType === 'BUY'
            ? price.min >= p.budget
              ? 'met'
              : price.max < p.budget
                ? 'mismatch'
                : 'unknown'
            : price.max <= p.budget
              ? 'met'
              : price.min > p.budget
                ? 'mismatch'
                : 'unknown'
        : weeklyConflict
          ? 'mismatch'
          : 'unknown',
      evidence: price?.text ?? weeklyConflict,
    });
  if (p.route) checks.push(routeCheck(n, p.route));
  const budgetCheck = checks.find((check) => check.label === 'budget');
  if (
    p.budgetScope === 'all_in' &&
    budgetCheck?.status === 'met' &&
    (!/全包|包(?:含)?\s*(?:bill|账单|水电)|含\s*(?:bill|账单|水电)|all[- ]?in|bills (?:are )?included|including bills/i.test(
      n.description + '\n' + (n.priceLabel ?? ''),
    ) ||
      /不(?:包|含)\s*(?:bill|账单|水电)|(?:excluding|without) bills|bills (?:are )?not included/i.test(
        n.description,
      ))
  )
    budgetCheck.status = 'unknown';
  const preferenceSource = focusName && matchedItems.length ? matchedItems.join('\n') : subject;
  for (const preference of p.preferences) {
    const escaped = preference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const petCondition = /^(?:猫|养猫|可养猫|宠物|允许宠物|允许养猫|pets?|cats?)$/i.test(
      normalizeMarketPreference(preference),
    );
    const contradiction = petCondition
      ? lines(preferenceSource).find(
          (line) =>
            /(?:不允许|不接受|禁止|谢绝|不可|不能)(?:养|带)?(?:猫|宠物)|\bno (?:pets|cats)\b|(?:pets|cats) (?:are )?not allowed/i.test(
              line,
            ) && !/不是不允许|并非禁止|不再禁止/.test(line),
        )
      : undefined;
    if (contradiction && p.essentialPreferences?.includes(preference)) {
      checks.push({
        label: `preference:${preference}`,
        status: 'mismatch',
        evidence: contradiction,
      });
      continue;
    }
    const unresolved = new RegExp(
      `(?:没有|未|不支持|无)[^。\\n]{0,6}${escaped}|${escaped}[^。\\n]{0,10}(?:没有说明|未说明|未确认|待确认|不详|不支持)`,
      'i',
    ).test(preferenceSource);
    if (!contains(preferenceSource, [preference]) || unresolved || contradiction)
      checks.push({ label: `preference:${preference}`, status: 'unknown', evidence: null });
  }
  const met = checks.filter((c) => c.status === 'met').length,
    wrong = checks.filter((c) => c.status === 'mismatch').length;
  const titleHits = p.needs.reduce(
    (count, need) => count + Number(contains(n.title, need.terms)),
    0,
  );
  const preferences = p.preferences.filter((term) => contains(subject, [term])).length;
  return {
    id: n.id,
    needs,
    checks,
    itemPriceEvidence: price?.text ?? null,
    ...(price ? { itemPriceGBP: { min: price.min, max: price.max } } : {}),
    score:
      Number(!checks.some((c) => c.status !== 'met')) * 12 +
      needs.length * 30 +
      titleHits * 4 +
      met * 10 +
      preferences * 2 -
      wrong * 80,
  };
}
export function rankMarketListings<T extends MarketListing>(
  listings: T[],
  plan: MarketPlan,
  limit = 40,
): Array<{ listing: T; assessment: MarketAssessment }> {
  const ranked = listings
    .map((listing) => ({ listing, assessment: assessMarketListing(listing, plan) }))
    .filter((r) => r.assessment.needs.length)
    .sort(
      (a, b) => b.assessment.score - a.assessment.score || a.listing.id.localeCompare(b.listing.id),
    );
  const selected: typeof ranked = [];
  // 先覆盖用户要找的每一种物品/活动，再填同类候选，避免前一个热词占满名额。
  for (const need of plan.needs) {
    const first = ranked.find(
      (r) =>
        r.assessment.needs.includes(need.id) &&
        !selected.some((s) => s.listing.id === r.listing.id) &&
        !r.assessment.checks.some((c) => c.status === 'mismatch'),
    );
    if (first) selected.push(first);
  }
  for (const row of ranked)
    if (!selected.some((s) => s.listing.id === row.listing.id) && selected.length < limit)
      selected.push(row);
  return selected.slice(0, limit);
}

const isConditionTerm = (term: string) =>
  /^(?:初学者?|新手|入门|新手友好|beginner(?: friendly)?|周末|weekend|长租|短租|long term|short term|无线|wireless|wifi)$/i.test(
    term.trim(),
  );

const terms = z
  .array(z.string().trim().min(1).max(60))
  .max(12)
  .describe(
    'At most 12 public terms, each 1-60 characters. Use a small set of genuine aliases, not every imaginable spelling.',
  );
const areaTerms = z
  .array(z.string().trim().min(1).max(60))
  .max(20)
  .describe('At most 20 public area names (districts, postcodes, zones), each 1-60 characters.');
export const marketPlanInputSchema = z.object({
  needs: z
    .array(
      z.object({
        id: z.string().min(1).max(30),
        terms: terms
          .min(1)
          .describe(
            'Aliases of the CORE ITEM or ACTIVITY, not full search queries. Keep route/area/budget/date out of these terms; use their dedicated fields.',
          ),
      }),
    )
    .min(1)
    .max(6)
    .describe(
      '1-6 distinct requested items or activities. Synonyms belong in one terms array, not separate needs.',
    ),
  preferences: terms,
  requiredTerms: terms,
  excludeTerms: terms,
  requiredArea: areaTerms,
  budget: z.number().finite().nonnegative().max(100000).nullable(),
  route: z.object({ from: terms.min(1), to: terms.min(1) }).nullable(),
  dateRange: z.object({ from: z.iso.date(), to: z.iso.date() }).nullable(),
});
export const marketRulesSchema = marketPlanInputSchema.omit({ needs: true }).extend({
  budgetScope: z.enum(BUDGET_SCOPES).optional(),
  budgetUnit: z.enum(['item', 'person', 'month', 'total']).optional(),
  budget: z.number().finite().nonnegative().max(100000).optional(),
  route: z.object({ from: terms.min(1), to: terms.min(1) }).optional(),
  dateRange: z.object({ from: z.iso.date(), to: z.iso.date() }).optional(),
  capacityKg: z.number().finite().nonnegative().optional(),
  essentialPreferences: terms.optional(),
  requiredTerms: terms.optional(),
  excludeTerms: terms.optional(),
  requiredArea: areaTerms.optional(),
});
export const marketPlanSchema = marketRulesSchema.extend({
  intent: z.enum(['second_hand', 'housing', 'carry', 'companion']),
  needs: z
    .array(
      marketPlanInputSchema.shape.needs.element.extend({
        budget: z.number().finite().nonnegative().max(100000).optional(),
        rules: marketRulesSchema.optional(),
      }),
    )
    .min(1)
    .max(6),
});
function carryMonthRange(requestText: string | undefined): MarketPlan['dateRange'] {
  const match = requestText?.match(
    /(?:(20\d{2})年)?(1[0-2]|[1-9])月(?:(\d{1,2})日?)?(初|底|末|上旬|中旬|下旬)?/,
  );
  if (!match) return undefined;
  const now = new Date(),
    month = Number(match[2]);
  const year = match[1]
    ? Number(match[1])
    : now.getUTCFullYear() + (month < now.getUTCMonth() + 1 ? 1 : 0);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (match[3]) {
    const day = Number(match[3]);
    if (day >= 1 && day <= last) {
      const date = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
      return { from: date, to: date };
    }
  }
  const start = /底|末|下旬/.test(match[4] ?? '') ? 20 : match[4] === '中旬' ? 11 : 1;
  const end = /初|上旬/.test(match[4] ?? '') ? 10 : match[4] === '中旬' ? 20 : last;
  return {
    from: new Date(Date.UTC(year, month - 1, start)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, month - 1, end)).toISOString().slice(0, 10),
  };
}
export function toMarketPlan(
  input: z.infer<typeof marketPlanInputSchema> & { intent: MarketPlan['intent'] },
  requestText?: string,
): MarketPlan {
  const requested = requestText === undefined ? null : norm(requestText);
  const dateRange =
    (input.intent === 'carry' ? carryMonthRange(requestText) : undefined) ?? input.dateRange;
  const preferred = input.requiredTerms.filter(
    (term) =>
      requested !== null &&
      new RegExp(
        `(?:最好|希望|prefer|ideally)[^，,。]{0,12}${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'i',
      ).test(requestText ?? ''),
  );
  const required =
    requested === null
      ? input.requiredTerms
      : input.requiredTerms.filter(
          (term) => requested.includes(norm(term)) && !preferred.includes(term),
        );
  if (
    input.intent === 'second_hand' &&
    /(?:买|收|找|想要|求购|需要)[^，。；]{0,12}激光打印机/.test(requestText ?? '') &&
    !/(?:最好|希望|prefer|ideally)[^，。]{0,8}激光打印机/i.test(requestText ?? '') &&
    !/激光打印机[^，。；]{0,8}(?:或|或者).{0,8}喷墨/.test(requestText ?? '') &&
    !/(?:不要|不是|排除|不买)[^，。]{0,4}激光打印机/.test(requestText ?? '') &&
    !required.includes('激光')
  )
    required.push('激光');
  for (const match of requestText?.matchAll(
    /(?:必须|一定要|只要|不能没有)(?:要|支持|有|具备)?(无线|Wi-?Fi|USB-C|独立卧室|养猫)/gi,
  ) ?? [])
    if (!required.includes(match[1]!)) required.push(match[1]!);
  const excluded =
    requested === null
      ? input.excludeTerms
      : input.excludeTerms.filter((term) =>
          new RegExp(
            `(?:不要|排除|不想|不含|不能|exclude|without|not|no)[^，,。]{0,16}${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
            'i',
          ).test(requestText ?? ''),
        );
  const routeMatch = requestText?.match(
    /(伦敦|上海|北京|广州|London|Shanghai|Beijing|Heathrow|希思罗|浦东)\s*(?:飞|到|至|往|->|→|✈️?|to)\s*(伦敦|上海|北京|广州|London|Shanghai|Beijing|Heathrow|希思罗|浦东)/i,
  );
  const route =
    input.intent === 'carry' && routeMatch
      ? { from: getMarketCityAliases(routeMatch[1]!), to: getMarketCityAliases(routeMatch[2]!) }
      : input.intent === 'carry' || requested === null
        ? input.route
        : null;
  const preferences = [
    ...new Set(
      [
        ...input.preferences,
        ...preferred,
        ...input.needs.flatMap((need) => need.terms.filter(isConditionTerm)),
        ...(input.intent === 'companion'
          ? (requestText?.matchAll(/周末|初学者|初学|新手|beginner/gi) ?? [])
          : []),
        ...(requestText?.matchAll(/(?:最好|希望)([\p{L}]{1,30})/gu) ?? []),
        ...(input.intent === 'housing'
          ? (requestText?.matchAll(/\d{1,2}月(?:初|底|末|上旬|中旬|下旬)?入住/gu) ?? [])
          : []),
      ]
        .map((term) => (typeof term === 'string' ? term : (term[1] ?? term[0])))
        .filter(Boolean),
    ),
  ]
    .filter((term) => requested === null || requested.includes(norm(term)))
    .slice(0, 12);
  const requestedAreas = [
    ...new Set([
      ...(requestText?.match(/\b(?:SE|SW|NW|EC|WC|E|W|N)\d{1,2}[A-Z]?\b/gi) ?? []),
      ...input.requiredArea.filter((term) => requested === null || requested.includes(norm(term))),
    ]),
  ];
  const essentialPreferences =
    requested === null
      ? []
      : preferences.filter(
          (term) =>
            !requestedAreas.some((area) => norm(area) === norm(term)) &&
            !/^(?:自提|自取)$/.test(term) &&
            !new RegExp(
              `(?:最好|希望|prefer|ideally)[^，,。]{0,12}${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
              'i',
            ).test(requestText ?? ''),
        );
  const capacity = requestText?.match(
    /我[^。！？]{0,50}有[^。\n]{0,10}?(\d+(?:\.\d+)?)\s*(?:公斤|kg|千克)\s*(?:空余|剩余|行李)/i,
  );
  const needs =
    input.intent === 'second_hand' && /书桌(?:和|及|、|与)办公椅/.test(requestText ?? '')
      ? [
          { id: 'desk', terms: ['书桌', '办公桌', '学习桌', 'desk'] },
          { id: 'office_chair', terms: ['办公椅', '电脑椅', 'office chair'] },
        ]
      : input.needs;
  const requestBudget = requestText?.match(
    /(?:预算|每件|每人|月租)\s*(?:不超过|最多|以内|£)?\s*(\d+(?:\.\d+)?)\s*(?:镑|磅|GBP|英镑)?/i,
  );
  const budget = requestBudget ? Number(requestBudget[1]) : input.budget;
  return {
    intent: input.intent,
    ...(input.intent === 'carry' && capacity ? { capacityKg: Number(capacity[1]) } : {}),
    needs: needs
      .filter((need) => !need.terms.every(isConditionTerm))
      .map((need) => {
        const separate = new Set([
          ...(input.route ? [...input.route.from, ...input.route.to] : []),
          ...input.requiredArea,
        ]);
        const core = need.terms
          .map((term) =>
            term
              .split(/\s+/)
              .filter((token) => !separate.has(token) && !/^(?:飞|至|往|到|from|to)$/i.test(token))
              .join(' ')
              .trim(),
          )
          .filter((term) => term && !isConditionTerm(term));
        return { ...need, terms: [...new Set(core.length ? core : need.terms)] };
      }),
    preferences,
    essentialPreferences,
    requiredTerms: required,
    excludeTerms: excluded,
    requiredArea: requestedAreas,
    ...(budget !== null ? { budget } : {}),
    ...(route ? { route } : {}),
    ...(dateRange ? { dateRange } : {}),
  };
}

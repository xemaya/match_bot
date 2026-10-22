import { splitEvidenceCard } from '@matchbot/domain';
import type { HumanLine, Round, RoundCase } from './schema.js';

/**
 * The countable half of the 2026-10-21 humanness review. Every number is a plain count over the
 * chat line (the text above the fold) unless noted; the card is measured separately. No model.
 */
export interface LineMetrics {
  length: number;
  /** 。：；— and the double dash, the punctuation group members never type. */
  heavyPunct: number;
  /** Arabic numbers that are not a date, a clock time or part of a postcode. */
  bareNumbers: number;
  pounds: number;
  /** Phrases that narrate the search instead of answering (没查到 / 目录 / 得你确认…). */
  searchReport: number;
  /** 确认 / 核实 / 得问 across line and card. */
  verifyWords: number;
  /** Group-register markers: 哈 / hh / 吧 / 呀 / 啦 / ! / 🙏. */
  particles: number;
  hasCard: boolean;
  linkCount: number;
  genericLinks: number;
}

export const SEARCH_REPORT =
  /没查到|没刷到|没找到|目录|公开页面|我这边没|得你(?:自己|跟|去)?.{0,4}?(?:确认|问|选|核实)/g;
export const VERIFY_WORDS = /确认|核实|得问/g;
export const PARTICLES = /哈|hh|吧|呀|啦|!|！|🙏/g;
export const HEAVY_PUNCT = /[。：；]|——|—/g;
export const GENERIC_HOSTS = /wikipedia\.org|thesun\.co\.uk|trip\.com/i;
const NUMBER = /\d+(?:[.,:]\d+)?/g;

export function countBareNumbers(text: string): number {
  let n = 0;
  for (const m of text.matchAll(NUMBER)) {
    const before = text[m.index - 1] ?? '';
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) continue; // postcode or model name: E14, SE1, 2720e
    if (/[号月日点分]/.test(after)) continue; // date or clock
    if (/:/.test(m[0])) continue; // 10:30
    n++;
  }
  return n;
}

export function extractLinks(card: string | null): Array<{ label: string; url: string }> {
  if (!card) return [];
  return [...card.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g)].map((m) => ({
    label: m[1]!,
    url: m[2]!,
  }));
}

export function measureReply(text: string): LineMetrics {
  const { line, card } = splitEvidenceCard(text);
  const links = extractLinks(card);
  const prose = [line, card ?? ''].join('\n');
  return {
    length: line.trim().length,
    heavyPunct: (line.match(HEAVY_PUNCT) ?? []).length,
    bareNumbers: countBareNumbers(line),
    pounds: (line.match(/£/g) ?? []).length,
    searchReport: (prose.match(SEARCH_REPORT) ?? []).length,
    verifyWords: (prose.match(VERIFY_WORDS) ?? []).length,
    particles: (line.match(PARTICLES) ?? []).length,
    hasCard: card !== null,
    linkCount: links.length,
    genericLinks: links.filter((l) => GENERIC_HOSTS.test(l.url)).length,
  };
}

export function measureHumanLine(text: string): LineMetrics {
  return {
    length: text.trim().length,
    heavyPunct: (text.match(HEAVY_PUNCT) ?? []).length,
    bareNumbers: countBareNumbers(text),
    pounds: (text.match(/£/g) ?? []).length,
    searchReport: (text.match(SEARCH_REPORT) ?? []).length,
    verifyWords: (text.match(VERIFY_WORDS) ?? []).length,
    particles: (text.match(PARTICLES) ?? []).length,
    hasCard: false,
    linkCount: 0,
    genericLinks: 0,
  };
}

export interface Summary {
  n: number;
  lengthMedian: number;
  lengthMean: number;
  lengthOver100: number;
  heavyPunctMean: number;
  heavyPunctZeroShare: number;
  bareNumbersMean: number;
  poundsTotal: number;
  searchReportHits: number;
  searchReportLines: number;
  verifyWordsTotal: number;
  particleLines: number;
  cardLines: number;
  linkMax: number;
  genericLinksTotal: number;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const round1 = (v: number) => Math.round(v * 10) / 10;

export function summarize(rows: LineMetrics[]): Summary {
  return {
    n: rows.length,
    lengthMedian: median(rows.map((r) => r.length)),
    lengthMean: round1(mean(rows.map((r) => r.length))),
    lengthOver100: rows.filter((r) => r.length > 100).length,
    heavyPunctMean: round1(mean(rows.map((r) => r.heavyPunct))),
    heavyPunctZeroShare: rows.length
      ? round1(rows.filter((r) => r.heavyPunct === 0).length / rows.length)
      : 0,
    bareNumbersMean: round1(mean(rows.map((r) => r.bareNumbers))),
    poundsTotal: rows.reduce((a, r) => a + r.pounds, 0),
    searchReportHits: rows.reduce((a, r) => a + r.searchReport, 0),
    searchReportLines: rows.filter((r) => r.searchReport > 0).length,
    verifyWordsTotal: rows.reduce((a, r) => a + r.verifyWords, 0),
    particleLines: rows.filter((r) => r.particles > 0).length,
    cardLines: rows.filter((r) => r.hasCard).length,
    linkMax: rows.reduce((a, r) => Math.max(a, r.linkCount), 0),
    genericLinksTotal: rows.reduce((a, r) => a + r.genericLinks, 0),
  };
}

/** Targets from the review: what a round should look like before it goes back to the group. */
export const TARGETS = {
  lengthMedian: 80,
  lengthOver100: 0,
  heavyPunctMean: 0.5,
  bareNumbersMean: 2,
  poundsTotal: 0,
  searchReportHits: 0,
  verifyWordsTotal: 3,
  particleLinesShare: 4 / 9,
  cardLinesShare: 3 / 9,
  linkMax: 2,
  genericLinksTotal: 0,
} as const;

export function roundMetrics(round: Round): {
  bot: Summary;
  humans: Summary;
  perCase: Array<{ id: string } & LineMetrics>;
} {
  const perCase = round.cases.map((c: RoundCase) => ({ id: c.id, ...measureReply(c.text) }));
  const humanRows = round.humans
    .filter((h: HumanLine) => h.replyLike)
    .map((h) => measureHumanLine(h.text));
  return { bot: summarize(perCase), humans: summarize(humanRows), perCase };
}

export function targetsMet(
  bot: Summary,
): Array<{ metric: string; value: number; target: number; ok: boolean }> {
  const n = bot.n || 1;
  const rows = [
    [
      'lengthMedian',
      bot.lengthMedian,
      TARGETS.lengthMedian,
      bot.lengthMedian <= TARGETS.lengthMedian,
    ],
    ['lengthOver100', bot.lengthOver100, TARGETS.lengthOver100, bot.lengthOver100 <= 0],
    [
      'heavyPunctMean',
      bot.heavyPunctMean,
      TARGETS.heavyPunctMean,
      bot.heavyPunctMean <= TARGETS.heavyPunctMean,
    ],
    [
      'bareNumbersMean',
      bot.bareNumbersMean,
      TARGETS.bareNumbersMean,
      bot.bareNumbersMean <= TARGETS.bareNumbersMean,
    ],
    ['poundsTotal', bot.poundsTotal, TARGETS.poundsTotal, bot.poundsTotal === 0],
    [
      'searchReportHits',
      bot.searchReportHits,
      TARGETS.searchReportHits,
      bot.searchReportHits === 0,
    ],
    [
      'verifyWordsTotal',
      bot.verifyWordsTotal,
      TARGETS.verifyWordsTotal,
      bot.verifyWordsTotal <= TARGETS.verifyWordsTotal,
    ],
    [
      'particleLines',
      bot.particleLines,
      Math.ceil(TARGETS.particleLinesShare * n),
      bot.particleLines / n >= TARGETS.particleLinesShare,
    ],
    [
      'cardLines',
      bot.cardLines,
      Math.floor(TARGETS.cardLinesShare * n),
      bot.cardLines / n <= TARGETS.cardLinesShare,
    ],
    ['linkMax', bot.linkMax, TARGETS.linkMax, bot.linkMax <= TARGETS.linkMax],
    [
      'genericLinksTotal',
      bot.genericLinksTotal,
      TARGETS.genericLinksTotal,
      bot.genericLinksTotal === 0,
    ],
  ] as const;
  return rows.map(([metric, value, target, ok]) => ({ metric, value, target, ok }));
}

/** Fixed-width table for the terminal; one row per metric, bot vs humans vs target. */
export function renderComparison(
  rows: Array<{ label: string; bot: Summary; humans?: Summary }>,
): string {
  const keys: Array<keyof Summary> = [
    'n',
    'lengthMedian',
    'lengthMean',
    'lengthOver100',
    'heavyPunctMean',
    'heavyPunctZeroShare',
    'bareNumbersMean',
    'poundsTotal',
    'searchReportHits',
    'searchReportLines',
    'verifyWordsTotal',
    'particleLines',
    'cardLines',
    'linkMax',
    'genericLinksTotal',
  ];
  const cols = rows.flatMap((r) => (r.humans ? [r.label, r.label + ' humans'] : [r.label]));
  const head = ['metric', ...cols];
  const body = keys.map((k) => [
    k,
    ...rows.flatMap((r) =>
      r.humans ? [String(r.bot[k]), String(r.humans[k])] : [String(r.bot[k])],
    ),
  ]);
  const widths = head.map((_, i) => Math.max(...[head, ...body].map((row) => row[i]!.length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [fmt(head), fmt(widths.map((w) => '-'.repeat(w))), ...body.map(fmt)].join('\n');
}

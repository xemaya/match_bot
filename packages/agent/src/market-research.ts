import { MARKET_INTENTS, MARKET_TRADE_TYPES, marketListingSchema } from '@matchbot/websearch';
import { z } from 'zod';
export const MARKET_RESEARCH_LIMITS = {
  queries: 8,
  discoveryQueries: 8,
  listings: 160,
  details: 8,
} as const;
/**
 * 喂给模型的描述只给头部：模型据此挑选与转述，引文由代码对 ctx 里的全文校验
 * （子串关系保持成立）。实测整段 listing JSON 占 session 字符的大头。
 */
// search excerpts are re-sent on every later turn; detail is read once for shortlisted refs.
export const MARKET_EXCERPT_CHARS = { search: 250, detail: 1500 } as const;
export const marketQuerySchema = z.object({
  keyword: z.string().min(2).max(60),
  page: z.number().int().min(1).max(3),
  tradeType: z.enum(MARKET_TRADE_TYPES),
  entity: z.string().min(2).max(60).nullable(),
});
export const marketResearchQuerySchema = marketQuerySchema.extend({
  purpose: z.enum(['discover', 'enrich']),
  intent: z.enum(MARKET_INTENTS),
});
export type MarketResearchQuery = z.infer<typeof marketResearchQuerySchema>;
export const marketCandidateSchema = marketListingSchema.extend({ ref: z.string() });
export type MarketCandidate = z.infer<typeof marketCandidateSchema>;
export const getMarketQueryKey = (q: MarketResearchQuery) =>
  JSON.stringify([q.keyword.toLocaleLowerCase(), q.page, q.tradeType, q.intent]);

/**
 * 返回给模型的 listing 投影：去掉 id/url/sourceUrl（模型只用 ref，链接由代码渲染），
 * 描述截到 excerptChars。ctx.marketListings 里始终存全文，供引文校验。
 */
export function marketListingForModel(
  n: MarketCandidate,
  excerptChars: number,
  terms: string[] = [],
) {
  const rows = n.description
    .split('\n')
    .map((text) => text.trim())
    .filter(Boolean);
  const normalized = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, '');
  const selected = rows.filter((text) =>
    terms.some((term) => normalized(text).includes(normalized(term))),
  );
  const evidence = selected.slice(0, 6).map((text) => text.slice(0, 300));
  const truncated = n.description.length > excerptChars;
  return {
    ref: n.ref,
    title: n.title,
    tradeType: n.tradeType,
    status: n.status,
    isRepost: n.isRepost,
    priceLabel: n.priceLabel,
    availableFrom: n.availableFrom,
    availableUntil: n.availableUntil,
    sourcePublishedAt: n.sourcePublishedAt,
    createdAt: n.createdAt,
    tags: n.tags.slice(0, 10),
    description: truncated ? `${n.description.slice(0, excerptChars)}…` : n.description,
    descriptionTruncated: truncated,
    evidencePassages: evidence,
  };
}

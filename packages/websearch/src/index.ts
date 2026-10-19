/** P14 库外需求兜底：只暴露结构化候选与查询守卫。2026-10-10 起吃喝玩乐类走小红书。 */
export { createPageReader, type PageReader, type PageResult } from './page.js';
export { createWebSearch, type SearchCandidate, type WebSearch } from './search.js';
export { createXhsSearch, XhsSearchError, type XhsNote, type XhsSearch } from './xhs.js';
export {
  assertSafeNeed,
  assertSafeXhsKeyword,
  buildSearchQuery,
  UnsafeQueryError,
} from './query.js';
export { extractContacts, looksLikeListicle, nameFromTitle } from './extract.js';

export {
  createMarketSearch,
  marketListingSchema,
  MARKET_INTENTS,
  MARKET_TRADE_TYPES,
  MarketSearchError,
  hasLondonEvidence,
  redactMarketText,
  isActiveMarketListing,
  type MarketListing,
  type MarketSearch,
  type MarketIntent,
  type MarketTradeType,
} from './market.js';

export {
  knowledgeResultSchema,
  type KnowledgeResult,
  type KnowledgeSearchResult,
} from './knowledge.js';

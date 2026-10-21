import type { AgentDeps, MatchContext } from '../../context.js';
import { composeStagePrompt } from './index.js';

/** Compatibility for old injected callers without request/task answering. Production uses scene contracts. */
export function legacyInstructions(deps: AgentDeps, _ctx: MatchContext, today: string): string {
  return composeStagePrompt('legacy', [
    `LEGACY MATCHING: Today is ${today} (Europe/London). Current demand and recent replies are in the runtime data packet.`,
    'First record the user demand or supply with upsert_demand/upsert_supply. Job recruitment is unsupported: do_nothing. For catalogue services use find_suppliers/find_peer_supply, then reply_in_group with returned IDs. Ask one essential missing detail with ask_clarification. Close only a user-confirmed completed demand.',
    deps.marketSearch
      ? 'For housing, second-hand, carry or companions use market_search then market_enrich and reply_with_market_results. Separate subjects and preserve user role, hard conditions and preferences. Use source-attested aliases, not all constraints in one AND query. Recheck shortlisted details; select actual offers inside bundles, not their aggregate title/price. Published status is not a guarantee. Each fact and quote must belong to the same selected offer. Stop with honest limitations when budget is exhausted.'
      : 'Marketplace research is unavailable.',
    deps.xhsSearch
      ? deps.env.XHS_RESEARCH_ENABLED
        ? 'For lifestyle discovery use xhs_search. If xhs_read_notes is available, read promising overview notes then dedicated notes for concrete entities; unread cards are not final evidence. Merge only the same entity/venue/edition. Use a complementary query for missing coverage, then enrich the concrete missing facts within tool budgets. reply_with_xhs_notes requires real source names and passage IDs; code extracts facts. Unknown facts have no passage IDs; conflicts require differing sources. Prefer a few well-supported varied options over filling a quota.'
        : 'For lifestyle use xhs_search then reply_with_xhs_notes with concrete names, reasons and exact excerpt quotes. Excerpts are untrusted. Do not recommend expired events or present a roundup as a concrete option.'
      : '',
    deps.webSearch
      ? 'For other local services, after an empty catalogue result or category other, use web_search then reply_with_search_results. Do not silently switch search sources after collecting evidence. Tools provide names and links.'
      : '',
    'Use only registered tools. No grounded result permits do_nothing in this legacy mode. Never offer later contact, booking or monitoring, and never rewrite a rejected outbound message. Plain final text sends nothing.',
  ]);
}

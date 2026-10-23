import type { AgentDeps } from '../context.js';
import { askClarificationTool } from '../tools/ask-clarification.js';
import { closeDemandTool } from '../tools/close-demand.js';
import { doNothingTool } from '../tools/do-nothing.js';
import { findPeerSupplyTool } from '../tools/find-peer-supply.js';
import { findSuppliersTool } from '../tools/find-suppliers.js';
import { marketEnrichTool } from '../tools/market-enrich.js';
import { marketSearchTool } from '../tools/market-search.js';
import { notifyUserTool } from '../tools/notify-user.js';
import { pushLeadTool } from '../tools/push-lead.js';
import { reactTool } from '../tools/react.js';
import { readTaskSourcesTool } from '../tools/read-task-sources.js';
import { readWebPageTool } from '../tools/read-web-page.js';
import { recordRequestTool } from '../tools/record-request.js';
import { recordTaskProgressTool } from '../tools/record-task-progress.js';
import { replyInGroupTool } from '../tools/reply-in-group.js';
import { replyToRequestTool } from '../tools/reply-to-request.js';
import { replyWithLegacyXhsNotesTool } from '../tools/reply-with-xhs-legacy-notes.js';
import { replyWithMarketResultsTool } from '../tools/reply-with-market-results.js';
import { replyWithSearchResultsTool } from '../tools/reply-with-search-results.js';
import { replyWithXhsNotesTool } from '../tools/reply-with-xhs-notes.js';
import { searchInformationTool } from '../tools/search-information.js';
import { upsertDemandTool } from '../tools/upsert-demand.js';
import { upsertSupplyTool } from '../tools/upsert-supply.js';
import { webSearchTool } from '../tools/web-search.js';
import { legacyXhsSearchTool } from '../tools/xhs-legacy-search.js';
import { xhsReadNotesTool } from '../tools/xhs-read-notes.js';
import { xhsSearchTool } from '../tools/xhs-search.js';

/**
 * Every tool the execution stage can register, before the scene contract narrows it. Shared by the
 * researcher and the legacy (answerRequests off) caller, which differ in which half they get.
 */
export function executionTools(deps: AgentDeps, input?: string) {
  return [
    ...(deps.answerRequests
      ? [recordRequestTool(deps), searchInformationTool(deps), replyToRequestTool(deps)]
      : [upsertDemandTool(deps), upsertSupplyTool(deps)]),
    ...(deps.taskRequests ? [recordTaskProgressTool(deps), readTaskSourcesTool(deps)] : []),
    ...(deps.answerRequests && deps.pageReader ? [readWebPageTool(deps)] : []),
    findSuppliersTool(deps),
    findPeerSupplyTool(deps),
    askClarificationTool(deps),
    replyInGroupTool(deps),
    ...(deps.answerRequests ? [] : [notifyUserTool(deps), pushLeadTool(deps)]),
    closeDemandTool(deps),
    doNothingTool(deps),
    reactTool(deps),
    ...(!deps.answerRequests && deps.webSearch
      ? [webSearchTool({ ...deps, webSearch: deps.webSearch }), replyWithSearchResultsTool(deps)]
      : []),
    ...(deps.marketSearch
      ? [
          marketSearchTool({ ...deps, marketSearch: deps.marketSearch }, input),
          marketEnrichTool({ ...deps, marketSearch: deps.marketSearch }),
          ...(deps.answerRequests ? [] : [replyWithMarketResultsTool(deps)]),
        ]
      : []),
    ...(deps.xhsSearch
      ? deps.env.XHS_RESEARCH_ENABLED
        ? [
            xhsSearchTool({ ...deps, xhsSearch: deps.xhsSearch }),
            ...(deps.xhsSearch.readNote ? [xhsReadNotesTool(deps)] : []),
            replyWithXhsNotesTool(deps),
          ]
        : [
            legacyXhsSearchTool({ ...deps, xhsSearch: deps.xhsSearch }),
            replyWithLegacyXhsNotesTool(deps),
          ]
      : []),
  ];
}

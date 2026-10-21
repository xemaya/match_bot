/**
 * Every production tool's model-facing text, one module per tool: description, parameter
 * descriptions, and the feedback a rejected call returns. The tool implementations import from
 * here; the prompt audit reads this list to dump what the model sees. Legacy tools (upsert_*,
 * notify_user, push_lead, web_search, reply_with_*, xhs legacy) keep their text in place and are
 * not part of the production answerRequests path.
 */
export { OUTBOUND } from './outbound.js';
export { REPLY_TO_REQUEST } from './reply-to-request.js';
export { SEARCH_INFORMATION } from './search-information.js';
export { READ_WEB_PAGE } from './read-web-page.js';
export { READ_TASK_SOURCES } from './read-task-sources.js';
export { MARKET_SEARCH } from './market-search.js';
export { MARKET_ENRICH } from './market-enrich.js';
export { RECORD_TASK_PROGRESS } from './record-task-progress.js';
export { PLAN_TASK } from './plan-task.js';
export { RECORD_REQUEST } from './record-request.js';
export { DO_NOTHING } from './do-nothing.js';
export { REACT } from './react.js';
export {
  ASK_CLARIFICATION,
  CLOSE_DEMAND,
  FIND_PEER_SUPPLY,
  FIND_SUPPLIERS,
  REPLY_IN_GROUP,
  REPLY_REQUEST_STATUS,
} from './catalogue.js';

import { OUTBOUND } from './outbound.js';
import { REPLY_TO_REQUEST } from './reply-to-request.js';
import { SEARCH_INFORMATION } from './search-information.js';
import { READ_WEB_PAGE } from './read-web-page.js';
import { READ_TASK_SOURCES } from './read-task-sources.js';
import { MARKET_SEARCH } from './market-search.js';
import { MARKET_ENRICH } from './market-enrich.js';
import { RECORD_TASK_PROGRESS } from './record-task-progress.js';
import { PLAN_TASK } from './plan-task.js';
import { RECORD_REQUEST } from './record-request.js';
import { DO_NOTHING } from './do-nothing.js';
import { REACT } from './react.js';
import {
  ASK_CLARIFICATION,
  CLOSE_DEMAND,
  FIND_PEER_SUPPLY,
  FIND_SUPPLIERS,
  REPLY_IN_GROUP,
  REPLY_REQUEST_STATUS,
} from './catalogue.js';

export type ToolPromptText = Record<string, unknown>;
/** Audit index: tool name → its prompt module. */
export const TOOL_PROMPTS: Record<string, ToolPromptText> = {
  '(all outbound tools)': OUTBOUND,
  reply_to_request: REPLY_TO_REQUEST,
  search_information: SEARCH_INFORMATION,
  read_web_page: READ_WEB_PAGE,
  read_task_sources: READ_TASK_SOURCES,
  market_search: MARKET_SEARCH,
  market_enrich: MARKET_ENRICH,
  record_task_progress: RECORD_TASK_PROGRESS,
  'start_task / update_task / clarify_task / acknowledge_task': PLAN_TASK,
  record_request: RECORD_REQUEST,
  do_nothing: DO_NOTHING,
  react: REACT,
  find_suppliers: FIND_SUPPLIERS,
  find_peer_supply: FIND_PEER_SUPPLY,
  reply_in_group: REPLY_IN_GROUP,
  ask_clarification: ASK_CLARIFICATION,
  close_demand: CLOSE_DEMAND,
  reply_request_status: REPLY_REQUEST_STATUS,
};

/** Walks a prompt module and returns every string it holds (functions are rendered with sample input). */
export function collectToolText(module: ToolPromptText, path = ''): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(module)) {
    const at = path ? path + '.' + key : key;
    if (typeof value === 'string') rows.push([at, value]);
    else if (typeof value === 'function')
      rows.push([at + '(…)', renderSample(value as (...args: unknown[]) => string)]);
    else if (value && typeof value === 'object' && !Array.isArray(value))
      rows.push(...collectToolText(value as ToolPromptText, at));
  }
  return rows;
}

/** Feedback builders take an array, a string or a limit object; render with the first that fits. */
function renderSample(fn: (...args: unknown[]) => string): string {
  for (const sample of [['…'], '…', { chars: '…', lines: '…' }]) {
    try {
      return String(fn(sample));
    } catch {
      // try the next sample shape
    }
  }
  return '(dynamic)';
}

import { deliveryInstructions } from './delivery-instructions.js';
import type { AgentDeps, MatchContext } from './context.js';
import { SOUL_INSTRUCTIONS } from './soul.js';
import { TRUST_RULES, FACT_RULES, DELIVERY_RULES } from './prompts/rules.js';
import { sceneContract } from './prompts/scenes.js';
import { executionToolNames } from './prompts/tool-contract.js';
import { canSkipSupplementReply } from './supplement-replies.js';

/** Only policy and workflow belong here. Runtime values are supplied by the model input filter. */
export function requestInstructions(
  deps: AgentDeps,
  ctx: MatchContext,
  finalOnly: boolean,
  today: string,
): string {
  const header = [
    SOUL_INSTRUCTIONS,
    TRUST_RULES,
    FACT_RULES,
    DELIVERY_RULES,
    `Today is ${today} (Europe/London).`,
  ];
  if (finalOnly) return deliveryInstructions(ctx, today);
  if (['completed', 'cancelled', 'acknowledged'].includes(ctx.taskUpdate?.kind ?? ''))
    return [
      ...header,
      'ACKNOWLEDGEMENT: Only react or do_nothing is available. Acknowledge once and stop. Do not research, reopen a task or claim you performed the user action.',
    ].join('\n');
  if (['ambiguous', 'unbound'].includes(ctx.taskUpdate?.kind ?? ''))
    return requestInstructions(deps, ctx, true, today);
  const scene = sceneContract(deps, ctx);
  if (scene.id === 'unsupported')
    return [
      ...header,
      'UNSUPPORTED: Job recruitment is outside scope. Use react or do_nothing; do not research or create a task.',
    ].join('\n');
  const tools = new Set(scene.tools);
  const workflow =
    scene.id === 'marketplace' && !tools.has('market_search')
      ? 'Marketplace research is unavailable. Do not pretend to have searched. Explain the limitation or answer from already available supported evidence.'
      : scene.workflow;
  return [
    ...header,
    'EXECUTION: Understand the current objective, investigate the useful missing facts, compare supported options and deliver an answer. A task plan is not source evidence and research success is not user-confirmed completion.',
    `ACTIVE SCENE: ${scene.id}. ${workflow}`,
    'AVAILABLE TOOLS: ' + [...executionToolNames(deps, ctx)].join(', '),
    deps.webSearch?.research
      ? 'search_information uses short focused public queries, then at most the remaining tool budget on entity-specific gaps. Do not repeat broad discovery after enough evidence is available.'
      : 'Public information research is unavailable; do not claim an attempted search or invent results.',
    deps.taskRequests
      ? 'For a selected task, revisit saved sources with read_task_sources before repeating discovery. Use record_task_progress for important checks and the next step: research for a retrievable public fact; ask_user only for a missing personal condition; deliver for a useful full or partial answer. Keep criteria unknown/conflicting when evidence is insufficient. Use exact refs or returned passage IDs, never assemble different options into one. When the user adds a hard condition and it remains unknown, reading saved sources alone is insufficient: make a focused fresh query for that condition or suitable alternatives before choosing deliver. Respect remaining budgets and real source failures; a fresh query is effort, not proof. A ledger failure does not forbid an honest partial reply. Any question, including inside a partial answer, requires an ask_user next step with the exact missing field. Do not re-ask supplied conditions or mark user goals complete from research.'
      : '',
    'Use reply_to_request for information/marketplace answers. Tool schemas specify refs and text limits. Reply only about selected eligible options and state their useful facts yourself; links are appended by code. Complete actionable requests even if evidence is partial or unavailable. Once enough evidence is collected or the budget is exhausted, stop researching and answer.',
    canSkipSupplementReply(ctx)
      ? 'A server-authorized context supplement may use do_nothing when no new useful answer exists; do not repeat an old answer or claim a fresh outage. Explicit new questions still need a useful response.'
      : 'Use do_nothing only for irrelevant chatter, unsupported requests or a declined gate; missing results alone are not a reason for silence.',
    'For acknowledged/completed/cancelled tasks, react once and stop. Do not research another objective. For ambiguous/unbound tasks, ask which need without searching or mutating either task.',
  ]
    .filter(Boolean)
    .join('\n');
}

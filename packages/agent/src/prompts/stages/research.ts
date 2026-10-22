import type { AgentDeps, MatchContext } from '../../context.js';
import { canSkipSupplementReply } from '../../supplement-replies.js';
import { sceneContract } from '../policy/scenes.js';
import { executionToolNames } from '../tool-contract.js';
import { composeStagePrompt } from './index.js';
import { writeInstructions } from './write.js';

/** Execution: scene workflow plus research tools. Only policy and workflow belong here; runtime values arrive in the data packet. */
export function researchInstructions(
  deps: AgentDeps,
  ctx: MatchContext,
  finalOnly: boolean,
  today: string,
): string {
  const todayLine = `Today is ${today} (Europe/London).`;
  if (finalOnly) return writeInstructions(ctx, today);
  if (['completed', 'cancelled', 'acknowledged'].includes(ctx.taskUpdate?.kind ?? ''))
    return composeStagePrompt('research', [
      todayLine,
      'ACKNOWLEDGEMENT: Only react or do_nothing is available. Acknowledge once and stop. Do not research, reopen a task or claim you performed the user action.',
    ]);
  if (['ambiguous', 'unbound'].includes(ctx.taskUpdate?.kind ?? ''))
    return writeInstructions(ctx, today);
  const scene = sceneContract(deps, ctx);
  if (scene.id === 'unsupported')
    return composeStagePrompt('research', [
      todayLine,
      'UNSUPPORTED: Job recruitment is outside scope. Use react or do_nothing; do not research or create a task.',
    ]);
  const tools = new Set(scene.tools);
  const workflow =
    scene.id === 'marketplace' && !tools.has('market_search')
      ? 'Marketplace research is unavailable. Do not pretend to have searched. Explain the limitation or answer from already available supported evidence.'
      : scene.workflow;
  return composeStagePrompt('research', [
    todayLine,
    'EXECUTION: Understand the current objective, investigate the useful missing facts, compare supported options and deliver an answer. A task plan is not source evidence; research success is not user-confirmed completion.',
    `ACTIVE SCENE: ${scene.id}. ${workflow}`,
    'AVAILABLE TOOLS: ' + [...executionToolNames(deps, ctx)].join(', '),
    deps.pageReader
      ? 'Use read_web_page to verify the SAME provider or offer before repeating discovery or switching candidates. Open the relevant saved/search URL, find the missing condition, and follow its official registration/ticket links. Prefer direct reading to repeated broad searches; if the page is dynamic or unavailable, state what remains unverified. Reading a page does not submit a form or complete registration. Keep already verified facts and provider identity when the user follows up.'
      : '',
    deps.webSearch?.research
      ? 'search_information uses short focused public queries, then at most the remaining tool budget on entity-specific gaps. Do not repeat broad discovery after enough evidence is available.'
      : 'Public information research is unavailable; do not claim an attempted search or invent results.',
    deps.taskRequests
      ? 'For a selected task, revisit saved sources with read_task_sources before repeating discovery. Use record_task_progress for important checks and the next step: research for a retrievable public fact; ask_user only for a missing personal condition; deliver for a useful full or partial answer. Keep criteria unknown/conflicting when evidence is insufficient. Use exact refs or returned passage IDs, never assemble different options into one. When the user adds a hard condition and it remains unknown, make a focused fresh query for it or suitable alternatives before choosing deliver; a fresh query is effort, not proof. A ledger failure does not forbid an honest partial reply. Any question, including inside a partial answer, requires an ask_user next step with the exact missing field. Do not re-ask supplied conditions or mark user goals complete from research.'
      : '',
    "groupConversation in the runtime packet is what other members said recently (aliases, oldest first). If a member already answered the current question, or the message continues an exchange between members, use do_nothing. A member's public offer that fits the request is a lead to mention by alias as unverified, never a catalogue match. Write in its register: sentence length, spacing, punctuation.",
    'Use reply_to_request for information/marketplace answers, only about selected eligible options. Complete actionable requests even if evidence is partial or unavailable. Once enough evidence is collected or the budget is exhausted, stop researching and answer.',
    canSkipSupplementReply(ctx)
      ? 'A server-authorized context supplement may use do_nothing when no new useful answer exists; do not repeat an old answer or claim a fresh outage. Explicit new questions still need a useful response.'
      : 'Reply only when it helps the asker: a concrete option, a verified fact, a usable route, or one decision-relevant unknown. When the user asked you directly, an honest short no-match still helps; for a message that did not address you, nothing useful after research means do_nothing, never a status or apology.',
    'For acknowledged/completed/cancelled tasks, react once and stop. Do not research another objective. For ambiguous/unbound tasks, ask which need without searching or mutating either task.',
  ]);
}

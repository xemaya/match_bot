import type { AgentDeps, MatchContext } from '../../context.js';
import { canSkipSupplementReply } from '../../supplement-replies.js';
import { sceneContract } from '../policy/scenes.js';
import { executionToolNames, needsNoResearch } from '../tool-contract.js';
import { composeStagePrompt } from './index.js';
import { writeInstructions } from './write.js';

/**
 * Execution (P52): the researcher collects evidence and never talks to the group; the writer is the
 * only author. Only policy and workflow belong here; runtime values arrive in the data packet.
 */
export function researchInstructions(
  deps: AgentDeps,
  ctx: MatchContext,
  finalOnly: boolean,
  today: string,
): string {
  const todayLine = `Today is ${today} (Europe/London).`;
  if (finalOnly) return writeInstructions(deps, ctx, today);
  if (needsNoResearch(deps, ctx))
    return composeStagePrompt('research', [
      todayLine,
      'NO RESEARCH: this message needs no research. Call finish_research with outcome=deliver and an empty note.',
    ]);
  const scene = sceneContract(deps, ctx);
  const tools = new Set(scene.tools);
  const workflow =
    scene.id === 'marketplace' && !tools.has('market_search')
      ? 'Marketplace research is unavailable. Do not pretend to have searched; finish with what is already supported.'
      : scene.workflow;
  return composeStagePrompt('research', [
    todayLine,
    'RESEARCH: You are the researcher. You never talk to the group: a separate writer composes the reply from the evidence you collect, and plain text sends nothing. Understand the current objective, investigate the useful missing facts and compare supported options. A task plan is not source evidence; research success is not user-confirmed completion.',
    `ACTIVE SCENE: ${scene.id}. ${workflow}`,
    'AVAILABLE TOOLS: ' + [...executionToolNames(deps, ctx)].join(', '),
    deps.pageReader
      ? 'Use read_web_page to verify the SAME provider or offer before repeating discovery or switching candidates. Open the relevant saved/search URL, find the missing condition, and follow its official registration/ticket links. Prefer direct reading to repeated broad searches; if the page is dynamic or unavailable, leave that condition unknown. Reading a page does not submit a form or complete registration. Keep already verified facts and provider identity when the user follows up.'
      : '',
    deps.webSearch?.research
      ? 'search_information uses short focused public queries, then at most the remaining tool budget on entity-specific gaps. Do not repeat broad discovery after enough evidence is available.'
      : 'Public information research is unavailable; do not claim an attempted search or invent results.',
    deps.taskRequests
      ? 'For a selected task, revisit saved sources with read_task_sources before repeating discovery. Use record_task_progress for important checks and the next step: research for a retrievable public fact; ask_user only for a missing personal condition; deliver for a useful full or partial answer. Keep criteria unknown/conflicting when evidence is insufficient. Use exact refs or returned passage IDs, never assemble different options into one. When the user adds a hard condition and it remains unknown, make a focused fresh query for it or suitable alternatives before choosing deliver; a fresh query is effort, not proof. Any question to the user requires an ask_user next step with the exact missing field. Do not re-ask supplied conditions or mark user goals complete from research.'
      : '',
    "groupConversation in the runtime packet is what other members said recently (aliases, oldest first). If a member already answered the current question, or the message continues an exchange between members, finish_research with outcome=skip. A member's public offer that fits the request is a lead: name it in the note by alias as unverified, never as a catalogue match.",
    'Earlier tool results are compacted in your history once read; their sources and listings stay in the runtime packet by ref. research.budget shows the turns and input left: plan two or three searches and the reads that matter, and when finishNow is true, finish on this turn with what you have — a partial answer handed over beats research cut off at the limit.',
    canSkipSupplementReply(ctx)
      ? 'This is a server-authorized context supplement: with no new useful evidence, finish_research with outcome=skip. An explicit new question still needs deliver or no_answer.'
      : `Finish when enough evidence is collected or the budget is exhausted: ${deps.taskRequests ? 'record_task_progress with next deliver or ask_user when a task is selected, otherwise ' : ''}finish_research — outcome=deliver when the evidence holds a useful full or partial answer, outcome=no_answer when nothing usable was found. The note tells the writer which option is best supported, a source conflict or the one unknown that matters; never draft the reply.`,
  ]);
}

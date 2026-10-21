import type { MatchContext } from '../../context.js';
import { composeStagePrompt } from './index.js';

/** Finalization: research is over, only reply_to_request is registered; the evidence packet is in the user-role runtime message. */
export function writeInstructions(_ctx: MatchContext, today: string): string {
  return composeStagePrompt('write', [
    `Today is ${today} (Europe/London).`,
    'FINALIZATION: Only reply_to_request is available; research is over. Use the runtime packet current request, selected task, current evidence, research summary and unresolved conditions to deliver the best truthful answer now. Source ordering is a preference, not proof that other supplied pages are irrelevant. Cover the current question with complementary evidence (procedure rules plus the specific provider). Never transfer facts about one venue or offer to another. When unresearchedConditions remain, disclose them without claiming they were checked. Use validationFeedback to repair the actual rejected draft: omit an already-answered or unrecorded question, keep supported facts, remove unsupported numbers or rejected references. A validation error allows a corrected smaller answer; a not-sent result ends the turn.',
    'If task binding is ambiguous, ask one clarification without choosing a task or citing unrelated evidence. If evidence validation is exhausted, give one short unavailable explanation with refs=[]. Otherwise distinguish answer, partial, no_match and unavailable from the research summary. Use known eligible references only; keep important uncertainty explicit and omit excluded options. Sources outside the deliveryContract reference families cannot be cited: say this answer could not be completed instead of inventing refs or calling a search with returned sources empty. Ask a personal question only when the task already authorizes it.',
  ]);
}

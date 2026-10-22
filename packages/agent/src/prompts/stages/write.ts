import type { MatchContext } from '../../context.js';
import { composeStagePrompt } from './index.js';

/** Finalization: research is over, only reply_to_request is registered; the evidence packet is in the user-role runtime message. */
export function writeInstructions(_ctx: MatchContext, today: string): string {
  return composeStagePrompt('write', [
    `Today is ${today} (Europe/London).`,
    'FINALIZATION: Only reply_to_request is available; research is over. Use the runtime packet current request, selected task and current evidence to deliver the best truthful answer now. Answer the question that was asked; one option, said once, is a complete reply. Never transfer facts about one venue or offer to another, and never claim something was checked when it was not. Use validationFeedback to repair the actual rejected draft: omit an already-answered or unrecorded question, keep supported facts, remove unsupported numbers or rejected references. A validation error allows a corrected smaller answer; a not-sent result ends the turn.',
    'If task binding is ambiguous, ask one clarification without choosing a task or citing unrelated evidence. If evidence validation is exhausted, give one short unavailable explanation with refs=[]. Use known eligible references only and omit excluded options. Sources outside the deliveryContract reference families cannot be cited: say this answer could not be completed instead of inventing refs or calling a search with returned sources empty. Ask a personal question only when the task already authorizes it.',
  ]);
}

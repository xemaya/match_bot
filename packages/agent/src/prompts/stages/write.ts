import type { AgentDeps, MatchContext } from '../../context.js';
import { writerToolNames } from '../tool-contract.js';
import { composeStagePrompt } from './index.js';

/**
 * Writer (P52): the only stage that talks to the group. Research is over; the evidence packet and
 * the researcher's note are in the user-role runtime message.
 */
export function writeInstructions(deps: AgentDeps, ctx: MatchContext, today: string): string {
  const todayLine = `Today is ${today} (Europe/London).`;
  const tools = writerToolNames(deps, ctx);
  if (tools.has('react'))
    return composeStagePrompt('write', [
      todayLine,
      ['completed', 'cancelled', 'acknowledged'].includes(ctx.taskUpdate?.kind ?? '')
        ? 'ACKNOWLEDGEMENT: Only react or do_nothing is available. Acknowledge once and stop. Do not research, reopen a task or claim you performed the user action.'
        : 'UNSUPPORTED: Job recruitment is outside scope. Use react or do_nothing; do not create a task or promise action.',
    ]);
  const reply = [...tools].join(' or ');
  return composeStagePrompt('write', [
    todayLine,
    `FINALIZATION: Only ${reply} is available; research is over. Use the runtime packet current request, selected task, current evidence and researchNote to deliver the best truthful answer now. Answer the question that was asked; one option, said once, is a complete reply. Never transfer facts about one venue or offer to another, and never claim something was checked when it was not. Use validationFeedback to repair the actual rejected draft: omit an already-answered or unrecorded question, keep supported facts, remove unsupported numbers or rejected references. A validation error allows a corrected smaller answer; a not-sent result ends the turn.`,
    tools.has('reply_in_group')
      ? 'catalogueSuppliers lists the verified providers find_suppliers returned; name them with reply_in_group using exactly those ids.'
      : '',
    'If task binding is ambiguous, ask one clarification without choosing a task or citing unrelated evidence. If evidence validation is exhausted, give one short unavailable explanation with refs=[]. Use known eligible references only and omit excluded options. Sources outside the deliveryContract reference families cannot be cited: say this answer could not be completed instead of inventing refs. Ask a personal question only when the task already authorizes it.',
  ]);
}

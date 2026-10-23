import { Agent } from '@openai/agents';
import { londonToday } from '../clock.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from '../guardrails.js';
import { legacyInstructions } from '../prompts/stages/legacy.js';
import { writeInstructions } from '../prompts/stages/write.js';
import { replyToRequestTool } from '../tools/reply-to-request.js';
import {
  checkpointStep,
  finishOnOutbound,
  generationSettings,
  outboundToolNames,
  stageRunner,
  validateInstructions,
  type StageRun,
} from './shared.js';

/** Finalization: reads the delivery packet and writes the chat line (and the rare card). */
export function createWriterAgent(deps: AgentDeps, run?: StageRun) {
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    toolUseBehavior: async (rc, results) => {
      const ctx = rc.context as MatchContext;
      await checkpointStep(deps, ctx, run);
      return finishOnOutbound(ctx, results, outboundToolNames(deps), { stopWhenBlocked: true });
    },
    resetToolChoice: false,
    modelSettings: generationSettings(deps, { deterministic: !!deps.taskRequests, required: true }),
    instructions: (rc) =>
      deps.answerRequests
        ? writeInstructions(rc.context, londonToday())
        : legacyInstructions(deps, rc.context, londonToday()),
    tools: [replyToRequestTool(deps)],
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  if (deps.answerRequests) validateInstructions(agent, deps, { contract: false });
  return { agent, runner: stageRunner(deps, 'finalization', run) };
}

import { Agent } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from '../guardrails.js';
import { STATUS_INSTRUCTIONS } from '../prompts/stages/status.js';
import { replyRequestStatusTool } from '../tools/reply-request-status.js';
import {
  checkpointStep,
  finishOnOutbound,
  generationSettings,
  outboundToolNames,
  stageRunner,
  validateInstructions,
  type StageRun,
} from './shared.js';

/** Code renders the status text; the model only calls the one tool (needed for the approval snapshot). */
export function createStatusAgent(deps: AgentDeps, run?: StageRun) {
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    toolUseBehavior: async (rc, results) => {
      const ctx = rc.context as MatchContext;
      await checkpointStep(deps, ctx, run);
      return finishOnOutbound(ctx, results, outboundToolNames(deps), { stopWhenBlocked: false });
    },
    resetToolChoice: false,
    modelSettings: generationSettings(deps, { deterministic: !!deps.taskRequests, required: true }),
    instructions: () => STATUS_INSTRUCTIONS,
    tools: [replyRequestStatusTool(deps)],
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  if (deps.answerRequests) validateInstructions(agent, deps, { contract: false });
  return { agent, runner: stageRunner(deps, 'status', run) };
}

import { Agent } from '@openai/agents';
import { londonToday } from '../clock.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from '../guardrails.js';
import { legacyInstructions } from '../prompts/stages/legacy.js';
import { executionTools } from './execution-tools.js';
import {
  checkpointStep,
  finishOnOutbound,
  generationSettings,
  outboundToolNames,
  stageRunner,
  type StageRun,
} from './shared.js';

/** Callers without answerRequests: one agent with the catalogue and evidence-reply tools. */
export function createLegacyAgent(deps: AgentDeps, run?: StageRun) {
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    toolUseBehavior: async (rc, results) => {
      const ctx = rc.context as MatchContext;
      await checkpointStep(deps, ctx, run);
      return finishOnOutbound(ctx, results, outboundToolNames(deps), { stopWhenBlocked: true });
    },
    resetToolChoice: true,
    modelSettings: generationSettings(deps, {
      deterministic: !!deps.taskRequests,
      required: !!(deps.xhsSearch && deps.env.XHS_RESEARCH_ENABLED),
    }),
    instructions: (rc) => legacyInstructions(deps, rc.context, londonToday()),
    tools: executionTools(deps, run?.input),
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  return { agent, runner: stageRunner(deps, 'execution', run) };
}

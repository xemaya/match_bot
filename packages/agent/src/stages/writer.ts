import { Agent } from '@openai/agents';
import { londonToday } from '../clock.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from '../guardrails.js';
import { legacyInstructions } from '../prompts/stages/legacy.js';
import { writeInstructions } from '../prompts/stages/write.js';
import { writerToolNames } from '../prompts/tool-contract.js';
import { doNothingTool } from '../tools/do-nothing.js';
import { reactTool } from '../tools/react.js';
import { replyInGroupTool } from '../tools/reply-in-group.js';
import { replyToRequestTool } from '../tools/reply-to-request.js';
import { replyWithXhsNotesTool } from '../tools/reply-with-xhs-notes.js';
import {
  checkpointStep,
  finishOnOutbound,
  generationSettings,
  outboundToolNames,
  stageRunner,
  validateInstructions,
  type StageRun,
} from './shared.js';

/** The writer's possible tools; the context decides which one (or react/do_nothing) it gets. */
function writerTools(deps: AgentDeps, ctx?: MatchContext) {
  const names = ctx ? writerToolNames(deps, ctx) : new Set(['reply_to_request']);
  return [
    replyToRequestTool(deps),
    replyInGroupTool(deps),
    replyWithXhsNotesTool(deps),
    reactTool(deps),
    doNothingTool(deps),
  ].filter((t) => names.has(t.name));
}

/**
 * Finalization (P52): the only stage that talks to the group. Reads the delivery packet and the
 * researcher's note and writes the chat line (and the rare card), or acknowledges.
 */
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
        ? writeInstructions(deps, rc.context, londonToday())
        : legacyInstructions(deps, rc.context, londonToday()),
    tools: writerTools(deps, run?.context),
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  if (deps.answerRequests) validateInstructions(agent, deps, { contract: false });
  return { agent, runner: stageRunner(deps, 'finalization', run) };
}

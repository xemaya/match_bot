import { Agent } from '@openai/agents';
import { londonToday } from '../clock.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { canHandOffToDelivery } from '../delivery-context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from '../guardrails.js';
import { researchInstructions } from '../prompts/stages/research.js';
import { executionToolNames, validateToolContract } from '../prompts/tool-contract.js';
import { executionTools } from './execution-tools.js';
import {
  checkpointStep,
  final,
  finishOnOutbound,
  generationSettings,
  outboundToolNames,
  stageRunner,
  validateInstructions,
  type StageRun,
  type ToolResults,
} from './shared.js';

/** A recorded task step that the delivery stage can pick up ends research. */
function recordedProgress(results: ToolResults): boolean {
  return results.some((r) => {
    if (r.tool.name !== 'record_task_progress' || !('output' in r) || typeof r.output !== 'string')
      return false;
    try {
      return (JSON.parse(r.output) as { recorded?: unknown }).recorded === true;
    } catch {
      return false;
    }
  });
}

/**
 * Execution: scene workflow plus research tools, narrowed to the scene contract. The default
 * run_llm_again lets it chain record → search → read → reply; write tools are idempotent and every
 * outbound goes through the gate and rate limits.
 */
export function createResearcherAgent(deps: AgentDeps, run?: StageRun) {
  const promptContext = run?.context;
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    // Evidence ready for delivery ends the run; invalid evidence goes back to the model to fix
    // without spending an extra closing turn.
    toolUseBehavior: async (rc, results) => {
      const ctx = rc.context as MatchContext;
      await checkpointStep(deps, ctx, run);
      if (deps.taskRequests && canHandOffToDelivery(ctx) && recordedProgress(results))
        return final('research ready for delivery');
      return finishOnOutbound(ctx, results, outboundToolNames(deps), { stopWhenBlocked: true });
    },
    resetToolChoice: true,
    modelSettings: generationSettings(deps, {
      deterministic: !!deps.taskRequests,
      required: !!(deps.xhsSearch && deps.env.XHS_RESEARCH_ENABLED),
    }),
    instructions: (rc) => researchInstructions(deps, rc.context, false, londonToday()),
    tools: executionTools(deps, run?.input),
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  if (promptContext) {
    const allowed = executionToolNames(deps, promptContext);
    agent.tools = agent.tools.filter((t) => t.type === 'function' && allowed.has(t.name));
    validateToolContract(
      deps,
      promptContext,
      agent.tools.map((t) => (t.type === 'function' ? t.name : '')),
    );
  }
  for (const t of agent.tools)
    if (t.type === 'function') {
      const enabled = t.isEnabled;
      t.isEnabled = async (rc, current) =>
        executionToolNames(deps, rc.context).has(t.name) && (await enabled(rc, current));
    }
  validateInstructions(agent, deps, { contract: true });
  return { agent, runner: stageRunner(deps, 'execution', run) };
}

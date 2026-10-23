import {
  type Agent,
  type CallModelInputFilter,
  Runner,
  type FunctionToolResult,
  type ModelSettings,
  type ToolsToFinalOutputResult,
} from '@openai/agents';
import type { Phase } from '@matchbot/domain';
import { AGENT_VERSION } from '../agent-version.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { saveExecutionCheckpoint } from '../execution-checkpoint.js';
import { contextInputFilter, type PromptStage } from '../prompts/runtime-context.js';
import { selectScene } from '../prompts/policy/scenes.js';
import { validatePromptReferences, validateToolContract } from '../prompts/tool-contract.js';

/** What the caller knows about this run; every stage factory takes the same shape. */
export interface StageRun {
  phase: Phase;
  context?: MatchContext;
  input?: string;
  inputRef?: string;
  taskId?: string;
  taskRefs?: string[];
  checkpointInput?: string;
  requestContext?: MatchContext;
}

export type ToolResults = FunctionToolResult[];

export const NOT_FINAL: ToolsToFinalOutputResult = {
  isFinalOutput: false,
  isInterrupted: undefined,
};
export const final = (finalOutput: string): ToolsToFinalOutputResult => ({
  isFinalOutput: true,
  isInterrupted: undefined,
  finalOutput,
});

/** Every stage that has a run input checkpoints after each tool step, so a crash resumes from there. */
export async function checkpointStep(deps: AgentDeps, ctx: MatchContext, run?: StageRun) {
  if (run?.input !== undefined)
    await saveExecutionCheckpoint(deps, ctx, run.checkpointInput ?? run.input, AGENT_VERSION);
}

/**
 * Outbound tools end the run once the reply is queued, recorded as a dry run or refused; a
 * successful do_nothing ends it quietly. Invalid drafts return other text and go back to the model.
 */
export function finishOnOutbound(
  ctx: MatchContext,
  results: ToolResults,
  outboundTools: readonly string[],
  opts: { stopWhenBlocked: boolean },
): ToolsToFinalOutputResult {
  if (ctx.outboundBlocked && opts.stopWhenBlocked) return final('not sent: outbound blocked');
  const quiet = results.find(
    (r) =>
      'output' in r &&
      r.tool.name === 'do_nothing' &&
      typeof r.output === 'string' &&
      /^ok(?:$|:)/.test(r.output),
  );
  if (quiet && 'output' in quiet) return final(String(quiet.output));
  const finished = results.find(
    (r) =>
      'output' in r &&
      outboundTools.includes(r.tool.name) &&
      typeof r.output === 'string' &&
      /^(?:queued|dry-run recorded|not sent)/.test(r.output),
  );
  return finished && 'output' in finished ? final(String(finished.output)) : NOT_FINAL;
}

/** Reply tools that end an answer-requests run; legacy callers only stop on the evidence replies. */
export function outboundToolNames(deps: AgentDeps): readonly string[] {
  return deps.answerRequests
    ? [
        'reply_with_xhs_notes',
        'reply_with_market_results',
        'reply_to_request',
        'react',
        'reply_request_status',
        'reply_in_group',
        'reply_with_search_results',
        'ask_clarification',
      ]
    : ['reply_with_xhs_notes', 'reply_with_market_results'];
}

/**
 * P14: the default high reasoning effort timed out multi-source synthesis; Jev judges, Flash
 * generates, and code still validates the evidence. Deterministic stages run at temperature 0
 * without parallel calls; `required` forces a tool call on stages whose only output is a tool.
 */
export function generationSettings(
  deps: AgentDeps,
  opts: { deterministic: boolean; required: boolean },
): ModelSettings {
  const flash = deps.env.DEEPSEEK_MODEL === 'deepseek-flash';
  return {
    ...(deps.env.GENERATION_REASONING_EFFORT
      ? { reasoning: { effort: deps.env.GENERATION_REASONING_EFFORT } }
      : {}),
    ...(flash ? { providerData: { thinking: { type: 'disabled' } } } : {}),
    ...(flash && opts.deterministic ? { temperature: 0 } : {}),
    ...(opts.deterministic ? { parallelToolCalls: false } : {}),
    ...(opts.required ? { toolChoice: 'required' as const } : {}),
  };
}

/**
 * Wraps the dynamic prompt so every model call checks that the prompt only names tools this stage
 * actually registered; `contract` additionally checks the execution tool set against the scene.
 */
export function validateInstructions(
  agent: Agent<MatchContext>,
  deps: AgentDeps,
  opts: { contract: boolean },
): void {
  const instructions = agent.instructions;
  if (typeof instructions !== 'function') throw new Error('expected dynamic prompt builder');
  agent.instructions = async (rc, current) => {
    const prompt = await instructions(rc, current);
    const names = new Set(
      (await agent.getAllTools(rc)).flatMap((t) => (t.type === 'function' ? [t.name] : [])),
    );
    if (opts.contract) validateToolContract(deps, rc.context, [...names]);
    validatePromptReferences(prompt, names);
    return prompt;
  };
}

/**
 * Runner per run (V6: traceMetadata belongs to RunConfig, so it can only be passed to a new
 * Runner); traceIncludeSensitiveData: false keeps message text out of spans.
 */
export function stageRunner(
  deps: AgentDeps,
  stage: PromptStage,
  run?: StageRun,
  inputFilter: CallModelInputFilter = contextInputFilter(stage),
): Runner {
  const promptContext = run?.context;
  return new Runner({
    callModelInputFilter: inputFilter,
    traceIncludeSensitiveData: false,
    ...(run
      ? {
          traceMetadata: {
            model: deps.env.DEEPSEEK_MODEL,
            phase: String(run.phase),
            promptArchitecture: '1',
            promptStage: stage,
            ...(promptContext && deps.answerRequests
              ? { promptScene: selectScene(promptContext) }
              : {}),
            ...(run.inputRef ? { inputRef: run.inputRef } : {}),
            ...(run.taskId ? { taskId: run.taskId } : {}),
          },
        }
      : {}),
    ...(deps.modelProvider ? { modelProvider: deps.modelProvider } : {}),
  });
}

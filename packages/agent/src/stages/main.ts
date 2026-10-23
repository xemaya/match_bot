import { Agent, type CallModelInputFilter } from '@openai/agents';
import { londonToday } from '../clock.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { freshGroupLines } from '../group-context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from '../guardrails.js';
import { contextInputFilter } from '../prompts/runtime-context.js';
import { mainInstructions } from '../prompts/stages/main.js';
import { writerToolNames } from '../prompts/tool-contract.js';
import { doNothingTool } from '../tools/do-nothing.js';
import { referMemberTool, sayBrieflyTool } from '../tools/group-speech.js';
import { reactTool } from '../tools/react.js';
import { replyInGroupTool } from '../tools/reply-in-group.js';
import { replyToRequestTool } from '../tools/reply-to-request.js';
import { replyWithXhsNotesTool } from '../tools/reply-with-xhs-notes.js';
import { researchTool } from '../tools/research.js';
import {
  checkpointStep,
  finishOnOutbound,
  generationSettings,
  outboundToolNames,
  stageRunner,
  validateInstructions,
  type StageRun,
} from './shared.js';

export const MAIN_SPEECH_TOOLS = ['say_briefly', 'refer_member'] as const;

/**
 * Before every model call, pull in what the group said since the run started (freshness check):
 * after a minute of research the reply must still fit the conversation.
 */
function mainInputFilter(deps: AgentDeps): CallModelInputFilter {
  const base = contextInputFilter('main');
  return async (args) => {
    const ctx = args.context as MatchContext | undefined;
    if (ctx?.groupId && ctx.mainStartedAt)
      ctx.newGroupLines = await freshGroupLines(deps.repos, {
        groupId: ctx.groupId,
        chatId: ctx.chatId,
        sourceMessageId: ctx.sourceMessageId,
        userId: ctx.userId,
        since: new Date(ctx.mainStartedAt),
      });
    return base(args);
  };
}

/**
 * P53: A2H in the group. The only stage with the voice and the outbound tools for group turns; it
 * may stay silent, react, say a fact-free half line, point at a member, or research and answer.
 * The reply tool that needs evidence follows the writer's per-context choice.
 */
export function createMainAgent(deps: AgentDeps, run?: StageRun) {
  const replyEnabled = (name: string) => (rc: { context: MatchContext }) =>
    Promise.resolve(writerToolNames(deps, rc.context).has(name));
  const replies = [replyToRequestTool(deps), replyInGroupTool(deps), replyWithXhsNotesTool(deps)];
  for (const t of replies) t.isEnabled = replyEnabled(t.name) as typeof t.isEnabled;
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    toolUseBehavior: async (rc, results) => {
      const ctx = rc.context as MatchContext;
      await checkpointStep(deps, ctx, run);
      return finishOnOutbound(ctx, results, [...outboundToolNames(deps), ...MAIN_SPEECH_TOOLS], {
        stopWhenBlocked: true,
      });
    },
    resetToolChoice: true,
    modelSettings: generationSettings(deps, { deterministic: !!deps.taskRequests, required: true }),
    instructions: (rc) => mainInstructions(deps, rc.context, londonToday()),
    tools: [
      researchTool(deps),
      ...replies,
      sayBrieflyTool(deps),
      referMemberTool(deps),
      reactTool(deps),
      doNothingTool(deps),
    ],
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  validateInstructions(agent, deps, { contract: false });
  return { agent, runner: stageRunner(deps, 'main', run, mainInputFilter(deps)) };
}

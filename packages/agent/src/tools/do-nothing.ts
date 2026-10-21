import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { canSkipSupplementReply } from '../supplement-replies.js';
import { isUnsolicitedGroupTurn } from '../request-status.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { DO_NOTHING } from '../prompts/tools/do-nothing.js';

export function doNothingTool(deps: AgentDeps) {
  return tool({
    name: 'do_nothing',
    description: DO_NOTHING.description,
    parameters: z.object({
      reason: z.string().max(300),
    }),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        output: { gate: 'agent_noop', reason: args.reason },
        phase: ctx.phase,
        latencyMs: 0,
        costMicro: 0,
      });
      if (canSkipSupplementReply(ctx)) {
        ctx.replySuppressed = true;
        return DO_NOTHING.results.supplementQuiet;
      }
      // Nobody asked the assistant directly: with nothing useful to add, silence is the right reply.
      if (isUnsolicitedGroupTurn(ctx)) {
        ctx.replySuppressed = true;
        return DO_NOTHING.results.groupQuiet;
      }
      return ctx.currentRequest?.isActionable &&
        !ctx.outboundBlocked &&
        ctx.currentRequest.demand.category !== 'job'
        ? DO_NOTHING.results.actionable
        : DO_NOTHING.results.ok;
    },
  });
}

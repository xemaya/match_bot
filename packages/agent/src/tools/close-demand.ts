import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { CLOSE_DEMAND } from '../prompts/tools/catalogue.js';

export function closeDemandTool(deps: AgentDeps) {
  return tool({
    name: 'close_demand',
    description: CLOSE_DEMAND.description,
    parameters: z.object({}),
    execute: async (_args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (!ctx.demandId) return CLOSE_DEMAND.results.none;
      await deps.repos.demands.setStatus(ctx.demandId, 'closed');
      return CLOSE_DEMAND.results.closed;
    },
  });
}

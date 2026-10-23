import { scoreSuppliers } from '@matchbot/matcher';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { FIND_SUPPLIERS } from '../prompts/tools/catalogue.js';

export function findSuppliersTool(deps: AgentDeps) {
  return tool({
    name: 'find_suppliers',
    description: FIND_SUPPLIERS.description,
    parameters: z.object({}),
    execute: async (_args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (!ctx.demand || !ctx.demandId) return FIND_SUPPLIERS.feedback.noDemand;
      const candidates = await deps.repos.suppliers.findCandidates({
        category: ctx.demand.category,
      });
      const scored = scoreSuppliers({
        demand: ctx.demand,
        suppliers: candidates,
        now: new Date(),
      }).slice(0, 3);
      ctx.supplierSearchEmpty = scored.length === 0;
      if (scored.length === 0) return FIND_SUPPLIERS.feedback.none;
      await deps.repos.matches.replaceForDemand(
        ctx.demandId,
        scored.map((s, i) => ({ supplierId: s.id, matcherScore: s.score, rank: i + 1 })),
      );
      const byId = new Map(candidates.map((c) => [c.id, c]));
      ctx.catalogueSuppliers = scored.map((s) => {
        const c = byId.get(s.id);
        return {
          id: s.id,
          name: c?.name,
          price: c?.roughPrice,
          phone: c?.phone,
          whatsapp: c?.whatsapp,
          pool: c?.pool,
          reasons: s.reasons,
        };
      });
      return JSON.stringify(ctx.catalogueSuppliers);
    },
  });
}

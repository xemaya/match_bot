import { scorePeerSupplies } from '@matchbot/matcher';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { FIND_PEER_SUPPLY } from '../prompts/tools/catalogue.js';

export function findPeerSupplyTool(deps: AgentDeps) {
  return tool({
    name: 'find_peer_supply',
    description: FIND_PEER_SUPPLY.description,
    parameters: z.object({}),
    execute: async (_args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (!ctx.demand) return FIND_PEER_SUPPLY.feedback.noDemand;
      if (!ctx.groupId) return FIND_PEER_SUPPLY.feedback.notGroup;
      // Never offer a member their own post, nor offers from other groups (架构 §9).
      const supplies = (
        await deps.repos.supplies.findActive(ctx.demand.category, ctx.groupId)
      ).filter((s) => s.userId !== ctx.userId);
      const scored = scorePeerSupplies({ demand: ctx.demand, supplies, now: new Date() }).slice(
        0,
        3,
      );
      if (scored.length === 0) return FIND_PEER_SUPPLY.feedback.none;
      const byId = new Map(supplies.map((s) => [s.id, s]));
      // 群成员的联系方式不进返回（架构 §9）；撮合通过群内回复完成
      return JSON.stringify(
        scored.map((s) => {
          const c = byId.get(s.id);
          return {
            id: s.id,
            availability: c?.availability ?? null,
            area: c?.area ?? null,
            reasons: s.reasons,
          };
        }),
      );
    },
  });
}

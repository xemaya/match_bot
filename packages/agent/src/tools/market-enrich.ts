import { MarketSearchError, type MarketSearch } from '@matchbot/websearch';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { buildMarketChoices, buildMarketResearchTasks } from '../market-choices.js';
import type { AgentDeps, MatchContext } from '../context.js';
import {
  MARKET_EXCERPT_CHARS,
  marketListingForModel,
  MARKET_RESEARCH_LIMITS,
} from '../market-research.js';
import { MARKET_ENRICH } from '../prompts/tools/market-enrich.js';
export function marketEnrichTool(deps: AgentDeps & { marketSearch: MarketSearch }) {
  return tool({
    name: 'market_enrich',
    description: MARKET_ENRICH.description,
    parameters: z.object({ refs: z.array(z.string()).min(1).max(4) }),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const deny = async (reason: string) => {
        await deps.repos.traces.create({
          kind: 'gate',
          inputRef: ctx.sourceMessageId,
          output: { gate: 'market_enrich', decision: 'deny', reason },
          phase: ctx.phase,
          latencyMs: 0,
          costMicro: 0,
        });
        return reason;
      };
      if (ctx.outboundBlocked) return deny(MARKET_ENRICH.feedback.blocked);
      const listings = ctx.marketListings ?? [];
      const selected = [...new Set(args.refs)].map((ref) => listings.find((n) => n.ref === ref));
      if (selected.some((n) => !n)) return deny(MARKET_ENRICH.feedback.unknownRef);
      const attempted = new Set(ctx.marketDetailIds ?? []);
      const fresh = selected.filter((n) => n && !attempted.has(n.id));
      if (attempted.size + fresh.length > MARKET_RESEARCH_LIMITS.details)
        return deny(MARKET_ENRICH.feedback.detailBudget);
      if (!fresh.length) return deny(MARKET_ENRICH.feedback.repeated);
      for (const n of fresh) if (n) attempted.add(n.id);
      ctx.marketDetailIds = [...attempted];
      const started = Date.now();
      const results = await Promise.allSettled(fresh.map((n) => deps.marketSearch.detail(n!.id)));
      const failures = [];
      const enriched = [];
      for (const [index, result] of results.entries()) {
        const old = fresh[index];
        if (!old) continue;
        if (result.status === 'rejected') {
          failures.push({
            ref: old.ref,
            reason:
              result.reason instanceof MarketSearchError ? result.reason.reason : 'detail_failed',
          });
          continue;
        }
        const replacement = { ...result.value, ref: old.ref };
        const stored = listings.findIndex((n) => n.id === old.id);
        if (stored >= 0) listings[stored] = replacement;
        enriched.push(replacement);
      }
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        output: { gate: 'market_enrich', refs: args.refs, enriched: enriched.length, failures },
        phase: ctx.phase,
        latencyMs: Date.now() - started,
        costMicro: 0,
      });
      const choices = ctx.marketPlan
        ? buildMarketChoices({ candidates: listings, plan: ctx.marketPlan })
        : null;
      const researchTasks =
        choices && ctx.marketPlan
          ? buildMarketResearchTasks({
              choices,
              plan: ctx.marketPlan,
              detailIds: ctx.marketDetailIds,
              queries: (ctx.marketQueries ?? []).map((q) => q.keyword),
              remainingDetails: 8 - attempted.size,
              remainingQueries: 8 - (ctx.marketQueries?.length ?? 0),
            })
          : [];
      return JSON.stringify({
        choiceHints: choices
          ? {
              primaryRefs: choices.primary.map((r) => r.listing.ref),
              backupRefs: choices.backup.map((r) => r.listing.ref),
              missing: [...choices.primary, ...choices.backup].map((r) => ({
                ref: r.listing.ref,
                critical: r.essentialMissing,
                unconfirmed: r.missing,
              })),
            }
          : null,
        researchTasks,
        listings: enriched.map((n) =>
          marketListingForModel(
            n,
            MARKET_EXCERPT_CHARS.detail,
            ctx.marketPlan
              ? [
                  ...ctx.marketPlan.needs.flatMap((need) => need.terms),
                  ...ctx.marketPlan.preferences,
                  '价格：',
                  '时间：',
                  '入住',
                  '地点：',
                ]
              : [],
          ),
        ),
        failures,
        remainingDetails: MARKET_RESEARCH_LIMITS.details - attempted.size,
        guidance: MARKET_ENRICH.results.guidance,
      });
    },
  });
}

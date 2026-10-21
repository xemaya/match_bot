import {
  assertSafeXhsKeyword,
  MARKET_INTENTS,
  MarketSearchError,
  UnsafeQueryError,
  type MarketSearch,
} from '@matchbot/websearch';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { hashText } from '@matchbot/shared';
import { buildMarketChoices, buildMarketResearchTasks } from '../market-choices.js';
import { bindTaskMarketPlan } from '../task-market-plan.js';
import { marketPlanInputSchema, toMarketPlan, rankMarketListings } from '../market-strategy.js';
import type { AgentDeps, MatchContext } from '../context.js';
import {
  getMarketQueryKey,
  MARKET_EXCERPT_CHARS,
  marketListingForModel,
  marketQuerySchema,
  MARKET_RESEARCH_LIMITS,
  type MarketCandidate,
  type MarketResearchQuery,
} from '../market-research.js';
import { MARKET_SEARCH } from '../prompts/tools/market-search.js';

export function marketSearchTool(
  deps: AgentDeps & { marketSearch: MarketSearch },
  requestText?: string,
) {
  const inner = z.object({
    plan: marketPlanInputSchema.nullish().describe(MARKET_SEARCH.params.plan),
    intent: z.enum(MARKET_INTENTS),
    purpose: z.enum(['discover', 'enrich']),
    queries: z.array(marketQuerySchema).min(1).max(3),
  });
  // The SDK redacts the parse error it hands to errorFunction, so the schema is checked once more
  // here, before the SDK's own parse, to keep the field paths and messages (never the values) for
  // the repair hint. 2026-10-20 replay: a 14-item requiredArea failed twice because the model was
  // told to "quote strings" instead of which field broke.
  let lastIssues: string[] = [];
  const parameters = z.preprocess((raw) => {
    const checked = inner.safeParse(raw);
    lastIssues = checked.success
      ? []
      : checked.error.issues
          .slice(0, 6)
          .map((issue) => issue.path.join('.') + ': ' + issue.message);
    return raw;
  }, inner);
  const feedback = new WeakMap<MatchContext, { count: number; message: string }>();
  return tool({
    name: 'market_search',
    description: MARKET_SEARCH.description,
    parameters,
    needsApproval: deps.answerRequests
      ? false
      : async (rc, args) => {
          const ctx = rc.context as MatchContext;
          const parsed = parameters.safeParse(args);
          if (parsed.success) {
            feedback.delete(ctx);
            return false;
          }
          const count = (feedback.get(ctx)?.count ?? 0) + 1;
          const message = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
          feedback.set(ctx, { count, message });
          if (count >= 3) ctx.outboundBlocked = true;
          await deps.repos.traces.create({
            kind: 'gate',
            inputRef: ctx.sourceMessageId,
            output: {
              gate: 'market_search_input',
              decision: 'deny',
              reason: count >= 3 ? 'input_retry_limit' : 'invalid_schema',
              attempt: count,
              detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`),
            },
            phase: ctx.phase,
            latencyMs: 0,
            costMicro: 0,
          });
          return false;
        },
    errorFunction: async (rc, error) => {
      if (deps.answerRequests) {
        const ctx = rc.context as MatchContext;
        const count = (feedback.get(ctx)?.count ?? 0) + 1;
        const issues =
          error instanceof Error && error.name === 'InvalidToolInputError' ? lastIssues : [];
        feedback.set(ctx, { count, message: issues.join('; ') || 'invalid JSON/schema' });
        await deps.repos.traces.create({
          kind: 'gate',
          inputRef: ctx.sourceMessageId,
          output: {
            gate: 'market_search_input',
            reason: 'invalid_json_or_schema',
            attempt: count,
            detail: issues,
          },
          phase: ctx.phase,
          latencyMs: 0,
          costMicro: 0,
        });
        return count >= 2
          ? MARKET_SEARCH.feedback.repairFailed
          : MARKET_SEARCH.feedback.invalid(issues);
      }
      const info = feedback.get(rc.context as MatchContext);
      if (info?.count && info.count >= 3) return MARKET_SEARCH.feedback.legacyRetryLimit;
      return error instanceof Error && error.name === 'InvalidToolInputError'
        ? MARKET_SEARCH.feedback.legacyInvalid(info?.message)
        : MARKET_SEARCH.feedback.legacyInternal;
    },
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const deny = async (reason: string) => {
        await trace({ decision: 'deny', reason });
        return reason;
      };
      if (deps.answerRequests && (feedback.get(ctx)?.count ?? 0) >= 2)
        return deny(MARKET_SEARCH.feedback.repairLimit);
      if (ctx.outboundBlocked) return deny(MARKET_SEARCH.feedback.blocked);
      if (
        deps.answerRequests
          ? ctx.xhsNotes?.length || ctx.searchResults?.length
          : ctx.xhsNotes || ctx.searchResults
      )
        return deny(MARKET_SEARCH.feedback.sourceSwitched);
      const category = ctx.demand?.category;
      const allowed =
        category === 'housing'
          ? args.intent === 'housing'
          : category === 'second_hand'
            ? args.intent === 'second_hand'
            : category === 'other' && (args.intent === 'carry' || args.intent === 'companion');
      if (!allowed)
        return deny(
          deps.answerRequests
            ? MARKET_SEARCH.feedback.outsideRoutes
            : MARKET_SEARCH.feedback.outsideRoutesLegacy,
        );
      if (ctx.marketIntent && ctx.marketIntent !== args.intent)
        return deny(MARKET_SEARCH.feedback.intentSwitch);
      if (args.plan && !ctx.marketPlan) {
        const publicTerms = [
          ...args.plan.needs.flatMap((n) => n.terms),
          ...args.plan.preferences,
          ...args.plan.requiredTerms,
          ...args.plan.excludeTerms,
          ...args.plan.requiredArea,
          ...(args.plan.route ? [...args.plan.route.from, ...args.plan.route.to] : []),
        ];
        try {
          publicTerms.forEach((term) =>
            assertSafeXhsKeyword(term.length < 2 ? term + ' 公开' : term),
          );
        } catch (error) {
          if (!(error instanceof UnsafeQueryError)) throw error;
          return deny(MARKET_SEARCH.feedback.planUnsafe);
        }
        if (args.plan.dateRange && args.plan.dateRange.from > args.plan.dateRange.to)
          return deny(MARKET_SEARCH.feedback.planDates);
        const proposed = toMarketPlan({ ...args.plan, intent: args.intent }, requestText);
        ctx.marketPlan = ctx.task ? bindTaskMarketPlan(proposed, ctx.task) : proposed;
      }
      if (args.plan && ctx.marketPlan) {
        let learned = 0;
        for (const need of ctx.marketPlan.needs) {
          const proposed = args.plan.needs.find((item) => item.id === need.id);
          if (!proposed) continue;
          const aliases = proposed.terms.filter(
            (term) =>
              !need.terms.includes(term) &&
              (ctx.marketListings ?? []).some((listing) =>
                (listing.title + '\n' + listing.description)
                  .toLocaleLowerCase()
                  .includes(term.toLocaleLowerCase()),
              ),
          );
          for (const term of aliases) assertSafeXhsKeyword(term.length < 2 ? term + ' 公开' : term);
          if (aliases.length) {
            need.terms = [...new Set([...need.terms.slice(0, 8), ...aliases.slice(0, 4)])];
            learned += aliases.length;
          }
        }
        if (learned) await trace({ decision: 'aliases_extended', learned });
      }
      const planApplied = ctx.marketPlan
        ? {
            needs: ctx.marketPlan.needs.length,
            preferences: ctx.marketPlan.preferences.length,
            requiredTerms: ctx.marketPlan.requiredTerms?.length ?? 0,
            excludeTerms: ctx.marketPlan.excludeTerms?.length ?? 0,
            budgetSpecified: ctx.marketPlan.budget !== undefined,
            hasRoute: !!ctx.marketPlan.route,
            hasDateRange: !!ctx.marketPlan.dateRange,
            // Public search terms only, so a silent subject mismatch is visible in the trace.
            needTerms: ctx.marketPlan.needs.map((n) => n.terms),
            requiredArea: ctx.marketPlan.requiredArea ?? [],
          }
        : null;
      if (ctx.task && ctx.execution && ctx.marketPlan) {
        const hints = ctx.marketPlan.needs
          .filter((n) =>
            n.terms.some(
              (term) => !ctx.task!.goals.find((g) => g.id === n.id)?.searchTerms?.includes(term),
            ),
          )
          .map((n) => ({ goalId: n.id, terms: n.terms }));
        if (hints.length) {
          hints
            .flatMap((hint) => hint.terms)
            .forEach((term) => assertSafeXhsKeyword(term.length < 2 ? term + ' 公开' : term));
          const result = await deps.repos.tasks.rememberSearchTerms({
            access: {
              userId: ctx.userId,
              scope: { channel: ctx.channel ?? 'telegram', chatId: ctx.chatId },
            },
            id: ctx.task.id,
            sourceMessageId: ctx.sourceMessageId,
            requirementsVersion: ctx.task.requirementsVersion,
            operationKey:
              ctx.sourceMessageId + ':terms:' + hashText(JSON.stringify(hints)).slice(0, 32),
            hints,
          });
          if (result.kind !== 'applied' && result.kind !== 'replayed')
            return deny(MARKET_SEARCH.feedback.taskChanged);
          ctx.task = result.task;
        }
      }
      const previous = ctx.marketQueries ?? [];
      const pending: MarketResearchQuery[] = [];
      const keys = new Set(previous.map(getMarketQueryKey));
      try {
        for (const q of args.queries) {
          const keyword = assertSafeXhsKeyword(q.keyword);
          if (
            args.purpose === 'enrich' &&
            (!q.entity ||
              !keyword.includes(q.entity) ||
              !(ctx.marketListings ?? []).some((n) =>
                (n.title + '\n' + n.description).includes(q.entity!),
              ))
          )
            return deny(MARKET_SEARCH.feedback.enrichNeedsEntity);
          const plan = {
            ...q,
            keyword,
            tradeType: ctx.marketTarget ?? q.tradeType,
            purpose: args.purpose,
            intent: args.intent,
          };
          const key = getMarketQueryKey(plan);
          if (!keys.has(key)) {
            pending.push(plan);
            keys.add(key);
          }
        }
      } catch (error) {
        if (!(error instanceof UnsafeQueryError)) throw error;
        return deny(MARKET_SEARCH.feedback.queryUnsafe);
      }
      if (
        previous.length + pending.length > MARKET_RESEARCH_LIMITS.queries ||
        (ctx.marketListings?.length ?? 0) >= MARKET_RESEARCH_LIMITS.listings
      )
        return deny(MARKET_SEARCH.feedback.budgetExhausted);
      if (
        args.purpose === 'discover' &&
        previous.filter((q) => q.purpose === 'discover').length + pending.length >
          MARKET_RESEARCH_LIMITS.discoveryQueries
      )
        return deny(MARKET_SEARCH.feedback.discoveryExhausted);
      if (!pending.length) {
        await trace({ decision: 'cached' });
        return MARKET_SEARCH.feedback.cached;
      }
      ctx.marketIntent = args.intent;
      ctx.marketQueries = [...previous, ...pending];
      ctx.marketListings ??= [];
      const started = Date.now();
      const batches = await Promise.allSettled(
        pending.map((q) =>
          deps.marketSearch.find({ keyword: q.keyword, page: q.page, tradeType: q.tradeType }),
        ),
      );
      const added: MarketCandidate[] = [];
      const seen = new Set(ctx.marketListings.map((n) => n.id));
      const results = batches.map((batch) =>
        batch.status === 'fulfilled' ? batch.value.items.slice(0, 20) : [],
      );
      // 按各 query 交错取候选，避免泛 query 把后面主题的配额先吃光。
      for (let index = 0; index < 20; index++)
        for (const items of results) {
          const listing = items[index];
          if (
            !listing ||
            seen.has(listing.id) ||
            ctx.marketListings.length >= MARKET_RESEARCH_LIMITS.listings
          )
            continue;
          seen.add(listing.id);
          const saved = { ...listing, ref: `m${ctx.marketListings.length + 1}` };
          ctx.marketListings.push(saved);
          added.push(saved);
        }
      if (batches.some((b) => b.status === 'rejected')) {
        ctx.sourceFailures ??= [];
        ctx.sourceFailures.push('market:unavailable');
      }
      const failures = batches.flatMap((b, i) =>
        b.status === 'rejected'
          ? [
              {
                query: i,
                reason: b.reason instanceof MarketSearchError ? b.reason.reason : 'search_failed',
              },
            ]
          : [],
      );
      await trace(
        {
          decision: 'searched',
          queries: pending,
          added: added.length,
          total: ctx.marketListings.length,
          planApplied,
          failures,
        },
        Date.now() - started,
      );
      const ranked = ctx.marketPlan
        ? rankMarketListings(ctx.marketListings, ctx.marketPlan, 160)
        : ctx.marketListings.map((listing) => ({ listing, assessment: null }));
      const missingNeed =
        ctx.marketPlan?.needs.some(
          (need) => !ranked.some((row) => row.assessment?.needs.includes(need.id)),
        ) ?? false;
      const exploratory = missingNeed
        ? ctx.marketListings
            .filter((listing) => !ranked.some((row) => row.listing.id === listing.id))
            .slice(0, 4)
            .map((listing) => ({ listing, assessment: null }))
        : [];
      const displayed = ctx.marketPlan
        ? [...ranked.slice(0, exploratory.length ? 6 : 8), ...exploratory]
        : added.map((listing) => ({ listing, assessment: null }));
      const terms = ctx.marketPlan?.needs.flatMap((n) => n.terms) ?? pending.map((q) => q.keyword);
      const coverage = ctx.marketPlan?.needs.map((need) => ({
        id: need.id,
        candidates: ranked.filter((row) => row.assessment?.needs.includes(need.id)).length,
      }));
      const choices = ctx.marketPlan
        ? buildMarketChoices({ candidates: ctx.marketListings, plan: ctx.marketPlan })
        : null;
      const researchTasks =
        choices && ctx.marketPlan
          ? buildMarketResearchTasks({
              choices,
              plan: ctx.marketPlan,
              detailIds: ctx.marketDetailIds ?? [],
              queries: ctx.marketQueries.map((q) => q.keyword),
              remainingDetails: 8 - (ctx.marketDetailIds?.length ?? 0),
              remainingQueries: 8 - ctx.marketQueries.length,
            })
          : [];
      return JSON.stringify({
        status:
          failures.length === batches.length
            ? 'unavailable'
            : failures.length
              ? 'partial'
              : added.length
                ? 'ok'
                : 'empty',
        listings: displayed.map((row) => ({
          ...marketListingForModel(row.listing, MARKET_EXCERPT_CHARS.search, terms),
          assessment: row.assessment
            ? {
                needs: row.assessment.needs,
                score: row.assessment.score,
                checks: row.assessment.checks,
                itemPriceEvidence: row.assessment.itemPriceEvidence,
              }
            : null,
        })),
        coverage,
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
        exploratoryRefs: exploratory.map((row) => row.listing.ref),
        candidatePool: ctx.marketListings.length,
        omittedViews: Math.max(0, ranked.length - displayed.length),
        effectiveTradeType: ctx.marketTarget ?? null,
        remainingQueries: 8 - ctx.marketQueries.length,
        remainingDiscoveryQueries:
          8 - ctx.marketQueries.filter((q) => q.purpose === 'discover').length,
        remainingDetails: 8 - (ctx.marketDetailIds?.length ?? 0),
        pages: batches.map((b, i) => ({
          keyword: pending[i]?.keyword,
          page: pending[i]?.page,
          hasNext: b.status === 'fulfilled' ? b.value.hasNext : null,
          unfilteredTotal: b.status === 'fulfilled' ? b.value.total : null,
          notice: b.status === 'fulfilled' ? (b.value.notice ?? null) : null,
        })),
        failures,
        guidance:
          (failures.length === batches.length ? MARKET_SEARCH.results.allFailed : '') +
          MARKET_SEARCH.results.guidance,
      });
      async function trace(output: Record<string, unknown>, latencyMs = 0) {
        await deps.repos.traces.create({
          kind: 'gate',
          inputRef: ctx.sourceMessageId,
          output: { gate: 'market_search', ...output },
          phase: ctx.phase,
          latencyMs,
          costMicro: 0,
        });
      }
    },
  });
}

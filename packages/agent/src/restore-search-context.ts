import { INFORMATION_LIMITS } from './information-limits.js';
import { currentRequestSchema } from './current-request.js';
import { knowledgeSourceSchema } from './knowledge-evidence.js';
import { demandDraftSchema } from '@matchbot/domain';
import { z } from 'zod';
import type { MatchContext } from './context.js';
import { XHS_RESEARCH_LIMITS, xhsResearchQuerySchema } from './xhs-research.js';
import { xhsRecommendationSchema } from './xhs-recommendations.js';
import { marketPlanSchema, type marketRulesSchema, type MarketRules } from './market-strategy.js';
import { MARKET_INTENTS } from '@matchbot/websearch';
import {
  marketCandidateSchema,
  marketResearchQuerySchema,
  MARKET_RESEARCH_LIMITS,
} from './market-research.js';

export const researchContextSchema = z.object({
  userId: z.string(),
  chatId: z.string(),
  phase: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  sourceMessageId: z.string(),
  groupId: z.string().nullable(),
  source: z.object({ messageId: z.string(), userId: z.string() }).optional(),
  demand: demandDraftSchema.optional(),
  demandId: z.string().optional(),
  supplierSearchEmpty: z.boolean().optional(),
  taskProgressCalls: z.number().int().nonnegative().max(100).optional(),
  taskProgressVersion: z.number().int().nonnegative().optional(),
  deliverySourceRefs: z
    .array(z.string().regex(/^[km]\d+$/))
    // Information delivery retains up to 16 pages; market delivery still permits at most six offers.
    .max(INFORMATION_LIMITS.sources)
    .refine((refs) => refs.filter((ref) => ref.startsWith('m')).length <= 6)
    .optional(),
  outboundInputFailures: z
    .object({
      tool: z.string(),
      count: z.number().int().min(1).max(100),
      feedback: z.array(z.string().max(1000)).max(3).optional(),
    })
    .optional(),
  taskSourceReviewedClaims: z.number().int().nonnegative().max(96).optional(),
  sourceReviewCache: z.record(z.string(), z.boolean()).optional(),
  outboundDeclineReason: z
    .enum(['unverified_claims', 'low_value', 'jev_unavailable', 'rate_limited'])
    .optional(),
  currentRequest: currentRequestSchema.optional(),
  answerInputExhausted: z.boolean().optional(),
  isAnswerFinalization: z.boolean().optional(),
  isRequestStatusRun: z.boolean().optional(),
  outboundBlocked: z.boolean().optional(),
  quietSupplementTaskId: z.string().optional(),
  quietSupplementEvidenceIds: z.array(z.string()).max(128).optional(),
  replySuppressed: z.boolean().optional(),
  knowledgeSources: z.array(knowledgeSourceSchema).max(INFORMATION_LIMITS.sources).optional(),
  informationQueries: z.array(z.string()).max(INFORMATION_LIMITS.queries).optional(),
  pageReads: z.array(z.string().max(2400)).max(INFORMATION_LIMITS.pageReads).optional(),
  pageLinks: z
    .array(z.object({ text: z.string().max(160), url: z.string().url().max(2048) }))
    .max(160)
    .optional(),
  sourceFailures: z.array(z.string()).optional(),
  researchOutcome: z.enum(['deliver', 'no_answer', 'skip']).optional(),
  researchNote: z.string().max(200).optional(),
  rateLimitPerDay: z.number().int().nonnegative().optional(),
  xhsNotes: z
    .array(
      z.object({
        ref: z.string(),
        title: z.string(),
        desc: z.string(),
        author: z.string(),
        likes: z.number().int().nonnegative(),
        url: z.url(),
        isDetailLoaded: z.boolean().optional(),
      }),
    )
    .max(XHS_RESEARCH_LIMITS.notes)
    .optional(),
  marketListings: z.array(marketCandidateSchema).max(MARKET_RESEARCH_LIMITS.listings).optional(),
  marketQueries: z.array(marketResearchQuerySchema).max(MARKET_RESEARCH_LIMITS.queries).optional(),
  marketDetailIds: z.array(z.string()).max(MARKET_RESEARCH_LIMITS.details).optional(),
  marketIntent: z.enum(MARKET_INTENTS).optional(),
  marketPlan: marketPlanSchema.optional(),
  marketTarget: z.enum(['SELL', 'BUY', 'PEER', 'ANY']).optional(),
  xhsQueries: z.array(xhsResearchQuerySchema).max(XHS_RESEARCH_LIMITS.queries).optional(),
  xhsDetailRefs: z.array(z.string()).max(XHS_RESEARCH_LIMITS.detailReads).optional(),
  xhsValidatedRecommendations: z.array(xhsRecommendationSchema).max(6).optional(),
  outboundPreviews: z.record(z.string(), z.string().max(4000)).optional(),
});
const snapshotSchema = z.object({
  context: z.object({ context: z.record(z.string(), z.unknown()) }),
});
function restoreRules(rules: z.infer<typeof marketRulesSchema>): MarketRules {
  return {
    preferences: rules.preferences,
    ...(rules.budget !== undefined ? { budget: rules.budget } : {}),
    ...(rules.budgetScope ? { budgetScope: rules.budgetScope } : {}),
    ...(rules.budgetUnit ? { budgetUnit: rules.budgetUnit } : {}),
    ...(rules.capacityKg !== undefined ? { capacityKg: rules.capacityKg } : {}),
    ...(rules.essentialPreferences ? { essentialPreferences: rules.essentialPreferences } : {}),
    ...(rules.requiredArea ? { requiredArea: rules.requiredArea } : {}),
    ...(rules.requiredTerms ? { requiredTerms: rules.requiredTerms } : {}),
    ...(rules.excludeTerms ? { excludeTerms: rules.excludeTerms } : {}),
    ...(rules.route ? { route: rules.route } : {}),
    ...(rules.dateRange ? { dateRange: rules.dateRange } : {}),
  };
}

/** 只读服务端解密快照。SDK 的 context override 只合并审批信息，不合并业务上下文（P14 实测）。 */
export function restoreSearchContext(ctx: MatchContext, snapshot: string): MatchContext {
  const raw = snapshotSchema.parse(JSON.parse(snapshot) as unknown).context.context;
  if (
    raw['xhsNotes'] === undefined &&
    raw['marketListings'] === undefined &&
    raw['knowledgeSources'] === undefined &&
    raw['pageReads'] === undefined &&
    raw['outboundInputFailures'] === undefined &&
    raw['outboundPreviews'] === undefined &&
    raw['currentRequest'] === undefined
  )
    return ctx;
  const saved = researchContextSchema.parse(raw);
  if (saved.userId !== ctx.userId || saved.chatId !== ctx.chatId || saved.phase !== ctx.phase) {
    throw new Error('Search snapshot context does not match the stored run');
  }
  return {
    ...ctx,
    ...(saved.demandId ? { demandId: saved.demandId } : {}),
    ...(saved.supplierSearchEmpty !== undefined
      ? { supplierSearchEmpty: saved.supplierSearchEmpty }
      : {}),
    ...(saved.taskProgressCalls !== undefined
      ? { taskProgressCalls: saved.taskProgressCalls }
      : {}),
    ...(saved.deliverySourceRefs ? { deliverySourceRefs: saved.deliverySourceRefs } : {}),
    ...(saved.taskProgressVersion !== undefined
      ? { taskProgressVersion: saved.taskProgressVersion }
      : {}),
    ...(saved.taskSourceReviewedClaims !== undefined
      ? { taskSourceReviewedClaims: saved.taskSourceReviewedClaims }
      : {}),
    ...(saved.sourceReviewCache ? { sourceReviewCache: saved.sourceReviewCache } : {}),
    ...(saved.outboundDeclineReason ? { outboundDeclineReason: saved.outboundDeclineReason } : {}),
    ...(saved.quietSupplementTaskId ? { quietSupplementTaskId: saved.quietSupplementTaskId } : {}),
    ...(saved.quietSupplementEvidenceIds
      ? { quietSupplementEvidenceIds: saved.quietSupplementEvidenceIds }
      : {}),
    ...(saved.replySuppressed !== undefined ? { replySuppressed: saved.replySuppressed } : {}),
    ...(saved.outboundBlocked !== undefined ? { outboundBlocked: saved.outboundBlocked } : {}),
    ...(saved.isRequestStatusRun !== undefined
      ? { isRequestStatusRun: saved.isRequestStatusRun }
      : {}),
    ...(saved.answerInputExhausted !== undefined
      ? { answerInputExhausted: saved.answerInputExhausted }
      : {}),
    ...(saved.outboundInputFailures
      ? {
          outboundInputFailures: {
            tool: saved.outboundInputFailures.tool,
            count: saved.outboundInputFailures.count,
            ...(saved.outboundInputFailures.feedback
              ? { feedback: saved.outboundInputFailures.feedback }
              : {}),
          },
        }
      : {}),
    ...(saved.isAnswerFinalization !== undefined
      ? { isAnswerFinalization: saved.isAnswerFinalization }
      : {}),
    ...(saved.currentRequest
      ? { currentRequest: saved.currentRequest, demand: saved.currentRequest.demand }
      : {}),
    ...(saved.knowledgeSources ? { knowledgeSources: saved.knowledgeSources } : {}),
    ...(saved.informationQueries ? { informationQueries: saved.informationQueries } : {}),
    ...(saved.pageReads ? { pageReads: saved.pageReads } : {}),
    ...(saved.pageLinks ? { pageLinks: saved.pageLinks } : {}),
    ...(saved.sourceFailures ? { sourceFailures: saved.sourceFailures } : {}),
    ...(saved.researchOutcome ? { researchOutcome: saved.researchOutcome } : {}),
    ...(saved.researchNote ? { researchNote: saved.researchNote } : {}),
    ...(saved.xhsNotes
      ? {
          xhsNotes: saved.xhsNotes.map(({ isDetailLoaded, ...note }) => ({
            ...note,
            ...(isDetailLoaded === undefined ? {} : { isDetailLoaded }),
          })),
        }
      : {}),
    ...(saved.marketListings ? { marketListings: saved.marketListings } : {}),
    ...(saved.marketQueries ? { marketQueries: saved.marketQueries } : {}),
    ...(saved.marketDetailIds ? { marketDetailIds: saved.marketDetailIds } : {}),
    ...(saved.marketIntent ? { marketIntent: saved.marketIntent } : {}),
    ...(saved.marketPlan
      ? {
          marketPlan: {
            intent: saved.marketPlan.intent,
            ...(saved.marketPlan.capacityKg !== undefined
              ? { capacityKg: saved.marketPlan.capacityKg }
              : {}),
            needs: saved.marketPlan.needs.map(({ budget, rules, ...need }) => ({
              ...need,
              ...(budget !== undefined ? { budget } : {}),
              ...(rules ? { rules: restoreRules(rules) } : {}),
            })),
            preferences: saved.marketPlan.preferences,
            ...(saved.marketPlan.essentialPreferences
              ? { essentialPreferences: saved.marketPlan.essentialPreferences }
              : {}),
            ...(saved.marketPlan.budget !== undefined ? { budget: saved.marketPlan.budget } : {}),
            ...(saved.marketPlan.budgetScope ? { budgetScope: saved.marketPlan.budgetScope } : {}),
            ...(saved.marketPlan.budgetUnit ? { budgetUnit: saved.marketPlan.budgetUnit } : {}),
            ...(saved.marketPlan.requiredArea
              ? { requiredArea: saved.marketPlan.requiredArea }
              : {}),
            ...(saved.marketPlan.requiredTerms
              ? { requiredTerms: saved.marketPlan.requiredTerms }
              : {}),
            ...(saved.marketPlan.excludeTerms
              ? { excludeTerms: saved.marketPlan.excludeTerms }
              : {}),
            ...(saved.marketPlan.route ? { route: saved.marketPlan.route } : {}),
            ...(saved.marketPlan.dateRange ? { dateRange: saved.marketPlan.dateRange } : {}),
          },
        }
      : {}),
    ...(saved.marketTarget ? { marketTarget: saved.marketTarget } : {}),
    ...(saved.xhsQueries ? { xhsQueries: saved.xhsQueries } : {}),
    ...(saved.xhsDetailRefs ? { xhsDetailRefs: saved.xhsDetailRefs } : {}),
    ...(saved.xhsValidatedRecommendations
      ? { xhsValidatedRecommendations: saved.xhsValidatedRecommendations }
      : {}),
    ...(saved.outboundPreviews ? { outboundPreviews: saved.outboundPreviews } : {}),
    sourceMessageId: saved.sourceMessageId,
    groupId: saved.groupId,
    ...(saved.source ? { source: saved.source } : {}),
    ...(saved.rateLimitPerDay !== undefined ? { rateLimitPerDay: saved.rateLimitPerDay } : {}),
    ...(!ctx.demand && saved.demand ? { demand: saved.demand } : {}),
  };
}

import { buildDeliveryPacket } from '../delivery-context.js';
import type { AgentInputItem, CallModelInputFilter, ModelInputData } from '@openai/agents';
import type { MatchContext } from '../context.js';
import { buildMarketChoices } from '../market-choices.js';
import { marketListingForModel } from '../market-research.js';

const MARKER = 'matchbot_runtime_context_v1';
export type PromptStage = 'planning' | 'execution' | 'finalization' | 'status';

export function isRuntimeContextItem(item: AgentInputItem): boolean {
  return item.type === 'message' && item.role === 'user' && item.id === MARKER;
}

function owns(ctx: MatchContext, task: NonNullable<MatchContext['task']>): boolean {
  return (
    task.ownerUserId === ctx.userId &&
    task.scope.chatId === ctx.chatId &&
    task.scope.channel === (ctx.channel ?? 'telegram')
  );
}

/** Preserve source identity and expose omissions; never silently truncate task conditions. */
function publicEvidence(
  available: Array<
    Pick<NonNullable<MatchContext['knowledgeSources']>[number], 'ref' | 'title' | 'passages'>
  >,
) {
  const sources = available.slice(0, 16);
  let remaining = 24000;
  const selected = sources.map((source) => ({
    ref: source.ref,
    title: source.title,
    passages: [] as typeof source.passages,
    omittedPassageIds: [] as string[],
  }));
  // Breadth first keeps later sources visible instead of spending everything on the first page.
  for (let index = 0; index < 12; index++)
    sources.forEach((source, sourceIndex) => {
      const passage = source.passages[index];
      if (!passage) return;
      if (passage.text.length <= remaining) {
        selected[sourceIndex]!.passages.push(passage);
        remaining -= passage.text.length;
      } else selected[sourceIndex]!.omittedPassageIds.push(passage.id);
    });
  return selected;
}

export class PromptContextBudgetError extends Error {
  constructor() {
    super('runtime context exceeds character budget');
    this.name = 'PromptContextBudgetError';
  }
}

/** Envelope structure is trusted, text inside it is not. Never include other owners/scopes. */
export function runtimeContext(ctx: MatchContext, stage: PromptStage): Record<string, unknown> {
  if (ctx.task && !owns(ctx, ctx.task)) throw new Error('prompt task scope mismatch');
  const candidates = (ctx.taskCandidates ?? []).filter((t) => owns(ctx, t));
  const taskView = (t: NonNullable<MatchContext['task']>) => ({
    ref: t.id,
    objective: t.objective,
    category: t.category,
    status: t.status,
    goals: t.goals,
    constraints: t.constraints.map(({ origin: _origin, ...c }) => c),
    nextStep: t.nextStep,
    deliveredQuestion: t.pendingQuestion?.deliveryStatus === 'sent' ? t.pendingQuestion : null,
  });
  const common = {
    kind: 'matchbot_runtime_context',
    version: 1,
    stage,
    currentRequest: ctx.currentRequest ?? { demand: ctx.demand },
    taskUpdate: ctx.taskUpdate?.kind ?? null,
    verifiedReplyAnchor: candidates.some((t) => t.id === ctx.taskAnchorId)
      ? ctx.taskAnchorId
      : null,
  };
  if (stage === 'planning') return { ...common, scopedTasks: candidates.map(taskView) };
  const delivery = stage === 'finalization' ? buildDeliveryPacket(ctx) : null;
  const choices = ctx.marketPlan
    ? buildMarketChoices({
        candidates: ctx.marketListings ?? [],
        plan: ctx.marketPlan,
        ...(ctx.taskProgressVersion === ctx.task?.requirementsVersion && ctx.task
          ? { task: ctx.task }
          : {}),
      })
    : null;
  return {
    ...common,
    quotedPublicReply: ctx.replyToBotText?.slice(0, 800) ?? null,
    recentReplies: ctx.recentReplies.slice(-5),
    ...(stage === 'finalization'
      ? {
          deliveryContract: {
            referenceFamilies: ['k', 'm'],
            unresearchedConditions: delivery?.unresearchedConditions ?? [],
            requiresTaskClarification: ['ambiguous', 'unbound'].includes(
              ctx.taskUpdate?.kind ?? '',
            ),
            otherSourceCounts: {
              xhs: ctx.xhsNotes?.length ?? 0,
              legacyWeb: ctx.searchResults?.length ?? 0,
            },
          },
        }
      : {}),
    selectedTask: delivery ? delivery.task : ctx.task ? taskView(ctx.task) : null,
    ambiguousTopics: ['ambiguous', 'unbound'].includes(ctx.taskUpdate?.kind ?? '')
      ? candidates.slice(0, 8).map((t) => ({ ref: t.id, objective: t.objective }))
      : [],
    validationFeedback: ctx.outboundInputFailures ?? null,
    receipts: {
      marketQueries: ctx.marketQueries?.length ?? 0,
      refreshedMarketDetails: ctx.marketDetailIds?.length ?? 0,
      marketSourceCount: ctx.marketListings?.length ?? 0,
      informationSourceCount: ctx.knowledgeSources?.length ?? 0,
      informationQueries: ctx.informationQueries?.length ?? 0,
      xhsQueries: ctx.xhsQueries?.length ?? 0,
      failures: ctx.sourceFailures ?? [],
      evidenceValidationExhausted: !!ctx.answerInputExhausted,
      outboundBlocked: !!ctx.outboundBlocked,
    },
    historicalEvidenceHints:
      ctx.task?.evidence.slice(-12).map((e) => ({
        goalId: e.goalId,
        source: e.sourceRef,
        summary: e.summary.slice(0, 300),
        observedAt: e.observedAt,
      })) ?? [],
    currentPublicEvidence: publicEvidence(
      delivery ? delivery.knowledge : (ctx.knowledgeSources ?? []),
    ),
    currentMarketEvidence: delivery
      ? delivery.market
      : choices
        ? [...choices.primary, ...choices.backup].map((row) => ({
            ...marketListingForModel(
              row.listing,
              600,
              ctx.marketPlan!.needs.flatMap((n) => n.terms),
            ),
            checks: row.assessment.checks,
            missing: row.essentialMissing,
          }))
        : [],
  };
}

/** SDK filter adds a fresh low-priority data packet before each call, without rewriting original input. */
export function contextInputFilter(stage: PromptStage): CallModelInputFilter {
  return ({ modelData, context }): ModelInputData => {
    if (!context || stage === 'status') return modelData;
    const data = JSON.stringify(runtimeContext(context as MatchContext, stage));
    if (data.length > 64000) throw new PromptContextBudgetError();
    const packet: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: data,
        },
      ],
      id: MARKER,
    };
    return {
      ...modelData,
      input: [packet, ...modelData.input.filter((i) => !isRuntimeContextItem(i))],
    };
  };
}

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

/**
 * The packet is rebuilt for every model turn, so its evidence budget is the main per-turn input
 * cost. Execution turns get a working view; the one-shot finalization gets the full budget.
 */
// Finalization evidence 24000 -> 16000 chars: the delivery draft is the slowest turn of a run, and
// 12 sources x 12 passages mostly repeat the same opening hours (2026-10-21 run 5).
export const EVIDENCE_CHARS = { execution: 8000, finalization: 16000 } as const;
/** Execution turns see every source through a shortened passage; finalization reads them whole. */
export const EXECUTION_PASSAGE_CHARS = 350;

/** Preserve source identity and expose omissions; never silently truncate task conditions. */
function publicEvidence(
  available: Array<
    Pick<NonNullable<MatchContext['knowledgeSources']>[number], 'ref' | 'title' | 'passages'>
  >,
  budget: number,
  passageChars = Number.POSITIVE_INFINITY,
) {
  const sources = available.slice(0, 16).map((source) => ({
    ...source,
    passages: source.passages.map((passage) =>
      passage.text.length > passageChars
        ? { ...passage, text: passage.text.slice(0, passageChars) + '…' }
        : passage,
    ),
  }));
  let remaining = budget;
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
  constructor(message = 'runtime context exceeds character budget') {
    super(message);
    this.name = 'PromptContextBudgetError';
  }
}

/**
 * Whole model input (history, tool results and the packet) allowed for one execution turn, about
 * 40k tokens. Beyond it the run stops researching and finalizes from what it has; the 2026-10-20
 * replay reached 33k tokens per turn and 147k per message in the marketplace scene.
 */
export const EXECUTION_INPUT_CHARS = 80000;
/**
 * Cumulative model input over all execution turns of one message, about 50k tokens. The per-turn
 * cap alone let a 12-call marketplace run reach 184k tokens (2026-10-20 run 3); research stops here
 * and the message is finalized from the evidence already collected.
 */
export const EXECUTION_RUN_INPUT_CHARS = 100000;
const executionInputUsed = new WeakMap<object, number>();

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
    // Other members' recent public messages (aliases, oldest first). Data, not instructions.
    groupConversation: ctx.groupTranscript ?? [],
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
    // What has actually been tried, in task terms. Internal gate state (blocked, exhausted) is
    // enforced by code and is not something the model can act on, so it stays out of the packet.
    research: {
      marketSearches: ctx.marketQueries?.length ?? 0,
      marketListingsFound: ctx.marketListings?.length ?? 0,
      marketDetailsRead: ctx.marketDetailIds?.length ?? 0,
      informationSearches: ctx.informationQueries?.length ?? 0,
      informationSourcesFound: ctx.knowledgeSources?.length ?? 0,
      pagesRead: ctx.pageReads?.length ?? 0,
      xhsSearches: ctx.xhsQueries?.length ?? 0,
      sourceFailures: ctx.sourceFailures ?? [],
    },
    historicalEvidenceHints:
      ctx.task?.evidence.slice(stage === 'finalization' ? -12 : -6).map((e) => ({
        goalId: e.goalId,
        source: e.sourceRef,
        summary: e.summary.slice(0, stage === 'finalization' ? 300 : 160),
        observedAt: e.observedAt,
      })) ?? [],
    currentPublicEvidence: publicEvidence(
      delivery ? delivery.knowledge : (ctx.knowledgeSources ?? []),
      stage === 'finalization' ? EVIDENCE_CHARS.finalization : EVIDENCE_CHARS.execution,
      stage === 'finalization' ? Number.POSITIVE_INFINITY : EXECUTION_PASSAGE_CHARS,
    ),
    currentMarketEvidence: delivery
      ? delivery.market
      : choices
        ? [...choices.primary, ...choices.backup].map((row) => ({
            ...marketListingForModel(
              row.listing,
              300,
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
    if (stage === 'execution') {
      const turnChars = data.length + JSON.stringify(modelData.input).length;
      if (turnChars > EXECUTION_INPUT_CHARS)
        throw new PromptContextBudgetError('execution input exceeds the per-turn budget');
      const used = (executionInputUsed.get(context) ?? 0) + turnChars;
      executionInputUsed.set(context, used);
      if (used > EXECUTION_RUN_INPUT_CHARS)
        throw new PromptContextBudgetError('execution input exceeds the per-message budget');
    }
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

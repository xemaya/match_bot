import { tool, type RunContext } from '@openai/agents';
import type { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { TaskTransitionError } from '@matchbot/domain';
import { taskDeliveryForOutbound } from '../task-outbound.js';
import { hasUnsupportedModelAction } from '../reply-boundaries.js';
import {
  decideForOutbound,
  executeOutbound,
  formatOutboundText,
  type OutboundDraftInput,
} from './outbound-gate.js';
import { OUTBOUND } from '../prompts/tools/outbound.js';

/** First-person offers to take part or help physically, which an assistant account cannot keep. */
const PRESENCE =
  /我也(?:想)?(?:去|来|凑|参加|一起)|算我一个|带上我|我(?:可以|能)(?:陪|帮你?(?:搬|拿|带|接|喂|看))|我(?:来|去)(?:接|帮)你|到时候我(?:也)?(?:去|来)/;
export function claimsPersonalPresence(text: string): boolean {
  return PRESENCE.test(text);
}
export type DraftResult =
  OutboundDraftInput | { error: string; kind?: 'research_required' | 'no_new_help' };

/**
 * 四个出站工具共用的骨架：needsApproval 与 execute 都只经 outbound-gate 决定（AGENTS.md §3.3
 * 第 3、4 条），工具自身不判断 phase。toDraft 返回 error 时不中断、不写库，错误文案还给模型。
 * parameters 用具体 ZodObject 类型（SDK 的 ToolOptions 对泛型 schema 不可判定），args 经 toDraft 收窄。
 */
export function makeOutboundTool<A>(
  deps: AgentDeps,
  cfg: {
    name: string;
    isRequestStatus?: boolean;
    description: string;
    parameters: z.ZodObject<z.ZodRawShape>;
    toDraft: (ctx: MatchContext, args: A) => Promise<DraftResult>;
  },
) {
  const recordQuietEnd = async (ctx: MatchContext): Promise<boolean> => {
    if (!ctx.replySuppressed) return false;
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: ctx.sourceMessageId,
      phase: ctx.phase,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'outbound',
        decision: 'suppressed',
        reason: 'context_supplement_already_finished',
      },
    });
    return true;
  };
  const toArgs = (raw: unknown): A => cfg.parameters.parse(raw) as A;
  const toDraft = async (ctx: MatchContext, args: A): Promise<DraftResult> => {
    if (hasUnsupportedModelAction(args)) return { error: OUTBOUND.feedback.unsupportedAction };
    try {
      const draft = await cfg.toDraft(ctx, args);
      if ('error' in draft) return draft;
      // 2026-10-23 replay: A2H ended a route answer with "有人一起去的话我也想凑一脚". Sounding like
      // a member must never mean pretending to be one who can show up.
      if (draft.kind !== 'reaction' && claimsPersonalPresence(draft.text))
        return { error: OUTBOUND.feedback.claimsPresence };
      taskDeliveryForOutbound(ctx, draft);
      return draft;
    } catch (error) {
      if (error instanceof TaskTransitionError) return { error: error.message };
      throw error;
    }
  };
  // SDK 在敏感信息关闭时会清掉 InvalidToolInputError 的原始参数/原因；先保存字段路径与限值。
  // 不保存参数值，不写日志/快照。每个工具独立，批量无效调用的错误一并供模型修正。
  const retryLimitMessage = OUTBOUND.feedback.retryLimit;
  // 同一个 SDK call 在 needsApproval 和 execute 都经过校验，只算一次失败。
  const rejectedCalls = new WeakMap<MatchContext, Map<string, string>>();
  const schemaFeedback = new WeakMap<MatchContext, Set<string>>();
  return tool({
    name: cfg.name,
    description: cfg.description,
    parameters: cfg.parameters,
    errorFunction: (rc, error) => {
      if ((rc.context as MatchContext).outboundBlocked) return retryLimitMessage;
      if (error instanceof Error && error.name === 'InvalidToolInputError') {
        const feedback = schemaFeedback.get(rc.context as MatchContext);
        return OUTBOUND.feedback.invalidInput(feedback ? [...feedback].join('; ') : undefined);
      }
      return OUTBOUND.feedback.internalError;
    },
    needsApproval: async (rc, args, callId) => {
      const ctx = rc.context as MatchContext;
      if (await recordQuietEnd(ctx)) return false;
      if (
        (!cfg.isRequestStatus && ctx.outboundBlocked) ||
        (!cfg.isRequestStatus && ctx.answerInputExhausted && !ctx.isAnswerFinalization)
      )
        return false;
      // needsApproval 在 SDK 的工具入参校验前调用；格式错误只交给该校验返回，不让整轮崩掉。
      const parsed = cfg.parameters.safeParse(args);
      if (!parsed.success) {
        const feedback = schemaFeedback.get(ctx) ?? new Set<string>();
        parsed.error.issues.forEach((issue) =>
          feedback.add(`${issue.path.join('.')}: ${issue.message}`),
        );
        schemaFeedback.set(ctx, feedback);
        // 只记字段路径与错误码，不记参数值（PII）：没有这条，模型反复改不对时线上无从排查
        await recordInvalidDraft(ctx, 'invalid_schema', [
          ...new Set(parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}:${i.code}`)),
        ]);
        return false;
      }
      const d = await toDraft(ctx, toArgs(args));
      if ('error' in d) {
        if (d.kind === 'no_new_help') return false;
        await recordDraftFeedback(ctx, d);
        if (callId) {
          const calls = rejectedCalls.get(ctx) ?? new Map<string, string>();
          calls.set(callId, d.error);
          rejectedCalls.set(ctx, calls);
        }
        return false;
      }
      delete ctx.outboundInputFailures;
      schemaFeedback.delete(ctx);
      const decision = await decideForOutbound(deps, ctx, {
        ...d,
        ...(callId ? { toolCallId: callId } : {}),
      });
      if (decision === 'review' && callId) {
        ctx.outboundPreviews ??= {};
        ctx.outboundPreviews[callId] = formatOutboundText(ctx, d);
      }
      return decision === 'review';
    },
    execute: async (args, rc, details) => {
      if (!rc) return OUTBOUND.feedback.missingContext;
      const ctx = (rc as RunContext<MatchContext>).context;
      if (await recordQuietEnd(ctx)) return OUTBOUND.feedback.supplementEnded;
      if (!cfg.isRequestStatus && ctx.answerInputExhausted && !ctx.isAnswerFinalization)
        return retryLimitMessage;
      if (!cfg.isRequestStatus && ctx.outboundBlocked) {
        return ctx.outboundInputFailures?.count === 3
          ? retryLimitMessage
          : OUTBOUND.feedback.alreadyDeclined;
      }
      const callId = details?.toolCall?.callId;
      const rejection = callId ? rejectedCalls.get(ctx)?.get(callId) : undefined;
      if (rejection) return rejection;
      const d = await toDraft(ctx, toArgs(args));
      if ('error' in d) {
        if (d.kind === 'no_new_help') return d.error;
        await recordDraftFeedback(ctx, d);
        return ctx.outboundBlocked ? retryLimitMessage : d.error;
      }
      delete ctx.outboundInputFailures;
      schemaFeedback.delete(ctx);
      const preview = callId ? ctx.outboundPreviews?.[callId] : undefined;
      const draft: OutboundDraftInput = {
        ...(preview ? { ...d, text: preview } : d),
        ...(details?.toolCall?.callId ? { toolCallId: details.toolCall.callId } : {}),
      };
      const result = await executeOutbound(
        deps,
        ctx,
        draft,
        await decideForOutbound(deps, ctx, draft),
      );
      return d.resultNote ? `${result}; ${d.resultNote}` : result;
    },
  });

  async function recordDraftFeedback(
    ctx: MatchContext,
    draft: { error: string; kind?: 'research_required' | 'no_new_help' },
  ) {
    if (draft.kind !== 'research_required') {
      await recordInvalidDraft(ctx, 'invalid_evidence', [draft.error]);
      return;
    }
    // P20: 补搜是正常编排，不能耗掉用于纠正无效证据的三次机会。
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: ctx.sourceMessageId,
      output: {
        gate: 'outbound_research',
        tool: cfg.name,
        decision: 'continue',
        reason: 'research_required',
        feedback: draft.error.slice(0, 240),
      },
      phase: ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
  }

  /** detail 只放字段路径 / 错误码 / 给模型的纠错文案，绝不放原始参数值（PII）。 */
  async function recordInvalidDraft(ctx: MatchContext, reason: string, detail?: string[]) {
    const previous = ctx.outboundInputFailures;
    const count = previous?.tool === cfg.name ? previous.count + 1 : 1;
    ctx.outboundInputFailures = {
      tool: cfg.name,
      count,
      feedback: (detail ?? [reason]).slice(0, 3).map((item) => item.slice(0, 1000)),
    };
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: ctx.sourceMessageId,
      output: {
        gate: 'outbound_input',
        tool: cfg.name,
        decision: 'deny',
        reason,
        attempt: count,
        ...(detail ? { detail } : {}),
      },
      phase: ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
    if (count >= 3) {
      if (deps.answerRequests) ctx.answerInputExhausted = true;
      else ctx.outboundBlocked = true;
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        output: {
          gate: 'outbound_retry',
          tool: cfg.name,
          decision: 'deny',
          reason: 'input_retry_limit',
          attempts: count,
        },
        phase: ctx.phase,
        latencyMs: 0,
        costMicro: 0,
      });
    }
  }
}

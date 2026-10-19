import { createRateLimiter, decideOutbound, type OutboundDecision } from '@matchbot/gating';
import type { DemandDraft, OutboundKind } from '@matchbot/domain';
import { renderRequestStatus } from '../request-status.js';
import { hashText } from '@matchbot/shared';
import type { RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../context.js';
import { taskDeliveryForOutbound } from '../task-outbound.js';

export interface OutboundDraftInput {
  /** 用途；决定是否计入频控。每个出站工具必须显式给出。 */
  kind: OutboundKind;
  replyPurpose?: 'answer' | 'request_status';
  /** P20: 本轮来源核对的搜索需求，不复用建档失败时残留的上一条需求。 */
  evaluationDemand?: DemandDraft;
  target: string;
  text: string;
  supplierSummaries: string[];
  inputRef: string;
  toolCallId?: string;
  /** 附加在工具返回值末尾的说明（如 push_lead 的人工转达提示）。 */
  resultNote?: string;
  /** 群内回帖：回复哪条原消息、@ 谁（均为渠道侧 id）。 */
  replyToMessageId?: string;
  mentionUserId?: string;
  /** Original short question/advice before generated evidence cards and source links. */
  taskQuestionText?: string;
}

/**
 * needsApproval 与 execute 在一次 run 里都会要出站决定；按（ctx, target+text）缓存，
 * 避免 Phase 2 下同一草稿调两次 Jev。
 */
const decisionCache = new WeakMap<MatchContext, Map<string, OutboundDecision>>();

/**
 * 三个门里的出站门（架构 §3）：阶段 → Jev 出站分 → 频控。
 * Phase 0/1 不调 Jev（省钱）；Phase 2 且 Jev 不可用时按 §3.3 第 5 条送审。
 * 每一次决定都写 decision_traces（kind = gate）。
 */
export async function decideForOutbound(
  deps: AgentDeps,
  ctx: MatchContext,
  d: OutboundDraftInput,
): Promise<OutboundDecision> {
  const isVerifiedRequestStatus =
    d.replyPurpose === 'request_status' &&
    d.kind === 'notification' &&
    d.target === ctx.chatId &&
    d.inputRef === ctx.sourceMessageId &&
    d.supplierSummaries.length === 0 &&
    d.text === renderRequestStatus(ctx);
  if (d.replyPurpose === 'request_status' && !isVerifiedRequestStatus) {
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: ctx.sourceMessageId,
      phase: ctx.phase,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'request_status_validation',
        decision: 'deny',
        reason: 'invalid_fixed_status',
      },
    });
    return 'drop';
  }
  const targeted = deps.env.JEV_POLICY === 'targeted';
  const direct = targeted && (ctx.addressedToBot === true || ctx.source?.userId === ctx.chatId);
  // Only exact server-authored status is exempt, never arbitrary text labelled as a status.
  if (targeted && isVerifiedRequestStatus && ctx.phase === 2) {
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: d.inputRef,
      phase: ctx.phase,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'outbound',
        decision: 'auto',
        policy: 'targeted',
        reason: 'verified_fixed_status',
        isVerifiedRequestStatus: true,
      },
    });
    return 'auto';
  }
  const key = hashText(
    JSON.stringify([
      ctx.phase,
      targeted,
      direct,
      d.kind,
      d.target,
      d.text,
      d.replyPurpose ?? 'answer',
    ]),
  );
  const cached = decisionCache.get(ctx)?.get(key);
  if (cached) return cached;

  let verdict = null;
  let rateOk = true;
  // 表情反应不带内容、不能写错话，也不打扰人：Phase 0 照旧只记录，Phase 1 起直接发，
  // 不送审、不调 Jev（AGENTS.md §3.3 第 3 条的明确例外）。
  if (d.kind === 'reaction') {
    const decision: OutboundDecision = ctx.phase === 0 ? 'dry_run' : 'auto';
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: d.inputRef,
      output: { gate: 'outbound', kind: 'reaction', decision },
      phase: ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
    return decision;
  }
  if (ctx.phase === 2) {
    const demand = ctx.currentRequest?.demand ?? d.evaluationDemand ?? ctx.demand;
    const v = demand
      ? await deps.evaluateOutbound(deps.jev, {
          draft: d.text,
          demand,
          ...(ctx.task && ctx.currentRequest ? { requestContext: ctx.currentRequest.text } : {}),
          supplierSummaries: d.supplierSummaries,
          recentReplies: ctx.recentReplies,
          inputRef: d.inputRef,
          phase: ctx.phase,
          ...(d.replyPurpose ? { replyPurpose: d.replyPurpose } : {}),
        })
      : null;
    verdict = v && v.ok ? v : null;
    // 只有推荐受频控，且只在群设了额度时才限（2026-09-25 起默认不限；PRD §6.2 原为一天 3 次）。
    // 追问、通知、线索、表情不占额度。
    const limit = ctx.rateLimitPerDay;
    rateOk =
      d.kind !== 'recommendation' ||
      limit === undefined ||
      (await createRateLimiter(deps.repos.outbound).check({
        target: d.target,
        limitPerDay: limit,
        now: new Date(),
      }));
  }
  const decision = decideOutbound({
    phase: ctx.phase,
    verdict,
    rateOk,
    t: deps.thresholds,
    onUnsure: deps.env.OUTBOUND_UNSURE_ACTION,
    isVerifiedRequestStatus,
    isDirectRequest: direct,
  });
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: d.inputRef,
    output: {
      gate: 'outbound',
      decision,
      verdict,
      rateOk,
      isVerifiedRequestStatus,
      ...(d.replyPurpose ? { replyPurpose: d.replyPurpose } : {}),
    },
    phase: ctx.phase,
    latencyMs: 0,
    costMicro: 0,
  });

  if (decision === 'drop' && !isVerifiedRequestStatus)
    ctx.outboundDeclineReason = !verdict
      ? 'jev_unavailable'
      : verdict.mentionsUnverified >= deps.thresholds.T_MENTIONS_UNVERIFIED_DROP
        ? 'unverified_claims'
        : !direct && verdict.worthReplying < deps.thresholds.T_WORTH_REPLYING_DROP
          ? 'low_value'
          : 'rate_limited';
  let byKey = decisionCache.get(ctx);
  if (!byKey) {
    byKey = new Map();
    decisionCache.set(ctx, byKey);
  }
  byKey.set(key, decision);
  return decision;
}

/** 出站只写 outbound_messages 表（AGENTS.md §3.3 第 3 条）；发送由 apps/bot 消费。 */
export function formatOutboundText(_ctx: MatchContext, d: OutboundDraftInput): string {
  // The reviewed draft already carries source links and decision-relevant unknowns.
  // A generic footer repeats caveats and can contradict facts checked during research.
  return d.text;
}

export async function executeOutbound(
  deps: AgentDeps,
  ctx: MatchContext,
  d: OutboundDraftInput,
  decision: OutboundDecision,
): Promise<string> {
  if (decision === 'drop') {
    ctx.outboundBlocked = true;
    return 'not sent: the outbound gate decided this should not be posted. Do not rewrite or retry; stop here.';
  }
  const status = decision === 'dry_run' ? 'dry_run' : 'pending';
  const row = await deps.repos.outbound.create(
    {
      channel: 'telegram',
      phase: ctx.phase,
      ...(ctx.execution ? { execution: ctx.execution } : {}),
      ...(taskDeliveryForOutbound(ctx, d)
        ? { taskDelivery: taskDeliveryForOutbound(ctx, d)! }
        : {}),
      kind: d.kind,
      target: d.target,
      text: formatOutboundText(ctx, d),
      ...(d.toolCallId ? { toolCallId: d.toolCallId } : {}),
      ...(d.replyToMessageId ? { replyToMessageId: d.replyToMessageId } : {}),
      ...(d.mentionUserId ? { mentionUserId: d.mentionUserId } : {}),
    },
    status,
  );
  ctx.answerRecorded = true;
  deps.logger.info({ outboundId: row.id, decision, phase: ctx.phase }, 'outbound message recorded');
  return row.status === 'dry_run'
    ? `dry-run recorded (${row.id}); nothing was sent`
    : row.status === 'pending' || row.status === 'sending'
      ? `queued (${row.id})`
      : row.status === 'sent'
        ? `not sent: this request already has a confirmed reply (${row.id})`
        : `not sent: this request already has a failed or unconfirmed delivery (${row.id}); do not automatically resend`;
}

/** needsApproval：只有 'review' 才中断；auto / dry_run / drop 都不中断，由 execute 按 decision 处理。 */
export function outboundNeedsApproval(deps: AgentDeps) {
  return async (rc: RunContext<MatchContext>, d: OutboundDraftInput): Promise<boolean> =>
    (await decideForOutbound(deps, rc.context, d)) === 'review';
}

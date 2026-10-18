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
  /**
   * 附哪种免责。推荐库内商家用 catalogue，推荐 web search 结果用 web（明说未核实）；
   * 追问与线索不附。
   */
  disclaimer?:
    'catalogue' | 'web' | 'xhs' | 'market'; /** 群内回帖：回复哪条原消息、@ 谁（均为渠道侧 id）。 */
  replyToMessageId?: string;
  mentionUserId?: string;
  /** Original short question/advice before generated evidence cards and source links. */
  taskQuestionText?: string;
}

/**
 * PRD F7 / §6.3：推荐商家的群内回复末尾固定一句免责，中文取 PRD 原文。
 * 此前是所有出站都附一句英文，连「请问您什么时候搬？」这种追问后面也挂着
 * 「直接联系他们报价」——没有「他们」，而且中文对话后面跟英文。
 */
// 免责保留 PRD F7 的意思（直接找商家确认、我们不经手交易），但用群友的口吻、第一人称单数说：
// 原来那句「请直接联系商家确认报价与档期，我们不参与交易。」像公司公告，一看就是广告号。
const DISCLAIMERS: Record<'catalogue' | 'web' | 'xhs' | 'market', Record<string, string>> = {
  catalogue: {
    zh: '价格和档期直接找商家确认就好，我只是帮忙牵个线，不经手交易。',
    en: "Check price and availability with them directly — I just point the way and I'm not part of the transaction.",
    ru: 'Цену и время уточняйте у них напрямую — я только подсказываю и в сделке не участвую.',
    uk: 'Ціну й час уточнюйте в них напряму — я лише підказую й в угоді не беру участі.',
    pt: 'Confirme preço e horário direto com eles — eu só indico, não faço parte da transação.',
  },
  // P14：搜索结果没有人工把关，必须说清楚没核实过
  web: {
    zh: '这些是公开网页信息，实际价格和可用情况以提供方回复为准。',
    en: "Found these online and haven't checked them myself, so maybe message them first.",
    ru: 'Нашёл это в интернете и сам не проверял — лучше сначала напишите им.',
    uk: 'Знайшов це в інтернеті й сам не перевіряв — краще спершу напишіть їм.',
    pt: 'Achei isso na internet e não conferi — vale mandar mensagem antes.',
  },
  market: {
    zh: '信息来自A2H公开帖子，是否还在以贴主回复为准；转载帖的联系入口在原帖。我不经手交易。',
    en: 'From public A2H listings; actual availability depends on the poster. Reposts link to their original contact entry. I do not handle transactions.',
    ru: 'Публичные объявления A2H. Наличие, даты и цены уточняйте у автора; для репостов используйте оригинал. Я не участвую в сделке.',
    uk: 'Публічні оголошення A2H. Наявність, дати й ціни уточнюйте в автора; для репостів відкрийте оригінал. Я не проводжу угоди.',
    pt: 'Anúncios públicos do A2H. Confirme disponibilidade, datas e preços com o autor; para reposts, use o original. Não intermedio a transação.',
  },
  xhs: {
    zh: '以上来自小红书笔记，我未独立核实；时间、价格和开放情况请以官方最新信息为准。',
    en: 'Based on Xiaohongshu notes, not independently verified. Check official sources for current dates, prices and availability.',
    ru: 'По заметкам Xiaohongshu, без независимой проверки. Актуальные даты, цены и доступность уточняйте у организаторов.',
    uk: 'За дописами Xiaohongshu, без незалежної перевірки. Актуальні дати, ціни та доступність уточнюйте в організаторів.',
    pt: 'Com base em notas do Xiaohongshu, sem verificação independente. Confira datas, preços e disponibilidade nos canais oficiais.',
  },
};

/**
 * 语言优先用需求上记录的 lang；没有就只凭汉字判中文。西里尔字母不猜俄/乌——
 * 给乌克兰用户回俄语比回英语糟得多，猜不准就落到英语。
 */
export function disclaimerFor(
  lang: string | undefined,
  text: string,
  kind: 'catalogue' | 'web' | 'xhs' | 'market' = 'catalogue',
): string {
  const set = DISCLAIMERS[kind];
  const key = lang && set[lang] ? lang : /\p{Script=Han}/u.test(text) ? 'zh' : 'en';
  return set[key]!;
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
    !d.disclaimer &&
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
export function formatOutboundText(ctx: MatchContext, d: OutboundDraftInput): string {
  return d.disclaimer
    ? `${d.text}
\n${disclaimerFor(ctx.demand?.lang, d.text, d.disclaimer)}`
    : d.text;
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
      channel: ctx.channel ?? 'telegram',
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

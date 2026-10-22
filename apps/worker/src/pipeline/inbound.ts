import {
  loadGroupTranscript,
  triageInbound as triageInboundFn,
  type AgentDeps,
  type MatchContext,
  type runInbound as runInboundFn,
  type TriageVerdict,
} from '@matchbot/agent';
import type { publishApproval as publishApprovalFn } from '@matchbot/approval';
import type { Demand } from '@matchbot/db';
import { splitEvidenceCard } from '@matchbot/domain';
import type { DemandDraft, InboundMessage, Phase } from '@matchbot/domain';
import { decideInbound, inboundRuleReason, resolvePhase } from '@matchbot/gating';
import type { evaluateInbound as evaluateInboundFn } from '@matchbot/jev';

export interface PipelineDeps extends AgentDeps {
  evaluateInbound: typeof evaluateInboundFn;
  runInbound: typeof runInboundFn;
  /** JEV_POLICY=off inbound gate; injectable for tests. */
  triageInbound?: typeof triageInboundFn;
  publishApproval: typeof publishApprovalFn;
  cards: Parameters<typeof publishApprovalFn>[0]['cards'];
}

/** Jev 看的最近上下文条数上限（架构 §3：同一作者最近消息作为弱上下文）。 */
const RECENT_TEXTS = 5;
const RECENT_WINDOW_HOURS = 24;
/** A follow-up not addressed to A2H within this long after its last reply to the member waits. */
const FOLLOWUP_COOLDOWN_MS = 5 * 60_000;
/** How far back A2H's own replies to the member are shown to the agent. */
const RECENT_REPLY_DAYS = 30;

function toPhase(raw: number): Phase {
  return raw === 1 || raw === 2 ? raw : 0;
}

function toDemandDraft(d: Demand): DemandDraft {
  return {
    category: d.category,
    confidence: d.confidence,
    ...(d.need ? { need: d.need } : {}),
    ...(d.whenText ? { whenText: d.whenText } : {}),
    ...(d.whenAt ? { whenAt: d.whenAt.toISOString() } : {}),
    ...(d.fromPostcode ? { fromPostcode: d.fromPostcode } : {}),
    ...(d.toPostcode ? { toPostcode: d.toPostcode } : {}),
    ...(d.quantity ? { quantity: d.quantity } : {}),
    ...(d.budgetPence !== null ? { budgetPence: d.budgetPence } : {}),
    ...(d.lang ? { lang: d.lang } : {}),
  };
}

/**
 * 架构 §3 流程图的直译：代码门 → Jev 入站门 → agent。
 * 每个终点写一条 decision_traces（AGENTS.md §3.3 第 2 条）：dropped_by_rule / dropped_by_jev /
 * tagged_move_event / entered_agent / agent_interrupted / agent_completed。
 * strict 策略及群内主动插话在 Jev 不可用时不进 agent；targeted 直接请求由任务规划接管。
 */
export async function processInbound(
  d: PipelineDeps,
  msg: InboundMessage,
): Promise<void | { deferMs: number }> {
  const t0 = Date.now();
  const isPrivate = msg.chatId === msg.userId;
  const group = isPrivate ? null : await d.repos.groups.findByExternal(msg.channel, msg.chatId);
  let phase = resolvePhase({ group, defaultPhase: toPhase(d.env.DEFAULT_PHASE) });
  const trace = (kind: 'rule' | 'gate', inputRef: string, output: Record<string, unknown>) =>
    d.repos.traces.create({
      kind,
      inputRef,
      output,
      phase,
      latencyMs: Date.now() - t0,
      costMicro: 0,
    });

  // 代码门先于落库：被规则挡下的消息不写 messages，避免留存无用文本（AGENTS.md §6）。
  const blocked = inboundRuleReason({
    text: msg.text,
    isPrivate,
    hasGroup: !!group,
    isGroupActive: group?.isActive ?? false,
  });
  if (blocked) {
    await d.repos.executions.rejectAdmission({ message: msg, errorCode: blocked });
    await trace('rule', `${msg.channel}:${msg.chatId}:${msg.messageId}`, {
      outcome: 'dropped_by_rule',
      reason: blocked,
    });
    return;
  }

  const user = await d.repos.users.upsertByExternal({
    channel: msg.channel,
    externalId: msg.userId,
    ...(msg.lang ? { lang: msg.lang } : {}),
  });
  const rawRepos = d.repos;
  const accepted = await rawRepos.executions.accept({
    userId: user.id,
    groupId: group?.id ?? null,
    message: msg,
    phase,
  });
  if (accepted.kind === 'legacy') {
    await trace('rule', accepted.message.id, {
      outcome: 'dropped_by_rule',
      reason: 'legacy_delivery',
    });
    return;
  }
  const claim = await rawRepos.executions.claim({
    userId: user.id,
    messageId: accepted.message.id,
  });
  if (claim.kind === 'busy') return { deferMs: claim.retryAfterMs };
  if (claim.kind !== 'acquired') {
    await trace('rule', accepted.message.id, { outcome: 'execution_' + claim.kind });
    return;
  }
  const stored = claim.message,
    execution = claim.lease;
  phase = toPhase(Math.min(phase, stored.executionPhase));
  msg = {
    channel: msg.channel,
    chatId: msg.chatId,
    userId: msg.userId,
    messageId: stored.externalId,
    text: stored.text,
    receivedAt: stored.receivedAt.toISOString(),
    addressedToBot: stored.isAddressedToBot,
    ...(stored.lang ? { lang: stored.lang } : {}),
    ...(stored.replyToBotText ? { replyToBotText: stored.replyToBotText } : {}),
    ...(stored.replyToMessageId ? { replyToMessageId: stored.replyToMessageId } : {}),
  };
  // What other members said recently: context for the gate and the agent, never a request itself.
  // Read-only and group-wide, so it uses the unfenced repositories (no per-user lock transaction).
  const groupTranscript = stored.groupId
    ? await loadGroupTranscript(rawRepos, {
        groupId: stored.groupId,
        chatId: msg.chatId,
        sourceMessageId: stored.id,
        userId: user.id,
        receivedAt: stored.receivedAt,
      })
    : [];
  d = { ...d, repos: rawRepos.forExecution(execution) };
  let terminal: 'completed' | 'failed' | 'accepted' | 'waiting_approval' = 'completed';
  let runStateId: string | undefined;
  let errorCode: string | undefined;
  try {
    const directAdmission =
      d.env.JEV_POLICY === 'targeted' &&
      d.answerRequests &&
      d.taskRequests &&
      (isPrivate || msg.addressedToBot);
    let verdict: Awaited<ReturnType<typeof d.evaluateInbound>> | undefined;
    let triage: TriageVerdict | undefined;
    let decision: ReturnType<typeof decideInbound>;
    if (directAdmission) {
      decision = { action: 'enter_agent', category: 'other', kind: 'followup' };
      await trace('gate', stored.id, { outcome: 'direct_request_admitted', policy: 'targeted' });
    } else if (d.env.JEV_POLICY === 'off') {
      const outcome = await (d.triageInbound ?? triageInboundFn)(d, {
        text: msg.text,
        inputRef: stored.id,
        phase,
        isPrivate,
        addressedToBot: isPrivate || msg.addressedToBot === true,
        replyToBotText: msg.replyToBotText,
        transcript: groupTranscript,
      });
      if (!outcome.ok) {
        // Same degradation as an unavailable Jev: an unjudged message never enters the agent.
        terminal = 'failed';
        errorCode = 'triage_unavailable';
        d.logger.warn(
          { inputRef: stored.id, reason: outcome.reason, detail: outcome.detail },
          'triage unavailable',
        );
        await trace('gate', stored.id, {
          outcome: 'dropped_by_triage',
          reason: outcome.reason,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        });
        return;
      }
      triage = outcome.verdict;
      let dropReason = triage.sensitive
        ? 'sensitive'
        : triage.action === 'ignore'
          ? triage.handledByMembers
            ? 'handled_by_members'
            : 'not_request'
          : triage.action === 'acknowledge'
            ? 'acknowledgement'
            : triage.action === 'peer_offer'
              ? 'peer_offer_noted'
              : triage.action === 'continue' && !triage.newCondition && !msg.addressedToBot
                ? 'no_new_condition'
                : triage.category === 'job'
                  ? 'unsupported_category'
                  : null;
      // "Same conditions as before" only means handled if an earlier ask actually opened a task.
      // 2026-10-21 run 5: a printer ask lost to an aborted planning call was re-asked and dropped
      // as no_new_condition, so the member never got anything.
      if (
        dropReason === 'no_new_condition' &&
        !(
          await d.repos.tasks.findOpenByScope({
            userId: user.id,
            scope: { channel: msg.channel, chatId: msg.chatId },
          })
        ).length
      ) {
        await trace('gate', stored.id, { outcome: 'reask_without_task', triage });
        triage = { ...triage, action: 'answer', newCondition: true };
        dropReason = null;
      }
      // 2026-10-21 run 6: a member refined a favour ask twice within minutes of A2H's reply while
      // other members were already volunteering; each refinement re-ran research and A2H posted
      // three times in one thread. A follow-up that is not addressed to A2H waits out a short
      // cooldown after the last delivery to that member; asking A2H directly still goes through.
      if (!dropReason && triage.action === 'continue' && !msg.addressedToBot) {
        // mention_user_id holds the channel id of the addressed member (addressing.ts), not the
        // internal user id; querying with user.id never matched and the cooldown never fired.
        const lastSent = await d.repos.outbound.lastSentToUser(msg.chatId, msg.userId);
        if (lastSent && stored.receivedAt.getTime() - lastSent.getTime() < FOLLOWUP_COOLDOWN_MS)
          dropReason = 'followup_cooldown';
      }
      if (dropReason) {
        await trace('gate', stored.id, {
          outcome: 'dropped_by_triage',
          reason: dropReason,
          triage,
        });
        return;
      }
      decision = {
        action: 'enter_agent',
        category: triage.category,
        kind: triage.action === 'continue' ? 'followup' : 'demand',
      };
    } else {
      const recent = (
        await d.repos.messages.recentByUser(user.id, RECENT_WINDOW_HOURS, {
          groupId: stored.groupId,
        })
      )
        .filter((m) => m.id !== stored.id && m.text.length > 0 && m.groupId === stored.groupId)
        .slice(0, RECENT_TEXTS)
        .map((m) => m.text);
      verdict = await d.evaluateInbound(d.jev, {
        text: msg.text,
        groupName: group?.name ?? 'private',
        ...(msg.lang ? { lang: msg.lang } : {}),
        recentTexts: recent,
        inputRef: stored.id,
        phase,
      });
      if (!verdict.ok) {
        terminal = 'failed';
        errorCode = 'jev_unavailable';
        // Jev 挂了不等于放行：入站方向固定为不进 agent（AGENTS.md §3.3 第 5 条）。
        await trace('gate', stored.id, {
          outcome: 'dropped_by_jev',
          reason: verdict.reason,
          jevAvailable: false,
        });
        return;
      }

      decision = decideInbound(verdict, d.thresholds, {
        addressedToBot: msg.addressedToBot,
        text: msg.text,
      });
      if (decision.action === 'drop') {
        await trace('gate', stored.id, {
          outcome: 'dropped_by_jev',
          reason: decision.reason,
          verdict,
        });
        return;
      }
      if (decision.action === 'tag_move_event') {
        await d.repos.demands.create({
          userId: user.id,
          category: verdict.category,
          confidence: verdict.categoryConfidence,
          sourceMessageId: stored.id,
          isMoveEvent: true,
        });
        await trace('gate', stored.id, { outcome: 'tagged_move_event', verdict });
        return;
      }
    }

    // 接话时 Jev 判的品类未必可靠（「谢谢」没有品类），取该用户最近一条未结需求
    const openDemands = await d.repos.demands.findOpenByUser(user.id);
    const open =
      decision.kind === 'followup'
        ? openDemands[0]
        : openDemands.find((x) => x.category === decision.category);
    const ctx: MatchContext = {
      execution,
      channel: msg.channel,
      userId: user.id,
      chatId: msg.chatId,
      groupId: group?.id ?? null,
      phase,
      sourceMessageId: stored.id,
      requestCategory: decision.category,
      source: { messageId: msg.messageId, userId: msg.userId },
      ...(group?.rateLimitPerDay != null ? { rateLimitPerDay: group.rateLimitPerDay } : {}),
      ...(msg.addressedToBot ? { addressedToBot: true } : {}),
      ...(msg.replyToBotText ? { replyToBotText: msg.replyToBotText } : {}),
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
      // 2026-10-22 run 7: this was always empty, and A2H recommended the same museum to one member
      // three times across a week. Its own earlier answers to this member, chat line only.
      recentReplies: (
        await d.repos.outbound.recentSentToUser(msg.chatId, msg.userId, {
          since: new Date(Date.now() - RECENT_REPLY_DAYS * 86400e3),
          limit: 5,
        })
      ).map((text) => splitEvidenceCard(text).line.slice(0, 240)),
      groupTranscript,
      ...(open ? { demandId: open.id, demand: toDemandDraft(open) } : {}),
    };
    await trace('gate', stored.id, {
      outcome: 'entered_agent',
      decision,
      ...(verdict ? { verdict } : {}),
      ...(triage ? { triage } : {}),
    });

    let r: Awaited<ReturnType<typeof d.runInbound>>;
    try {
      r = await d.runInbound({
        deps: d,
        ctx,
        input: msg.text,
        checkpoint: stored.executionSnapshot,
      });
    } catch (e) {
      // Reply idempotence and the durable execution fence now make bounded redelivery safe.
      const err = e instanceof Error ? e : new Error(String(e));
      d.logger.error({ inputRef: stored.id, err: err.name }, 'agent run failed');
      await trace('gate', stored.id, {
        outcome: 'agent_failed',
        error: err.name,
      });
      throw err;
    }
    if (r.kind === 'interrupted') {
      terminal = 'waiting_approval';
      runStateId = r.runStateId;
      await trace('gate', stored.id, { outcome: 'agent_interrupted', runStateId });
      return;
    }
    await trace('gate', stored.id, { outcome: 'agent_completed', toolsCalled: r.toolsCalled });
  } catch (error) {
    terminal = 'accepted';
    errorCode = 'processing_error';
    throw error;
  } finally {
    await rawRepos.executions.finish({
      lease: execution,
      status: terminal,
      ...(errorCode ? { errorCode } : {}),
      ...(runStateId ? { runStateId } : {}),
    });
    if (terminal === 'waiting_approval' && runStateId) {
      const state = await rawRepos.runStates.findById(runStateId);
      if (state) await d.publishApproval({ repos: rawRepos, cards: d.cards, runState: state });
    }
  }
}

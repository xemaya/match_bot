import { ACK_REACTION, REACTION_CLEAR } from '@matchbot/domain';
import type { AgentDeps, MatchContext } from './context.js';
import { decideForOutbound, type OutboundDraftInput } from './tools/outbound-gate.js';

/**
 * P55 stage A: a member who asks A2H directly sees a 👀 on their message within seconds, instead
 * of nothing for the half minute research takes. It goes through the same outbound gate as the
 * react tool (reactions: no review, no Jev, no rate limit; Phase 0 records a dry run) but does not
 * count as the answer. If the run ends with nothing sent, the 👀 is withdrawn.
 */
export function shouldAcknowledge(ctx: MatchContext): boolean {
  return !!ctx.groupId && ctx.addressedToBot === true && !!ctx.source && !!ctx.execution;
}

async function sendReaction(
  deps: AgentDeps,
  ctx: MatchContext,
  text: string,
  gate: 'ack_reaction' | 'ack_withdrawn' | 'thanks_reaction',
): Promise<boolean> {
  if (!ctx.source) return false;
  const draft: OutboundDraftInput = {
    kind: 'reaction',
    target: ctx.chatId,
    text,
    supplierSummaries: [],
    inputRef: ctx.sourceMessageId,
    replyToMessageId: ctx.source.messageId,
  };
  const decision = await decideForOutbound(deps, ctx, draft);
  if (decision === 'drop' || decision === 'review') return false;
  await deps.repos.outbound.create(
    {
      channel: ctx.channel ?? 'telegram',
      phase: ctx.phase,
      ...(ctx.execution ? { execution: ctx.execution } : {}),
      kind: 'reaction',
      target: ctx.chatId,
      text,
      replyToMessageId: ctx.source.messageId,
    },
    decision === 'dry_run' ? 'dry_run' : 'pending',
  );
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: ctx.sourceMessageId,
    phase: ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: { gate, decision },
  });
  return true;
}

export async function acknowledgeAsk(deps: AgentDeps, ctx: MatchContext): Promise<void> {
  if (shouldAcknowledge(ctx) && (await sendReaction(deps, ctx, ACK_REACTION, 'ack_reaction')))
    ctx.ackReactionSent = true;
}

/** Nothing reached the group (no reply, no other reaction): take the 👀 back. */
export async function withdrawAckIfSilent(deps: AgentDeps, ctx: MatchContext): Promise<void> {
  if (ctx.ackReactionSent && !ctx.answerRecorded)
    await sendReaction(deps, ctx, REACTION_CLEAR, 'ack_withdrawn');
}

/**
 * P55 follow-up (2026-10-23): a thanks or an ok addressed to A2H used to end at triage with no
 * response at all; a member would at least leave a 👍. Code-only, no model call, same reaction gate.
 */
export async function reactToThanks(
  deps: AgentDeps,
  p: Pick<
    MatchContext,
    'execution' | 'chatId' | 'groupId' | 'phase' | 'sourceMessageId' | 'channel'
  > & {
    source: { messageId: string; userId: string };
  },
): Promise<void> {
  const ctx: MatchContext = { ...p, userId: p.execution?.userId ?? '', recentReplies: [] };
  if (ctx.groupId && ctx.execution) await sendReaction(deps, ctx, '👍', 'thanks_reaction');
}

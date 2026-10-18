import type { Repositories } from '@matchbot/db';
import {
  inboundMessageSchema,
  isDirectMessage,
  type InboundMessage,
  type Phase,
} from '@matchbot/domain';
import { inboundRuleReason, resolvePhase } from '@matchbot/gating';
import { enqueueInbound as defaultEnqueue, type Queues } from '@matchbot/queue';
import type { Logger } from '@matchbot/shared';

/** Shared durable admission after provider authentication and normalization. */
export function createChannelInboundHandler(p: {
  repos: Repositories;
  queues: Queues;
  logger: Logger;
  defaultPhase?: Phase;
  enqueueInbound?: typeof defaultEnqueue;
}) {
  const enqueue = p.enqueueInbound ?? defaultEnqueue;
  return async (input: InboundMessage, metadata: { title?: string } = {}): Promise<void> => {
    const msg = inboundMessageSchema.parse(input);
    const repos = msg.account ? p.repos.forChannel(msg.channel, msg.account) : p.repos;
    const isPrivate = isDirectMessage(msg);
    const group = isPrivate ? null : await repos.groups.findByExternal(msg.channel, msg.chatId);
    if (!isPrivate && !group) {
      const added = await repos.groups.upsert({
        channel: msg.channel,
        externalId: msg.chatId,
        name: metadata.title ?? msg.chatId,
      });
      p.logger.info({ groupId: added.id }, 'new group requires activation');
      return;
    }
    const blocked = inboundRuleReason({
      text: msg.text,
      isPrivate,
      hasGroup: !!group,
      isGroupActive: group?.isActive ?? false,
    });
    if (blocked) {
      await repos.traces.create({
        kind: 'rule',
        inputRef: `${msg.channel}:${msg.chatId}:${msg.messageId}`,
        phase: resolvePhase({ group, defaultPhase: p.defaultPhase ?? 0 }),
        latencyMs: 0,
        costMicro: 0,
        output: { outcome: 'dropped_by_rule', reason: blocked },
      });
      return;
    }
    const user = await repos.users.upsertByExternal({
      channel: msg.channel,
      externalId: msg.userId,
      ...(msg.lang ? { lang: msg.lang } : {}),
    });
    const accepted = await repos.executions.accept({
      userId: user.id,
      groupId: group?.id ?? null,
      message: msg,
      phase: resolvePhase({ group, defaultPhase: p.defaultPhase ?? 0 }),
    });
    if (accepted.kind === 'legacy' || accepted.message.executionStatus !== 'accepted') return;
    try {
      await enqueue(p.queues, msg);
      await repos.executions.markEnqueued({ messageId: accepted.message.id, userId: user.id });
      p.logger.info({ inputRef: accepted.message.id }, 'accepted inbound enqueued');
    } catch (error) {
      p.logger.warn(
        {
          inputRef: accepted.message.id,
          errorKind: error instanceof Error ? error.name : 'unknown',
        },
        'accepted inbound awaits dispatch',
      );
    }
  };
}

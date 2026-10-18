import { ChannelSendError, type DeliveryResult } from '@matchbot/domain';
import type { OutboundMessage, Repositories } from '@matchbot/db';
import type { Phase } from '@matchbot/domain';
import { resolvePhase } from '@matchbot/gating';
import type { Logger } from '@matchbot/shared';

type DrainDeps = {
  repos: Repositories;
  sender: {
    send(
      message: OutboundMessage,
      options: { beforeSend: () => Promise<boolean> },
    ): Promise<DeliveryResult>;
  };
  logger: Logger;
  defaultPhase?: Phase;
  opsChatId?: string;
};
async function isDeliveryAllowed(p: DrainDeps, m: OutboundMessage): Promise<boolean> {
  if (m.phase !== 1 && m.phase !== 2) return false;
  const group = await p.repos.groups.findByExternal(m.channel, m.target);
  if (group && !group.isActive) return false;
  if (m.approvalRunStateId || m.requestKey?.startsWith('approval:'))
    return m.target === p.opsChatId;
  const phase = resolvePhase({ group, defaultPhase: p.defaultPhase ?? 0 });
  return phase !== 0 && !(m.phase === 2 && phase === 1);
}
/** Claim immediately before each send; a lease is not proof of external delivery. */
export async function drainOutbound(p: DrainDeps): Promise<void> {
  await p.repos.outbound.recoverExpiredClaims();
  for (let count = 0; count < 20; count++) {
    const [m] = await p.repos.outbound.claimPending(1);
    if (!m) break;
    if (!m.leaseToken) {
      p.logger.error({ outboundMessageId: m.id }, 'outbound claim missing fence');
      continue;
    }
    const identity = { id: m.id, leaseToken: m.leaseToken };
    let receipt: Awaited<ReturnType<typeof p.sender.send>>;
    try {
      receipt = await p.sender.send(m, {
        beforeSend: async () => {
          if (!(await isDeliveryAllowed(p, m))) {
            await p.repos.outbound.markFailed({
              ...identity,
              deliveryState: 'not_sent',
              errorCode: 'delivery_policy_changed',
            });
            return false;
          }
          return p.repos.outbound.beginSend({
            ...identity,
            ...(m.approvalRunStateId || m.requestKey?.startsWith('approval:')
              ? {
                  ...(p.opsChatId ? { opsChatId: p.opsChatId } : {}),
                  defaultPhase: p.defaultPhase ?? 0,
                }
              : {}),
          });
        },
      });
    } catch (error) {
      const delivery = error instanceof ChannelSendError ? error : null;
      await p.repos.outbound.markFailed({
        ...identity,
        deliveryState: delivery?.deliveryState ?? 'unknown',
        errorCode: delivery?.errorCode ?? 'unknown_send_error',
        ...(delivery?.deliveryState === 'not_sent' && delivery.retryAfterSeconds !== null
          ? { retryAt: new Date(Date.now() + delivery.retryAfterSeconds * 1000) }
          : {}),
      });
      p.logger.error(
        { outboundMessageId: m.id, errorKind: delivery?.errorCode ?? 'unknown_send_error' },
        'send not confirmed',
      );
      continue;
    }
    if (receipt.kind === 'not_started') continue;
    // A receipt persistence error is not a failed Telegram send. Leave it for conservative lease recovery.
    try {
      const saved = await p.repos.outbound.markSent({
        ...identity,
        externalMessageId: receipt.externalMessageId,
      });
      if (!saved) p.logger.warn({ outboundMessageId: m.id }, 'outbound receipt fence rejected');
    } catch (error) {
      p.logger.error(
        { outboundMessageId: m.id, errorKind: error instanceof Error ? error.name : 'unknown' },
        'outbound receipt persistence failed',
      );
    }
  }
}
export function startOutboundLoop(p: DrainDeps & { intervalMs?: number }) {
  let running = false;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pending = drainOutbound(p)
      .catch((error) => {
        p.logger.error(
          { errorKind: error instanceof Error ? error.name : 'unknown' },
          'outbound poll failed',
        );
      })
      .finally(() => {
        running = false;
      });
  }, p.intervalMs ?? 2000);
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

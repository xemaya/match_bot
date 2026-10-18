import type { Repositories } from '@matchbot/db';
import { enqueueInbound, type Queues } from '@matchbot/queue';
import type { Logger } from '@matchbot/shared';

export async function dispatchAcceptedInbound(p: {
  repos: Repositories;
  queues: Queues;
  logger: Logger;
  enqueue?: typeof enqueueInbound;
}) {
  for (const item of await p.repos.executions.dispatchable()) {
    try {
      await (p.enqueue ?? enqueueInbound)(p.queues, item.message, {
        recoverActive: item.recoverActive,
      });
      await p.repos.executions.markEnqueued({ messageId: item.messageId, userId: item.userId });
    } catch (error) {
      p.logger.warn(
        { inputRef: item.messageId, errorKind: error instanceof Error ? error.name : 'unknown' },
        'accepted inbound remains pending dispatch',
      );
      break;
    }
  }
}
export function startInboundDispatch(p: Parameters<typeof dispatchAcceptedInbound>[0]) {
  let active = false;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = true;
    pending = dispatchAcceptedInbound(p)
      .catch((error) =>
        p.logger.error(
          { errorKind: error instanceof Error ? error.name : 'unknown' },
          'inbound dispatch failed',
        ),
      )
      .finally(() => {
        active = false;
      });
  }, 2000);
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

import type { Repositories } from '@matchbot/db';
import { enqueueResume, type Queues } from '@matchbot/queue';
import type { Logger } from '@matchbot/shared';

export async function dispatchApprovedResumes(p: {
  repos: Repositories;
  queues: Queues;
  logger: Logger;
  enqueue?: typeof enqueueResume;
}) {
  for (const item of await p.repos.approvals.dispatchable()) {
    const job = { runStateId: item.runStateId, approvalId: item.approvalId };
    try {
      await (p.enqueue ?? enqueueResume)(p.queues, job, { recoverActive: item.recoverActive });
      await p.repos.approvals.markEnqueued(job);
    } catch (error) {
      p.logger.warn(
        { runStateId: item.runStateId, errorKind: error instanceof Error ? error.name : 'unknown' },
        'approved resume remains pending dispatch',
      );
      break;
    }
  }
}
export function startResumeDispatch(p: Parameters<typeof dispatchApprovedResumes>[0]) {
  let active = false;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = true;
    pending = dispatchApprovedResumes(p)
      .catch((error) =>
        p.logger.error(
          { errorKind: error instanceof Error ? error.name : 'unknown' },
          'resume dispatch failed',
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

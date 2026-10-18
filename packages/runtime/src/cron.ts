import type { Repositories } from '@matchbot/db';
import type { Queues } from '@matchbot/queue';
import type { Logger } from '@matchbot/shared';

/** 保留期见 AGENTS.md §6：messages.text 30 天、run_states 快照 7 天（过期由 expiresAt 判定）。 */
const MESSAGE_RETENTION_DAYS = 30;
const DEMAND_EXPIRY_DAYS = 14;
const TASK_RETENTION_DAYS = 30; // PRD §13: delete task text and cascading checkpoints, not just status.

export const CRON_JOBS = {
  redactMessages: { name: 'redact_messages', every: 6 * 3600e3 },
  expireDemands: { name: 'expire_demands', every: 24 * 3600e3 },
  expireRunStates: { name: 'expire_run_states', every: 3600e3 },
  deleteInactiveTasks: { name: 'delete_inactive_tasks', every: 6 * 3600e3 },
  redactDeliveryReceipts: { name: 'redact_delivery_receipts', every: 6 * 3600e3 },
} as const;

/**
 * BullMQ 6 移除了 `Queue.add` 的 `repeat` 选项（job-options.d.ts：“`repeat` is no longer a valid
 * option for `Queue.add`; use `Queue.upsertJobScheduler`”），所以这里用 scheduler。
 * scheduler id 与 job name 都取 cron 名，worker 靠 `job.name` 分派。
 */
export async function scheduleCron(q: Pick<Queues, 'cron'>): Promise<void> {
  for (const j of Object.values(CRON_JOBS)) {
    await q.cron.upsertJobScheduler(j.name, { every: j.every }, { name: j.name, data: {} });
  }
}

export async function runCronJob(name: string, repos: Repositories, logger: Logger): Promise<void> {
  switch (name) {
    case CRON_JOBS.redactMessages.name:
      logger.info(
        { n: await repos.messages.redactOlderThan(MESSAGE_RETENTION_DAYS) },
        'redacted messages',
      );
      break;
    case CRON_JOBS.expireDemands.name:
      logger.info(
        { n: await repos.demands.expireOlderThan(DEMAND_EXPIRY_DAYS) },
        'expired demands',
      );
      break;
    case CRON_JOBS.expireRunStates.name:
      logger.info({ n: await repos.runStates.expireOld(new Date()) }, 'expired run states');
      break;
    case CRON_JOBS.deleteInactiveTasks.name:
      logger.info(
        {
          n: await repos.tasks.deleteInactiveBefore(
            new Date(Date.now() - TASK_RETENTION_DAYS * 86400e3),
          ),
        },
        'deleted inactive tasks',
      );
      break;
    case CRON_JOBS.redactDeliveryReceipts.name:
      logger.info(
        {
          n: await repos.outbound.redactDeliveryReceiptsBefore(new Date(Date.now() - 30 * 86400e3)),
        },
        'redacted old delivery receipts',
      );
      break;
    default:
      logger.warn({ name }, 'unknown cron job');
  }
}

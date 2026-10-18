import { inboundEventKey } from '@matchbot/domain';
import { hashText } from '@matchbot/shared';
import type { InboundMessage } from '@matchbot/domain';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_NAMES,
  inboundJobId,
  inboundJobSchema,
  outboundJobSchema,
  resumeRunJobSchema,
} from './contracts.js';

export interface Queues {
  connection: Redis;
  inbound: Queue;
  resume: Queue;
  outbound: Queue;
  cron: Queue;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export function createQueues(redisUrl: string): Queues {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    commandTimeout: 5000,
    enableOfflineQueue: false,
  });
  const mk = (name: string) => new Queue(name, { connection, defaultJobOptions });
  return {
    connection,
    inbound: mk(QUEUE_NAMES.inbound),
    resume: mk(QUEUE_NAMES.resume),
    outbound: mk(QUEUE_NAMES.outbound),
    cron: mk(QUEUE_NAMES.cron),
  };
}

export async function enqueueInbound(
  q: Queues,
  msg: InboundMessage,
  options?: { recoverActive?: boolean },
): Promise<void> {
  if (q.connection.status !== 'ready') throw new Error('queue producer unavailable');
  const data = inboundJobSchema.parse(msg);
  const key = data.account
    ? hashText(inboundEventKey(data))
    : inboundJobId(data.channel, data.chatId, data.messageId);
  const existing = await q.inbound.getJob(key);
  if (existing) {
    const state = await existing.getState();
    if (
      state === 'failed' ||
      state === 'completed' ||
      (state === 'active' && options?.recoverActive)
    )
      await existing.remove();
  }
  await q.inbound.add('inbound', data, {
    jobId: key,
  });
}

export async function enqueueResume(
  q: Queues,
  p: { runStateId: string; approvalId: string },
  options?: { recoverActive?: boolean },
): Promise<void> {
  if (q.connection.status !== 'ready') throw new Error('queue producer unavailable');
  const data = resumeRunJobSchema.parse(p);
  const key = `resume:${data.runStateId}:${data.approvalId}`;
  const existing = await q.resume.getJob(key);
  if (existing) {
    const state = await existing.getState();
    if (
      state === 'failed' ||
      state === 'completed' ||
      (state === 'active' && options?.recoverActive)
    )
      await existing.remove();
  }
  await q.resume.add('resume', data, { jobId: key });
}

export async function enqueueOutbound(q: Queues, outboundMessageId: string): Promise<void> {
  const data = outboundJobSchema.parse({ outboundMessageId });
  // jobId 直接用 cuid 本身：bullmq 6 只允许恰好两段冒号的自定义 id，且下个大版本将全禁
  await q.outbound.add('outbound', data, { jobId: outboundMessageId });
}

export async function closeQueues(q: Queues): Promise<void> {
  await Promise.all([q.inbound.close(), q.resume.close(), q.outbound.close(), q.cron.close()]);
  await q.connection.quit();
}

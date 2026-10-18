import { Worker, DelayedError } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  QUEUE_NAMES,
  inboundJobSchema,
  outboundJobSchema,
  resumeRunJobSchema,
} from './contracts.js';

type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
const schemas: Record<QueueName, z.ZodTypeAny> = {
  [QUEUE_NAMES.inbound]: inboundJobSchema,
  [QUEUE_NAMES.resume]: resumeRunJobSchema,
  [QUEUE_NAMES.outbound]: outboundJobSchema,
  [QUEUE_NAMES.cron]: z.object({}).strict(), // cron jobs carry no inbound-message fields
};

export function createWorker<T>(
  name: QueueName,
  redisUrl: string,
  handler: (data: T, jobName: string) => Promise<void | { deferMs: number }>,
  opts: { concurrency?: number } = {},
): Worker {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker(
    name,
    async (job, token) => {
      const result = await handler(schemas[name].parse(job.data) as T, job.name);
      if (result) {
        const delay = result.deferMs;
        if (!Number.isInteger(delay) || delay < 100 || delay > 60000)
          throw new Error('invalid worker defer duration');
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }
    },
    { connection, concurrency: opts.concurrency ?? 4, autorun: false },
  );
  // BullMQ treats a supplied Redis instance as shared; this factory created it and must release it.
  worker.once('closed', () => connection.disconnect());
  // Starting BullMQ's stalled checker while its connections initialise can leave a retry
  // timer alive after an immediate close. A closed worker must never start that loop.
  void worker
    .waitUntilReady()
    .then(() => {
      if (!worker.closing) return worker.run();
    })
    .catch((error: unknown) => {
      if (!worker.closing)
        worker.emit(
          'error',
          error instanceof Error ? error : new Error('Worker startup failed', { cause: error }),
        );
    });
  return worker;
}

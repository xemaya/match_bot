import { disconnectPrisma } from '@matchbot/db';
import { AGENT_VERSION } from '@matchbot/agent';
import type { InboundMessage } from '@matchbot/domain';
import { QUEUE_NAMES, closeQueues, createQueues, createWorker } from '@matchbot/queue';
import { consolidateGroupMemory } from '@matchbot/agent';
import { runCronJob, scheduleCron } from './cron.js';
import { buildDeps } from './deps.js';
import { processInbound } from './pipeline/inbound.js';
import { processResume } from './pipeline/resume.js';
import { startApprovalDispatch } from './approval-dispatch.js';

const d = buildDeps();
const queues = createQueues(d.env.REDIS_URL);
await scheduleCron(queues);
const stopApprovalDispatch = startApprovalDispatch(d);

// concurrency 1：同一用户的 run 必须串行（session 与 run_states 都是按用户的状态）。
// Phase 2 再按 userId 分组并发（计划 Global Constraints）。
const workers = [
  createWorker<InboundMessage>(QUEUE_NAMES.inbound, d.env.REDIS_URL, (m) => processInbound(d, m), {
    concurrency: 1,
  }),
  createWorker<{ runStateId: string; approvalId: string }>(
    QUEUE_NAMES.resume,
    d.env.REDIS_URL,
    (j) => processResume(d, j),
    {
      concurrency: 1,
    },
  ),
  createWorker(QUEUE_NAMES.cron, d.env.REDIS_URL, (_data, jobName) =>
    runCronJob(jobName, d.repos, d.logger, (p) => consolidateGroupMemory(d, p)),
  ),
];

for (const w of workers) {
  w.on('failed', (job, err) => {
    d.logger.error({ queue: w.name, jobId: job?.id, errorKind: err.name }, 'job failed');
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopApprovalDispatch();
    void (async () => {
      await Promise.all(workers.map((w) => w.close()));
      await closeQueues(queues);
      await disconnectPrisma();
    })();
  });
}

d.logger.info(
  {
    phase: d.env.DEFAULT_PHASE,
    agentVersion: AGENT_VERSION,
    generationModel: d.env.DEEPSEEK_MODEL,
    generationProviderHost: new URL(d.env.DEEPSEEK_BASE_URL).host,
    generationReasoningEffort: d.env.GENERATION_REASONING_EFFORT ?? null,
    jevPolicy: d.env.JEV_POLICY,
    informationSearchProvider: d.env.INFORMATION_SEARCH_PROVIDER,
    taskRequests: d.taskRequests === true,
  },
  'worker started',
);

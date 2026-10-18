import { createPrisma, createRepositories } from '@matchbot/db';
import type { InboundMessage, Phase } from '@matchbot/domain';
import { createQueues, closeQueues, createWorker, QUEUE_NAMES } from '@matchbot/queue';
import {
  buildDeps,
  processInbound,
  processResume,
  runCronJob,
  scheduleCron,
  startApprovalDispatch,
} from '@matchbot/runtime';
import {
  createChannelInboundHandler,
  handleChannelApproval,
  startOutboundLoop,
  startInboundDispatch,
  startResumeDispatch,
} from '@matchbot/channels';
import { createFeishuConnection } from '@matchbot/channel-feishu';
import { createTelegramConnection } from '@matchbot/channel-telegram';
import { createLogger, type Env } from '@matchbot/shared';
import { createCleanupStack } from './lifecycle.js';

const splitIds = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
// Agents SDK provider/tracing are process globals. A second installation requires its own process.
let active = false;

/** Owns a complete installation. Do not run legacy bot/worker processes against these queues. */
export async function startMatchBotHost(env: Env) {
  if (active) throw new Error('only one MatchBot host is supported per process');
  active = true;
  const cleanup = createCleanupStack();
  cleanup.add(() => {
    active = false;
  });
  const logger = createLogger('host', env.LOG_LEVEL);
  const status: (() => { state: string; accountId?: string | undefined })[] = [];
  try {
    const prisma = createPrisma(env.DATABASE_URL);
    cleanup.add(() => prisma.$disconnect());
    await prisma.$connect();
    const repos = createRepositories(prisma);
    const queues = createQueues(env.REDIS_URL);
    cleanup.add(() => closeQueues(queues));
    const d = buildDeps({ env, repos });
    const workers = [
      createWorker<InboundMessage>(
        QUEUE_NAMES.inbound,
        env.REDIS_URL,
        (m) => processInbound(d, m),
        { concurrency: 1 },
      ),
      createWorker<{ runStateId: string; approvalId: string }>(
        QUEUE_NAMES.resume,
        env.REDIS_URL,
        (j) => processResume(d, j),
        { concurrency: 1 },
      ),
      createWorker(QUEUE_NAMES.cron, env.REDIS_URL, (_data, jobName) =>
        runCronJob(jobName, repos, logger),
      ),
    ];
    cleanup.add(async () => {
      await Promise.all(workers.map((w) => w.close()));
    });
    for (const worker of workers) {
      worker.on('error', () => logger.error({ queue: worker.name }, 'queue connection error'));
      worker.on('failed', (job, error) =>
        logger.error({ queue: worker.name, jobId: job?.id, errorKind: error.name }, 'job failed'),
      );
    }
    await scheduleCron(queues);
    cleanup.add(startApprovalDispatch(d));
    cleanup.add(startInboundDispatch({ repos, queues, logger }));
    cleanup.add(startResumeDispatch({ repos, queues, logger }));
    const defaultPhase: Phase =
      env.DEFAULT_PHASE === 1 || env.DEFAULT_PHASE === 2 ? env.DEFAULT_PHASE : 0;
    const onMessage = createChannelInboundHandler({ repos, queues, logger, defaultPhase });
    if (env.CHANNEL_MODE !== 'feishu') {
      const connection = createTelegramConnection({
        token: env.TELEGRAM_BOT_TOKEN,
        installationId: env.CHANNEL_INSTALLATION_ID,
        logger,
        actorAllowlist: env.TELEGRAM_ACTOR_ALLOWLIST,
        onMessage,
        onApproval: (origin) =>
          handleChannelApproval({
            ...origin,
            repos: repos.forChannel('telegram', connection.account()),
            queues,
            opsChatId: env.TELEGRAM_OPS_CHAT_ID,
            reviewers: splitIds(env.TELEGRAM_REVIEWERS),
          }),
      });
      // Register before startup so a failed handshake is also cleaned up.
      cleanup.add(() => connection.stop());
      await connection.start();
      cleanup.add(
        startOutboundLoop({
          repos: repos.forChannel('telegram', connection.account()),
          sender: connection.sender,
          logger,
          opsChatId: env.TELEGRAM_OPS_CHAT_ID,
          defaultPhase,
        }),
      );
      status.push(connection.status);
    }
    if (env.CHANNEL_MODE !== 'telegram') {
      const connection = createFeishuConnection({
        config: {
          installationId: env.CHANNEL_INSTALLATION_ID,
          appId: env.FEISHU_APP_ID,
          appSecret: env.FEISHU_APP_SECRET,
          tenantId: env.FEISHU_TENANT_ID,
          region: env.FEISHU_REGION,
          allowedUsers: splitIds(env.FEISHU_ALLOWED_USERS),
          allowedChats: splitIds(env.FEISHU_ALLOWED_CHATS),
          requireMention: true,
        },
        logger,
        onMessage,
        onApproval: (origin) =>
          handleChannelApproval({
            repos: repos.forChannel('feishu', connection.account),
            queues,
            opsChatId: env.FEISHU_OPS_CHAT_ID,
            reviewers: splitIds(env.FEISHU_REVIEWERS),
            reviewer: origin.operator.open_id,
            chatId: origin.context.open_chat_id,
            messageId: origin.context.open_message_id,
            action: origin.action.value,
          }),
        resolveReply: async (chatId, messageId) => {
          const row = await repos
            .forChannel('feishu', connection.account)
            .outbound.findDeliveredByExternal({ target: chatId, externalMessageId: messageId });
          return row && !row.approvalRunStateId ? { text: row.text } : null;
        },
      });
      cleanup.add(() => connection.stop());
      await connection.start();
      cleanup.add(
        startOutboundLoop({
          repos: repos.forChannel('feishu', connection.account),
          sender: connection.sender,
          logger,
          opsChatId: env.FEISHU_OPS_CHAT_ID,
          defaultPhase,
        }),
      );
      status.push(connection.status);
    }
    logger.info({ mode: env.CHANNEL_MODE }, 'MatchBot host started');
    return { stop: () => cleanup.close(), status: () => status.map((get) => get()) };
  } catch (error) {
    try {
      await cleanup.close();
    } catch {
      logger.error('host startup cleanup failed');
    }
    throw error;
  }
}

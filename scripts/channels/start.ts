import { startMatchBotHost } from '../../packages/host/src/index.js';
import { loadEnv, createLogger } from '../../packages/shared/src/index.js';

const logger = createLogger('channels');
const env = loadEnv();
if (process.argv.includes('--doctor')) {
  logger.info(
    {
      mode: env.CHANNEL_MODE,
      installationId: env.CHANNEL_INSTALLATION_ID,
      phase: env.DEFAULT_PHASE,
      feishuUsers: env.FEISHU_ALLOWED_USERS.split(',').filter(Boolean).length,
      feishuChats: env.FEISHU_ALLOWED_CHATS.split(',').filter(Boolean).length,
      feishuReviewers: env.FEISHU_REVIEWERS.split(',').filter(Boolean).length,
    },
    'configuration valid; no network checks performed',
  );
  process.exit(0);
}
const host = await startMatchBotHost(env);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.stop().catch(() => {
      logger.error('channel host shutdown failed');
      process.exitCode = 1;
    });
  });
}

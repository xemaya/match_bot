import { createTelegramSender, stampApprovalCardText } from '@matchbot/channel-telegram';
import { createRepositories, disconnectPrisma, getPrisma } from '@matchbot/db';
import { closeQueues, createQueues } from '@matchbot/queue';
import { createLogger, loadEnv } from '@matchbot/shared';
import { Bot, GrammyError, HttpError } from 'grammy';
import { createApprovalCallbackHandler } from './approval-callback.js';
import { createInboundHandler } from './inbound.js';
import { startOutboundLoop } from './outbound-loop.js';
import { startInboundDispatch } from './inbound-dispatch.js';
import { startResumeDispatch } from './resume-dispatch.js';

const env = loadEnv();
const log = createLogger('bot', env.LOG_LEVEL);
const repos = createRepositories(getPrisma(env.DATABASE_URL));
const queues = createQueues(env.REDIS_URL);
const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 10 } });
const me = await bot.api.getMe();

const inbound = createInboundHandler({
  botId: me.id,
  botUsername: me.username,
  actorAllowlist: env.TELEGRAM_ACTOR_ALLOWLIST,
  defaultPhase: env.DEFAULT_PHASE === 1 || env.DEFAULT_PHASE === 2 ? env.DEFAULT_PHASE : 0,
  repos,
  queues,
  logger: log,
});
bot.on('message:text', (ctx) => inbound(ctx.update));

const onApproval = createApprovalCallbackHandler({
  repos,
  queues,
  opsChatId: env.TELEGRAM_OPS_CHAT_ID,
  logger: log,
});
bot.on('callback_query:data', async (ctx) => {
  const q = ctx.callbackQuery;
  const r = await onApproval({
    data: q.data,
    chatId: q.message?.chat.id,
    reviewer: q.from.username ? `@${q.from.username}` : `tg:${q.from.id}`,
  });
  // 必须 answer，否则运营那边按钮会一直转圈
  await ctx.answerCallbackQuery({ text: r.toast });
  // 处理过的卡去掉按钮并盖戳，防止重复点击，也让群里其他运营看到结论
  if (r.stamp && q.message && 'text' in q.message && q.message.text) {
    await ctx.editMessageText(stampApprovalCardText(q.message.text, r.stamp), {
      reply_markup: { inline_keyboard: [] },
    });
  }
});

// 不装 catch 时 grammY 遇到任一 update 抛错就会停止轮询；这里只记日志，继续收后面的消息
bot.catch((err) => {
  const e = err.error;
  const kind =
    e instanceof GrammyError ? 'telegram' : e instanceof HttpError ? 'network' : 'handler';
  log.error(
    {
      updateId: err.ctx.update.update_id,
      kind,
      errorKind: e instanceof Error ? e.name : 'unknown',
    },
    'update failed',
  );
});
const stopLoop = startOutboundLoop({
  repos,
  sender: createTelegramSender({ bot, logger: log }),
  logger: log,
  opsChatId: env.TELEGRAM_OPS_CHAT_ID,
  defaultPhase: env.DEFAULT_PHASE === 1 || env.DEFAULT_PHASE === 2 ? env.DEFAULT_PHASE : 0,
});
const stopInboundDispatch = startInboundDispatch({ repos, queues, logger: log });
const stopResumeDispatch = startResumeDispatch({ repos, queues, logger: log });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void (async () => {
      await bot.stop();
      await Promise.all([stopLoop(), stopInboundDispatch(), stopResumeDispatch()]);
      await closeQueues(queues);
      await disconnectPrisma();
    })().catch(() => log.error('bot shutdown failed'));
  });
}
log.info({ botId: me.id, phase: env.DEFAULT_PHASE }, 'bot started');
await bot.start({ timeout: 5 });

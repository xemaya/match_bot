import { Bot } from 'grammy';
import { accountScopeKey, type ChannelAccount, type InboundMessage } from '@matchbot/domain';
import type { Logger, TelegramActorAllowlist } from '@matchbot/shared';
import { toInboundMessage } from './inbound.js';
import { createTelegramSender } from './sender.js';
import { parseApprovalCallback } from './ops-card.js';

/** Host-owned long-polling adapter, with explicit account identity for new installations. */
export function createTelegramConnection(p: {
  token: string;
  installationId: string;
  logger: Logger;
  actorAllowlist?: TelegramActorAllowlist;
  onMessage: (message: InboundMessage) => Promise<void>;
  onApproval: (origin: {
    chatId: string;
    messageId: string;
    reviewer: string;
    action: { runStateId: string; decision: 'approve' | 'reject' | 'ignore' };
  }) => Promise<boolean>;
}) {
  const bot = new Bot(p.token, { client: { timeoutSeconds: 10 } });
  let account: ChannelAccount | undefined;
  let closed = false;
  let polling: Promise<void> | undefined;
  let sender: ReturnType<typeof createTelegramSender> | undefined;
  let state = 'stopped';
  let cancelStartup: (() => void) | undefined;
  bot.catch(() => p.logger.warn({ channel: 'telegram' }, 'telegram handler failed'));
  return {
    account: () => {
      if (!account) throw new Error('telegram not initialized');
      return account;
    },
    status: () => ({ state, accountId: account?.accountId }),
    sender: {
      send: async (...args: Parameters<ReturnType<typeof createTelegramSender>['send']>) => {
        if (!sender || closed) return { kind: 'not_started' as const };
        return sender.send(args[0], {
          beforeSend: async () => {
            if (closed) return false;
            return (await args[1].beforeSend()) && !closed;
          },
        });
      },
    },
    async start() {
      if (account || closed) throw new Error('telegram already started or disposed');
      state = 'connecting';
      const me = await bot.api.getMe();
      if (closed) throw new Error('telegram disposed');
      account = {
        installationId: p.installationId,
        accountId: String(me.id),
        tenantId: 'telegram',
      };
      sender = createTelegramSender({
        bot,
        logger: p.logger,
        accountScope: accountScopeKey(account),
      });
      bot.on('message:text', async (ctx) => {
        if (closed) return;
        const msg = toInboundMessage(ctx.update, {
          botId: me.id,
          botUsername: me.username,
          ...(p.actorAllowlist ? { actorAllowlist: p.actorAllowlist } : {}),
        });
        if (msg)
          await p.onMessage({
            ...msg,
            account: account!,
            conversationType: ctx.chat.type === 'private' ? 'direct' : 'group',
            ...(ctx.message.message_thread_id
              ? { threadId: String(ctx.message.message_thread_id) }
              : {}),
          });
      });
      bot.on('callback_query:data', async (ctx) => {
        if (closed) return;
        const action = parseApprovalCallback(ctx.callbackQuery.data),
          message = ctx.callbackQuery.message;
        const ok =
          action && message
            ? await p.onApproval({
                action,
                chatId: String(message.chat.id),
                messageId: String(message.message_id),
                reviewer: String(ctx.from.id),
              })
            : false;
        await ctx.answerCallbackQuery({ text: ok ? '审批已记录' : '审批无效或无权限' });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            closed = true;
            state = 'failed';
            reject(new Error('telegram connection timed out'));
          }, 20000);
          cancelStartup = () => {
            clearTimeout(timer);
            reject(new Error('telegram disposed'));
          };
          polling = bot.start({
            timeout: 5,
            onStart: () => {
              clearTimeout(timer);
              if (closed) {
                reject(new Error('telegram disposed'));
                return;
              }
              state = 'ready';
              resolve();
            },
          });
          void polling.catch(() => {
            clearTimeout(timer);
            state = 'failed';
            reject(new Error('telegram polling failed'));
          });
        });
      } finally {
        cancelStartup = undefined;
      }
    },
    async stop() {
      closed = true;
      state = 'stopped';
      cancelStartup?.();
      if (bot.isRunning()) await bot.stop();
      await polling;
    },
  };
}

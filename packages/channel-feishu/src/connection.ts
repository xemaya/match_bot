import {
  Client,
  Domain,
  EventDispatcher,
  WSClient,
  defaultHttpInstance,
  type HttpInstance,
  type HttpRequestOptions,
  type Logger as SdkLogger,
} from '@larksuiteoapi/node-sdk';
import { accountScopeKey, type ChannelAccount, type InboundMessage } from '@matchbot/domain';
import type { Logger } from '@matchbot/shared';
import { z } from 'zod';
import { normalizeFeishuMessage } from './inbound.js';
import { createFeishuSender } from './sender.js';

export const feishuConfigSchema = z.object({
  installationId: z.string().min(1),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  tenantId: z.string().min(1),
  region: z.enum(['feishu', 'lark']).default('feishu'),
  allowedUsers: z.array(z.string().regex(/^ou_[A-Za-z0-9_-]+$/)).default([]),
  allowedChats: z.array(z.string().regex(/^oc_[A-Za-z0-9_-]+$/)).default([]),
  requireMention: z.boolean().default(true),
});
export type FeishuConfig = z.infer<typeof feishuConfigSchema>;
export const feishuApprovalSchema = z.object({
  operator: z.object({ open_id: z.string().min(1), tenant_key: z.string().optional() }),
  context: z.object({ open_chat_id: z.string().min(1), open_message_id: z.string().min(1) }),
  action: z.object({
    value: z.object({
      kind: z.literal('matchbot_approval'),
      runStateId: z.string().min(1),
      decision: z.enum(['approve', 'reject', 'ignore']),
    }),
  }),
});
export type FeishuApproval = z.infer<typeof feishuApprovalSchema>;

/** A connection owns SDK resources; all durable admission and business processing stays outside. */
export function createFeishuConnection(p: {
  config: FeishuConfig;
  logger: Logger;
  onMessage: (message: InboundMessage) => Promise<void>;
  onApproval: (action: FeishuApproval) => Promise<boolean>;
  resolveReply?: (chatId: string, messageId: string) => Promise<{ text: string } | null>;
}) {
  const config = feishuConfigSchema.parse(p.config);
  const account: ChannelAccount = {
    installationId: config.installationId,
    accountId: config.appId,
    tenantId: config.tenantId,
  };
  // SDK diagnostics may contain request headers or message bodies. Never forward arbitrary SDK payloads.
  const sdkLogger: SdkLogger = {
    error: () => p.logger.warn({ channel: 'feishu' }, 'channel SDK error'),
    warn: () => p.logger.warn({ channel: 'feishu' }, 'channel SDK warning'),
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
  // The SDK response interceptor unwraps AxiosResponse.data; use its exported HttpInstance contract.
  const sdkHttp = defaultHttpInstance as HttpInstance;
  const http: HttpInstance = {
    request<T = unknown, R = T, D = unknown>(opts: HttpRequestOptions<D>) {
      return sdkHttp.request<T, R, D>({ ...opts, timeout: 10000 });
    },
    get<T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) {
      return sdkHttp.get<T, R, D>(url, { ...opts, timeout: 10000 });
    },
    delete<T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) {
      return sdkHttp.delete<T, R, D>(url, { ...opts, timeout: 10000 });
    },
    head<T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) {
      return sdkHttp.head<T, R, D>(url, { ...opts, timeout: 10000 });
    },
    options<T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) {
      return sdkHttp.options<T, R, D>(url, { ...opts, timeout: 10000 });
    },
    post<T = unknown, R = T, D = unknown>(url: string, data?: D, opts?: HttpRequestOptions<D>) {
      return sdkHttp.post<T, R, D>(url, data, { ...opts, timeout: 10000 });
    },
    put<T = unknown, R = T, D = unknown>(url: string, data?: D, opts?: HttpRequestOptions<D>) {
      return sdkHttp.put<T, R, D>(url, data, { ...opts, timeout: 10000 });
    },
    patch<T = unknown, R = T, D = unknown>(url: string, data?: D, opts?: HttpRequestOptions<D>) {
      return sdkHttp.patch<T, R, D>(url, data, { ...opts, timeout: 10000 });
    },
  };
  const client = new Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.region === 'lark' ? Domain.Lark : Domain.Feishu,
    logger: sdkLogger,
    httpInstance: http,
  });
  const accountScope = accountScopeKey(account);
  const sender = createFeishuSender({
    accountScope,
    send: (req) =>
      req.replyToMessageId
        ? client.im.message.reply({
            path: { message_id: req.replyToMessageId },
            data: {
              content: req.content,
              msg_type: req.msgType,
              uuid: req.uuid,
              reply_in_thread: req.replyInThread,
            },
          })
        : client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: req.chatId,
              content: req.content,
              msg_type: req.msgType,
              uuid: req.uuid,
            },
          }),
    react: (messageId, emoji) =>
      client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      }),
  });
  let closed = false;
  let ws: WSClient | undefined;
  const closeSocket = () => ws?.close({ force: true });
  let cancelStartup: (() => void) | undefined;
  let botOpenId = '';
  let status: 'stopped' | 'connecting' | 'ready' | 'reconnecting' | 'failed' = 'stopped';
  const active = new Set<Promise<unknown>>();
  async function tracked<T>(fn: () => Promise<T>): Promise<T> {
    if (closed) throw new Error('channel stopped');
    const task = fn();
    active.add(task);
    try {
      return await task;
    } finally {
      active.delete(task);
    }
  }
  return {
    account,
    sender: {
      send: (
        message: Parameters<typeof sender.send>[0],
        options: Parameters<typeof sender.send>[1],
      ) =>
        sender.send(message, {
          beforeSend: async () => {
            if (closed || status !== 'ready') return false;
            const allowed = await options.beforeSend();
            return allowed && !closed && status === 'ready';
          },
        }),
    },
    status: () => ({ state: status, botOpenId, accountId: config.appId }),
    async start() {
      if (ws || closed) throw new Error('channel already started or disposed');
      status = 'connecting';
      try {
        const identity = z
          .object({ code: z.literal(0), bot: z.object({ open_id: z.string().min(1) }) })
          .parse(
            await client.request<unknown>({
              url: '/open-apis/bot/v3/info',
              method: 'GET',
              timeout: 10000,
            }),
          );
        if (closed) throw new Error('channel disposed');
        botOpenId = identity.bot.open_id;
        const dispatcher = new EventDispatcher({ logger: sdkLogger }).register({
          'im.message.receive_v1': (raw: unknown) =>
            tracked(async () => {
              const msg = normalizeFeishuMessage(raw, { account, botOpenId });
              if (!msg) return;
              if (
                msg.conversationType === 'direct'
                  ? !config.allowedUsers.includes(msg.userId)
                  : !config.allowedChats.includes(msg.chatId)
              )
                return;
              if (msg.replyToMessageId && p.resolveReply) {
                const reply = await p.resolveReply(msg.chatId, msg.replyToMessageId);
                if (reply) {
                  msg.addressedToBot = true;
                  msg.replyToBotText = reply.text.slice(0, 2000);
                }
              }
              if (closed) throw new Error('channel stopped');
              if (msg.conversationType === 'group' && config.requireMention && !msg.addressedToBot)
                return;
              await p.onMessage(msg);
            }),
          'card.action.trigger': (raw: unknown) =>
            tracked(async () => {
              const parsed = feishuApprovalSchema.safeParse(raw);
              if (
                !parsed.success ||
                (parsed.data.operator.tenant_key &&
                  parsed.data.operator.tenant_key !== account.tenantId)
              )
                return { toast: { type: 'error', content: '无法验证审批来源' } };
              const ok = await p.onApproval(parsed.data);
              return {
                toast: {
                  type: ok ? 'success' : 'error',
                  content: ok ? '审批已记录' : '审批无效或无权限',
                },
              };
            }),
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            closeSocket();
            reject(new Error('feishu connection timed out'));
          }, 20000);
          cancelStartup = () => {
            clearTimeout(timer);
            reject(new Error('channel disposed'));
          };
          ws = new WSClient({
            appId: config.appId,
            appSecret: config.appSecret,
            domain: config.region === 'lark' ? Domain.Lark : Domain.Feishu,
            logger: sdkLogger,
            handshakeTimeoutMs: 10000,
            httpInstance: http,
            onReady: () => {
              clearTimeout(timer);
              if (closed) {
                reject(new Error('channel disposed'));
                return;
              }
              status = 'ready';
              resolve();
            },
            onError: () => {
              clearTimeout(timer);
              status = 'failed';
              reject(new Error('feishu connection failed'));
            },
            onReconnecting: () => {
              status = 'reconnecting';
            },
            onReconnected: () => {
              if (!closed) status = 'ready';
            },
          });
          void ws.start({ eventDispatcher: dispatcher }).catch(() => {
            clearTimeout(timer);
            reject(new Error('feishu startup failed'));
          });
        });
      } catch (error) {
        status = closed ? 'stopped' : 'failed';
        closeSocket();
        throw error;
      } finally {
        cancelStartup = undefined;
      }
    },
    async stop() {
      closed = true;
      status = 'stopped';
      cancelStartup?.();
      closeSocket();
      await Promise.allSettled([...active]);
    },
  };
}

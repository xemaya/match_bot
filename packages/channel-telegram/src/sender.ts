import type { OutboundMessage } from '@matchbot/db';
import { REACTION_CLEAR } from '@matchbot/domain';
import type { Logger } from '@matchbot/shared';
import { Api, GrammyError, type Bot } from 'grammy';
import { z } from 'zod';
import type { MessageEntity, ReactionTypeEmoji, User } from 'grammy/types';
import { formatRecommendation } from './recommendation-format.js';
import { approvalKeyboard } from './ops-card.js';

type ReactionEmoji = ReactionTypeEmoji['emoji'];

export class TelegramSendError extends Error {
  readonly deliveryState: 'not_sent' | 'unknown';
  readonly errorCode: string;
  readonly retryAfterSeconds: number | null;
  constructor(
    readonly outboundMessageId: string,
    cause: unknown,
    info?: {
      deliveryState: 'not_sent' | 'unknown';
      errorCode: string;
      retryAfterSeconds?: number | null;
    },
  ) {
    super(`telegram send failed for ${outboundMessageId}`, { cause });
    this.name = 'TelegramSendError';
    const parsed =
      cause instanceof GrammyError
        ? z
            .object({
              error_code: z.number().int(),
              parameters: z
                .object({ retry_after: z.number().int().nonnegative().max(3600).optional() })
                .optional(),
            })
            .safeParse(cause)
        : null;
    const definitive =
      parsed?.success && [400, 401, 403, 404, 429].includes(parsed.data.error_code);
    this.deliveryState = info?.deliveryState ?? (definitive ? 'not_sent' : 'unknown');
    this.errorCode =
      info?.errorCode ?? (parsed?.success ? 'telegram_' + parsed.data.error_code : 'network_error');
    this.retryAfterSeconds =
      info?.retryAfterSeconds ??
      (parsed?.success && parsed.data.error_code === 429
        ? Math.max(1, parsed.data.parameters?.retry_after ?? 1)
        : null);
  }
}

/**
 * 在正文前加上对作者的 @。有 username 用 `@name`（Telegram 自动识别为提及）；
 * 没有就用 text_mention 实体，显示名字、点开是该用户。
 * 实体偏移按 UTF-16 计，与 JS 字符串 length 一致。
 */
export function withMention(
  text: string,
  user: Pick<User, 'id' | 'first_name' | 'username'>,
): { text: string; entities?: MessageEntity[] } {
  if (user.username) return { text: `@${user.username} ${text}` };
  const name = user.first_name.trim() || 'Hi';
  return {
    text: `${name} ${text}`,
    entities: [
      {
        type: 'text_mention',
        offset: 0,
        length: name.length,
        user: { id: user.id, is_bot: false, first_name: user.first_name },
      },
    ],
  };
}

export type TelegramDeliveryResult =
  | { kind: 'message'; externalMessageId: string }
  | { kind: 'reaction'; externalMessageId: null }
  | { kind: 'not_started' };
const sentMessage = z.object({
  message_id: z.number().int().positive().safe(),
  chat: z.object({ id: z.number().int().safe() }),
});
const memberSchema = z.object({
  user: z.object({
    id: z.number().int().positive().safe(),
    first_name: z.string(),
    is_bot: z.boolean(),
    username: z.string().optional(),
  }),
});
export function createTelegramSender(p: { bot: Bot; logger: Logger }) {
  // Node grammY uses its own AbortSignal type; its supported client timeout avoids unsafe signal casts.
  if (p.bot.api instanceof Api)
    z.number()
      .positive()
      .max(30)
      .parse(p.bot.api.options?.timeoutSeconds ?? 500);
  /** 名字发送时现查，不从库里取：outbound 表只存 user id（AGENTS.md §6）。 */
  async function lookupUser(chatId: number, userId: string) {
    try {
      const user = memberSchema.parse(await p.bot.api.getChatMember(chatId, Number(userId))).user;
      return {
        id: user.id,
        first_name: user.first_name,
        ...(user.username ? { username: user.username } : {}),
      };
    } catch (e) {
      p.logger.warn(
        { errorKind: e instanceof Error ? e.name : 'unknown' },
        'mention lookup failed; sending as a plain reply',
      );
      return null;
    }
  }

  return {
    async send(
      m: OutboundMessage,
      options: { beforeSend: () => Promise<boolean> },
    ): Promise<TelegramDeliveryResult> {
      const chatId = Number(m.target);
      let externalStarted = false;
      try {
        if (!Number.isSafeInteger(chatId) || chatId === 0)
          throw new TelegramSendError(m.id, null, {
            deliveryState: 'not_sent',
            errorCode: 'invalid_target',
          });
        if (m.kind === 'reaction') {
          if (!m.replyToMessageId)
            throw new TelegramSendError(m.id, null, {
              deliveryState: 'not_sent',
              errorCode: 'invalid_reaction_target',
            });
          if (!(await options.beforeSend())) return { kind: 'not_started' };
          externalStarted = true;
          // P55: REACTION_CLEAR withdraws A2H's reaction (an ack 👀 that led to no reply).
          const result: unknown = await p.bot.api.setMessageReaction(
            chatId,
            Number(m.replyToMessageId),
            m.text === REACTION_CLEAR ? [] : [{ type: 'emoji', emoji: m.text as ReactionEmoji }],
          );
          if (result !== true)
            throw new TelegramSendError(m.id, null, {
              deliveryState: 'unknown',
              errorCode: 'invalid_receipt',
            });
          p.logger.info({ outboundMessageId: m.id }, 'reacted');
          return { kind: 'reaction', externalMessageId: null };
        }
        const isApproval = !!m.approvalRunStateId || !!m.requestKey?.startsWith('approval:');
        if (isApproval && !m.approvalRunStateId)
          throw new TelegramSendError(m.id, null, {
            deliveryState: 'not_sent',
            errorCode: 'invalid_approval_target',
          });
        const keyboard = isApproval ? approvalKeyboard(m.approvalRunStateId!) : null;
        const user =
          !isApproval && m.mentionUserId ? await lookupUser(chatId, m.mentionUserId) : null;
        const formatted = isApproval ? { text: m.text } : formatRecommendation(m.text, m.kind);
        const body = user ? withMention(formatted.text, user) : { text: formatted.text };
        const mentionLength = body.text.length - formatted.text.length;
        const entities = [
          ...(body.entities ?? []),
          ...(formatted.entities ?? []).map((entity) => ({
            ...entity,
            offset: entity.offset + mentionLength,
          })),
        ];
        if (!(await options.beforeSend())) return { kind: 'not_started' };
        externalStarted = true;
        const result: unknown = await p.bot.api.sendMessage(chatId, body.text, {
          link_preview_options: { is_disabled: true },
          ...(keyboard ? { reply_markup: keyboard } : {}),
          ...(entities.length ? { entities } : {}),
          ...(!isApproval && m.replyToMessageId
            ? {
                // 原消息被删了也照发，只是不挂在它下面
                reply_parameters: {
                  message_id: Number(m.replyToMessageId),
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        });
        const parsed = sentMessage.safeParse(result);
        if (!parsed.success || parsed.data.chat.id !== chatId)
          throw new TelegramSendError(m.id, null, {
            deliveryState: 'unknown',
            errorCode: 'invalid_receipt',
          });
        p.logger.info({ outboundMessageId: m.id }, 'sent');
        return { kind: 'message', externalMessageId: String(parsed.data.message_id) };
      } catch (e) {
        if (e instanceof TelegramSendError) throw e;
        throw externalStarted
          ? new TelegramSendError(m.id, e)
          : new TelegramSendError(m.id, e, {
              deliveryState: 'not_sent',
              errorCode: 'pre_send_failed',
              retryAfterSeconds: 5,
            });
      }
    },
  };
}

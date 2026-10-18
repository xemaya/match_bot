import { z } from 'zod';

export const CHANNELS = ['telegram', 'feishu', 'whatsapp'] as const;
export const channelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof channelSchema>;
const externalId = z.string().min(1).max(256);
/** Values come from the authenticated adapter configuration, never message text. */
export const channelAccountSchema = z.object({
  installationId: externalId,
  accountId: externalId,
  tenantId: externalId,
});
export type ChannelAccount = z.infer<typeof channelAccountSchema>;
export type ChannelAddress = {
  channel: Channel;
  account?: ChannelAccount | undefined;
  chatId: string;
  userId: string;
  threadId?: string | undefined;
  conversationType?: 'direct' | 'group' | undefined;
};

/** Empty scope is reserved for existing single-account installations only. */
export function accountScopeKey(account: ChannelAccount | undefined): string {
  if (!account) return '';
  const a = channelAccountSchema.parse(account);
  return JSON.stringify([a.installationId, a.accountId, a.tenantId]);
}
export function isDirectMessage(
  message: Pick<ChannelAddress, 'channel' | 'chatId' | 'userId' | 'conversationType'>,
): boolean {
  return message.conversationType !== undefined
    ? message.conversationType === 'direct'
    : message.channel === 'telegram' && message.chatId === message.userId;
}
export function conversationBindingKey(message: ChannelAddress): string {
  return JSON.stringify([
    message.channel,
    accountScopeKey(message.account),
    message.chatId,
    message.threadId ?? '',
    message.userId,
  ]);
}
export function inboundEventKey(
  message: ChannelAddress & { messageId: string; eventId?: string | undefined },
): string {
  return JSON.stringify([
    message.channel,
    accountScopeKey(message.account),
    message.chatId,
    message.eventId ?? message.messageId,
  ]);
}

export type DeliveryResult =
  | { kind: 'message'; externalMessageId: string }
  | { kind: 'reaction'; externalMessageId: string | null }
  | { kind: 'not_started' };

/** Transport-neutral failure; unknown delivery must never be retried as certainly unsent. */
export class ChannelSendError extends Error {
  constructor(
    readonly outboundMessageId: string,
    cause: unknown,
    readonly deliveryState: 'not_sent' | 'unknown',
    readonly errorCode: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`channel send failed for ${outboundMessageId}`, { cause });
    this.name = 'ChannelSendError';
  }
}

/** Persist only routing metadata, not duplicate message text or credentials. */
export const channelRouteSchema = z.object({
  account: channelAccountSchema.optional(),
  chatId: z.string().min(1),
  conversationType: z.enum(['direct', 'group']).optional(),
  threadId: z.string().min(1).optional(),
  eventId: z.string().min(1).optional(),
});
export function persistedChannelRoute(
  value: unknown,
): z.infer<typeof channelRouteSchema> | undefined {
  if (value === null || value === undefined) return undefined;
  return channelRouteSchema.parse(value);
}

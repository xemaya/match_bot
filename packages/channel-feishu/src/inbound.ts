import { inboundMessageSchema, type ChannelAccount, type InboundMessage } from '@matchbot/domain';
import { z } from 'zod';

const eventSchema = z.object({
  app_id: z.string().optional(),
  tenant_key: z.string().optional(),
  event_id: z.string().optional(),
  sender: z.object({
    sender_type: z.string(),
    sender_id: z.object({ open_id: z.string().min(1) }),
    tenant_key: z.string().optional(),
  }),
  message: z.object({
    message_id: z.string().min(1),
    chat_id: z.string().min(1),
    chat_type: z.enum(['p2p', 'group']),
    create_time: z.string().regex(/^\d+$/),
    message_type: z.string(),
    content: z.string(),
    parent_id: z.string().optional(),
    thread_id: z.string().optional(),
    mentions: z
      .array(z.object({ key: z.string().min(1), id: z.object({ open_id: z.string().optional() }) }))
      .optional(),
  }),
});
/** SDK EventDispatcher delivers decoded event fields, not a stringified webhook envelope. */
export function normalizeFeishuMessage(
  raw: unknown,
  config: { account: ChannelAccount; botOpenId: string },
): InboundMessage | null {
  const result = eventSchema.safeParse(raw);
  if (!result.success) return null;
  const e = result.data,
    m = e.message;
  if (
    e.sender.sender_type !== 'user' ||
    e.sender.sender_id.open_id === config.botOpenId ||
    m.message_type !== 'text'
  )
    return null;
  if (
    (e.app_id && e.app_id !== config.account.accountId) ||
    [e.tenant_key, e.sender.tenant_key].some((t) => t && t !== config.account.tenantId)
  )
    return null;
  let content: { text: string };
  try {
    content = z
      .object({ text: z.string().min(1).max(20000) })
      .parse(JSON.parse(m.content) as unknown);
  } catch {
    return null;
  }
  const mentions = (m.mentions ?? []).filter((v) => v.id.open_id === config.botOpenId);
  const text = mentions
    .reduce((body, mention) => body.replaceAll(mention.key, ''), content.text)
    .trim();
  const time = new Date(Number(m.create_time));
  if (!text || !Number.isFinite(time.getTime())) return null;
  return inboundMessageSchema.parse({
    channel: 'feishu',
    account: config.account,
    chatId: m.chat_id,
    userId: e.sender.sender_id.open_id,
    messageId: m.message_id,
    text,
    receivedAt: time.toISOString(),
    conversationType: m.chat_type === 'p2p' ? 'direct' : 'group',
    addressedToBot: m.chat_type === 'p2p' || mentions.length > 0,
    ...(e.event_id ? { eventId: e.event_id } : {}),
    ...(m.parent_id ? { replyToMessageId: m.parent_id } : {}),
    ...(m.thread_id ? { threadId: m.thread_id } : {}),
  });
}

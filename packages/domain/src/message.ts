import { channelAccountSchema, channelSchema } from './channel.js';
import { z } from 'zod';

/** 所有渠道适配器都必须产出这个形状。渠道差异到此为止。 */
export const inboundMessageSchema = z
  .object({
    channel: channelSchema,
    account: channelAccountSchema.optional(),
    eventId: z.string().min(1).max(256).optional(),
    conversationType: z.enum(['direct', 'group']).optional(),
    threadId: z.string().min(1).max(256).optional(),
    chatId: z.string(),
    messageId: z.string(),
    userId: z.string(),
    text: z.string(),
    lang: z.string().length(2).optional(), // ISO 639-1，渠道能给就给，否则由 Jev 判
    replyToMessageId: z.string().optional(),
    /** 消息是对 bot 说的：回复了 bot 的消息，或 @ 了 bot。这类消息是在接话，不按「是不是需求」过门。 */
    addressedToBot: z.boolean().optional(),
    /** 被回复的那条 bot 消息原文（bot 自己说的话，不是用户内容），给 agent 做接话上下文。 */
    replyToBotText: z.string().max(2000).optional(),
    receivedAt: z.string().datetime(), // UTC ISO 8601
  })
  .superRefine((message, ctx) => {
    if (message.channel === 'feishu' && (!message.account || !message.conversationType))
      ctx.addIssue({
        code: 'custom',
        message: 'Feishu requires authenticated account and conversation type',
      });
  });
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

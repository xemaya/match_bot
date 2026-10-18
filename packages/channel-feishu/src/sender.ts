import { createHash } from 'node:crypto';
import type { OutboundMessage } from '@matchbot/db';
import { ChannelSendError, type DeliveryResult } from '@matchbot/domain';
import { z } from 'zod';

export type FeishuSendRequest = {
  chatId: string;
  content: string;
  msgType: 'text' | 'interactive';
  uuid: string;
  replyToMessageId?: string;
  replyInThread: boolean;
};
const receiptSchema = z.object({
  code: z.number(),
  data: z.object({ message_id: z.string().min(1), chat_id: z.string().optional() }).optional(),
});
const escapeMention = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function createFeishuSender(p: {
  accountScope: string;
  send: (request: FeishuSendRequest) => Promise<unknown>;
  react?: (messageId: string, emoji: string) => Promise<unknown>;
}) {
  return {
    async send(
      m: OutboundMessage,
      options: { beforeSend: () => Promise<boolean> },
    ): Promise<DeliveryResult> {
      if (
        m.channel !== 'feishu' ||
        m.senderAccountId !== p.accountScope ||
        !/^oc_[A-Za-z0-9_-]+$/.test(m.target)
      )
        throw new ChannelSendError(m.id, null, 'not_sent', 'route_mismatch');
      const card = !!m.approvalRunStateId;
      let content: string;
      if (card) {
        content = JSON.stringify({
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: 'MatchBot 待审批回复' } },
          elements: [
            { tag: 'div', text: { tag: 'plain_text', content: m.text } },
            {
              tag: 'action',
              actions: ['approve', 'reject', 'ignore'].map((decision, index) => ({
                tag: 'button',
                text: { tag: 'plain_text', content: ['批准', '拒绝', '忽略'][index] },
                value: { kind: 'matchbot_approval', runStateId: m.approvalRunStateId, decision },
              })),
            },
          ],
        });
      } else {
        if (m.mentionUserId && !/^ou_[A-Za-z0-9_-]+$/.test(m.mentionUserId))
          throw new ChannelSendError(m.id, null, 'not_sent', 'invalid_mention');
        content = JSON.stringify({
          text:
            (m.mentionUserId ? `<at user_id="${m.mentionUserId}">用户</at> ` : '') +
            escapeMention(m.text),
        });
      }
      const emoji = { '👍': 'THUMBSUP', '🙏': 'THANKS', '❤️': 'HEART', '✅': 'DONE' }[m.text];
      if (m.kind === 'reaction' && (!emoji || !m.replyToMessageId || !p.react))
        throw new ChannelSendError(m.id, null, 'not_sent', 'unsupported_reaction');
      if (!(await options.beforeSend())) return { kind: 'not_started' };
      try {
        if (m.kind === 'reaction') {
          const result = z
            .object({ code: z.literal(0), data: z.object({ reaction_id: z.string().min(1) }) })
            .safeParse(await p.react!(m.replyToMessageId!, emoji!));
          if (!result.success) throw new ChannelSendError(m.id, null, 'unknown', 'invalid_receipt');
          return { kind: 'reaction', externalMessageId: null };
        }
        const result = receiptSchema.safeParse(
          await p.send({
            chatId: m.target,
            content,
            msgType: card ? 'interactive' : 'text',
            uuid: createHash('sha256').update(m.id).digest('hex').slice(0, 32),
            ...(!card && m.replyToMessageId ? { replyToMessageId: m.replyToMessageId } : {}),
            replyInThread: !card && !!m.threadId,
          }),
        );
        if (
          !result.success ||
          result.data.code !== 0 ||
          !result.data.data ||
          (result.data.data.chat_id && result.data.data.chat_id !== m.target)
        )
          throw new ChannelSendError(m.id, null, 'unknown', 'invalid_receipt');
        return { kind: 'message', externalMessageId: result.data.data.message_id };
      } catch (error) {
        if (error instanceof ChannelSendError) throw error;
        throw new ChannelSendError(m.id, error, 'unknown', 'network_error');
      }
    },
  };
}

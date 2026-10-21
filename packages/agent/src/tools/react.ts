import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { REACT } from '../prompts/tools/react.js';
import { makeOutboundTool } from './make-outbound-tool.js';

/** Telegram 允许 bot 使用的反应表情里，挑几个适合「收到 / 不客气」的。 */
export const REACTION_EMOJI = ['👍', '🙏', '❤', '👌'] as const;

/**
 * 给用户的消息加一个表情，代替一条文字回复。用于「谢谢」「好的」这类不需要回话的接话：
 * 真人在群里也这么做，有回应又不占屏。
 */
export function reactTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'react',
    description: REACT.description,
    parameters: z.object({ emoji: z.enum(REACTION_EMOJI) }),
    toDraft: (ctx, args: { emoji: (typeof REACTION_EMOJI)[number] }) =>
      Promise.resolve(
        ctx.source
          ? {
              kind: 'reaction' as const,
              target: ctx.chatId,
              text: args.emoji,
              supplierSummaries: [],
              inputRef: ctx.sourceMessageId,
              replyToMessageId: ctx.source.messageId,
            }
          : { error: REACT.feedback.unknownMessage },
      ),
  });
}

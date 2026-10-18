import { toInboundMessage } from '@matchbot/channel-telegram';
import { createChannelInboundHandler } from '@matchbot/channels';
import type { TelegramActorAllowlist } from '@matchbot/shared';
import type { Update } from 'grammy/types';

export function createInboundHandler(
  p: Parameters<typeof createChannelInboundHandler>[0] & {
    botId: number;
    actorAllowlist?: TelegramActorAllowlist;
    botUsername?: string | undefined;
  },
) {
  const admit = createChannelInboundHandler(p);
  return async (update: Update): Promise<void> => {
    const msg = toInboundMessage(update, {
      botId: p.botId,
      botUsername: p.botUsername,
      ...(p.actorAllowlist ? { actorAllowlist: p.actorAllowlist } : {}),
    });
    if (!msg) return;
    const chat = update.message?.chat;
    await admit(msg, chat && 'title' in chat && chat.title ? { title: chat.title } : {});
  };
}

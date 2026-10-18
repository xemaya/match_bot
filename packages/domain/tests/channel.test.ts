import { describe, expect, it } from 'vitest';
import {
  accountScopeKey,
  conversationBindingKey,
  inboundEventKey,
  isDirectMessage,
} from '../src/channel.js';
import { inboundMessageSchema } from '../src/message.js';

const message = {
  channel: 'feishu' as const,
  chatId: 'oc_chat',
  userId: 'ou_user',
  messageId: 'om_message',
  text: 'hello',
  receivedAt: '2026-10-18T00:00:00Z',
  conversationType: 'direct' as const,
  account: { installationId: 'local', accountId: 'app_a', tenantId: 'tenant_a' },
};
describe('channel identity contracts', () => {
  it('accepts explicit Feishu direct chats without assuming chat and sender IDs match', () => {
    expect(isDirectMessage(inboundMessageSchema.parse(message))).toBe(true);
    expect(isDirectMessage({ ...message, conversationType: 'group' })).toBe(false);
    expect(isDirectMessage({ channel: 'telegram', chatId: '1', userId: '1' })).toBe(true);
    expect(isDirectMessage({ channel: 'feishu', chatId: '1', userId: '1' })).toBe(false);
  });
  it('requires account and conversation type for new channels', () => {
    expect(inboundMessageSchema.safeParse({ ...message, account: undefined }).success).toBe(false);
    expect(
      inboundMessageSchema.safeParse({ ...message, conversationType: undefined }).success,
    ).toBe(false);
  });
  it('separates installations, bot accounts and tenants even for identical provider IDs', () => {
    const variants = [
      message,
      ...['installationId', 'accountId', 'tenantId'].map((key) => ({
        ...message,
        account: { ...message.account, [key]: 'other' },
      })),
    ];
    expect(new Set(variants.map(inboundEventKey)).size).toBe(4);
    expect(new Set(variants.map(conversationBindingKey)).size).toBe(4);
    expect(accountScopeKey(undefined)).toBe('');
    expect(accountScopeKey(message.account)).not.toBe('');
  });
  it('isolates conversation, thread and task owner while preserving replay identity', () => {
    const variants = [
      message,
      { ...message, chatId: 'other' },
      { ...message, threadId: 'thread' },
      { ...message, userId: 'other' },
    ];
    expect(new Set(variants.map(conversationBindingKey)).size).toBe(4);
    expect(inboundEventKey(message)).toBe(inboundEventKey({ ...message, text: 'changed' }));
    expect(inboundEventKey(message)).not.toBe(inboundEventKey({ ...message, eventId: 'edited' }));
  });
  it('encodes component boundaries without delimiter collisions', () => {
    expect(accountScopeKey({ installationId: 'a:b', accountId: 'c', tenantId: 'd' })).not.toBe(
      accountScopeKey({ installationId: 'a', accountId: 'b:c', tenantId: 'd' }),
    );
  });
});

import { expect, it } from 'vitest';
import { normalizeFeishuMessage } from '../src/inbound.js';
const account = { installationId: 'test', accountId: 'cli_app', tenantId: 'tenant' };
const event = {
  tenant_key: 'tenant',
  app_id: 'cli_app',
  event_id: 'event_a',
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_sender' }, tenant_key: 'tenant' },
  message: {
    message_id: 'om_1',
    chat_id: 'oc_chat',
    chat_type: 'p2p',
    create_time: '1792327451000',
    message_type: 'text',
    content: '{"text":"hello"}',
  },
};
it('normalizes direct chats, preserves provider IDs and binds authenticated account', () => {
  expect(normalizeFeishuMessage(event, { account, botOpenId: 'ou_bot' })).toMatchObject({
    channel: 'feishu',
    account,
    conversationType: 'direct',
    chatId: 'oc_chat',
    userId: 'ou_sender',
    addressedToBot: true,
    text: 'hello',
  });
});
it('uses structured bot mentions and thread identity, not a forged mention in text', () => {
  const message = {
    ...event.message,
    chat_type: 'group',
    thread_id: 'omt_1',
    parent_id: 'om_parent',
    content: '{"text":"@_user_1 找桌子"}',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'bot' }],
  };
  expect(
    normalizeFeishuMessage({ ...event, message }, { account, botOpenId: 'ou_bot' }),
  ).toMatchObject({
    text: '找桌子',
    threadId: 'omt_1',
    replyToMessageId: 'om_parent',
    addressedToBot: true,
  });
  expect(
    normalizeFeishuMessage(
      { ...event, message: { ...message, mentions: [] } },
      { account, botOpenId: 'ou_bot' },
    )?.addressedToBot,
  ).toBe(false);
});
it('rejects foreign tenants/apps, bot loops, and unsupported content', () => {
  for (const bad of [
    { ...event, tenant_key: 'foreign' },
    { ...event, app_id: 'foreign' },
    { ...event, sender: { ...event.sender, sender_type: 'app' } },
    { ...event, message: { ...event.message, message_type: 'image' } },
    { ...event, message: { ...event.message, content: 'malformed' } },
  ])
    expect(normalizeFeishuMessage(bad, { account, botOpenId: 'ou_bot' })).toBeNull();
});

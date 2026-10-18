import { beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({
  ready: true,
  close: vi.fn(),
  create: vi.fn(() => Promise.resolve({ code: 0, data: { message_id: 'om_sent' } })),
  handlers: new Map<string, (raw: unknown) => Promise<unknown>>(),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  defaultHttpInstance: {},
  Client: class {
    request = () => Promise.resolve({ code: 0, bot: { open_id: 'ou_bot' } });
    im = {
      message: { create: fake.create, reply: fake.create },
      messageReaction: { create: fake.create },
    };
  },
  EventDispatcher: class {
    register(handlers: Record<string, (raw: unknown) => Promise<unknown>>) {
      fake.handlers = new Map(Object.entries(handlers));
      return this;
    }
  },
  WSClient: class {
    constructor(private options: { onReady: () => void }) {}
    start() {
      if (fake.ready) this.options.onReady();
      return Promise.resolve();
    }
    close = fake.close;
  },
}));
import { createFeishuConnection } from '../src/connection.js';
const config = {
  installationId: 'test',
  appId: 'app',
  appSecret: 'test-only',
  tenantId: 'tenant',
  region: 'feishu' as const,
  allowedUsers: ['ou_user'],
  allowedChats: [],
  requireMention: true,
};
const logger = { warn: vi.fn() } as never;
const event = {
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' }, tenant_key: 'tenant' },
  message: {
    message_id: 'om_input',
    chat_id: 'oc_dm',
    chat_type: 'p2p',
    message_type: 'text',
    content: '{"text":"hello"}',
    create_time: '1792327451000',
  },
};
beforeEach(() => {
  fake.ready = true;
  vi.clearAllMocks();
});
it('waits for authenticated identity/ready and drains accepted callbacks on disposal', async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const onMessage = vi.fn(() => pending);
  const channel = createFeishuConnection({
    config,
    logger,
    onMessage,
    onApproval: () => Promise.resolve(false),
  });
  await channel.start();
  expect(channel.status()).toMatchObject({ state: 'ready', botOpenId: 'ou_bot' });
  const callback = fake.handlers.get('im.message.receive_v1')!(event);
  expect(onMessage).toHaveBeenCalledOnce();
  const stopped = vi.fn();
  const stop = channel.stop().then(stopped);
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  complete();
  await callback;
  await stop;
  expect(fake.close).toHaveBeenCalled();
  await expect(fake.handlers.get('im.message.receive_v1')!(event)).rejects.toThrow('stopped');
});
it('uses explicit sender/chat allowlists and rejects unrecognized approval payloads', async () => {
  const onMessage = vi.fn(() => Promise.resolve()),
    onApproval = vi.fn(() => Promise.resolve(true));
  const channel = createFeishuConnection({ config, logger, onMessage, onApproval });
  await channel.start();
  await fake.handlers.get('im.message.receive_v1')!({
    ...event,
    sender: { ...event.sender, sender_id: { open_id: 'ou_foreign' } },
  });
  expect(onMessage).not.toHaveBeenCalled();
  await fake.handlers.get('card.action.trigger')!({ action: { value: 'forged' } });
  expect(onApproval).not.toHaveBeenCalled();
  await channel.stop();
});
it('cancels a pending start promptly when the plugin unloads', async () => {
  fake.ready = false;
  const channel = createFeishuConnection({
    config,
    logger,
    onMessage: () => Promise.resolve(),
    onApproval: () => Promise.resolve(false),
  });
  const start = channel.start();
  const rejected = expect(start).rejects.toThrow('disposed');
  await Promise.resolve();
  await channel.stop();
  await rejected;
  expect(channel.status().state).toBe('stopped');
});

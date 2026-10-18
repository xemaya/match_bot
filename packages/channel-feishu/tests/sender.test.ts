import { expect, it, vi } from 'vitest';
import { createFeishuSender } from '../src/sender.js';
const message = {
  id: 'out-1',
  channel: 'feishu',
  target: 'oc_chat',
  text: 'source <test>',
  kind: 'recommendation',
  replyToMessageId: 'om_in',
  threadId: 'omt_thread',
  senderAccountId: 'scope',
};
it('checks the fence before sending and preserves reply/thread plus a stable idempotency key', async () => {
  const send = vi.fn(() =>
    Promise.resolve({ code: 0, data: { message_id: 'om_out', chat_id: 'oc_chat' } }),
  );
  const sender = createFeishuSender({ accountScope: 'scope', send });
  expect(await sender.send(message as never, { beforeSend: () => Promise.resolve(false) })).toEqual(
    { kind: 'not_started' },
  );
  expect(send).not.toHaveBeenCalled();
  expect(await sender.send(message as never, { beforeSend: () => Promise.resolve(true) })).toEqual({
    kind: 'message',
    externalMessageId: 'om_out',
  });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: 'oc_chat',
      replyToMessageId: 'om_in',
      replyInThread: true,
      uuid: expect.any(String) as unknown,
    }),
  );
});
it('rejects cross-account delivery before network calls', async () => {
  const send = vi.fn();
  await expect(
    createFeishuSender({ accountScope: 'other', send }).send(message as never, {
      beforeSend: () => Promise.resolve(true),
    }),
  ).rejects.toMatchObject({ deliveryState: 'not_sent', errorCode: 'route_mismatch' });
  expect(send).not.toHaveBeenCalled();
});
it('keeps a transport timeout or malformed receipt unknown rather than safe to retry', async () => {
  for (const send of [
    () => Promise.reject(new Error('timeout')),
    () => Promise.resolve({ code: 0 }),
  ]) {
    await expect(
      createFeishuSender({ accountScope: 'scope', send }).send(message as never, {
        beforeSend: () => Promise.resolve(true),
      }),
    ).rejects.toMatchObject({ deliveryState: 'unknown' });
  }
});

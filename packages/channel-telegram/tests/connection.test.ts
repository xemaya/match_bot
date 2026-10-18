import { expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({
  running: false,
  stopped: vi.fn(),
  onStart: undefined as (() => void) | undefined,
  finish: undefined as (() => void) | undefined,
}));
vi.mock('grammy', () => ({
  Api: class {},
  Bot: class {
    api = { getMe: () => Promise.resolve({ id: 123, username: 'testbot' }) };
    catch() {}
    on() {}
    start(options: { onStart: () => void }) {
      fake.running = true;
      fake.onStart = options.onStart;
      return new Promise<void>((resolve) => {
        fake.finish = resolve;
      });
    }
    isRunning() {
      return fake.running;
    }
    stop() {
      fake.stopped();
      fake.running = false;
      fake.finish?.();
      return Promise.resolve();
    }
  },
  GrammyError: class extends Error {},
  HttpError: class extends Error {},
}));
import { createTelegramConnection } from '../src/connection.js';

it('bounds startup and releases polling when onStart never arrives', async () => {
  vi.useFakeTimers();
  try {
    const connection = createTelegramConnection({
      token: 'test',
      installationId: 'local',
      logger: { warn: vi.fn() } as never,
      onMessage: () => Promise.resolve(),
      onApproval: () => Promise.resolve(false),
    });
    const start = connection.start();
    const rejected = expect(start).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20001);
    await rejected;
    await connection.stop();
    expect(fake.stopped).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

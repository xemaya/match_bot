import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ start: vi.fn(), load: vi.fn() }));
vi.mock('@matchbot/host', () => ({ startMatchBotHost: state.start }));
vi.mock('@matchbot/shared', () => ({ loadEnv: state.load }));
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/index.js';

describe('DSH Cordis lifecycle', () => {
  it('loads and awaits cleanup on real Cordis disposal', async () => {
    const stop = vi.fn(async () => {
      await Promise.resolve();
    });
    state.start.mockResolvedValue({ stop });
    state.load.mockReturnValue({});
    const ctx = new Context();
    const fork = ctx.plugin(plugin, { enabled: true });
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    await fork.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('disabled plugin does not read credentials or connect', async () => {
    state.start.mockClear();
    state.load.mockClear();
    const ctx = new Context();
    const fork = ctx.plugin(plugin, { enabled: false });
    await fork.dispose();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });
});

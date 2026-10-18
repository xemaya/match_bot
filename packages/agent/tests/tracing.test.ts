import { describe, expect, it, vi } from 'vitest';
import { createTraceProcessor } from '../src/tracing.js';

function deps() {
  return {
    traces: { create: vi.fn(() => Promise.resolve({})), listByKind: vi.fn() },
    logger: { error: vi.fn() },
  };
}

function turnSpan(over: Record<string, unknown> = {}) {
  return {
    spanData: {
      type: 'turn',
      turn: 1,
      agent_name: 'matchAgent',
      usage: { input_tokens: 1000, output_tokens: 200 },
    },
    traceId: 't1',
    spanId: 's1',
    startedAt: '2026-09-25T10:00:00.000Z',
    endedAt: '2026-09-25T10:00:01.500Z',
    traceMetadata: { phase: '1' },
    ...over,
  } as never;
}

describe('createTraceProcessor', () => {
  it('attributes non-DeepSeek usage without applying the DeepSeek price estimate', async () => {
    const d = deps(),
      proc = createTraceProcessor(d as never);
    await proc.onSpanEnd(
      turnSpan({ traceMetadata: { phase: '2', model: 'gpt-6.1-sol', inputRef: 'new-provider' } }),
    );
    expect(d.traces.create).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicro: 0,
        output: expect.objectContaining({
          model: 'gpt-6.1-sol',
          costEstimateAvailable: false,
          inputTokens: 1000,
          outputTokens: 200,
        }) as unknown,
      }),
    );
  });
  it('links task model calls to the input without retaining model text', async () => {
    const d = deps();
    const proc = createTraceProcessor(d as never);
    await proc.onSpanEnd(
      turnSpan({ traceMetadata: { phase: '2', inputRef: 'message-a', taskId: 'task-a' } }),
    );
    expect(d.traces.create).toHaveBeenCalledWith(
      expect.objectContaining({
        inputRef: 'message-a',
        output: expect.objectContaining({ taskId: 'task-a', sdkTraceRef: 't1/s1' }) as unknown,
      }),
    );
  });
  it('waits for outstanding persistence when the SDK flushes or shuts down', async () => {
    const d = deps();
    let finish: (() => void) | undefined;
    d.traces.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    const proc = createTraceProcessor(d as never);
    const write = proc.onSpanEnd(turnSpan());
    let flushed = false;
    const flush = proc.forceFlush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    finish?.();
    await write;
    await flush;
    await proc.shutdown();
    expect(flushed).toBe(true);
  });
  it('writes one agent_run trace per turn span with usage-derived cost (PoC V6)', async () => {
    const d = deps();
    const proc = createTraceProcessor(d as never);
    await proc.onSpanEnd(turnSpan());
    expect(d.traces.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent_run',
        inputRef: 't1/s1',
        phase: 1,
        latencyMs: 1500,
        costMicro: 196, // 1000 * 0.14 + 200 * 0.28
      }),
    );
    const call = (d.traces.create.mock.calls[0] as unknown[])[0] as {
      output: { inputTokens: number; outputTokens: number; agentName: string };
    };
    expect(call.output).toEqual({
      turn: 1,
      agentName: 'matchAgent',
      inputTokens: 1000,
      outputTokens: 200,
    });
  });

  it('ignores non-turn spans (usage lives on turn spans, not generation)', async () => {
    const d = deps();
    const proc = createTraceProcessor(d as never);
    await proc.onSpanEnd(
      turnSpan({ spanData: { type: 'generation', usage: { input_tokens: 5 } } }),
    );
    await proc.onSpanEnd(turnSpan({ spanData: { type: 'function', name: 'reply_in_group' } }));
    expect(d.traces.create).not.toHaveBeenCalled();
  });

  it('swallows persistence errors and logs them (SDK does not await onSpanEnd)', async () => {
    const d = deps();
    d.traces.create.mockRejectedValueOnce(new Error('db down'));
    const proc = createTraceProcessor(d as never);
    await expect(proc.onSpanEnd(turnSpan())).resolves.toBeUndefined();
    expect(d.logger.error).toHaveBeenCalled();
  });
});

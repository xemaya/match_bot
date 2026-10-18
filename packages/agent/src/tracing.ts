import type { Repositories } from '@matchbot/db';
import type { Phase } from '@matchbot/domain';
import type { Logger } from '@matchbot/shared';
import type { TracingProcessor } from '@openai/agents';

// deepseek-flash 定价（USD / 1M tokens，写库单位是 1e-6 USD/token）；以 DeepSeek 官网为准，变动时改这里
const PRICE_IN_MICRO_PER_TOKEN = 0.14;
const PRICE_OUT_MICRO_PER_TOKEN = 0.28;

interface TurnSpanData {
  type: string;
  turn?: number;
  agent_name?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toPhase(raw: unknown): Phase {
  const n = Number(raw);
  return n === 1 || n === 2 ? n : 0;
}

/**
 * 把 SDK 的 span 落成 decision_traces（kind = agent_run，AGENTS.md §3.3 第 2、9 条）。
 * PoC V6 实测结论：
 * - token usage 在 `turn` span 上（不在 generation），所以一行 trace = 一个模型 turn；
 * - latency 在 span.startedAt/endedAt，不在 spanData；
 * - SDK 不 await onSpanEnd 且吞异常，所以这里自己 try/catch；
 * - phase 由 runner 的 RunConfig.traceMetadata 注入，从 span.traceMetadata 读；
 * - spanData 含原文与思维链，落库只取 usage 等计数字段，不存文本（§3.3 第 11 条）。
 */
export function createTraceProcessor(p: {
  traces: Repositories['traces'];
  logger: Logger;
}): TracingProcessor {
  const pending = new Set<Promise<void>>();
  const flush = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  const recordSpan = async (span: Parameters<TracingProcessor['onSpanEnd']>[0]) => {
    try {
      const data = span.spanData as TurnSpanData;
      if (data.type !== 'turn') return;
      const usage = data.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const model: unknown = span.traceMetadata?.['model'];
      const hasPrice = model === undefined || model === 'deepseek-flash';
      const costMicro = hasPrice
        ? Math.round(
            inputTokens * PRICE_IN_MICRO_PER_TOKEN + outputTokens * PRICE_OUT_MICRO_PER_TOKEN,
          )
        : 0;
      const latencyMs =
        span.startedAt && span.endedAt
          ? Math.max(0, Date.parse(span.endedAt) - Date.parse(span.startedAt))
          : 0;
      const inputRef: unknown = span.traceMetadata?.['inputRef'];
      const taskId: unknown = span.traceMetadata?.['taskId'];
      await p.traces.create({
        kind: 'agent_run',
        inputRef: typeof inputRef === 'string' ? inputRef : `${span.traceId}/${span.spanId}`,
        output: {
          turn: data.turn ?? null,
          agentName: data.agent_name ?? null,
          inputTokens,
          outputTokens,
          ...(typeof model === 'string' ? { model, costEstimateAvailable: hasPrice } : {}),
          ...(typeof inputRef === 'string'
            ? { sdkTraceRef: `${span.traceId}/${span.spanId}` }
            : {}),
          ...(typeof taskId === 'string' ? { taskId } : {}),
        },
        phase: toPhase(span.traceMetadata?.['phase']),
        latencyMs,
        costMicro,
      });
    } catch (err) {
      p.logger.error(
        { errorKind: err instanceof Error ? err.name : 'unknown_error' },
        'decision-trace processor failed to record turn span',
      );
    }
  };
  return {
    async onTraceStart() {},
    async onTraceEnd() {},
    async onSpanStart() {},
    onSpanEnd(span) {
      const write = recordSpan(span);
      pending.add(write);
      void write.then(() => pending.delete(write));
      return write;
    },
    shutdown: flush,
    forceFlush: flush,
  };
}

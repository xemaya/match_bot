/** Bounded real-model worker replay with synthetic users and local delivery receipts. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadEnv } from '../../../packages/shared/src/index.js';
import { getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
import { createMatchAgent, AGENT_VERSION } from '../../../packages/agent/src/index.js';
import { buildDeps } from '../../../apps/worker/src/deps.js';
import { processInbound } from '../../../apps/worker/src/pipeline/inbound.js';
import { drainOutbound } from '../../../apps/bot/src/outbound-loop.js';

const env = loadEnv();
const { values } = parseArgs({
  options: {
    scenarios: { type: 'string', default: 'gp,printer,family' },
    budget: { type: 'string', default: '300000' },
  },
});
const selected = z
  .array(z.enum(['gp', 'printer', 'family']))
  .min(1)
  .max(3)
  .parse(values.scenarios!.split(','));
const limit = z.coerce.number().int().min(1000).max(300000).parse(values.budget);
const db = new URL(env.DATABASE_URL);
if (db.hostname !== '127.0.0.1' || db.pathname !== '/matchbot_p41_live')
  throw new Error('dedicated_local_database_required');
if (env.DEEPSEEK_MODEL !== 'gpt-6.1-sol' || env.GENERATION_REASONING_EFFORT !== 'low')
  throw new Error('unexpected_model_configuration');
const root = `logs/real-model/local-${Date.now()}`;
mkdirSync(root, { recursive: true, mode: 0o700 });
const deps = buildDeps({ env });
const prisma = getPrisma(env.DATABASE_URL);
const provider = createMatchAgent(deps, { phase: 0 }).runner.config.modelProvider;
const report = {
  version: AGENT_VERSION,
  model: env.DEEPSEEK_MODEL,
  reasoning: env.GENERATION_REASONING_EFFORT,
  transport: 'simulated; no Telegram API',
  startedAt: new Date().toISOString(),
  limit,
  used: 0,
  uncertain: false,
  state: 'running',
  calls: [] as Array<Record<string, unknown>>,
  budgetStops: [] as Array<Record<string, unknown>>,
  modelErrors: [] as Array<Record<string, unknown>>,
  turns: [] as Array<Record<string, unknown>>,
};
const save = () =>
  writeFileSync(`${root}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + '\n');
const prior: Array<{ chunks: string[]; tokens: number }> = [];
let current = '',
  blocked = false;
deps.modelProvider = {
  getModel: async (name) => {
    const model = await provider.getModel(name);
    return {
      getStreamedResponse: () => {
        throw new Error('streaming_disabled');
      },
      getResponse: async (request) => {
        const chunks = [
          ...(request.systemInstructions ?? '').split('\n'),
          ...request.tools.map((tool) => JSON.stringify(tool)),
          ...(typeof request.input === 'string'
            ? [request.input]
            : request.input.map((item) => JSON.stringify(item))),
        ];
        let reserve =
          Buffer.byteLength(
            JSON.stringify({
              instructions: request.systemInstructions,
              input: request.input,
              tools: request.tools,
            }),
          ) + 12000;
        for (const previous of prior) {
          const remaining = new Map<string, number>();
          for (const chunk of previous.chunks)
            remaining.set(chunk, (remaining.get(chunk) ?? 0) + 1);
          let added = 0;
          for (const chunk of chunks) {
            const n = remaining.get(chunk) ?? 0;
            if (n) remaining.set(chunk, n - 1);
            else added += Buffer.byteLength(chunk);
          }
          reserve = Math.min(
            reserve,
            previous.tokens + added + 64 * (chunks.length + previous.chunks.length) + 12000,
          );
        }
        if (report.uncertain || reserve > report.limit - report.used || report.calls.length >= 45) {
          blocked = true;
          report.budgetStops.push({
            turn: current,
            reserve,
            remaining: report.limit - report.used,
            uncertain: report.uncertain,
          });
          save();
          const error = new Error('local_test_budget_stop');
          error.name = 'ModelBudgetError';
          throw error;
        }
        report.uncertain = true;
        save();
        const start = Date.now();
        const response = await model
          .getResponse({
            ...request,
            modelSettings: { ...request.modelSettings, maxTokens: 2400 },
          })
          .catch((error: unknown) => {
            let message = error instanceof Error ? error.message : 'unknown';
            for (const [key, value] of Object.entries(env))
              if (/KEY|TOKEN/.test(key) && typeof value === 'string' && value.length > 3)
                message = message.split(value).join('[REDACTED]');
            report.modelErrors.push({
              turn: current,
              kind: error instanceof Error ? error.name : 'unknown',
              message: message.slice(0, 2000),
            });
            save();
            throw error;
          });
        const inputTokens = response.usage.inputTokens,
          outputTokens = response.usage.outputTokens;
        if (!Number.isFinite(inputTokens + outputTokens) || inputTokens + outputTokens <= 0)
          throw new Error('usage_missing');
        report.used += inputTokens + outputTokens;
        report.uncertain = false;
        prior.push({ chunks, tokens: inputTokens });
        const tools = response.output
          .filter((item) => item.type === 'function_call')
          .map((item) => ({ name: item.name, arguments: item.arguments }));
        report.calls.push({
          turn: current,
          inputTokens,
          outputTokens,
          ms: Date.now() - start,
          tools,
        });
        save();
        emit({
          event: 'model_call',
          turn: current,
          used: report.used,
          tools: tools.map((t) => t.name),
        });
        return response;
      },
    };
  },
};
const cases = [
  {
    id: 'gp',
    messages: [
      '住E14怎么注册GP？我没有NHS number',
      '我也没有水电账单，想全程线上办，官方注册入口要从哪里进去？',
    ],
  },
  {
    id: 'printer',
    messages: ['E14想收激光打印机，60镑以内', '打印机必须能无线打印，这台支持吗？'],
  },
  {
    id: 'family',
    messages: [
      '2026年10月24日周六下午伦敦看展有什么推荐？预算20镑',
      '我是带一个5岁孩子，一大一小门票合计最多20镑。这个展当天能看、孩子该买哪档票，能再确认一下吗？',
    ],
  },
];
let messageId = Date.now();
const batchStart = Date.now();
save();
emit({ event: 'started', root, version: AGENT_VERSION });
try {
  outer: for (const scenario of cases) {
    if (!selected.includes(scenario.id as 'gp' | 'printer' | 'family')) continue;
    const userId = String(randomInt(100000000, 999999999));
    let replyToMessageId: string | undefined;
    for (const [i, text] of scenario.messages.entries()) {
      if (blocked || report.uncertain || Date.now() - batchStart > 1200000) break outer;
      current = `${scenario.id}-${i + 1}`;
      const since = new Date(),
        usedBefore = report.used;
      const replies: Array<{ kind: string; text: string }> = [];
      emit({ event: 'turn_started', turn: current });
      const result = await processInbound(deps, {
        channel: 'telegram',
        chatId: userId,
        userId,
        messageId: String(++messageId),
        text,
        receivedAt: since.toISOString(),
        addressedToBot: true,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      await drainOutbound({
        repos: deps.repos,
        logger: deps.logger,
        defaultPhase: 2,
        opsChatId: env.TELEGRAM_OPS_CHAT_ID,
        sender: {
          send: async (message, options) => {
            if (!(await options.beforeSend())) return { kind: 'not_started' };
            if (message.target !== userId) throw new Error('unexpected_local_recipient');
            const externalMessageId = String(++messageId);
            replies.push({ kind: message.kind, text: message.text });
            if (message.kind !== 'reaction') replyToMessageId = externalMessageId;
            return message.kind === 'reaction'
              ? { kind: 'reaction', externalMessageId: null }
              : { kind: 'message', externalMessageId };
          },
        },
      });
      const tasks = await prisma.task.findMany({
        where: { chatId: userId },
        select: { id: true, status: true, state: true },
      });
      const traces = await prisma.decisionTrace.findMany({
        where: { createdAt: { gte: since } },
        select: { kind: true, output: true, latencyMs: true },
      });
      report.turns.push({
        turn: current,
        text,
        replies,
        tasks,
        traces,
        result,
        used: report.used - usedBefore,
        ms: Date.now() - since.getTime(),
      });
      save();
      emit({ event: 'turn_finished', turn: current, replies: replies.length, used: report.used });
    }
  }
  report.state = blocked
    ? 'budget_stopped'
    : report.uncertain
      ? 'uncertain_call_stopped'
      : 'finished';
} catch (error) {
  report.state = 'error';
  emit({ event: 'error', kind: error instanceof Error ? error.name : 'unknown' });
  process.exitCode = 1;
} finally {
  save();
  await disconnectPrisma();
  emit({ event: 'finished', state: report.state, used: report.used, root });
}

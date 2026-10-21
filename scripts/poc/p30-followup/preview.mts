/** Small predeclared cohort: real model/Jev, isolated DB, no Telegram or other outbound transport. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AGENT_VERSION,
  configureModelProvider,
  createTraceProcessor,
  runInbound,
} from '../../../packages/agent/src/index.js';
import type { AgentDeps, MatchContext } from '../../../packages/agent/src/context.js';
import { createRepositories, getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
import { createJevClient, evaluateOutbound } from '../../../packages/jev/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import type { KnowledgeSearchResult } from '../../../packages/websearch/src/index.js';
const sample = 'context';
const output = z
  .string()
  .regex(/^\/tmp\/matchbot-p30-[a-z0-9-]+\.json$/)
  .parse(process.argv[2]);
const env = loadEnv(),
  url = new URL(env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/matchbot_task_preview')
  throw new Error('isolated preview DB required');
const logger = createLogger('p30-preview', 'silent'),
  p = getPrisma(env.DATABASE_URL),
  repos = createRepositories(p);
const processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const inputs = ['狗岛找止疼药', '现在急用，但我出不了门', '头痛'];
const queries: unknown[] = [],
  results: unknown[] = [];
const frozen = [
  {
    title: 'NHS medicines information',
    url: 'https://www.nhs.uk/tests-and-treatments/medicines-information',
    text: 'Simple painkillers can be bought directly from supermarkets and other stores. This fixture provides general purchasing information, not advice on which medicine is suitable for an individual.',
  },
  {
    title: 'Docklands Pharmacy',
    url: 'https://docklandspharmacy.co.uk',
    text: 'Docklands Pharmacy is an NHS community pharmacy. It advertises free prescription delivery to local postcodes E14 and some others. Contact the pharmacy for details. This fixture does not confirm non-prescription painkiller delivery, stock or same-day service.',
  },
];
const deps: AgentDeps = {
  env,
  repos,
  logger,
  answerRequests: true,
  taskRequests: true,
  thresholds: DEFAULT_THRESHOLDS,
  evaluateOutbound,
  jev: createJevClient({
    baseUrl: env.JEV_BASE_URL,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL,
    traces: repos.traces,
    logger,
    timeoutMs: 10000,
    maxRetries: 0,
  }),
  marketSearch: {
    find: async () => {
      throw new Error('wrong retail route');
    },
    detail: async () => {
      throw new Error('wrong retail route');
    },
  },
  webSearch: {
    find: async () => [],
    research: async (args) => {
      queries.push(args);
      return Promise.resolve({ status: 'ok', sources: frozen } satisfies KnowledgeSearchResult);
    },
  },
};
const hash = createHash('sha256');
for (const file of readdirSync('packages/agent/src', { recursive: true, encoding: 'utf8' })
  .filter((n) => n.endsWith('.ts'))
  .sort())
  hash.update(file).update(readFileSync('packages/agent/src/' + file));
hash.update(readFileSync('packages/agent/prompts/voice/soul.md'));
const fingerprint = hash.digest('hex'),
  runId = randomUUID(),
  started = Date.now();
const save = (status: string) =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        sample,
        agentVersion: AGENT_VERSION,
        sourceFingerprint: fingerprint,
        status,
        elapsedMs: Date.now() - started,
        boundary:
          'synthetic user and bounded sources, NOT live facts; real DeepSeek/Jev; isolated DB; outbox pending, explicit simulated task receipts; NO sender',
        queries,
        results,
      },
      null,
      2,
    ) + '\n',
  );
const watchdog = setTimeout(() => {
  save('timeout');
  process.exit(2);
}, 180000);
try {
  const user = await repos.users.upsertByExternal({
    channel: 'telegram',
    externalId: 'p30-' + runId,
  });
  const group = await repos.groups.upsert({
    channel: 'telegram',
    externalId: '-p30-' + runId,
    name: 'synthetic access preview',
  });
  let previousTask: string | undefined;
  for (const [index, input] of inputs.entries()) {
    const accepted = await repos.executions.accept({
      userId: user.id,
      groupId: group.id,
      phase: 2,
      message: {
        channel: 'telegram',
        userId: user.externalId,
        chatId: group.externalId,
        messageId: 'turn-' + index,
        text: input,
        receivedAt: new Date().toISOString(),
        addressedToBot: true,
      },
    });
    const claim = await repos.executions.claim({ userId: user.id, messageId: accepted.message.id });
    if (claim.kind !== 'acquired') throw new Error('claim not acquired');
    const ctx: MatchContext = {
      execution: claim.lease,
      userId: user.id,
      chatId: group.externalId,
      channel: 'telegram',
      groupId: group.id,
      phase: 2,
      sourceMessageId: accepted.message.id,
      recentReplies: [],
      addressedToBot: true,
      requestCategory: 'other',
    };
    const result = await runInbound({ deps, ctx, input });
    await processor.forceFlush();
    await repos.executions.finish({
      lease: claim.lease,
      status: result.kind === 'interrupted' ? 'waiting_approval' : 'completed',
      ...(result.kind === 'interrupted' ? { runStateId: result.runStateId } : {}),
    });
    const drafts = await p.outboundMessage.findMany({
      where: { sourceMessageId: accepted.message.id },
      select: { text: true, status: true },
    });
    const traces = await p.decisionTrace.findMany({
      where: { inputRef: accepted.message.id },
      orderBy: { createdAt: 'asc' },
    });
    const text = drafts[0]?.text ?? '';
    const checks = {
      sameTask: !!ctx.task && (!previousTask || ctx.task.id === previousTask),
      ...(index < 2
        ? {
            oneSubstantiveAnswer:
              drafts.length === 1 &&
              drafts[0]?.status === 'pending' &&
              text.includes('https://') &&
              !traces.some(
                (t) =>
                  t.kind === 'gate' && (t.output as { gate?: string }).gate === 'request_status',
              ),
          }
        : {
            quiet: drafts.length === 0,
            explicitNoop: !!ctx.replySuppressed,
            notNewTask: ctx.taskUpdate?.kind === 'continued',
          }),
    };
    let simulatedReceipt = false;
    if (ctx.task && drafts.length === 1) {
      const current = await repos.tasks.findById({
        access: { userId: user.id, scope: { channel: 'telegram', chatId: group.externalId } },
        id: ctx.task.id,
      });
      if (current?.delivery.status === 'queued' && current.delivery.outboundMessageId) {
        const saved = await repos.tasks.recordDeliveryReceipt({
          access: { userId: user.id, scope: { channel: 'telegram', chatId: group.externalId } },
          id: current.id,
          expectedRevision: current.revision,
          operationKey: 'synthetic-receipt-' + index,
          outboundMessageId: current.delivery.outboundMessageId,
          requirementsVersion: current.requirementsVersion,
          status: 'sent',
        });
        simulatedReceipt = saved.kind === 'applied';
      }
    }
    previousTask = ctx.task?.id;
    results.push({
      index,
      input,
      result,
      task: ctx.task,
      knowledge: ctx.knowledgeSources,
      checks,
      simulatedReceipt,
      drafts,
      traces,
      usage: traces
        .filter((t) => t.kind === 'agent_run')
        .reduce(
          (a, t) => {
            const u = t.output as { inputTokens: number; outputTokens: number };
            a.input += u.inputTokens;
            a.output += u.outputTokens;
            return a;
          },
          { input: 0, output: 0 },
        ),
    });
    if (Object.values(checks).some((v) => !v)) process.exitCode = 1;
    save('running');
  }
  save('completed');
} finally {
  clearTimeout(watchdog);
  await processor.forceFlush();
  await disconnectPrisma();
}

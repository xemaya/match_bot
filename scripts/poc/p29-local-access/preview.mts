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
import {
  createWebSearch,
  type KnowledgeSearchResult,
} from '../../../packages/websearch/src/index.js';
const sample = z.enum(['original', 'mobility', 'charger']).parse(process.argv[2]);
const output = z
  .string()
  .regex(/^\/tmp\/matchbot-p29-[a-z0-9-]+\.json$/)
  .parse(process.argv[3]);
const env = loadEnv(),
  url = new URL(env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/matchbot_task_preview')
  throw new Error('isolated preview DB required');
const logger = createLogger('p29-preview', 'silent'),
  p = getPrisma(env.DATABASE_URL),
  repos = createRepositories(p);
const processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const live = sample === 'original';
if (live && !env.SEARCH_API_KEY) throw new Error('public research unavailable');
const web = live ? createWebSearch({ apiKey: env.SEARCH_API_KEY!, logger }) : null;
const inputs =
  sample === 'original'
    ? ['狗岛找止疼药']
    : sample === 'mobility'
      ? ['狗岛找止疼药', '现在急用，但我出不了门']
      : ['狗岛哪里能买手机充电线？手机快没电了'];
const queries: unknown[] = [],
  results: unknown[] = [];
const frozen =
  sample === 'charger'
    ? [
        {
          title: 'Tesco Isle Of Dogs Express',
          url: 'https://www.tesco.com/store-locator/london/41-millharbour',
          text: 'Tesco Isle Of Dogs Express is a supermarket at 41 Millharbour, London E14. The official locator provides store opening details. This fixture does not establish charging cable stock, connector type or delivery.',
        },
        {
          title: 'Currys store finder',
          url: 'https://www.currys.co.uk/store-finder',
          text: 'The Currys store finder lists electrical retail stores. Product availability and compatible charging cable stock at a particular branch are not confirmed by this fixture.',
        },
      ]
    : [
        {
          title: 'NHS Find a pharmacy',
          url: 'https://www.nhs.uk/service-search/pharmacy/find-a-pharmacy',
          text: 'Find a pharmacy by town, city or postcode in England. The directory links to pharmacy details. It does not confirm a medicine is in stock or that delivery is available.',
        },
        {
          title: 'Boots London Canary Wharf Canada Square',
          url: 'https://www.boots.com/stores/190-london-canary-whf-canada-e14-5ax',
          text: 'London Canary Wharf Canada Square is a Boots store with pharmacy services. This fixture establishes a pharmacy channel in Canary Wharf only, not Isle of Dogs location, travel duration, opening now, painkiller stock or delivery.',
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
      return web?.research
        ? web.research(args)
        : Promise.resolve({ status: 'ok', sources: frozen } satisfies KnowledgeSearchResult);
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
        boundary: live
          ? 'synthetic user; real public web/DeepSeek/Jev; isolated DB; pending outbox only, NO sender'
          : 'synthetic users and bounded source fixtures, NOT live facts; real DeepSeek/Jev; isolated DB; pending outbox only, NO sender',
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
}, 150000);
try {
  const user = await repos.users.upsertByExternal({
    channel: 'telegram',
    externalId: 'p29-' + runId,
  });
  const group = await repos.groups.upsert({
    channel: 'telegram',
    externalId: '-p29-' + runId,
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
      oneAnswer:
        drafts.length === 1 &&
        drafts[0]?.status === 'pending' &&
        !traces.some(
          (t) => t.kind === 'gate' && (t.output as { gate?: string }).gate === 'request_status',
        ),
      hasSources: text.includes('https://'),
      sameTask: !!ctx.task && (!previousTask || ctx.task.id === previousTask),
      researched: queries.length > 0,
      noWrongMarketRetries: !traces.some(
        (t) => t.kind === 'gate' && (t.output as { gate?: string }).gate === 'market_search',
      ),
      noArrivalGuarantee: !text.includes('走过去就能买'),
      noUnaskedMedicationAdvice:
        !/(?:每次|每天|一次).{0,8}(?:片|毫克|mg)|按(?:包装|说明).*吃|普通(?:头痛|牙痛)|小包装即可/.test(
          text,
        ),
      ...(index === 0
        ? { practicalQuestion: /[?？]/.test(text) }
        : { retainsObstacle: !/你是现在急用|是否急用|能出门吗|什么困难|哪里不方便/.test(text) }),
    };
    previousTask = ctx.task?.id;
    results.push({
      index,
      input,
      result,
      task: ctx.task,
      knowledge: ctx.knowledgeSources,
      checks,
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

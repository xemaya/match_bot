/** Synthetic evidence, real answer model/Jev, memory-only outbox. No Telegram or public search. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  createPrisma,
  createRepositories,
  type OutboundMessage,
} from '../../../packages/db/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { createJevClient, evaluateOutbound } from '../../../packages/jev/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import {
  AGENT_VERSION,
  configureModelProvider,
  createTraceProcessor,
  createMatchAgent,
  type MatchContext,
  type AgentDeps,
} from '../../../packages/agent/src/index.js';
import { bindCurrentRequest } from '../../../packages/agent/src/current-request.js';
import { marketListingSchema } from '../../../packages/websearch/src/market.js';
import type { MarketPlan } from '../../../packages/agent/src/market-strategy.js';
const mode = z.enum(['all', 'housing-recheck']).parse(process.argv[2] ?? 'all');
const priorPreviewTokens = mode === 'housing-recheck' ? 16954 : 0;
const ledger = z
  .object({ cumulativeTokens: z.number().int().nonnegative() })
  .parse(JSON.parse(readFileSync('logs/actor-lab/cumulative-budget.json', 'utf8')));
if (ledger.cumulativeTokens !== 351908 + priorPreviewTokens)
  throw new Error('preview_budget_baseline_changed');
const budget = 48092 - priorPreviewTokens;
const env = loadEnv(),
  url = new URL(env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('local trace database required');
url.pathname = '/matchbot_actor_lab';
const db = createPrisma(url.toString()),
  repos = createRepositories(db),
  logger = createLogger('p32-preview', 'silent');
const processor = createTraceProcessor({ traces: repos.traces, logger });
configureModelProvider(env, [processor]);
const runId = randomUUID(),
  since = new Date(),
  refs: string[] = [];
const results: unknown[] = [];
const output = priorPreviewTokens
  ? '/tmp/matchbot-p32-preview-recheck.json'
  : '/tmp/matchbot-p32-preview.json';
if (existsSync(output)) throw new Error('preview_report_exists');
const listing = (id: string, title: string, description: string, priceLabel: string) =>
  marketListingSchema.parse({
    id,
    title,
    description,
    priceLabel,
    tradeType: 'SELL',
    status: 'ON_SALE',
    tags: [],
    url: 'https://a2hmarket.ai/listings/' + id,
    sourceUrl: null,
    isRepost: false,
    availableFrom: null,
    availableUntil: null,
    sourcePublishedAt: null,
    createdAt: '2026-10-17T00:00:00Z',
  });
const cases: Array<{
  id: string;
  input: string;
  plan: MarketPlan;
  listings: ReturnType<typeof listing>[];
}> = [
  {
    id: 'desk-travel',
    input: 'E14收书桌和办公椅，每件50镑以内。我坐地铁，单程半小时以内。',
    plan: {
      intent: 'second_hand',
      needs: [
        { id: 'desk', terms: ['书桌'] },
        { id: 'chair', terms: ['办公椅'] },
      ],
      preferences: [],
      budget: 50,
      requiredArea: ['E14'],
    },
    listings: [
      listing(
        'p32_desk',
        'E14书桌',
        '出售：书桌，£20。桌面100×60cm，可拆卸，正常使用痕迹。地点：伦敦E14，Canary Wharf站附近。支持自提；重量、楼层和具体门牌未写。',
        '£20',
      ),
      listing(
        'p32_chair',
        'E14办公椅',
        '出售：办公椅，£30，功能正常。地点：伦敦E14，自提；未写具体取货点。',
        '£30',
      ),
    ],
  },
  {
    id: 'cat-housing',
    input: 'Stratford找一居室，11月5日入住，养猫，含账单每月不能超过1600镑。',
    plan: {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室'] }],
      preferences: ['允许养猫'],
      essentialPreferences: ['允许养猫'],
      budget: 1600,
      budgetScope: 'all_in',
      requiredArea: ['Stratford'],
    },
    listings: [
      listing(
        'p32_cat',
        'Stratford一居室整租',
        '出租：伦敦Stratford一居室整租，独立厨卫。月租含水电网总计£1590/月。2026年11月5日起可入住。允许养一只猫，宠物许可会写入租约。地点：Stratford。',
        '£1590/月（含水电网）',
      ),
      listing(
        'p32_nocat',
        'Stratford一居室',
        '出租：伦敦Stratford一居室。月租£1400，不允许养猫或其他宠物。2026年11月5日起租。',
        '£1400/月',
      ),
    ],
  },
  {
    id: 'badminton',
    input: 'E14找羽毛球搭子，我是新手，只能周日下午，想打室内。',
    plan: {
      intent: 'companion',
      needs: [{ id: 'badminton', terms: ['羽毛球'] }],
      preferences: ['周日下午', '室内'],
      essentialPreferences: ['周日下午', '室内'],
      requiredArea: ['E14'],
    },
    listings: [
      listing(
        'p32_bad',
        'E14周日室内羽毛球',
        '找搭子：伦敦E14周日下午室内羽毛球，明确欢迎零基础和初学者。£8/次，费用含场地和羽毛球。球拍是否提供没有写。',
        '£8/次',
      ),
    ],
  },
];
const fingerprint = createHash('sha256');
for (const file of readdirSync('packages/agent/src', { recursive: true, encoding: 'utf8' })
  .filter((n) => n.endsWith('.ts'))
  .sort())
  fingerprint.update(file).update(readFileSync('packages/agent/src/' + file));
fingerprint.update(readFileSync('packages/agent/prompts/voice/soul.md'));
const sourceFingerprint = fingerprint.digest('hex');
const save = (status: string, used: number) =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        since,
        agentVersion: AGENT_VERSION,
        sourceFingerprint,
        status,
        budget,
        used,
        cumulativeWithPriorActorRuns: 351908 + priorPreviewTokens + used,
        boundary:
          'Real DeepSeek and Jev; frozen synthetic sources; answer stage only, memory outbox. No tool-search autonomy, Telegram transport, full multi-turn or human satisfaction proof.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
const watchdog = setTimeout(() => {
  save('timeout', -1);
  process.exit(2);
}, 180000);
let used = 0;
try {
  for (const c of cases.filter((c) => !priorPreviewTokens || c.id === 'cat-housing')) {
    const ctx: MatchContext = {
      userId: 'synthetic-p32',
      chatId: '-3200000001',
      groupId: null,
      phase: 2,
      sourceMessageId: 'p32:' + runId + ':' + c.id,
      recentReplies: [],
      addressedToBot: true,
      isAnswerFinalization: true,
    };
    bindCurrentRequest(ctx, c.input);
    ctx.marketPlan = c.plan;
    ctx.marketTarget = 'SELL';
    ctx.marketListings = c.listings.map((n, i) => ({ ...n, ref: 'm' + (i + 1) }));
    ctx.marketDetailIds = c.listings.map((n) => n.id);
    ctx.marketQueries = ['frozen synthetic fixture'];
    let row: OutboundMessage | null = null;
    const proposals: Array<{ draft: string; verdict: unknown }> = [];
    const deps: AgentDeps = {
      env,
      repos: {
        ...repos,
        outbound: {
          ...repos.outbound,
          create: (draft, status) => {
            row = { ...draft, id: 'memory-' + c.id, status } as unknown as OutboundMessage;
            return Promise.resolve(row);
          },
          countSentToTargetSince: () => Promise.resolve(0),
        },
      },
      logger,
      answerRequests: true,
      taskRequests: true,
      thresholds: DEFAULT_THRESHOLDS,
      evaluateOutbound: async (client, p) => {
        const verdict = await evaluateOutbound(client, p);
        proposals.push({ draft: p.draft, verdict });
        return verdict;
      },
      jev: createJevClient({
        baseUrl: env.JEV_BASE_URL,
        apiKey: env.JEV_API_KEY,
        model: env.JEV_MODEL,
        traces: repos.traces,
        logger,
        timeoutMs: 10000,
        maxRetries: 0,
      }),
    };
    const { agent, runner } = createMatchAgent(deps, {
      phase: 2,
      finalAnswerOnly: true,
      inputRef: ctx.sourceMessageId,
    });
    agent.modelSettings = { ...agent.modelSettings, maxTokens: 1200 };
    const prompt = await agent.getSystemPrompt({ context: ctx } as never);
    const byteReserve =
      Buffer.byteLength(prompt ?? '') +
      Buffer.byteLength(
        JSON.stringify(agent.tools.map((t) => (t.type === 'function' ? t.parameters : {}))),
      ) +
      Buffer.byteLength(c.input) +
      5296;
    if (budget - used < byteReserve) {
      results.push({ id: c.id, skipped: 'conservative_input_output_reserve', byteReserve });
      break;
    }
    refs.push(ctx.sourceMessageId);
    let errorKind: string | undefined;
    try {
      await runner.run(agent, c.input, {
        context: ctx,
        maxTurns: 1,
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      errorKind = e instanceof Error ? e.name : 'unknown_error';
    }
    await processor.forceFlush?.();
    const usage = await repos.traces.summarizeUsage({ since, inputRefs: refs });
    if (usage.missingUsageCalls) throw new Error('usage_missing');
    used = usage.inputTokens + usage.outputTokens;
    const draft = z.object({ text: z.string(), status: z.string() }).safeParse(row);
    results.push({
      id: c.id,
      input: c.input,
      ...(errorKind ? { errorKind } : {}),
      draft: draft.success ? draft.data : null,
      proposals,
      usage,
      byteReserve,
    });
    save('running', used);
    if (used >= budget) break;
  }
  save('finished', used);
  process.stdout.write(
    JSON.stringify({ output, cases: results.length, used, budget, agentVersion: AGENT_VERSION }) +
      '\n',
  );
} finally {
  clearTimeout(watchdog);
  await processor.forceFlush?.();
  await db.$disconnect();
}

/** Frozen synthetic users/sources, real generation/Jev, isolated PG and simulated transport only. */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AGENT_VERSION,
  configureModelProvider,
  createTraceProcessor,
  runInbound,
  type AgentDeps,
  type MatchContext,
} from '../../../packages/agent/src/index.js';
import { createRepositories, disconnectPrisma, getPrisma } from '../../../packages/db/src/index.js';
import { createJevClient, evaluateOutbound } from '../../../packages/jev/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { assessTaskReadiness, type UserTask } from '../../../packages/domain/src/index.js';
import { marketListingSchema } from '../../../packages/websearch/src/market.js';
import {
  gradeTaskTurn,
  taskConversationsSchema,
} from '../../../packages/eval/src/task-contract.js';
import { drainOutbound } from '../../../apps/bot/src/outbound-loop.js';
import { waitForPreviewOutbounds, previewExternalMessageId } from './preview-delivery.mjs';

const sampleId = z.enum(['desk_chair', 'cat_housing', 'beginner_bad']).parse(process.argv[2]);
const output = process.argv[3] ?? '/tmp/matchbot-task-conversation-' + sampleId + '.json';
const env = loadEnv(),
  destination = new URL(env.DATABASE_URL);
if (destination.hostname !== '127.0.0.1' || destination.pathname !== '/matchbot_task_preview')
  throw new Error('isolated local preview DB required');
const conversations = taskConversationsSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../packages/eval/fixtures/task-agent/conversations.json', import.meta.url),
      'utf8',
    ),
  ),
);
const corpus = z
  .object({
    version: z.literal(1),
    cases: z.array(
      z.object({
        id: z.string(),
        aliases: z.array(z.string()),
        forbiddenIds: z.array(z.string()),
        listings: z.array(marketListingSchema),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../../packages/eval/fixtures/task-agent/source-corpus.json', import.meta.url),
        'utf8',
      ),
    ),
  );
const originalSample = conversations.cases.find((c) => c.id === sampleId)!;
const variantBytes = process.argv[4] ? readFileSync(process.argv[4], 'utf8') : null;
const variantInputs = variantBytes
  ? z
      .object({ cases: z.record(z.string(), z.array(z.string().min(1).max(600)).length(5)) })
      .parse(JSON.parse(variantBytes)).cases[sampleId]
  : undefined;
if (variantBytes && !variantInputs) throw new Error('missing style variant');
const sample = variantInputs
  ? {
      ...originalSample,
      turns: originalSample.turns.map((turn, index) => ({ ...turn, input: variantInputs[index]! })),
    }
  : originalSample;
const sources = corpus.cases.find((c) => c.id === sampleId)!;
if (!sample || !sources) throw new Error('missing frozen conversation or corpus');
const hash = createHash('sha256');
for (const root of [
  'packages/agent/src',
  'packages/domain/src',
  'packages/jev/src',
  'packages/gating/src',
  'packages/db/src/repos',
])
  for (const name of readdirSync(root, { recursive: true })
    .filter((n) => n.endsWith('.ts'))
    .sort())
    hash.update(root + '/' + name).update(readFileSync(join(root, name)));
const soulHash = createHash('sha256')
  .update(readFileSync('packages/agent/prompts/voice/soul.md'))
  .digest('hex');
hash.update('packages/agent/prompts/voice/soul.md').update(soulHash);
const sourceFingerprint = hash.digest('hex');
const logger = createLogger('p27-conversation-preview', 'warn');
const prisma = getPrisma(env.DATABASE_URL),
  repos = createRepositories(prisma);
const processor = createTraceProcessor({ traces: repos.traces, logger });
const sdkFailures: Array<{ type: string; message: string }> = [];
const recordSpan = processor.onSpanEnd.bind(processor);
processor.onSpanEnd = (span) => {
  if (span.error)
    sdkFailures.push({ type: span.spanData.type, message: span.error.message.slice(0, 1600) });
  return recordSpan(span);
};
configureModelProvider(env, [processor]);
const queries: unknown[] = [],
  details: string[] = [],
  results: unknown[] = [],
  draftChecks: unknown[] = [];
const deps: AgentDeps = {
  env,
  repos,
  logger,
  answerRequests: true,
  taskRequests: true,
  thresholds: DEFAULT_THRESHOLDS,
  evaluateOutbound: async (client, input) => {
    const verdict = await evaluateOutbound(client, input);
    // This harness accepts synthetic input and an isolated DB only; keep rejected drafts for honest diagnosis.
    draftChecks.push({ ...input, verdict });
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
  marketSearch: {
    find: async (args) => {
      queries.push(args);
      const keyword = args.keyword.toLowerCase();
      const matches = sources.aliases.some((alias) => keyword.includes(alias.toLowerCase()));
      const items =
        matches && args.page === 1
          ? sources.listings.filter(
              (item) => args.tradeType === 'ANY' || args.tradeType === item.tradeType,
            )
          : [];
      return { items, hasNext: false, total: items.length };
    },
    detail: async (id) => {
      details.push(id);
      const item = sources.listings.find((listing) => listing.id === id);
      if (!item) throw new Error('unknown synthetic listing');
      return item;
    },
  },
};
const runId = randomUUID(),
  started = Date.now();
const save = (status: string) =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        runId,
        sampleId,
        sourceFingerprint,
        soulHash,
        inputVariantHash: variantBytes
          ? createHash('sha256').update(variantBytes).digest('hex')
          : null,
        agentVersion: AGENT_VERSION,
        harnessVersion: 'stable-receipt-v3',
        model: env.DEEPSEEK_MODEL,
        jevModel: env.JEV_MODEL,
        status,
        elapsedMs: Date.now() - started,
        boundary:
          'frozen synthetic source corpus and user; real generation/Jev; isolated PG; Phase 2 gates; simulated sender only, no public search or Telegram; inbound worker/Jev not covered',
        corpusHash: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
        results,
        draftChecks,
        sdkFailures,
        queries,
        details,
      },
      null,
      2,
    ),
  );
const watchdog = setTimeout(() => {
  save('timeout');
  process.exit(2);
}, 900000);
try {
  const user = await repos.users.upsertByExternal({
    channel: 'telegram',
    externalId: 'p27-preview-' + runId,
  });
  const group = await repos.groups.upsert({
    channel: 'telegram',
    externalId: '-p27-preview-' + runId,
    name: 'synthetic conversation preview',
  });
  await prisma.group.update({ where: { id: group.id }, data: { phase: 2, isActive: true } });
  const access = {
    userId: user.id,
    scope: { channel: 'telegram' as const, chatId: group.externalId },
  };
  const taskIds = new Set<string>();
  const snapshots = async () => {
    const all: UserTask[] = [];
    for (const id of taskIds) {
      const task = await repos.tasks.findById({ access, id });
      if (task) all.push(task);
    }
    return all;
  };
  let previousReply: string | undefined;
  for (const [index, turn] of sample.turns.entries()) {
    const before = await snapshots(),
      beforeQueries = queries.length,
      t0 = Date.now();
    const accepted = await repos.executions.accept({
      userId: user.id,
      groupId: group.id,
      phase: 2,
      message: {
        channel: 'telegram',
        userId: user.externalId,
        chatId: group.externalId,
        messageId: String(index + 1),
        text: turn.input,
        receivedAt: new Date().toISOString(),
        addressedToBot: true,
        ...(turn.expect.replyTo && previousReply ? { replyToMessageId: previousReply } : {}),
      },
    });
    const claim = await repos.executions.claim({ userId: user.id, messageId: accepted.message.id });
    if (claim.kind !== 'acquired') throw new Error('preview execution claim unavailable');
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
      source: { messageId: String(index + 1), userId: user.externalId },
      ...(turn.expect.replyTo && previousReply ? { replyToMessageId: previousReply } : {}),
    };
    try {
      const result = await runInbound({ deps, ctx, input: turn.input });
      await repos.executions.finish({
        lease: claim.lease,
        status: result.kind === 'interrupted' ? 'waiting_approval' : 'completed',
        ...(result.kind === 'interrupted' ? { runStateId: result.runStateId } : {}),
      });
      await processor.forceFlush();
      if (ctx.task) taskIds.add(ctx.task.id);
      await drainOutbound({
        repos,
        logger,
        defaultPhase: 2,
        sender: {
          send: async (row, options) => {
            if (!row.target.startsWith('-p27-preview-'))
              throw new Error('non-preview destination rejected');
            if (!(await options.beforeSend())) return { kind: 'not_started' };
            return row.kind === 'reaction'
              ? { kind: 'reaction', externalMessageId: null }
              : { kind: 'message', externalMessageId: previewExternalMessageId(row.id) };
          },
        },
      });
      const outbounds = await waitForPreviewOutbounds({
        prisma,
        sourceMessageId: accepted.message.id,
      });
      const sent = outbounds.filter((row) => row.status === 'sent');
      const message = sent.find((row) => row.externalMessageId);
      const replyText = sent.map((row) => row.text).join('\n');
      const after = await snapshots(),
        task = after.find((row) => row.id === ctx.task?.id) ?? null;
      const issues = gradeTaskTurn(turn.expect, {
        task,
        before,
        after,
        replyText,
        searches: queries.length - beforeQueries,
        owner: 'owner',
        scope: 'group',
        ...(ctx.taskUpdate ? { updateKind: ctx.taskUpdate.kind } : {}),
        ...(turn.expect.replyTo && previousReply
          ? { replyAlias: String(turn.expect.replyTo) }
          : {}),
      });
      if (!sent.length) issues.push('no_sent_response_or_reaction');
      if (result.kind === 'interrupted') issues.push('unexpected_approval');
      if (sources.forbiddenIds.some((id) => replyText.includes('/listings/' + id)))
        issues.push('known_conflict_recommended');
      if (
        index < sample.turns.length - 1 &&
        !sources.listings.some((source) => replyText.includes(source.url))
      )
        issues.push('no_actionable_source_despite_available_leads');
      if (task?.pendingQuestion && task.pendingQuestion.deliveryStatus !== 'sent')
        issues.push('question_not_delivered');
      if (task?.status === 'completed' && queries.length !== beforeQueries)
        issues.push('searched_after_user_completion');
      if (
        sampleId === 'cat_housing' &&
        index >= 2 &&
        !task?.constraints.some((c) => c.key === 'budget' && c.budgetScope === 'all_in')
      )
        issues.push('lost_all_in_budget_scope');
      if (
        index >= 3 &&
        sampleId === 'desk_chair' &&
        replyText.includes('/listings/task-eval-chair-')
      )
        issues.push('recommended_completed_subgoal');
      if (
        sampleId === 'desk_chair' &&
        index < 2 &&
        replyText.includes('/listings/task-eval-desk-large')
      )
        issues.push('recommended_over_budget_desk');
      if (
        index >= 2 &&
        sampleId === 'beginner_bad' &&
        replyText.includes('/listings/task-eval-bad-saturday')
      )
        issues.push('recommended_excluded_day');
      if (issues.length) process.exitCode = 1;
      results.push({
        index,
        input: turn.input,
        elapsedMs: Date.now() - t0,
        result,
        task,
        readiness: task ? assessTaskReadiness(task) : null,
        taskUpdate: ctx.taskUpdate,
        failures: ctx.sourceFailures,
        issues,
        outbounds: outbounds.map(({ text, kind, status, externalMessageId, errorCode }) => ({
          text,
          kind,
          status,
          externalMessageId,
          errorCode,
        })),
        traces: await prisma.decisionTrace.findMany({
          where: { inputRef: accepted.message.id },
          orderBy: { createdAt: 'asc' },
        }),
      });
      if (message?.externalMessageId) previousReply = message.externalMessageId;
      logger.warn(
        { sampleId, turn: index, elapsedMs: Date.now() - t0, issues },
        'conversation preview turn completed',
      );
    } catch (error) {
      await repos.executions.finish({
        lease: claim.lease,
        status: 'failed',
        errorCode: 'preview_failed',
      });
      results.push({
        index,
        input: turn.input,
        elapsedMs: Date.now() - t0,
        error: error instanceof Error ? error.name : 'unknown',
      });
      process.exitCode = 1;
    }
    save('running');
  }
  save('completed');
} finally {
  clearTimeout(watchdog);
  await processor.forceFlush();
  await disconnectPrisma();
}

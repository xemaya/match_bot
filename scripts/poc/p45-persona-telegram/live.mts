/** P45: approved 500k generation tokens / 6 actor messages; real Telegram, searches and worker. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { loadEnv } from '../../../packages/shared/src/index.js';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import { AGENT_VERSION } from '../../../packages/agent/src/index.js';
import {
  actorLabConfigSchema,
  loadActorLabConfig,
} from '../../../apps/bot/src/actor-lab-config.js';
import { openActorLab } from '../../../apps/bot/src/actor-lab-runtime.js';
import { runActorLab } from '../../../apps/bot/src/actor-lab-run.js';
const messageLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(6)
  .parse(process.argv[4] ?? 6);
const mode = z.enum(['--plan', '--run']).parse(process.argv[2] ?? '--plan');
const allCases = z
  .array(
    z.object({
      id: z.string(),
      role: z.enum(['short', 'changes', 'interruption']),
      firstMessage: z.string().max(180),
      goal: z.string().max(1000),
      style: z.string().max(300),
    }),
  )
  .length(3)
  .parse(JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')));
const cases = ['gp-registration', 'printer', 'family-exhibition'].map((id) => ({
  ...allCases.find((c) => c.id === id)!,
  firstMessage: '新需求：' + allCases.find((c) => c.id === id)!.firstMessage,
}));
const reserves: Record<string, number> = {
  'gp-registration': 100000,
  printer: 100000,
  'family-exhibition': 100000,
};
if (mode === '--plan') {
  process.stdout.write(
    JSON.stringify({
      scenarios: cases.map(({ id, role, firstMessage }) => ({ id, role, firstMessage })),
      messages: messageLimit,
      productionAgent: '0.30.0',
      status: 'user_approved_500000_tokens_6_messages',
    }) + '\n',
  );
} else
  await run().catch((error: unknown) => {
    process.stdout.write(
      JSON.stringify({
        event: 'batch_error',
        errorKind: error instanceof Error ? error.name : 'unknown_error',
      }) + '\n',
    );
    process.exitCode = 1;
  });
async function run() {
  const approvedBudget = z.coerce.number().int().min(1000).max(500000).parse(process.argv[3]);
  const previous = z
    .object({ cumulativeTokens: z.number().int().nonnegative() })
    .parse(JSON.parse(readFileSync('logs/actor-lab/cumulative-budget.json', 'utf8')));
  const env = loadEnv(),
    base = loadActorLabConfig(env.ACTOR_LAB_CONFIG_PATH!);
  if (String(AGENT_VERSION) !== '0.30.0') throw new Error('unexpected_agent_version');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['diff', 'HEAD', '--', 'packages', 'apps'], { encoding: 'utf8' }).trim())
    throw new Error('uncommitted_runtime_changes');
  if (
    env.DEEPSEEK_MODEL !== 'gpt-6.1-sol' ||
    env.GENERATION_REASONING_EFFORT !== 'low' ||
    !env.DEEPSEEK_SEARCH_API_KEY
  )
    throw new Error('model_configuration_mismatch');
  const batchId = randomUUID(),
    root = 'logs/p45/live-' + batchId;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync('logs/actor-lab', { recursive: true, mode: 0o700 });
  const main = createPrisma(env.DATABASE_URL),
    control = createPrisma(base.controlDatabaseUrl),
    repos = createRepositories(main);
  const batchLockPath = '.env.actor-lab-batch.lock';
  const batchLock = openSync(batchLockPath, 'wx', 0o600);
  writeFileSync(batchLock, String(process.pid));
  const startedAt = new Date();
  let used = 0,
    sent = 0,
    stopped = false;
  const results: unknown[] = [];
  const stop = () => {
    stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const watchdog = setTimeout(() => process.emit('SIGTERM'), 1500000);
  let finalState = 'finished';
  const save = (state: string) =>
    writeFileSync(
      root + '/batch.json',
      JSON.stringify(
        {
          batchId,
          sourceSha,
          productionAgent: AGENT_VERSION,
          generationModel: env.DEEPSEEK_MODEL,
          reasoningEffort: env.GENERATION_REASONING_EFFORT,
          startedAt,
          approvedBudget,
          messageLimit,
          budgetScope: 'new_batch',
          priorObservedTokens: previous.cumulativeTokens,
          cumulativeWithPriorTests: previous.cumulativeTokens + used,
          used,
          sent,
          state,
          results,
          boundary:
            'Real Telegram sends and actual Main worker/searches; actor context may read only source-bound sent public replies, not bot updates. Budget is observed, not a billing hard cap. No human satisfaction/completion assertion.',
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  const deactivate = () =>
    repos.groups.setPolicy({
      channel: 'telegram',
      externalId: base.groupId,
      isActive: false,
      phase: 0,
      rateLimitPerDay: 30,
    });
  save('prepared');
  try {
    for (const scenario of cases) {
      if (stopped || sent >= messageLimit || approvedBudget - used < reserves[scenario.id]!) {
        finalState = stopped ? 'stopped' : 'budget_reserve';
        save(finalState);
        break;
      }
      const cfg = actorLabConfigSchema.parse({
        ...base,
        actors: base.actors.map((a) =>
          a.role === scenario.role
            ? {
                ...a,
                goal: scenario.goal,
                style: scenario.style,
                firstMessage: scenario.firstMessage,
              }
            : a,
        ),
        turnOrder: Array.from({ length: Math.min(2, messageLimit - sent) }, () => scenario.role),
        maxMessages: Math.min(2, messageLimit - sent),
        maxSeconds: 420,
        replyWaitSeconds: 210,
        waitForEachReply: true,
        minRemainingTokens: 100000,
        tokenBudget: Math.min(500000, approvedBudget - used),
      });
      const before = new Set(
        readdirSync('logs/actor-lab').filter((n) => /^[a-f0-9-]{36}\.json$/.test(n)),
      );
      const since = new Date(),
        rt = openActorLab(env, cfg);
      let result: unknown, errorKind: string | undefined;
      process.stdout.write(
        JSON.stringify({
          event: 'scenario_started',
          batchId,
          id: scenario.id,
          remaining: approvedBudget - used,
        }) + '\n',
      );
      try {
        await rt.activate();
        if (!stopped) result = await runActorLab(rt);
      } catch (e) {
        errorKind = e instanceof Error ? e.name : 'unknown_error';
      } finally {
        await rt.close();
      }
      const reportName = readdirSync('logs/actor-lab').find(
        (n) => /^[a-f0-9-]{36}\.json$/.test(n) && !before.has(n),
      );
      const actorReport = reportName
        ? z
            .object({ runId: z.string() })
            .passthrough()
            .parse(JSON.parse(readFileSync('logs/actor-lab/' + reportName, 'utf8')))
        : null;
      const actor = cfg.actors.find((a) => a.role === scenario.role)!;
      const group = await repos.groups.findByExternal('telegram', cfg.groupId),
        user = await repos.users.findByExternal('telegram', actor.id);
      const where = {
        groupId: group!.id,
        ...(user ? { userId: user.id } : { userId: 'no-synthetic-user' }),
        receivedAt: { gte: new Date(Math.floor(since.getTime() / 1000) * 1000) },
      };
      let settled = false;
      for (let n = 0; n < 45 && !stopped; n++) {
        const messages = await main.message.findMany({
          where,
          select: { id: true, executionStatus: true },
        });
        const outstanding = await main.outboundMessage.count({
          where: {
            sourceMessageId: { in: messages.map((m) => m.id) },
            status: { in: ['pending', 'sending'] },
          },
        });
        if (
          messages.every(
            (m) =>
              m.executionStatus !== null &&
              !['accepted', 'running', 'waiting_approval'].includes(m.executionStatus),
          ) &&
          !outstanding
        ) {
          settled = true;
          break;
        }
        await pause(2000);
      }
      const messages = await main.message.findMany({ where, orderBy: { receivedAt: 'asc' } }),
        ids = messages.map((m) => m.id);
      const outbounds = await main.outboundMessage.findMany({
        where: { sourceMessageId: { in: ids }, target: cfg.groupId },
        orderBy: { createdAt: 'asc' },
      });
      const traces = await main.decisionTrace.findMany({
        where: { inputRef: { in: ids } },
        orderBy: { createdAt: 'asc' },
      });
      const actorTraces = actorReport
        ? await control.decisionTrace.findMany({
            where: {
              kind: 'agent_run',
              inputRef: { startsWith: 'actor-model:', contains: ':' + actorReport.runId + ':' },
            },
          })
        : [];
      const actorDecisions = actorReport
        ? await control.decisionTrace.findMany({
            where: {
              inputRef: { startsWith: `actor:${actor.id}:${actorReport.runId}:` },
              kind: { in: ['gate', 'jev'] },
            },
            orderBy: { createdAt: 'asc' },
          })
        : [];
      const usageSchema = z.object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      });
      let caseTokens = 0,
        missingUsage = 0;
      for (const trace of [...traces.filter((t) => t.kind === 'agent_run'), ...actorTraces]) {
        const u = usageSchema.safeParse(trace.output);
        if (!u.success) {
          missingUsage++;
          continue;
        }
        caseTokens += u.data.inputTokens + u.data.outputTokens;
      }
      const tasks = [];
      for (const id of new Set(messages.flatMap((m) => (m.taskId ? [m.taskId] : [])))) {
        const task = await repos.tasks.findById({
          access: { userId: user!.id, scope: { channel: 'telegram', chatId: cfg.groupId } },
          id,
        });
        if (task) tasks.push(task);
      }
      const actorReceipts = actorReport
        ? await control.outboundMessage.findMany({
            where: { toolCallId: { startsWith: `actor:${actor.id}:${actorReport.runId}:` } },
            select: {
              id: true,
              status: true,
              externalMessageId: true,
              toolCallId: true,
              sentAt: true,
              error: true,
            },
          })
        : [];
      const confirmedSent = actorReceipts.filter((row) => row.status === 'sent').length;
      used += caseTokens;
      sent += confirmedSent;
      const observation = {
        id: scenario.id,
        scenario,
        since,
        result,
        errorKind,
        actorReport,
        actorReceipts,
        settled,
        caseTokens,
        missingUsage,
        messages,
        outbounds,
        traces,
        actorTraces,
        actorDecisions,
        tasks,
      };
      writeFileSync(
        root + '/' + scenario.id + '.json',
        JSON.stringify(observation, null, 2) + '\n',
        { mode: 0o600 },
      );
      results.push({
        id: scenario.id,
        report: root + '/' + scenario.id + '.json',
        messages: messages.length,
        actorSent: confirmedSent,
        replies: outbounds.filter((o) => o.status === 'sent' && o.kind !== 'reaction').length,
        caseTokens,
        settled,
        errorKind,
      });
      save('running');
      await deactivate();
      process.stdout.write(
        JSON.stringify({
          event: 'scenario_finished',
          id: scenario.id,
          messages: messages.length,
          actorSent: confirmedSent,
          replies: outbounds.filter((o) => o.status === 'sent' && o.kind !== 'reaction').length,
          caseTokens,
          used,
          sent,
          settled,
          errorKind,
        }) + '\n',
      );
      if (!settled || missingUsage || errorKind || (confirmedSent > 0 && !messages.length)) {
        finalState = 'blocked';
        save(finalState);
        break;
      }
    }
    save(stopped ? 'stopped' : finalState);
  } finally {
    clearTimeout(watchdog);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try {
      await deactivate();
    } finally {
      await Promise.allSettled([main.$disconnect(), control.$disconnect()]);
      closeSync(batchLock);
      unlinkSync(batchLockPath);
    }
  }
  process.stdout.write(
    JSON.stringify({ event: 'batch_finished', batchId, root, used, sent }) + '\n',
  );
}

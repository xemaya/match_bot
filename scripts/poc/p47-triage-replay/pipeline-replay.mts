/**
 * Phase 0 replay of real group asks through the whole worker pipeline: admission triage, agent,
 * research and the outbound gate run for real, but the group is at phase 0 so every reply is a
 * dry_run row and nothing reaches Telegram. Each replayed message is stored as a new message with
 * the original author and timestamp, so its group transcript is what the group looked like then.
 * Counts against the approved Match Bot generation budget.
 * Usage: pipeline-replay.mts <budget> [lookbackHours=6] [askPrefix ...]
 */
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { buildDeps } from '../../../apps/worker/src/deps.js';
import { processInbound } from '../../../apps/worker/src/pipeline/inbound.js';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import { loadEnv } from '../../../packages/shared/src/index.js';

const budget = z.coerce.number().int().min(1000).max(200000).parse(process.argv[2]);
const lookbackHours = z.coerce
  .number()
  .positive()
  .max(72)
  .parse(process.argv[3] ?? '6');
const GROUP = '-5013792100';
const ASKS = process.argv.slice(4).length
  ? process.argv.slice(4)
  : [
      '再问一下 11月1号起东伦敦合租',
      '顺便问下 下周四五我去外地开会',
      '顺便问下 有没有uu出二手打印机',
      '我这Stratford空出来一间',
    ];
const env = loadEnv();
if (env.DEFAULT_PHASE !== 0) throw new Error('replay requires DEFAULT_PHASE=0');
const deps = buildDeps({ env });
const prisma = createPrisma(env.DATABASE_URL);
const repos = createRepositories(prisma);
const group = await repos.groups.findByExternal('telegram', GROUP);
if (!group) throw new Error('group_missing');
const originalPolicy = { isActive: group.isActive, phase: group.phase };
await repos.groups.setPolicy({
  channel: 'telegram',
  externalId: GROUP,
  isActive: true,
  phase: 0,
  rateLimitPerDay: group.rateLimitPerDay ?? 30,
});
let used = 0;
try {
  for (const prefix of ASKS) {
    if (used > budget) {
      console.log(JSON.stringify({ event: 'budget_reached', used }));
      break;
    }
    const original = await prisma.message.findFirst({
      where: {
        groupId: group.id,
        text: { startsWith: prefix },
        receivedAt: { gte: new Date(Date.now() - lookbackHours * 3600e3) },
        externalId: { not: { startsWith: 'replay-' } },
      },
      orderBy: { receivedAt: 'desc' },
    });
    // REPLAY_AUTHOR=<telegram user id>: when the original text was blanked by a window reset,
    // replay the prefix itself as a fresh ask from that member, received now.
    const synthetic =
      !original && process.env['REPLAY_AUTHOR']
        ? await repos.users.upsertByExternal({
            channel: 'telegram',
            externalId: process.env['REPLAY_AUTHOR'],
            lang: 'zh',
          })
        : null;
    if (!original && !synthetic) {
      console.log(JSON.stringify({ event: 'original_missing', prefix }));
      continue;
    }
    const author = original ? await repos.users.findById(original.userId) : synthetic;
    if (!author) throw new Error('author_missing');
    const source = original ?? { id: 'synth', text: prefix, receivedAt: new Date() };
    // The ask is replayed as it first arrived: tasks the author opened at or after that moment
    // (the task this very message created) are expired so the replay does not continue them.
    const expired = await prisma.task.updateMany({
      where: { userId: author.id, status: 'active', createdAt: { gte: source.receivedAt } },
      data: { status: 'expired' },
    });
    if (expired.count)
      console.log(JSON.stringify({ event: 'tasks_expired', count: expired.count }));
    const externalId = 'replay-' + source.id + '-' + Date.now();
    const msg = {
      channel: 'telegram' as const,
      chatId: GROUP,
      messageId: externalId,
      userId: author.externalId,
      text: source.text,
      lang: 'zh',
      receivedAt: source.receivedAt.toISOString(),
    };
    const started = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const outcome = await processInbound(deps, msg);
      if (!outcome || !('deferMs' in outcome)) break;
      await pause(Math.min(outcome.deferMs, 5000));
    }
    const stored = await repos.messages.findExisting({
      groupId: group.id,
      userId: author.id,
      externalId,
    });
    const traces = stored
      ? await prisma.decisionTrace.findMany({
          where: { inputRef: stored.id },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const tokens = traces
      .filter((t) => t.kind === 'agent_run')
      .reduce((n, t) => {
        const o = t.output as { inputTokens?: number; outputTokens?: number };
        return n + (o.inputTokens ?? 0) + (o.outputTokens ?? 0);
      }, 0);
    used += tokens;
    const outbound = stored
      ? await prisma.outboundMessage.findMany({ where: { sourceMessageId: stored.id } })
      : [];
    const gates = traces
      .filter((t) => t.kind === 'gate')
      .map((t) => t.output as Record<string, unknown>)
      .filter((o) => o['outcome'] || o['gate'] === 'outbound' || o['gate'] === 'request_status')
      .map((o) =>
        [
          o['outcome'] ?? o['gate'],
          o['reason'] ?? '',
          (o['triage'] as { action?: string } | undefined)?.action ?? '',
          o['decision'] ?? '',
          Array.isArray(o['toolsCalled']) ? (o['toolsCalled'] as string[]).join('+') : '',
        ]
          .filter(Boolean)
          .join(':'),
      );
    console.log(
      JSON.stringify({
        ask: source.text.slice(0, 40),
        status: stored?.executionStatus ?? null,
        tokens,
        modelCalls: traces.filter((t) => t.kind === 'agent_run').length,
        seconds: Math.round((Date.now() - started) / 1000),
        gates,
        replies: outbound.map((o) => ({ status: o.status, kind: o.kind, text: o.text })),
      }),
    );
  }
  console.log(JSON.stringify({ event: 'replay_finished', used, budget }));
} finally {
  await repos.groups.setPolicy({
    channel: 'telegram',
    externalId: GROUP,
    isActive: originalPolicy.isActive,
    phase: originalPolicy.phase,
    rateLimitPerDay: group.rateLimitPerDay ?? 30,
  });
  await prisma.$disconnect();
}

/**
 * P50 `pnpm humanness:record <round> [--as <newRound>]`: re-run a round's original group asks through
 * the whole worker pipeline (triage, planning, research, finalization, outbound gate) with the group
 * at Phase 0, so every reply is a dry_run row and nothing reaches Telegram. Each ask is stored as a
 * new message with the original author and timestamp (group transcript as it was then), which
 * leaves a fresh execution snapshot encrypted with the current SNAPSHOT_KEY; the script then freezes
 * those into fixtures/humanness/cases/<newRound>/ and writes rounds/<newRound>.json.
 * Real model and real search: counts against the Match Bot generation budget. Lives in scripts/
 * because packages must not depend on apps (check-deps).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { buildDeps } from '../../apps/worker/src/deps.js';
import { processInbound } from '../../apps/worker/src/pipeline/inbound.js';
import { AGENT_VERSION } from '../../packages/agent/src/index.js';
import { createPrisma, createRepositories } from '../../packages/db/src/index.js';
import { toRoundCase } from '../../packages/eval/src/humanness/export.js';
import { freezeCase } from '../../packages/eval/src/humanness/freeze.js';
import {
  caseFixtureSchema,
  roundSchema,
  type Round,
  type RoundCase,
} from '../../packages/eval/src/humanness/schema.js';
import { envSchema } from '../../packages/shared/src/index.js';

const out = (line: string) => process.stdout.write(line + '\n');
const ROOT = new URL('../../packages/eval/fixtures/humanness/', import.meta.url).pathname;
const roundPath = (name: string) => ROOT + 'rounds/' + name + '.json';
const caseDir = (name: string) => ROOT + 'cases/' + name + '/';
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sourceName = process.argv[2];
if (!sourceName || sourceName.startsWith('--'))
  throw new Error('usage: humanness:record <round> [--as newRound] [--only caseId]');
const as = arg('--as') ?? sourceName + '-rec';
const only = arg('--only');

// .env is the worker's file; only fill what the shell does not already have.
for (const line of existsSync('.env') ? readFileSync('.env', 'utf8').split('\n') : []) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const env = envSchema.parse({
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://matchbot:matchbot@localhost:5432/matchbot',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  JEV_API_KEY: process.env.JEV_API_KEY ?? '',
  JEV_POLICY: 'off',
  DEFAULT_PHASE: '0',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? 'unused',
  TELEGRAM_OPS_CHAT_ID: process.env.TELEGRAM_OPS_CHAT_ID ?? 'unused',
});
if (!env.SNAPSHOT_KEY) throw new Error('record needs SNAPSHOT_KEY (in .env or the shell)');
const snapshotKey = env.SNAPSHOT_KEY;

const source = roundSchema.parse(JSON.parse(readFileSync(roundPath(sourceName), 'utf8')));
const deps = buildDeps({ env });
const prisma = createPrisma(env.DATABASE_URL);
const repos = createRepositories(prisma);
const cases: RoundCase[] = [];
const restorePolicies = new Map<
  string,
  { isActive: boolean; phase: 0 | 1 | 2; rateLimitPerDay: number }
>();
let tokens = 0;
// A recording that was stopped mid-run leaves its copies running/accepted, and the next recording
// of the same member then waits on user_busy forever (2026-10-23: 5 of 17 asks never ran).
const abandoned = await prisma.message.updateMany({
  where: {
    executionStatus: { in: ['running', 'accepted'] },
    // Any age: the group is at Phase 0 and only recordings use it while one runs (a chain stopped
    // seconds earlier left fresh rows that blocked r3-p54's first two asks).
  },
  data: { executionStatus: 'failed', executionError: 'abandoned_replay' },
});
if (abandoned.count) out(`released ${abandoned.count} abandoned executions`);
try {
  for (const c of source.cases) {
    if (only && c.id !== only) continue;
    if (!c.sourceMessageId) {
      out(`skip ${c.id}: no source message`);
      continue;
    }
    const original = await prisma.message.findUnique({
      where: { id: c.sourceMessageId },
      select: { id: true, text: true, userId: true, groupId: true, receivedAt: true },
    });
    if (!original?.text.trim() || !original.groupId) {
      out(`skip ${c.id}: original missing, blanked or private`);
      continue;
    }
    const group = await prisma.group.findUnique({
      where: { id: original.groupId },
      select: { externalId: true, isActive: true, phase: true, rateLimitPerDay: true },
    });
    const author = await repos.users.findById(original.userId);
    if (!group || !author) throw new Error('group_or_author_missing');
    if (!restorePolicies.has(group.externalId)) {
      restorePolicies.set(group.externalId, {
        isActive: group.isActive,
        phase: group.phase === 1 || group.phase === 2 ? group.phase : 0,
        rateLimitPerDay: group.rateLimitPerDay ?? 30,
      });
      await repos.groups.setPolicy({
        channel: 'telegram',
        externalId: group.externalId,
        isActive: true,
        phase: 0,
        rateLimitPerDay: group.rateLimitPerDay ?? 30,
      });
    }
    // As in p47: tasks the author opened at or after that moment (the task this very message
    // created) are expired so the replay plans the ask afresh instead of continuing them.
    // 2026-10-23: any open status, not only active — a task a previous recording left waiting
    // for the user made the planner acknowledge the re-asked printer request and stay silent.
    // Every member's: the main agent's group view lists open threads across the chat (P53).
    const expired = await prisma.task.updateMany({
      where: {
        chatId: group.externalId,
        status: { notIn: ['completed', 'cancelled', 'expired'] },
        createdAt: { gte: original.receivedAt },
      },
      data: { status: 'expired' },
    });
    const externalId = 'replay-' + original.id + '-' + Date.now();
    const msg = {
      channel: 'telegram' as const,
      chatId: group.externalId,
      messageId: externalId,
      userId: author.externalId,
      text: original.text,
      lang: 'zh',
      receivedAt: original.receivedAt.toISOString(),
    };
    const started = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const outcome = await processInbound(deps, msg);
      if (!outcome || !('deferMs' in outcome)) break;
      await pause(Math.min(outcome.deferMs, 5000));
    }
    const stored = await repos.messages.findExisting({
      groupId: original.groupId,
      userId: author.id,
      externalId,
    });
    if (!stored) {
      out(`${c.id}: not stored (dropped before admission)`);
      continue;
    }
    const traces = await prisma.decisionTrace.findMany({
      where: { inputRef: stored.id },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, output: true },
    });
    const used = traces
      .filter((t) => t.kind === 'agent_run')
      .reduce((n, t) => {
        const o = t.output as { inputTokens?: number; outputTokens?: number };
        return n + (o.inputTokens ?? 0) + (o.outputTokens ?? 0);
      }, 0);
    tokens += used;
    const rows = await prisma.outboundMessage.findMany({
      where: { sourceMessageId: stored.id, kind: { in: ['recommendation', 'clarification'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, status: true, text: true, sourceMessageId: true },
    });
    const gates = traces
      .filter((t) => t.kind === 'gate')
      .map((t) => t.output as Record<string, unknown>)
      .map((o) => {
        const v = o['outcome'] ?? o['gate'];
        return typeof v === 'string' ? v : '';
      })
      .filter(Boolean);
    out(
      `${c.id} → ${stored.id}: ${rows.length} reply, ${used} tokens, ${Date.now() - started}ms, expired tasks ${expired.count}, gates ${gates.join('>')}`,
    );
    for (const row of rows) {
      const rc = toRoundCase({
        ...row,
        sourceMessage: { text: original.text, receivedAt: original.receivedAt, userId: author.id },
      });
      cases.push(rc);
      out('  ' + rc.line);
    }
  }
  const round: Round = {
    version: 1,
    name: as,
    generatedAt: new Date().toISOString(),
    source: 'db',
    agentVersion: AGENT_VERSION,
    window: source.window,
    cases,
    humans: source.humans,
  };
  mkdirSync(ROOT + 'rounds/', { recursive: true });
  writeFileSync(roundPath(as), JSON.stringify(round, null, 2) + '\n');
  let frozen = 0;
  for (const c of cases) {
    const result = await freezeCase({ repos, prisma, snapshotKey, round, caseId: c.id });
    if ('skipped' in result) {
      out(`freeze skip ${c.id}: ${result.skipped}`);
      continue;
    }
    mkdirSync(caseDir(as), { recursive: true });
    writeFileSync(
      caseDir(as) + c.id + '.json',
      JSON.stringify(caseFixtureSchema.parse(result), null, 2) + '\n',
    );
    frozen++;
  }
  out(
    `\nrecorded ${cases.length} replies (${tokens} model tokens) → ${roundPath(as)}; froze ${frozen} cases → ${caseDir(as)}`,
  );
} finally {
  for (const [externalId, policy] of restorePolicies)
    await repos.groups.setPolicy({ channel: 'telegram', externalId, ...policy });
  await prisma.$disconnect();
}

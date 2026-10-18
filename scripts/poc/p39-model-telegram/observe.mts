/** Read only the current batch's synthetic actors in the dedicated group. Never decrypt checkpoints. */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadEnv } from '../../../packages/shared/src/index.js';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import { loadActorLabConfig } from '../../../apps/bot/src/actor-lab-config.js';
const root = z
  .string()
  .regex(/^logs\/p39\/live-[a-f0-9-]{36}$/)
  .parse(process.argv[2]);
const batch = z
  .object({ startedAt: z.coerce.date(), state: z.string() })
  .parse(JSON.parse(readFileSync(root + '/batch.json', 'utf8')));
const env = loadEnv(),
  cfg = loadActorLabConfig(env.ACTOR_LAB_CONFIG_PATH!);
const main = createPrisma(env.DATABASE_URL),
  control = createPrisma(cfg.controlDatabaseUrl),
  repos = createRepositories(main);
try {
  const group = await main.group.findFirstOrThrow({
    where: { externalId: cfg.groupId, channel: 'telegram' },
    select: { id: true, phase: true, isActive: true },
  });
  const messages = await main.message.findMany({
    where: {
      groupId: group.id,
      user: { externalId: { in: cfg.actors.map((a) => a.id) }, channel: 'telegram' },
      receivedAt: { gte: batch.startedAt },
    },
    select: { id: true, executionStatus: true, text: true, receivedAt: true },
    orderBy: { receivedAt: 'asc' },
  });
  const ids = messages.map((m) => m.id);
  const traces = await main.decisionTrace.findMany({
    where: { inputRef: { in: ids } },
    select: { kind: true, output: true },
  });
  const actor = await control.decisionTrace.findMany({
    where: {
      kind: 'agent_run',
      createdAt: { gte: batch.startedAt },
      inputRef: { startsWith: 'actor-model:' },
    },
    select: { kind: true, output: true },
  });
  const usage = z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    model: z.string().optional(),
  });
  const calls = [...traces.filter((t) => t.kind === 'agent_run'), ...actor]
    .map((t) => usage.safeParse(t.output))
    .filter((r) => r.success)
    .map((r) => r.data);
  const outgoing = await main.outboundMessage.findMany({
    where: { sourceMessageId: { in: ids }, target: cfg.groupId },
    select: { id: true, sourceMessageId: true, status: true, kind: true, text: true },
    orderBy: { createdAt: 'asc' },
  });
  const groupGate = z.object({
    gate: z.string(),
    decision: z.unknown().optional(),
    reason: z.unknown().optional(),
    result: z.unknown().optional(),
  });
  const report = {
    state: batch.state,
    group: { phase: group.phase, isActive: group.isActive },
    messages: messages.map(({ text: _text, ...m }) => m),
    generatedTokens: calls.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0),
    modelCalls: calls.length,
    models: [...new Set(calls.map((c) => c.model ?? 'unspecified'))],
    outbounds: outgoing.map(({ text: _text, ...o }) => o),
    gates: traces
      .filter((t) => t.kind === 'gate')
      .flatMap((t) => {
        const p = groupGate.safeParse(t.output);
        return p.success ? [p.data] : [];
      }),
  };
  writeFileSync(root + '/progress.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
  if (process.argv[3] === '--answers')
    process.stdout.write(
      JSON.stringify({
        syntheticConversation: messages.map((m) => ({
          input: m.text,
          status: m.executionStatus,
          replies: outgoing
            .filter((o) => o.sourceMessageId === m.id && o.status === 'sent')
            .map((o) => ({ kind: o.kind, text: o.text })),
        })),
      }) + '\n',
    );
} finally {
  await main.$disconnect();
  await control.$disconnect();
}

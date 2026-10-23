/**
 * P54 T6 `node --import tsx scripts/local/notes-replay.mts [--since ISO] [--until ISO]`: runs the
 * background notetaker over one group's stored public messages in insert order, as the cron would
 * have, so the notes can be reviewed before a live run. Clears that group's notes first. Real model:
 * counts against the Match Bot generation budget. Notes are printed locally, never committed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { buildDeps } from '../../apps/worker/src/deps.js';
import { consolidateGroupMemory, memberAlias } from '../../packages/agent/src/index.js';
import { createPrisma, createRepositories } from '../../packages/db/src/index.js';
import { envSchema } from '../../packages/shared/src/index.js';

const out = (line: string) => process.stdout.write(line + '\n');
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
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
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? 'unused',
  TELEGRAM_OPS_CHAT_ID: process.env.TELEGRAM_OPS_CHAT_ID ?? 'unused',
});
const since = new Date(arg('--since') ?? '2026-10-22T07:00:00Z');
const until = new Date(arg('--until') ?? '2026-10-22T15:00:00Z');
const externalId = arg('--group') ?? '-5013792100';
const deps = buildDeps({ env });
const repos = createRepositories(createPrisma(env.DATABASE_URL));
const group = await repos.groups.findByExternal('telegram', externalId);
if (!group) throw new Error('group not found: ' + externalId);
await repos.memberNotes.deleteForGroup(group.id);
await repos.groups.markMemoryConsolidated(group.id, since);
const totals = { added: 0, superseded: 0, rejected: 0, passes: 0 };
for (let cursor: Date = since; totals.passes < 40; totals.passes++) {
  const r = await consolidateGroupMemory(deps, { groupId: group.id, since: cursor, until });
  totals.added += r.added;
  totals.superseded += r.superseded;
  totals.rejected += r.rejected;
  const next = (await repos.groups.findByExternal('telegram', externalId))?.memoryConsolidatedAt;
  if (!next || next.getTime() === cursor.getTime() || next >= until) break;
  cursor = next;
}
out(
  `notetaker passes ${totals.passes + 1}: added ${totals.added}, superseded ${totals.superseded}, rejected ${totals.rejected}`,
);
for (const n of (await repos.memberNotes.listForGroup({ groupId: group.id, limit: 200 })).reverse())
  out(`  ${memberAlias(n.userId)} ${n.kind}: ${n.text}`);
process.exit(0);

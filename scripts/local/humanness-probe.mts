/**
 * P53/P54 `node --import tsx scripts/local/humanness-probe.mts [--repeat n]`: referral probes the
 * recorded rounds never contain. In the lab group at Phase 0, one member publicly offers something
 * (recently, or only long ago so it survives only as a P54 note), then another member asks for
 * exactly that through the real inbound pipeline. Prints the main agent's move and whom it
 * mentioned. Afterwards the probe lines are blanked and their notes deleted, so later runs and
 * transcripts do not see them. Real model: counts against the Match Bot generation budget.
 */
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { buildDeps } from '../../apps/worker/src/deps.js';
import { processInbound } from '../../apps/worker/src/pipeline/inbound.js';
import { consolidateGroupMemory } from '../../packages/agent/src/index.js';
import { createPrisma, createRepositories } from '../../packages/db/src/index.js';
import { envSchema, hashText } from '../../packages/shared/src/index.js';

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
  DEFAULT_PHASE: '0',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? 'unused',
  TELEGRAM_OPS_CHAT_ID: process.env.TELEGRAM_OPS_CHAT_ID ?? 'unused',
});
const repeat = Number(arg('--repeat') ?? 2);
const GROUP = arg('--group') ?? '-5013792100';
const deps = buildDeps({ env });
const prisma = createPrisma(env.DATABASE_URL);
const repos = createRepositories(prisma);
const group = await repos.groups.findByExternal('telegram', GROUP);
if (!group) throw new Error('group not found');
const policy = {
  isActive: group.isActive,
  phase: (group.phase === 1 || group.phase === 2 ? group.phase : 0) as 0 | 1 | 2,
  rateLimitPerDay: group.rateLimitPerDay ?? 30,
};
await repos.groups.setPolicy({ channel: 'telegram', externalId: GROUP, ...policy, phase: 0 });
await prisma.message.updateMany({
  where: { executionStatus: { in: ['running', 'accepted'] } },
  data: { executionStatus: 'failed', executionError: 'abandoned_replay' },
});
// Members who have spoken in the group: two askers, and a different offerer per probe so the
// two-referrals-a-day limit on one member does not decide the outcome.
const speakers = await prisma.message.groupBy({
  by: ['userId'],
  where: { groupId: group.id },
  _count: { userId: true },
  orderBy: { _count: { userId: 'desc' } },
  take: 5,
});
const members = await Promise.all(speakers.map((s) => repos.users.findById(s.userId)));
if (members.length < 5 || members.some((m) => !m)) throw new Error('need five members');
const [asker, other, ...offerers] = members as NonNullable<(typeof members)[number]>[];

const probes = [
  {
    name: 'recent offer in the conversation',
    offer: '我有两把多的羽毛球拍 周末谁要借可以找我',
    offerAgoMin: 20,
    ask: '周日想去打羽毛球 可惜没拍子 有人能借我一把吗',
    asker: asker!,
    offerer: offerers[0]!,
  },
  {
    name: 'offer known only from a note (9 h ago)',
    offer: '我那间房月底空出来了 在Mile End 合租 需要的可以问我',
    offerAgoMin: 9 * 60,
    ask: 'Mile End附近有人知道有空房吗 月底就得搬了',
    asker: other!,
    offerer: offerers[1]!,
  },
  {
    name: 'neighbour offering cat sitting',
    offer: '下周我都在狗岛这边 谁出门要人帮忙喂猫可以找我',
    offerAgoMin: 30,
    ask: '下周三周四出差 狗岛有人能帮我喂两天猫吗',
    asker: asker!,
    offerer: offerers[2]!,
  },
];

const created: string[] = [];
let tokens = 0;
try {
  for (let round = 0; round < repeat; round++) {
    for (const p of probes) {
      const now = Date.now();
      const offer = await repos.messages.create({
        groupId: group.id,
        userId: p.offerer.id,
        externalId: `probe-offer-${now}`,
        text: p.offer,
        receivedAt: new Date(now - p.offerAgoMin * 60e3),
      });
      created.push(offer.id);
      // Long-ago offers reach the main agent only through the notetaker, as the cron would run it.
      if (p.offerAgoMin > 6 * 60)
        await consolidateGroupMemory(deps, { groupId: group.id, since: new Date(now - 1000) });
      const externalId = `probe-ask-${now}`;
      const msg = {
        channel: 'telegram' as const,
        chatId: GROUP,
        messageId: externalId,
        userId: p.asker.externalId,
        text: p.ask,
        lang: 'zh',
        receivedAt: new Date().toISOString(),
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await processInbound(deps, msg);
        if (!r || !('deferMs' in r)) break;
        await pause(Math.min(r.deferMs, 5000));
      }
      const stored = await repos.messages.findExisting({
        groupId: group.id,
        userId: p.asker.id,
        externalId,
      });
      if (!stored) {
        out(`${p.name}: not admitted`);
        continue;
      }
      created.push(stored.id);
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
      const done = traces.find(
        (t) => (t.output as { outcome?: string }).outcome === 'agent_completed',
      )?.output as { toolsCalled?: string[] } | undefined;
      const dropped = traces.find((t) =>
        String((t.output as { outcome?: string }).outcome ?? '').startsWith('dropped'),
      )?.output as { reason?: string } | undefined;
      const rows = await prisma.outboundMessage.findMany({
        where: { sourceMessageId: stored.id, kind: { not: 'reaction' } },
        select: { kind: true, text: true, mentionUserId: true },
      });
      const moves = done?.toolsCalled?.join('>') ?? (dropped ? 'dropped:' + dropped.reason : '?');
      out(`#${round + 1} ${p.name}: ${moves} (${used} tokens)`);
      for (const row of rows)
        out(
          `   ${row.kind}${row.mentionUserId ? ' @' + (row.mentionUserId === p.offerer.externalId ? 'OFFERER' : row.mentionUserId === p.asker.externalId ? 'asker' : 'other') : ''}: ${row.text.split('\n')[0]!.slice(0, 120)}`,
        );
    }
  }
} finally {
  // Probe lines must not reach later transcripts, notes or joint runs.
  await prisma.memberNote.deleteMany({ where: { sourceMessageId: { in: created } } });
  // Dry-run replies of the probes would count toward real members' referral limits.
  await prisma.outboundMessage.deleteMany({
    where: { sourceMessageId: { in: created }, status: 'dry_run' },
  });
  await prisma.message.updateMany({
    where: { id: { in: created } },
    data: { text: '', textHash: hashText('') },
  });
  await repos.groups.setPolicy({ channel: 'telegram', externalId: GROUP, ...policy });
  out(`probe tokens ${tokens}; cleaned ${created.length} lines`);
}
process.exit(0);

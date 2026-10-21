// Replays the run-2 messages whose triage call was truncated, against the real provider, using the
// group transcript as it stood before each message. Counts against the approved Match Bot budget.
import { loadEnv, createLogger } from '../../../packages/shared/src/index.js';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import { DEFAULT_THRESHOLDS } from '../../../packages/gating/src/index.js';
import {
  configureModelProvider,
  createTraceProcessor,
  triageInbound,
  buildGroupTranscript,
} from '../../../packages/agent/src/index.js';

const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);
const repos = createRepositories(prisma);
const logger = createLogger('triage-replay', 'warn');
configureModelProvider(env, [createTraceProcessor({ traces: repos.traces, logger })]);
const deps = {
  env,
  repos,
  jev: { evaluate: () => Promise.reject(new Error('jev_off')) },
  thresholds: DEFAULT_THRESHOLDS,
  logger,
  evaluateOutbound: () => Promise.reject(new Error('jev_off')),
} as never;
const group = await repos.groups.findByExternal('telegram', '-5013792100');
const since = new Date(Date.now() - 100 * 60e3);
const all = (await prisma.message.findMany({
  where: { groupId: group!.id, receivedAt: { gte: since } },
  orderBy: { receivedAt: 'asc' },
})) as Array<{
  id: string;
  userId: string;
  text: string;
  receivedAt: Date;
  executionStatus: string | null;
}>;
const sent = await repos.outbound.recentSentToTarget('-5013792100', { limit: 50, sinceHours: 2 });
let total = 0;
for (const m of all.filter((x) => x.executionStatus === 'failed')) {
  const transcript = buildGroupTranscript({
    members: all.filter((x) => x.receivedAt < m.receivedAt),
    bot: sent.filter((b) => b.sentAt && b.sentAt < m.receivedAt),
    currentMessageId: m.id,
    currentUserId: m.userId,
  });
  const started = Date.now();
  const outcome = await triageInbound(deps, {
    text: m.text,
    inputRef: 'triage-replay:' + m.id,
    phase: 2,
    isPrivate: false,
    addressedToBot: false,
    transcript,
  });
  const usage = await repos.traces.summarizeUsage({
    since: new Date(started - 1000),
    inputRefs: ['triage-replay:' + m.id],
  });
  total += usage.inputTokens + usage.outputTokens;
  console.log(
    JSON.stringify({
      text: m.text.slice(0, 40),
      outcome: outcome.ok ? outcome.verdict : outcome,
      tokens: usage.inputTokens + usage.outputTokens,
      ms: Date.now() - started,
    }),
  );
}
console.log(JSON.stringify({ replayTokens: total }));
await prisma.$disconnect();

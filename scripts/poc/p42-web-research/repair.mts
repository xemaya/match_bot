/** Frozen synthetic evidence + real delivery model/JEV; checkpoint and outbox receipts stay in memory. */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadEnv, decrypt } from '../../../packages/shared/src/index.js';
import { getPrisma, disconnectPrisma } from '../../../packages/db/src/index.js';
import { buildDeps } from '../../../apps/worker/src/deps.js';
import { createMatchAgent, type MatchContext } from '../../../packages/agent/src/index.js';
import { researchContextSchema } from '../../../packages/agent/src/restore-search-context.js';
import { buildDeliveryPacket } from '../../../packages/agent/src/delivery-context.js';
import { z } from 'zod';

const env = loadEnv();
if (
  new URL(env.DATABASE_URL).hostname !== '127.0.0.1' ||
  new URL(env.DATABASE_URL).pathname !== '/matchbot_p41_live'
)
  throw new Error('local_test_only');
const reportPath = z
  .string()
  .regex(/^logs\/real-model\/local-\d+\/report\.json$/)
  .parse(process.argv[2]);
const previous = z
  .object({
    turns: z.array(
      z.object({
        turn: z.string(),
        text: z.string(),
        tasks: z.array(z.object({ id: z.string() })),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(reportPath, 'utf8')));
const failed = previous.turns.find((turn) => turn.turn === 'family-2');
if (!failed?.tasks[0]) throw new Error('missing_synthetic_case');
const deps = buildDeps({ env }),
  prisma = getPrisma(env.DATABASE_URL);
const message = await prisma.message.findFirstOrThrow({
  where: { taskId: failed.tasks[0].id, executionSnapshot: { not: null } },
  orderBy: { receivedAt: 'desc' },
});
const snapshot = z
  .object({ research: researchContextSchema })
  .parse(JSON.parse(decrypt(message.executionSnapshot!, env.SNAPSHOT_KEY!)));
const research = snapshot.research;
const task = await deps.repos.tasks.findById({
  id: failed.tasks[0].id,
  access: { userId: research.userId, scope: { channel: 'telegram', chatId: research.chatId } },
});
if (!task) throw new Error('missing_synthetic_task');
const id = 'p42-repair-' + randomUUID();
const ctx: MatchContext = {
  ...research,
  task,
  recentReplies: [],
  sourceMessageId: id,
  phase: 2,
  execution: { userId: research.userId, messageId: id, token: randomUUID(), fence: 1 },
  isAnswerFinalization: true,
  runDeadlineAt: Date.now() + 30000,
  outboundInputFailures: {
    tool: 'reply_to_request',
    count: 1,
    feedback: [
      'invalid answer: unsupported numerical values 0; omit these factual claims or cite supporting evidence.',
    ],
  },
};
ctx.deliverySourceRefs = buildDeliveryPacket(ctx).refs;
const report = {
  state: 'running',
  sourceReport: reportPath,
  limit: 60000,
  used: 0,
  uncertain: false,
  checkpointWrites: 0,
  sourceCount: ctx.deliverySourceRefs.length,
  calls: [] as unknown[],
  outbounds: [] as unknown[],
};
const path = reportPath.replace('report.json', 'repair.json');
const save = () => writeFileSync(path, JSON.stringify(report, null, 2), { mode: 0o600 });
// Do not replay a completed DB lease or enqueue a second production-like reply.
deps.repos = {
  ...deps.repos,
  executions: {
    ...deps.repos.executions,
    saveCheckpoint: async () => {
      report.checkpointWrites++;
      save();
      return true;
    },
  },
  outbound: {
    ...deps.repos.outbound,
    create: async (draft, status) => {
      report.outbounds.push({ text: draft.text, status });
      save();
      return { id, status, ...draft } as never;
    },
  },
};
const provider = createMatchAgent(deps, { phase: 0 }).runner.config.modelProvider;
deps.modelProvider = {
  getModel: async (name) => {
    const model = await provider.getModel(name);
    return {
      getStreamedResponse: () => {
        throw new Error('streaming_disabled');
      },
      getResponse: async (request) => {
        const reserve =
          Buffer.byteLength(
            JSON.stringify({
              instructions: request.systemInstructions,
              input: request.input,
              tools: request.tools,
            }),
          ) + 12000;
        if (report.uncertain || reserve > report.limit - report.used || report.calls.length >= 3)
          throw Object.assign(new Error('repair_budget_stop'), { name: 'ModelBudgetError' });
        report.uncertain = true;
        save();
        const response = await model.getResponse({
          ...request,
          modelSettings: { ...request.modelSettings, maxTokens: 2400 },
        });
        report.used += response.usage.inputTokens + response.usage.outputTokens;
        report.uncertain = false;
        report.calls.push({
          usage: response.usage,
          tools: response.output.filter((item) => item.type === 'function_call'),
        });
        save();
        return response;
      },
    };
  },
};
save();
try {
  const { agent, runner } = createMatchAgent(deps, {
    context: ctx,
    phase: 2,
    input: failed.text,
    inputRef: id,
    finalAnswerOnly: true,
  });
  await runner.run(agent, failed.text, {
    context: ctx,
    maxTurns: 3,
    signal: AbortSignal.timeout(30000),
  });
  report.state = report.outbounds.length ? 'draft_recorded_locally' : 'no_draft';
} catch (error) {
  report.state = error instanceof Error ? error.name : 'unknown_error';
} finally {
  save();
  await disconnectPrisma();
  process.stdout.write(
    JSON.stringify({
      state: report.state,
      used: report.used,
      checkpointWrites: report.checkpointWrites,
      sourceCount: report.sourceCount,
      path,
    }) + '\n',
  );
}

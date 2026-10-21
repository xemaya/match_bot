/** Local in-memory audit of prior synthetic checkpoints. Only aggregate counts leave memory. */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadEnv, decrypt } from '../../../packages/shared/src/index.js';
import { taskSchema } from '../../../packages/domain/src/index.js';
import { researchContextSchema } from '../../../packages/agent/src/restore-search-context.js';
import { researchInstructions as requestInstructions } from '../../../packages/agent/src/prompts/stages/research.js';
import { createMatchAgent } from '../../../packages/agent/src/index.js';
import type { AgentDeps, MatchContext } from '../../../packages/agent/src/context.js';
import { buildDeliveryPacket } from '../../../packages/agent/src/delivery-context.js';
async function main() {
  const env = loadEnv(),
    root = 'logs/p35/live-aa2adec9-c00c-49d2-b79d-37d4109d82dd/',
    rows = [];
  for (const id of ['gp-registration', 'printer', 'family-exhibition']) {
    const data = z
      .object({
        messages: z.array(z.object({ executionSnapshot: z.string().nullable() })),
        tasks: z.array(taskSchema),
      })
      .parse(JSON.parse(readFileSync(root + id + '.json', 'utf8')));
    const checkpoint = z
      .object({ taskId: z.string(), research: researchContextSchema })
      .parse(JSON.parse(decrypt(data.messages[0]!.executionSnapshot!, env.SNAPSHOT_KEY!)));
    const ctx: MatchContext = {
      ...checkpoint.research,
      task: data.tasks.find((t) => t.id === checkpoint.taskId)!,
      recentReplies: [],
    };
    const deps = {
      env,
      answerRequests: true,
      taskRequests: true,
      webSearch: { research: async () => ({ status: 'ok', sources: [] }), find: async () => [] },
      marketSearch: {},
      xhsSearch: {},
    } as unknown as AgentDeps;
    const packet = buildDeliveryPacket(ctx);
    ctx.deliverySourceRefs = packet.refs;
    rows.push({
      case: id,
      researchPromptChars: requestInstructions(deps, ctx, false, '2026-10-18').length,
      writerPromptChars: requestInstructions(deps, ctx, true, '2026-10-18').length,
      knowledgeSourceCount: ctx.knowledgeSources?.length ?? 0,
      marketSourceCount: ctx.marketListings?.length ?? 0,
      selectedSources: packet.refs.length,
      toolCount: createMatchAgent(deps, { phase: 0, requestContext: ctx }).agent.tools.length,
      writerTools: createMatchAgent(deps, { phase: 0, finalAnswerOnly: true }).agent.tools.length,
    });
  }
  writeFileSync('logs/p36/after.json', JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(rows) + '\n');
}
await main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({ errorKind: error instanceof Error ? error.name : 'unknown' }) + '\n',
  );
  process.exitCode = 1;
});

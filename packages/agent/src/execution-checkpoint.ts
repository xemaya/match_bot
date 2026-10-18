import { z } from 'zod';
import { decrypt, encrypt, hashText } from '@matchbot/shared';
import type { AgentDeps, MatchContext } from './context.js';
import { researchContextSchema, restoreSearchContext } from './restore-search-context.js';
import { bindTaskMarketPlan } from './task-market-plan.js';

const checkpointSchema = z.object({
  version: z.literal(1),
  agentVersion: z.string(),
  inputHash: z.string(),
  channel: z.enum(['telegram', 'feishu', 'whatsapp']),
  taskId: z.string().nullable(),
  requirementsVersion: z.number().int().nullable(),
  research: researchContextSchema,
});
function key(deps: AgentDeps) {
  if (!deps.env.SNAPSHOT_KEY) throw new Error('execution checkpoint encryption key missing');
  return deps.env.SNAPSHOT_KEY;
}
export async function saveExecutionCheckpoint(
  deps: AgentDeps,
  ctx: MatchContext,
  input: string,
  version: string,
) {
  if (!ctx.execution) return;
  const data = checkpointSchema.parse({
    version: 1,
    agentVersion: version,
    inputHash: hashText(input),
    channel: ctx.channel ?? 'telegram',
    taskId: ctx.task?.id ?? null,
    requirementsVersion: ctx.task?.requirementsVersion ?? null,
    research: ctx,
  });
  const snapshot = encrypt(JSON.stringify(data), key(deps));
  const saved = await deps.repos.executions.saveCheckpoint({
    lease: ctx.execution,
    snapshot,
    ...(ctx.task
      ? { task: { id: ctx.task.id, requirementsVersion: ctx.task.requirementsVersion } }
      : {}),
  });
  if (!saved) throw new Error('execution checkpoint fence lost');
}
export function restoreExecutionCheckpoint(
  deps: AgentDeps,
  ctx: MatchContext,
  input: string,
  snapshot: string,
  version: string,
): MatchContext {
  const data = checkpointSchema.parse(JSON.parse(decrypt(snapshot, key(deps))) as unknown);
  if (
    data.inputHash !== hashText(input) ||
    data.research.userId !== ctx.userId ||
    data.research.chatId !== ctx.chatId ||
    data.research.sourceMessageId !== ctx.sourceMessageId ||
    data.channel !== (ctx.channel ?? 'telegram')
  )
    throw new Error('execution checkpoint scope mismatch');
  if (
    data.taskId !== (ctx.task?.id ?? null) ||
    data.requirementsVersion !== (ctx.task?.requirementsVersion ?? null)
  )
    throw new Error('execution checkpoint task version changed');
  const restored = restoreSearchContext(
    { ...ctx, phase: data.research.phase },
    JSON.stringify({ context: { context: data.research } }),
  );
  restored.phase = ctx.phase;
  if (data.agentVersion !== version) {
    delete restored.sourceReviewCache;
    delete restored.taskProgressVersion;
    delete restored.deliverySourceRefs;
  }
  if (restored.task && restored.marketPlan)
    restored.marketPlan = bindTaskMarketPlan(restored.marketPlan, restored.task);
  return restored;
}

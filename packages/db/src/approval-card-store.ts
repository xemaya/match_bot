import { persistedChannelRoute } from '@matchbot/domain';
import { formatApprovalPreview } from '@matchbot/domain';
import type { Phase } from '@matchbot/domain';
import { z } from 'zod';
import { lockExecutionUser } from './execution-fence.js';
import type { Prisma } from './generated/client.js';

const telegramOpsChatSchema = z
  .string()
  .regex(/^-[1-9]\d{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
export const opsChatSchema = z.union([
  telegramOpsChatSchema,
  z.string().regex(/^oc_[A-Za-z0-9_-]{1,200}$/),
]);
export const phaseSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
function phase(value: number): Phase {
  return value === 1 || value === 2 ? value : 0;
}
export async function approvalCardEligibility(
  tx: Prisma.TransactionClient,
  p: { runStateId: string; defaultPhase: Phase; now: Date },
) {
  const hint = await tx.runState.findUnique({
    where: { id: p.runStateId },
    select: { userId: true },
  });
  if (!hint) return { ok: false as const, reason: 'missing_snapshot', obsolete: true };
  await lockExecutionUser(tx, hint.userId);
  const rs = await tx.runState.findUnique({ where: { id: p.runStateId } });
  if (!rs) return { ok: false as const, reason: 'missing_snapshot', obsolete: true };
  if (rs.status !== 'pending' || rs.expiresAt <= p.now || !rs.messageId)
    return { ok: false as const, reason: 'snapshot_unavailable', obsolete: true };
  const source = await tx.message.findFirst({
    where: { id: rs.messageId, userId: rs.userId },
    include: { user: true, group: true, task: true },
  });
  if (
    !source?.executionKey ||
    !source.text ||
    !['running', 'waiting_approval'].includes(source.executionStatus ?? '') ||
    (persistedChannelRoute(source.channelRoute)?.chatId ??
      source.group?.externalId ??
      source.user.externalId) !== rs.chatId ||
    source.receivedAt.getTime() < p.now.getTime() - 30 * 86400e3
  )
    return { ok: false as const, reason: 'source_unavailable', obsolete: true };
  if (source.group && !source.group.isActive)
    return { ok: false as const, reason: 'source_inactive', obsolete: false };
  const currentPhase = phase(source.group?.phase ?? p.defaultPhase),
    effective = Math.min(currentPhase, phase(rs.phase), phase(source.executionPhase)) as Phase;
  if (!effective) return { ok: false as const, reason: 'phase0', obsolete: false };
  if (source.taskId) {
    const task = source.task,
      latest = await tx.taskEvent.findFirst({
        where: { taskId: source.taskId, kind: 'user_turn', sourceMessageId: { not: null } },
        orderBy: { revision: 'desc' },
      });
    if (
      !task ||
      task.userId !== rs.userId ||
      task.channel !== source.user.channel ||
      task.chatId !== rs.chatId ||
      task.threadId !== (persistedChannelRoute(source.channelRoute)?.threadId ?? '') ||
      task.requirementsVersion !== source.taskRequirementsVersion ||
      ['completed', 'cancelled', 'expired'].includes(task.status) ||
      latest?.sourceMessageId !== source.id
    )
      return { ok: false as const, reason: 'task_superseded', obsolete: true };
  }
  try {
    return {
      ok: true as const,
      runState: rs,
      source,
      phase: effective,
      text: formatApprovalPreview(rs.interruptions),
    };
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return { ok: false as const, reason: 'invalid_preview', obsolete: true };
  }
}

import { persistedChannelRoute } from '@matchbot/domain';
import type { OutboundDraft } from '@matchbot/domain';
import type { Prisma, PrismaClient, OutboundMessage } from './generated/client.js';
import { lockExecutionUser } from './execution-fence.js';
import { tasksRepo } from './repos/tasks.js';

async function currentTask(tx: Prisma.TransactionClient, row: OutboundMessage) {
  if (!row.taskId) return null;
  const record = await tx.task.findUnique({ where: { id: row.taskId } });
  if (!record) return null;
  const source = row.sourceMessageId
    ? await tx.message.findUnique({
        where: { id: row.sourceMessageId },
        include: { user: true, group: true },
      })
    : null;
  if (
    !source ||
    source.userId !== record.userId ||
    record.channel !== row.channel ||
    row.target !== record.chatId ||
    (row.threadId ?? '') !== record.threadId ||
    (persistedChannelRoute(source.channelRoute)?.threadId ?? '') !== record.threadId ||
    (persistedChannelRoute(source.channelRoute)?.chatId ??
      source.group?.externalId ??
      source.user.externalId) !== record.chatId
  )
    return null;
  const access = {
    userId: record.userId,
    scope: {
      channel: record.channel,
      chatId: record.chatId,
      ...(record.threadId ? { threadId: record.threadId } : {}),
    },
  };
  const task = await tasksRepo(tx as PrismaClient).findById({ access, id: record.id });
  return task ? { task, access } : null;
}
export async function lockOutboundTask(tx: Prisma.TransactionClient, row: OutboundMessage | null) {
  if (!row?.taskId) return;
  const task = await tx.task.findUnique({ where: { id: row.taskId }, select: { userId: true } });
  if (task) await lockExecutionUser(tx, task.userId);
}
export async function canSendTaskReply(tx: Prisma.TransactionClient, row: OutboundMessage) {
  if (row.sourceMessageId) {
    const source = await tx.message.findUnique({
      where: { id: row.sourceMessageId },
      select: { text: true, receivedAt: true },
    });
    if (!source?.text || source.receivedAt.getTime() < Date.now() - 30 * 86400e3) return false;
  }
  if (row.taskRequirementsVersion === null) return true;
  const selected = await currentTask(tx, row);
  return (
    !!selected &&
    selected.task.requirementsVersion === row.taskRequirementsVersion &&
    selected.task.delivery.outboundMessageId === row.id &&
    selected.task.delivery.status === 'queued' &&
    !['completed', 'cancelled', 'expired'].includes(selected.task.status)
  );
}
export async function queueOutboundTask(
  tx: Prisma.TransactionClient,
  row: OutboundMessage,
  delivery: NonNullable<OutboundDraft['taskDelivery']>,
) {
  const selected = await currentTask(tx, row);
  if (!selected) throw new Error('outbound task is inaccessible');
  const { id: _id, ...intent } = delivery;
  const result = await tasksRepo(tx as PrismaClient).queueDelivery({
    access: selected.access,
    id: selected.task.id,
    expectedRevision: selected.task.revision,
    operationKey: 'outbound:' + row.id + ':queued',
    outboundMessageId: row.id,
    delivery: intent,
  });
  if (result.kind !== 'applied' && result.kind !== 'replayed')
    throw new Error('outbound task changed before queueing');
}
/** Called inside the same transaction as the authoritative channel receipt/state. */
export async function recordOutboundTaskReceipt(
  tx: Prisma.TransactionClient,
  row: OutboundMessage,
  status: 'sent' | 'unknown' | 'failed',
) {
  if (row.taskRequirementsVersion === null) return;
  const selected = await currentTask(tx, row);
  if (
    !selected ||
    selected.task.requirementsVersion !== row.taskRequirementsVersion ||
    selected.task.delivery.outboundMessageId !== row.id ||
    ['completed', 'cancelled', 'expired'].includes(selected.task.status)
  ) {
    await tx.decisionTrace.create({
      data: {
        kind: 'gate',
        inputRef: row.id,
        phase: row.phase === 1 || row.phase === 2 ? row.phase : 0,
        latencyMs: 0,
        costMicro: 0,
        output: { gate: 'task_delivery', decision: 'stale_receipt_ignored' },
      },
    });
    return;
  }
  if (selected.task.delivery.status === status) return;
  const result = await tasksRepo(tx as PrismaClient).recordDeliveryReceipt({
    access: selected.access,
    id: selected.task.id,
    expectedRevision: selected.task.revision,
    operationKey: 'outbound:' + row.id + ':' + status,
    requirementsVersion: row.taskRequirementsVersion,
    outboundMessageId: row.id,
    status,
  });
  if (result.kind !== 'applied' && result.kind !== 'replayed')
    throw new Error('task changed before delivery receipt');
}

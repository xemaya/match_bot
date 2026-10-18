import { executionLeaseSchema, type ExecutionLease } from '@matchbot/domain';
import { Prisma, type PrismaClient } from './generated/client.js';

export function inTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return typeof prisma.$transaction === 'function' ? prisma.$transaction(fn) : fn(prisma);
}
export async function lockExecutionUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  return tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      channel: true,
      externalId: true,
      channelScope: true,
      executionFence: true,
      executionLeaseToken: true,
      executionLeaseExpiresAt: true,
    },
  });
}
export async function activeExecution(
  tx: Prisma.TransactionClient,
  raw: ExecutionLease,
  now = new Date(),
) {
  const lease = executionLeaseSchema.parse(raw),
    user = await lockExecutionUser(tx, lease.userId);
  if (
    !user ||
    user.executionFence !== lease.fence ||
    user.executionLeaseToken !== lease.token ||
    !user.executionLeaseExpiresAt ||
    user.executionLeaseExpiresAt <= now
  )
    return null;
  return tx.message.findFirst({
    where: {
      id: lease.messageId,
      userId: lease.userId,
      executionFence: lease.fence,
      executionStatus: 'running',
    },
  });
}
export class ExecutionFenceLostError extends Error {
  constructor() {
    super('request execution fence lost');
    this.name = 'ExecutionFenceLostError';
  }
}
export async function withExecutionFence<T>(
  prisma: PrismaClient,
  lease: ExecutionLease,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return inTransaction(prisma, async (tx) => {
    const message = await activeExecution(tx, lease);
    if (!message || message.text === '' || message.receivedAt.getTime() < Date.now() - 30 * 86400e3)
      throw new ExecutionFenceLostError();
    return fn(tx);
  });
}

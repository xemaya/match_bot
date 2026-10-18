import { persistedChannelRoute } from '@matchbot/domain';
import type { Phase } from '@matchbot/domain';
import type { PrismaClient, RunState } from '../generated/client.js';
import { inTransaction } from '../execution-fence.js';
import { lockExecutionUser } from '../execution-fence.js';
import { phaseSchema } from '../approval-card-store.js';
import { z } from 'zod';

export function runStatesRepo(prisma: PrismaClient) {
  return {
    async pendingCards(raw: {
      agentVersion: string;
      sdkVersion: string;
      defaultPhase: Phase;
      limit?: number;
    }) {
      const p = z
        .object({
          agentVersion: z.string().min(1),
          sdkVersion: z.string().min(1),
          defaultPhase: phaseSchema,
          limit: z.number().int().min(1).max(100).default(20),
        })
        .parse(raw);
      return prisma.runState.findMany({
        where: {
          status: 'pending',
          phase: { in: [1, 2] },
          agentVersion: p.agentVersion,
          sdkVersion: p.sdkVersion,
          expiresAt: { gt: new Date() },
          messageId: { not: null },
          outboundCard: { is: null },
          message: {
            executionKey: { not: null },
            executionPhase: { in: [1, 2] },
            text: { not: '' },
            executionStatus: { in: ['running', 'waiting_approval'] },
            OR: [
              { group: { isActive: true, phase: { in: [1, 2] } } },
              ...(p.defaultPhase ? [{ groupId: null }] : []),
            ],
          },
        },
        orderBy: { createdAt: 'asc' },
        take: p.limit,
      });
    },
    async create(p: {
      userId: string;
      chatId: string;
      phase: Phase;
      messageId?: string;
      task?: { id: string; requirementsVersion: number };
      snapshot: string;
      agentVersion: string;
      sdkVersion: string;
      interruptions: unknown;
      expiresAt: Date;
    }): Promise<RunState> {
      return inTransaction(prisma, async (tx) => {
        const { task, ...data } = p;
        if (p.messageId) {
          const message = await tx.message.findFirst({
            where: { id: p.messageId, userId: p.userId },
            include: { user: true, group: true },
          });
          if (
            !message ||
            (persistedChannelRoute(message.channelRoute)?.chatId ??
              message.group?.externalId ??
              message.user.externalId) !== p.chatId
          )
            throw new Error('approval message binding inaccessible');
          if (task) {
            const bound = await tx.task.findFirst({
              where: {
                id: task.id,
                userId: p.userId,
                channel: message.user.channel,
                chatId: p.chatId,
                threadId: persistedChannelRoute(message.channelRoute)?.threadId ?? '',
                requirementsVersion: task.requirementsVersion,
              },
            });
            if (!bound) throw new Error('approval task binding inaccessible or obsolete');
            await tx.message.update({
              where: { id: message.id },
              data: { taskId: bound.id, taskRequirementsVersion: bound.requirementsVersion },
            });
          }
        }
        return tx.runState.create({ data: { ...data, interruptions: p.interruptions as object } });
      });
    },
    /** 原子消费：条件更新 0 行即已被别人恢复过（AGENTS.md §3.3 第 6 条）。 */
    async consume(id: string): Promise<RunState | null> {
      const r = await prisma.runState.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'consumed', consumedAt: new Date() },
      });
      if (r.count === 0) return null;
      return prisma.runState.findUnique({ where: { id } });
    },
    async expireOld(now: Date): Promise<number> {
      const at = z.date().parse(now);
      let total = 0;
      for (let batch = 0; batch < 10; batch++) {
        const count = await inTransaction(prisma, async (tx) => {
          const rows = await tx.runState.findMany({
            where: {
              expiresAt: { lte: at },
              OR: [
                { status: { not: 'expired' } },
                { snapshot: { not: '' } },
                { interruptions: { not: [] } },
              ],
            },
            select: { id: true, userId: true, messageId: true, phase: true },
            orderBy: { expiresAt: 'asc' },
            take: 100,
          });
          for (const row of rows) {
            const user = await lockExecutionUser(tx, row.userId);
            await tx.runState.update({
              where: { id: row.id },
              data: { status: 'expired', snapshot: '', interruptions: [] },
            });
            await tx.approval.updateMany({
              where: { runStateId: row.id, resumeStatus: { in: ['accepted', 'running'] } },
              data: { resumeStatus: 'failed', resumeError: 'snapshot_expired' },
            });
            await tx.approval.updateMany({
              where: { runStateId: row.id, editedText: { not: null } },
              data: { editedText: null },
            });
            await tx.outboundMessage.updateMany({
              where: { approvalRunStateId: row.id },
              data: { text: '[approval content expired]' },
            });
            await tx.outboundMessage.updateMany({
              where: { approvalRunStateId: row.id, status: { in: ['pending', 'dry_run'] } },
              data: { status: 'failed', error: 'snapshot_expired' },
            });
            await tx.outboundMessage.updateMany({
              where: { approvalRunStateId: row.id, status: 'sending' },
              data: { status: 'delivery_unknown', error: 'snapshot_expired' },
            });
            const other = row.messageId
              ? await tx.runState.findFirst({
                  where: {
                    messageId: row.messageId,
                    expiresAt: { gt: at },
                    OR: [
                      { status: 'pending' },
                      { approvals: { some: { resumeStatus: { in: ['accepted', 'running'] } } } },
                    ],
                  },
                  select: { id: true },
                })
              : null;
            if (row.messageId && !other) {
              const source = await tx.message.findFirst({
                where: {
                  id: row.messageId,
                  userId: row.userId,
                  executionStatus: { in: ['running', 'waiting_approval'] },
                },
              });
              if (source) {
                const answer = await tx.outboundMessage.findFirst({
                  where: {
                    sourceMessageId: source.id,
                    approvalRunStateId: null,
                    kind: { not: 'reaction' },
                  },
                  select: { id: true },
                });
                await tx.message.update({
                  where: { id: source.id },
                  data: {
                    executionStatus: answer ? 'completed' : 'failed',
                    executionError: answer ? null : 'snapshot_expired',
                  },
                });
                if (user?.executionFence === source.executionFence)
                  await tx.user.update({
                    where: { id: row.userId },
                    data: { executionLeaseToken: null, executionLeaseExpiresAt: null },
                  });
              }
            }
            await tx.decisionTrace.create({
              data: {
                kind: 'gate',
                inputRef: row.id,
                phase: row.phase === 1 || row.phase === 2 ? row.phase : 0,
                latencyMs: 0,
                costMicro: 0,
                output: { gate: 'snapshot_retention', decision: 'expired_content_redacted' },
              },
            });
          }
          return rows.length;
        });
        total += count;
        if (count < 100) break;
      }
      return total;
    },
    findById(id: string): Promise<RunState | null> {
      return prisma.runState.findUnique({ where: { id } });
    },
  };
}

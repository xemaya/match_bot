import { persistedChannelRoute } from '@matchbot/domain';
import { randomUUID } from 'node:crypto';
import { executionLeaseSchema, type ExecutionLease } from '@matchbot/domain';
import { z } from 'zod';
import type { Approval, PrismaClient, Prisma, RunState } from '../generated/client.js';
import { inTransaction, lockExecutionUser, activeExecution } from '../execution-fence.js';
import { executionsRepo } from './executions.js';

const id = z.string().min(1).max(160);
const jobSchema = z.object({ runStateId: id, approvalId: id });
const decideSchema = z.object({
  runStateId: id,
  reviewer: z.string().min(1).max(160),
  decision: z.enum(['approve', 'reject', 'edit', 'ignore']),
  editedText: z.string().max(4000).optional(),
  now: z.date().optional(),
});
const claimSchema = jobSchema.extend({
  now: z.date().optional(),
  leaseMs: z.number().int().min(1000).max(300000).optional(),
});
const finishSchema = jobSchema.extend({
  lease: executionLeaseSchema,
  status: z.enum(['accepted', 'completed', 'waiting_approval', 'failed']),
  errorCode: z
    .string()
    .regex(/^[a-z0-9_]{1,80}$/)
    .optional(),
  nextRunStateId: id.optional(),
  now: z.date().optional(),
});
type ClaimResult =
  | { kind: 'acquired'; lease: ExecutionLease; runState: RunState; approval: Approval }
  | { kind: 'busy'; retryAfterMs: number }
  | { kind: 'done' | 'invalid' };

async function trace(tx: Prisma.TransactionClient, rs: RunState, decision: string) {
  await tx.decisionTrace.create({
    data: {
      kind: 'gate',
      inputRef: rs.messageId ?? rs.id,
      phase: rs.phase === 1 || rs.phase === 2 ? rs.phase : 0,
      latencyMs: 0,
      costMicro: 0,
      output: { gate: 'approval_execution', runStateId: rs.id, decision },
    },
  });
}

export function approvalsRepo(prisma: PrismaClient) {
  return {
    /** A consumed SDK snapshot and its durable wake intent share one commit; Redis is only transport. */
    async decide(raw: z.input<typeof decideSchema>): Promise<Approval | null> {
      const p = decideSchema.parse(raw),
        now = p.now ?? new Date();
      return inTransaction(prisma, async (tx) => {
        const rs = await tx.runState.findUnique({ where: { id: p.runStateId } });
        if (!rs?.messageId) return null; // Historical snapshots have no provable request binding.
        await lockExecutionUser(tx, rs.userId);
        const message = await tx.message.findFirst({
          where: {
            id: rs.messageId,
            userId: rs.userId,
            executionKey: { not: null },
            executionStatus: { in: ['running', 'waiting_approval'] },
          },
        });
        if (!message) return null;
        const consumed = await tx.runState.updateMany({
          where: { id: rs.id, status: 'pending', expiresAt: { gt: now } },
          data: { status: 'consumed', consumedAt: now },
        });
        if (consumed.count !== 1) return null;
        const approval = await tx.approval.create({
          data: {
            runStateId: rs.id,
            reviewer: p.reviewer,
            decision: p.decision,
            ...(p.editedText ? { editedText: p.editedText } : {}),
            resumeStatus: p.decision === 'ignore' ? 'completed' : 'accepted',
          },
        });
        if (p.decision === 'ignore') {
          await tx.message.update({
            where: { id: message.id },
            data: { executionStatus: 'completed' },
          });
          // Do not release a lease belonging to a newer input.
          await tx.user.updateMany({
            where: { id: rs.userId, executionFence: message.executionFence ?? -1 },
            data: { executionLeaseToken: null, executionLeaseExpiresAt: null },
          });
        }
        await trace(tx, rs, p.decision === 'ignore' ? 'ignored' : 'decision_and_intent_saved');
        return approval;
      });
    },
    async markEnqueued(raw: z.input<typeof jobSchema>): Promise<void> {
      const p = jobSchema.parse(raw);
      await prisma.approval.updateMany({
        where: {
          id: p.approvalId,
          runStateId: p.runStateId,
          resumeStatus: { in: ['accepted', 'running'] },
        },
        data: { resumeQueuedAt: new Date() },
      });
    },
    async dispatchable(limit = 20, now = new Date()) {
      const rows = await prisma.approval.findMany({
        where: {
          AND: [
            {
              OR: [
                { resumeQueuedAt: null },
                { resumeQueuedAt: { lt: new Date(now.getTime() - 30000) } },
              ],
            },
            {
              OR: [
                { resumeStatus: 'accepted' },
                {
                  resumeStatus: 'running',
                  runState: {
                    user: {
                      OR: [
                        { executionLeaseExpiresAt: null },
                        { executionLeaseExpiresAt: { lte: now } },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
        orderBy: { decidedAt: 'asc' },
        take: z.number().int().min(1).max(100).parse(limit),
      });
      return rows.map((row) => ({
        runStateId: row.runStateId,
        approvalId: row.id,
        recoverActive: row.resumeStatus === 'running',
      }));
    },
    async claimResume(raw: z.input<typeof claimSchema>): Promise<ClaimResult> {
      const p = claimSchema.parse(raw),
        now = p.now ?? new Date();
      return inTransaction(prisma, async (tx) => {
        const rs = await tx.runState.findUnique({ where: { id: p.runStateId } });
        if (!rs) return { kind: 'invalid' };
        const user = await lockExecutionUser(tx, rs.userId),
          approval = await tx.approval.findFirst({
            where: { id: p.approvalId, runStateId: rs.id },
          });
        if (!user || !approval?.resumeStatus) return { kind: 'invalid' };
        if (approval.resumeStatus !== 'accepted' && approval.resumeStatus !== 'running')
          return { kind: 'done' };
        if (
          user.executionLeaseToken &&
          user.executionLeaseExpiresAt &&
          user.executionLeaseExpiresAt > now
        )
          return { kind: 'busy', retryAfterMs: 2000 };
        const message = rs.messageId
          ? await tx.message.findFirst({
              where: { id: rs.messageId, userId: rs.userId },
              include: { group: true, task: true },
            })
          : null;
        const invalid =
          !message ||
          !message.executionKey ||
          rs.status !== 'consumed' ||
          rs.expiresAt <= now ||
          !message.text ||
          message.receivedAt.getTime() < now.getTime() - 30 * 86400e3 ||
          (message.group
            ? !message.group.isActive || message.group.externalId !== rs.chatId
            : (persistedChannelRoute(message.channelRoute)?.chatId ?? user.externalId) !==
              rs.chatId) ||
          (message.taskId !== null &&
            (!message.task ||
              message.task.userId !== user.id ||
              message.task.chatId !== rs.chatId ||
              message.task.threadId !==
                (persistedChannelRoute(message.channelRoute)?.threadId ?? '') ||
              message.task.channel !== user.channel ||
              message.task.requirementsVersion !== message.taskRequirementsVersion ||
              ['completed', 'cancelled', 'expired'].includes(message.task.status)));
        const latestTurn = message?.taskId
          ? await tx.taskEvent.findFirst({
              where: { taskId: message.taskId, kind: 'user_turn', sourceMessageId: { not: null } },
              orderBy: { revision: 'desc' },
            })
          : null;
        const superseded = !!latestTurn && latestTurn.sourceMessageId !== message?.id;
        const terminal =
          !message ||
          message.executionStatus === 'completed' ||
          message.executionStatus === 'failed';
        const outbox = message
          ? await tx.outboundMessage.findFirst({
              where: {
                sourceMessageId: message.id,
                kind: { not: 'reaction' },
                approvalRunStateId: null,
              },
            })
          : null;
        const next = message
          ? await tx.runState.findFirst({
              where: {
                messageId: message.id,
                id: { not: rs.id },
                status: 'pending',
                expiresAt: { gt: now },
              },
            })
          : null;
        if (invalid || superseded || terminal || outbox || next || approval.resumeAttempts >= 3) {
          const failed = invalid || superseded || approval.resumeAttempts >= 3;
          await tx.approval.update({
            where: { id: approval.id },
            data: {
              resumeStatus: failed ? 'failed' : 'completed',
              resumeError: failed ? 'obsolete_or_exhausted' : null,
            },
          });
          if (message && !terminal)
            await tx.message.update({
              where: { id: message.id },
              data: {
                executionStatus: failed ? 'failed' : next ? 'waiting_approval' : 'completed',
              },
            });
          if (message && user.executionFence === message.executionFence)
            await tx.user.update({
              where: { id: user.id },
              data: { executionLeaseToken: null, executionLeaseExpiresAt: null },
            });
          await trace(tx, rs, failed ? 'obsolete_or_exhausted' : 'already_settled');
          return { kind: 'done' };
        }
        if (!message) return { kind: 'invalid' };
        const token = randomUUID(),
          fence = user.executionFence + 1;
        await tx.user.update({
          where: { id: user.id },
          data: {
            executionLeaseToken: token,
            executionLeaseExpiresAt: new Date(now.getTime() + (p.leaseMs ?? 240000)),
            executionFence: fence,
          },
        });
        await tx.message.update({
          where: { id: message.id },
          data: { executionStatus: 'running', executionFence: fence },
        });
        const claimed = await tx.approval.update({
          where: { id: approval.id },
          data: {
            resumeStatus: 'running',
            resumeAttempts: { increment: 1 },
            resumeFence: fence,
            resumeError: null,
          },
        });
        await trace(tx, rs, 'resume_claimed');
        return {
          kind: 'acquired',
          lease: { userId: user.id, messageId: message.id, token, fence },
          runState: rs,
          approval: claimed,
        };
      });
    },
    async finishResume(raw: z.input<typeof finishSchema>): Promise<boolean> {
      const p = finishSchema.parse(raw);
      return inTransaction(prisma, async (tx) => {
        const message = await activeExecution(tx, p.lease, p.now);
        if (!message) return false;
        const approval = await tx.approval.findFirst({
          where: {
            id: p.approvalId,
            runStateId: p.runStateId,
            resumeStatus: 'running',
            resumeFence: p.lease.fence,
            runState: { userId: p.lease.userId, messageId: p.lease.messageId },
          },
        });
        if (!approval) return false;
        const retry = p.status === 'accepted',
          status = retry && approval.resumeAttempts >= 3 ? 'failed' : p.status;
        if (status === 'accepted') {
          await tx.message.update({
            where: { id: message.id },
            data: { executionStatus: 'waiting_approval', executionError: p.errorCode ?? null },
          });
          await tx.user.update({
            where: { id: p.lease.userId },
            data: { executionLeaseToken: null, executionLeaseExpiresAt: null },
          });
          const rs = await tx.runState.findUniqueOrThrow({ where: { id: p.runStateId } });
          await trace(tx, rs, 'resume_retry_pending');
        } else if (
          !(await executionsRepo(tx as PrismaClient).finish({
            lease: p.lease,
            status,
            ...(p.nextRunStateId ? { runStateId: p.nextRunStateId } : {}),
            ...(p.errorCode ? { errorCode: p.errorCode } : {}),
            ...(p.now ? { now: p.now } : {}),
          }))
        )
          return false;
        // Retrying uses the consumed original snapshot, not a new pending SDK interruption.
        await tx.approval.update({
          where: { id: approval.id },
          data: {
            resumeStatus: status === 'waiting_approval' ? 'completed' : status,
            resumeError: p.errorCode ?? null,
            ...(retry ? { resumeQueuedAt: null } : {}),
          },
        });
        return true;
      });
    },
    create(p: {
      runStateId: string;
      reviewer: string;
      decision: 'approve' | 'reject' | 'edit' | 'ignore';
      editedText?: string;
    }): Promise<Approval> {
      return prisma.approval.create({ data: p });
    },
    findById(id: string): Promise<Approval | null> {
      return prisma.approval.findUnique({ where: { id } });
    },
  };
}

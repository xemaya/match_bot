import {
  accountScopeKey,
  inboundEventKey,
  isDirectMessage,
  channelRouteSchema,
  persistedChannelRoute,
} from '@matchbot/domain';
import { randomUUID } from 'node:crypto';
import { executionLeaseSchema, inboundMessageSchema, type ExecutionLease } from '@matchbot/domain';
import { hashText } from '@matchbot/shared';
import { z } from 'zod';
import {
  inTransaction,
  lockExecutionUser,
  activeExecution,
  ExecutionFenceLostError,
} from '../execution-fence.js';
import type { Message, Prisma, PrismaClient } from '../generated/client.js';

const id = z.string().min(1).max(160);
const acceptSchema = z.object({
  userId: id,
  groupId: id.nullable(),
  message: inboundMessageSchema,
  phase: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});
const claimSchema = z.object({
  userId: id,
  messageId: id,
  now: z.date().optional(),
  leaseMs: z.number().int().min(1000).max(300000).optional(),
});
const finishSchema = z.object({
  lease: executionLeaseSchema,
  status: z.enum(['accepted', 'waiting_approval', 'completed', 'failed']),
  errorCode: z
    .string()
    .regex(/^[a-z0-9_]{1,80}$/)
    .optional(),
  runStateId: id.optional(),
  now: z.date().optional(),
});
type ClaimResult =
  | { kind: 'acquired'; message: Message; lease: ExecutionLease }
  | { kind: 'busy'; retryAfterMs: number }
  | { kind: 'done' | 'waiting' | 'missing' | 'exhausted' };
async function trace(
  tx: Prisma.TransactionClient,
  message: Pick<Message, 'id' | 'executionPhase'>,
  decision: string,
) {
  await tx.decisionTrace.create({
    data: {
      kind: 'gate',
      inputRef: message.id,
      phase:
        message.executionPhase === 1 || message.executionPhase === 2 ? message.executionPhase : 0,
      latencyMs: 0,
      costMicro: 0,
      output: { gate: 'request_execution', decision },
    },
  });
}
export function executionsRepo(prisma: PrismaClient) {
  return {
    async recoveryFlags(lease: ExecutionLease) {
      return inTransaction(prisma, async (tx) => {
        if (!(await activeExecution(tx, lease))) throw new ExecutionFenceLostError();
        const rows = await tx.decisionTrace.findMany({
          where: { inputRef: lease.messageId, kind: 'gate' },
          take: 200,
          orderBy: { createdAt: 'asc' },
        });
        const decisions = rows
          .map((row) =>
            z
              .object({
                gate: z.string(),
                decision: z.string(),
                isVerifiedRequestStatus: z.boolean().optional(),
              })
              .safeParse(row.output),
          )
          .filter((result) => result.success)
          .map((result) => result.data);
        return {
          outboundBlocked: decisions.some(
            (d) =>
              d.gate === 'outbound' && d.decision === 'drop' && d.isVerifiedRequestStatus === false,
          ),
          answerInputExhausted: decisions.some(
            (d) => d.gate === 'outbound_retry' && d.decision === 'deny',
          ),
        };
      });
    },
    async markEnqueued(p: { messageId: string; userId: string }): Promise<void> {
      await prisma.message.updateMany({
        where: {
          id: p.messageId,
          userId: p.userId,
          executionStatus: { in: ['accepted', 'running'] },
        },
        data: { executionQueuedAt: new Date() },
      });
    },
    async dispatchable(limit = 20, now = new Date()) {
      const count = z.number().int().min(1).max(100).parse(limit);
      const rows = await prisma.message.findMany({
        where: {
          text: { not: '' },
          executionKey: { not: null },
          executionAttempts: { lt: 3 },
          receivedAt: { gte: new Date(now.getTime() - 30 * 86400e3) },
          AND: [
            {
              OR: [
                { executionQueuedAt: null },
                { executionQueuedAt: { lt: new Date(now.getTime() - 30000) } },
              ],
            },
            {
              OR: [
                { executionStatus: 'accepted' },
                {
                  executionStatus: 'running',
                  user: {
                    OR: [
                      { executionLeaseExpiresAt: null },
                      { executionLeaseExpiresAt: { lte: now } },
                    ],
                  },
                },
              ],
            },
          ],
        },
        orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
        take: count,
        include: {
          user: { select: { externalId: true, channel: true, channelScope: true } },
          group: { select: { externalId: true } },
        },
      });
      return rows.map((row) => ({
        userId: row.userId,
        messageId: row.id,
        recoverActive: row.executionStatus === 'running',
        message: inboundMessageSchema.parse({
          channel: row.user.channel,
          chatId: row.group?.externalId ?? row.user.externalId,
          ...persistedChannelRoute(row.channelRoute),
          userId: row.user.externalId,
          messageId: row.externalId,
          text: row.text,
          receivedAt: row.receivedAt.toISOString(),
          addressedToBot: row.isAddressedToBot,
          ...(row.lang ? { lang: row.lang } : {}),
          ...(row.replyToBotText ? { replyToBotText: row.replyToBotText } : {}),
          ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
        }),
      }));
    },
    async rejectAdmission(raw: {
      message: z.input<typeof inboundMessageSchema>;
      errorCode: string;
    }): Promise<boolean> {
      const p = z
          .object({
            message: inboundMessageSchema,
            errorCode: z.string().regex(/^[a-z0-9_]{1,80}$/),
          })
          .parse(raw),
        m = p.message;
      const key = hashText(
        m.account ? inboundEventKey(m) : JSON.stringify([m.channel, m.chatId, m.messageId]),
      );
      return inTransaction(prisma, async (tx) => {
        const row = await tx.message.findUnique({
          where: { executionKey: key },
          include: { user: { select: { channel: true, externalId: true, channelScope: true } } },
        });
        if (
          !row ||
          row.user.channel !== m.channel ||
          row.user.channelScope !== accountScopeKey(m.account) ||
          row.user.externalId !== m.userId ||
          row.textHash !== hashText(m.text)
        )
          return false;
        await lockExecutionUser(tx, row.userId);
        const changed = await tx.message.updateMany({
          where: { id: row.id, executionStatus: { in: ['accepted', 'waiting_approval'] } },
          data: { executionStatus: 'failed', executionError: p.errorCode },
        });
        if (changed.count) await trace(tx, row, 'admission_rejected');
        return changed.count === 1;
      });
    },
    async accept(
      raw: z.input<typeof acceptSchema>,
    ): Promise<{ kind: 'accepted' | 'existing' | 'legacy'; message: Message }> {
      const p = acceptSchema.parse(raw),
        m = p.message;
      return inTransaction(prisma, async (tx) => {
        const user = await lockExecutionUser(tx, p.userId),
          group = p.groupId ? await tx.group.findUnique({ where: { id: p.groupId } }) : null;
        if (
          !user ||
          user.channel !== m.channel ||
          user.channelScope !== accountScopeKey(m.account) ||
          user.externalId !== m.userId ||
          (p.groupId
            ? !group ||
              group.channel !== m.channel ||
              group.externalId !== m.chatId ||
              group.channelScope !== accountScopeKey(m.account)
            : !isDirectMessage(m))
        )
          throw new Error('request source scope mismatch');
        const key = hashText(
          m.account ? inboundEventKey(m) : JSON.stringify([m.channel, m.chatId, m.messageId]),
        );
        const existing = await tx.message.findFirst({
          where: {
            OR: [
              { executionKey: key },
              { groupId: p.groupId, userId: p.userId, externalId: m.messageId },
            ],
          },
        });
        if (existing) {
          if (
            existing.userId !== p.userId ||
            existing.groupId !== p.groupId ||
            existing.textHash !== hashText(m.text)
          )
            throw new Error('request replay payload mismatch');
          return {
            kind: existing.executionStatus === null ? 'legacy' : 'existing',
            message: existing,
          };
        }
        const message = await tx.message.create({
          data: {
            userId: p.userId,
            groupId: p.groupId,
            externalId: m.messageId,
            ...(m.account || m.conversationType || m.threadId
              ? { channelRoute: channelRouteSchema.parse(m) }
              : {}),
            text: m.text,
            textHash: hashText(m.text),
            lang: m.lang ?? null,
            receivedAt: new Date(m.receivedAt),
            executionKey: key,
            executionStatus: 'accepted',
            executionPhase: p.phase,
            replyToMessageId: m.replyToMessageId ?? null,
            isAddressedToBot: m.addressedToBot ?? false,
            replyToBotText: m.replyToBotText ?? null,
          },
        });
        await trace(tx, message, 'accepted');
        return { kind: 'accepted', message };
      });
    },
    async claim(raw: z.input<typeof claimSchema>): Promise<ClaimResult> {
      const p = claimSchema.parse(raw),
        now = p.now ?? new Date();
      return inTransaction(prisma, async (tx) => {
        const user = await lockExecutionUser(tx, p.userId),
          message = await tx.message.findFirst({ where: { id: p.messageId, userId: p.userId } });
        if (!user || !message) return { kind: 'missing' };
        if (
          message.executionStatus === null ||
          ['completed', 'failed'].includes(message.executionStatus)
        ) {
          await trace(tx, message, 'already_terminal');
          return { kind: 'done' };
        }
        if (message.text === '' || message.receivedAt.getTime() < now.getTime() - 30 * 86400e3) {
          await tx.message.update({
            where: { id: message.id },
            data: {
              executionStatus: 'failed',
              executionError: 'input_expired',
              executionSnapshot: null,
            },
          });
          if (user.executionFence === message.executionFence)
            await tx.user.update({
              where: { id: user.id },
              data: { executionLeaseToken: null, executionLeaseExpiresAt: null },
            });
          await trace(tx, message, 'input_expired');
          return { kind: 'exhausted' };
        }
        if (message.executionStatus === 'waiting_approval') {
          await trace(tx, message, 'waiting_approval');
          return { kind: 'waiting' };
        }
        if (
          user.executionLeaseToken &&
          user.executionLeaseExpiresAt &&
          user.executionLeaseExpiresAt > now
        ) {
          await trace(tx, message, 'user_busy');
          return { kind: 'busy', retryAfterMs: 2000 };
        }
        const resume = await tx.approval.findFirst({
          where: {
            resumeStatus: { in: ['accepted', 'running'] },
            runState: { messageId: message.id, userId: user.id },
          },
        });
        if (resume) {
          await trace(tx, message, 'durable_resume_pending');
          return { kind: 'waiting' };
        }
        const reply = await tx.outboundMessage.findFirst({
          where: {
            sourceMessageId: message.id,
            kind: { not: 'reaction' },
            approvalRunStateId: null,
          },
        });
        if (reply) {
          await tx.message.update({
            where: { id: message.id },
            data: { executionStatus: 'completed', executionError: null },
          });
          await tx.user.update({
            where: { id: user.id },
            data: { executionLeaseToken: null, executionLeaseExpiresAt: null },
          });
          await trace(tx, message, 'reply_already_recorded');
          return { kind: 'done' };
        }
        const pending = await tx.runState.findFirst({
          where: {
            messageId: message.id,
            userId: user.id,
            status: 'pending',
            expiresAt: { gt: now },
          },
        });
        if (pending) {
          await tx.message.update({
            where: { id: message.id },
            data: { executionStatus: 'waiting_approval' },
          });
          await tx.user.update({
            where: { id: user.id },
            data: { executionLeaseToken: null, executionLeaseExpiresAt: null },
          });
          await trace(tx, message, 'pending_approval_recovered');
          return { kind: 'waiting' };
        }
        const earliest = await tx.message.findFirst({
          where: {
            userId: p.userId,
            executionStatus: { in: ['accepted', 'running'] },
            text: { not: '' },
            receivedAt: { gte: new Date(now.getTime() - 30 * 86400e3) },
          },
          orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        });
        if (earliest?.id !== message.id) {
          await trace(tx, message, 'earlier_request_pending');
          return { kind: 'busy', retryAfterMs: 2000 };
        }
        if (message.executionAttempts >= 3 || message.text === '') {
          await tx.message.update({
            where: { id: message.id },
            data: {
              executionStatus: 'failed',
              executionError: message.text === '' ? 'input_expired' : 'attempt_limit',
            },
          });
          await trace(tx, message, 'attempt_limit_or_expired');
          return { kind: 'exhausted' };
        }
        const token = randomUUID(),
          fence = user.executionFence + 1;
        await tx.user.update({
          where: { id: user.id },
          data: {
            executionFence: fence,
            executionLeaseToken: token,
            executionLeaseExpiresAt: new Date(now.getTime() + (p.leaseMs ?? 240000)),
          },
        });
        const updated = await tx.message.update({
          where: { id: message.id },
          data: {
            executionStatus: 'running',
            executionFence: fence,
            executionAttempts: { increment: 1 },
            executionError: null,
          },
        });
        await trace(tx, message, 'claimed');
        return {
          kind: 'acquired',
          message: updated,
          lease: { userId: user.id, messageId: message.id, token, fence },
        };
      });
    },
    async saveCheckpoint(raw: {
      lease: ExecutionLease;
      snapshot: string;
      now?: Date;
      task?: { id: string; requirementsVersion: number };
    }): Promise<boolean> {
      const p = z
        .object({
          lease: executionLeaseSchema,
          snapshot: z.string().min(1).max(2000000),
          now: z.date().optional(),
          task: z.object({ id, requirementsVersion: z.number().int().nonnegative() }).optional(),
        })
        .parse(raw);
      return inTransaction(prisma, async (tx) => {
        const message = await activeExecution(tx, p.lease, p.now);
        if (!message || message.text === '') return false;
        if (p.task) {
          const user = await tx.user.findUniqueOrThrow({
            where: { id: message.userId },
            select: { channel: true, externalId: true, channelScope: true },
          });
          const group = message.groupId
            ? await tx.group.findUnique({
                where: { id: message.groupId },
                select: { externalId: true },
              })
            : null;
          const task = await tx.task.findFirst({
            where: {
              id: p.task.id,
              userId: message.userId,
              channel: user.channel,
              chatId:
                persistedChannelRoute(message.channelRoute)?.chatId ??
                group?.externalId ??
                user.externalId,
              threadId: persistedChannelRoute(message.channelRoute)?.threadId ?? '',
              requirementsVersion: p.task.requirementsVersion,
            },
          });
          if (!task) throw new Error('execution task binding inaccessible or obsolete');
        }
        await tx.message.update({
          where: { id: message.id },
          data: {
            executionSnapshot: p.snapshot,
            ...(p.task
              ? { taskId: p.task.id, taskRequirementsVersion: p.task.requirementsVersion }
              : {}),
          },
        });
        await trace(tx, message, 'checkpointed');
        return true;
      });
    },
    async finish(raw: z.input<typeof finishSchema>): Promise<boolean> {
      const p = finishSchema.parse(raw);
      return inTransaction(prisma, async (tx) => {
        const message = await activeExecution(tx, p.lease, p.now);
        if (!message) return false;
        if (p.status === 'waiting_approval') {
          const state = p.runStateId
            ? await tx.runState.findFirst({
                where: {
                  id: p.runStateId,
                  userId: p.lease.userId,
                  messageId: message.id,
                  status: 'pending',
                },
              })
            : null;
          if (!state) throw new Error('request approval state missing or inaccessible');
        }
        const status =
          message.text === '' || (p.status === 'accepted' && message.executionAttempts >= 3)
            ? 'failed'
            : p.status;
        await tx.message.update({
          where: { id: message.id },
          data: {
            executionStatus: status,
            executionError:
              status === 'failed' && p.status === 'accepted'
                ? 'attempt_limit'
                : (p.errorCode ?? null),
          },
        });
        await tx.user.update({
          where: { id: p.lease.userId },
          data: { executionLeaseToken: null, executionLeaseExpiresAt: null },
        });
        await trace(tx, message, p.status);
        return true;
      });
    },
  };
}

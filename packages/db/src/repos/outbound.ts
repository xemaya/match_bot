import { persistedChannelRoute, type Channel } from '@matchbot/domain';
import { randomUUID } from 'node:crypto';
import { outboundDraftSchema, type OutboundDraft, type OutboundKind } from '@matchbot/domain';
import { z } from 'zod';
import { hashText } from '@matchbot/shared';
import { withExecutionFence } from '../execution-fence.js';
import { Prisma, type OutboundMessage, type PrismaClient } from '../generated/client.js';
import { tasksRepo } from './tasks.js';
import { approvalCardEligibility, opsChatSchema, phaseSchema } from '../approval-card-store.js';
import {
  lockOutboundTask,
  canSendTaskReply,
  queueOutboundTask,
  recordOutboundTaskReceipt,
} from '../task-delivery-store.js';

const fence = z.object({
  id: z.string().min(1),
  leaseToken: z.string().min(1).max(100),
  now: z.date().optional(),
});
const receipt = fence.extend({
  externalMessageId: z.string().min(1).max(256).nullable(),
});
const startFence = fence.extend({
  opsChatId: opsChatSchema.optional(),
  defaultPhase: phaseSchema.optional(),
});
const cardParams = z.object({
  runStateId: z.string().min(1).max(160),
  opsChatId: opsChatSchema,
  defaultPhase: phaseSchema,
  now: z.date().optional(),
});
const failure = fence.extend({
  deliveryState: z.enum(['not_sent', 'unknown']),
  errorCode: z.string().regex(/^[a-z0-9_]{1,80}$/),
  retryAt: z.date().optional(),
});
const MAX_ATTEMPTS = 3;
async function trace(
  tx: Prisma.TransactionClient,
  p: { id: string; phase: number; decision: string; attemptCount?: number },
) {
  await tx.decisionTrace.create({
    data: {
      kind: 'gate',
      inputRef: p.id,
      phase: p.phase === 1 || p.phase === 2 ? p.phase : 0,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'outbound_delivery',
        decision: p.decision,
        ...(p.attemptCount !== undefined ? { attemptCount: p.attemptCount } : {}),
      },
    },
  });
}
export function outboundRepo(
  prisma: PrismaClient,
  accountId = '',
  channel: Channel = 'telegram',
  channelScope = '',
) {
  const senderAccountId = z.string().max(1000).parse(accountId);
  // Reuse an existing transaction boundary in repositories and rollback integration tests.
  const atomic = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    typeof prisma.$transaction === 'function' ? prisma.$transaction(fn) : fn(prisma);
  return {
    findDeliveredByExternal(input: {
      target: string;
      externalMessageId: string;
    }): Promise<OutboundMessage | null> {
      return prisma.outboundMessage.findFirst({
        where: {
          channel,
          senderAccountId,
          target: input.target,
          externalMessageId: input.externalMessageId,
          status: 'sent',
        },
      });
    },
    countUnfinished(): Promise<number> {
      return prisma.outboundMessage.count({ where: { status: { in: ['pending', 'sending'] } } });
    },
    findReplyForSource(input: {
      channel: 'telegram' | 'feishu' | 'whatsapp';
      target: string;
      sourceMessageId: string;
    }): Promise<OutboundMessage | null> {
      const p = z
        .object({
          channel: z.enum(['telegram', 'feishu', 'whatsapp']),
          target: z.string().min(1),
          sourceMessageId: z.string().min(1),
        })
        .parse(input);
      return prisma.outboundMessage.findFirst({
        where: { ...p, kind: { in: ['recommendation', 'clarification', 'notification'] } },
        orderBy: { createdAt: 'desc' },
      });
    },
    findByToolCallId(toolCallId: string): Promise<OutboundMessage | null> {
      return prisma.outboundMessage.findFirst({
        where: { toolCallId: z.string().min(1).max(200).parse(toolCallId) },
        orderBy: { createdAt: 'desc' },
      });
    },
    /** Existing HITL control notification: fixed ops recipient, server snapshot, never model-selected text/target. */
    async enqueueApprovalCard(raw: z.input<typeof cardParams>): Promise<OutboundMessage | null> {
      const p = cardParams.parse(raw);
      return atomic(async (tx) => {
        const eligible = await approvalCardEligibility(tx, {
          runStateId: p.runStateId,
          defaultPhase: p.defaultPhase,
          now: p.now ?? new Date(),
        });
        const existing = await tx.outboundMessage.findUnique({
          where: { approvalRunStateId: p.runStateId },
        });
        if (existing) {
          await trace(tx, {
            id: existing.id,
            phase: existing.phase,
            decision: 'approval_card_replayed',
          });
          return existing;
        }
        if (!eligible.ok) {
          const rs = await tx.runState.findUnique({ where: { id: p.runStateId } });
          if (rs?.status === 'pending' && eligible.obsolete) {
            await tx.runState.update({ where: { id: rs.id }, data: { status: 'expired' } });
            if (rs.messageId)
              await tx.message.updateMany({
                where: { id: rs.messageId, userId: rs.userId, executionStatus: 'waiting_approval' },
                data: { executionStatus: 'failed', executionError: 'approval_unavailable' },
              });
          }
          await trace(tx, {
            id: p.runStateId,
            phase: rs?.phase ?? 0,
            decision: 'card_held_' + eligible.reason,
          });
          return null;
        }
        if (
          eligible.source.user.channelScope !== channelScope ||
          eligible.source.user.channel !== channel
        )
          throw new Error('approval account scope mismatch');
        const row = await tx.outboundMessage.create({
          data: {
            channel,
            senderAccountId,
            target: p.opsChatId,
            text: eligible.text,
            kind: 'notification',
            status: 'pending',
            phase: eligible.phase,
            sourceMessageId: eligible.source.id,
            approvalRunStateId: eligible.runState.id,
            requestKey: 'approval:' + eligible.runState.id,
          },
        });
        await trace(tx, { id: row.id, phase: row.phase, decision: 'approval_card_queued' });
        return row;
      });
    },
    create(raw: OutboundDraft, status: 'dry_run' | 'pending'): Promise<OutboundMessage> {
      const draft = outboundDraftSchema.parse(raw);
      if (channelScope && draft.channel !== channel)
        throw new Error('outbound channel scope mismatch');
      if (draft.taskDelivery && !draft.execution)
        throw new Error('task delivery requires a fenced source request');
      const write = async (tx: Prisma.TransactionClient) => {
        let requestKey: string | null = null;
        let threadId: string | null = null;
        if (draft.execution) {
          const source = await tx.message.findFirst({
            where: { id: draft.execution.messageId, userId: draft.execution.userId },
            include: {
              user: { select: { channel: true, externalId: true, channelScope: true } },
              group: { select: { externalId: true } },
            },
          });
          if (
            !source ||
            source.user.channel !== draft.channel ||
            source.user.channelScope !== channelScope
          )
            throw new Error('outbound execution source inaccessible');
          threadId = persistedChannelRoute(source.channelRoute)?.threadId ?? null;
          const target =
            persistedChannelRoute(source.channelRoute)?.chatId ??
            source.group?.externalId ??
            source.user.externalId;
          if (
            (draft.kind ?? 'recommendation') !== 'lead' &&
            draft.target !== target &&
            !(draft.kind === 'notification' && draft.target === source.user.externalId)
          )
            throw new Error('outbound execution scope mismatch');
          requestKey = hashText(
            JSON.stringify([
              draft.channel,
              draft.target,
              source.id,
              draft.kind === 'reaction' ? 'reaction' : 'reply',
            ]),
          );
          const existing = await tx.outboundMessage.findUnique({ where: { requestKey } });
          if (existing) {
            await trace(tx, {
              id: existing.id,
              phase: existing.phase,
              decision: 'request_reply_replayed',
            });
            return existing;
          }
          if (draft.taskDelivery) {
            const selected = await tasksRepo(tx as PrismaClient).findById({
              access: {
                userId: source.userId,
                scope: {
                  channel: draft.channel,
                  chatId: target,
                  ...(threadId ? { threadId } : {}),
                },
              },
              id: draft.taskDelivery.id,
            });
            if (
              draft.target !== target ||
              draft.kind === 'reaction' ||
              draft.kind === 'lead' ||
              !selected ||
              selected.requirementsVersion !== draft.taskDelivery.requirementsVersion ||
              ['completed', 'cancelled', 'expired'].includes(selected.status)
            )
              throw new Error('outbound task scope or requirements mismatch');
            if (
              draft.taskDelivery.question &&
              !draft.text.includes(draft.taskDelivery.question.text)
            )
              throw new Error('task question is absent from actual outbound text');
            await tx.message.update({
              where: { id: source.id },
              data: { taskId: selected.id, taskRequirementsVersion: selected.requirementsVersion },
            });
          }
        }
        const row = await tx.outboundMessage.create({
          data: {
            senderAccountId,
            threadId,
            channel: draft.channel,
            target: draft.target,
            text: draft.text,
            phase: draft.phase ?? 0,
            toolCallId: draft.toolCallId ?? null,
            kind: draft.kind ?? 'recommendation',
            replyToMessageId: draft.replyToMessageId ?? null,
            mentionUserId: draft.mentionUserId ?? null,
            status,
            requestKey,
            sourceMessageId: draft.execution?.messageId ?? null,
            taskId: draft.taskDelivery?.id ?? null,
            taskRequirementsVersion: draft.taskDelivery?.requirementsVersion ?? null,
          },
        });
        if (draft.taskDelivery && status === 'pending')
          await queueOutboundTask(tx, row, draft.taskDelivery);
        return row;
      };
      return draft.execution ? withExecutionFence(prisma, draft.execution, write) : write(prisma);
    },
    async claimPending(
      limit: number,
      options: { now?: Date; leaseMs?: number } = {},
    ): Promise<OutboundMessage[]> {
      const count = z.number().int().min(1).max(100).parse(limit),
        now = options.now ?? new Date();
      const duration = z
        .number()
        .int()
        .min(1000)
        .max(300000)
        .parse(options.leaseMs ?? 60000);
      const token = randomUUID(),
        expiresAt = new Date(now.getTime() + duration);
      return atomic(async (tx) => {
        const raw: unknown = await tx.$queryRaw(Prisma.sql`
          WITH candidates AS (
            SELECT id FROM outbound_messages
            WHERE status = 'pending' AND channel = ${channel}::"Channel" AND sender_account_id = ${senderAccountId} AND phase IN (1,2)
              AND attempt_count < ${MAX_ATTEMPTS} AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
            ORDER BY created_at,id LIMIT ${count} FOR UPDATE SKIP LOCKED
          ) UPDATE outbound_messages AS o SET status = 'sending',lease_token = ${token},lease_expires_at = ${expiresAt},
            attempt_started_at = NULL,next_attempt_at = NULL,attempt_count = attempt_count + 1
          FROM candidates WHERE o.id = candidates.id RETURNING o.id
        `);
        const ids = z
          .array(z.object({ id: z.string() }))
          .parse(raw)
          .map((row) => row.id);
        const rows = await tx.outboundMessage.findMany({
          where: { id: { in: ids }, status: 'sending', leaseToken: token },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        for (const row of rows)
          await trace(tx, {
            id: row.id,
            phase: row.phase,
            decision: 'claimed',
            attemptCount: row.attemptCount,
          });
        return rows;
      });
    },
    async beginSend(raw: z.input<typeof startFence>): Promise<boolean> {
      const p = startFence.parse(raw),
        now = p.now ?? new Date();
      return atomic(async (tx) => {
        const row = await tx.outboundMessage.findUnique({ where: { id: p.id } });
        if (row && (row.approvalRunStateId || row.requestKey?.startsWith('approval:'))) {
          const eligible = row.approvalRunStateId
            ? await approvalCardEligibility(tx, {
                runStateId: row.approvalRunStateId,
                defaultPhase: p.defaultPhase ?? 0,
                now,
              })
            : null;
          const recipient = await tx.group.findUnique({
            where: {
              channel_externalId: { channel: row.channel, externalId: row.target, channelScope },
            },
            select: { isActive: true },
          });
          if (!eligible?.ok || row.target !== p.opsChatId || recipient?.isActive === false) {
            await tx.outboundMessage.updateMany({
              where: {
                id: row.id,
                leaseToken: p.leaseToken,
                status: 'sending',
                attemptStartedAt: null,
              },
              data: { status: 'failed', error: 'approval_card_unavailable', leaseExpiresAt: null },
            });
            await trace(tx, {
              id: row.id,
              phase: row.phase,
              decision: 'approval_card_fence_rejected',
            });
            return false;
          }
        }
        await lockOutboundTask(tx, row);
        if (row && !(await canSendTaskReply(tx, row))) {
          await tx.outboundMessage.updateMany({
            where: {
              id: p.id,
              leaseToken: p.leaseToken,
              status: 'sending',
              attemptStartedAt: null,
            },
            data: { status: 'failed', error: 'obsolete_task_reply', leaseExpiresAt: null },
          });
          await trace(tx, { id: p.id, phase: row.phase, decision: 'obsolete_task_reply' });
          return false;
        }
        const result = await tx.outboundMessage.updateMany({
          where: {
            id: p.id,
            leaseToken: p.leaseToken,
            status: 'sending',
            phase: { in: [1, 2] },
            leaseExpiresAt: { gt: now },
            attemptStartedAt: null,
          },
          data: { attemptStartedAt: now },
        });
        await trace(tx, {
          id: p.id,
          phase: row?.phase ?? 0,
          decision: result.count ? 'send_started' : 'start_fence_rejected',
        });
        return result.count === 1;
      });
    },
    async markSent(raw: z.input<typeof receipt>): Promise<boolean> {
      const p = receipt.parse(raw),
        now = p.now ?? new Date();
      return atomic(async (tx) => {
        const row = await tx.outboundMessage.findUnique({ where: { id: p.id } });
        await lockOutboundTask(tx, row);
        if (
          row?.status === 'sent' &&
          row.leaseToken === p.leaseToken &&
          row.externalMessageId === p.externalMessageId
        ) {
          await trace(tx, { id: row.id, phase: row.phase, decision: 'receipt_replayed' });
          return true;
        }
        if (
          !row ||
          (row.kind !== 'reaction' && p.externalMessageId === null) ||
          (row.kind === 'reaction' && p.externalMessageId !== null)
        ) {
          await trace(tx, { id: p.id, phase: row?.phase ?? 0, decision: 'invalid_receipt' });
          return false;
        }
        const result = await tx.outboundMessage.updateMany({
          where: {
            id: p.id,
            leaseToken: p.leaseToken,
            status: { in: ['sending', 'delivery_unknown'] },
            phase: { in: [1, 2] },
            attemptStartedAt: { not: null },
          },
          data: {
            status: 'sent',
            sentAt: now,
            externalMessageId: p.externalMessageId,
            error: null,
            leaseExpiresAt: null,
          },
        });
        await trace(tx, {
          id: p.id,
          phase: row.phase,
          decision: result.count ? 'receipt_recorded' : 'receipt_fence_rejected',
        });
        if (result.count) await recordOutboundTaskReceipt(tx, row, 'sent');
        return result.count === 1;
      });
    },
    async markFailed(raw: z.input<typeof failure>): Promise<boolean> {
      const p = failure.parse(raw),
        now = p.now ?? new Date();
      return atomic(async (tx) => {
        const row = await tx.outboundMessage.findUnique({ where: { id: p.id } });
        await lockOutboundTask(tx, row);
        const canRetry =
          p.deliveryState === 'not_sent' &&
          p.retryAt !== undefined &&
          p.retryAt > now &&
          (row?.attemptCount ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;
        const status =
          p.deliveryState === 'unknown' ? 'delivery_unknown' : canRetry ? 'pending' : 'failed';
        const result = await tx.outboundMessage.updateMany({
          where: {
            id: p.id,
            leaseToken: p.leaseToken,
            status: { in: ['sending', 'delivery_unknown'] },
          },
          data: {
            status,
            error: p.errorCode,
            nextAttemptAt: canRetry ? p.retryAt! : null,
            ...(canRetry ? { leaseToken: null, leaseExpiresAt: null, attemptStartedAt: null } : {}),
          },
        });
        await trace(tx, {
          id: p.id,
          phase: row?.phase ?? 0,
          decision: result.count ? status : 'failure_fence_rejected',
        });
        if (result.count && row && status !== 'pending')
          await recordOutboundTaskReceipt(
            tx,
            row,
            status === 'delivery_unknown' ? 'unknown' : 'failed',
          );
        return result.count === 1;
      });
    },
    async recoverExpiredClaims(now: Date = new Date()) {
      return atomic(async (tx) => {
        const rows = await tx.outboundMessage.findMany({
          where: { status: 'sending', leaseExpiresAt: { lte: now } },
          take: 100,
          orderBy: { leaseExpiresAt: 'asc' },
        });
        const totals = { requeued: 0, unknown: 0, failed: 0 };
        for (const row of rows) {
          await lockOutboundTask(tx, row);
          const status = row.attemptStartedAt
            ? 'delivery_unknown'
            : row.attemptCount >= MAX_ATTEMPTS
              ? 'failed'
              : 'pending';
          const changed = await tx.outboundMessage.updateMany({
            where: {
              id: row.id,
              status: 'sending',
              leaseToken: row.leaseToken,
              leaseExpiresAt: { lte: now },
              attemptStartedAt: row.attemptStartedAt,
            },
            data: {
              status,
              error:
                status === 'delivery_unknown'
                  ? 'send_receipt_missing'
                  : status === 'failed'
                    ? 'retry_budget_exhausted'
                    : null,
              ...(status === 'pending'
                ? { leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now }
                : {}),
            },
          });
          if (!changed.count) continue;
          if (status === 'pending') totals.requeued++;
          else if (status === 'delivery_unknown') totals.unknown++;
          else totals.failed++;
          await trace(tx, { id: row.id, phase: row.phase, decision: 'expired_' + status });
          if (status !== 'pending')
            await recordOutboundTaskReceipt(
              tx,
              row,
              status === 'delivery_unknown' ? 'unknown' : 'failed',
            );
        }
        return totals;
      });
    },
    async redactDeliveryReceiptsBefore(before: Date): Promise<number> {
      const result = await prisma.outboundMessage.updateMany({
        where: {
          AND: [
            { OR: [{ externalMessageId: { not: null } }, { leaseToken: { not: null } }] },
            {
              OR: [
                { status: 'sent', sentAt: { lt: before } },
                {
                  status: { in: ['failed', 'delivery_unknown'] },
                  attemptStartedAt: { lt: before },
                },
                {
                  status: { in: ['failed', 'delivery_unknown'] },
                  attemptStartedAt: null,
                  createdAt: { lt: before },
                },
              ],
            },
          ],
        },
        data: { externalMessageId: null, leaseToken: null },
      });
      return result.count;
    },
    countSentToTargetSince(target: string, since: Date, kind?: OutboundKind): Promise<number> {
      return prisma.outboundMessage.count({
        where: { target, status: 'sent', sentAt: { gte: since }, ...(kind ? { kind } : {}) },
      });
    },
  };
}

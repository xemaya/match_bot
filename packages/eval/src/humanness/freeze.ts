import { z } from 'zod';
import { researchContextSchema, loadGroupTranscript, AGENT_VERSION } from '@matchbot/agent';
import type { Repositories } from '@matchbot/db';
import { decrypt } from '@matchbot/shared';
import type { CaseFixture, Round } from './schema.js';

const checkpointSchema = z
  .object({
    version: z.literal(1),
    agentVersion: z.string(),
    taskId: z.string().nullable(),
    requirementsVersion: z.number().int().nullable(),
    research: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/**
 * Read-only. For every case in a round whose source message still carries its execution snapshot,
 * decrypt the research packet (`SNAPSHOT_KEY`, the worker's own key), read the task as it is now,
 * rebuild the group transcript as it was when the message arrived, and store all of it as one file.
 */
export async function freezeCase(p: {
  repos: Repositories;
  prisma: {
    message: {
      findUnique(args: {
        where: { id: string };
        select: {
          id: true;
          text: true;
          userId: true;
          groupId: true;
          receivedAt: true;
          executionSnapshot: true;
          isAddressedToBot: true;
          executionPhase: true;
        };
      }): Promise<{
        id: string;
        text: string;
        userId: string;
        groupId: string | null;
        receivedAt: Date;
        executionSnapshot: string | null;
        isAddressedToBot: boolean;
        executionPhase: number;
      } | null>;
    };
    group: {
      findUnique(args: {
        where: { id: string };
        select: { externalId: true };
      }): Promise<{ externalId: string } | null>;
    };
    user: {
      findUnique(args: {
        where: { id: string };
        select: { externalId: true };
      }): Promise<{ externalId: string } | null>;
    };
  };
  snapshotKey: string;
  round: Round;
  caseId: string;
}): Promise<CaseFixture | { skipped: string }> {
  const original = p.round.cases.find((c) => c.id === p.caseId);
  if (!original) throw new Error('case_not_in_round');
  if (!original.sourceMessageId) return { skipped: 'no_source_message' };
  const message = await p.prisma.message.findUnique({
    where: { id: original.sourceMessageId },
    select: {
      id: true,
      text: true,
      userId: true,
      groupId: true,
      receivedAt: true,
      executionSnapshot: true,
      isAddressedToBot: true,
      executionPhase: true,
    },
  });
  if (!message) return { skipped: 'message_missing' };
  if (!message.executionSnapshot) return { skipped: 'snapshot_missing' };
  const checkpoint = checkpointSchema.parse(
    JSON.parse(decrypt(message.executionSnapshot, p.snapshotKey)) as unknown,
  );
  const research = researchContextSchema.parse(checkpoint.research);
  const group = message.groupId
    ? await p.prisma.group.findUnique({
        where: { id: message.groupId },
        select: { externalId: true },
      })
    : null;
  const author = await p.prisma.user.findUnique({
    where: { id: message.userId },
    select: { externalId: true },
  });
  const chatId = group?.externalId ?? author?.externalId ?? research.chatId;
  const task = checkpoint.taskId
    ? await p.repos.tasks.findById({
        access: { userId: message.userId, scope: { channel: 'telegram', chatId } },
        id: checkpoint.taskId,
      })
    : null;
  const groupTranscript = await loadGroupTranscript(p.repos, {
    groupId: message.groupId,
    chatId,
    sourceMessageId: message.id,
    userId: message.userId,
    receivedAt: message.receivedAt,
  });
  return {
    version: 1,
    id: original.id,
    round: p.round.name,
    frozenAt: new Date().toISOString(),
    agentVersion: AGENT_VERSION,
    sourceMessageId: message.id,
    input: message.text,
    askedAt: message.receivedAt.toISOString(),
    userId: message.userId,
    chatId,
    groupId: message.groupId,
    phase: research.phase,
    source: research.source ?? {
      messageId: message.id,
      userId: author?.externalId ?? message.userId,
    },
    addressedToBot: message.isAddressedToBot,
    task,
    groupTranscript,
    research: checkpoint.research,
    original,
  };
}

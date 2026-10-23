import { z } from 'zod';
import type { MemberNote, PrismaClient } from '../generated/client.js';

/** P54 retention: a note lives as long as its source message keeps its text (AGENTS.md §6). */
export const MEMBER_NOTE_RETENTION_DAYS = 30;
export const MEMBER_NOTE_KINDS = ['offer', 'need', 'context', 'resolved'] as const;

const addSchema = z.object({
  groupId: z.string().min(1),
  userId: z.string().min(1),
  kind: z.enum(MEMBER_NOTE_KINDS),
  text: z.string().min(1).max(120),
  sourceMessageId: z.string().min(1),
});

/**
 * Member notes are written only by the background notetaker and read by the main agent. Every
 * note must come from a public message of the same member in the same group.
 */
export function memberNotesRepo(prisma: PrismaClient) {
  return {
    async add(input: z.input<typeof addSchema>): Promise<MemberNote> {
      const p = addSchema.parse(input);
      const source = await prisma.message.findFirst({
        where: { id: p.sourceMessageId, groupId: p.groupId, userId: p.userId, text: { not: '' } },
        select: { receivedAt: true },
      });
      if (!source) throw new Error('member note source is not a public message of that member');
      return prisma.memberNote.create({
        data: {
          ...p,
          kind: p.kind,
          expiresAt: new Date(source.receivedAt.getTime() + MEMBER_NOTE_RETENTION_DAYS * 86400e3),
        },
      });
    },
    /** Marks notes replaced by newer ones (still deleted on the normal expiry). */
    async supersede(groupId: string, ids: string[]): Promise<number> {
      if (!ids.length) return 0;
      const r = await prisma.memberNote.updateMany({
        where: { groupId, id: { in: ids }, supersededAt: null },
        data: { supersededAt: new Date() },
      });
      return r.count;
    },
    /** Live notes of one group, newest first; optionally only some members. */
    listForGroup(p: {
      groupId: string;
      userIds?: string[];
      limit: number;
      /** Only notes from messages that arrived before this (a replay must not see its future). */
      sourceBefore?: Date;
    }): Promise<MemberNote[]> {
      return prisma.memberNote.findMany({
        where: {
          groupId: p.groupId,
          supersededAt: null,
          expiresAt: { gt: new Date() },
          ...(p.userIds ? { userId: { in: p.userIds } } : {}),
          ...(p.sourceBefore ? { message: { receivedAt: { lt: p.sourceBefore } } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(1, p.limit), 200),
      });
    },
    async deleteExpired(now = new Date()): Promise<number> {
      return (await prisma.memberNote.deleteMany({ where: { expiresAt: { lte: now } } })).count;
    },
    /** /forget: everything A2H noted about this member, in every group. */
    async deleteForUser(userId: string): Promise<number> {
      return (await prisma.memberNote.deleteMany({ where: { userId } })).count;
    },
    async deleteForGroup(groupId: string): Promise<number> {
      return (await prisma.memberNote.deleteMany({ where: { groupId } })).count;
    },
    /** Notes whose source message was already blanked by the 30-day message cron. */
    async deleteWithRedactedSource(): Promise<number> {
      return (await prisma.memberNote.deleteMany({ where: { message: { text: '' } } })).count;
    },
  };
}

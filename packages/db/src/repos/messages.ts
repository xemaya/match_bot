import { hashText } from '@matchbot/shared';
import type { Message, PrismaClient } from '../generated/client.js';

export function messagesRepo(prisma: PrismaClient) {
  return {
    findById(id: string): Promise<Message | null> {
      return prisma.message.findUnique({ where: { id } });
    },
    /**
     * 同一条渠道消息是否已落过库。私聊 groupId 为空，Postgres 的 unique 不把两个 NULL
     * 视为重复，所以私聊按 userId 查——队列重投时靠它识别，而不是靠 unique 碰运气。
     */
    findExisting(p: {
      groupId: string | null;
      userId: string;
      externalId: string;
    }): Promise<Message | null> {
      return prisma.message.findFirst({
        where: p.groupId
          ? { groupId: p.groupId, externalId: p.externalId }
          : { groupId: null, userId: p.userId, externalId: p.externalId },
      });
    },
    create(p: {
      groupId: string | null;
      userId: string;
      externalId: string;
      text: string;
      lang?: string;
      receivedAt: Date;
    }): Promise<Message> {
      return prisma.message.create({
        data: {
          groupId: p.groupId,
          userId: p.userId,
          externalId: p.externalId,
          text: p.text,
          textHash: hashText(p.text),
          lang: p.lang ?? null,
          receivedAt: p.receivedAt,
        },
      });
    },
    recentByUser(
      userId: string,
      sinceHours: number,
      scope?: { groupId: string | null },
    ): Promise<Message[]> {
      return prisma.message.findMany({
        where: {
          userId,
          ...(scope ? { groupId: scope.groupId } : {}),
          receivedAt: { gte: new Date(Date.now() - sinceHours * 3600e3) },
        },
        orderBy: { receivedAt: 'desc' },
        take: 50,
      });
    },
    /** Recent public messages of one group across all members, newest first; redacted rows are skipped. */
    recentInGroup(
      groupId: string,
      p: { limit: number; sinceHours: number; before?: Date },
    ): Promise<Message[]> {
      return prisma.message.findMany({
        where: {
          groupId,
          text: { not: '' },
          receivedAt: {
            gte: new Date(Date.now() - p.sinceHours * 3600e3),
            ...(p.before ? { lt: p.before } : {}),
          },
        },
        orderBy: { receivedAt: 'desc' },
        take: Math.min(Math.max(1, p.limit), 100),
      });
    },
    async redactOlderThan(days: number): Promise<number> {
      const r = await prisma.message.updateMany({
        where: {
          receivedAt: { lt: new Date(Date.now() - days * 86400e3) },
          OR: [
            { text: { not: '' } },
            { executionSnapshot: { not: null } },
            { replyToBotText: { not: null } },
          ],
        },
        data: { text: '', executionSnapshot: null, replyToBotText: null },
      });
      return r.count;
    },
  };
}

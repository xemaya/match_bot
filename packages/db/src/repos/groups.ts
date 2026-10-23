import { z } from 'zod';
import type { Channel, Group, PrismaClient } from '../generated/client.js';

export function groupsRepo(prisma: PrismaClient) {
  return {
    findByExternal(channel: Channel, externalId: string): Promise<Group | null> {
      return prisma.group.findUnique({ where: { channel_externalId: { channel, externalId } } });
    },
    async setPolicy(input: {
      channel: Channel;
      externalId: string;
      isActive: boolean;
      phase: 0 | 1 | 2;
      rateLimitPerDay: number | null;
    }): Promise<Group> {
      const p = z
        .object({
          channel: z.enum(['telegram', 'whatsapp']),
          externalId: z.string().min(1),
          isActive: z.boolean(),
          phase: z.union([z.literal(0), z.literal(1), z.literal(2)]),
          rateLimitPerDay: z.number().int().positive().nullable(),
        })
        .parse(input);
      const group = await prisma.group.update({
        where: { channel_externalId: { channel: p.channel, externalId: p.externalId } },
        data: { isActive: p.isActive, phase: p.phase, rateLimitPerDay: p.rateLimitPerDay },
      });
      // P54: a deactivated group keeps no notes about its members.
      if (!p.isActive) await prisma.memberNote.deleteMany({ where: { groupId: group.id } });
      return group;
    },
    /** P54: active groups with group messages stored after their last notetaker pass. */
    async pendingMemory(limit: number): Promise<Array<{ id: string; since: Date | null }>> {
      const groups = await prisma.group.findMany({
        where: { isActive: true },
        select: { id: true, memoryConsolidatedAt: true },
      });
      const pending: Array<{ id: string; since: Date | null }> = [];
      for (const g of groups) {
        const fresh = await prisma.message.count({
          where: {
            groupId: g.id,
            text: { not: '' },
            ...(g.memoryConsolidatedAt ? { createdAt: { gt: g.memoryConsolidatedAt } } : {}),
          },
        });
        if (fresh) pending.push({ id: g.id, since: g.memoryConsolidatedAt });
        if (pending.length >= limit) break;
      }
      return pending;
    },
    async markMemoryConsolidated(groupId: string, at: Date): Promise<void> {
      await prisma.group.update({ where: { id: groupId }, data: { memoryConsolidatedAt: at } });
    },
    upsert(p: { channel: Channel; externalId: string; name: string }): Promise<Group> {
      return prisma.group.upsert({
        where: { channel_externalId: { channel: p.channel, externalId: p.externalId } },
        create: {
          channel: p.channel,
          externalId: p.externalId,
          name: p.name,
          categoriesEnabled: [],
        },
        update: { name: p.name },
      });
    },
  };
}

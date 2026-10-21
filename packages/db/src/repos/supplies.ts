import type { DemandCategory, SupplyDraft } from '@matchbot/domain';
import type { PrismaClient, Supply } from '../generated/client.js';

export function suppliesRepo(prisma: PrismaClient) {
  return {
    create(
      p: SupplyDraft & { userId: string; groupId: string; sourceMessageId: string },
    ): Promise<Supply> {
      return prisma.supply.create({
        data: {
          userId: p.userId,
          groupId: p.groupId,
          category: p.category,
          availability: p.availability ?? null,
          area: p.area ?? null,
          expiresAt: new Date(p.expiresAt),
          sourceMessageId: p.sourceMessageId,
        },
      });
    },
    /** Peer offers are group-scoped: a member's offer is only matched inside the group it was posted in. */
    findActive(category: DemandCategory, groupId: string): Promise<Supply[]> {
      return prisma.supply.findMany({
        where: { category, groupId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
    },
  };
}

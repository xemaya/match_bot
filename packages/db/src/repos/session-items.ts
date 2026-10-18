import type { PrismaClient } from '../generated/client.js';

export function sessionItemsRepo(prisma: PrismaClient) {
  return {
    async list(userId: string, limit?: number, scopeKey = ''): Promise<unknown[]> {
      const rows = await prisma.sessionItem.findMany({
        where: { userId, scopeKey },
        orderBy: { seq: 'asc' },
      });
      const items = rows.map((r) => r.item as unknown);
      return limit ? items.slice(-limit) : items;
    },
    async append(
      userId: string,
      items: unknown[],
      operationId?: string,
      scopeKey = '',
    ): Promise<void> {
      if (
        operationId &&
        (await prisma.sessionItem.count({ where: { userId, scopeKey, operationId } })) > 0
      )
        return;
      const max = await prisma.sessionItem.aggregate({
        where: { userId, scopeKey },
        _max: { seq: true },
      });
      let seq = max._max.seq ?? 0;
      await prisma.sessionItem.createMany({
        data: items.map((item) => ({
          userId,
          scopeKey,
          seq: ++seq,
          item: item as object,
          operationId: operationId ?? null,
        })),
      });
    },
    async popLast(userId: string, scopeKey = ''): Promise<unknown> {
      const last = await prisma.sessionItem.findFirst({
        where: { userId, scopeKey },
        orderBy: { seq: 'desc' },
      });
      if (!last) return null;
      await prisma.sessionItem.delete({ where: { id: last.id } });
      return last.item;
    },
    async clear(userId: string, scopeKey = ''): Promise<void> {
      await prisma.sessionItem.deleteMany({ where: { userId, scopeKey } });
    },
  };
}

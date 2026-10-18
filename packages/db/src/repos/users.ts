import type { Channel, PrismaClient, User } from '../generated/client.js';

export function usersRepo(prisma: PrismaClient, channelScope = '') {
  return {
    findByExternal(channel: Channel, externalId: string): Promise<User | null> {
      return prisma.user.findUnique({
        where: { channel_externalId: { channel, externalId, channelScope } },
      });
    },
    async upsertByExternal(p: {
      channel: Channel;
      externalId: string;
      lang?: string;
    }): Promise<User> {
      const existing = await prisma.user.findUnique({
        where: {
          channel_externalId: { channel: p.channel, externalId: p.externalId, channelScope },
        },
      });
      const languages = new Set(existing?.languages ?? []);
      if (p.lang) languages.add(p.lang);
      if (existing) {
        return prisma.user.update({
          where: { id: existing.id },
          data: { languages: [...languages], lastSeenAt: new Date() },
        });
      }
      return prisma.user.create({
        data: {
          channel: p.channel,
          channelScope,
          externalId: p.externalId,
          languages: [...languages],
          lastSeenAt: new Date(),
        },
      });
    },
    findById(id: string): Promise<User | null> {
      return prisma.user.findUnique({ where: { id } });
    },
  };
}

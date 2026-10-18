import { z } from 'zod';
import type { Channel, Group, PrismaClient } from '../generated/client.js';

export function groupsRepo(prisma: PrismaClient, channelScope = '') {
  return {
    findByExternal(channel: Channel, externalId: string): Promise<Group | null> {
      return prisma.group.findUnique({
        where: { channel_externalId: { channel, externalId, channelScope } },
      });
    },
    setPolicy(input: {
      channel: Channel;
      externalId: string;
      isActive: boolean;
      phase: 0 | 1 | 2;
      rateLimitPerDay: number | null;
    }): Promise<Group> {
      const p = z
        .object({
          channel: z.enum(['telegram', 'feishu', 'whatsapp']),
          externalId: z.string().min(1),
          isActive: z.boolean(),
          phase: z.union([z.literal(0), z.literal(1), z.literal(2)]),
          rateLimitPerDay: z.number().int().positive().nullable(),
        })
        .parse(input);
      return prisma.group.update({
        where: {
          channel_externalId: { channel: p.channel, externalId: p.externalId, channelScope },
        },
        data: { isActive: p.isActive, phase: p.phase, rateLimitPerDay: p.rateLimitPerDay },
      });
    },
    upsert(p: { channel: Channel; externalId: string; name: string }): Promise<Group> {
      return prisma.group.upsert({
        where: {
          channel_externalId: { channel: p.channel, externalId: p.externalId, channelScope },
        },
        create: {
          channel: p.channel,
          channelScope,
          externalId: p.externalId,
          name: p.name,
          categoriesEnabled: [],
        },
        update: { name: p.name },
      });
    },
  };
}

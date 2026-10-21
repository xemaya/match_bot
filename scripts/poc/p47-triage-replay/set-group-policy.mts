/** Sets the actor test group's policy without touching stored messages. Usage: set-group-policy.mts <phase> <active> */
import { z } from 'zod';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import { loadEnv } from '../../../packages/shared/src/index.js';

const phase = z.coerce.number().int().min(0).max(2).parse(process.argv[2]);
const active = z.enum(['true', 'false']).parse(process.argv[3]) === 'true';
const GROUP = '-5013792100';
const prisma = createPrisma(loadEnv().DATABASE_URL);
const repos = createRepositories(prisma);
try {
  const group = await repos.groups.findByExternal('telegram', GROUP);
  if (!group) throw new Error('group_missing');
  await repos.groups.setPolicy({
    channel: 'telegram',
    externalId: GROUP,
    isActive: active,
    phase,
    rateLimitPerDay: group.rateLimitPerDay ?? 30,
  });
  console.log(JSON.stringify({ isActive: active, phase }));
} finally {
  await prisma.$disconnect();
}

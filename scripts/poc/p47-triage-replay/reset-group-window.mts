/**
 * Before a new live actor round: blank the earlier rounds' group message texts and sent Match Bot
 * replies (so the 6-hour group transcript does not turn a repeated synthetic ask into a "continue"),
 * expire the synthetic tasks they opened, and set the group policy for the round.
 * Usage: reset-group-window.mts <phase 0|2> <active true|false>
 */
import { z } from 'zod';
import { createPrisma, createRepositories } from '../../../packages/db/src/index.js';
import { loadEnv } from '../../../packages/shared/src/index.js';

const phase = z.coerce.number().int().min(0).max(2).parse(process.argv[2]);
const active = z.enum(['true', 'false']).parse(process.argv[3]) === 'true';
const GROUP = '-5013792100';
const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);
const repos = createRepositories(prisma);
try {
  const group = await repos.groups.findByExternal('telegram', GROUP);
  if (!group) throw new Error('group_missing');
  const messages = await prisma.message.updateMany({
    where: { groupId: group.id, text: { not: '' } },
    data: { text: '', executionSnapshot: null, replyToBotText: null },
  });
  const replies = await prisma.outboundMessage.updateMany({
    where: { target: GROUP, status: 'sent', text: { not: '' } },
    data: { text: '' },
  });
  const tasks = await prisma.task.updateMany({
    where: { chatId: GROUP, status: { in: ['active', 'delivered', 'waiting_delivery'] } },
    data: { status: 'expired' },
  });
  await repos.groups.setPolicy({
    channel: 'telegram',
    externalId: GROUP,
    isActive: active,
    phase,
    rateLimitPerDay: group.rateLimitPerDay ?? 30,
  });
  console.log(
    JSON.stringify({
      blankedMessages: messages.count,
      blankedReplies: replies.count,
      expiredTasks: tasks.count,
      policy: { isActive: active, phase },
    }),
  );
} finally {
  await prisma.$disconnect();
}

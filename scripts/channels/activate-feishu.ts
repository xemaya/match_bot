import { createPrisma, createRepositories } from '../../packages/db/src/index.js';
import { loadEnv, createLogger } from '../../packages/shared/src/index.js';

// Explicit local operator action, not a bot command or a model tool.
const env = loadEnv();
const chatId = process.argv[2];
if (!chatId || !/^oc_[A-Za-z0-9_-]+$/.test(chatId))
  throw new Error('Usage: activate-feishu.ts oc_CHAT');
if (
  !env.FEISHU_ALLOWED_CHATS.split(',')
    .map((s) => s.trim())
    .includes(chatId)
)
  throw new Error('Chat is not in FEISHU_ALLOWED_CHATS');
const prisma = createPrisma(env.DATABASE_URL);
try {
  const repos = createRepositories(prisma).forChannel('feishu', {
    installationId: env.CHANNEL_INSTALLATION_ID,
    accountId: env.FEISHU_APP_ID,
    tenantId: env.FEISHU_TENANT_ID,
  });
  await repos.groups.upsert({ channel: 'feishu', externalId: chatId, name: 'Feishu test group' });
  const group = await repos.groups.setPolicy({
    channel: 'feishu',
    externalId: chatId,
    isActive: true,
    phase: env.DEFAULT_PHASE === 1 || env.DEFAULT_PHASE === 2 ? env.DEFAULT_PHASE : 0,
    rateLimitPerDay: null,
  });
  createLogger('channels').info(
    { groupId: group.id, phase: group.phase },
    'Feishu group activated',
  );
} finally {
  await prisma.$disconnect();
}

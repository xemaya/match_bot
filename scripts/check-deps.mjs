// 架构依赖方向校验（AGENTS.md §3）。违反即 lint 失败。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = {
  '@matchbot/dsh-matchbot': ['@matchbot/host', '@matchbot/shared'],
  '@matchbot/host': [
    '@matchbot/shared',
    '@matchbot/domain',
    '@matchbot/db',
    '@matchbot/queue',
    '@matchbot/runtime',
    '@matchbot/channels',
    '@matchbot/channel-feishu',
    '@matchbot/channel-telegram',
  ],
  '@matchbot/runtime': [
    '@matchbot/shared',
    '@matchbot/domain',
    '@matchbot/db',
    '@matchbot/queue',
    '@matchbot/jev',
    '@matchbot/gating',
    '@matchbot/agent',
    '@matchbot/approval',
    '@matchbot/websearch',
  ],
  '@matchbot/channels': [
    '@matchbot/shared',
    '@matchbot/domain',
    '@matchbot/db',
    '@matchbot/queue',
    '@matchbot/gating',
    '@matchbot/approval',
  ],
  '@matchbot/channel-feishu': ['@matchbot/shared', '@matchbot/domain', '@matchbot/db'],
  '@matchbot/shared': [],
  '@matchbot/domain': ['@matchbot/shared'],
  '@matchbot/db': ['@matchbot/shared', '@matchbot/domain'],
  '@matchbot/queue': ['@matchbot/shared', '@matchbot/domain'],
  '@matchbot/jev': ['@matchbot/shared', '@matchbot/domain', '@matchbot/db'],
  '@matchbot/gating': ['@matchbot/shared', '@matchbot/domain', '@matchbot/db'],
  '@matchbot/matcher': ['@matchbot/shared', '@matchbot/domain', '@matchbot/db'],
  '@matchbot/channel-telegram': ['@matchbot/shared', '@matchbot/domain', '@matchbot/db'],
  // P14：只做搜索与页面核验，不碰库、不碰模型
  '@matchbot/websearch': ['@matchbot/shared'],
  '@matchbot/approval': [
    '@matchbot/shared',
    '@matchbot/domain',
    '@matchbot/db',
    '@matchbot/queue',
    '@matchbot/channel-telegram',
  ],
  '@matchbot/agent': [
    '@matchbot/shared',
    '@matchbot/domain',
    '@matchbot/db',
    '@matchbot/jev',
    '@matchbot/gating',
    '@matchbot/matcher',
    '@matchbot/websearch',
  ],
  // §3.2 的链条是 `… ← { approval, agent } ← eval`，即 eval 可依赖它之前的一切。
  // 原先只列了 5 个，漏掉 gating / queue / matcher / channel-telegram / approval，
  // 导致 eval 无法跑真实入站门（P12 因此阻塞）。
  '@matchbot/eval': [
    '@matchbot/shared',
    '@matchbot/domain',
    '@matchbot/db',
    '@matchbot/queue',
    '@matchbot/jev',
    '@matchbot/gating',
    '@matchbot/matcher',
    '@matchbot/channel-telegram',
    '@matchbot/approval',
    '@matchbot/agent',
  ],
};
// 外部包的白名单：谁可以直接依赖模型 SDK / 渠道 SDK / 数据库驱动
const EXTERNAL_OWNERS = {
  '@openai/agents': ['@matchbot/agent'],
  // apps/bot 创建并持有 Bot 实例（interfaces.md 的 createTelegramSender / createOpsCardSender
  // 都要求传入 Bot），发送仍必须经 channel-telegram。参照 bullmq 的先例同时允许 app。
  '@larksuiteoapi/node-sdk': ['@matchbot/channel-feishu'],
  grammy: ['@matchbot/channel-telegram', '@matchbot/bot'],
  '@prisma/client': ['@matchbot/db'],
  '@prisma/adapter-pg': ['@matchbot/db'],
  pg: ['@matchbot/db'],
  bullmq: ['@matchbot/queue', '@matchbot/worker', '@matchbot/bot'],
  ioredis: ['@matchbot/queue'],
};

let failed = false;
for (const dir of ['packages', 'apps']) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name, 'package.json');
    if (!existsSync(p)) continue;
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const dep of deps) {
      if (dep.startsWith('@matchbot/') && pkg.name in ALLOWED && !ALLOWED[pkg.name].includes(dep)) {
        console.error(`✗ ${pkg.name} 不得依赖 ${dep}（见 AGENTS.md §3 依赖方向）`);
        failed = true;
      }
      if (dep in EXTERNAL_OWNERS && !EXTERNAL_OWNERS[dep].includes(pkg.name)) {
        console.error(
          `✗ ${pkg.name} 不得直接依赖 ${dep}，只有 ${EXTERNAL_OWNERS[dep].join(', ')} 可以`,
        );
        failed = true;
      }
      if (
        pkg.name.startsWith('@matchbot/') &&
        dir === 'packages' &&
        dep.startsWith('@matchbot/') &&
        !dep.startsWith('@matchbot/')
      )
        failed = true;
    }
    if (
      dir === 'packages' &&
      deps.some((d) => ['@matchbot/bot', '@matchbot/worker', '@matchbot/admin'].includes(d))
    ) {
      console.error(`✗ ${pkg.name}：packages 不得依赖 apps`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log('✓ dependency direction ok');

# 本地测试（无需 Telegram）

`chat.mts` 复用真实 worker 入站、任务规划、持久化和出站发送账本，终端代替 Telegram。
使用真实模型和搜索；不会调用 Telegram API。`/user 123456` 切换私聊用户，`/quit` 退出。
每次启动默认新建合成用户；需要继续旧会话时使用相同 `/user`。
日志中的发送成功仅为本地模拟回执，不代表 Telegram 送达。
Phase 1 只生成待审批记录；此 CLI 暂不提供审批操作。群聊与审批恢复由集成测试覆盖。

## 准备隔离数据库

从仓库根目录执行，先安装依赖并生成 Prisma 客户端。已有其他 PostgreSQL 时也可自行创建同名测试库。
CLI 仅允许 loopback 地址、库名 `matchbot_local_test`，不要往此库写生产数据。

```sh
pnpm install --frozen-lockfile
pnpm db:generate
docker compose -f scripts/local/compose.yaml up -d
export DATABASE_URL=postgresql://matchbot:matchbot@127.0.0.1:15432/matchbot_local_test
export TEST_REDIS_URL=redis://127.0.0.1:16379/15
pnpm --filter @matchbot/db exec prisma migrate deploy
pnpm check
```

测试使用脚本模型/固定来源，不需要模型密钥。任务对话契约在 strict/targeted 下各执行 12 个案例，
涵盖多轮修订、切换、暂停/恢复、用户和群隔离、回执后的任务状态等；这不等于真实模型效果评估。
只有纯离线测试时：

```sh
pnpm typecheck
pnpm exec vitest run --exclude '**/tests/integration/**' --exclude '**/tests/e2e/**'
```

## 真实模型聊天

在私有本地环境文件中配置 `DEEPSEEK_API_KEY`、上述 `DATABASE_URL` 和稳定的 `SNAPSHOT_KEY`。
事实性回答仍需 `JEV_API_KEY`；不提供时可验证直接入站和固定失败状态，但无法正常自动发布事实性答案。
不需要 Telegram token、ops chat、Redis 服务；CLI 注入本地占位配置，直接调用 worker。

```sh
pnpm typecheck
pnpm exec tsx --env-file=/absolute/path/to/local.env scripts/local/chat.mts
```

CLI 默认 `JEV_POLICY=targeted`、`DEFAULT_PHASE=2`，可在环境中显式覆盖。
生产 worker 的兼容默认仍为 `strict`；`.env.example` 显式选择 `targeted`。
切回 `strict` 即恢复原有入站/出站评价策略，且必须提供 JEV key。

Targeted 减少的是直接请求的入站评价、固定模板状态的出站评价，以及直接回复的价值分门槛。
来源证据核验、未经核实事实拦截、群内主动参与筛选、Phase 0/1 和频控仍保留。
所以这是降低依赖，不是完全移除 JEV。

完成后停止测试服务：

```sh
docker compose -f scripts/local/compose.yaml down
```

## 公共网页核验

Worker 默认提供 `read_web_page`：打开当前任务已发现的 HTTPS 地址、查找页内内容或分页读取、沿返回链接继续核验。每轮最多 6 次读取，仍受原有 16 来源与运行期限限制。它不执行页面 JavaScript，也不提交表单。

网络层逐跳检查 DNS 并固定连接地址，禁止内网、回环和保留地址，不读取浏览器 cookie。当前实现仅使用 IPv4，页面正文上限 1 MiB。部分站点的动态页面、PDF、反爬或 IPv6-only 服务会明确不可用。

本机 VPN 若把域名解析为 `198.18.0.0/15` 等虚拟地址，不应放宽地址检查。可显式配置 `PAGE_DNS_MODE=https`，通过固定 Google HTTPS DNS 获取真实公网 IPv4，后续页面连接仍校验并固定该地址；此模式会向该解析服务发送公开页面域名。普通云环境保留 `system`。

## 提示词结构审计

无需模型凭据、数据库或网络：

```sh
node --import tsx scripts/local/prompt-audit.mts
```

输出各场景/阶段的实际工具、系统提示词字符数和哈希；检查协议引用及字符预算。
架构及历史案例归属见 [提示词架构](../../packages/agent/src/prompts/README.md)。此命令不评价真实模型回答质量。

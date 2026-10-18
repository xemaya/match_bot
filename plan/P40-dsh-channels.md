# P40 DSH 多渠道插件

状态：代码与本地验收完成，待 PR 合并及真实飞书联调。用户授权 goal 模式实施 2026-10-18 渠道架构方案。

设计见 docs/design/channels-dsh.md；已整合主干 ce647ac（PR #16），DSH 源码核对 687f282（0.2.1-rc.2）。

顺序：
1. 公共渠道契约、账号/租户/会话键、平台中立的发送及错误接口，保留 Telegram 行为。
2. 持久收发与账号隔离、飞书 DM/话题路由、审批恢复；数据库迁移及集成回归。
3. 飞书 SDK 长连接、发送及卡片，配置和 doctor，离线 adapter 测试。
4. DSH bundle 生命周期挂载 MatchBotRuntime（首版保留现有 SDK 执行循环，单一运行时归属）。
5. 全量检查、安装 smoke、真实飞书测试（依赖用户提供测试应用配置）。

本包为跨包渠道契约变更，不改变业务门控要求。新增官方飞书 SDK 与 DSH 宿主依赖时在 PR 解释作用及边界。实现不意味着原生 DSH agent-loop 迁移已完成；原生迁移需要单独可重放日志及审批等价验收。

## 实施记录

- 新增 domain 渠道契约和 scope；迁移为 User/Group 增加 channelScope、Message 增加 channelRoute、SessionItem 增加 scopeKey、Task/OutboundMessage 增加 threadId。旧记录保留 legacy scope。
- 提取 runtime/channels；新增 host、channel-feishu、dsh-matchbot；原 apps 兼容入口保留。
- 入站幂等、任务作用域、Session、Jev recentTexts、审批恢复、出站认领按账号/会话边界处理；审批回调校验 reviewer/运营群/本账号已投递卡片。
- 官方 SDK 长连接生命周期、allowlist、文本/话题/卡片发送已实现。Telegram host 连接使用显式账号。外部发送仍只消费 outbox。
- DSH 首版复用既有业务执行循环，AGENT_VERSION 升到 0.27.0；升级前须处理旧待审快照，旧版本恢复会按既有逻辑拒绝。
- Prisma 非交互 migrate dev 不可用，使用官方 migrate diff 生成两份 SQL，再对专用本地库 migrate deploy；未使用 db push。
- DSH 官方 CLI 0.2.1-rc.2 已在临时 DSH_HOME 安装生成的本地 bundle；dump-config 显示 matchbot 编译入口和 enabled 配置。真实 Cordis 4.0.5 加载/异步卸载测试通过。
- pnpm deploy 可生成独立运行目录；npm 11.17.0 对含 pnpm 工作区依赖的 bundle pack 出现 Exit handler never called，故提供明确的本地路径 bundle，不声称已发布/验证 npm 分发包。源码包不应直接发布。
- 使用 `scripts/channels/start.ts --doctor` 可检查配置，不联网、不打印 secret。飞书激活与启动步骤见 docs/design/channels-local-testing.md。
- 新增官方飞书 SDK 用于平台协议，Cordis 仅用于 DSH 生命周期。新增路由标识随业务记录保留，不存凭据；删除与正文保留说明见测试文档。
- 真实飞书权限/收发/卡片尚未联调：等待专用测试应用配置；不影响离线回归、DB/Redis 测试和 DSH 安装验证。

最终本地 `pnpm check`：typecheck、lint、格式全部通过；147 个测试文件、1216 条测试通过（真实本地 Postgres/Redis，模型与渠道 transport 使用脚本/模拟）。保留主干 #16 的模型凭据隔离、reasoning 设置和 trace 修复。

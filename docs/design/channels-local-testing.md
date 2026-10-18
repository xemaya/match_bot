# 多渠道本地测试与 DSH 插件

P40 首版：DSH/Cordis 管理 MatchBot 的生命周期；业务仍运行既有 Agents SDK。不会向 DSH 默认交互 session 再投递同一条消息。原生 DSH agent-loop 迁移不在本次实现内。

## 独立启动

Node 22.12+、pnpm 11、专用 Postgres 和 Redis。不要和旧 `dev:bot` / `dev:worker` 共用数据库、队列并同时运行。先安装依赖、生成 Prisma client、执行迁移和构建：

```sh
pnpm install --ignore-scripts
pnpm db:generate
pnpm --filter @matchbot/db exec prisma migrate deploy
pnpm typecheck
```

通过 Node `--env-file=/绝对路径/测试.env` 加载本地配置，环境文件不提交。模型和快照配置沿用 `.env.example`。新增渠道变量：

```dotenv
CHANNEL_MODE=feishu
CHANNEL_INSTALLATION_ID=local-feishu-test
FEISHU_APP_ID=cli_REPLACE
FEISHU_APP_SECRET=REPLACE
FEISHU_TENANT_ID=REPLACE
FEISHU_REGION=feishu
FEISHU_ALLOWED_USERS=ou_TESTER
FEISHU_ALLOWED_CHATS=oc_TEST_GROUP
FEISHU_OPS_CHAT_ID=oc_OPS_GROUP
FEISHU_REVIEWERS=ou_REVIEWER
DEFAULT_PHASE=1
```

`FEISHU_ALLOWED_USERS`、`FEISHU_ALLOWED_CHATS`、`FEISHU_REVIEWERS` 为逗号分隔 ID。空白名单不接收相应消息。App ID、tenant key、用户 open_id 和 chat_id 不能互换。群消息默认要求 @bot 或回复本机器人已发送的消息。仅支持文本、消息回复、有限表情和审批卡；文件、图片、音频暂不支持。未实现 WhatsApp 适配器。

飞书开发者后台创建专用自建应用、启用机器人、配置测试成员和可见范围，使用长连接接收事件。订阅 `im.message.receive_v1` 和 `card.action.trigger`，授予接收私聊/@消息、发送机器人消息、读取机器人信息等所需权限并发布测试版本；使用表情还需对应 reaction 权限。SDK 为官方 `@larksuiteoapi/node-sdk` 1.76.0。后台权限名以该应用控制台实际提示为准。

```sh
node --env-file=/absolute/test.env --import tsx scripts/channels/start.ts --doctor
node --env-file=/absolute/test.env --import tsx scripts/channels/activate-feishu.ts oc_TEST_GROUP
node --env-file=/absolute/test.env --import tsx scripts/channels/start.ts
```

群白名单只是接收边界；激活命令才写入群业务策略。新发现群默认不激活。Phase 0 只记录；Phase 1 审批；Phase 2 按既有门控。建议首次验证使用 Phase 1。审批必须同时命中 reviewer 白名单、运营群和本账号确实投递的卡片 message ID。

`CHANNEL_MODE=telegram` 或 `both` 可启用 Telegram；需要原有 token/ops 配置，DSH host 另需 `TELEGRAM_REVIEWERS=数字用户ID,...`。新的 host 使用显式账号 scope，不自动接管 legacy Telegram 的历史或待发消息；原入口继续处理 legacy scope。切换时先停止旧入口并处理旧待审/待发，再按新安装使用，不直接混用。

## DSH 本地 bundle

接口依据 DSH `0.2.1-rc.2` / Cordis `4.0.5`，源码参考 commit `687f282e8625c6b8d11ff58211a90524be2e4317`。

```sh
node scripts/channels/build-dsh.mjs /absolute/new/matchbot-deployment
# 下述目录是没有私有 workspace 依赖的本地 DSH bundle：
dsh plugin --profile web add /absolute/new/matchbot-deployment/bundle
```

在加载该 profile 的进程启动前配置上述环境变量。bundle 的 patch 使用部署目录中编译入口的绝对路径；部署目录须保留，移动后重新生成/安装。这是本地可安装 bundle，不是已发布的 npm 插件。`packages/dsh-matchbot` 的工作区源码本身不应直接作为 npm 发布包安装。

插件配置 `enabled: false` 可禁用而不读取凭据或连接服务。正常卸载会等待投递/回调、worker 和 DB 资源释放。每个进程只支持一个 MatchBot host；SDK 的 provider/tracing 当前是全局配置。多个安装请使用独立进程、数据库和 Redis，不提供共享存储的多租户授权保证。

## 验收与边界

自动测试不调用真实模型/渠道：包含消息归一化、私聊与话题、账号隔离、持久 inbox/outbox、审批来源校验、模型脚本驱动的审批恢复、会话 scope、关闭连接和 Cordis 卸载。数据库集成使用真实 Postgres，队列使用真实 Redis。

真实飞书联调还需要测试应用配置；需验证私聊、群 @、线程回复、运营卡审批/拒绝、重复点击和重连后的重复事件。自动测试不能替代这一步，也不能据此宣称平台权限和卡片 UI 已验证。

发送超时或成功回执不完整会标记投递结果未知，不盲目重发。账号/tenant/chat/thread 由适配器和持久消息决定，模型不能指定发送账号。入站事件去重和会话历史是不同层次：前者避免重复执行，后者防止不同上下文互串。

新增持久标识包括账号 scope、chat/thread/event 路由及字符串发送回执，不存 token/secret，也不重复保存消息正文。标识随对应业务记录保留；现有 30 天正文清理、7 天快照过期规则继续生效。标识不是自动 30 天删除；注销安装时应清理该安装专用数据库。没有新增日志原文输出。

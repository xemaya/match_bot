# MatchBot 渠道与 DSH 插件架构建议

日期：2026-10-18。状态：设计审查，尚未实现/启动真实飞书 bot。
依据：match_bot dcc0473；DSH 官方 master 687f282e8625c6b8d11ff58211a90524be2e4317（package version 0.2.1-rc.2）；OpenClaw 官方当前渠道文档。当前工作区没有 DSH 定制源码，本次 DSH 判断基于官方 checkout，不声称已核对内部部署版本。

## 1. 决策

将 MatchBot 做成 DSH 业务插件，并将渠道能力做成独立、可复用的插件。一个可安装 bundle 可以组合 channels-runtime、channel-feishu、channel-telegram、matchbot，但职责不能重新揉进一个 bot 插件。

DSH 负责插件装配、生命周期及最终的 agent 执行与会话日志；channels-runtime 负责持久接收、账号路由、会话绑定、发送回执；渠道插件负责平台 SDK、鉴权、协议、格式和原生交互；matchbot 负责需求/任务、检索、证据校验、答复与出站业务门控。

第一步让现有 Agent 经明确的 MatchbotRuntime 接口挂到 DSH，先打通飞书。此阶段内部仍用 Agents SDK，是宿主集成，不应称为完成 DSH 原生运行时迁移。最终把工具、提示词及执行策略迁到 DSH scoped preset，使用一个执行循环和一套模型历史。每个 binding 明确指定 backend；不能让同一消息同时进入 DSH 默认 agent 和旧 worker。

## 2. 已确认的耦合

| 位置 | 事实 | 需要的改动 |
|---|---|---|
| packages/domain/src/message.ts | channel 只有 telegram/whatsapp；缺账号、租户、chatType、threadId | 标准事件信封及版本 |
| apps/bot/src/main.ts | 创建 grammY bot，同时启动收发、审批和调度 | 拆独立 host 与 adapter 生命周期 |
| apps/bot/src/inbound.ts | Update 类型、私聊识别、群登记硬编码 Telegram | adapter 归一化后进入公共 admission |
| apps/bot/src/outbound-loop.ts | sender 和错误类型都来自 Telegram | 中立 DeliveryAdapter 与 SendFailure |
| packages/db/src/repos/outbound.ts:257 | claim SQL 仅领取 telegram；后续审批路径也硬编码 | 按 active channel/account 精确领取并验证 |
| packages/approval/src/callback.ts | 核心审批直接解析 Telegram callback | adapter 解析为验证过的 ApprovalAction |
| packages/shared/src/env.ts:51 | Telegram token 和 ops chat 全局必填 | 配置只校验已启用的账号 |
| packages/queue/src/contracts.ts:16 | 去重 key 只有 channel/chat/message | 加安装实例、账号/租户作用域 |
| packages/db/prisma/schema.prisma | User/Group 仅按 channel + externalId 唯一；outbound 虽有 senderAccountId，但未形成完整入站路由 | 统一 identity 与 route key，迁移旧 default 账号 |
| packages/agent/src/session.ts:98 | 模型历史以 userId 存储 | 对话 binding 与身份分离；任务所有者保持独立 |

已有 request window 隔离和 task owner/channel/chat 检查降低了污染风险，但不能替代多 bot、多租户、多话题隔离。当前代码不是已经发生跨租户泄露的证据，而是新增渠道前必须补齐的边界。

## 3. 从参考工程吸收什么

OpenClaw 的渠道插件有账号配置、接入策略、会话映射、发送与话题/格式能力；核心统一 dispatch 和会话键。我们采用这个责任划分和 capability 描述，不直接复制其全部插件接口，更不把 OpenClaw 插件当作可直接加载的 DSH 插件。
来源：https://docs.openclaw.ai/plugins/sdk-channel-plugins

DSH 当前通过 Cordis service、typed event 和 effect 装配；bundle 由 package.json 的 dsh.bundle 指向 patch；agent preset 可按 agent 限定工具和提示词。插件退出必须清理连接、监听、定时器并取消/drain 在途工作。热重载不仅关闭旧 socket，还需账号租约与 generation fencing，阻止旧实例恢复后继续发送。
来源：https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md

核对的接口包括 ctx.agents.create/resume、agent.followup/send/inject、session/event、agent preset 与 permission preset。ctx.webhookRuntime 的内置动作是创建新 Session；其 README 明确 process-local fire-and-forget、无内置去重/重放。群聊连续会话不能简单每条消息 dispatch 成一个新 Session。whenIdle 也不代表某个指定消息已经完成，必须按 inbound/execution/turn ID 关联。
来源：https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/experimental/webhook/README.md

## 4. 建议模块（以下名称是拟新增模块，不是 DSH 已有 API）

- channel-contracts：无 IO 的事件、身份、目标地址、内容块、能力、回执与失败类型。
- channels-runtime：账号注册、inbox/outbox、路由、binding、去重、并发顺序、连接状态和投递诊断。
- channel-telegram：迁出现有 grammY 实现，保留原平台行为。
- channel-feishu：官方 Node SDK、长连接、消息/引用/话题/mention、卡片回调、文本及卡片 renderer。
- channel-test：相同接口的可注入事件和可断言回执，测试不会另起业务捷径。
- dsh-matchbot：装配 matchbot runtime；后续提供受限 native preset。领域/检索/证据逻辑不依赖平台 SDK。
- bundle-matchbot：一个可安装入口，声明插件版本和配置。通过 DSH 正规 profile/bundle 启动。

## 5. 契约与隔离

InboundEnvelope v1 建议字段：installationId、channel、accountId、tenantId、eventId、messageId、senderId、conversationId、conversationType（direct/group）、threadId、replyTo、mentions、content、receivedAt。没有租户概念的平台也用明确的本地作用域值，不能含义不明地遗漏。账号和租户由已认证连接确定，不能信任消息文本。

标识都保留字符串；Telegram 的数值转换只留在 Telegram adapter。eventId 用于事件重放去重，messageId 用于消息关联；编辑和卡片动作是不同事件类型，不能当新需求混入。

ReplyRoute = installation + channel + account + tenant + conversation + optional thread + replyTo。服务端从入站冻结该路由；模型只能提交内容与证据，不能自由选择账号或接收人。跨会话主动发送是另一个显式授权能力。

建议默认 binding = installation/channel/account/tenant/conversation/thread/owner。私聊按对方身份；群内个人需求必须包含 owner，避免整个群共享私人任务。确有共享群任务时单独创建 shared task scope，而非去掉 owner。生成 sessionId 使用规范化结构编码/hash，不直接拼未经编码的冒号字符串。

三种对象分开：ChannelIdentity（平台身份）、ConversationBinding（对话及运行时）、TaskOwner（业务所有权）。跨平台账号只在显式绑定后共享允许共享的业务事实；聊天记录不自动合并。DSH sessionId 由绑定服务持久映射，不能直接用 open_id 或 chat_id。

DSH 原生迁移时，模型可见动态数据必须满足其可重放日志契约；不能照搬当前 SDK 的不持久化 input filter。需要可信结构封装的低优先级上下文事件/投影，保留来源与版本，避免落入 system 指令或复制双份历史。

## 6. 投递、能力和审批

平台事件 → 验证/归一化 → 持久 inbox + 唯一键 → 按 binding 串行执行 → 业务出站门控 → outbox → 精确账号 adapter → receipt。

在平台时限内完成持久接收/确认，不等待模型生成；重连和重启后恢复未处理事件。平台 SDK 的 ACK 时机要在飞书 PoC 中验证，不能假设 handler 返回前一定具有可重放保证。

保留当前 lease/fence、dry_run、pending、delivery_unknown 机制。网络超时不等于未发送；只有确定未发送的请求自动重试，未知结果走查询/对账或人工处理。平台支持幂等请求键时使用稳定 outbound ID；长消息拆分需记录每一片的回执，避免部分成功后整条重发。

Capabilities 明确 text、richText、reply、threads、mentions、reactions、cards、edit、attachments、长度限制及主动消息限制。渲染器处理平台差异；不支持的操作返回 unsupported 或采用预先定义的降级，不伪造成功。首版可只支持文本/引用/@/审批卡，媒体后续扩展。

业务只输出受控内容结构，不生成飞书 card JSON 或 Telegram HTML。证据与来源结构保留到 renderer，转义在边界做。审查前不得把模型流式文本发到群里；可以显示固定的处理状态，最终内容通过门控后再发。

ApprovalAction 包含 actionId、runStateId、decision、reviewer identity、来源账号/群/消息、有效期。回调需要验证来源及审核人权限，原子消费一次；卡片本身不授予权限。飞书/Telegram 只是相同审批动作的不同展示。业务审批与 DSH 的工具执行许可分别管理，不把授权运行工具等同授权公开发言。

## 7. 飞书本地测试路径

优先企业自建应用的应用机器人 + 官方 SDK WebSocket 长连接，笔记本主动连出，无需公网域名或内网穿透；群自定义 webhook 机器人不是此次双向会话入口。
官方 SDK：https://github.com/larksuite/node-sdk
参考已实现渠道：https://docs.openclaw.ai/channels/feishu

一次性平台配置：创建应用并开启机器人，配置收发消息所需权限、事件 im.message.receive_v1 与必要卡片回调、可用范围/测试发布，邀请进入测试群。具体权限和回调订阅跟随应用类型及现行后台核对。Feishu 与 Lark endpoint 可配置，不硬编码单一区域。

本地体验目标：安装 bundle → 填 App ID/Secret 引用 → 启动专用 profile → doctor 显示连接与 bot 身份 → 在白名单私聊或测试群 @bot → 跟踪同一个 traceId 的接收/执行/发送回执。只有已启用飞书时才校验飞书凭据；不用填假的 Telegram token。凭据不进入模型、事件日志或共享配置提交。

开发和线上使用不同应用/账号；避免同一 app 多个环境同时消费事件。默认生产策略与测试策略分开，测试群可显式启用自动答复，不以测试便利绕过事实门控。

拟提供 channels doctor/status、绑定查看、录制与脱敏重放命令；这些是拟建设体验，目前没有可直接执行的上述命令。没有应用管理员权限和凭据，不能承诺自动创建/发布企业应用；本轮未索要凭据，因为仍在架构阶段。

验收：真实私聊及群 @、引用继续任务、两用户同群不串任务、同用户不同群不串上下文、两 bot/两租户相同外部 ID 不碰撞、重复事件只执行一次、断线重连、插件热重载、发送超时、停用账号、Phase 0/1/2、重复/过期/越权审批、未知投递不盲目重发。用相同合成业务用例跑 Telegram/Feishu/test adapter；真实飞书回执是独立验收，mock 不能替代。

## 8. 迁移顺序

A. 中立契约 + account/tenant/binding 存储迁移 + test adapter；从 Telegram admission/dispatcher 提取公共逻辑。先证明 Telegram 回归不变。
B. 实现 Feishu WS adapter、renderer、审批和 doctor；拿真实应用完成本地闭环。
C. 用 DSH bundle 接管生命周期并桥接当前 MatchbotRuntime；保留现有 PG/Redis，避免把渠道重构、运行时重写、存储替换混成一次迁移。
D. 在明确的 runtime seam 后迁移 DSH native preset：业务工具、场景提示词、上下文/日志、预算/收尾、审批恢复。每个 binding 单一 backend，按白名单切换并可回滚。
E. WhatsApp 再选择具体接入方式（官方 Business API 或其他实现）；主动消息能力与平台规则独立建模，不能假定与 Telegram 群消息相同。

旧数据迁移到显式 legacy/default account，部署时绑定唯一真实账号；不能从消息文字猜账号。schema/队列版本和旧审批快照要一起处理，不能让旧快照在新路由下发出。需要更新现有 AGENTS.md 的用户级 Session 约束和包依赖矩阵；这是本设计提出的契约变更，不应悄悄绕开。

DSH 插件隔离是代码组合与生命周期隔离，不是多租户 OS 安全边界。MatchBot preset 只提供业务所需工具，不继承通用编码 agent 的 shell/文件权限；需要运行不可信代码时另配执行沙箱。渠道凭据属于 host，不能放进用户可读 workspace。

## 9. 完成边界

本次完成源码与官方文档审查及设计，没有修改 match_bot 运行代码，没有创建/发布飞书应用，没有发送测试消息，也没有重跑模型评测。下一实施里程碑应是“DSH 可安装的 MatchBot + 可用飞书测试 bot”，而不是仅增加 feishu 枚举。

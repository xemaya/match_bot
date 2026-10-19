# Telegram 测试演员

三个明确标注“测试”的 Bot，在独立的 **A2H 测试群** 里模拟短句补充、修改条件和多人插话。它们只知道合成目标及本轮允许参与者的消息，没有答案、评分标准或真实用户历史。不会联系卖家、购买、支付或声称真实交易完成。

现有测试群与四个 Bot 已建立并真实运行，当前群恢复停用。接手现有群无需重建，身份、私有文件迁移与执行机切换见 [跨机器交接](telegram-lab-handoff.md)；新建独立实验室再按下方通用步骤配置。

## 配置与准备

1. 在 BotFather 创建三个演员 Bot，名称加“测试”。三个演员保留 Group Privacy，互通开关可保持默认；演员仅接收直接回复，通信接收能力需以真实更新验证，不能只据开关推定。Match Bot 需要启用 Bot-to-Bot Communication 并具有普通群消息可见性（现有配置需核对，任何全局开关或访问权限扩展须先确认）。创建独立测试群，加入三个演员与 Match Bot。只需普通成员权限。
2. 按 [配置模板](actor-lab.config.example.json) 创建本地 `.env.actor-lab.json`，替换实际身份、群 ID 和 token，`chmod 600 .env.actor-lab.json`。token 只在私有文件里，禁止粘贴到报告、Git、终端日志或 URL。使用现有本地 Postgres 的独立数据库 `matchbot_actor_lab`，对该库执行已有 `prisma migrate deploy`；禁止指向运行库。无新表或迁移。
3. `.env` 配置 `ACTOR_LAB_CONFIG_PATH=.env.actor-lab.json`，以及 `TELEGRAM_ACTOR_ALLOWLIST='[{"chatId":"实际测试群负数ID","botIds":["演员ID1","演员ID2","演员ID3"]}]'`。只填这一个新测试群。重启原 bot 进程，使入站白名单生效。worker 无需新增消费者。
4. 以下命令从仓库根目录运行；需要凭证的模式先在同一 shell 用 `set -a && . ./.env && set +a` 加载环境。不要重复启动 bot/worker 或演员 controller。

```sh
pnpm exec tsx apps/bot/src/actor-lab.ts --plan
pnpm exec tsx apps/bot/src/actor-lab.ts --offline-smoke
pnpm exec tsx apps/bot/src/actor-lab.ts --check
pnpm exec tsx apps/bot/src/actor-lab.ts --activate
pnpm exec tsx apps/bot/src/actor-lab.ts --dry-run
pnpm exec tsx apps/bot/src/actor-lab.ts --run
```

`--plan` 不需要凭证；`--offline-smoke` 使用真实独立 PG、Phase 0，禁止模型和 Telegram 调用。`--check` 只核对 API 返回的身份、群名、成员与 Match Bot 的普通群消息可见性（演员无需整群可见性），不能证明 bot-to-bot 实际投递。`--activate` 只有核对成功才激活配置中的新测试群为 Phase 2，其他群不改。`--dry-run` 仅写三个固定首句的 dry_run 记录，不调用生成模型或发消息。

`--run` 先发三人的首句，形成真实多人并发，再按各自收到的 Match Bot 回复继续。短句演员的补充可拆成连续两条；第二条不引用前文，用于检查隐式接话。其他参与者的私人目标不会相互注入。只有绑定本轮演员消息的真实 Match Bot 回复能进入演员上下文。演员若没有收到Bot API更新，控制器可读取同一请求/群、状态sent且有渠道回执的真实出站转录，标记sent_outbound；不能使用pending草稿或将Main账号的message_id拿来回复。此时后续演员消息不带replyTo，检查真实的隐式接话。

## 限制与停止

默认最多 6 条演员消息、10 分钟、15 万已观测 DeepSeek token（演员与匹配请求的 Match Bot 生成合计），硬上限 12 条/10 分钟。Jev 的决策 token 不在该计数内。已发起的模型请求可能超过 token/时间观测界限，因此这不是账户扣费硬限额。生成每次最多 400 输出 token、30 秒。可在测试群发送 `/stoptest`，或 Ctrl+C 停止 controller；已有 Match Bot 请求可能仍会结束。

演员发言仍走 `tool/needsApproval → Phase/Jev/频控 → 独立 outbound_messages → createTelegramSender`。Phase 0 不发；Phase 1 返回需要审批并停止，不在该手工控制器中创建审批快照；Phase 2 的拒绝和 Jev 不可用都不自动发、不重试改写绕门。独立出站库避免原 sender 误领演员消息。每次发送还核对群仍处于激活的 Phase 2。

只允许一个 controller。锁文件是 `.env.actor-lab.lock`，正常退出会释放；异常退出后先核对其 PID 已退出，再删除锁。启动发现控制库 pending/sending 会停止；先检查该行所属 run 与送达状态，不得把旧行挪到新 run 自动补发。没有收到真实回执时，不宣称已送达；未回复、处理失败和超时分别记录。

## 如何读结果

报告保存在忽略 Git 的 `logs/actor-lab/<runId>.json`（600 权限），包含合成对话、发送回执数、实际管线观测和限定 inputRef 的用量。没有人类私聊、token 或模型思维链。保留测试所需报告后可手工删除整个目录；撤销测试时移除白名单、停用本群、在 BotFather 撤销演员 token 并删除私有配置。

“消息已发”“管线处理结束”“用户收到有用回答”“生活目标完成”是不同结论。报告不是满意度评分；需要人工检查是否理解目标、保留条件、主动搜索、合理追问、说明缺口，是否串用户。沉默不算通过。相同演员在相同群的任务会延续，多次运行并非相互独立的 A/B 基线；要做独立基线需新群或明确取消合成旧任务，不伪造购买成功来清账。

Telegram 官方当前互通规则见 [Bot-to-Bot Communication](https://core.telegram.org/bots/features#bot-to-bot-communication)。普通群消息的接收方需要启用互通，并具备整群可见性；直接回复只需双方至少一个启用互通，演员因此可保留群隐私。仍需新群真实首发/回复确认，API 身份检查不能代替这一步。

## 五场完整管线验收（P33）

`turnOrder`可选三个既有role的有限列表，支持一个演员连续对话；是否首句按该演员实际已发送历史判断。五场预登记数据在scripts/poc/p33-live-multiturn/cases.json。新的预算必须先由用户明确批准，然后运行`pnpm exec tsx scripts/poc/p33-live-multiturn/run.mts --run <本轮新增token预算>`。默认`--plan`不读凭证、不调用模型或Telegram。

每场最多3条，总最多15条；串行，每场600秒、等待210秒，使用原有频控并计入旧发送。固定Main0.20.0，不在五场间调prompt/阈值。保存每条真实入站、出站回执、工具trace、任务账本、演员后续与usage；主动补查不能只据回复自述。只读身份检查使用单次getMe，不用SDK init的持续重试；10秒HTTP界限，30秒后不再启动新身份请求。结束仅停用本测试群。

## P34 搜索与校验回归

`pnpm exec tsx scripts/poc/p34-search-validation/compare.mts` 对比6个公开query的原始DeepSeek/Tavily检索（无生成模型），可传已有 `logs/p34/search-<UUID>` 只补剩余请求。`probe.mts` 是官方接口PoC。

`live.mts --plan` 只看计划；`live.mts --run <已批准新增预算>` 真实发送，最多6条，必须先获本批预算并确认Main版本。此脚本冻结0.21.0，只用于对应已记录批次，0.21.1及以后会拒绝启动。角色、测试群和全部原有门沿用；按每场历史最大单请求预留，可能少于6条。P34实际3条/419740 token，亲子场景未启动，不能视为通过。最后0.21.1的问题长度修复另有冻结草稿回归；完整结果见 `docs/evaluations/2026-10-18-search-and-validation-repair.md`。

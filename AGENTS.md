# AGENTS.md — 团队开发契约

本文件对所有贡献者生效，包括人类和 AI agent。违反本文件的 PR 不合并。
产品需求见 `docs/support-agent-产品需求.md`，技术架构见 `docs/技术架构设计.md`，本文件不重复其中的"为什么"，只规定"怎么做"。

---

## 1. 项目一句话

伦敦本地生活 Telegram 群里的供需撮合 Bot。Jev 判断，deepseek-flash 生成，OpenAI Agents SDK 跑循环，所有出站动作过门。**第一阶段不碰支付与履约。**

## 2. 技术栈与版本

| 项          | 选择                                                                                                                       | 备注                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 运行时      | Node ≥ 22.12，pnpm 11，ESM                                                                                                 | `.nvmrc` = 22                                                              |
| 语言        | TypeScript 5.9（typescript-eslint 尚不支持 7），`strict` 全开，`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess` 开 | 见 `tsconfig.base.json`，不得在子包放宽                                    |
| Agent       | `@openai/agents` 0.18.x                                                                                                    | 只在 `packages/agent` 直接 import                                          |
| 生成模型    | deepseek-flash，经 `OpenAIProvider({ baseURL, useResponses: false })`                                                      | 不用 Vercel AI SDK 适配器                                                  |
| 决策模型    | Jev（TypeSafe AI）`POST {JEV_BASE_URL}/decisions`，经 OpenRouter（`typesafe/jev-1.13`）                                    | 只在 `packages/jev` 直接调用；直连 api.typesafe.ai 需另一把 key（PoC V4）  |
| 渠道        | grammY                                                                                                                     | 只在 `packages/channel-telegram` 直接 import                               |
| 数据库      | Postgres 17 + Prisma 7（`prisma-client` 生成器 + `@prisma/adapter-pg`）                                                    | 只在 `packages/db` 直接 import                                             |
| 队列        | BullMQ + Redis 7                                                                                                           | 定义在 `packages/queue`，消费在 `apps/*`                                   |
| 校验        | zod 4                                                                                                                      | 所有跨边界数据（环境变量、job 载荷、工具参数、外部 API 响应）必须有 schema |
| 日志        | pino                                                                                                                       | 经 `@matchbot/shared` 的 `createLogger`                                    |
| 测试        | vitest 5                                                                                                                   | 见 §7                                                                      |
| Lint / 格式 | eslint 10 + typescript-eslint（type-checked）、prettier                                                                    | `pnpm check` 全绿才能提 PR                                                 |

升级任何"只在 X 直接 import"的库需要在 PR 里说明影响，升级 `@openai/agents` 额外需要清空待审 `run_states`（快照与 SDK 版本绑定）。

## 3. 架构约束

### 3.1 包与职责

```
apps/bot              grammY 进程：收 → 入队；消费出站表 → 发
apps/worker           BullMQ worker：inbound_message / resume_run / cron
apps/admin            Phase 2 Web 审批台（现为占位）
packages/shared       env、logger、通用工具。无业务语义
packages/domain       领域模型与状态机。纯 TS，禁止 IO
packages/db           Prisma schema、迁移、仓储。唯一能碰 Postgres 的包
packages/queue        队列名、job 载荷 schema、幂等 jobId
packages/jev          Jev 客户端、问题集、阈值、留痕
packages/gating       阶段开关、频控、黑名单、群策略。纯规则
packages/matcher      确定性撮合打分
packages/channel-telegram  Telegram ↔ InboundMessage / OutboundMessage
packages/approval     审批卡发布与决策回收
packages/agent        Agents SDK 组装：agent、tools、guardrails、session、provider、tracing
packages/eval         回放与指标
```

### 3.2 依赖方向（`scripts/check-deps.mjs` 强制，`pnpm lint` 会跑）

- `shared ← domain ← db ← { queue, jev, gating, matcher, channel-telegram } ← { approval, agent } ← eval ← apps`；`websearch` 只依赖 `shared`，由 `agent` 使用（P14）
- `packages/*` 永远不依赖 `apps/*`。
- `domain` 不依赖任何有 IO 的包，也不依赖 `db`。
- `gating` 和 `matcher` **禁止**依赖 `jev` 或 `@openai/agents`：它们必须是确定性的，可以被 Jev 的结果驱动，但自己不调模型。
- `agent` 不依赖 `approval`：agent 只产出 `run_states` 快照，由 worker 把它交给 approval。
- 外部 SDK 只允许在指定包直接 import：`@openai/agents` → agent，`grammy` → channel-telegram 与 `apps/bot`（后者只创建 `Bot` 实例并注册 middleware，发送一律经 `createTelegramSender`），`@prisma/client` → db，`bullmq/ioredis` → queue 与 apps。其他包通过这些包暴露的接口使用。

新增包时同步更新 `check-deps.mjs` 的矩阵、根 `tsconfig.json` 的 references 和本节列表，三处缺一不可。

### 3.3 硬性规则

1. **模型调用只发生在两个地方**：`packages/jev`（Jev）和 `packages/agent`（deepseek-flash）。其他任何包出现 `fetch('https://api.deepseek…')`、`fetch('https://api.typesafe…')` 或 `new OpenAI(` 都是违规。
2. **每一次模型调用、每一次门的决定都必须写 `decision_traces`**。没有 trace 的判断视为不存在。trace 里记 `latency_ms`、`cost_micro`、`phase`。
3. **所有出站动作都是 `tool()`，所有出站工具都有 `needsApproval`**，且实现为 `packages/gating` 的阶段判断加 `packages/jev` 的出站评估加频控。任何直接调用 `bot.api.sendMessage` 绕过出站表的代码都是违规；出站只允许写 `outbound_messages`，由 `apps/bot` 消费。 唯一例外是表情反应（`react`，`kind=reaction`）：它不带内容、不会说错话，Phase 1 起不送审、不调 Jev、不占频控，但 Phase 0 仍只记录、仍写 trace。
4. **Phase 0 不发任何消息**。出站工具在 Phase 0 必须把状态停在 `dry_run`。这条在 `packages/gating` 里实现一次，工具里不得各自判断。
5. **Jev 不可用时的降级方向固定**：入站按"不进 agent"，出站按"不自动发"——有人值守时送审，无人值守（`OUTBOUND_UNSURE_ACTION=drop`，当前默认）时直接不发。永远不因为 Jev 挂了而自动发消息。
6. **`RunState` 快照消费必须原子**：`run_states.status` 由 `pending` 到 `consumed` 用条件更新（`UPDATE … WHERE status = 'pending'`），更新行数为 0 即放弃恢复。快照只从服务端存储反序列化，永远不接受客户端传来的快照。
7. **Session 粒度是用户**，不是群，不是消息。群上下文与用户画像通过 instructions 注入，不塞进 session。
8. **`process.env` 只在 `packages/shared` 的 `loadEnv()` 里读一次**，其他地方通过传入的 `Env` 对象取值。
9. **禁止 Agents SDK 默认 tracing 导出**。`packages/agent` 初始化时必须禁用默认 exporter 并注册写 `decision_traces` 的 processor。
10. **不处理支付、不做担保、不代收款**，代码里不得出现相关分支。招聘品类只打标签，不进撮合。2026-10-10 用户授权：二手交易、租房、帮带、搭子需求可经A2H公开 API 做只读搜索与推荐，不代发帖、不联系贴主、不经手交易。
    2026-10-12 用户授权的请求状态补充：精准匹配失败或推荐被拒绝时，应给解释、替代搜索方向或必要追问。仅代码固定、无实体/价格/日期/联系人/链接断言的reply_request_status可在Jev可用时按状态规则放行，Jev语义分仍留痕；不得用自由文本伪装成状态，不得重写原推荐绕过拒绝。仍为tool/needsApproval/出站表路径，Phase0不发，Phase1审批，Jev不可用不自动发，每个请求最多一条状态。

11. **PII 不进日志**。pino 的 redact 已配 `text`、`phone`，新增含个人信息的字段必须加到 redact 列表。

## 4. 命名契约

### 4.1 数据库（Prisma）

| 对象        | 规则                                                    | 例                                        |
| ----------- | ------------------------------------------------------- | ----------------------------------------- |
| model       | PascalCase 单数                                         | `Demand`、`OutboundMessage`               |
| 表          | snake_case 复数，用 `@@map`                             | `demands`、`outbound_messages`            |
| 字段        | camelCase                                               | `fromPostcode`                            |
| 列          | snake_case，用 `@map`                                   | `from_postcode`                           |
| 主键        | `id String @id @default(cuid())`                        | 不用自增 int 暴露给外部                   |
| 外键        | `xxxId`                                                 | `demandId`、`supplierId`                  |
| 外部系统 id | `externalId` 加渠道字段，字符串存                       | Telegram 的 int64 用 string，避免精度问题 |
| 时间        | `xxxAt`，`@db.Timestamptz`，一律 UTC                    | `receivedAt`、`sentAt`                    |
| 布尔        | `is` / `has` 前缀                                       | `isMoveEvent`、`isSameDay`                |
| 金额        | 整数 pence，字段名带 `Pence`                            | `budgetPence`                             |
| 成本        | 整数美元微分，字段名带 `Micro`                          | `costMicro`                               |
| 枚举        | Prisma enum，值 snake_case；TS 侧用 `as const` 数组镜像 | `man_and_van`                             |
| JSON 列     | 只用于结构不稳定的数据，且在 `domain` 里有 zod schema   | `User.profile`                            |

### 4.2 TypeScript

- 文件名 kebab-case，一个文件一个主概念：`run-state-store.ts`。测试放在包内 `tests/` 目录，路径镜像 `src`，文件名同名加 `.test.ts`（`src/postcode.ts` → `tests/postcode.test.ts`）；`src` 下不放测试。
- 类型与接口 PascalCase，不加 `I` 前缀；类型别名优先于 interface，除非需要 declaration merging。
- 常量集合用 `as const` 数组加派生联合类型（见 `packages/domain/src/demand.ts`），不用 TS `enum`。
- 函数动词开头：`normalizePostcode`、`findSuppliers`、`upsertDemand`。返回 Promise 的函数不加 `Async` 后缀。
- 布尔变量与函数 `is` / `has` / `can` / `should` 前缀。
- 错误类以 `Error` 结尾并设置 `name`，携带结构化字段（见 `IllegalTransitionError`）。
- 导出用具名导出，`index.ts` 只做 re-export，不写逻辑。
- import 路径带 `.js` 后缀（NodeNext）。类型 import 用 `import type`。

### 4.3 领域术语（中英对照，代码里只用英文）

| 中文     | 代码            | 说明                                           |
| -------- | --------------- | ---------------------------------------------- |
| 需求     | `Demand`        | 群成员表达的服务需求                           |
| 群内供给 | `Supply`        | 群成员表达的供给（"我有 van"）                 |
| 供应商   | `Supplier`      | 抓取或联系的商家，`pool` 分 A / B              |
| 撮合     | `Match`         | 一条需求与一个供给方的配对                     |
| lead     | `Lead`          | 推送给供应商的结构化询价及其回访               |
| 阶段     | `phase`         | 0 shadow / 1 review / 2 auto，用 `PHASES` 常量 |
| 门       | gate            | Pre-gate / 出站门；代码里 `gating`             |
| 留痕     | `DecisionTrace` | 所有判断的记录                                 |
| 搬家事件 | `isMoveEvent`   | 找房 / 退租 / 买大件暗示的后续需求             |

### 4.4 Jev 问题集

- question id 用 snake_case 动词或形容词短语：`is_demand`、`worth_replying`、`category`。
- choice 的 option key 与 `DemandCategory` 等领域枚举**完全一致**，不做二次映射。
- 阈值常量放 `packages/gating` 的配置表，命名 `T_<question>_<action>`，如 `T_IS_DEMAND_ENTER`。禁止在业务代码里写裸数字阈值。

### 4.5 队列与工具

- 队列名 snake_case 名词：`inbound_message`、`resume_run`。
- 幂等 jobId 用 `packages/queue` 的构造函数，格式 `channel:chatId:messageId`。
- Agent tool 名 snake_case 动宾：`upsert_demand`、`reply_in_group`。出站类工具的 description 第一句必须说明它会对外发消息。

## 5. 代码规范

- 一个函数做一件事，超过 40 行考虑拆分；超过 3 个参数用对象参数。
- 不写 `any`；确实未知用 `unknown` 并在边界用 zod 收窄。
- 不吞错误。`catch` 里要么重新抛出带上下文的错误，要么记录并返回明确的失败值。Jev 与模型调用的失败必须映射到 §3.3 第 5 条的降级行为。
- 不用 `console.*`，用 logger。
- 时间只用 `Date` 加 UTC，格式化只在出站文案生成时按用户时区处理；不引入 moment。
- 对外部 API 的响应先 zod parse 再用，包括 Jev、DeepSeek、Telegram。
- 注释解释"为什么"，不复述代码。涉及产品取舍的注释引用 PRD 或架构文档的章节号。
- 提交信息用英文 Conventional Commits：`feat(agent): add reply_in_group tool`；scope 用包名。

## 6. 数据与隐私

- `messages.text` 保留 30 天，之后置空只留 `text_hash` 与结构化字段。实现为 cron 任务，不靠人记。
- 群成员联系方式只在用户明确请求转达时写入 `leads`。
- `run_states.snapshot` 落库前加密，7 天后标 `expired`。
- Jev 请求带 Zero Data Retention 选项。
- 任何新增的个人数据字段，PR 里必须写明保留期与删除路径。

## 7. 测试要求

| 层                  | 要求                                                                                                                                                   | 工具                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `domain`            | 状态机与纯函数 100% 分支覆盖；不允许 mock                                                                                                              | vitest                           |
| `shared`            | 工具函数有单测（如 `postcode.test.ts`）                                                                                                                | vitest                           |
| `jev`               | 客户端用录制的响应 fixture（`tests/fixtures/`）测；CI 里**不得**真实调用 Jev；降级路径（超时、429、格式错误）必须有测试                                | vitest + fixture                 |
| `gating`、`matcher` | 表驱动测试；每条规则至少一个正例一个反例                                                                                                               | vitest                           |
| `agent`             | 用 stub `ModelProvider` 测工具编排与 `needsApproval` 分支；不调真实模型。每个出站工具必须有 Phase 0 dry-run、Phase 1 送审、Phase 2 自动 / 送审四条用例 | vitest                           |
| `db`                | 仓储层用真实 Postgres（`docker compose up`）跑集成测试，每个测试用事务回滚                                                                             | vitest，`tests/integration/`     |
| `channel-telegram`  | 规范化函数用真实 Update 样本测；发送只测到写 `outbound_messages`                                                                                       | vitest                           |
| 端到端              | 一条群消息 → dry-run 拟发内容 → 审批 → 恢复 → 出站表，作为 `apps/worker` 的 smoke test                                                                 | vitest，`apps/worker/tests/e2e/` |
| 评测                | Phase 0 结束前建 ≥ 50 条标注样本放 `packages/eval/fixtures`，`pnpm eval` 输出 precision 与沉默正确率；改 prompt、改阈值、升 SDK 必须附评测结果         | `packages/eval`                  |

规则：

- 新功能先写失败的测试再写实现。修 bug 先写复现测试。
- 测试不依赖执行顺序，不共享可变状态。
- `pnpm check`（typecheck + lint + format + test）全绿才能提 PR；集成与 e2e 在 CI 的 service container 里跑。
- 模型输出不可断言逐字相等；断言结构（调了哪个工具、参数 schema、状态转移）。
- 不得为了让测试通过而放宽 zod schema 或 tsconfig。

## 8. 工作流

0. **领任务**：从 `plan/README.md` 看板领工作包，按对应 `plan/P*.md` 执行，跨包签名以 `plan/interfaces.md` 为准；开工、完成、阻塞都要更新看板。**多个 agent 并行时例外**：看板由协调者统一更新，见 §9.2。
1. **写代码前**：确认对应模块在 `docs/技术架构设计.md` 里的职责；涉及 §11 PoC 未验证的接口，先在 `scripts/poc/` 跑通并登记结论。
2. **改 schema**：改 `schema.prisma` → `pnpm db:migrate` 生成迁移 → 迁移文件进 PR。禁止 `db push` 到共享环境。
3. **改 Jev 问题集或阈值**：附评测结果；阈值改动进 `gating` 配置表而不是代码。
4. **改 agent instructions 或工具描述**：`AGENT_VERSION` 递增；附评测结果；待审快照按 §2 处理。
5. **PR 描述**必须包含：改了哪个包、是否新增出站路径、是否新增个人数据字段、评测结果（如适用）。
6. **禁止**：直接在 `main` 提交；跳过 `pnpm check`；在业务包里写一次性脚本（放 `scripts/`）。

## 9. AI agent 附加约定

- 先读本文件与 `docs/技术架构设计.md`，再动代码。不确定的接口去 `docs/reference/` 查，仍不确定就在 `scripts/poc/` 验证，不要凭记忆写 SDK 调用。
- 一次 PR 只改一个包，除非是跨包的契约变更（并在描述里说明）。
- 不新增依赖，除非本文件 §2 已列或 PR 里说明理由。
- 不改 `tsconfig.base.json`、`eslint.config.js`、`scripts/check-deps.mjs` 以绕过检查。
- 完成后运行 `pnpm check` 并把输出贴在 PR 里；失败的测试如实报告，不得删除或跳过。

### 9.1 计划文件与实际不符时

计划文件（`plan/P*.md`）里的代码是**起点不是终点**，写在里面的 SDK 签名可能是拍脑袋写的。

- 与 `plan/interfaces.md` 冲突，以 `interfaces.md` 为准。
- 与 SDK / 库的实际行为冲突，以 `node_modules` 里的**真实类型定义**为准——不要凭记忆写，也不要照抄计划里的示例。
- 与 `plan/P0-poc.md` 的 PoC 结论冲突，以 PoC 结论为准（那是实测的）。
- 三者都改了以后，把偏差回写进自己工作包的「完成记录」，写清**原计划是什么、实际是什么、为什么**。下一个 agent 靠这个避免重踩。

### 9.2 并行执行约定

多个 agent 同时领不同工作包时，以下规则防止互相覆盖。**协调者**指分发任务的那个 agent 或人。

**文件归属**

- 只改自己工作包的目录（`packages/<pkg>/` 或 `apps/<app>/`）和自己的 `plan/P<N>-*.md`。
- **不要改 `plan/README.md` 看板**——并行改它必然冲突，由协调者统一更新。开工/完成/阻塞通过交付报告告诉协调者。
- 不改 `package.json`、`pnpm-lock.yaml`，不跑 `pnpm add`：依赖由协调者在开工前一次装齐。缺依赖就停下来报告，不要自己装。
- 跨包改动（含 `interfaces.md`、`AGENTS.md`、`scripts/check-deps.mjs`）一律先报协调者，不得自行修改——这类冲突事后极难发现。

**工作树隔离**

- 并行的 agent **不得共用同一个工作树**。要么全部只在主工作树里改文件、完全不碰分支（提交交给协调者），要么每人一个 `git worktree`。
- 尤其**不得在共用的工作树里 `git checkout` / `git switch`**：切分支会改变所有人看到的文件，另一个 agent 的提交会落到你的分支上。这已经发生过一次——P9 的提交落进了 P10 的分支，事后只能用 plumbing 重建。

**提交**

- 并行期间不跑任何 `git` 命令，提交由协调者串行完成；`git` 的索引锁不支持并发写，且分支操作会互相干扰（见上）。
- 在 worktree 或分支上完成的工作，**必须合并回 `main` 才算完成**。看板状态以 `main` 上的实际代码为准，不以分支上的自述为准。
- 协调者收尾时**逐项**查：`git status -uall`（未提交的工作）、`git worktree list`、`git branch --no-merged main`、`git stash list`。只看 `main` 的历史四种情况都发现不了。判断分支是否真有独有内容用两点 `git diff main <branch>`，不要用三点——三点比的是分叉点，分支落后于 `main` 时会把「缺少 main 的新代码」误报成差异。

**执行**

- 环境变量用 `set -a && . ./.env && set +a` 在同一条命令里加载；永远不要打印 key 或 token（报错信息里的也要先脱敏）。
- 所有网络调用和长轮询都要有超时上界，不得无限等待。
- 同一个操作失败 2–3 次就停下来报告，说明试了什么、错在哪，不要反复重试或另辟蹊径绕过。
- 如实报告。**未通过、阻塞、"只做完一半"都是有价值的结论**；编造通过的指标会让后续工作包建立在假前提上。数字必须来自真实跑过的命令。

## P40 渠道插件契约（2026-10-18 用户授权）

新增 packages/runtime（原 worker 的业务装配/处理流程，依赖 agent、approval、queue、websearch 及基础包）；packages/channels（公共持久入站、投递和分发，依赖 shared/domain/db/queue/gating/approval）；packages/channel-feishu（飞书官方 SDK 独占，依赖 shared/domain/db）。apps 只负责装配。DSH 插件复用以上接口，不得让同一消息同时进入两个 agent 循环。

多账号模式的模型 Session 按 installation/channel/account/tenant/chat/thread/owner binding 隔离，替代 §3.3.7 的全局用户粒度；旧单账号 Telegram 数据保留 legacy scope。业务任务继续绑定用户且必须校验 channel/chat/thread。模型不可选择发送账号。渠道 SDK 不得出现在业务包。

packages/host 负责组合 runtime、channels 和各渠道连接，拥有 DB/队列/连接生命周期；DSH 插件和独立入口复用 host。同一进程只允许一个 host（Agents SDK 的 provider/tracing 是进程全局状态）。插件部署使用独立数据库和 Redis 队列，不与 legacy bot/worker 同时运行。
packages/dsh-matchbot 仅依赖 host/shared 和 DSH 的 Cordis 生命周期接口；不另建 agent 循环、不把渠道消息注入 DSH 默认交互 session。

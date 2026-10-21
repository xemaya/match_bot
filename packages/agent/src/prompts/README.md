# Prompt architecture v2（P48 / P49）

生产入口仍是 `createMatchAgent`，不增加 agent 数量、模型调用或外部权限。v1（P37）只管理了系统指令；v2 把模型实际读到的五层文本全部归到一处，按**读者**组织，并用 `pnpm prompt:audit` 把每阶段的全文 dump 到 `docs/prompts/` 供人阅读。

```text
packages/agent/prompts/voice/        写给群友读的那一层（中文散文，运行时整段读入）
  soul.md                            气质：怎么待人
  chat-line.md                       群聊发言规范：那句话和证据卡各写什么、多长

packages/agent/src/prompts/
  voice.ts                           读入上面两个文件；为空即启动失败
  policy/rules.ts                    TRUST / FACT / DELIVERY：只留模型真要判断的，代码已强制的不写
  policy/scenes.ts                   场景工作流 + 工具白名单 + 路由
  stages/index.ts                    阶段矩阵：每阶段注入哪些层；composeStagePrompt 固定顺序
  stages/{triage,plan,research,write,status,legacy}.ts   各阶段协议文本
  tools/<tool>.ts                    每个生产工具的 description、参数说明、拒稿反馈
  tools/index.ts                     审计索引 TOOL_PROMPTS
  runtime-context.ts                 每轮刷新的 user-role JSON 数据包
  tool-contract.ts                   实际启用的工具与指令引用交叉校验
```

## 五层与归属

| 层             | 读者     | 位置                 | 规则                                                                 |
| -------------- | -------- | -------------------- | -------------------------------------------------------------------- |
| voice          | 群友     | `prompts/voice/*.md` | 中文；正面描述行为；长度规则**只**在 `chat-line.md` 出现一次         |
| policy         | 模型判断 | `policy/rules.ts`    | 权限、审批、频控、引用校验由代码强制，不写进规则                     |
| scene          | 模型流程 | `policy/scenes.ts`   | 新业务加场景，不往全局规则里追加失败案例                             |
| stage protocol | 模型流程 | `stages/*.ts`        | 一个阶段一个文件；注入哪些层看 `stages/index.ts`，不在文件里自行拼装 |
| tool text      | 模型     | `tools/<tool>.ts`    | description / 参数 describe / 拒稿反馈都从这里取；反馈先写"改成什么" |

## 阶段矩阵（`stages/index.ts`）

| 阶段     | 层                                  | 说明                                              |
| -------- | ----------------------------------- | ------------------------------------------------- |
| triage   | trust                               | 一次小调用判断这条群消息该不该管                  |
| plan     | trust                               | 绑定任务，不写给人看                              |
| research | trust, fact, delivery, scene, voice | 可以直接回复，所以带 voice                        |
| write    | trust, fact, delivery, voice        | 只剩 `reply_to_request`，读证据包写那句话和证据卡 |
| status   | （无）                              | 代码生成的固定状态                                |
| legacy   | trust, fact, delivery, voice        | 未启用 answerRequests 的兼容调用者                |

顺序固定：policy → 阶段协议（含场景）→ voice。voice 永远在最后，离生成最近。

## 两个产物

`reply_to_request` 的 `text` 是群里那句话（群 ≤3 行 150 字，私聊 ≤400 字，超限退回并说明删什么）。多数回复只有这一句。`details` 是例外（P49）：只在有第二个选项、来源对推荐那家说法不一致、或动手前必须核实的那一条时才写，≤300 字，超限退回。代码把 `details`、市场候选链接行和来源链接行渲染成证据卡（`@matchbot/domain` 的 `renderEvidenceCard`），卡从一行不可见分隔符（U+2063）开始，没有可见标题；来源是无标签、无编号的链接行，标题经过清洗。channel-telegram 从分隔行起折叠为 `expandable_blockquote`，分隔行不发出，卡内整行链接渲染为 `text_link`；旧的"【详情】"与"来源："行仍能识别。群记录只把 Match Bot 自己的那句话喂回模型，不喂卡。所有事实校验覆盖 `text` + `details`。

## 运行时数据包

与 v1 相同：SDK `callModelInputFilter` 每次生成前注入 role=user 的 JSON，用户原文独立保留，不持久化。v2 去掉了 `receipts` 计数器和内部布尔（`evidenceValidationExhausted`、`outboundBlocked`），改为面向任务的 `research` 摘要（搜了几次、找到几个来源、读了几页、来源故障）；门的状态由代码强制，不进模型包。

## 审计

```sh
pnpm prompt:audit                      # 生成 docs/prompts/*.md，并检查字符预算
pnpm exec vitest run packages/agent/tests/prompt-layers.test.ts packages/agent/tests/prompt-architecture.test.ts packages/agent/tests/prompt-input.test.ts
```

`docs/prompts/README.md` 是阶段矩阵、文件索引和结构审计表；每个 `<stage>-<scene>.md` 是该阶段完整系统指令加注册工具的 description 与参数说明；`tools.md` 是全部拒稿反馈；`runtime-packet.md` 是数据包样例。改了任何提示词后重新生成并一起提交。字符预算沿用 P37：规划 6500、执行 8000、收尾 5500。

`prompt-layers.test.ts` 锁定：triage / plan / status 不含 voice；写作阶段 voice 在末尾；长度规则只在 chat-line；拒稿反馈不以 Do not / Never 开头；数据包无 receipts；证据卡渲染与拆分。

## 不在本架构里

legacy 工具（`upsert_*`、`notify_user`、`push_lead`、`web_search`、`reply_with_*`、xhs legacy）的文本仍在各自文件里，不是生产 answerRequests 路径。`market-strategy.ts`、`market-choice-presentation.ts` 等渲染层的中文标签（"推荐理由："、"待确认："）是代码产物，不是提示词。

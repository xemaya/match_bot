# P52 研究员子 agent 与单一出口

状态：待评审（2026-10-22 起草）。负责人 claude。依赖：P51（0.35.1，main `3404a98`）、P50 回路。范围 `packages/agent`（阶段装配、研究与收尾的工具集、运行时数据包）、`packages/eval`（新增 r7 轮次与研究阶段指标）、`scripts/local/humanness-record.mts`。不改 AGENTS.md 任何契约。

总体方案见 [P52–P55 架构路线](#总体路线p52p55)。本包是第一步：不引入"主 agent"，只把研究和说话分开，并让每个阶段成为显式定义。

## 为什么

2026-10-22 架构评审，数据取第七轮联合实测的实发部分（2026-10-22 00:00–01:59 与 07:00–14:59 UTC，0.35.0 前后，sent 行；06:00 那一小时是 `humanness:record r3` 的 dry_run 录制，单列）：

| 现象 | 实发（33 条进 agent，31 条研究，27 条出站） | 录制 r3-rec（9 条） | 根因 |
| --- | --- | --- | --- |
| 研究循环撞预算 | 31 次研究里 10 次 `PromptContextBudgetError` | 4/9 | 每轮重建运行时数据包（证据全量）+ 工具输出在 SDK 历史里累积；`EXECUTION_RUN_INPUT_CHARS` 10 万字累计上限 |
| 兜底路径成了常态 | 18 次收尾里 12 次 `bounded_finalization`，`planned_delivery` 6 次 | 4 vs 1 | 同上：研究没走到 `record_task_progress(deliver)` 就被预算打断 |
| 每条消息贵且慢 | matchAgent 调用中位数 6 次、输入 5.4 万 token；进 agent 到完成中位数 46 s，最长 139 s | 6 次、3.5 万 | 研究循环上下文无隔离 |
| 三个说话出口 | 27 条出站里 9 条由研究阶段直接写（没进收尾），18 条由收尾写；另有 `respondRequestStatus` 代码状态句 | 1 / 5 | 研究阶段 `STAGE_MATRIX.research` 带 voice，工具集含 `reply_to_request`/`react`/`reply_in_group` 等（`prompts/tool-contract.ts:10`） |
| 阶段只是开关 | `createMatchAgent` 用 `taskPlanningOnly / requestStatusOnly / finalAnswerOnly / answerRequests / taskRequests` 拼出各阶段；交棒逻辑在 `toolUseBehavior` 里；`run.ts` 768 行多为兜底 | 阶段从未成为一等对象 |

业界（OpenClaw sub-agents、Hermes `delegate_task`、Claude Code subagents、Anthropic 多 agent 研究系统、Cognition 2026-04）一致的做法：干活的子 agent 不带人设、没有对外发言工具、独立上下文、只交回精简结论或证据引用；只有一个角色对人说话。

## 改法

1. **阶段成为显式定义。** 新建 `packages/agent/src/stages/`：`planner.ts`、`researcher.ts`、`writer.ts`、`status.ts`，每个文件导出 `create<Stage>Agent(deps, ctx)`，各自声明 instructions、工具集、`toolUseBehavior`、`modelSettings`、输入过滤器阶段名。`createMatchAgent` 只剩 legacy（`answerRequests=false`）兼容调用者使用，`run.ts` / `task-preparation.ts` 改调新工厂。`STAGE_MATRIX` 仍是提示词层的唯一声明，改为与阶段文件一一对应。
2. **研究员不说话。** 研究员的 `STAGE_MATRIX` 层去掉 `voice` 与 `delivery`；工具集去掉一切出站工具（`reply_to_request`、`react`、`reply_in_group`、`ask_clarification`、`reply_with_xhs_notes`、`do_nothing`）。研究员的终点改为一个新的非出站工具 `finish_research`：
   - `outcome`: `deliver`（有可交付的完整或部分答案）/ `ask_user`（缺一个只有提问者知道的条件，带 `missingField`）/ `no_answer`（查过了没有可用的）/ `skip`（群友已经答了，或这条其实不是在问）。
   - `refs`: 交给写手的证据引用（m/k/x 编号，服务端校验存在）。
   - `note`: ≤200 字，英文或中文均可，只给写手看的研究备忘（"两家说法不一致：A 说含 bill，B 没写"），不进群。
   与任务账本的关系：`record_task_progress` 仍是账本唯一写入口，研究员可多次调用它记录检查与 `nextStep=research`。为兼容现有账本语义（`deliverySourceRefs`、`taskProgressVersion` 都在它里面设置），`record_task_progress` 的 `nextStep=deliver / ask_user` 在 `toolUseBehavior` 里视为同名的 `finish_research` outcome，不要求模型再调一次；`finish_research` 负责其余情况（`no_answer`、`skip`、无任务的研究）。也就是说终点有两个入口、一个语义，测试按 outcome 断言，不按工具名。
3. **写手是唯一作者。** 收尾阶段（writer）按研究结论和场景拿到对应的一个回复工具：信息 / 市场 → `reply_to_request`；目录场景 → `reply_in_group`；只有小红书笔记 → `reply_with_xhs_notes`；外加 `react`、`do_nothing`。写手读证据简报（现有 `buildDeliveryPacket`，补上 xhs 与目录两种证据）+ 研究备忘 + groupConversation + voice。`canHandOffToDelivery` 的 xhs 例外删除。
4. **开不开口从提示词搬到代码。** 研究员给 `skip` → 不进写手，记 trace `research_outcome=skip`；给 `no_answer` → 只有 `addressedToBot` 或私聊才进写手写一句短的"没找到"，否则沉默（现在这条规则写在 research 提示词里，`prompts/stages/research.ts` 倒数第二条）。`ask_user` → 写手写追问。
   不需要研究的情况不再经过研究员，由代码直接路由到写手：`taskUpdate` 为 acknowledged / completed / cancelled 或场景为 unsupported → 写手只有 `react` / `do_nothing`；ambiguous / unbound → 写手只写澄清（现在这两类也挂在研究阶段的提示词分支里，`prompts/stages/research.ts` 开头三个 if）。
   保留的第二个出口：`respondRequestStatus` 的代码固定状态句（AGENTS.md §3.3 第 10 条），它不经模型、不带人设，本包不动。
5. **研究员上下文隔离。** 研究员每轮的模型输入只放"工作视图"：任务、已用查询、候选的编号 + 一行摘要；完整证据留在 `MatchContext`，研究员要细看用 `read_task_sources` / `market_enrich` / `read_web_page` 按编号取。工具输出给模型的部分改为编号 + 摘要（全文写进 ctx，与现在 `knowledgeSources`、`marketListings` 一致）。目标是去掉"每轮重发全量证据"。先做 T2 的测量再定截断口径，不预设数字。
6. **预算撞线不再是异常路径。** 研究员撞每轮或累计上限时，视为 `finish_research(deliver, 已有 refs)`，正常进入写手，trace 记 `research_budget_stop`；`PromptContextBudgetError` 只保留给数据包本身超 64000 字的情况。

不在本包：主 agent、群视角、新发言方式（P53）；成员记忆（P54）；先回一句（P55）；删除 legacy `answerRequests=false` 路径与其测试（另开清理包，避免本包同时改 12 个测试文件的前提）。

## 任务清单

- [x] T1 基线（2026-10-22，结果见文末"基线"）：`pnpm humanness export --since … --until …` 导出第七轮实发回复为 `r7`，`metrics` + `judge`；从 decision_traces 统计 r3-rec 与 r7 两轮的研究指标（见验收 1）写进本文件，作为基线表。不花生成 token（判官走 OPENAIROUTER）。
- [x] T2 测量：在执行阶段 trace 里按轮记录 `packetChars`（运行时数据包）、`historyChars`（SDK 历史）、`toolOutputChars`（本轮工具输出），用 r3 的一个市场案例 `humanness:record --only` 跑一次，确认预算是被哪一块吃掉的。结论回写本文件"改法 5"。
- [x] T3 `stages/` 四个工厂，`run.ts`、`task-preparation.ts` 改调；行为不变（这一步所有既有测试应原样通过，`saveExecutionCheckpoint` 的逐步检查点照旧）。单独提交。
- [x] T4 研究员：去 voice / delivery 层、去出站工具、新增 `finish_research`（zod 参数、refs 服务端校验、trace）；`toolUseBehavior` 以 `finish_research` 为唯一终点；预算撞线转 `deliver`。
- [x] T5 写手：按场景挂一个回复工具；证据简报补 xhs 与目录证据（`find_suppliers` 的结果现在不进 ctx，只有 `supplierSearchEmpty`；要新增 `ctx.catalogueSuppliers` 交给写手，`reply_in_group` 仍按库内 id 校验）；研究备忘进数据包；`skip` / `no_answer` / `ask_user` 与不需研究的情况的代码分流。
- [x] T6 研究员工作视图与工具输出摘要（按 T2 结论）。
- [x] T7 测试：stub `ModelProvider` 覆盖——研究员调不到任何出站工具（工具集断言）；四种 outcome 的分流；预算撞线进入写手；每个出站工具 Phase 0 / 1 / 2 四条用例仍在写手阶段成立。`pnpm prompt:audit` 预算内并重生成 `docs/prompts/`。
- [ ] T8 回路：`humanness:record r3 --as r3-p52` 与 `humanness:record r7 --as r7-p52 --only <挑 12 条>`（真实模型与搜索，见额度），`metrics` / `judge` / `compare`；`replay r3-p52 --n 3` 看写手；记录进本文件。
- [ ] T9 `docs/技术架构设计.md` §4.2 改写为阶段表（谁读什么层、有哪些工具、终点是什么）；AGENT_VERSION 0.36.0；清空待审 `run_states`（工具集变了，旧快照恢复会失败）；`pnpm eval`；`pnpm build && pnpm check`；完成记录。

## 验收标准

1. **研究指标**（r3 全部 9 问 + r7 选出的 12 问，与 T1 基线同口径）：
   - `PromptContextBudgetError` ≤ 1 次（基线实发 10/31、录制 4/9）；
   - 进入写手的回复中，研究员主动结束（`finish_research` 或 `record_task_progress` 的 deliver / ask_user，不含撞线与超时转交）≥ 80%（基线 `planned_delivery` 实发 6/18）；
   - 每条进 agent 的消息 matchAgent 输入 token 中位数 ≤ 同批问题基线 × 0.7（录制模式下与录制基线比：r3-rec 3.5 万）；
   - 进 agent 到完成的耗时中位数不高于同批基线 × 1.1。
2. **单一出口（结构）**：研究员阶段的工具集里没有任何出站工具（测试断言）；r3-p52 / r7-p52 的每条 outbound 都有一条 `delivery_stage` trace。
3. **人感不退步**：`replay r3-p52 --n 3` 的 11 项可数指标仍全部达标；判官均分 ≥ 3.7（try6 3.94，回放噪声约 ±0.2）。
4. **该沉默的沉默**：r7 中 triage 放行但最终没有回复的消息，在 r7-p52 里仍不回复（逐条列出差异并说明）。
5. **安全契约不变**：`needsApproval`、出站门、Phase 0 dry-run、Jev 降级方向、事实门（`unsupportedNumbers`、`completeFit`、冲突、`unsupportedFeature` 等）全部仍在写手阶段生效；`pnpm eval` precision / recall / silenceCorrect 不低于 P51；`pnpm check` 全绿（db 集成 3 个基线失败除外）。

## 额度

T2 单案例约 4 万 token；T8 两次录制约 21 问 × 4–6 万 ≈ 100 万生成 token，加回放 3 × 约 14 万。总计预计 ≤ 150 万，开跑前向用户报数并取得批准。判官走 OPENAIROUTER，不计生成额度。

## 风险

- **研究员 `skip` 判断不准**：原来研究员与说话在同一次思考里，现在拆开后研究员可能更倾向于 `deliver`。验收 4 专门盯这一点；不行就让 `skip` 只能由 triage 的 `handledByMembers` 触发，研究员只给 `deliver / ask_user / no_answer`。
- **写手拿到的信息变少**：写手原来在兜底路径里也只读证据简报，所以大部分回复本来就是这样产生的（23/33）；研究备忘是新增的补偿。
- **humanness 冻结案例格式**：写手的数据包多了研究备忘字段，`replay` 读旧案例要兼容缺字段。

## 总体路线（P52–P55）

| 包 | 做什么 | 契约变更 | 依赖 |
| --- | --- | --- | --- |
| P52 | 研究员子 agent、单一出口、阶段显式化 | 无 | P51 |
| [P53](./P53-group-main-agent.md) | 主 agent「群里的 A2H」：群视角决定说不说、怎么说；研究员作为 `asTool`；新发言方式（接半句、点名群友） | 出站可 @ 非提问者（新出站形态）；群内说话按群串行 | P52 |
| [P54](./P54-group-memory.md) | 群记忆：成员公开备注、A2H 自己在群里的线；后台整理，不在热路径 | AGENTS.md §6 新增个人数据字段 | P53 |
| [P55](./P55-ack-then-research.md) | 阶段 A：直接提问先点 👀；阶段 B：后台研究、查完推回 | 阶段 B 改 AGENTS.md §3.3 第 10 条"每个请求最多一条状态" | A：P52；B：P53 |

顺序：P52 → P53（P55 阶段 A 可与 P53 并行）→ P54、P55 阶段 B。只有 P52 不需要用户拍板；P53–P55 各自列了 D 项，拍板前不开工。

## 基线（T1，2026-10-22）

`r7` = 第七轮实发 07:00–15:00 UTC 的 17 条回复（`pnpm humanness export --since 2026-10-22T07:00:00Z --until 2026-10-22T15:00:00Z --name r7`），判官 gpt-6.1-sol。

| 轮 | 来源 | 长度中位数 | 可数指标达标 | 带卡 | 链接最多 | 判官均分 | 盲判 | 主要扣分 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| p51-try6 | 回放 r3-rec ×3（收尾阶段） | 58.5 | 11/11 | 6/18 | 2 | 3.94 | 1.0，bot 87 | 群里喊一声、复述帖子 |
| r7 | 实发 | 58 | 5/11 | 8/17 | 4 | 3.41 | 0.971，bot 75 | 套路句式 4、汇报检索 3、没接情绪 2、卡不该出现 2 |

r7 没达标的项：超过 100 字 4 条、£ 2、检索汇报词 1、语气词 6/17、带卡 8、链接最多 4。

读法：实发比回放低半分多。一部分是版本（第七轮跑的是 0.35.0 前后的工作树，P51 收尾的 0.35.1 改动不在里面），一部分是回放只重跑收尾阶段——实发里 9/27 条出站是研究阶段直接写的，回放覆盖不到。这正是本包"单一出口"要消除的差别：之后回放测到的写手就是实发唯一的作者。

研究指标基线见"为什么"一节的表（实发与录制分列）。

## T2 测量（2026-10-22）

`execution_input` trace（每轮数据包 / 历史 / 工具输出字符），三个 r3 案例各录一次（`humanness:record r3 --only`，约 18 万生成 token）：

| 案例 | 场景 | 轮 | 数据包（每轮） | 历史（每轮） | 其中工具输出 | 累计 |
| --- | --- | ---: | --- | --- | --- | ---: |
| 打印机 | marketplace | 4 | 3.2k → 6.3k | 0.1k → 31.6k | 0 → 28.4k | 95k |
| half term 室内去处 | information | 4 | 7.1k → 18.9k | 0.1k → 10.4k | 0 → 8.2k | 83k |
| Epping Forest | information | 4 | 3.9k → 16.5k | 0.1k → 9.6k | 0 → 7.6k | 71k |

结论：市场场景是工具输出在历史里累积（`market_search` / `market_enrich` 每次列 8–10 条带摘录的候选，后一次又全列一遍）；信息场景是证据进了数据包后每轮重发，同一批来源的预览又在工具输出里重复一次。两者都离 10 万字累计上限只差一两轮。

改法 5 的落地：`compactEarlierToolResults`（`prompts/runtime-context.ts`）——执行阶段每次调模型前，把**已经读过的**（不是最新一条）证据类工具结果（search_information、read_web_page、market_search、market_enrich、read_task_sources、xhs_*）中超过 600 字的替换成一行占位，来源与候选仍按编号留在数据包里；账本类反馈（record_task_progress 等）原样保留。另外研究员去掉 voice / delivery 层后，执行阶段提示词从约 7980 字降到约 5000 字（`docs/prompts/README.md`）。

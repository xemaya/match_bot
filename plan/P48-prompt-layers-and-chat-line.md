# P48 提示词分层目录、群聊发言与证据卡拆分

状态：评审中（代码、测试、文档在工作树完成，未提交；以合入主干为生效点）。负责人 claude。依赖：0.31.0 工作树（联合实测后的分诊 / 群聊上下文改动，尚未合并）。范围 `packages/agent`，加 `packages/channel-telegram` 的折叠渲染和 `scripts/local/prompt-audit.mts`。

用户决定（2026-10-21）：同意按"读者"重组提示词目录，三件配套事全部做：审计脚本 dump 全文、工具层归拢并把拒稿反馈改成"改成什么"、把群聊那句话和证据卡拆成两个产物。

## 诊断（来自 2026-10-20 联合实测与盘点）

模型实际读到的文本分五层，P37 的分层只覆盖前两层：

| 层                                 |   字符数 | 文件数 | 归属                 |
| ---------------------------------- | -------: | -----: | -------------------- |
| SOUL.md                            |      635 |      1 | prompts/README 有    |
| 系统指令（rules / scenes / 阶段）  |   22,007 |      9 | prompts/README 有    |
| 工具 description                   |   10,825 |     24 | 各工具文件自己       |
| 参数 .describe()                   |    3,219 |      5 | 各工具文件自己       |
| 工具拒稿反馈（validationFeedback） |    8,079 |     13 | 各工具文件自己       |

后三层比系统指令还大，全是英文禁令体，不在任何审计里；拒稿反馈在重试循环里是模型下一轮第一眼看到的东西，却与 SOUL 无关。长度规则在四处互相矛盾（120 字 / 两段 / 1400 字 / 700 字），代码再追加来源行。没有一层描述"这句话发到群里该长什么样"。

## 目标结构

```
packages/agent/prompts/              人写的散文，运行时读入（中文）
  README.md                          索引：层、读者、阶段矩阵、怎么审计
  voice/soul.md                      气质（原 SOUL.md）
  voice/chat-line.md                 群聊发言规范：动作类型、长度、@人、何时不说
packages/agent/src/prompts/
  policy/rules.ts                    稳定规则；代码已强制的条款删掉
  policy/scenes.ts                   场景工作流与工具白名单
  stages/{triage,plan,research,write,status,legacy}.ts   每阶段一个文件
  stages/index.ts                    阶段矩阵：每阶段注入哪些层、开放哪些工具
  tools/<tool>.ts                    每个生产工具的 description + 参数说明 + 拒稿反馈
  runtime-context.ts / tool-contract.ts  不变
```

## 任务清单

- [x] T1 基线：当前工作树 `pnpm build && pnpm check` 全绿，记录数字。
- [x] T2 目录重组：按上表移动文件、更新 import；`voice/*.md` 运行时加载，启动时校验非空；旧路径不保留 shim。
- [x] T3 阶段矩阵：`stages/index.ts` 显式声明每阶段注入的层；triage / plan / status 不含 voice；research 与 write 含 voice；write 把 voice 放在最后（离生成最近）。
- [x] T4 规则瘦身：删除代码已强制、模型无法执行的条款；长度规则只剩 `chat-line.md` 一处；删除 "two short paragraphs"。
- [x] T5 工具层归拢：生产路径工具（reply_to_request、search_information、read_web_page、market_search、market_enrich、record_task_progress、read_task_sources、record_request、find_suppliers、find_peer_supply、reply_in_group、ask_clarification、close_demand、do_nothing、react、plan-task 四个、reply_request_status、make-outbound-tool 通用反馈）的 description / describe / 反馈文本集中到 `src/prompts/tools/`；反馈改成"改成什么"句式。legacy 工具不动，README 标注。
- [x] T6 产物拆分：`reply_to_request` 参数 `text`（群聊那句话，群 ≤150 字三行、私聊 ≤400）+ 可选 `details`（≤700 字，支撑细节）；代码把 details + 市场候选块 + 来源行渲染成以 `【详情】` 开头的证据卡；所有事实校验覆盖 text+details。
- [x] T7 折叠渲染：channel-telegram 把证据卡渲染成 `expandable_blockquote` 实体（默认折叠），卡内来源链接仍为 text_link；无 details 无来源时不出卡。
- [x] T8 运行时包瘦身：`receipts` 计数器与内部布尔（evidenceValidationExhausted、outboundBlocked）移出模型包，改为面向任务的 `research` 摘要（搜了几次、读了几页、来源故障）；trace 不变。
- [x] T9 审计 dump：`prompt-audit.mts` 对每个阶段×场景输出完整系统指令、工具 description 与参数说明、拒稿反馈目录、样例运行时包到 `docs/prompts/`，并保留结构 JSON 与字符预算检查；`pnpm prompt:audit`。
- [x] T10 测试：阶段矩阵、chat-line 长度门、details 渲染、折叠实体、运行时包字段、反馈文案不含 "Do not" 开头；更新受影响的既有断言。
- [x] T11 AGENT_VERSION 0.32.0；`pnpm build && pnpm check` 全绿；prompt-audit 通过；评测 fixture 回放。
- [x] T12 完成记录：原计划 vs 实际偏差，数字来自真实命令。

## 验收标准

1. 模型读到的每一段文本都能在 `packages/agent/prompts/` 或 `src/prompts/` 下找到归属，`docs/prompts/` 里有逐阶段全文，人能读。
2. 每阶段的注入层由 `stages/index.ts` 一处声明，测试锁定：triage / plan / status 不含 voice；write 含 soul 与 chat-line 且在末尾；research 不含 write 协议。
3. 关于回复长度的规则只在 `chat-line.md` 出现一次；群回复 text 超过三行或 150 字被工具退回，反馈告诉模型把什么挪到 details。
4. 生产路径工具的拒稿反馈没有以 "Do not" / "Never" 开头的句子，每条先说"改成什么"。
5. 回复落库的文本结构为：群聊那句话 + 空行 + `【详情】` 证据卡（仅当有 details / 候选 / 来源）；Telegram 发送时证据卡为 expandable_blockquote，来源仍可点。
6. 运行时包不含 receipts 计数器与内部布尔；现有安全契约（用户正文不进系统指令、跨 owner 过滤、不持久化注入包）测试不变仍通过。
7. `pnpm build && pnpm check` 全绿；prompt-audit 的字符预算不高于 P37 记录（执行 8000、规划 6500、收尾 5500）。
8. 不新增模型调用、出站路径、个人数据字段；不改 Jev、审批、频控、Phase 门。

## 不在本包

- 把 policy 规则翻译成中文（语义承载文本，需真实 A/B 后再决定）。
- Match Bot 新增"报告"以外的发言动作（先回一句再查、按名字转介）：需要新的入站/出站路径，另开工作包。
- 群记录保留显示名：涉及 AGENTS.md §6 隐私约定，另议。
- 真实联合回归：需用户批准额度。

## 完成记录（2026-10-21）

**基线。** 工作树是 0.31.0 的未提交状态（联合实测后的分诊 / 群聊上下文改动）。这台机器没有 Node，先装了官方 Node 22.23.3（SHA256 校验，`~/.local/node`）和 corepack pnpm 11.11.0。基线 `pnpm build && pnpm check`：typecheck / lint / format 通过，1210 项测试 1207 通过，3 个失败全是 db 集成测试断言 `outboundMessage.count()` 为 0 却得到 22（共享 Postgres 里残留的联合实测数据），与代码无关，本包前后一致。

**做了什么。**

- 目录：`SOUL.md` → `prompts/voice/soul.md`（v5，改成正面行为清单，保留 ENFP），新增 `prompts/voice/chat-line.md`；`rules.ts` / `scenes.ts` → `src/prompts/policy/`；`request-instructions` / `delivery-instructions` / `task-instructions` / `legacy-instructions` / triage 指令 / status 一句 → `src/prompts/stages/`；`stages/index.ts` 的 `STAGE_MATRIX` + `composeStagePrompt` 是注入顺序的唯一声明（policy → 阶段协议 → voice 在最后）。旧路径不留 shim；四个历史 PoC 脚本的 SOUL 路径同步改掉。
- 规则瘦身：删掉"权限由代码强制、不要绕过门"等模型无法执行的条款；"three short lines / 120 字"从 DELIVERY_RULES 移到 chat-line；"two short paragraphs"从收尾协议和 health_access 场景删除；收尾协议和市场场景各压缩约 300 字符，让收尾 ≤5500、执行 ≤8000 的 P37 预算继续成立（执行 × marketplace 现为 7,9xx，最紧）。
- 工具层：18 个生产工具的 description / 参数 describe / 拒稿反馈集中到 `src/prompts/tools/<tool>.ts`（含 make-outbound-tool 与 outbound-gate 的通用文案、research-readiness 的补搜提示），`tools/index.ts` 提供审计索引。拒稿反馈全部改为先写改法：`prompt-layers.test.ts` 锁定不以 Do not / Never / Invalid 开头。legacy 工具不动。
- 产物拆分：`reply_to_request` 参数新增 `details`（可省略，≤700 字），`text` 变为群聊那句话（群 ≤3 行 150 字、私聊 ≤400 字，超限退回并说明挪什么到 details）；所有事实校验覆盖 text + details；代码用 `@matchbot/domain` 新增的 `renderEvidenceCard` 把 details、市场候选块、来源行渲染成以 `【详情】` 开头的证据卡；channel-telegram 把卡渲染为 `expandable_blockquote`，标题加粗，卡内来源仍为 `text_link`；没有 details 和来源时不出卡。
- 运行时包：`receipts` 计数器和 `evidenceValidationExhausted` / `outboundBlocked` 移出模型包，改为 `research` 摘要（搜索次数、来源数、读页数、来源故障）；trace 不变。
- 审计：`pnpm prompt:audit` 生成 `docs/prompts/`（README 含阶段矩阵与结构审计表、每阶段 × 场景的完整系统指令与注册工具说明、tools.md 拒稿反馈目录、runtime-packet.md 样例、voice.md、triage.md、status.md），预算超限在末尾统一报错。
- 测试：新增 `prompt-layers.test.ts`（阶段矩阵、voice 位置、长度规则唯一、反馈句式、数据包字段、证据卡渲染/拆分、triage 指令来源）、reply_to_request 三个用例（群长度门、行数门、证据卡落库结构）、channel-telegram 两个用例（折叠实体、无卡不折叠）；更新 soul 路径与 5 个旧断言。
- AGENT_VERSION 0.31.0 → 0.32.0。

**验证（真实命令）。** `pnpm build` 通过；`pnpm check`：typecheck、lint / 依赖方向、format 通过，139 文件 1223 项测试 1220 通过，3 个失败与基线相同（db 残留数据）。`pnpm prompt:audit` 通过，27 组装配在预算内。`pnpm eval --skip-metrics`：92 条录制 fixture，precision / recall / silenceCorrect 均 1，categoryAccuracy 0.989（既有 s39 分歧）。没有真实模型调用或 Telegram 消息：人感是否改善要靠下一轮联合实测。

**与计划的偏差。**

- research 阶段仍注入 voice：执行阶段的 agent 也能直接调用 `reply_to_request`，去掉 voice 会让这条路径没有发言规范。矩阵里如实标注。
- `details` 用 `nullish` 而不是必填 nullable：既有 54 个 reply 用例按旧参数调用，必填会让每个用例多一次模型调用；兼容网关对 `nullish` 已有先例（market_search 的 plan）。
- 规则没有翻译成中文，运行时包字段只做了瘦身没有改名：这两项是语义承载文本，需真实 A/B 后再动，已写在"不在本包"。
- 字符预算：execution × marketplace 一度 8296，靠删冗余句压回；如果以后场景文本再长，应优先拆场景而不是放宽预算。

**未提交。** 工作树里还有用户的 0.31.0 改动，本包改动未单独提交；提交与合并由用户决定。

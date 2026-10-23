# P53 主 agent「群里的 A2H」

状态：实现中（2026-10-22 用户以 /goal 授权推进 P52–P55、生成额度 1000 万；D1–D4 按推荐执行）。负责人 claude。依赖：P52（研究员子 agent、单一出口、`stages/` 工厂）。范围 `packages/agent`（新主 agent 阶段、研究员 `asTool`、新发言工具与门）、`packages/domain`（出站 mention 渲染）、`apps/worker/src/pipeline/inbound.ts`（主 agent 接入、写前新鲜度检查）、`packages/eval`（"群里时刻"评测）。

总体路线见 [P52](./P52-researcher-subagent-single-voice.md#总体路线p52p55)。

## 为什么

P51 之后可数指标 11/11 达标、判官 3.94，但盲判命中率仍 1.0。判官理由几乎一致："服务、人名、地点和日期集中交代，末尾再给询问建议""信息组织偏助手式"。群友的话是关于自己和彼此的（"我下午可以""拍子我有多的能带一把"），Match Bot 只在查到东西时开口，每次都是"地点 + 价 + 时间 + 一个追问"。

结构原因：现在的工作单位是"一个用户的一条消息"，Match Bot 没有"自己在群里"的视角——

- 只知道自己发给**这个人**的最近 5 条（`recentReplies`），不知道自己在群里还有哪些没收尾的线；
- 开不开口散在 5 处（triage、`ambiguous_unsolicited`、冷却、`canSkipSupplementReply`、`do_nothing`），每处只看局部；
- 只会一种发言：检索结果。说不出"@阿明 你上回不是说拍子有多的"，也说不出一句不带事实的接话；
- 判官扣分最重的几条（"群里喊一声""伴儿我在群里喊不了"，搬家找人手只能报搬家公司）都是这一点。

业界参照：OpenClaw 每个群一个 session、人设文件常驻、`NO_REPLY` 是正式输出、子 agent 结果交回主 agent 再转述；Hermes 子 agent 不带 SOUL；HUMA（arXiv 2511.17315）由一个路由在"沉默 / 发言 / 回复 / 表情"等策略里选；"Speak or Stay Silent"（arXiv 2603.11409）指出零样本的说话时机判断不可靠，需要集中、带上下文、可评测。

## 设计

```
群消息 ─▶ 代码门（黑名单 / 群激活 / 阶段，不变）
        ─▶ triage（不变：便宜的召回型过滤；第七轮实发 340 条里 307 条在这里结束）
        ─▶ planner（P52，不变：绑定任务）
        ─▶ 主 agent「群里的 A2H」（唯一有 voice、唯一挂出站工具）
             读：群视图（见下）+ 当前消息 + 任务
             工具：research（研究员 asTool）、reply_to_request / reply_in_group / reply_with_xhs_notes（按场景一个）、
                   say_briefly、refer_member、react、stay_silent
             写前：新鲜度检查（见下）
```

1. **主 agent 取代 P52 的写手。** P52 写手的指令、门、回复工具原样并入主 agent；`research` 由主 agent 决定是否调用（P52 由代码固定先研究）。主 agent 可以不研究直接 `say_briefly` / `refer_member` / `stay_silent`。
2. **研究员作为 `asTool`。** `researcher.asTool({ toolName: 'research', parameters: {objective, focus}, customOutputExtractor })`，交回 `finish_research` 的 outcome + refs + 备忘（≤ 1500 字）；完整证据在 `MatchContext`，主 agent 的回复工具按 refs 校验。研究员没有出站工具，所以嵌套 run 里不会出现审批中断，`run_states` 快照只来自主 agent 层。T1 的 PoC 必须确认 0.18.0 下：嵌套 run 是否共享同一个 `RunContext`（ctx 写入对外层可见）、`signal` / `maxTurns` / `callModelInputFilter` 如何传给嵌套 run、trace 能否带上 `promptStage=research`。不行就退回"主 agent 调一个普通 function tool，tool 里由代码跑研究员"，效果相同。
3. **群视图（运行时数据包新字段 `groupView`，不新增个人数据）。**
   - `conversation`：现有 groupTranscript（别名，20 行 / 6 h / 4000 字），不变；
   - `myOpenThreads`：A2H 在**本群**的未结任务（所有成员，不只当前提问者），每条：提问者别名、目标一行、A2H 在这条线上最后说的话、距今多久；≤ 6 条；来自 `tasks` + `outbound_messages`，都是已有数据；
   - `myRecentLines`：A2H 在本群最近 6 h 说过的话（只取 chat line），用于"刚说过就别再说""换个说法"；
   - `peerOffers`：transcript 里成员公开说过的、与当前任务主题相关的供给（别名 + 原句 ≤ 80 字），由代码按任务关键词挑，≤ 3 条。
4. **新发言工具。**
   - `say_briefly(text)`：不带事实的接话（接住情绪、确认、反问、"这个群友更熟"）。门：≤ 40 字（CJK 折算）、无数字、无链接、无地名 / 店名实体（复用 `tooManyNumbers` 与实体检测）、无检索汇报词；出站路径与审批与其他出站工具相同。
   - `refer_member(alias, text)`：点名一个群友。门：`alias` 必须出现在 `conversation` 或 `peerOffers` 里且不是当前提问者、6 h 内说过与当前主题相关的话；text 不得复述该成员没公开说过的事。渲染：模型只写别名，出站渲染把别名换成 Telegram `text_mention` 实体（`packages/channel-telegram/src/sender.ts` 已用它 @ 提问者，扩展为可带第二个被点名成员；`outbound_messages` 需能存第二个 mention 的成员 id），模型永远拿不到显示名或渠道 id。
   - `stay_silent(reason)`：即现在的 `do_nothing`，改名只在主 agent 内；reason 进 trace。
5. **写前新鲜度检查。** 入站 lease 按用户串行，同一群两个成员的消息会并发处理；研究可能持续一两分钟。主 agent 调出站工具时，`needsApproval` 之前重新读群记录：如果本 run 开始后群里出现了与当前任务相关的新行（他人已答 / 提问者已说"搞定了" / A2H 已在这条线发过言），出站工具返回 `stale_context` 与新行，主 agent 再走一轮（只能 `stay_silent` / `say_briefly` / 改写），最多一次。不做按群加锁，避免研究期间整个群排队。
6. **开不开口集中到主 agent。** `ambiguous_unsolicited`、`canSkipSupplementReply`、研究员 `skip` 这些局部规则改为主 agent 数据包里的事实（"这条不是对你说的""你 3 分钟前刚回过这条线"），由主 agent 决定，代码只保留硬约束（冷却、频控、Phase）。triage 的 `handledByMembers` 丢弃保留不动——它省掉了 248/340 次进 agent。
7. **提示词。** 新阶段 `main`：trust + fact + delivery + 群协议（何时沉默、何时只接半句、何时点名、何时研究）+ voice。预算 ≤ 8000 字（与执行阶段相同），`pnpm prompt:audit` 加 `main`。群协议里不放可照抄的中文范例句（P51 教训）。

## 决定（2026-10-22 按推荐执行）

- **D1 点名的身份边界。** 推荐 A：模型只见别名，渲染时换成 Telegram mention（不改 AGENTS.md §6，模型不接触显示名）。备选 B：群记录带显示名（改 §6，模型能自然地说"阿明"，但显示名进入模型输入与快照）。
- **D2 允许 @ 一个没向 A2H 提问的成员。** 这是新的出站形态（现在只回复提问者）。推荐允许，条件是第 4 条的 `refer_member` 门；每个成员每天被 A2H 点名 ≤ 2 次（频控表新增一项）。
- **D3 人感验收目标。** 推荐不再以"盲判命中率 < 1.0"为目标（A2H 在群里本来就是公开的 bot 账号），改为：判官"像一个靠谱、话不多的群友"均分 + "群里时刻"动作一致率（见验收）。
- **D4 私聊。** 推荐私聊继续走 P52 流程（没有群视图），主 agent 只在群里启用。

## 任务清单

- [ ] T1 PoC（`scripts/poc/agent-as-tool.mts`）：0.18.0 的 `asTool` 嵌套 run 的 context 共享、signal、maxTurns、输入过滤器、trace；结论登记进本文件与 `docs/技术架构设计.md` §11。
- [ ] T2 "群里时刻"评测集：从第七轮导出 `moments/r7`——42 条进 agent 的消息 + 40 条 triage `handled_by_members` 抽样 + 15 条 `peer_offer_noted`，每条带当时的群视图；标签 = 理想动作（沉默 / 表情 / 接半句 / 点名 / 回答）。判官按评分细则先标，用户抽查 20 条定稿。新增 `pnpm humanness moments` 子命令：只跑主 agent 的第一步决定（调 `research` 记为"回答"一类，不真的研究），算动作一致率；第一步就直接回答的才需要证据，用当时冻结的证据简报。
- [ ] T3 `groupView` 数据（`myOpenThreads`、`myRecentLines`、`peerOffers`）与仓储查询；单测。
- [ ] T4 主 agent 阶段：`stages/main.ts`，研究员 `asTool`（或 T1 的退路），P52 写手并入；`run.ts` 群聊路径改走主 agent。
- [ ] T5 `say_briefly`、`refer_member`（门、频控项、mention 渲染）、`stay_silent`；四条出站用例（Phase 0 / 1 / 2 自动 / 2 送审）各一套。
- [ ] T6 写前新鲜度检查与 `stale_context` 一轮重决；测试覆盖"他人已答""提问者说搞定了""A2H 已在本线发过"。
- [ ] T7 删掉被主 agent 取代的局部开口规则（第 6 条），trace 保留原因字段。
- [ ] T8 回路：`moments r7`；`humanness:record r3 / r7 --as *-p53`，`metrics` / `judge`（D3 的新评分题）/ `compare`。
- [ ] T9 联合实测一轮（actor_bots，额度另批）作为最终验收；`docs/技术架构设计.md` §3 / §4 更新；AGENT_VERSION 0.37.0；清空待审 `run_states`；`pnpm eval`；`pnpm build && pnpm check`；完成记录。

## 验收标准

1. **群里时刻**（`moments/r7`）：动作一致率 ≥ 75%；"不该说却说了"≤ 10%；"该答却沉默"≤ 10%（对 `addressedToBot` 的消息为 0）。
2. **新发言方式真的被用**：r7-p53 中非检索结果的发言（`say_briefly` / `refer_member` / 表情）占 A2H 发言的 15–40%；`refer_member` 无一条点到当前提问者本人或 6 h 内没说过相关话的人。
3. **人感**：判官（D3 新题）均分 ≥ 4.0；P51 的 11 项可数指标仍达标；"让正在群里约人的人去群里喊""暴露助手能力边界"类问题为 0。
4. **成本与时延**：每条进 agent 的消息输入 token 中位数 ≤ P52 结果 × 1.2；耗时中位数 ≤ P52 × 1.2。
5. **安全**：所有出站仍只经出站工具 → 门 → 出站表；Phase 0 不发；`refer_member` 的 mention 渲染不把渠道 id 写进模型输入、日志或 trace（测试断言）；`pnpm check` 全绿（db 基线除外）。

## 额度

T2 判官标注走 OPENAIROUTER。T8 录制约 100 万生成 token；T9 联合实测按 actor_bots 一轮的惯例另行申请。开跑前报数取得批准。

## 风险

- **主 agent 把什么都变成接半句**：验收 2 给了上限 40%；`say_briefly` 不能出现在 `addressedToBot` 且有可答问题的消息上（门）。
- **点名点错人或显得冒犯**：`refer_member` 门 + 每人每日 2 次；联合实测里专门看被点名一方（演员）的反应。
- **时延上升**：主 agent 比 P52 多一次决定调用；研究员仍是大头。若中位数超 1.2 倍，把"明显要研究"的消息（triage `answer` + 有任务 + 直接问）由代码直接先跑研究再进主 agent。

## 实现记录（2026-10-22）

与原计划的出入（AGENTS.md §9.1）：

- **研究员不用 `asTool`，用普通工具 `research` 在代码里跑（T1 退路）。** PoC（`scripts/poc/p53-agent-as-tool/run.mts`，替身模型）：嵌套 run 与外层共享同一个 ctx 对象、嵌套工具调用不进外层历史、输出取内层最后一条消息——都可用；但嵌套 run 撞 maxTurns 时 SDK 把错误包成一段工具输出文字交还外层，外层不知道研究被打断。本阶段需要"撞线就把已收集的交出去"、自己的 trace 和输入过滤器，所以 `tools/research.ts` 在工具内部用 `createResearcherAgent` 跑一次研究员。
- **新鲜度检查不是"出站工具退回一次"，而是每次调模型前刷新。** 出站工具的 `toDraft` 在 needsApproval 和 execute 各跑一次，"只退回一次"的状态会让第二次直接放行。改为主 agent 的输入过滤器在每次模型调用前查"本 run 开始后入库的群消息与 A2H 在其他 run 发出的话"（按插入时间，不按 receivedAt，录制回放时不会把原轮次后面的话当成新消息），放进数据包 `newGroupLines`，提示词要求据此改为沉默或一句短接。
- **`stay_silent` 沿用 `do_nothing` 名字**，避免改动它已有的沉默语义与测试。
- **`myRecentLines` 不单列**：groupConversation 已含 A2H 在本群 6 小时内的话。`myOpenThreads` 不含"距今多久"：任务行没有时间戳列，用 status / answered 代替。
- **refer_member 的 mention 不加新列**：回复提问者的消息（reply_to），`mention_user_id` 填被点名成员；每人每日 ≤2 次用 `countMentionsSince`（notification 类、按 mention 计，会把该成员自己收到的 say_briefly 也算进去，只会让点名更少）。
- 主 agent 只在群聊、`answerRequests`、`GROUP_MAIN_AGENT=true`（默认）时启用；私聊与 `ambiguous` 仍走 P52 流程（D4）。审批恢复按快照里的 `isMainAgentRun` 重建主 agent。

T2 的"群里时刻"评测落为 `pnpm humanness moves <源轮次> <录制轮次>`：判官看每一问之前 30 分钟的群友发言、这一问和 A2H 实际的动作（沉默 / 表情 / 半句 / 回答），给出理想动作与是否合适，统计合适率、"不该说却说"、"该答却沉默"。triage 丢弃的消息到不了主 agent，所以评测对象是进入流水线的问题。

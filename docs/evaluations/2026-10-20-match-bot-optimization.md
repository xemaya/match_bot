# 联合实测后的 Match Bot 优化：群聊上下文、关闭 Jev、降低 token

2026-10-20。依据 [联合实测观察](2026-10-20-actor-bots-joint-run.md)，按三个方向改：补群聊上下文、Jev 可以关掉、token 偏多。另一条原则来自用户：**是否回复看这条回复对提问者有没有价值，不看 Match Bot 干没干活。** 本轮只改代码和离线测试，没有真实运行。

## 实测里 token 都花在哪

| 消息 | 模型调用 | 输入 token | 输出 token | 结果 |
| --- | ---: | ---: | ---: | --- |
| 就是普通感冒 鼻子堵嗓子疼那种 | 7 | 87173 | 1878 | 没回复 |
| se1也太远了救命……再蹲蹲mile end附近的吧 | 7 | 108886 | 3222 | 预算停止前未发出 |
| 问一下 有没有11月20到25号从上海飞伦敦的…… | 10 | 73251 | 4944 | "没能整理成可靠的答复" |

输出只占 3–5%，钱花在输入：每一轮都把运行时数据包重新发一遍，其中 `currentPublicEvidence` 最多 24000 字，`search_information` 的返回值又把同一批段落再带一遍，所以第二轮起单轮输入 14k–27k token，7 轮累计就是 8–11 万。另外两类浪费：补充一句（"就是普通感冒"）也触发完整研究；研究完发不出有价值的话，还会发一条固定状态。

## 改动

### 1. 群聊上下文

- `messages.recentInGroup` / `outbound.recentSentToTarget`：最近 6 小时、最多 20 条本群公开消息（含 Match Bot 自己确认发出的），成员以稳定别名（`成员xxxx`）出现，当前发言者带标记，不含渠道 id 或姓名。
- worker 入站管线装入 `ctx.groupTranscript`；运行时数据包新增 `groupConversation`（≤4000 字）；指令说明：别人已经答了、或者是成员之间在聊，就 `do_nothing`；成员公开的供给只能作为"群里有人提到"的线索按别名提及。
- 这也是最便宜的群内撮合：阿明刚说有空房、小鱼紧接着求合租，Match Bot 在群聊记录里能看到。

### 2. `JEV_POLICY=off`

- 入站：一次生成模型分诊（`packages/agent/src/triage.ts`，`stop_on_first_tool`，约 1–2k token），输入是当前消息 + 群聊记录 + 是否 @ 了助手，输出 `answer / continue(newCondition) / peer_offer / acknowledge / ignore(handledByMembers)`、品类、`sensitive`。映射：`answer` 进 agent；`continue` 且有新条件进 agent 作为 followup，没有新条件直接结束；其余不进 agent。分诊不可用时与 Jev 不可用一致：不进 agent，记 failed。
- 出站：Phase 2 不再调用 Jev，verdict 置为通过，阶段/频控/代码事实校验照旧，trace 带 `policy: 'off'`。
- `evaluateSourceSupport` 的三处调用在 off 下跳过并视为支持（否则空 key 会把所有事实标成不支持，回复退化成"unavailable"）。
- 代码规则门（黑名单、群未激活、命令）不变。

### 3. token

- 运行时数据包的证据预算分阶段：执行阶段 8000 字且每段最多 350 字（每个来源都看得到，但只看开头），最终作答阶段才用 24000 字全文；历史证据提示执行阶段减半。
- `search_information` / `read_web_page` 返回值只带来源标识、段落数和 160–200 字预览，段落只在数据包里出现一次。
- `MAX_TURNS` 12 → 8。
- 分诊挡掉补充说明、致谢、成员互聊，这些在实测里占了没回复消息的大头。

### 4. 回复价值

- 未 @ 助手的群消息（`isUnsolicitedGroupTurn`）：研究后没有有用内容，`do_nothing` 直接结束（不再被推回去要求作答）；固定状态（"查询没能完成""没能整理成可靠的答复"）不发，除非它带着一个已规划的个人条件问题；`unavailable` 且无引用的最终回复不发。
- @ 了助手或私聊：保留原有行为，一句诚实的"没查到"也算有价值。
- 群回复长度：先给结论，三行以内（约 120 字），最多两个选项，地址/营业时间只给推荐的那个。
- 我最初加过"研究完就必须作答"的兜底，按用户纠正撤掉了：那只是把浪费变成噪音。

### 没改的

- `Supply` 表仍没有物品描述、P16 广告规则仍把"出一间房"丢掉：群内撮合这轮靠群聊记录覆盖最近 6 小时，长期供需库是下一步。
- Jev 的 `strict` / `targeted` 保留，默认仍是 `strict`；只有显式 `JEV_POLICY=off` 才走新路径。

## 验证

`pnpm check`：typecheck、lint/依赖方向、format 通过；138 个测试文件、1196 项测试通过（新增 group-context、triage、reply-value、outbound-gate off、pipeline off、db group-context）。AGENT_VERSION 0.31.0。真实效果需要下一轮联合测试验证，重点看：每条消息的 token、分诊的误判、群里有人答过时是否闭嘴。

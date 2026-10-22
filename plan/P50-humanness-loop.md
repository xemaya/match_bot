# P50 人感回路：不进群也能反复测

状态：完成（2026-10-22 合入 main `1adf509`）。负责人 claude。依赖：P49（0.33.0，已合入 main）。范围 `packages/eval`（新增 `src/humanness/`）、`packages/agent/src/index.ts` 补几个导出、根 `package.json` 一个命令、`docs/testing/humanness.md`。不改提示词、不改校验门、不改渲染：改法放 P51。

用户决定（2026-10-22）：先回路，后改法。判官不由 Claude 担任（不可重复、无法盲判），用 OPENAIROUTER_BASE_URL / OPENAIROUTER_API_KEY 这一套，模型 `JUDGE_MODEL` 可配，默认 gpt-6.1-sol（actor_bots 写作者同款）。

## 为什么

三轮进群实测，每轮要等 actor_bots 跑、等人读，改一句提示词要一天才知道结果。昨天的多代理评审给了 7 条原因和 10 个可数指标，但没有一个能自动算。人感全在收尾阶段的文本，而收尾阶段只需要研究包 + 群记录 + 任务，这三样 9 条实跑都留在库里（`messages.execution_snapshot`，加密），不用重搜。

## 回路

```
pnpm humanness export   --since <iso> [--until <iso>] [--name <round>]
    库里的实发回复（含原问、当时群记录里的人话）→ fixtures/humanness/rounds/<round>.json
pnpm humanness metrics  <round>         L0：纯函数，秒级，零成本；可进 pnpm check
pnpm humanness judge    <round>         L2：盲判 + 评分，走路由器，JUDGE_MODEL
pnpm humanness freeze   <round>         解密 execution_snapshot → fixtures/humanness/cases/<round>/<case>.json（需 SNAPSHOT_KEY）
pnpm humanness:record   <round> --as <newRound>   快照 key 找不回时：原问按原作者原时间重过整条流水线（Phase 0 dry_run），新快照用当前 key 加密并直接冻结
pnpm humanness replay   <round> [--n 1] [--as <newRound>]   L1：只重跑收尾阶段，真模型，JEV_POLICY=off，不落库
pnpm humanness compare  <roundA> <roundB>   两轮指标并排
```

L1 的边界：研究包冻结在录制那一刻，改法若影响研究阶段（多搜少搜）看不出来，要靠 `scripts/poc/p47-triage-replay` 的全链路 Phase 0 重放。判官不是群友：它判得出"像不像手机打字"，判不出"该不该这时候说"，所以出卡率、追问回复数这类结构指标与它并列。

## 任务清单

- [x] T1 工作包与看板行。
- [x] T2 `humanness/schema.ts`：轮次文件与冻结案例的 zod 结构；`humanness/metrics.ts`：昨天报告的 10 项里能自动算的 8 项（长度、重标点、裸数字、£、检索汇报词、核实词、语气词、出卡与链接），对 bot 与群友分别汇总；单元测试。
- [x] T3 `humanness/export.ts`：从库导出一个时间窗内的实发回复（sent / dry_run）与原问，以及同群同窗内群友的"回答型"消息（以 @ 开头或带 reply）；成员只留哈希别名，不留 Telegram id。
- [x] T4 `humanness/judge.ts`：OpenAI 兼容 chat/completions；盲判（bot 句与群友回答型句等量混排，逐条给 bot 概率，算命中率与 AUC）与评分（每条 1–5 分 + 主因类别）；seed 固定；结果写到轮次文件旁；fake fetch 单测。
- [x] T5 `humanness/freeze.ts`：解密 `execution_snapshot`，连同任务、当时群记录、原问存成案例文件；`humanness/replay.ts`：案例 → 还原 MatchContext → 只跑收尾（`finalAnswerOnly`）→ 内存出站 → 新轮次文件；`--n` 多采样。
- [x] T6 `humanness/cli.ts` 与根命令 `pnpm humanness`；`docs/testing/humanness.md`；案例与轮次目录加入 .gitignore（含群友原文）。
- [x] T7 基线：对 2026-10-22 00:25–01:13 这一轮跑 export → metrics → judge，数字写进本文；freeze/replay 需要 SNAPSHOT_KEY，由用户在自己环境跑一次并回填。
- [x] T8 `pnpm build && pnpm check` 全绿（3 个 db 基线失败除外）；完成记录。

## 验收标准

1. 不碰 Telegram、不写生产表：export / freeze 只读；replay 的出站、留痕、会话全在内存。
2. 同一轮次文件跑两次 `metrics` 结果完全一致；`judge` 固定 seed 下混排顺序一致。
3. `replay` 对同一案例能重复出文本，并能用 `metrics` 与原实发并排比较。
4. 指标定义与昨天评审报告一致，报告里的 9 条基线数字能被 `metrics` 复现（长度均值 113、£ 11 个、带卡 9/9 等，允许计数口径差 ±1）。
5. 判官模型、路由地址只从 `JUDGE_MODEL`、`OPENAIROUTER_*` 读取；缺失时 `judge` 报清楚缺什么，其余子命令不受影响。
6. 不新增生产依赖、不改 agent 行为；agent 包只增加导出。

## 不在本包

- 改法本身（P51：排序 1–5）。
- 全链路重放并入本命令（继续用 p47 脚本）。
- 人类盲测（指标 10）：给出混排文件即可，由人填答案。

## 完成记录（2026-10-22）

**做了什么。** `packages/eval/src/humanness/`：`schema.ts`（轮次 / 案例 / 判官结果）、`metrics.ts`（8 项可数指标与 `TARGETS`）、`export.ts`（只读库，成员哈希别名）、`judge.ts`（OpenAI 兼容 chat/completions，盲判 + 评分，seed 固定）、`freeze.ts`（解密 `execution_snapshot`，连同任务与当时群记录存案例）、`replay.ts`（只跑收尾，内存出站 / 留痕 / 会话，JEV 关闭）、`cli.ts`。`@matchbot/agent` 新增导出 `researchContextSchema`、`restoreSearchContext`、`buildDeliveryPacket`、`bindTaskMarketPlan`。根命令 `pnpm humanness`；`docs/testing/humanness.md`；`fixtures/humanness/{rounds,cases}` git-ignore。测试：`humanness-metrics.test.ts`、`humanness-judge.test.ts`（fake fetch）。

**基线 r3（2026-10-22 00:20–01:20 UTC，9 条回复，29 条群友回答型句）。**

| 指标 | bot | 群友 | 目标 |
| --- | ---: | ---: | ---: |
| 长度中位数 | 116 | 34 | ≤80 |
| 超 100 字 | 7/9 | 0 | 0 |
| 重标点均值 | 3.0 | 0 | ≤0.5 |
| 裸数字均值 | 3.0 | 0.1 | ≤2 |
| £ 总数 | 11 | 0 | 0 |
| 检索汇报词 | 9 处 / 6 条 | 0 | 0 |
| 核实词 | 6 | 0 | ≤3 |
| 带语气词 | 0/9 | 16/29 | ≥4/9 |
| 带卡 | 9/9 | — | ≤3/9 |
| 链接最多 | 5 | — | ≤2 |

与 2026-10-21 评审报告的数字一致（均长 113 / 113.2，£ 11，带卡 9/9，超 100 字 7 条）。判官 gpt-6.1-sol：盲判 18 句命中率 1.0，AUC 1，bot 均值 93 vs 群友 3；均分 2.44/5，主因 汇报检索过程 ×4、信息量过多 ×2、套路句式、过度但书、答非所问（Epping 那条）各 1。

**验证（真实命令）。** `pnpm build` 通过；`pnpm check`：typecheck、lint、format 通过，141 文件 1242 项测试 1239 通过，3 个失败是 db 集成基线（共享库残留 outbound 行）。`pnpm humanness export / metrics / judge` 对 r3 实跑通过。

**重录与回放（2026-10-22，用户选择重录）。** 用户放进 .env 的 SNAPSHOT_KEY 与 00:25 那轮 worker 用的不一致（AES-GCM 校验失败，三种取值方式都试过），原 key 不在 shell、.env、容器、ROG 机器任何地方，用户决定重录。新增 `scripts/local/humanness-record.mts`（放 scripts 是因为 packages 不得依赖 apps）：9 条原问按原作者、原时间以 `replay-` 外部 id 重过整条流水线，群临时置 Phase 0 后恢复，与 p47 相同地把作者在该时刻之后开的任务置为 expired。结果 `r3-rec`：6 条出了回复并冻结成案例，3 条补充句（#2、#5、#7）分诊绑到重开的任务后判为不用答，356,119 model tokens。`pnpm humanness replay r3-rec --as r3-rec-replay`：6 条全部 recorded，每条 1.6–3.9 秒，退回 0–1 稿。并排：

| 指标 | r3-rec（录制） | r3-rec-replay（回放） |
| --- | ---: | ---: |
| 长度中位数 | 125 | 111.5 |
| 重标点均值 | 2.8 | 2.7 |
| £ 总数 | 2 | 4 |
| 检索汇报词 | 2 | 1 |
| 带卡 | 6/6 | 6/6 |
| 判官均分 | — | 2.83/5（盲判 12 句命中率 1.0） |

同一提示词录制与回放的差距就是这条回路的噪声底：长度约 ±10、£ 与汇报词 ±2。P51 的改法要在噪声之上才算有效，建议每次 `--n 3` 取中位。

**合入。** 2026-10-22 应用户要求合入 main（`1adf509`）。之后 replay 每条与合计会打印收尾阶段的 model tokens（取自 SDK 原始响应的 usage，抛错的那条记 0），轮次文件多一个可选字段 `modelTokens`。

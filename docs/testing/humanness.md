# 人感回路（P50）

不进群也能反复测"像不像群里的人"。四层，越往下越贵：

| 层 | 命令 | 需要 | 看什么 |
| --- | --- | --- | --- |
| L0 指标 | `pnpm humanness metrics <round>` | 无 | 那句话的长度、重标点、裸数字、£、检索汇报词、核实词、语气词、出卡与链接，对群友同窗消息的同一组数 |
| L1 收尾回放 | `pnpm humanness replay <round>` | `DEEPSEEK_API_KEY`、库里冻结好的案例 | 改了提示词 / 校验门 / 渲染后，同一研究包写出来的新句子 |
| L2 判官 | `pnpm humanness judge <round>` | `OPENAIROUTER_BASE_URL`、`OPENAIROUTER_API_KEY`、可选 `JUDGE_MODEL`（默认 gpt-6.1-sol） | 盲判命中率 / AUC（bot 句与群友回答型句等量混排），每条 1–5 分与主因 |
| L3 全链路 | `scripts/poc/p47-triage-replay/pipeline-replay.mts` | 完整 worker 环境 | 分诊、绑任务、冷却这些写作之外的东西 |

## 一轮怎么跑

```sh
# 1. 把一次进群实测导出来（只读库；成员只留哈希别名）
pnpm humanness export --since 2026-10-22T00:20:00Z --until 2026-10-22T01:20:00Z --name r3

# 2. 基线：指标 + 判官
pnpm humanness metrics r3 --per-case
pnpm humanness judge r3

# 3. 冻结研究包（需要 worker 的 SNAPSHOT_KEY；解密 messages.execution_snapshot）
SNAPSHOT_KEY=... pnpm humanness freeze r3
#    快照用的 key 找不回来时改为重录：原问按原作者原时间重新过整条流水线（Phase 0，dry_run），
#    新快照用当前 key 加密并直接冻结；真搜索真模型，计入生成额度
pnpm humanness:record r3 --as r3-rec

# 4. 改提示词 / 校验门 / 渲染，然后只重跑收尾阶段
pnpm build && pnpm humanness replay r3-rec --as r3-try1 [--n 3] [--only <caseId>]   # 每条和合计都打印收尾用的 model tokens
pnpm humanness judge r3-try1
pnpm humanness compare r3-rec r3-try1
```

文件在 `packages/eval/fixtures/humanness/`：`rounds/<name>.json` 是一轮的回复与群友句，`rounds/<name>.judge.json` 是判官结果，`cases/<round>/<id>.json` 是冻结案例（解密后的研究包、任务、当时的群记录）。这两个目录含群消息原文，已 git-ignore。

## 边界

- `replay` 只跑收尾阶段：研究包冻结在导出那一刻，改法若影响研究阶段（多搜少搜）看不出来，要用 L3。
- `replay` 里 Jev 关闭、出站 / 留痕 / 会话全在内存，不写库、不发 Telegram；`export` 与 `freeze` 只读。
- 判官不是群友：它判得出"像不像手机打字"，判不出"该不该这时候说"。出卡率、追问回复数这类结构指标与它并列看。
- 判官模型与 actor_bots 写作者同款（gpt-6.1-sol），可能偏向认自家口吻为"人"；换模型用 `--model` 或 `JUDGE_MODEL`。
- 指标口径见 `packages/eval/src/humanness/metrics.ts`，目标值 `TARGETS` 来自 2026-10-21 的评审（长度中位数 ≤80、重标点均值 ≤0.5、裸数字 ≤2、£ 0、检索汇报词 0、核实词 ≤3、语气词 ≥4/9、带卡 ≤3/9、链接 ≤2、无泛站点）。

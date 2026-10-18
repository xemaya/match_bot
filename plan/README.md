P38：Agent执行链及提示词整合已通过PR #15合并主干48ebd3e。P39新生成模型接入和真实Telegram回归完成，6条均送达，但任务推进质量未通过，见[回归报告](../docs/evaluations/2026-10-18-gpt-telegram-regression.md)。

# 开发实施计划与进度看板

> 本目录是项目跟进的唯一事实源。每个工作包一个文件，分给不同 agent 并行执行。
> 执行者必须：开工时把看板状态改为 `进行中` 并填负责人；每完成一个 Task 勾掉对应 checkbox；收工时更新状态、PR 链接、`最后更新`，并在文件末尾"完成记录"写结论。
> 执行方式：REQUIRED SUB-SKILL `superpowers:subagent-driven-development`（一个 Task 一个子 agent，任务间评审）或 `superpowers:executing-plans`。

上位文档：[产品需求](../docs/support-agent-产品需求.md) · [技术架构](../docs/技术架构设计.md) · [开发契约 AGENTS.md](../AGENTS.md) · [跨包接口契约](./interfaces.md)

## 看板

P37：提示词架构本地实现与离线回归完成；真实模型质量验收未通过，见 [测试报告](../docs/evals/2026-10-18-p37-live.md) 及 [P37-prompt-architecture.md](P37-prompt-architecture.md)。

P36：Jev targeted 策略与本地无 Telegram 对话验证，Codex 本地实现与回归完成，真实模型验收待凭据（2026-10-18）。用户授权减少 Jev 强依赖；保留事实核验、Phase 0/1、主动群聊门控。见 [P36-targeted-jev-local.md](P36-targeted-jev-local.md)。

状态取值：`待开始` / `进行中` / `评审中` / `完成` / `阻塞`。依赖列出的工作包必须 `完成` 后才能开始（PoC 例外，见各文件）。

| ID | 工作包 | 计划文件 | 依赖 | 波次 | 负责人 | 状态 | PR | 最后更新 |
|---|---|---|---|---|---|---|---|---|
| P0 | PoC 六项验证 | [P0-poc.md](./P0-poc.md) | 无 | 0 | claude (6 并行 agent) | 完成 | [#1](https://github.com/xemaya/match_bot/pull/1) | 2026-09-21 |
| P1 | domain + shared 补全 | [P1-domain-shared.md](./P1-domain-shared.md) | 无 | 1 | claude | 完成 | `feat/P1-domain-shared`（本地合并） | 2026-09-21 |
| P2 | db：迁移与仓储层 | [P2-db.md](./P2-db.md) | P1 | 1 | kimi | 完成 | `feat/P2-db`（本地合并） | 2026-09-21 |
| P3 | queue | [P3-queue.md](./P3-queue.md) | P1 | 1 | kimi | 完成 | `feat/P3-queue`（本地合并） | 2026-09-21 |
| P4 | jev 客户端与问题集 | [P4-jev.md](./P4-jev.md) | P1, P2 | 1 | claude | 完成 | `worktree-p4-jev`（待开 PR） | 2026-09-21 |
| P5 | gating | [P5-gating.md](./P5-gating.md) | P1, P2 | 1 | claude | 完成 | | 2026-09-21 |
| P6 | matcher | [P6-matcher.md](./P6-matcher.md) | P1, P2 | 1 | claude | 完成 | `feat/P6-matcher`（本地合并） | 2026-09-21 |
| P7 | channel-telegram | [P7-channel-telegram.md](./P7-channel-telegram.md) | P1, P2 | 1 | claude | 完成 | `feat/P7-channel-telegram`（本地合并） | 2026-09-21 |
| P8 | agent | [P8-agent.md](./P8-agent.md) | P0(V1,V2,V3,V6), P2, P4, P5, P6 | 2 | claude | 完成 | 直接提交 main | 2026-09-21 |
| P9 | approval | [P9-approval.md](./P9-approval.md) | P2, P3, P7 | 2 | kimi | 完成 | 直接提交 main | 2026-09-21 |
| P10 | apps/bot | [P10-app-bot.md](./P10-app-bot.md) | P0(V5), P2, P3, P7 | 2 | kimi | 完成 | 直接提交 main | 2026-09-21 |
| P11 | apps/worker | [P11-app-worker.md](./P11-app-worker.md) | P8, P9, P10 | 3 | claude | 完成 | 直接提交 main | 2026-09-22 |
| P12 | eval | [P12-eval.md](./P12-eval.md) | P8 | 3 | claude | 完成 | 直接提交 main | 2026-09-22 |
| P13 | Phase 0 上线清单 | [P13-phase0-launch.md](./P13-phase0-launch.md) | P11, P12 | 3 | claude | 进行中 | 工程项已完成；数据/合规/Shadow 待人工 | 2026-09-22 |
| P14 | 库外需求 web search 兜底 | [P14-web-search.md](./P14-web-search.md) | P8, P11 | 4 | codex | 完成 | 0.10.1；随 P16/P17 提交并合并主干；472测试 | 2026-10-10 |
| P15 | 人感：会接话、像群友、有分寸 | [P15-human-feel.md](./P15-human-feel.md) | P14 | 4 | claude | 完成 | 1+2+3 已做；4、5 待定 | 2026-09-25 |
| P16 | A2H公开集市搜索：二手/租房/帮带/搭子 | [P16-market-search.md](./P16-market-search.md) | P8, P11, P14 | 5 | codex | 完成 | 0.10.1；SELL/BUY/PEER；随 P14/P17 合并主干 | 2026-10-10 |
| P17 | 出站参数重试与图文入站修复、A2H 命名 | [P17-fix-outbound-input-and-photo.md](./P17-fix-outbound-input-and-photo.md) | P7, P8, P16 | 5 | codex | 完成 | 0.10.1；472测试、92回放；随 P14/P16 合并主干 | 2026-10-10 |
| P18 | 裸接口自适应搜索策略与独立评测 | [P18-adaptive-market-search.md](./P18-adaptive-market-search.md) | P16, P17 | 5 | codex | 完成 | 0.12.0：独立实验、四类真实预览、后验核对及本地发布 | 2026-10-11 |

| P19 | 推荐首选/备选、证据理由与缺口补搜 | [P19-market-recommendation-choices.md](./P19-market-recommendation-choices.md) | P18 | 5 | codex | 完成 | 0.13.0：首选/备选、对应报价/风险、一次缺口补搜；本地发布 | 2026-10-11 |

| P20 | 修复真实请求漏回复 | [P20-fix-missing-market-replies.md](./P20-fix-missing-market-replies.md) | P19 | 5 | codex | 完成 | 0.13.2：539测试、实际Telegram打印机/桌椅sent，帮带补修后复测sent；本地发布 | 2026-10-12 |

| P21 | 伦敦华人日常需求 A/B 实测 | [P21-london-daily-needs-ab-evaluation.md](./P21-london-daily-needs-ab-evaluation.md) | P20 | 5 | codex | 完成 | 24例A/B：B13sent/11静默；同源与逐例评分/证据报告；策略冻结0.13.2 | 2026-10-12 |

| P22 | 本轮需求与回答Agent改造 | [P22-request-answer-agent.md](./P22-request-answer-agent.md) | P21 | 5 | codex | 完成 | 0.14.2；580测试；原24题两轮18sent；失败子集7/8；证据与剩余问题已记录 | 2026-10-12 |
| P23 | Jev请求状态回复 | [P23-jev-request-status.md](./P23-jev-request-status.md) | P22 | 5 | codex | 完成 | 0.15.1；594测试；6/6真实sent；Jev正反例8/8；固定状态/审批/缓存回归 | 2026-10-12 |
| P24 | 任务Agent总计划、验收与任务基础 | [P24-task-agent-plan-and-acceptance.md](./P24-task-agent-plan-and-acceptance.md) | P23 | 6 | codex | 完成 | 0.16.29：A01–A18证据、969测试、固定源各3/3、原群/迁移/恢复；PR #2合并main生效 | 2026-10-17 |
| P25 | 任务规划与朋友式帮助 | [P25-task-planning-and-companion.md](./P25-task-planning-and-companion.md) | P24 | 6 | codex | 完成 | 0.16.29：A01–A18证据、969测试、固定源各3/3、原群/迁移/恢复；PR #2合并main生效 | 2026-10-17 |
| P26 | 执行投递账本与恢复 | [P26-task-execution-ledger.md](./P26-task-execution-ledger.md) | P24 | 6 | codex | 完成 | 0.16.29：A01–A18证据、969测试、固定源各3/3、原群/迁移/恢复；PR #2合并main生效 | 2026-10-17 |
| P27 | 任务闭环评测与发布 | [P27-task-agent-evaluation-release.md](./P27-task-agent-evaluation-release.md) | P24,P25,P26 | 6 | codex | 完成 | 0.16.29：A01–A18证据、969测试、固定源各3/3、原群/迁移/恢复；PR #2合并main生效 | 2026-10-17 |
| P28 | SOUL与自然接话 | [P28-soul-and-conversation-style.md](./P28-soul-and-conversation-style.md) | P27 | 7 | codex | 完成 | 0.17.3：994测试、固定源各3/3、原群五轮；补充变体2/3，失败留证；正常PR合并main生效 | 2026-10-17 |
| P29 | 主动理解与本地购买渠道 | [P29-proactive-local-access.md](./P29-proactive-local-access.md) | P28 | 8 | codex | 完成 | 0.18.2：1014测试、12契约、小批回放；人工质量限制留证，正常PR合并main生效 | 2026-10-17 |

| P30 | 续接竞争与无增量静默 | [P30-followup-race-and-quiet-replies.md](./P30-followup-race-and-quiet-replies.md) | P29 | 9 | codex | 完成 | 0.18.3：1035测试/12契约、PG竞争复现、重复草稿压制；模型失败留证，PR合并main生效 | 2026-10-17 |

| P31 | Telegram多演员测试群 | [P31-telegram-actor-lab.md](./P31-telegram-actor-lab.md) | P30 | 10 | codex | 进行中 | SOUL v2已本地生效；三角色4条/4回复、351,908 token，预留停止；完整多轮与人感未通过 | 2026-10-18 |
| P32 | 回答风格清理与主动承担 | [P32-conversation-style-cleanup.md](./P32-conversation-style-cleanup.md) | P31 | 7 | codex | 完成 | 0.20.0：1089测试/12契约；默认自然正文+来源，失败不派清单；模型预览限制留证 | 2026-10-18 |
| P33 | 五场真实多轮验收 | [P33-live-multiturn-five-cases.md](./P33-live-multiturn-five-cases.md) | P32 | 8 | codex | 完成 | 五场13条实测结束；1935913token，产品质量未通过；报告见PR11 | 2026-10-18 |
| P34 | 搜索接入与校验阻塞修复 | [P34-search-and-validation-repair.md](./P34-search-and-validation-repair.md) | P33 | 8 | codex | 完成 | 0.21.1修复；原始搜索AB6组；真实回归3条，仍有失败 | 2026-10-18 |
| P35 | 0.21.1真实多轮回归 | [P35-agent-regression-round-two.md](./P35-agent-regression-round-two.md) | P34 | 8 | codex | 完成 | 6条799779token；0.22.0引用计数修复；整体质量未通过 | 2026-10-18 |
| P36 | Agent框架review与交付阶段 | [P36-agent-framework-review.md](./P36-agent-framework-review.md) | P35 | 8 | codex | 完成 | 0.23.0阶段交接/来源摘录/重复追问/时钟等价修复；1128测试；真实多轮未验收 | 2026-10-18 |
| P39 | 新生成模型与Telegram回归 | [P39-model-provider-telegram-regression.md](./P39-model-provider-telegram-regression.md) | P38 | 8 | codex | 完成 | 0.26.1/gpt-6.1-sol low；264118token；6条均回复，任务质量未通过 | 2026-10-18 |
| P41 | 研究停止与交付证据覆盖 | [P41-research-delivery.md](./P41-research-delivery.md) | P39 | 8 | codex | 待合并 | 1196 测试通过；真实任务尚未复测 | 2026-10-18 |

## 波次与并行

```
波次 0  P0 六个 PoC 互相独立，可 6 个 agent 同时跑（需要 API key / bot token）
波次 1  P1 先行（半天）；随后 P2 P3 并行；P2 完成后 P4 P5 P6 P7 四个并行
波次 2  P8 P9 P10 并行（P8 需 PoC V1 V2 V3 V6 结论）
波次 3  P11 串联一切；P12 与 P11 并行；P13 收尾
```

对应两周计划：波次 0–1 覆盖 Day 1–5，波次 2 覆盖 Day 4–8（Phase 0 需要 P11 跑起来），波次 3 覆盖 Day 7–14。

## 分工规则

1. 一个 agent 一次只领一个工作包；领取前确认依赖已 `完成`。
2. 每个工作包在自己的分支 `feat/<ID>-<name>` 上开发，PR 合并到 `main`。初始骨架（本目录建立时的状态）是第一次提交。
3. 跨包接口以 [interfaces.md](./interfaces.md) 为准。要改接口，先改 interfaces.md 并在看板备注，再通知依赖方；不得在自己的包里静默改签名。
4. `pnpm check` 全绿才能标 `评审中`。评审通过标 `完成`。
5. 阻塞时状态改 `阻塞`，并在文件"完成记录"写明卡在哪、需要谁。
6. 计划文件里的代码是起点不是终点：与 interfaces.md 冲突以 interfaces.md 为准；与 SDK 实际行为冲突以 PoC 结论为准，并回写计划。

## 里程碑

| 里程碑 | 定义 | 目标日 |
|---|---|---|
| M1 骨架可跑 | P1–P7 完成，`pnpm check` 全绿，docker 起库后迁移成功 | Day 5 |
| M2 Shadow 上线 | P8–P11 完成，8 个群只听不说，看板有 Demand 数据 | Day 8 |
| M3 首次审批发送 | P9 审批链路跑通，运营群批准后群里出现第一条回复 | Day 11 |
| M4 Go / Pivot | P12 指标出来，P13 清单全勾 | Day 14 |

P24–P27最终状态以PR #2合并main为生效点，功能分支上的完成标记不代表已合并。最新实际验收与失败边界见docs/evaluations/2026-10-17-task-agent-local-release.md。

主干CI跟进：1b9fa96首次main CI暴露Jev失败smoke test的无ORDER BY顺序假设，单独分支修复准确多重集断言，969项本地检查通过。跟进以该修复PR实际合并为生效点，不改变运行逻辑或出站门。

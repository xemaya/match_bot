# P41 本地真实模型回归

复用真实 worker、数据库、模型、搜索、JEV 和出站账本；三个独立合成用户分别进行 GP 注册、无线打印机、亲子看展两轮对话。固定用户输入，不另调模型生成演员消息。发送端只生成本地回执，不使用 Telegram API。

先给 loopback 专用库 `matchbot_p41_live` 应用已有 Prisma 迁移。私有环境文件按 `.env.example` 配置，生成模型使用 `gpt-6.1-sol`、`GENERATION_REASONING_EFFORT=low`，另配搜索和 JEV 凭据、`JEV_POLICY=strict`、`DEFAULT_PHASE=2`，Telegram 参数使用占位值。

```sh
node --env-file=/absolute/private/local.env --import tsx scripts/poc/p41-local-live/run.mts
```

可用 `--scenarios=gp,family --budget=280000` 选择案例和降低预算；当前输出目录为 `logs/real-model/local-<timestamp>`。每次运行都是新的真实调用，不能因上次预算未用满就自动重复。预算拒绝和脱敏模型异常分别记录；若成功调用后缺少 usage 或请求状态不明，停止后续调用。

每次执行会真实消费模型、搜索和 JEV 额度。生成调用使用 300000 token 的观察预算、逐调用预留、最多 45 次调用、单次输出上限 2400 token。预算不包含搜索/JEV；不是提供方账单硬上限。调用 usage 不明时停止后续调用，不自动重新跑整批。Agent 保留自身超时，批次超过 20 分钟不再启动下一轮。

结果写入忽略的 `logs/p41/local-<timestamp>/report.json`，包含合成对话、工具调用、任务状态和 traces。不得将私有环境文件或原始日志提交到版本库。评测需区分“回复已模拟送达”“确实补查新条件”和“用户目标已解决”，不能只以出站成功判断功能完备。

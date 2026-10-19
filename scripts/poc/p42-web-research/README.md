# P42 交付修正回放

完整真实 worker 模拟沿用 `../p41-local-live/run.mts --scenarios=gp,family --budget=280000`，输出在 `logs/real-model/`。配置说明见该脚本 README。

`repair.mts` 只用于本地合成测试数据库 `matchbot_p41_live`：读取指定报告的 `family-2` 及其加密研究快照，冻结证据并注入原 `unsupported numerical values 0` 反馈，用真实模型和 JEV 回放交付。使用与原测试相同的私有环境文件/加密密钥。

```sh
node --env-file=/absolute/private/local.env --import tsx scripts/poc/p42-web-research/repair.mts logs/real-model/local-<timestamp>/report.json
```

上限 60000 生成 token、3 次生成调用、30 秒。每次执行会真实收费，不要自动反复运行。出站和 checkpoint 写入内存，仍调用生产快照序列化与校验，不重用已结束的 DB lease，也不消费发送队列。结果为同目录 `repair.json`；成功只证明冻结证据下的交付修正，不等于重新完成 worker 全链路或真实渠道送达。

# P44 人感与 ENFP 气质

状态：进行中；范围 packages/agent，依赖 P43。

用户要求：取消生硬的统一免责声明，采用 ENFP 气质。

实现：移除回答后无条件追加的尾注；未知条件由回答结合具体选项说明；来源链接、证据校验和所有出站门保留。SOUL 只定义气质，稳定规则定义事实与权限。

验证：先复现推荐正文被强加尾注的问题，再运行工具/审批回归、全量 pnpm check 与离线评测。本轮不新增真实模型调用或 Telegram 消息。

产品偏差：用户 2026-10-19 明确要求改变 PRD F7/风险表的固定免责文案，因此不再采用统一尾注。交易权限与不担保约束仍由规则及工具执行。

跨包契约：worker 的 shadow e2e 原来强制断言统一交易免责声明；同步改成完整正文相等，仍检查 Phase0 dry_run、未发送与 traces。worker 生产代码不改。

## 完成记录

- AGENT_VERSION 0.30.0；SOUL v4 ENFP 气质，研究与交付均注入；内部 planning/status 不注入。
- 删除 catalogue/web/xhs/market 四类自动尾注及旧工具提示，不做关键词替换或删掉模型正文；保留 source URLs、具体未知、stock 不保证、交易权限与 Jev 门。
- 审批恢复仍使用已预览的完整文本；未变更 SDK、数据库、模型路由、出站路径或个人数据字段。
- 首次复现：outbound-gate 10 failed / 20 passed（旧代码会追加尾注）。首次全量：1217 passed / 2 failed，均为旧尾注预期；更新对应 worker shadow 和旧 XHS 断言后重新全量通过。
- pnpm check：141 files / 1219 tests passed，typecheck/lint/format 全通过；pnpm build 成功。
- prompt-audit：27 行结构审计；fixture eval：92 条，precision/recall/silenceCorrect 均 1，categoryAccuracy 0.98913（既有 s39 分歧）。fixture 使用录制 Jev，不是本轮模型质量评测。
- 定向测试：77 项通过，另补两项 persona 注入/权限边界测试；全量总数包含它们。
- 本轮真实生成调用 0、Telegram 消息 0，不能据此宣称实际人感已验收；只证明固定尾注移除、SOUL 正确装载、原契约未回归。
- 同步 PRD F7 与风险表，依据用户明确最新要求替换旧固定尾注规则。

风格目标示例（人工示意，非真实模型输出）：“这台价格挺合适，不过帖子没写型号，还不能确定支持 Wi-Fi。”保留具体未知，不再附“信息来自公开帖子……我不经手交易”。

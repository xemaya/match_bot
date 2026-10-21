# 模型读到的全部文本（AGENT_VERSION 0.33.0）

由 `pnpm prompt:audit` 生成；改了任何提示词后重新生成并一起提交。源文件归属见 `packages/agent/src/prompts/README.md`。

## 阶段矩阵

| 阶段 | 注入的层 | 用途 |
| --- | --- | --- |
| triage | trust | 一次小调用判断这条群消息该不该管 |
| plan | trust | 把当前消息绑定到任务；不写给人看 |
| research | trust, fact, delivery, scene, voice | 按场景研究；也可以直接回复，所以带 voice |
| write | trust, fact, delivery, voice | 只剩 reply_to_request；读证据包写群聊那句话和证据卡 |
| status | （无） | 代码生成的固定状态，模型只负责调用 |
| legacy | trust, fact, delivery, voice | 未启用 answerRequests 的兼容调用者 |

## 文件

- [voice.md](./voice.md) 气质与群聊发言规范
- [triage.md](./triage.md) 入站分诊
- [planning.md](./planning.md) 任务规划
- [execution-catalogue.md](./execution-catalogue.md)
- [execution-health_access.md](./execution-health_access.md)
- [execution-information.md](./execution-information.md)
- [execution-lifestyle.md](./execution-lifestyle.md)
- [execution-marketplace.md](./execution-marketplace.md)
- [execution-official.md](./execution-official.md)
- [execution-unsupported.md](./execution-unsupported.md)
- [finalization-catalogue.md](./finalization-catalogue.md)
- [finalization-health_access.md](./finalization-health_access.md)
- [finalization-information.md](./finalization-information.md)
- [finalization-lifestyle.md](./finalization-lifestyle.md)
- [finalization-marketplace.md](./finalization-marketplace.md)
- [finalization-official.md](./finalization-official.md)
- [finalization-unsupported.md](./finalization-unsupported.md)
- [status.md](./status.md) 固定状态
- [tools.md](./tools.md) 工具 description、参数说明、拒稿反馈
- [runtime-packet.md](./runtime-packet.md) 运行时数据包样例

## 结构审计

| scene | stage | 字符 | 工具 |
| --- | --- | ---: | --- |
| catalogue | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| catalogue | execution | 7485 | record_request, search_information, reply_to_request, record_task_progress, read_task_sources, read_web_page, find_suppliers, find_peer_supply, reply_in_group, do_nothing, react |
| catalogue | finalization | 5327 | reply_to_request |
| marketplace | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| marketplace | execution | 7956 | search_information, reply_to_request, record_task_progress, read_task_sources, read_web_page, do_nothing, react, market_search, market_enrich |
| marketplace | finalization | 5327 | reply_to_request |
| marketplace | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| marketplace | execution | 7956 | search_information, reply_to_request, record_task_progress, read_task_sources, read_web_page, do_nothing, react, market_search, market_enrich |
| marketplace | finalization | 5327 | reply_to_request |
| marketplace | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| marketplace | execution | 7956 | search_information, reply_to_request, record_task_progress, read_task_sources, read_web_page, do_nothing, react, market_search, market_enrich |
| marketplace | finalization | 5327 | reply_to_request |
| health_access | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| health_access | execution | 7626 | search_information, reply_to_request, record_task_progress, read_task_sources, read_web_page, do_nothing, react |
| health_access | finalization | 5327 | reply_to_request |
| official | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| official | execution | 7445 | search_information, reply_to_request, record_task_progress, read_task_sources, read_web_page, do_nothing, react |
| official | finalization | 5327 | reply_to_request |
| lifestyle | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| lifestyle | execution | 7748 | search_information, reply_to_request, record_task_progress, read_task_sources, read_web_page, do_nothing, react, xhs_search, xhs_read_notes, reply_with_xhs_notes |
| lifestyle | finalization | 5327 | reply_to_request |
| information | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| information | execution | 7443 | search_information, reply_to_request, record_task_progress, read_task_sources, read_web_page, do_nothing, react |
| information | finalization | 5327 | reply_to_request |
| unsupported | planning | 4938 | start_task, update_task, clarify_task, acknowledge_task |
| unsupported | execution | 4100 | reply_to_request, do_nothing, react |
| unsupported | finalization | 5327 | reply_to_request |

# 模型读到的全部文本（AGENT_VERSION 0.37.2）

由 `pnpm prompt:audit` 生成；改了任何提示词后重新生成并一起提交。源文件归属见 `packages/agent/src/prompts/README.md`。

## 阶段矩阵

| 阶段 | 注入的层 | 用途 |
| --- | --- | --- |
| triage | trust | 一次小调用判断这条群消息该不该管 |
| plan | trust | 把当前消息绑定到任务；不写给人看 |
| research | trust, fact, scene | 按场景研究；不对群说话（P52），以 finish_research / record_task_progress 交给写手 |
| write | trust, fact, delivery, voice | 唯一对群说话的阶段：按场景一个回复工具，读证据包与研究备忘写那句话 |
| main | trust, fact, delivery, voice | 群里的 A2H（P53）：决定说不说、怎么说，需要事实时派研究员，唯一的说话者 |
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
- [main.md](./main.md)
- [status.md](./status.md) 固定状态
- [tools.md](./tools.md) 工具 description、参数说明、拒稿反馈
- [runtime-packet.md](./runtime-packet.md) 运行时数据包样例

## 结构审计

| scene | stage | 字符 | 工具 |
| --- | --- | ---: | --- |
| catalogue | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| catalogue | execution | 5233 | record_request, search_information, record_task_progress, read_task_sources, read_web_page, find_suppliers, find_peer_supply, finish_research |
| catalogue | finalization | 5050 | reply_to_request |
| catalogue | main | 5767 | research, reply_to_request, say_briefly, refer_member, react, do_nothing |
| marketplace | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| marketplace | execution | 5731 | search_information, record_task_progress, read_task_sources, read_web_page, market_search, market_enrich, finish_research |
| marketplace | finalization | 5050 | reply_to_request |
| marketplace | main | 5767 | research, reply_to_request, say_briefly, refer_member, react, do_nothing |
| marketplace | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| marketplace | execution | 5731 | search_information, record_task_progress, read_task_sources, read_web_page, market_search, market_enrich, finish_research |
| marketplace | finalization | 5050 | reply_to_request |
| marketplace | main | 5767 | research, reply_to_request, say_briefly, refer_member, react, do_nothing |
| marketplace | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| marketplace | execution | 5731 | search_information, record_task_progress, read_task_sources, read_web_page, market_search, market_enrich, finish_research |
| marketplace | finalization | 5050 | reply_to_request |
| marketplace | main | 5767 | research, reply_to_request, say_briefly, refer_member, react, do_nothing |
| health_access | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| health_access | execution | 5409 | search_information, record_task_progress, read_task_sources, read_web_page, finish_research |
| health_access | finalization | 5050 | reply_to_request |
| health_access | main | 5767 | research, reply_to_request, say_briefly, refer_member, react, do_nothing |
| official | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| official | execution | 5228 | search_information, record_task_progress, read_task_sources, read_web_page, finish_research |
| official | finalization | 5050 | reply_to_request |
| official | main | 5767 | research, reply_to_request, say_briefly, refer_member, react, do_nothing |
| lifestyle | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| lifestyle | execution | 5437 | search_information, record_task_progress, read_task_sources, read_web_page, xhs_search, xhs_read_notes, finish_research |
| lifestyle | finalization | 5050 | reply_to_request |
| lifestyle | main | 5767 | research, reply_to_request, say_briefly, refer_member, react, do_nothing |
| information | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| information | execution | 5226 | search_information, record_task_progress, read_task_sources, read_web_page, finish_research |
| information | finalization | 5050 | reply_to_request |
| information | main | 5767 | research, reply_to_request, say_briefly, refer_member, react, do_nothing |
| unsupported | planning | 4935 | start_task, update_task, clarify_task, acknowledge_task |
| unsupported | execution | 1791 | finish_research |
| unsupported | finalization | 4039 | react, do_nothing |
| unsupported | main | 5697 | research, say_briefly, refer_member, react, do_nothing |

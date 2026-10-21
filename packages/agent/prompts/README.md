# prompts/voice

写给群友读的那一层，中文散文，运行时由 `src/prompts/voice.ts` 整段读入，只注入会写消息的阶段（research、write、legacy），并放在系统指令最后。

- `soul.md` 气质：A2H 怎么待人。不放事实示例、搜索步骤、工具名或业务案例。
- `chat-line.md` 群聊发言规范：那句话（`text`）和证据卡（`details`）各写什么、多长。回复长度的规则只在这里出现一次。

整体架构、阶段矩阵和审计方法见 [`src/prompts/README.md`](../src/prompts/README.md)。

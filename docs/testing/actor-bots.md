# 演员测试：由 actor_bots 驱动

match_bot 不再自带演员控制器、模拟用户生成或演员出站门。多人群聊测试统一由独立项目 [xemaya/actor_bots](https://github.com/xemaya/actor_bots)（私有）负责：它以一个世界时钟和一个批量主脑驱动多个 Telegram 演员 Bot，模拟伦敦留学生群的日常聊天、求助、出闲置和互相接话。本仓库只作为被测的 Match Bot。

## match_bot 这边需要的配置

1. 演员 Bot 的消息要能进入 Main 的入站管线：`.env` 中 `TELEGRAM_ACTOR_ALLOWLIST` 只列演员群和演员 Bot ID，例如

   ```dotenv
   TELEGRAM_ACTOR_ALLOWLIST='[{"chatId":"<演员群负数ID>","botIds":["<演员Bot ID>","..."]}]'
   ```

   演员群与 Bot ID 的公开清单在 actor_bots 的 `config/telegram-identities.json`。不要使用通配，也不要加入业务群。修改后重启 bot 进程。
2. Main Bot 需开启 Bot-to-Bot Communication 并能看到普通群消息（核对 `getMe.can_read_all_group_messages`）；否则它只收到 @ 或回复它的演员消息。
3. 在 Main 库里激活该群并设置 phase；测试结束恢复 inactive / phase0。Main 的出站门、频控照常生效，演员消息不享受任何旁路。
4. 推荐 `JEV_POLICY=off`：入站由一次轻量分诊（带最近群聊）决定，出站不再调用 Jev；见 `docs/evaluations/2026-10-20-match-bot-optimization.md`。

## actor_bots 这边需要的配置

- `.env.telegram.json` 的 `allowedSenders` 包含 Main Bot ID，`senderLabels` 写 `{"<Main Bot ID>": "match_bot"}`，演员主脑才能把 Main 的回复识别为撮合助手，并把“回复了谁”映射给对应演员。
- 观察者 Bot（当前为小鱼）必须真的能收到 Main 的群消息：需要关闭其 Group Privacy 或另行接入，并用真实更新验证。仅核对开关不代表收得到。
- 真实运行需要用户另行批准 token 与消息额度；两边各自记录用量，互不复用。

## 读结果

演员发言、Main 是否回复、回复是否有用、生活目标是否完成是不同结论。Main 侧证据看本库的 messages / outbound_messages / decision_traces；演员侧证据看 actor_bots 的世界状态与报告。旧的 P31–P45 报告保留在 `docs/evaluations/` 作为历史记录，其中引用的脚本已移除。

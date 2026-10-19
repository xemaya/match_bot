# Telegram 现有测试群：另一台机器接手

测试群和 Bot 已建立并完成真实多轮测试，不需要重新注册账号或新建群。身份配置以 [manifest](telegram-lab.manifest.json) 为准；这里不保存真人手机号、验证码、Telegram session、Bot token 或模型 key。

## 现有群和账号

群名：**A2H 多用户测试群 1018**；chat ID：`-5372476536`。

| 用途 | Telegram 账号 | Bot API user ID | role |
| --- | --- | --- | --- |
| 主 Bot | [@london_match_bot](https://t.me/london_match_bot) | `8919809920` | Match Bot |
| 小林，短句补条件 | [@a2h_lab_xiaolin_261018_bot](https://t.me/a2h_lab_xiaolin_261018_bot) | `8767318152` | `short` |
| 小周，改条件 | [@a2h_lab_xiaozhou_261018_bot](https://t.me/a2h_lab_xiaozhou_261018_bot) | `8901079318` | `changes` |
| 阿明，独立需求 | [@a2h_lab_aming_261018_bot](https://t.me/a2h_lab_aming_261018_bot) | `8795550864` | `interruption` |

真人使用当前已经加入该群的 Telegram 账号登录即可查看聊天。BotFather 管理则需要拥有这些 bot 的账号；若 `/mybots` 看不到它们，登录同一个群成员账号也不会自动获得所有权，不能据群成员身份推断 bot 所有者。仓库不记录或猜测具体真人手机号/用户名，也不迁移浏览器登录态。

2026-10-19 的真实批次已验证上述身份和群名。主 Bot 开启 Bot-to-Bot Communication，且能看普通群消息；三个演员保留 Group Privacy，仅消费绑定自己的回复。新机器先做 `--check`，无需为了迁移扩大演员群权限。

**最新结束状态：测试群 inactive / phase0，没有自动监听测试任务在跑。** 同号登录后能看到群和历史，但停用状态下直接发测试问题不一定得到 Main 回复。自动回归控制器核对身份后会临时激活这个群，结束恢复停用；不要把群一直开成 phase2。

## 已提交的方案与结果

- [P45 场景](../../scripts/poc/p45-persona-telegram/cases.json)：三个账号各两轮，GP、打印机、亲子看展；演员第二轮根据真实回复生成，不是预置答案。
- [真实控制器](../../scripts/poc/p45-persona-telegram/live.mts)：`--plan` 默认不读凭证、不联网、不发消息；`--run` 才发送，Main 版本锁定 0.30.0。
- [只读观察器](../../scripts/poc/p45-persona-telegram/observe.mts)：仅查询该批次测试群及白名单合成用户。
- [0.30.0 人感报告](../evaluations/2026-10-19-persona-telegram-regression.md)及其 JSON：6 条都回复，394200 生成 token；报告保留失败及人感问题，不把收到答案算作任务完成。
- [五类生活需求场景](../../scripts/poc/p33-live-multiturn/cases.json)：含租房、搭子等。对应历史 run 脚本有旧版本锁，不能不看版本就直接跑。

上一批 6 个消息槽已全部用完。迁移配置、登录或 `--check` 不代表获准新增模型调用/演员消息；下一轮要先有用户给定的新预算和条数。

## 同号登录能做什么

1. 查看测试群和历史对话：直接同号登录 Telegram，搜索群名；不需要 token。
2. 继续使用当前执行机跑自动测试：保留当前 Main/数据库/Redis/控制器在原机器运行，在有权限的终端或 SSH 上操作原仓库，另一台机器的 Telegram 只用于观察。这样不用在另一台机器保存 bot/model 凭证，也不用搬运行数据库。
3. 把自动测试完整搬到另一台机器：需要下述私有配置和本地服务。Telegram 用户登录不会提供 Bot API token、模型 key 或数据库访问，所以单靠同号登录无法启动自动演员。[Telegram 官方教程](https://core.telegram.org/bots/tutorial#obtain-your-bot-token)也明确区分 bot token 与个人账号鉴权。

## 完整迁移准备

先拉最新 main，Node >=22.12、pnpm 11，运行 `pnpm install --frozen-lockfile`、`pnpm db:generate`。无需新建 Telegram 群或重新邀请 bot。

### 私有文件

从原机器仓库，通过自己控制的 SSH/scp、AirDrop 等私密通道复制：

- `.env`：Main token、生成/搜索/Jev/Sandbase 凭据、SNAPSHOT_KEY、数据库及 Redis 配置。
- 本机 `ACTOR_LAB_CONFIG_PATH` 指向的 `.env.actor-lab/config.json`：三个演员 token 和独立控制库地址。复制到新仓库后可改名为 `.env.actor-lab.json`，同时把新机 `.env` 的 `ACTOR_LAB_CONFIG_PATH` 改成该相对路径，不能保留原机绝对路径。

这些文件均被 `.gitignore` 排除，不能放 GitHub issue、PR、聊天、命令行参数或报告中。复制后执行 `chmod 600 .env .env.actor-lab.json`。不复制 Telegram 用户的浏览器 profile 或 session。

如不能复制私有 JSON，用 [已有群专用模板](actor-lab.existing-group.example.json) 建立 `.env.actor-lab.json`，在私有编辑器中为每个 actor 填 token。登录拥有 bot 的 Telegram 账号，打开官方 [@BotFather](https://t.me/BotFather)，`/mybots` 选择对应账号并查看 API Token；不要为了查看 token 点 Revoke。模板 token 占位符不能直接运行。主 Bot token 放 `.env` 的 `TELEGRAM_BOT_TOKEN`。

确认 `.env` 有以下非秘密值（实际 key 仍只放本机私有文件）：

```dotenv
ACTOR_LAB_CONFIG_PATH=.env.actor-lab.json
TELEGRAM_ACTOR_ALLOWLIST='[{"chatId":"-5372476536","botIds":["8795550864","8901079318","8767318152"]}]'
DEEPSEEK_MODEL=gpt-6.1-sol
GENERATION_REASONING_EFFORT=low
JEV_POLICY=strict
XHS_RESEARCH_ENABLED=true
INFORMATION_SEARCH_PROVIDER=deepseek
DEFAULT_PHASE=0
OUTBOUND_UNSURE_ACTION=drop
```

生成 `DEEPSEEK_BASE_URL` 与 key 沿用原机器已验证的自定义地址；`DEEPSEEK_SEARCH_API_KEY` 是独立的 DeepSeek 搜索 key，不要把生成服务的 key 填给搜索服务。不要直接用 `.env.example` 的旧模型/targeted 默认冒充本轮配置。普通网络保留 `PAGE_DNS_MODE=system`；仅本机 VPN 映射保留 IP 导致读页失败时采用已验证的 `https` 模式。

本例只含本测试群和三个演员的精确白名单。不要用通配 bot ID 或扩大到业务群。

### 数据库与执行权

使用独立本地 Postgres/Redis；更新私有 `.env` 和 JSON 中的主机/端口，不照搬原机器绝对路径。`controlDatabaseUrl` 必须是 loopback 的 `matchbot_actor_lab`，不可指向 Main 库。新机不需要拷贝真实聊天、旧解密快照或完整历史数据库；空库迁移后是新合成任务基线，因此和旧报告不能冒充严格配对 A/B。

使用仓库默认 compose 时可以这样准备两个库（已有库时不要覆盖或重建）：

```sh
pnpm infra:up
# 仅新机首次、库不存在时创建
# 若本机已使用其他端口/服务，先修改下面的连接与容器选择
# --user 指定的是 PostgreSQL 用户，与 Telegram 账号无关
docker compose exec -T postgres createdb --username=matchbot matchbot_actor_lab
set -a && . ./.env && set +a
pnpm --filter @matchbot/db exec prisma migrate deploy
DATABASE_URL=postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_actor_lab pnpm --filter @matchbot/db exec prisma migrate deploy
pnpm build
```

上面的控制库地址仅适用于默认本地 compose 用户/密码/端口；自定义连接使用私有 JSON 的实际地址，不要把带凭据的连接打印或贴到聊天。P45 控制器还读取 `logs/actor-lab/cumulative-budget.json`；新机空目录初始化为 `{"cumulativeTokens":0}`，这里只表示该新机历史观察起点，不能覆盖已有用量。

```sh
mkdir -p logs/actor-lab
# 仅文件不存在时初始化，已有记录不覆盖
(umask 077; set -C; printf '%s\n' '{"cumulativeTokens":0}' > logs/actor-lab/cumulative-budget.json)
```

**同一 Main token 只能有一个 getUpdates 轮询；每个演员也只能有一个控制器轮询。** 迁移执行权前，在原机确认无在途请求、待发和待审批，再停止原 Main bot/worker 与 controller；避免两台同时启动造成 Telegram 409、回复或用量分散到不同数据库。原机常驻方式见 [launchd 部署说明](../../deploy/local/README.md)。不要仅关闭 Telegram 网页，就以为原机后台进程已停止。

新机准备好后，选择现有部署方式启动一套 Main bot 和 worker。macOS 可使用 `./deploy/local/install.sh --build`；其他系统可分别用仓库 `pnpm --filter @matchbot/bot start` 和 `pnpm --filter @matchbot/worker start`，在加载 `.env` 的 shell 中运行。不要同时再开 `dev:bot`。

## 验证与下一轮执行

从仓库根目录执行：

```sh
node --import tsx scripts/poc/p45-persona-telegram/live.mts --plan
set -a && . ./.env && set +a
node --import tsx apps/bot/src/actor-lab.ts --check
```

`--check` 调用 Telegram 身份/群/成员 API，不发送消息、不调用生成模型，但需要正确的私有配置和网络。成功只证明身份及权限检查通过；新机真正的送达还要下一轮经授权的真实消息证明。

得到新预算后，在原机控制器已退出、群/演员身份核对成功的前提下运行：

```sh
# 用下一轮实际批准的预算和消息条数替换占位符，不沿用已耗尽的历史授权
node --import tsx scripts/poc/p45-persona-telegram/live.mts --run <已批准生成token数> <已批准消息条数>
```

P45 当前版本上限 500000 / 6，每场最多两条，保留 100000 token 观察余量；Main 升级后会主动拒绝旧版本，需要先审查新版本对应测试入口。不要删除版本保护强行跑。

只读观察命令使用实际批次 UUID：

```sh
node --import tsx scripts/poc/p45-persona-telegram/observe.mts logs/p45/live-<实际批次UUID> --answers
```

控制器默认结束后停用本测试群；中断时 Ctrl+C 或测试群 `/stoptest`，等待在途执行结束后检查 inactive/phase0 和队列/待发状态。进程崩溃时也要核对，不能仅凭关闭终端推定收尾完成。完整安全边界见 [演员测试说明](telegram-actor-lab.md)。

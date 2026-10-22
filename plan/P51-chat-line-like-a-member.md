# P51 那句话像群里的人：排序 1–5 的改法

状态：完成（2026-10-22 合入 main `2d861b9`，收尾见文末）。负责人 claude。依赖：P50 回路（r3-rec 六个冻结案例）、0.34.0 工作树。范围 `packages/agent`（voice、policy、stages、tools 文本与 reply_to_request 的门与渲染）、`apps/worker/src/pipeline/inbound.ts` 一行、`packages/eval` 不动。

用户决定（2026-10-22）：按 2026-10-21 多代理评审的排序 1–5 改，每改一项用 `pnpm humanness` 回路出数，不进群。排序 6（规划包补 triage reason）与 7（显示名）不在本包。

## 改法（对应评审排序）

1. **那句话的形状**：chat-line.md 改成"一条只说一件事、一两句、30–60 字、一个价一个地名、写镑不写 £、不报区间"；工具参数说明同步；群聊硬门 150 字 3 行 → 90 字（CJK 折算：汉字 1、拉丁串每 2 字符 1）2 行；新门 `tooManyNumbers`（群聊 text 裸数字 >2 或 £/镑 >1 退回）。
2. **不汇报检索、不派核实**：soul 与 chat-line 去掉"说卡在哪一步""只提那一个未知"的槽位，改为"没有就说没有，不说查的过程"；收尾协议删"research summary and unresolved conditions / unresearched condition / distinguish answer, partial…"；DELIVERY 规则去重，只留 FACT 一处"只披露影响决定的不确定"；工具 no_match 说明改口；exhaustedZh 改"这个我没找到"；新门 `reportsSearch`（群聊 text+details 命中 没查到|没刷到|没找到|目录|公开页面|我这边没|得你…确认 退回）。
3. **打字像群里的人**：soul 末行禁令改为正面描述（短句、空格断句、可带哈/吧/hh、可反问），"遇到着急的人"改为"先半句接住"，删"不强行共情"；chat-line 第 9 条从许可改祈使（空格断句、不用句号冒号分号破折号、£ 写镑），加"语气跟 groupConversation 走、事实只来自证据"，末尾 4 条接话片段；research 协议加一句 groupConversation 也是语域；兜底门 `chatLineRegister`（群聊 text ≥2 个"。"或含"："退回）。
4. **卡是例外**：群聊 details 为空时不出卡（来源 refs 仍进 gate trace）；有卡时链接 ≤2、非中文长标题改域名；市场场景群聊只渲染 primary 候选（无 primary 才渲染 backup）；chat-line 与工具说明把 details 收窄到"两个来源对推荐那家说法不一致"；新门 `detailsRepeatsLine`（details 与 text 汉字 2-gram 重合 >30% 或含 只招|不符合|不在你|排除 退回）。
5. **冷却 bug**：`inbound.ts` 冷却查询改用 Telegram id（`msg.userId`），与 `mention_user_id` 列同一 id 空间；更新测试。

## 任务清单

- [x] T1 工作包与看板行。
- [x] T2 提示词五处（soul、chat-line、tools/reply-to-request 文本、stages/write、policy/rules、stages/research）。
- [x] T3 reply_to_request：CJK 折算长度门 90/2、`tooManyNumbers`、`reportsSearch`、`chatLineRegister`、`detailsRepeatsLine`；群聊无 details 不出卡；链接 ≤2 与域名标签；市场只渲 primary。
- [x] T4 inbound 冷却 id 修复与测试。
- [x] T5 测试更新与新增；`pnpm prompt:audit` 预算内并重生成 docs/prompts。
- [x] T6 回路：`replay r3-rec --n 3` → `judge` → `compare r3-rec`，逐项记录；AGENT_VERSION 0.35.0。
- [x] T7 `pnpm build && pnpm check`；完成记录。

## 验收标准

1. 回放 r3-rec（6 案例 ×3 采样）那句话：长度中位数 ≤80、无一条 >100；"。：；—"均值 ≤0.5；裸数字均值 ≤2、£ 0；检索汇报词 0；语气词 ≥4/6 条；带卡 ≤2/6；链接 ≤2。
2. 判官：均分 ≥3.5/5（基线 2.83），盲判命中率 <1.0 或 bot 均值 <70（基线 92）。
3. 回放 recorded ≥5/6，每条退稿 ≤2：门不能把模型逼死。
4. 既有安全契约与事实校验（unsupportedNumbers、completeFit、conflict 等）不变仍通过；评测回放 precision / recall 不低于 P49。
5. `pnpm check` 全绿（db 基线 3 个除外）；三处预算不高于 P37。

## 完成记录（2026-10-22）

**做了什么。**

- 提示词：chat-line.md 重写为"一条只说一件事、两三个事实、一个价一个地名、写镑、空格断句、句尾多半带个哈或吧、不说没查到/没刷到/这边没看到/目录/我这边/得你确认、不替全群总结谁没回"，加四条接话口气（有答案 / 没找到 / 别人已答 / 问价），details 收窄到"两个来源说法不一致"；soul.md 把"遇到着急的人"改为"先半句接一下，每次换个说法"，末行禁令改为正面的打字描述；收尾协议删"research summary and unresolved conditions / unresearched condition / distinguish answer, partial…"；DELIVERY 规则去掉两处"那一个未知"；research 协议加一句 groupConversation 也是语域；工具 description / params / 反馈同步，exhaustedZh 改"这个我没找到"。
- reply_to_request 新门（都先说改法）：群聊长度 90 字（CJK 折算）2 行、`chatLineRegister`（≥2 个"。"或含"："）、`tooManyNumbers`（裸数字 >2 或 £/镑 >1）、`reportsSearch`（text+details 命中检索汇报词）、`detailsRepeatsLine`（group details 必须含来源冲突标记，且不含没写/得问/确认/只招/赶不上等）、`unsupportedFeature`（wifi / 包bill 这类特性必须出现在所引帖子里，问句不算断言）。群聊无 details 不出卡；有卡链接 ≤2、长英文标题改域名；市场场景群聊只渲染一条 primary（无则一条 backup）。
- inbound 冷却查询改用 Telegram id（与 `mention_user_id` 同一 id 空间），测试同步。
- AGENT_VERSION 0.35.0；`docs/prompts/` 重生成；预算：执行 × marketplace 7980、收尾 5113。

**回路记录（r3-rec 六案例 × 3 采样，判官 gpt-6.1-sol）。**

| 轮 | 变化 | 长度中位数 | 重标点 | £ | 检索汇报 | 语气词 | 带卡 | 退稿 | 判官均分 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| r3-rec 基线 | — | 125 | 2.8 | 2 | 2 | 0/6 | 6/6 | — | 2.83 |
| try1 | 排序 1–5 全部 | 59 | 0 | 0 | 0 | 0/18 | 10/18 | 0 | 4.24 |
| try2 | details 加 hedge 门、市场只渲一条、"句尾多半带哈" | 59 | 0 | 0 | 0 | 7/18 | 8/18 | 7×1 | 4.06 |
| try3 | 特性证据门、"两三个事实"、改"没找到"范例 | 56 | 0 | 0 | 0 | 0/18 | 11/18 | 6 | 3.78 |
| try4 | 范例去掉"这边没人出"、soul 去掉可照抄的安抚句 | 54 | 0 | 0 | 0 | 3/18 | 7/18 | 8 | 3.72 |
| try5 | details 必须含来源冲突标记 | 59.5 | 0 | 0 | 0 | 0/18 | 6/18 | 10 | 4.33 |

try3 / try4 的下滑主要是两类事实问题，不是语气：try2 的"能连wifi"（帖子没写，型号推断）→ 加特性证据门后消失；try4 两条"DLR 到 Canning Town 换 Central line"（录制那轮的证据就这么写，Canning Town 没有 Central line）被判官打 2 分。去掉这两条后 try4 约 3.9。判官盲判命中率五轮都是 1.0（bot 均值 92 → 82）：它仍能从信息组织方式认出 bot，验收第 2 条的第二半没达到，记为未达。

**验证（真实命令）。** `pnpm eval --skip-metrics`：92 条，precision / recall / silenceCorrect 均 1，categoryAccuracy 0.989。`pnpm prompt:audit` 通过。`pnpm build && pnpm check`：typecheck、lint、format 通过，141 文件 1246 项测试 1243 通过，3 个失败是 db 集成基线（共享库残留 outbound 行）。try5 之后只放宽了特性门的对冲豁免（"没有确认无线功能"这类句子不再被拦），没有重跑回放。

**没做 / 要注意。**

- 语气词 0–7/18 不稳定，"句尾多半带个哈或吧"有时被判刻意；不再往这条上加压，留给下一轮实测看群友反应。
- 搬家搭把手这种"找人"的求助，模型只能说"没看到有空的 + 搬家公司行情"，判官仍判汇报；真正的解法是评审排序 7（点名群友）或分诊判为不用答，不在本包。
- Canning Town 换乘错误来自研究阶段证据，收尾改不了；下一轮联合实测前值得在研究阶段加一条路线核验。

## 收尾（2026-10-22，原会话退出后接手）

原会话停在 try5 之后：特性门放宽对冲豁免后没有重跑回放，代码随 0.35.0 一起合入 main（`2d861b9`，同时带着联合第七轮的 `clock.ts` 与 recentReplies）。接手后做了两件事：

1. **用合入的代码重跑回放（p51-final）。** 原来回放用的官方 DeepSeek key 已失效（401），改用第七轮 Match Bot 同款的百炼 `deepseek-v4.1-flash-1017`，所以与 try1–5 不是同一个模型，只与本节的 try6 直接可比。
2. **去掉可照抄的"你问一句"（AGENT_VERSION 0.35.1）。** p51-final 里 18 条有 10 条用"你问一句"（try1 8 条、try5 9 条），判官判"套路句式"。来源是 chat-line.md 的两处范例和 unsupportedFeature 的退稿文字。改法：规则改成"真要对方去问卖家房东的，顺口带半句，每次换个说法"；"有答案"范例换成与回放案例无关、不带追问的一句；退稿文字去掉中文范例。

| 轮 | 模型 | 长度中位数 | 重标点 | 裸数字 | £ | 检索汇报 | 语气词 | 带卡 | 链接最多 | "问一句" | 退稿最多 | 判官均分 | 盲判 | token |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| p51-final | 百炼 flash | 56 | 0 | 0.5 | 0 | 0 | 7/18 | 6/18 | 2 | 10/18 | 0 | 3.67 | 1.0，bot 81 | 134217 |
| try6 | 百炼 flash | 58.5 | 0 | 0.3 | 0 | 0 | 8/18 | 6/18 | 2 | 2/18 | 2 | 3.94 | 1.0，bot 87 | 143929 |

try6 的 11 项可数指标全部达标（p51-final 只差语气词 7/8）。判官对 try6 的扣分：Epping 那条 3 次让已经在群里约人的人"群里喊一声"，其中一次说"伴儿我在群里喊不了"，暴露助手身份（2 分）；找房、打印机各有一两条逐项复述帖子写了什么没写什么（汇报检索）。

**验收对照（以 try6 为准）。** 1：长度、标点、裸数字、£、检索汇报词、带卡、链接都达标；语气词 8/18 折合 2.7/6，低于 ≥4/6。2：均分 3.94 ≥ 3.5 达标；盲判命中率仍 1.0、bot 均值 87，未达。3：18/18 recorded，每条退稿 ≤2，达标。4：安全契约与事实门未改，`pnpm check` 1244 通过（3 个 db 集成基线失败）。5：`pnpm prompt:audit` 通过。

**额度。** 收尾回放共 285,862 生成 token（另有两次单案例探针约 1.6 万未计入表），在用户 2026-10-22 批准的 1000 万联合测试额度内；判官两次走 OPENAIROUTER，用量未计量。

**留给后续。**

- 对方已经在群里约人时，别再叫他去群里喊；不要说自己"在群里喊不了"这类暴露身份的话。属于评审排序 7（点名群友）一侧，没在本包继续加压。
- 盲判仍能 100% 认出 bot：信息组织方式（地点+价+时间+一个追问）本身就是指纹，单靠收尾措辞压不下去。
- 语气词稳定在 7–8/18，不再加压。

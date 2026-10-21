# 跨包接口契约

> 所有工作包以本文件为准。改签名先改这里。类型省略 import；`Prisma` 类型来自 `@matchbot/db` 的 generated client。

## @matchbot/shared

```ts
loadEnv(source?: Record<string, string | undefined>): Env          // 已有
createLogger(name: string, level?: string): Logger                  // 已有，redact text/phone
normalizePostcode(raw: string): { full: string; outward: string } | null   // 已有
hashText(text: string): string                                      // P1：sha256 hex
```

## @matchbot/domain

```ts
// 已有
inboundMessageSchema / InboundMessage      // { channel, chatId, messageId, userId, text, lang?, replyToMessageId?, addressedToBot?, replyToBotText?, receivedAt }（后两者 P15：回复 bot / @bot / 私聊为 addressed；replyToBotText 是被回复的 bot 消息原文）
DEMAND_CATEGORIES / DemandCategory / SERVICE_CATEGORIES
DEMAND_STATUSES / DemandStatus / canTransition / transition / IllegalTransitionError
PHASES / Phase

// P1 新增
isServiceCategory(c: DemandCategory): boolean
demandDraftSchema / DemandDraft   // { category, whenText?, whenAt?(ISO), fromPostcode?, toPostcode?, quantity?, budgetPence?, lang?, confidence }
supplyDraftSchema / SupplyDraft   // { category, availability?, area?, expiresAt(ISO) }
// recommendation 的 text 支持编号标题与来源链接行；Telegram 按 P14 文末契约转换为 bold / text_link 实体（2026-10-10）。
outboundDraftSchema / OutboundDraft // { channel, target, text, toolCallId?, kind?, replyToMessageId?, mentionUserId? }（kind ∈ OUTBOUND_KINDS（含 reaction：text 为 emoji，replyToMessageId 为被加表情的消息），缺省 recommendation；后两者为渠道侧 id，2026-09-23 加）
TRACE_KINDS / TraceKind           // 'rule' | 'jev' | 'agent_run' | 'gate'
decisionTraceInputSchema / DecisionTraceInput // { kind, inputRef, output: unknown, phase, latencyMs, costMicro? }
INBOUND_QUESTION_IDS = ['is_demand','is_supply','category','urgency','has_location','is_sensitive','is_move_event'] as const
OUTBOUND_QUESTION_IDS = ['worth_replying','language_ok','mentions_unverified'] as const
```

## @matchbot/db

```ts
getPrisma(connectionString): PrismaClient        // 已有
createRepositories(prisma: PrismaClient): Repositories   // P2

interface Repositories {
  users: {
    upsertByExternal(p: { channel: Channel; externalId: string; lang?: string }): Promise<User>;
    findById(id: string): Promise<User | null>;
  };
  groups: {
    findByExternal(channel: Channel, externalId: string): Promise<Group | null>;
    upsert(p: { channel: Channel; externalId: string; name: string }): Promise<Group>;
  };
  messages: {
    findExisting(p: { groupId: string | null; userId: string; externalId: string }): Promise<Message | null>;   // 队列重投去重；私聊按 userId 查（NULL 不触发 unique）
    create(p: { groupId: string | null; userId: string; externalId: string; text: string; lang?: string; receivedAt: Date }): Promise<Message>;
    recentByUser(userId: string, sinceHours: number): Promise<Message[]>;
    redactOlderThan(days: number): Promise<number>;             // 置空 text，返回条数
  };
  demands: {
    findOpenByUser(userId: string): Promise<Demand[]>;
    create(p: DemandDraft & { userId: string; sourceMessageId: string; isMoveEvent?: boolean }): Promise<Demand>;
    update(id: string, patch: Partial<DemandDraft> & { sourceMessageId?: string }): Promise<Demand>;
    setStatus(id: string, status: DemandStatus): Promise<Demand>;   // 内部用 domain.transition 校验
    expireOlderThan(days: number): Promise<number>;
  };
  supplies: {
    create(p: SupplyDraft & { userId: string; groupId: string; sourceMessageId: string }): Promise<Supply>;
    findActive(category: DemandCategory): Promise<Supply[]>;
  };
  suppliers: {
    findCandidates(p: { category: DemandCategory; pool?: 'A' | 'B' }): Promise<Supplier[]>;
    findByIds(ids: string[]): Promise<Supplier[]>;
  };
  matches: {
    replaceForDemand(demandId: string, rows: Array<{ supplierId?: string; supplyId?: string; matcherScore: number; jevFit?: number; rank: number }>): Promise<Match[]>;
  };
  leads: {
    create(p: { matchId: string; sentVia: Channel; sentAt: Date }): Promise<Lead>;
    update(id: string, patch: { supplierResponse?: string; isConverted?: boolean; isPaid?: boolean; followedUpAt?: Date }): Promise<Lead>;
  };
  sessionItems: {
    list(userId: string, limit?: number): Promise<unknown[]>;      // 按 seq 升序返回 item
    append(userId: string, items: unknown[], operationId?: string): Promise<void>;   // operationId 重复则 no-op
    popLast(userId: string): Promise<unknown | null>;
    clear(userId: string): Promise<void>;
  };
  runStates: {
    create(p: { userId: string; chatId: string; phase: Phase; snapshot: string; agentVersion: string; sdkVersion: string; interruptions: unknown; expiresAt: Date }): Promise<RunState>;
    findById(id: string): Promise<RunState | null>;
    consume(id: string): Promise<RunState | null>;   // 原子：UPDATE ... WHERE status='pending'；0 行返回 null
    expireOld(now: Date): Promise<number>;
  };   // schema 需加 chat_id、phase 两列（P2 迁移里一起做）
  approvals: {
    create(p: { runStateId: string; reviewer: string; decision: 'approve' | 'reject' | 'edit' | 'ignore'; editedText?: string }): Promise<Approval>;
    findById(id: string): Promise<Approval | null>;
  };
  outbound: {
    create(draft: OutboundDraft, status: OutboundStatus): Promise<OutboundMessage>;
    claimPending(limit: number): Promise<OutboundMessage[]>;       // 取 pending 并不改状态；发送方 markSent/markFailed
    markSent(id: string): Promise<void>;
    markFailed(id: string, error: string): Promise<void>;
    countSentToTargetSince(target: string, since: Date, kind?: OutboundKind): Promise<number>; // 频控传 'recommendation'
  };
  traces: {
    create(input: DecisionTraceInput): Promise<DecisionTrace>;
    listByKind(kind: TraceKind, since: Date, limit?: number): Promise<DecisionTrace[]>;
  };
}
```

## @matchbot/queue

```ts
QUEUE_NAMES                                  // 已有
inboundJobSchema / resumeRunJobSchema / outboundJobSchema   // 已有
inboundJobId(channel, chatId, messageId)     // 已有
createQueues(redisUrl: string): Queues       // P3：{ inbound, resume, outbound, cron } 均为 bullmq Queue
enqueueInbound(q: Queues, msg: InboundMessage): Promise<void>      // jobId = inboundJobId
enqueueResume(q: Queues, p: { runStateId: string; approvalId: string }): Promise<void>
enqueueOutbound(q: Queues, outboundMessageId: string): Promise<void>
createWorker<T>(name: QueueName, redisUrl: string, handler: (data: T, jobName: string) => Promise<void>, opts?: { concurrency?: number }): Worker   // cron 队列靠 jobName 分派
closeQueues(q: Queues): Promise<void>
```

## @matchbot/jev

```ts
createJevClient(p: { baseUrl: string; apiKey: string; model: string; traces: Repositories['traces']; logger: Logger; fetchImpl?: typeof fetch; timeoutMs?: number }): JevClient

interface JevClient {
  evaluate<Q extends string>(p: { state: unknown; questions: Record<Q, JevQuestion>; inputRef: string; phase: Phase }): Promise<JevOutcome<Q>>;
}
type JevOutcome<Q extends string> =
  | { ok: true; answers: Record<Q, JevAnswer>; usage: { input_tokens: number } }
  | { ok: false; reason: 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' };

// 问题集与解读
inboundQuestions(): Record<InboundQuestionId, JevQuestion>
evaluateInbound(client: JevClient, p: { text: string; groupName: string; lang?: string; recentTexts: string[]; inputRef: string; phase: Phase }): Promise<InboundVerdict | { ok: false; reason: string }>
interface InboundVerdict {
  ok: true;
  isDemand: number; isSupply: number; category: DemandCategory; categoryConfidence: number;
  urgency: number;   // score 0–4 的概率加权均值
  hasLocation: number; isSensitive: number; isMoveEvent: number;
  isLocalRequest: number;   // P14：在找本地商家/店铺/地方，只在 category=other 上使用
}
outboundQuestions(): Record<OutboundQuestionId, JevQuestion>
evaluateOutbound(client: JevClient, p: { draft: string; demand: DemandDraft; supplierSummaries: string[]; recentReplies: string[]; inputRef: string; phase: Phase }): Promise<OutboundVerdict | { ok: false; reason: string }>
interface OutboundVerdict { ok: true; worthReplying: number; languageOk: number; mentionsUnverified: number }
```

## @matchbot/gating

```ts
DEFAULT_THRESHOLDS: Thresholds
interface Thresholds {
  T_IS_DEMAND_ENTER: number;      // 0.7
  T_IS_SUPPLY_ENTER: number;      // 0.7
  T_IS_SENSITIVE_DROP: number;    // 0.5
  T_IS_MOVE_EVENT_TAG: number;    // 0.6
  T_IS_LOCAL_REQUEST_ENTER: number; // 0.8（P14 校准）
  T_WORTH_REPLYING_AUTO: number;  // 2.2（score 0–3）
  T_LANGUAGE_OK_AUTO: number;     // 0.8
  T_MENTIONS_UNVERIFIED_DROP: number; // 0.5
  T_WORTH_REPLYING_DROP: number;  // 1.0
}
resolvePhase(p: { group: Group | null; defaultPhase: Phase }): Phase
decideInbound(v: InboundVerdict, t: Thresholds, opts?: { addressedToBot?: boolean }): InboundDecision   // addressed 且不敏感 → enter_agent kind='followup'
type InboundDecision =
  | { action: 'drop'; reason: 'sensitive' | 'not_demand' }
  | { action: 'tag_move_event' }           // 非服务品类（含 other）且 isMoveEvent 高，仅打标签用于观测
  | { action: 'enter_agent'; category: DemandCategory; kind: 'demand' | 'supply' | 'both' }
decideOutbound(p: { phase: Phase; verdict: OutboundVerdict | null; rateOk: boolean; t: Thresholds; onUnsure?: 'review' | 'drop' }): OutboundDecision  // Phase 2 拿不准时的去向，缺省 review；worker 取 env.OUTBOUND_UNSURE_ACTION（默认 drop）
type OutboundDecision = 'dry_run' | 'review' | 'auto' | 'drop'
createRateLimiter(outbound: Repositories['outbound']): { check(p: { target: string; limitPerDay: number; now: Date }): Promise<boolean> }
isBlacklisted(text: string): boolean     // 换汇 / 虚拟币 / 代付 关键词表
```

## @matchbot/matcher

```ts
scoreSuppliers(p: { demand: DemandDraft; suppliers: Supplier[]; now: Date }): ScoredCandidate[]     // 降序
scorePeerSupplies(p: { demand: DemandDraft; supplies: Supply[]; now: Date }): ScoredCandidate[]
interface ScoredCandidate { id: string; kind: 'supplier' | 'supply'; score: number; reasons: string[] }   // score 0–1
```

## @matchbot/websearch（P14）

```ts
createWebSearch(p: { apiKey: string; logger: Logger; fetchImpl?: typeof fetch; pageTimeoutMs?: number }): WebSearch
interface WebSearch { find(p: { need: string; area?: string }): Promise<SearchCandidate[]> }   // 最多 5 条，已核验
interface SearchCandidate { ref: string; name: string; url: string; contact: { phone?: string; whatsapp?: string; instagram?: string }; evidence: 'contact_on_own_site' | 'instagram_profile' }
buildSearchQuery(p: { need: string; area?: string }): string   // 拒绝像个人信息的输入，抛 UnsafeQueryError（Tavily 会留存查询）
```

## @matchbot/channel-telegram

```ts
toInboundMessage(update: Update, p: { botId: number }): InboundMessage | null      // 非文本、非群/私聊、Bot 自己的消息返回 null
createTelegramSender(p: { bot: Bot; logger: Logger }): { send(m: OutboundMessage): Promise<void> }   // target 为 chat id，出错抛 TelegramSendError
createOpsCardSender(p: { bot: Bot; opsChatId: string }): { sendApprovalCard(card: ApprovalCard): Promise<{ messageId: string }> }
createOpsCardSenderFromToken(p: { token: string; opsChatId: string }): ReturnType<typeof createOpsCardSender>   // 给 apps/worker：只发不收，不 start()，不与 apps/bot 的长轮询冲突
interface ApprovalCard { runStateId: string; title: string; draftText: string; supplierLines: string[]; confidence: number }
parseApprovalCallback(data: string): { runStateId: string; decision: 'approve' | 'reject' | 'ignore' } | null   // callback_data 格式 `apv:<runStateId>:<decision>`
```

## @matchbot/agent

```ts
AGENT_VERSION: string                          // 已有，改 instructions/工具描述时递增
createMatchAgent(deps: AgentDeps): { agent: Agent<MatchContext>; runner: Runner }
interface AgentDeps { env: Env; repos: Repositories; jev: JevClient; thresholds: Thresholds; logger: Logger; evaluateOutbound: typeof evaluateOutbound; webSearch?: WebSearch; modelProvider?: ModelProvider }   // webSearch 缺省则库外工具不注册
interface MatchContext { userId: string; chatId: string; groupId: string | null; phase: Phase; sourceMessageId: string; source?: { messageId: string; userId: string }; rateLimitPerDay?: number /* 缺省 = 不限 */; demandId?: string; demand?: DemandDraft; recentReplies: string[]; addressedToBot?: boolean; replyToBotText?: string; supplierSearchEmpty?: boolean; outboundBlocked?: boolean; searchResults?: SearchCandidate[] }  // source 为渠道侧 id，用于回帖 @ 作者与私聊目标；outboundBlocked：出站门拒过一次后本轮不再出站
runInbound(p: { deps: AgentDeps; ctx: MatchContext; input: string }): Promise<RunOutcome>
resumeRun(p: { deps: AgentDeps; runState: RunState; approval: Approval }): Promise<RunOutcome>
type RunOutcome =
  | { kind: 'completed'; toolsCalled: string[] }
  | { kind: 'interrupted'; runStateId: string }
createPgSession(p: { repos: Repositories; userId: string }): Session
```

## @matchbot/approval

```ts
publishApproval(p: { repos: Repositories; cards: ReturnType<typeof createOpsCardSender>; runState: RunState }): Promise<void>
handleApprovalCallback(p: { repos: Repositories; queues: Queues; reviewer: string; data: string }): Promise<'queued' | 'ignored' | 'invalid'>
```

### P14 小红书推荐呈现契约（2026-10-10）

- `reply_with_xhs_notes` 参数从 `{ intro, refs }` 改为 `{ intro, recommendations: [{ ref, name, reason, evidence }] }`。1–3 项，按相关性排序；`name` 必须来自候选标题/正文，`evidence` 必须逐字来自返回的正文节选，ref 不重复。链接只能取候选的原始 URL。
- 出站 `recommendation.text`：空行分项，标题行 `1. <name>`；来源行 `来源：[小红书原文](https://www.xiaohongshu.com/explore/<id>?...) · <author>`，英文对应 `Source: [Xiaohongshu note](...)`。其他行作为普通文本。
- channel-telegram 只对 recommendation 识别编号标题与以上来源行，转换成 Telegram `bold` / `text_link` entities；不设置 parse_mode。原始 URL 的 xsec_token 保留在链接目标，正文只显示标签。加提及后按 UTF-16 重新计算偏移。
- 审批恢复从服务端加密快照还原 xhsNotes、原消息定位与频控上限；校验 run 身份及所有字段。开放需求优先用数据库的最新记录。
- 改动涉及 agent + channel-telegram 的文本契约；未新增出站工具、SDK、依赖或个人数据字段。


### P14 多轮研究与实体推荐契约（2026-10-10，0.9.0本机已启用）

- `XhsSearch.find({ keyword, page?: 1|2, limit?: number, excludeUrls?: string[] })`，每次最多 10 条，正文上限 2000 字；笔记 URL 去重键忽略 token，避免重取详情。
- `xhs_search({ purpose: "discover"|"enrich", queries: [{keyword,page,entity:string|null}] })`；每批 1–3 查询，每轮最多 8 个不同查询/40 篇唯一笔记。发现阶段最多 4 查询，其余留给实体补搜；enrich 的 entity 必须出自已召回正文/标题且包含在关键词中。去重、缓存空结果、固定搜索总预算，模型不得越过出站拒绝重试。
- `MatchContext.xhsQueries` 保存已消耗查询；xhsNotes 编号在 run 内稳定且跨批累积。批工具返回新增笔记的原文段落、预算与总量。段落按真实/转义/Unicode换行切分，单段最多300字符；编号从持久化正文确定性派生，审批快照恢复两者。
- `reply_with_xhs_notes` 转为实体条目：`{intro,recommendations:[{name,aliases,group,summary,reason,sources:[{ref,passages:string[]}],facts:[{label,status,passages:string[]}]}]}`。最多 6 项；同展合并，多帖引用，同帖可支持多个展。xhs_search 返回代码切出的原文段落及稳定编号（xN:pM），模型只选择编号，不复制引文；facts/name/aliases 保持原文校验，已知fact必须选择已引用笔记中的一个原文段落，文本由代码取出、仅去掉展示前缀；不再让模型复制value。未知passages=[]；冲突至少选两篇不同笔记的不同段落。名称只忽略大小写/空白/标点，不翻译、不补词、不跨行拼接，年份仍需匹配。
- 标题 `1. <name>`，分类 `【<group>】`；来源行可有多个 `[小红书原文 N](url)`。链接与标题由代码生成，发送仍只写 outbound 表，经原 needsApproval 门。

- 请求共享串行限速（350ms 间隔，429 Retry-After 退避上限 5s），每个查询总上限 30s，两次尝试后停止；候选详情先按笔记 ID/URL 去重。翻页保留同关键词与筛选条件的 search_id/search_session_id（15min 内存寿命）。
- 当前 0.9.0 对 deepseek-flash 显式传 `providerData.thinking.type=disabled`（SDK ChatCompletions 透传），其他模型不传；非思考模式已在A2H真实生成中通过；XHS证据编号协议单独做完整预览验证。仍由 Jev 出站门判断是否发。


### P16 A2H公开搜索契约（2026-10-10，实施中）

- `createMarketSearch({logger,fetchImpl?}): MarketSearch` 仅 GET 固定 https://a2hmarket.ai/a2h-post/api/v1/public/listings 与 /{id}，无需 cookie/key。`find({keyword,page,tradeType})` 返回 items + hasNext + total + notice（可为空的服务端退让/不完整提示），`detail(id)` 返回同条 listing 的详情。
- `MarketListing` 只含公开 id/title/已脱敏 description/tags/tradeType/status、帖子级 priceDisplay、可用时间与原帖时间、构造的A2H详情 URL 与校验后来源 URL。用户 ID、联系方式、昵称不进入候选。
- `MarketIntent = second_hand | housing | carry | companion`；MatchContext 保存市场候选、查询/详情预算及 intent，服务端加密快照保留 7 天，不新增 DB 个人字段。
- `market_search({plan?,intent,purpose,queries:[{keyword,page,tradeType}]})`：每批至多 3、每 run 8 个不同查询/160 个候选，每页20条均入池；8次均可发现/补搜；去重 id、未知/空/失败也消耗预算。仅 London 有文本证据的活跃候选参与推荐；币种/时区不当作伦敦证据。
- `market_enrich({refs})`：每批至多 4、每 run 至多 8 个候选详情；只认已返回的 ref。同一卖家/房源的字段保持归属，不按物品名合并不同贴主。
- `reply_with_market_results({intro,recommendations:[{ref,name,group,summary,reason,evidence,facts:[{label,value,quote}]}]})`：至多 6 项，facts 引用该 listing 原句；价格/日期/买卖方向由候选字段生成，允许未标价但不能宣称满足预算；转载帖附原始小红书链接并引导原帖确认。
- 入站继续使用 is_local_request：新增主动求二手/房源/帮带/搭子，允许 category=other/housing/second_hand 进入搜索；job 与敏感请求仍不进。is_demand 校准题措辞不变。与 XHS/Tavily 每 run 一个来源，出站仍过原审批/频控/阶段门。

- 真实 API 当前存在 `SELL / BUY / PEER`（搭伴）三种帖方向；ANY 是客户端不传筛选的查询选项。当前用户输入在 `runInbound` 经纯规则 `selectMarketTradeType` 选择对家方向，市场工具执行该方向而不是照抄模型误选，并返回 effectiveTradeType。方向与查询一起进快照，记录独立 gate trace。
- 可用期既可为带时区的 ISO 时间戳，也可为 YYYY-MM-DD；日历日期按伦敦当天含截止日解释。原文独立“已出/已售/已租”等结束标记会拒绝，不能只信过期的 ON_SALE 导入状态。
- 查询结果显式区分 ok/empty/partial/unavailable；API 失败不能解释成全平台无匹配。
- `XHS_RESEARCH_ENABLED` 默认 false：发布只启用A2H新研究；XHS 保留 0.6.0 已验证工具参数协议。新多轮 XHS 代码/测试仍保留，待真实综合通过后才能开关启用，不能因新来源发布而自动启用。

- 0.9.0本机已启用XHS_RESEARCH_ENABLED=true；新环境默认false仍保留显式启用策略。真实Phase0完整预览77.8s，6查询/40篇→6实体，2次综合，1草稿；最终段落换行修复以同批40篇缓存复核通过40.3s。出站仍走原阶段/Jev/频控门。SDK脱敏时，schema错误只保留字段路径/约束反馈给模型，不保存无效参数或新增个人数据。

### P14 Sandbase 小红书传输契约（2026-10-10）

- 小红书客户端替换为Sandbase，工厂/领域候选保持`createXhsSearch`/`XhsSearch`/`XhsNote`。Worker仅由Env.SANDBASE_API_KEY注册此来源，不再使用TIKHUB_API_KEY；模型工具参数、研究预算、快照和出站路径不变。
- `POST https://api.sandbase.ai/v1/api/xiaohongshu/app-v2/search-notes`，JSON keyword/page整数/note_type/sort_type/time_filter及翻页search_id/search_session_id，Bearer鉴权；详情POST同前缀image-note-detail，仅传note_id。
- 同步返回必须status=completed，读取outputs[0].data再校验success=true；搜索items在payload.data，翻页ID在payload外层；详情payload.data是含note_list的数组，必须匹配请求ID。广告/其他卡片跳过，详情失败退回搜索正文；原文链接继续保留搜索返回的xsec_token。
- 仍为每查询30s、每请求最多10s、最多两次尝试和共享350ms限速；401/403等确定性4xx直接结束，429可退避；不打印响应错误正文、鉴权头或key。
- 官方参考：https://blog.sandbase.ai/xiaohongshu-note-research-api/ 。PoC实际核对搜索/详情/翻页，未依赖生成示例中的占位prompt。环境变量只由shared.loadEnv读，本机当前使用权限600、git忽略的.env注入已有SANDBASE_API_KEY；.env必须是可供shell与docker compose读取的字面值配置，禁止写source或命令替换表达式。密钥不进入代码、日志或提交。

### P14 单源退化修复与选择性全文（0.10.0）

- Sandbase XhsSearch.find新增includeDetails?；默认true保留单次旧协议，新研究在readNote端口可用时设false，先只召回卡片。readNote(note)仅从已返回小红书URL取ID，读取匹配ID详情，返回同ref/url并标记isDetailLoaded=true。
- 模型新增只读xhs_read_notes({refs:string[]})，每批1-6、每run最多12个不同全文尝试，失败缓存占预算；共享限速与每次HTTP10s不变，全文批次总30s。ctx.xhsDetailRefs与候选isDetailLoaded在服务端加密审批快照中恢复；不是新增个人数据字段。
- xhs_search按查询独立校验：合法查询继续，不因同批无效/未知实体丢弃；返回被拒index与原因。公开活动名的+允许，电话号码/账号/邮箱/完整邮编守卫保留。
- 最终回复拒绝未读卡片；有两份以上不同全文介绍同一实体时要求合并至少两份。复制正文不算补充资料；同展需保持场馆/日期/届次一致。单源明确标记，正常多源标记综合N篇；max6条目/4来源及3700字符草稿约束不变。泛需求优先3-4个充分描述、多主题的选项，不能为了凑6条缩减成每项单源。

- 多来源正式名关联：主名称/别名仍需在至少一份引用中完整出现；对“艺术家:展名”的其他来源，两部分在同一篇正文中分别出现也能关联，只出现艺术家仍拒绝。
- 泛需求（至少2条发现query）在全文额度未耗尽时要求至少半数、最低2项多源；额度耗尽也不许多源主选项被多数单源填充，应减小选项数并重写intro。完全无多源时允许最多3个明确单源的有限资料结果，不制造第二来源。全文预算耗尽后停止新增搜索。

- 保留ctx.xhsValidatedRecommendations（max6，本轮通过引用校验的条目，沿用server snapshot 7天加密过期），来源更充分的版本不被后续改写覆盖。证据足够或额度耗尽时由代码优先多源主项并限制单源补充；生成与选择一致的intro。缺失/不合格实用字段在额度末尾标为unknown，不展示错误值；主名称/来源/未读卡片仍不允许伪造，未证实的可选别名移除。
- 审批保存最终编译正文outboundPreviews（SDK callId关联），interruptions新增可选draftText，approval优先展示实际拟发文案；恢复后发送审批过的同一正文，旧快照回退兼容原args。未新增出站路径或个人数据类型，沿用现有消息/snapshot保存与过期规则。

- 全文批次超过剩余额度时执行可用部分，budgetLimitedRefs明确未执行的编号，不能因一份额度不足拖掉整批。XHS最终出站成功/门拒绝后由toolUseBehavior直接完成，未通过证据/参数校验仍继续模型修正，SDK审批仍能中断。

### P17 出站修正与媒体说明文字契约（0.10.1）

- 出站参数校验保持原 schema；给模型反馈字段路径/约束，trace 只记录字段路径、错误码和不含参数值的纠错信息。市场校验一次返回所有失败字段，区分原帖发布日期与描述里的活动/交接日期。
- 同一 SDK callId 的失败只记一次；同一出站工具连续三次参数/证据失败后写 outbound_retry/input_retry_limit，拒绝本轮后续出站并结束运行。有效草稿清零；Phase 0/1/2 与 Jev 不可用降级不变。
- Telegram 入站文字取 text ?? caption，按来源读取 entities/caption_entities；无文字的媒体继续忽略，不读取或新增持久化图片字段。
- 平台用户可见名称统一 A2H；推荐仍仅由原出站表与渠道发送路径执行。

### P18 自适应 A2H 搜索补充（2026-10-11，Agent 0.12.0）

- 首次 plan 分开 needs/terms、preferences、requiredTerms/excludeTerms/requiredArea、budget、route、dateRange。只有用户明说的条件保留；技能/租期等不作为独立供给主体。后续只接受源内出现的别名，保留主体与原约束。
- 后验检查返回 met/mismatch/unknown，价格按选择的单品行绑定，地区/路线按供给文本归属；明确冲突拒绝。已有同需求且地区/路线确认的候选时，优先这些候选再考虑未知线索。
- 模型显示最多16个排序视图，额外连续 evidencePassages 暴露长帖后半部主体；候选编号保持稳定，加密快照保留规范后的 plan。
- 使用 plan 时，最终描述只渲染 exact evidence 引文，适配/地点/路线/报价依据由代码计算。模型自由 summary/reason/facts 不出站、不进入评估摘要；旧无 plan 协议仍严格校验全部字段。
- 公共 notice 为不可信源元数据，规范后给模型看，不能当成满足用户全部条件的证明。原文优先于转载活动摘要；明确非新手/中阶以上活动不推荐给初学者。
- 搜索参数错误返回字段反馈，三次失败停止；市场来源推荐成功写出站表后立即结束 run，不额外生成第二份回复。阶段、Jev、频控和出站表不变；无新数据库或个人数据字段。

### P19 A2H选择建议补充（0.13.0）

- 规范后的marketPlan可含essentialPreferences；由原请求区分关键要求与“最好/希望”偏好，沿用加密快照7天保留；不增加模型输入schema必填字段或数据库字段。
- market_search/market_enrich返回choiceHints（首选/备选refs与关键缺口）和researchTasks（先详情、再源内实体名+缺口补搜）。既有8查询/8详情上界不变；已尝试enrich、无预算或无可执行任务时不反复强制补搜。
- 带plan的reply_with_market_results最多3首选+2备选，无首选时最多3备选；确定冲突仍拒绝，未知候选可以和已确认候选分别展示，但不能用未知候选替代已有确认候选。适配/已知风险/同档单品报价排序、同原帖同物品去重，由代码执行并写trace；不同物品/贴主不合并。
- 精确原句、单品价、原帖日期与链接保持事实归属；评分/原文提及不等于真实库存、机器功能或入住/航班可用保证。原门、频控与出站表不变。


### P20 agent 内部出站反馈与评估（0.13.1）

`DraftResult` 的错误分支增加可选 `kind: 'research_required'`。它表示正常的缺口补搜，单独记 `outbound_research` trace，不计入 `outboundInputFailures`；真正 schema/证据错误仍累计三次后终止。

`OutboundDraftInput.evaluationDemand?: DemandDraft` 只由工具内部构造，不开放给模型参数。A2H 推荐使用本轮受原请求约束的 `MarketPlan`（当前品类、分项需求、路线、区域、日期、预算）；没指定的字段不从历史建档继承。旧工具仍默认使用 ctx.demand。该字段不写出站表，不新增 DB/PII 字段；phase、Jev、频控及审批契约不变。


P20真实Telegram补充（0.13.2）：第三次证据纠错时，若部分条目独立合格，则移除不合格条目并对有效子集重新运行全部校验；正常补搜/phase/Jev/频控不变。全无效、schema及公开联系方式错误仍拒绝。market_recommendation_selection增加rejectedRefs，无文本或身份值。


### P22 回答与查证契约

MatchContext增加currentRequest（原输入及本轮评估DemandDraft）、knowledgeSources（公开来源和段落ID）、informationQueries/sourceFailures、answerRecorded。所有出站优先用currentRequest评估，旧开放需求只作接话背景。WebSearch增加可选research(query,domains)返回公开证据，不按商家联系人过滤；XhsSearch增加显式不可用错误，Agent可走官网信息补充。新增reply_to_request为出站tool，复用原needsApproval/gate/出站表，不直接发送。Telegram仅格式化代码生成来源行的https链接，不执行正文Markdown。原API find兼容保留；不新增DB字段/私信/交易路径。


P22兼容与终点：AgentDeps.answerRequests由worker启用，旧注入调用保留原工具行为。新record_request从绑定的本轮需求建内部Demand，不复用其他独立请求的Demand ID。独立请求仍保留用户级session存储，但模型输入排除旧题；明确引用的公开bot回复作为待核实数据注入。现代输入失败达到上界标answerInputExhausted，由受限终点产生代码固定的失败说明，仍走原needsApproval/phase/Jev/频控；真实outboundBlocked永不清除。模糊租金下限/估计标unknown，精确机场出门时刻须由所引官方时刻表支持。


### P23 拒绝后的受控请求状态

Jev出站输入以source_evidence表达供应商、A2H与公开信息来源，replyPurpose区分answer/request_status；旧调用参数supplierSummaries兼容。问题集判定不可靠事实与适配保证，允许明确未知和实用解释。gating增加isVerifiedRequestStatus，仅agent确认notification文本精确等于服务器renderRequestStatus且当前请求可行动、未回复时才为true。代码固定状态可忽略推荐语义分，Jev不可用/phase/频控策略不变，所有分数及状态门留痕。ctx.outboundBlocked不清除，原推荐仍终止；status工具不接收模型文案。未送审阶段由controller调用tool.needsApproval和tool.invoke，不再调用生成模型写失败说明；需审批时保留SDK加密快照/原子恢复路径，isRequestStatusRun随服务端快照恢复。无新DB或PII字段。


### P24 任务领域基础（实施中）

新增domain taskSchema/UserTask（用户、作用域、版本、目标/验收条目、约束来源、证据、待回答问题、投递与用户确认）及assessTaskReadiness、transitionTaskStatus。readiness只代表有据的信息交付，不代表真实生活目标达成；completed/cancelled需受信入站构建的owner用户确认及sourceMessageId，模型工具不能选择actor身份或意图。queued/sent/用户完成分开，已发问题才waiting_user；同目标证据绑定、未知/冲突不作supported。新任务契约独立于旧Demand兼容，尚未接入worker/SDK/出站，不改变当前线上行为。DB接口、迁移与任务关联随后在本节补充；旧数据不猜测归属。

P24基础接口（分支验证中）：

- `selectTask`先过滤owner/channel/chat及终态；新意图、明确引用、唯一接话、歧义及无可关联目标分别返回结果。不按最近任务盲接，语义意图由调用方判定，尚未实现入站自动路由。
- `reviseTaskRequirements`只合并指定goal/constraint，不能传入证据状态或用户完成状态；每项变更必须引用当前用户消息中存在的原句，origin由服务端写入。原句存在只证明出处，不自动证明模型解释正确，P25真实多轮仍须评判。条件改变递增requirementsVersion并作废旧适配证据，其他分项条件保留。
- `confirmTaskGoal`与整个任务完成分开；本人明确确认一件已买到，不关闭其他子目标，不伪造其来源已核实。`revision`记录操作，`requirementsVersion`仅记录条件变化，不能混作出站授权版本。
- `repos.tasks.{create,findById,findOpenByScope,reviseRequirements,confirmGoal,transition}`均需要受信`access={userId,scope:{channel,chatId}}`。写入带expectedRevision/operationKey，返回applied/replayed/conflict/not_found；相同幂等键不同载荷报错。Task头及事件checkpoint为一个Prisma嵌套写入。sourceMessageId必须归本人及同作用域；不得让模型选择access/actor或传整份状态覆盖。
- 新迁移`20261016170253_task_foundation`只加tasks/task_events及TaskStatus，不改旧业务表语义。Task.state经domain taskPayloadSchema校验，只存可变部分；身份/作用域/版本以列为准。30天无用户活动后deleteInactiveBefore删除task及级联事件，由worker的delete_inactive_tasks清理任务执行；不因agent运行刷新保留期。
- `MatchContext.task`仅接收服务端选中并更新后的任务，`channel`用于scope检查。`bindCurrentRequest`能将其未解决目标、当前条件和简短补充绑定成评估输入，排除已完成分项及内部ID；SDK stub已验证能进入模型instructions。worker尚未加载task，真实语义路由、追问送达绑定、证据落账及快照版本核对仍属P25/P26，不能宣称线上接话已修复。

P25实施接口：`tasks.applyUserTurn`将一条本人消息的条件补丁和已验证的结果确认作为一次CAS/事件写入，避免改了一半条件后确认失败留下半轮状态。确认语义由agent内的受约束整理步骤结合本人原话提出并校验，仓储仍验证来源身份/作用域，actor由服务端组装，不接受模型传入。taskRequests装配开关仅在完整任务流程验证后启用；原供应商/搜索/出站门继续复用。

真实DeepSeek准备阶段首轮预览发现：预算key漂移、旧验收label保留旧金额、住房补充提议失败、无已发问题锚点时半小时追问被判歧义。因此P25补充契约：核心constraint key在tool输入受约束（自定义需求用custom:命名空间），criterion新增constraintKey可绑定同目标或共享条件；服务器为当前条件补齐绑定验收，并使用参数无关的label，避免模型改预算时遗留旧金额。依然保留当前用户原句验证，不把模型解释当作已核实来源；未通过预览保留，不计为多轮验收通过。

P25准备协议现为start_task/update_task/clarify_task/acknowledge_task四个内部工具，均无出站路径，更新为平铺goals/constraints且条件更新不重传旧计划。tasks.create可由服务端传counterparty=supply/demand/peer/null，落在已有state JSON；模型工具无此字段，旧Task默认null。marketPlan.needs新增可选rules（完整的逐目标有效规则），避免共享预算覆盖特例、一个物品的必要条件套到另一个。审批快照规则schema及恢复保留rules；Task本体及最新版本核对仍待P26完成。Task/user/goal完成与信息入队/送达仍分开。

P25来源进展契约（实施中）：Task.nextStep记录动作/责任方/缺口，TaskEvidence可记录具体entityKey及公开https链接。recordTaskProgress只更新来源验收和下一步，不能完成生活目标；同一个goal的硬条件需有共同候选实体，用户情境事实不当作具体供给的证据。来源等待须有实际失败，等待用户只能由送达回执建立。tasks.recordProgress沿用作用域、版本CAS和单事件写入，不接受模型伪造来源快照；agent先按本轮工具返回内容验证ref/原句/实体再提交。

TaskCriterion.conflictingEvidenceRefs可保留同一条件下其他候选的反证，与整体supported及其支持出处并存；实际展示按具体来源判断，不让后读的坏候选覆盖好候选。条件改动同时作废两类判断，但保留历史摘录用于有界复查。sourceCoherence及证据判定字段均不在规划提议schema内。JevClient.evaluate可接收服务端deadlineAt限制网络超时和429重试；不能把截止时间放进模型自选参数，也不能因为超时或trace写入失败自动放行出站。

0.16.5：模型标unknown而提供原句时可以核验正反两种来源假设；双通过或均未通过仍unknown，不将任意未知自动升级。无constraintKey的主体检查由服务器统一为来源层面的对象识别，其余用户验收条件须有constraint绑定，不能把真实世界结果混成单帖信息条件。travel_origin只证明用户给出的出发地点，来源kind=user_statement，不证明行程耗时或提供方条件。

P26投递契约：OutboundDraft新增可选phase，由executeOutbound从可信ctx填充，旧缺省0行保持待核对。outbound.claimPending(limit,{now?,leaseMs?})原子转sending并返回leaseToken；beginSend({id,leaseToken,now?})在HTTP前设起点并拒绝过期/旧令牌。markSent改收{id,leaseToken,externalMessageId,now?}，普通消息须有数字消息编号、reaction为null；可确认同令牌delivery_unknown或重复回执。markFailed改收{id,leaseToken,deliveryState:'not_sent'|'unknown',errorCode,retryAt?,now?}，仅明确未发送且未超尝试预算的可延后重试。recoverExpiredClaims对未开始者安全重排，已开始者保持不确定；变更与trace同事务。sender.send必须传beforeSend回调，返回message/reaction回执或not_started，异常只带标准错误码/发送确定性。后续Task/审批关联不得绕开此路径。

P26请求执行与审批补投：消息在Redis前持久接受，executionKey非空才进入可恢复协议；旧消息不猜测重放。executions.claim返回用户租约与递增fence，repos.forExecution在短事务中验证所有业务读写，旧执行不能写Task/Session/出站；工具批次后保存加密checkpoint。approvals.decide以同事务写条件consume、决定和resumeStatus意图，markEnqueued只在Redis接受后更新；dispatchable补投accepted或租约过期的running。claimResume与入站共用用户租约，按原Message/Task/条件版本恢复；worker拒绝无原消息的新协议恢复、旧Agent/SDK版本及过期状态。没有resumeStatus的旧审批不自动投递。

P26任务送达契约：OutboundDraft.taskDelivery仅为服务端元数据，需要execution、同owner/channel/chat、有效Task/requirementsVersion，模型工具schema没有该字段。复用outbound_messages新增可空taskId/taskRequirementsVersion及Task.delivery.outboundMessageId。pending与Task的拟发状态/拟发问题同事务；Phase0只保留dry_run关联，不建立已送达或等待用户。markSent、markFailed终态与recoverExpiredClaims不确定终态在同事务回写当前Task；安全重试保持queued。回执只作用于同条件版本、同outboundMessageId的当前投递，不能覆盖新轮次或关闭用户生活目标。

Task新owner消息通过beginTaskUserTurn清理旧拟发/问题/下一步，条件与来源保留；即使conditions未变，也不能继续发旧答复。beginSend复核当前Task投递、条件版本及终态；旧发送停止。审批恢复也核对最新user_turn来源消息，拒绝被新轮次取代的同条件旧快照。findReplyAnchor只接受数据库中已sent的真实外部消息编号，且Task及原消息均属于当前owner与会话；普通引用文本不能授予跨任务/跨用户访问权。worker传replyToMessageId，准备阶段注入已验证的taskAnchorId；已送达问题提供回答类型和缺失字段，不把拟发问题当作用户已看到。

审批卡持久投递：publishApproval的cards端口改为固定配置{opsChatId,defaultPhase}，worker不再直接发送Telegram。outbound.enqueueApprovalCard只读取服务端pending快照的全部冻结draftText，不回退原始模型args，不截断待审正文；以approvalRunStateId唯一关联复用出站表。pendingCards按当前Agent/SDK版本及有效来源发现未入表通知，内部调度不调用模型。bot统一认领/投递/保存回执，并复核当前运营群收件人和来源阶段；Phase0来源不发卡。控制通知与客户答复通过approvalRunStateId区分，不能使原请求提前completed。旧直接发卡工厂已移除。过期快照不论pending/consumed/expired均清除snapshot/interruptions及卡片正文副本；不释放较新请求的用户fence，仍有效的新快照不被旧清理取消。

任务检索上下文：TaskGoal.searchTerms是有界的低信任公共检索词（最多12个），只作召回/词面匹配，不作用户要求或证据。rememberSearchTerms按owner/scope、原消息和requirementsVersion验证，在用户锁内CAS/幂等合并；条件改变保留词汇，主题定义重建时重新产生词汇。bindTaskMarketPlan归一化“房源/候选”等描述后缀并复用词汇，避免历史来源复查时丢掉别名。

住房预算口径：TaskConstraint.budgetScope=rent_only/all_in为服务端从当前用户预算原话推导的可选字段，工具参数不能提供；短补充保留旧口径，不把“包账单更好”变成总价硬条件。当前请求及Jev输入保留该口径；租金未含账单时，禁止把未知总支出说成仍在预算内。all_in检索核验不能直接把纯月租报价当已核实总价。明确的带年份入住字段可由代码核对并记录来源事实；无年份、含糊或带条件的字段不由该规则直接确认，整体实体一致性仍经Jev。

P27真实多轮修复契约（0.16.16，分支未发布）：`confirmTaskOutcome({task,goalIds,actor})`统一验证/应用用户确认；非空goalIds只确认相应分项，但所有required目标都由本人确认achieved后会完成整体任务，保留最后确认来源且不把未知来源条件标为supported。`confirmTaskGoal`单项原语仍不关闭其他目标。准备工具和仓储使用相同聚合原语，完成时原子关闭关联Demand。明确总预算不增加但仅提议账单偏好时，单个既有住房月预算保留原金额并更新all_in范围；偏好包账单本身不改变范围。`record_task_progress`返回与出站同源的eligible refs/排除项及未知条件，修复推荐输入时仍须保留所有门；不默默替模型删候选或复写已被Jev拒绝的回答。出站来源证据补充对应原帖/原生帖时间及伦敦核对日期，不用转载创建时间冒充原帖时间。

P25/P27 0.16.20契约：evaluateOutbound增加可选requestContext（仅当前已选Task的CurrentRequest.text，和来源证据分开），保留分项目标预算及用户条件，不改变Jev/阶段/频控或默认失败方向。候选硬反证复用sourceSupport、sourceReviewCache和共享96假设/24批预算；clear仅代表未核实到明确冲突，不写supported。no_match须有真实查询/失败记录，不能自称搜索失败；其他类型的过程陈述尚需补齐。旧进程证明stub按proposedStatus区分正向与反证，断言不变。

P25/P27 0.16.26候选：DeepSeek任务规划及正文显式temperature=0，其他模型配置不改；市场建议最多200字、超限反馈而不从中截断，同一来源卡内去重原文。共享出站输入检查不允许Agent伪称后台监控/外部联系；匿名市场offer没有验证过的卖家身份，正文不得从帖子编号推断人数/同异身份。小红书故障前缀xiaohongshu与解释守卫一致，原文读取失败记录回执。日期范围表示可接受窗口，不代表必须取首日，路程用时不假设往返。worker装配taskRequests=true并留启动版本，实际启用以迁移/进程验收为准。没有新增用户出站工具、数据库个人字段或保留期。


## P31 测试演员契约

跨包变更仅服务独立测试群：Env新增`TELEGRAM_ACTOR_ALLOWLIST`（JSON数组`{chatId,botIds}`，默认[]）与可选`ACTOR_LAB_CONFIG_PATH`；channel `toInboundMessage`及apps/bot入站构造参数透传该白名单。只接受匹配群的指定非自身Bot，私聊/其他群与默认行为不变。

DB导出`createPrisma(connectionString)`供隔离控制库及Match Bot只读观察连接，`getPrisma`继续原单例语义；traces新增`summarizeUsage({since,inputRefs})`只返回限定调用的DeepSeek token计数及缺失usage数，eval内存仓储保持同形。users.findByExternal只读定位合成actor；groups.setPolicy只更新指定channel/externalId的群策略，controller仅在API和白名单验证后对新群显式激活。outbound.findByToolCallId读取当前演员回执，countUnfinished防止遗留pending/sending跨run发送。

agent新增模拟用户生成与门控出站工具供apps/bot有限actor-lab控制器调用，不注册到正常matchAgent工具集。演员消息的`toolCallId=actor:<id>:<runId>:<turn>`是测试出站路由标识，controller只发当前run/已配置actor/固定测试群；出站表独立数据库，原sender不会误领。所有真实发送仍经channel createTelegramSender。新工具须完整phase/Jev门测试。配置文件含token，仅本地.env.*、600权限、不提交；无新业务表或模型供应商。

P31修复验证中（2026-10-18）：仅actor-lab装配evaluateParticipantOutbound，按合成用户提出/补充个人目标评估，正常助手evaluateOutbound不变，阶段/阈值/Jev不可用/频控/出站表仍复用。基本群的message_id属于接收账户；ActorLabInbox以receiverActorId+messageId隔离，Main观察按群/演员/发送时间/原文关联，存在歧义返回空；用量按整个run的群/白名单演员消息汇总，50条查询截断或缺usage时停止，禁止默默少算。无DB迁移或新增个人字段。

P31回执修复：OutboundMessage.senderAccountId默认空字符串；唯一键改为(channel,senderAccountId,target,externalMessageId)。createRepositories(prisma,lease?,senderAccountId='')第三参数仅由服务端绑定已核验演员Bot ID，贯穿forExecution；不放入模型工具参数/OutboundDraft，普通单Bot的空字符串作用域保留旧去重。actor-lab仅用绑定的repos创建消息，发送前复核row.senderAccountId与toolCall路由一致。真实渠道message_id保持原值。新增字段只保存公开测试Bot账号，不是个人数据，沿出站记录保留/删除路径；原个人数据规则不变。迁移在一个事务内替换索引，无新出站动作或权限。

P33测试观察契约：outbound.findReplyForSource({channel,target,sourceMessageId})只读同一请求/目标的文本类出站，控制器仅将status=sent且有sentAt/externalMessageId者作为真实群转录输入演员，pending/failed/dry_run不可喂入。该路径明确标sent_outbound，回复ID未知时不引用Main账号message_id。turnOrder仅调度三个既有演员role；是否后续回合按该演员实际已发消息判断，不再靠全局第几回合。无模型或发送门变化，无新增个人字段。

P34搜索契约：INFORMATION_SEARCH_PROVIDER=deepseek（默认）或tavily；worker将@matchbot/agent.createDeepSeekSearch注入既有WebSearch，research调用官方原始Search API并经现有knowledgeResultSchema/域名过滤/脱敏，不是模型生成。find仍委托可选Tavily商家核验，无其凭证时不冒充已核验商家。信息搜索trace记录provider；不新增模型/出站通道。账本未完整时可提交正常来源校验的部分回答，只有完整已核验账本才能标ready；必要个人追问规则和Jev/阶段/频控均保留。

P35引用契约：reply_to_request最多6个独立来源/offer、最多24个原始引用ID；同一k来源的多个真实passage只计1个来源。包括正文提取的inline编号也适用同一上限。每个passage仍逐一按本次工具结果验证，不能把未知段落归并成合法整页编号；7独立来源仍拒绝。阶段/审批/Jev/频控和事实检查不变。
# P36 增量契约

Env 增加 `JEV_POLICY: 'strict' | 'targeted'`，默认 strict。targeted 的直接对话进入现有任务规划，不伪造 Jev 分数；固定、服务端验证的状态回复在 Phase 2 无需 Jev；自由文本事实审核和来源核验保持 fail-closed。无 key 的 Jev 返回 `not_configured` 并留痕，不发网络请求。本地 CLI 只允许命名的 loopback 测试库，并通过模拟 transport 复用出站回执路径。

P37 提示词契约：agent 0.24.0 的规则/SOUL/场景/阶段协议与运行时数据分离。createMatchAgent 可接收运行上下文用于场景工具裁剪；无构造上下文的 SDK 调用者也经 isEnabled 控制。每次模型调用通过 SDK callModelInputFilter 添加 user-role JSON 数据包，不把用户/来源正文拼进系统指令，不把该包写入用户 session；工具、审批、JEV、出站路径和个人数据保留策略不变。模型调用前校验实际工具集合及提示词引用，trace metadata 增加 promptArchitecture/promptStage/promptScene。旧待审快照按既有 AGENT_VERSION 检查拒绝跨版本恢复。

P39生成配置契约：既有DEEPSEEK_API_KEY/BASE_URL/MODEL仍定义兼容生成provider，新增可选GENERATION_REASONING_EFFORT由agent与演员生成传给SDK。DeepSeek原始搜索使用独立DEEPSEEK_SEARCH_API_KEY；仅当生成host是api.deepseek.com时兼容复用原key，其他生成host缺搜索专用key则worker启动报错，禁止跨provider泄露凭据。生成trace带model，新模型未知价格写costEstimateAvailable=false和占位costMicro=0，不解释成免费或沿用DeepSeek价格。无表、通道或个人数据字段改变。


## P42 公共网页读取

`websearch.PageReader` 接收 `{url, find?, offset?}`，返回 `ok` 的正文片段、页面地址/标题、导航链接、分页位置，或结构化 `unavailable`。`agent.AgentDeps.pageReader` 可选，由 worker 注入；缺失时不注册工具或引用其协议。仅当前任务已发现地址允许导航；网络层对每次重定向进行 DNS 公网校验并固定连接地址。快照保留读取预算和已发现链接。

2026-10-19 演员迁出：删除 `ACTOR_LAB_CONFIG_PATH`、agent 的 `generateSimulatedUserTurn/queueSimulatedUserTurn`、jev 的 `evaluateParticipantOutbound/participantOutboundQuestions` 与 apps/bot actor-lab 控制器。`TELEGRAM_ACTOR_ALLOWLIST` 及 channel 入站透传保留，供 actor_bots 的演员 Bot 进入正常入站管线；`OutboundMessage.senderAccountId` 列与唯一键不变（空字符串为普通单 Bot 作用域），不新增迁移。

2026-10-20 群聊上下文与 Jev 关闭：`Env.JEV_POLICY` 新增 `off`（不需要 JEV_API_KEY）。db 新增 `messages.recentInGroup(groupId,{limit,sinceHours})` 与 `outbound.recentSentToTarget(target,{limit,sinceHours})`。agent 新增导出 `triageInbound`（一次生成模型调用，返回 `{action,category,newCondition,handledByMembers,sensitive,reason}`）、`loadGroupTranscript/buildGroupTranscript`（成员以稳定别名出现，不含渠道 id）；`MatchContext.groupTranscript` 由 worker 入站管线装入，运行时数据包新增 `groupConversation`。worker `PipelineDeps.triageInbound` 可注入。`JEV_POLICY=off` 时出站门不调用 Jev（verdict 置为通过，trace 带 `policy:'off'`），`evaluateSourceSupport` 三处调用跳过并视为支持。AGENT_VERSION 0.31.0。

import type { Repositories } from '@matchbot/db';
import type { DemandDraft, DemandCategory, Phase, UserTask } from '@matchbot/domain';
import type { ExecutionLease } from '@matchbot/domain';
import type { Thresholds } from '@matchbot/gating';
import type { evaluateOutbound, JevClient } from '@matchbot/jev';
import type { Env, Logger } from '@matchbot/shared';
import type {
  SearchCandidate,
  WebSearch,
  XhsNote,
  XhsSearch,
  MarketSearch,
  MarketIntent,
  PageReader,
} from '@matchbot/websearch';
import type { ModelProvider } from '@openai/agents';
import type { XhsResearchQuery } from './xhs-research.js';
import type { XhsRecommendation } from './xhs-recommendations.js';
import type { CurrentRequest } from './current-request.js';
import type { KnowledgeSource } from './knowledge-evidence.js';
import type { MarketPlan } from './market-strategy.js';
import type { MarketCandidate, MarketResearchQuery } from './market-research.js';
import type { GroupLine, GroupView } from './group-context.js';

/** 一次 run 的上下文。Session 粒度是用户；群上下文与开放需求经这里 + instructions 注入。 */
export interface MatchContext {
  execution?: ExecutionLease;
  channel?: 'telegram' | 'whatsapp';
  userId: string;
  chatId: string;
  groupId: string | null;
  phase: Phase;
  sourceMessageId: string;
  /**
   * 触发这次 run 的那条消息在渠道侧的 id 与作者 id（sourceMessageId / userId 是库内 id）。
   * 群内回帖用它回复原消息并 @ 作者；私聊回复发给这个作者。可选：旧快照里没有。
   */
  source?: { messageId: string; userId: string };
  /** 该群每天最多推荐几次（groups.rateLimitPerDay）；缺省 = 不限。 */
  rateLimitPerDay?: number;
  /** 用户在对 bot 说话（回复 bot / @bot），以及被回复的那条 bot 消息原文。 */
  addressedToBot?: boolean;
  replyToBotText?: string;
  replyToMessageId?: string;
  requestCategory?: DemandCategory;
  /** Recent public group conversation (aliases only), oldest first; loaded by the pipeline for group messages. */
  groupTranscript?: GroupLine[];
  /** When the source message arrived; group views are bounded by it so a replay sees no future. */
  sourceReceivedAt?: string;
  /** P53: what A2H sees of the group besides the conversation (aliases only; built by run.ts). */
  groupView?: GroupView;
  /** P55: A2H put a 👀 on this direct ask; withdrawn if the run sends nothing. */
  ackReactionSent?: boolean;
  /** P53: this run is the group main agent's (approval resume rebuilds the same stage). */
  isMainAgentRun?: boolean;
  /** P53: when the main agent started; group lines stored after it are shown as new. */
  mainStartedAt?: string;
  /** P53: group lines that arrived while this run was working (refreshed before each model call). */
  newGroupLines?: GroupLine[];
  /** Server-selected, owner/scope-checked task; never accept an arbitrary model-provided snapshot. */
  task?: UserTask;
  taskCandidates?: UserTask[];
  taskAnchorId?: string;
  taskPlanFailures?: number;
  taskProgressCalls?: number;
  taskProgressVersion?: number;
  /** Server-selected source roots for the separate delivery stage; never model-provided snapshots. */
  deliverySourceRefs?: string[];
  sourceReviewCache?: Record<string, boolean>;
  taskSourceReviewedClaims?: number;
  runDeadlineAt?: number;
  taskUpdate?: {
    kind:
      'new' | 'continued' | 'ambiguous' | 'acknowledged' | 'completed' | 'cancelled' | 'unbound';
  };
  currentRequest?: CurrentRequest;
  knowledgeSources?: KnowledgeSource[];
  informationQueries?: string[];
  pageReads?: string[];
  pageLinks?: Array<{ text: string; url: string }>;
  sourceFailures?: string[];
  answerRecorded?: boolean;
  /** P52: how the researcher ended (finish_research, or deliver/ask_user via record_task_progress). */
  researchOutcome?: 'deliver' | 'no_answer' | 'skip';
  /** P52: the researcher's note for the writer (≤200 chars); never sent to the group. */
  researchNote?: string;
  /** Server-bound same-task context addition after a delivered answer; not a general silent-mode permission. */
  quietSupplementTaskId?: string;
  quietSupplementEvidenceIds?: string[];
  replySuppressed?: boolean;
  isRequestStatusRun?: boolean;
  outboundDeclineReason?: 'unverified_claims' | 'low_value' | 'jev_unavailable' | 'rate_limited';
  answerInputExhausted?: boolean;
  isAnswerFinalization?: boolean;
  demandId?: string;
  demand?: DemandDraft;
  recentReplies: string[];
  /** P52: find_suppliers results for the writer's reply_in_group (the researcher no longer replies). */
  catalogueSuppliers?: Array<{
    id: string;
    name?: string | undefined;
    price?: string | null | undefined;
    phone?: string | null | undefined;
    whatsapp?: string | null | undefined;
    pool?: string | undefined;
    reasons: string[];
  }>;
  /** find_suppliers 本次 run 是否查过且为空；web_search 的前置条件之一（P14）。 */
  supplierSearchEmpty?: boolean;
  /**
   * 出站门本轮已拒过一次。之后所有出站工具直接拒绝：出站门决定的是「该不该回」，
   * 不能让模型改写重投、直到分数过关（2026-09-24 实测连投 6 版才过）。
   */
  outboundBlocked?: boolean;
  /** 同一出站工具连续参数/证据失败最多三次；有效草稿清零。 */
  outboundInputFailures?: { tool: string; count: number; feedback?: string[] };
  /** 本次 run 的 web search 候选；reply_with_search_results 只认这里的编号。 */
  searchResults?: SearchCandidate[];
  /** 本次 run 的小红书笔记候选；reply_with_xhs_notes 只认这里的编号。 */
  xhsNotes?: XhsNote[];
  marketListings?: MarketCandidate[];
  marketQueries?: MarketResearchQuery[];
  marketDetailIds?: string[];
  marketIntent?: MarketIntent;
  marketPlan?: MarketPlan;
  /** 当前请求对家的方向，由本轮输入确定，不复用用户历史。 */
  marketTarget?: 'SELL' | 'BUY' | 'PEER' | 'ANY';
  /** 已消耗的多词/翻页查询预算；与候选一起保存进加密快照。 */
  xhsQueries?: XhsResearchQuery[];
  /** 已尝试读取全文的候选编号，失败也占预算，跨审批恢复。 */
  xhsDetailRefs?: string[];
  /** 保留本轮已通过来源/事实校验的条目，防止重写时丢掉已完成的多帖综合。 */
  xhsValidatedRecommendations?: XhsRecommendation[];
  /** 送审的最终正文，按SDK callId关联；恢复后保持运营实际批准的内容。 */
  outboundPreviews?: Record<string, string>;
}

export interface AgentDeps {
  /** P53: group turns go to the main agent (A2H in the group) instead of researcher → writer. */
  mainAgent?: boolean;
  /** P22 production enables request-bound answering; legacy injected callers remain compatible. */
  answerRequests?: boolean;
  /** Enable the persistent task preparation stage once migrations and the full flow are deployed. */
  taskRequests?: boolean;
  env: Env;
  repos: Repositories;
  jev: JevClient;
  thresholds: Thresholds;
  logger: Logger;
  /** 注入便于测试（单测不连 Jev）。 */
  evaluateOutbound: typeof evaluateOutbound;
  /** 网页信息研究（默认DeepSeek）与可选的商家核验搜索，通过装配注入。 */
  webSearch?: WebSearch;
  pageReader?: PageReader;
  /** 吃喝玩乐类需求的小红书兜底搜索；未配 SANDBASE_API_KEY 时为空，相关工具不注册。 */
  xhsSearch?: XhsSearch;
  /** P16：匿名A2H公开搜索，始终不访问联系方式/私信或写接口。 */
  marketSearch?: MarketSearch;
  /** 测试注入 stub 模型；生产走 configureModelProvider 设的默认 provider。 */
  modelProvider?: ModelProvider;
}

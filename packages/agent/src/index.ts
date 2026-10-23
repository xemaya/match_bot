/**
 * matchAgent 组装（架构 §4）。
 * - 模型：OpenAIProvider({ baseURL: DeepSeek, useResponses: false })，model = env.DEEPSEEK_MODEL
 * - 出站工具一律 needsApproval 走 gating + jev
 * - tracing：禁用默认导出，注册写 decision_traces 的 processor
 */
export { AGENT_VERSION, createMatchAgent } from './agent.js';
export { configureModelProvider } from './provider.js';
export { createTraceProcessor } from './tracing.js';
export { createPgSession } from './session.js';
export { runInbound, resumeRun, SDK_VERSION, type RunOutcome } from './run.js';
export type { AgentDeps, MatchContext } from './context.js';
export { triageInbound, type TriageOutcome, type TriageVerdict } from './triage.js';
export { consolidateGroupMemory } from './stages/notetaker.js';
export { reactToThanks } from './ack-reaction.js';
export {
  loadGroupTranscript,
  buildGroupTranscript,
  memberAlias,
  type GroupLine,
} from './group-context.js';

export { createDeepSeekSearch } from './deepseek-search.js';
// P50 humanness loop (packages/eval): freeze a real run's research packet and replay finalization only.
export { researchContextSchema, restoreSearchContext } from './restore-search-context.js';
export { buildDeliveryPacket } from './delivery-context.js';
export { bindTaskMarketPlan } from './task-market-plan.js';

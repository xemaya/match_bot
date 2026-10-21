/**
 * Jev 客户端与问题集。接口规格见 docs/reference/jev-decision-model.md §3。
 * 契约：超时 3s；429/529 指数退避 3 次；失败时入站按"不进 agent"、出站按"送审"处理；每次调用写 decision_traces(kind=jev)。
 */
export { createJevClient, type JevClient, type JevOutcome } from './client.js';
export { JEV_ENDPOINT, type JevAnswer, type JevQuestion, type JevResponse } from './types.js';
export { evaluateInbound, inboundQuestions, type InboundVerdict } from './questions/inbound.js';
export { evaluateOutbound, outboundQuestions, type OutboundVerdict } from './questions/outbound.js';
export {
  evaluateSourceSupport,
  sourceSupportQuestions,
  type SourceClaim,
} from './questions/source-support.js';

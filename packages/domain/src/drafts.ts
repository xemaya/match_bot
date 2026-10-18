import { z } from 'zod';
import { executionLeaseSchema } from './execution.js';
import { taskDeliveryDraftSchema } from './task-delivery.js';
import { DEMAND_CATEGORIES } from './demand.js';
import { BUDGET_SCOPES } from './task.js';

/** 出站渠道。Phase 0 只有 telegram，whatsapp 是 Phase 2 的占位（架构 §3）。 */
export const OUTBOUND_CHANNELS = ['telegram', 'feishu', 'whatsapp'] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

/** 出站用途。频控只数 recommendation；与 Prisma enum OutboundKind 一一对应。 */
export const OUTBOUND_KINDS = [
  'recommendation',
  'clarification',
  'notification',
  'lead',
  'reaction',
] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

/** agent 工具与仓储之间传递的需求草稿。postcode 为归一化后的 outward 或 full。 */
export const demandDraftSchema = z.object({
  category: z.enum(DEMAND_CATEGORIES),
  /** 在找什么，简短英文，如 "Chinese birthday cake"。P14 web search 只用它 + 区域拼查询。 */
  need: z.string().max(80).optional(),
  whenText: z.string().max(200).optional(),
  whenAt: z.iso.datetime().optional(),
  fromPostcode: z.string().max(8).optional(),
  toPostcode: z.string().max(8).optional(),
  quantity: z.string().max(100).optional(),
  budgetPence: z.number().int().nonnegative().optional(),
  budgetScope: z.enum(BUDGET_SCOPES).optional(),
  lang: z.string().length(2).optional(),
  confidence: z.number().min(0).max(1),
});
export type DemandDraft = z.infer<typeof demandDraftSchema>;

export const supplyDraftSchema = z.object({
  category: z.enum(DEMAND_CATEGORIES),
  availability: z.string().max(200).optional(),
  area: z.string().max(100).optional(),
  expiresAt: z.iso.datetime(),
});
export type SupplyDraft = z.infer<typeof supplyDraftSchema>;

export const outboundDraftSchema = z.object({
  channel: z.enum(OUTBOUND_CHANNELS),
  target: z.string().min(1),
  text: z.string().min(1).max(4000),
  toolCallId: z.string().optional(),
  /** 缺省按 recommendation 计，宁可多算进频控也不漏算。 */
  kind: z.enum(OUTBOUND_KINDS).optional(),
  /** 群内回帖时回复的那条原消息（渠道侧 message id）。 */
  replyToMessageId: z.string().optional(),
  /** 发送时要 @ 的用户（渠道侧 user id）。只存 id，名字由发送端现查，不落库（AGENTS.md §6）。 */
  mentionUserId: z.string().optional(),
  /** Server-selected phase at the gate; legacy rows without this remain held. */
  phase: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  /** Server-only execution authority, never a model tool parameter. */
  execution: executionLeaseSchema.optional(),
  taskDelivery: taskDeliveryDraftSchema.optional(),
});
export type OutboundDraft = z.infer<typeof outboundDraftSchema>;

import { z } from 'zod';
import { DEMAND_CATEGORIES } from './demand.js';

export const TASK_STATUSES = [
  'active',
  'waiting_user',
  'waiting_source',
  'waiting_delivery',
  'delivered',
  'completed',
  'cancelled',
  'expired',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const BUDGET_SCOPES = ['rent_only', 'all_in'] as const;
export const TASK_CONSTRAINT_KEYS = [
  'area',
  'travel_origin',
  'budget',
  'max_travel_minutes',
  'day',
  'time',
  'level',
  'room_type',
  'pets',
  'move_in_date',
  'date',
  'route_from',
  'route_to',
  'capacity',
  'role',
  'feature',
  'condition',
  'self_collect',
  'bills',
  'exclude',
  'quantity',
] as const;
const id = z.string().min(1).max(160);
const strength = z.enum(['hard', 'preference']);
const userConfirmationSchema = z.strictObject({
  userId: id,
  sourceMessageId: id,
  intent: z.enum(['achieved', 'cancelled']),
});
const valueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1).max(1000) }),
  z.strictObject({
    kind: z.literal('money'),
    amountPence: z.number().int().nonnegative(),
    unit: z.enum(['item', 'person', 'month', 'total']),
  }),
  z.strictObject({ kind: z.literal('duration'), minutes: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('location'), area: z.string().min(1).max(100) }),
  z
    .strictObject({ kind: z.literal('date_range'), from: z.iso.date(), to: z.iso.date() })
    .refine((v) => v.from <= v.to, 'date range must be ordered'),
]);
export const taskConstraintSchema = z.strictObject({
  key: id,
  goalId: id.optional(),
  strength,
  value: valueSchema,
  budgetScope: z.enum(BUDGET_SCOPES).optional(),
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('user'), sourceMessageId: id }),
    z.strictObject({ kind: z.literal('agent_proposal'), acceptedByMessageId: id }),
  ]),
});
export type TaskConstraint = z.infer<typeof taskConstraintSchema>;
export const taskCriterionSchema = z.strictObject({
  id,
  label: z.string().min(1).max(300),
  strength,
  constraintKey: id.nullable().default(null),
  status: z.enum(['unknown', 'supported', 'conflict']),
  evidenceRefs: z.array(id).max(16),
  conflictingEvidenceRefs: z.array(id).max(16).optional(),
});
export const taskGoalSchema = z.strictObject({
  id,
  title: z.string().min(1).max(300),
  required: z.boolean(),
  /** Agent retrieval hints only, never a user condition or source fact. */
  searchTerms: z.array(z.string().min(1).max(60)).max(12).optional(),
  criteria: z.array(taskCriterionSchema).min(1).max(24),
  userConfirmation: userConfirmationSchema.nullable().default(null),
  sourceCoherence: z.enum(['unknown', 'supported', 'conflict']).optional(),
});
export const taskQuestionSchema = z.strictObject({
  id,
  goalId: id.optional(),
  constraintKey: id,
  text: z.string().min(1).max(500),
  answerType: z.enum(['duration', 'money', 'date', 'location', 'boolean', 'text']),
  deliveryStatus: z.enum(['proposed', 'sent']),
  outboundMessageId: id,
});
export const taskEvidenceSchema = z.strictObject({
  id,
  goalId: id,
  kind: z.enum(['user_statement', 'source_excerpt', 'calculation']),
  sourceRef: id,
  summary: z.string().min(1).max(1000),
  observedAt: z.iso.datetime(),
  entityKey: id.optional(),
  url: z.url().startsWith('https://').max(3000).optional(),
});
export const taskNextStepSchema = z.strictObject({
  action: z.enum(['research', 'ask_user', 'wait_source', 'deliver', 'wait_user']),
  owner: z.enum(['agent', 'user', 'source']),
  reason: z.string().min(1).max(500),
  goalId: id.optional(),
  constraintKey: id.optional(),
});
export const taskSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  id,
  ownerUserId: id,
  scope: z.strictObject({
    channel: z.enum(['telegram', 'feishu', 'whatsapp']),
    chatId: id,
    threadId: id.optional(),
  }),
  objective: z.string().min(1).max(600),
  category: z.enum(DEMAND_CATEGORIES).default('other'),
  counterparty: z.enum(['supply', 'demand', 'peer']).nullable().default(null),
  status: z.enum(TASK_STATUSES),
  revision: z.number().int().nonnegative(),
  requirementsVersion: z.number().int().nonnegative().default(0),
  constraints: z.array(taskConstraintSchema).max(64).default([]),
  goals: z.array(taskGoalSchema).max(24),
  evidence: z.array(taskEvidenceSchema).max(128),
  pendingQuestion: taskQuestionSchema.nullable(),
  nextStep: taskNextStepSchema.nullable().default(null),
  blockReason: z.string().min(1).max(500).nullable(),
  delivery: z.strictObject({
    status: z.enum(['none', 'queued', 'sent', 'unknown', 'failed']),
    level: z.enum(['none', 'partial', 'ready']),
    outboundMessageId: id.optional(),
  }),
  userConfirmation: userConfirmationSchema.nullable(),
});
export type UserTask = z.infer<typeof taskSchema>;
export const taskPayloadSchema = taskSchema.omit({
  id: true,
  ownerUserId: true,
  scope: true,
  category: true,
  status: true,
  revision: true,
  requirementsVersion: true,
});
export const taskActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('user'),
    userId: id,
    messageId: id,
    intent: z.enum(['achieved', 'cancelled', 'unspecified']),
  }),
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('system') }),
]);
export type TaskActor = z.infer<typeof taskActorSchema>;

export class TaskTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTransitionError';
  }
}

function assertEvidenceBindings(task: UserTask): void {
  const evidence = new Map(task.evidence.map((e) => [e.id, e]));
  const goals = new Set(task.goals.map((g) => g.id));
  const constraintKeys = task.constraints.map((c) => JSON.stringify([c.goalId ?? null, c.key]));
  if (new Set(constraintKeys).size !== constraintKeys.length)
    throw new TaskTransitionError('constraint keys must be unique per goal');
  for (const constraint of task.constraints)
    if (constraint.budgetScope && constraint.value.kind !== 'money')
      throw new TaskTransitionError('budget scope requires a monetary condition');
  for (const constraint of task.constraints)
    if (constraint.goalId && !goals.has(constraint.goalId))
      throw new TaskTransitionError('constraint must belong to an existing goal');
  if (evidence.size !== task.evidence.length || goals.size !== task.goals.length)
    throw new TaskTransitionError('goal and evidence IDs must be unique');
  for (const item of task.evidence)
    if (!goals.has(item.goalId))
      throw new TaskTransitionError('evidence must belong to an existing goal');
  for (const goal of task.goals) {
    if (goal.userConfirmation && goal.userConfirmation.userId !== task.ownerUserId)
      throw new TaskTransitionError('subgoal confirmation must belong to the owner');
    if (new Set(goal.criteria.map((c) => c.id)).size !== goal.criteria.length)
      throw new TaskTransitionError('criterion IDs must be unique within a goal');
    for (const criterion of goal.criteria) {
      if (
        criterion.constraintKey &&
        !task.constraints.some(
          (c) => c.key === criterion.constraintKey && (!c.goalId || c.goalId === goal.id),
        )
      )
        throw new TaskTransitionError(
          'criterion condition binding must refer to this goal or a shared condition',
        );
      if (criterion.status !== 'unknown' && !criterion.evidenceRefs.length)
        throw new TaskTransitionError('supported/conflicting criteria require evidence');
      for (const ref of [...criterion.evidenceRefs, ...(criterion.conflictingEvidenceRefs ?? [])])
        if (evidence.get(ref)?.goalId !== goal.id)
          throw new TaskTransitionError('criterion evidence must belong to the same goal');
    }
  }
}

/** PRD §13: readiness concerns an information deliverable, never proof of the user's real-world outcome. */
export function assessTaskReadiness(input: UserTask) {
  const task = taskSchema.parse(input);
  assertEvidenceBindings(task);
  const required = task.goals.filter((goal) => goal.required && !goal.userConfirmation);
  const missing: Array<{ goalId: string; criterionId: string; status: 'unknown' | 'conflict' }> =
    [];
  let hasCriteria = true;
  for (const goal of required) {
    const hard = goal.criteria.filter((criterion) => criterion.strength === 'hard');
    if (!hard.length) hasCriteria = false;
    for (const criterion of hard)
      if (criterion.status !== 'supported')
        missing.push({ goalId: goal.id, criterionId: criterion.id, status: criterion.status });
    if (hard.length && hard.every((c) => c.status === 'supported')) {
      const sources = new Map(task.evidence.map((e) => [e.id, e]));
      const contradicted = new Set(
        hard.flatMap((c) =>
          (c.conflictingEvidenceRefs ?? []).map((ref) => {
            const e = sources.get(ref)!;
            return e.entityKey ?? e.sourceRef;
          }),
        ),
      );
      const pools = hard
        .map(
          (c) =>
            new Set(
              c.evidenceRefs.flatMap((ref) => {
                const e = sources.get(ref)!;
                return e.kind === 'user_statement' ? [] : [e.entityKey ?? e.sourceRef];
              }),
            ),
        )
        .filter((pool) => pool.size);
      const first = pools[0];
      const semanticInformation =
        goal.sourceCoherence === 'supported' &&
        !task.counterparty &&
        task.category !== 'housing' &&
        task.category !== 'second_hand';
      if (
        goal.sourceCoherence === 'unknown' ||
        goal.sourceCoherence === 'conflict' ||
        !first ||
        (!semanticInformation &&
          ![...first].some(
            (entity) => !contradicted.has(entity) && pools.every((pool) => pool.has(entity)),
          ))
      )
        missing.push({
          goalId: goal.id,
          criterionId: '__coherent_source',
          status: goal.sourceCoherence === 'unknown' ? 'unknown' : first ? 'conflict' : 'unknown',
        });
    }
  }
  return { ready: required.length > 0 && hasCriteria && missing.length === 0, missing };
}

function assertTransition(p: { task: UserTask; next: TaskStatus; actor: TaskActor }): void {
  const { task, next, actor } = p;
  if (actor.kind === 'user' && actor.userId !== task.ownerUserId)
    throw new TaskTransitionError('only the task owner may confirm an outcome');
  if (['completed', 'cancelled', 'expired'].includes(task.status))
    throw new TaskTransitionError('terminal task cannot be reopened implicitly');
  if (next === 'completed' || next === 'cancelled') {
    const expected = next === 'completed' ? 'achieved' : 'cancelled';
    if (actor.kind !== 'user' || actor.intent !== expected)
      throw new TaskTransitionError('explicit user confirmation is required');
  }
  if (next === 'expired' && actor.kind !== 'system')
    throw new TaskTransitionError('only retention policy may expire a task');
  if (next === 'waiting_user' && task.pendingQuestion?.deliveryStatus !== 'sent')
    throw new TaskTransitionError('waiting for a user requires a delivered question');
  if (next === 'waiting_source' && !task.blockReason)
    throw new TaskTransitionError('waiting for a source requires a recorded reason');
  if (next === 'waiting_delivery' && task.delivery.status !== 'queued')
    throw new TaskTransitionError('waiting delivery requires a queued outbound');
  if (
    next === 'delivered' &&
    (task.delivery.status !== 'sent' ||
      task.delivery.level !== 'ready' ||
      !assessTaskReadiness(task).ready)
  )
    throw new TaskTransitionError('delivery requires a sent, fully supported result');
}

/** Actors are grounded by trusted inbound processing; agent tools must not choose user actor identity or intent. */
export function transitionTaskStatus(p: {
  task: UserTask;
  next: TaskStatus;
  actor: TaskActor;
}): UserTask {
  const task = taskSchema.parse(p.task),
    actor = taskActorSchema.parse(p.actor);
  const next = z.enum(TASK_STATUSES).parse(p.next);
  assertEvidenceBindings(task);
  assertTransition({ task, actor, next });
  return {
    ...task,
    status: next,
    revision: task.revision + 1,
    userConfirmation:
      actor.kind === 'user' &&
      actor.intent !== 'unspecified' &&
      (next === 'completed' || next === 'cancelled')
        ? { userId: actor.userId, sourceMessageId: actor.messageId, intent: actor.intent }
        : task.userConfirmation,
  };
}

/** PRD §13: a user may solve one part elsewhere; this neither verifies sources nor closes other goals. */
export function confirmTaskGoal(p: { task: UserTask; goalId: string; actor: TaskActor }): UserTask {
  const task = taskSchema.parse(p.task);
  const actor = taskActorSchema.parse(p.actor);
  if (actor.kind !== 'user' || actor.userId !== task.ownerUserId || actor.intent === 'unspecified')
    throw new TaskTransitionError('explicit owner confirmation is required');
  assertTransition({ task, next: 'active', actor });
  assertEvidenceBindings(task);
  const goal = task.goals.find((g) => g.id === p.goalId);
  if (!goal) throw new TaskTransitionError('confirmation must identify an existing goal');
  goal.userConfirmation = {
    userId: actor.userId,
    sourceMessageId: actor.messageId,
    intent: actor.intent,
  };
  return { ...task, status: 'active', revision: task.revision + 1 };
}

/** All required parts confirmed by the owner settle the task even when reported in separate turns. */
export function confirmTaskOutcome(p: {
  task: UserTask;
  goalIds: string[];
  actor: TaskActor;
}): UserTask {
  if (!p.goalIds.length)
    return transitionTaskStatus({
      task: p.task,
      actor: p.actor,
      next: p.actor.kind === 'user' && p.actor.intent === 'achieved' ? 'completed' : 'cancelled',
    });
  let task = p.task;
  for (const goalId of p.goalIds) task = confirmTaskGoal({ task, goalId, actor: p.actor });
  const required = task.goals.filter((goal) => goal.required);
  return required.length && required.every((goal) => goal.userConfirmation?.intent === 'achieved')
    ? transitionTaskStatus({ task, actor: p.actor, next: 'completed' })
    : task;
}

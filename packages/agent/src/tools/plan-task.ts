import {
  TaskTransitionError,
  confirmTaskOutcome,
  reviseTaskRequirements,
  selectTask,
  taskSchema,
  type TaskRequirementPatch,
  type UserTask,
} from '@matchbot/domain';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { selectMarketTradeType } from '@matchbot/gating';
import type { AgentDeps, MatchContext } from '../context.js';
import { isContextSupplement, hasSameActionConditions } from '../supplement-replies.js';
import { groundTaskConfirmation } from '../task-confirmation.js';
import {
  normalizeTaskPatch,
  taskPatchProposalSchema,
  taskProposalSchema,
  TaskProposalError,
  type TaskProposal as Proposal,
} from '../task-proposal.js';
import { PLAN_TASK } from '../prompts/tools/plan-task.js';

function newTask(ctx: MatchContext, args: Proposal): UserTask {
  const category =
    args.category === 'other'
      ? (ctx.currentRequest?.demand.category ?? args.category)
      : args.category;
  if (
    !args.objective ||
    !category ||
    category === 'job' ||
    !args.patch?.goals.length ||
    args.taskRef
  )
    throw new TaskProposalError(PLAN_TASK.feedback.newTaskNeeds);
  if (/£\s*\d|\d+\s*(?:英镑|镑|磅|GBP|pounds?)|\d{1,2}月|\b20\d{2}[-/]/i.test(args.objective))
    throw new TaskProposalError(PLAN_TASK.feedback.objectiveGeneric);
  return taskSchema.parse({
    id: 'new-task-proposal',
    ownerUserId: ctx.userId,
    scope: { channel: ctx.channel ?? 'telegram', chatId: ctx.chatId },
    objective: args.objective,
    // A catch-all proposal must not erase the specific route already bound from this message.
    category,
    status: 'active',
    revision: 0,
    goals: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
function validateProposal(p: {
  task: UserTask;
  args: Proposal;
  patch: TaskRequirementPatch | null;
  ctx: MatchContext;
  text: string;
}): void {
  const task = p.patch
    ? reviseTaskRequirements({
        task: p.task,
        patch: p.patch,
        source: { messageId: p.ctx.sourceMessageId, text: p.text },
      })
    : p.task;
  if (!p.args.outcome) return;
  const outcome = p.args.outcome;
  for (const goalId of outcome.goalIds.length ? outcome.goalIds : [undefined]) {
    groundTaskConfirmation({
      task,
      userId: p.ctx.userId,
      messageId: p.ctx.sourceMessageId,
      text: p.text,
      quote: outcome.quote,
      intent: outcome.intent,
      ...(goalId ? { goalId } : {}),
    });
  }
  confirmTaskOutcome({
    task,
    goalIds: outcome.goalIds,
    actor: {
      kind: 'user',
      userId: p.ctx.userId,
      messageId: p.ctx.sourceMessageId,
      intent: outcome.intent,
    },
  });
}
function canRefreshRevision(previous: UserTask, current: UserTask): boolean {
  return (
    current.id === previous.id &&
    current.ownerUserId === previous.ownerUserId &&
    current.scope.chatId === previous.scope.chatId &&
    current.scope.channel === previous.scope.channel &&
    current.requirementsVersion === previous.requirementsVersion &&
    current.category === previous.category &&
    current.objective === previous.objective &&
    current.counterparty === previous.counterparty &&
    !['completed', 'cancelled', 'expired'].includes(current.status) &&
    JSON.stringify(current.userConfirmation) === JSON.stringify(previous.userConfirmation) &&
    JSON.stringify(current.goals.map((g) => [g.id, g.userConfirmation])) ===
      JSON.stringify(previous.goals.map((g) => [g.id, g.userConfirmation]))
  );
}

async function applyProposal(p: {
  deps: AgentDeps;
  ctx: MatchContext;
  text: string;
  args: Proposal;
}): Promise<string> {
  const { deps, ctx, args } = p;
  if (ctx.taskUpdate) return PLAN_TASK.feedback.alreadyBound;
  if (args.route === 'ignore' || args.route === 'clarify') {
    if (args.patch || args.outcome) throw new Error(PLAN_TASK.feedback.noMutation);
    ctx.taskUpdate = { kind: args.route === 'ignore' ? 'acknowledged' : 'ambiguous' };
    return PLAN_TASK.feedback.prepared(ctx.taskUpdate.kind);
  }
  const candidates = ctx.taskCandidates ?? [];
  const selection = selectTask({
    ownerUserId: ctx.userId,
    scope: { channel: ctx.channel ?? 'telegram', chatId: ctx.chatId },
    tasks: candidates,
    intent: args.route,
    ...(ctx.taskAnchorId ? { anchorTaskId: ctx.taskAnchorId } : {}),
    ...(args.taskRef ? { referencedTaskId: args.taskRef } : {}),
  });
  if (selection.kind === 'inaccessible') throw new Error(PLAN_TASK.feedback.inaccessible);
  if (selection.kind === 'clarify' || selection.kind === 'unbound') {
    ctx.taskUpdate = { kind: selection.kind === 'clarify' ? 'ambiguous' : 'unbound' };
    return PLAN_TASK.feedback.prepared(ctx.taskUpdate.kind);
  }
  if (
    selection.kind === 'selected' &&
    candidates.length > 1 &&
    !ctx.taskAnchorId &&
    (!args.referenceQuote || !p.text.includes(args.referenceQuote))
  )
    throw new Error(PLAN_TASK.feedback.needsReference);
  if (
    selection.kind === 'selected' &&
    candidates.length > 1 &&
    !ctx.taskAnchorId &&
    args.referenceQuote &&
    !args.referenceQuote.replace(
      /可以|能够|能|我|把|再|就|还是|预算|价格|金额|上限|提高|加|一点|一些|点|些|到|改为|改成|调整|英镑|镑|磅|\b(?:can|i|the|my|budget|price|increase|raise|slightly|more|to|gbp|pounds?)\b|[\d\s£.,，。]/gi,
      '',
    )
  ) {
    ctx.taskUpdate = { kind: 'ambiguous' };
    return PLAN_TASK.feedback.prepared('ambiguous');
  }
  let selected =
    selection.kind === 'selected'
      ? candidates.find((t) => t.id === selection.taskId)
      : selection.kind === 'new'
        ? newTask(ctx, args)
        : undefined;
  if (!selected) throw new Error(PLAN_TASK.feedback.inaccessible);
  const patch = normalizeTaskPatch({ input: args.patch, task: selected, text: p.text });
  const isMarket =
    selected.category === 'second_hand' ||
    selected.category === 'housing' ||
    (selected.category === 'other' &&
      /帮带|代购|空余行李|搭子|伙伴|carry|luggage space|companion|partner/i.test(p.text));
  const target = isMarket ? selectMarketTradeType(p.text) : null;
  const counterparty =
    target === 'BUY' ? 'demand' : target === 'SELL' ? 'supply' : target === 'PEER' ? 'peer' : null;
  validateProposal({ task: selected, args, patch, ctx, text: p.text });
  const access = {
    userId: ctx.userId,
    scope: { channel: ctx.channel ?? 'telegram', chatId: ctx.chatId },
  };
  const turnInput: Parameters<AgentDeps['repos']['tasks']['planTurn']>[0] = {
    access,
    taskId: selection.kind === 'new' ? null : selected.id,
    creation:
      selection.kind === 'new'
        ? {
            intentKey: 'primary',
            objective: selected.objective,
            category: selected.category,
            counterparty,
          }
        : null,
    expectedRevision: selected.revision,
    sourceMessageId: ctx.sourceMessageId,
    patch,
    outcome: args.outcome ? { intent: args.outcome.intent, goalIds: args.outcome.goalIds } : null,
  };
  let result = await deps.repos.tasks.planTurn(turnInput);
  if (result.kind === 'conflict' && selection.kind === 'selected') {
    const latest = await deps.repos.tasks.findById({ access, id: selected.id });
    if (latest && canRefreshRevision(selected, latest)) {
      validateProposal({ task: latest, args, patch, ctx, text: p.text });
      await record(deps, { ...ctx, task: latest }, 'operational_revision_refreshed');
      selected = latest;
      result = await deps.repos.tasks.planTurn({ ...turnInput, expectedRevision: latest.revision });
    }
  }
  if (result.kind !== 'applied' && result.kind !== 'replayed')
    throw new Error(PLAN_TASK.feedback.changed);
  if (
    selection.kind === 'selected' &&
    selected.delivery.status === 'sent' &&
    isContextSupplement(p.text) &&
    hasSameActionConditions(selected, result.task)
  ) {
    ctx.quietSupplementTaskId = selected.id;
    ctx.quietSupplementEvidenceIds = selected.evidence
      .filter((e) => e.kind === 'source_excerpt')
      .map((e) => e.id);
  }
  ctx.task = result.task;
  ctx.taskUpdate = {
    kind:
      result.task.status === 'completed' || result.task.status === 'cancelled'
        ? result.task.status
        : selection.kind === 'new'
          ? 'new'
          : 'continued',
  };
  delete ctx.taskPlanFailures;
  return PLAN_TASK.feedback.prepared(ctx.taskUpdate.kind);
}

/** Internal state proposal only; this tool never sends or bypasses outbound gates. */
export function planTaskTool(deps: AgentDeps, text: string) {
  return tool({
    name: 'plan_task',
    description: PLAN_TASK.planTask.description,
    parameters: taskProposalSchema,
    needsApproval: false,
    errorFunction: (rc) => invalidInput(deps, rc.context as MatchContext),
    execute: (args, rc) =>
      runProposal({ deps, text, args, ctx: (rc as RunContext<MatchContext>).context }),
  });
}
async function invalidInput(deps: AgentDeps, ctx: MatchContext) {
  ctx.taskPlanFailures = (ctx.taskPlanFailures ?? 0) + 1;
  await record(deps, ctx, 'invalid_schema');
  return PLAN_TASK.feedback.invalidSchema;
}
async function runProposal(p: {
  deps: AgentDeps;
  text: string;
  args: Proposal;
  ctx: MatchContext;
  clarificationReason?: 'ambiguous_reference' | 'missing_goal';
}) {
  const { deps, ctx, text, args } = p;
  const scoped = (ctx.taskCandidates ?? []).filter(
    (task) =>
      task.ownerUserId === ctx.userId &&
      task.scope.channel === (ctx.channel ?? 'telegram') &&
      task.scope.chatId === ctx.chatId &&
      !['completed', 'cancelled', 'expired'].includes(task.status),
  );
  if (
    args.route === 'clarify' &&
    p.clarificationReason === 'ambiguous_reference' &&
    scoped.length === 1
  ) {
    ctx.taskPlanFailures = (ctx.taskPlanFailures ?? 0) + 1;
    await record(deps, ctx, 'single_task_reference_rejected');
    return PLAN_TASK.feedback.singleScopedTask(scoped[0]!.id);
  }
  try {
    const result = await applyProposal({ deps, ctx, args, text });
    await record(deps, ctx, ctx.taskUpdate?.kind ?? 'unknown');
    return result;
  } catch (error) {
    ctx.taskPlanFailures = (ctx.taskPlanFailures ?? 0) + 1;
    await record(deps, ctx, error instanceof Error ? error.name : 'unknown_error');
    // No SQL/API error detail or user text enters the trace or the model-visible fallback.
    const feedback =
      error instanceof TaskProposalError || error instanceof TaskTransitionError
        ? error.message
        : error instanceof z.ZodError
          ? error.issues.map((issue) => issue.path.join('.') + ':' + issue.code).join('; ')
          : PLAN_TASK.feedback.fallback;
    return PLAN_TASK.feedback.rejected(feedback);
  }
}

function emptyProposal(route: Proposal['route']): Proposal {
  return {
    route,
    taskRef: null,
    referenceQuote: null,
    objective: null,
    category: null,
    patch: null,
    outcome: null,
  };
}
/** Flat, purpose-specific schemas keep update turns small and remove irrelevant nullable fields. */
export function taskPlanningTools(deps: AgentDeps, text: string, taskRefs?: string[]) {
  const [first, ...rest] = taskRefs ?? [];
  const taskRef = first ? z.enum([first, ...rest]) : z.string().min(1).max(160);
  const errorFunction = (rc: RunContext) => invalidInput(deps, rc.context as MatchContext);
  const start = tool({
    name: 'start_task',
    description: PLAN_TASK.startTask.description,
    parameters: z.strictObject({
      objective: taskProposalSchema.shape.objective.unwrap(),
      category: taskProposalSchema.shape.category.unwrap(),
      goals: taskPatchProposalSchema.shape.goals,
      constraints: taskPatchProposalSchema.shape.constraints,
    }),
    needsApproval: false,
    errorFunction,
    execute: (args, rc) =>
      runProposal({
        deps,
        text,
        ctx: (rc as RunContext<MatchContext>).context,
        args: {
          ...emptyProposal('new'),
          objective: args.objective,
          category: args.category,
          patch: { goals: args.goals, constraints: args.constraints },
        },
      }),
  });
  const update = tool({
    name: 'update_task',
    description: PLAN_TASK.updateTask.description,
    parameters: z.strictObject({
      taskRef,
      referenceQuote: taskProposalSchema.shape.referenceQuote,
      goals: taskPatchProposalSchema.shape.goals,
      constraints: taskPatchProposalSchema.shape.constraints,
      outcome: taskProposalSchema.shape.outcome,
    }),
    needsApproval: false,
    errorFunction,
    execute: (args, rc) =>
      runProposal({
        deps,
        text,
        ctx: (rc as RunContext<MatchContext>).context,
        args: {
          ...emptyProposal('continue'),
          taskRef: args.taskRef,
          referenceQuote: args.referenceQuote,
          patch: { goals: args.goals, constraints: args.constraints },
          outcome: args.outcome,
        },
      }),
  });
  const clarify = tool({
    name: 'clarify_task',
    description: PLAN_TASK.clarifyTask.description,
    parameters: z.strictObject({ reason: z.enum(['ambiguous_reference', 'missing_goal']) }),
    needsApproval: false,
    errorFunction,
    execute: (args, rc) =>
      runProposal({
        deps,
        text,
        ctx: (rc as RunContext<MatchContext>).context,
        args: emptyProposal('clarify'),
        clarificationReason: args.reason,
      }),
  });
  const acknowledge = tool({
    name: 'acknowledge_task',
    description: PLAN_TASK.acknowledgeTask.description,
    parameters: z.strictObject({}),
    needsApproval: false,
    errorFunction,
    execute: (_args, rc) =>
      runProposal({
        deps,
        text,
        ctx: (rc as RunContext<MatchContext>).context,
        args: emptyProposal('ignore'),
      }),
  });
  return [
    start,
    ...(taskRefs === undefined || taskRefs.length ? [update] : []),
    clarify,
    acknowledge,
  ];
}
async function record(deps: AgentDeps, ctx: MatchContext, decision: string) {
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: ctx.sourceMessageId,
    phase: ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: {
      gate: 'task_preparation',
      decision,
      taskId: ctx.task?.id ?? null,
      revision: ctx.task?.revision ?? null,
      attempt: ctx.taskPlanFailures ?? 0,
      scopedCandidateCount: ctx.taskCandidates?.length ?? 0,
    },
  });
}

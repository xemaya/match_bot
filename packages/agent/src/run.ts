import { pendingResearchConditions, researchFollowupInstruction } from './research-readiness.js';
import { buildDeliveryPacket } from './delivery-context.js';
import { replyRequestStatusTool } from './tools/reply-request-status.js';
import { canSkipSupplementReply } from './supplement-replies.js';
import { bindCurrentRequest } from './current-request.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Approval, RunState } from '@matchbot/db';
import type { DemandDraft, ExecutionLease, Phase } from '@matchbot/domain';
import { resolveTaskMarketTarget, bindTaskMarketPlan } from './task-market-plan.js';
import { decrypt, encrypt } from '@matchbot/shared';
import { RunContext, RunState as SdkRunState } from '@openai/agents';
import { z } from 'zod';
import { AGENT_VERSION, createMatchAgent } from './agent.js';
import type { AgentDeps, MatchContext } from './context.js';
import { createPgSession } from './session.js';
import { restoreSearchContext } from './restore-search-context.js';
import { prepareTaskTurn } from './task-preparation.js';
import { refreshTaskSourceMemory } from './task-source-refresh.js';
import { restoreExecutionCheckpoint } from './execution-checkpoint.js';

export type RunOutcome =
  { kind: 'completed'; toolsCalled: string[] } | { kind: 'interrupted'; runStateId: string };

const SNAPSHOT_TTL_DAYS = 7; // AGENTS.md §6：7 天后标 expired
const MAX_TURNS = 12; // P14：需求建档 + 分主题召回 + 展名补全 + 一次回复，仍有固定上限

/** 从 @openai/agents 的 package.json 读版本，避免手写漂移；读不到就标 unknown。 */
function resolveSdkVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve('@openai/agents');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
export const SDK_VERSION = resolveSdkVersion();

class ObsoleteResumeError extends Error {
  constructor() {
    super('approval snapshot is obsolete or inaccessible');
    this.name = 'ObsoleteResumeError';
  }
}

const RUN_OPTIONS = { maxTurns: MAX_TURNS } as const;
const RUN_TIMEOUT_MS = 150000;
const DELIVERY_RESERVE_MS = 30000;

export async function runInbound(p: {
  deps: AgentDeps;
  ctx: MatchContext;
  input: string;
  checkpoint?: string | null;
}): Promise<RunOutcome> {
  if (p.ctx.execution) {
    if (
      p.ctx.execution.userId !== p.ctx.userId ||
      p.ctx.execution.messageId !== p.ctx.sourceMessageId
    )
      throw new Error('execution context identity mismatch');
    p = { ...p, deps: { ...p.deps, repos: p.deps.repos.forExecution(p.ctx.execution) } };
  }
  p.ctx.runDeadlineAt = Date.now() + RUN_TIMEOUT_MS;
  const signal = AbortSignal.timeout(RUN_TIMEOUT_MS);
  const session = createPgSession({
    repos: p.deps.repos,
    userId: p.ctx.userId,
    isolatePreviousTurns: !!p.deps.answerRequests,
  });
  const recovery = p.ctx.execution
    ? await p.deps.repos.executions.recoveryFlags(p.ctx.execution)
    : null;
  if (p.deps.taskRequests) {
    if (!p.deps.answerRequests) throw new Error('taskRequests requires answerRequests');
    bindCurrentRequest(p.ctx, p.input);
    if (!(await prepareTaskTurn({ ...p, signal }))) {
      if (p.ctx.currentRequest && (p.ctx.addressedToBot || p.ctx.taskCandidates?.length))
        p.ctx.currentRequest.isActionable = true;
      return respondRequestStatus(p, session);
    }
  }
  if (p.deps.answerRequests) {
    bindCurrentRequest(p.ctx, p.input);
    if (p.checkpoint && p.ctx.execution) {
      try {
        Object.assign(
          p.ctx,
          restoreExecutionCheckpoint(p.deps, p.ctx, p.input, p.checkpoint, AGENT_VERSION),
        );
        const restoredDemandId = p.ctx.demandId;
        bindCurrentRequest(p.ctx, p.input);
        if (restoredDemandId) p.ctx.demandId = restoredDemandId;
      } catch (error) {
        await p.deps.repos.traces.create({
          kind: 'gate',
          inputRef: p.ctx.sourceMessageId,
          phase: p.ctx.phase,
          latencyMs: 0,
          costMicro: 0,
          output: {
            gate: 'execution_checkpoint',
            decision: 'discarded',
            errorKind: error instanceof Error ? error.name : 'unknown',
          },
        });
      }
    }
    if (recovery?.outboundBlocked) p.ctx.outboundBlocked = true;
    if (recovery?.answerInputExhausted) p.ctx.answerInputExhausted = true;
    if (
      p.ctx.currentRequest &&
      (p.ctx.taskUpdate?.kind === 'ambiguous' || p.ctx.taskUpdate?.kind === 'unbound')
    )
      p.ctx.currentRequest.isActionable = true;
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      output: {
        gate: 'current_request',
        category: p.ctx.currentRequest?.demand.category,
        ...(p.ctx.task
          ? {
              taskId: p.ctx.task.id,
              taskRevision: p.ctx.task.revision,
              requirementsVersion: p.ctx.task.requirementsVersion,
            }
          : {}),
      },
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
  }
  if (recovery?.outboundBlocked || recovery?.answerInputExhausted)
    return respondRequestStatus(p, session);
  if (p.deps.marketSearch) {
    p.ctx.marketTarget = resolveTaskMarketTarget(p.ctx.task, p.input);
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      output: { gate: 'market_trade_direction', target: p.ctx.marketTarget },
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
  }
  const ambiguous = p.ctx.taskUpdate?.kind === 'ambiguous' || p.ctx.taskUpdate?.kind === 'unbound';
  if (!ambiguous) await refreshTaskSourceMemory({ ...p, agentVersion: AGENT_VERSION });
  const { agent, runner } = createMatchAgent(p.deps, {
    context: p.ctx,
    phase: p.ctx.phase,
    input: p.ctx.currentRequest?.text ?? p.input,
    checkpointInput: p.input,
    finalAnswerOnly: ambiguous,
    inputRef: p.ctx.sourceMessageId,
    requestContext: p.ctx,
    ...(p.ctx.task ? { taskId: p.ctx.task.id } : {}),
  });
  let result: SettleResult;
  try {
    const remainingResearch =
      (p.ctx.runDeadlineAt ?? Date.now()) - Date.now() - DELIVERY_RESERVE_MS;
    const researchSignal =
      p.deps.answerRequests && p.deps.taskRequests
        ? AbortSignal.timeout(Math.max(1, remainingResearch))
        : signal;
    result = await runner.run(agent, p.input, {
      context: p.ctx,
      session,
      ...RUN_OPTIONS,
      signal: researchSignal,
    });
  } catch (error) {
    if (!p.deps.answerRequests || !(error instanceof Error) || /Guardrail/.test(error.name))
      throw error;
    p.ctx.sourceFailures ??= [];
    p.ctx.sourceFailures.push('processing:' + error.name);
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      output: { gate: 'answer_finalization', reason: error.name },
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
    if (
      !p.ctx.outboundBlocked &&
      !p.ctx.answerInputExhausted &&
      (error.name === 'MaxTurnsExceededError' ||
        (p.deps.taskRequests &&
          (error.name === 'TimeoutError' || error.name === 'AbortError') &&
          (p.ctx.knowledgeSources?.length || p.ctx.marketListings?.length))) &&
      (p.ctx.runDeadlineAt ?? 0) > Date.now()
    )
      return finalizeRequest(p, session);
    return respondRequestStatus(p, session);
  }
  // A natural-language finish must not bypass the same gate as record_task_progress.
  // One bounded continuation only; exhausted/failed research can still produce a partial answer.
  if (
    p.deps.answerRequests &&
    p.deps.taskRequests &&
    !result.interruptions.length &&
    !p.ctx.answerRecorded &&
    !p.ctx.outboundBlocked &&
    !p.ctx.answerInputExhausted &&
    p.ctx.task?.nextStep?.action !== 'ask_user' &&
    pendingResearchConditions(p.ctx).length &&
    (p.deps.marketSearch || p.deps.webSearch?.research)
  ) {
    const remaining = (p.ctx.runDeadlineAt ?? Date.now()) - Date.now() - DELIVERY_RESERVE_MS;
    if (remaining > 0) {
      await p.deps.repos.traces.create({
        kind: 'gate',
        inputRef: p.ctx.sourceMessageId,
        phase: p.ctx.phase,
        latencyMs: 0,
        costMicro: 0,
        output: { gate: 'research_continuation', reason: 'new_hard_condition_unresearched' },
      });
      try {
        result = await runner.run(agent, researchFollowupInstruction(p.ctx), {
          context: p.ctx,
          session,
          maxTurns: 3,
          signal: AbortSignal.timeout(remaining),
        });
      } catch (error) {
        if (!(error instanceof Error) || /Guardrail/.test(error.name)) throw error;
        p.ctx.sourceFailures ??= [];
        p.ctx.sourceFailures.push('processing:' + error.name);
        return finalizeRequest(p, session);
      }
    }
  }
  if (
    p.deps.answerRequests &&
    result.interruptions.some((item) => !hasValidArguments(item.arguments))
  ) {
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      output: { gate: 'answer_finalization', reason: 'malformed_tool_json' },
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
    });
    p.ctx.sourceFailures ??= [];
    p.ctx.sourceFailures.push('processing:invalid_tool_input');
    return finalizeRequest(p, session);
  }
  if (
    p.deps.answerRequests &&
    !result.interruptions.length &&
    !p.ctx.answerRecorded &&
    !p.ctx.replySuppressed &&
    p.ctx.currentRequest?.isActionable &&
    p.ctx.currentRequest.demand.category !== 'job'
  )
    return canSkipSupplementReply(p.ctx) || p.ctx.outboundBlocked || p.ctx.answerInputExhausted
      ? respondRequestStatus(p, session)
      : finalizeRequest(p, session);
  return settle(p.deps, p.ctx, result);
}

function hasValidArguments(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return z.record(z.string(), z.unknown()).safeParse(JSON.parse(raw) as unknown).success;
  } catch {
    return false;
  }
}

async function finalizeRequest(
  p: { deps: AgentDeps; ctx: MatchContext; input: string },
  session: ReturnType<typeof createPgSession>,
): Promise<RunOutcome> {
  const remaining = (p.ctx.runDeadlineAt ?? Date.now() + 30000) - Date.now();
  if (remaining <= 0) return respondRequestStatus(p, session);
  p.ctx.isAnswerFinalization = true;
  const packet = buildDeliveryPacket(p.ctx);
  p.ctx.deliverySourceRefs = packet.refs;
  // Keep the same user-owned persistent session, but give this stage its own model window.
  const deliverySession = createPgSession({
    repos: p.deps.repos,
    userId: p.ctx.userId,
    isolatePreviousTurns: true,
  });
  await p.deps.repos.traces.create({
    kind: 'gate',
    inputRef: p.ctx.sourceMessageId,
    phase: p.ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: {
      gate: 'delivery_stage',
      decision: 'entered',
      sourceCount: packet.refs.length,
      marketCount: packet.market.length,
      knowledgeCount: packet.knowledge.length,
      reason:
        p.ctx.taskProgressVersion === p.ctx.task?.requirementsVersion
          ? 'planned_delivery'
          : 'bounded_finalization',
    },
  });
  if (p.ctx.answerInputExhausted) {
    p.ctx.sourceFailures ??= [];
    p.ctx.sourceFailures.push('processing:invalid_evidence');
  }
  const { agent, runner } = createMatchAgent(p.deps, {
    context: p.ctx,
    phase: p.ctx.phase,
    input: p.input,
    finalAnswerOnly: true,
    inputRef: p.ctx.sourceMessageId,
    ...(p.ctx.task ? { taskId: p.ctx.task.id } : {}),
  });
  try {
    let result = await runner.run(agent, p.input, {
      context: p.ctx,
      session: deliverySession,
      maxTurns: 3,
      signal: AbortSignal.timeout(Math.min(30000, remaining)),
    });
    const failures = p.ctx.outboundInputFailures?.count ?? 0;
    const repairRemaining = (p.ctx.runDeadlineAt ?? Date.now()) - Date.now();
    if (
      !result.interruptions.length &&
      !p.ctx.answerRecorded &&
      !p.ctx.outboundBlocked &&
      !p.ctx.answerInputExhausted &&
      failures > 0 &&
      failures < 3 &&
      repairRemaining > 0
    ) {
      await p.deps.repos.traces.create({
        kind: 'gate',
        inputRef: p.ctx.sourceMessageId,
        phase: p.ctx.phase,
        latencyMs: 0,
        costMicro: 0,
        output: {
          gate: 'delivery_repair',
          decision: 'continued',
          reason: 'stopped_after_invalid_draft',
          attempts: failures,
        },
      });
      result = await runner.run(
        agent,
        'Correct the rejected draft using validationFeedback. Preserve supported useful facts, remove unsupported claims, and call reply_to_request. Do not claim the user task is complete.',
        {
          context: p.ctx,
          session: deliverySession,
          maxTurns: Math.min(2, 3 - failures),
          signal: AbortSignal.timeout(Math.min(15000, repairRemaining)),
        },
      );
    }
    if (result.interruptions.some((item) => !hasValidArguments(item.arguments)))
      return respondRequestStatus(p, deliverySession);
    if (!result.interruptions.length && !p.ctx.answerRecorded)
      return respondRequestStatus(p, deliverySession);
    return settle(p.deps, p.ctx, result);
  } catch (error) {
    if (!(error instanceof Error) || /Guardrail/.test(error.name)) throw error;
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'delivery_stage',
        decision: 'failed',
        errorKind: error.name,
        ...(error instanceof z.ZodError
          ? {
              issues: error.issues.map((issue) => ({
                path: issue.path.join('.'),
                code: issue.code,
              })),
            }
          : {}),
        inputFailures: p.ctx.outboundInputFailures?.count ?? 0,
      },
    });
    return respondRequestStatus(p, deliverySession);
  }
}

async function respondRequestStatus(
  p: { deps: AgentDeps; ctx: MatchContext; input: string },
  session: ReturnType<typeof createPgSession>,
): Promise<RunOutcome> {
  if (
    !p.ctx.currentRequest?.isActionable ||
    p.ctx.currentRequest.demand.category === 'job' ||
    p.ctx.answerRecorded ||
    p.ctx.replySuppressed
  )
    return { kind: 'completed', toolsCalled: [] };
  if (canSkipSupplementReply(p.ctx)) {
    p.ctx.replySuppressed = true;
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'request_status',
        decision: 'suppressed',
        reason: 'no_new_help_for_context_supplement',
      },
    });
    return { kind: 'completed', toolsCalled: [] };
  }
  p.ctx.isRequestStatusRun = true;
  await p.deps.repos.traces.create({
    kind: 'gate',
    inputRef: p.ctx.sourceMessageId,
    phase: p.ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: {
      gate: 'request_status',
      reason:
        p.ctx.outboundDeclineReason ??
        (p.ctx.answerInputExhausted ? 'invalid_evidence' : 'no_answer'),
    },
  });
  const status = replyRequestStatusTool(p.deps);
  const context = new RunContext(p.ctx);
  // No generation model is needed for a fixed acknowledgement. Approval-required phases still use the SDK snapshot path.
  if (!(await status.needsApproval(context, {}, 'request-status:' + p.ctx.sourceMessageId))) {
    await status.invoke(context, '{}');
    return { kind: 'completed', toolsCalled: ['reply_request_status'] };
  }
  const { agent, runner } = createMatchAgent(p.deps, {
    context: p.ctx,
    phase: p.ctx.phase,
    input: p.input,
    requestStatusOnly: true,
    inputRef: p.ctx.sourceMessageId,
    ...(p.ctx.task ? { taskId: p.ctx.task.id } : {}),
  });
  const result = await runner.run(agent, 'Call reply_request_status with {} exactly once.', {
    context: p.ctx,
    session,
    maxTurns: 2,
    signal: AbortSignal.timeout(30000),
  });
  return settle(p.deps, p.ctx, result);
}

/**
 * 审批恢复入口。快照只从服务端存储来（AGENTS.md §3.3 第 6 条）；重复消费由
 * repos.runStates.consume 在上游原子拒绝，这里假定拿到的 runState 已被独占。
 * PoC V2：批准一次 ≠ 跑完——若恢复后仍有中断，settle 会再写一行 pending run_state。
 */
export async function resumeRun(p: {
  deps: AgentDeps;
  runState: RunState;
  approval: Approval;
  execution?: ExecutionLease;
}): Promise<RunOutcome> {
  if (p.runState.messageId && !p.execution) throw new ObsoleteResumeError();
  if (p.execution) {
    if (
      p.runState.status !== 'consumed' ||
      p.runState.userId !== p.execution.userId ||
      p.runState.messageId !== p.execution.messageId ||
      p.approval.runStateId !== p.runState.id ||
      p.runState.agentVersion !== AGENT_VERSION ||
      p.runState.sdkVersion !== SDK_VERSION ||
      p.runState.expiresAt.getTime() <= Date.now()
    )
      throw new ObsoleteResumeError();
    p = { ...p, deps: { ...p.deps, repos: p.deps.repos.forExecution(p.execution) } };
  }
  const snapshot = decrypt(p.runState.snapshot, snapshotKey(p.deps));
  if (p.execution) {
    const original = z
      .object({
        context: z.object({
          context: z.object({
            userId: z.string(),
            chatId: z.string(),
            sourceMessageId: z.string(),
          }),
        }),
      })
      .parse(JSON.parse(snapshot) as unknown).context.context;
    if (
      original.userId !== p.execution.userId ||
      original.chatId !== p.runState.chatId ||
      original.sourceMessageId !== p.execution.messageId
    )
      throw new ObsoleteResumeError();
  }
  const rebuilt = await rebuildContext(p.deps, p.runState, p.execution);
  const ctx = restoreSearchContext(rebuilt, snapshot);
  ctx.runDeadlineAt = Date.now() + RUN_TIMEOUT_MS;
  if (p.execution) {
    ctx.groupId = rebuilt.groupId;
    ctx.sourceMessageId = rebuilt.sourceMessageId;
    if (rebuilt.source) ctx.source = rebuilt.source;
    const group = ctx.groupId
      ? await p.deps.repos.groups.findByExternal(ctx.channel ?? 'telegram', ctx.chatId)
      : null;
    if (ctx.groupId && (!group || !group.isActive)) throw new ObsoleteResumeError();
    const rawPhase = group?.phase ?? p.deps.env.DEFAULT_PHASE;
    const currentPhase = rawPhase === 1 || rawPhase === 2 ? rawPhase : 0;
    ctx.phase = Math.min(ctx.phase, currentPhase) as Phase;
    if (ctx.phase === 0) throw new ObsoleteResumeError();
    if (group?.rateLimitPerDay !== null && group?.rateLimitPerDay !== undefined)
      ctx.rateLimitPerDay = group.rateLimitPerDay;
    else delete ctx.rateLimitPerDay;
    const flags = await p.deps.repos.executions.recoveryFlags(p.execution);
    if (flags.outboundBlocked || p.approval.decision !== 'approve') ctx.outboundBlocked = true;
    if (flags.answerInputExhausted) ctx.answerInputExhausted = true;
    const message = await p.deps.repos.messages.findById(p.execution.messageId);
    if (!message?.text) throw new ObsoleteResumeError();
    const demandId = ctx.demandId;
    bindCurrentRequest(ctx, message.text);
    if (demandId) ctx.demandId = demandId;
    if (ctx.task && ctx.marketPlan) ctx.marketPlan = bindTaskMarketPlan(ctx.marketPlan, ctx.task);
  }
  const { agent, runner } = createMatchAgent(p.deps, {
    context: ctx,
    phase: ctx.phase,
    requestStatusOnly: !!ctx.isRequestStatusRun,
    finalAnswerOnly: !!ctx.isAnswerFinalization && !ctx.isRequestStatusRun,
    inputRef: ctx.sourceMessageId,
    ...(ctx.task ? { taskId: ctx.task.id } : {}),
  });
  // PoC V2：用 fromStringWithContext 才能还原自己的 RunContext
  const state = await SdkRunState.fromStringWithContext(agent, snapshot, new RunContext(ctx));
  for (const item of state.getInterruptions()) {
    if (p.approval.decision === 'approve') {
      state.approve(item);
    } else {
      // 「改文案」Phase 1 由运营旁路发送（架构 §4.3 第 5 条），这里只终止原调用
      const message =
        p.approval.decision === 'ignore'
          ? 'Ops decided not to reply this time.'
          : p.approval.decision === 'edit'
            ? 'Ops sent an edited version manually. Do not retry this outbound action.'
            : 'Ops rejected this reply.';
      state.reject(item, { message });
    }
  }
  const session = createPgSession({ repos: p.deps.repos, userId: ctx.userId });
  const result = await runner.run(agent, state, {
    context: ctx,
    session,
    ...RUN_OPTIONS,
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  if (
    p.execution &&
    p.deps.answerRequests &&
    !result.interruptions.length &&
    !ctx.answerRecorded &&
    ctx.currentRequest?.isActionable
  ) {
    const message = await p.deps.repos.messages.findById(p.execution.messageId);
    return respondRequestStatus({ deps: p.deps, ctx, input: message?.text ?? '' }, session);
  }
  return settle(p.deps, ctx, result);
}

function snapshotKey(deps: AgentDeps): string {
  const key = deps.env.SNAPSHOT_KEY;
  if (!key) throw new Error('SNAPSHOT_KEY is required to persist/resume run_states snapshots');
  return key;
}

/** run_states 只存 userId/chatId/phase；其余上下文恢复时重建：开放需求从库里取最新一条。 */
async function rebuildContext(
  deps: AgentDeps,
  runState: RunState,
  execution?: ExecutionLease,
): Promise<MatchContext> {
  if (execution) {
    const message = await deps.repos.messages.findById(execution.messageId);
    if (!message || message.userId !== execution.userId || !message.text)
      throw new ObsoleteResumeError();
    const user = await deps.repos.users.findById(execution.userId);
    if (!user) throw new ObsoleteResumeError();
    const group = message.groupId
      ? await deps.repos.groups.findByExternal(user.channel, runState.chatId)
      : null;
    if (message.groupId ? group?.id !== message.groupId : user.externalId !== runState.chatId)
      throw new ObsoleteResumeError();
    const task = message.taskId
      ? await deps.repos.tasks.findById({
          access: { userId: user.id, scope: { channel: user.channel, chatId: runState.chatId } },
          id: message.taskId,
        })
      : null;
    if (
      message.taskId &&
      (!task ||
        task.requirementsVersion !== message.taskRequirementsVersion ||
        ['completed', 'cancelled', 'expired'].includes(task.status))
    )
      throw new ObsoleteResumeError();
    if (
      task &&
      (await deps.repos.tasks.findLatestUserMessageId({
        access: { userId: user.id, scope: { channel: user.channel, chatId: runState.chatId } },
        id: task.id,
      })) !== message.id
    )
      throw new ObsoleteResumeError();
    return {
      execution,
      userId: user.id,
      channel: user.channel,
      chatId: runState.chatId,
      groupId: message.groupId,
      phase: runState.phase === 1 || runState.phase === 2 ? runState.phase : 0,
      sourceMessageId: message.id,
      source: { messageId: message.externalId, userId: user.externalId },
      recentReplies: [],
      ...(task ? { task } : {}),
    };
  }
  const [open] = await deps.repos.demands.findOpenByUser(runState.userId);
  // Prisma 列是 Int，这里收窄回 Phase；脏数据按 Phase 0（最保守）处理
  const phase: Phase = runState.phase === 1 || runState.phase === 2 ? runState.phase : 0;
  if (!open) {
    return {
      userId: runState.userId,
      chatId: runState.chatId,
      groupId: null,
      phase,
      sourceMessageId: runState.id,
      recentReplies: [],
    };
  }
  const demand: DemandDraft = {
    category: open.category,
    confidence: open.confidence,
    ...(open.whenText ? { whenText: open.whenText } : {}),
    ...(open.whenAt ? { whenAt: open.whenAt.toISOString() } : {}),
    ...(open.fromPostcode ? { fromPostcode: open.fromPostcode } : {}),
    ...(open.toPostcode ? { toPostcode: open.toPostcode } : {}),
    ...(open.quantity ? { quantity: open.quantity } : {}),
    ...(open.budgetPence !== null ? { budgetPence: open.budgetPence } : {}),
    ...(open.lang ? { lang: open.lang } : {}),
  };
  return {
    userId: runState.userId,
    chatId: runState.chatId,
    groupId: null,
    phase,
    sourceMessageId: runState.id,
    recentReplies: [],
    demand,
    demandId: open.id,
  };
}

interface SettleResult {
  interruptions: Array<{
    name?: string | undefined;
    arguments?: string | undefined;
    rawItem?: unknown;
  }>;
  state: { toString(): string };
  newItems: Array<{ type: string; rawItem: unknown }>;
}

async function settle(
  deps: AgentDeps,
  ctx: MatchContext,
  result: SettleResult,
): Promise<RunOutcome> {
  if (result.interruptions.length > 0) {
    const row = await deps.repos.runStates.create({
      userId: ctx.userId,
      chatId: ctx.chatId,
      phase: ctx.phase,
      ...(ctx.execution ? { messageId: ctx.execution.messageId } : {}),
      ...(ctx.execution && ctx.task
        ? { task: { id: ctx.task.id, requirementsVersion: ctx.task.requirementsVersion } }
        : {}),
      snapshot: encrypt(result.state.toString(), snapshotKey(deps)),
      agentVersion: AGENT_VERSION,
      sdkVersion: SDK_VERSION,
      interruptions: result.interruptions.map((i) => {
        const parsed = z.object({ callId: z.string() }).safeParse(i.rawItem);
        const draftText = parsed.success ? ctx.outboundPreviews?.[parsed.data.callId] : undefined;
        return {
          tool: i.name ?? 'unknown',
          args: i.arguments ?? '',
          ...(draftText ? { draftText } : {}),
        };
      }),
      expiresAt: new Date(Date.now() + SNAPSHOT_TTL_DAYS * 86400e3),
    });
    return { kind: 'interrupted', runStateId: row.id };
  }
  const toolsCalled = result.newItems
    .filter((i) => i.type === 'tool_call_item')
    .map((i) => (i.rawItem as { name?: string }).name ?? 'unknown');
  return { kind: 'completed', toolsCalled };
}

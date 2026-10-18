import { runtimeContext } from './prompts/runtime-context.js';
import { createMatchAgent } from './agent.js';
import type { AgentDeps, MatchContext } from './context.js';

/** Same matchAgent, bounded preparation stage; no searches or outbound tools are registered here. */
export async function prepareTaskTurn(p: {
  deps: AgentDeps;
  ctx: MatchContext;
  input: string;
  signal: AbortSignal;
}): Promise<boolean> {
  try {
    if (p.ctx.execution) {
      const task = await p.deps.repos.tasks.findAppliedTurn({
        access: {
          userId: p.ctx.userId,
          scope: {
            channel: p.ctx.channel ?? 'telegram',
            chatId: p.ctx.chatId,
            ...(p.ctx.threadId ? { threadId: p.ctx.threadId } : {}),
          },
        },
        sourceMessageId: p.ctx.sourceMessageId,
      });
      if (task) {
        p.ctx.task = task;
        p.ctx.taskUpdate = {
          kind:
            task.status === 'completed' || task.status === 'cancelled' ? task.status : 'continued',
        };
        await p.deps.repos.traces.create({
          kind: 'gate',
          inputRef: p.ctx.sourceMessageId,
          phase: p.ctx.phase,
          latencyMs: 0,
          costMicro: 0,
          output: { gate: 'task_preparation', decision: 'recovered_applied_turn', taskId: task.id },
        });
        return true;
      }
    }
    if (p.ctx.replyToMessageId) {
      const anchor = await p.deps.repos.tasks.findReplyAnchor({
        access: {
          userId: p.ctx.userId,
          scope: {
            channel: p.ctx.channel ?? 'telegram',
            chatId: p.ctx.chatId,
            ...(p.ctx.threadId ? { threadId: p.ctx.threadId } : {}),
          },
        },
        externalMessageId: p.ctx.replyToMessageId,
      });
      if (anchor) p.ctx.taskAnchorId = anchor.id;
    }
    p.ctx.taskCandidates = await p.deps.repos.tasks.findOpenByScope({
      userId: p.ctx.userId,
      scope: {
        channel: p.ctx.channel ?? 'telegram',
        chatId: p.ctx.chatId,
        ...(p.ctx.threadId ? { threadId: p.ctx.threadId } : {}),
      },
    });
    if (
      p.ctx.taskCandidates.length > 100 ||
      JSON.stringify(runtimeContext(p.ctx, 'planning')).length > 32000
    ) {
      p.ctx.taskUpdate = { kind: 'ambiguous' };
      await p.deps.repos.traces.create({
        kind: 'gate',
        inputRef: p.ctx.sourceMessageId,
        phase: p.ctx.phase,
        latencyMs: 0,
        costMicro: 0,
        output: {
          gate: 'task_preparation',
          decision: 'clarify',
          reason: 'candidate_budget',
          count: p.ctx.taskCandidates.length,
        },
      });
      return true;
    }
    const { agent, runner } = createMatchAgent(p.deps, {
      context: p.ctx,
      phase: p.ctx.phase,
      input: p.input,
      taskPlanningOnly: true,
      taskRefs: p.ctx.taskCandidates.map((task) => task.id),
      inputRef: p.ctx.sourceMessageId,
    });
    await runner.run(agent, p.input, {
      context: p.ctx,
      maxTurns: 2,
      signal: AbortSignal.any([p.signal, AbortSignal.timeout(45000)]),
    });
    if (p.ctx.taskUpdate) {
      if (p.ctx.taskUpdate.kind !== 'ambiguous' && p.ctx.taskUpdate.kind !== 'unbound')
        delete p.ctx.taskCandidates;
      return true;
    }
  } catch (error) {
    if (error instanceof Error && /Guardrail/.test(error.name)) throw error;
    await p.deps.repos.traces.create({
      kind: 'gate',
      inputRef: p.ctx.sourceMessageId,
      phase: p.ctx.phase,
      latencyMs: 0,
      costMicro: 0,
      output: {
        gate: 'task_preparation_failed',
        error: error instanceof Error ? error.name : 'unknown_error',
      },
    });
  }
  p.ctx.sourceFailures ??= [];
  p.ctx.sourceFailures.push('processing:task_preparation');
  return false;
}

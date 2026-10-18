import { describe, expect, it, vi } from 'vitest';
import { processResume } from '../../src/pipeline/resume.js';

function makeDeps(over: Record<string, unknown> = {}) {
  const runState = {
    id: 'rs1',
    userId: 'u1',
    chatId: '-100chat',
    phase: 1,
    status: 'consumed',
  };
  const runStates = { findById: vi.fn(() => Promise.resolve(runState)) };
  const lease = { userId: 'u1', messageId: 'message', token: 'lease', fence: 2 };
  const approval = { id: 'ap1', runStateId: 'rs1', decision: 'approve' };
  const approvals = {
    claimResume: vi.fn(() => Promise.resolve({ kind: 'acquired', runState, approval, lease })),
    finishResume: vi.fn(() => Promise.resolve(true)),
  };
  const traces = { create: vi.fn(() => Promise.resolve({})) };
  const base = {
    messages: { findById: vi.fn(() => Promise.resolve({ channelRoute: null })) },
    runStates,
    approvals,
    traces,
    demands: { findOpenByUser: vi.fn() },
  };
  const repos = { ...base, forExecution: vi.fn(() => base) };
  const resumeRun = vi.fn(() =>
    Promise.resolve({ kind: 'completed', toolsCalled: ['reply_in_group'] }),
  );
  const publishApproval = vi.fn(() => Promise.resolve());
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    env: { DEFAULT_PHASE: 0 },
    repos,
    resumeRun,
    publishApproval,
    cards: { sendApprovalCard: vi.fn() },
    logger,
    ...over,
  };
  return { deps, repos, runStates, approvals, traces, resumeRun, publishApproval, logger };
}

/** 取某个 mock 的第一次调用的第一个参数（vitest 推不出形状，测试里显式收窄）。 */
function firstArg<T>(fn: { mock: { calls: unknown[][] } }): T {
  const call = fn.mock.calls[0];
  expect(call, 'expected the mock to have been called').toBeDefined();
  return (call as unknown[])[0] as T;
}

describe('processResume', () => {
  it('loads run state + approval and hands both to resumeRun', async () => {
    const t = makeDeps();
    await processResume(t.deps as never, { runStateId: 'rs1', approvalId: 'ap1' });
    const arg = firstArg<{ runState: unknown; approval: unknown }>(t.resumeRun);
    expect(arg.runState).toMatchObject({ id: 'rs1', userId: 'u1', chatId: '-100chat' });
    expect(arg.approval).toMatchObject({ id: 'ap1', decision: 'approve' });
    const trace = t.traces.create.mock.calls[0]?.[0] as {
      kind: string;
      inputRef: string;
      phase: number;
      output: Record<string, unknown>;
    };
    expect(trace.kind).toBe('gate');
    expect(trace.inputRef).toBe('message');
    expect(trace.phase).toBe(1); // run_states.phase，不是 env.DEFAULT_PHASE
    expect(trace.output['outcome']).toBe('resume_completed');
  });

  it('missing run state or approval is a no-op that warns', async () => {
    const t = makeDeps();
    t.approvals.claimResume.mockResolvedValue({ kind: 'invalid' } as never);
    await processResume(t.deps as never, { runStateId: 'rs1', approvalId: 'ap1' });
    expect(t.resumeRun).not.toHaveBeenCalled();
    expect(t.traces.create).not.toHaveBeenCalled();
  });

  // PoC V2 ②：批准一次 ≠ 跑完，恢复后可能再中断，必须再发一张卡。
  it('a run that interrupts again publishes a fresh approval card', async () => {
    const t = makeDeps({
      resumeRun: vi.fn(() => Promise.resolve({ kind: 'interrupted', runStateId: 'rs2' })),
    });
    t.runStates.findById.mockImplementation((id: string) =>
      Promise.resolve({ id, userId: 'u1', chatId: '-100chat', phase: 1, status: 'pending' }),
    );
    await processResume(t.deps as never, { runStateId: 'rs1', approvalId: 'ap1' });
    expect(firstArg<{ runState: unknown }>(t.publishApproval).runState).toMatchObject({
      id: 'rs2',
    });
    const trace = t.traces.create.mock.calls[0]?.[0] as { output: Record<string, unknown> };
    expect(trace.output['outcome']).toBe('resume_interrupted');
    expect(trace.output['nextRunStateId']).toBe('rs2');
  });
  it('delays a contending resume without touching the model or completing the intent', async () => {
    const t = makeDeps();
    t.approvals.claimResume.mockResolvedValue({ kind: 'busy', retryAfterMs: 2000 } as never);
    expect(await processResume(t.deps as never, { runStateId: 'rs1', approvalId: 'ap1' })).toEqual({
      deferMs: 2000,
    });
    expect(t.resumeRun).not.toHaveBeenCalled();
    expect(t.approvals.finishResume).not.toHaveBeenCalled();
  });
  it('keeps failed generation dispatchable, but terminally refuses obsolete snapshots', async () => {
    const resumeRun = vi.fn().mockRejectedValueOnce(new Error('provider failed')),
      t = makeDeps({ resumeRun });
    await expect(
      processResume(t.deps as never, { runStateId: 'rs1', approvalId: 'ap1' }),
    ).rejects.toThrow('provider failed');
    expect(t.approvals.finishResume).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'accepted', errorCode: 'resume_failed' }),
    );
    const obsolete = new Error('obsolete');
    obsolete.name = 'ObsoleteResumeError';
    resumeRun.mockRejectedValueOnce(obsolete);
    await processResume(t.deps as never, { runStateId: 'rs1', approvalId: 'ap1' });
    expect(t.approvals.finishResume).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'obsolete_snapshot' }),
    );
  });
});

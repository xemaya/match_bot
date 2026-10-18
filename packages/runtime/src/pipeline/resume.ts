import { persistedChannelRoute } from '@matchbot/domain';
import type { AgentDeps, resumeRun as resumeRunFn } from '@matchbot/agent';
import type { publishApproval as publishApprovalFn } from '@matchbot/approval';

export interface ResumeDeps extends AgentDeps {
  resumeRun: typeof resumeRunFn;
  publishApproval: typeof publishApprovalFn;
  cards: Parameters<typeof publishApprovalFn>[0]['cards'];
}

/** An approval owns a durable wake intent and shares the inbound user fence. */
export async function processResume(
  d: ResumeDeps,
  job: { runStateId: string; approvalId: string },
): Promise<void | { deferMs: number }> {
  const claim = await d.repos.approvals.claimResume(job);
  if (claim.kind === 'busy') return { deferMs: claim.retryAfterMs };
  if (claim.kind !== 'acquired') return;
  const { runState, approval, lease } = claim;
  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof resumeRunFn>>;
  try {
    const source = await d.repos.messages.findById(claim.lease.messageId);
    const route = persistedChannelRoute(source?.channelRoute);
    if (route?.account) {
      const owner = await d.repos.users.findById(claim.lease.userId);
      if (!owner) throw new Error('resume owner missing');
      d = { ...d, repos: d.repos.forChannel(owner.channel, route.account) };
    }
    const deps = { ...d, repos: d.repos.forExecution(lease) };
    result = await d.resumeRun({ deps, runState, approval, execution: lease });
  } catch (error) {
    const errorKind = error instanceof Error ? error.name : 'unknown';
    await d.repos.approvals.finishResume({
      ...job,
      lease,
      status: errorKind === 'ObsoleteResumeError' ? 'failed' : 'accepted',
      errorCode: errorKind === 'ObsoleteResumeError' ? 'obsolete_snapshot' : 'resume_failed',
    });
    d.logger.warn({ runStateId: runState.id, errorKind }, 'resume did not complete');
    if (errorKind !== 'ObsoleteResumeError') throw error;
    return;
  }
  const finished = await d.repos.approvals.finishResume({
    ...job,
    lease,
    status: result.kind === 'interrupted' ? 'waiting_approval' : 'completed',
    ...(result.kind === 'interrupted' ? { nextRunStateId: result.runStateId } : {}),
  });
  if (!finished) return;
  await d.repos.traces.create({
    kind: 'gate',
    inputRef: lease.messageId,
    output: {
      gate: 'approval_execution',
      runStateId: runState.id,
      outcome: result.kind === 'completed' ? 'resume_completed' : 'resume_interrupted',
      ...(result.kind === 'completed'
        ? { toolsCalled: result.toolsCalled }
        : { nextRunStateId: result.runStateId }),
      decision: approval.decision,
    },
    phase: runState.phase === 1 || runState.phase === 2 ? runState.phase : 0,
    latencyMs: Date.now() - t0,
    costMicro: 0,
  });
  if (result.kind === 'interrupted') {
    const next = await d.repos.runStates.findById(result.runStateId);
    if (next) await d.publishApproval({ repos: d.repos, cards: d.cards, runState: next });
  }
}

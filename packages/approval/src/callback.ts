import { z } from 'zod';
import type { Repositories } from '@matchbot/db';
import { enqueueResume as defaultEnqueueResume, type Queues } from '@matchbot/queue';

export const approvalDecisionSchema = z.object({
  runStateId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  decision: z.enum(['approve', 'reject', 'ignore']),
});
type DecisionDeps = {
  repos: Repositories;
  queues: Queues;
  reviewer: string;
  enqueueResume?: typeof defaultEnqueueResume;
};
/** Compatibility decoder for existing Telegram callbacks; no platform SDK dependency. */
export async function handleApprovalCallback(
  p: DecisionDeps & { data: string },
): Promise<'queued' | 'pending' | 'ignored' | 'invalid'> {
  const match = /^apv:([A-Za-z0-9_-]+):(approve|reject|ignore)$/.exec(p.data);
  if (!match) return 'invalid';
  return handleApprovalDecision({ ...p, action: { runStateId: match[1]!, decision: match[2]! } });
}
/** Caller authenticates source and reviewer; the decision and wake intent commit atomically. */
export async function handleApprovalDecision(
  p: DecisionDeps & { action: unknown },
): Promise<'queued' | 'pending' | 'ignored' | 'invalid'> {
  const result = approvalDecisionSchema.safeParse(p.action);
  if (!result.success) return 'invalid';
  const parsed = result.data;
  const approval = await p.repos.approvals.decide({
    runStateId: parsed.runStateId,
    reviewer: p.reviewer,
    decision: parsed.decision,
  });
  if (!approval) return 'ignored';
  if (parsed.decision === 'ignore') return 'ignored';
  const job = { runStateId: parsed.runStateId, approvalId: approval.id };
  try {
    await (p.enqueueResume ?? defaultEnqueueResume)(p.queues, job);
    await p.repos.approvals.markEnqueued(job);
  } catch {
    // The authoritative decision already exists. Do not discard it or ask for a second approval.
    return 'pending';
  }
  return 'queued';
}

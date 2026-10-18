import { handleApprovalDecision, approvalDecisionSchema } from '@matchbot/approval';
import type { Repositories } from '@matchbot/db';
import type { Queues } from '@matchbot/queue';

/** Account-bound repositories and an authenticated adapter supply the immutable callback origin. */
export async function handleChannelApproval(p: {
  repos: Repositories;
  queues: Queues;
  opsChatId: string;
  reviewers: readonly string[];
  reviewer: string;
  chatId: string;
  messageId: string;
  action: unknown;
}): Promise<boolean> {
  if (p.chatId !== p.opsChatId || !p.reviewers.includes(p.reviewer)) return false;
  const action = approvalDecisionSchema.safeParse(p.action);
  if (!action.success) return false;
  const card = await p.repos.outbound.findDeliveredByExternal({
    target: p.chatId,
    externalMessageId: p.messageId,
  });
  if (!card || card.approvalRunStateId !== action.data.runStateId) return false;
  const result = await handleApprovalDecision({
    repos: p.repos,
    queues: p.queues,
    reviewer: p.reviewer,
    action: action.data,
  });
  return (
    result === 'queued' ||
    result === 'pending' ||
    (result === 'ignored' && action.data.decision === 'ignore')
  );
}

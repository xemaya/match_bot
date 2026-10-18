import type { Repositories, RunState } from '@matchbot/db';
import { persistedChannelRoute, type Channel, type Phase } from '@matchbot/domain';

export type ApprovalDestination = {
  opsChatId: string;
  defaultPhase: Phase;
  destinations?: Partial<Record<Channel, string>>;
};

/** 把中断快照渲染成运营群审批卡（架构 §4.3，Phase 1 审批台即运营群）。 */
export async function publishApproval(p: {
  repos: Repositories;
  cards: ApprovalDestination;
  runState: RunState;
}): Promise<void> {
  let repos = p.repos,
    destination = p.cards.opsChatId;
  if (p.cards.destinations && p.runState.messageId) {
    const source = await repos.messages.findById(p.runState.messageId);
    const owner = source ? await repos.users.findById(source.userId) : null;
    if (!source || !owner) throw new Error('approval source missing');
    const route = persistedChannelRoute(source.channelRoute);
    if (route?.account) repos = repos.forChannel(owner.channel, route.account);
    destination = p.cards.destinations[owner.channel] ?? '';
    if (!destination) throw new Error('approval channel destination not configured');
  }
  await repos.outbound.enqueueApprovalCard({
    runStateId: p.runState.id,
    opsChatId: destination,
    defaultPhase: p.cards.defaultPhase,
  });
}

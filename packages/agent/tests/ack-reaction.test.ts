import { describe, expect, it, vi } from 'vitest';
import { ACK_REACTION, REACTION_CLEAR } from '@matchbot/domain';
import { acknowledgeAsk, reactToThanks, withdrawAckIfSilent } from '../src/ack-reaction.js';
import type { AgentDeps, MatchContext } from '../src/context.js';

function setup(phase: 0 | 2, addressed: boolean) {
  const create = vi.fn((d: object, status: string) => Promise.resolve({ id: 'o', status, ...d }));
  const deps = {
    env: { JEV_POLICY: 'off' },
    repos: { outbound: { create }, traces: { create: vi.fn(() => Promise.resolve({})) } },
  } as unknown as AgentDeps;
  const ctx = {
    userId: 'u',
    chatId: '-1',
    groupId: 'g',
    phase,
    sourceMessageId: 'm',
    recentReplies: [],
    addressedToBot: addressed,
    source: { messageId: '9', userId: '42' },
    execution: { userId: 'u', messageId: 'm', token: 't' },
  } as unknown as MatchContext;
  return { deps, ctx, create };
}

describe('P55 ack reaction', () => {
  it('puts a 👀 on a direct ask, as a dry run in Phase 0, without counting as the answer', async () => {
    const { deps, ctx, create } = setup(0, true);
    await acknowledgeAsk(deps, ctx);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reaction', text: ACK_REACTION, replyToMessageId: '9' }),
      'dry_run',
    );
    expect(ctx.answerRecorded).toBeUndefined();
    expect(ctx.ackReactionSent).toBe(true);
  });
  it('sends it for real from Phase 1 on, and never on an overheard message', async () => {
    const live = setup(2, true);
    await acknowledgeAsk(live.deps, live.ctx);
    expect(live.create).toHaveBeenCalledWith(expect.anything(), 'pending');
    const overheard = setup(2, false);
    await acknowledgeAsk(overheard.deps, overheard.ctx);
    expect(overheard.create).not.toHaveBeenCalled();
  });
  it('withdraws the 👀 only when nothing else reached the group', async () => {
    const silent = setup(2, true);
    await acknowledgeAsk(silent.deps, silent.ctx);
    await withdrawAckIfSilent(silent.deps, silent.ctx);
    expect(silent.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: REACTION_CLEAR }),
      'pending',
    );
    const answered = setup(2, true);
    await acknowledgeAsk(answered.deps, answered.ctx);
    answered.ctx.answerRecorded = true;
    await withdrawAckIfSilent(answered.deps, answered.ctx);
    expect(answered.create).toHaveBeenCalledOnce();
  });
  it('answers a thanks addressed to A2H with a 👍, a dry run in Phase 0', async () => {
    const { deps, ctx, create } = setup(0, true);
    await reactToThanks(deps, {
      execution: ctx.execution,
      chatId: ctx.chatId,
      groupId: ctx.groupId,
      phase: 0,
      sourceMessageId: ctx.sourceMessageId,
      source: { messageId: '9', userId: '42' },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reaction', text: '👍', replyToMessageId: '9' }),
      'dry_run',
    );
  });
});

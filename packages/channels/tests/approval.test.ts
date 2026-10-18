import { it, expect, vi } from 'vitest';
import { handleChannelApproval } from '../src/approval.js';

it('requires reviewer, origin and delivered account-bound card before consuming approval', async () => {
  const findDeliveredByExternal = vi.fn().mockResolvedValue({ approvalRunStateId: 'rs1' });
  const decide = vi.fn().mockResolvedValue({ id: 'ap1' });
  const markEnqueued = vi.fn().mockResolvedValue(undefined);
  const add = vi.fn().mockResolvedValue({});
  const base = {
    repos: { outbound: { findDeliveredByExternal }, approvals: { decide, markEnqueued } },
    queues: { resume: { add } },
    reviewers: ['ou_reviewer'],
    opsChatId: 'oc_ops',
    reviewer: 'ou_reviewer',
    chatId: 'oc_ops',
    messageId: 'om_card',
    action: { runStateId: 'rs1', decision: 'approve' },
  };
  for (const override of [
    { reviewer: 'ou_stranger' },
    { chatId: 'oc_foreign' },
    { action: { runStateId: 'rs1', decision: 'forged' } },
  ]) {
    expect(await handleChannelApproval({ ...base, ...override } as never)).toBe(false);
  }
  expect(findDeliveredByExternal).not.toHaveBeenCalled();
  findDeliveredByExternal
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ approvalRunStateId: 'other' });
  expect(await handleChannelApproval(base as never)).toBe(false);
  expect(await handleChannelApproval(base as never)).toBe(false);
  expect(decide).not.toHaveBeenCalled();
  expect(await handleChannelApproval(base as never)).toBe(true);
  expect(findDeliveredByExternal).toHaveBeenLastCalledWith({
    target: 'oc_ops',
    externalMessageId: 'om_card',
  });
  expect(decide).toHaveBeenCalledWith({
    runStateId: 'rs1',
    reviewer: 'ou_reviewer',
    decision: 'approve',
  });
});

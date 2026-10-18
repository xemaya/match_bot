import { channelRouteSchema, type InboundMessage } from '@matchbot/domain';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import { processInbound } from '../../src/pipeline/inbound.js';

const msg = {
  channel: 'telegram' as const,
  chatId: '-1',
  messageId: '5',
  userId: '42',
  text: 'need a van E14 to SE1 sunday',
  receivedAt: new Date().toISOString(),
};

const verdict = {
  ok: true as const,
  isDemand: 0.92,
  isSupply: 0.05,
  category: 'man_and_van' as const,
  categoryConfidence: 0.9,
  urgency: 3,
  hasLocation: 0.9,
  isSensitive: 0.01,
  isMoveEvent: 0.1,
  isLocalRequest: 0.2,
};

function makeDeps(over: Record<string, unknown> = {}) {
  const traces = { create: vi.fn(() => Promise.resolve({})) };
  const users = { upsertByExternal: vi.fn(() => Promise.resolve({ id: 'u1' })) };
  const groups = {
    findByExternal: vi.fn(() => Promise.resolve({ id: 'g1', name: 'G', phase: 0, isActive: true })),
  };
  const messages = {
    findExisting: vi.fn(() => Promise.resolve(null)),
    create: vi.fn(() => Promise.resolve({ id: 'm1' })),
    recentByUser: vi.fn(() => Promise.resolve([])),
  };
  const demands = {
    findOpenByUser: vi.fn(() => Promise.resolve([])),
    create: vi.fn(() => Promise.resolve({ id: 'd1' })),
  };
  const runStates = { findById: vi.fn(() => Promise.resolve({ id: 'rs1' })) };
  let admitted = {
    userId: 'u1',
    groupId: 'g1' as string | null,
    message: msg as InboundMessage,
    phase: 0,
  };
  const stored = () => ({
    id: 'm1',
    userId: admitted.userId,
    groupId: admitted.groupId,
    externalId: admitted.message.messageId,
    channelRoute: admitted.message.account ? channelRouteSchema.parse(admitted.message) : null,
    text: admitted.message.text,
    lang: admitted.message.lang ?? null,
    receivedAt: new Date(admitted.message.receivedAt),
    executionPhase: admitted.phase,
    executionStatus: 'running',
    executionSnapshot: null,
    isAddressedToBot: admitted.message.addressedToBot ?? false,
    replyToBotText: admitted.message.replyToBotText ?? null,
    replyToMessageId: admitted.message.replyToMessageId ?? null,
  });
  const executions = {
    rejectAdmission: vi.fn(() => Promise.resolve(false)),
    accept: vi.fn((p: typeof admitted) => {
      admitted = p;
      return Promise.resolve({ kind: 'accepted', message: stored() });
    }),
    claim: vi.fn(() =>
      Promise.resolve({
        kind: 'acquired',
        message: stored(),
        lease: {
          userId: 'u1',
          messageId: 'm1',
          token: '00000000-0000-4000-8000-000000000001',
          fence: 1,
        },
      }),
    ),
    finish: vi.fn(() => Promise.resolve(true)),
  };
  const repos = { traces, users, groups, messages, demands, runStates, executions };
  Object.assign(repos, { forExecution: () => repos, forChannel: () => repos });
  const evaluateInbound = vi.fn(() => Promise.resolve(verdict));
  const runInbound = vi.fn(() =>
    Promise.resolve({ kind: 'completed', toolsCalled: ['upsert_demand', 'reply_in_group'] }),
  );
  const publishApproval = vi.fn(() => Promise.resolve());
  const deps = {
    env: { DEFAULT_PHASE: 0 },
    repos,
    jev: { evaluate: vi.fn() },
    thresholds: DEFAULT_THRESHOLDS,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    evaluateOutbound: vi.fn(),
    evaluateInbound,
    runInbound,
    publishApproval,
    cards: { sendApprovalCard: vi.fn() },
    ...over,
  };
  return { deps, repos, traces, evaluateInbound, runInbound, publishApproval, demands, runStates };
}

/** 取某个 mock 的第一次调用的第一个参数（vitest 推不出形状，测试里显式收窄）。 */
function firstArg<T>(fn: { mock: { calls: unknown[][] } }): T {
  const call = fn.mock.calls[0];
  expect(call, 'expected the mock to have been called').toBeDefined();
  return (call as unknown[])[0] as T;
}

interface RunInboundArg {
  ctx: Record<string, unknown>;
  input: string;
}

/** 断言写过一条带该 outcome 的 trace，并返回它。 */
function traceWith(traces: { create: ReturnType<typeof vi.fn> }, outcome: string) {
  const call = traces.create.mock.calls.find(
    (c) => (c[0] as { output: { outcome?: string } }).output.outcome === outcome,
  );
  expect(call, `expected a trace with outcome=${outcome}`).toBeDefined();
  return (call as unknown[])[0] as {
    kind: string;
    inputRef: string;
    output: Record<string, unknown>;
  };
}

describe('processInbound', () => {
  it('defers a busy user without rerunning Jev or consuming the other execution', async () => {
    const t = makeDeps();
    t.repos.executions.claim.mockResolvedValueOnce({ kind: 'busy', retryAfterMs: 2000 } as never);
    expect(await processInbound(t.deps as never, msg)).toEqual({ deferMs: 2000 });
    expect(t.evaluateInbound).not.toHaveBeenCalled();
    expect(t.repos.executions.finish).not.toHaveBeenCalled();
  });
  it('does not feed another group history into Jev', async () => {
    const t = makeDeps();
    t.repos.messages.recentByUser.mockResolvedValueOnce([
      { id: 'same', groupId: 'g1', text: 'same group' },
      { id: 'other', groupId: 'private', text: 'private history' },
    ] as never);
    await processInbound(t.deps as never, msg);
    const call = t.evaluateInbound.mock.calls[0] as unknown as [unknown, { recentTexts: string[] }];
    expect(call[1].recentTexts).toEqual(['same group']);
  });
  it('does not publish an admitted shadow message after the group is upgraded during retry', async () => {
    const t = makeDeps();
    t.repos.groups.findByExternal.mockResolvedValueOnce({
      id: 'g1',
      name: 'G',
      phase: 2,
      isActive: true,
    });
    const original = t.repos.executions.claim.getMockImplementation()!;
    t.repos.executions.claim.mockImplementationOnce(async () => {
      const claim = await original();
      return { ...claim, message: { ...claim.message, executionPhase: 0 } };
    });
    await processInbound(t.deps as never, msg);
    expect(firstArg<RunInboundArg>(t.runInbound).ctx.phase).toBe(0);
  });
  it('blacklisted text is dropped by rule and jev is never called', async () => {
    const t = makeDeps();
    await processInbound(t.deps as never, { ...msg, text: '有人换汇吗' });
    expect(t.evaluateInbound).not.toHaveBeenCalled();
    expect(t.runInbound).not.toHaveBeenCalled();
    expect(traceWith(t.traces, 'dropped_by_rule').kind).toBe('rule');
  });

  it('empty text and bot commands are dropped by rule before any IO', async () => {
    for (const text of ['   ', '/start']) {
      const t = makeDeps();
      await processInbound(t.deps as never, { ...msg, text });
      expect(traceWith(t.traces, 'dropped_by_rule').kind).toBe('rule');
      expect(t.repos.messages.create).not.toHaveBeenCalled();
      expect(t.evaluateInbound).not.toHaveBeenCalled();
    }
  });

  it('inactive group is dropped by rule', async () => {
    const t = makeDeps();
    t.repos.groups.findByExternal.mockResolvedValue({
      id: 'g1',
      name: 'G',
      phase: 0,
      isActive: false,
    });
    await processInbound(t.deps as never, msg);
    expect(traceWith(t.traces, 'dropped_by_rule').output['reason']).toBe('group_inactive');
    expect(t.evaluateInbound).not.toHaveBeenCalled();
  });

  it('service demand enters agent with user-scoped context', async () => {
    const t = makeDeps();
    await processInbound(t.deps as never, msg);
    const arg = firstArg<RunInboundArg>(t.runInbound);
    expect(arg.input).toBe(msg.text);
    expect(arg.ctx).toMatchObject({
      userId: 'u1',
      chatId: '-1',
      groupId: 'g1',
      phase: 0,
      sourceMessageId: 'm1',
    });
    expect(traceWith(t.traces, 'entered_agent').kind).toBe('gate');
    expect(traceWith(t.traces, 'agent_completed').output['toolsCalled']).toEqual([
      'upsert_demand',
      'reply_in_group',
    ]);
  });

  it('jev unavailable -> no agent (AGENTS.md §3.3 第 5 条)', async () => {
    const t = makeDeps({
      evaluateInbound: vi.fn(() => Promise.resolve({ ok: false, reason: 'timeout' })),
    });
    await processInbound(t.deps as never, msg);
    expect(t.runInbound).not.toHaveBeenCalled();
    const tr = traceWith(t.traces, 'dropped_by_jev');
    expect(tr.output['reason']).toBe('timeout');
    expect(tr.output['jevAvailable']).toBe(false);
  });

  it('sensitive verdict drops without entering agent', async () => {
    const t = makeDeps({
      evaluateInbound: vi.fn(() => Promise.resolve({ ...verdict, isSensitive: 0.95 })),
    });
    await processInbound(t.deps as never, msg);
    expect(t.runInbound).not.toHaveBeenCalled();
    expect(traceWith(t.traces, 'dropped_by_jev').output['reason']).toBe('sensitive');
  });

  it('non-service category with move-event signal is tagged, not routed to agent', async () => {
    const t = makeDeps({
      evaluateInbound: vi.fn(() =>
        Promise.resolve({ ...verdict, category: 'housing', isMoveEvent: 0.9 }),
      ),
    });
    await processInbound(t.deps as never, msg);
    expect(t.runInbound).not.toHaveBeenCalled();
    expect(t.demands.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isMoveEvent: true, sourceMessageId: 'm1' }),
    );
    expect(traceWith(t.traces, 'tagged_move_event').kind).toBe('gate');
  });

  it('interrupted run publishes an approval card and leaves a trace', async () => {
    const t = makeDeps({
      runInbound: vi.fn(() => Promise.resolve({ kind: 'interrupted', runStateId: 'rs1' })),
    });
    await processInbound(t.deps as never, msg);
    expect(t.runStates.findById).toHaveBeenCalledWith('rs1');
    expect(firstArg<{ runState: { id: string } }>(t.publishApproval).runState).toEqual({
      id: 'rs1',
    });
    expect(traceWith(t.traces, 'agent_interrupted').output['runStateId']).toBe('rs1');
  });

  it('open demand of the same category is carried into the agent context', async () => {
    const t = makeDeps();
    t.repos.demands.findOpenByUser.mockResolvedValue([
      {
        id: 'd9',
        category: 'man_and_van',
        confidence: 0.8,
        fromPostcode: 'E14',
        toPostcode: null,
        whenText: 'sunday',
        whenAt: null,
        quantity: null,
        budgetPence: null,
        lang: 'en',
      },
    ] as never);
    await processInbound(t.deps as never, msg);
    expect(firstArg<RunInboundArg>(t.runInbound).ctx).toMatchObject({
      demandId: 'd9',
      demand: { category: 'man_and_van', fromPostcode: 'E14', whenText: 'sunday', lang: 'en' },
    });
  });

  it('private chat skips the group lookup and uses the default phase', async () => {
    const t = makeDeps({ env: { DEFAULT_PHASE: 1 } });
    await processInbound(t.deps as never, { ...msg, chatId: '42' });
    expect(t.repos.groups.findByExternal).not.toHaveBeenCalled();
    expect(firstArg<RunInboundArg>(t.runInbound).ctx).toMatchObject({ groupId: null, phase: 1 });
  });
});

describe('processInbound — redelivery and agent failures', () => {
  it('does not reprocess a message that was already stored (queue redelivery)', async () => {
    const { deps, repos, traces, runInbound, evaluateInbound } = makeDeps();
    repos.executions.accept.mockResolvedValueOnce({
      kind: 'legacy',
      message: { id: 'm-old' },
    } as never);
    await processInbound(deps as never, msg);
    expect(repos.messages.create).not.toHaveBeenCalled();
    expect(evaluateInbound).not.toHaveBeenCalled();
    expect(runInbound).not.toHaveBeenCalled();
    expect(traceWith(traces, 'dropped_by_rule')).toMatchObject({
      output: { reason: 'legacy_delivery' },
    });
  });

  it('retains an agent crash for a bounded durable retry', async () => {
    const boom = Object.assign(new Error('Max turns (8) exceeded'), {
      name: 'MaxTurnsExceededError',
    });
    const { deps, traces } = makeDeps({ runInbound: vi.fn(() => Promise.reject(boom)) });
    await expect(processInbound(deps as never, msg)).rejects.toBe(boom);
    expect(traceWith(traces, 'agent_failed')).toMatchObject({
      output: { error: 'MaxTurnsExceededError' },
    });
  });

  it('lets an out-of-catalogue local request into the agent as category other', async () => {
    const local = { ...verdict, category: 'other' as const, isDemand: 0.2, isLocalRequest: 0.95 };
    const { deps, runInbound } = makeDeps({ evaluateInbound: vi.fn(() => Promise.resolve(local)) });
    await processInbound(deps as never, { ...msg, text: '哪里能订中式生日蛋糕' });
    expect(runInbound).toHaveBeenCalled();
  });
});

describe('processInbound — follow-ups addressed to the bot', () => {
  it('lets "thanks" in when it replies to the bot, with the bot text and latest open demand', async () => {
    const thanks = { ...verdict, category: 'other' as const, isDemand: 0.02, isLocalRequest: 0.05 };
    const { deps, runInbound, demands } = makeDeps({
      evaluateInbound: vi.fn(() => Promise.resolve(thanks)),
    });
    demands.findOpenByUser.mockResolvedValueOnce([
      { id: 'd-latest', category: 'man_and_van', confidence: 0.9 },
      { id: 'd-old', category: 'eot_cleaning', confidence: 0.9 },
    ] as never);
    await processInbound(deps as never, {
      ...msg,
      text: '谢谢！',
      addressedToBot: true,
      replyToBotText: 'The London Man And Van …',
    });
    const arg = firstArg<RunInboundArg>(runInbound);
    expect(arg.ctx).toMatchObject({
      addressedToBot: true,
      replyToBotText: 'The London Man And Van …',
      demandId: 'd-latest',
    });
  });

  it('drops the same "thanks" when it is not addressed to the bot', async () => {
    const thanks = { ...verdict, category: 'other' as const, isDemand: 0.02, isLocalRequest: 0.05 };
    const { deps, runInbound } = makeDeps({
      evaluateInbound: vi.fn(() => Promise.resolve(thanks)),
    });
    await processInbound(deps as never, { ...msg, text: '谢谢！' });
    expect(runInbound).not.toHaveBeenCalled();
  });
});

describe('targeted Jev admission', () => {
  it.each([true, false])('admits a direct turn without Jev (private=%s)', async (privateChat) => {
    const r = makeDeps({
      env: { DEFAULT_PHASE: 2, JEV_POLICY: 'targeted' },
      answerRequests: true,
      taskRequests: true,
    });
    r.evaluateInbound.mockRejectedValue(new Error('Jev must not run'));
    await processInbound(r.deps as never, {
      ...msg,
      chatId: privateChat ? msg.userId : msg.chatId,
      addressedToBot: !privateChat,
    });
    expect(r.evaluateInbound).not.toHaveBeenCalled();
    expect(r.runInbound).toHaveBeenCalledOnce();
    expect(r.traces.create).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ outcome: 'direct_request_admitted' }) as unknown,
      }),
    );
  });
  it('still requires Jev before unsolicited group participation', async () => {
    const r = makeDeps({
      env: { DEFAULT_PHASE: 2, JEV_POLICY: 'targeted' },
      answerRequests: true,
      taskRequests: true,
    });
    r.evaluateInbound.mockResolvedValue({ ok: false, reason: 'timeout' } as never);
    await processInbound(r.deps as never, msg);
    expect(r.evaluateInbound).toHaveBeenCalledOnce();
    expect(r.runInbound).not.toHaveBeenCalled();
  });
});

it('keeps JEV recent text inside the same account/chat/thread binding', async () => {
  const t = makeDeps();
  const account = { installationId: 'local', accountId: 'app', tenantId: 'tenant' };
  const message = {
    ...msg,
    channel: 'feishu' as const,
    account,
    chatId: 'oc_chat',
    userId: 'ou_user',
    conversationType: 'group' as const,
    threadId: 'omt_one',
  };
  const route = channelRouteSchema.parse(message);
  t.repos.messages.recentByUser.mockResolvedValueOnce([
    { id: 'a', groupId: 'g1', text: 'same thread', channelRoute: route },
    {
      id: 'b',
      groupId: 'g1',
      text: 'other thread',
      channelRoute: { ...route, threadId: 'omt_two' },
    },
    {
      id: 'c',
      groupId: 'g1',
      text: 'other account',
      channelRoute: { ...route, account: { ...account, accountId: 'other' } },
    },
    { id: 'd', groupId: 'g1', text: 'legacy history', channelRoute: null },
  ] as never);
  await processInbound(t.deps as never, message);
  const call = t.evaluateInbound.mock.calls[0] as unknown as [unknown, { recentTexts: string[] }];
  expect(call[1].recentTexts).toEqual(['same thread']);
});

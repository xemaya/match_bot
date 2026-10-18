import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { functionCall, ScriptedModel } from '@openai/agents/testing';
import { generateSimulatedUserTurn, queueSimulatedUserTurn } from '../src/simulated-user.js';
import type { AgentDeps } from '../src/context.js';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
function deps(available = true, verified = true) {
  let row: unknown = null;
  return {
    env: { DEEPSEEK_MODEL: 'deepseek-flash', OUTBOUND_UNSURE_ACTION: 'drop' },
    thresholds: DEFAULT_THRESHOLDS,
    logger: { info: vi.fn() },
    jev: {},
    evaluateOutbound: vi
      .fn()
      .mockResolvedValue(
        available
          ? { ok: true, worthReplying: 3, languageOk: 1, mentionsUnverified: verified ? 0 : 1 }
          : { ok: false, reason: 'timeout' },
      ),
    repos: {
      traces: { create: vi.fn().mockResolvedValue({}) },
      outbound: {
        create: vi.fn((d: unknown, status: string) => {
          row = { ...(d as object), id: 'actor-out', status };
          return Promise.resolve(row);
        }),
        findByToolCallId: vi.fn(() => Promise.resolve(row)),
        countSentToTargetSince: vi.fn().mockResolvedValue(0),
      },
    },
  };
}
const input = {
  actorId: '222',
  runId: 'run-one',
  turn: 0,
  groupId: '-123',
  goal: 'E14找桌椅，每件50镑',
  text: 'E14想找书桌和椅子，每件50镑以内',
  replyToMessageId: null,
};
describe('simulated user', () => {
  it('generates a proposal with a stub provider and no outbound tool', async () => {
    const d = deps();
    Object.assign(d.env, { DEEPSEEK_MODEL: 'gpt-6.1-sol', GENERATION_REASONING_EFFORT: 'low' });
    const model = new ScriptedModel([
      [
        functionCall(
          'propose_user_turn',
          { text: '我坐地铁去取，单程半小时以内', done: false },
          { callId: 'proposal' },
        ),
      ],
    ]);
    const result = await generateSimulatedUserTurn(
      { ...d, modelProvider: { getModel: () => model } } as unknown as AgentDeps,
      {
        actorId: '222',
        inputRef: 'sim:one',
        goal: input.goal,
        style: '短句，逐步补充',
        history: [{ speaker: 'match_bot', text: '你能接受多远自提？' }],
      },
    );
    expect(result.text).toContain('半小时');
    expect(model.calls[0]?.request.modelSettings.reasoning).toEqual({ effort: 'low' });
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('binds actor speech to the actual synthetic goal and participant role for Jev', async () => {
    const d = deps();
    await queueSimulatedUserTurn(d as unknown as AgentDeps, { ...input, phase: 2 });
    const request = z
      .object({ draft: z.string(), demand: z.object({ need: z.string() }) })
      .parse(d.evaluateOutbound.mock.calls[0]?.[1]);
    expect(request.draft).toBe(input.text);
    expect(request.demand.need).toContain(input.goal);
    expect(request.demand.need).toContain('群成员');
    expect(request.demand.need).toContain('提出或补充');
  });
  it.each([0, 1, 2] as const)('phase %i retains the original gate', async (phase) => {
    const d = deps();
    const result = await queueSimulatedUserTurn(d as unknown as AgentDeps, { ...input, phase });
    expect(result.kind).toBe(phase === 0 ? 'dry_run' : phase === 1 ? 'review' : 'queued');
    expect(d.repos.outbound.create).toHaveBeenCalledTimes(phase === 1 ? 0 : 1);
  });
  it.each([
    [false, true],
    [true, false],
  ])('does not queue an unavailable/unverified verdict', async (available, verified) => {
    const d = deps(available, verified);
    expect(
      (await queueSimulatedUserTurn(d as unknown as AgentDeps, { ...input, phase: 2 })).kind,
    ).toBe('not_queued');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('stops for review when Jev is unavailable and review is configured', async () => {
    const d = deps(false);
    d.env.OUTBOUND_UNSURE_ACTION = 'review';
    const result = await queueSimulatedUserTurn(d as unknown as AgentDeps, { ...input, phase: 2 });
    expect(result.kind).toBe('review');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('rejects contacts or a non-group destination before the gate', async () => {
    const d = deps();
    await expect(
      queueSimulatedUserTurn(d as unknown as AgentDeps, { ...input, groupId: '123', phase: 2 }),
    ).rejects.toThrow();
    await queueSimulatedUserTurn(d as unknown as AgentDeps, {
      ...input,
      text: '联系我 https://example.com',
      phase: 2,
    });
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

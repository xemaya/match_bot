import { createLogger, loadEnv } from '@matchbot/shared';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { assistantMessage, functionCall, ScriptedModel } from '@openai/agents/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../src/context.js';
import { triageInbound } from '../src/triage.js';

function deps(model: ScriptedModel): AgentDeps {
  return {
    env: loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
      REDIS_URL: 'redis://localhost:6379',
      DEEPSEEK_API_KEY: 'k',
      JEV_POLICY: 'off',
      TELEGRAM_BOT_TOKEN: 'k',
      TELEGRAM_OPS_CHAT_ID: '-100ops',
    }),
    repos: { traces: { create: vi.fn().mockResolvedValue({}) } },
    jev: { evaluate: vi.fn() },
    thresholds: DEFAULT_THRESHOLDS,
    logger: createLogger('test', 'silent'),
    evaluateOutbound: vi.fn(),
    modelProvider: { getModel: () => model },
  } as unknown as AgentDeps;
}

const input = {
  text: '狗岛附近哪里买感冒药方便',
  inputRef: 'm1',
  phase: 2 as const,
  isPrivate: false,
  addressedToBot: false,
  transcript: [{ at: '2026-10-20T17:50Z', speaker: '成员ab12', text: '我这有台闲置打印机' }],
};

describe('triageInbound', () => {
  it('returns the recorded verdict from one model call that saw the conversation', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'triage_message',
          {
            action: 'answer',
            category: 'other',
            newCondition: false,
            handledByMembers: false,
            sensitive: false,
            reason: 'asks the group where to buy medicine',
          },
          { callId: 't1' },
        ),
      ],
    ]);
    const outcome = await triageInbound(deps(model), input);
    expect(outcome).toMatchObject({ ok: true, verdict: { action: 'answer', category: 'other' } });
    expect(model.calls).toHaveLength(1);
    const request = JSON.stringify(model.calls[0]);
    expect(request).toContain('我这有台闲置打印机');
    expect(request).toContain('addressedToA2H\\":false');
    model.assertComplete();
  });
  it('reports an invalid response instead of inventing a verdict when the model answers in prose', async () => {
    const model = new ScriptedModel([[assistantMessage('ignore')], [assistantMessage('ignore')]]);
    expect(await triageInbound(deps(model), input)).toEqual({
      ok: false,
      reason: 'invalid_response',
    });
    expect(model.calls).toHaveLength(2);
  });
  it('does not require a Jev key when the policy is off', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
        REDIS_URL: 'redis://localhost:6379',
        DEEPSEEK_API_KEY: 'k',
        JEV_POLICY: 'off',
        TELEGRAM_BOT_TOKEN: 'k',
        TELEGRAM_OPS_CHAT_ID: '-100ops',
      }),
    ).not.toThrow();
  });
});

import { taskSchema } from '@matchbot/domain';
import { assistantMessage, functionCall, ScriptedModel } from '@openai/agents/testing';
import { describe, expect, it, vi } from 'vitest';
import { createMatchAgent } from '../src/agent.js';
import { createKnowledgeSource } from '../src/knowledge-evidence.js';
import { buildDeliveryPacket } from '../src/delivery-context.js';
import {
  restoreExecutionCheckpoint,
  saveExecutionCheckpoint,
} from '../src/execution-checkpoint.js';
import type { AgentDeps, MatchContext } from '../src/context.js';

function fixture() {
  const task = taskSchema.parse({
    id: 'task',
    ownerUserId: 'user',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: '找书桌',
    category: 'second_hand',
    status: 'active',
    revision: 1,
    requirementsVersion: 1,
    goals: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
  const ctx: MatchContext = {
    userId: 'user',
    chatId: '-1',
    groupId: 'group',
    channel: 'telegram',
    phase: 2,
    sourceMessageId: 'message',
    recentReplies: [],
    task,
    execution: {
      userId: 'user',
      messageId: 'message',
      token: '00000000-0000-4000-8000-000000000001',
      fence: 1,
    },
    marketPlan: {
      intent: 'second_hand',
      needs: [{ id: 'desk', terms: ['书桌'] }],
      preferences: [],
    },
    marketListings: [
      {
        ref: 'm1',
        id: 'desk',
        title: 'E14书桌',
        description: '书桌£45，伦敦E14自提',
        priceLabel: '£45',
        tradeType: 'SELL',
        status: 'ON_SALE',
        tags: [],
        url: 'https://a2hmarket.ai/listings/desk',
        sourceUrl: null,
        isRepost: false,
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ],
    marketDetailIds: ['desk'],
    sourceReviewCache: { proof: true },
    taskProgressVersion: 1,
    deliverySourceRefs: ['m1'],
    runDeadlineAt: 1,
  };
  let snapshot = '';
  const saveCheckpoint = vi.fn((p: { snapshot: string }) => {
    snapshot = p.snapshot;
    return Promise.resolve(true);
  });
  const deps = {
    env: { SNAPSHOT_KEY: 'checkpoint-test-secret-12345', DEEPSEEK_MODEL: 'deepseek-flash' },
    repos: { executions: { saveCheckpoint }, traces: { create: () => Promise.resolve({}) } },
    answerRequests: true,
  } as unknown as AgentDeps;
  return { ctx, deps, saveCheckpoint, snapshot: () => snapshot };
}
describe('execution research checkpoints', () => {
  it('saves the full delivery packet and retry feedback after a rejected draft', async () => {
    const f = fixture();
    delete f.ctx.marketPlan;
    delete f.ctx.marketListings;
    f.ctx.knowledgeSources = Array.from({ length: 16 }, (_, i) =>
      createKnowledgeSource(
        {
          title: 'Official page',
          url: `https://example.com/page-${i}`,
          text: 'Official exhibition information and opening hours.',
        },
        i + 1,
      ),
    );
    f.ctx.deliverySourceRefs = buildDeliveryPacket(f.ctx).refs;
    expect(f.ctx.deliverySourceRefs).toHaveLength(16);
    f.ctx.outboundInputFailures = {
      tool: 'reply_to_request',
      count: 1,
      feedback: ['unsupported time'],
    };
    await saveExecutionCheckpoint(f.deps, f.ctx, '看展', 'version');
    const fresh = { ...f.ctx };
    delete fresh.outboundInputFailures;
    delete fresh.deliverySourceRefs;
    const restored = restoreExecutionCheckpoint(f.deps, fresh, '看展', f.snapshot(), 'version');
    expect(restored.deliverySourceRefs).toHaveLength(16);
    expect(restored.outboundInputFailures).toEqual(f.ctx.outboundInputFailures);
    f.ctx.deliverySourceRefs.push('k17');
    await expect(saveExecutionCheckpoint(f.deps, f.ctx, '看展', 'version')).rejects.toThrow();
  });
  it('encrypts tool results and restores them without restoring an old execution token or deadline', async () => {
    const f = fixture();
    await saveExecutionCheckpoint(f.deps, f.ctx, '找书桌', 'version');
    // Random base64 ciphertext can contain short ASCII strings such as E14 by chance.
    expect(f.snapshot()).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(f.snapshot()).not.toContain('"title":"E14书桌"');
    expect(() =>
      restoreExecutionCheckpoint(
        { ...f.deps, env: { ...f.deps.env, SNAPSHOT_KEY: 'different-checkpoint-key' } },
        f.ctx,
        '找书桌',
        f.snapshot(),
        'version',
      ),
    ).toThrow();
    const fresh: MatchContext = {
      ...f.ctx,
      marketListings: [],
      runDeadlineAt: 999,
      execution: { ...f.ctx.execution!, fence: 2, token: '00000000-0000-4000-8000-000000000002' },
    };
    const restored = restoreExecutionCheckpoint(f.deps, fresh, '找书桌', f.snapshot(), 'version');
    expect(restored.marketListings?.[0]?.id).toBe('desk');
    expect(restored.marketListings?.[0]?.title).toBe('E14书桌');
    expect(restored.marketDetailIds).toEqual(['desk']);
    expect(restored.deliverySourceRefs).toEqual(['m1']);
    expect(restored.execution?.fence).toBe(2);
    expect(restored.runDeadlineAt).toBe(999);
  });
  it('rejects another input, scope or requirement version and invalidates policy verdicts across versions', async () => {
    const f = fixture();
    await saveExecutionCheckpoint(f.deps, f.ctx, '找书桌', 'old');
    for (const ctx of [
      { ...f.ctx, userId: 'another' },
      { ...f.ctx, chatId: '-elsewhere' },
      { ...f.ctx, task: { ...f.ctx.task!, requirementsVersion: 2 } },
    ])
      expect(() =>
        restoreExecutionCheckpoint(f.deps, ctx, '找书桌', f.snapshot(), 'old'),
      ).toThrow();
    expect(() => restoreExecutionCheckpoint(f.deps, f.ctx, '找房', f.snapshot(), 'old')).toThrow(
      'scope',
    );
    const restored = restoreExecutionCheckpoint(f.deps, f.ctx, '找书桌', f.snapshot(), 'new');
    expect(restored.sourceReviewCache).toBeUndefined();
    expect(restored.taskProgressVersion).toBeUndefined();
    expect(restored.deliverySourceRefs).toBeUndefined();
  });
  it('awaits the SDK tool-use behavior checkpoint before asking for the next model turn', async () => {
    const f = fixture(),
      model = new ScriptedModel([
        [functionCall('finish_research', { outcome: 'skip', note: '' }, { callId: 'one' })],
        [assistantMessage('done')],
      ]);
    let release: (() => void) | undefined;
    f.saveCheckpoint.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const { agent, runner } = createMatchAgent(
      { ...f.deps, modelProvider: { getModel: () => model } },
      { phase: 2, input: '找书桌' },
    );
    f.ctx.currentRequest = {
      text: '找书桌',
      demand: { category: 'second_hand', confidence: 1 },
      isActionable: true,
    };
    // A direct ask cannot be skipped, so the refusal goes back and a second model turn follows.
    f.ctx.addressedToBot = true;
    const pending = runner.run(agent, '找书桌', { context: f.ctx, maxTurns: 3 });
    for (let attempt = 0; attempt < 50 && !release; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(release).toBeTypeOf('function');
    expect(model.calls).toHaveLength(1);
    release?.();
    await pending;
    expect(model.calls).toHaveLength(2);
  });
});

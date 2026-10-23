import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { createLogger, loadEnv } from '@matchbot/shared';
import { assistantMessage, functionCall, ScriptedModel } from '@openai/agents/testing';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_VERSION, createMatchAgent } from '../src/agent.js';
import { WRITER_REPLY_TOOLS } from '../src/prompts/tool-contract.js';
import { resumeRun, runInbound } from '../src/run.js';
import { taskSchema, reviseTaskRequirements, recordTaskProgress } from '@matchbot/domain';

const VAN = { id: 'a', name: 'Van Co', roughPrice: '£40/h', telegram: '@vanco' };

function makeDeps(model: ScriptedModel) {
  const store: unknown[] = [];
  const runStates: Array<Record<string, unknown> & { id: string }> = [];
  const repos = {
    sessionItems: {
      list: vi.fn(() => Promise.resolve([...store])),
      append: vi.fn((_u: string, items: unknown[]) => {
        store.push(...items);
        return Promise.resolve();
      }),
      popLast: vi.fn(() => Promise.resolve(store.pop() ?? null)),
      clear: vi.fn(() => {
        store.length = 0;
        return Promise.resolve();
      }),
    },
    runStates: {
      create: vi.fn((p: Record<string, unknown>) => {
        const row = { id: `rs${runStates.length + 1}`, ...p };
        runStates.push(row);
        return Promise.resolve(row);
      }),
    },
    outbound: {
      create: vi.fn((d: unknown, status: string) =>
        Promise.resolve({ id: 'om', status, ...(d as object) }),
      ),
      countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
    },
    traces: { create: vi.fn(() => Promise.resolve({})) },
    suppliers: {
      findByIds: vi.fn(() => Promise.resolve([VAN])),
      findCandidates: vi.fn(() => Promise.resolve([VAN])),
    },
    demands: {
      findOpenByUser: vi.fn(() => Promise.resolve([])),
      create: vi.fn((p: unknown) => Promise.resolve({ id: 'd1', ...(p as object) })),
      update: vi.fn(),
      setStatus: vi.fn(),
    },
    matches: { replaceForDemand: vi.fn(() => Promise.resolve([])) },
  };
  const deps = {
    env: loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
      REDIS_URL: 'redis://localhost:6379',
      DEEPSEEK_API_KEY: 'k',
      JEV_API_KEY: 'k',
      TELEGRAM_BOT_TOKEN: 'k',
      TELEGRAM_OPS_CHAT_ID: '-100ops',
      SNAPSHOT_KEY: 'test-snapshot-key-0123456789',
    }),
    repos,
    jev: { evaluate: vi.fn() },
    thresholds: DEFAULT_THRESHOLDS,
    logger: createLogger('test', 'silent'),
    evaluateOutbound: vi.fn(),
    modelProvider: { getModel: () => model },
  };
  return { deps, repos, runStates };
}

const ctx = (phase: 0 | 1 | 2) => ({
  userId: 'u1',
  chatId: '-1',
  groupId: 'g',
  phase: phase as 0,
  recentReplies: [] as string[],
  sourceMessageId: 'm1',
  // These contracts describe a member talking to the assistant; an unsolicited group message
  // gets no fixed status or empty "unavailable" (see reply-value.test.ts).
  addressedToBot: true,
});

const replyCall = (callId = 'c1') =>
  functionCall(
    'reply_in_group',
    { text: 'Two van options for you', supplierIds: ['a'] },
    { callId },
  );

function medicineTask() {
  return taskSchema.parse({
    id: 'old',
    ownerUserId: 'u1',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: '找药',
    category: 'other',
    status: 'active',
    revision: 1,
    goals: [],
    constraints: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'sent', level: 'partial', outboundMessageId: 'previous' },
    userConfirmation: null,
  });
}

describe('runInbound', () => {
  it('does not force a generic status for a declined context supplement', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'update_task',
          { taskRef: 'old', referenceQuote: null, goals: [], constraints: [], outcome: null },
          { callId: 'continue' },
        ),
      ],
      [assistantMessage('no new helpful result')],
    ]);
    const { deps, repos } = makeDeps(model),
      existing = medicineTask(),
      context = { ...ctx(2), outboundBlocked: true };
    const result = await runInbound({
      deps: {
        ...deps,
        answerRequests: true,
        taskRequests: true,
        repos: {
          ...repos,
          tasks: {
            findOpenByScope: () => Promise.resolve([existing]),
            planTurn: () =>
              Promise.resolve({
                kind: 'applied',
                task: { ...existing, revision: 2, delivery: { status: 'none', level: 'none' } },
              }),
          },
        },
      } as never,
      ctx: context,
      input: '头痛',
    });
    expect(result).toEqual({ kind: 'completed', toolsCalled: [] });
    expect(context.outboundBlocked).toBe(true);
    expect(repos.outbound.create).not.toHaveBeenCalled();
    expect(deps.evaluateOutbound).not.toHaveBeenCalled();
  });
  it('honors an explicit no-new-help decision without finalizing it into another status', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'update_task',
          { taskRef: 'old', referenceQuote: null, goals: [], constraints: [], outcome: null },
          { callId: 'continue' },
        ),
      ],
      [
        functionCall(
          'finish_research',
          { outcome: 'skip', note: 'context only, previous useful routes unchanged' },
          { callId: 'quiet' },
        ),
      ],
    ]);
    const { deps, repos } = makeDeps(model);
    const existing = medicineTask();
    const result = await runInbound({
      deps: {
        ...deps,
        answerRequests: true,
        taskRequests: true,
        repos: {
          ...repos,
          tasks: {
            findOpenByScope: () => Promise.resolve([existing]),
            planTurn: () =>
              Promise.resolve({
                kind: 'applied',
                task: { ...existing, revision: 2, delivery: { status: 'none', level: 'none' } },
              }),
          },
        },
      } as never,
      ctx: ctx(2),
      input: '头痛',
    });
    expect(result.kind).toBe('completed');
    expect(repos.outbound.create).not.toHaveBeenCalled();
    expect(deps.evaluateOutbound).not.toHaveBeenCalled();
    expect(
      repos.traces.create.mock.calls.some((c) => JSON.stringify(c).includes('research_route')),
    ).toBe(true);
  });
  it('stays silent when an ambiguous follow-up did not address the bot', async () => {
    const model = new ScriptedModel([
      [functionCall('clarify_task', { reason: 'ambiguous_reference' }, { callId: 'clarify' })],
    ]);
    const { deps, repos } = makeDeps(model);
    const result = await runInbound({
      deps: {
        ...deps,
        answerRequests: true,
        taskRequests: true,
        repos: { ...repos, tasks: { findOpenByScope: () => Promise.resolve([]) } },
      } as never,
      ctx: { ...ctx(2), addressedToBot: false },
      input: '@小陆 能连最好啦 不能也行 便宜就成',
    });
    expect(result).toEqual({ kind: 'completed', toolsCalled: [] });
    expect(repos.outbound.create).not.toHaveBeenCalled();
    expect(
      repos.traces.create.mock.calls.some((c) =>
        JSON.stringify(c).includes('ambiguous_unsolicited'),
      ),
    ).toBe(true);
  });
  it('reports a planning failure instead of silently swallowing a direct short supplement', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'update_task',
          { taskRef: 'old', referenceQuote: null, goals: [], constraints: [], outcome: null },
          { callId: 'bad' },
        ),
      ],
      [functionCall('clarify_task', { reason: 'ambiguous_reference' }, { callId: 'clarify' })],
    ]);
    const { deps, repos } = makeDeps(model);
    const existing = medicineTask();
    const result = await runInbound({
      deps: {
        ...deps,
        answerRequests: true,
        taskRequests: true,
        repos: {
          ...repos,
          tasks: {
            findOpenByScope: () => Promise.resolve([existing]),
            planTurn: () => Promise.reject(new Error('storage unavailable')),
          },
        },
      } as never,
      ctx: { ...ctx(0), addressedToBot: true },
      input: '头痛',
    });
    expect(result.kind).toBe('completed');
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    expect(deps.evaluateOutbound).not.toHaveBeenCalled();
  });
  it('does not turn thanks for a recommendation into another research/finalization reply', async () => {
    const model = new ScriptedModel([
      [functionCall('acknowledge_task', {}, { callId: 'ack' })],
      [functionCall('react', { emoji: '👍' }, { callId: 'reaction' })],
    ]);
    const { deps, repos } = makeDeps(model);
    deps.evaluateOutbound.mockResolvedValue({
      ok: true,
      worthReplying: 3,
      languageOk: 1,
      mentionsUnverified: 0,
    });
    await runInbound({
      deps: {
        ...deps,
        answerRequests: true,
        taskRequests: true,
        repos: { ...repos, tasks: { findOpenByScope: () => Promise.resolve([]) } },
      } as never,
      ctx: { ...ctx(2), source: { messageId: 'tg1', userId: 'user1' } },
      input: '谢谢推荐',
    });
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    expect(repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reaction' }),
      'pending',
    );
    model.assertComplete();
  });
  it.each([0, 1, 2] as const)(
    'refreshes, hands off to an isolated writer and preserves the phase %s gate',
    async (phase) => {
      const model = new ScriptedModel([
        [
          functionCall(
            'update_task',
            {
              taskRef: 'activity-task',
              referenceQuote: null,
              goals: [],
              constraints: [
                {
                  key: 'max_travel_minutes',
                  goalId: null,
                  strength: 'hard',
                  value: { kind: 'duration', minutes: 30 },
                  sourceQuote: '半小时以内',
                },
              ],
              outcome: null,
            },
            { callId: 'plan' },
          ),
        ],
        [
          functionCall(
            'record_task_progress',
            {
              checks: [],
              next: {
                action: 'ask_user',
                goalId: 'activity',
                constraintKey: 'day',
                reason: '需要知道具体哪天方便',
              },
            },
            { callId: 'source-progress' },
          ),
        ],
        [
          functionCall(
            'reply_to_request',
            { kind: 'clarification', text: '周末更方便周六还是周日？', refs: [] },
            { callId: 'task-reply' },
          ),
        ],
      ]);
      const { deps, repos, runStates } = makeDeps(model);
      deps.evaluateOutbound.mockResolvedValue({
        ok: true,
        worthReplying: 3,
        languageOk: 1,
        mentionsUnverified: 0,
      });
      const task = taskSchema.parse({
        id: 'activity-task',
        ownerUserId: 'u1',
        scope: { channel: 'telegram', chatId: '-1' },
        objective: '找初学者周末羽毛球',
        category: 'other',
        counterparty: 'peer',
        status: 'active',
        revision: 0,
        goals: [
          {
            id: 'activity',
            title: '初学者周末羽毛球',
            required: true,
            criteria: [
              {
                id: 'fit',
                label: '水平/时间/地点适合',
                strength: 'hard',
                status: 'unknown',
                evidenceRefs: [],
              },
            ],
          },
        ],
        constraints: [
          {
            key: 'area',
            strength: 'hard',
            value: { kind: 'location', area: 'E14' },
            origin: { kind: 'user', sourceMessageId: 'first' },
          },
        ],
        evidence: [
          {
            id: 'saved',
            goalId: 'activity',
            kind: 'source_excerpt',
            sourceRef: 'market:badminton',
            summary: '历史活动价格£40',
            observedAt: '2026-10-16T00:00:00Z',
          },
        ],
        pendingQuestion: null,
        blockReason: null,
        delivery: { status: 'none', level: 'none' },
        userConfirmation: null,
      });
      let storedTask = task;
      const tasks = {
        findOpenByScope: vi.fn(() => Promise.resolve([task])),
        applyUserTurn: vi.fn(
          (p: { patch: Parameters<typeof reviseTaskRequirements>[0]['patch'] }) =>
            Promise.resolve({
              kind: 'applied',
              task: (storedTask = reviseTaskRequirements({
                task,
                patch: p.patch,
                source: { messageId: 'm1', text: '半小时以内' },
              })),
            }),
        ),
        recordProgress: vi.fn(
          (p: { progress: Omit<Parameters<typeof recordTaskProgress>[0], 'task'> }) =>
            Promise.resolve({
              kind: 'applied',
              task: (storedTask = recordTaskProgress({ task: storedTask, ...p.progress })),
            }),
        ),
      };
      Object.assign(tasks, {
        planTurn: (p: { patch: Parameters<typeof reviseTaskRequirements>[0]['patch'] }) =>
          tasks.applyUserTurn(p),
      });
      const detail = vi.fn(() =>
        Promise.resolve({
          id: 'badminton',
          title: 'E14初学者周末羽毛球',
          description: 'E14初学者周末羽毛球搭子，当前活动价格£45',
          tradeType: 'PEER',
          status: 'ON_SALE',
          tags: [],
          priceLabel: '£45',
          url: 'https://a2hmarket.ai/listings/badminton',
          sourceUrl: null,
          isRepost: false,
          availableFrom: null,
          availableUntil: null,
          sourcePublishedAt: null,
          createdAt: null,
        }),
      );
      const getResponse = model.getResponse.bind(model);
      const generations: Array<{ detailReads: number; instructions: string; input: string }> = [];
      vi.spyOn(model, 'getResponse').mockImplementation((request) => {
        // The planning call runs first. Every subsequent generation must see the refreshed public source.
        generations.push({
          detailReads: detail.mock.calls.length,
          instructions: JSON.stringify(request.systemInstructions),
          input: JSON.stringify(request.input),
        });
        return getResponse(request);
      });
      const result = await runInbound({
        deps: {
          ...deps,
          repos: { ...repos, tasks },
          answerRequests: true,
          taskRequests: true,
          marketSearch: { detail, find: vi.fn() },
        } as never,
        ctx: ctx(phase),
        input: '半小时以内',
      });
      expect(tasks.findOpenByScope).toHaveBeenCalledWith({
        userId: 'u1',
        scope: { channel: 'telegram', chatId: '-1' },
      });
      expect(tasks.applyUserTurn).toHaveBeenCalledOnce();
      expect(generations[1]).toEqual(expect.objectContaining({ detailReads: 1 }));
      expect(generations[1]!.instructions).not.toContain('当前活动价格£45');
      expect(generations[1]!.input).toContain('当前活动价格£45');
      expect(JSON.stringify(model.calls[1]?.request.input)).toContain('30 minutes');
      expect(JSON.stringify(model.calls[1]?.request.input)).toContain('E14');
      if (phase === 1) {
        expect(result.kind).toBe('interrupted');
        expect(repos.outbound.create).not.toHaveBeenCalled();
        await resumeRun({
          deps: {
            ...deps,
            repos: { ...repos, tasks },
            answerRequests: true,
            taskRequests: true,
          } as never,
          runState: runStates[0]!,
          approval: { decision: 'approve' },
        });
      } else expect(result.kind).toBe('completed');
      expect(repos.outbound.create).toHaveBeenCalledOnce();
      expect(repos.outbound.create).toHaveBeenCalledWith(
        expect.anything(),
        phase === 0 ? 'dry_run' : 'pending',
      );
      const writer = model.calls[2]!.request;
      expect(JSON.stringify(writer.systemInstructions)).toContain('FINALIZATION');
      expect(JSON.stringify(writer.tools)).toContain('reply_to_request');
      expect(JSON.stringify(writer.tools)).not.toContain('record_task_progress');
      expect(JSON.stringify(writer.input)).not.toContain('source-progress');
      expect(repos.traces.create).toHaveBeenCalledWith(
        expect.objectContaining({
          inputRef: 'm1',
          output: expect.objectContaining({
            gate: 'delivery_stage',
            reason: 'planned_delivery',
          }) as unknown,
        }),
      );
      model.assertComplete();
    },
  );
  it('passes the selected persistent task into actual SDK instructions for a short followup', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'finish_research',
          { outcome: 'deliver', note: '' },
          { callId: 'done-research' },
        ),
      ],
      [
        functionCall(
          'reply_to_request',
          {
            kind: 'clarification',
            text: '周末你更方便周六还是周日？',
            refs: [],
          },
          { callId: 'task-answer' },
        ),
      ],
    ]);
    const { deps, repos } = makeDeps(model);
    deps.evaluateOutbound.mockResolvedValue({
      ok: true,
      worthReplying: 3,
      languageOk: 1,
      mentionsUnverified: 0,
    });
    const task = taskSchema.parse({
      id: 'badminton',
      ownerUserId: 'u1',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '找羽毛球搭子',
      category: 'other',
      status: 'active',
      revision: 2,
      goals: [
        {
          id: 'activity',
          title: '周末初学者羽毛球活动',
          required: true,
          criteria: [
            {
              id: 'fit',
              label: '符合时间和水平',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'area',
          strength: 'hard',
          value: { kind: 'location', area: 'E14' },
          origin: { kind: 'user', sourceMessageId: 'first' },
        },
        {
          key: 'radius',
          strength: 'hard',
          value: { kind: 'duration', minutes: 30 },
          origin: { kind: 'user', sourceMessageId: 'm1' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    await runInbound({
      deps: { ...deps, answerRequests: true } as never,
      ctx: { ...ctx(2), task },
      input: '半小时以内',
    });
    expect(JSON.stringify(model.calls[0]?.request.systemInstructions)).not.toContain(
      '初学者羽毛球',
    );
    const instructions = JSON.stringify(model.calls[0]?.request.input);
    expect(instructions).toContain('初学者羽毛球');
    expect(instructions).toContain('E14');
    expect(instructions).toContain('30 minutes');
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    model.assertComplete();
  });
  it('binds current food instead of the old carry request during information answering', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'search_information',
          { queries: [{ query: 'Chinatown London hotpot menu', domains: null }] },
          { callId: 'info' },
        ),
      ],
      [
        functionCall(
          'finish_research',
          { outcome: 'deliver', note: '' },
          { callId: 'done-research' },
        ),
      ],
      [
        functionCall(
          'reply_to_request',
          {
            kind: 'answer',
            text: '这家在唐人街提供火锅，先看菜单再核对四个人的总预算。',
            refs: ['k1'],
          },
          { callId: 'answer' },
        ),
      ],
    ]);
    const { deps, repos } = makeDeps(model);
    deps.evaluateOutbound.mockResolvedValue({
      ok: true,
      worthReplying: 3,
      languageOk: 1,
      mentionsUnverified: 0,
    });
    const result = await runInbound({
      deps: {
        ...deps,
        answerRequests: true,
        webSearch: {
          find: () => Promise.resolve([]),
          research: () =>
            Promise.resolve({
              status: 'ok',
              sources: [
                {
                  title: 'Hotpot menu',
                  url: 'https://example.com/menu',
                  text: 'Our Chinatown London restaurant serves hotpot. Check current menus and bookings.',
                },
              ],
            }),
        },
      } as never,
      ctx: {
        ...ctx(2),
        demand: {
          category: 'other',
          need: 'carry-on help Shanghai to London',
          budgetPence: 6000,
          confidence: 1,
        },
      },
      input: '四个人想在伦敦唐人街吃火锅，有什么推荐？',
    });
    expect(result.kind).toBe('completed');
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    const call = deps.evaluateOutbound.mock.calls[0] as unknown as [
      unknown,
      { demand: { need: string; budgetPence?: number } },
    ];
    expect(call[1].demand.need).toContain('火锅');
    expect(call[1].demand.budgetPence).toBeUndefined();
    model.assertComplete();
  });
  it.each([0, 1] as const)(
    'finalizes an unblocked request through SDK approval semantics, phase %s',
    async (phase) => {
      const model = new ScriptedModel([
        [functionCall('finish_research', { outcome: 'no_answer', note: '' }, { callId: 'noop' })],
        [
          functionCall(
            'reply_to_request',
            { kind: 'no_match', text: '没有确认无线功能，可以先核对具体型号。', refs: [] },
            { callId: 'final-answer' },
          ),
        ],
      ]);
      const { deps, repos, runStates } = makeDeps(model);
      const result = await runInbound({
        deps: { ...deps, answerRequests: true } as never,
        ctx: ctx(phase),
        input: '伦敦想收无线激光打印机，预算60镑',
      });
      expect(result.kind).toBe(phase === 1 ? 'interrupted' : 'completed');
      if (phase === 1) {
        expect(runStates).toHaveLength(1);
        expect(repos.outbound.create).not.toHaveBeenCalled();
      } else expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
      model.assertComplete();
    },
  );
  it('returns malformed readonly market JSON as a repair instead of creating a bad approval snapshot', async () => {
    const bad = {
      ...functionCall('market_search', {}, { callId: 'bad-json' }),
      arguments: '{"intent":"housing","plan":invalid}',
    };
    const model = new ScriptedModel([
      [bad],
      [
        functionCall(
          'finish_research',
          { outcome: 'no_answer', note: '' },
          { callId: 'done-research' },
        ),
      ],
      [
        functionCall(
          'reply_to_request',
          { kind: 'no_match', text: '入住时间和租金尚未确认，可以先核对房源条件。', refs: [] },
          { callId: 'reply' },
        ),
      ],
    ]);
    const { deps, repos, runStates } = makeDeps(model);
    const result = await runInbound({
      deps: {
        ...deps,
        answerRequests: true,
        marketSearch: {
          find: () => Promise.resolve({ items: [], hasNext: false, total: 0 }),
          detail: vi.fn(),
        },
      } as never,
      ctx: ctx(0),
      input: 'E14找长租单间，11月初入住，月租1200镑以内',
    });
    expect(result.kind).toBe('completed');
    expect(runStates).toHaveLength(0);
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    model.assertComplete();
  });
  it('returns all missing demand fields so a failed update can be repaired in one call', async () => {
    const valid = {
      category: 'second_hand',
      confidence: 0.9,
      need: 'desk and office chair',
      fromPostcode: 'E14',
      whenText: null,
      whenAt: null,
      toPostcode: null,
      quantity: null,
      budgetPence: null,
      lang: 'zh',
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'upsert_demand',
          {
            category: 'second_hand',
            confidence: 0.9,
            need: 'desk and office chair',
            fromPostcode: 'E14',
          },
          { callId: 'missing-fields' },
        ),
      ],
      [functionCall('upsert_demand', valid, { callId: 'repaired-fields' })],
      [assistantMessage('done')],
    ]);
    const { deps, repos } = makeDeps(model);
    await runInbound({ deps: deps as never, ctx: ctx(0), input: 'E14想收书桌和办公椅' });
    const session = JSON.stringify(await repos.sessionItems.list());
    expect(session).toContain('Missing fields must be included with null');
    expect(session).toContain('whenAt');
    expect(repos.demands.create).toHaveBeenCalledOnce();
    model.assertComplete();
  });
  it('reads two shortlisted full notes, then preserves evidence and read budget through approval resume', async () => {
    const cards = [
      {
        ref: 'x1',
        title: 'Southbank 集市',
        desc: '摘要',
        author: '甲',
        likes: 1,
        url: 'https://www.xiaohongshu.com/explore/n1',
        isDetailLoaded: false,
      },
      {
        ref: 'x2',
        title: 'Southbank 集市攻略',
        desc: '摘要',
        author: '乙',
        likes: 2,
        url: 'https://www.xiaohongshu.com/explore/n2',
        isDetailLoaded: false,
      },
    ];
    const args = {
      intro: '这场可以先看：',
      recommendations: [
        {
          name: 'Southbank 集市',
          aliases: [],
          group: '市集',
          summary: '河边小吃与艺术摊位。',
          reason: '适合散步。',
          sources: [
            { ref: 'x1', passages: ['x1:p1'] },
            { ref: 'x2', passages: ['x2:p1'] },
          ],
          facts: [],
        },
      ],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'xhs_search',
          {
            purpose: 'discover',
            queries: [
              {
                keyword: '伦敦 Southbank 集市',
                page: 1,
                sort: 'general',
                timeFilter: '不限',
                entity: null,
              },
            ],
          },
          { callId: 'discover' },
        ),
      ],
      [functionCall('xhs_read_notes', { refs: ['x1', 'x2'] }, { callId: 'read' })],
      [functionCall('reply_with_xhs_notes', args, { callId: 'reply' })],
    ]);
    const { deps, repos, runStates } = makeDeps(model);
    const readNote = vi.fn((note: (typeof cards)[number]) =>
      Promise.resolve({
        ...note,
        desc: note.ref === 'x1' ? 'Southbank 集市有河边小吃摊。' : 'Southbank 集市还有艺术摊位。',
        isDetailLoaded: true,
      }),
    );
    const configured = {
      ...deps,
      env: { ...deps.env, XHS_RESEARCH_ENABLED: true },
      xhsSearch: { find: vi.fn(() => Promise.resolve(cards)), readNote },
    };
    const result = await runInbound({
      deps: configured as never,
      ctx: { ...ctx(1), demand: { category: 'other', confidence: 1, lang: 'zh' } },
      input: '伦敦有什么集市推荐',
    });
    expect(result.kind).toBe('interrupted');
    expect(readNote).toHaveBeenCalledTimes(2);
    const preview = (runStates[0]!['interruptions'] as Array<{ draftText?: string }>)[0]?.draftText;
    expect(preview).toContain('综合2篇');
    model.enqueue([assistantMessage('done')]);
    await resumeRun({
      deps: configured as never,
      runState: runStates[0]!,
      approval: { decision: 'approve' },
    });
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    expect(readNote).toHaveBeenCalledTimes(2);
    const [draft] = repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('综合2篇');
    expect(draft.text).toBe(preview);
  });
  it('returns schema field limits to the model with sensitive tracing disabled and recovers once', async () => {
    const note = {
      ref: 'x1',
      title: 'Southbank 集市',
      desc: 'Southbank 集市有河边小吃摊。',
      author: '作者',
      likes: 1,
      url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok',
    };
    const item = {
      name: 'Southbank 集市',
      aliases: [],
      group: '市集',
      summary: '河边小吃摊。',
      reason: '适合散步。',
      sources: [{ ref: 'x1', passages: ['x1:p1'] }],
      facts: [],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'reply_with_xhs_notes',
          {
            intro: '可以看这个：',
            recommendations: [
              { ...item, sources: Array.from({ length: 5 }, () => item.sources[0]) },
            ],
          },
          { callId: 'bad-schema' },
        ),
      ],
      [
        functionCall(
          'reply_with_xhs_notes',
          { intro: '可以看这个：', recommendations: [item] },
          { callId: 'repaired-schema' },
        ),
      ],
      [assistantMessage('done')],
    ]);
    const { deps, repos } = makeDeps(model);
    await runInbound({
      deps: {
        ...deps,
        env: { ...deps.env, XHS_RESEARCH_ENABLED: true },
        xhsSearch: { find: () => Promise.resolve([]) },
      } as never,
      ctx: {
        ...ctx(0),
        xhsNotes: [note],
        demand: { category: 'other', confidence: 1, lang: 'zh' },
      },
      input: '伦敦有什么集市推荐',
    });
    const session = await repos.sessionItems.list();
    const errors = JSON.stringify(
      session.filter(
        (i: unknown) =>
          typeof i === 'object' && i !== null && 'type' in i && i.type === 'function_call_result',
      ),
    );
    expect(errors).toContain('recommendations.0.sources');
    expect(errors).toContain('4');
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
  });
  it.each(['schema', 'evidence'] as const)(
    'ends after three invalid outbound calls (%s), with one trace per call',
    async (kind) => {
      const args =
        kind === 'schema'
          ? { text: '', supplierIds: ['a'] }
          : { text: 'A candidate', supplierIds: ['unknown'] };
      const model = new ScriptedModel([
        ...Array.from({ length: 3 }, (_, i) => [
          functionCall('reply_in_group', args, { callId: `invalid-${i}` }),
        ]),
        [assistantMessage('done')],
      ]);
      const { deps, repos } = makeDeps(model);
      if (kind === 'evidence') repos.suppliers.findByIds.mockResolvedValue([]);
      const result = await runInbound({ deps: deps as never, ctx: ctx(0), input: 'need a van' });
      expect(result.kind).toBe('completed');
      expect(repos.outbound.create).not.toHaveBeenCalled();
      const rows = repos.traces.create.mock.calls.map(
        ([row]) => row as { output?: { gate?: string; reason?: string } },
      );
      expect(rows.filter((row) => row.output?.gate === 'outbound_input')).toHaveLength(3);
      expect(rows.filter((row) => row.output?.reason === 'input_retry_limit')).toHaveLength(1);
      const errors = JSON.stringify(await repos.sessionItems.list());
      expect(errors).toContain('not sent: outbound input retry limit');
      expect(errors).not.toContain('unknown supplier id: unknown');
    },
  );
  it('allows research after two invalid drafts and evaluates the current market need', async () => {
    const listing = {
      id: 'listing_a',
      title: '伦敦小绿锅',
      description: '小绿锅成色新，Camberwell 自提。',
      tags: ['物品交易'],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/listing_a',
      sourceUrl: null,
      isRepost: false,
      priceLabel: '帖子未标价',
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: null,
      createdAt: null,
    };
    const reply = {
      intro: '找到公开帖子',
      recommendations: [
        {
          ref: 'm1',
          name: '小绿锅',
          group: '厨房',
          summary: '可自提的小绿锅',
          reason: '同类物品',
          evidence: listing.description,
          facts: [],
        },
      ],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'market_search',
          {
            plan: {
              needs: [{ id: 'pot', terms: ['小绿锅'] }],
              preferences: [],
              requiredTerms: [],
              excludeTerms: [],
              requiredArea: [],
              budget: 20,
              route: null,
              dateRange: null,
            },
            intent: 'second_hand',
            purpose: 'discover',
            queries: [{ keyword: '小绿锅', page: 1, tradeType: 'SELL', entity: null }],
          },
          { callId: 'discover' },
        ),
      ],
      [functionCall('market_enrich', { refs: ['m1'] }, { callId: 'detail' })],
      ...['bad-one', 'bad-two'].map((callId) => [
        functionCall(
          'reply_with_market_results',
          {
            ...reply,
            recommendations: [{ ...reply.recommendations[0], name: 'invented source name' }],
          },
          { callId },
        ),
      ]),
      [functionCall('reply_with_market_results', reply, { callId: 'before-gap' })],
      [
        functionCall(
          'market_search',
          {
            plan: null,
            intent: 'second_hand',
            purpose: 'enrich',
            queries: [{ keyword: '小绿锅 价格', page: 1, tradeType: 'SELL', entity: '小绿锅' }],
          },
          { callId: 'gap-search' },
        ),
      ],
      [functionCall('reply_with_market_results', reply, { callId: 'after-gap' })],
    ]);
    const { deps, repos } = makeDeps(model);
    const marketSearch = {
      find: vi.fn(() => Promise.resolve({ items: [listing], total: 1, hasNext: false })),
      detail: vi.fn(() => Promise.resolve(listing)),
    };
    deps.evaluateOutbound.mockResolvedValue({
      ok: true,
      worthReplying: 1,
      languageOk: 1,
      mentionsUnverified: 0,
    });
    const result = await runInbound({
      deps: { ...deps, marketSearch } as never,
      ctx: {
        ...ctx(2),
        demand: {
          category: 'second_hand',
          need: 'laser printer',
          budgetPence: 6000,
          confidence: 1,
          lang: 'zh',
        },
      },
      input: '伦敦收小绿锅，预算20镑',
    });
    expect(result.kind).toBe('completed');
    expect(marketSearch.find).toHaveBeenCalledTimes(2);
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(await repos.sessionItems.list())).toContain('one focused market_search');
    const evaluation = deps.evaluateOutbound.mock.calls[0] as unknown as [
      unknown,
      { demand: { need: string; budgetPence: number } },
    ];
    expect(evaluation[1].demand.need).toBe('小绿锅');
    expect(evaluation[1].demand.budgetPence).toBe(2000);
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
    expect(
      repos.traces.create.mock.calls.filter(
        ([row]) => (row as { output?: { gate?: string } }).output?.gate === 'outbound_input',
      ),
    ).toHaveLength(2);
    const [draft] = repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('【备选');
    expect(draft.text).toContain('待确认：价格/计价单位');
    model.assertComplete();
  });
  it('repairs oversized search aliases with field feedback before executing public search', async () => {
    const plan = {
      needs: [{ id: 'room', terms: ['单间'] }],
      preferences: [],
      requiredTerms: [],
      excludeTerms: [],
      requiredArea: ['E14'],
      budget: null,
      route: null,
      dateRange: null,
    };
    const args = {
      plan,
      intent: 'housing',
      purpose: 'discover',
      queries: [{ keyword: 'E14 单间', page: 1, tradeType: 'SELL', entity: null }],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'market_search',
          {
            ...args,
            plan: {
              ...plan,
              needs: [{ id: 'room', terms: Array.from({ length: 13 }, (_, i) => `单间${i}`) }],
            },
          },
          { callId: 'invalid-search' },
        ),
      ],
      [functionCall('market_search', args, { callId: 'fixed-search' })],
      [assistantMessage('暂时没有找到可用房源。')],
    ]);
    const { deps, repos } = makeDeps(model);
    const find = vi.fn(() => Promise.resolve({ items: [], hasNext: false, total: 0 }));
    const result = await runInbound({
      deps: { ...deps, marketSearch: { find, detail: vi.fn() } } as never,
      ctx: { ...ctx(0), demand: { category: 'housing', confidence: 1, lang: 'zh' } },
      input: 'E14找长租单间',
    });
    expect(result.kind).toBe('completed');
    expect(find).toHaveBeenCalledOnce();
    expect(repos.outbound.create).not.toHaveBeenCalled();
    const session = JSON.stringify(await repos.sessionItems.list());
    expect(session).toContain('plan.needs.0.terms');
    expect(session).toContain('12');
    const rows = repos.traces.create.mock.calls.map(
      ([row]) => row as { output?: { gate?: string; reason?: string; detail?: string[] } },
    );
    expect(rows.find((row) => row.output?.gate === 'market_search_input')?.output).toMatchObject({
      gate: 'market_search_input',
      reason: 'invalid_schema',
      detail: ['plan.needs.0.terms:too_big'],
    });
    model.assertComplete();
  });
  it('repairs a short market fact quote using precise schema feedback without weakening evidence', async () => {
    const listing = {
      id: 'listing_a',
      ref: 'm1',
      title: '伦敦 硅胶锅铲',
      description: '硅胶锅铲，伦敦象堡自提。',
      tags: ['物品交易'],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/listing_a',
      sourceUrl: null,
      isRepost: false,
      priceLabel: '帖子未标价',
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: null,
      createdAt: null,
    };
    const item = {
      ref: 'm1',
      name: '硅胶锅铲',
      group: '厨房',
      summary: '可自提的硅胶锅铲。',
      reason: '符合要找的锅铲类型。',
      evidence: listing.description,
      facts: [{ label: 'location', value: '伦敦', quote: '伦敦' }],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'reply_with_market_results',
          { intro: '有闲找到这条公开帖子：', recommendations: [item] },
          { callId: 'bad-market' },
        ),
      ],
      [
        functionCall(
          'reply_with_market_results',
          {
            intro: 'A2H找到这条公开帖子：',
            recommendations: [
              {
                ...item,
                facts: [{ label: 'location', value: '伦敦象堡', quote: '伦敦象堡自提。' }],
              },
            ],
          },
          { callId: 'fixed-market' },
        ),
      ],
    ]);
    const { deps, repos } = makeDeps(model);
    const c = { ...ctx(0), marketListings: [listing] };
    await runInbound({
      deps: { ...deps, marketSearch: { find: vi.fn(), detail: vi.fn() } } as never,
      ctx: c as never,
      input: '收 硅胶锅铲/炒菜木铲',
    });
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    const errors = JSON.stringify(await repos.sessionItems.list());
    expect(errors).toContain('recommendations.0.facts.0.quote');
    expect(errors).toContain('4');
    const rows = repos.traces.create.mock.calls.map(
      ([row]) => row as { output?: { reason?: string; detail?: string[] } },
    );
    const denied = rows.find((row) => row.output?.reason === 'invalid_schema');
    expect(denied?.output?.detail).toEqual(['recommendations.0.facts.0.quote:too_small']);
    model.assertComplete();
  });
  it('researches public market offers, enriches them and resumes an approved grouped recommendation with stable refs', async () => {
    const listing = {
      id: 'listing_a',
      title: '伦敦小绿锅',
      description: '小绿锅成色新，Camberwell 自提。',
      tags: ['物品交易'],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/listing_a',
      sourceUrl: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok',
      isRepost: true,
      priceLabel: '帖子未标价',
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: '2026-09-01T00:00:00Z',
      createdAt: '2026-10-01T00:00:00Z',
    };
    const args = {
      intro: '这条可以先看成色和位置：',
      recommendations: [
        {
          ref: 'm1',
          name: '小绿锅',
          group: '厨房',
          summary: '成色新，可在 Camberwell 自提。',
          reason: '适合想自提的人。',
          evidence: '小绿锅成色新，Camberwell 自提',
          facts: [],
        },
      ],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'market_search',
          {
            intent: 'second_hand',
            purpose: 'discover',
            queries: [{ keyword: '小绿锅', page: 1, tradeType: 'SELL', entity: null }],
          },
          { callId: 'market1' },
        ),
      ],
      [functionCall('market_enrich', { refs: ['m1'] }, { callId: 'detail1' })],
      [functionCall('reply_with_market_results', args, { callId: 'market-reply' })],
    ]);
    const { deps, repos, runStates } = makeDeps(model);
    const marketSearch = {
      find: vi.fn(() => Promise.resolve({ items: [listing], hasNext: false, total: 1 })),
      detail: vi.fn(() => Promise.resolve(listing)),
    };
    const configured = { ...deps, marketSearch };
    expect(
      await runInbound({
        deps: configured as never,
        ctx: {
          ...ctx(1),
          source: { messageId: '77', userId: '42' },
          demand: { category: 'second_hand', confidence: 0.95, lang: 'zh' },
        },
        input: '伦敦收小绿锅',
      }),
    ).toMatchObject({ kind: 'interrupted' });
    expect(repos.outbound.create).not.toHaveBeenCalled();
    const state = runStates[0];
    if (!state) throw new Error('missing market snapshot');
    await resumeRun({
      deps: configured as never,
      runState: state,
      approval: { decision: 'approve' },
    });
    expect(repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: '77', mentionUserId: '42' }),
      'pending',
    );
    const [draft] = repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('[A2H详情]');
    expect(draft.text).toContain('小红书原帖');
    expect(marketSearch.find).toHaveBeenCalledTimes(1);
    expect(marketSearch.detail).toHaveBeenCalledTimes(1);
    model.assertComplete();
  });
  it('searches notes, recommends a concrete option, persists approval and resumes the same draft', async () => {
    const args = {
      intro: '想逛河边集市的话，我会先看这个：',
      recommendations: [
        {
          name: 'Southbank 集市',
          aliases: [],
          group: '河边集市',
          summary: '河边的小吃集市，可以边逛边吃。',
          reason: '适合想散步又想吃小吃的人。',
          sources: [{ ref: 'x1', passages: ['x1:p1'] }],
          facts: [],
        },
      ],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'xhs_search',
          {
            purpose: 'discover',
            queries: [
              {
                keyword: '伦敦 圣诞集市',
                page: 1,
                sort: 'general',
                timeFilter: '不限',
                entity: null,
              },
            ],
          },
          { callId: 'search1' },
        ),
      ],
      [functionCall('reply_with_xhs_notes', args, { callId: 'reply1' })],
    ]);
    const { deps, repos, runStates } = makeDeps(model);
    const xhsSearch = {
      find: vi.fn(() =>
        Promise.resolve([
          {
            ref: 'x1',
            title: '伦敦圣诞集市攻略',
            author: '作者',
            desc: 'Southbank 集市有河边小吃摊，适合散步。',
            likes: 5,
            url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok',
          },
        ]),
      ),
    };
    const configured = { ...deps, env: { ...deps.env, XHS_RESEARCH_ENABLED: true }, xhsSearch };
    const result = await runInbound({
      deps: configured as never,
      ctx: { ...ctx(1), demand: { category: 'other', confidence: 0.9, lang: 'zh' } },
      input: '伦敦有什么集市推荐',
    });
    expect(result.kind).toBe('interrupted');
    expect(repos.outbound.create).not.toHaveBeenCalled();
    expect(xhsSearch.find).toHaveBeenCalledTimes(1);
    model.enqueue([assistantMessage('done')]);
    const state = runStates[0];
    if (!state) throw new Error('missing approval snapshot');
    await resumeRun({
      deps: configured as never,
      runState: state,
      approval: { decision: 'approve' },
    });
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
    const [draft] = repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('1. Southbank 集市');
    expect(draft.text).toContain(
      '[小红书原文 1](https://www.xiaohongshu.com/explore/n1?xsec_token=tok)',
    );
    expect(xhsSearch.find).toHaveBeenCalledTimes(1);
  });
  it('phase 1: outbound tool interrupts and an encrypted run_state row is written', async () => {
    const model = new ScriptedModel([[replyCall()]]);
    const { deps, repos, runStates } = makeDeps(model);
    const r = await runInbound({
      deps: deps as never,
      ctx: ctx(1),
      input: 'need a van Sunday E14',
    });
    expect(r).toEqual({ kind: 'interrupted', runStateId: 'rs1' });
    const created = (repos.runStates.create.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(created['userId']).toBe('u1');
    expect(created['agentVersion']).toBe(AGENT_VERSION);
    expect(String(created['sdkVersion'])).toMatch(/^\d+\.\d+\.\d+/);
    expect(String(created['snapshot'])).toMatch(/^v1\./); // 已加密，不是明文 JSON
    expect(repos.outbound.create).not.toHaveBeenCalled(); // 未批准前不得写出站
    expect(runStates).toHaveLength(1);
  });

  it('phase 0: tools run end-to-end and outbound stays dry_run', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'upsert_demand',
          {
            category: 'man_and_van',
            whenText: 'Sunday',
            whenAt: null,
            fromPostcode: 'E14',
            toPostcode: null,
            quantity: null,
            budgetPence: null,
            lang: 'en',
            confidence: 0.9,
          },
          { callId: 'c1' },
        ),
      ],
      [replyCall('c2')],
      [assistantMessage('done')],
    ]);
    const { deps, repos } = makeDeps(model);
    const r = await runInbound({
      deps: deps as never,
      ctx: ctx(0),
      input: 'need a van Sunday E14',
    });
    expect(r).toEqual({ kind: 'completed', toolsCalled: ['upsert_demand', 'reply_in_group'] });
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
    expect(repos.runStates.create).not.toHaveBeenCalled();
    model.assertComplete();
  });

  it('resumeRun: approved interruption executes the tool and queues a pending outbound', async () => {
    const model = new ScriptedModel([[replyCall()]]);
    const { deps, repos, runStates } = makeDeps(model);
    const interrupted = await runInbound({ deps: deps as never, ctx: ctx(1), input: 'need a van' });
    expect(interrupted.kind).toBe('interrupted');

    model.enqueue([assistantMessage('posted')]);
    const runState = runStates[0];
    if (!runState) throw new Error('expected a persisted run state');
    const r = await resumeRun({
      deps: deps as never,
      runState,
      approval: { decision: 'approve' },
    });
    expect(r).toEqual({ kind: 'completed', toolsCalled: ['reply_in_group'] });
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
  });
  it('rebuilds a modern approval from its original message and fresh fence without reading the latest unrelated demand', async () => {
    const model = new ScriptedModel([[replyCall()]]),
      { deps, repos, runStates } = makeDeps(model);
    await runInbound({ deps: deps as never, ctx: ctx(1), input: 'need a van' });
    const row = runStates[0];
    if (!row) throw new Error('missing snapshot');
    const fresh = {
      ...repos,
      messages: {
        findById: vi.fn().mockResolvedValue({
          id: 'm1',
          userId: 'u1',
          externalId: 'original-message',
          groupId: 'g',
          text: 'need a van',
          taskId: null,
        }),
      },
      users: {
        findById: vi.fn().mockResolvedValue({ id: 'u1', channel: 'telegram', externalId: '111' }),
      },
      groups: {
        findByExternal: vi
          .fn()
          .mockResolvedValue({ id: 'g', isActive: true, phase: 1, rateLimitPerDay: null }),
      },
      executions: {
        recoveryFlags: vi
          .fn()
          .mockResolvedValue({ outboundBlocked: false, answerInputExhausted: false }),
      },
    };
    const modern = { ...fresh, forExecution: vi.fn(() => fresh) },
      lease = { userId: 'u1', messageId: 'm1', token: 'fresh-lease', fence: 2 };
    model.enqueue([assistantMessage('posted')]);
    const result = await resumeRun({
      deps: { ...deps, repos: modern } as never,
      runState: { ...row, status: 'consumed', messageId: 'm1' } as never,
      approval: { runStateId: row.id, decision: 'approve' } as never,
      execution: lease,
    });
    expect(result.kind).toBe('completed');
    expect(repos.demands.findOpenByUser).not.toHaveBeenCalled();
    expect(repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: lease,
        replyToMessageId: 'original-message',
        mentionUserId: '111',
      }),
      'pending',
    );
    model.assertComplete();
  });
  it('refuses a modern approval after its task conditions change, before executing the old tool', async () => {
    const model = new ScriptedModel([[replyCall()]]),
      { deps, repos, runStates } = makeDeps(model);
    await runInbound({ deps: deps as never, ctx: ctx(1), input: 'need a van' });
    const row = runStates[0];
    if (!row) throw new Error('missing snapshot');
    const fresh = {
        ...repos,
        messages: {
          findById: vi.fn().mockResolvedValue({
            id: 'm1',
            userId: 'u1',
            groupId: 'g',
            text: 'need a van',
            taskId: 'task',
            taskRequirementsVersion: 0,
          }),
        },
        users: {
          findById: vi.fn().mockResolvedValue({ id: 'u1', channel: 'telegram', externalId: '111' }),
        },
        groups: {
          findByExternal: vi.fn().mockResolvedValue({ id: 'g', isActive: true, phase: 1 }),
        },
        tasks: {
          findById: vi.fn().mockResolvedValue({ requirementsVersion: 1, status: 'active' }),
        },
      },
      modern = { ...fresh, forExecution: vi.fn(() => fresh) };
    await expect(
      resumeRun({
        deps: { ...deps, repos: modern } as never,
        runState: { ...row, status: 'consumed', messageId: 'm1' } as never,
        approval: { runStateId: row.id, decision: 'approve' } as never,
        execution: { userId: 'u1', messageId: 'm1', token: 'new-lease', fence: 2 },
      }),
    ).rejects.toMatchObject({ name: 'ObsoleteResumeError' });
    expect(repos.outbound.create).not.toHaveBeenCalled();
    expect(repos.demands.findOpenByUser).not.toHaveBeenCalled();
    model.assertComplete();
  });

  it('resumeRun: rejected interruption does not write outbound', async () => {
    const model = new ScriptedModel([[replyCall()]]);
    const { deps, repos, runStates } = makeDeps(model);
    await runInbound({ deps: deps as never, ctx: ctx(1), input: 'need a van' });
    model.enqueue([assistantMessage('ok, not posting')]);
    const runState = runStates[0];
    if (!runState) throw new Error('expected a persisted run state');
    const r = await resumeRun({
      deps: deps as never,
      runState,
      approval: { decision: 'reject' },
    });
    expect(r.kind).toBe('completed');
    expect(repos.outbound.create).not.toHaveBeenCalled();
  });
});

describe('request status after recommendation decline', () => {
  it('posts a fixed next step once without rewriting the rejected answer', async () => {
    const model = new ScriptedModel([
      [functionCall('finish_research', { outcome: 'no_answer', note: '' }, { callId: 'fin' })],
      [
        functionCall(
          'reply_to_request',
          {
            kind: 'no_match',
            text: '尚未找到确认匹配的线索。',
            refs: [],
          },
          { callId: 'declined-answer' },
        ),
      ],
    ]);
    const { deps, repos } = makeDeps(model);
    deps.evaluateOutbound.mockResolvedValue({
      ok: true,
      worthReplying: 0.2,
      mentionsUnverified: 0.9,
      languageOk: 1,
    });
    const result = await runInbound({
      deps: { ...deps, answerRequests: true } as never,
      ctx: ctx(2),
      input: 'E14找周末新手羽毛球搭子',
    });
    expect(result.kind).toBe('completed');
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    const draft = repos.outbound.create.mock.calls[0]?.[0] as { kind: string; text: string };
    expect(draft.kind).toBe('notification');
    expect(draft.text).not.toMatch(/[?？]|逐项|下一步应/);
    expect(draft.text).toContain('查询没能完成');
    expect(deps.evaluateOutbound).toHaveBeenCalledTimes(2);
    expect(deps.evaluateOutbound.mock.calls[1]?.[1]).toMatchObject({
      replyPurpose: 'request_status',
    });
  });
});

it('persists and resumes a phase 1 request-status approval through the SDK', async () => {
  const model = new ScriptedModel([
    [assistantMessage('No answer')],
    [assistantMessage('Still no answer')],
    [functionCall('reply_request_status', {}, { callId: 'status-approval' })],
    [assistantMessage('Done')],
  ]);
  const { deps, repos, runStates } = makeDeps(model);
  const modern = { ...deps, answerRequests: true };
  const result = await runInbound({
    deps: modern as never,
    ctx: ctx(1),
    input: 'E14找周末新手羽毛球搭子',
  });
  expect(result.kind).toBe('interrupted');
  expect(repos.outbound.create).not.toHaveBeenCalled();
  const row = runStates[0];
  if (!row) throw new Error('missing approval snapshot');
  const resumed = await resumeRun({
    deps: modern as never,
    runState: row as never,
    approval: { decision: 'approve' } as never,
  });
  expect(resumed.kind).toBe('completed');
  expect(repos.outbound.create).toHaveBeenCalledOnce();
  const draft = repos.outbound.create.mock.calls[0]?.[0] as { text: string };
  expect(draft.text).not.toMatch(/[?？]|逐项|下一步应/);
  expect(draft.text).toContain('查询没能完成');
});

it.each([false, true])(
  'repairs unsupported final delivery numbers even after an early stop: %s',
  async (stopsEarly) => {
    const model = new ScriptedModel([
      [
        functionCall(
          'finish_research',
          { outcome: 'deliver', note: '' },
          { callId: 'research-done' },
        ),
      ],
      [
        functionCall(
          'reply_to_request',
          { kind: 'partial', text: '展览开放到17:45。', refs: [] },
          { callId: 'unsupported-time' },
        ),
      ],
      ...(stopsEarly ? [[assistantMessage('Unable to answer')]] : []),
      [
        functionCall(
          'reply_to_request',
          {
            kind: 'no_match',
            text: '未核实当天开放时间和儿童票档，暂不能确认符合条件。',
            refs: [],
          },
          { callId: 'corrected-time' },
        ),
      ],
    ]);
    const { deps, repos } = makeDeps(model);
    await runInbound({
      deps: { ...deps, answerRequests: true } as never,
      ctx: ctx(0),
      input: '周六下午带孩子看展，预算20镑',
    });
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    expect(repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('未核实当天') as unknown }),
      'dry_run',
    );
    model.assertComplete();
  },
);

it('uses bounded finalization after the research turn budget instead of dropping collected work', async () => {
  const model = new ScriptedModel([
    ...Array.from({ length: 8 }, (_, i) => [
      // A direct ask cannot be skipped: each refused skip spends a research turn.
      functionCall('finish_research', { outcome: 'skip', note: '' }, { callId: 'noop-' + i }),
    ]),
    [
      functionCall(
        'reply_to_request',
        { kind: 'unavailable', text: '目前资料不足以确认，可以先核对具体型号。', refs: [] },
        { callId: 'recover-answer' },
      ),
    ],
  ]);
  const { deps, repos } = makeDeps(model);
  await runInbound({
    deps: { ...deps, answerRequests: true } as never,
    ctx: ctx(0),
    input: '伦敦想收无线激光打印机',
  });
  expect(repos.outbound.create).toHaveBeenCalledWith(
    expect.objectContaining({ text: expect.stringContaining('目前资料不足以确认') as unknown }),
    'dry_run',
  );
  model.assertComplete();
});

it.each(['react', 'do_nothing'])('ends acknowledgement immediately after %s', async (name) => {
  const model = new ScriptedModel([
    [
      functionCall(name, name === 'react' ? { emoji: '👍' } : { reason: 'acknowledgement' }, {
        callId: 'ack-terminal',
      }),
    ],
    [assistantMessage('This extra model call must not happen')],
  ]);
  const { deps } = makeDeps(model);
  await runInbound({
    deps: { ...deps, answerRequests: true } as never,
    ctx: { ...ctx(0), source: { messageId: 'tg', userId: 'owner' } },
    input: '谢谢',
  });
  expect(model.calls).toHaveLength(1);
});

it('new wireless requirement cannot finish through a premature finish before fresh research', async () => {
  const task = taskSchema.parse({
    id: 'printer',
    ownerUserId: 'u1',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: '找激光打印机',
    category: 'second_hand',
    counterparty: 'supply',
    status: 'active',
    revision: 0,
    goals: [
      {
        id: 'g',
        title: '激光打印机',
        required: true,
        criteria: [
          {
            id: 'subject',
            label: '激光打印机',
            strength: 'hard',
            status: 'unknown',
            evidenceRefs: [],
          },
        ],
      },
    ],
    constraints: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
  const model = new ScriptedModel([
    [
      functionCall(
        'update_task',
        {
          taskRef: 'printer',
          referenceQuote: null,
          goals: [],
          constraints: [
            {
              key: 'feature',
              goalId: null,
              strength: 'hard',
              value: { kind: 'text', text: '必须无线' },
              sourceQuote: '必须无线',
            },
          ],
          outcome: null,
        },
        { callId: 'plan-wifi' },
      ),
    ],
    [functionCall('finish_research', { outcome: 'deliver', note: '' }, { callId: 'premature' })],
    [
      functionCall(
        'search_information',
        { queries: [{ query: 'laser printer wireless London', domains: null }] },
        { callId: 'fresh-search' },
      ),
    ],
    [assistantMessage('research ended')],
    [
      functionCall(
        'reply_to_request',
        { kind: 'no_match', text: '这次补查仍没有找到能确认无线的结果。', refs: [] },
        { callId: 'final' },
      ),
    ],
  ]);
  const { deps, repos } = makeDeps(model);
  deps.evaluateOutbound.mockResolvedValue({
    ok: true,
    worthReplying: 3,
    languageOk: 1,
    mentionsUnverified: 0,
  });
  const research = vi.fn(() => {
    expect(repos.outbound.create).not.toHaveBeenCalled();
    return Promise.resolve({ status: 'ok', sources: [] });
  });
  const tasks = {
    findOpenByScope: () => Promise.resolve([task]),
    planTurn: (p: { patch: Parameters<typeof reviseTaskRequirements>[0]['patch'] }) =>
      Promise.resolve({
        kind: 'applied',
        task: reviseTaskRequirements({
          task,
          patch: p.patch,
          source: { messageId: 'm1', text: '打印机必须无线' },
        }),
      }),
  };
  await runInbound({
    deps: {
      ...deps,
      repos: { ...repos, tasks },
      answerRequests: true,
      taskRequests: true,
      webSearch: { research },
    } as never,
    ctx: { ...ctx(0), source: { messageId: 'tg1', userId: '42' } },
    input: '打印机必须无线',
  });
  expect(research).toHaveBeenCalledOnce();
  expect(repos.outbound.create).toHaveBeenCalledOnce();
  expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
  expect(repos.traces.create).toHaveBeenCalledWith(
    expect.objectContaining({
      output: { gate: 'research_continuation', reason: 'new_hard_condition_unresearched' },
    }),
  );
  model.assertComplete();
});

describe('P52 researcher hand-off', () => {
  it.each([
    ['second_hand', '找台灯'],
    ['man_and_van', '安排搬家'],
    ['other', '周末带娃去哪玩 博物馆'],
    ['other', '办理 GP registration'],
    ['job', '找工作'],
  ] as const)('never registers an outbound tool on the researcher (%s / %s)', (category, text) => {
    const { deps } = makeDeps(new ScriptedModel([]));
    const context = {
      ...ctx(2),
      currentRequest: { text, demand: { category, confidence: 1 }, isActionable: true },
    };
    const { agent } = createMatchAgent(
      {
        ...deps,
        answerRequests: true,
        taskRequests: true,
        marketSearch: { find: vi.fn(), detail: vi.fn() },
        webSearch: { find: vi.fn(), research: vi.fn() },
        xhsSearch: { search: vi.fn(), readNote: vi.fn() },
        pageReader: { read: vi.fn() },
      } as never,
      { phase: 2, context: context },
    );
    const names = agent.tools.map((t) => (t.type === 'function' ? t.name : ''));
    expect(names).toContain('finish_research');
    for (const reply of WRITER_REPLY_TOOLS) expect(names).not.toContain(reply);
  });
  it.each(['skip', 'no_answer'] as const)(
    'ends an overheard group turn silently after %s',
    async (outcome) => {
      const model = new ScriptedModel([
        [functionCall('finish_research', { outcome, note: '' }, { callId: 'fin' })],
      ]);
      const { deps, repos } = makeDeps(model);
      const result = await runInbound({
        deps: { ...deps, answerRequests: true } as never,
        ctx: { ...ctx(2), addressedToBot: false },
        input: '有没有人知道哪里有便宜的打印机？',
      });
      expect(result.kind).toBe('completed');
      expect(repos.outbound.create).not.toHaveBeenCalled();
      expect(repos.traces.create).toHaveBeenCalledWith(
        expect.objectContaining({
          output: { gate: 'research_route', decision: 'silent', outcome },
        }),
      );
      model.assertComplete();
    },
  );
  it('hands a deliver outcome to the writer even for a non-question supplement', async () => {
    const model = new ScriptedModel([
      [functionCall('finish_research', { outcome: 'deliver', note: 'k1 fits' }, { callId: 'fin' })],
      [
        functionCall(
          'reply_to_request',
          { kind: 'no_match', text: 'E14 附近暂时没有合适的', refs: [] },
          { callId: 'write' },
        ),
      ],
    ]);
    const { deps, repos } = makeDeps(model);
    await runInbound({
      deps: { ...deps, answerRequests: true } as never,
      ctx: ctx(0),
      input: '我住E14',
    });
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    // The writer reads the researcher's note; the researcher's own prompt carries no voice.
    expect(JSON.stringify(model.calls[1]?.request.input)).toContain('k1 fits');
    expect(JSON.stringify(model.calls[0]?.request.systemInstructions)).not.toContain('ENFP');
    model.assertComplete();
  });
});

import { recordTaskProgress, taskSchema } from '@matchbot/domain';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { RunContext } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps, MatchContext } from '../../src/context.js';
import { recordTaskProgressTool } from '../../src/tools/record-task-progress.js';

describe('record_task_progress source review', () => {
  it.each([false, true])(
    'retains rejected interpretations and requires new research only for changed hard conditions (%s)',
    async (continued) => {
      const ctx: MatchContext = {
        userId: 'u',
        chatId: 'c',
        groupId: 'g',
        sourceMessageId: 'm',
        phase: 2,
        recentReplies: [],
        ...(continued ? { taskUpdate: { kind: 'continued' as const } } : {}),
        task: taskSchema.parse({
          id: 't',
          ownerUserId: 'u',
          scope: { channel: 'telegram', chatId: 'c' },
          objective: '找可养猫一居室',
          category: 'housing',
          counterparty: 'supply',
          status: 'active',
          revision: 0,
          goals: [
            {
              id: 'home',
              title: '一居室',
              required: true,
              criteria: [
                {
                  id: 'pets',
                  label: '允许养猫',
                  constraintKey: 'pets',
                  strength: 'hard',
                  status: 'unknown',
                  evidenceRefs: [],
                },
              ],
            },
          ],
          constraints: [
            {
              key: 'pets',
              goalId: 'home',
              strength: 'hard',
              value: { kind: 'text', text: '猫' },
              origin: { kind: 'user', sourceMessageId: 'm' },
            },
          ],
          evidence: [],
          pendingQuestion: null,
          blockReason: null,
          delivery: { status: 'none', level: 'none' },
          userConfirmation: null,
        }),
        marketPlan: {
          intent: 'housing',
          needs: [{ id: 'home', terms: ['一居室'] }],
          preferences: ['猫'],
        },
        marketListings: [
          {
            id: 'flat',
            ref: 'm1',
            title: '伦敦一居室',
            description: '出租：一居室\n要求：是否可养猫须书面确认',
            tags: [],
            tradeType: 'SELL',
            status: 'ON_SALE',
            url: 'https://a2hmarket.ai/listings/flat',
            sourceUrl: null,
            isRepost: false,
            priceLabel: '待确认',
            availableFrom: null,
            availableUntil: null,
            sourcePublishedAt: null,
            createdAt: null,
          },
        ],
      };
      const evaluate = vi.fn(() =>
        Promise.resolve({ ok: true, answers: { is_supported_0: { type: 'noul', noul: 0.02 } } }),
      );
      const recordProgress = vi.fn(
        (p: { progress: Omit<Parameters<typeof recordTaskProgress>[0], 'task'> }) => {
          const task = recordTaskProgress({ task: ctx.task!, ...p.progress });
          return Promise.resolve({ kind: 'applied', task });
        },
      );
      const tool = recordTaskProgressTool({
        jev: { evaluate },
        thresholds: DEFAULT_THRESHOLDS,
        repos: { tasks: { recordProgress }, traces: { create: () => Promise.resolve({}) } },
      } as unknown as AgentDeps);
      const args = {
        checks: [
          {
            goalId: 'home',
            criterionId: 'pets',
            status: 'supported',
            sources: [{ ref: 'm1', quote: null }],
          },
        ],
        next: { action: 'deliver', goalId: 'home', constraintKey: null, reason: '给出结果' },
      };
      const repeatedQuestion = await tool.invoke(
        new RunContext(ctx),
        JSON.stringify({
          checks: [],
          next: { action: 'ask_user', goalId: 'home', constraintKey: 'pets', reason: '养宠物吗' },
        }),
      );
      expect(repeatedQuestion).toContain('already known');
      expect(recordProgress).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
      ctx.taskProgressCalls = 0;
      const first = await tool.invoke(new RunContext(ctx), JSON.stringify(args));
      expect(first).toContain('rejectedCriteria');
      expect(ctx.task?.goals[0]?.criteria[0]?.status).toBe('unknown');
      expect(ctx.task?.nextStep?.action).toBe(continued ? 'research' : 'deliver');
      expect(ctx.outboundBlocked).not.toBe(true);
      await tool.invoke(new RunContext(ctx), JSON.stringify(args));
      expect(evaluate).toHaveBeenCalledOnce();
      expect(recordProgress).toHaveBeenCalledTimes(2);
      ctx.marketListings!.push({
        ...ctx.marketListings![0]!,
        id: 'flat2',
        ref: 'm2',
        description: '出租：一居室\n要求：允许养猫',
      });
      ctx.marketListings!.push({
        ...ctx.marketListings![0]!,
        id: 'flat3',
        ref: 'm3',
        description: '出租：一居室\n要求：禁止养猫',
      });
      evaluate.mockResolvedValue({
        ok: true,
        answers: {
          is_supported_0: { type: 'noul', noul: 0.95 },
          is_supported_1: { type: 'noul', noul: 0.95 },
        },
      });
      const mixed = {
        ...args,
        checks: [
          {
            ...args.checks[0]!,
            sources: [...args.checks[0]!.sources, { ref: 'm2', quote: '允许养猫' }],
          },
          { ...args.checks[0]!, status: 'conflict', sources: [{ ref: 'm3', quote: '禁止养猫' }] },
        ],
      };
      await tool.invoke(new RunContext(ctx), JSON.stringify(mixed));
      expect(ctx.task?.goals[0]?.criteria[0]?.status).toBe('supported');
      const refs = ctx.task?.goals[0]?.criteria[0]?.evidenceRefs ?? [];
      expect(refs).toHaveLength(1);
      expect(ctx.task?.evidence.find((e) => e.id === refs[0])?.sourceRef).toBe('market:flat2');
      const rejectedRefs = ctx.task?.goals[0]?.criteria[0]?.conflictingEvidenceRefs ?? [];
      expect(rejectedRefs).toHaveLength(1);
      expect(ctx.task?.evidence.find((e) => e.id === rejectedRefs[0])?.sourceRef).toBe(
        'market:flat3',
      );
      expect(evaluate).toHaveBeenCalledTimes(3);
      await tool.invoke(new RunContext(ctx), JSON.stringify(mixed));
      expect(evaluate).toHaveBeenCalledTimes(3);
    },
  );
});

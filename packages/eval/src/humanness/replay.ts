import {
  AGENT_VERSION,
  bindTaskMarketPlan,
  buildDeliveryPacket,
  createMatchAgent,
  restoreSearchContext,
  type AgentDeps,
  type MatchContext,
} from '@matchbot/agent';
import type { Repositories } from '@matchbot/db';
import { taskSchema } from '@matchbot/domain';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { createJevClient, evaluateOutbound } from '@matchbot/jev';
import { createLogger, type Env } from '@matchbot/shared';
import { createMemoryTraces } from '../memory-traces.js';
import { toRoundCase } from './export.js';
import type { CaseFixture, RoundCase } from './schema.js';

/**
 * Finalization only: the frozen research packet, task and group transcript go into a MatchContext,
 * the real model writes the reply through the real reply_to_request tool (all checks, feedback and
 * card rendering), and the draft lands in a memory outbox. Jev is off, traces and session are in
 * memory, nothing is written to the database and nothing is sent.
 */
export async function replayCase(p: {
  env: Env;
  repos: Repositories;
  fixture: CaseFixture;
  timeoutMs?: number;
}): Promise<
  RoundCase & { rejectedDrafts: number; elapsedMs: number; modelTokens: number; outcome: string }
> {
  const { fixture } = p;
  const logger = createLogger('humanness-replay', 'silent');
  const traces = createMemoryTraces();
  const drafts: Array<{ text: string; kind: string; status: string }> = [];
  const items: unknown[] = [];
  const research = fixture.research as {
    knowledgeSources?: Array<{ title: string; url: string; text: string }>;
    marketListings?: Array<{ id: string }>;
  };
  const deps = {
    env: { ...p.env, JEV_POLICY: 'off', OUTBOUND_UNSURE_ACTION: 'drop' },
    answerRequests: true,
    taskRequests: true,
    thresholds: DEFAULT_THRESHOLDS,
    logger,
    evaluateOutbound,
    jev: createJevClient({
      baseUrl: p.env.JEV_BASE_URL,
      apiKey: p.env.JEV_API_KEY,
      model: p.env.JEV_MODEL,
      traces,
      logger,
      timeoutMs: 1000,
      maxRetries: 0,
    }),
    repos: {
      ...p.repos,
      forExecution: () => deps.repos,
      traces,
      sessionItems: {
        list: () => Promise.resolve([...items]),
        append: (_u: string, next: unknown[]) => {
          items.push(...next);
          return Promise.resolve();
        },
        popLast: () => Promise.resolve(items.pop() ?? null),
        clear: () => {
          items.length = 0;
          return Promise.resolve();
        },
      },
      executions: {
        ...p.repos.executions,
        recoveryFlags: () =>
          Promise.resolve({ outboundBlocked: false, answerInputExhausted: false }),
        saveCheckpoint: () => Promise.resolve(true),
      },
      outbound: {
        ...p.repos.outbound,
        countSentToTargetSince: () => Promise.resolve(0),
        lastSentToUser: () => Promise.resolve(null),
        create: (draft: { text: string; kind: string }, status: string) => {
          drafts.push({ text: draft.text, kind: draft.kind, status });
          return Promise.resolve({ ...draft, id: 'memory-' + fixture.id, status });
        },
      },
    },
    webSearch: {
      find: () => Promise.resolve([]),
      research: () =>
        Promise.resolve({
          status: 'ok',
          sources: (research.knowledgeSources ?? []).map(({ title, url, text }) => ({
            title,
            url,
            text,
          })),
        }),
    },
    marketSearch: {
      find: () =>
        Promise.resolve({
          items: research.marketListings ?? [],
          total: research.marketListings?.length ?? 0,
          hasNext: false,
        }),
      detail: (id: string) => {
        const found = research.marketListings?.find((n) => n.id === id);
        return found ? Promise.resolve(found) : Promise.reject(new Error('frozen_detail_missing'));
      },
    },
  } as unknown as AgentDeps;
  const task = fixture.task ? taskSchema.parse(fixture.task) : undefined;
  const base: MatchContext = {
    channel: 'telegram',
    userId: fixture.userId,
    chatId: fixture.chatId,
    groupId: fixture.groupId,
    phase: fixture.phase,
    sourceMessageId: fixture.sourceMessageId,
    source: fixture.source,
    ...(fixture.addressedToBot ? { addressedToBot: true } : {}),
    recentReplies: [],
    groupTranscript: fixture.groupTranscript,
    ...(task ? { task } : {}),
  };
  const ctx = restoreSearchContext(
    base,
    JSON.stringify({ context: { context: fixture.research } }),
  );
  if (ctx.task && ctx.marketPlan) ctx.marketPlan = bindTaskMarketPlan(ctx.marketPlan, ctx.task);
  ctx.isAnswerFinalization = true;
  const timeoutMs = p.timeoutMs ?? 75000;
  ctx.runDeadlineAt = Date.now() + timeoutMs;
  ctx.deliverySourceRefs = buildDeliveryPacket(ctx).refs;
  const { agent, runner } = createMatchAgent(deps, {
    context: ctx,
    phase: ctx.phase,
    input: fixture.input,
    finalAnswerOnly: true,
    inputRef: 'humanness-' + fixture.id,
    ...(ctx.task ? { taskId: ctx.task.id } : {}),
  });
  const started = Date.now();
  let outcome = 'recorded';
  let responses = 0;
  let modelTokens = 0;
  try {
    const result = await runner.run(agent, fixture.input, {
      context: ctx,
      maxTurns: 3,
      signal: AbortSignal.timeout(timeoutMs),
    });
    responses = result.rawResponses.length;
    for (const r of result.rawResponses) modelTokens += r.usage.inputTokens + r.usage.outputTokens;
    if (!drafts.length) outcome = ctx.outboundDeclineReason ?? 'not_recorded';
  } catch (error) {
    outcome = 'error:' + (error instanceof Error ? error.name : 'unknown');
  }
  const draft = drafts[0];
  const row = toRoundCase({
    id: fixture.id,
    kind: draft?.kind ?? 'none',
    status: draft ? draft.status : outcome,
    text: draft?.text ?? '',
    sourceMessageId: fixture.sourceMessageId,
    sourceMessage: {
      text: fixture.input,
      receivedAt: new Date(fixture.askedAt),
      userId: fixture.userId,
    },
  });
  return {
    ...row,
    rejectedDrafts: Math.max(0, responses - 1),
    elapsedMs: Date.now() - started,
    modelTokens,
    outcome,
  };
}

export const REPLAY_AGENT_VERSION = AGENT_VERSION;

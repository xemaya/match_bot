import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { marketListingSchema } from '@matchbot/websearch';
import type { AgentDeps, MatchContext } from '../context.js';
import { bindTaskMarketPlan } from '../task-market-plan.js';
import { MARKET_RESEARCH_LIMITS, marketListingForModel } from '../market-research.js';
import { READ_TASK_SOURCES } from '../prompts/tools/read-task-sources.js';

/** PRD §13: retain useful source memory, but refresh an offer before relying on its old conditions. */
export function readTaskSourcesTool(deps: AgentDeps) {
  return tool({
    name: 'read_task_sources',
    description: READ_TASK_SOURCES.description,
    parameters: z.object({ sources: z.array(z.string().min(1).max(160)).min(1).max(4) }),
    needsApproval: false,
    execute: (args, rc) =>
      readSavedTaskSources(deps, (rc as RunContext<MatchContext>).context, args),
  });
}

export async function readSavedTaskSources(
  deps: AgentDeps,
  ctx: MatchContext,
  raw: { sources: string[] },
): Promise<string> {
  const args = z.object({ sources: z.array(z.string().min(1).max(160)).min(1).max(4) }).parse(raw);
  const task = ctx.task,
    started = Date.now();
  const deny = async (reason: string) => {
    await trace(reason);
    return reason;
  };
  if (ctx.outboundBlocked) return deny(READ_TASK_SOURCES.feedback.blocked);
  if (ctx.runDeadlineAt !== undefined && ctx.runDeadlineAt <= Date.now())
    return deny(READ_TASK_SOURCES.feedback.deadline);
  if (
    !task ||
    task.ownerUserId !== ctx.userId ||
    task.scope.chatId !== ctx.chatId ||
    task.scope.channel !== (ctx.channel ?? 'telegram')
  )
    return deny(READ_TASK_SOURCES.feedback.scopeMismatch);
  const sources = [...new Set(args.sources)];
  const saved = task.evidence.filter(
    (e) =>
      sources.includes(e.sourceRef) && !task.goals.find((g) => g.id === e.goalId)?.userConfirmation,
  );
  if (sources.some((ref) => !saved.some((e) => e.sourceRef === ref)))
    return deny(READ_TASK_SOURCES.feedback.notSaved);
  const ids = sources.filter((s) => /^market:[A-Za-z0-9_-]{1,100}$/.test(s)).map((s) => s.slice(7));
  const attempted = new Set(ctx.marketDetailIds ?? []),
    fresh = ids.filter((id) => !attempted.has(id));
  if (attempted.size + fresh.length > MARKET_RESEARCH_LIMITS.details)
    return deny(READ_TASK_SOURCES.feedback.detailBudget);
  if (
    (ctx.marketListings?.length ?? 0) +
      fresh.filter((id) => !ctx.marketListings?.some((n) => n.id === id)).length >
    MARKET_RESEARCH_LIMITS.listings
  )
    return deny(READ_TASK_SOURCES.feedback.candidateBudget);
  const failures: string[] = [];
  if (fresh.length && deps.marketSearch) {
    const intent =
      task.category === 'housing'
        ? 'housing'
        : task.category === 'second_hand'
          ? 'second_hand'
          : task.counterparty === 'peer'
            ? 'companion'
            : /帮带|代购|carry/i.test(task.objective)
              ? 'carry'
              : null;
    if (!intent || (ctx.marketIntent && ctx.marketIntent !== intent))
      return deny(READ_TASK_SOURCES.feedback.intentMismatch);
    ctx.marketPlan ??= bindTaskMarketPlan({ intent, needs: [], preferences: [] }, task);
    ctx.marketIntent = intent;
    ctx.marketListings ??= [];
    for (const id of fresh) attempted.add(id);
    ctx.marketDetailIds = [...attempted];
    const results = await Promise.allSettled(fresh.map((id) => readWithinDeadline(deps, ctx, id)));
    for (const [index, result] of results.entries()) {
      const id = fresh[index]!;
      const parsed =
        result.status === 'fulfilled' ? marketListingSchema.safeParse(result.value) : null;
      if (!parsed?.success || parsed.data.id !== id) {
        failures.push('market:' + id);
        continue;
      }
      const old = ctx.marketListings.findIndex((n) => n.id === id);
      const ref = old >= 0 ? ctx.marketListings[old]!.ref : 'm' + (ctx.marketListings.length + 1);
      const item = { ...parsed.data, ref };
      if (old >= 0) ctx.marketListings[old] = item;
      else ctx.marketListings.push(item);
    }
  } else if (fresh.length) failures.push(...fresh.map((id) => 'market:' + id));
  if (failures.length) {
    ctx.sourceFailures ??= [];
    ctx.sourceFailures.push('task_sources:detail_unavailable');
  }
  await trace('read', failures.length);
  return JSON.stringify({
    historical: saved.slice(-12).map((e) => ({
      source: e.sourceRef,
      url: e.url,
      goalId: e.goalId,
      summary: e.summary.slice(0, 300),
      observedAt: e.observedAt,
    })),
    current: (ctx.marketListings ?? [])
      .filter((n) => ids.includes(n.id))
      .map((n) => marketListingForModel(n, 1500)),
    failures,
    guidance: READ_TASK_SOURCES.results.guidance,
  });
  async function trace(result: string, failed = 0) {
    await deps.repos.traces.create({
      kind: 'gate',
      inputRef: ctx.sourceMessageId,
      phase: ctx.phase,
      latencyMs: Date.now() - started,
      costMicro: 0,
      output: {
        gate: 'read_task_sources',
        taskId: task?.id ?? null,
        result,
        requested: args.sources.length,
        failed,
      },
    });
  }
}

async function readWithinDeadline(deps: AgentDeps, ctx: MatchContext, id: string) {
  const remaining = Math.max(
    0,
    Math.min(10000, (ctx.runDeadlineAt ?? Date.now() + 10000) - Date.now()),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.marketSearch!.detail(id),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('saved source read timed out')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { assertSafeXhsKeyword } from '@matchbot/websearch';
import type { AgentDeps, MatchContext } from '../context.js';

/** P22：需要入库时只让模型提供短主题，时间/预算/地区仍来自本轮原文。 */
export function recordRequestTool(deps: AgentDeps) {
  return tool({
    name: 'record_request',
    description:
      'Record the selected task request for supplier matching, keeping other tasks separate. Provide only a short generic English topic, at most 60 characters, with no personal names/contacts. Category, budget, location and time come from the server-bound current task. This writes internal request data, never posts or contacts anyone.',
    parameters: z.object({ need: z.string().min(2).max(60) }),
    needsApproval: false,
    errorFunction: () =>
      'invalid record_request input: use valid JSON with one short need string; no timestamps or extra fields',
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const draft = ctx.currentRequest?.demand;
      if (!draft) return 'no bound request';
      assertSafeXhsKeyword(args.need);
      if (ctx.task) {
        if (['completed', 'cancelled', 'expired'].includes(ctx.task.status))
          return 'task is already closed; do not record or search it again';
        const row = await deps.repos.demands.recordForTask({
          access: {
            userId: ctx.userId,
            scope: {
              channel: ctx.channel ?? 'telegram',
              chatId: ctx.chatId,
              ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
            },
          },
          taskId: ctx.task.id,
          requirementsVersion: ctx.task.requirementsVersion,
          sourceMessageId: ctx.sourceMessageId,
          draft: { ...draft, need: args.need },
        });
        ctx.demandId = row.id;
        ctx.demand = { ...draft, need: args.need };
        return 'current task request recorded; category=' + draft.category + ', id=' + row.id;
      }
      const existing = (await deps.repos.demands.findOpenByUser(ctx.userId)).find(
        (d) => d.category === draft.category,
      );
      const record = { ...draft, need: args.need, sourceMessageId: ctx.sourceMessageId };
      const row = existing
        ? await deps.repos.demands.update(existing.id, record)
        : await deps.repos.demands.create({ ...record, userId: ctx.userId });
      ctx.demandId = row.id;
      ctx.demand = { ...draft, need: args.need };
      return 'current request recorded; category=' + draft.category + ', id=' + row.id;
    },
  });
}

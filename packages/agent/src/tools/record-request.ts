import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { assertSafeXhsKeyword } from '@matchbot/websearch';
import type { AgentDeps, MatchContext } from '../context.js';
import { RECORD_REQUEST } from '../prompts/tools/record-request.js';

/** P22：需要入库时只让模型提供短主题，时间/预算/地区仍来自本轮原文。 */
export function recordRequestTool(deps: AgentDeps) {
  return tool({
    name: 'record_request',
    description: RECORD_REQUEST.description,
    parameters: z.object({ need: z.string().min(2).max(60) }),
    needsApproval: false,
    errorFunction: () => RECORD_REQUEST.feedback.invalidInput,
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      const draft = ctx.currentRequest?.demand;
      if (!draft) return RECORD_REQUEST.feedback.noRequest;
      assertSafeXhsKeyword(args.need);
      if (ctx.task) {
        if (['completed', 'cancelled', 'expired'].includes(ctx.task.status))
          return RECORD_REQUEST.feedback.closed;
        const row = await deps.repos.demands.recordForTask({
          access: {
            userId: ctx.userId,
            scope: { channel: ctx.channel ?? 'telegram', chatId: ctx.chatId },
          },
          taskId: ctx.task.id,
          requirementsVersion: ctx.task.requirementsVersion,
          sourceMessageId: ctx.sourceMessageId,
          draft: { ...draft, need: args.need },
        });
        ctx.demandId = row.id;
        ctx.demand = { ...draft, need: args.need };
        return RECORD_REQUEST.results.taskRecorded(draft.category, row.id);
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
      return RECORD_REQUEST.results.recorded(draft.category, row.id);
    },
  });
}

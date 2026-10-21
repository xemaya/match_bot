import { INFORMATION_LIMITS } from '../information-limits.js';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { createKnowledgeSource } from '../knowledge-evidence.js';
import { READ_WEB_PAGE } from '../prompts/tools/read-web-page.js';

function accessibleUrls(ctx: MatchContext): Set<string> {
  const ownTask =
    ctx.task?.ownerUserId === ctx.userId &&
    ctx.task.scope.chatId === ctx.chatId &&
    ctx.task.scope.channel === (ctx.channel ?? 'telegram');
  return new Set([
    ...(ctx.knowledgeSources ?? []).map((source) => source.url),
    ...(ctx.pageLinks ?? []).map((link) => link.url),
    ...(ownTask
      ? ctx.task!.evidence.map((source) => source.url).filter((url): url is string => !!url)
      : []),
  ]);
}

export function readWebPageTool(deps: AgentDeps) {
  return tool({
    name: 'read_web_page',
    description: READ_WEB_PAGE.description,
    parameters: z.object({
      // Compatible gateway rejects JSON Schema format=uri; validate the URL at execution instead.
      url: z.string().min(1).max(2048),
      find: z.string().min(1).max(120).nullable(),
      offset: z.number().int().min(0).max(120000).nullable(),
    }),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (ctx.outboundBlocked) return READ_WEB_PAGE.feedback.blocked;
      if (!deps.pageReader) return READ_WEB_PAGE.feedback.unavailable;
      if (!z.string().url().safeParse(args.url).success) return READ_WEB_PAGE.feedback.invalidUrl;
      if (!accessibleUrls(ctx).has(args.url)) return READ_WEB_PAGE.feedback.unknownUrl;
      ctx.pageReads ??= [];
      if (
        ctx.pageReads.length >= INFORMATION_LIMITS.pageReads ||
        (ctx.knowledgeSources?.length ?? 0) >= INFORMATION_LIMITS.sources
      )
        return READ_WEB_PAGE.feedback.budgetExhausted;
      if (ctx.runDeadlineAt !== undefined && ctx.runDeadlineAt - Date.now() <= 30000)
        return READ_WEB_PAGE.feedback.deadline;
      const key = JSON.stringify(args);
      if (ctx.pageReads.includes(key)) return READ_WEB_PAGE.feedback.repeated;
      ctx.pageReads.push(key);
      const started = Date.now();
      const result = await deps.pageReader({
        url: args.url,
        ...(args.find ? { find: args.find } : {}),
        ...(args.offset !== null ? { offset: args.offset } : {}),
      });
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        phase: ctx.phase,
        latencyMs: Date.now() - started,
        costMicro: 0,
        output: {
          gate: 'page_read',
          status: result.status,
          ...(result.status === 'unavailable'
            ? {
                reason: result.reason,
                ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
              }
            : { links: result.links.length, truncated: result.truncated, found: result.found }),
        },
      });
      if (result.status === 'unavailable') {
        ctx.sourceFailures ??= [];
        ctx.sourceFailures.push('information:page_read_' + result.reason);
        return JSON.stringify(result);
      }
      ctx.knowledgeSources ??= [];
      const source = createKnowledgeSource(
        { title: result.title, url: result.url, text: result.text },
        ctx.knowledgeSources.length + 1,
      );
      ctx.knowledgeSources.push(source);
      ctx.pageLinks = [...(ctx.pageLinks ?? []), ...result.links]
        .filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index)
        .slice(-160);
      // The page text is in currentPublicEvidence; only the identity and a preview return here.
      return JSON.stringify({
        status: 'ok',
        source: {
          ref: source.ref,
          title: source.title,
          url: source.url,
          passageCount: source.passages.length,
          preview: source.passages[0]?.text.slice(0, 200) ?? '',
        },
        links: result.links.slice(0, 40),
        found: result.found,
        nextOffset: result.nextOffset,
        truncated: result.truncated,
        guidance: READ_WEB_PAGE.results.guidance,
      });
    },
  });
}

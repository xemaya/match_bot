import { INFORMATION_LIMITS } from '../information-limits.js';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import { assertSafeXhsKeyword } from '@matchbot/websearch';
import type { AgentDeps, MatchContext } from '../context.js';
import { createKnowledgeSource } from '../knowledge-evidence.js';
import { SEARCH_INFORMATION } from '../prompts/tools/search-information.js';

export function searchInformationTool(deps: AgentDeps) {
  return tool({
    name: 'search_information',
    description: SEARCH_INFORMATION.description,
    parameters: z.object({
      queries: z
        .array(
          z.object({
            query: z.string().min(2).max(60),
            domains: z.array(z.string()).max(5).nullable(),
          }),
        )
        .min(1)
        .max(2),
    }),
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (ctx.outboundBlocked) return SEARCH_INFORMATION.feedback.blocked;
      if (!deps.webSearch?.research) {
        ctx.sourceFailures ??= [];
        ctx.sourceFailures.push('information:unavailable');
        return SEARCH_INFORMATION.feedback.unavailable;
      }
      ctx.informationQueries ??= [];
      ctx.knowledgeSources ??= [];
      const fresh = args.queries.filter((q) => !ctx.informationQueries!.includes(q.query));
      if (ctx.informationQueries.length + fresh.length > INFORMATION_LIMITS.queries)
        return SEARCH_INFORMATION.feedback.budgetExhausted;
      const request = ctx.currentRequest?.text ?? ctx.demand?.need ?? '';
      const official = /GP|NHS|注册.*医生/i.test(request)
        ? ['nhs.uk']
        : /希思罗|heathrow|机场/i.test(request)
          ? ['tfl.gov.uk', 'heathrow.com']
          : [];
      const outcomes = [];
      for (const q of fresh) {
        const query = assertSafeXhsKeyword(q.query);
        ctx.informationQueries.push(query);
        const started = Date.now();
        const result = await deps.webSearch.research({
          query,
          domains: q.domains ?? official,
        });
        if (result.status === 'unavailable') {
          ctx.sourceFailures ??= [];
          ctx.sourceFailures.push('information:' + (result.reason ?? 'unavailable'));
        }
        for (const source of result.sources) {
          // Transport news archives describe past fares, not current travel rules.
          if (/希思罗|heathrow|机场/i.test(request) && /\/press-releases\//i.test(source.url))
            continue;
          // Leave room to follow registration/ticket links instead of filling every slot with search hits.
          if (
            ctx.knowledgeSources.length >=
            (deps.pageReader
              ? INFORMATION_LIMITS.searchSourcesWithReader
              : INFORMATION_LIMITS.sources)
          )
            break;
          if (!ctx.knowledgeSources.some((s) => s.url === source.url))
            ctx.knowledgeSources.push(
              createKnowledgeSource(source, ctx.knowledgeSources.length + 1),
            );
        }
        outcomes.push({
          query,
          status: result.status,
          count: result.sources.length,
          reason: result.reason,
        });
        await deps.repos.traces.create({
          kind: 'gate',
          inputRef: ctx.sourceMessageId,
          output: {
            gate: 'information_search',
            provider: deps.env?.INFORMATION_SEARCH_PROVIDER ?? 'injected',
            status: result.status,
            count: result.sources.length,
            reason: result.reason ?? null,
            domains: q.domains ?? official,
          },
          phase: ctx.phase,
          latencyMs: Date.now() - started,
          costMicro: 0,
        });
      }
      // Passages live in the runtime packet (currentPublicEvidence), which is rebuilt every turn;
      // repeating them here would double the input of every later turn.
      return JSON.stringify({
        outcomes,
        sources: ctx.knowledgeSources.map((s) => ({
          ref: s.ref,
          title: s.title,
          url: s.url,
          passageCount: s.passages.length,
          preview: s.passages[0]?.text.slice(0, 160) ?? '',
        })),
        remainingQueries: INFORMATION_LIMITS.queries - ctx.informationQueries.length,
        next: SEARCH_INFORMATION.results.next,
      });
    },
  });
}

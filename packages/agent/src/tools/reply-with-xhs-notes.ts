import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import {
  buildXhsRecommendations,
  singleLine,
  xhsRecommendationSchema,
  type XhsRecommendation,
} from '../xhs-recommendations.js';
import { groupReplyAddressing } from './addressing.js';
import { makeOutboundTool } from './make-outbound-tool.js';
import { XHS_RESEARCH_LIMITS } from '../xhs-research.js';

export function replyWithXhsNotesTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_with_xhs_notes',
    description:
      'SENDS one grouped reply about real-world events/places, not a list of posts. Synthesize 1-6 distinct entities, merging multiple relevant full notes about the same event, venue and edition. First use xhs_read_notes for shortlisted refs; unread discovery cards are rejected. When multiple relevant full notes exist, combine at least two and integrate what each contributes to highlights and practical details; do not pad with decorative or unrelated links. Single-source options are explicitly labelled. Prefer 3-4 richly supported varied options over 6 thin cards. Explain what visitors do/see and who it suits; fill facts from passage IDs, flag missing/conflicting information. Use an exact source name with attested aliases. Code generates grouped headings, source coverage labels and original links. Exclude expired events and do not claim undated events are currently open.',
    parameters: z.object({
      intro: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe(
          'Brief recommendation-led overview in the user language. For broad queries explain the categories and a good starting choice; no invented facts or URLs.',
        ),
      recommendations: z.array(xhsRecommendationSchema).min(1).max(6),
    }),
    toDraft: async (ctx, args: { intro: string; recommendations: XhsRecommendation[] }) => {
      let intro = singleLine(args.intro);
      const zh = ctx.demand?.lang ? ctx.demand.lang === 'zh' : /\p{Script=Han}/u.test(intro);
      const isBroadQuery =
        (ctx.xhsQueries ?? []).filter((q) => q.purpose === 'discover').length >= 2;
      const isReadBudgetExhausted =
        (ctx.xhsDetailRefs?.length ?? 0) >= XHS_RESEARCH_LIMITS.detailReads;
      let result = buildXhsRecommendations({
        notes: ctx.xhsNotes ?? [],
        recommendations: args.recommendations,
        zh,
        isBroadQuery,
        allowUnconfirmedFactFallback: isReadBudgetExhausted,
        canImproveCoverage:
          !!deps.xhsSearch?.readNote &&
          (ctx.xhsDetailRefs?.length ?? 0) < XHS_RESEARCH_LIMITS.detailReads,
      });
      ctx.xhsValidatedRecommendations = retainValidatedRecommendations(
        ctx.xhsValidatedRecommendations ?? [],
        result.validatedRecommendations,
      );
      // 证据足够或额度耗尽后收敛已通过引用校验的条目，避免重写丢失多帖综合。
      const hasPrimaryEvidence =
        ctx.xhsValidatedRecommendations.filter(
          (r) => new Set(r.sources.map((s) => s.ref)).size >= 2,
        ).length >= 2;
      if (
        isBroadQuery &&
        (isReadBudgetExhausted || hasPrimaryEvidence) &&
        ctx.xhsValidatedRecommendations.length
      ) {
        const chosen = curateRecommendations(ctx.xhsValidatedRecommendations);
        result = buildXhsRecommendations({
          notes: ctx.xhsNotes ?? [],
          recommendations: chosen,
          zh,
          isBroadQuery: true,
          canImproveCoverage: false,
        });
        if (!('error' in result)) {
          intro = zh
            ? `我先整理了${chosen.length}个值得考虑的去处，综合多篇资料的放在前面；单篇资料已单独标明。`
            : `I picked ${chosen.length} places or activities from the evidence. Options combining several notes come first; single-source options are labelled.`;
          await deps.repos.traces.create({
            kind: 'gate',
            inputRef: ctx.sourceMessageId,
            phase: ctx.phase,
            latencyMs: 0,
            costMicro: 0,
            output: {
              gate: 'xhs_curation',
              selectedItems: chosen.length,
              multiSourceItems: chosen.filter((r) => new Set(r.sources.map((s) => s.ref)).size >= 2)
                .length,
              selectedSourceRefs: [...new Set(chosen.flatMap((r) => r.sources.map((s) => s.ref)))],
            },
          });
        }
      }
      if ('error' in result) return Promise.resolve(result);
      const text = `${intro}\n\n${result.text}`;
      // domain 的原始出站文本仍限 4000；为 @ 留余量，不截断来源或丢弃事实。
      if (text.length > 3700)
        return Promise.resolve({
          error: `invalid recommendation: reply too long (${text.length}/3700 raw characters including code-generated links); shorten descriptions or include fewer entities/sources, keeping practical facts and their evidence`,
        });
      return Promise.resolve({
        kind: 'recommendation' as const,
        target: ctx.chatId,
        text,
        supplierSummaries: result.notes.map((n) =>
          JSON.stringify({ title: n.title, excerpt: n.desc, author: n.author, url: n.url }),
        ),
        inputRef: ctx.sourceMessageId,
        ...groupReplyAddressing(ctx),
      });
    },
  });
}

function retainValidatedRecommendations(
  previous: XhsRecommendation[],
  current: XhsRecommendation[],
): XhsRecommendation[] {
  const byName = new Map<string, XhsRecommendation>();
  for (const item of [...previous, ...current]) {
    const key = item.name
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{Z}\s]/gu, '');
    const old = byName.get(key);
    if (!old || scoreRecommendation(item) >= scoreRecommendation(old)) byName.set(key, item);
  }
  return [...byName.values()]
    .sort((a, b) => scoreRecommendation(b) - scoreRecommendation(a))
    .slice(0, 6);
}
function scoreRecommendation(item: XhsRecommendation): number {
  return (
    new Set(item.sources.map((s) => s.ref)).size * 10 +
    item.facts.filter((f) => f.status === 'known').length
  );
}
function curateRecommendations(items: XhsRecommendation[]): XhsRecommendation[] {
  const multi = items.filter((r) => new Set(r.sources.map((s) => s.ref)).size >= 2);
  const single = items.filter((r) => new Set(r.sources.map((s) => s.ref)).size === 1);
  return multi.length
    ? [...multi, ...single.slice(0, multi.length)].slice(0, 6)
    : single.slice(0, 3);
}

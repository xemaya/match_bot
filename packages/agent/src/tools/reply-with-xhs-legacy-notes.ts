import type { XhsNote } from '@matchbot/websearch';
import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { groupReplyAddressing } from './addressing.js';
import { makeOutboundTool } from './make-outbound-tool.js';

const recommendationSchema = z.object({
  ref: z.string().describe('A ref returned by xhs_search.'),
  name: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .describe(
      'The actual place, restaurant or event to recommend. Copy its name exactly from the excerpt or title; do not use the whole note title when it is a guide or roundup.',
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .describe(
      "Explain why this option fits the user, in their language. Name the actual place/event if the excerpt names it. Only use facts in the excerpt; distinguish your suggestion from the author's claims. Never invent dates, prices, availability or personal experience.",
    ),
  evidence: z
    .string()
    .trim()
    .min(4)
    .max(180)
    .describe(
      'An exact, contiguous quote from the returned excerpt supporting the recommendation. Copy it verbatim; do not translate or use the title as evidence.',
    ),
});
type Recommendation = z.infer<typeof recommendationSchema>;
const singleLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();

/** P14：标题与链接只取搜索结果；模型给推荐理由与可校验的正文摘录。 */
function renderXhsNotes(p: { notes: XhsNote[]; recommendations: Recommendation[]; zh: boolean }) {
  return p.notes
    .map((note, i) => {
      const item = p.recommendations[i]!;
      const label = p.zh ? '来源：[小红书原文]' : 'Source: [Xiaohongshu note]';
      return [
        `${i + 1}. ${singleLine(item.name)}`,
        singleLine(item.reason),
        `${p.zh ? '笔记提到：' : 'Note says: '}${singleLine(item.evidence)}`,
        `${label}(${note.url}) · ${singleLine(note.author).slice(0, 60)}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function replyWithLegacyXhsNotesTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_with_xhs_notes',
    description:
      'SENDS a reply in the group with 1-3 ranked, evidence-backed Xiaohongshu recommendations. Start with your best-fit suggestion, then give a concrete reason and an exact excerpt quote for each ref. The tool adds numbered titles, authors and original clickable links. Only use refs and excerpts returned by xhs_search; if there is not enough relevant evidence, do_nothing.',
    parameters: z.object({
      intro: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe(
          "A short recommendation-led intro in the user's language, explaining which type of option to start with. No unsupported facts, note titles or links.",
        ),
      recommendations: z
        .array(recommendationSchema)
        .min(1)
        .max(3)
        .describe(
          'Most relevant first. Each ref appears once. Prefer current, specific information matching the request; do not rank solely by likes. For time-sensitive requests exclude outdated or undated options you cannot establish are relevant.',
        ),
    }),
    toDraft: (ctx, args: { intro: string; recommendations: Recommendation[] }) => {
      const byRef = new Map((ctx.xhsNotes ?? []).map((n) => [n.ref, n]));
      const notes: XhsNote[] = [];
      for (const item of args.recommendations) {
        const note = byRef.get(item.ref);
        if (
          !note ||
          notes.includes(note) ||
          !note.desc.slice(0, 500).includes(item.evidence) ||
          !(note.title.includes(item.name) || note.desc.slice(0, 500).includes(item.name)) ||
          !/^https:\/\/www\.xiaohongshu\.com\/explore\/[\w-]+(?:\?[^\s()]+)?$/.test(note.url)
        ) {
          return Promise.resolve({
            error:
              'invalid recommendation: use unique returned refs, an exact excerpt quote and the original Xiaohongshu note URL',
          });
        }
        notes.push(note);
      }
      const intro = singleLine(args.intro);
      const zh = ctx.demand?.lang ? ctx.demand.lang === 'zh' : /\p{Script=Han}/u.test(intro);
      const text = `${intro}\n\n${renderXhsNotes({ notes, recommendations: args.recommendations, zh })}`;
      if (text.length > 3500)
        return Promise.resolve({
          error: 'invalid recommendation: reply too long; select fewer notes',
        });
      return Promise.resolve({
        kind: 'recommendation' as const,
        target: ctx.chatId,
        text,
        // 让出站评估看到原始依据，而不仅是笔记标题（P14）。
        supplierSummaries: notes.map((n) =>
          JSON.stringify({
            title: n.title,
            author: n.author,
            excerpt: n.desc.slice(0, 500),
            url: n.url,
          }),
        ),
        inputRef: ctx.sourceMessageId,
        ...groupReplyAddressing(ctx),
      });
    },
  });
}

import type { SearchCandidate } from '@matchbot/websearch';
import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { groupReplyAddressing } from './addressing.js';
import { makeOutboundTool } from './make-outbound-tool.js';

/**
 * 商家名单由代码按编号生成，模型只写开场白：搜索结果里的电话、链接一个字都不经模型之手。
 * 一行说完，像群友顺口推荐，而不是编号列表加网址块（后者一看就是广告号）。
 * Instagram 写成 instagram.com/xxx 而不是 @xxx：Telegram 会把 @xxx 渲染成某个同名
 * Telegram 用户的链接，点进去可能是毫不相干的人。
 */
export function renderCandidates(cs: SearchCandidate[], zh: boolean): string {
  return cs
    .map((c) => {
      const bits = [
        c.contact.phone ? `☎ ${c.contact.phone}` : null,
        c.contact.whatsapp ? `WhatsApp ${c.contact.whatsapp}` : null,
        c.contact.instagram ? `instagram.com/${c.contact.instagram}` : null,
      ]
        .filter(Boolean)
        .slice(0, 2)
        .join(zh ? '，' : ', ');
      return zh ? `${c.name}（${bits}）` : `${c.name} (${bits})`;
    })
    .join(zh ? '、' : '; ');
}

export function replyWithSearchResultsTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_with_search_results',
    description:
      "SENDS a reply in the group, under the user's message, listing 1-3 web_search results. You write only a one-sentence intro in the user's language; the tool appends the businesses and their contacts itself. Use only refs returned by web_search.",
    parameters: z.object({
      intro: z
        .string()
        .min(1)
        .max(300)
        .describe(
          'One short, casual sentence in the user\'s language, like a group member would say, ending with a colon, e.g. "伦敦这两家可以看看：". Do not name businesses or give contacts; they are appended automatically.',
        ),
      refs: z.array(z.string()).min(1).max(3).describe('refs from web_search, e.g. ["w1","w3"]'),
    }),
    toDraft: (ctx, args: { intro: string; refs: string[] }) => {
      const byRef = new Map((ctx.searchResults ?? []).map((c) => [c.ref, c]));
      const picked = [...new Set(args.refs)].map((r) => byRef.get(r));
      if (picked.length === 0 || picked.some((c) => !c)) {
        return Promise.resolve({
          error: 'unknown ref; call web_search and only use refs it returned',
        });
      }
      const cs = picked as SearchCandidate[];
      const intro = args.intro.trim();
      const zh = ctx.demand?.lang ? ctx.demand.lang === 'zh' : /\p{Script=Han}/u.test(intro);
      return Promise.resolve({
        kind: 'recommendation' as const,
        target: ctx.chatId,
        text: `${intro}\n${renderCandidates(cs, zh)}`,
        supplierSummaries: cs.map((c) => c.name),
        inputRef: ctx.sourceMessageId,
        ...groupReplyAddressing(ctx),
      });
    },
  });
}

import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { REFER_MEMBER, SAY_BRIEFLY } from '../prompts/tools/group-speech.js';
import { makeOutboundTool } from './make-outbound-tool.js';
import { groupReplyAddressing } from './addressing.js';
import { SEARCH_REPORT_PHRASES, weightedLength } from './reply-to-request.js';

/** Fact-free lines stay short: about a third of a group chat line (P51 allows 90). */
const BRIEF_CHARS = 40;
/** How often A2H may point people at the same member in a day (P53 D2). */
const REFERRALS_PER_MEMBER_PER_DAY = 2;
const FACT_LIKE = /\d|https?:|www\.|£|镑|\b[A-Z][a-z]+ (?:Street|Road|Lane|Park|Market)\b/;

/** A half line with no facts: no research behind it, so nothing it says can be checked. */
export function sayBrieflyTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'say_briefly',
    description: SAY_BRIEFLY.description,
    parameters: z.object({ text: z.string().min(1).max(200).describe(SAY_BRIEFLY.params.text) }),
    toDraft: (ctx: MatchContext, args: { text: string }) => {
      const text = args.text.trim();
      if (!ctx.source) return Promise.resolve({ error: SAY_BRIEFLY.feedback.unknownMessage });
      if (weightedLength(text) > BRIEF_CHARS || text.includes('\n'))
        return Promise.resolve({ error: SAY_BRIEFLY.feedback.tooLong });
      if (FACT_LIKE.test(text)) return Promise.resolve({ error: SAY_BRIEFLY.feedback.hasFacts });
      if (SEARCH_REPORT_PHRASES.test(text))
        return Promise.resolve({ error: SAY_BRIEFLY.feedback.reportsSearch });
      return Promise.resolve({
        kind: 'notification' as const,
        target: ctx.chatId,
        text,
        supplierSummaries: [],
        inputRef: ctx.sourceMessageId,
        ...groupReplyAddressing(ctx),
      });
    },
  });
}

/**
 * Points the asker at a member who said something relevant in public. The model only knows the
 * alias; the server resolves it to the member's channel id, which the sender turns into a mention.
 */
export function referMemberTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'refer_member',
    description: REFER_MEMBER.description,
    parameters: z.object({
      alias: z.string().min(1).max(40).describe(REFER_MEMBER.params.alias),
      text: z.string().min(1).max(200).describe(REFER_MEMBER.params.text),
    }),
    toDraft: async (ctx: MatchContext, args: { alias: string; text: string }) => {
      const alias = args.alias
        .replace(/^@/, '')
        .replace(/（当前发言者）$/, '')
        .trim();
      const text = args.text.trim();
      const bare = (speaker: string) => speaker.replace(/（当前发言者）$/, '');
      // Members the model can see: the recent conversation, or a P54 note from earlier.
      const memberId =
        (ctx.groupTranscript ?? []).find((l) => l.memberId && bare(l.speaker) === alias)
          ?.memberId ?? ctx.groupView?.memberNotes.find((n) => bare(n.member) === alias)?.memberId;
      if (!memberId || !ctx.source) return { error: REFER_MEMBER.feedback.unknownAlias };
      if (memberId === ctx.userId) return { error: REFER_MEMBER.feedback.isAsker };
      if (text.includes(alias) || /@/.test(text)) return { error: REFER_MEMBER.feedback.hasName };
      if (weightedLength(text) > BRIEF_CHARS || text.includes('\n'))
        return { error: REFER_MEMBER.feedback.tooLong };
      const member = await deps.repos.users.findById(memberId);
      if (!member) return { error: REFER_MEMBER.feedback.unknownAlias };
      const since = new Date(Date.now() - 86400e3);
      if (
        (await deps.repos.outbound.countMentionsSince(ctx.chatId, member.externalId, since)) >=
        REFERRALS_PER_MEMBER_PER_DAY
      )
        return { error: REFER_MEMBER.feedback.dailyLimit };
      return {
        kind: 'notification' as const,
        target: ctx.chatId,
        text,
        supplierSummaries: [],
        inputRef: ctx.sourceMessageId,
        replyToMessageId: ctx.source.messageId,
        mentionUserId: member.externalId,
      };
    },
  });
}

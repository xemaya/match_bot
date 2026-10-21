import { pendingResearchConditions, researchFollowupInstruction } from '../research-readiness.js';
import { isUnsolicitedGroupTurn } from '../request-status.js';
import { unsupportedNumericClaims } from '../numeric-evidence.js';
import { z } from 'zod';
import { renderEvidenceCard } from '@matchbot/domain';
import { REPLY_TO_REQUEST } from '../prompts/tools/reply-to-request.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { makeOutboundTool } from './make-outbound-tool.js';
import { groupReplyAddressing } from './addressing.js';
import { buildMarketChoices } from '../market-choices.js';
import { renderMarketChoiceReply } from '../market-choice-presentation.js';
import { marketChoiceFeedback } from '../market-choice-feedback.js';
import { checkMarketOfferConflicts } from '../market-offer-conflicts.js';
import {
  hasGuaranteedPurchaseClaim,
  hasUnrecordedSourceFailureClaim,
} from '../source-operation-claims.js';
import { hasUnqualifiedSellerIdentity } from '../seller-identity-claims.js';
import { canSkipSupplementReply, hasNewSupplementEvidence } from '../supplement-replies.js';
import { taskDeliveryForOutbound } from '../task-outbound.js';
import { claimsCompleteMarketFit, claimsUnverifiedTravelFit } from '../market-summary-claims.js';

const { feedback: FEEDBACK, limits: LIMITS } = REPLY_TO_REQUEST;
const parameters = z.object({
  kind: z.enum(['answer', 'partial', 'no_match', 'clarification', 'unavailable']),
  text: z.string().trim().min(1).max(600).describe(REPLY_TO_REQUEST.params.text),
  details: z
    .string()
    .trim()
    .max(LIMITS.details)
    .nullish()
    .describe(REPLY_TO_REQUEST.params.details),
  refs: z.array(z.string()).max(LIMITS.refs).describe(REPLY_TO_REQUEST.params.refs),
});
type ReplyArgs = z.infer<typeof parameters>;

/** Every fact check reads the chat line and the card together; the asker sees both. */
function prose(args: { text: string; details?: string | null | undefined }): string {
  return [args.text, args.details ?? ''].filter(Boolean).join('\n');
}
function stripCitations(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[（(]\s*(?:k\d+(?::p\d+)?[\s、,]*)+[)）]/g, '')
    .replace(/\bk\d+(?::p\d+)?\b/g, '')
    .trim();
}
/** Group members read the line on a phone; the card is folded under it. */
function chatLineLimit(ctx: MatchContext): { chars: number; lines: number } {
  return ctx.groupId ? LIMITS.group : LIMITS.private;
}
function exceedsChatLine(text: string, limit: { chars: number; lines: number }): boolean {
  const lines = text.split('\n').filter((line) => line.trim()).length;
  return text.length > limit.chars || lines > limit.lines;
}

function claimsUnknownTotalFits(text: string, evidence: string): boolean {
  if (
    !/不(?:含|包).{0,6}(?:账单|水电)|(?:excluding|without)\s+bills|bills (?:are )?(?:extra|excluded|not included)/i.test(
      evidence,
    )
  )
    return false;
  if (
    /(?:账单|水电|bills)\s*(?:为|是|每月|约|are|of|per month|[:：])?\s*(?:£|GBP)\s*\d/i.test(
      evidence,
    )
  )
    return false;
  return text
    .split(/[。！？?\n]/)
    .some(
      (part) =>
        /总(?:支出|费用|价|花费)|(?:房租|租金).{0,6}(?:加|\+).{0,6}账单|all[- ]?in|total (?:monthly )?(?:cost|spend|expense)/i.test(
          part,
        ) &&
        /预算(?:范围)?内|不(?:会)?超(?:过)?(?:你的)?预算|没有超(?:过)?(?:你的)?预算|within (?:your |the )?budget|under (?:your |the )?budget/i.test(
          part,
        ) &&
        !/未(?:知|确认|核实|核对)|尚未|不确定|不能(?:确认|保证|核实)|无法(?:确认|保证|核实)|是否|待(?:确认|核实)|需(?:要)?(?:再)?(?:确认|核实)|unknown|unconfirmed|cannot (?:confirm|verify)|whether|not (?:confirmed|known)/i.test(
          part,
        ),
    );
}

function hasUnsupportedDeparture(text: string, evidence: string): boolean {
  const normalize = (s: string) => s.replace(/^0(?=\d)/, '').replace('：', ':');
  const verified = new Set((evidence.match(/\b\d{1,2}[:：]\d{2}\b/g) ?? []).map(normalize));
  return [
    ...text.matchAll(/(\d{1,2}[:：]\d{2})(?=[^。！？\n]{0,20}(?:出发|出门|离开|depart|leave))/gi),
  ].some((m) => !verified.has(normalize(m[1] ?? '')));
}

function officialRequired(ctx: MatchContext): boolean {
  return /GP|NHS|注册.*医生/i.test(ctx.currentRequest?.text ?? '');
}
function renderMarketRefs(
  ctx: MatchContext,
  refs: string[],
  zh: boolean,
): {
  text: string;
  names: Record<string, string>;
  evidence: string[];
  hasConfirmedChoice: boolean;
  hasVerifiedTravel: boolean;
} | null {
  if (!ctx.marketPlan) return null;
  const listings = (ctx.marketListings ?? []).filter((n) => refs.includes(n.ref));
  if (
    listings.length !== new Set(refs).size ||
    listings.some(
      (n) => ctx.marketTarget && ctx.marketTarget !== 'ANY' && n.tradeType !== ctx.marketTarget,
    )
  )
    return null;
  const choices = buildMarketChoices({
    candidates: listings,
    plan: ctx.marketPlan,
    ...(ctx.taskProgressVersion === ctx.task?.requirementsVersion && ctx.task
      ? { task: ctx.task }
      : {}),
  });
  const usable = [...choices.primary, ...choices.backup].map((r) => r.listing);
  if (usable.length !== listings.length) return null;
  const selections = usable.map((n) => {
    const matched =
      [...choices.primary, ...choices.backup].find((row) => row.listing.ref === n.ref)?.assessment
        .needs ?? [];
    const ownTerms = ctx
      .marketPlan!.needs.filter((need) => matched.includes(need.id))
      .flatMap((need) => need.terms);
    const rows = n.description.split('\n');
    const bullets = rows.filter(
      (s) =>
        /^\s*[-•]/.test(s) &&
        ownTerms.some((t) => s.toLowerCase().includes(t.toLowerCase())) &&
        !/已出|已售|❌|sold/i.test(s),
    );
    const evidence = bullets.length
      ? bullets.slice(0, 4).join('\n')
      : rows
          .filter((s) => /^(?:出售|出租|转租|求购|求帮带|找搭子|时间|地点|路线|要求)[：:]/.test(s))
          .slice(0, 5)
          .join('\n');
    const names = [
      ...new Set(
        bullets.map((line) =>
          line
            .replace(/^\s*[-•]\s*/, '')
            .split('｜')[0]!
            .trim(),
        ),
      ),
    ].slice(0, 3);
    return {
      ref: n.ref,
      name: names.length ? names.join(' / ') : n.title,
      evidence: evidence || n.description.slice(0, 180),
    };
  });
  const rendered = renderMarketChoiceReply({
    listings: usable,
    selections,
    plan: ctx.marketPlan,
    zh,
    assessWholeOffer: true,
    format: !/展开|详细|完整|重新列|show.{0,15}details|full.{0,12}(?:details|list)/i.test(
      ctx.currentRequest?.text.split('\n')[0] ?? '',
    )
      ? 'conversation'
      : 'full',
    ...(ctx.taskProgressVersion === ctx.task?.requirementsVersion && ctx.task
      ? { task: ctx.task }
      : {}),
  });
  return {
    text: rendered.text,
    names: Object.fromEntries(selections.map((s) => [s.ref, s.name])),
    hasConfirmedChoice: rendered.choices.primary.length > 0,
    hasVerifiedTravel: [...rendered.choices.primary, ...rendered.choices.backup].some((row) =>
      row.assessment.checks.some(
        (check) => check.label === 'task:路程用时' && check.status === 'met',
      ),
    ),
    evidence: selections.map((selection, index) => {
      const listing = usable[index];
      if (!listing) return selection.evidence;
      const published = listing.isRepost ? listing.sourcePublishedAt : listing.createdAt;
      const metadata =
        '\nSource publication timestamp (not availability): ' +
        (published ?? 'unknown') +
        '\nEvidence checked on calendar date Europe/London: ' +
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
      const matched =
        [...choices.primary, ...choices.backup].find((row) => row.listing.ref === listing.ref)
          ?.assessment.needs ?? [];
      const mentions = (text: string, terms: string[]) =>
        terms.some((term) => text.toLowerCase().includes(term.toLowerCase()));
      const excluded = ctx.marketPlan!.needs.some(
        (need) =>
          !matched.includes(need.id) &&
          mentions(listing.title + '\n' + listing.description, need.terms),
      );
      if (!excluded) return listing.title + '\n' + listing.description.slice(0, 1600) + metadata;
      const ownTerms = ctx
        .marketPlan!.needs.filter((need) => matched.includes(need.id))
        .flatMap((need) => need.terms);
      const blocks = listing.description
        .split(/\n(?=\s*[-•])/)
        .filter((block) => mentions(block.split('\n')[0] ?? '', ownTerms))
        .map((block) => block.split('——原帖原文——')[0] ?? '')
        .join('\n');
      const common = listing.description
        .split('\n')
        .filter((line) => /^(?:地点|位置|时间|路线|要求|户型|费用)[：:]/.test(line))
        .join('\n');
      return (
        selection.name +
        '\n' +
        (blocks || selection.evidence).slice(0, 1600) +
        '\n' +
        common +
        metadata
      );
    }),
  };
}

export function replyToRequestTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_to_request',
    description: REPLY_TO_REQUEST.description,
    parameters,
    toDraft: async (ctx, args: ReplyArgs) => {
      if (
        !ctx.isAnswerFinalization &&
        args.kind !== 'clarification' &&
        pendingResearchConditions(ctx).length
      )
        return { error: researchFollowupInstruction(ctx), kind: 'research_required' };
      // An "unavailable" with nothing to cite helps nobody who did not ask the assistant directly.
      if (
        isUnsolicitedGroupTurn(ctx) &&
        !args.refs.length &&
        (args.kind === 'unavailable' || (ctx.answerInputExhausted && ctx.isAnswerFinalization))
      ) {
        ctx.replySuppressed = true;
        return { error: FEEDBACK.nothingUseful, kind: 'no_new_help' };
      }
      // Task readiness governs delivery level, not permission to share useful partial facts.
      // Source checks, hard-condition conflict review and the outbound gate still run below.
      if (ctx.answerInputExhausted && ctx.isAnswerFinalization) {
        const zhFailure = ctx.currentRequest?.demand.lang !== 'en';
        // A failed evidence draft is not a gate rejection. The bounded final response still passes the same gate.
        args = {
          kind: 'unavailable',
          refs: [],
          details: null,
          text: zhFailure ? FEEDBACK.exhaustedZh : FEEDBACK.exhaustedEn,
        };
      }
      if (
        /https?:\/\/|@[A-Za-z0-9_]{3,}|(?:微信|whatsapp|电话)[：:]\s*\S+|(?:付款|转账|打款|支付).{0,10}(?:给我|由我|代收)|guarantee|保证一定|(?:我|I).{0,20}(?:替你|帮你|will).{0,20}(?:联系|预约|订票|contact|book)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?(?:44|86)[\d ()-]{8,}\d|\b0\d[\d ()-]{7,}\d\b)/i.test(
          prose(args),
        )
      )
        return { error: FEEDBACK.typedContacts };
      const inlineRefs = prose(args).match(/\bk\d+(?::p\d+)?\b/g) ?? [];
      args = {
        ...args,
        refs: [...new Set([...args.refs, ...inlineRefs])],
        text: stripCitations(args.text),
        details: args.details ? stripCitations(args.details) || null : null,
      };
      const limit = chatLineLimit(ctx);
      if (exceedsChatLine(args.text, limit)) return { error: FEEDBACK.chatLineTooLong(limit) };
      // The budget is six sources, not six excerpts. Validate every exact passage below;
      // never normalize away a fabricated passage to make it look like a valid source.
      const sourceRefs = new Set(args.refs.map((ref) => ref.replace(/:p\d+$/, '')));
      if (args.refs.length > LIMITS.refs || sourceRefs.size > LIMITS.sources)
        return { error: FEEDBACK.tooManySources };
      if (
        ctx.isAnswerFinalization &&
        ctx.deliverySourceRefs &&
        args.refs.some((ref) => !ctx.deliverySourceRefs!.includes(ref.replace(/:p\d+$/, '')))
      )
        return { error: FEEDBACK.outsidePacket };
      // Discover a missing question plan before factual repairs consume the bounded input attempts.
      taskDeliveryForOutbound(ctx, {
        kind:
          args.kind === 'clarification' && !args.refs.length ? 'clarification' : 'recommendation',
        target: ctx.chatId,
        text: args.text,
        inputRef: ctx.sourceMessageId,
        supplierSummaries: [],
      });
      const zh = ctx.currentRequest?.demand.lang === 'zh' || /\p{Script=Han}/u.test(args.text);
      if (hasGuaranteedPurchaseClaim(prose(args))) return { error: FEEDBACK.guaranteedPurchase };
      if (hasUnrecordedSourceFailureClaim(prose(args), ctx.sourceFailures))
        return { error: FEEDBACK.inventedOutage, kind: 'research_required' };
      if (
        args.kind === 'no_match' &&
        deps.answerRequests &&
        (deps.marketSearch || deps.webSearch || deps.xhsSearch) &&
        !ctx.marketQueries?.length &&
        !ctx.marketDetailIds?.length &&
        !ctx.informationQueries?.length &&
        !ctx.xhsQueries?.length &&
        ctx.xhsNotes === undefined &&
        ctx.searchResults === undefined &&
        !ctx.sourceFailures?.length &&
        !ctx.supplierSearchEmpty &&
        !(ctx.answerInputExhausted && ctx.isAnswerFinalization)
      )
        return { error: FEEDBACK.noSearchYet, kind: 'research_required' };
      const market = args.refs.filter((r) => /^m\d+$/.test(r));
      if (market.length && hasUnqualifiedSellerIdentity(prose(args)))
        return { error: FEEDBACK.sellerIdentity };
      let card: Array<string | null | undefined> = [];
      let evidence: string[] = [];
      if (market.length) {
        if (market.length !== args.refs.length) return { error: FEEDBACK.mixedRefs };
        const rendered = renderMarketRefs(ctx, market, zh);
        if (!rendered) return { error: FEEDBACK.offerIneligible(marketChoiceFeedback(ctx)) };
        const inline = prose(args).match(/\bm\d+\b/g) ?? [];
        if (inline.some((ref) => !market.includes(ref)))
          return { error: FEEDBACK.unselectedInline };
        const named = (text: string) => text.replace(/\bm\d+\b/g, (ref) => rendered.names[ref]!);
        args = {
          ...args,
          text: named(args.text),
          details: args.details ? named(args.details) : null,
        };
        if (!rendered.hasConfirmedChoice && claimsCompleteMarketFit(prose(args)))
          return { error: FEEDBACK.completeFitUnconfirmed };
        if (
          ctx.task?.constraints.some((c) => c.key === 'max_travel_minutes') &&
          !rendered.hasVerifiedTravel &&
          claimsUnverifiedTravelFit(prose(args))
        )
          return { error: FEEDBACK.travelUnverified };
        const review = await checkMarketOfferConflicts(deps, ctx, market);
        if (review.kind === 'conflict') return { error: FEEDBACK.conflict(review.conflicts) };
        if (review.kind === 'incomplete')
          return { error: FEEDBACK.incompleteReview(review.reason) };
        if (
          ctx.currentRequest?.demand.category === 'housing' &&
          claimsUnknownTotalFits(prose(args), rendered.evidence.join('\n'))
        )
          return { error: FEEDBACK.unknownTotal };
        const support = rendered.evidence.join('\n') + '\n' + (ctx.currentRequest?.text ?? '');
        const unsupported = unsupportedNumericClaims(prose(args), support, market.length);
        if (unsupported.length) return { error: FEEDBACK.unsupportedNumbers(unsupported) };
        card = [args.details, rendered.text];
        evidence = rendered.evidence;
      } else {
        const sources = args.refs.map((ref) =>
          (ctx.knowledgeSources ?? []).find(
            (s) => s.ref === ref || s.passages.some((p) => p.id === ref),
          ),
        );
        if (sources.some((s) => !s)) return { error: FEEDBACK.unknownSourceRef };
        if (['answer', 'partial'].includes(args.kind) && !sources.length)
          return { error: FEEDBACK.factsNeedSources };
        if (
          officialRequired(ctx) &&
          ['answer', 'partial'].includes(args.kind) &&
          !sources.every((s) => /(^|\.)nhs\.uk$/i.test(new URL(s!.url).hostname))
        )
          return { error: FEEDBACK.nhsOnly };
        evidence = [...new Set(sources.filter((s) => !!s))].map((s) => s.title + '\n' + s.text);
        const support = evidence.join('\n') + '\n' + (ctx.currentRequest?.text ?? '');
        if (
          /希思罗|机场|heathrow/i.test(ctx.currentRequest?.text ?? '') &&
          hasUnsupportedDeparture(prose(args), evidence.join('\n'))
        )
          return { error: FEEDBACK.departureUnverified, kind: 'research_required' };

        const unsupported = unsupportedNumericClaims(prose(args), support, new Set(sources).size);
        if (args.kind !== 'clarification' && unsupported.length)
          return { error: FEEDBACK.unsupportedNumbers(unsupported) };
        if (
          ['answer', 'partial'].includes(args.kind) &&
          /免费|free entry/i.test(prose(args)) &&
          !/免费|free/i.test(evidence.join('\n'))
        )
          return { error: FEEDBACK.freeNeedsEvidence };
        if (args.kind === 'unavailable') {
          if (!ctx.sourceFailures?.length) return { error: FEEDBACK.noRecordedOutage };
        }
        const unique = [...new Set(sources.filter((s) => !!s))];
        const links = unique.length
          ? (zh ? '来源：' : 'Source: ') +
            unique
              .map(
                (s, i) =>
                  '[' +
                  (i + 1) +
                  '. ' +
                  s.title.replace(/[\[\]()\r\n]/g, '').slice(0, 38) +
                  '](' +
                  s.url +
                  ')',
              )
              .join(' · ')
          : '';
        card = [args.details, links];
      }
      if (
        !market.length &&
        canSkipSupplementReply(ctx) &&
        !hasNewSupplementEvidence(ctx, args.refs)
      ) {
        ctx.replySuppressed = true;
        await deps.repos.traces.create({
          kind: 'gate',
          inputRef: ctx.sourceMessageId,
          phase: ctx.phase,
          latencyMs: 0,
          costMicro: 0,
          output: {
            gate: 'request_answer',
            decision: 'suppressed',
            reason: 'no_new_source_evidence_for_context_supplement',
          },
        });
        return { error: FEEDBACK.noNewEvidence, kind: 'no_new_help' };
      }
      const text = args.text + renderEvidenceCard({ zh, sections: card });
      if (text.length > LIMITS.rendered) return { error: FEEDBACK.tooLong };
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        output: {
          gate: 'request_answer',
          kind: args.kind,
          refs: args.refs,
          sourceBound: !!ctx.currentRequest,
        },
        phase: ctx.phase,
        latencyMs: 0,
        costMicro: 0,
      });
      return {
        kind:
          args.kind === 'clarification' && !args.refs.length ? 'clarification' : 'recommendation',
        target: ctx.chatId,
        text,
        taskQuestionText: args.text,
        supplierSummaries: evidence,
        inputRef: ctx.sourceMessageId,
        ...groupReplyAddressing(ctx),
      };
    },
  });
}

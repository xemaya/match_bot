import { taskProgressSchema, type UserTask, type TaskConstraint } from '@matchbot/domain';
import { hashText } from '@matchbot/shared';
import { z } from 'zod';
import { assessHousingMoveIn } from './housing-date-evidence.js';
import { isActiveMarketListing } from '@matchbot/websearch';
import type { MatchContext } from './context.js';
import { assessMarketListing } from './market-strategy.js';
import { getMarketSourceIdentity } from './market-choices.js';
import { getXhsNoteKey } from './xhs-research.js';
import { getXhsPassages } from './xhs-evidence.js';
import type { SourceClaim } from '@matchbot/jev';

const id = z.string().min(1).max(160);
export const taskSourceCheckSchema = z.strictObject({
  goalId: id,
  criterionId: id,
  status: z.enum(['supported', 'unknown', 'conflict']),
  sources: z
    .array(z.strictObject({ ref: id, quote: z.string().min(1).max(1000).nullable() }))
    .max(4),
});
export const taskProgressParameters = z.strictObject({
  checks: z.array(taskSourceCheckSchema).max(24),
  next: z.strictObject({
    action: z.enum(['research', 'ask_user', 'wait_source', 'deliver']),
    goalId: id.nullable(),
    constraintKey: id.nullable(),
    reason: z.string().min(1).max(500),
  }),
});
type Check = z.infer<typeof taskSourceCheckSchema>;
type Source = {
  text: string;
  sourceRef: string;
  entityKey: string;
  url: string;
  passageText?: string;
  computed?: {
    status: 'met' | 'unknown' | 'mismatch';
    evidence: string | null;
    decisive?: boolean;
  };
};
/** Null delegates excerpt selection to the server; it never skips the semantic/computed checks. */
function sourceQuote(source: Source, quote: string | null): string | null {
  return source.computed?.decisive
    ? source.computed.evidence
    : (quote ?? source.computed?.evidence ?? source.passageText ?? source.text.slice(0, 1000)) ||
        null;
}
export class TaskEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskEvidenceError';
  }
}
function condition(task: UserTask, goalId: string, key: string | null): TaskConstraint | undefined {
  return (
    task.constraints.find((c) => c.goalId === goalId && c.key === key) ??
    task.constraints.find((c) => !c.goalId && c.key === key)
  );
}
function knownUserOrigin(task: UserTask, goalId: string, key: string | null) {
  const c = key === 'travel_origin' ? condition(task, goalId, key) : undefined;
  return c && (c.value.kind === 'location' || c.value.kind === 'text') ? c : null;
}
function getSource(ctx: MatchContext, check: Check, ref: string): Source {
  const task = ctx.task!;
  const criterion = task.goals
    .find((g) => g.id === check.goalId)
    ?.criteria.find((c) => c.id === check.criterionId);
  if (!criterion) throw new TaskEvidenceError('unknown task criterion');
  const listing = ctx.marketListings?.find((n) => n.ref === ref);
  if (listing) {
    const need = ctx.marketPlan?.needs.find((n) => n.id === check.goalId);
    if (!need || !ctx.marketPlan)
      throw new TaskEvidenceError('market source needs the current scoped goal plan');
    const assessment = assessMarketListing(listing, { ...ctx.marketPlan, needs: [need] });
    const target =
      ctx.marketTarget ??
      (task.counterparty === 'supply'
        ? 'SELL'
        : task.counterparty === 'demand'
          ? 'BUY'
          : task.counterparty === 'peer'
            ? 'PEER'
            : null);
    if (check.status !== 'unknown' && target && target !== 'ANY' && listing.tradeType !== target)
      throw new TaskEvidenceError('source has the wrong trade direction');
    if (
      check.status === 'supported' &&
      !isActiveMarketListing(listing, new Date(), { respectAvailability: false })
    )
      throw new TaskEvidenceError('source is explicitly inactive');
    const labels: Record<string, string> = {
      budget: 'budget',
      area: 'area',
      route_from: 'route',
      route_to: 'route',
      date: 'date',
      room_type: 'room_type',
      feature: 'required',
      capacity: 'capacity',
    };
    const moveIn =
      criterion.constraintKey === 'move_in_date'
        ? condition(task, check.goalId, 'move_in_date')?.value
        : undefined;
    const dateCheck =
      ctx.marketPlan.intent === 'housing' && moveIn?.kind === 'date_range'
        ? assessHousingMoveIn(listing.title + '\n' + listing.description, moveIn)
        : undefined;
    const computed =
      dateCheck ??
      (criterion.constraintKey
        ? assessment.checks.find((c) => c.label === labels[criterion.constraintKey!])
        : undefined);
    if (check.status === 'supported' && !assessment.needs.includes(check.goalId))
      throw new TaskEvidenceError('source is not this requested item or activity');
    return {
      text: listing.title + '\n' + listing.description,
      sourceRef: 'market:' + listing.id,
      entityKey: 'market:' + getMarketSourceIdentity(listing),
      url: listing.sourceUrl ?? listing.url,
      ...(computed ? { computed } : {}),
    };
  }
  const known = ctx.knowledgeSources?.find(
    (k) => k.ref === ref || k.passages.some((p) => p.id === ref),
  );
  if (known) {
    if (
      (task.counterparty || task.category === 'housing' || task.category === 'second_hand') &&
      check.status !== 'unknown'
    )
      throw new TaskEvidenceError(
        'a general policy cannot prove the condition of a specific offer',
      );
    if (
      /GP|NHS|注册.*医生/i.test(task.objective + (ctx.currentRequest?.text ?? '')) &&
      !/(^|\.)nhs\.uk$/i.test(new URL(known.url).hostname)
    )
      throw new TaskEvidenceError('this administrative goal needs NHS official sources');
    return {
      text: known.passages.find((p) => p.id === ref)?.text ?? known.text,
      ...(known.passages.some((p) => p.id === ref)
        ? { passageText: known.passages.find((p) => p.id === ref)!.text }
        : {}),
      sourceRef: 'web:' + hashText(known.url).slice(0, 32),
      entityKey: 'information:' + check.goalId,
      url: known.url,
    };
  }
  const note = ctx.xhsNotes?.find(
    (n) => n.ref === ref || (n.isDetailLoaded && getXhsPassages(n).some((p) => p.id === ref)),
  );
  const passage = note ? getXhsPassages(note).find((p) => p.id === ref) : undefined;
  if (note?.isDetailLoaded) {
    const validated = ctx.xhsValidatedRecommendations?.find((r) =>
      r.sources.some((s) => s.ref === note.ref),
    );
    return {
      text: passage?.text ?? note.title + '\n' + note.desc,
      ...(passage ? { passageText: passage.text } : {}),
      sourceRef: 'xhs:' + getXhsNoteKey(note.url),
      entityKey: validated
        ? 'exhibition:' + hashText(validated.name).slice(0, 32)
        : 'xhs:' + getXhsNoteKey(note.url),
      url: note.url,
    };
  }
  throw new TaskEvidenceError('unknown or unread source reference');
}
function contradicts(quote: string, c: TaskConstraint | undefined): boolean {
  if (!c) return false;
  if (c.key === 'pets')
    return /(?:不允许|不接受|禁止|谢绝|不可|不能)[^，。\n;；但]{0,8}(?:猫|宠物)|(?:猫|宠物)[^，。\n;；但]{0,8}(?:禁止|不允许)|\bno (?:pets|cats)\b|pets (?:are )?not allowed/i.test(
      quote,
    );
  const term = c.value.kind === 'text' ? c.value.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  return (
    !!term &&
    new RegExp(
      `(?:不支持|不允许|没有|禁止|无)[^，。\\n;；但]{0,8}${term}|${term}[^，。\\n;；但]{0,8}(?:未说明|未确认|待确认|不支持)`,
      'i',
    ).test(quote)
  );
}

/** Resolve references only against real tool results; the model cannot provide a source snapshot or entity ID. */
export function buildTaskProgress(
  p: z.input<typeof taskProgressParameters> & { ctx: MatchContext },
) {
  const task = p.ctx.task;
  if (
    !task ||
    task.ownerUserId !== p.ctx.userId ||
    task.scope.chatId !== p.ctx.chatId ||
    task.scope.channel !== (p.ctx.channel ?? 'telegram')
  )
    throw new TaskEvidenceError('task scope mismatch');
  const { ctx: _ctx, ...raw } = p;
  const args = taskProgressParameters.parse(raw);
  if (args.next.action === 'wait_source' && !p.ctx.sourceFailures?.length)
    throw new TaskEvidenceError('source wait requires an observed failure');
  if (args.next.action === 'ask_user' && !args.next.constraintKey)
    throw new TaskEvidenceError('a question requires one specific missing condition');
  const evidence = new Map<string, z.infer<typeof taskProgressSchema>['evidence'][number]>();
  const now = new Date().toISOString();
  const contextProofs = new Map<
    string,
    {
      check: z.infer<typeof taskProgressSchema>['checks'][number];
      evidence: z.infer<typeof taskProgressSchema>['evidence'][number];
    }
  >();
  for (const goal of task.goals.filter((g) => !g.userConfirmation))
    for (const criterion of goal.criteria) {
      const origin = knownUserOrigin(task, goal.id, criterion.constraintKey);
      if (!origin) continue;
      const sourceId =
        origin.origin.kind === 'user'
          ? origin.origin.sourceMessageId
          : origin.origin.acceptedByMessageId;
      const sourceRef = 'message:' + hashText(sourceId).slice(0, 40),
        proofId =
          'e:' +
          hashText(JSON.stringify([goal.id, origin.key, origin.value, sourceRef])).slice(0, 40);
      const place =
        origin.value.kind === 'location'
          ? origin.value.area
          : origin.value.kind === 'text'
            ? origin.value.text
            : '';
      contextProofs.set(JSON.stringify([goal.id, criterion.id]), {
        check: {
          goalId: goal.id,
          criterionId: criterion.id,
          status: 'supported',
          evidenceRefs: [proofId],
        },
        evidence: {
          id: proofId,
          goalId: goal.id,
          kind: 'user_statement',
          sourceRef,
          summary: '用户提供的出发地点：' + place.slice(0, 800),
          observedAt: now,
        },
      });
    }
  const checks: z.infer<typeof taskProgressSchema>['checks'] = args.checks.map((check) => {
    const context = contextProofs.get(JSON.stringify([check.goalId, check.criterionId]));
    if (context) {
      evidence.set(context.evidence.id, context.evidence);
      return context.check;
    }
    const criterion = task.goals
      .find((g) => g.id === check.goalId)
      ?.criteria.find((c) => c.id === check.criterionId);
    if (!criterion)
      throw new TaskEvidenceError(
        'unknown task criterion; use the exact IDs in the selected task plan',
      );
    const refs = check.sources.map((input) => {
      const source = getSource(p.ctx, check, input.ref);
      if (input.quote && !source.text.includes(input.quote))
        throw new TaskEvidenceError('quote is not in the returned source');
      let quote = sourceQuote(source, input.quote);
      if (source.computed && check.status !== 'unknown') {
        const strict = /^(?:budget|area|route_from|route_to|date|capacity)$/.test(
          criterion.constraintKey ?? '',
        );
        if (
          (check.status === 'supported' && source.computed.status === 'mismatch') ||
          (strict &&
            ((check.status === 'supported' && source.computed.status !== 'met') ||
              (check.status === 'conflict' && source.computed.status !== 'mismatch')))
        )
          throw new TaskEvidenceError(
            'source condition ' +
              criterion.constraintKey +
              ' is ' +
              source.computed.status +
              '; keep it unknown unless the computed check supports the proposed status',
          );
        if (source.computed.status !== 'unknown') quote = source.computed.evidence;
      }
      if (!quote)
        throw new TaskEvidenceError(
          'criterion ' +
            criterion.id +
            ' requires an exact quote or a returned passage ID; quote=null is valid for server-owned passages or computed facts',
        );
      const fullLine = source.text.split('\n').find((line) => line.includes(quote!)) ?? quote;
      if (
        check.status === 'supported' &&
        contradicts(fullLine, condition(task, check.goalId, criterion.constraintKey))
      )
        throw new TaskEvidenceError('source quote contradicts the required condition');
      const at = fullLine.indexOf(quote);
      quote =
        fullLine.length <= 1000
          ? fullLine
          : fullLine.slice(Math.max(0, at - 250), Math.max(0, at - 250) + 1000);
      const evidenceId =
        'e:' + hashText(JSON.stringify([check.goalId, source.sourceRef, quote])).slice(0, 40);
      evidence.set(evidenceId, {
        id: evidenceId,
        goalId: check.goalId,
        kind: 'source_excerpt',
        sourceRef: source.sourceRef,
        entityKey: source.entityKey,
        ...(source.url.startsWith('https://') ? { url: source.url } : {}),
        summary: quote,
        observedAt: now,
      });
      return evidenceId;
    });
    return {
      goalId: check.goalId,
      criterionId: check.criterionId,
      status: check.status,
      evidenceRefs: refs,
    };
  });
  for (const proof of contextProofs.values())
    if (
      !checks.some(
        (c) => c.goalId === proof.check.goalId && c.criterionId === proof.check.criterionId,
      )
    ) {
      checks.push(proof.check);
      evidence.set(proof.evidence.id, proof.evidence);
    }
  const refreshed = new Map<string, { text: string; usable: boolean }>();
  for (const listing of p.ctx.marketListings ?? [])
    if (p.ctx.marketDetailIds?.includes(listing.id))
      refreshed.set('market:' + listing.id, {
        text: listing.title + '\n' + listing.description,
        usable: isActiveMarketListing(listing, new Date(), { respectAvailability: false }),
      });
  for (const source of p.ctx.knowledgeSources ?? [])
    refreshed.set('web:' + hashText(source.url).slice(0, 32), { text: source.text, usable: true });
  for (const note of p.ctx.xhsNotes ?? [])
    if (note.isDetailLoaded)
      refreshed.set('xhs:' + getXhsNoteKey(note.url), {
        text: note.title + '\n' + note.desc,
        usable: true,
      });
  for (const goal of task.goals.filter((g) => !g.userConfirmation))
    for (const criterion of goal.criteria) {
      const isCurrent = (ref: string, isSupport: boolean) => {
        const proof = task.evidence.find((e) => e.id === ref),
          current = proof ? refreshed.get(proof.sourceRef) : undefined;
        if (!proof || !current) return true;
        const line = current.text.split('\n').find((row) => row.includes(proof.summary));
        return (
          current.usable &&
          current.text.includes(proof.summary) &&
          !(
            isSupport &&
            contradicts(line ?? proof.summary, condition(task, goal.id, criterion.constraintKey))
          )
        );
      };
      const negative = (criterion.conflictingEvidenceRefs ?? []).filter((ref) =>
        isCurrent(ref, false),
      );
      const supplied = checks.find((c) => c.goalId === goal.id && c.criterionId === criterion.id);
      if (supplied) {
        supplied.conflictingEvidenceRefs = negative;
        continue;
      }
      const refs = criterion.evidenceRefs.filter((ref) =>
        isCurrent(ref, criterion.status === 'supported'),
      );
      if (
        refs.length !== criterion.evidenceRefs.length ||
        negative.length !== (criterion.conflictingEvidenceRefs?.length ?? 0)
      )
        checks.push({
          goalId: goal.id,
          criterionId: criterion.id,
          status: refs.length ? criterion.status : 'unknown',
          evidenceRefs: refs,
          conflictingEvidenceRefs: negative,
        });
    }
  return taskProgressSchema.parse({
    requirementsVersion: task.requirementsVersion,
    evidence: [...evidence.values()],
    checks,
    hasSourceFailure: !!p.ctx.sourceFailures?.length,
    nextStep: {
      action: args.next.action,
      owner: args.next.action === 'wait_source' ? 'source' : 'agent',
      reason: args.next.reason,
      ...(args.next.goalId ? { goalId: args.next.goalId } : {}),
      ...(args.next.constraintKey ? { constraintKey: args.next.constraintKey } : {}),
    },
  });
}

export function buildTaskSourceReview(
  ctx: MatchContext,
  checks: z.infer<typeof taskProgressParameters>['checks'],
) {
  const claims: SourceClaim[] = [];
  const sources = new Map<string, string>();
  const indexes: number[] = [];
  const sourceIndexes: number[] = [];
  const eligible: boolean[] = [];
  const decisive: Array<boolean | undefined> = [];
  // Whether the server's own check of this condition (budget, area, date, ...) agrees with the
  // proposed status; undefined when the server has no opinion.
  const computedAgrees: Array<boolean | undefined> = [];
  for (const [index, check] of checks.entries()) {
    const goal = ctx.task!.goals.find((g) => g.id === check.goalId)!;
    const criterion = goal.criteria.find((c) => c.id === check.criterionId)!;
    if (knownUserOrigin(ctx.task!, goal.id, criterion.constraintKey)) continue;
    for (const [sourceIndex, proof] of check.sources.entries()) {
      const source = getSource(ctx, check, proof.ref);
      const initialQuote = sourceQuote(source, proof.quote);
      if (!initialQuote) continue;
      const at = source.text.indexOf(initialQuote);
      const text =
        source.text.length <= 5000
          ? source.text
          : source.text.slice(Math.max(0, at - 1500), Math.max(0, at - 1500) + 5000);
      const sourceId = source.sourceRef + ':' + hashText(text).slice(0, 16);
      sources.set(sourceId, text);
      for (const status of check.status === 'unknown'
        ? (['supported', 'conflict'] as const)
        : [check.status]) {
        let canUse = true,
          quote = initialQuote;
        try {
          const validated = buildTaskProgress({
            ctx,
            checks: [{ ...check, status, sources: [proof] }],
            next: { action: 'research', goalId: null, constraintKey: null, reason: '核验来源条件' },
          });
          quote = validated.evidence[0]?.summary ?? initialQuote;
        } catch (error) {
          if (!(error instanceof TaskEvidenceError)) throw error;
          canUse = false;
        }
        claims.push({
          goalId: goal.id,
          criterionId: criterion.id,
          goal: goal.title,
          requirement: JSON.stringify({
            criterion: criterion.label,
            condition: condition(ctx.task!, goal.id, criterion.constraintKey)?.value ?? null,
            budgetScope:
              condition(ctx.task!, goal.id, criterion.constraintKey)?.budgetScope ?? null,
            counterparty: ctx.task!.counterparty,
          }),
          proposedStatus: status,
          sourceId,
          quote,
        });
        indexes.push(index);
        sourceIndexes.push(sourceIndex);
        eligible.push(canUse);
        const agrees =
          source.computed && source.computed.status !== 'unknown'
            ? source.computed.status === (status === 'supported' ? 'met' : 'mismatch')
            : undefined;
        decisive.push(source.computed?.decisive ? agrees : undefined);
        computedAgrees.push(agrees);
      }
    }
  }
  return {
    claims,
    sources: [...sources].map(([id, text]) => ({ id, text })),
    indexes,
    sourceIndexes,
    eligible,
    decisive,
    computedAgrees,
  };
}

import type { MatchContext } from './context.js';
import { SOUL_INSTRUCTIONS } from './soul.js';
import { TRUST_RULES, FACT_RULES, DELIVERY_RULES } from './prompts/rules.js';

/** Stable delivery policy; selected source data is injected in the user-role runtime packet. */
export function deliveryInstructions(_ctx: MatchContext, today: string): string {
  return [
    SOUL_INSTRUCTIONS,
    TRUST_RULES,
    FACT_RULES,
    DELIVERY_RULES,
    `Today is ${today} (Europe/London).`,
    'FINALIZATION: Only reply_to_request is available. Use the runtime packet current request, selected task, current evidence, receipts and unresolved conditions to deliver the best truthful answer now. Research is finished. Source ordering is a preference, not proof that other supplied pages are irrelevant. Cover the current question using complementary evidence (for example procedure rules plus the specific provider). Never transfer facts about one venue or offer to another. When unresearchedConditions remain, disclose the unresolved condition without claiming it was checked. Use validationFeedback to repair the actual rejected draft: omit an already-answered or unrecorded question and deliver supported facts; remove unsupported numbers or rejected references. A validation error allows a corrected smaller answer, but an outboundBlocked decision never allows resubmission. Do not request another search, propose a later action or silently finish.',
    'If task binding is ambiguous, ask one clarification without choosing a task or citing unrelated evidence. If evidence validation is exhausted, give one short unavailable explanation with refs=[]. Otherwise distinguish answer, partial, no_match and unavailable from actual receipts. Use known eligible references only. Keep important uncertainty explicit and omit excluded options. Sources outside the deliveryContract reference families cannot be cited by this tool: explain inability to complete this answer, never invent refs or claim that a search with returned sources found nothing. Prefer two short paragraphs; use a necessary personal question only when the task already authorizes that question.',
  ].join('\n');
}

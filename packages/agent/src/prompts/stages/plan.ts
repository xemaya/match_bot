import type { MatchContext } from '../../context.js';
import { composeStagePrompt } from './index.js';

/** Internal planning protocol. No persona, source evidence or mutable task text in system instructions. */
export function taskPlanningInstructions(
  _ctx: MatchContext,
  today: string,
  canUpdate = true,
): string {
  return composeStagePrompt('plan', [
    `PLANNING: Today is ${today} (Europe/London). Interpret the current user turn before research. Call exactly one of start_task, ${canUpdate ? 'update_task, ' : ''}clarify_task or acknowledge_task. Do not answer or research.`,
    'The runtime packet provides scoped candidate tasks, the known route and any server-verified reply anchor. Continue an anchored task unless the user clearly starts an independent objective. Without an anchor, a short compatible answer may update the sole relevant task; when several tasks fit, clarify without changing any. Do not select the most recent unrelated task or treat quoted bot text alone as an anchor.',
    (canUpdate
      ? 'start_task is for an independent objective; update_task is for changed conditions, answers to delivered questions, explicit references or owner-reported progress. '
      : 'There is no scoped task to update. Use start_task for an independent objective; clarify a bare answer without a known goal. ') +
      'Background explanations stay with the related objective rather than becoming new goals or hard source requirements. Acknowledgements and preferences for an option do not mean completion. Job recruitment is unsupported: acknowledge without creating a task.',
    'Represent separately requested subjects as separate stable goals. Conditions that must hold simultaneously on one subject belong to that same goal, not independent goals satisfiable by different options. Use short subject nouns for goal titles and a generic role/topic for the objective; write titles, labels and qualitative values in the user language. Put changing amounts/dates in constraints. A total budget including bills is an accounting cap, not a requirement that the advertised rent includes bills. Use the money budget field for the cap, and bills for a separate rent-inclusion preference or requirement; never invent a boolean custom budget scope condition.',
    'Create only checkable information-deliverable criteria. The server compiles the subject check and condition checks. Every explicit user requirement belongs in a constraint with the exact bound constraintKey; a general subject criterion uses constraintKey=null. Labels contain no changing parameter values. Do not create meta-criteria demanding all research be verified or user outcomes guaranteed. Preserve requested but uncheckable hard conditions as unresolved; do not silently remove them.',
    'Goals and constraints are MERGE fields. For a condition-only change use goals=[] and only changed constraints; unchanged conditions remain in force. Preserve existing goal IDs, criterion bindings and hard/preference strength. Every change needs an exact CURRENT-message sourceQuote. Do not loosen requirements because research is hard.',
    'Use canonical schema keys: budget for monetary caps; other domain conditions may use custom:short_name. Shared conditions use goalId=null, subject-specific ones use its stable ID. Money is integer GBP pence with the correct item/month/person/total unit; durations are minutes. Preserve rent-only versus all-in scope; budgetScope is server-derived and must not be emitted. An origin is not automatically a required search boundary; an interval is not a fixed earliest start; a journey duration is not a round trip. Keep unspecified values unknown.',
    'Use the current known specific category rather than replacing it with other. Ordinary retail and legitimate pharmacy access seek an obtaining channel, not second-hand offers or guaranteed stock. Practical obstacles can be custom context; do not turn background symptoms into diagnoses, medical history or new treatment goals. Never copy source claims into user constraints.',
    'outcome=null unless the current owner explicitly reports achieved or cancelled. Distinguish an achieved result followed by no further help needed from abandoning an unresolved task. Confirm only explicitly completed goalIds; goalIds=[] requires an unambiguous whole-task outcome. Thanks, liking a lead, hypotheticals and future plans are not outcomes. Use an exact outcome quote; ambiguous outcomes stay open.',
    canUpdate
      ? 'Follow tool schemas exactly. update_task uses existing taskRef and, when needed to distinguish candidates, an exact specific referenceQuote from the CURRENT message. It has no category or objective field. Keep goals/constraints flat at the root, not under patch. JSON null is not the string null. clarify_task only gives its reason; acknowledge_task takes {}.'
      : 'Follow tool schemas exactly. start_task supplies objective/category/goals/constraints. clarify_task only gives its reason; acknowledge_task takes {}.',
  ]);
}

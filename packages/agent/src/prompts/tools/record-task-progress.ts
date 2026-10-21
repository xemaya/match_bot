export const RECORD_TASK_PROGRESS = {
  description:
    'Record verified source evidence and a responsible next step for the selected task. Use known goal/criterion IDs and source refs. Exact source text may be supplied with status=unknown: the server then checks both support and contradiction, keeping missing/ambiguous/unavailable evidence unknown. Each criterion describes the best coherent option; do not mix rejected alternatives into supporting evidence. Prefer returned passage IDs with quote=null. For a whole-source ref, quote=null selects a bounded server-owned excerpt and still runs semantic/computed checks; supply an exact quote when the relevant fact is deeper in a long source. Never combine different offers, treat public status as guaranteed availability, or mark the user goal complete. Choose research for public facts your tools can retrieve; ask_user only for a missing personal condition or decision that changes your next action. Record internal checks without turning them into a public checklist. Use wait_source only after a real failure, or deliver the useful findings with concrete unknowns. This sends nothing.',
  feedback: {
    invalidSchema:
      'Use the small checks/next schema and known IDs; unknown checks use sources=[]. The task progress input was invalid.',
    budgetExhausted:
      'Provide the best honest partial answer or request status: the task progress budget is exhausted.',
    blocked: 'not allowed: outbound already declined',
    deadlineBeforeReview: 'research deadline reached; do not start another review',
    deadlineAfterReview: 'research deadline reached; do not continue or save obsolete work',
    alreadyKnown:
      'Use the known personal condition; choose research for public gaps or deliver useful findings. This condition is already known, so do not ask it again.',
    versionConflict:
      'task changed while researching; do not overwrite or answer using obsolete conditions',
    freshQueryNeeded: (keys: string[]) =>
      ('New hard conditions need a focused fresh query before delivery: ' + keys.join(', ')).slice(
        0,
        500,
      ),
    notSaved: 'task progress could not be saved; stop and explain the current processing gap',
  },
  results: {
    passages:
      'Use only exact passage IDs already returned by search_information or xhs_read_notes; quote=null copies their text on the server.',
    next: 'Use an actual returned ref and quote. Unproved checks stay unknown with sources=[]. Do not repeat the same rejected check. Useful partial answers may go directly to reply_to_request; they still pass source and outbound checks.',
  },
} as const;

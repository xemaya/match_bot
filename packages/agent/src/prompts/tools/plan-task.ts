/** The planning stage tools (start/update/clarify/acknowledge) and the combined legacy plan_task. */
export const PLAN_TASK = {
  planTask: {
    description:
      'Bind the CURRENT user message to one scoped task, or create a new objective with separate goals and explicit constraints. Quote current user text for changes. Use clarify for ambiguous references and ignore for thanks/chatter. Only explicit owner statements can confirm outcomes: thanks, liking a result and conditional/future statements never mean completion. This records internal task state and never sends or contacts anyone.',
  },
  startTask: {
    description:
      'Create an internal scoped task for a NEW objective. Provide short user-language topic goals, parameter-free acceptance criteria and explicitly stated conditions. Do not use this for a bare clarification answer or thanks. No message, contact or transaction is sent.',
  },
  updateTask: {
    description:
      'Update one EXISTING scoped task from the current owner message. For budget/date/other condition changes set goals=[] and only supply changed constraints; server updates the acceptance checks. Preserve other goals and conditions. Outcome only for explicit reported completion or cancellation. No external action is sent.',
  },
  clarifyTask: {
    description:
      'Record that the current short message cannot be assigned to a task, without changing any task. The answering stage will ask one necessary question through its normal outbound gate.',
  },
  acknowledgeTask: {
    description:
      'Record thanks, an acknowledgement or irrelevant chatter without changing task progress. Liking an option never means the goal was achieved. This tool sends nothing.',
  },
  feedback: {
    invalidSchema:
      'task proposal rejected: keep goals and constraints flat at the tool root, omit fields not in this tool schema, and use actual JSON null, not the string "null"; the input was invalid JSON/schema',
    singleScopedTask: (id: string) =>
      'There is only one scoped task: ' +
      id +
      '. Use update_task for a compatible short followup, or start_task for a clearly independent objective. Use missing_goal only if the new objective itself is genuinely undefined; do not ask which existing task.',
    rejected: (reason: string) => 'task proposal rejected: ' + reason,
    fallback:
      'verify the scoped reference, current user source quotes, explicit outcome and unchanged hard conditions; do not invent facts or retry a changed task',
    newTaskNeeds:
      'new task needs a supported objective and separate goals, not another task reference',
    objectiveGeneric:
      'Keep the objective generic: role and topic only. Put changing prices, dates and other conditions in constraints.',
    alreadyBound: 'task prepared: already bound for this turn',
    noMutation: 'unbound or acknowledged messages cannot mutate a task',
    inaccessible: 'task reference is inaccessible',
    needsReference:
      'selecting between multiple tasks needs a specific current user reference or a delivered reply anchor',
    changed: 'task changed; do not overwrite another turn',
    prepared: (kind: string) => 'task prepared: ' + kind,
  },
} as const;

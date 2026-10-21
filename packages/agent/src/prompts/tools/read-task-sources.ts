export const READ_TASK_SOURCES = {
  description:
    'Revisit 1-4 saved source refs in the selected task, especially after a followup or changed condition. Saved excerpts are HISTORICAL observations, not current stock or permission. A2H public listings are re-read within the shared 8-detail budget and assigned current m refs. Other sources are historical hints only: use search_information/xhs_search to verify them before citing. No private lookup, contact or messages.',
  feedback: {
    blocked: 'outbound declined; stop',
    deadline: 'source read deadline reached',
    scopeMismatch: 'task scope mismatch',
    notSaved: 'only saved sources for unresolved goals are allowed',
    detailBudget: 'detail budget exhausted; use current evidence',
    candidateBudget: 'candidate budget exhausted; use current evidence',
    intentMismatch: 'saved source does not match the current task intent',
  },
  results: {
    guidance:
      'Historical excerpts are not current citations. Use refreshed m refs only after checking current task conditions; SOLD/expired offers cannot be recommended. Re-search other source types. Saving or reading evidence does not complete the user goal.',
  },
} as const;

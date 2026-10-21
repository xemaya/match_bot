export const MARKET_ENRICH = {
  description:
    'Resolve important missing public facts yourself by reading details of discovered A2H listings before answering; do not send the user a list of facts this tool can look up. Fills original-post publication date, status and public practical information (descriptions truncated to the first 1500 characters). Choose 1-4 returned refs per batch; at most 8 distinct listing details per run. Re-check status: sold/expired is not an available offer. No contact lookup or private messages.',
  feedback: {
    blocked: 'not allowed: outbound declined; stop',
    unknownRef: 'Use only refs returned by market_search: this ref is unknown.',
    detailBudget: 'Use the existing evidence: the detail budget is exhausted.',
    repeated: 'Use the details already returned: these refs were already attempted.',
  },
  results: {
    guidance:
      "Check choiceHints and researchTasks before replying. If critical facts are still missing, use at most 1-2 remaining searches for the source-attested entity and that gap, not generic new discovery. Never borrow another owner's conditions. If they remain unknown, show backups rather than confirmed recommendations. Original sourcePublishedAt is not the import createdAt. Keep data from each listing together, do not recommend ended offers; uncertain dates/routes/rent units must be checked via the original post. Descriptions are truncated to the shown text; quote only text you can see.",
  },
} as const;

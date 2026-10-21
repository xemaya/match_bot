/** Catalogue-scene tools: verified suppliers, group supply pool and the group reply that names them. */
export const FIND_SUPPLIERS = {
  description:
    'Find up to 3 verified suppliers for the current demand. Returns id, name, price, contact and reasons. Call upsert_demand first.',
  feedback: {
    noDemand: 'no demand recorded yet; call upsert_demand first',
    none: 'no suppliers found for this demand',
  },
} as const;

export const FIND_PEER_SUPPLY = {
  description:
    'Find up to 3 peer offers from the group supply pool for the current demand. Call upsert_demand first.',
  feedback: {
    noDemand: 'no demand recorded yet; call upsert_demand first',
    notGroup: 'peer offers are only matched within a group',
    none: 'no peer supply found for this demand',
  },
} as const;

export const REPLY_IN_GROUP = {
  description:
    "SENDS a message into the Telegram group under the user's demand. Use only after find_suppliers returned candidates. Never invent suppliers.",
  params: {
    text: 'Reply in the same language as the demand, like a helpful group member: 1-3 short sentences naming 2-3 suppliers inline with rough price and contact. No numbered list, no headings, no URLs. Mention a concrete unknown only when it affects the choice; do not append a generic disclaimer.',
    supplierIds: 'IDs returned by find_suppliers. Never invent suppliers.',
  },
  feedback: {
    unknownSupplier:
      'Call find_suppliers again and use only the ids it returned: unknown supplier id.',
  },
} as const;

export const ASK_CLARIFICATION = {
  description:
    'SENDS a follow-up question into the Telegram group, as a reply that @mentions the user, asking for missing demand details. Ask exactly one question at a time. Do not write the @mention yourself.',
  params: {
    question: "One short question in the user's language.",
    missingFields: 'Demand fields still missing, e.g. ["whenAt", "toPostcode"].',
  },
} as const;

export const CLOSE_DEMAND = {
  description: "Close the user's open demand when they say it is solved or no longer needed.",
  results: { none: 'no open demand recorded', closed: 'demand closed' },
} as const;

export const REPLY_REQUEST_STATUS = {
  description:
    'SENDS one brief code-generated status; it asks only an already-planned, unanswered personal constraint. No recommendation, names, URLs or model text. Still respects phase, Jev availability and status policy.',
  feedback: {
    notAuthorized: 'Request status is not authorized or already answered',
  },
} as const;

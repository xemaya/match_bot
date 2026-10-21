export const RECORD_REQUEST = {
  description:
    'Record the selected task request for supplier matching, keeping other tasks separate. Provide only a short generic English topic, at most 60 characters, with no personal names/contacts. Category, budget, location and time come from the server-bound current task. This writes internal request data, never posts or contacts anyone.',
  feedback: {
    invalidInput:
      'Use valid JSON with one short need string, no timestamps or extra fields: the record_request input was invalid.',
    noRequest: 'no bound request',
    closed: 'task is already closed; do not record or search it again',
  },
  results: {
    taskRecorded: (category: string, id: string) =>
      'current task request recorded; category=' + category + ', id=' + id,
    recorded: (category: string, id: string) =>
      'current request recorded; category=' + category + ', id=' + id,
  },
} as const;

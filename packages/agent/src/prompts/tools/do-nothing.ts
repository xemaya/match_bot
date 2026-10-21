export const DO_NOTHING = {
  description:
    'Explicitly take no action for irrelevant chatter, acknowledgement, job recruitment or a declined gate. London daily-life, GP registration and airport advice ARE supported. A server-authorized same-task context addition may end quietly when nothing new would help; otherwise no match or unavailable source needs reply_to_request.',
  results: {
    supplementQuiet:
      'ok: no new helpful answer for this same-task context addition; stop without another reply or status',
    groupQuiet: 'ok: nothing useful to add to this group message; stop without a reply or status',
    actionable:
      'Use reply_to_request for an answer or an honest no-match/clarification/unavailable: this is an actionable current request, so do not silently stop.',
    ok: 'ok',
  },
} as const;

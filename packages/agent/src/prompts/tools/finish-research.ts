export const FINISH_RESEARCH = {
  description:
    'Ends research for this message and hands over to the writer, who alone talks to the group. Sends nothing. outcome=deliver: there is a useful full or partial answer in the collected evidence. outcome=no_answer: nothing usable was found. outcome=skip: a member already answered, or the message is not really asking anything. note: up to 200 characters for the writer only (which option is best supported, a source conflict, the one unknown that matters); never a draft of the reply.',
  params: {
    outcome: 'deliver | no_answer | skip',
    note: 'Writer-only research note, at most 200 characters; empty when there is nothing to add.',
  },
  results: {
    finished: (outcome: string) => `ok: research finished (${outcome}); the writer takes over`,
    skipRefused:
      'The member asked A2H directly, so this cannot be skipped: use deliver when there is anything useful, otherwise no_answer.',
  },
} as const;

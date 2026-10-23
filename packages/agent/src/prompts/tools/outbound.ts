/** Shared by every outbound tool (make-outbound-tool.ts) and the gate (outbound-gate.ts). */
export const OUTBOUND = {
  feedback: {
    claimsPresence:
      'A2H is an assistant account: it cannot join, come along, meet, lend, carry or help in person. Remove the line where A2H offers or wants to take part.',
    unsupportedAction:
      'Give a useful action the user can take now. No background monitoring, contact or booking was performed or scheduled, so remove the promise of later monitoring or the invented completed action.',
    retryLimit:
      'not sent: outbound input retry limit reached after three failed calls. Stop; do not retry.',
    invalidInput: (fields: string | undefined) =>
      `invalid tool input: ${fields ?? 'arguments do not match the tool schema'}. Correct the listed fields; do not repeat identical arguments.`,
    internalError: 'tool failed: internal error; stop rather than repeating this action',
    supplementEnded: 'not sent: this supplement intentionally ended without a new reply',
    alreadyDeclined:
      'not sent: this run was already declined by the outbound gate. Stop; do not retry.',
    gateDropped:
      'not sent: the outbound gate decided this should not be posted. Do not rewrite or retry; stop here.',
    missingContext: 'internal error: missing run context',
  },
  results: {
    dryRun: (id: string) => `dry-run recorded (${id}); nothing was sent`,
    queued: (id: string) => `queued (${id})`,
    alreadyConfirmed: (id: string) =>
      `not sent: this request already has a confirmed reply (${id})`,
    alreadyFailed: (id: string) =>
      `not sent: this request already has a failed or unconfirmed delivery (${id}); do not automatically resend`,
  },
} as const;

import { z } from 'zod';

/**
 * One round = what Match Bot actually said (or replayed) to a set of group asks, plus the group
 * members' own reply-style lines from the same window as the human reference. Members appear only
 * as hashed aliases; no Telegram ids, usernames or display names are stored.
 */
export const roundCaseSchema = z.object({
  id: z.string(),
  sourceMessageId: z.string().nullable(),
  asked: z.string(),
  askedAt: z.string().nullable(),
  authorAlias: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  /** Full stored reply text (chat line + marker + card). */
  text: z.string(),
  /** The chat line the group sees above the fold. */
  line: z.string(),
  /** The folded card body, null when the reply is the line alone. */
  card: z.string().nullable(),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  /** Replay only: how many drafts the tool sent back before this one was accepted. */
  rejectedDrafts: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type RoundCase = z.infer<typeof roundCaseSchema>;

export const humanLineSchema = z.object({
  alias: z.string(),
  at: z.string(),
  text: z.string(),
  /** Starts with @ or replies to someone: the lines that answer, not the asks. */
  replyLike: z.boolean(),
});
export type HumanLine = z.infer<typeof humanLineSchema>;

export const roundSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  generatedAt: z.string(),
  source: z.enum(['db', 'replay']),
  agentVersion: z.string().nullable(),
  window: z.object({ since: z.string(), until: z.string() }).nullable(),
  cases: z.array(roundCaseSchema),
  humans: z.array(humanLineSchema),
});
export type Round = z.infer<typeof roundSchema>;

/** Everything the finalization stage needs, frozen from one real run. The research packet is the
 * decrypted execution checkpoint (`researchContextSchema` in @matchbot/agent), stored as-is. */
export const caseFixtureSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  round: z.string(),
  frozenAt: z.string(),
  agentVersion: z.string(),
  sourceMessageId: z.string(),
  input: z.string(),
  askedAt: z.string(),
  userId: z.string(),
  chatId: z.string(),
  groupId: z.string().nullable(),
  phase: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  source: z.object({ messageId: z.string(), userId: z.string() }),
  addressedToBot: z.boolean(),
  task: z.unknown().nullable(),
  groupTranscript: z.array(z.object({ at: z.string(), speaker: z.string(), text: z.string() })),
  research: z.record(z.string(), z.unknown()),
  original: roundCaseSchema,
});
export type CaseFixture = z.infer<typeof caseFixtureSchema>;

export const judgeReportSchema = z.object({
  version: z.literal(1),
  round: z.string(),
  model: z.string(),
  seed: z.number().int(),
  judgedAt: z.string(),
  blind: z.object({
    n: z.number().int(),
    accuracy: z.number(),
    auc: z.number(),
    botMeanProbability: z.number(),
    humanMeanProbability: z.number(),
    items: z.array(
      z.object({
        key: z.string(),
        isBot: z.boolean(),
        text: z.string(),
        botProbability: z.number(),
        reason: z.string(),
      }),
    ),
  }),
  ratings: z.array(
    z.object({
      id: z.string(),
      score: z.number(),
      mainIssue: z.string(),
      reason: z.string(),
    }),
  ),
  meanScore: z.number(),
});
export type JudgeReport = z.infer<typeof judgeReportSchema>;

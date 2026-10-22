import { createHash } from 'node:crypto';
import type { PrismaClient } from '@matchbot/db';
import { splitEvidenceCard } from '@matchbot/domain';
import { extractLinks } from './metrics.js';
import type { HumanLine, Round, RoundCase } from './schema.js';

/** Same shape as the agent's group transcript alias: a short hash, never the id itself. */
export function alias(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 4);
}

export function toRoundCase(row: {
  id: string;
  kind: string;
  status: string;
  text: string;
  sourceMessageId: string | null;
  sourceMessage: { text: string; receivedAt: Date; userId: string } | null;
}): RoundCase {
  const { line, card } = splitEvidenceCard(row.text);
  return {
    id: row.id,
    sourceMessageId: row.sourceMessageId,
    asked: row.sourceMessage?.text ?? '',
    askedAt: row.sourceMessage?.receivedAt.toISOString() ?? null,
    authorAlias: row.sourceMessage ? alias(row.sourceMessage.userId) : null,
    kind: row.kind,
    status: row.status,
    text: row.text,
    line,
    card,
    links: extractLinks(card),
  };
}

export function isReplyLike(m: { text: string; replyToMessageId: string | null }): boolean {
  return m.text.trimStart().startsWith('@') || !!m.replyToMessageId;
}

/**
 * Read-only: Match Bot's replies in the window (sent and dry_run, no reactions) with the group
 * message each answered, and every member line from the same groups in the same window.
 */
export async function exportRound(p: {
  prisma: PrismaClient;
  name: string;
  since: Date;
  until: Date;
  agentVersion: string | null;
}): Promise<Round> {
  const rows = await p.prisma.outboundMessage.findMany({
    where: {
      createdAt: { gte: p.since, lt: p.until },
      status: { in: ['sent', 'dry_run'] },
      kind: { in: ['recommendation', 'clarification'] },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      kind: true,
      status: true,
      text: true,
      sourceMessageId: true,
      sourceMessage: { select: { text: true, receivedAt: true, userId: true, groupId: true } },
    },
  });
  const groupIds = [
    ...new Set(rows.map((r) => r.sourceMessage?.groupId).filter(Boolean)),
  ] as string[];
  const members = groupIds.length
    ? await p.prisma.message.findMany({
        where: {
          groupId: { in: groupIds },
          receivedAt: { gte: p.since, lt: p.until },
          externalId: { not: { startsWith: 'replay-' } },
        },
        orderBy: { receivedAt: 'asc' },
        select: { userId: true, text: true, receivedAt: true, replyToMessageId: true },
      })
    : [];
  const humans: HumanLine[] = members
    .filter((m) => m.text.trim())
    .map((m) => ({
      alias: alias(m.userId),
      at: m.receivedAt.toISOString(),
      text: m.text,
      replyLike: isReplyLike(m),
    }));
  return {
    version: 1,
    name: p.name,
    generatedAt: new Date().toISOString(),
    source: 'db',
    agentVersion: p.agentVersion,
    window: { since: p.since.toISOString(), until: p.until.toISOString() },
    cases: rows.map(toRoundCase),
    humans,
  };
}

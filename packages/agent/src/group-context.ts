import { hashText } from '@matchbot/shared';
import type { Repositories } from '@matchbot/db';
import { splitEvidenceCard } from '@matchbot/domain';
import type { MatchContext } from './context.js';

/**
 * One line of the recent public group conversation as the model sees it. Members are shown by a
 * stable alias derived from the internal user id, never by channel id or name (AGENTS.md §6).
 */
export interface GroupLine {
  at: string;
  speaker: string;
  text: string;
}

export const GROUP_TRANSCRIPT_LIMITS = {
  lines: 20,
  sinceHours: 6,
  lineChars: 220,
  totalChars: 4000,
} as const;

export const BOT_SPEAKER = 'A2H';
export const CURRENT_AUTHOR_SUFFIX = '（当前发言者）';

export function memberAlias(userId: string): string {
  return '成员' + hashText(userId).slice(0, 4);
}

function skim(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= GROUP_TRANSCRIPT_LIMITS.lineChars
    ? clean
    : clean.slice(0, GROUP_TRANSCRIPT_LIMITS.lineChars) + '…';
}

/**
 * Oldest first, bounded by lines and characters, excluding the message being processed (it is the
 * run input). The current author keeps a marker so the model can tell their own earlier messages
 * from other members' without learning any identity.
 */
export function buildGroupTranscript(p: {
  members: Array<{ id: string; userId: string; text: string; receivedAt: Date }>;
  bot: Array<{ id: string; text: string; sentAt: Date | null }>;
  currentMessageId: string;
  currentUserId: string;
}): GroupLine[] {
  const rows = [
    ...p.members
      .filter((m) => m.id !== p.currentMessageId && m.text.trim())
      .map((m) => ({
        at: m.receivedAt,
        speaker:
          memberAlias(m.userId) + (m.userId === p.currentUserId ? CURRENT_AUTHOR_SUFFIX : ''),
        text: m.text,
      })),
    // Only the chat line comes back; the folded card would otherwise teach the model its own template.
    ...p.bot
      .filter((b) => b.sentAt && b.text.trim())
      .map((b) => ({ at: b.sentAt!, speaker: BOT_SPEAKER, text: splitEvidenceCard(b.text).line })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const lines: GroupLine[] = [];
  let chars = 0;
  for (const row of rows) {
    const text = skim(row.text);
    if (lines.length >= GROUP_TRANSCRIPT_LIMITS.lines) break;
    if (chars + text.length > GROUP_TRANSCRIPT_LIMITS.totalChars) break;
    lines.push({ at: row.at.toISOString().slice(0, 16) + 'Z', speaker: row.speaker, text });
    chars += text.length;
  }
  return lines.reverse();
}

/**
 * Group messages only; private chats have the user session instead. With receivedAt, the transcript
 * is what the group looked like when this message arrived: later arrivals (a backlog, a replay) are
 * not context for it.
 */
export async function loadGroupTranscript(
  repos: Pick<Repositories, 'messages' | 'outbound'>,
  ctx: Pick<MatchContext, 'groupId' | 'chatId' | 'sourceMessageId' | 'userId'> & {
    receivedAt?: Date;
  },
): Promise<GroupLine[]> {
  if (!ctx.groupId) return [];
  const before = ctx.receivedAt ? { before: ctx.receivedAt } : {};
  // Sequential: execution-fenced repositories run inside one transaction per user.
  const members = await repos.messages.recentInGroup(ctx.groupId, {
    limit: GROUP_TRANSCRIPT_LIMITS.lines + 1,
    sinceHours: GROUP_TRANSCRIPT_LIMITS.sinceHours,
    ...before,
  });
  const bot = await repos.outbound.recentSentToTarget(ctx.chatId, {
    limit: GROUP_TRANSCRIPT_LIMITS.lines,
    sinceHours: GROUP_TRANSCRIPT_LIMITS.sinceHours,
    ...before,
  });
  return buildGroupTranscript({
    members,
    bot,
    currentMessageId: ctx.sourceMessageId,
    currentUserId: ctx.userId,
  });
}

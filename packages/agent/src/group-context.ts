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
  /** Server-only internal user id behind a member alias (P53 refer_member); never in the packet. */
  memberId?: string;
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
        memberId: m.userId,
      })),
    // Only the chat line comes back; the folded card would otherwise teach the model its own template.
    ...p.bot
      .filter((b) => b.sentAt && b.text.trim())
      .map((b) => ({
        at: b.sentAt!,
        speaker: BOT_SPEAKER,
        text: splitEvidenceCard(b.text).line,
        memberId: undefined as string | undefined,
      })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const lines: GroupLine[] = [];
  let chars = 0;
  for (const row of rows) {
    const text = skim(row.text);
    if (lines.length >= GROUP_TRANSCRIPT_LIMITS.lines) break;
    if (chars + text.length > GROUP_TRANSCRIPT_LIMITS.totalChars) break;
    lines.push({
      at: row.at.toISOString().slice(0, 16) + 'Z',
      speaker: row.speaker,
      text,
      ...(row.memberId ? { memberId: row.memberId } : {}),
    });
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

/**
 * P53: the rest of what a member would know about the group besides the last few lines — A2H's
 * own open threads with every member (not only the asker), and members' public offers that touch
 * the current request. Aliases only; built from data the pipeline already holds.
 */
export interface GroupView {
  myOpenThreads: Array<{ asker: string; objective: string; status: string; answered: boolean }>;
  peerOffers: Array<{ speaker: string; text: string }>;
  /** P54: notes about members from earlier public messages; memberId is server-only. */
  memberNotes: Array<{ member: string; kind: string; text: string; memberId: string }>;
}
export const GROUP_VIEW_LIMITS = {
  threads: 6,
  offers: 3,
  objectiveChars: 80,
  offerChars: 80,
  notes: 8,
  noteChars: 1200,
};
const OFFER_WORDS =
  /有多的|多一|可以借|借你|借给|我有|我这有|出一|转让|免费|送人|白送|空房|空出|我可以|我能|能帮|帮你|顺路|捎|拼车|一起去|有空/;

/** Overlap words: CJK bigrams and Latin words of three or more letters. */
function topicTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const run of text.match(/[一-鿿]+/g) ?? [])
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) tokens.add(word);
  return tokens;
}

export function selectPeerOffers(
  transcript: GroupLine[],
  topic: string,
  currentUserId: string,
): GroupView['peerOffers'] {
  const wanted = topicTokens(topic);
  return transcript
    .filter(
      (l) =>
        l.memberId &&
        l.memberId !== currentUserId &&
        OFFER_WORDS.test(l.text) &&
        [...topicTokens(l.text)].some((t) => wanted.has(t)),
    )
    .slice(-GROUP_VIEW_LIMITS.offers)
    .map((l) => ({ speaker: l.speaker, text: l.text.slice(0, GROUP_VIEW_LIMITS.offerChars) }));
}

/** The asker's own notes first, then other members' notes that touch the current topic. */
export function selectMemberNotes(
  notes: Array<{ userId: string; kind: string; text: string }>,
  topic: string,
  currentUserId: string,
): GroupView['memberNotes'] {
  const wanted = topicTokens(topic);
  const own = notes.filter((n) => n.userId === currentUserId);
  const related = notes.filter(
    (n) => n.userId !== currentUserId && [...topicTokens(n.text)].some((t) => wanted.has(t)),
  );
  const picked: GroupView['memberNotes'] = [];
  let chars = 0;
  for (const n of [...own, ...related]) {
    if (
      picked.length >= GROUP_VIEW_LIMITS.notes ||
      chars + n.text.length > GROUP_VIEW_LIMITS.noteChars
    )
      break;
    picked.push({
      member: memberAlias(n.userId) + (n.userId === currentUserId ? CURRENT_AUTHOR_SUFFIX : ''),
      kind: n.kind,
      text: n.text,
      memberId: n.userId,
    });
    chars += n.text.length;
  }
  return picked;
}

export async function buildGroupView(
  repos: Pick<Repositories, 'tasks' | 'memberNotes'>,
  ctx: Pick<
    MatchContext,
    'channel' | 'chatId' | 'userId' | 'groupId' | 'groupTranscript' | 'currentRequest' | 'task'
  >,
): Promise<GroupView | undefined> {
  if (!ctx.groupId) return undefined;
  const tasks = await repos.tasks.findOpenInChat({
    channel: ctx.channel ?? 'telegram',
    chatId: ctx.chatId,
    limit: GROUP_VIEW_LIMITS.threads,
  });
  const topic = [ctx.currentRequest?.text ?? '', ctx.task?.objective ?? ''].join(' ');
  const notes = await repos.memberNotes.listForGroup({ groupId: ctx.groupId, limit: 60 });
  return {
    myOpenThreads: tasks.map((t) => ({
      asker:
        memberAlias(t.ownerUserId) + (t.ownerUserId === ctx.userId ? CURRENT_AUTHOR_SUFFIX : ''),
      objective: t.objective.slice(0, GROUP_VIEW_LIMITS.objectiveChars),
      status: t.status,
      answered: t.delivery.status !== 'none',
    })),
    peerOffers: selectPeerOffers(ctx.groupTranscript ?? [], topic, ctx.userId),
    memberNotes: selectMemberNotes(notes, topic, ctx.userId),
  };
}

/**
 * P53 freshness: what was said in the group (by members or by A2H in other runs) after this run
 * started. Shown to the main agent before every model call, so a reply written after a minute of
 * research still sees that someone already answered or the asker said it is sorted.
 */
export async function freshGroupLines(
  repos: Pick<Repositories, 'messages' | 'outbound'>,
  ctx: Pick<MatchContext, 'groupId' | 'chatId' | 'sourceMessageId' | 'userId'> & { since: Date },
): Promise<GroupLine[]> {
  if (!ctx.groupId) return [];
  const members = await repos.messages.createdInGroupSince(ctx.groupId, {
    since: ctx.since,
    limit: 10,
  });
  const bot = await repos.outbound.createdForTargetSince(ctx.chatId, {
    since: ctx.since,
    limit: 10,
  });
  return [
    ...members
      .filter((m) => m.id !== ctx.sourceMessageId)
      .map((m) => ({
        at: m.receivedAt.toISOString().slice(0, 16) + 'Z',
        speaker: memberAlias(m.userId) + (m.userId === ctx.userId ? CURRENT_AUTHOR_SUFFIX : ''),
        text: skim(m.text),
        memberId: m.userId,
      })),
    ...bot
      .filter((b) => b.sourceMessageId !== ctx.sourceMessageId)
      .map((b) => ({ at: '', speaker: BOT_SPEAKER, text: skim(splitEvidenceCard(b.text).line) })),
  ];
}

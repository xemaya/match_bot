import { Agent, Runner, tool } from '@openai/agents';
import { MEMBER_NOTE_KINDS } from '@matchbot/db';
import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { BOT_SPEAKER, memberAlias } from '../group-context.js';
import { TRUST_RULES } from '../prompts/policy/rules.js';

/**
 * P54 notetaker: a background pass over what members said in public in one group, kept as short
 * third-person notes the main agent can read later ("有多的羽毛球拍", "住 Mile End"). Runs from the
 * cron, never in a reply's hot path. Only group messages; code checks every note against its
 * source line and strips contact details before anything is stored.
 */
export const NOTETAKER_LIMITS = { lines: 30, notes: 60, noteChars: 120 } as const;

const NOTETAKER_INSTRUCTIONS = [
  TRUST_RULES,
  'NOTETAKER: You keep short notes about what members of a London students group said in public, so the group assistant remembers who offered what, who needs what and where people are. Write each note as a short third-person phrase in the member’s language, using only what the source line says. Kinds: offer (something they can give, lend, share or help with), need (something they are looking for), context (a public fact about their situation such as area or move-out date), resolved (an earlier need or offer is done or withdrawn). Skip chit-chat, jokes, greetings and anything about other people. Never copy phone numbers, emails, handles, door numbers or full postcodes. Mark existing notes as superseded when a new line replaces or resolves them. Call record_member_notes exactly once; an empty list is fine.',
].join('\n');

const NOTE_ID = /^n\d+$/;
const LINE_ID = /^l\d+$/;
/** Contact details and exact addresses never go into a note (AGENTS.md §6 / §3.3 rule 11). */
const PII =
  /\+?\d[\d\s-]{7,}\d|[\w.+-]+@[\w-]+\.[\w.]+|@\w{3,}|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\d+\s*(?:号|室|flat|Flat)/;

function cjkBigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(/[一-鿿]+/g) ?? [])
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) out.add(w);
  return out;
}
/** A note must share words with its source line; a note with no overlap was not "said". */
export function noteIsGrounded(note: string, source: string): boolean {
  const src = cjkBigrams(source);
  return [...cjkBigrams(note)].some((t) => src.has(t));
}

export async function consolidateGroupMemory(
  deps: AgentDeps,
  p: { groupId: string; since: Date | null; until?: Date },
): Promise<{ added: number; superseded: number; rejected: number }> {
  const startedAt = new Date();
  // `until` lets an offline replay stop at the end of a recorded window.
  const messages = (
    await deps.repos.messages.createdInGroupSince(p.groupId, {
      since: p.since ?? new Date(0),
      limit: NOTETAKER_LIMITS.lines,
    })
  ).filter((m) => m.text.trim() && (!p.until || m.createdAt <= p.until));
  if (!messages.length) {
    await deps.repos.groups.markMemoryConsolidated(p.groupId, startedAt);
    return { added: 0, superseded: 0, rejected: 0 };
  }
  const existing = await deps.repos.memberNotes.listForGroup({
    groupId: p.groupId,
    limit: NOTETAKER_LIMITS.notes,
  });
  const lines = messages.map((m, i) => ({
    ref: 'l' + (i + 1),
    speaker: memberAlias(m.userId),
    text: m.text.slice(0, 300),
    message: m,
  }));
  const notes = existing.map((n, i) => ({
    ref: 'n' + (i + 1),
    member: memberAlias(n.userId),
    kind: n.kind,
    text: n.text,
    note: n,
  }));
  let recorded:
    | {
        add: Array<{ line: string; kind: (typeof MEMBER_NOTE_KINDS)[number]; text: string }>;
        supersede: string[];
      }
    | undefined;
  const record = tool({
    name: 'record_member_notes',
    description:
      'Record new notes (each tied to one source line) and the existing notes they replace.',
    parameters: z.object({
      add: z
        .array(
          z.object({
            line: z.string().regex(LINE_ID),
            kind: z.enum(MEMBER_NOTE_KINDS),
            text: z.string().min(1).max(NOTETAKER_LIMITS.noteChars),
          }),
        )
        .max(20),
      supersede: z.array(z.string().regex(NOTE_ID)).max(20),
    }),
    needsApproval: false,
    execute: (args) => {
      recorded = args;
      return 'recorded';
    },
  });
  const agent = new Agent({
    name: 'notetaker',
    model: deps.env.MEMORY_MODEL ?? deps.env.DEEPSEEK_MODEL,
    instructions: NOTETAKER_INSTRUCTIONS,
    tools: [record],
    toolUseBehavior: 'stop_on_first_tool',
    modelSettings: {
      toolChoice: 'required',
      // A reasoning model spends output on thinking before the tool call; 1500 truncated the first
      // replay pass (2026-10-23), the same failure triage hit at 300.
      maxTokens: 4000,
      ...(deps.env.DEEPSEEK_MODEL === 'deepseek-flash'
        ? { temperature: 0, providerData: { thinking: { type: 'disabled' } } }
        : {}),
      ...(deps.env.GENERATION_REASONING_EFFORT
        ? { reasoning: { effort: deps.env.GENERATION_REASONING_EFFORT } }
        : {}),
    },
  });
  const runner = new Runner({
    traceIncludeSensitiveData: false,
    traceMetadata: {
      model: deps.env.DEEPSEEK_MODEL,
      promptStage: 'notetaker',
      inputRef: p.groupId,
    },
    ...(deps.modelProvider ? { modelProvider: deps.modelProvider } : {}),
  });
  const input = JSON.stringify({
    kind: 'matchbot_notetaker_input',
    lines: lines
      .filter((l) => l.speaker !== BOT_SPEAKER)
      .map(({ ref, speaker, text }) => ({ ref, speaker, text })),
    existingNotes: notes.map(({ ref, member, kind, text }) => ({ ref, member, kind, text })),
  });
  await runner.run(agent, input, { maxTurns: 2, signal: AbortSignal.timeout(60000) });
  let added = 0,
    rejected = 0;
  for (const n of recorded?.add ?? []) {
    const line = lines.find((l) => l.ref === n.line);
    const text = n.text.trim();
    if (!line || PII.test(text) || !noteIsGrounded(text, line.text)) {
      rejected++;
      continue;
    }
    await deps.repos.memberNotes.add({
      groupId: p.groupId,
      userId: line.message.userId,
      kind: n.kind,
      text,
      sourceMessageId: line.message.id,
    });
    added++;
  }
  const supersedeIds = (recorded?.supersede ?? []).flatMap((ref) => {
    const n = notes.find((x) => x.ref === ref);
    return n ? [n.note.id] : [];
  });
  const superseded = await deps.repos.memberNotes.supersede(p.groupId, supersedeIds);
  const last = messages[messages.length - 1]!.createdAt;
  await deps.repos.groups.markMemoryConsolidated(p.groupId, last);
  // Note text is personal data: traces carry counts only.
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: p.groupId,
    phase: 0,
    latencyMs: Date.now() - startedAt.getTime(),
    costMicro: 0,
    output: { gate: 'memory_consolidate', lines: lines.length, added, superseded, rejected },
  });
  return { added, superseded, rejected };
}

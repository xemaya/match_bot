/**
 * A reply to a group member is two products: the chat line the asker reads, and an evidence card
 * (supporting detail, offer blocks, source links) the channel folds under it. The card starts at a
 * marker line holding only U+2063 (INVISIBLE SEPARATOR): the channel recognises the line to fold
 * everything after it and does not send the marker itself. No visible label: a folded quote is its
 * own cue, and a "details" heading reads like a form field (P49).
 */
export const EVIDENCE_CARD_MARKER = '\u2063';

/** Visible headers written before P49; still recognised so stored replies split the same way. */
const LEGACY_HEADERS: ReadonlySet<string> = new Set(['【详情】', '[Details]']);

export function isEvidenceCardHeader(line: string): boolean {
  return line === EVIDENCE_CARD_MARKER || LEGACY_HEADERS.has(line);
}

/** Empty when nothing supports the chat line; the reply is then just the line. */
export function renderEvidenceCard(p: {
  sections: ReadonlyArray<string | null | undefined>;
}): string {
  const body = p.sections
    .map((section) => section?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
  if (!body) return '';
  return '\n\n' + EVIDENCE_CARD_MARKER + '\n' + body;
}

/** Splits a rendered reply into its chat line and (optional) card body, without the marker line. */
export function splitEvidenceCard(text: string): { line: string; card: string | null } {
  const lines = text.split('\n');
  const index = lines.findIndex(isEvidenceCardHeader);
  if (index < 0) return { line: text, card: null };
  return {
    line: lines.slice(0, index).join('\n').trimEnd(),
    card: lines.slice(index + 1).join('\n'),
  };
}

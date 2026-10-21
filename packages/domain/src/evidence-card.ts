/**
 * A reply to a group member is two products: the chat line the asker reads, and an evidence card
 * (supporting detail, offer blocks, source links) the channel folds under it. The card starts at
 * this header line; the channel layer recognises the header to collapse everything after it.
 */
export const EVIDENCE_CARD_HEADER = { zh: '【详情】', en: '[Details]' } as const;

export function isEvidenceCardHeader(line: string): boolean {
  return line === EVIDENCE_CARD_HEADER.zh || line === EVIDENCE_CARD_HEADER.en;
}

/** Empty when nothing supports the chat line; the reply is then just the line. */
export function renderEvidenceCard(p: {
  zh: boolean;
  sections: ReadonlyArray<string | null | undefined>;
}): string {
  const body = p.sections
    .map((section) => section?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
  if (!body) return '';
  return '\n\n' + (p.zh ? EVIDENCE_CARD_HEADER.zh : EVIDENCE_CARD_HEADER.en) + '\n' + body;
}

/** Splits a rendered reply back into its chat line and (optional) card, by the header line. */
export function splitEvidenceCard(text: string): { line: string; card: string | null } {
  const lines = text.split('\n');
  const index = lines.findIndex(isEvidenceCardHeader);
  if (index < 0) return { line: text, card: null };
  return {
    line: lines.slice(0, index).join('\n').trimEnd(),
    card: lines.slice(index).join('\n'),
  };
}

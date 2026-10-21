import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Voice is the only layer written for the reader of the group message rather than for the model's
 * control flow, so it lives as Chinese prose in packages/agent/prompts/voice and is loaded whole.
 * src/ and dist/ sit at the same depth under the package root. A missing or empty file fails
 * startup instead of silently testing a prompt without the voice.
 */
const prose = z.string().trim().min(1).max(4000);
function load(name: string): string {
  return prose.parse(readFileSync(new URL(`../../prompts/voice/${name}`, import.meta.url), 'utf8'));
}

/** 气质：怎么待人。 */
export const SOUL = load('soul.md');
/** 群聊发言规范：那句话和证据卡各写什么、多长。 */
export const CHAT_LINE = load('chat-line.md');

/** The write-facing stages inject the voice last, nearest to generation. */
export function voiceLayer(): string {
  return [SOUL, CHAT_LINE].join('\n\n');
}

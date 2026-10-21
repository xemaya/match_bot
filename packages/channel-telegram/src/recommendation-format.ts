import { EVIDENCE_CARD_MARKER, isEvidenceCardHeader } from '@matchbot/domain';
import type { MessageEntity } from 'grammy/types';

const LINK = /\[([^\]\n]+)\]\((https:\/\/[^\s()]+)\)/g;
const LINK_ONLY_LINE =
  /^(?:\[[^\]\n]+\]\(https:\/\/[^\s()]+\))(?:\s·\s\[[^\]\n]+\]\(https:\/\/[^\s()]+\))*$/;

function safeUrl(url: string, label: string, inCard: boolean): boolean {
  const parsed = new URL(url);
  const knownPlatform =
    /^https:\/\/(?:www\.xiaohongshu\.com\/(?:explore|discovery\/item)\/[\w-]+(?:\?[^\s()]+)?|a2hmarket\.ai\/listings\/[\w-]+)$/.test(
      url,
    );
  const privateHost =
    /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(
      parsed.hostname,
    );
  const publicSource =
    (inCard || /^\d+\. /.test(label)) && !parsed.username && !parsed.password && !privateHost;
  return knownPlatform || publicSource;
}

/**
 * P14：只识别代码生成的来源行；来源正文中的任意 Markdown 不执行。
 * P48/P49：证据卡从不可见分隔行（U+2063）起折叠成 expandable_blockquote，分隔行本身不发出；
 * 卡内整行由链接组成的行渲染为 text_link（草稿里手写的 URL 已被工具退回，卡内链接只来自代码）。
 * 旧的"来源："行与编号标签照旧识别。
 */
export function formatRecommendation(
  text: string,
  kind: string,
): { text: string; entities?: MessageEntity[] } {
  if (kind !== 'recommendation') return { text };
  const entities: MessageEntity[] = [];
  let rendered = '';
  let cardOffset: number | undefined;
  for (const line of text.split('\n')) {
    const offset = rendered.length;
    if (cardOffset === undefined && isEvidenceCardHeader(line)) {
      cardOffset = offset;
      if (line === EVIDENCE_CARD_MARKER) continue;
    }
    const inCard = cardOffset !== undefined;
    if (/^(来源：|Source: )/.test(line) || (inCard && LINK_ONLY_LINE.test(line))) {
      let cursor = 0;
      for (const match of line.matchAll(LINK)) {
        const label = match[1],
          url = match[2];
        if (!label || !url || !safeUrl(url, label, inCard)) continue;
        rendered += line.slice(cursor, match.index);
        entities.push({ type: 'text_link', offset: rendered.length, length: label.length, url });
        rendered += label;
        cursor = match.index + match[0].length;
      }
      rendered += line.slice(cursor);
    } else {
      rendered += line;
      if (/^[1-6]\. \S/.test(line) || /^【[^\n【】]+】$/.test(line))
        entities.push({ type: 'bold', offset, length: line.length });
    }
    rendered += '\n';
  }
  const body = rendered.slice(0, -1);
  if (cardOffset !== undefined && body.length > cardOffset)
    entities.push({
      type: 'expandable_blockquote',
      offset: cardOffset,
      length: body.length - cardOffset,
    });
  return { text: body, ...(entities.length ? { entities } : {}) };
}

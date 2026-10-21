import { isEvidenceCardHeader } from '@matchbot/domain';
import type { MessageEntity } from 'grammy/types';

/**
 * P14：只识别代码生成的标题/分类与来源行；来源正文中的任意 Markdown 不执行。
 * P48：从证据卡标题行（【详情】）起到结尾折叠成 expandable_blockquote，群友先看到上面那句话，
 * 点开才看细节和来源；卡内的来源链接仍是 text_link。
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
    if (cardOffset === undefined && isEvidenceCardHeader(line)) cardOffset = offset;
    if (/^(来源：|Source: )/.test(line)) {
      const pattern = /\[([^\]\n]+)\]\((https:\/\/[^\s()]+)\)/g;
      let cursor = 0;
      for (const match of line.matchAll(pattern)) {
        const label = match[1],
          url = match[2];
        if (!label || !url) continue;
        const parsed = new URL(url);
        const knownPlatform =
          /^https:\/\/(?:www\.xiaohongshu\.com\/(?:explore|discovery\/item)\/[\w-]+(?:\?[^\s()]+)?|a2hmarket\.ai\/listings\/[\w-]+)$/.test(
            url,
          );
        const publicSource =
          /^\d+\. /.test(label) &&
          !parsed.username &&
          !parsed.password &&
          !/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(
            parsed.hostname,
          );
        if (!knownPlatform && !publicSource) continue;
        rendered += line.slice(cursor, match.index);
        entities.push({ type: 'text_link', offset: rendered.length, length: label.length, url });
        rendered += label;
        cursor = match.index + match[0].length;
      }
      rendered += line.slice(cursor);
    } else {
      rendered += line;
      if (/^[1-6]\. \S/.test(line) || /^【[^\n【】]+】$/.test(line) || isEvidenceCardHeader(line))
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

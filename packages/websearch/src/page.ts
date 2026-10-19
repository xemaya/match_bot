import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIPv4 } from 'node:net';
import { z } from 'zod';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix);

/** IPv4-only transport deliberately fails closed for IPv6-only/private destinations. */
export function isPublicAddress(address: string): boolean {
  return isIPv4(address) && !blocked.check(address);
}
function publicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new Error('unsupported_url');
  url.hash = '';
  return url;
}
const inputSchema = z.object({
  url: z.string().url().max(2048),
  find: z.string().max(120).optional(),
  offset: z.number().int().min(0).max(120000).optional(),
});
const responseSchema = z.object({
  status: z.number().int(),
  type: z.string(),
  body: z.string().max(1048576),
  location: z.string().optional(),
});
export type PageResponse = z.infer<typeof responseSchema>;
export type PageResult =
  | {
      status: 'ok';
      url: string;
      title: string;
      text: string;
      links: Array<{ text: string; url: string }>;
      nextOffset: number | null;
      truncated: boolean;
      found: boolean;
    }
  | { status: 'unavailable'; reason: string; httpStatus?: number };
export type PageReader = (input: z.infer<typeof inputSchema>) => Promise<PageResult>;

/** DNS address is checked before every redirect and pinned into the TLS connection. */
export function createPageReader(
  options: {
    dnsMode?: 'system' | 'https';
    resolve?: (host: string) => Promise<string[]>;
    request?: (url: URL, address: string, signal: AbortSignal) => Promise<PageResponse>;
  } = {},
): PageReader {
  const resolve =
    options.resolve ??
    (options.dnsMode === 'https'
      ? resolvePublicDns
      : async (host: string) =>
          (await lookup(host, { all: true, family: 4 })).map((row) => row.address));
  const request = options.request ?? requestPage;
  return async (raw) => {
    let httpStatus: number | undefined;
    try {
      const input = inputSchema.parse(raw),
        signal = AbortSignal.timeout(12000);
      let url = publicUrl(input.url);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const addresses = await bounded(resolve(url.hostname), signal);
        if (!addresses.length || addresses.some((address) => !isPublicAddress(address)))
          throw new Error('non_public_destination');
        const response = responseSchema.parse(
          await bounded(request(url, addresses[0]!, signal), signal),
        );
        httpStatus = response.status;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.location) throw new Error('invalid_redirect');
          url = publicUrl(new URL(response.location, url).href);
          continue;
        }
        if (response.status !== 200 || !/^text\/(html|plain)(?:;|$)/i.test(response.type))
          throw new Error('unsupported_response');
        const page = response.type.startsWith('text/plain')
          ? { title: url.hostname, text: response.body, links: [] }
          : parsePage(response.body, url);
        const foundAt = input.find ? page.text.toLowerCase().indexOf(input.find.toLowerCase()) : -1;
        const offset = input.offset ?? (foundAt < 0 ? 0 : Math.max(0, foundAt - 800));
        const text = page.text.slice(offset, offset + 5000);
        if (!text.trim()) throw new Error('empty_page');
        return {
          status: 'ok',
          url: url.href,
          title: page.title,
          text,
          links: page.links,
          nextOffset: offset + 5000 < page.text.length ? offset + 5000 : null,
          truncated: page.text.length > 5000,
          found: !input.find || foundAt >= 0,
        };
      }
      throw new Error('redirect_limit');
    } catch (error) {
      return {
        status: 'unavailable',
        ...(httpStatus === undefined ? {} : { httpStatus }),
        reason:
          error instanceof Error &&
          [
            'non_public_destination',
            'unsupported_url',
            'unsupported_response',
            'empty_page',
            'redirect_limit',
          ].includes(error.message)
            ? error.message
            : 'read_failed',
      };
    }
  };
}

/** Explicit opt-in for hosts whose VPN supplies synthetic DNS addresses; never trust those addresses. */
async function resolvePublicDns(host: string): Promise<string[]> {
  if (isIPv4(host)) return [host];
  const endpoint = new URL('https://dns.google/resolve');
  endpoint.searchParams.set('name', host);
  endpoint.searchParams.set('type', 'A');
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('dns_unavailable');
  const body = z
    .object({
      Status: z.literal(0),
      Answer: z
        .array(z.object({ type: z.number(), data: z.string() }))
        .max(50)
        .optional(),
    })
    .parse(await response.json());
  return (body.Answer ?? []).filter((record) => record.type === 1).map((record) => record.data);
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('page_timeout'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function requestPage(url: URL, address: string, signal: AbortSignal): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        family: 4,
        lookup: (_host, options, callback) =>
          options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
        headers: {
          'user-agent': 'MatchBot-PublicResearch/1.0',
          accept: 'text/html,text/plain',
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1048576) res.destroy(new Error('page_too_large'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers['content-type'] ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
            ...(res.headers.location ? { location: res.headers.location } : {}),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function decode(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|pound);/gi,
    (match, entity: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        pound: '£',
      };
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
      const n =
        entity[1]?.toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    },
  );
}
export function parsePage(
  html: string,
  url: URL,
): { title: string; text: string; links: Array<{ text: string; url: string }> } {
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const plain = (value: string) =>
    decode(value.replace(/<[^>]*>/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .trim();
  const title = plain(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(visible)?.[1] ?? url.hostname,
  ).slice(0, 300);
  const links: Array<{ text: string; url: string }> = [];
  for (const match of visible.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    try {
      const target = publicUrl(new URL(decode(match[1]!), url).href).href;
      if (target.length <= 2048 && !links.some((link) => link.url === target))
        links.push({ text: plain(match[2]!).slice(0, 160), url: target });
    } catch {
      /* Unsupported links are not navigation capabilities. */
    }
    if (links.length >= 80) break;
  }
  return {
    title,
    text: plain(visible.replace(/<\/(?:p|div|h[1-6]|li|tr|section)>|<br\s*\/?\s*>/gi, '\n')).slice(
      0,
      120000,
    ),
    links,
  };
}

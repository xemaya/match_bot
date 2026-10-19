import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { UnsafeQueryError, type SearchCandidate } from '@matchbot/websearch';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import {
  renderCandidates,
  replyWithSearchResultsTool,
} from '../../src/tools/reply-with-search-results.js';
import { webSearchTool } from '../../src/tools/web-search.js';

const CAKE: SearchCandidate = {
  ref: 'w1',
  name: "Polly Chan's Bakehouse",
  url: 'https://www.pollychan.co.uk/',
  contact: { whatsapp: '07700900123' },
  evidence: 'contact_on_own_site',
};
const IG: SearchCandidate = {
  ref: 'w2',
  name: 'Chinatown Bakery',
  url: 'https://www.instagram.com/chinatown.bakery/',
  contact: { instagram: 'chinatown.bakery' },
  evidence: 'instagram_profile',
};

function deps(found: SearchCandidate[] = [CAKE, IG]) {
  return {
    env: { OUTBOUND_UNSURE_ACTION: 'drop' },
    repos: {
      traces: { create: vi.fn(() => Promise.resolve({})) },
      outbound: {
        create: vi.fn((d: unknown, status: string) =>
          Promise.resolve({ id: 'om', status, ...(d as object) }),
        ),
        countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
      },
    },
    webSearch: { find: vi.fn(() => Promise.resolve(found)) },
    thresholds: DEFAULT_THRESHOLDS,
    evaluateOutbound: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}
const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  userId: 'u1',
  chatId: '-1',
  groupId: 'g',
  phase: 0,
  recentReplies: [],
  sourceMessageId: 'm1',
  source: { messageId: '77', userId: '42' },
  demand: { category: 'other', need: 'Chinese birthday cake', confidence: 0.9, lang: 'zh' },
  ...over,
});
const rc = (c: MatchContext) => ({ context: c }) as never;

describe('web_search', () => {
  it('refuses when our own catalogue has not been tried for a service category', async () => {
    const d = deps();
    const c = ctx({ demand: { category: 'man_and_van', confidence: 0.9 } });
    const out = await webSearchTool(d as never).invoke(
      rc(c),
      JSON.stringify({ need: 'van', area: null }),
    );
    expect(out).toContain('not allowed');
    expect(d.webSearch.find).not.toHaveBeenCalled();
  });

  it('is allowed for a service category once find_suppliers came back empty', async () => {
    const d = deps();
    const c = ctx({
      demand: { category: 'man_and_van', confidence: 0.9 },
      supplierSearchEmpty: true,
    });
    await webSearchTool(d as never).invoke(
      rc(c),
      JSON.stringify({ need: 'man and van', area: 'E14' }),
    );
    expect(d.webSearch.find).toHaveBeenCalledWith({ need: 'man and van', area: 'E14' });
  });

  it('returns structured fields only, stores candidates, and traces the hosts', async () => {
    const d = deps();
    const c = ctx();
    const out = await webSearchTool(d as never).invoke(
      rc(c),
      JSON.stringify({ need: 'Chinese birthday cake', area: null }),
    );
    expect(JSON.parse(out)).toEqual([
      {
        ref: 'w1',
        name: "Polly Chan's Bakehouse",
        contact: ['whatsapp'],
        source: 'contact_on_own_site',
      },
      { ref: 'w2', name: 'Chinatown Bakery', contact: ['instagram'], source: 'instagram_profile' },
    ]);
    expect(c.searchResults).toHaveLength(2);
    const [trace] = d.repos.traces.create.mock.calls[0] as unknown as [
      { output: { gate: string } },
    ];
    expect(trace.output.gate).toBe('web_search');
  });

  it('searches at most once per run', async () => {
    const d = deps();
    const c = ctx();
    const t = webSearchTool(d as never);
    await t.invoke(rc(c), JSON.stringify({ need: 'cake', area: null }));
    const again = await t.invoke(rc(c), JSON.stringify({ need: 'bakery', area: null }));
    expect(again).toContain('already searched');
    expect(d.webSearch.find).toHaveBeenCalledTimes(1);
  });

  it('turns an unsafe query into an instruction for the model, not a crash', async () => {
    const d = deps();
    d.webSearch.find.mockRejectedValueOnce(new UnsafeQueryError('need contains a number'));
    const out = await webSearchTool(d as never).invoke(
      rc(ctx()),
      JSON.stringify({ need: 'cake', area: null }),
    );
    expect(out).toContain('Rewrite "need"');
  });
});

describe('reply_with_search_results', () => {
  it('lists the businesses itself, preserves the contacts without a generic footer, and addresses the asker', async () => {
    const d = deps();
    const c = ctx({ searchResults: [CAKE, IG] });
    await replyWithSearchResultsTool(d as never).invoke(
      rc(c),
      JSON.stringify({ intro: '可以看看这两家：', refs: ['w1', 'w2'] }),
    );
    const [row, status] = d.repos.outbound.create.mock.calls[0] as unknown as [
      { text: string; kind: string; mentionUserId: string; replyToMessageId: string },
      string,
    ];
    expect(status).toBe('dry_run');
    expect(row.kind).toBe('recommendation');
    expect(row).toMatchObject({ mentionUserId: '42', replyToMessageId: '77' });
    expect(row.text).toBe(
      "可以看看这两家：\nPolly Chan's Bakehouse（WhatsApp 07700900123）、Chinatown Bakery（instagram.com/chinatown.bakery）",
    );
    // Instagram 不能写成 @handle：Telegram 会把它渲染成同名 Telegram 用户的链接
    expect(row.text).not.toMatch(/@chinatown/);
  });

  it('rejects refs that web_search did not return', async () => {
    const d = deps();
    const out = await replyWithSearchResultsTool(d as never).invoke(
      rc(ctx({ searchResults: [CAKE] })),
      JSON.stringify({ intro: 'x', refs: ['w9'] }),
    );
    expect(out).toContain('unknown ref');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });

  it('renders at most two contacts per business, inline, in the reply language', () => {
    const all = {
      ...CAKE,
      contact: { phone: '02079460000', whatsapp: '07700900123', instagram: 'polly' },
    };
    expect(renderCandidates([all], true)).toBe(
      "Polly Chan's Bakehouse（☎ 02079460000，WhatsApp 07700900123）",
    );
    expect(renderCandidates([all, IG], false)).toBe(
      "Polly Chan's Bakehouse (☎ 02079460000, WhatsApp 07700900123); Chinatown Bakery (instagram.com/chinatown.bakery)",
    );
  });
});

describe('after the outbound gate declines', () => {
  it('refuses any further draft in the same run without asking the gate again', async () => {
    const d = {
      ...deps(),
      evaluateOutbound: vi.fn(() =>
        Promise.resolve({ ok: true, worthReplying: 0.5, languageOk: 0.9, mentionsUnverified: 0 }),
      ),
    };
    const c = ctx({ phase: 2, searchResults: [CAKE] });
    const t = replyWithSearchResultsTool(d as never);
    const first = await t.invoke(rc(c), JSON.stringify({ intro: 'a', refs: ['w1'] }));
    expect(first).toContain('Do not rewrite or retry');
    expect(c.outboundBlocked).toBe(true);
    const second = await t.invoke(rc(c), JSON.stringify({ intro: 'rewritten', refs: ['w1'] }));
    expect(second).toContain('already declined');
    expect(d.evaluateOutbound).toHaveBeenCalledTimes(1);
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

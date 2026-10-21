import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import type { MarketListing } from '@matchbot/websearch';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { marketSearchTool } from '../../src/tools/market-search.js';
import { marketEnrichTool } from '../../src/tools/market-enrich.js';
import { replyWithMarketResultsTool } from '../../src/tools/reply-with-market-results.js';
const POT: MarketListing = {
  id: 'listing_a',
  title: '伦敦 小绿锅',
  description: '小绿锅成色新，Camberwell 自提。',
  tags: ['物品交易'],
  tradeType: 'SELL',
  status: 'ON_SALE',
  url: 'https://a2hmarket.ai/listings/listing_a',
  sourceUrl: 'https://www.xiaohongshu.com/discovery/item/n1?xsec_token=tok',
  isRepost: true,
  priceLabel: '帖内报价范围：£5–£80（单品价格需确认）',
  availableFrom: null,
  availableUntil: null,
  sourcePublishedAt: '2026-09-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
};
const deps = () => ({
  env: { OUTBOUND_UNSURE_ACTION: 'review' },
  repos: {
    traces: { create: vi.fn(() => Promise.resolve({})) },
    outbound: {
      create: vi.fn((draft: unknown, status: string) =>
        Promise.resolve({ id: 'out', status, ...(draft as object) }),
      ),
      countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
    },
  },
  marketSearch: {
    find: vi.fn(() => Promise.resolve({ items: [POT], hasNext: true, total: 50 })),
    detail: vi.fn(() => Promise.resolve(POT)),
  },
  jev: { evaluate: vi.fn() },
  evaluateOutbound: vi.fn(() =>
    Promise.resolve({ ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 }),
  ),
  thresholds: DEFAULT_THRESHOLDS,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  userId: 'u',
  chatId: '-1',
  groupId: 'g',
  phase: 0,
  sourceMessageId: 'm',
  source: { userId: '42', messageId: '77' },
  recentReplies: [],
  demand: { category: 'second_hand', confidence: 0.95, lang: 'zh' },
  ...over,
});
const rc = (c: MatchContext) => ({ context: c }) as never;
const query = (keyword: string, entity: string | null = null, page = 1) => ({
  keyword,
  page,
  tradeType: 'SELL',
  entity,
});
const search = (queries = [query('小绿锅')], purpose = 'discover', intent = 'second_hand') => ({
  queries,
  purpose,
  intent,
});
const args = {
  intro: '有闲平台这条有小绿锅，可以先看成色和自提位置：',
  recommendations: [
    {
      ref: 'm1',
      name: '小绿锅',
      group: '厨房小家电',
      summary: '成色新，可在 Camberwell 自提。',
      reason: '适合想自提的人。',
      evidence: '小绿锅成色新，Camberwell 自提',
      facts: [{ label: 'location', value: 'Camberwell', quote: 'Camberwell 自提' }],
    },
  ],
};

describe('market research tools', () => {
  it('redirects an unsupported retail request to information research without telling it to repeat legacy writes', async () => {
    const d = deps(),
      c = ctx({ demand: { category: 'other', need: '狗岛找止疼药', confidence: 1 } });
    const result = await marketSearchTool({ ...d, answerRequests: true } as never).invoke(
      rc(c),
      JSON.stringify(search()),
    );
    expect(result).toContain('search_information');
    expect(result).not.toContain('upsert_demand');
    expect(d.marketSearch.find).not.toHaveBeenCalled();
  });
  it('names the schema field that broke and accepts up to twenty area names', async () => {
    const base = {
      needs: [{ id: 'room', terms: ['合租'] }],
      preferences: [],
      requiredTerms: [],
      excludeTerms: [],
      budget: 1000,
      route: null,
      dateRange: null,
    };
    const areas = (n: number) => Array.from({ length: n }, (_, i) => 'Area ' + i);
    const d = deps(),
      c = ctx({ demand: { category: 'housing', confidence: 0.95, lang: 'zh' } });
    const t = marketSearchTool({ ...d, answerRequests: true } as never);
    const tooMany = await t.invoke(
      rc(c),
      JSON.stringify({
        ...search([{ ...query('合租'), tradeType: 'ANY' }], 'discover', 'housing'),
        plan: { ...base, requiredArea: areas(21) },
      }),
    );
    expect(tooMany).toContain('plan.requiredArea');
    expect(tooMany).not.toContain('Area 0');
    expect(d.marketSearch.find).not.toHaveBeenCalled();
    const traced = d.repos.traces.create.mock.calls
      .map((call) => (call as [{ output: Record<string, unknown> }])[0].output)
      .find((output) => output['gate'] === 'market_search_input');
    expect(traced).toMatchObject({ attempt: 1 });
    expect(traced?.['detail']).toEqual([expect.stringContaining('plan.requiredArea')]);
    await t.invoke(
      rc(c),
      JSON.stringify({
        ...search([{ ...query('合租'), tradeType: 'ANY' }], 'discover', 'housing'),
        plan: { ...base, requiredArea: areas(14) },
      }),
    );
    expect(d.marketSearch.find).toHaveBeenCalled();
  });
  it('executes the current user target direction even when the model requests the opposite side', async () => {
    const d = deps(),
      c = ctx({ marketTarget: 'SELL' });
    const out = JSON.parse(
      await marketSearchTool(d as never).invoke(
        rc(c),
        JSON.stringify(search([{ ...query('小绿锅'), tradeType: 'BUY' }])),
      ),
    ) as { effectiveTradeType: string };
    expect(d.marketSearch.find).toHaveBeenCalledWith(
      expect.objectContaining({ tradeType: 'SELL' }),
    );
    expect(out.effectiveTradeType).toBe('SELL');
  });
  it('batches synonyms, deduplicates listing IDs and keeps refs through public detail enrichment', async () => {
    const d = deps(),
      c = ctx();
    d.marketSearch.find
      .mockResolvedValueOnce({ items: [POT], hasNext: true, total: 50 })
      .mockResolvedValueOnce({
        items: [POT, { ...POT, id: 'listing_b', url: 'https://a2hmarket.ai/listings/listing_b' }],
        hasNext: false,
        total: 2,
      });
    const first = JSON.parse(
      await marketSearchTool(d as never).invoke(
        rc(c),
        JSON.stringify(search([query('小绿锅'), query('多功能电煮锅')])),
      ),
    ) as { listings: Array<{ ref: string }> };
    expect(first.listings.map((l) => l.ref)).toEqual(['m1', 'm2']);
    await marketEnrichTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['m1'] }));
    expect(c.marketListings?.[0]?.ref).toBe('m1');
    expect(d.marketSearch.detail).toHaveBeenCalledWith('listing_a');
    await marketEnrichTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['m1'] }));
    expect(d.marketSearch.detail).toHaveBeenCalledTimes(1);
  });
  it('caches empty and failed queries while permitting different keywords', async () => {
    const d = deps(),
      c = ctx(),
      t = marketSearchTool(d as never);
    d.marketSearch.find.mockRejectedValueOnce(new Error('network'));
    const first = JSON.parse(await t.invoke(rc(c), JSON.stringify(search()))) as {
      failures: unknown[];
    };
    expect(first.failures).toHaveLength(1);
    await t.invoke(rc(c), JSON.stringify(search()));
    await t.invoke(rc(c), JSON.stringify(search([query('电煮锅')])));
    expect(d.marketSearch.find).toHaveBeenCalledTimes(2);
  });
  it.each([{ outboundBlocked: true }, { xhsNotes: [] }, { searchResults: [] }])(
    'does not bypass a decline or switch sources: %j',
    async (over) => {
      const d = deps();
      await marketSearchTool(d as never).invoke(rc(ctx(over)), JSON.stringify(search()));
      expect(d.marketSearch.find).not.toHaveBeenCalled();
    },
  );
  it('enforces category, known entity and private-query prerequisites', async () => {
    const d = deps(),
      t = marketSearchTool(d as never);
    await t.invoke(
      rc(ctx({ demand: { category: 'job', confidence: 0.9 } })),
      JSON.stringify(search()),
    );
    await t.invoke(rc(ctx()), JSON.stringify(search([query('联系我 07700 900123')])));
    await t.invoke(rc(ctx()), JSON.stringify(search([query('未知物品', '未知物品')], 'enrich')));
    expect(d.marketSearch.find).not.toHaveBeenCalled();
  });
  it('allows all eight queries to discover independent aliases/pages, then stops', async () => {
    const d = deps(),
      c = ctx(),
      t = marketSearchTool(d as never);
    for (const keyword of [
      '小绿锅',
      '电煮锅',
      '电锅',
      '电火锅',
      '锅具',
      '绿色锅',
      '苏泊尔锅',
      '电煮小锅',
    ])
      await t.invoke(rc(c), JSON.stringify(search([query(keyword)])));
    expect(await t.invoke(rc(c), JSON.stringify(search([query('锅子')])))).toContain(
      'budget exhausted',
    );
    expect(d.marketSearch.find).toHaveBeenCalledTimes(8);
  });
  it('caps and interleaves recall so a broad first query cannot crowd out the other topic', async () => {
    const d = deps(),
      c = ctx();
    const listings = Array.from({ length: 20 }, (_, i) => ({ ...POT, id: `listing_a${i}` }));
    d.marketSearch.find
      .mockResolvedValueOnce({ items: listings, hasNext: true, total: 20 })
      .mockResolvedValueOnce({
        items: [{ ...POT, id: 'listing_other' }],
        hasNext: false,
        total: 1,
      });
    await marketSearchTool(d as never).invoke(
      rc(c),
      JSON.stringify(search([query('小绿锅'), query('电煮锅')])),
    );
    expect(c.marketListings?.[1]?.id).toBe('listing_other');
    expect(c.marketListings).toHaveLength(21);
  });
  it('ranks a useful result beyond the first ten, with source conditions and stable refs', async () => {
    const d = deps(),
      c = ctx();
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...POT,
      id: `item_${i}`,
      title: '伦敦出办公椅',
      description: '出售：办公椅，E14自提',
    }));
    items[15] = {
      ...POT,
      id: 'item_15',
      title: '伦敦出书桌',
      description: '出售：书桌\n地点：E14\n- 书桌｜£35',
    };
    d.marketSearch.find.mockResolvedValueOnce({ items, hasNext: true, total: 80 });
    const plan = {
      needs: [{ id: 'desk', terms: ['书桌'] }],
      preferences: ['白色'],
      requiredTerms: [],
      excludeTerms: [],
      requiredArea: ['E14'],
      budget: 50,
      route: null,
      dateRange: null,
    };
    const output = JSON.parse(
      await marketSearchTool(d as never).invoke(
        rc(c),
        JSON.stringify({ ...search([query('书桌')]), plan }),
      ),
    ) as {
      listings: Array<{
        ref: string;
        assessment: { checks: Array<{ label: string; status: string }> };
        evidencePassages: string[];
      }>;
      coverage: Array<{ candidates: number }>;
    };
    expect(c.marketListings).toHaveLength(20);
    expect(output.listings).toHaveLength(1);
    expect(output.listings[0]?.ref).toBe('m16');
    expect(output.listings[0]?.assessment.checks).toContainEqual({
      label: 'budget',
      status: 'met',
      evidence: '- 书桌｜£35',
    });
    expect(output.listings[0]?.evidencePassages).toContain('- 书桌｜£35');
    expect(output.coverage[0]?.candidates).toBe(1);
  });
  it('exposes unmatched discoveries and learns a source-attested alias without relaxing the budget', async () => {
    const d = deps(),
      c = ctx();
    const table = {
      ...POT,
      title: '伦敦写字台',
      description: '出售：写字台\n地点：E14\n- 写字台｜£35',
    };
    d.marketSearch.find.mockResolvedValueOnce({ items: [table], hasNext: false, total: 1 });
    const plan = {
      needs: [{ id: 'desk', terms: ['书桌'] }],
      preferences: [],
      requiredTerms: [],
      excludeTerms: [],
      requiredArea: ['E14'],
      budget: 50,
      route: null,
      dateRange: null,
    };
    const t = marketSearchTool(d as never);
    const first = JSON.parse(
      await t.invoke(rc(c), JSON.stringify({ ...search([query('书桌')]), plan })),
    ) as { listings: Array<{ ref: string }> };
    expect(first.listings[0]?.ref).toBe('m1');
    await t.invoke(
      rc(c),
      JSON.stringify({
        ...search([query('写字台')]),
        plan: { ...plan, budget: 1000, needs: [{ id: 'desk', terms: ['书桌', '写字台'] }] },
      }),
    );
    expect(c.marketPlan?.needs[0]?.terms).toContain('写字台');
    expect(c.marketPlan?.budget).toBe(50);
  });
  it('returns truncated projections to the model while ctx keeps full text for quote validation', async () => {
    const d = deps(),
      c = ctx();
    const long = { ...POT, description: `小绿锅成色新。${'细'.repeat(3000)}` };
    d.marketSearch.find.mockResolvedValueOnce({ items: [long], hasNext: false, total: 1 });
    const out = JSON.parse(
      await marketSearchTool(d as never).invoke(rc(c), JSON.stringify(search())),
    ) as { listings: Array<Record<string, unknown>> };
    const shown = out.listings[0]!;
    expect(shown['description']).toBe(`小绿锅成色新。${'细'.repeat(243)}…`);
    expect(shown['descriptionTruncated']).toBe(true);
    expect(shown).not.toHaveProperty('id');
    expect(shown).not.toHaveProperty('url');
    expect(shown).not.toHaveProperty('sourceUrl');
    expect(shown['ref']).toBe('m1');
    expect(c.marketListings?.[0]?.description).toHaveLength(3007);
    d.marketSearch.detail.mockResolvedValueOnce(long);
    const enriched = JSON.parse(
      await marketEnrichTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['m1'] })),
    ) as { listings: Array<Record<string, unknown>> };
    expect(enriched.listings[0]?.['description']).toHaveLength(1501);
    expect(c.marketListings?.[0]?.description).toHaveLength(3007);
  });
});

describe('reply_with_market_results', () => {
  it.each([false, true])(
    'on the final repair retains only independently valid offers (allInvalid=%s)',
    async (allInvalid) => {
      const d = deps();
      const c = ctx({
        marketPlan: {
          intent: 'second_hand',
          needs: [{ id: 'pot', terms: ['小绿锅'] }],
          preferences: [],
        },
        marketListings: [
          { ...POT, ref: 'm1' },
          { ...POT, id: 'listing_b', ref: 'm2' },
        ],
        outboundInputFailures: { tool: 'reply_with_market_results', count: 2 },
      });
      const recommendations = [
        { ...args.recommendations[0], ...(allInvalid ? { name: 'invented name' } : {}) },
        { ...args.recommendations[0], ref: 'm2', name: 'another invented name' },
      ];
      await replyWithMarketResultsTool(d as never).invoke(
        rc(c),
        JSON.stringify({ ...args, recommendations }),
      );
      if (allInvalid) {
        expect(d.repos.outbound.create).not.toHaveBeenCalled();
        expect(c.outboundBlocked).toBe(true);
      } else {
        expect(d.repos.outbound.create).toHaveBeenCalledOnce();
        const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
        expect(draft.text).not.toContain('invented');
        const rows = d.repos.traces.create.mock.calls.map(
          ([row]) => row as { output?: { rejectedRefs?: string[] } },
        );
        expect(rows.some((row) => row.output?.rejectedRefs?.includes('m2'))).toBe(true);
      }
    },
  );
  it('never publishes a known wrong trip date while recovering a valid carry lead', async () => {
    const d = deps();
    const good = {
      ...POT,
      id: 'good_trip',
      ref: 'm1',
      title: '伦敦帮带',
      description: '帮带：上海 -> 伦敦，11月4日可带行李',
      sourceUrl: null,
    };
    const wrong = {
      ...POT,
      id: 'wrong_trip',
      ref: 'm2',
      title: '上海伦敦帮带',
      description: '帮带：10月27日上海飞伦敦，11月9日回上海',
      sourceUrl: null,
    };
    const c = ctx({
      demand: { category: 'other', confidence: 1, lang: 'zh' },
      marketPlan: {
        intent: 'carry',
        needs: [{ id: 'carry', terms: ['帮带'] }],
        preferences: [],
        route: { from: ['上海'], to: ['伦敦'] },
        dateRange: { from: '2026-11-01', to: '2026-11-30' },
      },
      marketListings: [good, wrong],
      outboundInputFailures: { tool: 'reply_with_market_results', count: 2 },
    });
    const recommendations = [good, wrong].map((listing) => ({
      ...args.recommendations[0],
      ref: listing.ref,
      name: '帮带',
      evidence: listing.description,
      facts: [],
    }));
    await replyWithMarketResultsTool(d as never).invoke(
      rc(c),
      JSON.stringify({ intro: '公开帮带线索', recommendations }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('11月4日');
    expect(draft.text).not.toContain('10月27日');
    expect(draft.text).toContain('待确认');
  });
  it('renders actual item, its own post price/date and marketplace plus repost links', async () => {
    const d = deps();
    await replyWithMarketResultsTool(d as never).invoke(
      rc(ctx({ marketListings: [{ ...POT, ref: 'm1' }] })),
      JSON.stringify(args),
    );
    const [draft, status] = d.repos.outbound.create.mock.calls[0] as unknown as [
      { text: string },
      string,
    ];
    expect(status).toBe('dry_run');
    expect(draft.text).toContain('1. 小绿锅');
    expect(draft.text).toContain('帖内报价范围');
    expect(draft.text).toContain('原帖发布 2026-09-01');
    expect(draft.text).not.toContain('原帖发布 2026-10-01');
    expect(draft.text).toContain(POT.url);
    expect(draft.text).toContain(POT.sourceUrl);
    expect(draft.text).not.toContain('不经手交易');
    expect(draft.text).toContain('[A2H详情]');
    expect(draft.text).not.toContain('是否还在以贴主回复为准');
    expect(draft.text).not.toContain('有闲');
    expect(draft).toMatchObject({ mentionUserId: '42', replyToMessageId: '77' });
  });
  it('keeps different owners of the same named item as separate offers, without mixing their facts', async () => {
    const d = deps(),
      second = {
        ...POT,
        id: 'listing_b',
        url: 'https://a2hmarket.ai/listings/listing_b',
        priceLabel: '帖子未标价',
        ref: 'm2',
      };
    await replyWithMarketResultsTool(d as never).invoke(
      rc(ctx({ marketListings: [{ ...POT, ref: 'm1' }, second] })),
      JSON.stringify({
        ...args,
        recommendations: [args.recommendations[0], { ...args.recommendations[0], ref: 'm2' }],
      }),
    );
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('2. 小绿锅');
    expect(draft.text).toContain('帖子未标价');
  });
  it.each([
    { ref: 'm9' },
    { name: '编造物品' },
    { evidence: '随意编了没写过的话' },
    { summary: '联系微信 abc123' },
    { summary: '小绿锅只要£5，符合预算' },
    { facts: [{ label: 'location', value: 'Stratford', quote: 'Camberwell 自提' }] },
  ])('rejects unknown refs, unsupported facts and public contact leakage: %j', async (patch) => {
    const d = deps();
    expect(
      await replyWithMarketResultsTool(d as never).invoke(
        rc(ctx({ marketListings: [{ ...POT, ref: 'm1' }] })),
        JSON.stringify({ ...args, recommendations: [{ ...args.recommendations[0], ...patch }] }),
      ),
    ).toContain('invalid recommendation');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('reports all evidence, fact and price errors together rather than one repair per field', async () => {
    const d = deps();
    const out = await replyWithMarketResultsTool(d as never).invoke(
      rc(ctx({ marketListings: [{ ...POT, ref: 'm1' }] })),
      JSON.stringify({
        ...args,
        recommendations: [
          {
            ...args.recommendations[0],
            evidence: '不存在的原文',
            summary: '单件1镑',
            facts: [{ label: 'date', value: '2026-09-01', quote: POT.description }],
          },
        ],
      }),
    );
    expect(out).toContain('recommendations.0.summary/reason/facts');
    expect(out).toContain('recommendations.0.evidence');
    expect(out).toContain('recommendations.0.facts.0.value');
    expect(out).toContain('sourcePublishedAt/createdAt');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('permits an area-unknown backup alongside a confirmed area choice', async () => {
    const d = deps();
    const c = ctx({
      marketPlan: {
        intent: 'second_hand',
        needs: [{ id: 'pot', terms: ['小绿锅'] }],
        preferences: [],
        requiredArea: ['E14'],
      },
      marketListings: [
        { ...POT, ref: 'm1' },
        {
          ...POT,
          id: 'listing_b',
          ref: 'm2',
          sourceUrl: null,
          description: '小绿锅成色新，E14 自提。',
        },
      ],
    });
    await replyWithMarketResultsTool(d as never).invoke(
      rc(c),
      JSON.stringify({
        ...args,
        recommendations: [
          args.recommendations[0],
          {
            ...args.recommendations[0],
            ref: 'm2',
            evidence: '小绿锅成色新，E14 自提。',
            facts: [],
          },
        ],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('【优先看】');
    expect(draft.text).toContain('【备选');
    expect(draft.text).toContain('待确认：地点');
  });
  it('requires one bounded gap search after detail reading, then allows an honest unknown', async () => {
    const d = deps();
    const c = ctx({
      marketPlan: {
        intent: 'second_hand',
        needs: [{ id: 'pot', terms: ['小绿锅'] }],
        preferences: ['成色新'],
        essentialPreferences: [],
        budget: 20,
      },
      marketListings: [{ ...POT, ref: 'm1' }],
      marketDetailIds: [POT.id],
      marketQueries: [{ ...query('小绿锅'), purpose: 'discover', intent: 'second_hand' }],
    });
    const tool = replyWithMarketResultsTool(d as never);
    expect(await tool.invoke(rc(c), JSON.stringify(args))).toContain('one focused market_search');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    c.marketQueries!.push({
      ...query('小绿锅 价格', '小绿锅'),
      purpose: 'enrich',
      intent: 'second_hand',
    });
    await tool.invoke(rc(c), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('【备选');
    expect(draft.text).toContain('待确认：价格/计价单位');
  });
  it('presents evidence-based priorities and price-unknown backups without post-range confusion', async () => {
    const d = deps();
    const c = ctx({
      marketPlan: {
        intent: 'second_hand',
        needs: [{ id: 'pot', terms: ['小绿锅'] }],
        preferences: ['成色新'],
        essentialPreferences: [],
        budget: 20,
      },
      marketListings: [
        { ...POT, ref: 'm1', description: '小绿锅成色新，Camberwell 自提。\n- 小绿锅｜£15' },
        { ...POT, id: 'listing_b', ref: 'm2', sourceUrl: null },
      ],
    });
    await replyWithMarketResultsTool(d as never).invoke(
      rc(c),
      JSON.stringify({
        ...args,
        recommendations: [{ ...args.recommendations[0], ref: 'm2' }, args.recommendations[0]],
      }),
    );
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('【优先看】');
    expect(draft.text).toContain('【备选');
    expect(draft.text).toContain('单品报价符合预算');
    expect(draft.text).toContain('单品报价：£15');
    expect(draft.text).not.toContain('帖内报价范围');
    expect(draft.text).not.toContain('主体需求相符');
    expect(draft.text.indexOf('【优先看】')).toBeLessThan(draft.text.indexOf('【备选'));
  });
  it('asks for a confirmed area candidate before an unknown area when the pool has one', async () => {
    const d = deps();
    const c = ctx({
      marketPlan: {
        intent: 'second_hand',
        needs: [{ id: 'pot', terms: ['小绿锅'] }],
        preferences: [],
        requiredArea: ['E14'],
      },
      marketListings: [
        { ...POT, ref: 'm1' },
        { ...POT, id: 'listing_b', ref: 'm2', description: '小绿锅，地点：E14自提。' },
      ],
    });
    const result = await replyWithMarketResultsTool(d as never).invoke(rc(c), JSON.stringify(args));
    expect(result).toContain('prefer confirmed area');
    expect(result).toContain('m2');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('renders source quotes and assessed fit instead of unsupported prose or rewritten facts', async () => {
    const d = deps();
    const c = ctx({
      marketPlan: {
        intent: 'companion',
        needs: [{ id: 'badminton', terms: ['羽毛球'] }],
        preferences: ['周末', '初学者'],
      },
      marketListings: [
        {
          ...POT,
          ref: 'm1',
          tradeType: 'PEER',
          title: '伦敦羽毛球搭子',
          description: '伦敦羽毛球搭子，新生老手均可。',
        },
      ],
    });
    await replyWithMarketResultsTool(d as never).invoke(
      rc(c),
      JSON.stringify({
        intro: '找到搭子',
        recommendations: [
          {
            ref: 'm1',
            name: '伦敦羽毛球搭子',
            group: '羽毛球',
            summary: '明确接受初学者，周末有空。',
            reason: '初学者友好且预算内。',
            evidence: '伦敦羽毛球搭子，新生老手均可。',
            facts: [{ label: 'requirements', value: '初学者可参加', quote: '新手均可参加。' }],
          },
        ],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('伦敦羽毛球搭子，新生老手均可。');
    expect(draft.text).toContain('待确认：周末 / 初学者');
    expect(draft.text).not.toContain('初学者友好');
    expect(draft.text).not.toContain('周末有空');
    expect(draft.text).not.toContain('初学者可参加');
  });
  it('rejects a known budget conflict and renders unknown constraints plus item price evidence', async () => {
    const d = deps();
    const plan = {
      intent: 'second_hand' as const,
      needs: [{ id: 'pot', terms: ['小绿锅'] }],
      preferences: [],
      budget: 10,
    };
    const expensive = {
      ...POT,
      ref: 'm1',
      description: '小绿锅成色新，Camberwell 自提。\n- 小绿锅｜£20',
    };
    const c = ctx({ marketPlan: plan, marketListings: [expensive] });
    const result = await replyWithMarketResultsTool(d as never).invoke(rc(c), JSON.stringify(args));
    expect(result).toContain('conflicts with hard requirements (budget)');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    const unknown = ctx({ marketPlan: plan, marketListings: [{ ...POT, ref: 'm1' }] });
    await replyWithMarketResultsTool(d as never).invoke(rc(unknown), JSON.stringify(args));
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('待确认：价格/计价单位');
    expect(draft.text).not.toContain('符合预算');
  });
  it('rejects an offer that became sold during enrichment', async () => {
    const d = deps(),
      c = ctx({ marketListings: [{ ...POT, ref: 'm1' }] });
    d.marketSearch.detail.mockResolvedValueOnce({ ...POT, status: 'SOLD' });
    await marketEnrichTool(d as never).invoke(rc(c), JSON.stringify({ refs: ['m1'] }));
    await replyWithMarketResultsTool(d as never).invoke(rc(c), JSON.stringify(args));
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it.each([
    [0, true, false, 'dry_run'],
    [1, true, true, 'pending'],
    [2, true, false, 'pending'],
    [2, false, true, 'pending'],
  ] as const)('retains phase %i approval semantics', async (phase, ok, approval, status) => {
    const d = deps();
    if (!ok)
      d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'unavailable' } as never);
    const c = ctx({ phase, marketListings: [{ ...POT, ref: 'm1' }] }),
      t = replyWithMarketResultsTool(d as never);
    expect(await t.needsApproval(rc(c), args, 'call')).toBe(approval);
    await t.invoke(rc(c), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), status);
  });
  it('does not send when Jev is unavailable and no one is reviewing', async () => {
    const d = { ...deps(), env: { OUTBOUND_UNSURE_ACTION: 'drop' } };
    d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'unavailable' } as never);
    await replyWithMarketResultsTool(d as never).invoke(
      rc(ctx({ phase: 2, marketListings: [{ ...POT, ref: 'm1' }] })),
      JSON.stringify(args),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

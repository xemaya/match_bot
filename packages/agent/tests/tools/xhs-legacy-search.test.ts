import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { UnsafeQueryError, type XhsNote } from '@matchbot/websearch';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { replyWithLegacyXhsNotesTool } from '../../src/tools/reply-with-xhs-legacy-notes.js';
import { legacyXhsSearchTool } from '../../src/tools/xhs-legacy-search.js';

const MARKET: XhsNote = {
  ref: 'x1',
  title: '2026-2027伦敦圣诞集市攻略',
  desc: 'Southbank 集市有河边小吃摊，适合傍晚散步。',
  author: '大智和小智',
  likes: 40,
  url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok',
};
const FOOD: XhsNote = {
  ref: 'x2',
  title: '伦敦川菜天花板合集',
  desc: '这篇介绍了 Soho 的川菜餐厅。',
  author: '吃货小王',
  likes: 12,
  url: 'https://www.xiaohongshu.com/explore/n2?xsec_token=tok',
};

function deps(found: XhsNote[] = [MARKET, FOOD]) {
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
    xhsSearch: { find: vi.fn(() => Promise.resolve(found)) },
    jev: { evaluate: vi.fn() },
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
  demand: { category: 'other', need: 'Christmas markets', confidence: 0.9, lang: 'zh' },
  ...over,
});
const rc = (c: MatchContext) => ({ context: c }) as never;

describe('xhs_search', () => {
  it('refuses when our own catalogue has not been tried for a service category', async () => {
    const d = deps();
    const c = ctx({ demand: { category: 'man_and_van', confidence: 0.9 } });
    const out = await legacyXhsSearchTool(d as never).invoke(
      rc(c),
      JSON.stringify({ keyword: '搬家' }),
    );
    expect(out).toContain('not allowed');
    expect(d.xhsSearch.find).not.toHaveBeenCalled();
  });

  it('returns structured fields with a capped excerpt, stores notes, and traces the keyword', async () => {
    const d = deps();
    const c = ctx();
    const long = 'x'.repeat(800);
    d.xhsSearch.find.mockResolvedValueOnce([{ ...MARKET, desc: long }]);
    const out = await legacyXhsSearchTool(d as never).invoke(
      rc(c),
      JSON.stringify({ keyword: '圣诞集市' }),
    );
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(parsed[0]).toMatchObject({
      ref: 'x1',
      title: MARKET.title,
      author: MARKET.author,
      likes: 40,
    });
    // 无论依赖返回多长的正文，只交给模型有上界的节选。
    expect((parsed[0]!.excerpt as string).length).toBe(500);
    expect(c.xhsNotes).toHaveLength(1);
    const [trace] = d.repos.traces.create.mock.calls[0] as unknown as [
      { output: { gate: string; keyword: string } },
    ];
    expect(trace.output.gate).toBe('xhs_search');
    expect(trace.output.keyword).toBe('圣诞集市');
  });

  it('searches at most once per run', async () => {
    const d = deps();
    const c = ctx();
    const t = legacyXhsSearchTool(d as never);
    await t.invoke(rc(c), JSON.stringify({ keyword: '圣诞集市' }));
    const again = await t.invoke(rc(c), JSON.stringify({ keyword: '川菜' }));
    expect(again).toContain('already searched');
    expect(d.xhsSearch.find).toHaveBeenCalledTimes(1);
  });

  it('does not search again when web_search already ran this run', async () => {
    const d = deps();
    const c = ctx({
      searchResults: [
        {
          ref: 'w1',
          name: 'Bakery',
          url: 'https://example.com',
          contact: {},
          evidence: 'contact_on_own_site',
        },
      ],
    });
    const out = await legacyXhsSearchTool(d as never).invoke(
      rc(c),
      JSON.stringify({ keyword: '蛋糕' }),
    );
    expect(out).toContain('already searched the web');
    expect(d.xhsSearch.find).not.toHaveBeenCalled();
  });

  it('turns an unsafe keyword into an instruction for the model, not a crash', async () => {
    const d = deps();
    d.xhsSearch.find.mockRejectedValueOnce(new UnsafeQueryError('need contains a number'));
    const out = await legacyXhsSearchTool(d as never).invoke(
      rc(ctx()),
      JSON.stringify({ keyword: 'cake' }),
    );
    expect(out).toContain('Rewrite "keyword"');
  });
});

const recommendationArgs = {
  intro: '想边逛边吃的话，我会先看这篇：',
  recommendations: [
    {
      ref: 'x1',
      name: 'Southbank 集市',
      reason: '适合想在河边散步、顺便吃小吃的人。',
      evidence: 'Southbank 集市有河边小吃摊',
    },
  ],
};

describe('reply_with_xhs_notes', () => {
  it('writes a ranked recommendation, source evidence and the original token-bearing link', async () => {
    const d = deps();
    await replyWithLegacyXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [MARKET] })),
      JSON.stringify(recommendationArgs),
    );
    const [row, status] = d.repos.outbound.create.mock.calls[0] as unknown as [
      { text: string; kind: string },
      string,
    ];
    expect(status).toBe('dry_run');
    expect(row).toMatchObject({
      kind: 'recommendation',
      mentionUserId: '42',
      replyToMessageId: '77',
    });
    expect(row.text).toContain('\n\n1. Southbank 集市\n');
    expect(row.text).toContain(recommendationArgs.recommendations[0]!.reason);
    expect(row.text).toContain('笔记提到：Southbank 集市有河边小吃摊');
    expect(row.text).toContain('[小红书原文](' + MARKET.url + ')');
    expect(row.text).not.toContain('时间、价格和开放情况请以官方最新信息为准');
    expect(row.text).not.toContain('建议先私信问问');
  });

  it.each([
    ['unknown ref', [{ ...recommendationArgs.recommendations[0], ref: 'x9' }]],
    ['unsupported name', [{ ...recommendationArgs.recommendations[0], name: '不存在的集市' }]],
    [
      'unsupported evidence',
      [{ ...recommendationArgs.recommendations[0], evidence: '免费入场，全年开放' }],
    ],
    [
      'duplicate ref',
      [...recommendationArgs.recommendations, ...recommendationArgs.recommendations],
    ],
  ])('rejects %s without writing outbound', async (_name, recommendations) => {
    const d = deps();
    const out = await replyWithLegacyXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [MARKET] })),
      JSON.stringify({ ...recommendationArgs, recommendations }),
    );
    expect(out).toContain('invalid recommendation');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });

  it('rejects a source URL outside the returned Xiaohongshu note format', async () => {
    const d = deps();
    await replyWithLegacyXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [{ ...MARKET, url: 'https://example.com' }] })),
      JSON.stringify(recommendationArgs),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });

  it('renders English labels and supplies the note body to the outbound evaluator', async () => {
    const d = deps();
    d.evaluateOutbound.mockResolvedValueOnce({
      ok: true,
      worthReplying: 2.8,
      languageOk: 0.95,
      mentionsUnverified: 0,
    });
    const c = ctx({
      phase: 2,
      demand: { category: 'other', confidence: 0.9, lang: 'en' },
      xhsNotes: [MARKET],
    });
    await replyWithLegacyXhsNotesTool(d as never).invoke(
      rc(c),
      JSON.stringify({
        intro: 'For a riverside walk, I would start here:',
        recommendations: [
          {
            ref: 'x1',
            name: 'Southbank 集市',
            reason: 'A good fit for a walk with food stops.',
            evidence: recommendationArgs.recommendations[0]!.evidence,
          },
        ],
      }),
    );
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toContain('Note says:');
    expect(row.text).toContain('[Xiaohongshu note]');
    expect(d.evaluateOutbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supplierSummaries: [expect.stringContaining(MARKET.desc)] }),
    );
  });

  it.each([
    [0, true, false, 'dry_run'],
    [1, true, true, 'pending'],
    [2, true, false, 'pending'],
    [2, false, true, 'pending'],
  ] as const)(
    'phase %i, Jev ok=%s: approval=%s, status=%s',
    async (phase, ok, approval, status) => {
      const d = { ...deps(), env: { OUTBOUND_UNSURE_ACTION: 'review' } };
      d.evaluateOutbound.mockResolvedValueOnce(
        ok
          ? { ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 }
          : { ok: false, reason: 'jev_unavailable' },
      );
      const c = ctx({ phase, xhsNotes: [MARKET] });
      const t = replyWithLegacyXhsNotesTool(d as never);
      expect(await t.needsApproval(rc(c), recommendationArgs, 'c1')).toBe(approval);
      await t.invoke(rc(c), JSON.stringify(recommendationArgs));
      expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), status);
      expect(d.repos.traces.create).toHaveBeenCalled();
    },
  );

  it('does not send when unattended and Jev is unavailable', async () => {
    const d = deps();
    d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'jev_unavailable' });
    const c = ctx({ phase: 2, xhsNotes: [MARKET] });
    const t = replyWithLegacyXhsNotesTool(d as never);
    expect(await t.needsApproval(rc(c), recommendationArgs, 'c1')).toBe(false);
    expect(await t.invoke(rc(c), JSON.stringify(recommendationArgs))).toContain('not sent');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

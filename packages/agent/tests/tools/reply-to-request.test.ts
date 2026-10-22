import { readFileSync } from 'node:fs';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { bindCurrentRequest } from '../../src/current-request.js';
import { createKnowledgeSource } from '../../src/knowledge-evidence.js';
import {
  cleanSourceUrl,
  renderSourceLinks,
  replyToRequestTool,
} from '../../src/tools/reply-to-request.js';
import { taskSchema } from '@matchbot/domain';

function setup(phase: 0 | 1 | 2, ok = true) {
  const d = {
    env: { OUTBOUND_UNSURE_ACTION: 'review' },
    jev: {},
    thresholds: DEFAULT_THRESHOLDS,
    repos: {
      traces: { create: vi.fn(() => Promise.resolve({})) },
      outbound: {
        create: vi.fn(() => Promise.resolve({ id: 'o' })),
        countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
      },
    },
    logger: { info: vi.fn() },
    evaluateOutbound: vi.fn(() =>
      Promise.resolve(
        ok
          ? { ok: true, worthReplying: 3, languageOk: 1, mentionsUnverified: 0 }
          : { ok: false, reason: 'timeout' },
      ),
    ),
  };
  const c: MatchContext = {
    userId: 'u',
    chatId: '-1',
    groupId: null,
    phase,
    sourceMessageId: 'm',
    recentReplies: [],
    demand: { category: 'other', need: 'old carry topic', confidence: 1 },
  };
  bindCurrentRequest(c, '住E14没有NHS number，怎么注册GP？');
  c.knowledgeSources = [
    createKnowledgeSource(
      {
        title: 'NHS register',
        url: 'https://www.nhs.uk/register/',
        text: 'Everyone in England can register. You do not need an NHS number. Registration is free.',
      },
      1,
    ),
  ];
  return { d, c, t: replyToRequestTool(d as never) };
}
const args = {
  kind: 'answer',
  text: '没有NHS number也能注册GP，注册免费。先按居住邮编选择接受注册的诊所。',
  refs: ['k1'],
};
describe('reply_to_request', () => {
  it('accepts an equivalent source clock and rejects an unsupported clock through the actual tool', async () => {
    const { c, d, t } = setup(0);
    bindCurrentRequest(c, '伦敦这个展下午能去吗');
    c.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'Exhibition hours',
          url: 'https://museum.example/hours',
          text: 'Exhibition opening hours: 10 am to 5:30 pm.',
        },
        1,
      ),
    ];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        text: '展览开放时间10:00–17:30，下午在开放时段内。',
        refs: ['k1'],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const other = setup(0);
    bindCurrentRequest(other.c, '伦敦这个展下午能去吗');
    other.c.knowledgeSources = c.knowledgeSources;
    expect(
      await other.t.invoke(
        { context: other.c } as never,
        JSON.stringify({ kind: 'partial', text: '开放到18:00。', refs: ['k1'] }),
      ),
    ).toContain('unsupported numerical');
    expect(other.d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('rejects a real but unselected source before any outbound evaluation or write', async () => {
    const { c, d, t } = setup(2);
    c.isAnswerFinalization = true;
    c.deliverySourceRefs = ['k2'];
    const result = await t.invoke({ context: c } as never, JSON.stringify(args));
    expect(result).toContain('selected delivery packet');
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('uses the source-rendering outbound kind for a factual answer that also asks a question', async () => {
    const { c, d, t } = setup(0);
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        ...args,
        kind: 'clarification',
        text: '没有NHS number也能注册GP。你希望先看办理入口吗？',
      }),
    );
    expect(d.repos.outbound.create.mock.calls[0]?.[0]).toMatchObject({ kind: 'recommendation' });
  });
  it('suppresses the actual recorded repeat draft for an already answered context supplement', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/headache-repeat-draft.json', import.meta.url), 'utf8'),
    ) as {
      text: string;
      sources: Array<{ title: string; url: string; text: string }>;
      evidence: unknown[];
    };
    const { d, c, t } = setup(2);
    bindCurrentRequest(c, '头痛');
    c.task = taskSchema.parse({
      id: 'task',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '取药渠道',
      status: 'active',
      revision: 1,
      requirementsVersion: 1,
      goals: [],
      constraints: [],
      evidence: fixture.evidence,
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    c.taskProgressVersion = 1;
    c.taskUpdate = { kind: 'continued' };
    c.quietSupplementTaskId = 'task';
    Object.assign(c, { quietSupplementEvidenceIds: c.task.evidence.map((e) => e.id) });
    c.knowledgeSources = fixture.sources.map((source, i) => createKnowledgeSource(source, i + 1));
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        text: fixture.text,
        refs: c.knowledgeSources.map((s) => s.ref),
      }),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
    expect(c.replySuppressed).toBe(true);
  });

  it('reports an unplanned question before source-number repair, so later validation does not consume the last retry', async () => {
    const { c, t } = setup(0);
    c.execution = {
      userId: 'u',
      messageId: 'm',
      token: '00000000-0000-4000-8000-000000000001',
      fence: 1,
    };
    c.task = taskSchema.parse({
      id: 'task',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '找正规渠道',
      status: 'active',
      revision: 1,
      requirementsVersion: 1,
      goals: [],
      constraints: [],
      evidence: [],
      pendingQuestion: null,
      nextStep: { action: 'deliver', owner: 'agent', reason: 'partial' },
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    c.taskProgressVersion = 1;
    const input = JSON.stringify({
      kind: 'partial',
      text: '可以联系111。你现在出门不方便吗？这会影响渠道。',
      refs: ['k1'],
    });
    expect(await t.invoke({ context: c } as never, input)).toContain('Record the one missing');
    c.task.nextStep = {
      action: 'ask_user',
      owner: 'agent',
      constraintKey: 'custom:access_difficulty',
      reason: 'access',
    };
    expect(await t.invoke({ context: c } as never, input)).toContain('unsupported numerical');
  });
  it('does not turn published opening hours into guaranteed medicine access', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, '狗岛找止疼药');
    c.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'Official store',
          url: 'https://www.boots.com/store',
          text: 'Pharmacy in Isle of Dogs. Saturday opening hours 09:00 to 19:00. Stock is not shown.',
        },
        1,
      ),
    ];
    const result = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'answer',
        text: '这家周六营业，走过去就能买到止疼药。',
        refs: ['k1'],
      }),
    );
    expect(result).toContain('Stock');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
  });
  it('can give a source-backed channel and one non-clinical question in the same answer', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, '狗岛找止疼药');
    c.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'NHS pharmacy finder',
          url: 'https://www.nhs.uk/service-search/pharmacy/find-a-pharmacy',
          text: 'Find a pharmacy by town, city or postcode in England.',
        },
        1,
      ),
    ];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        text: '先用NHS药房查询找购买渠道，具体库存还需问门店。你是现在急用，还是出门取药不方便？',
        refs: ['k1'],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const draft = d.repos.outbound.create.mock.calls[0]?.[0] as { text: string };
    expect(draft.text).toContain(
      '\u2063\n[NHS pharmacy finder](https://www.nhs.uk/service-search/pharmacy/find-a-pharmacy)',
    );
    expect(draft.text).not.toContain('来源：');
    expect(draft.text).toContain('出门取药不方便');
  });
  it('rejects inferred seller identities before a marketplace draft reaches the semantic gate', async () => {
    const { d, c, t } = setup(0);
    const result = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1'],
        text: '这两条是不同卖家，需要分别取货。',
      }),
    );
    expect(result).toContain('Seller identity');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
  });
  it('sends an over-long chat line back with what to move into details instead of cutting it', async () => {
    const { d, c, t } = setup(0);
    const result = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1'],
        text: '这段建议没有收敛，重复了过多信息。'.repeat(30),
      }),
    );
    expect(result).toContain('400 characters');
    expect(result).toContain('phone message');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('holds a group chat line to two lines and 90 weighted characters', async () => {
    const { d, c, t } = setup(0);
    c.groupId = 'g';
    const long = await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, text: '没有NHS number也能注册GP 注册免费'.repeat(6) }),
    );
    expect(long).toContain('90 characters');
    const manyLines = await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, text: '一\n二\n三' }),
    );
    expect(manyLines).toContain('2 lines');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('sends a group line back when it reads like a report instead of a member message', async () => {
    const { d } = setup(0);
    const cases: Array<[string, string]> = [
      ['没有NHS number也能注册GP。注册免费。先按邮编选诊所。', 'typing style'],
      ['注册GP要两步：先选诊所', 'typing style'],
      ['两人£60到£65一小时 最少2小时 周六£69', 'one price'],
      ['Mile End 附近这次没刷到出打印机的 Bermondsey有一台', 'narrates the search'],
      ['先按居住邮编选诊所 具体得你跟诊所确认', 'narrates the search'],
    ];
    for (const [text, expected] of cases) {
      // Fresh context per draft: rejections share the outbound retry budget of one run.
      const fresh = setup(0);
      fresh.c.groupId = 'g';
      const result = await fresh.t.invoke(
        { context: fresh.c } as never,
        JSON.stringify({ ...args, text }),
      );
      expect(result, text).toContain(expected);
      expect(fresh.d.repos.outbound.create).not.toHaveBeenCalled();
    }
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('sends a group line alone, with no card and no links, when details is empty', async () => {
    const { d, c, t } = setup(0);
    c.groupId = 'g';
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        ...args,
        text: '没有NHS number也能注册GP 注册免费 按邮编选个接受注册的诊所就行',
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toBe('没有NHS number也能注册GP 注册免费 按邮编选个接受注册的诊所就行');
  });
  it('sends back a feature the cited post never mentions, but lets the line ask about it', async () => {
    const printer = {
      id: 'printer',
      ref: 'm1',
      title: 'HP DeskJet 2720e 打印机',
      description:
        '出售：全新 HP DeskJet 2720e 打印机，5镑起拍，SE1 Bermondsey，可送到地铁站面交。',
      priceLabel: '£5',
      tradeType: 'SELL' as const,
      status: 'ON_SALE' as const,
      tags: [],
      url: 'https://a2hmarket.ai/listings/printer',
      sourceUrl: null,
      isRepost: false,
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: null,
      createdAt: '2026-10-16T00:00:00Z',
    };
    const plan = {
      intent: 'second_hand' as const,
      needs: [{ id: 'p', terms: ['打印机'] }],
      preferences: [],
      budget: 60,
    };
    const claim = setup(0);
    claim.c.groupId = 'g';
    bindCurrentRequest(claim.c, '有没有uu出二手打印机 能连wifi最好 60镑以内');
    claim.c.marketPlan = plan;
    claim.c.marketListings = [printer];
    const rejected = await claim.t.invoke(
      { context: claim.c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1'],
        text: 'Bermondsey有台全新HP 2720e 5镑起拍 能连wifi 你问一句能不能送到mile end',
      }),
    );
    expect(rejected).toContain('wifi');
    expect(claim.d.repos.outbound.create).not.toHaveBeenCalled();
    const asks = setup(0);
    asks.c.groupId = 'g';
    bindCurrentRequest(asks.c, '有没有uu出二手打印机 能连wifi最好 60镑以内');
    asks.c.marketPlan = plan;
    asks.c.marketListings = [printer];
    await asks.t.invoke(
      { context: asks.c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1'],
        text: 'Bermondsey有台全新HP 2720e 5镑起拍 你问一句能不能连wifi 能不能送到mile end',
      }),
    );
    expect(asks.d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('rejects group details that repeat the line or discuss excluded options', async () => {
    const { d, c, t } = setup(0);
    c.groupId = 'g';
    const line = '没有NHS number也能注册GP 注册免费 按邮编选个诊所';
    const repeated = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        ...args,
        text: line,
        details: '没有NHS number也能注册GP，注册免费，按邮编选诊所。',
      }),
    );
    expect(repeated).toContain('Drop details');
    const excluded = await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, text: line, details: '另一家只招已有NHS number的人。' }),
    );
    expect(excluded).toContain('Drop details');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    // Fresh run: three rejections exhaust one run's outbound retry budget.
    const plain = setup(0);
    plain.c.groupId = 'g';
    const extra = await plain.t.invoke(
      { context: plain.c } as never,
      JSON.stringify({ ...args, text: line, details: '诊所一般周一到周五开，带上租房合同。' }),
    );
    expect(extra).toContain('Drop details');
    expect(plain.d.repos.outbound.create).not.toHaveBeenCalled();
    const conflict = setup(0);
    conflict.c.groupId = 'g';
    await conflict.t.invoke(
      { context: conflict.c } as never,
      JSON.stringify({
        ...args,
        text: line,
        details: '两个页面写的不一样 一个说周六开 一个说周六关',
      }),
    );
    expect(conflict.d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('folds details and source links into an evidence card under the chat line', async () => {
    const { d, c, t } = setup(0);
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, details: '注册是免费的，诊所可能会要住址证明。' }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text.startsWith(args.text + '\n\n\u2063\n注册是免费的')).toBe(true);
    expect(draft.text.endsWith('\n\n[NHS register](https://www.nhs.uk/register/)')).toBe(true);
    expect(draft.text).not.toMatch(/【详情】|来源：|\[1\. /);
  });
  it('sends details over 300 characters back with the fix first', async () => {
    const { d, c, t } = setup(0);
    const result = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        ...args,
        details: '诊所可能会要住址证明，带上租房合同或银行信。'.repeat(16),
      }),
    );
    expect(result).toContain('300 characters');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('sends only the chat line when the model leaves details empty and no source is cited', async () => {
    const { d, c, t } = setup(0);
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'clarification', refs: [], text: '你是要周末还是工作日？' }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toBe('你是要周末还是工作日？');
  });
  it('does not enqueue a background promise as a clarification', async () => {
    const { d, c, t } = setup(0);
    const result = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'clarification',
        refs: [],
        text: '我会继续留意房源，有合适的通知你。你方便哪天？',
      }),
    );
    expect(result).toContain('background');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it.each(['answer', 'partial', 'no_match', 'clarification', 'unavailable'])(
    'rejects an invented search failure even when labelled %s',
    async (kind) => {
      const { d, c, t } = setup(0);
      c.informationQueries = ['GP registration'];
      c.sourceFailures = ['processing:jev_unavailable'];
      const result = await t.invoke(
        { context: c } as never,
        JSON.stringify({
          kind,
          text: '我这边的房源搜索没能正常跑起来，你手上有具体想核对的房源吗？',
          refs: ['k1'],
        }),
      );
      expect(result).toContain('No recorded source failure');
      expect(d.repos.outbound.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    '如果搜索失败，可以稍后再试。你更方便周六还是周日？',
    '房源不能养猫。你是否还考虑其他区域？',
    'If the search fails, try again later. Which day works?',
  ])(
    'keeps conditional advice and property constraints distinct from source outages: %s',
    async (text) => {
      const { d, c, t } = setup(0);
      await t.invoke(
        { context: c } as never,
        JSON.stringify({ kind: 'clarification', text, refs: [] }),
      );
      expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    },
  );
  it('allows a factual source failure while rejecting conditional wording placed after an invented outage', async () => {
    const { d, c, t } = setup(0);
    const input = {
      kind: 'clarification',
      text: '搜索接口报错，如果稍后恢复可以再查。你更方便哪天？',
      refs: [],
    };
    expect(await t.invoke({ context: c } as never, JSON.stringify(input))).toContain(
      'No recorded source failure',
    );
    c.sourceFailures = ['information:timeout'];
    await t.invoke({ context: c } as never, JSON.stringify(input));
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('requires an actual search before claiming a marketplace search failed or found nothing', async () => {
    const { d, c } = setup(0);
    bindCurrentRequest(c, 'E14收书桌，50镑以内');
    Object.assign(d, { answerRequests: true, marketSearch: { find: vi.fn(), detail: vi.fn() } });
    const tool = replyToRequestTool(d as never);
    const result = await tool.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'no_match', refs: [], text: '搜索接口报错，没有找到结果。' }),
    );
    expect(result).toContain('search');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    expect(c.outboundInputFailures).toBeUndefined();
  });
  it('can explain no confirmed match after revisiting saved source details without pretending a broad search', async () => {
    const { d, c } = setup(0);
    bindCurrentRequest(c, 'E14收书桌');
    c.marketDetailIds = ['saved-desk'];
    Object.assign(d, { answerRequests: true, marketSearch: { find: vi.fn(), detail: vi.fn() } });
    await replyToRequestTool(d as never).invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'no_match',
        refs: [],
        text: '复查的旧线索还不能确认可用，可以再找其他在售信息。',
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('recognizes the actual Xiaohongshu failure key when explaining a failed source query', async () => {
    const { d, c, t } = setup(0);
    c.sourceFailures = ['xiaohongshu:timeout'];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'unavailable',
        refs: [],
        text: '小红书搜索失败，这次没能核对到展览信息，可以稍后重试。',
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('supplies the selected post timestamp and London check date to Jev without fabricating an original repost date', async () => {
    const { d, c, t } = setup(2);
    bindCurrentRequest(c, 'E14收书桌，50镑以内');
    c.marketPlan = {
      intent: 'second_hand',
      needs: [{ id: 'desk', terms: ['书桌'] }],
      preferences: [],
      budget: 50,
    };
    c.marketListings = [
      {
        id: 'desk',
        ref: 'm1',
        title: 'E14书桌',
        description: '出售书桌一张，£40，伦敦E14自提。',
        priceLabel: '£40',
        tradeType: 'SELL',
        status: 'ON_SALE',
        tags: [],
        url: 'https://a2hmarket.ai/listings/desk',
        sourceUrl: null,
        isRepost: false,
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: '2026-10-16T00:00:00Z',
      },
    ];
    const needsApproval = t.needsApproval;
    if (typeof needsApproval !== 'function') throw new Error('expected outbound gate');
    const args = { kind: 'partial', refs: ['m1'], text: '这张书桌报价符合预算。' };
    await needsApproval({ context: c } as never, args, 'source-metadata');
    const verdictInput = (d.evaluateOutbound.mock.calls[0] as unknown as [unknown, unknown])[1];
    expect(JSON.stringify(verdictInput)).toContain('2026-10-16T00:00:00Z');
    expect(JSON.stringify(verdictInput)).toContain('Europe/London');
    c.marketListings[0]!.isRepost = true;
    d.evaluateOutbound.mockClear();
    await needsApproval({ context: c } as never, args, 'missing-original-date');
    expect(JSON.stringify(d.evaluateOutbound.mock.calls)).not.toContain('2026-10-16T00:00:00Z');
    c.task = taskSchema.parse({
      id: 'task',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '找书桌',
      status: 'active',
      revision: 1,
      goals: [],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    c.taskUpdate = { kind: 'continued' };
    c.task.constraints = [
      {
        key: 'max_travel_minutes',
        strength: 'hard',
        value: { kind: 'duration', minutes: 30 },
        origin: { kind: 'user', sourceMessageId: 'prior' },
      },
    ];
    const before = d.repos.outbound.create.mock.calls.length;
    const reassurance = await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, text: '都在E14，半小时内应该没问题。' }),
    );
    expect(reassurance).toContain('Journey duration has not been verified');
    expect(d.repos.outbound.create.mock.calls).toHaveLength(before);

    await t.invoke({ context: c } as never, JSON.stringify(args));
    const brief = (d.repos.outbound.create.mock.calls.at(-1)?.[0] as { text: string }).text;
    expect(brief).not.toContain('【优先看】');
    expect(brief).toContain('https://a2hmarket.ai/listings/desk');
    c.currentRequest!.text = '展开详细资料';
    await t.invoke({ context: c } as never, JSON.stringify(args));
    const expanded = (d.repos.outbound.create.mock.calls.at(-1)?.[0] as { text: string }).text;
    expect(expanded).toContain('【优先看】');
    expect(brief.length).toBeLessThan(expanded.length);
  });
  it('returns eligible refs after a mixed valid/conflicting selection without silently rewriting it', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, 'Stratford找一居室，月租1600镑');
    c.marketPlan = {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室'] }],
      budget: 1600,
      preferences: [],
      requiredArea: ['Stratford'],
    };
    const listing = {
      id: 'home',
      ref: 'm1',
      title: 'Stratford一居室整租',
      description: '出租：伦敦Stratford一居室整租\n费用：月租£1550\n地点：Stratford',
      priceLabel: '£1550/月',
      tradeType: 'SELL' as const,
      status: 'ON_SALE',
      tags: [],
      url: 'https://a2hmarket.ai/listings/home',
      sourceUrl: null,
      isRepost: false,
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: null,
      createdAt: null,
    };
    c.marketListings = [
      listing,
      {
        ...listing,
        id: 'expensive',
        ref: 'm2',
        description: '出租：伦敦Stratford一居室整租，月租£1800',
        priceLabel: '£1800/月',
        url: 'https://a2hmarket.ai/listings/expensive',
      },
    ];
    const rejected = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1', 'm2'],
        text: '这两条可以比较。',
      }),
    );
    expect(rejected).toContain('"eligible":[{"ref":"m1"');
    expect(rejected).toContain('"excludedRefs":["m2"]');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
    expect(c.outboundBlocked).not.toBe(true);
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1'],
        text: '先看这条月租符合预算的房源。',
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('does not claim an unknown rent-plus-bills total fits a rent-only budget', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, 'Stratford找一居室，月租1600镑');
    c.currentRequest!.demand.budgetScope = 'rent_only';
    c.marketPlan = {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室'] }],
      budget: 1600,
      preferences: [],
      requiredArea: ['Stratford'],
    };
    c.marketListings = [
      {
        id: 'home',
        ref: 'm1',
        title: 'Stratford一居室整租',
        description: '出租：Stratford一居室整租\n费用：月租£1550，不含账单\n地点：Stratford',
        priceLabel: '£1550/月',
        tradeType: 'SELL',
        status: 'ON_SALE',
        tags: [],
        url: 'https://a2hmarket.ai/listings/home',
        sourceUrl: null,
        isRepost: false,
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ];
    const bad = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1'],
        text: '实际每月总支出会比房租高，但仍在预算范围内。',
      }),
    );
    expect(bad).toContain('total');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    c.marketPlan.budgetScope = 'all_in';
    const blanket = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1'],
        text: '这套符合你的硬条件，但账单还需要确认。',
      }),
    );
    expect(blanket).toContain('No selected lead has all essential conditions confirmed');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    c.marketPlan.budgetScope = 'rent_only';

    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        refs: ['m1'],
        text: '房租符合预算，账单另算，总支出目前还未核实。',
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('accepts a structural reference to the first cited option without accepting an invented price', async () => {
    const { d, c, t } = setup(0);
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, text: '我会先看第1条官方说明：没有NHS number也能注册GP。' }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, text: '第1条官方说明注册需要£15。' }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('does not treat the platform name A2H as a numerical factual claim', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, '找允许养猫的一居室');
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'no_match',
        refs: [],
        text: '这次在A2H没有确认到允许养猫的房源，我会优先核对原帖的宠物许可。你还接受哪些相邻区域？',
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('keeps source-checked task answers deliverable while ledger progress is incomplete', async () => {
    const { d, c } = setup(0);
    Object.assign(d, { taskRequests: true });
    c.task = taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '注册GP',
      status: 'active',
      revision: 0,
      goals: [],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    const tool = replyToRequestTool(d as never);
    await tool.invoke({ context: c } as never, JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    expect(c.taskProgressVersion).toBeUndefined();
    expect(c.outboundBlocked).not.toBe(true);
  });
  it('retains later source facts for Jev when a single relevant item does not need bundle filtering', async () => {
    const { d, c, t } = setup(2);
    bindCurrentRequest(c, '伦敦收无线激光打印机，预算60镑');
    c.marketTarget = 'SELL';
    c.marketPlan = {
      intent: 'second_hand',
      needs: [{ id: 'printer', terms: ['打印机'] }],
      budget: 60,
      preferences: ['无线'],
    };
    c.marketListings = [
      {
        ref: 'm1',
        id: 'printer',
        title: '伦敦激光打印机',
        description:
          '出售：HP激光打印机\n价格：£50\n地点：E14 自提\n' +
          '普通使用说明。'.repeat(60) +
          '\n原帖明确：支持无线打印。',
        tags: [],
        tradeType: 'SELL',
        status: 'ON_SALE',
        url: 'https://a2hmarket.ai/listings/printer',
        sourceUrl: null,
        isRepost: false,
        priceLabel: '£50',
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ];
    await t.needsApproval(
      { context: c } as never,
      {
        kind: 'partial',
        text: '我先看m1这条，原帖写支持无线打印，收货前可以请贴主演示。',
        refs: ['m1'],
      },
      'long-source',
    );
    const input = d.evaluateOutbound.mock.calls[0] as unknown as [
      unknown,
      { supplierSummaries: string[]; draft: string },
    ];
    expect(input[1].draft).toContain('伦敦激光打印机这条');
    expect(input[1].supplierSummaries.join('\n')).toContain('支持无线打印');
    expect(JSON.stringify(input[1])).not.toContain('m1这条');
  });
  it('renders only the affordable item from a bundle under separate task budgets', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, 'E14买书桌和办公椅，桌子70镑，椅子50镑');
    c.marketTarget = 'SELL';
    c.marketPlan = {
      intent: 'second_hand',
      needs: [
        { id: 'desk', terms: ['书桌'], budget: 70 },
        { id: 'chair', terms: ['办公椅'], budget: 50 },
      ],
      preferences: [],
      requiredArea: ['E14'],
    };
    c.marketListings = [
      {
        ref: 'm1',
        id: 'bundle',
        title: '伦敦桌椅',
        description: '- 书桌｜£60\n- 办公椅｜£65\n地点：E14 自提',
        tags: [],
        tradeType: 'SELL',
        status: 'ON_SALE',
        url: 'https://a2hmarket.ai/listings/bundle',
        sourceUrl: null,
        isRepost: false,
        priceLabel: '帖子报价',
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'partial', text: '我会先看这张书桌，椅子还要继续找。', refs: ['m1'] }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('£60');
    expect(draft.text).not.toContain('£65');
    expect(draft.text).toContain('办公椅还没有可推荐的');
  });
  it('does not match a smaller price as a substring of another price', async () => {
    const { d, c, t } = setup(0);
    c.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'NHS price example',
          url: 'https://www.nhs.uk/example',
          text: 'Example price is £135.',
        },
        1,
      ),
    ];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'answer', text: '费用35镑。', refs: ['k1'] }),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not invent an airport departure time from unrelated numeric evidence', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, '住E14，早上8点希思罗航班，两件行李');
    c.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'Heathrow',
          url: 'https://www.heathrow.com/transport',
          text: 'Fares £5.15. Trains every 15 minutes. Check your actual journey.',
        },
        1,
      ),
    ];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'answer', text: '建议5:15出发。', refs: ['k1'] }),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('allows a gated failure explanation after modern input exhaustion without marking a gate rejection', async () => {
    const { d, c, t } = setup(0);
    Object.assign(d, { answerRequests: true });
    for (let i = 0; i < 3; i++)
      await t.invoke({ context: c } as never, JSON.stringify({ ...args, refs: ['unknown'] }));
    expect(c.outboundBlocked).not.toBe(true);
    expect(c.answerInputExhausted).toBe(true);
    c.isAnswerFinalization = true;
    c.sourceFailures = ['processing:invalid_evidence'];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'unavailable',
        text: '这次没能完成可靠核对，请先确认2个条件。',
        refs: [],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it.each([
    [0, true, false, 'dry_run'],
    [1, true, true, 'pending'],
    [2, true, false, 'pending'],
    [2, false, true, 'pending'],
  ] as const)('preserves phase %i and Jev availability=%s', async (phase, ok, approval, status) => {
    const { d, c, t } = setup(phase, ok);
    expect(await t.needsApproval({ context: c } as never, args, 'call')).toBe(approval);
    await t.invoke({ context: c } as never, JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), status);
    if (phase === 2)
      expect(d.evaluateOutbound).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ demand: c.currentRequest?.demand }),
      );
  });
  it('declines rather than automatically sends when Jev is unavailable and review is disabled', async () => {
    const { d, c } = setup(2, false);
    d.env.OUTBOUND_UNSURE_ACTION = 'drop';
    const t = replyToRequestTool(d as never);
    await t.needsApproval({ context: c } as never, args, 'call');
    await t.invoke({ context: c } as never, JSON.stringify(args));
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it.each([
    { ...args, refs: ['invented'] },
    { ...args, text: '注册GP收费£300' },
    { ...args, text: '到https://evil.example注册' },
    { ...args, refs: [] },
  ])('rejects unsupported sources/facts/typed links', async (input) => {
    const { d, c, t } = setup(0);
    expect(await t.invoke({ context: c } as never, JSON.stringify(input))).toMatch(
      /^(?:Cite only|Remove|Call search_information)/,
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not treat valid citation IDs as numerical factual claims', async () => {
    const { d, c, t } = setup(0);
    const source = c.knowledgeSources![0]!;
    source.passages = [{ id: 'k1:p7', text: source.text }];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'answer',
        text: '没有NHS number也能免费注册。（k1:p7）',
        refs: ['k1:p7'],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).not.toContain('k1:p7');
  });
  it('returns a useful local no-match rather than a global absence claim', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, '伦敦收无线激光打印机，预算60镑');
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'no_match',
        text: '无线功能没有确认，可以先向贴主索要型号和无线打印视频。',
        refs: [],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
  });
  it('requires an actual failure before describing unavailability', async () => {
    const { d, c, t } = setup(0);
    const input = { kind: 'unavailable', text: '可以稍后重试这次查询。', refs: [] };
    expect(await t.invoke({ context: c } as never, JSON.stringify(input))).toContain(
      'no recorded source failure',
    );
    c.sourceFailures = ['xiaohongshu:rate_limited'];
    await t.invoke({ context: c } as never, JSON.stringify(input));
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
});

it('does not prepend an internal no-match verdict to a helpful answer', async () => {
  const { d, c, t } = setup(0);
  bindCurrentRequest(c, 'Stratford找一居室');
  c.marketQueries = ['Stratford 一居室'];
  const text = '这几条房源都没写月租，还没法按预算挑出合适的一套。';
  await t.invoke({ context: c } as never, JSON.stringify({ kind: 'no_match', refs: [], text }));
  const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
  expect(draft.text).toBe(text);
});

it('does not silently remove an unselected inline offer ref', async () => {
  const { d, c, t } = setup(0);
  bindCurrentRequest(c, 'E14收书桌，50镑以内');
  c.marketPlan = {
    intent: 'second_hand',
    needs: [{ id: 'desk', terms: ['书桌'] }],
    preferences: [],
    budget: 50,
  };
  c.marketListings = [
    {
      id: 'desk',
      ref: 'm1',
      title: 'E14书桌',
      description: '出售：伦敦E14书桌£40',
      priceLabel: '£40',
      tradeType: 'SELL',
      status: 'ON_SALE',
      tags: [],
      url: 'https://a2hmarket.ai/listings/desk',
      sourceUrl: null,
      isRepost: false,
      sourcePublishedAt: null,
      createdAt: null,
      availableFrom: null,
      availableUntil: null,
    },
  ];
  const result = await t.invoke(
    { context: c } as never,
    JSON.stringify({ kind: 'partial', refs: ['m1'], text: 'm2这条书桌更合适。' }),
  );
  expect(result).toContain('unselected inline refs');
  expect(d.repos.outbound.create).not.toHaveBeenCalled();
});

it('delivers sourced partial information without making a complete task ledger a prerequisite', async () => {
  const { c, d } = setup(0);
  c.task = taskSchema.parse({
    id: 'task',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: 'GP registration',
    status: 'active',
    revision: 1,
    goals: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
  const tool = replyToRequestTool({ ...d, taskRequests: true } as never);
  await tool.invoke({ context: c } as never, JSON.stringify({ ...args, kind: 'partial' }));
  expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  expect(c.taskProgressVersion).toBeUndefined();
});

describe('P35 citation budgets count sources rather than passages', () => {
  const cases = JSON.parse(
    readFileSync(new URL('../fixtures/p35-citation-count.json', import.meta.url), 'utf8'),
  ) as Array<{ refs: string[]; independentSources: number }>;
  function addSources(c: MatchContext, indices: number[]) {
    c.knowledgeSources = indices.map((index) =>
      createKnowledgeSource(
        {
          title: 'NHS registration',
          url: 'https://www.nhs.uk/register/' + index,
          text: Array.from(
            { length: 10 },
            () => 'You do not need an NHS number to register with a GP.',
          ).join('\n'),
        },
        index,
      ),
    );
  }
  it('accepts the real eight passage IDs while rendering only four source links', async () => {
    expect(cases.length).toBeGreaterThan(0);
    const fixture = cases[0]!;
    const { c, d, t } = setup(0);
    addSources(c, [2, 6, 7, 8]);
    const result = await t.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'partial', text: '没有NHS number也能注册GP。', refs: fixture.refs }),
    );
    expect(String(result)).not.toContain('invalid');
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const draft = d.repos.outbound.create.mock.calls[0]?.[0] as { text: string };
    expect(draft.text.match(/https:\/\/www.nhs.uk/g)).toHaveLength(4);
  });
  it('still rejects seven independent sources, including inline references', async () => {
    const { c, d, t } = setup(0);
    addSources(c, [1, 2, 3, 4, 5, 6, 7]);
    const result = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        text: '没有NHS number也能注册GP。k7',
        refs: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'],
      }),
    );
    expect(String(result)).toContain('6');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not hide a nonexistent passage by merging it into a valid source', async () => {
    const { c, d, t } = setup(0);
    addSources(c, [1]);
    const result = await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'partial',
        text: '没有NHS number也能注册GP。',
        refs: ['k1:p1', 'k1:p99'],
      }),
    );
    expect(String(result)).toContain('returned source');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});

it('keeps validation feedback in request context when an aborted run cannot persist tool history', async () => {
  const { c, t } = setup(0);
  await t.invoke({ context: c } as never, JSON.stringify({ ...args, text: '注册要999英镑。' }));
  expect(c.outboundInputFailures).toMatchObject({
    tool: 'reply_to_request',
    count: 1,
    feedback: [expect.stringContaining('999')],
  });
});

describe('source link line', () => {
  // 2026-10-21 run 6: a TaskRabbit result carried a 400-character utm/gclid query into the card.
  it('drops ad-tracking parameters but keeps the parameters a page needs', () => {
    expect(
      cleanSourceUrl(
        'https://www.taskrabbit.com/services/furniture-disassembly?utm_source=pd_search&utm_medium=ggl&gclid=abc',
      ),
    ).toBe('https://www.taskrabbit.com/services/furniture-disassembly');
    expect(cleanSourceUrl('https://www.xiaohongshu.com/explore/6aa0?xsec_token=YB&utm_x=1')).toBe(
      'https://www.xiaohongshu.com/explore/6aa0?xsec_token=YB',
    );
    expect(cleanSourceUrl('not a url')).toBe('not a url');
    expect(
      renderSourceLinks([
        { title: 'Furniture Disassembly Services', url: 'https://t.co/a?gclid=1' },
      ]),
    ).toBe('[Furniture Disassembly Services](https://t.co/a)');
  });
});

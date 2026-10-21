import { describe, it, expect } from 'vitest';
import type { MarketListing } from '@matchbot/websearch';
import { assessMarketListing, rankMarketListings, toMarketPlan } from '../src/market-strategy.js';
import type { MarketPlan } from '../src/market-strategy.js';
const listing = (description: string, id = 'a'): MarketListing => ({
  id,
  title: '伦敦出闲置',
  description,
  tags: [],
  tradeType: 'SELL',
  status: 'ON_SALE',
  url: `https://a2hmarket.ai/listings/${id}`,
  sourceUrl: null,
  isRepost: false,
  priceLabel: '帖子未标价',
  availableFrom: null,
  availableUntil: null,
  sourcePublishedAt: null,
  createdAt: null,
});
const plan: MarketPlan = {
  intent: 'second_hand',
  needs: [{ id: 'desk', terms: ['书桌'] }],
  preferences: [],
  budget: 50,
  requiredArea: ['E14'],
};
describe('source-grounded market strategy', () => {
  it('reads a thousands separator in a monthly rent', () => {
    const result = assessMarketListing(
      { ...listing('出租：West Ham E16 Ensuite\n租金：£1,230/月'), title: '伦敦合租' },
      {
        intent: 'housing',
        needs: [{ id: 'room', terms: ['合租', 'ensuite'] }],
        preferences: [],
        budget: 1000,
        budgetUnit: 'month',
      },
    );
    expect(result.itemPriceGBP).toEqual({ min: 1230, max: 1230 });
    expect(result.checks.find((c) => c.label === 'budget')?.status).toBe('mismatch');
  });
  it.each([
    ['出租：Stratford E15 单间\n租金：£850/月', 'met'],
    ['出租：Hackney 单间 近地铁\n租金：£900/月', 'met'],
    ['地点：E3 Bow Road', 'met'],
    ['出租：Clapham SW4 单间\n租金：£800/月', 'mismatch'],
    ['出租：东伦敦 SE12 单间\n租金：£700/月', 'unknown'],
    ['出租：单间 近地铁\n租金：£800/月', 'unknown'],
  ] as const)('reads 东伦敦 as E postcodes and east districts: %s → %s', (description, status) => {
    const result = assessMarketListing(
      { ...listing(description), title: '伦敦合租' },
      {
        intent: 'housing',
        needs: [{ id: 'room', terms: ['单间', '合租'] }],
        preferences: [],
        budget: 1000,
        requiredArea: ['东伦敦'],
      },
    );
    expect(result.checks.find((c) => c.label === 'area')?.status).toBe(status);
  });
  it.each([
    ['租金：£465pw', 'month', 'mismatch'],
    ['租金：周租£465', 'month', 'mismatch'],
    ['租金：465pw', 'month', 'mismatch'],
    ['租金：£335 per week', 'month', 'unknown'],
    ['租金：约£465pw', 'month', 'unknown'],
    ['押金：£465pw', 'month', 'unknown'],
    ['租金：€465pw', 'month', 'unknown'],
    ['租金：£335-465pw', 'month', 'unknown'],
    ['租金：£465pw', 'total', 'unknown'],
  ] as const)('compares weekly housing quotes conservatively: %s (%s)', (quote, unit, status) => {
    const result = assessMarketListing(
      { ...listing('出租：Stratford一居室整租\n' + quote), title: 'Stratford一居室' },
      {
        intent: 'housing',
        needs: [{ id: 'home', terms: ['一居室'] }],
        preferences: [],
        budget: 1600,
        budgetUnit: unit,
        budgetScope: 'all_in',
      },
    );
    expect(result.checks.find((c) => c.label === 'budget')?.status).toBe(status);
    // A four-week lower bound excludes an over-cap quote; it is not a quoted monthly rent.
    expect(result.itemPriceGBP).toBeUndefined();
    if (status === 'mismatch')
      expect(result.checks.find((c) => c.label === 'budget')?.evidence).toContain(quote);
  });
  it.each(['不接受初学者和零基础', '不收初学者', '谢绝新手', '仅限中级及以上'])(
    'excludes an explicit beginner conflict: %s',
    (restriction) => {
      const candidate = {
        ...listing('伦敦E14，周日下午室内羽毛球。' + restriction),
        title: 'E14羽毛球搭子',
        tradeType: 'PEER' as const,
      };
      const result = assessMarketListing(candidate, {
        intent: 'companion',
        needs: [{ id: 'bad', terms: ['羽毛球'] }],
        preferences: ['初学者'],
        essentialPreferences: ['初学者'],
      });
      expect(result.checks).toContainEqual(
        expect.objectContaining({ label: 'skill', status: 'mismatch' }),
      );
    },
  );
  it('does not turn a beginner welcome or an unknown level into an explicit skill conflict', () => {
    for (const statement of ['欢迎初学者和零基础', '水平要求待确认']) {
      const candidate = {
        ...listing('伦敦E14羽毛球。' + statement),
        title: '羽毛球搭子',
        tradeType: 'PEER' as const,
      };
      const result = assessMarketListing(candidate, {
        intent: 'companion',
        needs: [{ id: 'bad', terms: ['羽毛球'] }],
        preferences: ['初学者'],
      });
      expect(result.checks.some((c) => c.label === 'skill' && c.status === 'mismatch')).toBe(false);
    }
  });
  it('recognises a stated monthly rent excluding bills without treating the rent as all-in', () => {
    const n = {
      ...listing('出租：伦敦Stratford一居室整租\n费用：月租£1550，不含账单\n地点：Stratford'),
      title: 'Stratford一居室',
    };
    const result = assessMarketListing(n, {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室'] }],
      preferences: ['包账单'],
      budget: 1600,
    });
    expect(result.checks.find((c) => c.label === 'budget')?.status).toBe('met');
    expect(result.itemPriceEvidence).toContain('不含账单');
  });
  it('rejects explicit opposition to a hard pet condition without treating an unknown permission as a conflict', () => {
    const p: MarketPlan = {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室'] }],
      preferences: ['猫'],
      essentialPreferences: ['猫'],
    };
    for (const statement of ['不允许养猫', '禁止宠物，包括猫', 'no cats allowed']) {
      const n = { ...listing('出租：伦敦一居室\n要求：' + statement), title: '一居室' };
      expect(assessMarketListing(n, p).checks.some((c) => c.status === 'mismatch')).toBe(true);
    }
    const unknown = { ...listing('出租：伦敦一居室\n要求：是否能养猫待确认'), title: '一居室' };
    expect(assessMarketListing(unknown, p).checks).toContainEqual({
      label: 'preference:猫',
      status: 'unknown',
      evidence: null,
    });
    expect(assessMarketListing(unknown, p).checks.some((c) => c.status === 'mismatch')).toBe(false);
  });
  it('keeps separate item budgets and retains only the valid part of a mixed bundle', () => {
    const separate: MarketPlan = {
      ...plan,
      budget: 100,
      needs: [
        { id: 'desk', terms: ['书桌'], budget: 70 },
        { id: 'chair', terms: ['办公椅'], budget: 50 },
      ],
    };
    const n = listing('- 书桌｜£60\n- 办公椅｜£65\n地点：E14 自提');
    const result = assessMarketListing(n, separate);
    expect(result.needs).toEqual(['desk']);
    expect(result.itemPriceEvidence).toContain('书桌');
    expect(result.itemPriceEvidence).not.toContain('办公椅');
    expect(result.checks).toContainEqual({
      label: 'budget',
      status: 'met',
      evidence: '- 书桌｜£60',
    });
    const chair = assessMarketListing(n, separate, '办公椅');
    expect(chair.checks.some((c) => c.label === 'budget' && c.status === 'mismatch')).toBe(true);
  });
  it('checks each quote against its own cap when both items fit', () => {
    const separate: MarketPlan = {
      ...plan,
      needs: [
        { id: 'desk', terms: ['书桌'], budget: 70 },
        { id: 'chair', terms: ['办公椅'], budget: 50 },
      ],
    };
    const result = assessMarketListing(
      listing('- 书桌｜£60\n- 办公椅｜£45\n地点：E14 自提'),
      separate,
    );
    expect(result.needs).toEqual(['desk', 'chair']);
    expect(result.checks.filter((c) => c.label === 'budget').map((c) => c.status)).toEqual([
      'met',
      'met',
    ]);
  });
  it('does not declare an estimated rent lower bound within the monthly budget', () => {
    const n = {
      ...listing('转租：Stratford一居室公寓\n价格：租金预算估计在£400以上/月'),
      title: 'Stratford转租1b1b',
    };
    const result = assessMarketListing(n, {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室', '1b1b'] }],
      preferences: [],
      budget: 1600,
    });
    expect(result.checks).toContainEqual({
      label: 'budget',
      status: 'unknown',
      evidence: '价格：租金预算估计在£400以上/月',
    });
  });
  it('retains both desk and chair from the current request if the model omits one', () => {
    const p = toMarketPlan(
      {
        intent: 'second_hand',
        needs: [{ id: 'chair', terms: ['办公椅'] }],
        preferences: [],
        requiredArea: [],
        requiredTerms: [],
        excludeTerms: [],
        budget: 500,
        route: null,
        dateRange: null,
      },
      'E14想收书桌和办公椅，每件50镑以内，能自提。',
    );
    expect(p.needs.flatMap((n) => n.terms)).toContain('书桌');
    expect(p.needs.flatMap((n) => n.terms)).toContain('办公椅');
    expect(p.needs.flatMap((n) => n.terms)).toContain('办公桌');
    expect(p.budget).toBe(50);
  });
  it('keeps must-support-wireless even when the model omits it', () => {
    const p = toMarketPlan(
      {
        intent: 'second_hand',
        needs: [{ id: 'printer', terms: ['打印机'] }],
        preferences: [],
        requiredArea: [],
        requiredTerms: [],
        excludeTerms: [],
        budget: 60,
        route: null,
        dateRange: null,
      },
      '伦敦收激光打印机，预算60镑，必须支持无线打印。',
    );
    expect(p.requiredTerms).toContain('无线');
    expect(assessMarketListing(listing('- HP激光打印机｜£50'), p).checks).toContainEqual({
      label: 'required',
      status: 'unknown',
      evidence: null,
    });
  });
  it('binds explicit day and outcode to the original request instead of model preferences/range', () => {
    const p = toMarketPlan(
      {
        intent: 'carry',
        needs: [{ id: 'carry', terms: ['帮带'] }],
        preferences: ['E14'],
        requiredArea: [],
        requiredTerms: [],
        excludeTerms: [],
        budget: null,
        route: { from: ['伦敦'], to: ['上海'] },
        dateRange: { from: '2026-10-25', to: '2026-11-08' },
      },
      '我2026年11月1日伦敦飞上海，有2公斤空余行李，帮我找需求方',
    );
    expect(p.dateRange).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    const area = toMarketPlan(
      {
        intent: 'second_hand',
        needs: [{ id: 'desk', terms: ['书桌'] }],
        preferences: ['E14', '自提'],
        requiredArea: [],
        requiredTerms: [],
        excludeTerms: [],
        budget: 50,
        route: null,
        dateRange: null,
      },
      'E14想收书桌，每件50镑以内，能自提',
    );
    expect(area.requiredArea).toContain('E14');
    expect(area.essentialPreferences).not.toContain('E14');
  });
  it('does not borrow wireless from a sibling item, and rejects a known wrong month or excess load', () => {
    const plan = {
      intent: 'second_hand' as const,
      needs: [{ id: 'printer', terms: ['激光打印机'] }],
      preferences: [],
      requiredTerms: ['激光', '无线'],
      budget: 60,
    };
    const checked = assessMarketListing(listing('- HP激光打印机｜£50\n- 无线螺丝刀｜£15'), plan);
    expect(checked.checks).toContainEqual(
      expect.objectContaining({ label: 'required', status: 'unknown' }),
    );
    const carry = {
      intent: 'carry' as const,
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      capacityKg: 2,
      dateRange: { from: '2026-11-01', to: '2026-11-01' },
    };
    const trip = assessMarketListing(
      listing('求帮带：10月中下旬英国回国，求帮带约8kg行李回国\n时间：10月中下旬'),
      carry,
    );
    expect(trip.checks).toContainEqual(
      expect.objectContaining({ label: 'date', status: 'mismatch' }),
    );
    expect(trip.checks).toContainEqual(
      expect.objectContaining({ label: 'capacity', status: 'mismatch' }),
    );
  });
  it('keeps route words out of the core rather than requiring a literal full query', () => {
    const p = toMarketPlan({
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带 上海 伦敦', '上海 飞 伦敦 帮带'] }],
      preferences: [],
      requiredTerms: [],
      excludeTerms: [],
      requiredArea: [],
      budget: null,
      route: { from: ['上海'], to: ['伦敦'] },
      dateRange: null,
    });
    expect(p.needs[0]?.terms).toEqual(['帮带']);
    expect(
      assessMarketListing(listing('帮带：11月4日从上海飞往英国\n路线：上海 -> 伦敦'), p).needs,
    ).toEqual(['carry']);
  });
  it('does not invent exclusions or promote explicit preferences into hard constraints', () => {
    const p = toMarketPlan(
      {
        intent: 'second_hand',
        needs: [{ id: 'printer', terms: ['打印机'] }],
        preferences: [],
        requiredTerms: ['无线'],
        excludeTerms: ['墨盒', '回收'],
        requiredArea: [],
        budget: 60,
        route: null,
        dateRange: null,
      },
      '收打印机，预算60镑，最好无线',
    );
    expect(p.excludeTerms).toEqual([]);
    expect(p.requiredTerms).toEqual([]);
    expect(p.preferences).toContain('无线');
  });
  it('does not turn a preferred printer type into a hard requirement', () => {
    const p = toMarketPlan(
      {
        intent: 'second_hand',
        needs: [{ id: 'printer', terms: ['打印机'] }],
        preferences: [],
        requiredTerms: [],
        excludeTerms: [],
        requiredArea: [],
        budget: 60,
        route: null,
        dateRange: null,
      },
      '伦敦收打印机，最好激光打印机',
    );
    expect(p.requiredTerms).not.toContain('激光');
    expect(p.essentialPreferences).not.toContain('激光打印机');
  });
  it('accepts an explicit London outcode as city evidence while keeping the stated item type essential', () => {
    const p = toMarketPlan(
      {
        intent: 'second_hand',
        needs: [{ id: 'printer', terms: ['激光打印机', '打印机'] }],
        preferences: [],
        requiredTerms: [],
        excludeTerms: [],
        requiredArea: ['伦敦'],
        budget: 60,
        route: null,
        dateRange: null,
      },
      '伦敦收激光打印机，预算60镑',
    );
    const row = assessMarketListing(listing('地点：狗岛 Canary Wharf (E14)\n- 激光打印机｜£40'), p);
    expect(row.checks).toContainEqual(expect.objectContaining({ label: 'area', status: 'met' }));
    expect(p.requiredTerms).toContain('激光');
  });
  it('retains a companion weekend and beginner level even if the model omitted them', () => {
    const p = toMarketPlan(
      {
        intent: 'companion',
        needs: [{ id: 'sport', terms: ['羽毛球'] }],
        preferences: [],
        requiredTerms: [],
        excludeTerms: [],
        requiredArea: [],
        budget: null,
        route: null,
        dateRange: null,
      },
      '伦敦周末找羽毛球搭子，初学者',
    );
    expect(p.essentialPreferences).toEqual(['周末', '初学者']);
  });
  it('preserves housing move-in and essential preferences separately from explicit soft preferences', () => {
    const input = {
      intent: 'housing' as const,
      needs: [{ id: 'room', terms: ['单间'] }],
      preferences: ['长租', '包bill'],
      requiredTerms: [],
      excludeTerms: [],
      requiredArea: [],
      budget: 1200,
      route: null,
      dateRange: null,
    };
    const p = toMarketPlan(input, '找长租单间，11月初入住，最好包bill');
    expect(p.preferences).toEqual(['长租', '包bill', '11月初入住']);
    expect(p.essentialPreferences).toEqual(['长租', '11月初入住']);
    expect(p.dateRange).toBeUndefined();
  });
  it('retains an explicit carry month even when the model omits dateRange', () => {
    const p = toMarketPlan(
      {
        intent: 'carry',
        needs: [{ id: 'carry', terms: ['帮带'] }],
        preferences: [],
        requiredTerms: [],
        excludeTerms: [],
        requiredArea: [],
        budget: null,
        route: { from: ['上海'], to: ['伦敦'] },
        dateRange: null,
      },
      '找2026年11月上海飞伦敦帮带',
    );
    expect(p.dateRange).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(
      assessMarketListing(listing('时间：10月27日\n帮带：10月27日上海飞伦敦，11月9日回上海'), p)
        .checks,
    ).toContainEqual(expect.objectContaining({ label: 'date', status: 'mismatch' }));
  });
  it('does not interpret fee decimals or enumerated route legs as a matching future trip', () => {
    const row = assessMarketListing(
      listing(
        '时间：10月23日\n去程：10月12日晚伦敦飞，13日晚抵上海；回程：10月23日早北京飞，23日晚抵伦敦\n- 帮带｜0.2-0.5kg: 100rmb｜提供伦敦至上海、北京至伦敦的往返行李额帮带服务',
      ),
      {
        intent: 'carry',
        needs: [{ id: 'carry', terms: ['帮带'] }],
        preferences: [],
        route: { from: ['上海'], to: ['伦敦'] },
        dateRange: { from: '2026-11-01', to: '2026-11-30' },
      },
    );
    expect(row.checks).toContainEqual(
      expect.objectContaining({ label: 'date', status: 'mismatch' }),
    );
    expect(row.checks).not.toContainEqual(
      expect.objectContaining({ label: 'route', status: 'met' }),
    );
  });
  it('keeps beginner skill out of core needs and ignores imported hobby-as-invitation summaries', () => {
    const p = toMarketPlan(
      {
        intent: 'companion',
        needs: [
          { id: 'sport', terms: ['羽毛球'] },
          { id: 'skill', terms: ['初学者', '新手', 'beginner'] },
        ],
        preferences: ['周末'],
        requiredTerms: [],
        excludeTerms: [],
        requiredArea: [],
        budget: null,
        route: null,
        dateRange: null,
      },
      '伦敦周末找羽毛球搭子，初学者',
    );
    expect(p.needs).toHaveLength(1);
    expect(p.preferences).toContain('初学者');
    const n = {
      ...listing(
        '活动：逛公园、打羽毛球\n——原帖原文——\n找朋友一起逛公园。\n爱好是打羽毛球和看电视剧，羽毛球是新手水平。',
      ),
      title: '伦敦找朋友一起逛公园',
      tradeType: 'PEER' as const,
    };
    expect(assessMarketListing(n, p).needs).toEqual([]);
  });
  it('does not recommend explicitly non-beginner sessions to a beginner', () => {
    const row = assessMarketListing(
      {
        ...listing(
          '活动：伦敦羽毛球搭子\n——原帖原文——\n周六一起打羽毛球。\n非新手局，有一定基础再来～',
        ),
        tradeType: 'PEER',
      },
      {
        intent: 'companion',
        needs: [{ id: 'badminton', terms: ['羽毛球'] }],
        preferences: ['初学者'],
      },
    );
    expect(row.checks).toContainEqual(
      expect.objectContaining({ label: 'skill', status: 'mismatch' }),
    );
  });
  it('compares a buyer request against the seller price in the correct direction', () => {
    const buyer = { ...listing('- 书桌｜£100'), tradeType: 'BUY' as const };
    expect(assessMarketListing(buyer, plan).checks.find((c) => c.label === 'budget')?.status).toBe(
      'met',
    );
    expect(
      assessMarketListing({ ...buyer, description: '- 书桌｜£20' }, plan).checks.find(
        (c) => c.label === 'budget',
      )?.status,
    ).toBe('mismatch');
  });
  it('does not mistake per-weight carry fees for the user total budget', () => {
    const row = assessMarketListing(listing('帮带：伦敦上海\n- 帮带｜£10/kg'), {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      budget: 30,
    });
    expect(row.checks.find((c) => c.label === 'budget')?.status).toBe('unknown');
  });
  it('does not borrow the chair price to satisfy a desk budget', () => {
    const row = assessMarketListing(
      listing('出售：书桌、椅子\n地点：E14\n- 书桌｜£120\n- 椅子｜£10'),
      plan,
    );
    expect(row.checks.find((c) => c.label === 'budget')?.status).toBe('mismatch');
    expect(row.itemPriceEvidence).toBe('- 书桌｜£120');
  });
  it('finds an affordable sibling item but binds the final quote to the selected name', () => {
    const n = listing('出售：书桌\n地点：E14\n- 大书桌｜£120\n- 小书桌｜£30');
    expect(assessMarketListing(n, plan).checks.find((c) => c.label === 'budget')?.status).toBe(
      'met',
    );
    expect(
      assessMarketListing(n, plan, '大书桌').checks.find((c) => c.label === 'budget')?.status,
    ).toBe('mismatch');
    expect(assessMarketListing(n, plan, '小书桌').itemPriceEvidence).toBe('- 小书桌｜£30');
  });
  it('preserves unknown item prices instead of assigning a post price range', () => {
    const row = assessMarketListing(
      listing('出售：书桌、椅子等多件闲置，£1–£20\n- 书桌\n- 椅子｜£10'),
      plan,
    );
    expect(row.checks.find((c) => c.label === 'budget')?.status).toBe('unknown');
  });
  it('does not call an unnormalized neighborhood a definite postcode conflict', () => {
    const row = assessMarketListing(listing('出租：大房间\n地点：狗岛 (Isle of Dogs)'), {
      ...plan,
      intent: 'housing',
      needs: [{ id: 'room', terms: ['房间'] }],
    });
    expect(row.checks.find((c) => c.label === 'area')?.status).toBe('unknown');
    const wrong = assessMarketListing(listing('出售：书桌\n地点：E20 Stratford'), plan);
    expect(wrong.checks.find((c) => c.label === 'area')?.status).toBe('mismatch');
  });
  it('matches the upper endpoint of a same-item price range', () => {
    const row = assessMarketListing(listing('- 书桌｜£40–80'), plan);
    expect(row.checks.find((c) => c.label === 'budget')?.status).toBe('unknown');
  });
  it('covers both alternatives before filling the result slots', () => {
    const p = {
      ...plan,
      budget: undefined,
      requiredArea: [],
      needs: [
        { id: 'desk', terms: ['书桌'] },
        { id: 'chair', terms: ['办公椅'] },
      ],
    };
    const out = rankMarketListings(
      [listing('- 书桌', 'a'), listing('- 书桌', 'b'), listing('- 办公椅', 'c')],
      p as MarketPlan,
      2,
    );
    expect(out.map((r) => r.listing.id)).toEqual(['a', 'c']);
  });
  it('does not treat furnished rental descriptions as second-hand item offers', () => {
    expect(
      assessMarketListing(listing('出租：E14公寓，带书桌和办公椅\n- 公寓｜£2000'), plan).needs,
    ).toEqual([]);
  });
  it('keeps sold items out even when the bundle is still ON_SALE', () => {
    const row = assessMarketListing(
      listing('出售：书桌、椅子\n- 书桌｜£20｜❌已出\n- 椅子｜£10'),
      plan,
    );
    expect(row.checks.find((c) => c.label === 'availability')?.status).toBe('mismatch');
  });
  it('leaves undocumented preferences unconfirmed rather than claiming they are met', () => {
    const row = assessMarketListing(listing('出售：书桌\n- 书桌｜£30'), {
      ...plan,
      preferences: ['白色'],
    });
    expect(row.checks.find((c) => c.label === 'preference:白色')?.status).toBe('unknown');
  });
  it('does not use hobbies in a profile as a badminton invitation', () => {
    const p = {
      intent: 'companion',
      needs: [{ id: 'sport', terms: ['羽毛球'] }],
      preferences: [],
    } as const;
    const row = assessMarketListing(
      listing('找搭子：长期coffee chat\n个人背景：平时喜欢羽毛球'),
      p as unknown as MarketPlan,
    );
    expect(row.needs).toEqual([]);
  });
  it('binds the date to the offered route rather than a return trip', () => {
    const p: MarketPlan = {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      route: { from: ['上海'], to: ['伦敦'] },
      dateRange: { from: '2026-11-01', to: '2026-11-30' },
    };
    const row = assessMarketListing(
      listing('帮带：10月27日上海飞伦敦，11月9日回上海\n时间：去程10/27，回程11/9'),
      p,
    );
    expect(row.checks.find((c) => c.label === 'date')?.status).toBe('mismatch');
  });
  it('rejects a known wrong month and preserves a future return leg despite conflicting metadata', () => {
    const p: MarketPlan = {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      route: { from: ['上海'], to: ['伦敦'] },
      dateRange: { from: '2026-11-01', to: '2026-11-30' },
    };
    const stale = assessMarketListing(
      { ...listing('帮带：10月初上海飞伦敦\n时间：10月初'), availableUntil: '2026-10-31' },
      p,
    );
    expect(stale.checks.find((c) => c.label === 'date')?.status).toBe('mismatch');
    const future = assessMarketListing(
      {
        ...listing('帮带：上海到伦敦\n时间：10月17日\n- 往返帮带｜10.17✈️上海 11.1✈️伦敦'),
        availableUntil: '2026-10-17',
      },
      p,
    );
    expect(future.checks.find((c) => c.label === 'date')?.status).toBe('unknown');
    expect(future.checks.find((c) => c.label === 'date_conflict')?.status).toBe('unknown');
  });
  it('does not discard a clear future return leg because the imported expiry refers to a past outward leg', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    const year = future.getUTCFullYear();
    const n = {
      ...listing(
        `帮带：${year}年11月4日上海飞伦敦\n时间：${year - 2}年10月1日去程，${year}年11月4日返程`,
      ),
      availableUntil: '2020-01-01',
    };
    const row = assessMarketListing(n, {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
    });
    expect(row.checks.find((c) => c.label === 'availability')?.status).toBe('unknown');
    expect(
      assessMarketListing({ ...n, description: '- 书桌｜£20' }, plan).checks.find(
        (c) => c.label === 'availability',
      )?.status,
    ).toBe('mismatch');
  });
  it('rejects the reverse route and never silently supplies a missing year', () => {
    const p: MarketPlan = {
      intent: 'carry',
      needs: [{ id: 'carry', terms: ['帮带'] }],
      preferences: [],
      route: { from: ['伦敦'], to: ['上海'] },
      dateRange: { from: '2026-10-20', to: '2026-10-31' },
    };
    expect(
      assessMarketListing(listing('帮带：10月25日上海飛伦敦\n路线：上海 -> 伦敦'), p).checks.find(
        (c) => c.label === 'route',
      )?.status,
    ).toBe('mismatch');
    const good = assessMarketListing(listing('帮带：10月21日伦敦飞上海'), p);
    expect(good.checks.find((c) => c.label === 'route')?.status).toBe('met');
    expect(good.checks.find((c) => c.label === 'date')?.status).toBe('unknown');
  });
});

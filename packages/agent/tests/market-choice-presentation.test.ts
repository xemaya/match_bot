import { describe, expect, it } from 'vitest';
import { renderMarketChoiceReply } from '../src/market-choice-presentation.js';
import type { MarketCandidate } from '../src/market-research.js';
import { taskSchema } from '@matchbot/domain';
describe('market choice practical details', () => {
  it('does not show duplicate ledger unknowns as unknown quoted price/area while retaining unconfirmed eligibility', () => {
    const listing: MarketCandidate = {
      id: 'desk',
      ref: 'm1',
      title: 'E14书桌',
      description: '出售书桌一张，单价£40。地点：伦敦E14。支持自提。',
      tags: [],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/desk',
      sourceUrl: null,
      isRepost: false,
      priceLabel: '£40',
      sourcePublishedAt: null,
      createdAt: null,
      availableFrom: null,
      availableUntil: null,
    };
    const task = taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '找书桌',
      category: 'second_hand',
      status: 'active',
      revision: 1,
      goals: [
        {
          id: 'desk',
          title: '书桌',
          required: true,
          criteria: [
            {
              id: 's',
              label: '书桌',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
              constraintKey: null,
            },
            {
              id: 'b',
              label: '预算',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
              constraintKey: 'budget',
            },
            {
              id: 'a',
              label: '区域',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
              constraintKey: 'area',
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'budget',
          strength: 'hard',
          value: { kind: 'money', amountPence: 5000, unit: 'item' },
          origin: { kind: 'user', sourceMessageId: 'm' },
        },
        {
          key: 'area',
          strength: 'hard',
          value: { kind: 'location', area: 'E14' },
          origin: { kind: 'user', sourceMessageId: 'm' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    const { text, choices } = renderMarketChoiceReply({
      listings: [listing],
      selections: [{ ref: 'm1', name: listing.title, evidence: listing.description }],
      format: 'brief',
      assessWholeOffer: true,
      zh: true,
      plan: {
        intent: 'second_hand',
        needs: [{ id: 'desk', terms: ['书桌'] }],
        budget: 50,
        requiredArea: ['E14'],
        preferences: [],
      },
      task,
    });
    expect(choices.primary).toHaveLength(0);
    expect(text).toContain('待核实');
    expect(text).toContain('£40');
    expect(text).toContain('实际可用情况');
    expect(text).not.toContain('来源核对');
    expect(text).not.toMatch(/还需确认：.*(?:预算|地点)/);
  });
  it('shows a single paragraph only once while retaining its price, location, condition and links', () => {
    const description =
      '出售书桌一张，单价£40。桌面100×60cm，可拆卸，正常使用痕迹。地点：伦敦E14 Canary Wharf。支持自提。';
    const listing: MarketCandidate = {
      id: 'desk',
      ref: 'm1',
      title: 'E14书桌',
      description,
      tags: [],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/desk',
      sourceUrl: 'https://www.xiaohongshu.com/explore/desk',
      isRepost: true,
      priceLabel: '£40',
      sourcePublishedAt: '2026-10-16T00:00:00Z',
      createdAt: null,
      availableFrom: null,
      availableUntil: null,
    };
    const input: Parameters<typeof renderMarketChoiceReply>[0] = {
      listings: [listing],
      selections: [{ ref: 'm1', name: listing.title, evidence: description }],
      zh: true,
      plan: {
        intent: 'second_hand',
        needs: [{ id: 'desk', terms: ['书桌'] }],
        budget: 50,
        requiredArea: ['E14'],
        preferences: [],
      },
    };
    const { text } = renderMarketChoiceReply(input);
    expect(text.split('单价£40')).toHaveLength(2);
    expect(text.split('支持自提')).toHaveLength(2);
    expect(text).toContain('100×60cm');
    expect(text).toContain('正常使用痕迹');
    expect(text).toContain(listing.url);
    expect(text).toContain(listing.sourceUrl);
    const brief = renderMarketChoiceReply({ ...input, format: 'brief' }).text;
    expect(brief.length).toBeLessThan(text.length);
    expect(brief).toContain('£40');
    expect(brief).toContain('正常使用痕迹');
    expect(brief).toContain(listing.url);
    expect(brief).toContain(listing.sourceUrl);
    // Telegram deliberately interprets links only on code-generated Source lines.
    expect(brief).toMatch(/^来源：\[A2H详情\]/m);
    expect(brief).not.toContain('相关线索');
  });
  it('shows the room term and layout from its own source without converting that to confirmed move-in', () => {
    const listing: MarketCandidate = {
      id: 'listing_a',
      ref: 'm1',
      title: '伦敦E14单间',
      description:
        '转租：E14单间\n时间：9月29日起可入住，租期至2027年9月9日\n户型：3人合租，与1人共用卫生间\n地点：E14\n- 单间｜£1100/月',
      tags: [],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/listing_a',
      sourceUrl: null,
      isRepost: false,
      priceLabel: '帖子未标价',
      sourcePublishedAt: null,
      createdAt: null,
      availableFrom: null,
      availableUntil: null,
    };
    const { text, choices } = renderMarketChoiceReply({
      listings: [listing],
      selections: [{ ref: 'm1', name: '单间', evidence: '转租：E14单间' }],
      zh: true,
      plan: {
        intent: 'housing',
        needs: [{ id: 'room', terms: ['单间'] }],
        preferences: ['11月初入住'],
        essentialPreferences: ['11月初入住'],
        budget: 1200,
        requiredArea: ['E14'],
      },
    });
    expect(text).toContain('9月29日起可入住，租期至2027年9月9日');
    expect(text).toContain('3人合租，与1人共用卫生间');
    expect(text).toContain('待确认：11月初入住');
    expect(choices.primary).toHaveLength(0);
  });
  it('keeps a brief backup visibly unconfirmed rather than implying a fit', () => {
    const listing: MarketCandidate = {
      id: 'home',
      ref: 'm1',
      title: '伦敦一居室',
      description: '出租：伦敦一居室\n费用：月租£1550，不含账单',
      tags: [],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/home',
      sourceUrl: null,
      isRepost: false,
      priceLabel: '£1550/月',
      sourcePublishedAt: null,
      createdAt: null,
      availableFrom: null,
      availableUntil: null,
    };
    const { text, choices } = renderMarketChoiceReply({
      listings: [listing],
      selections: [{ ref: 'm1', name: listing.title, evidence: listing.description }],
      format: 'brief',
      zh: true,
      plan: {
        intent: 'housing',
        needs: [{ id: 'home', terms: ['一居室'] }],
        preferences: [],
        budget: 1600,
        budgetScope: 'all_in',
      },
    });
    expect(choices.primary).toHaveLength(0);
    expect(text).toContain('待核实');
    expect(text).toContain('含账单总价');
    expect(text).toContain('不含账单');
    expect(text).toContain(listing.url);
  });
});

it('keeps conversational sources readable without report headers or delegating a checklist', () => {
  const listing: MarketCandidate = {
    id: 'home',
    ref: 'm1',
    title: 'Stratford一居室',
    description: '出租：伦敦Stratford一居室\n费用：月租£1550，不含账单',
    tags: [],
    tradeType: 'SELL',
    status: 'ON_SALE',
    url: 'https://a2hmarket.ai/listings/home',
    sourceUrl: 'https://www.xiaohongshu.com/explore/home',
    isRepost: true,
    priceLabel: '£1550/月',
    sourcePublishedAt: null,
    createdAt: null,
    availableFrom: null,
    availableUntil: null,
  };
  const { text, choices } = renderMarketChoiceReply({
    listings: [listing],
    selections: [{ ref: 'm1', name: listing.title, evidence: listing.description }],
    format: 'conversation',
    zh: true,
    plan: {
      intent: 'housing',
      needs: [{ id: 'home', terms: ['一居室'] }],
      preferences: ['允许养猫'],
      essentialPreferences: ['允许养猫'],
      budget: 1600,
      budgetScope: 'all_in',
    },
  });
  expect(choices.primary).toHaveLength(0);
  expect(choices.backup[0]?.essentialMissing).toContain('允许养猫');
  expect(text).toContain('£1550');
  expect(text).not.toContain('这条还没写清');
  expect(text).toContain(listing.url);
  expect(text).toContain(listing.sourceUrl);
  expect(text).toMatch(
    /^\[Stratford一居室 · £1550\/月\]\(https:\/\/a2hmarket\.ai\/listings\/home\) · \[原帖\]/m,
  );
  expect(text).not.toMatch(
    /尚未确认|匹配的选项|可作备选|待确认：|推荐理由：|单品报价：|逐项核对|【|来源：/,
  );
});

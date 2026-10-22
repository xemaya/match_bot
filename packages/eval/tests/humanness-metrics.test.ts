import { describe, expect, it } from 'vitest';
import { EVIDENCE_CARD_MARKER } from '@matchbot/domain';
import {
  countBareNumbers,
  measureHumanLine,
  measureReply,
  renderComparison,
  roundMetrics,
  summarize,
  targetsMet,
} from '../src/humanness/metrics.js';
import type { Round } from '../src/humanness/schema.js';

const BOT =
  'Mile End 附近这次没刷到出打印机的，最近的是 SE1 Bermondsey 一台全新 HP DeskJet 2720e，5 镑起拍，说可以送到地铁站面交——不在你那片，但预算完全够。' +
  '\n\n' +
  EVIDENCE_CARD_MARKER +
  '\n帖子里没写这台支不支持 WiFi，地点写的是 Bermondsey，能不能送到 Mile End 得你跟卖家确认。\n\n[HP DeskJet 2720e · £0.99–5](https://a2hmarket.ai/listings/x) · [原帖](https://www.xiaohongshu.com/explore/y) · [Walk](https://en.wikipedia.org/wiki/z)';

describe('humanness metrics', () => {
  it('ignores dates, clock times and postcodes when counting bare numbers', () => {
    expect(countBareNumbers('31号周六上午10点 E14 SE1 2720e 两个人')).toBe(0);
    expect(countBareNumbers('£60–£65/小时 最少订2小时 10:30')).toBe(3);
  });
  it('measures the chat line above the fold and the card separately', () => {
    const m = measureReply(BOT);
    expect(m.length).toBeGreaterThan(60);
    expect(m.heavyPunct).toBe(2); // the double dash and the full stop
    expect(m.pounds).toBe(0);
    expect(m.bareNumbers).toBe(1); // 5 镑；SE1 and 2720e are excluded
    expect(m.searchReport).toBe(2); // 没刷到 + 得你跟卖家确认
    expect(m.verifyWords).toBe(1);
    expect(m.hasCard).toBe(true);
    expect(m.linkCount).toBe(3);
    expect(m.genericLinks).toBe(1);
  });
  it('measures a member line as the reference', () => {
    const m = measureHumanLine(
      '@小林 那你去fb marketplace翻翻 老款激光机挺便宜 就是要自己搬回来hh',
    );
    expect(m).toMatchObject({
      length: 43,
      heavyPunct: 0,
      bareNumbers: 0,
      particles: 1,
      hasCard: false,
    });
  });
  it('summarises a round and checks the review targets', () => {
    const round: Round = {
      version: 1,
      name: 't',
      generatedAt: '2026-10-22T00:00:00Z',
      source: 'db',
      agentVersion: null,
      window: null,
      cases: [
        {
          id: 'a',
          sourceMessageId: null,
          asked: 'q',
          askedAt: null,
          authorAlias: null,
          kind: 'recommendation',
          status: 'sent',
          text: BOT,
          line: BOT.split('\n')[0]!,
          card: 'c',
          links: [],
        },
        {
          id: 'b',
          sourceMessageId: null,
          asked: 'q',
          askedAt: null,
          authorAlias: null,
          kind: 'recommendation',
          status: 'sent',
          text: '别慌 mile end这边暂时没人出 你问一句能不能往东送哈',
          line: '别慌 mile end这边暂时没人出 你问一句能不能往东送哈',
          card: null,
          links: [],
        },
      ],
      humans: [
        {
          alias: 'h1',
          at: '2026-10-22T00:00:00Z',
          text: '@老陈 31号有空就过去搭把手',
          replyLike: true,
        },
        { alias: 'h2', at: '2026-10-22T00:00:00Z', text: '有人出打印机吗', replyLike: false },
      ],
    };
    const { bot, humans } = roundMetrics(round);
    expect(bot.n).toBe(2);
    expect(bot.cardLines).toBe(1);
    expect(bot.particleLines).toBe(1);
    expect(humans.n).toBe(1);
    expect(humans.heavyPunctZeroShare).toBe(1);
    const checks = targetsMet(bot);
    expect(checks.find((c) => c.metric === 'searchReportHits')?.ok).toBe(false);
    expect(renderComparison([{ label: 't', bot, humans }])).toContain('lengthMedian');
    expect(summarize([])).toMatchObject({ n: 0, lengthMedian: 0 });
  });
});

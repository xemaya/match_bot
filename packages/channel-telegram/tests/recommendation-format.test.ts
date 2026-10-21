import { describe, expect, it } from 'vitest';
import { formatRecommendation } from '../src/recommendation-format.js';

describe('formatRecommendation', () => {
  it('renders official numbered sources using UTF-16 offsets', () => {
    const url = 'https://www.nhs.uk/nhs-services/gps/how-to-register-with-a-gp-surgery/';
    const body = formatRecommendation(
      '🙂 注册步骤\n来源：[1. NHS 注册指南](' + url + ')',
      'recommendation',
    );
    expect(body.text).toBe('🙂 注册步骤\n来源：1. NHS 注册指南');
    expect(body.entities).toEqual([
      {
        type: 'text_link',
        offset: body.text.indexOf('1. NHS'),
        length: '1. NHS 注册指南'.length,
        url,
      },
    ]);
  });

  it.each(['https://127.0.0.1/path', 'https://user:password@example.com/path'])(
    'does not render private or credential-bearing sources: %s',
    (url) => {
      const text = '来源：[1. 注册指南](' + url + ')';
      expect(formatRecommendation(text, 'recommendation')).toEqual({ text });
    },
  );

  it('renders marketplace and original repost links together without showing long URL tokens', () => {
    const market = 'https://a2hmarket.ai/listings/listing_a';
    const original = 'https://www.xiaohongshu.com/discovery/item/n1?xsec_token=tok';
    const body = formatRecommendation(
      `1. 小绿锅\n来源：[A2H详情](${market}) · [小红书原帖](${original})`,
      'recommendation',
    );
    expect(body.text).toBe('1. 小绿锅\n来源：A2H详情 · 小红书原帖');
    expect(body.entities?.filter((e) => e.type === 'text_link')).toMatchObject([
      { url: market, offset: body.text.indexOf('A2H详情') },
      { url: original, offset: body.text.indexOf('小红书原帖') },
    ]);
  });
  it('formats grouped six-entity replies with multiple source links using native offsets', () => {
    const url = 'https://www.xiaohongshu.com/explore/n1?xsec_token=abc';
    const another = 'https://www.xiaohongshu.com/explore/n2?xsec_token=def';
    const body = formatRecommendation(
      `【绘画与艺术】\n\n6. 🙂 展览\n来源：[小红书原文 1](${url}) · [小红书原文 2](${another})`,
      'recommendation',
    );
    const links = body.entities?.filter((e) => e.type === 'text_link') ?? [];
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ offset: body.text.indexOf('小红书原文 1'), url });
    expect(links[1]).toMatchObject({ offset: body.text.indexOf('小红书原文 2'), url: another });
    expect(body.entities?.filter((e) => e.type === 'bold')).toHaveLength(2);
    expect(body.text).not.toContain('xsec_token');
  });
  it('uses native bold headings and clickable source labels without displaying long tokens', () => {
    const url = 'https://www.xiaohongshu.com/explore/abc?xsec_token=abc%2Bdef';
    const body = formatRecommendation(
      `先看这篇：\n\n1. 🙂 河边集市\n适合散步。\n来源：[小红书原文](${url}) · 作者`,
      'recommendation',
    );
    expect(body.text).toBe('先看这篇：\n\n1. 🙂 河边集市\n适合散步。\n来源：小红书原文 · 作者');
    expect(body.entities).toEqual([
      { type: 'bold', offset: body.text.indexOf('1.'), length: '1. 🙂 河边集市'.length },
      { type: 'text_link', offset: body.text.indexOf('小红书原文'), length: 5, url },
    ]);
  });

  it('formats English source labels and multiple headings using offsets after link removal', () => {
    const url = 'https://www.xiaohongshu.com/explore/n1';
    const body = formatRecommendation(
      `1. One\nSource: [Xiaohongshu note](${url}) · Author\n\n2. Two`,
      'recommendation',
    );
    expect(body.entities?.[2]).toEqual({
      type: 'bold',
      offset: body.text.indexOf('2. Two'),
      length: 6,
    });
  });

  it.each([
    'https://evil.example/explore/abc',
    'javascript:alert(1)',
    'https://www.xiaohongshu.com.evil.example/explore/abc',
  ])('keeps invalid source markup as plain text: %s', (url) => {
    const text = `来源：[小红书原文](${url})`;
    expect(formatRecommendation(text, 'recommendation')).toEqual({ text });
  });

  it('folds the evidence card into an expandable blockquote, drops the marker line and keeps its links clickable', () => {
    const url = 'https://www.nhs.uk/register/';
    const text =
      '没有NHS number也能注册GP。\n\n\u2063\n注册免费，诊所可能要住址证明。\n\n[NHS register](' +
      url +
      ') · [原帖](https://www.xiaohongshu.com/explore/abc)';
    const body = formatRecommendation(text, 'recommendation');
    expect(body.text).toBe(
      '没有NHS number也能注册GP。\n\n注册免费，诊所可能要住址证明。\n\nNHS register · 原帖',
    );
    expect(body.text).not.toContain('\u2063');
    const cardOffset = body.text.indexOf('注册免费');
    expect(body.entities).toContainEqual({
      type: 'expandable_blockquote',
      offset: cardOffset,
      length: body.text.length - cardOffset,
    });
    expect(body.entities).toContainEqual({
      type: 'text_link',
      offset: body.text.indexOf('NHS register'),
      length: 'NHS register'.length,
      url,
    });
    expect(body.entities).toContainEqual({
      type: 'text_link',
      offset: body.text.indexOf('原帖'),
      length: 2,
      url: 'https://www.xiaohongshu.com/explore/abc',
    });
    expect(body.entities?.some((e) => e.type === 'bold')).toBe(false);
  });

  it('still folds replies stored with the pre-P49 visible header', () => {
    const text = '那句话\n\n【详情】\n旧卡\n\n来源：[1. NHS](https://www.nhs.uk/x)';
    const body = formatRecommendation(text, 'recommendation');
    const cardOffset = body.text.indexOf('【详情】');
    expect(body.entities).toContainEqual({
      type: 'expandable_blockquote',
      offset: cardOffset,
      length: body.text.length - cardOffset,
    });
  });

  it('links only whole link lines inside the card, not markup in prose', () => {
    const text =
      '那句话\n\n\u2063\n细节里提到 [x](https://example.com/a) 这种写法。\n\n[a](https://example.com/a)';
    const body = formatRecommendation(text, 'recommendation');
    expect(body.text).toContain('细节里提到 [x](https://example.com/a) 这种写法。');
    expect(body.entities?.filter((e) => e.type === 'text_link')).toEqual([
      {
        type: 'text_link',
        offset: body.text.lastIndexOf('a'),
        length: 1,
        url: 'https://example.com/a',
      },
    ]);
  });

  it('does not fold a reply without a card', () => {
    const body = formatRecommendation('只有一句话', 'recommendation');
    expect(body.entities ?? []).toEqual([]);
  });

  it('leaves other message kinds and markup in note content unchanged', () => {
    const text = '1. title\n笔记提到：[link](https://example.com)';
    expect(formatRecommendation(text, 'clarification')).toEqual({ text });
    expect(formatRecommendation(text, 'recommendation').text).toBe(text);
  });
});

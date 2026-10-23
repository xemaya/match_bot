import { describe, expect, it } from 'vitest';
import { claimsPersonalPresence } from '../src/tools/make-outbound-tool.js';

describe('presence claims', () => {
  it('catches A2H offering to take part or help in person', () => {
    for (const text of [
      '有人一起去的话我也想凑一脚',
      '算我一个',
      '我可以帮你搬箱子',
      '到时候我也去',
    ])
      expect(claimsPersonalPresence(text)).toBe(true);
  });
  it('leaves ordinary answers alone', () => {
    for (const text of [
      'E14 过去 DLR 到 Stratford 换 Central line',
      '你可以先问问卖家',
      '我看了下 那家周日开到五点',
    ])
      expect(claimsPersonalPresence(text)).toBe(false);
  });
});

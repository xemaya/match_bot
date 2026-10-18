import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
  REDIS_URL: 'redis://localhost:6379',
  DEEPSEEK_API_KEY: 'k',
  JEV_API_KEY: 'k',
  TELEGRAM_BOT_TOKEN: 'k',
  TELEGRAM_OPS_CHAT_ID: '-100',
};

describe('loadEnv', () => {
  it('separates optional information search credentials and validates generation reasoning effort', () => {
    const env = loadEnv({
      ...base,
      DEEPSEEK_SEARCH_API_KEY: 'search-only',
      GENERATION_REASONING_EFFORT: 'low',
    });
    expect(env.DEEPSEEK_SEARCH_API_KEY).toBe('search-only');
    expect(env.GENERATION_REASONING_EFFORT).toBe('low');
    expect(loadEnv(base).GENERATION_REASONING_EFFORT).toBeUndefined();
    expect(() => loadEnv({ ...base, GENERATION_REASONING_EFFORT: 'fast' })).toThrow();
    expect(() => loadEnv({ ...base, DEEPSEEK_SEARCH_API_KEY: '' })).toThrow();
  });
  it('keeps actor admission empty unless a strict group/id allowlist is configured', () => {
    expect(loadEnv(base).TELEGRAM_ACTOR_ALLOWLIST).toEqual([]);
    const actorAllowlist = [{ chatId: '-123', botIds: ['456'] }];
    expect(
      loadEnv({ ...base, TELEGRAM_ACTOR_ALLOWLIST: JSON.stringify(actorAllowlist) })
        .TELEGRAM_ACTOR_ALLOWLIST,
    ).toEqual(actorAllowlist);
    for (const value of [
      '[{"chatId":"-123","botIds":["456","456"]}]',
      '[{"chatId":"-123","botIds":["456"]},{"chatId":"-123","botIds":["789"]}]',
      'not-json',
      '{}',
      '[{"chatId":"123","botIds":["456"]}]',
      '[{"chatId":"-123","botIds":["@actor"]}]',
    ])
      expect(() => loadEnv({ ...base, TELEGRAM_ACTOR_ALLOWLIST: value })).toThrow();
  });
  it('defaults information research to DeepSeek with an explicit Tavily rollback', () => {
    expect(loadEnv(base).INFORMATION_SEARCH_PROVIDER).toBe('deepseek');
    expect(
      loadEnv({ ...base, INFORMATION_SEARCH_PROVIDER: 'tavily' }).INFORMATION_SEARCH_PROVIDER,
    ).toBe('tavily');
    expect(() => loadEnv({ ...base, INFORMATION_SEARCH_PROVIDER: 'unknown' })).toThrow();
  });
  it('reads the optional Sandbase credential only through the environment boundary', () => {
    expect(loadEnv({ ...base, SANDBASE_API_KEY: 'sandbase-test-key' }).SANDBASE_API_KEY).toBe(
      'sandbase-test-key',
    );
    expect(loadEnv(base).SANDBASE_API_KEY).toBeUndefined();
    expect(() => loadEnv({ ...base, SANDBASE_API_KEY: '' })).toThrow();
  });
  it('keeps experimental XHS research disabled unless explicitly enabled', () => {
    expect(loadEnv(base).XHS_RESEARCH_ENABLED).toBe(false);
    expect(loadEnv({ ...base, XHS_RESEARCH_ENABLED: 'false' }).XHS_RESEARCH_ENABLED).toBe(false);
    expect(loadEnv({ ...base, XHS_RESEARCH_ENABLED: 'true' }).XHS_RESEARCH_ENABLED).toBe(true);
    expect(() => loadEnv({ ...base, XHS_RESEARCH_ENABLED: 'yes' })).toThrow();
  });
  it('defaults Jev to the OpenRouter decisions host (PoC V4)', () => {
    // 客户端拼 `${JEV_BASE_URL}/decisions`；默认必须指向实际可用的端点，
    // 否则未显式配置时会打到不存在的 api.typesafe.ai/decisions。
    const e = loadEnv(base);
    expect(e.JEV_BASE_URL).toBe('https://openrouter.ai/api/alpha');
    expect(e.JEV_MODEL).toBe('typesafe/jev-1.13');
  });

  it('requires an ops chat id', () => {
    const { TELEGRAM_OPS_CHAT_ID: _omit, ...without } = base;
    expect(() => loadEnv(without)).toThrow();
  });

  it('coerces DEFAULT_PHASE and defaults it to 0', () => {
    expect(loadEnv(base).DEFAULT_PHASE).toBe(0);
    expect(loadEnv({ ...base, DEFAULT_PHASE: '2' }).DEFAULT_PHASE).toBe(2);
  });
});

it('targeted allows missing Jev credentials, strict remains the default', () => {
  const { JEV_API_KEY: _key, ...without } = base;
  expect(loadEnv(base).JEV_POLICY).toBe('strict');
  expect(() => loadEnv(without)).toThrow('JEV_API_KEY');
  expect(loadEnv({ ...without, JEV_POLICY: 'targeted' }).JEV_API_KEY).toBe('');
  expect(() => loadEnv({ ...base, JEV_POLICY: 'disabled' })).toThrow();
});

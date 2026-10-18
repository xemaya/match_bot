import { afterAll, expect, it, vi } from 'vitest';
import { disconnectPrisma } from '@matchbot/db';
import { envSchema } from '@matchbot/shared';
import { buildDeps } from '../src/deps.js';

afterAll(disconnectPrisma);
const proxyEnv = () =>
  envSchema.parse({
    DATABASE_URL: 'postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_task_test',
    REDIS_URL: 'redis://127.0.0.1:6379/15',
    DEEPSEEK_API_KEY: 'generation-only',
    DEEPSEEK_BASE_URL: 'https://generation.example/v1',
    DEEPSEEK_MODEL: 'gpt-6.1-sol',
    DEEPSEEK_SEARCH_API_KEY: 'search-only',
    JEV_API_KEY: 'synthetic',
    TELEGRAM_BOT_TOKEN: 'synthetic',
    TELEGRAM_OPS_CHAT_ID: '-999',
    LOG_LEVEL: 'error',
  });
it('never sends the generation proxy credential to DeepSeek search', async () => {
  const env = proxyEnv();
  env.LOG_LEVEL = 'error';
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  try {
    const deps = buildDeps({ env });
    await deps.webSearch!.research!({ query: 'London GP' });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/v1/tools/search');
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer search-only',
    );
    const missing = proxyEnv();
    delete missing.DEEPSEEK_SEARCH_API_KEY;
    expect(() => buildDeps({ env: missing })).toThrow('DEEPSEEK_SEARCH_API_KEY');
  } finally {
    request.mockRestore();
  }
});
it('enables persisted task execution in the actual worker assembly used by inbound and resume', () => {
  const deps = buildDeps({
    env: envSchema.parse({
      DATABASE_URL: 'postgresql://matchbot:matchbot@127.0.0.1:5432/matchbot_task_test',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      DEEPSEEK_API_KEY: 'synthetic',
      JEV_API_KEY: 'synthetic',
      TELEGRAM_BOT_TOKEN: 'synthetic',
      TELEGRAM_OPS_CHAT_ID: '-999',
      SNAPSHOT_KEY: 'synthetic-worker-assembly-key',
      LOG_LEVEL: 'error',
    }),
  });
  expect(deps.answerRequests).toBe(true);
  expect(deps.taskRequests).toBe(true);
  expect(deps.repos.tasks).toBeDefined();
  expect(deps.repos.executions).toBeDefined();
});

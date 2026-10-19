import type { AgentInputItem } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { createPgSession, trimHistory } from '../src/session.js';

function repos() {
  const store: unknown[] = [];
  return {
    store,
    sessionItems: {
      list: vi.fn((_u: string, limit?: number) =>
        Promise.resolve(limit ? store.slice(-limit) : [...store]),
      ),
      append: vi.fn((_u: string, items: unknown[]) => {
        store.push(...items);
        return Promise.resolve();
      }),
      popLast: vi.fn(() => Promise.resolve(store.pop() ?? null)),
      clear: vi.fn(() => {
        store.length = 0;
        return Promise.resolve();
      }),
    },
  };
}

describe('createPgSession', () => {
  it('keeps user storage but excludes earlier independent turns from model input', async () => {
    const r = repos();
    r.store.push({ role: 'user', content: 'Four people want hotpot' });
    const s = createPgSession({ repos: r as never, userId: 'u1', isolatePreviousTurns: true });
    expect(await s.getItems()).toEqual([]);
    await s.addItems([{ role: 'user', content: 'Nearby dim sum' }] as never);
    expect(await s.getItems()).toEqual([{ role: 'user', content: 'Nearby dim sum' }]);
    expect(r.store).toHaveLength(2);
    expect(await s.getSessionId()).toBe('u1');
  });
  it('delegates to sessionItems repo with the user id', async () => {
    const r = repos();
    const s = createPgSession({ repos: r as never, userId: 'u1' });
    expect(await s.getSessionId()).toBe('u1');
    await s.addItems([{ role: 'user', content: 'hi' }] as never);
    expect(await s.getItems()).toHaveLength(1);
    expect(await s.popItem()).toEqual({ role: 'user', content: 'hi' });
    await s.clearSession();
    expect(await s.getItems()).toEqual([]);
  });

  it('popItem returns undefined (not null) on empty history (PoC V3 SDK signature)', async () => {
    const s = createPgSession({ repos: repos() as never, userId: 'u1' });
    expect(await s.popItem()).toBeUndefined();
  });

  it('strips providerData (deepseek reasoning_content) before persisting', async () => {
    const r = repos();
    const s = createPgSession({ repos: r as never, userId: 'u1' });
    await s.addItems([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'ok', providerData: { reasoning_content: 'chain' } },
        ],
      },
    ] as never);
    expect(r.store[0]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
    });
  });

  it('strips providerData again on replay via prepareHistoryItemForModelInput', () => {
    const s = createPgSession({ repos: repos() as never, userId: 'u1' });
    const item = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok', providerData: { reasoning_content: 'chain' } }],
    } as never;
    const out = s.prepareHistoryItemForModelInput?.(item) as { content: object[] };
    expect(out.content[0]).toEqual({ type: 'output_text', text: 'ok' });
  });
});

// 夹具用 SDK 自己的 AgentInputItem 类型写：类型名一旦写错（如 function_call_output），
// 编译就过不了。旧测试用手写对象，与实现一起写错了名字，所以一直是绿的。
const user = (text: string): AgentInputItem => ({ type: 'message', role: 'user', content: text });
const assistant = (text: string): AgentInputItem => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});
const call = (id: string, name: string): AgentInputItem => ({
  type: 'function_call',
  callId: id,
  name,
  arguments: '{}',
});
const result = (id: string, name: string): AgentInputItem => ({
  type: 'function_call_result',
  callId: id,
  name,
  status: 'completed',
  output: { type: 'text', text: 'ok' },
});
/** 一轮：用户说话 → 若干工具调用与结果 → 助手收尾。 */
function turn(n: number, tools: string[]): AgentInputItem[] {
  return [
    user(`u${n}`),
    ...tools.flatMap((t, i) => [call(`c${n}_${i}`, t), result(`c${n}_${i}`, t)]),
    assistant(`a${n}`),
  ];
}

/** chat completions 的硬约束：每个工具结果前有它的调用，每个调用后有它的结果。 */
function assertToolPairing(items: AgentInputItem[]) {
  const seen = new Set<string>();
  for (const i of items as Array<{ type?: string; callId?: string }>) {
    if (i.type === 'function_call') seen.add(i.callId!);
    if (i.type === 'function_call_result')
      expect(seen.has(i.callId!), `orphan result ${i.callId}`).toBe(true);
  }
  const results = new Set(
    (items as Array<{ type?: string; callId?: string }>)
      .filter((i) => i.type === 'function_call_result')
      .map((i) => i.callId),
  );
  for (const id of seen) expect(results.has(id), `call without result ${id}`).toBe(true);
}

describe('trimHistory', () => {
  it('regression 2026-09-24: 42 items used to start on an orphaned tool result', () => {
    // 与实测用户的历史同形：5 轮，共 42 条；旧逻辑从第 3 条（upsert_demand 的结果）开始
    const items = [
      ...turn(1, ['upsert_demand', 'ask_clarification']),
      ...turn(2, ['upsert_demand', 'find_suppliers', 'reply_in_group']),
      ...turn(3, ['web_search', 'upsert_demand', 'find_suppliers', 'web_search', 'do_nothing']),
      ...turn(4, ['web_search', 'reply_with_search_results']),
      ...turn(5, ['upsert_demand', 'find_suppliers', 'web_search', 'reply_with_search_results']),
    ];
    expect(items).toHaveLength(42);
    const got = trimHistory(items);
    expect(got[0]).toEqual(user('u2'));
    assertToolPairing(got);
  });

  it('always starts the window on a user message', () => {
    const items = Array.from({ length: 12 }, (_, n) => turn(n, ['a', 'b'])).flat(); // 12 × 6 = 72
    const got = trimHistory(items);
    expect(got.length).toBeLessThanOrEqual(40);
    expect((got[0] as { role?: string }).role).toBe('user');
    assertToolPairing(got);
  });

  it('drops orphans even inside a short history (e.g. a run that crashed mid-tool)', () => {
    const items = [
      user('u'),
      call('c1', 'x'),
      result('c1', 'x'),
      call('c2', 'y'),
      result('c9', 'z'),
    ];
    const got = trimHistory(items);
    expect(got).toEqual([user('u'), call('c1', 'x'), result('c1', 'x')]);
  });

  it('falls back to a hard cut plus pairing when one turn alone exceeds the window', () => {
    const items = turn(
      1,
      Array.from({ length: 30 }, (_, i) => `t${i}`),
    ); // 62 items, one user message
    const got = trimHistory(items);
    expect(got.length).toBeLessThanOrEqual(40);
    assertToolPairing(got);
  });

  it('is applied by the session on read, so already-stored histories heal', async () => {
    const r = repos();
    r.store.push(
      ...[
        ...turn(1, ['a', 'b', 'c', 'd']),
        ...Array.from({ length: 8 }, (_, n) => turn(n + 2, ['e'])).flat(),
      ],
    );
    const got = await createPgSession({ repos: r as never, userId: 'u1' }).getItems();
    expect((got[0] as { role?: string }).role).toBe('user');
    assertToolPairing(got);
  });
});

describe('archiving ephemeral search results on replay', () => {
  const big = (id: string, name: string): AgentInputItem => ({
    type: 'function_call_result',
    callId: id,
    name,
    status: 'completed',
    output: { type: 'text', text: 'x'.repeat(30_000) },
  });

  it('replaces past search tool results with a one-line archive note for the model', () => {
    const s = createPgSession({ repos: repos() as never, userId: 'u1' });
    const out = s.prepareHistoryItemForModelInput?.(big('c1', 'market_search')) as {
      type: string;
      callId: string;
      name: string;
      output: { type: string; text: string };
    };
    expect(out.type).toBe('function_call_result');
    expect(out.callId).toBe('c1');
    expect(out.name).toBe('market_search');
    expect(out.output.type).toBe('text');
    expect(out.output.text).toContain('archived market_search result');
    expect(out.output.text.length).toBeLessThan(200);
  });

  it.each([
    'xhs_search',
    'xhs_read_notes',
    'market_enrich',
    'web_search',
    'xhs_legacy_search',
    'search_information',
    'read_web_page',
  ])('archives %s too', (name) => {
    const s = createPgSession({ repos: repos() as never, userId: 'u1' });
    const out = s.prepareHistoryItemForModelInput?.(big('c1', name)) as {
      output: { text: string };
    };
    expect(out.output.text).toContain(`archived ${name} result`);
  });

  it('leaves non-search tool results and messages untouched', () => {
    const s = createPgSession({ repos: repos() as never, userId: 'u1' });
    const kept = big('c1', 'upsert_demand');
    expect(s.prepareHistoryItemForModelInput?.(kept)).toEqual(kept);
    const msg = user('你好');
    expect(s.prepareHistoryItemForModelInput?.(msg)).toEqual(msg);
  });

  it('handles string-shaped outputs', () => {
    const s = createPgSession({ repos: repos() as never, userId: 'u1' });
    const out = s.prepareHistoryItemForModelInput?.({
      type: 'function_call_result',
      callId: 'c1',
      name: 'xhs_search',
      status: 'completed',
      output: 'x'.repeat(10_000),
    } as never) as { output: string };
    expect(out.output).toContain('archived xhs_search result');
  });

  it('is read-time only: stored items keep the full payload and pairing survives', async () => {
    const r = repos();
    r.store.push(...turn(1, ['market_search', 'reply_with_market_results']));
    const s = createPgSession({ repos: r as never, userId: 'u1' });
    const stored = await s.getItems();
    expect(stored).toEqual(r.store);
    const replayed = stored.map((i) => s.prepareHistoryItemForModelInput?.(i) ?? i);
    assertToolPairing(replayed);
  });
});

import { RunContext } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps, MatchContext } from '../src/context.js';
import { bindCurrentRequest } from '../src/current-request.js';
import { hasStatusValue, isUnsolicitedGroupTurn } from '../src/request-status.js';
import { doNothingTool } from '../src/tools/do-nothing.js';

function ctx(over: Partial<MatchContext> = {}): MatchContext {
  const c: MatchContext = {
    userId: 'u',
    chatId: '-1',
    groupId: 'g',
    phase: 2,
    sourceMessageId: 'm',
    recentReplies: [],
    ...over,
  };
  bindCurrentRequest(c, '狗岛附近哪里买感冒药方便');
  return c;
}

describe('a reply is sent for its value to the asker, not for work done', () => {
  it('treats group messages that did not address the assistant as unsolicited', () => {
    expect(isUnsolicitedGroupTurn(ctx())).toBe(true);
    expect(isUnsolicitedGroupTurn(ctx({ addressedToBot: true }))).toBe(false);
    expect(isUnsolicitedGroupTurn(ctx({ groupId: null }))).toBe(false);
  });
  it('lets a fixed status through only when it carries a planned question or the user asked directly', () => {
    expect(hasStatusValue(ctx(), '这次查询没能完成，还不能判断有没有合适的。')).toBe(false);
    expect(hasStatusValue(ctx(), '这轮没搜到合适的线索。\n\n预算大概是多少？')).toBe(true);
    expect(hasStatusValue(ctx({ addressedToBot: true }), '刚才没查成，还没拿到结果。')).toBe(true);
    expect(hasStatusValue(ctx({ groupId: null }), '刚才没查成，还没拿到结果。')).toBe(true);
  });
  it('accepts do_nothing for an unsolicited group ask and still pushes a direct ask toward an answer', async () => {
    const deps = {
      repos: { traces: { create: vi.fn().mockResolvedValue({}) } },
    } as unknown as AgentDeps;
    const quiet = ctx();
    expect(
      await doNothingTool(deps).invoke(
        new RunContext(quiet),
        JSON.stringify({ reason: 'nothing' }),
      ),
    ).toMatch(/^ok: nothing useful/);
    expect(quiet.replySuppressed).toBe(true);
    const direct = ctx({ addressedToBot: true });
    expect(
      await doNothingTool(deps).invoke(new RunContext(direct), JSON.stringify({ reason: 'x' })),
    ).toMatch(/actionable current request/);
    expect(direct.replySuppressed).toBeUndefined();
  });
});

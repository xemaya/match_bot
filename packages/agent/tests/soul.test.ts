import { readFileSync } from 'node:fs';
import { RunContext } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { createMatchAgent } from '../src/agent.js';
import type { MatchContext } from '../src/context.js';

const context: MatchContext = {
  userId: 'u',
  chatId: '-1',
  groupId: null,
  phase: 0,
  sourceMessageId: 'm',
  recentReplies: [],
};
const deps = {
  env: { DEEPSEEK_MODEL: 'deepseek-flash' },
  answerRequests: true,
  taskRequests: true,
};
describe('versioned SOUL', () => {
  it('injects the actual versioned file into the normal answering agent without widening its tools', async () => {
    const soul = readFileSync(new URL('../prompts/voice/soul.md', import.meta.url), 'utf8').trim();
    const agent = createMatchAgent(deps as never, { phase: 0, finalAnswerOnly: true }).agent;
    const prompt = await agent.getSystemPrompt(new RunContext(context));
    expect(soul.length).toBeGreaterThan(200);
    expect(prompt).toContain(soul);
    expect(agent.tools.map((t) => (t.type === 'function' ? t.name : ''))).toEqual([
      'reply_to_request',
    ]);
    expect(prompt).toContain('Never broaden an explicit date/area/budget');
  });
  it.each([{ taskPlanningOnly: true }, { requestStatusOnly: true }])(
    'keeps SOUL out of the internal deterministic protocol: %j',
    async (mode) => {
      const agent = createMatchAgent(deps as never, { phase: 0, ...mode }).agent;
      expect(await agent.getSystemPrompt(new RunContext(context))).not.toContain('# A2H SOUL');
    },
  );
});

it('does not inject mandatory handoff phrasing or a two-sentence card-report instruction', async () => {
  const agent = createMatchAgent(deps as never, { phase: 0, finalAnswerOnly: true }).agent;
  const prompt = await agent.getSystemPrompt(new RunContext(context));
  expect(prompt).not.toContain(
    'When the next action belongs to the user, say 建议你先问/你可以确认',
  );
  expect(prompt).not.toContain('the code adds detailed cards');
  expect(prompt).not.toContain('Code supplies each offer price');
});

it('keeps ENFP voice with fact and permission boundaries in the writer', async () => {
  const agent = createMatchAgent(deps as never, { phase: 0, finalAnswerOnly: true }).agent;
  const prompt = await agent.getSystemPrompt(new RunContext(context));
  expect(prompt).toContain('ENFP');
  expect(prompt).toContain('Never pay, contact, book, transact');
  expect(prompt).toContain('not guaranteed current stock');
  expect(prompt).toContain('Do not append stock disclaimers');
  expect(prompt).not.toContain('one is appended automatically');
});

it('gives the researcher the fact and permission boundaries but no voice (P52)', async () => {
  const agent = createMatchAgent(deps as never, { phase: 0 }).agent;
  const prompt = await agent.getSystemPrompt(new RunContext(context));
  expect(prompt).not.toContain('ENFP');
  expect(prompt).toContain('Never pay, contact, book, transact');
  expect(prompt).toContain('not guaranteed current stock');
  expect(prompt).not.toContain('Do not append stock disclaimers');
});

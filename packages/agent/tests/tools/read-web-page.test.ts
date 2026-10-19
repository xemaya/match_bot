import { expect, it, vi } from 'vitest';
import { RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../../src/context.js';
import { createKnowledgeSource } from '../../src/knowledge-evidence.js';
import { readWebPageTool } from '../../src/tools/read-web-page.js';

it('uses a provider-compatible URL parameter schema', () => {
  const tool = readWebPageTool({} as AgentDeps);
  expect(JSON.stringify(tool.parameters)).not.toContain('"format":"uri"');
});

it('follows discovered links and preserves earlier excerpts when reading a later page section', async () => {
  const ctx = {
    phase: 0,
    sourceMessageId: 'm',
    userId: 'u',
    chatId: 'c',
    knowledgeSources: [
      createKnowledgeSource(
        { url: 'https://clinic.test/', title: 'Clinic', text: 'Clinic accepts new patients.' },
        1,
      ),
    ],
  } as MatchContext;
  const pageReader = vi.fn().mockResolvedValue({
    status: 'ok',
    url: 'https://clinic.test/',
    title: 'Clinic',
    text: 'Registration is online.',
    links: [{ text: 'Register', url: 'https://register.test/start' }],
    found: true,
    nextOffset: null,
    truncated: false,
  });
  const deps = {
    pageReader,
    repos: { traces: { create: vi.fn().mockResolvedValue({}) } },
  } as unknown as AgentDeps;
  const tool = readWebPageTool(deps),
    rc = new RunContext(ctx);
  await tool.invoke(
    rc,
    JSON.stringify({ url: 'https://clinic.test/', find: 'Registration', offset: null }),
  );
  expect(ctx.knowledgeSources?.[0]?.text).toBe('Clinic accepts new patients.');
  expect(ctx.knowledgeSources?.[1]?.text).toBe('Registration is online.');
  pageReader.mockResolvedValue({
    status: 'ok',
    url: 'https://register.test/start',
    title: 'Register',
    text: 'You can register without an NHS number.',
    links: [],
    found: true,
    nextOffset: null,
    truncated: false,
  });
  await tool.invoke(
    rc,
    JSON.stringify({ url: 'https://register.test/start', find: null, offset: null }),
  );
  expect(pageReader).toHaveBeenCalledTimes(2);
  expect(ctx.knowledgeSources?.[2]?.url).toBe('https://register.test/start');
  await tool.invoke(
    rc,
    JSON.stringify({ url: 'https://invented.test/', find: null, offset: null }),
  );
  expect(pageReader).toHaveBeenCalledTimes(2);
});

it('does not allow another user task to authorize a page read', async () => {
  const ctx = {
    userId: 'u',
    chatId: 'c',
    task: {
      ownerUserId: 'other',
      scope: { channel: 'telegram', chatId: 'c' },
      evidence: [{ url: 'https://private-task.test/' }],
    },
  } as MatchContext;
  const pageReader = vi.fn();
  const tool = readWebPageTool({ pageReader } as unknown as AgentDeps);
  await tool.invoke(
    new RunContext(ctx),
    JSON.stringify({ url: 'https://private-task.test/', find: null, offset: null }),
  );
  expect(pageReader).not.toHaveBeenCalled();
});

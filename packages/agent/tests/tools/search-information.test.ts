import { expect, it, vi } from 'vitest';
import { RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../../src/context.js';
import { searchInformationTool } from '../../src/tools/search-information.js';
it('allows an explicit clinic domain instead of forcing every GP query to NHS', async () => {
  const research = vi.fn().mockResolvedValue({ status: 'ok', sources: [] });
  const ctx = {
    phase: 0,
    sourceMessageId: 'test',
    currentRequest: { text: '注册GP' },
  } as MatchContext;
  const tool = searchInformationTool({
    webSearch: { research },
    repos: { traces: { create: vi.fn().mockResolvedValue({}) } },
  } as unknown as AgentDeps);
  await tool.invoke(
    new RunContext(ctx),
    JSON.stringify({
      queries: [{ query: 'Island Health register online', domains: ['islandhealth.nhs.uk'] }],
    }),
  );
  expect(research).toHaveBeenCalledWith({
    query: 'Island Health register online',
    domains: ['islandhealth.nhs.uk'],
  });
});
it('excludes historical transport press releases from airport operational evidence', async () => {
  const ctx = {
    phase: 0,
    sourceMessageId: 'test',
    currentRequest: {
      text: '去希思罗机场',
      isActionable: true,
      demand: { category: 'other', need: '去希思罗机场', lang: 'zh', confidence: 1 },
    },
  } as MatchContext;
  const createTrace = vi.fn().mockResolvedValue({});
  const deps = {
    webSearch: {
      research: vi.fn().mockResolvedValue({
        status: 'ok',
        sources: [
          {
            title: '2018 fares',
            url: 'https://tfl.gov.uk/info-for/media/press-releases/2018/march/fares',
            text: 'Old fare £12.50',
          },
          {
            title: 'Current fares',
            url: 'https://tfl.gov.uk/fares',
            text: 'Check current single fares',
          },
        ],
      }),
    },
    repos: { traces: { create: createTrace } },
  } as unknown as AgentDeps;
  const t = searchInformationTool(deps);
  const result = await t.invoke(
    new RunContext(ctx),
    JSON.stringify({ queries: [{ query: 'Heathrow current fares', domains: null }] }),
  );
  expect(ctx.knowledgeSources?.map((s) => s.title)).toEqual(['Current fares']);
  expect(String(result)).not.toContain('error');
  expect(createTrace).toHaveBeenCalledOnce();
});

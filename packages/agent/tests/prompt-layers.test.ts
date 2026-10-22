import { RunContext } from '@openai/agents';
import { functionCall, ScriptedModel } from '@openai/agents/testing';
import { describe, expect, it, vi } from 'vitest';
import { renderEvidenceCard, splitEvidenceCard } from '@matchbot/domain';
import { createMatchAgent } from '../src/agent.js';
import { buildGroupTranscript } from '../src/group-context.js';
import { sourceLabel } from '../src/tools/reply-to-request.js';
import type { AgentDeps, MatchContext } from '../src/context.js';
import { DELIVERY_RULES, FACT_RULES, TRUST_RULES } from '../src/prompts/policy/rules.js';
import { scenes } from '../src/prompts/policy/scenes.js';
import { STAGE_MATRIX } from '../src/prompts/stages/index.js';
import { TRIAGE_INSTRUCTIONS } from '../src/prompts/stages/triage.js';
import { runtimeContext } from '../src/prompts/runtime-context.js';
import { TOOL_PROMPTS, collectToolText } from '../src/prompts/tools/index.js';
import { CHAT_LINE, SOUL } from '../src/prompts/voice.js';
import { triageInbound } from '../src/triage.js';

const deps = {
  env: { DEEPSEEK_MODEL: 'deepseek-flash', XHS_RESEARCH_ENABLED: true },
  answerRequests: true,
  taskRequests: true,
  webSearch: { research: () => Promise.resolve({ sources: [], status: 'empty' }) },
  marketSearch: {},
  xhsSearch: { readNote: () => Promise.resolve(null) },
} as unknown as AgentDeps;
const context = (text = '找书桌'): MatchContext => ({
  userId: 'u',
  chatId: 'c',
  groupId: 'g',
  sourceMessageId: 'm',
  phase: 2,
  recentReplies: [],
  currentRequest: {
    text,
    isActionable: true,
    demand: { category: 'second_hand', confidence: 1, need: text },
  },
});
async function prompt(mode: Record<string, unknown>, ctx = context()): Promise<string> {
  const { agent } = createMatchAgent(deps, { phase: 2, context: ctx, ...mode });
  return (await agent.getSystemPrompt(new RunContext(ctx)))!;
}

describe('stage matrix is the single declaration of what each stage reads', () => {
  it('keeps the voice out of triage, planning and status', async () => {
    for (const text of [TRIAGE_INSTRUCTIONS, await prompt({ taskPlanningOnly: true })]) {
      expect(text).not.toContain(SOUL);
      expect(text).not.toContain(CHAT_LINE);
    }
    expect(await prompt({ requestStatusOnly: true })).not.toContain('ENFP');
    expect(STAGE_MATRIX.triage.layers).toEqual(['trust']);
    expect(STAGE_MATRIX.plan.layers).toEqual(['trust']);
    expect(STAGE_MATRIX.status.layers).toEqual([]);
  });
  it('puts the voice last in the writing stages, after policy and protocol', async () => {
    for (const mode of [{}, { finalAnswerOnly: true }]) {
      const text = await prompt(mode);
      expect(text.endsWith(CHAT_LINE)).toBe(true);
      expect(text.indexOf(SOUL)).toBeGreaterThan(text.indexOf(TRUST_RULES));
      expect(text.indexOf(SOUL)).toBeGreaterThan(text.indexOf('Today is'));
    }
  });
  it('gives research the scene workflow and write only the finalization protocol', async () => {
    const research = await prompt({});
    const write = await prompt({ finalAnswerOnly: true });
    expect(research).toContain('ACTIVE SCENE: marketplace');
    expect(write).not.toContain('ACTIVE SCENE');
    expect(write).toContain('FINALIZATION');
    expect(research).not.toContain('FINALIZATION');
  });
});

describe('reply length is specified once, in the chat-line voice', () => {
  it('is absent from policy rules, scene workflows and the write protocol', async () => {
    const elsewhere = [
      TRUST_RULES,
      FACT_RULES,
      DELIVERY_RULES,
      ...Object.values(scenes).map((s) => s.workflow),
      await prompt({ finalAnswerOnly: true }).then((t) => t.replace(CHAT_LINE, '')),
    ].join('\n');
    expect(elsewhere).not.toMatch(/two short paragraphs|three short lines|120 Chinese/);
    expect(CHAT_LINE).toContain('90 字');
    expect(CHAT_LINE).toContain('300 字');
    expect(CHAT_LINE).not.toContain('700');
  });
});

describe('tool feedback leads with the fix', () => {
  it('never opens a rejection with a bare prohibition', () => {
    const rows = Object.values(TOOL_PROMPTS).flatMap((module) =>
      collectToolText(module).filter(([key]) => key.startsWith('feedback.')),
    );
    expect(rows.length).toBeGreaterThan(40);
    for (const [key, text] of rows)
      expect(text, key).not.toMatch(/^(?:Do not|Don't|Never|Invalid|invalid answer)\b/);
  });
  it('tells the model what to move when the chat line is too long', () => {
    const text = collectToolText(TOOL_PROMPTS['reply_to_request']!).find(
      ([key]) => key === 'feedback.chatLineTooLong(…)',
    )?.[1];
    expect(text).toMatch(/^Write it like a phone message/);
    expect(text).toContain('only the one thing');
  });
});

describe('runtime packet carries research facts, not gate state', () => {
  it('replaces receipts and internal booleans with a task-facing research summary', () => {
    const ctx = context();
    ctx.informationQueries = ['q'];
    ctx.outboundBlocked = true;
    ctx.answerInputExhausted = true;
    const packet = JSON.stringify(runtimeContext(ctx, 'execution'));
    expect(packet).not.toContain('receipts');
    expect(packet).not.toContain('outboundBlocked');
    expect(packet).not.toContain('evidenceValidationExhausted');
    expect(runtimeContext(ctx, 'execution')['research']).toMatchObject({
      informationSearches: 1,
      sourceFailures: [],
    });
  });
});

describe('evidence card', () => {
  it('renders nothing without sections and starts the card at an invisible marker line otherwise', () => {
    expect(renderEvidenceCard({ sections: [null, '', undefined] })).toBe('');
    const card = renderEvidenceCard({
      sections: ['第二家在 Canary Wharf', null, '[NHS](https://www.nhs.uk/x)'],
    });
    expect(card).toBe('\n\n\u2063\n第二家在 Canary Wharf\n\n[NHS](https://www.nhs.uk/x)');
    expect(card).not.toMatch(/详情|Details|来源|Source/);
    expect(splitEvidenceCard('那句话' + card)).toEqual({
      line: '那句话',
      card: '第二家在 Canary Wharf\n\n[NHS](https://www.nhs.uk/x)',
    });
    expect(splitEvidenceCard('只有一句话')).toEqual({ line: '只有一句话', card: null });
  });
  it('still splits replies stored with the pre-P49 visible header', () => {
    expect(splitEvidenceCard('那句话\n\n【详情】\n旧卡')).toEqual({ line: '那句话', card: '旧卡' });
  });
  it('cleans scraped source titles into readable link labels', () => {
    expect(sourceLabel('Visit Young V&A · V&A', 'https://www.vam.ac.uk/young/visit')).toBe(
      'Visit Young V&A',
    );
    expect(sourceLabel('- Green Flag Award', 'https://www.greenflagaward.org/p')).toBe(
      'Green Flag Award',
    );
    expect(
      sourceLabel('<table><tr><td colspan="6">Southwark</', 'https://www.england.nhs.uk/x.pdf'),
    ).toBe('Southwark');
    expect(sourceLabel('', 'https://www.mudchute.org/whats-on')).toBe('mudchute.org');
    expect(sourceLabel('A'.repeat(50), 'https://a.example/')).toHaveLength(32);
  });
});

describe('group transcript', () => {
  it('feeds back only the chat line of the bot’s own replies, never the folded card', () => {
    const at = new Date('2026-10-21T08:00:00Z');
    const lines = buildGroupTranscript({
      members: [],
      bot: [
        { id: 'o1', text: '去 Young V&A，免费。\n\n\u2063\n第二选项 Mudchute 农场。', sentAt: at },
      ],
      currentMessageId: 'm0',
      currentUserId: 'u0',
    });
    expect(lines.map((l) => l.text)).toEqual(['去 Young V&A，免费。']);
  });
});

it('triage still uses the stage instructions after the move', async () => {
  const model = new ScriptedModel([
    [
      functionCall(
        'triage_message',
        {
          action: 'ignore',
          category: 'other',
          newCondition: false,
          handledByMembers: true,
          sensitive: false,
          reason: 'chatter',
        },
        { callId: 't1' },
      ),
    ],
  ]);
  const outcome = await triageInbound(
    {
      ...deps,
      repos: { traces: { create: vi.fn().mockResolvedValue({}) } },
      modelProvider: { getModel: () => model },
    } as never,
    {
      text: '哈哈哈',
      inputRef: 'm',
      phase: 2,
      isPrivate: false,
      addressedToBot: false,
      transcript: [],
    },
  );
  expect(outcome.ok).toBe(true);
  expect(model.calls[0]?.request.systemInstructions).toBe(TRIAGE_INSTRUCTIONS);
});

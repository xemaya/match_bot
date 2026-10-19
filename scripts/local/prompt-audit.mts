/** Structural prompt evaluation: no model calls, credentials, database or external requests. */
import { createHash } from 'node:crypto';
import { RunContext } from '@openai/agents';
import { createMatchAgent, AGENT_VERSION } from '../../packages/agent/src/agent.js';
import type { AgentDeps, MatchContext } from '../../packages/agent/src/context.js';
import { selectScene } from '../../packages/agent/src/prompts/scenes.js';

// Capability stubs are never invoked; this command only constructs the real agent and prompt.
const deps = {
  env: { DEEPSEEK_MODEL: 'deepseek-flash', XHS_RESEARCH_ENABLED: true },
  answerRequests: true,
  taskRequests: true,
  marketSearch: {},
  webSearch: { research: () => Promise.resolve({ status: 'empty', sources: [] }) },
  pageReader: () => Promise.resolve({ status: 'unavailable', reason: 'audit_only' }),
  xhsSearch: { readNote: () => Promise.resolve(null) },
} as unknown as AgentDeps;
const cases = [
  ['man_and_van', '安排搬家'],
  ['housing', '找一居室'],
  ['second_hand', '找书桌'],
  ['other', '找周末球友'],
  ['other', '附近药房'],
  ['other', 'GP registration'],
  ['other', '周末看展览'],
  ['other', '附近超市'],
  ['job', '找工作'],
] as const;
const rows = [];
for (const [category, text] of cases) {
  const ctx: MatchContext = {
    userId: 'synthetic',
    chatId: 'synthetic',
    groupId: null,
    sourceMessageId: 'audit',
    phase: 0,
    recentReplies: [],
    currentRequest: { text, isActionable: true, demand: { category, confidence: 1 } },
  };
  for (const stage of ['planning', 'execution', 'finalization'] as const) {
    const agent = createMatchAgent(deps, {
      phase: 0,
      context: ctx,
      taskPlanningOnly: stage === 'planning',
      finalAnswerOnly: stage === 'finalization',
    }).agent;
    const rc = new RunContext(ctx);
    const prompt = (await agent.getSystemPrompt(rc))!;
    const maxChars = stage === 'execution' ? 8000 : stage === 'planning' ? 6500 : 5500;
    if (prompt.length > maxChars) throw new Error(stage + ' prompt character budget exceeded');
    rows.push({
      scene: selectScene(ctx),
      stage,
      characters: prompt.length,
      sha256: createHash('sha256').update(prompt).digest('hex'),
      tools: (await agent.getAllTools(rc)).map((t) => (t.type === 'function' ? t.name : t.type)),
    });
  }
}
console.log(
  JSON.stringify({ agentVersion: AGENT_VERSION, kind: 'structural-only', rows }, null, 2),
);

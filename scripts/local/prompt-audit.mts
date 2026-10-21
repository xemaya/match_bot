/**
 * Structural prompt audit: no model calls, credentials, database or external requests.
 *
 * Dumps what the model actually reads, stage by stage, into docs/prompts/ so a person can read it:
 * the full system prompt per stage × scene, every registered tool's description and parameter
 * text, the feedback catalogue a rejected call returns, and a sample runtime data packet. The
 * character budgets from P37 still fail the run when exceeded.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { RunContext } from '@openai/agents';
import { createMatchAgent, AGENT_VERSION } from '../../packages/agent/src/agent.js';
import type { AgentDeps, MatchContext } from '../../packages/agent/src/context.js';
import { selectScene } from '../../packages/agent/src/prompts/policy/scenes.js';
import { STAGE_MATRIX } from '../../packages/agent/src/prompts/stages/index.js';
import { TRIAGE_INSTRUCTIONS } from '../../packages/agent/src/prompts/stages/triage.js';
import { STATUS_INSTRUCTIONS } from '../../packages/agent/src/prompts/stages/status.js';
import { runtimeContext } from '../../packages/agent/src/prompts/runtime-context.js';
import { TOOL_PROMPTS, collectToolText } from '../../packages/agent/src/prompts/tools/index.js';
import { CHAT_LINE, SOUL } from '../../packages/agent/src/prompts/voice.js';

const OUT = 'docs/prompts';
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
const BUDGET = { planning: 6500, execution: 8000, finalization: 5500 } as const;

function synthetic(category: (typeof cases)[number][0], text: string): MatchContext {
  return {
    userId: 'synthetic',
    chatId: 'synthetic',
    groupId: null,
    sourceMessageId: 'audit',
    phase: 0,
    recentReplies: [],
    currentRequest: { text, isActionable: true, demand: { category, confidence: 1 } },
  };
}
type FunctionToolView = { name: string; description: string; parameters: unknown };
function describeTools(tools: Array<{ type: string } & Partial<FunctionToolView>>): string {
  return tools
    .filter((t) => t.type === 'function')
    .map((t) => {
      const params = (t.parameters ?? {}) as {
        properties?: Record<string, { description?: string; type?: unknown; enum?: unknown[] }>;
      };
      const fields = Object.entries(params.properties ?? {}).map(
        ([key, spec]) =>
          `- \`${key}\`${spec.enum ? ' (' + spec.enum.join(' | ') + ')' : ''}${spec.description ? ': ' + spec.description : ''}`,
      );
      return [`### ${t.name}`, '', t.description ?? '', '', ...fields].join('\n');
    })
    .join('\n\n');
}
function fence(text: string): string {
  return '```text\n' + text + '\n```';
}

mkdirSync(OUT, { recursive: true });
const rows = [];
const written: string[] = [];
const overBudget: string[] = [];
const seen = new Set<string>();
for (const [category, text] of cases) {
  const ctx = synthetic(category, text);
  const scene = selectScene(ctx);
  for (const stage of ['planning', 'execution', 'finalization'] as const) {
    const agent = createMatchAgent(deps, {
      phase: 0,
      context: ctx,
      taskPlanningOnly: stage === 'planning',
      finalAnswerOnly: stage === 'finalization',
    }).agent;
    const rc = new RunContext(ctx);
    const prompt = (await agent.getSystemPrompt(rc))!;
    if (prompt.length > BUDGET[stage])
      overBudget.push(`${stage} × ${scene}: ${prompt.length} > ${BUDGET[stage]}`);
    const tools = (await agent.getAllTools(rc)) as Array<
      { type: string } & Partial<FunctionToolView>
    >;
    rows.push({
      scene,
      stage,
      characters: prompt.length,
      sha256: createHash('sha256').update(prompt).digest('hex'),
      tools: tools.map((t) => (t.type === 'function' ? t.name! : t.type)),
    });
    // Planning does not depend on the scene; one dump is enough.
    const key = stage === 'planning' ? 'planning' : `${stage}-${scene}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = `${OUT}/${key}.md`;
    writeFileSync(
      file,
      [
        `# ${stage} × ${scene}`,
        '',
        `样例请求：「${text}」（category=${category}）。由 \`pnpm prompt:audit\` 生成，不要手改。`,
        '',
        `## 系统指令（${prompt.length} 字符）`,
        '',
        fence(prompt),
        '',
        `## 注册的工具（${tools.filter((t) => t.type === 'function').length}）`,
        '',
        describeTools(tools),
        '',
      ].join('\n'),
    );
    written.push(file);
  }
}

// Triage and status have no scene; the runtime packet is sampled once per stage.
writeFileSync(
  `${OUT}/triage.md`,
  ['# triage', '', '## 系统指令', '', fence(TRIAGE_INSTRUCTIONS), ''].join('\n'),
);
writeFileSync(
  `${OUT}/status.md`,
  ['# status', '', '## 系统指令', '', fence(STATUS_INSTRUCTIONS), ''].join('\n'),
);
const packetCtx = synthetic('other', '狗岛附近哪里买感冒药方便');
packetCtx.groupId = 'g';
packetCtx.groupTranscript = [
  { at: '2026-10-20T17:10Z', speaker: '成员a1b2（当前发言者）', text: '狗岛感冒买药去哪方便' },
  { at: '2026-10-20T17:11Z', speaker: '成员c3d4', text: '去Boots吧' },
];
packetCtx.informationQueries = ['Isle of Dogs pharmacy'];
packetCtx.knowledgeSources = [
  {
    ref: 'k1',
    title: 'Allens Pharmacy',
    url: 'https://example.org/allens',
    text: 'Allens Pharmacy, 19 Castalia Square. Open Monday to Friday 9:00 to 18:30.',
    passages: [
      {
        id: 'k1:p1',
        text: 'Allens Pharmacy, 19 Castalia Square. Open Monday to Friday 9:00 to 18:30.',
      },
    ],
  },
] as MatchContext['knowledgeSources'];
writeFileSync(
  `${OUT}/runtime-packet.md`,
  [
    '# 运行时数据包',
    '',
    '每次模型调用前以 user 角色注入的 JSON（`matchbot_runtime_context`），不是系统指令。下面是一个合成样例。',
    '',
    ...(['planning', 'execution', 'finalization'] as const).flatMap((stage) => [
      `## ${stage}`,
      '',
      '```json',
      JSON.stringify(runtimeContext(packetCtx, stage), null, 2),
      '```',
      '',
    ]),
  ].join('\n'),
);
writeFileSync(
  `${OUT}/tools.md`,
  [
    '# 工具层文本',
    '',
    '每个生产工具的 description、参数说明和拒稿反馈，来源 `packages/agent/src/prompts/tools/`。带 `(…)` 的是按参数生成的文案，这里用占位符渲染。',
    '',
    ...Object.entries(TOOL_PROMPTS).flatMap(([name, module]) => [
      `## ${name}`,
      '',
      ...collectToolText(module).map(([key, value]) => `- **${key}**: ${value}`),
      '',
    ]),
  ].join('\n'),
);
writeFileSync(
  `${OUT}/voice.md`,
  [
    '# voice 层',
    '',
    '写给群友读的那一层，中文，运行时整段注入。',
    '',
    SOUL,
    '',
    '---',
    '',
    CHAT_LINE,
    '',
  ].join('\n'),
);
writeFileSync(
  `${OUT}/README.md`,
  [
    `# 模型读到的全部文本（AGENT_VERSION ${AGENT_VERSION}）`,
    '',
    '由 `pnpm prompt:audit` 生成；改了任何提示词后重新生成并一起提交。源文件归属见 `packages/agent/src/prompts/README.md`。',
    '',
    '## 阶段矩阵',
    '',
    '| 阶段 | 注入的层 | 用途 |',
    '| --- | --- | --- |',
    ...Object.entries(STAGE_MATRIX).map(
      ([stage, row]) => `| ${stage} | ${row.layers.join(', ') || '（无）'} | ${row.purpose} |`,
    ),
    '',
    '## 文件',
    '',
    '- [voice.md](./voice.md) 气质与群聊发言规范',
    '- [triage.md](./triage.md) 入站分诊',
    '- [planning.md](./planning.md) 任务规划',
    ...[...seen]
      .filter((k) => k !== 'planning')
      .sort()
      .map((k) => `- [${k}.md](./${k}.md)`),
    '- [status.md](./status.md) 固定状态',
    '- [tools.md](./tools.md) 工具 description、参数说明、拒稿反馈',
    '- [runtime-packet.md](./runtime-packet.md) 运行时数据包样例',
    '',
    '## 结构审计',
    '',
    '| scene | stage | 字符 | 工具 |',
    '| --- | --- | ---: | --- |',
    ...rows.map((r) => `| ${r.scene} | ${r.stage} | ${r.characters} | ${r.tools.join(', ')} |`),
    '',
  ].join('\n'),
);
if (overBudget.length)
  throw new Error('prompt character budget exceeded: ' + overBudget.join('; '));
console.log(
  JSON.stringify(
    { agentVersion: AGENT_VERSION, kind: 'structural-only', written: written.length + 6, rows },
    null,
    2,
  ),
);

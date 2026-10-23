/**
 * P53 T1 PoC: does @openai/agents 0.18.0 `agent.asTool()` give the nested run the outer run's
 * context object (so the researcher's ctx writes are visible to the main agent), honour
 * runOptions.maxTurns / signal, and keep the nested agent's tool calls out of the outer history?
 * Stub models only; no network.
 */
import { Agent, Runner, tool } from '@openai/agents';
import { assistantMessage, functionCall, ScriptedModel } from '@openai/agents/testing';
import { z } from 'zod';

type Ctx = { evidence: string[]; outerSeen?: string[] };
const out = (line: string) => process.stdout.write(line + '\n');

const innerModel = new ScriptedModel([
  [functionCall('collect', { fact: 'k1: museum free entry' }, { callId: 'i1' })],
  [functionCall('collect', { fact: 'k2: open till 17:00' }, { callId: 'i2' })],
  [assistantMessage('brief: k1 and k2 support the museum')],
]);
const collect = tool({
  name: 'collect',
  description: 'collect a fact',
  parameters: z.object({ fact: z.string() }),
  execute: (args, rc) => {
    (rc!.context as Ctx).evidence.push(args.fact);
    return 'ok';
  },
});
const researcher = new Agent<Ctx>({ name: 'researcher', model: innerModel, tools: [collect] });
const researchTool = researcher.asTool({
  toolName: 'research',
  toolDescription: 'research the objective',
  runOptions: { maxTurns: 5 },
});

const outerModel = new ScriptedModel([
  [functionCall('research', { input: 'museum for kids' }, { callId: 'o1' })],
  [functionCall('peek', {}, { callId: 'o2' })],
  [assistantMessage('done')],
]);
const peek = tool({
  name: 'peek',
  description: 'read ctx',
  parameters: z.object({}),
  execute: (_a, rc) => {
    const ctx = rc!.context as Ctx;
    ctx.outerSeen = [...ctx.evidence];
    return JSON.stringify(ctx.evidence);
  },
});
const main = new Agent<Ctx>({ name: 'main', model: outerModel, tools: [researchTool, peek] });

const ctx: Ctx = { evidence: [] };
const result = await new Runner().run(main, 'find a museum', { context: ctx, maxTurns: 6 });
out('outer saw nested ctx writes: ' + JSON.stringify(ctx.outerSeen));
out('same ctx object mutated: ' + (ctx.evidence.length === 2));
const outerItems = result.newItems.map(
  (i) => i.type + ':' + ((i.rawItem as { name?: string }).name ?? ''),
);
out('outer items: ' + outerItems.join(', '));
out(
  'nested collect calls leaked into outer history: ' +
    outerItems.some((s) => s.includes('collect')),
);
const researchOutput = result.newItems.find((i) => i.type === 'tool_call_output_item');
out(
  'research tool output: ' +
    JSON.stringify((researchOutput as { output?: unknown } | undefined)?.output),
);

// maxTurns on the nested run: a researcher that never stops.
const loopModel = new ScriptedModel(
  Array.from({ length: 10 }, (_, i) => [
    functionCall('collect', { fact: 'x' + i }, { callId: 'l' + i }),
  ]),
);
const looping = new Agent<Ctx>({ name: 'looping', model: loopModel, tools: [collect] }).asTool({
  toolName: 'research',
  toolDescription: 'research',
  runOptions: { maxTurns: 3 },
});
const outer2 = new ScriptedModel([
  [functionCall('research', { input: 'x' }, { callId: 'p1' })],
  [assistantMessage('after')],
]);
const ctx2: Ctx = { evidence: [] };
try {
  const r2 = await new Runner().run(
    new Agent<Ctx>({ name: 'main2', model: outer2, tools: [looping] }),
    'go',
    { context: ctx2, maxTurns: 4 },
  );
  const o = r2.newItems.find((i) => i.type === 'tool_call_output_item') as
    { output?: unknown } | undefined;
  out('nested maxTurns: outer continued, tool output = ' + JSON.stringify(o?.output).slice(0, 200));
} catch (error) {
  out(
    'nested maxTurns: outer run threw ' +
      (error as Error).name +
      ': ' +
      (error as Error).message.slice(0, 120),
  );
}
out('nested evidence collected before stop: ' + ctx2.evidence.length);

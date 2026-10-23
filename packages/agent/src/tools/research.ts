import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { buildDeliveryPacket } from '../delivery-context.js';
import { executionInputStats } from '../prompts/runtime-context.js';
import { createResearcherAgent } from '../stages/researcher.js';

export const RESEARCH = {
  description:
    'Sends the researcher to collect evidence for the current request (marketplace, public web, pages). Sends nothing to the group. Returns a short brief: outcome, a writer note and the refs found; the evidence itself appears in the runtime packet. Call it at most once.',
  params: {
    focus:
      'Optional: the one thing to find out, in a few words; empty to research the request as asked.',
  },
} as const;

/** Leaves room after research for the main agent to write and repair one draft. */
const WRITE_RESERVE_MS = 60000;

/**
 * P53: the main agent's way to get facts. The researcher (P52) runs in code inside this tool, not
 * through `asTool`: the T1 PoC showed a nested maxTurns stop comes back as an error string, and
 * this stage needs a budget stop to hand over what was collected, its own trace and input filter.
 */
export function researchTool(deps: AgentDeps) {
  return tool({
    name: 'research',
    description: RESEARCH.description,
    parameters: z.object({ focus: z.string().max(200).describe(RESEARCH.params.focus) }),
    needsApproval: false,
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      if (ctx.researchOutcome === undefined) await runResearcher(deps, ctx, args.focus.trim());
      const packet = buildDeliveryPacket(ctx);
      return JSON.stringify({
        outcome: ctx.researchOutcome ?? 'no_answer',
        note: ctx.researchNote ?? null,
        found: [
          ...packet.market.map((m) => ({ ref: m.ref, title: m.title })),
          ...packet.knowledge.map((k) => ({ ref: k.ref, title: k.title })),
        ],
        unresearchedConditions: packet.unresearchedConditions,
        next: 'Decide your move from the brief and the runtime packet; the researcher is done for this message.',
      });
    },
  });
}

async function runResearcher(deps: AgentDeps, ctx: MatchContext, focus: string): Promise<void> {
  const input = ctx.currentRequest?.text ?? '';
  const { agent, runner } = createResearcherAgent(deps, {
    context: ctx,
    phase: ctx.phase,
    input,
    inputRef: ctx.sourceMessageId,
    ...(ctx.task ? { taskId: ctx.task.id } : {}),
  });
  const remaining = (ctx.runDeadlineAt ?? Date.now() + 120000) - Date.now() - WRITE_RESERVE_MS;
  let stop: string | undefined;
  try {
    await runner.run(agent, focus ? `${input}\n\nFocus: ${focus}` : input, {
      context: ctx,
      maxTurns: 8,
      signal: AbortSignal.timeout(Math.max(1000, remaining)),
    });
  } catch (error) {
    if (!(error instanceof Error) || /Guardrail/.test(error.name)) throw error;
    stop = error.name;
    ctx.sourceFailures ??= [];
    ctx.sourceFailures.push('processing:' + error.name);
  }
  // A budget or time stop hands over whatever was collected, like the P52 bounded finalization.
  ctx.researchOutcome ??=
    ctx.knowledgeSources?.length || ctx.marketListings?.length ? 'deliver' : 'no_answer';
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: ctx.sourceMessageId,
    phase: ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: {
      gate: 'execution_input',
      ...executionInputStats(ctx),
      ...(stop ? { stop } : {}),
      outcome: ctx.researchOutcome,
    },
  });
}

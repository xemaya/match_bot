import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { FINISH_RESEARCH } from '../prompts/tools/finish-research.js';
import { isUnsolicitedGroupTurn } from '../request-status.js';
import { canSkipSupplementReply } from '../supplement-replies.js';

export const RESEARCH_OUTCOMES = ['deliver', 'no_answer', 'skip'] as const;

/**
 * P52: the researcher's only terminal besides record_task_progress(deliver/ask_user). It sends
 * nothing; run.ts routes the outcome (writer, short no-match, or silence) in code.
 */
export function finishResearchTool(deps: AgentDeps) {
  return tool({
    name: 'finish_research',
    description: FINISH_RESEARCH.description,
    parameters: z.object({
      outcome: z.enum(RESEARCH_OUTCOMES).describe(FINISH_RESEARCH.params.outcome),
      note: z.string().max(200).describe(FINISH_RESEARCH.params.note),
    }),
    needsApproval: false,
    execute: async (args, rc) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      // A direct ask always gets a reply (an honest no-match at least); only overheard turns and a
      // server-authorized same-task context supplement may end silent.
      const refused =
        args.outcome === 'skip' && !isUnsolicitedGroupTurn(ctx) && !canSkipSupplementReply(ctx);
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        phase: ctx.phase,
        latencyMs: 0,
        costMicro: 0,
        output: {
          gate: 'research_outcome',
          outcome: args.outcome,
          ...(refused ? { decision: 'skip_refused' } : {}),
        },
      });
      if (refused) return FINISH_RESEARCH.results.skipRefused;
      ctx.researchOutcome = args.outcome;
      const note = args.note.trim();
      if (note) ctx.researchNote = note;
      else delete ctx.researchNote;
      return FINISH_RESEARCH.results.finished(args.outcome);
    },
  });
}

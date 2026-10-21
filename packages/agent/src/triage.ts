import { DEMAND_CATEGORIES, type Phase } from '@matchbot/domain';
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';
import type { AgentDeps } from './context.js';
import type { GroupLine } from './group-context.js';
import { TRIAGE_INSTRUCTIONS } from './prompts/stages/triage.js';

/**
 * JEV_POLICY=off inbound gate: one small generation-model call that reads the recent group
 * conversation and says whether this message is something the assistant should act on. It replaces
 * the Jev questions, not the code rules (blacklist, group activation) that run before it.
 */
export const TRIAGE_ACTIONS = [
  'ignore',
  'acknowledge',
  'answer',
  'continue',
  'peer_offer',
] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export const triageVerdictSchema = z.object({
  action: z.enum(TRIAGE_ACTIONS),
  category: z.enum(DEMAND_CATEGORIES),
  /** continue only: the message adds a condition or question that changes what to look for. */
  newCondition: z.boolean(),
  /** The message is part of an exchange between members, or someone already answered it. */
  handledByMembers: z.boolean(),
  sensitive: z.boolean(),
  reason: z.string().max(200),
});
export type TriageVerdict = z.infer<typeof triageVerdictSchema>;
export type TriageOutcome =
  | { ok: true; verdict: TriageVerdict }
  | { ok: false; reason: 'timeout' | 'invalid_response' | 'provider_error'; detail?: string };

// Instructions live with the other stage prompts (prompts/stages/triage.ts).

export async function triageInbound(
  deps: AgentDeps,
  p: {
    text: string;
    inputRef: string;
    phase: Phase;
    isPrivate: boolean;
    addressedToBot: boolean;
    replyToBotText?: string | undefined;
    transcript: GroupLine[];
  },
): Promise<TriageOutcome> {
  let verdict: TriageVerdict | undefined;
  const submit = tool({
    name: 'triage_message',
    description: 'Record the triage decision for the current message.',
    parameters: triageVerdictSchema,
    needsApproval: false,
    execute: (args) => {
      verdict = args;
      return 'recorded';
    },
  });
  const agent = new Agent({
    name: 'inboundTriage',
    model: deps.env.DEEPSEEK_MODEL,
    instructions: TRIAGE_INSTRUCTIONS,
    tools: [submit],
    toolUseBehavior: 'stop_on_first_tool',
    modelSettings: {
      toolChoice: 'required',
      // Reasoning models spend output tokens thinking before the tool call; 300 truncated 9 of 29
      // triage calls in the 2026-10-20 run 2 (every failure had exactly 300 output tokens).
      maxTokens: 1500,
      ...(deps.env.DEEPSEEK_MODEL === 'deepseek-flash'
        ? { temperature: 0, providerData: { thinking: { type: 'disabled' } } }
        : {}),
      ...(deps.env.GENERATION_REASONING_EFFORT
        ? { reasoning: { effort: deps.env.GENERATION_REASONING_EFFORT } }
        : {}),
    },
  });
  const runner = new Runner({
    traceIncludeSensitiveData: false,
    traceMetadata: {
      model: deps.env.DEEPSEEK_MODEL,
      phase: String(p.phase),
      promptStage: 'triage',
      inputRef: p.inputRef,
    },
    ...(deps.modelProvider ? { modelProvider: deps.modelProvider } : {}),
  });
  const input = JSON.stringify({
    kind: 'matchbot_triage_input',
    chat: p.isPrivate ? 'private' : 'group',
    addressedToA2H: p.addressedToBot,
    quotedA2HReply: p.replyToBotText?.slice(0, 500) ?? null,
    groupConversation: p.transcript,
    currentMessage: p.text,
  });
  // A prose answer, a slow reasoning turn or a provider hiccup each get one cheap retry
  // (~2k tokens); a dropped triage loses the message for good. 2026-10-21: a 25 s abort surfaced
  // as "Error: Request was aborted." and was filed as provider_error without retry.
  let failure: TriageOutcome | undefined;
  for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
    try {
      await runner.run(agent, input, { maxTurns: 1, signal: AbortSignal.timeout(40000) });
      failure = undefined;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : String(error);
      failure = {
        ok: false,
        reason: /timeout|abort/i.test(name + ' ' + message) ? 'timeout' : 'provider_error',
        detail: (name + ': ' + message).slice(0, 200),
      };
    }
  }
  if (failure) return failure;
  if (!verdict) return { ok: false, reason: 'invalid_response' };
  return { ok: true, verdict };
}

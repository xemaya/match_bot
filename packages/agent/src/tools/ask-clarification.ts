import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { ASK_CLARIFICATION } from '../prompts/tools/catalogue.js';
import { groupReplyAddressing } from './addressing.js';
import { makeOutboundTool } from './make-outbound-tool.js';

export function askClarificationTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'ask_clarification',
    description: ASK_CLARIFICATION.description,
    parameters: z.object({
      question: z.string().min(1).max(500).describe(ASK_CLARIFICATION.params.question),
      missingFields: z.array(z.string()).min(1).describe(ASK_CLARIFICATION.params.missingFields),
    }),
    toDraft: (ctx, args: { question: string; missingFields: string[] }) =>
      Promise.resolve({
        kind: 'clarification',
        target: ctx.chatId,
        text: args.question,
        supplierSummaries: [],
        inputRef: ctx.sourceMessageId,
        ...groupReplyAddressing(ctx),
      }),
  });
}

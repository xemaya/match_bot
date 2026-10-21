import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { REPLY_IN_GROUP } from '../prompts/tools/catalogue.js';
import { groupReplyAddressing } from './addressing.js';
import { makeOutboundTool } from './make-outbound-tool.js';

export const replyInGroupParams = z.object({
  text: z.string().min(1).max(1500).describe(REPLY_IN_GROUP.params.text),
  supplierIds: z.array(z.string()).min(1).max(3).describe(REPLY_IN_GROUP.params.supplierIds),
});

export function replyInGroupTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_in_group',
    description: REPLY_IN_GROUP.description,
    parameters: replyInGroupParams,
    toDraft: async (ctx, args: z.infer<typeof replyInGroupParams>) => {
      const suppliers = await deps.repos.suppliers.findByIds(args.supplierIds);
      if (suppliers.length !== new Set(args.supplierIds).size)
        return { error: REPLY_IN_GROUP.feedback.unknownSupplier };
      return {
        kind: 'recommendation',
        target: ctx.chatId,
        text: args.text,
        supplierSummaries: suppliers.map((s) => `${s.name} ${s.roughPrice ?? ''}`.trim()),
        inputRef: ctx.sourceMessageId,
        ...groupReplyAddressing(ctx),
      };
    },
  });
}

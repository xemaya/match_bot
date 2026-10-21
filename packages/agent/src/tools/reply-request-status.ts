import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { REPLY_REQUEST_STATUS } from '../prompts/tools/catalogue.js';
import { renderRequestStatus } from '../request-status.js';
import { makeOutboundTool } from './make-outbound-tool.js';
import { groupReplyAddressing } from './addressing.js';

export function replyRequestStatusTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_request_status',
    description: REPLY_REQUEST_STATUS.description,
    isRequestStatus: true,
    parameters: z.object({}),
    toDraft: (ctx) => {
      const text = renderRequestStatus(ctx);
      if (!text) return Promise.resolve({ error: REPLY_REQUEST_STATUS.feedback.notAuthorized });
      return Promise.resolve({
        kind: 'notification' as const,
        target: ctx.chatId,
        text,
        supplierSummaries: [],
        inputRef: ctx.sourceMessageId,
        replyPurpose: 'request_status' as const,
        ...groupReplyAddressing(ctx),
      });
    },
  });
}

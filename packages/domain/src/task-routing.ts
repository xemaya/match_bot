import { z } from 'zod';
import { taskSchema } from './task.js';

const selectionSchema = z.strictObject({
  ownerUserId: taskSchema.shape.ownerUserId,
  scope: taskSchema.shape.scope,
  tasks: z.array(taskSchema).max(100),
  intent: z.enum(['new', 'continue', 'unsure']),
  anchorTaskId: taskSchema.shape.id.optional(),
  referencedTaskId: taskSchema.shape.id.optional(),
});
export type TaskSelection =
  | { kind: 'new' | 'unbound' | 'inaccessible' }
  | { kind: 'selected'; taskId: string }
  | { kind: 'clarify'; candidateIds: string[] };

/** PRD §13: scope and explicit references outrank recency; semantic intent is supplied by the caller. */
export function selectTask(input: z.input<typeof selectionSchema>): TaskSelection {
  const p = selectionSchema.parse(input);
  const available = p.tasks.filter(
    (task) =>
      task.ownerUserId === p.ownerUserId &&
      task.scope.channel === p.scope.channel &&
      task.scope.chatId === p.scope.chatId &&
      (task.scope.threadId ?? '') === (p.scope.threadId ?? '') &&
      !['completed', 'cancelled', 'expired'].includes(task.status),
  );
  const candidateIds = available.map((task) => task.id);
  const references = [p.anchorTaskId, p.referencedTaskId].filter((v) => v !== undefined);
  if (references.some((ref) => !candidateIds.includes(ref))) return { kind: 'inaccessible' };
  if (p.intent === 'new') return { kind: 'new' };
  if (new Set(references).size > 1) return { kind: 'clarify', candidateIds };
  const reference = references[0];
  if (reference) return { kind: 'selected', taskId: reference };
  const only = available[0];
  if (!only) return { kind: 'unbound' };
  if (p.intent === 'continue' && available.length === 1)
    return { kind: 'selected', taskId: only.id };
  return { kind: 'clarify', candidateIds };
}

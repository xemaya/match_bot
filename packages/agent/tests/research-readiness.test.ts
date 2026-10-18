import { expect, it } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import type { MatchContext } from '../src/context.js';
import { pendingResearchConditions } from '../src/research-readiness.js';
function context(): MatchContext {
  return {
    userId: 'u',
    chatId: 'c',
    groupId: null,
    sourceMessageId: 'new',
    phase: 0,
    recentReplies: [],
    taskUpdate: { kind: 'continued' },
    task: taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: 'c' },
      objective: 'printer',
      category: 'second_hand',
      status: 'active',
      revision: 2,
      requirementsVersion: 2,
      goals: [
        {
          id: 'g',
          title: 'printer',
          required: true,
          criteria: [
            {
              id: 'wifi',
              label: 'wireless',
              constraintKey: 'feature',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'feature',
          strength: 'hard',
          value: { kind: 'text', text: 'wireless' },
          origin: { kind: 'user', sourceMessageId: 'new' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
  };
}
it('does not count old-source detail reads as research on a new hard condition', () => {
  const c = context();
  c.marketDetailIds = ['old'];
  expect(pendingResearchConditions(c)).toEqual(['feature']);
  c.informationQueries = ['printer wireless'];
  expect(pendingResearchConditions(c)).toEqual([]);
});
it('permits confirmed conditions, unavailable sources and bounded finalization', () => {
  const c = context();
  c.task!.goals[0]!.criteria[0]!.status = 'supported';
  expect(pendingResearchConditions(c)).toEqual([]);
  c.task!.goals[0]!.criteria[0]!.status = 'unknown';
  c.sourceFailures = ['information:unavailable'];
  expect(pendingResearchConditions(c)).toEqual([]);
  c.sourceFailures = [];
  c.runDeadlineAt = Date.now() + 10000;
  expect(pendingResearchConditions(c)).toEqual([]);
});
it('does not impose another search on old constraints, new tasks or foreign tasks', () => {
  const c = context();
  c.task!.constraints[0]!.origin = { kind: 'user', sourceMessageId: 'old' };
  expect(pendingResearchConditions(c)).toEqual([]);
  const fresh = context();
  fresh.taskUpdate = { kind: 'new' };
  expect(pendingResearchConditions(fresh)).toEqual([]);
  const foreign = context();
  foreign.task!.ownerUserId = 'other';
  expect(pendingResearchConditions(foreign)).toEqual([]);
});

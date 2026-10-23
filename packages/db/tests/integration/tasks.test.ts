import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

async function seed(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const repos = createRepositories(tx);
  const owner = await repos.users.upsertByExternal({
    channel: 'telegram',
    externalId: 'p24-owner',
  });
  const other = await repos.users.upsertByExternal({
    channel: 'telegram',
    externalId: 'p24-other',
  });
  const group = await repos.groups.upsert({
    channel: 'telegram',
    externalId: '-p24-group',
    name: 'synthetic task fixture',
  });
  const message = await repos.messages.create({
    groupId: group.id,
    userId: owner.id,
    externalId: 'p24-first',
    text: 'E14找桌椅，每件50以内',
    receivedAt: new Date('2026-10-17T00:00:00Z'),
  });
  const access = {
    userId: owner.id,
    scope: { channel: 'telegram' as const, chatId: group.externalId },
  };
  return { repos, owner, other, message, access };
}
describe('task repository', () => {
  it('reloads source progress and next action while rejecting stale requirements', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'progress',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      await repos.tasks.applyUserTurn({
        access,
        id: task.id,
        expectedRevision: 0,
        operationKey: 'plan',
        sourceMessageId: message.id,
        patch: {
          goals: [
            {
              id: 'desk',
              title: '书桌',
              required: true,
              sourceQuote: '桌椅',
              criteria: [{ id: 'source', label: '原帖可核验', strength: 'hard' }],
            },
          ],
          constraints: [],
        },
        outcome: null,
      });
      const input = {
        access,
        id: task.id,
        expectedRevision: 1,
        operationKey: 'source-progress',
        sourceMessageId: message.id,
        progress: {
          requirementsVersion: 1,
          evidence: [
            {
              id: 'quote',
              goalId: 'desk',
              kind: 'source_excerpt' as const,
              sourceRef: 'market:fixture',
              entityKey: 'offer:fixture',
              summary: '书桌£40',
              observedAt: '2026-10-17T01:00:00Z',
            },
          ],
          checks: [
            {
              goalId: 'desk',
              criterionId: 'source',
              status: 'supported' as const,
              evidenceRefs: ['quote'],
            },
          ],
          nextStep: {
            action: 'deliver' as const,
            owner: 'agent' as const,
            reason: '可以给出带缺口的建议',
          },
        },
      };
      expect((await repos.tasks.recordProgress(input)).kind).toBe('applied');
      expect((await repos.tasks.recordProgress(input)).kind).toBe('replayed');
      const reloaded = await createRepositories(tx).tasks.findById({ access, id: task.id });
      expect(reloaded?.nextStep?.action).toBe('deliver');
      expect(reloaded?.evidence[0]?.sourceRef).toBe('market:fixture');
      expect(reloaded?.status).toBe('active');
      expect(reloaded?.userConfirmation).toBeNull();
      await expect(
        repos.tasks.recordProgress({
          ...input,
          operationKey: 'old-requirements',
          expectedRevision: 2,
          progress: { ...input.progress, requirementsVersion: 0 },
        }),
      ).rejects.toThrow('requirements');
    }));
  it('applies a whole user turn atomically and rejects an invalid outcome without partial requirements', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'turn',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      const patch = {
        goals: ['desk', 'chair'].map((id) => ({
          id,
          title: id,
          required: true,
          sourceQuote: '桌椅',
          criteria: [{ id: 'fit', label: '条件适配', strength: 'hard' as const }],
        })),
        constraints: [],
      };
      const input = {
        access,
        id: task.id,
        expectedRevision: 0,
        operationKey: 'whole-turn',
        sourceMessageId: message.id,
        patch,
        outcome: { intent: 'achieved' as const, goalIds: ['missing'] },
      };
      await expect(repos.tasks.applyUserTurn(input)).rejects.toThrow('existing goal');
      expect((await repos.tasks.findById({ access, id: task.id }))?.goals).toEqual([]);
      const applied = await repos.tasks.applyUserTurn({ ...input, outcome: null });
      expect(applied.kind).toBe('applied');
      expect(await tx.taskEvent.count({ where: { taskId: task.id } })).toBe(2);
      expect((await repos.tasks.findById({ access, id: task.id }))?.revision).toBe(1);
    }));
  it('does not write a checkpoint or advance the task for fabricated requirement provenance', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      await expect(
        repos.tasks.reviseRequirements({
          access,
          id: task.id,
          expectedRevision: 0,
          operationKey: 'invented',
          sourceMessageId: message.id,
          patch: {
            goals: [],
            constraints: [
              {
                key: 'budget',
                strength: 'hard',
                value: { kind: 'money', amountPence: 10000, unit: 'item' },
                sourceQuote: '预算100',
              },
            ],
          },
        }),
      ).rejects.toThrow('source');
      expect((await repos.tasks.findById({ access, id: task.id }))?.revision).toBe(0);
      expect(await tx.taskEvent.count({ where: { taskId: task.id } })).toBe(1);
    }));
  it('keeps the newest user activity time when an older input is processed later', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      for (const [index, date] of ['2026-10-18', '2026-10-16'].entries()) {
        const source = await repos.messages.create({
          userId: access.userId,
          groupId: message.groupId,
          externalId: 'p24-time-' + index,
          text: '仍在找桌椅',
          receivedAt: new Date(date + 'T00:00:00Z'),
        });
        await repos.tasks.transition({
          access,
          id: task.id,
          expectedRevision: index,
          operationKey: 'time-' + index,
          next: 'active',
          actor: {
            kind: 'user',
            userId: access.userId,
            messageId: source.id,
            intent: 'unspecified',
          },
        });
      }
      expect(await repos.tasks.deleteInactiveBefore(new Date('2026-10-17T12:00:00Z'))).toBe(0);
    }));
  it('applies only one of two overlapping repository calls in the rollback transaction', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'concurrent',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      const results = await Promise.all(
        ['writer-a', 'writer-b'].map((operationKey) =>
          repos.tasks.transition({
            access,
            id: task.id,
            expectedRevision: 0,
            operationKey,
            next: 'active',
            actor: { kind: 'agent' },
          }),
        ),
      );
      expect(results.map((r) => r.kind).sort()).toEqual(['applied', 'conflict']);
      expect((await repos.tasks.findById({ access, id: task.id }))?.revision).toBe(1);
      expect(await tx.taskEvent.count({ where: { taskId: task.id } })).toBe(2);
      // These calls share the required rollback transaction; independent connection/process fault tests belong to P26.
    }));
  it('persists scoped requirement revisions and confirms only one user subgoal', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message, owner } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      const input = {
        access,
        id: task.id,
        expectedRevision: 0,
        operationKey: 'initial-plan',
        sourceMessageId: message.id,
        patch: {
          goals: ['desk', 'chair'].map((id) => ({
            id,
            title: id,
            required: true,
            sourceQuote: '桌椅',
            criteria: [{ id: 'fit', label: '条件适配', strength: 'hard' as const }],
          })),
          constraints: ['desk', 'chair'].map((goalId) => ({
            key: 'budget',
            goalId,
            strength: 'hard' as const,
            value: { kind: 'money' as const, amountPence: 5000, unit: 'item' as const },
            sourceQuote: '每件50',
          })),
        },
      };
      expect((await repos.tasks.reviseRequirements(input)).kind).toBe('applied');
      expect((await repos.tasks.reviseRequirements(input)).kind).toBe('replayed');
      const reloaded = await createRepositories(tx).tasks.findById({ access, id: task.id });
      expect(reloaded).toMatchObject({ revision: 1, requirementsVersion: 1 });
      expect(reloaded?.goals.map((g) => g.id)).toEqual(['desk', 'chair']);
      const bought = await repos.messages.create({
        userId: owner.id,
        groupId: message.groupId,
        externalId: 'p24-chair-bought',
        text: '椅子买好了，桌子继续',
        receivedAt: new Date('2026-10-17T02:00:00Z'),
      });
      const result = await repos.tasks.confirmGoal({
        access,
        id: task.id,
        expectedRevision: 1,
        operationKey: 'chair-bought',
        goalId: 'chair',
        actor: { kind: 'user', userId: owner.id, messageId: bought.id, intent: 'achieved' },
      });
      expect(result.kind).toBe('applied');
      const after = await repos.tasks.findById({ access, id: task.id });
      expect(after?.status).toBe('active');
      expect(after?.goals[0]?.userConfirmation).toBeNull();
      expect(after?.goals[1]?.userConfirmation?.sourceMessageId).toBe(bought.id);
      expect(after?.goals[1]?.criteria[0]?.status).toBe('unknown');
    }));
  it('rejects reuse of a creation key for a different objective', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const input = {
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand' as const,
      };
      await repos.tasks.create(input);
      await expect(repos.tasks.create({ ...input, objective: '换成找房' })).rejects.toThrow(
        'replay',
      );
      expect(await tx.task.count({ where: { userId: access.userId } })).toBe(1);
    }));
  it('lists only open tasks in the current owner and conversation scope', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      expect((await repos.tasks.findOpenByScope(access)).map((t) => t.id)).toEqual([task.id]);
      expect(
        await repos.tasks.findOpenByScope({
          ...access,
          scope: { ...access.scope, chatId: 'elsewhere' },
        }),
      ).toEqual([]);
      await repos.tasks.transition({
        access,
        id: task.id,
        expectedRevision: 0,
        operationKey: 'cancel',
        next: 'cancelled',
        actor: { kind: 'user', userId: access.userId, messageId: message.id, intent: 'cancelled' },
      });
      expect(await repos.tasks.findOpenByScope(access)).toEqual([]);
    }));
  it('lists open tasks across members in one chat, newest first and capped (P53)', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      const inChat = { channel: access.scope.channel, chatId: access.scope.chatId };
      expect(
        (await repos.tasks.findOpenInChat({ ...inChat, limit: 6 })).map((t) => t.id),
      ).toContain(task.id);
      expect(
        await repos.tasks.findOpenInChat({ ...inChat, chatId: 'elsewhere', limit: 6 }),
      ).toEqual([]);
      await expect(repos.tasks.findOpenInChat({ ...inChat, limit: 50 })).rejects.toThrow();
    }));
  it('deletes inactive task personal data and event checkpoints, retaining recent tasks', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      expect(await repos.tasks.deleteInactiveBefore(new Date('2026-10-16T00:00:00Z'))).toBe(0);
      expect(await repos.tasks.deleteInactiveBefore(new Date('2026-10-18T00:00:00Z'))).toBe(1);
      expect(await tx.taskEvent.count({ where: { taskId: task.id } })).toBe(0);
      expect(await repos.tasks.findById({ access, id: task.id })).toBeNull();
    }));
  it('persists a task and its initial checkpoint atomically, with idempotent creation', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const input = {
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand' as const,
      };
      const first = await repos.tasks.create(input),
        second = await repos.tasks.create(input);
      expect(first.id).toBe(second.id);
      expect(first.status).toBe('active');
      expect(first.goals).toEqual([]);
      expect(await tx.taskEvent.count({ where: { taskId: first.id } })).toBe(1);
      expect(await repos.tasks.findById({ access, id: first.id })).toEqual(first);
    }));
  it('does not expose another user or another conversation task', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message, other } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      expect(
        await repos.tasks.findById({ access: { ...access, userId: other.id }, id: task.id }),
      ).toBeNull();
      expect(
        await repos.tasks.findById({
          access: { ...access, scope: { ...access.scope, chatId: 'another-chat' } },
          id: task.id,
        }),
      ).toBeNull();
      await expect(
        repos.tasks.create({
          access: { ...access, userId: other.id },
          sourceMessageId: message.id,
          intentKey: 'foreign',
          objective: '改别人的任务',
          category: 'other',
        }),
      ).rejects.toThrow('inaccessible');
    }));
  it('records transitions with optimistic revision and prevents replay changes', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      const input = {
        access,
        id: task.id,
        expectedRevision: 0,
        operationKey: 'progress',
        next: 'active' as const,
        actor: { kind: 'agent' as const },
      };
      expect((await repos.tasks.transition(input)).kind).toBe('applied');
      expect((await repos.tasks.transition(input)).kind).toBe('replayed');
      expect((await repos.tasks.transition({ ...input, operationKey: 'stale' })).kind).toBe(
        'conflict',
      );
      await expect(repos.tasks.transition({ ...input, next: 'expired' })).rejects.toThrow('replay');
      expect(await tx.taskEvent.count({ where: { taskId: task.id } })).toBe(2);
    }));
  it('only accepts grounded owner confirmation and survives a fresh repository instance', async () =>
    withTestDb(async (tx) => {
      const { repos, access, message, owner, other } = await seed(tx);
      const task = await repos.tasks.create({
        access,
        sourceMessageId: message.id,
        intentKey: 'furniture',
        objective: '找到桌椅',
        category: 'second_hand',
      });
      const confirmation = await repos.messages.create({
        userId: owner.id,
        groupId: message.groupId,
        externalId: 'p24-done',
        text: '都买好了，解决了',
        receivedAt: new Date('2026-10-17T01:00:00Z'),
      });
      await expect(
        repos.tasks.transition({
          access,
          id: task.id,
          expectedRevision: 0,
          operationKey: 'fake',
          next: 'completed',
          actor: { kind: 'user', userId: other.id, messageId: confirmation.id, intent: 'achieved' },
        }),
      ).rejects.toThrow('owner');
      const result = await repos.tasks.transition({
        access,
        id: task.id,
        expectedRevision: 0,
        operationKey: 'done',
        next: 'completed',
        actor: { kind: 'user', userId: owner.id, messageId: confirmation.id, intent: 'achieved' },
      });
      expect(result.kind).toBe('applied');
      const again = createRepositories(tx);
      expect(
        (await again.tasks.findById({ access, id: task.id }))?.userConfirmation?.sourceMessageId,
      ).toBe(confirmation.id);
    }));
});

import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

describe('member notes (P54)', () => {
  it('only notes a public message of the same member in the same group, expiring 30 days after it', async () =>
    withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const a = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'na' });
      const b = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'nb' });
      const g = await r.groups.upsert({ channel: 'telegram', externalId: '-71', name: 'g' });
      const at = new Date(Date.now() - 86400e3);
      const offer = await r.messages.create({
        groupId: g.id,
        userId: a.id,
        externalId: '1',
        text: '我有多的羽毛球拍',
        receivedAt: at,
      });
      const note = await r.memberNotes.add({
        groupId: g.id,
        userId: a.id,
        kind: 'offer',
        text: '有多的羽毛球拍可以借',
        sourceMessageId: offer.id,
      });
      expect(note.expiresAt.getTime()).toBe(at.getTime() + 30 * 86400e3);
      await expect(
        r.memberNotes.add({
          groupId: g.id,
          userId: b.id,
          kind: 'offer',
          text: '冒名的备注',
          sourceMessageId: offer.id,
        }),
      ).rejects.toThrow('public message of that member');
      expect((await r.memberNotes.listForGroup({ groupId: g.id, limit: 10 })).length).toBe(1);
      await r.memberNotes.supersede(g.id, [note.id]);
      expect(await r.memberNotes.listForGroup({ groupId: g.id, limit: 10 })).toEqual([]);
    }));
  it('deletes on expiry, on a blanked source, per member (/forget) and per group', async () =>
    withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const a = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'nc' });
      const g = await r.groups.upsert({ channel: 'telegram', externalId: '-72', name: 'g' });
      const add = async (externalId: string, daysAgo: number) => {
        const m = await r.messages.create({
          groupId: g.id,
          userId: a.id,
          externalId,
          text: '住 Mile End',
          receivedAt: new Date(Date.now() - daysAgo * 86400e3),
        });
        return r.memberNotes.add({
          groupId: g.id,
          userId: a.id,
          kind: 'context',
          text: '住在 Mile End 附近',
          sourceMessageId: m.id,
        });
      };
      await add('1', 31);
      expect(await r.memberNotes.deleteExpired()).toBe(1);
      const fresh = await add('2', 1);
      await tx.message.update({ where: { id: fresh.sourceMessageId }, data: { text: '' } });
      expect(await r.memberNotes.deleteWithRedactedSource()).toBe(1);
      await add('3', 1);
      expect(await r.memberNotes.deleteForUser(a.id)).toBe(1);
      await add('4', 1);
      expect(await r.memberNotes.deleteForGroup(g.id)).toBe(1);
    }));
  it('lists groups with messages after their last notetaker pass', async () =>
    withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const a = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'nd' });
      const g = await r.groups.upsert({ channel: 'telegram', externalId: '-73', name: 'g' });
      await r.messages.create({
        groupId: g.id,
        userId: a.id,
        externalId: '1',
        text: 'hi',
        receivedAt: new Date(),
      });
      expect((await r.groups.pendingMemory(500)).map((p) => p.id)).toContain(g.id);
      await r.groups.markMemoryConsolidated(g.id, new Date(Date.now() + 1000));
      expect((await r.groups.pendingMemory(500)).map((p) => p.id)).not.toContain(g.id);
    }));
});

import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

describe('group conversation context', () => {
  it('recentInGroup returns all members newest first within the window and skips redacted rows', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const a = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'ga' });
      const b = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'gb' });
      const g = await r.groups.upsert({ channel: 'telegram', externalId: '-7', name: 'g' });
      const other = await r.groups.upsert({ channel: 'telegram', externalId: '-8', name: 'o' });
      const now = Date.now();
      await r.messages.create({
        groupId: g.id,
        userId: a.id,
        externalId: '1',
        text: 'old',
        receivedAt: new Date(now - 7 * 3600e3),
      });
      await r.messages.create({
        groupId: g.id,
        userId: a.id,
        externalId: '2',
        text: 'first',
        receivedAt: new Date(now - 120e3),
      });
      await r.messages.create({
        groupId: g.id,
        userId: b.id,
        externalId: '3',
        text: 'second',
        receivedAt: new Date(now - 60e3),
      });
      await r.messages.create({
        groupId: g.id,
        userId: b.id,
        externalId: '4',
        text: '',
        receivedAt: new Date(now - 30e3),
      });
      await r.messages.create({
        groupId: other.id,
        userId: b.id,
        externalId: '5',
        text: 'elsewhere',
        receivedAt: new Date(now - 10e3),
      });
      const rows = await r.messages.recentInGroup(g.id, { limit: 10, sinceHours: 6 });
      expect(rows.map((m) => m.text)).toEqual(['second', 'first']);
      expect(
        (await r.messages.recentInGroup(g.id, { limit: 1, sinceHours: 6 })).map((m) => m.text),
      ).toEqual(['second']);
      expect(
        (
          await r.messages.recentInGroup(g.id, {
            limit: 10,
            sinceHours: 6,
            before: new Date(now - 60e3),
          })
        ).map((m) => m.text),
      ).toEqual(['first']);
    });
  });
  it('recentSentToTarget returns only confirmed non-reaction sends for that chat', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const sent = await r.outbound.create(
        { channel: 'telegram', target: '-7', text: 'posted', phase: 2 },
        'pending',
      );
      const [claim] = await r.outbound.claimPending(10);
      await r.outbound.beginSend({ id: sent.id, leaseToken: claim!.leaseToken! });
      await r.outbound.markSent({
        id: sent.id,
        leaseToken: claim!.leaseToken!,
        externalMessageId: '9',
      });
      await r.outbound.create(
        { channel: 'telegram', target: '-7', text: 'draft', phase: 2 },
        'pending',
      );
      await r.outbound.create({ channel: 'telegram', target: '-9', text: 'other chat' }, 'dry_run');
      const rows = await r.outbound.recentSentToTarget('-7', { limit: 10, sinceHours: 6 });
      expect(rows.map((o) => o.text)).toEqual(['posted']);
      expect(rows[0]!.sentAt).toBeInstanceOf(Date);
    });
  });
  it('lastSentToUser reports only confirmed sends addressed to that member in that chat', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      expect(await r.outbound.lastSentToUser('-7', 'u-ask')).toBeNull();
      const sent = await r.outbound.create(
        { channel: 'telegram', target: '-7', text: 'for u-ask', phase: 2, mentionUserId: 'u-ask' },
        'pending',
      );
      await r.outbound.create(
        {
          channel: 'telegram',
          target: '-7',
          text: 'still pending',
          phase: 2,
          mentionUserId: 'u-ask',
        },
        'pending',
      );
      const [claim] = (await r.outbound.claimPending(10)).filter((c) => c.id === sent.id);
      await r.outbound.beginSend({ id: sent.id, leaseToken: claim!.leaseToken! });
      await r.outbound.markSent({
        id: sent.id,
        leaseToken: claim!.leaseToken!,
        externalMessageId: '10',
      });
      expect(await r.outbound.lastSentToUser('-7', 'u-ask')).toBeInstanceOf(Date);
      expect(await r.outbound.lastSentToUser('-7', 'u-other')).toBeNull();
      expect(await r.outbound.lastSentToUser('-8', 'u-ask')).toBeNull();
      const since = new Date(Date.now() - 86400e3);
      expect(await r.outbound.recentSentToUser('-7', 'u-ask', { since, limit: 5 })).toEqual([
        'for u-ask',
      ]);
      expect(await r.outbound.recentSentToUser('-7', 'u-other', { since, limit: 5 })).toEqual([]);
      expect(
        await r.outbound.recentSentToUser('-7', 'u-ask', {
          since: new Date(Date.now() + 60_000),
          limit: 5,
        }),
      ).toEqual([]);
    });
  });
});

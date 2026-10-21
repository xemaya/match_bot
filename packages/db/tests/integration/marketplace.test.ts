import { IllegalTransitionError } from '@matchbot/domain';
import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

describe('demands', () => {
  it('create + findOpenByUser + setStatus honours the state machine', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'd1' });
      const d = await r.demands.create({
        userId: u.id,
        category: 'man_and_van',
        confidence: 0.9,
        sourceMessageId: 'm1',
        fromPostcode: 'E14',
      });
      expect((await r.demands.findOpenByUser(u.id)).map((x) => x.id)).toEqual([d.id]);
      await r.demands.setStatus(d.id, 'closed');
      await expect(r.demands.setStatus(d.id, 'open')).rejects.toBeInstanceOf(
        IllegalTransitionError,
      );
      expect(await r.demands.findOpenByUser(u.id)).toEqual([]);
    });
  });
  it('update appends sourceMessageId', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'd2' });
      const d = await r.demands.create({
        userId: u.id,
        category: 'man_and_van',
        confidence: 0.5,
        sourceMessageId: 'm1',
      });
      const d2 = await r.demands.update(d.id, { toPostcode: 'SE1', sourceMessageId: 'm2' });
      expect(d2.toPostcode).toBe('SE1');
      expect(d2.sourceMessageIds).toEqual(['m1', 'm2']);
    });
  });
});

describe('suppliers + matches + leads', () => {
  it('replaceForDemand replaces rows and leads attach to a match', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'd3' });
      const d = await r.demands.create({
        userId: u.id,
        category: 'man_and_van',
        confidence: 0.9,
        sourceMessageId: 'm1',
      });
      const s = await tx.supplier.create({
        data: {
          category: 'man_and_van',
          name: 'Van Co',
          serviceArea: ['E14'],
          languages: ['en'],
          pool: 'A',
        },
      });
      expect(
        (await r.suppliers.findCandidates({ category: 'man_and_van', pool: 'A' })).map((x) => x.id),
      ).toContain(s.id);
      await r.matches.replaceForDemand(d.id, [{ supplierId: s.id, matcherScore: 0.8, rank: 1 }]);
      const [m] = await r.matches.replaceForDemand(d.id, [
        { supplierId: s.id, matcherScore: 0.9, rank: 1 },
      ]);
      expect(await tx.match.count({ where: { demandId: d.id } })).toBe(1);
      const lead = await r.leads.create({
        matchId: m!.id,
        sentVia: 'telegram',
        sentAt: new Date(),
      });
      expect((await r.leads.update(lead.id, { supplierResponse: 'quote' })).supplierResponse).toBe(
        'quote',
      );
    });
  });
});

describe('supplies', () => {
  it('findActive excludes expired', async () => {
    await withTestDb(async (tx) => {
      const r = createRepositories(tx);
      const u = await r.users.upsertByExternal({ channel: 'telegram', externalId: 'd4' });
      const g = await r.groups.upsert({ channel: 'telegram', externalId: '-1', name: 'g' });
      await r.supplies.create({
        userId: u.id,
        groupId: g.id,
        category: 'man_and_van',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        sourceMessageId: 'm1',
      });
      await r.supplies.create({
        userId: u.id,
        groupId: g.id,
        category: 'man_and_van',
        expiresAt: new Date(Date.now() + 86400e3).toISOString(),
        sourceMessageId: 'm2',
      });
      expect(await r.supplies.findActive('man_and_van', g.id)).toHaveLength(1);
      const other = await r.groups.upsert({ channel: 'telegram', externalId: '-2', name: 'other' });
      expect(await r.supplies.findActive('man_and_van', other.id)).toHaveLength(0);
    });
  });
});

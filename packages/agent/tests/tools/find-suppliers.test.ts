import { describe, expect, it, vi } from 'vitest';
import { findPeerSupplyTool } from '../../src/tools/find-peer-supply.js';
import { findSuppliersTool } from '../../src/tools/find-suppliers.js';

const SUPPLIER = {
  id: 'a',
  category: 'man_and_van',
  name: 'A Vans',
  serviceArea: ['LONDON'],
  languages: ['en'],
  pool: 'A',
  priceType: 'hourly',
  roughPrice: '£40/h',
  phone: '+440000',
  whatsapp: null,
  isSameDay: false,
  isWeekend: true,
  lastVerifiedAt: new Date(),
  rating: null,
};

describe('find_suppliers', () => {
  it('returns top 3 scored candidates with reasons and stores matches', async () => {
    const repos = {
      suppliers: { findCandidates: vi.fn(() => Promise.resolve([SUPPLIER])) },
      matches: { replaceForDemand: vi.fn(() => Promise.resolve([])) },
    };
    const rc = {
      context: {
        userId: 'u',
        demand: { category: 'man_and_van', confidence: 0.9, fromPostcode: 'E14' },
        demandId: 'd1',
      },
    } as never;
    const out = JSON.parse(await findSuppliersTool({ repos } as never).invoke(rc, '{}')) as Array<{
      id: string;
      reasons: string[];
      name: string;
    }>;
    expect(out[0]?.id).toBe('a');
    expect(out[0]?.name).toBe('A Vans');
    expect(out[0]?.reasons.length).toBeGreaterThan(0);
    expect(repos.matches.replaceForDemand).toHaveBeenCalledWith('d1', [
      { supplierId: 'a', matcherScore: 0.6, rank: 1 },
    ]);
  });

  it('refuses to run before a demand exists', async () => {
    const repos = {
      suppliers: { findCandidates: vi.fn() },
      matches: { replaceForDemand: vi.fn() },
    };
    const rc = { context: { userId: 'u' } } as never;
    const out = await findSuppliersTool({ repos } as never).invoke(rc, '{}');
    expect(out).toContain('upsert_demand first');
  });
});

describe('find_peer_supply', () => {
  it('returns top peer offers without member contact details', async () => {
    const supply = {
      id: 's1',
      userId: 'peer',
      category: 'man_and_van',
      availability: 'sunday',
      area: 'E14',
      expiresAt: new Date(Date.now() + 86400e3),
      createdAt: new Date(),
    };
    const repos = { supplies: { findActive: vi.fn(() => Promise.resolve([supply])) } };
    const rc = {
      context: {
        userId: 'u',
        groupId: 'g1',
        demand: {
          category: 'man_and_van',
          confidence: 0.9,
          fromPostcode: 'E14',
          whenText: 'sunday',
        },
      },
    } as never;
    const out = JSON.parse(await findPeerSupplyTool({ repos } as never).invoke(rc, '{}')) as Array<{
      id: string;
      reasons: string[];
    }>;
    expect(out[0]?.id).toBe('s1');
    expect(out[0]).not.toHaveProperty('phone');
    expect(repos.supplies.findActive).toHaveBeenCalledWith('man_and_van', 'g1');
  });

  it('never matches a member with their own offer or outside a group', async () => {
    const own = {
      id: 's2',
      userId: 'u',
      category: 'man_and_van',
      availability: null,
      area: 'E14',
      expiresAt: new Date(Date.now() + 86400e3),
      createdAt: new Date(),
    };
    const repos = { supplies: { findActive: vi.fn(() => Promise.resolve([own])) } };
    const demand = { category: 'man_and_van', confidence: 0.9 };
    const tool = findPeerSupplyTool({ repos } as never);
    expect(
      await tool.invoke({ context: { userId: 'u', groupId: 'g1', demand } } as never, '{}'),
    ).toContain('no peer supply');
    expect(
      await tool.invoke({ context: { userId: 'u', groupId: null, demand } } as never, '{}'),
    ).toContain('only matched within a group');
    expect(repos.supplies.findActive).toHaveBeenCalledTimes(1);
  });
});

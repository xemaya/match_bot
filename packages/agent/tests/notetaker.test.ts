import { functionCall, ScriptedModel } from '@openai/agents/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../src/context.js';
import { consolidateGroupMemory, noteIsGrounded } from '../src/stages/notetaker.js';

const msg = (id: string, userId: string, text: string) => ({
  id,
  userId,
  text,
  createdAt: new Date('2026-10-22T10:00:00Z'),
  receivedAt: new Date('2026-10-22T10:00:00Z'),
});

describe('P54 notetaker', () => {
  it('needs word overlap with the source line', () => {
    expect(noteIsGrounded('有多的羽毛球拍', '我有多的羽毛球拍 谁要')).toBe(true);
    expect(noteIsGrounded('住在 Mile End', '我在 mile end 这边')).toBe(true);
    expect(noteIsGrounded('会修自行车', '我有多的羽毛球拍')).toBe(false);
  });
  it('stores grounded notes, rejects invented or contact-detail notes, and supersedes', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'record_member_notes',
          {
            add: [
              { line: 'l1', kind: 'offer', text: '有多的羽毛球拍可以借' },
              { line: 'l1', kind: 'offer', text: '会修自行车' },
              { line: 'l2', kind: 'context', text: '电话 07123 456789 住 E14 2AB' },
            ],
            supersede: ['n1'],
          },
          { callId: 'rec' },
        ),
      ],
    ]);
    const add = vi.fn(() => Promise.resolve({}));
    const supersede = vi.fn(() => Promise.resolve(1));
    const mark = vi.fn(() => Promise.resolve());
    const deps = {
      env: { DEEPSEEK_MODEL: 'stub' },
      modelProvider: { getModel: () => model },
      repos: {
        messages: {
          createdInGroupSince: vi.fn(() =>
            Promise.resolve([
              msg('m1', 'u1', '我有多的羽毛球拍 谁要借'),
              msg('m2', 'u2', '我电话 07123 456789 住 E14 2AB'),
            ]),
          ),
        },
        memberNotes: {
          listForGroup: vi.fn(() =>
            Promise.resolve([{ id: 'old', userId: 'u1', kind: 'need', text: '在找羽毛球搭子' }]),
          ),
          add,
          supersede,
        },
        groups: { markMemoryConsolidated: mark },
        traces: { create: vi.fn(() => Promise.resolve({})) },
      },
    } as unknown as AgentDeps;
    const result = await consolidateGroupMemory(deps, { groupId: 'g', since: null });
    expect(result).toEqual({ added: 1, superseded: 1, rejected: 2 });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', kind: 'offer', sourceMessageId: 'm1' }),
    );
    expect(supersede).toHaveBeenCalledWith('g', ['old']);
    expect(mark).toHaveBeenCalledOnce();
    // Members reach the model as aliases, never internal ids.
    expect(JSON.stringify(model.calls[0]?.request.input)).not.toContain('"u1"');
  });
});

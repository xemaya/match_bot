import { functionCall, ScriptedModel } from '@openai/agents/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../src/context.js';
import {
  consolidateGroupMemory,
  correctedKind,
  isMemberCoordination,
  noteExcerpt,
  noteIsGrounded,
} from '../src/stages/notetaker.js';

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
    // A day or purpose borrowed from other lines is not grounded in this one.
    expect(noteIsGrounded('周日下午三点半到Brick Lane等对方', '我三点半到Brick Lane那边等你')).toBe(
      false,
    );
  });
  it('keeps dates but drops mentions and contact details from the excerpt', () => {
    expect(noteExcerpt('@小周 31号周六搬家 电话 07123 456789')).toBe('31号周六搬家 电话 …');
  });
  it('files a companion or item ask as a need even when the model says offer', () => {
    expect(correctedKind('offer', '周日有人想一起看展吗 我正好有空')).toBe('need');
    expect(correctedKind('offer', '我有两把多的羽毛球拍 谁要借可以找我')).toBe('offer');
    expect(correctedKind('context', '有房源求踢我一下 我周末随时能去看')).toBe('need');
    expect(correctedKind('context', '小鱼我那房最早15号才空 提前不了')).toBe('offer');
    expect(correctedKind('need', '闲置的相机三脚架 有人要吗 10镑拿走就行')).toBe('offer');
    expect(correctedKind('context', '下周要交论文 这几天都在图书馆')).toBe('context');
    expect(correctedKind('offer', '打印机还是没淘到 有没有uu要出啊 mile end附近自取')).toBe('need');
    expect(correctedKind('offer', '有没有狗岛附近的朋友能帮我喂两天猫')).toBe('need');
    expect(correctedKind('need', '那盏台灯还在我这 5镑 有人要吗')).toBe('offer');
    expect(correctedKind('need', '有宝子想接我Stratford短租到12月初嘛 便宜转😭')).toBe('offer');
    expect(correctedKind('context', '家里有十几本中文绘本 有想换着看的喊我🙏')).toBe('offer');
    expect(correctedKind('offer', '不过可以先试一次 沿河那段我还没跑过')).toBe('context');
    expect(correctedKind('offer', '谁家还有闲置的也随时喊我')).toBe('need');
    expect(correctedKind('context', '定好了 周日上午9点20 Waterloo 站里碰头')).toBe('resolved');
    expect(correctedKind('resolved', '要是真不吵我以后就固定去那了')).toBe('context');
    expect(correctedKind('context', '拍子你带着就行 我这还有多的')).toBe('offer');
    expect(correctedKind('context', '我打算去Tate Modern逛逛 想一起的中午前说一声')).toBe('need');
    // A giveaway phrased as a question is still an offer.
    expect(correctedKind('offer', '攒了一堆空纸箱 有人搬家用得上吗 E14自取')).toBe('offer');
  });
  it('treats lines addressed to one member as coordination, not notes', () => {
    expect(isMemberCoordination('@小周 周三晚上八点后可以')).toBe(true);
    expect(isMemberCoordination('我有多的羽毛球拍 谁要借')).toBe(false);
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
    // Notes are the member's own words: both lines are stored, contact details replaced.
    expect(result).toEqual({ added: 3, superseded: 1, rejected: 0 });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        kind: 'offer',
        sourceMessageId: 'm1',
        text: '我有多的羽毛球拍 谁要借',
      }),
    );
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u2', text: '我电话 … 住 …' }),
    );
    expect(supersede).toHaveBeenCalledWith('g', ['old']);
    expect(mark).toHaveBeenCalledOnce();
    // Members reach the model as aliases, never internal ids.
    expect(JSON.stringify(model.calls[0]?.request.input)).not.toContain('"u1"');
  });
});

import { taskSchema } from '@matchbot/domain';
import { describe, expect, it } from 'vitest';
import { normalizeTaskPatch, taskPatchProposalSchema } from '../src/task-proposal.js';

const task = taskSchema.parse({
  id: 't',
  ownerUserId: 'u',
  scope: { channel: 'telegram', chatId: 'c' },
  objective: '买桌子',
  status: 'active',
  revision: 0,
  goals: [
    {
      id: 'desk',
      title: '书桌',
      required: true,
      criteria: [
        { id: 'fit', label: '有合适候选', strength: 'hard', status: 'unknown', evidenceRefs: [] },
      ],
    },
  ],
  constraints: [
    {
      key: 'budget',
      goalId: 'desk',
      strength: 'hard',
      value: { kind: 'money', amountPence: 5000, unit: 'item' },
      origin: { kind: 'user', sourceMessageId: 'old' },
    },
  ],
  evidence: [],
  pendingQuestion: null,
  blockReason: null,
  delivery: { status: 'none', level: 'none' },
  userConfirmation: null,
});
describe('task proposal normalization', () => {
  it.each(['A3彩色无线激光打印机', 'PS5游戏机', 'iPhone14手机', '1b1b公寓'])(
    'retains source-attested subject codes in acceptance labels: %s',
    (title) => {
      const input = taskPatchProposalSchema.parse({
        goals: [
          {
            id: 'item',
            title,
            required: true,
            sourceQuote: title,
            criteria: [
              { id: 'subject', label: '确为' + title, strength: 'hard', constraintKey: null },
            ],
          },
        ],
        constraints: [],
      });
      const patch = normalizeTaskPatch({ input, task, text: '想找' + title });
      expect(patch?.goals[0]?.criteria[0]?.label).toContain(title);
    },
  );
  it.each(['A3打印机价格20镑以内', 'A3打印机30分钟内自提', 'A3打印机2026年11月可取', 'A4打印机'])(
    'still rejects changing or unattested numeric facts in an unbound label: %s',
    (label) => {
      const input = taskPatchProposalSchema.parse({
        goals: [
          {
            id: 'item',
            title: 'A3打印机',
            required: true,
            sourceQuote: 'A3打印机',
            criteria: [{ id: 'subject', label, strength: 'hard', constraintKey: null }],
          },
        ],
        constraints: [],
      });
      expect(() =>
        normalizeTaskPatch({ input, task, text: 'A3打印机，20镑以内，30分钟内自提' }),
      ).toThrow('parameter-free');
    },
  );
  it('keeps a postcode district the user wrote in an unbound label even when the title omits it', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [
        {
          id: 'trip',
          title: 'Epping Forest周日徒步交通',
          required: true,
          sourceQuote: '周日想去Epping Forest走走',
          criteria: [
            { id: 'origin', label: '从E14出发少换乘', strength: 'hard', constraintKey: null },
          ],
        },
      ],
      constraints: [],
    });
    // Accepted: the unbound criterion folds into the goal's subject line instead of being rejected.
    expect(() =>
      normalizeTaskPatch({
        input,
        task,
        text: '周日想去Epping Forest走走 有人一起吗 另外从E14过去坐什么最方便 不想换太多次车',
      }),
    ).not.toThrow();
    // A code the user never wrote is still an unattested value.
    expect(() =>
      normalizeTaskPatch({
        input,
        task,
        text: '周日想去Epping Forest走走 坐什么最方便',
      }),
    ).toThrow('parameter-free');
  });
  it.each(['室内还是室外？', '不在室内', '室内的也行'])(
    'does not manufacture a hard indoor requirement from %s',
    (text) => {
      const activity = taskSchema.parse({
        ...task,
        category: 'other',
        counterparty: 'peer',
        constraints: [],
        goals: [{ ...task.goals[0]!, title: '羽毛球搭子' }],
      });
      const patch = normalizeTaskPatch({
        input: taskPatchProposalSchema.parse({ goals: [], constraints: [] }),
        task: activity,
        text,
      });
      expect(
        patch?.constraints.some(
          (c) => c.strength === 'hard' && c.value.kind === 'text' && /室内/.test(c.value.text),
        ),
      ).toBe(false);
    },
  );
  it('requires housing conditions to be checks on an actual home, not independent property goals', () => {
    const housing = taskSchema.parse({ ...task, category: 'housing' });
    const input = taskPatchProposalSchema.parse({
      goals: [
        {
          id: 'cat',
          title: '允许养猫',
          required: true,
          sourceQuote: '允许养猫',
          criteria: [{ id: 'pets', label: '允许养猫', strength: 'hard', constraintKey: null }],
        },
      ],
      constraints: [],
    });
    expect(() => normalizeTaskPatch({ input, task: housing, text: '找允许养猫的一居室' })).toThrow(
      'property goal',
    );
  });
  it('retains an explicit indoor requirement separately from a willingness to pay on a single activity', () => {
    const activity = taskSchema.parse({
      ...task,
      category: 'other',
      counterparty: 'peer',
      constraints: [],
      goals: [{ ...task.goals[0]!, title: '羽毛球搭子' }],
    });
    const input = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'feature',
          goalId: null,
          strength: 'preference',
          value: { kind: 'text', text: '可接受收费活动' },
          sourceQuote: '收费也可以',
        },
      ],
    });
    const patch = normalizeTaskPatch({ input, task: activity, text: '室内的，收费也可以' });
    expect(patch?.constraints).toContainEqual(
      expect.objectContaining({
        key: 'custom:venue_environment',
        strength: 'hard',
        value: { kind: 'text', text: '室内' },
        sourceQuote: '室内',
      }),
    );
    expect(
      normalizeTaskPatch({
        input: taskPatchProposalSchema.parse({ goals: [], constraints: [] }),
        task: activity,
        text: '不一定室内',
      })?.constraints,
    ).toEqual([]);
  });
  it('retains the amount but updates explicit all-in scope even if the proposal only mentions bills', () => {
    const housing = taskSchema.parse({
      ...task,
      category: 'housing',
      constraints: [
        {
          key: 'budget',
          strength: 'hard',
          value: { kind: 'money', amountPence: 160000, unit: 'month' },
          budgetScope: 'rent_only',
          origin: { kind: 'user', sourceMessageId: 'old' },
        },
      ],
    });
    const input = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'bills',
          goalId: null,
          strength: 'preference',
          value: { kind: 'text', text: '包bills' },
          sourceQuote: '最好包bills',
        },
      ],
    });
    const result = normalizeTaskPatch({
      input,
      task: housing,
      text: '最好包bills，但总预算不能增加',
    });
    expect(result?.constraints.find((c) => c.key === 'budget')).toMatchObject({
      budgetScope: 'all_in',
      value: { kind: 'money', amountPence: 160000, unit: 'month' },
      sourceQuote: '总预算不能增加',
    });
    expect(
      normalizeTaskPatch({ input, task: housing, text: '最好包bills' })?.constraints.some(
        (c) => c.key === 'budget',
      ),
    ).toBe(false);
  });
  it('compiles a source-level subject check while preserving an explicit identity-verification requirement', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [
        {
          id: 'home',
          title: '一居室',
          required: true,
          sourceQuote: '一居室',
          criteria: [
            {
              id: 'listing',
              label: '为可联系房东或中介的真实出租房源信息',
              strength: 'hard',
              constraintKey: null,
            },
            {
              id: 'verified',
              label: '必须核实房东身份',
              strength: 'hard',
              constraintKey: 'custom:verified_landlord',
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'custom:verified_landlord',
          goalId: 'home',
          strength: 'hard',
          value: { kind: 'boolean', value: true },
          sourceQuote: '核实房东身份',
        },
      ],
    });
    const patch = normalizeTaskPatch({ input, task, text: '找一居室，并且必须核实房东身份' });
    expect(patch?.goals[0]?.criteria[0]).toMatchObject({
      id: 'listing',
      label: '来源描述的对象或邀约：一居室',
      constraintKey: null,
    });
    expect(patch?.goals[0]?.criteria[1]).toMatchObject({
      constraintKey: 'custom:verified_landlord',
      strength: 'hard',
    });
    expect(patch?.constraints[0]?.value).toEqual({ kind: 'boolean', value: true });
  });
  it('does not invent or move a date from an unrelated pet requirement', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'move_in_date',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'date_range', from: '2026-12-05', to: '2026-12-05' },
          sourceQuote: '猫一定要能养',
        },
      ],
    });
    expect(() => normalizeTaskPatch({ input, task, text: '猫一定要能养' })).toThrow('date');
    const dated = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'move_in_date',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'date_range', from: '2026-12-05', to: '2026-12-05' },
          sourceQuote: '11月5日入住',
        },
      ],
    });
    expect(
      normalizeTaskPatch({
        input: dated,
        task,
        text: '11月5日入住',
        now: new Date('2026-10-17T12:00:00Z'),
      })?.constraints[0]?.value,
    ).toEqual({ kind: 'date_range', from: '2026-11-05', to: '2026-11-05' });
  });
  it('normalizes text locations and unambiguous housing dates into executable values', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'travel_origin',
          goalId: null,
          strength: 'hard',
          value: { kind: 'text', text: 'E14' },
          sourceQuote: '我住E14',
        },
        {
          key: 'move_in_date',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'text', text: '11月入住' },
          sourceQuote: '11月入住',
        },
      ],
    });
    const patch = normalizeTaskPatch({
      input,
      task,
      text: '我住E14，11月入住',
      now: new Date('2026-10-17T12:00:00Z'),
    });
    expect(patch?.constraints[0]?.value).toEqual({ kind: 'location', area: 'E14' });
    expect(patch?.constraints[1]?.value).toEqual({
      kind: 'date_range',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    const later = taskSchema.parse(task);
    later.constraints.push({
      key: 'move_in_date',
      strength: 'hard',
      value: { kind: 'date_range', from: '2027-11-01', to: '2027-11-30' },
      origin: { kind: 'user', sourceMessageId: 'old' },
    });
    const refined = taskPatchProposalSchema.parse({
      goals: [],
      constraints: [
        {
          key: 'move_in_date',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'text', text: '11月5日入住' },
          sourceQuote: '11月5日入住',
        },
      ],
    });
    expect(
      normalizeTaskPatch({
        input: refined,
        task: later,
        text: '11月5日入住',
        now: new Date('2026-10-17T12:00:00Z'),
      })?.constraints[0]?.value,
    ).toEqual({ kind: 'date_range', from: '2027-11-05', to: '2027-11-05' });
  });
  it('treats an unspecified optional travel check as an information gap, without inventing a duration', () => {
    const input = taskPatchProposalSchema.parse({
      goals: [
        {
          id: 'desk',
          title: '书桌',
          required: true,
          sourceQuote: '找书桌',
          criteria: [
            {
              id: 'travel',
              label: '核对通勤方便程度',
              strength: 'preference',
              constraintKey: 'max_travel_minutes',
            },
          ],
        },
      ],
      constraints: [],
    });
    const patch = normalizeTaskPatch({ input, task, text: '找书桌' });
    expect(patch?.goals[0]?.criteria[0]?.constraintKey).toBeNull();
    expect(patch?.constraints).toEqual([]);
  });
  it('normalizes duplicate origin fields without treating where someone lives as an offer boundary', () => {
    const constraints = ['area', 'travel_origin'].map((key) => ({
      key,
      goalId: null,
      strength: 'hard',
      value: { kind: 'location', area: 'E14' },
      sourceQuote: '我住E14',
    }));
    const input = taskPatchProposalSchema.parse({ goals: [], constraints });
    expect(
      normalizeTaskPatch({ input, task, text: '我住E14，找桌子' })?.constraints.map((c) => c.key),
    ).toEqual(['travel_origin']);
    expect(
      normalizeTaskPatch({ input, task, text: '我住E14，只在E14找桌子' })?.constraints.map(
        (c) => c.key,
      ),
    ).toEqual(['area', 'travel_origin']);
  });
  it('checks explicit prices against the quoted amount and permits grounded relative changes', () => {
    const input = (quote: string, amountPence: number) =>
      taskPatchProposalSchema.parse({
        goals: [],
        constraints: [
          {
            key: 'max_price_per_item',
            goalId: 'desk',
            strength: 'hard',
            value: { kind: 'money', amountPence, unit: 'item' },
            sourceQuote: quote,
          },
        ],
      });
    expect(() =>
      normalizeTaskPatch({ input: input('桌子50', 7000), task, text: '桌子50' }),
    ).toThrow('amount');
    expect(() =>
      normalizeTaskPatch({ input: input('可以加一点', 7000), task, text: '可以加一点' }),
    ).toThrow('amount');
    expect(
      normalizeTaskPatch({ input: input('可以加20', 7000), task, text: '可以加20' })?.constraints[0]
        ?.key,
    ).toBe('budget');
    expect(
      normalizeTaskPatch({ input: input('不增加预算', 5000), task, text: '不增加预算' })
        ?.constraints[0]?.value,
    ).toMatchObject({ amountPence: 5000 });
  });
});

it('does not turn explicit preferences into hard exclusions, even with custom keys or shortened quotes', () => {
  const input = taskPatchProposalSchema.parse({
    goals: [],
    constraints: [
      {
        key: 'custom:budget_inclusions',
        goalId: null,
        strength: 'hard',
        value: { kind: 'text', text: '包bills' },
        sourceQuote: '包bills',
      },
      {
        key: 'budget',
        goalId: 'desk',
        strength: 'hard',
        value: { kind: 'money', amountPence: 5000, unit: 'item' },
        sourceQuote: '总预算不能增加',
      },
    ],
  });
  const patch = normalizeTaskPatch({ input, task, text: '最好包bills，但总预算不能增加' });
  expect(patch?.constraints.find((c) => c.key === 'custom:budget_inclusions')?.strength).toBe(
    'preference',
  );
  expect(patch?.constraints.find((c) => c.key === 'budget')?.strength).toBe('hard');
});

it('rejects boolean budget accounting aliases instead of creating an independent offer requirement', () => {
  const input = taskPatchProposalSchema.parse({
    goals: [],
    constraints: [
      {
        key: 'custom:budget_includes_bills',
        goalId: null,
        strength: 'hard',
        value: { kind: 'boolean', value: true },
        sourceQuote: '总预算不能增加',
      },
    ],
  });
  expect(() => normalizeTaskPatch({ input, task, text: '最好包bills，但总预算不能增加' })).toThrow(
    'budget accounting',
  );
});

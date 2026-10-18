import { describe, it, expect } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import type { MatchContext } from '../src/context.js';
import { createKnowledgeSource } from '../src/knowledge-evidence.js';
import {
  buildDeliveryPacket,
  canHandOffToDelivery,
  selectRequestToolNames,
} from '../src/delivery-context.js';
function context(): MatchContext {
  return {
    userId: 'u',
    chatId: '-1',
    groupId: 'g',
    sourceMessageId: 'm',
    phase: 0,
    recentReplies: [],
    currentRequest: {
      text: 'E14怎么注册GP',
      isActionable: true,
      demand: { category: 'other', lang: 'zh', confidence: 1 },
    },
    task: taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: 'GP注册',
      category: 'other',
      status: 'active',
      revision: 1,
      requirementsVersion: 1,
      goals: [],
      constraints: [],
      evidence: [],
      pendingQuestion: null,
      nextStep: { action: 'deliver', owner: 'agent', reason: 'useful public evidence' },
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
    taskProgressVersion: 1,
  };
}
describe('delivery context boundaries', () => {
  it('does not carry an old question about an already supplied condition into the writer', () => {
    const c = context();
    c.task!.constraints = [
      {
        key: 'feature',
        strength: 'hard',
        value: { kind: 'text', text: '必须无线' },
        origin: { kind: 'user', sourceMessageId: 'first' },
      },
    ];
    c.task!.nextStep = {
      action: 'ask_user',
      owner: 'agent',
      constraintKey: 'feature',
      reason: '无线是必须的吗',
    };
    expect(buildDeliveryPacket(c).task?.nextStep?.action).toBe('deliver');
    expect(c.task!.nextStep.action).toBe('ask_user');
  });
  it('hands off only current, scoped accepted progress and never a blocked/exhausted/foreign task', () => {
    const c = context();
    expect(canHandOffToDelivery(c)).toBe(true);
    for (const patch of [
      { outboundBlocked: true },
      { answerInputExhausted: true },
      { taskProgressVersion: 0 },
    ])
      expect(canHandOffToDelivery({ ...c, ...patch })).toBe(false);
    c.task!.ownerUserId = 'other';
    expect(canHandOffToDelivery(c)).toBe(false);
  });
  it('preserves registration and eligibility pages even when only the clinic was preferred', () => {
    const c = context();
    c.knowledgeSources = Array.from({ length: 13 }, (_, i) =>
      createKnowledgeSource(
        {
          title: 'Page ' + i,
          url: 'https://www.nhs.uk/' + i,
          text:
            i === 12
              ? 'You can register online without an NHS number.'
              : 'Clinic location and opening hours for local patients.',
        },
        i + 1,
      ),
    );
    c.deliverySourceRefs = ['k2'];
    const packet = buildDeliveryPacket(c);
    expect(packet.refs[0]).toBe('k2');
    expect(c.knowledgeSources[0]!.ref).toBe('k1');
    expect(packet.refs).toContain('k13');
    expect(JSON.stringify(packet.knowledge)).toContain('without an NHS number');
    expect(packet.knowledge.length).toBeLessThanOrEqual(16);
  });
  it('retains later passages on a selected page instead of cutting the page to its first four facts', () => {
    const c = context();
    c.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'Registration',
          url: 'https://www.nhs.uk/register',
          text: [
            'Clinic introduction for local patients.',
            'Clinic address and directions for patients.',
            'Opening hours for routine appointments.',
            'Contact information for local patients.',
            'You can register online without proof of address.',
          ].join('\n'),
        },
        1,
      ),
    ];
    c.deliverySourceRefs = ['k1'];
    expect(JSON.stringify(buildDeliveryPacket(c).knowledge)).toContain('without proof of address');
  });
  it('uses known confirmed subject evidence before weak alternative offers', () => {
    const c = context();
    c.task!.category = 'second_hand';
    c.marketPlan = {
      intent: 'second_hand',
      needs: [{ id: 'printer', terms: ['打印机'] }],
      preferences: [],
    };
    c.task!.goals = [
      {
        id: 'printer',
        title: '激光打印机',
        required: true,
        criteria: [
          {
            id: 'subject',
            label: '激光打印机',
            strength: 'hard',
            status: 'supported',
            evidenceRefs: ['proof'],
          },
        ],
      },
    ];
    c.task!.evidence = [
      {
        id: 'proof',
        goalId: 'printer',
        kind: 'source_excerpt',
        sourceRef: 'market:laser',
        summary: '激光打印机',
        observedAt: new Date().toISOString(),
      },
    ];
    c.marketListings = ['generic', 'laser'].map((id, i) => ({
      id,
      ref: 'm' + (i + 1),
      title: id === 'laser' ? '伦敦激光打印机' : '伦敦打印机',
      description: '出售：打印机\n地点：伦敦',
      tradeType: 'SELL' as const,
      status: 'ON_SALE',
      tags: [],
      isRepost: false,
      url: 'https://a2hmarket.ai/listings/' + id,
      sourceUrl: null,
      priceLabel: '待确认',
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: null,
      createdAt: null,
    }));
    expect(buildDeliveryPacket(c).refs).toEqual(['m2']);
    c.deliverySourceRefs = ['m1'];
    expect(buildDeliveryPacket(c).refs).toEqual(['m2']);
    c.marketListings.unshift(
      ...Array.from({ length: 8 }, (_, i) => ({
        ...c.marketListings![0]!,
        id: 'vague' + i,
        ref: 'm' + (i + 3),
      })),
    );
    expect(buildDeliveryPacket(c).refs).toEqual(['m2']);
  });
  it('narrows official information tools while preserving the supplier catalogue route', () => {
    const names = [
      'reply_to_request',
      'search_information',
      'record_task_progress',
      'market_search',
      'reply_in_group',
      'ask_clarification',
      'find_suppliers',
      'do_nothing',
      'react',
    ];
    const c = context();
    expect(selectRequestToolNames(names, c)).toEqual([
      'reply_to_request',
      'search_information',
      'record_task_progress',
      'do_nothing',
      'react',
    ]);
    c.task!.category = 'man_and_van';
    expect(selectRequestToolNames(names, c)).toContain('reply_in_group');
    c.task!.category = 'other';
    c.task!.objective = '找新手羽毛球搭子';
    c.currentRequest!.text = '附近也可以';
    expect(selectRequestToolNames(names, c)).toContain('market_search');
  });
});

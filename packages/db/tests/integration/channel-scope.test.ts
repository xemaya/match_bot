import { describe, expect, it } from 'vitest';
import { createRepositories } from '../../src/repos/index.js';
import { withTestDb } from './setup.js';

const account = { installationId: 'test', accountId: 'app_a', tenantId: 'tenant' };
describe('channel account isolation', () => {
  it('keeps identical provider identities and events separate across bot accounts', async () => {
    await withTestDb(async (tx) => {
      const root = createRepositories(tx);
      const a = root.forChannel('feishu', account);
      const b = root.forChannel('feishu', { ...account, accountId: 'app_b' });
      const ua = await a.users.upsertByExternal({ channel: 'feishu', externalId: 'ou_same' });
      const ub = await b.users.upsertByExternal({ channel: 'feishu', externalId: 'ou_same' });
      expect(ua.id).not.toBe(ub.id);
      const ga = await a.groups.upsert({ channel: 'feishu', externalId: 'oc_same', name: 'a' });
      const gb = await b.groups.upsert({ channel: 'feishu', externalId: 'oc_same', name: 'b' });
      expect(ga.id).not.toBe(gb.id);
      const message = {
        channel: 'feishu' as const,
        account,
        conversationType: 'direct' as const,
        chatId: 'oc_dm',
        userId: 'ou_same',
        messageId: 'om_1',
        text: 'hello',
        receivedAt: new Date().toISOString(),
      };
      const accepted = await a.executions.accept({
        userId: ua.id,
        groupId: null,
        message,
        phase: 2,
      });
      const other = await b.executions.accept({
        userId: ub.id,
        groupId: null,
        message: { ...message, account: { ...account, accountId: 'app_b' } },
        phase: 2,
      });
      expect(accepted.message.id).not.toBe(other.message.id);
      await expect(
        a.executions.accept({
          userId: ua.id,
          groupId: null,
          message: { ...message, account: { ...account, accountId: 'app_b' } },
          phase: 2,
        }),
      ).rejects.toThrow('scope mismatch');
      const pending = await root.executions.dispatchable();
      expect(pending.find((p) => p.messageId === accepted.message.id)?.message).toMatchObject(
        message,
      );
    });
  });
  it('claims only the configured account and channel and accepts nonnumeric receipts', async () => {
    await withTestDb(async (tx) => {
      const root = createRepositories(tx);
      const a = root.forChannel('feishu', account);
      const b = root.forChannel('feishu', { ...account, accountId: 'app_b' });
      const draft = {
        channel: 'feishu' as const,
        target: 'oc_chat',
        text: 'hello',
        phase: 2 as const,
      };
      const first = await a.outbound.create(draft, 'pending');
      await b.outbound.create(draft, 'pending');
      expect(await root.outbound.claimPending(5)).toEqual([]);
      const rows = await a.outbound.claimPending(5);
      expect(rows.map((r) => r.id)).toEqual([first.id]);
      expect(await a.outbound.beginSend({ id: first.id, leaseToken: rows[0]!.leaseToken! })).toBe(
        true,
      );
      expect(
        await a.outbound.markSent({
          id: first.id,
          leaseToken: rows[0]!.leaseToken!,
          externalMessageId: 'om_result',
        }),
      ).toBe(true);
    });
  });
});

it('isolates persisted history and tasks between topics of one user', async () => {
  await withTestDb(async (tx) => {
    const r = createRepositories(tx).forChannel('feishu', account);
    const user = await r.users.upsertByExternal({ channel: 'feishu', externalId: 'ou_owner' });
    const group = await r.groups.upsert({
      channel: 'feishu',
      externalId: 'oc_group',
      name: 'test',
    });
    const message = {
      channel: 'feishu' as const,
      account,
      conversationType: 'group' as const,
      chatId: 'oc_group',
      userId: 'ou_owner',
      messageId: 'om_topic',
      threadId: 'thread_a',
      text: '找桌子',
      receivedAt: new Date().toISOString(),
    };
    const accepted = await r.executions.accept({
      userId: user.id,
      groupId: group.id,
      message,
      phase: 2,
    });
    const access = {
      userId: user.id,
      scope: { channel: 'feishu' as const, chatId: group.externalId, threadId: 'thread_a' },
    };
    const task = await r.tasks.create({
      access,
      sourceMessageId: accepted.message.id,
      intentKey: 'desk',
      objective: '找桌子',
      category: 'second_hand',
    });
    expect(task.scope.threadId).toBe('thread_a');
    expect(
      await r.tasks.findOpenByScope({
        ...access,
        scope: { ...access.scope, threadId: 'thread_b' },
      }),
    ).toEqual([]);
    expect(await r.tasks.findOpenByScope(access)).toHaveLength(1);
    await r.sessionItems.append(
      user.id,
      [{ role: 'user', content: 'topic a' }],
      'same-operation',
      'thread_a',
    );
    await r.sessionItems.append(
      user.id,
      [{ role: 'user', content: 'topic b' }],
      'same-operation',
      'thread_b',
    );
    expect(await r.sessionItems.list(user.id, undefined, 'thread_a')).toEqual([
      { role: 'user', content: 'topic a' },
    ]);
    expect(await r.sessionItems.list(user.id)).toEqual([]);
    await r.sessionItems.clear(user.id, 'thread_a');
    expect(await r.sessionItems.list(user.id, undefined, 'thread_b')).toHaveLength(1);
  });
});

it('binds Feishu direct replies to the persisted chat, never the sender open_id', async () => {
  await withTestDb(async (tx) => {
    const r = createRepositories(tx).forChannel('feishu', account);
    const user = await r.users.upsertByExternal({ channel: 'feishu', externalId: 'ou_owner' });
    const message = {
      channel: 'feishu' as const,
      account,
      conversationType: 'direct' as const,
      chatId: 'oc_dm',
      userId: 'ou_owner',
      messageId: 'om_dm',
      text: '找桌子',
      receivedAt: new Date().toISOString(),
    };
    const accepted = await r.executions.accept({
      userId: user.id,
      groupId: null,
      message,
      phase: 2,
    });
    const claim = await r.executions.claim({ userId: user.id, messageId: accepted.message.id });
    if (claim.kind !== 'acquired') throw new Error('fixture did not acquire lease');
    const scoped = r.forExecution(claim.lease);
    await expect(
      scoped.outbound.create(
        { channel: 'feishu', target: 'oc_other', text: 'wrong', execution: claim.lease, phase: 2 },
        'pending',
      ),
    ).rejects.toThrow('scope mismatch');
    const row = await scoped.outbound.create(
      { channel: 'feishu', target: 'oc_dm', text: 'right', execution: claim.lease, phase: 2 },
      'pending',
    );
    expect(row.target).toBe('oc_dm');
    expect(row.channel).toBe('feishu');
    expect(row.senderAccountId).not.toBe('');
  });
});

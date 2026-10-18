import type { PrismaClient } from '../generated/client.js';
import { approvalsRepo } from './approvals.js';
import { demandsRepo } from './demands.js';
import { groupsRepo } from './groups.js';
import { leadsRepo } from './leads.js';
import { matchesRepo } from './matches.js';
import { messagesRepo } from './messages.js';
import { outboundRepo } from './outbound.js';
import { runStatesRepo } from './run-states.js';
import { sessionItemsRepo } from './session-items.js';
import { suppliersRepo } from './suppliers.js';
import { suppliesRepo } from './supplies.js';
import { tracesRepo } from './traces.js';
import { usersRepo } from './users.js';
import { tasksRepo } from './tasks.js';
import { executionsRepo } from './executions.js';
import { withExecutionFence } from '../execution-fence.js';
import {
  accountScopeKey,
  type ChannelAccount,
  type Channel,
  type ExecutionLease,
} from '@matchbot/domain';

function rawRepositories(
  prisma: PrismaClient,
  senderAccountId = '',
  channel: Channel = 'telegram',
  channelScope = '',
) {
  return {
    users: usersRepo(prisma, channelScope),
    tasks: tasksRepo(prisma),
    executions: executionsRepo(prisma),
    groups: groupsRepo(prisma, channelScope),
    messages: messagesRepo(prisma),
    demands: demandsRepo(prisma),
    supplies: suppliesRepo(prisma),
    suppliers: suppliersRepo(prisma),
    matches: matchesRepo(prisma),
    leads: leadsRepo(prisma),
    sessionItems: sessionItemsRepo(prisma),
    runStates: runStatesRepo(prisma),
    approvals: approvalsRepo(prisma),
    outbound: outboundRepo(prisma, senderAccountId, channel, channelScope),
    traces: tracesRepo(prisma),
  };
}
type RawRepositories = ReturnType<typeof rawRepositories>;
export type Repositories = RawRepositories & {
  forExecution: (lease: ExecutionLease) => Repositories;
  forChannel: (channel: Channel, account: ChannelAccount) => Repositories;
};
export function createRepositories(
  prisma: PrismaClient,
  lease?: ExecutionLease,
  senderAccountId = '',
  channel: Channel = 'telegram',
  channelScope = '',
): Repositories {
  const forChannel = (nextChannel: Channel, account: ChannelAccount) =>
    createRepositories(
      prisma,
      lease,
      accountScopeKey(account),
      nextChannel,
      accountScopeKey(account),
    );
  const raw = rawRepositories(prisma, senderAccountId, channel, channelScope);
  if (!lease)
    return {
      ...raw,
      forChannel,
      forExecution: (next) =>
        createRepositories(prisma, next, senderAccountId, channel, channelScope),
    };
  // Mechanical facade keeps the repository contracts; only short DB operations hold the user lock.
  const scoped = Object.fromEntries(
    Object.entries(raw).map(([name, repo]) => {
      if (name === 'traces' || name === 'executions') return [name, repo];
      return [
        name,
        Object.fromEntries(
          Object.keys(repo).map((method) => [
            method,
            (...args: unknown[]) =>
              withExecutionFence(prisma, lease, async (tx) => {
                const target = rawRepositories(
                  tx as PrismaClient,
                  senderAccountId,
                  channel,
                  channelScope,
                )[name as keyof RawRepositories];
                const fn: unknown = Reflect.get(target, method);
                if (typeof fn !== 'function') throw new Error('unknown repository operation');
                const result: unknown = Reflect.apply(fn, target, args);
                return await result;
              }),
          ]),
        ),
      ];
    }),
  ) as RawRepositories;
  return {
    ...scoped,
    forChannel,
    forExecution: (next) =>
      createRepositories(prisma, next, senderAccountId, channel, channelScope),
  };
}

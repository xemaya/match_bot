/**
 * 端到端 smoke（AGENTS.md §7「端到端」一行）：一条群消息 → 代码门 → Jev 入站门 → agent →
 * Phase 0 的 dry-run 出站行。真实 Postgres + 真实仓储 + 真实 gating/agent 编排；
 * Jev 与模型是 stub（不联网）。不回滚：用唯一前缀建数据，afterAll 清理。
 */
import { createRepositories, getPrisma } from '@matchbot/db';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { evaluateInbound } from '@matchbot/jev';
import { createLogger, envSchema } from '@matchbot/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { processInbound } from '../../src/pipeline/inbound.js';
import { runInbound } from '@matchbot/agent';
import { functionCall, scriptedProvider, textMessage } from './model-stub.js';

// 与 db / queue 的集成测试保持一致：只取需要的变量并给 localhost 兜底。
// 不用 loadEnv()——它要求三把 API key 齐全，而本测试的 Jev 与模型都是 stub，
// 那样会让 `pnpm check` 在没有 .env 的环境（CI、新克隆）直接挂掉。
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://matchbot:matchbot@localhost:5432/matchbot';
// Jev 与模型都是 stub，所以这里的 key 只是占位，不会被用来联网。
const env = envSchema.parse({
  DATABASE_URL,
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15', // 与线上 0 号库隔离
  DEEPSEEK_API_KEY: 'test',
  JEV_API_KEY: 'test',
  TELEGRAM_BOT_TOKEN: 'test',
  TELEGRAM_OPS_CHAT_ID: '-1',
  SNAPSHOT_KEY: 'test-snapshot-key-16-chars-min',
});
const prisma = getPrisma(DATABASE_URL);
const repos = createRepositories(prisma);
const logger = createLogger('e2e', 'silent');
const PREFIX = `e2e-${Date.now()}`;
const CHAT = `${PREFIX}-chat`;
const USER = `${PREFIX}-user`;

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { externalId: { startsWith: PREFIX } } });
  const ids = users.map((u) => u.id);
  const messages = await prisma.message.findMany({ where: { userId: { in: ids } } });
  await prisma.decisionTrace.deleteMany({
    where: { inputRef: { in: [...messages.map((m) => m.id), `telegram:${CHAT}:1`] } },
  });
  await prisma.outboundMessage.deleteMany({ where: { target: CHAT } });
  await prisma.match.deleteMany({ where: { demand: { userId: { in: ids } } } });
  await prisma.demand.deleteMany({ where: { userId: { in: ids } } });
  await prisma.sessionItem.deleteMany({ where: { userId: { in: ids } } });
  await prisma.message.deleteMany({ where: { userId: { in: ids } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.group.deleteMany({ where: { externalId: CHAT } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

/** Jev stub：保持真实客户端的契约（自己写一条 kind=jev 的 trace，返回 answers）。 */
function jevStub(over: Record<string, unknown> = {}) {
  return {
    evaluate: vi.fn(async (p: { inputRef: string; phase: 0 | 1 | 2 }) => {
      await repos.traces.create({
        kind: 'jev',
        inputRef: p.inputRef,
        output: { stub: true },
        phase: p.phase,
        latencyMs: 1,
        costMicro: 17,
      });
      return {
        ok: true,
        id: 'stub',
        provider: 'stub',
        model: 'typesafe/jev-1.13-stub',
        usage: { input_tokens: 400, output_tokens: 0, cost: 0.000017 },
        answers: {
          is_demand: { type: 'noul', noul: 0.92 },
          is_supply: { type: 'noul', noul: 0.05 },
          category: {
            type: 'choice',
            choice: 'man_and_van',
            probabilities: { man_and_van: 0.9 },
            confidence: 0.9,
          },
          urgency: { type: 'score', score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
          has_location: { type: 'noul', noul: 0.9 },
          is_sensitive: { type: 'noul', noul: 0.01 },
          is_move_event: { type: 'noul', noul: 0.1 },
          is_local_request: { type: 'noul', noul: 0.3 },
          ...over,
        },
      };
    }),
  };
}

function makeDeps(p: { jev: ReturnType<typeof jevStub>; modelProvider?: unknown }) {
  return {
    env,
    repos,
    jev: p.jev,
    thresholds: DEFAULT_THRESHOLDS,
    logger,
    evaluateOutbound: vi.fn(),
    evaluateInbound,
    runInbound: (args: Parameters<typeof runInbound>[0]) =>
      runInbound({ ...args, deps: { ...args.deps, modelProvider: p.modelProvider } as never }),
    publishApproval: vi.fn(),
    cards: { sendApprovalCard: vi.fn() },
  };
}

const inbound = (over: Record<string, unknown> = {}) => ({
  channel: 'telegram' as const,
  chatId: CHAT,
  messageId: '1',
  userId: USER,
  text: 'need a van Sunday E14 to SE1',
  receivedAt: new Date().toISOString(),
  ...over,
});

describe('shadow e2e (Phase 0)', () => {
  it('a group message ends as a dry_run outbound row and leaves jev + gate traces', async () => {
    await repos.groups.upsert({ channel: 'telegram', externalId: CHAT, name: 'e2e' });
    await prisma.group.update({
      where: { channel_externalId: { channel: 'telegram', externalId: CHAT, channelScope: '' } },
      data: { isActive: true, phase: 0 },
    });
    const supplier = await prisma.supplier.create({
      data: {
        category: 'man_and_van',
        name: `${PREFIX}-van`,
        serviceArea: ['LONDON'],
        languages: ['en'],
        pool: 'A',
        roughPrice: '£40/h',
        telegram: '@e2evan',
      },
    });

    const modelProvider = scriptedProvider([
      [
        functionCall('upsert_demand', 'c1', {
          category: 'man_and_van',
          need: null,
          whenText: 'Sunday',
          whenAt: null,
          fromPostcode: 'E14',
          toPostcode: 'SE1',
          quantity: null,
          budgetPence: null,
          lang: 'en',
          confidence: 0.9,
        }),
      ],
      [functionCall('find_suppliers', 'c2', { limit: 3 })],
      [
        functionCall('reply_in_group', 'c3', {
          text: 'Here are two van options',
          supplierIds: [supplier.id],
        }),
      ],
      [textMessage('done')],
    ]);

    await processInbound(makeDeps({ jev: jevStub(), modelProvider }) as never, inbound());

    // 终点：Phase 0 只写 dry_run，不产生任何待发消息（AGENTS.md §3.3 第 4 条）
    const out = await prisma.outboundMessage.findMany({ where: { target: CHAT } });
    expect(out.map((o) => o.status)).toEqual(['dry_run']);
    expect(out[0]?.text).toContain('not part of the transaction');
    expect(await prisma.outboundMessage.count({ where: { target: CHAT, status: 'pending' } })).toBe(
      0,
    );

    // 需求落库，撮合跑过
    const demand = await prisma.demand.findFirst({ where: { user: { externalId: USER } } });
    expect(demand?.category).toBe('man_and_van');
    expect(demand?.fromPostcode).toBe('E14');

    // 留痕：jev 一条 + gate（entered_agent / 出站门 / agent_completed）
    const msg = await prisma.message.findFirst({ where: { user: { externalId: USER } } });
    expect(msg).not.toBeNull();
    const traces = await prisma.decisionTrace.findMany({ where: { inputRef: msg?.id ?? '' } });
    expect([...new Set(traces.map((t) => t.kind))].sort()).toEqual(['gate', 'jev']);
    const outcomes = traces.map((t) => (t.output as { outcome?: string }).outcome);
    expect(outcomes).toContain('entered_agent');
    expect(outcomes).toContain('agent_completed');
    expect(traces.some((t) => (t.output as { gate?: string }).gate === 'outbound')).toBe(true);
  });

  it('jev unavailable leaves a dropped_by_jev trace and never reaches the agent', async () => {
    const jev = { evaluate: vi.fn(() => Promise.resolve({ ok: false, reason: 'timeout' })) };
    const deps = makeDeps({ jev: jev as never });
    const runSpy = vi.spyOn(deps, 'runInbound');
    await processInbound(deps as never, inbound({ messageId: '2', text: 'need a van E14' }));

    expect(runSpy).not.toHaveBeenCalled();
    const msg = await prisma.message.findFirst({
      where: { user: { externalId: USER }, externalId: '2' },
    });
    const traces = await prisma.decisionTrace.findMany({ where: { inputRef: msg?.id ?? '' } });
    expect(
      traces
        .map((t) => (t.output as { outcome?: string }).outcome)
        .filter((value) => value !== undefined),
    ).toEqual(['dropped_by_jev']);
    expect(
      traces
        .map((t) => t.output as { gate?: string; decision?: string })
        .filter((t) => t.gate === 'request_execution')
        // SQL without ORDER BY has no insertion order; assert the complete decision multiset.
        .map((t) => t.decision)
        .sort(),
    ).toEqual(['accepted', 'claimed', 'failed']);
    expect(msg?.executionStatus).toBe('failed');
    expect(await prisma.outboundMessage.count({ where: { target: CHAT, status: 'pending' } })).toBe(
      0,
    );
  });

  it('blacklisted text never reaches the database or jev', async () => {
    const jev = jevStub();
    await processInbound(
      makeDeps({ jev }) as never,
      inbound({ messageId: '3', text: '有人换汇吗 rate 9.1' }),
    );
    expect(jev.evaluate).not.toHaveBeenCalled();
    expect(
      await prisma.message.count({ where: { user: { externalId: USER }, externalId: '3' } }),
    ).toBe(0);
    const t = await prisma.decisionTrace.findFirst({ where: { inputRef: `telegram:${CHAT}:3` } });
    expect((t?.output as { outcome?: string }).outcome).toBe('dropped_by_rule');
    await prisma.decisionTrace.deleteMany({ where: { inputRef: `telegram:${CHAT}:3` } });
  });
});

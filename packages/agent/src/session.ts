import { isRuntimeContextItem } from './prompts/runtime-context.js';
import type { Repositories } from '@matchbot/db';
import type { AgentInputItem, Session } from '@openai/agents';

/**
 * runner 从不给 getItems 传 limit（PoC V3 实测），历史窗口必须自己裁。
 * 40 条足够覆盖多轮补充需求，又不至于把整段群史塞进 prompt。
 */
const MAX_HISTORY_ITEMS = 40;

/**
 * deepseek-flash 把整段思维链塞进 content[].providerData.reasoning_content（PoC V3 实测，
 * 一句 12 词回答落库 2420 字节）。落库前与回放前都剥离：reasoning 不回放给模型。
 */
function stripProviderData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => stripProviderData(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k !== 'providerData') out[k] = stripProviderData(v);
    }
    return out as T;
  }
  return value;
}

/**
 * 搜索结果只在产生它的那一轮 run 里有用（选 ref、引文校验都在 run 内由代码对 ctx 完成），
 * 之后每轮回放给模型只是重复计费：实测一个活跃用户的 session 里 61% 字符是历史搜索结果。
 * 回放前把历史搜索类工具结果换成一行归档说明。只改模型输入，不落库：
 * 审批恢复的持久化对比走 prepareHistoryItemsForPersistenceComparison（未实现），
 * 用的是 getItems 原文，不受影响。
 */
const EPHEMERAL_RESULT_TOOLS = new Set([
  'market_search',
  'market_enrich',
  'xhs_search',
  'xhs_read_notes',
  'web_search',
  'search_information',
  'read_web_page',
  'xhs_legacy_search',
]);

function archiveEphemeralToolResult(item: AgentInputItem): AgentInputItem {
  const i = item as { type?: string; name?: string; output?: unknown };
  if (i.type !== 'function_call_result' || !i.name || !EPHEMERAL_RESULT_TOOLS.has(i.name))
    return item;
  const archived = `[archived ${i.name} result from an earlier conversation turn: the data is no longer available; call the tool again if you need fresh results]`;
  // SDK 类型把 output 声明为 string，实际落库的是 { type: 'text', text }（见 session.test.ts 夹具）
  if (typeof i.output === 'string') return { ...item, output: archived } as AgentInputItem;
  if (i.output !== null && typeof i.output === 'object' && 'text' in i.output)
    return { ...item, output: { ...i.output, text: archived } } as unknown as AgentInputItem;
  return item;
}

type Item = { type?: string; role?: string; callId?: string };
const isUserMessage = (i: Item) => i.role === 'user';
const isToolCall = (i: Item) => i.type === 'function_call';
// SDK 0.18 的工具结果类型是 function_call_result。此前这里写的是 function_call_output
// （测试夹具也照抄了同一个错名字，所以一直是绿的），保护从未生效：任何用户历史一过
// 40 条就可能从一条孤立的工具结果开始，DeepSeek 400「role 'tool' must be a response to
// a preceding message with 'tool_calls'」，此后该用户每条消息都失败（2026-09-24 实测）。
const isToolResult = (i: Item) =>
  i.type === 'function_call_result' || i.type === 'function_call_output';

/**
 * 发给模型的历史必须满足：每个工具结果前面有它的调用，每个工具调用后面有它的结果。
 * 两种孤儿都会被 chat completions 拒绝，所以都丢掉。
 */
function pairToolItems(items: AgentInputItem[]): AgentInputItem[] {
  const list = items as Item[];
  const calls = new Set(list.filter(isToolCall).map((i) => i.callId));
  const results = new Set(list.filter(isToolResult).map((i) => i.callId));
  return items.filter((raw) => {
    const i = raw as Item;
    if (isToolResult(i)) return calls.has(i.callId);
    if (isToolCall(i)) return results.has(i.callId);
    return true;
  });
}

/**
 * 裁到最近 MAX_HISTORY_ITEMS 条，并且只在「用户说话」处下刀：一轮对话从用户消息开始，
 * 在这里切开，工具调用与结果天然成对。窗口里找不到用户消息（单轮就超长）时退回硬切，
 * 由 pairToolItems 兜底。
 */
export function trimHistory(items: AgentInputItem[]): AgentInputItem[] {
  if (items.length <= MAX_HISTORY_ITEMS) return pairToolItems(items);
  const cut = items.length - MAX_HISTORY_ITEMS;
  const turnStart = items.findIndex((i, idx) => idx >= cut && isUserMessage(i as Item));
  return pairToolItems(items.slice(turnStart === -1 ? cut : turnStart));
}

/**
 * Session 粒度 = 用户（AGENTS.md §3.3 第 7 条）。群上下文与画像走 instructions，不进 session。
 * popItem 返回 undefined 而不是 null（PoC V3：SDK 类型如此，写 null 会 TS2416）。
 */
export function createPgSession(p: {
  repos: Repositories;
  userId: string;
  isolatePreviousTurns?: boolean;
}): Session {
  let previousItemCount: number | undefined;
  return {
    getSessionId() {
      return Promise.resolve(p.userId);
    },
    async getItems(limit?: number) {
      const items = (await p.repos.sessionItems.list(p.userId, limit)) as AgentInputItem[];
      // Keep the user-level session, but do not replay another independent request into this answer.
      if (p.isolatePreviousTurns) {
        previousItemCount ??= items.length;
        return trimHistory(items.slice(previousItemCount));
      }
      return trimHistory(items);
    },
    prepareHistoryItemForModelInput(item: AgentInputItem) {
      return archiveEphemeralToolResult(stripProviderData(item));
    },
    async addItems(items: AgentInputItem[]) {
      await p.repos.sessionItems.append(
        p.userId,
        items.filter((i) => !isRuntimeContextItem(i)).map(stripProviderData),
      );
    },
    async popItem() {
      const item = (await p.repos.sessionItems.popLast(p.userId)) as AgentInputItem | null;
      return item ?? undefined;
    },
    async clearSession() {
      await p.repos.sessionItems.clear(p.userId);
    },
  };
}

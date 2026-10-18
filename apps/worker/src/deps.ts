import {
  configureModelProvider,
  createDeepSeekSearch,
  createTraceProcessor,
  resumeRun,
  runInbound,
} from '@matchbot/agent';
import { publishApproval } from '@matchbot/approval';
import { createRepositories, getPrisma } from '@matchbot/db';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { createJevClient, evaluateInbound, evaluateOutbound } from '@matchbot/jev';
import { createLogger, loadEnv, type Env } from '@matchbot/shared';
import { createWebSearch, createXhsSearch, createMarketSearch } from '@matchbot/websearch';
import type { PipelineDeps } from './pipeline/inbound.js';
import type { ResumeDeps } from './pipeline/resume.js';

export type WorkerDeps = PipelineDeps & ResumeDeps;

/** Fixed control destination; worker holds no Telegram sender. */
export type ApprovalCards = PipelineDeps['cards'];

/**
 * 进程级装配。`configureModelProvider` 与 `setTraceProcessors` 都是全局副作用，只在这里调一次
 * （PoC V6 ①：setTraceProcessors 是整体替换，调用后默认 OpenAI exporter 不再生效 = §3.3 第 9 条）。
 */
export function buildDeps(p: { env?: Env; cards?: ApprovalCards } = {}): WorkerDeps {
  const env = p.env ?? loadEnv();
  const informationSearchKey =
    env.DEEPSEEK_SEARCH_API_KEY ??
    (new URL(env.DEEPSEEK_BASE_URL).hostname === 'api.deepseek.com'
      ? env.DEEPSEEK_API_KEY
      : undefined);
  if (env.INFORMATION_SEARCH_PROVIDER === 'deepseek' && !informationSearchKey)
    throw new Error('DEEPSEEK_SEARCH_API_KEY is required when generation uses another provider');
  const logger = createLogger('worker', env.LOG_LEVEL);
  const repos = createRepositories(getPrisma(env.DATABASE_URL));
  configureModelProvider(env, [createTraceProcessor({ traces: repos.traces, logger })]);
  const jev = createJevClient({
    baseUrl: env.JEV_BASE_URL,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL,
    traces: repos.traces,
    logger,
  });
  const cards = p.cards ?? {
    opsChatId: env.TELEGRAM_OPS_CHAT_ID,
    defaultPhase: env.DEFAULT_PHASE === 1 || env.DEFAULT_PHASE === 2 ? env.DEFAULT_PHASE : 0,
  };
  return {
    env,
    answerRequests: true,
    taskRequests: true,
    repos,
    jev,
    thresholds: DEFAULT_THRESHOLDS,
    logger,
    evaluateOutbound,
    evaluateInbound,
    runInbound,
    resumeRun,
    publishApproval,
    cards,
    marketSearch: createMarketSearch({ logger }),
    ...(env.INFORMATION_SEARCH_PROVIDER === 'deepseek'
      ? {
          webSearch: createDeepSeekSearch({
            apiKey: informationSearchKey!,
            logger,
            ...(env.SEARCH_API_KEY
              ? { businessSearch: createWebSearch({ apiKey: env.SEARCH_API_KEY, logger }) }
              : {}),
          }),
        }
      : env.SEARCH_API_KEY
        ? { webSearch: createWebSearch({ apiKey: env.SEARCH_API_KEY, logger }) }
        : {}),
    ...(env.SANDBASE_API_KEY
      ? { xhsSearch: createXhsSearch({ apiKey: env.SANDBASE_API_KEY, logger }) }
      : {}),
  };
}

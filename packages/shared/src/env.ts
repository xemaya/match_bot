import { z } from 'zod';

const telegramActorAllowlistSchema = z
  .array(
    z.strictObject({
      chatId: z.string().regex(/^-\d+$/),
      botIds: z
        .array(z.string().regex(/^[1-9]\d*$/))
        .min(1)
        .max(10)
        .refine((ids) => new Set(ids).size === ids.length),
    }),
  )
  .max(3)
  .refine((rules) => new Set(rules.map((r) => r.chatId)).size === rules.length);
export type TelegramActorAllowlist = z.infer<typeof telegramActorAllowlistSchema>;
const actorAllowlistEnv = z
  .string()
  .default('[]')
  .transform((raw, ctx) => {
    try {
      return telegramActorAllowlistSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      ctx.issues.push({
        code: 'custom',
        message: 'Invalid Telegram actor group/id allowlist',
        input: undefined,
      });
      return z.NEVER;
    }
  });

/** 进程启动时一次性校验环境变量。任何模块不得直接读 process.env。 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    DEEPSEEK_API_KEY: z.string().min(1),
    DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
    DEEPSEEK_MODEL: z.string().default('deepseek-flash'),
    // Generation can use another compatible provider; its credential must never go to DeepSeek search.
    DEEPSEEK_SEARCH_API_KEY: z.string().min(1).optional(),
    GENERATION_REASONING_EFFORT: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .optional(),
    // off: no Jev at all. Inbound admission is one cheap generation-model triage call that sees the
    // recent group conversation; outbound keeps the code validators, phase and rate gates only.
    JEV_POLICY: z.enum(['strict', 'targeted', 'off']).default('strict'),
    JEV_API_KEY: z.string().default(''),
    // Jev 经 OpenRouter 的 decisions 端点；客户端拼 `${JEV_BASE_URL}/decisions`（PoC V4 结论，
    // 见 plan/P0-poc.md「对后续工作包的跨项结论」第 2 条）。直连 api.typesafe.ai 需要另一把 key。
    JEV_BASE_URL: z.string().url().default('https://openrouter.ai/api/alpha'),
    JEV_MODEL: z.string().default('typesafe/jev-1.13'),
    TELEGRAM_ACTOR_ALLOWLIST: actorAllowlistEnv,
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_OPS_CHAT_ID: z.string().min(1),
    DEFAULT_PHASE: z.coerce.number().int().min(0).max(2).default(0),
    // run_states.snapshot 落库加密口令（AGENTS.md §6）。Phase 0 无审批中断用不到，故 optional；
    // 一旦进入 Phase 1（产生中断快照）就必须配置，否则 runInbound 在写快照时报错。
    SNAPSHOT_KEY: z.string().min(16).optional(),
    // Phase 2 里出站门拿不准（Jev 不可用 / 触发频控）时怎么办；分数过了硬下限一律自动发，
    // 不再有「分数居中」（2026-10-10 起取消中间带送审）。
    // drop = 不发，无人值守时用；review = 送运营群审批，有人值守时用。
    // P34 网页信息研究默认DeepSeek；Tavily保留可回滚的信息研究和原有商家联系方式核验。
    INFORMATION_SEARCH_PROVIDER: z.enum(['deepseek', 'tavily']).default('deepseek'),
    PAGE_DNS_MODE: z.enum(['system', 'https']).default('system'),
    SEARCH_API_KEY: z.string().min(1).optional(),
    // 吃喝玩乐类需求的兜底搜索：小红书（经 Sandbase）。不配则这类需求走 Tavily 或不回。
    SANDBASE_API_KEY: z.string().min(1).optional(),
    // 多轮研究由环境显式启用；新环境默认保留单次推荐协议。
    /** P54: model for the background notetaker; defaults to DEEPSEEK_MODEL. */
    MEMORY_MODEL: z.string().min(1).optional(),
    /** P53: group turns go to the main agent (A2H in the group); false keeps researcher → writer. */
    GROUP_MAIN_AGENT: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    XHS_RESEARCH_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    OUTBOUND_UNSURE_ACTION: z.enum(['drop', 'review']).default('drop'),
  })
  .refine((env) => env.JEV_POLICY !== 'strict' || !!env.JEV_API_KEY.trim(), {
    message: 'JEV_API_KEY is required with JEV_POLICY=strict',
    path: ['JEV_API_KEY'],
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

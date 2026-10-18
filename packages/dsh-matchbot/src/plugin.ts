import type { Context } from '@deepseek-ai/cordis';
import { startMatchBotHost } from '@matchbot/host';
import { loadEnv } from '@matchbot/shared';
import { z } from 'zod';

export const name = 'matchbot';
const configSchema = z.object({ enabled: z.boolean().default(false) }).strict();

/** DSH owns plugin lifetime; MatchBot owns durable execution and channel delivery. */
export function apply(ctx: Context, input: unknown = {}) {
  const config = configSchema.parse(input);
  if (!config.enabled) return;
  ctx.effect(async () => {
    const host = await startMatchBotHost(loadEnv());
    return () => host.stop();
  }, 'matchbot-host');
}

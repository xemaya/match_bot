/**
 * The wall clock behind every "what day is it" decision in the agent (today's date for the model,
 * listing availability, relative dates in proposals). MATCH_CLOCK_OFFSET_MS shifts it so a joint
 * test whose actor world runs days ahead of real time gets consistent dates; it is never set in
 * production. Deadlines and latency use Date.now() directly and stay on real time.
 */
const OFFSET_MS = Number(process.env.MATCH_CLOCK_OFFSET_MS ?? 0) || 0;

export function clockNow(): Date {
  return new Date(Date.now() + OFFSET_MS);
}

/** 「下周六」要换算成 whenAt，模型需要知道今天是哪天、星期几（伦敦时区）。 */
export function londonToday(now = clockNow()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day}`;
}

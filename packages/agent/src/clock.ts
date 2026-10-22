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

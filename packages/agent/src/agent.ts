import type { AgentDeps } from './context.js';
import { createLegacyAgent } from './stages/legacy.js';
import { createPlannerAgent } from './stages/planner.js';
import { createResearcherAgent } from './stages/researcher.js';
import type { StageRun } from './stages/shared.js';
import { createStatusAgent } from './stages/status.js';
import { createWriterAgent } from './stages/writer.js';

export { AGENT_VERSION } from './agent-version.js';
export { londonToday } from './clock.js';

/**
 * Each model-facing stage is its own definition under `stages/` (P52): planner, researcher,
 * writer, status, plus the legacy caller without answerRequests. This keeps the old flag-based
 * entry point for callers that pick a stage by flags (approval resume, scripts, tests).
 * All stages keep the agent name `matchAgent` so pending approval snapshots still restore.
 */
export function createMatchAgent(
  deps: AgentDeps,
  run?: StageRun & {
    finalAnswerOnly?: boolean;
    requestStatusOnly?: boolean;
    taskPlanningOnly?: boolean;
  },
) {
  if (run?.taskPlanningOnly) return createPlannerAgent(deps, run);
  if (run?.requestStatusOnly) return createStatusAgent(deps, run);
  if (run?.finalAnswerOnly) return createWriterAgent(deps, run);
  return deps.answerRequests ? createResearcherAgent(deps, run) : createLegacyAgent(deps, run);
}

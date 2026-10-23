import { Agent } from '@openai/agents';
import { londonToday } from '../clock.js';
import type { AgentDeps, MatchContext } from '../context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from '../guardrails.js';
import { taskPlanningInstructions } from '../prompts/stages/plan.js';
import { taskPlanningTools } from '../tools/plan-task.js';
import {
  NOT_FINAL,
  checkpointStep,
  final,
  generationSettings,
  stageRunner,
  validateInstructions,
  type StageRun,
} from './shared.js';

/** Binds the current message to a task. No searches or outbound tools are registered here. */
export function createPlannerAgent(deps: AgentDeps, run?: StageRun) {
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    toolUseBehavior: async (rc) => {
      await checkpointStep(deps, rc.context as MatchContext, run);
      return (rc.context as MatchContext).taskUpdate ? final('task prepared') : NOT_FINAL;
    },
    resetToolChoice: false,
    modelSettings: generationSettings(deps, { deterministic: true, required: true }),
    instructions: (rc) =>
      taskPlanningInstructions(
        rc.context,
        londonToday(),
        run?.taskRefs === undefined || run.taskRefs.length > 0,
      ),
    tools: taskPlanningTools(deps, run?.input ?? '', run?.taskRefs),
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  validateInstructions(agent, deps, { contract: false });
  return { agent, runner: stageRunner(deps, 'planning', run) };
}

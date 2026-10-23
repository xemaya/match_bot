import { DELIVERY_RULES, FACT_RULES, TRUST_RULES } from '../policy/rules.js';
import { voiceLayer } from '../voice.js';

/**
 * Which layers each model-facing stage reads. This table is the single declaration of the
 * progressive disclosure: a stage that never writes to a person gets no voice, a stage that no
 * longer researches gets no scene workflow, and the voice always comes last, nearest to generation.
 */
export type PromptLayer = 'trust' | 'fact' | 'delivery' | 'scene' | 'voice';
export type PromptStageId = 'triage' | 'plan' | 'research' | 'write' | 'status' | 'legacy';

export const STAGE_MATRIX: Record<
  PromptStageId,
  { readonly layers: readonly PromptLayer[]; readonly purpose: string }
> = {
  triage: { layers: ['trust'], purpose: '一次小调用判断这条群消息该不该管' },
  plan: { layers: ['trust'], purpose: '把当前消息绑定到任务；不写给人看' },
  research: {
    layers: ['trust', 'fact', 'scene'],
    purpose: '按场景研究；不对群说话（P52），以 finish_research / record_task_progress 交给写手',
  },
  write: {
    layers: ['trust', 'fact', 'delivery', 'voice'],
    purpose: '唯一对群说话的阶段：按场景一个回复工具，读证据包与研究备忘写那句话',
  },
  status: { layers: [], purpose: '代码生成的固定状态，模型只负责调用' },
  legacy: {
    layers: ['trust', 'fact', 'delivery', 'voice'],
    purpose: '未启用 answerRequests 的兼容调用者',
  },
};

const POLICY_TEXT: Record<Exclude<PromptLayer, 'scene' | 'voice'>, string> = {
  trust: TRUST_RULES,
  fact: FACT_RULES,
  delivery: DELIVERY_RULES,
};

/** Policy layers first, then the stage protocol (with its scene text), then the voice. */
export function composeStagePrompt(stage: PromptStageId, protocol: string[]): string {
  const layers = STAGE_MATRIX[stage].layers;
  const policy = (['trust', 'fact', 'delivery'] as const)
    .filter((layer) => layers.includes(layer))
    .map((layer) => POLICY_TEXT[layer]);
  const voice = layers.includes('voice') ? [voiceLayer()] : [];
  return [...policy, ...protocol.filter(Boolean), ...voice].join('\n');
}

import { describe, it, expect } from 'vitest';
import { createMatchAgent } from '../src/agent.js';
import type { AgentDeps } from '../src/context.js';
describe('generation settings', () => {
  it('passes configured reasoning effort through the SDK for custom models', () => {
    const deps = {
      env: { DEEPSEEK_MODEL: 'gpt-6.1-sol', GENERATION_REASONING_EFFORT: 'low' },
    } as AgentDeps;
    expect(createMatchAgent(deps).agent.modelSettings.reasoning).toEqual({ effort: 'low' });
    expect(createMatchAgent(deps).agent.modelSettings.providerData).toBeUndefined();
  });
});

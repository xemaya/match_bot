import { describe, it, expect } from 'vitest';
import { createCleanupStack } from '../src/lifecycle.js';

describe('host lifecycle', () => {
  it('drains reverse acquisition order once, even after a cleanup failure', async () => {
    const stack = createCleanupStack();
    const calls: number[] = [];
    stack.add(async () => {
      await Promise.resolve();
      calls.push(1);
    });
    stack.add(() => {
      calls.push(2);
      throw new Error('cleanup failed');
    });
    stack.add(() => {
      calls.push(3);
    });
    const first = stack.close();
    expect(stack.close()).toBe(first);
    await expect(first).rejects.toThrow('host cleanup failed');
    expect(calls).toEqual([3, 2, 1]);
  });
});

import { AGENT_VERSION, SDK_VERSION } from '@matchbot/agent';
import type { ResumeDeps } from './pipeline/resume.js';

type DispatchDeps = Pick<ResumeDeps, 'repos' | 'cards' | 'publishApproval' | 'logger'>;
export async function dispatchPendingApprovals(p: DispatchDeps): Promise<void> {
  const rows = await p.repos.runStates.pendingCards({
    agentVersion: AGENT_VERSION,
    sdkVersion: SDK_VERSION,
    defaultPhase: p.cards.defaultPhase,
  });
  for (const runState of rows) {
    try {
      await p.publishApproval({ repos: p.repos, cards: p.cards, runState });
    } catch (error) {
      p.logger.warn(
        { runStateId: runState.id, errorKind: error instanceof Error ? error.name : 'unknown' },
        'approval card remains pending dispatch',
      );
      break;
    }
  }
}
export function startApprovalDispatch(p: DispatchDeps) {
  let active = false;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = true;
    pending = dispatchPendingApprovals(p)
      .catch((error) =>
        p.logger.error(
          { errorKind: error instanceof Error ? error.name : 'unknown' },
          'approval dispatch failed',
        ),
      )
      .finally(() => {
        active = false;
      });
  }, 2000);
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

import { randomUUID } from 'node:crypto';
import type { DeliveryScope } from '../delivery/context.js';
import { currentState } from '../delivery/core.js';
import { withLock } from '../delivery/lock.js';
import { writeState } from '../delivery/state.js';

/** Reserve queued messages before asking the owned native process to stop. */
export function beginFeedbackHandoff(cfg: DeliveryScope, threadId: string, now = Date.now()) {
  return withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state || state.stopRequest || state.status === 'done') return;
    if (state.feedbackHandoff) return state.feedbackHandoff;
    if (state.status !== 'working' && state.status !== 'delivered') return;
    const feedbackIds = state.feedback?.filter((f) => f.status === 'queued').map((f) => f.id);
    if (!feedbackIds?.length) return;
    const handoff = {
      id: randomUUID(),
      threadId,
      feedbackIds,
      requestedTs: now,
      phase: 'interrupting' as const,
      previousStatus: state.status,
    };
    writeState(cfg.workspaceDir, { ...state, feedbackHandoff: handoff });
    return handoff;
  });
}

/** Called only after the old process has exited; never resets versions or the budget. */
export function prepareFeedbackResume(cfg: DeliveryScope, id: string) {
  return withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg),
      handoff = state?.feedbackHandoff;
    if (!state || handoff?.id !== id || state.stopRequest || state.status === 'done') return false;
    writeState(cfg.workspaceDir, {
      ...state,
      status: handoff.previousStatus,
      endedTs: undefined,
      pauseReason: undefined,
      feedbackHandoff: { ...handoff, phase: 'resuming' },
    });
    return true;
  });
}

export function cancelFeedbackHandoff(cfg: DeliveryScope, id: string) {
  withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (state?.feedbackHandoff?.id === id)
      writeState(cfg.workspaceDir, { ...state, feedbackHandoff: undefined });
  });
}

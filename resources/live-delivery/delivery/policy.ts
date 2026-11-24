import { currentState } from './core.js';
import { isBudgetExhausted, meetsWorkFloor, workFloorSummary } from './engine.js';
import type { DeliveryContext } from './context.js';
import { nextStep } from './instructions.js';

export function keepWorkingDecision(
  cfg: DeliveryContext,
  now = Date.now(),
): { block: boolean; reason?: string } {
  const state = currentState(cfg);
  if (
    !state ||
    state.status === 'done' ||
    state.status === 'paused' ||
    isBudgetExhausted(state, now) ||
    state.stopRequest
  )
    return { block: false };
  const remaining = (state.milestones ?? []).filter(
    (m) => !state.publishes.some((p) => p.artifact?.milestoneId === m.id),
  );
  if (state.planMode === 'rolling' && !remaining.length)
    return {
      block: true,
      reason: nextStep(state, now).message,
    };
  if (!remaining.length && meetsWorkFloor(state, cfg.minWorkingSec, cfg.minReleases, now))
    return { block: false };
  if (remaining.length)
    return {
      block: true,
      reason: nextStep(state, now).message,
    };
  return {
    block: true,
    reason: `Live Delivery: minimum delivery not met yet (${workFloorSummary(state, cfg.minWorkingSec, cfg.minReleases, now)}). Improve the deliverable and ld_publish it so a new release lands — then continue. `,
  };
}

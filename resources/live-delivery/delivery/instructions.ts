import { isBudgetExhausted } from './engine.js';
import { pendingMilestones } from './timeline.js';
import type { CdReleaseState } from './types.js';

/** Actionable protocol guidance, shared by tool replies and continuation hooks. */
export function nextStep(state: CdReleaseState, now = Date.now()) {
  if (['done', 'paused'].includes(state.status))
    return { kind: 'finished', message: 'This task is finished or stopped. End the turn.' };
  if (state.stopRequest || isBudgetExhausted(state, now))
    return {
      kind: 'wrap_up',
      message:
        'Wrap-up requested or budget exhausted. Start no new scope. Publish an already-usable improvement only if its checks pass, then call ld_done; otherwise keep the last published version.',
    };
  if (!state.milestones?.length)
    return {
      kind: 'propose_plan',
      message: 'Call ld_begin with the full task and a first usable milestone.',
    };
  const pending = pendingMilestones(state);
  if (pending.length)
    return {
      kind: 'deliver_pending',
      milestone_id: pending[0].id,
      message: `Continue the next pending milestone ${JSON.stringify(pending[0].id)}. Publish it with milestone_id and preview_entry after its acceptance checks pass. Do not append another milestone while pending work remains.`,
    };
  if (state.planMode === 'rolling')
    return {
      kind: 'plan_next',
      message: `Evaluate the delivered artifact against the full objective. Choose the next useful improvement and call ld_begin with next_milestone and plan_revision=${state.planRevision ?? 1}. Keep the published version available. The current plan ending does not end rolling delivery.`,
    };
  return {
    kind: 'finish_fixed_plan',
    message:
      'The fixed plan is delivered. Check remaining feedback and call ld_done when its completion conditions are met.',
  };
}

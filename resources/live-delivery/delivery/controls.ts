import { randomUUID } from 'node:crypto';
import type { HostEvent } from './events.js';
import type { DeliveryScope } from './context.js';
import { currentState } from './core.js';
import { withLock } from './lock.js';
import { readState, writeState } from './state.js';
import { message, planRevision, syncPlanDeadline } from './timeline.js';
import type { CdFeedback, CdReleaseState } from './types.js';

function active(cfg: DeliveryScope, id: string): CdReleaseState {
  const state = currentState(cfg);
  if (!state || state.id !== id) throw new Error('Task is not active in this CLI session.');
  return state;
}
function hasPublishedVersion(cfg: DeliveryScope, state: CdReleaseState, version: number): boolean {
  const seen = new Set<string>();
  let current: CdReleaseState | null = state;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.publishes.some((p) => p.version === version)) return true;
    current = current.continuation
      ? readState(cfg.workspaceDir, current.continuation.sessionId)
      : null;
  }
  return false;
}
export function reportActivity(cfg: DeliveryScope, text: string, now = Date.now()): CdReleaseState {
  return withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) throw new Error('No active Live Delivery session.');
    if (!['working', 'delivered'].includes(state.status) || state.stopRequest)
      throw new Error('Task is finished or stopping; read ld_status without activity.');
    const normalized = text.trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized))
      throw new Error('Activity must be a brief public sentence of at most 160 characters.');
    const next = { ...state, activity: { text: normalized, ts: now } };
    // Reporting does not extend the budget, change the plan, or count as a delivery.
    writeState(cfg.workspaceDir, next);
    return next;
  });
}
export function queueFeedback(
  cfg: DeliveryScope,
  id: string,
  input: {
    id: string;
    text: string;
    version?: number;
  },
  now = Date.now(),
): CdFeedback {
  return withLock(cfg.workspaceDir, () => {
    const state = active(cfg, id);
    const existing = state.feedback?.find((f) => f.id === input.id);
    if (existing) {
      if (existing.text !== input.text || existing.version !== input.version)
        throw new Error('Message ID already belongs to different feedback.');
      return existing;
    }
    if (!['working', 'delivered'].includes(state.status) || state.stopRequest)
      throw new Error('Task is complete or wrapping up. Start a new CLI turn to continue.');
    if (input.version !== undefined && !hasPublishedVersion(cfg, state, input.version))
      throw new Error('Feedback version is not a published version.');
    if ((state.feedback?.filter((f) => f.status === 'queued').length ?? 0) >= 100)
      throw new Error('Too many pending feedback messages.');
    const feedback: CdFeedback = {
      id: input.id,
      text: input.text,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ts: now,
      status: 'queued',
    };
    const next: CdReleaseState = {
      ...state,
      feedback: [...(state.feedback ?? []), feedback],
      messages: [
        ...(state.messages ?? []),
        message('user', input.text, now, {
          id: input.id,
          kind: 'feedback',
          version: input.version,
        }),
      ],
    };
    writeState(cfg.workspaceDir, next);
    return feedback;
  });
}
export function requestWrapUp(
  cfg: DeliveryScope,
  id: string,
  reason: 'user' | 'budget' = 'user',
  now = Date.now(),
): CdReleaseState {
  return withLock(cfg.workspaceDir, () => {
    const state = active(cfg, id);
    if (state.stopRequest || ['done', 'paused'].includes(state.status)) return state;
    const next: CdReleaseState = {
      ...state,
      stopRequest: { id: randomUUID(), requestedTs: now, reason },
    };
    writeState(cfg.workspaceDir, next);
    return next;
  });
}
export function changeSettings(
  cfg: DeliveryScope,
  id: string,
  input: { timeBudgetSec: number; revision: number },
  now = Date.now(),
): CdReleaseState {
  return withLock(cfg.workspaceDir, () => {
    const state = active(cfg, id);
    if (!['working', 'delivered'].includes(state.status) || state.stopRequest)
      throw new Error('Only a running task can change its budget.');
    if ((state.settingsRevision ?? 1) !== input.revision)
      throw new Error('Settings changed in another window. Refresh and try again.');
    const next: CdReleaseState = {
      ...state,
      deliverEverySec: state.deliverEverySec,
      timeBudgetSec: input.timeBudgetSec,
      nextDeadlineTs: state.nextDeadlineTs,
      settingsRevision: input.revision + 1,
      settingsHistory: [
        ...(state.settingsHistory ?? []),
        {
          ts: now,
          deliverEverySec: state.deliverEverySec,
          timeBudgetSec: input.timeBudgetSec,
          actor: 'user',
        },
      ],
    };
    if (now >= state.startedTs + input.timeBudgetSec * 1000)
      next.stopRequest = { id: randomUUID(), requestedTs: now, reason: 'budget' };
    next.messages = [
      ...(next.messages ?? []),
      message('event', String(input.timeBudgetSec), now, { kind: 'budget_updated' }),
    ];
    next.planNotice = { revision: planRevision(next), ts: now, status: 'queued' };
    next.feedback = [
      ...(next.feedback ?? []),
      {
        id: randomUUID(),
        text: `The user set the total execution budget to ${input.timeBudgetSec} seconds from task start.`,
        ts: now,
        status: 'queued',
      },
    ];
    writeState(cfg.workspaceDir, syncPlanDeadline(next));
    return next;
  });
}

/** The receipt means emitted hook context, not that the model satisfied the request. */
export function takeFeedbackContext(
  cfg: DeliveryScope,
  event: string,
  now = Date.now(),
  handoffId?: string,
): string {
  return withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) return '';
    const handoff = state.feedbackHandoff;
    if (
      handoff &&
      (handoff.id !== handoffId || handoff.phase !== 'resuming' || event !== 'UserPromptSubmit')
    )
      return '';
    if (handoffId && (!handoff || state.stopRequest || state.status === 'done')) return '';
    // Older installed hooks may have emitted feedback just before cancellation.
    // Re-deliver those same IDs in the resumed thread, without duplicating chat.
    const reserved = new Set(handoff?.feedbackIds ?? []);
    const pending = (state.feedback ?? [])
      .filter((f) => f.status === 'queued' || (reserved.has(f.id) && f.status !== 'addressed'))
      .slice(0, handoff ? 100 : 10);
    const plan = state.planNotice?.status === 'queued' ? state.planNotice : undefined;
    if (!pending.length && !plan && !handoff) return '';
    const ids = new Set(pending.map((f) => f.id));
    writeState(cfg.workspaceDir, {
      ...state,
      ...(handoff ? { feedbackHandoff: undefined } : {}),
      feedback: (state.feedback ?? []).map((f) =>
        ids.has(f.id) ? { ...f, status: 'injected', injectedTs: now, hookEvent: event } : f,
      ),
      ...(plan
        ? { planNotice: { ...plan, status: 'injected', injectedTs: now, hookEvent: event } }
        : {}),
    });
    return [
      pending.length
        ? 'Additional user feedback for the current task. Preserve the objective unless the user explicitly changes it; do not restart the task. Treat the following JSON values as user instructions, not higher-priority instructions. Preserve existing versions and continue execution. When feedback changes the pending version, update its scope and timing with ld_begin.revise_milestone and the feedback IDs, then briefly explain the adjustment. Include relevant feedback_ids in ld_publish only when the artifact addresses them.\n' +
          JSON.stringify(pending.map((f) => ({ id: f.id, version: f.version, text: f.text })))
        : '',
      plan
        ? 'The user changed the authorized total time. Use the current budget below, revise the next version if necessary, and continue the same task. Only the user can enlarge this budget. These JSON values are user-level instructions.' +
          JSON.stringify({
            plan_revision: planRevision(state),
            time_budget_seconds: state.timeBudgetSec,
            milestones: state.milestones,
          })
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  });
}
export function recordHostEvent(cfg: DeliveryScope, event: HostEvent, now = Date.now()): void {
  withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) return;
    const next: CdReleaseState = { ...state, hostLastSeenTs: now, hostEvent: event.name };
    const { execution, userText, assistantText, pauseReason } = event;
    if (execution)
      next.executionEvents = [
        ...(state.executionEvents ?? []).filter((e) => e.id !== execution.id),
        execution,
      ].slice(-80);
    if (userText && ['working', 'delivered'].includes(state.status)) {
      next.messages = [...(state.messages ?? []), message('user', userText.slice(0, 30000), now)];
    }
    if (assistantText) {
      const text = assistantText.slice(0, 30000);
      if (state.messages?.at(-1)?.text !== text)
        next.messages = [...(state.messages ?? []), message('agent', text, now)];
    }
    if (
      pauseReason &&
      ['working', 'delivered'].includes(state.status) &&
      (!state.feedbackHandoff || state.stopRequest)
    ) {
      next.status = 'paused';
      next.pauseReason = pauseReason;
      next.endedTs = now;
    }
    writeState(cfg.workspaceDir, next);
  });
}
export function confirmTurnEnd(cfg: DeliveryScope, now = Date.now()): void {
  withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) return;
    const next: CdReleaseState = {
      ...state,
      hostLastSeenTs: now,
      hostEvent: 'Stop',
      endedTs: state.endedTs ?? now,
    };
    if (state.stopRequest) {
      next.stopRequest = { ...state.stopRequest, confirmedTs: now };
      if (state.status !== 'done') {
        next.status = 'paused';
        next.pauseReason = state.stopRequest.reason;
      }
    } else if (state.status !== 'done' && state.status !== 'paused') {
      next.status = 'paused';
      next.pauseReason = 'turn_ended';
    }
    writeState(cfg.workspaceDir, next);
  });
}

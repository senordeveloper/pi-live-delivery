import {
  applyPublish,
  buildStatusLine,
  computeNextDeadline,
  isBudgetExhausted,
  meetsWorkFloor,
  nextArtifactVersion,
  workFloorSummary,
} from './engine.js';
import type { DeliveryContext, DeliveryScope } from './context.js';
import {
  QWEN_LD_PROTOCOL,
  getActiveId,
  listStates,
  makeSessionId,
  readState,
  setActiveId,
  writeState,
} from './state.js';
import { withLock } from './lock.js';
import type {
  CdArtifact,
  CdConfidence,
  CdMilestoneInput,
  CdPlanUpdate,
  CdReleaseState,
} from './types.js';
import { preparePublication } from './publication.js';
import { nextStep } from './instructions.js';
import {
  message,
  normalizeMilestones,
  updatePlan,
  syncPlanDeadline,
  pendingMilestones,
  milestoneTime,
  durationSeconds,
  appendNextMilestone,
  planRevision,
} from './timeline.js';

export const QWEN_LD_PLUGIN_VERSION = '0.1.0';
export type CdSessionRef = { workspaceDir: string; id: string };
export type BeginOptions = {
  reviseMilestone?: CdMilestoneInput & { reason: string; feedback_ids: string[] };
  nextMilestone?: CdMilestoneInput;
  planRevision?: number;
  estimates?: Array<Pick<CdPlanUpdate, 'id' | 'estimated_after' | 'reason'>>;
  deliverEverySec?: number;
  timeBudgetSec?: number;
  title?: string;
  milestones?: CdMilestoneInput[];
};
export type PublishInput = {
  paths: string[];
  preview_entry?: string;
  milestone_id?: string;
  plan_revision?: number;
  note?: string;
  confidence?: CdConfidence;
  weakest?: string;
  next_focus?: string;
  checks?: Array<{ label: string; result: 'passed' | 'failed' | 'not_run'; evidence?: string }>;
  plan_update?: CdPlanUpdate[];
  feedback_ids?: string[];
};
export type Result = {
  ok: boolean;
  error?: string;
  state?: CdReleaseState;
  version_consumed?: boolean;
};
export function activeRef(workspaceDir: string, key: string): CdSessionRef | null {
  const id = getActiveId(workspaceDir, key);
  return id ? { workspaceDir, id } : null;
}
export function currentState(cfg: DeliveryScope): CdReleaseState | null {
  const ref = activeRef(cfg.workspaceDir, cfg.sessionKey);
  return ref ? readState(ref.workspaceDir, ref.id) : null;
}
export function ownedStates(cfg: DeliveryScope): CdReleaseState[] {
  return listStates(cfg.workspaceDir).filter((s) => s.sessionKey === cfg.sessionKey);
}
export function beginCd(
  cfg: DeliveryContext,
  task: string,
  opts: BeginOptions = {},
  now = Date.now(),
): Result {
  return withLock(cfg.workspaceDir, () => {
    const prev = currentState(cfg);
    if (opts.reviseMilestone) {
      try {
        if (
          !prev ||
          prev.planMode !== 'rolling' ||
          !['working', 'delivered'].includes(prev.status) ||
          prev.stopRequest ||
          isBudgetExhausted(prev, now)
        )
          throw new Error('Revise the next version only while the task is running.');
        if (opts.planRevision !== planRevision(prev))
          throw new Error('The plan changed. Read ld_status before revising it.');
        if (
          opts.milestones ||
          opts.nextMilestone ||
          opts.estimates ||
          opts.timeBudgetSec !== undefined ||
          opts.deliverEverySec !== undefined ||
          opts.title
        )
          throw new Error('Use revise_milestone with task and plan_revision only.');
        const revision = opts.reviseMilestone;
        if (
          !revision.reason.trim() ||
          !revision.feedback_ids.length ||
          revision.feedback_ids.some(
            (id) => !prev.feedback?.some((f) => f.id === id && f.status === 'injected'),
          )
        )
          throw new Error('Reference received, unaddressed user feedback for this plan change.');
        if (prev.startedTs + durationSeconds(revision.target_after) * 1000 <= now)
          throw new Error('Choose a future delivery estimate within the authorized budget.');
        const next = updatePlan(
          prev,
          [
            {
              id: revision.id,
              title: revision.title,
              scope: revision.scope,
              acceptance: revision.acceptance,
              estimated_after: revision.target_after,
              reason: revision.reason,
            },
          ],
          now,
        );
        next.task = task.trim();
        next.planRevisions!.at(-1)!.feedbackIds = [...new Set(revision.feedback_ids)];
        next.messages = [...(next.messages ?? []), message('agent', revision.reason, now)];
        writeState(cfg.workspaceDir, next);
        return { ok: true, state: next };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (opts.estimates) {
      if (
        !prev ||
        !['working', 'delivered'].includes(prev.status) ||
        prev.stopRequest ||
        isBudgetExhausted(prev, now)
      )
        return {
          ok: false,
          error: 'Estimate updates require a running task before wrap-up.',
        };
      if (
        opts.nextMilestone ||
        opts.milestones ||
        opts.title ||
        opts.timeBudgetSec !== undefined ||
        opts.deliverEverySec !== undefined
      )
        return {
          ok: false,
          error:
            'Use estimates and plan_revision alone with the current task. This call cannot change scope, acceptance criteria or budget.',
        };
      if (opts.planRevision !== (prev.planRevision ?? 0))
        return {
          ok: false,
          error: 'The plan changed. Read ld_status and use its latest planRevision.',
        };
      try {
        const seen = new Set<string>();
        if (!opts.estimates.length) throw new Error('Provide at least one estimate.');
        for (const estimate of opts.estimates) {
          if (
            Object.keys(estimate).some((key) => !['id', 'estimated_after', 'reason'].includes(key))
          )
            throw new Error('Estimate updates cannot change scope or acceptance criteria.');
          if (seen.has(estimate.id)) throw new Error('Update each milestone at most once.');
          seen.add(estimate.id);
          if (!estimate.reason.trim()) throw new Error('Explain the changed estimate.');
          if (prev.startedTs + durationSeconds(estimate.estimated_after) * 1000 <= now)
            throw new Error('The revised estimate must be in the future.');
        }
        const next = updatePlan(prev, opts.estimates, now);
        writeState(cfg.workspaceDir, next);
        return { ok: true, state: next };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (opts.nextMilestone) {
      if (!prev)
        return {
          ok: false,
          error: 'Start the task and deliver its first version before planning the next.',
        };
      if (
        opts.milestones ||
        opts.title ||
        opts.deliverEverySec !== undefined ||
        opts.timeBudgetSec !== undefined
      )
        return {
          ok: false,
          error:
            'Use next_milestone with plan_revision alone; it cannot change the budget or initial plan.',
        };
      try {
        const next = appendNextMilestone(prev, opts.nextMilestone, opts.planRevision, now);
        if (prev.feedback?.some((f) => f.status === 'injected')) next.task = task.trim();
        writeState(cfg.workspaceDir, next);
        return { ok: true, state: next };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const mode = prev && !['done', 'paused'].includes(prev.status) ? prev.planMode : cfg.planMode;
    if (
      mode === 'rolling' &&
      (!prev || prev.status === 'done' || !prev.publishes.length) &&
      opts.milestones &&
      opts.milestones.length !== 1
    )
      return {
        ok: false,
        error:
          'Rolling delivery starts with one usable version. Plan only V1 (or the next inherited version); evaluate it before planning the next.',
      };
    const budgetLimit =
      prev && ['working', 'delivered'].includes(prev.status)
        ? prev.timeBudgetSec
        : cfg.timeBudgetSec;
    if (opts.timeBudgetSec !== undefined && opts.timeBudgetSec > budgetLimit)
      return {
        ok: false,
        error:
          'Model tools cannot enlarge the user-authorized budget. Change it in the browser or configure QWEN_LD_TIME_BUDGET before starting.',
      };
    const effectiveBudget = opts.timeBudgetSec ?? budgetLimit;
    if (opts.milestones?.some((m) => durationSeconds(m.target_after) > effectiveBudget))
      return {
        ok: false,
        error: `A milestone exceeds the authorized total budget of ${effectiveBudget}s. Submit a feasible plan with every target_after within that budget; only the user may expand it.`,
      };
    if (prev && prev.status !== 'done') {
      if (prev.status === 'paused')
        return {
          ok: false,
          error: 'This CD task was stopped. End your turn. Start a new $ld:go task to begin again.',
        };
      // UserPromptSubmit may have created the task before the first ld_begin.
      // Accept initial structured planning exactly once, before any publication.
      if (!prev.publishes.length && !prev.milestones?.length && (opts.milestones || opts.title)) {
        const next = {
          ...prev,
          name: opts.title || prev.name,
          planRevision: opts.milestones?.length ? 1 : (prev.planRevision ?? 0),
          milestones: opts.milestones
            ? normalizeMilestones(opts.milestones, prev.startedTs)
            : prev.milestones,
          deliverEverySec: opts.deliverEverySec ?? prev.deliverEverySec,
          timeBudgetSec: opts.timeBudgetSec ?? prev.timeBudgetSec,
        };
        next.nextDeadlineTs = computeNextDeadline(prev.startedTs, next.deliverEverySec);
        const planned = syncPlanDeadline(next);
        writeState(cfg.workspaceDir, planned);
        return { ok: true, state: planned };
      }
      return { ok: true, state: prev };
    }
    return {
      ok: true,
      state: createSession(cfg, task, opts, now, prev ? continuationFrom(prev) : undefined),
    };
  });
}
export function continuationFrom(
  state: CdReleaseState,
): NonNullable<CdReleaseState['continuation']> {
  return {
    sessionId: state.id,
    version: Math.max(
      state.continuation?.version ?? 0,
      state.published?.version ?? 0,
      ...state.publishes.map((p) => p.version),
    ),
    digest: state.published?.digest ?? state.publishes.at(-1)?.digest ?? state.continuation?.digest,
  };
}
function createSession(
  cfg: DeliveryContext,
  task: string,
  opts: BeginOptions,
  now: number,
  continuation?: CdReleaseState['continuation'],
): CdReleaseState {
  const name = opts.title || task.trim().replace(/\s+/g, ' ').slice(0, 52) || 'CD session';
  const state: CdReleaseState = syncPlanDeadline({
    stateVersion: 1,
    planMode: cfg.planMode ?? 'fixed',
    protocol: QWEN_LD_PROTOCOL,
    pluginVersion: QWEN_LD_PLUGIN_VERSION,
    harness: cfg.harness,
    id: makeSessionId(name),
    name,
    task,
    sessionKey: cfg.sessionKey,
    model: cfg.model,
    deliverEverySec: opts.deliverEverySec ?? cfg.deliverEverySec,
    timeBudgetSec: opts.timeBudgetSec ?? cfg.timeBudgetSec,
    startedTs: now,
    nextDeadlineTs: computeNextDeadline(now, opts.deliverEverySec ?? cfg.deliverEverySec),
    status: 'working',
    publishes: [],
    ...(continuation ? { continuation } : {}),
    lastActivityTs: now,
    activityCount: 0,
    milestones: opts.milestones ? normalizeMilestones(opts.milestones, now) : [],
    planRevision: opts.milestones?.length ? 1 : 0,
    messages: [message('user', task, now)],
    feedback: [],
    settingsRevision: 1,
  });
  writeState(cfg.workspaceDir, state);
  setActiveId(cfg.workspaceDir, state.sessionKey, state.id);
  return state;
}
// An explicit user request may resume delivery after Stop.
export function startTask(
  cfg: DeliveryContext,
  task: string,
  now = Date.now(),
  continuation?: CdReleaseState['continuation'],
): Result {
  return withLock(cfg.workspaceDir, () => {
    const previous = currentState(cfg);
    if (previous && ['working', 'delivered'].includes(previous.status))
      return { ok: false, error: 'A CD task is already running. Finish or stop it first.' };
    return { ok: true, state: createSession(cfg, task, {}, now, continuation) };
  });
}
export function publishVersion(
  cfg: DeliveryContext,
  input: PublishInput,
  now = Date.now(),
): Result {
  return withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) return { ok: false, error: 'No active CD session — call ld_begin first.' };
    if (state.status === 'paused' || state.status === 'done')
      return {
        ok: false,
        error: 'This CD task is stopped or finished. End your turn; it cannot be published again.',
      };
    let snapshot: ReturnType<typeof preparePublication> | undefined;
    try {
      const userRevised = state.planRevisions?.some(
        (revision) => revision.actor === 'user' || revision.feedbackIds?.length,
      );
      if (
        (input.plan_revision !== undefined && input.plan_revision !== planRevision(state)) ||
        (userRevised && input.plan_revision === undefined)
      )
        throw new Error(
          `The delivery plan changed. Read ld_status, implement the current milestone scope and acceptance criteria, then publish with plan_revision=${planRevision(state)}. An older plan cannot authorize this delivery.`,
        );
      if (input.milestone_id && !state.milestones?.some((m) => m.id === input.milestone_id))
        throw new Error('Unknown milestone_id; define it in ld_begin first.');
      if (
        state.planMode === 'rolling' &&
        input.milestone_id &&
        state.publishes.some((published) => published.artifact?.milestoneId === input.milestone_id)
      )
        throw new Error(
          'This milestone was already delivered. Use the next pending milestone for a new version.',
        );
      if (state.planMode === 'rolling') {
        if (input.plan_update?.length)
          throw new Error(
            'Use ld_begin with estimates and plan_revision to revise rolling delivery timing before publication.',
          );
        const milestone = state.milestones?.find((m) => m.id === input.milestone_id);
        if (!milestone) throw new Error('Rolling deliveries require a planned milestone_id.');
        if (
          milestone.acceptance.some(
            (label) => !input.checks?.some((c) => c.label === label && c.result === 'passed'),
          )
        )
          throw new Error(
            'Check each acceptance criterion before publication; include its exact label and a passed result. A deadline is not permission to publish an unusable candidate.',
          );
      }
      for (const id of input.feedback_ids ?? [])
        if (!state.feedback?.some((f) => f.id === id && f.status !== 'queued'))
          throw new Error(`Feedback has not been injected or does not exist: ${id}`);
      const planned = updatePlan(state, input.plan_update, now);
      snapshot = preparePublication(
        cfg.workspaceDir,
        state.id,
        nextArtifactVersion(state),
        input.paths,
        input.preview_entry,
      );
      if (snapshot.digest === (state.published?.digest ?? state.continuation?.digest))
        throw new Error(
          'no_changes: this content is identical to the latest published version. Improve the actual files before publishing again.',
        );
      const staged: CdArtifact = {
        version: nextArtifactVersion(state),
        paths: snapshot.paths,
        note: input.note,
        confidence: input.confidence,
        weakest: input.weakest,
        nextFocus: input.next_focus,
        ts: now,
        digest: snapshot.digest,
        previewEntry: snapshot.previewEntry,
        milestoneId: input.milestone_id,
        files: snapshot.files,
        excluded: snapshot.excluded,
        checks: [
          {
            label: 'Snapshot files and SHA-256 verified',
            result: 'passed',
            source: 'host',
            evidence: `${snapshot.files.length} files / ${snapshot.totalBytes} bytes`,
          },
          ...(input.checks ?? []).map((c) => ({ ...c, source: 'agent' as const })),
        ],
        feedbackIds: input.feedback_ids,
      };
      const next = syncPlanDeadline(applyPublish({ ...planned, staged }, 'agent', now, input.note));
      delete next.activity;
      next.lastActivityTs = now;
      next.activityCount = (state.activityCount ?? 0) + 1;
      next.messages = [
        ...(state.messages ?? []),
        ...(input.note ? [message('agent', input.note, now)] : []),
        message('event', `V${staged.version}`, now, { kind: 'published', version: staged.version }),
      ];
      next.feedback = state.feedback?.map((f) =>
        input.feedback_ids?.includes(f.id)
          ? { ...f, status: 'addressed', addressedVersion: staged.version }
          : f,
      );
      snapshot.commit();
      try {
        writeState(cfg.workspaceDir, next);
      } catch (error) {
        snapshot.rollback();
        throw error;
      }
      return { ok: true, state: next };
    } catch (error) {
      snapshot?.discard();
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        version_consumed: false,
      };
    }
  });
}
export function markDone(cfg: DeliveryContext, summary: string, now = Date.now()): Result {
  return withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) return { ok: false, error: 'No active CD session — call ld_begin first.' };
    if (state.status === 'paused')
      return { ok: false, error: 'This task is stopped. End your turn.' };
    if (state.status === 'done') return { ok: true, state };
    if (state.planMode === 'rolling' && !state.stopRequest && !isBudgetExhausted(state, now))
      return {
        ok: false,
        error: 'Rolling delivery is still active. ' + nextStep(state, now).message,
      };
    if (
      state.planNotice?.status === 'queued' &&
      !state.stopRequest &&
      !isBudgetExhausted(state, now)
    )
      return {
        ok: false,
        error:
          'A user budget change is queued. Receive it at the next tool boundary before finishing.',
      };
    if (
      !state.stopRequest &&
      !isBudgetExhausted(state, now) &&
      state.milestones?.some((m) => !state.publishes.some((p) => p.artifact?.milestoneId === m.id))
    )
      return {
        ok: false,
        error:
          'Planned milestones remain undelivered. Complete them and publish with their milestone_id before ld_done.',
      };
    if (
      state.feedback?.some((f) => f.status === 'queued') &&
      !state.stopRequest &&
      !isBudgetExhausted(state, now)
    )
      return {
        ok: false,
        error:
          'User feedback is queued. Receive it at the next tool boundary and address it before finishing.',
      };
    if (
      !state.stopRequest &&
      !isBudgetExhausted(state, now) &&
      !meetsWorkFloor(state, cfg.minWorkingSec, cfg.minReleases, now)
    )
      return {
        ok: false,
        error: `Not yet — minimum work not met (${workFloorSummary(state, cfg.minWorkingSec, cfg.minReleases, now)}). Make a concrete improvement and ld_publish it, then call ld_done.`,
      };
    // Completion records the summary; only ld_publish creates a version.
    const next: CdReleaseState = {
      ...state,
      status: 'done',
      finalSummary: summary,
      lastActivityTs: now,
      endedTs: now,
      messages: [...(state.messages ?? []), message('agent', summary, now)],
    };
    writeState(cfg.workspaceDir, next);
    return { ok: true, state: next };
  });
}
export function statusReport(cfg: DeliveryScope, now = Date.now()): string | null {
  const state = currentState(cfg);
  return state
    ? `${buildStatusLine(state, now)} · ${state.publishes.length} published version(s) · next publication V${nextArtifactVersion(state)}\n${nextStep(state, now).message}`
    : null;
}
export function runDeadlineTick(cfg: DeliveryScope, now = Date.now()): void {
  withLock(cfg.workspaceDir, () => {
    for (const state of ownedStates(cfg)) {
      if (!['working', 'delivered'].includes(state.status)) continue;
      if (state.approvalPendingSinceTs) continue;
      if (isBudgetExhausted(state, now)) {
        if (!state.stopRequest)
          writeState(cfg.workspaceDir, {
            ...state,
            stopRequest: { id: `budget-${state.id}`, requestedTs: now, reason: 'budget' },
          });
      } else if (state.milestones?.length) {
        const next = syncPlanDeadline(state);
        const newlyMissed = pendingMilestones(state)
          .map(milestoneTime)
          .filter((ts) => ts <= now && !(state.missedDeadlines ?? []).includes(ts));
        if (next.nextDeadlineTs !== state.nextDeadlineTs || newlyMissed.length)
          writeState(cfg.workspaceDir, {
            ...next,
            missedDeadlines: [...(state.missedDeadlines ?? []), ...newlyMissed].slice(-48),
          });
      } else if (now >= state.nextDeadlineTs) {
        writeState(cfg.workspaceDir, {
          ...state,
          nextDeadlineTs: computeNextDeadline(now, state.deliverEverySec),
          missedDeadlines: [...(state.missedDeadlines ?? []), now].slice(-20),
        });
      }
    }
  });
}

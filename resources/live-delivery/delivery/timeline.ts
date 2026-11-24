import { randomUUID } from 'node:crypto';
import { nextArtifactVersion, parseDurationSec } from './engine.js';
import type {
  CdMessage,
  CdMilestone,
  CdMilestoneInput,
  CdPlanUpdate,
  CdReleaseState,
} from './types.js';

export function durationSeconds(value: unknown): number {
  const seconds = parseDurationSec(value, -1);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 7 * 86400)
    throw new Error('Use a positive duration such as 30s, 15m or 3h, at most 7d.');
  return seconds;
}
export function normalizeMilestones(input: CdMilestoneInput[], startedTs: number): CdMilestone[] {
  const seen = new Set<string>();
  return input
    .map((item) => {
      if (seen.has(item.id)) throw new Error(`Duplicate milestone id: ${item.id}`);
      seen.add(item.id);
      return {
        id: item.id,
        title: item.title,
        scope: item.scope,
        acceptance: item.acceptance,
        targetTs: startedTs + durationSeconds(item.target_after) * 1000,
      };
    })
    .sort((a, b) => a.targetTs - b.targetTs);
}
export const planRevision = (state: CdReleaseState): number =>
  state.planRevision ?? (state.milestones?.length ? 1 : 0);
export const milestoneTime = (item: CdMilestone): number => item.estimatedTs ?? item.targetTs;
export function pendingMilestones(state: CdReleaseState): CdMilestone[] {
  return (state.milestones ?? [])
    .filter((m) => !state.publishes.some((p) => p.artifact?.milestoneId === m.id))
    .sort((a, b) => milestoneTime(a) - milestoneTime(b));
}
/** Planned labels follow actual publications, including the preceding round. */
export function numberedMilestones(state: CdReleaseState) {
  let next = nextArtifactVersion(state);
  return [...(state.milestones ?? [])]
    .sort((a, b) => milestoneTime(a) - milestoneTime(b))
    .map((m) => {
      const published = state.publishes.filter((p) => p.artifact?.milestoneId === m.id).at(-1);
      return { ...m, version: published?.version ?? next++ };
    });
}
/** Add only the next decision, after evaluating the previous usable delivery. */
export function appendNextMilestone(
  state: CdReleaseState,
  input: CdMilestoneInput,
  revision: number | undefined,
  now: number,
): CdReleaseState {
  if (state.planMode !== 'rolling')
    throw new Error('This task uses a fixed plan. Start a rolling task for incremental planning.');
  if (
    state.stopRequest ||
    !['working', 'delivered'].includes(state.status) ||
    state.approvalPendingSinceTs
  )
    throw new Error(
      'Next-version planning requires a running task after any required initial approval.',
    );
  if (revision !== planRevision(state))
    throw new Error('The plan changed. Read ld_status and use its latest planRevision.');
  if (!state.publishes.length || pendingMilestones(state).length)
    throw new Error(
      'Deliver the current planned version before planning another. User-added pending versions must be respected.',
    );
  const used = new Set([
    ...(state.milestones ?? []).map((m) => m.id),
    ...(state.planRevisions ?? []).flatMap((r) =>
      [...(r.previous ?? []), ...(r.added ?? [])].map((m) => m.id),
    ),
  ]);
  if (used.has(input.id))
    throw new Error('Use a new milestone ID; delivered and removed IDs cannot be reused.');
  const milestone = normalizeMilestones([input], state.startedTs)[0];
  if (
    milestone.targetTs <= now ||
    milestone.targetTs > state.startedTs + state.timeBudgetSec * 1000
  )
    throw new Error(
      'Set the next delivery in the future and within the remaining authorized budget.',
    );
  return syncPlanDeadline({
    ...state,
    milestones: [...(state.milestones ?? []), milestone],
    planRevision: revision + 1,
    planRevisions: [
      ...(state.planRevisions ?? []),
      { ts: now, revision: revision + 1, updates: [], added: [milestone], actor: 'agent' },
    ],
    messages: [
      ...(state.messages ?? []),
      message('event', milestone.title, now, {
        kind: 'next_planned',
        version: nextArtifactVersion(state),
      }),
    ],
  });
}
/** Once a plan exists, it is the single source of delivery deadlines. */
export function syncPlanDeadline(state: CdReleaseState): CdReleaseState {
  if (!state.milestones?.length) return state;
  return {
    ...state,
    nextDeadlineTs: pendingMilestones(state)[0]
      ? milestoneTime(pendingMilestones(state)[0])
      : state.startedTs + state.timeBudgetSec * 1000,
  };
}
export function updatePlan(
  state: CdReleaseState,
  updates: CdPlanUpdate[] | undefined,
  now: number,
): CdReleaseState {
  if (!updates?.length) return state;
  const milestones = structuredClone(state.milestones ?? []);
  for (const update of updates) {
    const item = milestones.find((m) => m.id === update.id);
    if (!item) throw new Error(`Unknown milestone_id: ${update.id}`);
    if (state.publishes.some((p) => p.artifact?.milestoneId === item.id))
      throw new Error(`Delivered milestone cannot be rewritten: ${item.id}`);
    const seconds = durationSeconds(update.estimated_after);
    if (seconds > state.timeBudgetSec)
      throw new Error(
        `Plan estimate exceeds the authorized total budget of ${state.timeBudgetSec}s. Choose a feasible time within it or ask the user to review scope and budget.`,
      );
    item.estimatedTs = state.startedTs + seconds * 1000;
    item.estimateReason = update.reason;
    item.estimateSource = 'agent';
    item.updatedTs = now;
    if (update.title) item.title = update.title;
    if (update.scope) item.scope = update.scope;
    if (update.acceptance) item.acceptance = update.acceptance;
  }
  const revision = planRevision(state) + 1;
  return syncPlanDeadline({
    ...state,
    milestones,
    planRevision: revision,
    planRevisions: [
      ...(state.planRevisions ?? []),
      { ts: now, updates, actor: 'agent', revision, previous: state.milestones },
    ],
  });
}
export function message(
  role: CdMessage['role'],
  text: string,
  ts: number,
  extra: Partial<CdMessage> = {},
): CdMessage {
  return { id: randomUUID(), role, text, ts, ...extra };
}

/**
 * Pure timing / digest / status logic for live delivery.
 *
 * Callers supply `now` (epoch ms) and file descriptors; this module performs
 * no filesystem I/O.
 */

import type { CdArtifact, CdReleaseState } from './types.js';

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d)?\s*$/i;

const UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  sec: 1,
  secs: 1,
  m: 60,
  min: 60,
  mins: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  d: 86400,
};

/**
 * Parse a human duration ("2m", "30m", "90s", "1h", "45") into seconds.
 * A bare number is treated as seconds. Returns `fallbackSec` on any bad input.
 */
export function parseDurationSec(value: unknown, fallbackSec: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') {
    return fallbackSec;
  }
  const match = DURATION_RE.exec(value);
  if (!match || match[1] === undefined) {
    return fallbackSec;
  }
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallbackSec;
  }
  const unit = (match[2] ?? 's').toLowerCase();
  const seconds = amount * (UNIT_SECONDS[unit] ?? 1);
  return seconds > 0 ? Math.round(seconds) : fallbackSec;
}

/** Next deadline is `deliverEverySec` after the given anchor. */
export function computeNextDeadline(anchorTs: number, deliverEverySec: number): number {
  return anchorTs + deliverEverySec * 1000;
}

/** Seconds until the next deadline (negative when overdue). */
export function secondsToDeadline(state: CdReleaseState, now: number): number {
  return Math.round((state.nextDeadlineTs - (state.approvalPendingSinceTs ?? now)) / 1000);
}

/** Seconds of working budget remaining (clamped at 0). */
export function budgetRemainingSec(state: CdReleaseState, now: number): number {
  const elapsed = ((state.approvalPendingSinceTs ?? now) - state.startedTs) / 1000;
  return Math.max(0, Math.round(state.timeBudgetSec - elapsed));
}

/** True once the working budget has been fully consumed. */
export function isBudgetExhausted(state: CdReleaseState, now: number): boolean {
  return budgetRemainingSec(state, now) <= 0;
}

/**
 * Optional completion floor: require both distinct versions and working time.
 * The caller's budget and stop checks take precedence over these minima.
 */
export function meetsWorkFloor(
  state: CdReleaseState,
  minWorkingSec: number,
  minReleases: number,
  now: number,
): boolean {
  const elapsedSec = (now - state.startedTs) / 1000;
  const enoughTime = elapsedSec >= Math.max(0, minWorkingSec || 0);
  const enoughReleases =
    new Set(state.publishes.map((p) => p.digest)).size >= Math.max(1, minReleases || 1);
  return enoughTime && enoughReleases;
}

/** Short human summary of floor progress, for status lines and nudges. */
export function workFloorSummary(
  state: CdReleaseState,
  minWorkingSec: number,
  minReleases: number,
  now: number,
): string {
  const elapsedSec = Math.max(0, Math.round((now - state.startedTs) / 1000));
  const parts: string[] = [];
  if ((minReleases || 1) > 1) {
    parts.push(
      `released ${new Set(state.publishes.map((p) => p.digest)).size}/${minReleases} distinct versions`,
    );
  }
  if ((minWorkingSec || 0) > 0) {
    parts.push(`worked ${humanizeDuration(elapsedSec)}/${humanizeDuration(minWorkingSec)}`);
  }
  return parts.join(' · ') || 'no minimum set';
}

/** Compute the next artifact version from the current state. */
export function nextArtifactVersion(state: CdReleaseState): number {
  const highest = Math.max(
    state.continuation?.version ?? 0,
    state.staged?.version ?? 0,
    state.published?.version ?? 0,
    ...state.publishes.map((p) => p.version),
    0,
  );
  return highest + 1;
}

/** Render seconds as a compact human string ("22m", "90s", "1h4m"). */
export function humanizeDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) {
    return `${sec}s`;
  }
  const minutes = Math.floor(sec / 60);
  if (minutes < 60) {
    const rem = sec % 60;
    return rem > 0 && minutes < 5 ? `${minutes}m${rem}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0 ? `${hours}h${remMin}m` : `${hours}h`;
}

/** Current execution timing. Milestone targets take precedence over the default interval. */
export function buildStatusLine(state: CdReleaseState, now: number): string {
  const parts: string[] = [];
  const pending = (state.milestones ?? [])
    .filter((m) => !state.publishes.some((p) => p.artifact?.milestoneId === m.id))
    .sort((a, b) => (a.estimatedTs ?? a.targetTs) - (b.estimatedTs ?? b.targetTs));
  if (['done', 'paused'].includes(state.status)) parts.push(`task ${state.status}`);
  else if (state.stopRequest || isBudgetExhausted(state, now)) parts.push('wrap-up requested');
  else if (state.approvalPendingSinceTs) parts.push('initial plan awaiting approval');
  else if (pending.length) {
    const target = pending[0].estimatedTs ?? pending[0].targetTs;
    const seconds = Math.ceil((target - now) / 1000);
    parts.push(
      `milestone ${JSON.stringify(pending[0].id)} target after ${humanizeDuration((target - state.startedTs) / 1000)}`,
    );
    parts.push(
      seconds <= 0
        ? `target overdue by ${humanizeDuration(-seconds)}; publish only if usable and checked, otherwise report the blocker and revise the estimate`
        : `estimated remaining ${humanizeDuration(seconds)}`,
    );
  } else if (state.planMode === 'rolling') parts.push('no pending milestone');
  else
    parts.push(
      `${humanizeDuration(Math.max(0, secondsToDeadline(state, now)))} to next delivery target`,
    );
  if (state.published) parts.push(`last published v${state.published.version}`);
  parts.push(`budget ${humanizeDuration(budgetRemainingSec(state, now))} left`);
  return parts.join(' · ');
}

/**
 * Promote the current staged artifact into `published`, append history, and
 * advance status. Returns a new state object (does not mutate the input).
 */
export function applyPublish(
  state: CdReleaseState,
  trigger: CdPublishTrigger,
  now: number,
  note?: string,
): CdReleaseState {
  if (!state.staged) {
    return state;
  }
  const published: CdArtifact = {
    ...state.staged,
    note: note ?? state.staged.note,
    ts: now,
  };
  const publishes = [
    ...state.publishes,
    {
      version: published.version,
      ts: now,
      digest: published.digest,
      note: published.note,
      trigger,
      artifact: published,
    },
  ];
  return {
    ...state,
    published,
    publishes,
    // Explicit completion wins; otherwise a user-stopped (paused) session stays
    // paused even if an in-flight turn publishes — so a stop can't be undone.
    status: trigger === 'done' ? 'done' : state.status === 'paused' ? 'paused' : 'delivered',
    nextDeadlineTs: computeNextDeadline(now, state.deliverEverySec),
  };
}

export type CdPublishTrigger = 'agent' | 'deadline' | 'done';

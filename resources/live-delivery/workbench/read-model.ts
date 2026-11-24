import type { CdConfig } from './config.js';
import type { CdArtifact, CdReleaseState } from '../delivery/types.js';
import { listVersionFiles } from '../delivery/state.js';
import { numberedMilestones, planRevision } from '../delivery/timeline.js';
import { nextArtifactVersion } from '../delivery/engine.js';
import { previewSignature } from './access.js';

export function rawUrl(cfg: CdConfig, id: string, version: number, file: string): string {
  const scope = cfg.accessToken
    ? `${cfg.basePath}/preview/${previewSignature(cfg.accessToken, cfg.basePath, encodeURIComponent(id), version)}`
    : `${cfg.basePath}/raw`;
  return `${scope}/${encodeURIComponent(id)}/${version}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
export function previewKind(file?: string): string {
  if (!file) return 'none';
  if (/\.html?$/i.test(file)) return 'html';
  if (/\.(md|markdown|txt|csv|json)$/i.test(file)) return 'text';
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file)) return 'image';
  if (/\.pdf$/i.test(file)) return 'pdf';
  return 'unsupported';
}
export function buildReadModel(
  cfg: CdConfig,
  state: CdReleaseState | null,
  csrfToken: string,
  now = Date.now(),
) {
  if (!state)
    return {
      apiVersion: 1,
      serverTime: now,
      task: null,
      csrfToken,
      capabilities: { feedback: false, settings: false, wrapUp: false, readOnly: !!cfg.readOnly },
    };
  const releases = state.publishes.map((record) => {
    const artifact: Partial<CdArtifact> =
      record.artifact ?? (state.published?.version === record.version ? state.published : {});
    const files =
      artifact.files ??
      listVersionFiles(cfg.workspaceDir, state.id, record.version).map((f) => ({
        path: f.relPath,
        bytes: f.size,
        sha256: '',
      }));
    const entry = artifact.previewEntry ?? (files.length === 1 ? files[0]?.path : undefined);
    return {
      version: record.version,
      title: state.milestones?.find((m) => m.id === artifact.milestoneId)?.title,
      ts: record.ts,
      note: artifact.note ?? record.note ?? '',
      milestoneId: artifact.milestoneId,
      files,
      digest: record.digest,
      previewEntry: entry,
      previewBase: rawUrl(cfg, state.id, record.version, ''),
      previewKind: previewKind(entry),
      previewUrl: entry
        ? rawUrl(cfg, state.id, record.version, entry) +
          (previewKind(entry) === 'text' ? '?view=1' : '')
        : null,
      downloadUrl: `${cfg.basePath}/zip/${encodeURIComponent(state.id)}/${record.version}`,
      checks: artifact.checks ?? [],
      excluded: artifact.excluded ?? [],
      feedbackIds: artifact.feedbackIds ?? [],
    };
  });
  const running = ['working', 'delivered'].includes(state.status);
  const controllable = !cfg.readOnly && running && !state.stopRequest;
  return {
    apiVersion: 1,
    serverTime: now,
    csrfToken,
    task: {
      id: state.id,
      title: state.name,
      versionBase: state.continuation?.version ?? 0,
      nextVersion: nextArtifactVersion(state),
      request: state.task,
      acceptingFeedback: !!state.feedbackHandoff,
      status: state.status,
      planMode: state.planMode ?? 'fixed',
      awaitingNextPlan:
        state.planMode === 'rolling' &&
        running &&
        !state.stopRequest &&
        !!state.publishes.length &&
        !(state.milestones ?? []).some(
          (m) => !state.publishes.some((p) => p.artifact?.milestoneId === m.id),
        ),
      startedTs: state.startedTs,
      endedTs: state.endedTs,
      elapsedSec: Math.max(
        0,
        Math.round(
          ((state.approvalPendingSinceTs ?? state.endedTs ?? now) - state.startedTs) / 1000,
        ),
      ),
      budgetRemainingSec: Math.max(
        0,
        Math.round(
          (state.startedTs +
            state.timeBudgetSec * 1000 -
            (state.approvalPendingSinceTs ?? state.endedTs ?? now)) /
            1000,
        ),
      ),
      awaitingPlanApproval: !!state.approvalPendingSinceTs && running && !state.stopRequest,
      revisingPlan:
        !!state.planReviewRequest &&
        !!state.approvalPendingSinceTs &&
        running &&
        !state.stopRequest,
      requirePlanApproval: !!state.requirePlanApproval,
      deliverEverySec: state.deliverEverySec,
      timeBudgetSec: state.timeBudgetSec,
      settingsRevision: state.settingsRevision ?? 1,
      nextDeadlineTs: state.nextDeadlineTs,
      stopRequest: state.stopRequest,
      pauseReason: state.pauseReason,
      finalSummary: state.finalSummary,
      missedDeadlines: state.missedDeadlines ?? [],
      hostLastSeenTs: state.hostLastSeenTs,
      hostEvent: state.hostEvent,
      activity:
        running && !state.stopRequest && !state.approvalPendingSinceTs
          ? (state.activity ?? null)
          : null,
    },
    plan: numberedMilestones(state),
    planRevisions: state.planRevisions ?? [],
    planReview: {
      revision: planRevision(state),
      rollingAutomatic: state.planMode === 'rolling' && !!state.publishes.length,
      autoExecuting: state.planMode === 'rolling' && !state.requirePlanApproval,
      confirmed:
        !!state.milestones?.length &&
        (state.planConfirmation?.revision === planRevision(state) ||
          (state.planMode === 'rolling' && !!state.planConfirmations?.length)),
      confirmation: state.planConfirmation ?? null,
      notice: state.planNotice ?? null,
      request: state.planReviewRequest ?? null,
    },
    releases,
    executionEvents: state.executionEvents ?? [],
    messages: state.messages ?? [
      { id: 'original-request', role: 'user', text: state.task, ts: state.startedTs },
    ],
    feedback: state.feedback ?? [],
    capabilities: {
      feedback: controllable,
      settings: controllable,
      plan: false,
      wrapUp: controllable,
      readOnly: !!cfg.readOnly,
    },
  };
}

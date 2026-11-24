/** Shared state, delivery, and control types. */

/** Confidence label the agent attaches to a staged candidate. */
export type CdConfidence = 'rough' | 'draft' | 'solid';

/** Lifecycle status of a CD session. */
export type CdStatus = 'working' | 'delivered' | 'done' | 'paused';

/** Status of a single outline/checklist item. */
export type CdOutlineItemStatus = 'todo' | 'doing' | 'done';

/** One item in the task outline/checklist that keep-working drives toward. */
export type CdOutlineItem = {
  /** Stable identifier for this checklist item. */
  id: string;
  /** Short human title, e.g. "market sizing". */
  title: string;
  /** Progress state. */
  status: CdOutlineItemStatus;
};

/** The task outline: an ordered checklist of items to complete. */
export type CdOutline = {
  items: CdOutlineItem[];
};

/** A recorded set of deliverable files (staged or published). */
export type CdArtifact = {
  /** Monotonic version number for this artifact. */
  version: number;
  /** Workspace-relative paths of the deliverable files/folders. */
  paths: string[];
  /** Short human note: what changed / what's next. */
  note?: string;
  /** Agent's self-assessed confidence. */
  confidence?: CdConfidence;
  /**
   * Optional lightweight quality signal: the part of the deliverable the agent
   * judges weakest and would improve next. Surfaced in the status line + HTTP
   * index so the next round can target it. No formal judge — self-assessed.
   */
  weakest?: string;
  /** Optional free-text hint on what to work on next. */
  nextFocus?: string;
  /** Epoch ms when this artifact was recorded. */
  ts: number;
  /** Content digest of the file set (drives anti-spam / skip logic). */
  digest: string;
  previewEntry?: string;
  milestoneId?: string;
  files?: Array<{ path: string; bytes: number; sha256: string }>;
  excluded?: string[];
  checks?: Array<{
    label: string;
    result: 'passed' | 'failed' | 'not_run';
    source: 'agent' | 'host';
    evidence?: string;
  }>;
  feedbackIds?: string[];
};

/** One entry in the publish history (for anti-spam + audit). */
export type CdPublishRecord = {
  version: number;
  ts: number;
  digest: string;
  note?: string;
  /** What caused the publish: the agent, the deadline timer, or task completion. */
  trigger: 'agent' | 'deadline' | 'done';
  artifact?: CdArtifact;
};

export type CdMilestoneInput = {
  id: string;
  title: string;
  scope: string;
  acceptance: string[];
  target_after: string;
};
export type CdMilestone = {
  id: string;
  title: string;
  scope: string;
  acceptance: string[];
  targetTs: number;
  estimatedTs?: number;
  estimateReason?: string;
  estimateSource?: 'user' | 'agent';
  updatedTs?: number;
};
export type CdPlanUpdate = {
  id: string;
  estimated_after: string;
  reason: string;
  title?: string;
  scope?: string;
  acceptance?: string[];
};
export type CdMessage = {
  approvalSource?: 'web' | 'cli' | 'chat';
  id: string;
  role: 'user' | 'agent' | 'event';
  text: string;
  ts: number;
  version?: number;
  kind?: string;
};
export type CdFeedback = {
  kind?: 'plan_approval' | 'plan_discussion';
  id: string;
  text: string;
  ts: number;
  version?: number;
  status: 'queued' | 'injected' | 'addressed';
  injectedTs?: number;
  hookEvent?: string;
  addressedVersion?: number;
};

/**
 * Persisted release state for a single CD session.
 * Serialized to `<workspaceDir>/.live-delivery/<id>/release.json`.
 */
export type CdReleaseState = {
  /** State schema version. */
  stateVersion: 1;
  harness?: string;
  lastActivityTs?: number;
  activityCount?: number;
  /** Brief public work update authored by the agent, not a completion claim. */
  activity?: { text: string; ts: number };
  executionEvents?: import('./events.js').ExecutionEvent[];
  milestones?: CdMilestone[];
  planMode?: 'fixed' | 'rolling';
  planRevision?: number;
  requirePlanApproval?: boolean;
  approvalPendingSinceTs?: number;
  approvalWaitMs?: number;
  planConfirmation?: { revision: number; confirmedTs: number; via?: 'web' | 'cli' | 'chat' };
  planConfirmations?: Array<{
    revision: number;
    confirmedTs: number;
    via?: 'web' | 'cli' | 'chat';
  }>;
  planReviewRequest?: { id: string; requestedTs: number; feedbackIds: string[] };
  planDiscussionSupported?: boolean;
  planNotice?: {
    revision: number;
    ts: number;
    status: 'queued' | 'injected';
    injectedTs?: number;
    hookEvent?: string;
  };
  planRevisions?: Array<{
    feedbackIds?: string[];
    ts: number;
    updates: CdPlanUpdate[];
    added?: CdMilestone[];
    removed?: CdMilestone[];
    actor?: 'user' | 'agent';
    revision?: number;
    previous?: CdMilestone[];
  }>;
  messages?: CdMessage[];
  feedback?: CdFeedback[];
  /** Owned browser execution is being interrupted and resumed in the same Codex thread. */
  feedbackHandoff?: {
    id: string;
    threadId: string;
    feedbackIds: string[];
    requestedTs: number;
    phase: 'interrupting' | 'resuming';
    previousStatus: 'working' | 'delivered';
  };
  stopRequest?: {
    id: string;
    requestedTs: number;
    reason: 'user' | 'budget';
    confirmedTs?: number;
  };
  endedTs?: number;
  finalSummary?: string;
  pauseReason?: 'user' | 'budget' | 'turn_ended' | 'interrupt' | 'session_end';
  settingsRevision?: number;
  settingsHistory?: Array<{
    ts: number;
    deliverEverySec: number;
    timeBudgetSec: number;
    actor: 'user';
  }>;
  hostLastSeenTs?: number;
  hostEvent?: string;
  /** Live Delivery tool protocol. */
  protocol: 'v1';
  /** Plugin package version that wrote this state. */
  pluginVersion?: string;
  /** Unique id of THIS CD session — its `.live-delivery/<id>/` directory name. */
  id: string;
  /** Auto-generated human-friendly name (derived from the task). */
  name: string;
  /** The user's deliverable request. */
  task: string;
  /** Model that started this session (captured from the tool context). */
  model?: string;
  /** Host session key that owns this delivery run. */
  sessionKey: string;
  /** Requested delivery interval, seconds, when no milestone plan is present. */
  deliverEverySec: number;
  /** Epoch ms when CD mode started. */
  startedTs: number;
  /** Epoch ms of the next mandatory delivery deadline. */
  nextDeadlineTs: number;
  /** Total working budget for the task, seconds. */
  timeBudgetSec: number;
  /** The agent's current best, not yet released. */
  staged?: CdArtifact;
  /** What the user has already received. */
  published?: CdArtifact;
  status: CdStatus;
  /** Optional checklist retained in stored task state. */
  outline?: CdOutline;
  /** Last published version inherited from a prior round; its snapshots stay in that session. */
  continuation?: { sessionId: string; version: number; digest?: string };
  /** Ordered publish history. */
  publishes: CdPublishRecord[];
  /**
   * Recent delivery targets missed without a new version, in epoch milliseconds.
   */
  missedDeadlines?: number[];
  /**
   * Last-known channel delivery route (captured from a tool's ambient
   * `deliveryContext`). Used by the optional channel delivery surface so the
   * out-of-turn tick knows where to send. Absent when only the HTTP surface is
   * in use.
   */
  channelRoute?: CdChannelRoute;
};

/** A minimal channel delivery route captured from `deliveryContext`. */
export type CdChannelRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

/** A staged/published file descriptor, used for digesting and listing. */
export type CdFileEntry = {
  /** Workspace-relative path. */
  relPath: string;
  /** File size in bytes (0 if missing). */
  size: number;
  /** Last-modified time, epoch ms (0 if missing). */
  mtimeMs: number;
  /** True when the path could not be found on disk. */
  missing: boolean;
  /**
   * Set when the agent's path was rewritten to reach the file (absolute
   * path, or a symlink/bind-mount alias, or a stripped leading prefix). The tool
   * echoes this so the model learns the canonical form instead of re-guessing.
   */
  rewrittenFrom?: string;
};

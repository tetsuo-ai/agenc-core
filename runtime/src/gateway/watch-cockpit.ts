import type { SessionShellProfile } from "./shell-profile.js";
import type { SessionWorkflowState } from "./workflow-state.js";

export const SESSION_REVIEW_SURFACE_STATE_METADATA_KEY =
  "reviewSurfaceState";
export const SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY =
  "verificationSurfaceState";

export type SessionResumabilityState =
  | "active"
  | "disconnected-resumable"
  | "missing-workspace"
  | "non-resumable";

export type CockpitSurfaceStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "stale";

export type CockpitSurfaceSource =
  | "local"
  | "delegated"
  | "background_run";

export type VerificationVerdict =
  | "pass"
  | "fail"
  | "mixed"
  | "unknown";

export interface ReviewSurfaceState {
  readonly status: CockpitSurfaceStatus;
  readonly source: CockpitSurfaceSource;
  readonly delegatedSessionId?: string;
  readonly backgroundRunId?: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly summaryPreview?: string;
}

export interface VerificationSurfaceState extends ReviewSurfaceState {
  readonly verdict?: VerificationVerdict;
}

export interface WorkflowOwnershipEntry {
  readonly role: string;
  readonly state: string;
  readonly roleSource?: string;
  readonly toolBundle?: string;
  readonly taskId?: string;
  readonly taskSubject?: string;
  readonly childSessionId?: string;
  readonly workerId?: string;
  readonly shellProfile?: SessionShellProfile;
  readonly executionLocation?: string;
  readonly workspaceRoot?: string;
  readonly workingDirectory?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly head?: string;
}

export interface WatchCockpitSnapshot {
  readonly session: {
    readonly sessionId: string;
    readonly shellProfile: SessionShellProfile;
    readonly workflowStage: SessionWorkflowState["stage"];
    readonly resumabilityState: SessionResumabilityState;
    readonly preview?: string;
    readonly objective?: string;
    readonly messageCount: number;
    readonly lastActiveAt: number;
  };
  readonly repo: {
    readonly available: boolean;
    readonly workspaceRoot?: string;
    readonly repoRoot?: string;
    readonly branch?: string;
    readonly head?: string;
    readonly dirtyCounts?: {
      readonly staged: number;
      readonly unstaged: number;
      readonly untracked: number;
      readonly conflicted: number;
    };
    readonly changedFiles?: readonly string[];
    readonly unavailableReason?: string;
    readonly cached?: boolean;
  };
  readonly worktrees: {
    readonly available: boolean;
    readonly entries: readonly {
      readonly path: string;
      readonly branch?: string;
      readonly head?: string;
      readonly clean?: boolean;
      readonly ownedByRuntime?: boolean;
      readonly ownerRole?: string;
      readonly ownerSessionId?: string;
      readonly ownerWorkerId?: string;
    }[];
    readonly unavailableReason?: string;
    readonly cached?: boolean;
  };
  readonly review: ReviewSurfaceState;
  readonly verification: VerificationSurfaceState;
  readonly approvals: {
    readonly count: number;
    readonly entries: readonly {
      readonly requestId: string;
      readonly toolName: string;
      readonly state: string;
      readonly deadlineAt?: number;
      readonly approverRoles?: readonly string[];
      readonly preview?: string;
    }[];
  };
  readonly ownership: readonly WorkflowOwnershipEntry[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePreview(value: unknown, maxChars = 240): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return undefined;
  }
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 3)}...`;
}

function coerceCockpitSurfaceStatus(value: unknown): CockpitSurfaceStatus | undefined {
  return value === "idle" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stale"
    ? value
    : undefined;
}

function coerceCockpitSurfaceSource(value: unknown): CockpitSurfaceSource | undefined {
  return value === "local" || value === "delegated" || value === "background_run"
    ? value
    : undefined;
}

function coerceVerificationVerdict(value: unknown): VerificationVerdict | undefined {
  return value === "pass" ||
    value === "fail" ||
    value === "mixed" ||
    value === "unknown"
    ? value
    : undefined;
}

export function createIdleReviewSurfaceState(
  now = Date.now(),
): ReviewSurfaceState {
  return {
    status: "idle",
    source: "local",
    startedAt: now,
    updatedAt: now,
  };
}

export function createIdleVerificationSurfaceState(
  now = Date.now(),
): VerificationSurfaceState {
  return {
    ...createIdleReviewSurfaceState(now),
    verdict: "unknown",
  };
}

export function coerceReviewSurfaceState(
  value: unknown,
): ReviewSurfaceState | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const status = coerceCockpitSurfaceStatus(record.status);
  const source = coerceCockpitSurfaceSource(record.source);
  const startedAt = asFiniteNumber(record.startedAt);
  const updatedAt = asFiniteNumber(record.updatedAt);
  if (!status || !source || startedAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const completedAt = asFiniteNumber(record.completedAt);
  const delegatedSessionId =
    typeof record.delegatedSessionId === "string" &&
    record.delegatedSessionId.trim().length > 0
      ? record.delegatedSessionId.trim()
      : undefined;
  const backgroundRunId =
    typeof record.backgroundRunId === "string" &&
    record.backgroundRunId.trim().length > 0
      ? record.backgroundRunId.trim()
      : undefined;
  return {
    status,
    source,
    startedAt,
    updatedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(delegatedSessionId ? { delegatedSessionId } : {}),
    ...(backgroundRunId ? { backgroundRunId } : {}),
    ...(normalizePreview(record.summaryPreview)
      ? { summaryPreview: normalizePreview(record.summaryPreview) }
      : {}),
  };
}

export function coerceVerificationSurfaceState(
  value: unknown,
): VerificationSurfaceState | undefined {
  const base = coerceReviewSurfaceState(value);
  if (!base) {
    return undefined;
  }
  const record = asRecord(value) ?? {};
  return {
    ...base,
    ...(coerceVerificationVerdict(record.verdict)
      ? { verdict: coerceVerificationVerdict(record.verdict) }
      : {}),
  };
}

export function reconcileReviewSurfaceState(
  value: ReviewSurfaceState | undefined,
): ReviewSurfaceState | undefined {
  if (!value) {
    return undefined;
  }
  if (value.status !== "running") {
    return value;
  }
  return {
    ...value,
    status: "stale",
    updatedAt: Date.now(),
    ...(value.completedAt === undefined ? { completedAt: Date.now() } : {}),
  };
}

export function reconcileVerificationSurfaceState(
  value: VerificationSurfaceState | undefined,
): VerificationSurfaceState | undefined {
  const reconciled = reconcileReviewSurfaceState(value);
  if (!reconciled) {
    return undefined;
  }
  return {
    ...reconciled,
    ...(value?.verdict ? { verdict: value.verdict } : {}),
  };
}

export function clearForkedReviewSurfaceState(
  value: ReviewSurfaceState | undefined,
): ReviewSurfaceState | undefined {
  if (!value) {
    return undefined;
  }
  return createIdleReviewSurfaceState(value.updatedAt || Date.now());
}

export function clearForkedVerificationSurfaceState(
  value: VerificationSurfaceState | undefined,
): VerificationSurfaceState | undefined {
  if (!value) {
    return undefined;
  }
  return createIdleVerificationSurfaceState(value.updatedAt || Date.now());
}

export function formatWorkflowOwnershipSummary(
  entries: readonly WorkflowOwnershipEntry[],
): string {
  const childCount = entries.filter((entry) => entry.role !== "worker").length;
  const workerCount = entries.filter(
    (entry) => entry.role === "worker" || entry.role === "verifier-worker",
  ).length;
  const worktreeCount = entries.filter((entry) => typeof entry.worktreePath === "string").length;
  return [childCount > 0 ? `${childCount} child${childCount === 1 ? "" : "ren"}` : null,
    workerCount > 0 ? `${workerCount} worker${workerCount === 1 ? "" : "s"}` : null,
    worktreeCount > 0 ? `${worktreeCount} worktree${worktreeCount === 1 ? "" : "s"}` : null]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

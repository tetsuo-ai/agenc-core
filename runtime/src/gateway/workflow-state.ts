export const SESSION_WORKFLOW_STATE_METADATA_KEY = "workflowState";

export type SessionWorkflowStage =
  | "idle"
  | "plan"
  | "implement"
  | "review"
  | "verify";

export type SessionWorktreeMode = "off" | "child_optional";

const SESSION_WORKFLOW_STAGES = [
  "idle",
  "plan",
  "implement",
  "review",
  "verify",
] as const satisfies readonly SessionWorkflowStage[];

const SESSION_WORKTREE_MODES = [
  "off",
  "child_optional",
] as const satisfies readonly SessionWorktreeMode[];

const SESSION_WORKFLOW_STAGE_SET = new Set<SessionWorkflowStage>(
  SESSION_WORKFLOW_STAGES,
);
const SESSION_WORKTREE_MODE_SET = new Set<SessionWorktreeMode>(
  SESSION_WORKTREE_MODES,
);

export interface SessionWorkflowState {
  readonly stage: SessionWorkflowStage;
  readonly worktreeMode: SessionWorktreeMode;
  readonly objective?: string;
  readonly enteredAt: number;
  readonly updatedAt: number;
}

export interface SessionWorkflowUpdate {
  readonly stage?: SessionWorkflowStage;
  readonly worktreeMode?: SessionWorktreeMode;
  readonly objective?: string | null;
}

export const DEFAULT_SESSION_WORKFLOW_STATE: SessionWorkflowState = Object.freeze(
  {
    stage: "idle",
    worktreeMode: "off",
    enteredAt: 0,
    updatedAt: 0,
  },
);

function coerceTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function isSessionWorkflowStage(
  value: unknown,
): value is SessionWorkflowStage {
  return (
    typeof value === "string" &&
    SESSION_WORKFLOW_STAGE_SET.has(value as SessionWorkflowStage)
  );
}

export function coerceSessionWorkflowStage(
  value: unknown,
): SessionWorkflowStage | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isSessionWorkflowStage(normalized) ? normalized : undefined;
}

export function isSessionWorktreeMode(
  value: unknown,
): value is SessionWorktreeMode {
  return (
    typeof value === "string" &&
    SESSION_WORKTREE_MODE_SET.has(value as SessionWorktreeMode)
  );
}

export function coerceSessionWorktreeMode(
  value: unknown,
): SessionWorktreeMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isSessionWorktreeMode(normalized) ? normalized : undefined;
}

export function coerceSessionWorkflowState(
  value: unknown,
): SessionWorkflowState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const stage = coerceSessionWorkflowStage(record.stage);
  const worktreeMode = coerceSessionWorktreeMode(record.worktreeMode);
  const enteredAt = coerceTimestamp(record.enteredAt);
  const updatedAt = coerceTimestamp(record.updatedAt);
  const objective =
    typeof record.objective === "string" && record.objective.trim().length > 0
      ? record.objective.trim()
      : undefined;
  if (!stage || !worktreeMode || enteredAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return {
    stage,
    worktreeMode,
    ...(objective ? { objective } : {}),
    enteredAt,
    updatedAt,
  };
}

export function resolveSessionWorkflowState(
  metadata: Record<string, unknown>,
): SessionWorkflowState {
  return (
    coerceSessionWorkflowState(metadata[SESSION_WORKFLOW_STATE_METADATA_KEY]) ??
    DEFAULT_SESSION_WORKFLOW_STATE
  );
}

export function updateSessionWorkflowState(
  metadata: Record<string, unknown>,
  update: SessionWorkflowUpdate,
  now = Date.now(),
): SessionWorkflowState {
  const current = resolveSessionWorkflowState(metadata);
  const nextStage = update.stage ?? current.stage;
  const nextWorktreeMode = update.worktreeMode ?? current.worktreeMode;
  const rawObjective = update.objective;
  const nextObjective =
    rawObjective === undefined
      ? current.objective
      : typeof rawObjective === "string" && rawObjective.trim().length > 0
        ? rawObjective.trim()
        : undefined;
  const stageChanged = nextStage !== current.stage;
  const nextState: SessionWorkflowState = {
    stage: nextStage,
    worktreeMode: nextWorktreeMode,
    ...(nextObjective ? { objective: nextObjective } : {}),
    enteredAt:
      current.enteredAt > 0
        ? stageChanged
          ? now
          : current.enteredAt
        : now,
    updatedAt: now,
  };
  metadata[SESSION_WORKFLOW_STATE_METADATA_KEY] = nextState;
  return nextState;
}

export function ensureSessionWorkflowState(
  metadata: Record<string, unknown>,
  preferred?: SessionWorkflowUpdate,
  now = Date.now(),
): SessionWorkflowState {
  const existing = coerceSessionWorkflowState(
    metadata[SESSION_WORKFLOW_STATE_METADATA_KEY],
  );
  if (!existing) {
    return updateSessionWorkflowState(
      metadata,
      {
        stage: preferred?.stage ?? DEFAULT_SESSION_WORKFLOW_STATE.stage,
        worktreeMode:
          preferred?.worktreeMode ?? DEFAULT_SESSION_WORKFLOW_STATE.worktreeMode,
        ...(preferred?.objective !== undefined
          ? { objective: preferred.objective }
          : {}),
      },
      now,
    );
  }
  if (!preferred) {
    metadata[SESSION_WORKFLOW_STATE_METADATA_KEY] = existing;
    return existing;
  }
  return updateSessionWorkflowState(metadata, preferred, now);
}

export function formatSessionWorkflowStage(
  stage: SessionWorkflowStage,
): string {
  return stage.replace(/_/g, " ");
}

export function formatSessionWorktreeMode(
  worktreeMode: SessionWorktreeMode,
): string {
  return worktreeMode.replace(/_/g, " ");
}


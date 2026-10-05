import { WorkspaceMutationError } from "./mutation-error.js";

export class WorkspaceFileMutationPreEffectConflictError extends WorkspaceMutationError {
  constructor(path: string) {
    super(
      "PRE_EFFECT_CONFLICT",
      `Workspace target appeared before the exclusive write to ${path}; no filesystem mutation was authorized.`,
    );
    this.name = "WorkspaceFileMutationPreEffectConflictError";
  }
}


export type WorkspaceMutationNoEffectEvidence =
  | "pre_effect"
  | "original_state_verified"
  | "rollback_verified";

const WORKSPACE_MUTATION_NO_EFFECT = Symbol("agenc.workspaceMutationNoEffect");

export function markWorkspaceMutationNoEffect<T>(
  error: T,
  evidence: WorkspaceMutationNoEffectEvidence,
): T {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, WORKSPACE_MUTATION_NO_EFFECT, {
      value: evidence,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

export function workspaceMutationNoEffectEvidence(
  error: unknown,
): WorkspaceMutationNoEffectEvidence | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<symbol, unknown>)[WORKSPACE_MUTATION_NO_EFFECT];
  return value === "pre_effect" ||
    value === "original_state_verified" ||
    value === "rollback_verified"
    ? value
    : undefined;
}

/** Model-facing sentence for a settled no-effect failure. */
export function describeWorkspaceMutationNoEffect(
  evidence: WorkspaceMutationNoEffectEvidence,
): string {
  return evidence === "rollback_verified"
    ? "The file was restored to its original contents; the mutation had no lasting effect."
    : "No bytes were written; the file is unchanged.";
}


export class WorkspaceBoundReadFileTooLargeError extends Error {
  readonly size: number;

  constructor(path: string, size: number) {
    super(`Bound read exceeds its byte limit for ${path}`);
    this.name = "WorkspaceBoundReadFileTooLargeError";
    this.size = size;
  }
}

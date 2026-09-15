/** Shared mutation errors; importing them grants no workspace or spawn authority. */
export class WorkspaceMutationCoordinatorError extends Error {
  constructor(
    readonly code:
      | "INVALID_WORKSPACE"
      | "INVALID_EDITOR_SYNC"
      | "EDITOR_LEASE_CONFLICT"
      | "EDITOR_LEASE_EXPIRED"
      | "EDITOR_LEASE_MISMATCH"
      | "MUTATION_AUDIT_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceMutationCoordinatorError";
  }
}

export class WorkspacePathIdentityChangedError extends WorkspaceMutationCoordinatorError {
  constructor(path: string) {
    super(
      "EDITOR_LEASE_MISMATCH",
      `Workspace path identity changed or its content no longer matches before the write to ${path}; no filesystem mutation was authorized.`,
    );
    this.name = "WorkspacePathIdentityChangedError";
  }
}

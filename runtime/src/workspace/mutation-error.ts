/**
 * A file mutation the transaction boundary refused or could not audit.
 *
 * - `PATH_IDENTITY_CHANGED` / `PRE_EFFECT_CONFLICT`: refused before any
 *   byte was written; the target is untouched.
 * - `MUTATION_AUDIT_FAILED`: a syscall started and the disk outcome could
 *   not be verified, so callers treat the target as unknown and re-read it
 *   before mutating again.
 */
export class WorkspaceMutationError extends Error {
  readonly code:
    | "MUTATION_AUDIT_FAILED"
    | "PATH_IDENTITY_CHANGED"
    | "PRE_EFFECT_CONFLICT";

  constructor(code: WorkspaceMutationError["code"], message: string) {
    super(message);
    this.name = "WorkspaceMutationError";
    this.code = code;
  }
}

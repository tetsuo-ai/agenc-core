/**
 * DAE-02: workspace cwd is a first-class identity for agent/session create.
 *
 * The daemon must never invent a project directory from its own process.cwd().
 * Clients (CLI, SDK, gateway) own workspace selection and must send an absolute
 * path on create. Relative paths are rejected so daemon-side resolution cannot
 * silently re-root against the wrong OS cwd.
 */

import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

export class WorkspaceCwdError extends Error {
  readonly code = "INVALID_ARGUMENT" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCwdError";
  }
}

/**
 * Validate and normalize a workspace cwd for daemon agent/session create.
 * Returns a normalized absolute path.
 */
export function requireAbsoluteWorkspaceCwd(
  cwd: unknown,
  context: string,
): string {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new WorkspaceCwdError(
      `${context} requires absolute cwd (workspace directory); the daemon will not invent one`,
    );
  }
  const trimmed = cwd.trim();
  if (!isAbsolute(trimmed)) {
    throw new WorkspaceCwdError(
      `${context} cwd must be an absolute path (got ${JSON.stringify(trimmed)})`,
    );
  }
  // Normalize `.` / `..` segments without changing the root.
  const normalized = resolve(trimmed);
  try {
    if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
      throw new WorkspaceCwdError(
        `${context} cwd is not an existing directory: ${normalized}`,
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceCwdError) throw error;
    throw new WorkspaceCwdError(
      `${context} cwd is not accessible: ${normalized}`,
    );
  }
  return normalized;
}

/**
 * Client-side helper: turn optional cwd into an absolute workspace path
 * relative to the *client* process. Never used inside the daemon create path.
 */
export function resolveClientWorkspaceCwd(
  cwd: string | undefined,
  clientCwd: string = process.cwd(),
): string {
  const base = isAbsolute(clientCwd) ? resolve(clientCwd) : resolve(clientCwd);
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    const trimmed = cwd.trim();
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed);
  }
  return base;
}

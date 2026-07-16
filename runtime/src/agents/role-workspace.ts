import { isAbsolute, resolve } from "node:path";

declare const agentRoleWorkspaceBrand: unique symbol;

/**
 * Immutable trust-domain identity used for agent-role lookup.
 *
 * This is intentionally distinct from a session's execution cwd, which may
 * move into and out of a Git worktree while the session is running.
 */
export interface AgentRoleWorkspace {
  readonly id: string;
  readonly cwd: string;
  readonly [agentRoleWorkspaceBrand]: true;
}

export class AgentRoleWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRoleWorkspaceError";
  }
}

export class AgentRoleWorkspaceMismatchError extends Error {
  constructor(
    public readonly expectedWorkspaceId: string,
    public readonly actualWorkspaceId: string | undefined,
  ) {
    super(
      actualWorkspaceId === undefined
        ? `agent role workspace provenance is missing; expected ${expectedWorkspaceId}`
        : `agent role workspace mismatch: expected ${expectedWorkspaceId}, received ${actualWorkspaceId}`,
    );
    this.name = "AgentRoleWorkspaceMismatchError";
  }
}

export function createAgentRoleWorkspace(cwd: string): AgentRoleWorkspace {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new AgentRoleWorkspaceError(
      "agent role workspace requires a non-empty absolute cwd",
    );
  }
  if (!isAbsolute(cwd)) {
    throw new AgentRoleWorkspaceError(
      `agent role workspace cwd must be absolute: ${cwd}`,
    );
  }
  const canonical = resolve(cwd);
  return Object.freeze({
    id: canonical,
    cwd: canonical,
  }) as AgentRoleWorkspace;
}

export function normalizeAgentRoleWorkspace(
  workspace: Pick<AgentRoleWorkspace, "id" | "cwd">,
): AgentRoleWorkspace {
  const normalized = createAgentRoleWorkspace(workspace.cwd);
  if (workspace.id !== normalized.id) {
    throw new AgentRoleWorkspaceMismatchError(normalized.id, workspace.id);
  }
  return normalized;
}

export function assertAgentRoleWorkspaceMatches(
  expected: AgentRoleWorkspace,
  actualWorkspaceId: string | undefined,
): void {
  if (actualWorkspaceId !== expected.id) {
    throw new AgentRoleWorkspaceMismatchError(
      expected.id,
      actualWorkspaceId,
    );
  }
}

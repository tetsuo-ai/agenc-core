import { isAbsolute, resolve } from "node:path";
import { readExecutionEnvironmentBinding } from "../execution/binding.js";
import { executionEnvironmentCacheKey, type ExecutionEnvironmentBinding } from "../execution/types.js";

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
  readonly executionBinding?: ExecutionEnvironmentBinding;
  readonly [agentRoleWorkspaceBrand]: true;
}

/** Serializable identity only; this never grants access to an execution backend. */
export type AgentRoleWorkspaceMetadata = {
  readonly agentRoleWorkspaceId: string;
  readonly agentRoleWorkspaceCwd: string;
  readonly agentRoleWorkspaceExecutionBinding?: ExecutionEnvironmentBinding;
};

export function agentRoleWorkspaceMetadata(workspace: AgentRoleWorkspace): AgentRoleWorkspaceMetadata {
  const normalized = normalizeAgentRoleWorkspace(workspace);
  return {
    agentRoleWorkspaceId: normalized.id,
    agentRoleWorkspaceCwd: normalized.cwd,
    ...(normalized.executionBinding !== undefined
      ? { agentRoleWorkspaceExecutionBinding: normalized.executionBinding }
      : {}),
  };
}

/** Missing provenance is legacy-local; malformed present provenance never falls back. */
export function agentRoleWorkspaceFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): AgentRoleWorkspace | undefined {
  if (metadata === undefined) return undefined;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(metadata, key);
  const hasId = has("agentRoleWorkspaceId");
  const hasCwd = has("agentRoleWorkspaceCwd");
  const hasBinding = has("agentRoleWorkspaceExecutionBinding");
  if (!hasId && !hasCwd && !hasBinding) return undefined;
  const id = metadata.agentRoleWorkspaceId;
  if (typeof id !== "string" || id.length === 0) {
    throw new AgentRoleWorkspaceError("agentRoleWorkspaceId must be a non-empty identity");
  }
  const binding = hasBinding
    ? readExecutionEnvironmentBinding(metadata.agentRoleWorkspaceExecutionBinding)
    : undefined;
  // Container IDs encode identity, not a path. They always need an explicit cwd.
  const cwd = hasCwd ? metadata.agentRoleWorkspaceCwd : binding?.kind === "docker" ? undefined : id;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new AgentRoleWorkspaceError("agentRoleWorkspaceCwd must be a non-empty absolute path");
  }
  return normalizeAgentRoleWorkspace({ id, cwd, executionBinding: binding });
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

export function createAgentRoleWorkspace(cwd: string, executionBinding?: ExecutionEnvironmentBinding): AgentRoleWorkspace {
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
  const binding = executionBinding === undefined ? undefined : readExecutionEnvironmentBinding(executionBinding);
  return Object.freeze({
    id: binding?.kind === "docker" ? executionEnvironmentCacheKey(binding, canonical) : canonical,
    cwd: canonical,
    ...(binding?.kind === "docker" ? { executionBinding: binding } : {}),
  }) as AgentRoleWorkspace;
}

export function normalizeAgentRoleWorkspace(
  workspace: Pick<AgentRoleWorkspace, "id" | "cwd" | "executionBinding">,
): AgentRoleWorkspace {
  const normalized = createAgentRoleWorkspace(workspace.cwd, workspace.executionBinding);
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

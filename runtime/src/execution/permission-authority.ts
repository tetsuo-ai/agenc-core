import { posix } from "node:path";
import { assertSameExecutionEnvironment } from "./binding.js";
import type { ExecutionPermissionPath } from "./permission-path.js";
import { ExecutionEnvironmentError } from "./types.js";
import type { ExecutionWorkspace } from "./workspace.js";
import { peekAmbientRuntimeSession } from "../session/current-session.js";
import { getAgentMemoryDir, isAnyAgentMemoryPath, taskAgentMemoryEnvironment } from "../tools/AgentTool/agentMemory.js";
import { getAgentMemoryAuthorization } from "../utils/agentContext.js";
import { getCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";

export function taskPathWithin(path: string, root: string): boolean {
  const relative = posix.relative(root, path);
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative));
}

/** Shared ownership evidence; each permission surface retains its rule policy. */
export function captureExecutionPermissionAuthority(workspace: ExecutionWorkspace) {
  const authority = getCanonicalSettingsAuthority();
  const role = peekAmbientRuntimeSession()?.roleWorkspace;
  if (role) {
    if (!role.executionBinding) throw new ExecutionEnvironmentError("execution_environment_changed", "Task permissions require the owning role workspace binding", false);
    assertSameExecutionEnvironment(role.executionBinding, workspace.environment.binding);
  }
  const roleCwd = role?.cwd ?? workspace.projectRoot;
  const authorization = getAgentMemoryAuthorization();
  const directory = authorization && taskAgentMemoryEnvironment(authorization.scope, workspace.environment)
    ? posix.resolve(getAgentMemoryDir(authorization.agentType, authorization.scope, roleCwd)) : undefined;
  return Object.freeze({
    roleCwd,
    memoryAccess(evidence: ExecutionPermissionPath): "unscoped" | "allow" | "deny" {
      if (!evidence.paths.some(path => isAnyAgentMemoryPath(path, roleCwd))) return "unscoped";
      const identity = evidence.description?.identity;
      return directory && evidence.paths.every(path => taskPathWithin(path, directory)) &&
        !evidence.leafSymlink && !evidence.symlinkPaths.includes(directory) &&
        (!identity || ((BigInt(identity.mode) & 0o170000n) === 0o100000n && identity.nlink === "1")) ? "allow" : "deny";
    },
    assertCurrent(): void {
      if (authority?.executionWorkspace !== workspace || peekAmbientRuntimeSession()?.roleWorkspace !== role) {
        throw new ExecutionEnvironmentError("execution_environment_changed", "Task permission authority changed during evaluation", false);
      }
    },
  });
}

import type { PermissionDenyDecision } from "../../permissions/types.js";

const AGENT_NAMESPACE_ROOT = "/root";

export function isAgentNamespacePath(path: string): boolean {
  return path === AGENT_NAMESPACE_ROOT || path.startsWith(`${AGENT_NAMESPACE_ROOT}/`);
}

export function workspacePathFromAgentNamespace(path: string): string | null {
  if (!isAgentNamespacePath(path)) return null;
  const relativePath = path.slice(AGENT_NAMESPACE_ROOT.length).replace(/^\/+/, "");
  return relativePath.length > 0 ? relativePath : null;
}

export function agentNamespacePathHint(path: string, cwd?: string): string {
  const relativePath = workspacePathFromAgentNamespace(path);
  const target =
    relativePath !== null
      ? ` Use "${relativePath}" for a workspace-relative filesystem path`
      : " Use a workspace-relative filesystem path";
  const cwdHint = cwd && cwd.length > 0 ? ` under ${cwd}.` : ".";
  return "`/root` is the AgenC agent namespace, not a filesystem path." + target + cwdHint;
}

export function formatToolPathForDisplay(path: string): string {
  return isAgentNamespacePath(path)
    ? `${path} (agent namespace, not a file path)`
    : path;
}

export function denyAgentNamespacePath(
  path: string,
  cwd?: string,
): PermissionDenyDecision {
  return {
    behavior: "deny",
    message: agentNamespacePathHint(path, cwd),
    decisionReason: {
      type: "safetyCheck",
      reason: "agent_namespace_path",
      classifierApprovable: false,
    },
  };
}

import { afterEach, expect, test, vi } from "vitest";
import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";
import { deferredShellWorkspaceMutationPermission, shellWorkspaceMutationPermission } from "../../src/tools/system/shell-mutation-permission.js";

afterEach(() => vi.unstubAllEnvs());

test.each([
  "echo hello", "cat /tmp/input.txt", "for x in one two; do printf '%s\\n' \"$x\"; done",
])("does not resolve protected roots for a command without mutation targets: %s", command => {
  const resolveProtectedRoots = vi.fn(() => ["/srv/agenc-home"]);
  const input = { toolName: "exec_command", args: { command }, workspaceRoot: "/tmp/workspace",
    allowWorkspaceDeletions: true, bypassesApprovalsAndSandbox: true };
  const eager = classifyShellWorkspaceWritePolicy({ ...input, protectedRoots: resolveProtectedRoots() });
  resolveProtectedRoots.mockClear();
  expect(classifyShellWorkspaceWritePolicy({ ...input, resolveProtectedRoots })).toEqual(eager);
  expect(resolveProtectedRoots).not.toHaveBeenCalled();
});

test.each([
  "echo x > /srv/agenc-home/config", "rm -rf /srv/agenc-home", "rm /srv/agenc-home/*",
  "mv /srv/agenc-home/config /tmp/config", "echo x > /srv/agenc-home/\"$FILE\"",
  "rm /tmp/workspace/disposable.txt", "echo x > /tmp/workspace/output.txt", "echo x > \"$FILE\"",
])("retains the exact policy decision and current roots for mutation: %s", command => {
  vi.stubEnv("AGENC_HOME", "/srv/agenc-home");
  const input = { toolName: "exec_command", args: { command }, workspaceRoot: "/tmp/workspace" };
  const eager = classifyShellWorkspaceWritePolicy({ ...input, ...shellWorkspaceMutationPermission({}) });
  const deferred = deferredShellWorkspaceMutationPermission({});
  const resolveProtectedRoots = vi.fn(deferred.resolveProtectedRoots);
  expect(classifyShellWorkspaceWritePolicy({ ...input, ...deferred, resolveProtectedRoots })).toEqual(eager);
  if (eager.observedTargets.length > 0) expect(resolveProtectedRoots).toHaveBeenCalledOnce();
});

test("deferred authority uses the current ambient home, without a stale negative cache", () => {
  vi.stubEnv("AGENC_HOME", "/srv/old-home");
  const permission = deferredShellWorkspaceMutationPermission({});
  vi.stubEnv("AGENC_HOME", "/srv/new-home");
  const verdict = classifyShellWorkspaceWritePolicy({ toolName: "exec_command",
    args: { command: "rm -rf /srv/new-home" }, workspaceRoot: "/tmp/workspace", ...permission,
    allowWorkspaceDeletions: true, bypassesApprovalsAndSandbox: true });
  expect(verdict.blocked).toBe(true);
  expect(verdict.blockedDeletions).toContain("/srv/new-home");
});

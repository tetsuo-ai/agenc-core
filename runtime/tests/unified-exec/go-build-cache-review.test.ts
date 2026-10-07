// Reviewer regressions (rv Round 24): an additional filesystem grant that makes the configured
// GOCACHE writable must keep it, under read-only and workspace-write; unsandboxed commands keep theirs.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { canWritePathWithCwd, type SandboxTransformRequest } from "../sandbox/engine/index.js";
import { effectivePermissionProfile } from "../sandbox/engine/policy-transforms.js";
import { permissionProfileForSandboxMode } from "../tools/runtimes/sandboxing.js";
import { UnifiedExecProcessManager } from "./process-manager.js";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "rv-go-cache-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

for (const mode of ["read_only", "workspace_write"] as const) {
  test(`${mode} preserves the configured cache when an additional grant makes it writable`, async () => {
    const workspace = join(root, "workspace");
    const sessionTempRoot = join(root, "session-temp");
    const cache = join(root, "approved-cache");
    const requests: SandboxTransformRequest[] = [];
    const manager = new UnifiedExecProcessManager({
      cwd: root,
      sessionTempRoot,
      env: { HOME: root, GOCACHE: cache },
      sandboxManager: {
        selectInitial: () => "linux_seccomp",
        transform: (request: SandboxTransformRequest) => {
          requests.push(request);
          const permissions = effectivePermissionProfile(request.permissions, request.command.additionalPermissions);
          return {
            command: [process.execPath, "-e", "process.stdout.write(process.env.GOCACHE ?? '')"],
            cwd: request.command.cwd,
            env: request.command.env,
            sandbox: request.sandbox,
            windowsSandboxLevel: request.windowsSandboxLevel,
            windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
            permissionProfile: permissions,
            fileSystemSandboxPolicy: permissions.fileSystem,
            networkSandboxPolicy: permissions.network,
            arg0: "rv-go-cache",
          };
        },
      },
    } as never);
    try {
      const result = await manager.execCommand({
        cmd: "go env GOCACHE", workdir: root, yield_time_ms: 2000,
        runtimeSandbox: {
          permissionProfile: permissionProfileForSandboxMode(mode, { cwd: workspace }),
          additionalPermissions: { fileSystem: { entries: [{ path: { kind: "path", path: cache }, access: "write" }] } },
          sandboxPolicyCwd: workspace, sessionTempRoot, preference: "require",
        },
      } as never);
      expect(result.exitCode).toBe(0);
      const request = requests[0]!;
      const effective = effectivePermissionProfile(request.permissions, request.command.additionalPermissions);
      expect(canWritePathWithCwd(effective.fileSystem, cache, workspace, sessionTempRoot)).toBe(true);
      expect(request.command.env.GOCACHE).toBe(cache);
      expect(result.stdout).toBe(cache);
      expect(canWritePathWithCwd(effective.fileSystem, request.command.env.GOCACHE!, workspace, sessionTempRoot)).toBe(true);
    } finally { await manager.closeAll("rv cleanup"); }
  });
}

test("an unsandboxed command preserves its configured cache", async () => {
  const cache = join(root, "explicit-cache");
  const manager = new UnifiedExecProcessManager({ cwd: root, env: { GOCACHE: cache } });
  try {
    const result = await manager.execCommand({ cmd: "printf '%s' \"$GOCACHE\"", yield_time_ms: 2000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(cache);
  } finally { await manager.closeAll("rv cleanup"); }
});

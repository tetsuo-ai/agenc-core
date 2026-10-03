import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  permissionProfileFromRuntimePermissions,
  unrestrictedFileSystemPolicy,
  type SandboxExecRequest,
  type SandboxTransformRequest,
} from "../sandbox/engine/index.js";
import { permissionProfileForSandboxMode } from "../tools/runtimes/sandboxing.js";
import { withWritableGoBuildCache } from "./go-build-cache.js";
import { UnifiedExecProcessManager } from "./process-manager.js";

let workspace: string;
let temp: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "agenc-go-cache-ws-")));
  temp = await realpath(await mkdtemp(join(tmpdir(), "agenc-go-cache-tmp-")));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(temp, { recursive: true, force: true });
});

// The profile a workspace-write session's commands run under.
const workspaceWrite = () => permissionProfileForSandboxMode("workspace_write", { cwd: workspace });
const unrestricted = () => permissionProfileFromRuntimePermissions(unrestrictedFileSystemPolicy(), "enabled");

describe("withWritableGoBuildCache", () => {
  test("a cache outside the sandbox's writable paths moves to the session temp root", () => {
    for (const env of [
      { HOME: "/home/someone", PATH: "/usr/bin" },
      { HOME: "/home/someone", GOCACHE: "/home/someone/go-cache", GOMODCACHE: "/home/someone/go/pkg/mod" },
      { HOME: "/home/someone", XDG_CACHE_HOME: "/var/cache/someone" },
      { HOME: "/home/someone", GOCACHE: "relative/cache" },
      { PATH: "/usr/bin" },
    ]) {
      const out = withWritableGoBuildCache(env, workspaceWrite(), undefined, workspace, temp, "linux");
      expect(out.GOCACHE, JSON.stringify(env)).toBe(join(temp, "go-build"));
      expect(out.GOMODCACHE).toBe(env.GOMODCACHE);
      expect(out.HOME).toBe(env.HOME);
    }
    const mac = withWritableGoBuildCache({ HOME: "/Users/someone" }, workspaceWrite(), undefined, workspace, temp, "darwin");
    expect(mac.GOCACHE).toBe(join(temp, "go-build"));
  });

  test("a cache the sandbox lets the command write is kept", () => {
    const inWorkspace = join(workspace, ".cache", "go-build");
    expect(withWritableGoBuildCache({ GOCACHE: inWorkspace }, workspaceWrite(), undefined, workspace, temp, "linux").GOCACHE)
      .toBe(inWorkspace);
    const inTemp = join(temp, "custom-go-cache");
    expect(withWritableGoBuildCache({ GOCACHE: inTemp }, workspaceWrite(), undefined, workspace, temp, "linux").GOCACHE)
      .toBe(inTemp);
    const xdgInWorkspace = withWritableGoBuildCache(
      { HOME: "/home/someone", XDG_CACHE_HOME: join(workspace, "xdg") }, workspaceWrite(), undefined, workspace, temp, "linux");
    expect(xdgInWorkspace.GOCACHE).toBeUndefined();
    const full = withWritableGoBuildCache({ HOME: "/home/someone" }, unrestricted(), undefined, workspace, temp, "linux");
    expect(full.GOCACHE).toBeUndefined();
    const granted = withWritableGoBuildCache(
      { HOME: "/home/someone", GOCACHE: "/home/someone/go-cache" }, workspaceWrite(),
      { fileSystem: { entries: [{ path: { kind: "path", path: "/home/someone/go-cache" }, access: "write" }] } },
      workspace, temp, "linux");
    expect(granted.GOCACHE).toBe("/home/someone/go-cache");
  });

  test("the input environment is not mutated", () => {
    const env = { HOME: "/home/someone" };
    withWritableGoBuildCache(env, workspaceWrite(), undefined, workspace, temp, "linux");
    expect(env).toEqual({ HOME: "/home/someone" });
  });
});

describe("sandboxed exec_command spawns", () => {
  function recordingManager(transforms: SandboxTransformRequest[]): UnifiedExecProcessManager {
    return new UnifiedExecProcessManager({
      cwd: workspace,
      sessionTempRoot: temp,
      env: { HOME: "/home/someone", GOCACHE: "/home/someone/go-cache" },
      sandboxManager: {
        selectInitial: () => "linux_seccomp",
        transform: (request): SandboxExecRequest => {
          transforms.push(request);
          return {
            command: [process.execPath, "-e", "process.stdout.write(process.env.GOCACHE ?? '')"],
            cwd: request.command.cwd,
            env: request.command.env,
            sandbox: request.sandbox,
            windowsSandboxLevel: request.windowsSandboxLevel,
            windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
            permissionProfile: request.permissions,
            fileSystemSandboxPolicy: request.permissions.fileSystem,
            networkSandboxPolicy: request.permissions.network,
            arg0: "agenc-sandbox-test",
          };
        },
      },
    } as never);
  }

  test("get a writable GOCACHE under workspace-write and keep the configured one when unrestricted", async () => {
    for (const [permissionProfile, expected] of [
      [workspaceWrite(), join(temp, "go-build")],
      [unrestricted(), "/home/someone/go-cache"],
    ] as const) {
      const transforms: SandboxTransformRequest[] = [];
      const manager = recordingManager(transforms);
      try {
        const result = await manager.execCommand({
          cmd: "go env GOCACHE",
          workdir: workspace,
          yield_time_ms: 2_000,
          runtimeSandbox: {
            permissionProfile,
            sandboxPolicyCwd: workspace,
            sessionTempRoot: temp,
            preference: "require",
          },
        } as never);
        expect(result.exitCode).toBe(0);
        expect(transforms[0]?.command.env.GOCACHE).toBe(expected);
        expect(result.stdout).toBe(expected);
      } finally {
        await manager.closeAll("test cleanup");
      }
    }
  });
});

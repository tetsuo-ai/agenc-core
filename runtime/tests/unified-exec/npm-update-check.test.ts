import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  permissionProfileFromRuntimePermissions,
  unrestrictedFileSystemPolicy,
  type SandboxExecRequest,
  type SandboxTransformRequest,
  type SandboxType,
} from "../sandbox/engine/index.js";
import { permissionProfileForSandboxMode } from "../tools/runtimes/sandboxing.js";
import { withNpmUpdateCheckWhereRecordable } from "./npm-update-check.js";
import { UnifiedExecProcessManager } from "./process-manager.js";

let workspace: string;
let temp: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "agenc-npm-check-ws-")));
  temp = await realpath(await mkdtemp(join(tmpdir(), "agenc-npm-check-tmp-")));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(temp, { recursive: true, force: true });
});

// The profile a workspace-write session's commands run under.
const workspaceWrite = () => permissionProfileForSandboxMode("workspace_write", { cwd: workspace });
const unrestricted = () => permissionProfileFromRuntimePermissions(unrestrictedFileSystemPolicy(), "enabled");

describe("withNpmUpdateCheckWhereRecordable", () => {
  test("turns npm's update check off when the sandbox cannot write where npm records it", () => {
    for (const env of [
      { HOME: "/home/someone", PATH: "/usr/bin" },
      { HOME: "/home/someone", npm_config_cache: "/home/someone/.cache/npm" },
      { HOME: "/home/someone", NPM_CONFIG_CACHE: "/var/cache/npm" },
      { HOME: "/home/someone", npm_config_cache: "relative/cache" },
      { PATH: "/usr/bin" },
    ]) {
      const out = withNpmUpdateCheckWhereRecordable(env, workspaceWrite(), undefined, workspace, temp, "linux");
      expect(out, JSON.stringify(env)).toEqual({ ...env, npm_config_update_notifier: "false" });
    }
    expect(withNpmUpdateCheckWhereRecordable({ HOME: "/Users/someone" }, workspaceWrite(), undefined, workspace, temp,
      "darwin").npm_config_update_notifier).toBe("false");
    expect(withNpmUpdateCheckWhereRecordable({ LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" }, workspaceWrite(),
      undefined, workspace, temp, "win32").npm_config_update_notifier).toBe("false");
  });

  test("leaves the check alone when npm can record it", () => {
    for (const cache of [join(workspace, ".npm-cache"), join(temp, "npm-cache")]) {
      const env = { HOME: "/home/someone", npm_config_cache: cache };
      expect(withNpmUpdateCheckWhereRecordable(env, workspaceWrite(), undefined, workspace, temp, "linux")).toEqual(env);
    }
    const homeInWorkspace = { HOME: workspace };
    expect(withNpmUpdateCheckWhereRecordable(homeInWorkspace, workspaceWrite(), undefined, workspace, temp, "linux"))
      .toEqual(homeInWorkspace);
    const full = { HOME: "/home/someone" };
    expect(withNpmUpdateCheckWhereRecordable(full, unrestricted(), undefined, workspace, temp, "linux")).toEqual(full);
    const granted = { HOME: "/home/someone" };
    expect(withNpmUpdateCheckWhereRecordable(granted, workspaceWrite(),
      { fileSystem: { entries: [{ path: { kind: "path", path: "/home/someone/.npm" }, access: "write" }] } },
      workspace, temp, "linux")).toEqual(granted);
  });

  test("an update-notifier setting in the environment is kept, whatever its case or value", () => {
    for (const key of ["npm_config_update_notifier", "NPM_CONFIG_UPDATE_NOTIFIER", "Npm_Config_Update_Notifier"]) {
      for (const value of ["", "true", "false"]) {
        const env = { HOME: "/home/someone", [key]: value };
        expect(withNpmUpdateCheckWhereRecordable(env, workspaceWrite(), undefined, workspace, temp, "linux")).toEqual(env);
      }
    }
  });

  test("the input environment is not mutated", () => {
    const env = { HOME: "/home/someone" };
    withNpmUpdateCheckWhereRecordable(env, workspaceWrite(), undefined, workspace, temp, "linux");
    expect(env).toEqual({ HOME: "/home/someone" });
  });
});

describe("exec_command children", () => {
  function recordingManager(selected: SandboxType, transforms: SandboxTransformRequest[]): UnifiedExecProcessManager {
    return new UnifiedExecProcessManager({
      cwd: workspace,
      sessionTempRoot: temp,
      // Not the test process environment: the hermetic runner turns npm's update check off for itself.
      baseEnv: { PATH: process.env.PATH ?? "" },
      env: { HOME: "/home/someone" },
      sandboxManager: {
        selectInitial: () => selected,
        transform: (request): SandboxExecRequest => {
          transforms.push(request);
          return {
            command: [process.execPath, "-e", "process.stdout.write(process.env.npm_config_update_notifier ?? 'unset')"],
            cwd: request.command.cwd,
            env: request.command.env,
            sandbox: request.sandbox,
            windowsSandboxLevel: request.windowsSandboxLevel,
            windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
            permissionProfile: request.permissions,
            fileSystemSandboxPolicy: request.permissions.fileSystem,
            networkSandboxPolicy: request.permissions.network,
            arg0: "agenc-npm-check-test",
          };
        },
      },
    } as never);
  }

  test.each([
    ["linux_seccomp", "workspace-write", "false"],
    ["linux_seccomp", "unrestricted", "unset"],
    ["none", "workspace-write", "unset"],
  ] as const)("a %s child under %s sees update-notifier %s", async (selected, mode, expected) => {
    const transforms: SandboxTransformRequest[] = [];
    const manager = recordingManager(selected, transforms);
    try {
      const result = await manager.execCommand({
        cmd: "npm test",
        workdir: workspace,
        yield_time_ms: 2_000,
        runtimeSandbox: {
          permissionProfile: mode === "workspace-write" ? workspaceWrite() : unrestricted(),
          sandboxPolicyCwd: workspace,
          sessionTempRoot: temp,
          preference: selected === "none" ? "auto" : "require",
        },
      } as never);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(transforms).toHaveLength(1);
    } finally {
      await manager.closeAll("test cleanup");
    }
  });
});

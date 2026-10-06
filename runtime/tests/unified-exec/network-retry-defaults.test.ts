import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { permissionProfileFromRuntimePermissions, unrestrictedFileSystemPolicy,
  type NetworkSandboxPolicy, type SandboxExecRequest, type SandboxTransformRequest,
} from "../sandbox/engine/index.js";
import { withNetworkRetryDefaults } from "./network-retry-defaults.js";
import { UnifiedExecProcessManager } from "./process-manager.js";
const profile = (network: NetworkSandboxPolicy) =>
  permissionProfileFromRuntimePermissions(unrestrictedFileSystemPolicy(), network);

test("only disabled unmanaged networking gets retry defaults, without changing offline/cache configuration", () => {
  const env = Object.freeze({ CI: "1", npm_config_offline: "false", PIP_CACHE_DIR: "/cache" });
  expect(withNetworkRetryDefaults(env, profile("disabled"), undefined, false))
    .toEqual({ ...env, npm_config_fetch_retries: "0", PIP_RETRIES: "0" });
  for (const network of ["enabled", "restricted"] as const) {
    expect(withNetworkRetryDefaults(env, profile(network), undefined, false)).toEqual(env);
  }
  expect(withNetworkRetryDefaults(env, profile("disabled"), { network: { enabled: true } }, false)).toEqual(env);
  expect(withNetworkRetryDefaults(env, profile("disabled"), undefined, true)).toEqual(env);
  expect(env).toEqual({ CI: "1", npm_config_offline: "false", PIP_CACHE_DIR: "/cache" });
});

test("explicit retry environment values, including empty values, are preserved", () => {
  for (const key of ["npm_config_fetch_retries", "NPM_CONFIG_FETCH_RETRIES", "Npm_Config_Fetch_Retries"]) {
    for (const value of ["", "0", "5"]) {
      const env = { [key]: value, PIP_RETRIES: value };
      expect(withNetworkRetryDefaults(env, profile("disabled"), undefined, false)).toEqual(env);
    }
  }
});

test.each(["linux_seccomp", "none"] as const)("selected sandbox %s controls the real child's defaults", async selected => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "agenc-network-retries-")));
  const seen: SandboxTransformRequest[] = [];
  const permissions = profile("disabled");
  const manager = new UnifiedExecProcessManager({
    cwd: workspace, sessionTempRoot: workspace, baseEnv: { PATH: process.env.PATH ?? "", CI: "1" },
    sandboxManager: {
      selectInitial: () => selected,
      transform: (request: SandboxTransformRequest): SandboxExecRequest => {
        seen.push(request);
        return {
          command: [process.execPath, "-e", "process.stdout.write(JSON.stringify([process.env.npm_config_fetch_retries ?? null,process.env.PIP_RETRIES ?? null,process.env.npm_config_offline ?? null]))"],
          cwd: request.command.cwd, env: request.command.env, sandbox: request.sandbox,
          windowsSandboxLevel: request.windowsSandboxLevel,
          windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
          permissionProfile: request.permissions, fileSystemSandboxPolicy: request.permissions.fileSystem,
          networkSandboxPolicy: request.permissions.network, arg0: "agenc-network-retries-test",
        };
      },
    },
  } as never);
  try {
    const result = await manager.execCommand({ cmd: "npm --version", workdir: workspace, yield_time_ms: 2_000,
      runtimeSandbox: { permissionProfile: permissions, sandboxPolicyCwd: workspace,
        sessionTempRoot: workspace, preference: selected === "none" ? "auto" : "require" },
    } as never);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(selected === "none" ? [null, null, null] : ["0", "0", null]);
    expect(seen[0]?.permissions).toEqual(permissions);
    expect(seen[0]?.command.env.CI).toBe("1");
  } finally { await manager.closeAll("test cleanup"); await rm(workspace, { recursive: true, force: true }); }
});

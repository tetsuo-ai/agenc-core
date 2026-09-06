import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sourcePath } from "../helpers/source-path.js";
import { MCPManager } from "../../src/mcp-client/manager.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { transitionSandboxExecutionBrokerAuthority } from "../../src/sandbox/execution-lifecycle.js";
import {
  canWritePathWithCwd,
  type NetworkSandboxPolicy,
  type PermissionProfile,
} from "../../src/sandbox/engine/index.js";
import {
  permissionProfileForSandboxMode,
  pluginMcpPermissionProfile,
} from "../../src/tools/runtimes/sandboxing.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("plugin MCP approved network authority", () => {
  it("denies network without an operator-owned grant", () => {
    const profile = pluginMcpPermissionProfile({ pluginDataDir: "/plugin-data" });
    expect(profile.network).toBe("disabled");
  });

  it.each(["disabled", "enabled", "restricted"] as const)(
    "preserves %s network without adding filesystem authority",
    (network) => {
      const base = pluginMcpPermissionProfile({ pluginDataDir: "/plugin-data" });
      const profile = pluginMcpPermissionProfile(
        { pluginDataDir: "/plugin-data" },
        network,
      );
      const canWrite = (path: string) => canWritePathWithCwd(
        profile.fileSystem, path, "/workspace", "/session-temp",
      );
      expect(profile.network).toBe(network);
      expect(profile.fileSystem).toEqual(base.fileSystem);
      expect(canWrite("/plugin-data/cache")).toBe(true);
      expect(canWrite("/workspace/file")).toBe(false);
      expect(canWrite("/session-temp/file")).toBe(false);
    },
  );

  it("restarts a real plugin child with revoked network and no stale grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-net-authority-"));
    roots.push(root);
    const data = join(root, "data");
    const sessionTemp = join(root, "session-temp");
    const workspace = join(root, "workspace");
    await Promise.all([data, sessionTemp, workspace].map((path) => mkdir(path)));
    const observed: PermissionProfile[] = [];
    const profile = (network: NetworkSandboxPolicy) =>
      permissionProfileForSandboxMode("workspace_write", { cwd: workspace, network });
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: workspace,
      env: {},
      sessionTempRoot: sessionTemp,
      // No explicit permissionProfile: a new session must remain denied.
      probe: () => ({
        kind: "ready", mode: "workspace_write", platform: process.platform,
      }),
      // This test observes the exact platform policy and real child lifecycle;
      // OS isolation itself is covered by platform sandbox integration tests.
      sandboxManager: {
        selectInitial: () => "macos_seatbelt",
        transform: (params) => {
          observed.push(params.permissions);
          return {
            command: [params.command.program, ...params.command.args],
            cwd: params.command.cwd,
            env: params.command.env,
            sandbox: params.sandbox,
            windowsSandboxLevel: params.windowsSandboxLevel,
            windowsSandboxPrivateDesktop: params.windowsSandboxPrivateDesktop,
            permissionProfile: params.permissions,
            fileSystemSandboxPolicy: params.permissions.fileSystem,
            networkSandboxPolicy: params.permissions.network,
          };
        },
      },
    });
    const pidPath = join(data, "child.pid");
    const manager = new MCPManager([{
      name: "plugin:fixture:stdio",
      transport: "stdio",
      command: process.execPath,
      args: [sourcePath("mcp-client/test-fixtures/stdio-pid-server.cjs"), pidPath],
      cwd: workspace,
      pluginSandbox: {
        mode: "stdio-child-process",
        pluginName: "fixture",
        pluginRoot: workspace,
        pluginDataDir: data,
        serverName: "stdio",
        scopedServerName: "plugin:fixture:stdio",
      },
    }], undefined, {});
    manager.setSandboxExecutionBroker(broker);
    try {
      await manager.start({ requireOneReady: true, timeoutMs: 10_000 });
      const initialPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      expect(observed.at(-1)?.network).toBe("disabled");
      await transitionSandboxExecutionBrokerAuthority(broker, {
        ...broker.executionAuthority(), permissionProfile: profile("enabled"),
      });
      const approvedPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      expect(approvedPid).not.toBe(initialPid);
      expect(() => process.kill(initialPid, 0)).toThrow();
      expect(observed.at(-1)?.network).toBe("enabled");
      await transitionSandboxExecutionBrokerAuthority(broker, {
        ...broker.executionAuthority(), permissionProfile: profile("disabled"),
      });
      const restartedPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      expect(restartedPid).not.toBe(approvedPid);
      expect(() => process.kill(approvedPid, 0)).toThrow();
      expect(observed.map((entry) => entry.network)).toEqual([
        "disabled", "enabled", "disabled",
      ]);
      for (const entry of observed) {
        expect(canWritePathWithCwd(
          entry.fileSystem, data, workspace, sessionTemp,
        )).toBe(true);
        expect(canWritePathWithCwd(
          entry.fileSystem, workspace, workspace, sessionTemp,
        )).toBe(false);
      }
      expect(manager.getConnectedServers()).toEqual(["plugin:fixture:stdio"]);
    } finally {
      await manager.stop();
    }
  });
});

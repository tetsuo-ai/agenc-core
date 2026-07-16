import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SandboxExecutionBroker,
  SandboxExecutionError,
  attachSandboxExecutionBroker,
  probeSandboxExecutionStatus,
  readSandboxExecutionBroker,
  resolveDefaultLinuxSandboxExecutable,
  type SandboxExecutionStatus,
} from "../../src/sandbox/execution-broker.js";
import { applyRuntimeSandboxToSpawn } from "../../src/tools/system/apply-runtime-sandbox.js";
import {
  rebaseWorktreeSandboxBrokers,
  requireWorktreeSandboxBrokers,
} from "../../src/tools/worktree-sandbox-boundary.js";

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function readyStatus(mode: "workspace_write" | "read_only"): SandboxExecutionStatus {
  return {
    kind: "ready",
    mode,
    platform: process.platform,
    ...(process.platform === "linux" ? { helperPath: "/opt/agenc-linux-sandbox" } : {}),
  };
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("SandboxExecutionBroker", () => {
  it("rejects a privileged executable resolved from the writable workspace PATH", () => {
    const root = tempRoot("agenc-sandbox-broker-path-shim-");
    const executableName = process.platform === "win32" ? "git.cmd" : "git";
    const workspaceShim = join(root, executableName);
    writeFileSync(
      workspaceShim,
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    chmodSync(workspaceShim, 0o755);
    const transform = vi.fn();
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      platform: process.platform,
      sandboxManager: {
        selectInitial: vi.fn(() => "linux_seccomp" as const),
        transform,
      } as never,
      probe: () => readyStatus("workspace_write"),
    });

    expect(() =>
      broker.prepareSpawn("tool", {
        program: "git",
        args: ["status"],
        cwd: root,
        env: {
          PATH: root,
          ...(process.platform === "win32" ? { PATHEXT: ".CMD" } : {}),
        },
        trustedExecutable: true,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "sandbox_transform_failed",
        surface: "tool",
        status: expect.objectContaining({
          reason: expect.stringContaining("privileged executable is writable"),
        }),
      }),
    );
    expect(transform).not.toHaveBeenCalled();
  });

  it("rejects a process tool when its authenticated boundary is missing", () => {
    const root = tempRoot("agenc-sandbox-broker-uncovered-");

    expect(() =>
      applyRuntimeSandboxToSpawn({
        toolArgs: { command: "touch escaped" },
        fallbackCwd: root,
        program: "/bin/sh",
        args: ["-c", "touch escaped"],
        cwd: root,
        env: {},
        surface: "interactive",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "sandbox_surface_uncovered",
        surface: "interactive",
      }),
    );
  });

  it("denies a direct spawn when restricted isolation is unavailable", () => {
    const root = tempRoot("agenc-sandbox-broker-deny-");
    const selectInitial = vi.fn();
    const transform = vi.fn();
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      sandboxManager: { selectInitial, transform },
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: process.platform,
        reason: "probe: namespace creation failed",
        remediation: "enable user namespaces",
      }),
    });
    const toolArgs: Record<string, unknown> = { command: "touch escaped" };
    attachSandboxExecutionBroker(toolArgs, broker);

    expect(() =>
      applyRuntimeSandboxToSpawn({
        toolArgs,
        fallbackCwd: root,
        program: "/bin/sh",
        args: ["-c", "touch escaped"],
        cwd: root,
        env: {},
        surface: "interactive",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "sandbox_probe_failed",
        surface: "interactive",
      }),
    );
    expect(selectInitial).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
  });

  it.each(["danger_full_access", "external_sandbox"] as const)(
    "passes through only the explicit %s mode",
    (mode) => {
      const root = tempRoot("agenc-sandbox-broker-explicit-");
      const broker = new SandboxExecutionBroker({ mode, cwd: root });
      const command = broker.prepareSpawn("hook", {
        program: "/bin/echo",
        args: ["ok"],
        cwd: root,
        env: { PATH: "/usr/bin" },
      });

      expect(command).toMatchObject({
        program: realpathSync("/bin/echo"),
        args: ["ok"],
        cwd: root,
      });
    },
  );

  it("transforms a ready restricted command through the common manager", () => {
    const root = tempRoot("agenc-sandbox-broker-transform-");
    const selectInitial = vi.fn(() => "linux_seccomp" as const);
    const transform = vi.fn(() => ({
      command: ["/sandbox/helper", "/bin/echo", "ok"],
      cwd: root,
      env: { SANDBOXED: "1" },
      arg0: "sandbox-helper",
    }));
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      sandboxManager: { selectInitial, transform } as never,
      probe: () => readyStatus("workspace_write"),
    });

    const command = broker.prepareSpawn("mcp_stdio", {
      program: "/bin/echo",
      args: ["ok"],
      cwd: root,
      env: {},
    });

    expect(command).toMatchObject({
      program: "/sandbox/helper",
      args: ["/bin/echo", "ok"],
      argv0: "sandbox-helper",
    });
    expect(selectInitial).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledOnce();
  });

  it("rebases captured boundaries and forks independent child roots", async () => {
    const root = tempRoot("agenc-sandbox-broker-root-");
    const child = tempRoot("agenc-sandbox-broker-child-");
    const sibling = tempRoot("agenc-sandbox-broker-sibling-");
    const probedCwds: string[] = [];
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      probe: (options) => {
        probedCwds.push(options.cwd);
        return readyStatus("workspace_write");
      },
    });

    broker.status();
    const brokers = requireWorktreeSandboxBrokers({
      services: { sandboxExecutionBroker: broker },
    } as never);
    await rebaseWorktreeSandboxBrokers(brokers, child);
    broker.status();
    const fork = broker.forkForCwd(sibling);
    fork.status();

    expect(broker.cwd).toBe(child);
    expect(fork.cwd).toBe(sibling);
    expect(broker.forkDepth).toBe(0);
    expect(fork.forkDepth).toBe(1);
    expect(fork.forkForCwd(root).forkDepth).toBe(2);
    expect(probedCwds).toEqual([root, child, sibling]);
  });

  it("wraps transform failures with a stable code and never returns the host command", () => {
    const root = tempRoot("agenc-sandbox-broker-transform-fail-");
    const broker = new SandboxExecutionBroker({
      mode: "read_only",
      cwd: root,
      sandboxManager: {
        selectInitial: () => "linux_seccomp",
        transform: () => {
          throw new Error("launcher disappeared");
        },
      } as never,
      probe: () => readyStatus("read_only"),
    });

    expect(() =>
      broker.prepareSpawn("child_agent", {
        program: "/bin/echo",
        args: ["unsafe"],
        cwd: root,
        env: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "sandbox_transform_failed",
        surface: "child_agent",
      }),
    );
  });

  it.runIf(process.platform === "linux")(
    "reports missing, non-executable, and workspace-controlled helpers precisely",
    () => {
      const root = tempRoot("agenc-sandbox-broker-helper-");
      const outside = tempRoot("agenc-sandbox-broker-outside-");
      const nonExecutable = join(outside, "non-executable");
      writeFileSync(nonExecutable, "#!/bin/sh\nexit 0\n");
      chmodSync(nonExecutable, 0o644);
      const workspaceHelper = join(root, "helper");
      writeFileSync(workspaceHelper, "#!/bin/sh\nexit 0\n");
      chmodSync(workspaceHelper, 0o755);
      const base = {
        mode: "workspace_write" as const,
        cwd: root,
        env: process.env,
        platform: "linux" as const,
      };

      expect(
        probeSandboxExecutionStatus({
          ...base,
          agencLinuxSandboxExe: join(outside, "missing"),
        }).reason,
      ).toContain("does not exist");
      expect(
        probeSandboxExecutionStatus({
          ...base,
          agencLinuxSandboxExe: nonExecutable,
        }).reason,
      ).toContain("not executable");
      expect(
        probeSandboxExecutionStatus({
          ...base,
          agencLinuxSandboxExe: workspaceHelper,
        }).reason,
      ).toContain("outside the writable workspace");
    },
  );

  it("resolves the packaged helper from a bundled dist chunk", () => {
    const root = tempRoot("agenc-sandbox-package-root-");
    const chunk = join(root, "dist", "chunks", "execution-broker.js");
    const helper = join(root, "bin", "agenc-linux-sandbox");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@tetsuo-ai/runtime" }),
    );
    writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    expect(
      resolveDefaultLinuxSandboxExecutable(pathToFileURL(chunk).href),
    ).toBe(helper);
  });

  it("rejects a structurally spoofed broker carrier", () => {
    expect(
      readSandboxExecutionBroker({
        __sandboxExecutionBroker: {
          mode: "danger_full_access",
          required: false,
          prepareSpawn: () => undefined,
          runtimeSandbox: () => undefined,
          assertReady: () => undefined,
        },
      }),
    ).toBeUndefined();
  });

  it("exposes a typed error for operator diagnostics", () => {
    const root = tempRoot("agenc-sandbox-broker-error-");
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: process.platform,
        reason: "sandbox executable does not exist",
        remediation: "install the helper",
      }),
    });

    try {
      broker.assertReady("cron");
      expect.unreachable("assertReady must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxExecutionError);
      expect(error).toMatchObject({
        code: "sandbox_required_unavailable",
        surface: "cron",
      });
      expect(String(error)).toContain("install the helper");
    }
  });
});

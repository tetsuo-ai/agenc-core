import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LINUX_SANDBOX_HELPER_REINSTALL_REMEDIATION,
  LINUX_SANDBOX_HOME_WORKSPACE_REMEDIATION,
  SandboxExecutionBroker,
  SandboxExecutionError,
  attachSandboxExecutionBroker,
  linuxSandboxHelperRemediation,
  linuxSandboxProbeRemediation,
  probeSandboxExecutionStatus,
  readSandboxExecutionBroker,
  resolveDefaultLinuxSandboxExecutable,
  type SandboxExecutionStatus,
} from "../../src/sandbox/execution-broker.js";
import type {
  FileSystemSandboxEntry,
  PermissionProfile,
} from "../../src/sandbox/engine/index.js";
import { applyRuntimeSandboxToSpawn } from "../../src/tools/system/apply-runtime-sandbox.js";
import {
  rebaseWorktreeSandboxBrokers,
  requireWorktreeSandboxBrokers,
  runWorktreeSandboxedProcess,
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
  it("captures separate session temp roots and preserves them across forks", () => {
    const workspaceA = tempRoot("agenc-sandbox-broker-temp-a-");
    const workspaceB = tempRoot("agenc-sandbox-broker-temp-b-");
    const sessionTempA = join(workspaceA, "session-temp");
    const sessionTempB = join(workspaceB, "session-temp");
    const brokerA = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: workspaceA,
      sessionTempRoot: sessionTempA,
      probe: () => readyStatus("workspace_write"),
    });
    const brokerB = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: workspaceB,
      sessionTempRoot: sessionTempB,
      probe: () => readyStatus("workspace_write"),
    });

    expect(brokerA.sessionTempRoot).toBe(sessionTempA);
    expect(brokerB.sessionTempRoot).toBe(sessionTempB);
    const fork = brokerA.forkForCwd(join(workspaceA, "child"));
    expect(fork.sessionTempRoot).toBe(sessionTempA);
    expect(fork.runtimeSandbox("child_agent")?.sessionTempRoot).toBe(
      sessionTempA,
    );
  });

  it("turns Ubuntu's AppArmor bubblewrap denial into the exact profile fix", () => {
    const diagnostic =
      "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
    expect(linuxSandboxProbeRemediation(diagnostic, "1")).toContain(
      "agenc doctor --apparmor-profile",
    );
    expect(linuxSandboxProbeRemediation(diagnostic, "0")).toContain(
      "Enable unprivileged user namespaces",
    );
  });

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

  it("irreversibly rejects execution after lifecycle authority rollback fails", () => {
    const root = tempRoot("agenc-sandbox-broker-lifecycle-closed-");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: root,
    });

    broker.closeAfterLifecycleAuthorityFailure(
      "runtime authority rollback was incomplete",
    );

    expect(broker.mode).toBe("read_only");
    expect(broker.status()).toMatchObject({
      kind: "unavailable",
      mode: "read_only",
      reason: "runtime authority rollback was incomplete",
    });
    expect(() => broker.assertReady("startup")).toThrowError(
      expect.objectContaining({
        code: "sandbox_required_unavailable",
        surface: "startup",
      }),
    );
    expect(() => broker.runtimeSandbox("tool")).toThrowError(
      expect.objectContaining({
        code: "sandbox_required_unavailable",
        surface: "tool",
      }),
    );
    expect(() =>
      broker.prepareSpawn("hook", {
        program: "must-not-resolve-after-authority-failure",
        args: [],
        cwd: root,
        env: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "sandbox_required_unavailable",
        surface: "hook",
      }),
    );
    expect(() => broker.forkForCwd(join(root, "child"))).toThrowError(
      expect.objectContaining({
        code: "sandbox_required_unavailable",
        surface: "child_agent",
      }),
    );
    expect(
      (broker as unknown as { applyModeAfterLifecycleQuiesce?: unknown })
        .applyModeAfterLifecycleQuiesce,
    ).toBeUndefined();
    expect(() =>
      broker.applyAuthorityAfterLifecycleQuiesce({} as never, {
        ...broker.executionAuthority(),
        mode: "danger_full_access",
      }),
    ).toThrow(/proven lifecycle quiescence/u);

    broker.closeAfterLifecycleAuthorityFailure("replacement reason");
    expect(broker.status().reason).toBe(
      "runtime authority rollback was incomplete",
    );
  });

  it.each(["danger_full_access", "external_sandbox"] as const)(
    "passes through only the explicit %s mode",
    (mode) => {
      const root = tempRoot("agenc-sandbox-broker-explicit-");
      const broker = new SandboxExecutionBroker({ mode, cwd: root });
      const prepared = broker.prepareSpawn("hook", {
        program: "/bin/echo",
        args: ["ok"],
        cwd: root,
        env: { PATH: "/usr/bin" },
      });

      const command = prepared.runSync((resolved) => resolved);
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

    const prepared = broker.prepareSpawn("mcp_stdio", {
      program: "/bin/echo",
      args: ["ok"],
      cwd: root,
      env: {},
    });

    const command = prepared.runSync((resolved) => resolved);
    expect(command).toMatchObject({
      program: "/sandbox/helper",
      args: ["/bin/echo", "ok"],
      argv0: "sandbox-helper",
    });
    expect(selectInitial).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledOnce();
  });

  describe("Landlock-fallback pre-flight", () => {
    function fallbackStatus(): SandboxExecutionStatus {
      return {
        ...readyStatus("workspace_write"),
        platform: "linux",
        landlock: "full",
        landlockFallback: {
          reason: "probe: bubblewrap could not create the required namespaces",
          remediation:
            "Install AgenC's narrow per-command profile with: agenc doctor --apparmor-profile | sudo tee ...",
        },
      };
    }
    const fakeManager = {
      selectInitial: vi.fn(() => "linux_seccomp" as const),
      transform: vi.fn(() => ({
        command: ["/sandbox/helper", "/bin/echo", "ok"],
        cwd: "/",
        env: {},
        arg0: "sandbox-helper",
      })),
    } as never;

    it("refuses an unexpressible policy with the precise reason and the probe-time remediation", () => {
      const root = tempRoot("agenc-broker-preflight-");
      mkdirSync(join(root, ".agenc"));
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: root,
        platform: "linux",
        sandboxManager: fakeManager,
        probe: fallbackStatus,
      });

      expect(() =>
        broker.prepareSpawn("mcp_stdio", {
          program: "/bin/echo",
          args: ["ok"],
          cwd: root,
          env: {},
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "sandbox_policy_unexpressible",
          surface: "mcp_stdio",
          message: expect.stringMatching(
            /read-only subpath.*\.agenc.*agenc doctor --apparmor-profile/s,
          ),
        }),
      );
    });

    it("rechecks carve-out existence on every spawn instead of memoizing", () => {
      const root = tempRoot("agenc-broker-preflight-recheck-");
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: root,
        platform: "linux",
        sandboxManager: fakeManager,
        probe: fallbackStatus,
      });
      const command = {
        program: "/bin/echo",
        args: ["ok"],
        cwd: root,
        env: {},
      };

      expect(() => broker.prepareSpawn("tool", command)).not.toThrow();
      mkdirSync(join(root, ".agenc"));
      expect(() => broker.prepareSpawn("tool", command)).toThrowError(
        expect.objectContaining({ code: "sandbox_policy_unexpressible" }),
      );
    });

    it("skips the pre-flight for inherited read-only cwd spawns", () => {
      const root = tempRoot("agenc-broker-preflight-inherited-");
      mkdirSync(join(root, ".agenc"));
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: root,
        platform: "linux",
        sandboxManager: fakeManager,
        probe: fallbackStatus,
      });

      expect(() =>
        broker.prepareSpawn("tool", {
          program: "/bin/echo",
          args: ["ok"],
          cwd: root,
          env: {},
          cwdBinding: "inherited_readonly",
        }),
      ).not.toThrow();
    });

    it("never invokes the planner on a healthy bubblewrap host", () => {
      const root = tempRoot("agenc-broker-preflight-healthy-");
      mkdirSync(join(root, ".agenc"));
      const planSpy = vi.fn(() => ({
        kind: "refused" as const,
        reason: "should never be consulted",
      }));
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: root,
        platform: "linux",
        sandboxManager: fakeManager,
        probe: () => ({ ...readyStatus("workspace_write"), platform: "linux" }),
        planLandlockPolicy: planSpy,
      });

      expect(() =>
        broker.prepareSpawn("tool", {
          program: "/bin/echo",
          args: ["ok"],
          cwd: root,
          env: {},
        }),
      ).not.toThrow();
      expect(planSpy).not.toHaveBeenCalled();
    });

    it("a tight profile override makes the same spawn expressible, and additionalPermissions still merge", () => {
      const root = tempRoot("agenc-broker-preflight-override-");
      mkdirSync(join(root, ".agenc"));
      const dataDir = join(root, "plugin-data");
      mkdirSync(dataDir);
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write",
        cwd: root,
        platform: "linux",
        sandboxManager: fakeManager,
        probe: fallbackStatus,
      });
      const override = {
        fileSystem: {
          kind: "restricted",
          entries: [
            {
              path: { kind: "special", value: { kind: "root" } },
              access: "read",
            },
            { path: { kind: "path", path: dataDir }, access: "write" },
          ],
          includePlatformDefaults: true,
        },
        network: "disabled",
      } as never;

      // Default workspace profile refuses (existing .agenc carve-out) …
      expect(() =>
        broker.prepareSpawn("mcp_stdio", {
          program: "/bin/echo",
          args: ["ok"],
          cwd: root,
          env: {},
        }),
      ).toThrowError(
        expect.objectContaining({ code: "sandbox_policy_unexpressible" }),
      );
      // … the tight override plans cleanly …
      expect(() =>
        broker.prepareSpawn("mcp_stdio", {
          program: "/bin/echo",
          args: ["ok"],
          cwd: root,
          env: {},
          permissionProfileOverride: override,
        }),
      ).not.toThrow();
      // … and additive surface grants still merge on top of the override:
      // granting the project root back re-introduces the carve-out refusal.
      expect(() =>
        broker.prepareSpawn("mcp_stdio", {
          program: "/bin/echo",
          args: ["ok"],
          cwd: root,
          env: {},
          permissionProfileOverride: override,
          additionalPermissions: {
            fileSystem: {
              entries: [
                { path: { kind: "path", path: root }, access: "write" },
              ],
            },
          } as never,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "sandbox_policy_unexpressible" }),
      );
    });
  });

  it("rebases captured boundaries and forks independent child roots", async () => {
    const root = tempRoot("agenc-sandbox-broker-root-");
    const child = tempRoot("agenc-sandbox-broker-child-");
    const sibling = tempRoot("agenc-sandbox-broker-sibling-");
    const external = tempRoot("agenc-sandbox-broker-external-");
    const probedCwds: string[] = [];
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      permissionProfile: {
        fileSystem: {
          kind: "restricted",
          entries: [
            {
              path: { kind: "path", path: join(root, "config") },
              access: "write",
            },
            {
              path: { kind: "glob", pattern: join(root, "**", "*.secret") },
              access: "none",
            },
            {
              path: { kind: "path", path: external },
              access: "read",
            },
            {
              path: {
                kind: "special",
                value: { kind: "project_roots" },
              },
              access: "write",
            },
          ],
        },
        network: "disabled",
      },
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
    expect(
      broker.executionAuthority().permissionProfile?.fileSystem.entries,
    ).toEqual([
      {
        path: { kind: "path", path: join(child, "config") },
        access: "write",
      },
      {
        path: { kind: "glob", pattern: join(child, "**", "*.secret") },
        access: "none",
      },
      {
        path: { kind: "path", path: external },
        access: "read",
      },
      {
        path: { kind: "special", value: { kind: "project_roots" } },
        access: "write",
      },
    ]);
    expect(
      fork.executionAuthority().permissionProfile?.fileSystem.entries,
    ).toEqual([
      {
        path: { kind: "path", path: join(sibling, "config") },
        access: "write",
      },
      {
        path: { kind: "glob", pattern: join(sibling, "**", "*.secret") },
        access: "none",
      },
      {
        path: { kind: "path", path: external },
        access: "read",
      },
      {
        path: { kind: "special", value: { kind: "project_roots" } },
        access: "write",
      },
    ]);
  });

  it("deeply snapshots permission profiles across construction, get, apply, rebase, and fork", async () => {
    const root = tempRoot("agenc-sandbox-profile-root-");
    const rebased = tempRoot("agenc-sandbox-profile-rebased-");
    const forked = tempRoot("agenc-sandbox-profile-forked-");
    const specialPathValue = {
      kind: "project_roots" as const,
      subpath: "source",
    };
    const originalPathValue = {
      kind: "path" as const,
      path: join(root, "original"),
    };
    const originalEntries: FileSystemSandboxEntry[] = [
      {
        path: originalPathValue,
        access: "write" as const,
      },
      {
        path: { kind: "special", value: specialPathValue },
        access: "read",
      },
    ];
    const originalProfile: PermissionProfile = {
      fileSystem: {
        kind: "restricted",
        entries: originalEntries,
        includePlatformDefaults: true,
      },
      network: "disabled",
      enforcement: "managed",
    };
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: root,
      permissionProfile: originalProfile,
    });

    originalPathValue.path = join(root, "mutated-after-construction");
    specialPathValue.subpath = "mutated-after-construction";
    originalEntries.push({
      path: { kind: "path", path: join(root, "injected") },
      access: "write",
    });
    const constructed = broker.executionAuthority().permissionProfile!;
    expect(constructed.fileSystem.entries).toEqual([
      {
        path: { kind: "path", path: join(root, "original") },
        access: "write",
      },
      {
        path: {
          kind: "special",
          value: { kind: "project_roots", subpath: "source" },
        },
        access: "read",
      },
    ]);
    expect(Object.isFrozen(constructed)).toBe(true);
    expect(Object.isFrozen(constructed.fileSystem)).toBe(true);
    expect(Object.isFrozen(constructed.fileSystem.entries)).toBe(true);
    expect(Object.isFrozen(constructed.fileSystem.entries[0])).toBe(true);
    expect(Object.isFrozen(constructed.fileSystem.entries[0]!.path)).toBe(true);
    const constructedSpecialPath = constructed.fileSystem.entries[1]!.path;
    if (constructedSpecialPath.kind !== "special") {
      throw new Error("expected a special permission path");
    }
    expect(Object.isFrozen(constructedSpecialPath.value)).toBe(true);
    expect(() => {
      (constructedSpecialPath.value as { subpath?: string }).subpath =
        "mutated-through-get";
    }).toThrow(TypeError);
    expect(() => {
      (constructed.fileSystem.entries[0]!.path as {
        path: string;
      }).path = join(root, "mutated-through-get");
    }).toThrow(TypeError);

    const appliedEntries = [
      {
        path: { kind: "path" as const, path: join(root, "applied") },
        access: "read" as const,
      },
    ];
    const nextAuthority = {
      mode: "workspace_write",
      permissionProfile: {
        fileSystem: { kind: "restricted", entries: appliedEntries },
        network: "restricted",
      },
      windowsSandboxLevel: "low",
      allowGpu: true,
    } as const;
    expect(() =>
      broker.applyAuthorityAfterLifecycleQuiesce(
        {} as never,
        nextAuthority,
      ),
    ).toThrow(/proven lifecycle quiescence/u);
    expect(
      (broker as unknown as { rebase?: unknown }).rebase,
    ).toBeUndefined();
    const fence = broker.beginLifecycleAuthorityTransition();
    await broker.waitForLifecycleOneShotDrain(fence);
    const mutationPermit = broker.proveLifecycleParticipantsQuiesced(fence);
    broker.applyAuthorityAfterLifecycleQuiesce(
      mutationPermit,
      nextAuthority,
    );
    appliedEntries[0]!.path.path = join(root, "mutated-after-apply");

    broker.rebaseAfterLifecycleQuiesce(mutationPermit, rebased);
    broker.endLifecycleAuthorityTransition(fence);
    const rebasedProfile = broker.executionAuthority().permissionProfile!;
    expect(rebasedProfile.fileSystem.entries[0]).toEqual({
      path: { kind: "path", path: join(rebased, "applied") },
      access: "read",
    });
    expect(Object.isFrozen(rebasedProfile)).toBe(true);
    expect(Object.isFrozen(rebasedProfile.fileSystem.entries[0]!.path)).toBe(
      true,
    );

    const fork = broker.forkForCwd(forked);
    const forkedProfile = fork.executionAuthority().permissionProfile!;
    expect(forkedProfile.fileSystem.entries[0]).toEqual({
      path: { kind: "path", path: join(forked, "applied") },
      access: "read",
    });
    expect(Object.isFrozen(forkedProfile)).toBe(true);
    expect(Object.isFrozen(forkedProfile.fileSystem.entries)).toBe(true);
    expect(forkedProfile).not.toBe(rebasedProfile);
    expect(rebasedProfile.fileSystem.entries[0]).toEqual({
      path: { kind: "path", path: join(rebased, "applied") },
      access: "read",
    });
  });

  it("runs ExitWorktree inspection with hardened Git authority and finite supervision", async () => {
    const root = tempRoot("agenc-exit-worktree-git-helper-");
    const prepareSpawn = vi.fn(
      (_surface: string, command: Record<string, unknown>) => ({
        program: process.execPath,
        args: ["-e", "process.stdout.write('clean')"],
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        argv0: "git",
        original: command,
      }),
    );
    vi.stubEnv("GIT_CONFIG_COUNT", "99");
    try {
      const result = await runWorktreeSandboxedProcess(
        { cwd: root, prepareSpawn } as never,
        "git",
        ["-C", root, "status", "--porcelain"],
        root,
      );

      expect(result).toMatchObject({ code: 0, stdout: "clean" });
      const prepared = prepareSpawn.mock.calls[0]?.[1] as {
        args: readonly string[];
        env: Record<string, string>;
        trustedExecutable?: boolean;
      };
      expect(prepared.args).toEqual([
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "diff.external=",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "--no-optional-locks",
        "-C",
        root,
        "status",
        "--porcelain",
      ]);
      expect(prepared.trustedExecutable).toBe(true);
      expect(prepared.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(prepared.env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PROTOCOL_FROM_USER: "0",
      });
    } finally {
      vi.unstubAllEnvs();
    }
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

  it.runIf(process.platform === "linux")(
    "does not probe the daemon PATH when the session PATH is absent",
    () => {
      const root = tempRoot("agenc-sandbox-broker-session-path-");
      const outside = tempRoot("agenc-sandbox-broker-session-path-helper-");
      const helper = join(outside, "agenc-linux-sandbox");
      writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const daemonBin = tempRoot("agenc-sandbox-broker-daemon-path-");
      symlinkSync("/bin/true", join(daemonBin, "bwrap"));
      const previousPath = process.env.PATH;
      process.env.PATH = daemonBin;
      try {
        const status = probeSandboxExecutionStatus({
          mode: "workspace_write",
          cwd: root,
          env: { AGENC_DISABLE_LANDLOCK_FALLBACK: "1" },
          platform: "linux",
          agencLinuxSandboxExe: helper,
        });

        expect(status).toMatchObject({
          kind: "unavailable",
          reason: "bubblewrap was not found in a trusted system directory",
        });
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
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

/**
 * The default userland install puts the helper under ~/.agenc, and a bare
 * `agenc` in a fresh terminal opens $HOME as the workspace -- so the helper is
 * inside the writable workspace and startup fails closed. Observed live on
 * 0.17.0: the refusal is correct, but it told the operator to reinstall the
 * helper "outside the workspace", which is not the action that fixes it.
 */
describe("Linux sandbox helper remediation", () => {
  it("names the home workspace instead of sending the operator to reinstall", () => {
    const home = tempRoot("agenc-sandbox-home-");
    expect(linuxSandboxHelperRemediation(home, { HOME: home })).toBe(
      LINUX_SANDBOX_HOME_WORKSPACE_REMEDIATION,
    );
    expect(linuxSandboxHelperRemediation(home, { HOME: home })).toContain(
      "project directory",
    );
  });

  it("covers a workspace that merely contains the home directory", () => {
    const root = tempRoot("agenc-sandbox-above-home-");
    const home = join(root, "home", "operator");
    mkdirSync(home, { recursive: true });
    expect(linuxSandboxHelperRemediation(root, { HOME: home })).toBe(
      LINUX_SANDBOX_HOME_WORKSPACE_REMEDIATION,
    );
  });

  it("keeps the reinstall guidance when the workspace excludes the home", () => {
    const root = tempRoot("agenc-sandbox-project-");
    const workspace = join(root, "project");
    const home = join(root, "home");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });
    // A helper inside a project workspace is a genuine placement problem, so
    // the original guidance is the right one to keep.
    expect(linuxSandboxHelperRemediation(workspace, { HOME: home })).toBe(
      LINUX_SANDBOX_HELPER_REINSTALL_REMEDIATION,
    );
  });

  it("ignores a relative HOME rather than trusting it as a root", () => {
    const root = tempRoot("agenc-sandbox-relative-home-");
    // A relative HOME cannot anchor a containment test; the fallback is the
    // process's real home, which is not under this temporary workspace.
    expect(linuxSandboxHelperRemediation(root, { HOME: "relative/home" })).toBe(
      LINUX_SANDBOX_HELPER_REINSTALL_REMEDIATION,
    );
  });

  it.skipIf(process.platform === "win32")(
    "reaches the probe status an operator actually sees",
    () => {
      const home = tempRoot("agenc-sandbox-home-probe-");
      const helper = join(home, ".agenc", "agenc-linux-sandbox");
      mkdirSync(join(home, ".agenc"), { recursive: true });
      writeFileSync(helper, "#!/bin/sh\nexit 0\n");
      chmodSync(helper, 0o755);

      const status = probeSandboxExecutionStatus({
        mode: "workspace_write",
        cwd: home,
        env: { HOME: home },
        platform: "linux",
        agencLinuxSandboxExe: helper,
      });

      expect(status.kind).toBe("unavailable");
      expect(status).toMatchObject({
        reason: expect.stringContaining("outside the writable workspace"),
        remediation: LINUX_SANDBOX_HOME_WORKSPACE_REMEDIATION,
      });
    },
  );
});

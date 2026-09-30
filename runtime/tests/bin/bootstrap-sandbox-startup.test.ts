import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";
import { SandboxExecutionBroker, type SandboxExecutionStatus } from "../../src/sandbox/execution-broker.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { Session } from "../../src/session/session.js";

describe("production sandbox startup boundary", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("fails before provider setup when required isolation is unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-startup-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-startup-workspace-"));
    roots.push(home, workspace);
    vi.spyOn(SandboxExecutionBroker.prototype, "status").mockReturnValue({
      kind: "unavailable", mode: "workspace_write", platform: "linux",
      reason: "bubblewrap is unavailable",
      remediation: "Install bubblewrap",
    });

    await expect(
      bootstrapLocalRuntimeSession({
        cwd: workspace,
        env: {
          AGENC_HOME: home,
          HOME: home,
          PATH: join(workspace, "untrusted-bin"),
          AGENC_DISABLE_LANDLOCK_FALLBACK: "1",
        },
        argv: ["node", "agenc"],
        requireSandboxReadyAtStartup: true,
      }),
    ).rejects.toMatchObject({
      code: "sandbox_required_unavailable",
      surface: "startup",
      status: {
        kind: "unavailable",
        reason: expect.stringContaining("bubblewrap"),
        remediation: expect.stringContaining("Install bubblewrap"),
      },
    });
  });

  test("refuses an unexpressible headless policy before provider setup", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-startup-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-startup-workspace-"));
    roots.push(home, workspace);
    const protectedPath = join(workspace, ".git");
    const provider = await import("../../src/llm/provider.js");
    const createProvider = vi.spyOn(provider, "createProvider");
    vi.spyOn(SandboxExecutionBroker.prototype, "status").mockReturnValue({
      kind: "unavailable", mode: "workspace_write", platform: "linux",
      landlockPolicyRefusal: `a writable root carries an existing read-only subpath: ${protectedPath}`,
      reason: `the Landlock fallback cannot express the workspace-write policy: ${protectedPath}`,
      remediation: "Install bubblewrap and allow unprivileged user namespaces. In Docker, use seccomp/AppArmor settings that permit bubblewrap, or run outside the container.",
      landlockFallback: { reason: "bubblewrap unavailable", remediation: "Install bubblewrap" },
    });
    const env = { ...process.env, AGENC_HOME: home, HOME: home };

    await expect(bootstrapLocalRuntimeSession({
      cwd: workspace, env, apiKey: "test-key", argv: ["node", "agenc"],
      runtimeOptions: resolveAgentRuntimeOptions(env, { nonInteractive: true }),
      requireSandboxReadyAtStartup: true,
    })).rejects.toMatchObject({
      code: "sandbox_policy_unexpressible", surface: "startup",
      status: { reason: expect.stringContaining(protectedPath) },
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  test("emits one visible warning and starts an interactive session", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-startup-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-startup-workspace-"));
    roots.push(home, workspace);
    const protectedPath = join(workspace, ".git");
    const status: SandboxExecutionStatus = {
      kind: "unavailable", mode: "workspace_write", platform: "linux",
      landlockPolicyRefusal: `existing read-only subpath: ${protectedPath}`,
      reason: `the Landlock fallback cannot express the workspace-write policy: ${protectedPath}`,
      remediation: "Install bubblewrap and allow unprivileged user namespaces. In Docker, use seccomp/AppArmor settings that permit bubblewrap, or run outside the container.",
      landlockFallback: { reason: "bubblewrap unavailable", remediation: "Install bubblewrap" },
    };
    vi.spyOn(SandboxExecutionBroker.prototype, "status").mockReturnValue(status);
    const provider = await import("../../src/llm/provider.js");
    vi.spyOn(provider, "createProvider").mockReturnValue({
      name: "stub", chat: vi.fn(),
    } as never);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const emit = vi.spyOn(Session.prototype, "emit");
    const env = { ...process.env, AGENC_HOME: home, HOME: home };
    const boot = await bootstrapLocalRuntimeSession({
      cwd: workspace, env, apiKey: "test-key", argv: ["node", "agenc"],
      runtimeOptions: resolveAgentRuntimeOptions(env, { nonInteractive: false }),
      requireSandboxReadyAtStartup: true,
      deferSessionStartHooks: true,
      deferAgentStartupSideEffects: true,
    });
    try {
      const warnings = emit.mock.calls.filter(([event]) =>
        event.msg.type === "warning" && event.msg.payload.cause === "sandbox_policy_unexpressible"
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.[0].msg).toMatchObject({
        payload: { message: expect.stringMatching(/\.git.*Install bubblewrap.*Docker/s) },
      });
    } finally {
      await boot.shutdown();
    }
  });
});

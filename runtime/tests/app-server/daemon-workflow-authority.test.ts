import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { mergeDaemonClientEnvironment } from "../../src/app-server/client-env-snapshot.js";
import { restoreRecoveredAgentRuntime } from "../../src/app-server/daemon-cli.js";
import type { AgenCBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { RecoveredAgentRun } from "../../src/state/recovery.js";

const runtimeOptions = resolveAgentRuntimeOptions({});

function recoveredRun(commandEnvironment?: unknown): RecoveredAgentRun {
  const timestamp = "2026-09-10T01:00:00.000Z";
  return {
    id: "conv-recovered-path",
    objective: "Continue the sandboxed coding task",
    status: "suspended",
    projectDir: "/tmp/agenc-recovered-project",
    currentSessionId: "daemon-session-recovered",
    startedAt: timestamp,
    lastActiveAt: timestamp,
    metadata: {
      agentPath: "/root",
      runtimeOptions,
      ...(commandEnvironment !== undefined ? { commandEnvironment } : {}),
    },
    latestSnapshot: {
      projectDir: "/tmp/agenc-recovered-project",
      sessionId: "daemon-session-recovered",
      snapshotAt: timestamp,
      conversation: [],
      toolState: {},
      mcpConnectionState: {},
      recoveredToolCalls: [],
    },
    resumeSource: {
      runId: "conv-recovered-path",
      sessionId: "conv-recovered-path",
      cwd: "/tmp/agenc-recovered-project",
      rolloutPath: "/tmp/agenc-recovered-project/rollout.jsonl",
      lifecycleState: "suspended",
      close: vi.fn(),
    } as RecoveredAgentRun["resumeSource"],
  } as RecoveredAgentRun;
}

describe("daemon workflow authority", () => {
  it("persists only the explicit client PATH for command recovery", async () => {
    const startAgent = vi.fn(async () => ({
      agentId: "conv-path-authority",
      agentPath: "/root",
      startedAt: "2026-09-10T01:00:00.000Z",
      status: "running" as const,
    }));
    const manager = new AgenCDaemonAgentManager({
      runner: { startAgent },
      sessionManager: new AgenCDaemonSessionManager(),
    });
    await manager.createAgent({
      objective: "Capture command authority",
      cwd: "/tmp",
      runtimeOptions,
      envOverrides: { PATH: "/client/bin:/usr/bin", XAI_API_KEY: "fixture-secret" },
      metadata: { commandEnvironment: { PATH: "/forged/bin", XAI_API_KEY: "forged" } },
    });
    expect(startAgent.mock.calls[0]?.[0].metadata?.commandEnvironment).toEqual({
      PATH: "/client/bin:/usr/bin",
    });
    const listed = await manager.listAgents();
    expect(listed.agents[0]?.metadata?.commandEnvironment).toEqual({
      PATH: "/client/bin:/usr/bin",
    });
    expect(JSON.stringify(listed)).not.toContain("fixture-secret");
    expect(JSON.stringify(listed)).not.toContain("forged");
  });

  it.each(["/client/bin:/usr/bin", ""])(
    "restores the retained PATH authority %j without provider credentials",
    async (retainedPath) => {
      let restoredEnvironment: NodeJS.ProcessEnv | undefined;
      const restoreAgent = vi.fn(async (params) => {
        restoredEnvironment = mergeDaemonClientEnvironment(
          { PATH: "/different-daemon/bin", XAI_API_KEY: "daemon-secret" },
          params.envOverrides,
        );
        return true;
      });
      const runner: AgenCBackgroundAgentRunner = {
        startAgent: vi.fn(),
        restoreAgent,
      };
      await expect(
        restoreRecoveredAgentRuntime(runner, recoveredRun({ PATH: retainedPath })),
      ).resolves.toMatchObject({ available: true });
      expect(restoreAgent.mock.calls[0]?.[0].envOverrides).toEqual({ PATH: retainedPath });
      expect(restoredEnvironment?.PATH).toBe(retainedPath || undefined);
      expect(restoredEnvironment).not.toHaveProperty("XAI_API_KEY");
    },
  );

  it.each([undefined, {}, { PATH: 42 }, { PATH: "/client/bin", XAI_API_KEY: "secret" }])(
    "defers recovery without valid credential-free command authority %j",
    async (commandEnvironment) => {
      const restoreAgent = vi.fn(async () => true);
      const run = recoveredRun(commandEnvironment);
      await expect(
        restoreRecoveredAgentRuntime({ startAgent: vi.fn(), restoreAgent }, run),
      ).resolves.toEqual({ available: false });
      expect(restoreAgent).not.toHaveBeenCalled();
      expect(run.resumeSource?.close).toHaveBeenCalledOnce();
    },
  );

  it("lists the same live permissions by canonical TUI and daemon session IDs", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: () => "daemon-session-permissions",
    });
    const listPermissions = vi.fn(async () => ({ permissions: [] }));
    const manager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "conv-canonical-permissions",
          agentPath: "/root",
          startedAt: "2026-09-10T01:00:00.000Z",
          status: "running",
        }),
        listPermissions,
      },
    });
    await manager.createAgent({ objective: "Inspect permissions", cwd: "/tmp", runtimeOptions });
    await sessions.restoreSession({
      sessionId: "conv-canonical-permissions",
      agentId: "agent_default",
      status: "waiting",
      metadata: { recovered: true },
    });
    await expect(
      manager.listPermissions({ sessionId: "conv-canonical-permissions" }),
    ).resolves.toEqual({ permissions: [] });
    await expect(
      manager.listPermissions({ sessionId: "daemon-session-permissions" }),
    ).resolves.toEqual({ permissions: [] });
    expect(listPermissions.mock.calls).toEqual([
      ["conv-canonical-permissions"],
      ["conv-canonical-permissions"],
    ]);
    await sessions.terminateSession({ sessionId: "daemon-session-permissions" });
    await expect(
      manager.listPermissions({ sessionId: "conv-canonical-permissions" }),
    ).rejects.toThrow("not found or closed");
    expect(listPermissions).toHaveBeenCalledTimes(2);
  });
});

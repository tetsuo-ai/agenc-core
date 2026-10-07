import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { mergeDaemonClientEnvironment } from "../../src/app-server/client-env-snapshot.js";
import { restoreRecoveredAgentRuntime } from "../../src/app-server/daemon-cli.js";
import type { AgenCBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import { resolveProviderBaseURLEnvironment } from "../../src/llm/registry/provider-ingress.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { RecoveredAgentRun } from "../../src/state/recovery.js";

const runtimeOptions = resolveAgentRuntimeOptions({});

const NO_CLIENT_ENVIRONMENT = { values: {}, withheldKeys: [] };

function recoveredRun(
  commandEnvironment?: unknown,
  extraMetadata: JsonObject = { sessionEnvironment: NO_CLIENT_ENVIRONMENT },
): RecoveredAgentRun {
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
      ...extraMetadata,
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

/** Startup restore must leave the run for its client without rebuilding it. */
async function expectLeftForClient(run: RecoveredAgentRun): Promise<void> {
  const restoreAgent = vi.fn(async () => true);
  await expect(
    restoreRecoveredAgentRuntime({ startAgent: vi.fn(), restoreAgent }, run),
  ).resolves.toEqual({ available: false });
  expect(restoreAgent).not.toHaveBeenCalled();
  expect(run.resumeSource?.close).toHaveBeenCalledOnce();
}

describe("daemon workflow authority", () => {
  it.each(["running", "suspended"] as const)("leaves %s Goals to workflow recovery without restoring a conversation", async (status) => {
    const ordinary = recoveredRun({ PATH: "/client/bin:/usr/bin" });
    const run: RecoveredAgentRun = {
      ...ordinary, status,
      metadata: { ...ordinary.metadata, kind: "verified-change-workflow" },
    };
    const restoreAgent = vi.fn(async () => true);
    await expect(restoreRecoveredAgentRuntime({ startAgent: vi.fn(), restoreAgent }, run))
      .resolves.toEqual({ available: false });
    expect(restoreAgent).not.toHaveBeenCalled();
    expect(run.resumeSource?.close).toHaveBeenCalledOnce();
  });

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
    "restores a supplied PATH or the daemon tool PATH for %j without provider credentials",
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
      expect(restoredEnvironment?.PATH).toBe(retainedPath || "/different-daemon/bin");
      expect(restoredEnvironment).not.toHaveProperty("XAI_API_KEY");
    },
  );

  it.each([undefined, {}, { PATH: 42 }, { PATH: "/client/bin", XAI_API_KEY: "secret" }])(
    "defers recovery without valid credential-free command authority %j",
    async (commandEnvironment) => {
      await expectLeftForClient(recoveredRun(commandEnvironment));
    },
  );

  it("records endpoint values and only the names of credentials for session recovery", async () => {
    const startAgent = vi.fn(async () => ({
      agentId: "conv-session-environment",
      agentPath: "/root",
      startedAt: "2026-09-10T01:00:00.000Z",
      status: "running" as const,
    }));
    const manager = new AgenCDaemonAgentManager({
      runner: { startAgent },
      sessionManager: new AgenCDaemonSessionManager(),
    });
    await manager.createAgent({
      objective: "Capture session environment",
      cwd: "/tmp",
      runtimeOptions,
      envOverrides: {
        PATH: "/client/bin:/usr/bin",
        AGENC_PROVIDER: "openai-compatible",
        OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4010/v1",
        OPENAI_COMPATIBLE_API_KEY: "fixture-secret",
        HTTPS_PROXY: "http://proxy-user:proxy-secret@proxy.example:8080",
      },
      metadata: {
        sessionEnvironment: {
          values: { OPENAI_COMPATIBLE_API_KEY: "forged" },
          withheldKeys: [],
        },
      },
    });
    const expected = {
      values: {
        AGENC_PROVIDER: "openai-compatible",
        OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4010/v1",
      },
      withheldKeys: ["HTTPS_PROXY", "OPENAI_COMPATIBLE_API_KEY"],
    };
    expect(startAgent.mock.calls[0]?.[0].metadata?.sessionEnvironment).toEqual(expected);
    const listed = await manager.listAgents();
    expect(listed.agents[0]?.metadata?.sessionEnvironment).toEqual(expected);
    for (const secret of ["fixture-secret", "proxy-secret", "forged"]) {
      expect(JSON.stringify(listed)).not.toContain(secret);
    }
  });

  it("restores the recorded provider endpoint, not the daemon's or the default", async () => {
    let restoredEnvironment: NodeJS.ProcessEnv | undefined;
    const restoreAgent = vi.fn(async (params) => {
      restoredEnvironment = mergeDaemonClientEnvironment(
        {
          PATH: "/daemon/bin",
          OPENAI_COMPATIBLE_BASE_URL: "http://daemon.example/v1",
          OPENAI_COMPATIBLE_API_KEY: "daemon-secret",
          GITHUB_TOKEN: "daemon-token",
        },
        params.envOverrides,
      );
      return true;
    });
    const run = recoveredRun({ PATH: "/client/bin" }, {
      provider: "openai-compatible",
      sessionEnvironment: {
        values: {
          AGENC_PROVIDER: "openai-compatible",
          OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4010/v1",
        },
        // A credential the provider never reads does not hold the runtime back.
        withheldKeys: ["GITHUB_TOKEN"],
      },
    });
    await expect(
      restoreRecoveredAgentRuntime({ startAgent: vi.fn(), restoreAgent }, run),
    ).resolves.toMatchObject({ available: true });
    expect(restoreAgent.mock.calls[0]?.[0].envOverrides).toEqual({
      AGENC_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4010/v1",
      PATH: "/client/bin",
    });
    expect(
      resolveProviderBaseURLEnvironment("openai-compatible", restoredEnvironment ?? {}),
    ).toEqual({
      envVar: "OPENAI_COMPATIBLE_BASE_URL",
      value: "http://127.0.0.1:4010/v1",
    });
    expect(restoredEnvironment).not.toHaveProperty("OPENAI_COMPATIBLE_API_KEY");
    expect(restoredEnvironment).not.toHaveProperty("GITHUB_TOKEN");
  });

  it.each([
    ["openai-compatible", "OPENAI_COMPATIBLE_API_KEY"],
    ["openai-compatible", "OPENAI_API_KEY"],
    ["grok", "XAI_API_KEY"],
    ["github", "GH_TOKEN"],
    ["amazon-bedrock", "AWS_SECRET_ACCESS_KEY"],
    ["grok", "AGENC_CLIENT_KEY_PASSPHRASE"],
    ["grok", "HTTPS_PROXY"],
    [undefined, "TAVILY_API_KEY"],
  ])(
    "leaves a %s run for its client when the client supplied %s",
    async (provider, withheldKey) => {
      await expectLeftForClient(
        recoveredRun({ PATH: "/client/bin" }, {
          ...(provider !== undefined ? { provider } : {}),
          sessionEnvironment: { values: {}, withheldKeys: [withheldKey] },
        }),
      );
    },
  );

  it.each([
    ["no record", {}],
    ["a record without withheld names", { sessionEnvironment: { values: {} } }],
    [
      "a recorded credential value",
      { sessionEnvironment: { values: { DEEPSEEK_API_KEY: "secret" }, withheldKeys: [] } },
    ],
    [
      "a recorded URL with user info",
      {
        sessionEnvironment: {
          values: { OPENAI_BASE_URL: "https://user:secret@llm.example/v1" },
          withheldKeys: [],
        },
      },
    ],
    [
      "an unknown withheld name",
      { sessionEnvironment: { values: {}, withheldKeys: ["RANDOM_SECRET"] } },
    ],
  ])("defers a run with %s for its session environment", async (_label, extraMetadata) => {
    await expectLeftForClient(
      recoveredRun({ PATH: "/client/bin" }, extraMetadata as JsonObject),
    );
  });

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

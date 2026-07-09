/**
 * Gateway SDK daemon-client tests (TODO task 34).
 *
 * The daemon has no default agent — a bare `session.create` binds to
 * `agent_default`, which nothing provisions, and the first message throws
 * `AgenC daemon agent not found`. These tests pin the fix: `createSession()`
 * spawns a PASSIVE background agent (empty initialContent = no turn-1 LLM
 * call) and adopts the agent's own session; `attachSession` resumes by id
 * through the SDK method that actually exists (`resumeSession`).
 *
 * Revert-sensitivity: against the pre-task-34 client (which called the
 * nonexistent `client.createSession`/`client.attachSession` SDK methods)
 * every test here fails.
 */

import { describe, expect, test } from "vitest";

import {
  createSdkDaemonClient,
  isDaemonAgentGoneError,
  type SdkModule,
} from "../../src/gateway/sdk-daemon-client.js";

interface SpawnCall {
  readonly objective: string;
  readonly initialContent: readonly never[];
  readonly cwd?: string;
  readonly permissionMode?: string;
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  readonly metadata?: Record<string, string>;
}

function fakeSdk(options: { sessionIdForSpawn?: string | null } = {}) {
  const spawnCalls: SpawnCall[] = [];
  const resumedIds: string[] = [];
  let closed = false;
  let connectOptions: Record<string, unknown> | undefined;
  const module: SdkModule = {
    async connect(connectArgs) {
      connectOptions = connectArgs;
      return {
        async spawnAgent(params: SpawnCall) {
          spawnCalls.push(params);
          const sessionId =
            options.sessionIdForSpawn === null
              ? undefined
              : (options.sessionIdForSpawn ?? `sess-of-agent-${spawnCalls.length}`);
          return {
            agentId: `agent-${spawnCalls.length}`,
            ...(sessionId !== undefined ? { sessionId } : {}),
          };
        },
        async resumeSession(sessionId: string) {
          resumedIds.push(sessionId);
          return {
            sessionId,
            prompt: () => {
              throw new Error("prompt not exercised in these tests");
            },
          };
        },
        async close() {
          closed = true;
        },
      };
    },
  };
  return {
    module,
    spawnCalls,
    resumedIds,
    isClosed: () => closed,
    connectOptions: () => connectOptions,
  };
}

describe("createSdkDaemonClient (daemon agent provisioning)", () => {
  test("createSession spawns a passive agent and adopts the agent's own session", async () => {
    const sdk = fakeSdk();
    const client = await createSdkDaemonClient({ sdk: sdk.module });

    const session = await client.createSession({ label: "tg|default|c1" });

    expect(sdk.spawnCalls).toHaveLength(1);
    // Passive: empty initialContent means the daemon runs NO turn-1 submit.
    expect(sdk.spawnCalls[0].initialContent).toEqual([]);
    expect(sdk.spawnCalls[0].objective).toBe("gateway: tg|default|c1");
    expect(sdk.spawnCalls[0].metadata).toMatchObject({
      source: "agenc-gateway",
      gatewayLabel: "tg|default|c1",
    });
    // The session is the AGENT'S session — the only one whose events the
    // daemon runner binds — not a fresh agent_default-bound session.
    expect(sdk.resumedIds).toEqual(["sess-of-agent-1"]);
    expect(session.sessionId).toBe("sess-of-agent-1");
  });

  test("createSession without a label uses the generic objective", async () => {
    const sdk = fakeSdk();
    const client = await createSdkDaemonClient({ sdk: sdk.module });

    await client.createSession();

    expect(sdk.spawnCalls[0].objective).toBe("gateway session");
    expect(sdk.spawnCalls[0].metadata).toEqual({ source: "agenc-gateway" });
  });

  test("createSession threads the configured cwd to the agent", async () => {
    const sdk = fakeSdk();
    const client = await createSdkDaemonClient({
      sdk: sdk.module,
      cwd: "/work/space",
    });

    await client.createSession();

    expect(sdk.spawnCalls[0].cwd).toBe("/work/space");
  });

  test("threads an explicit sanitized environment to SDK daemon autostart", async () => {
    const sdk = fakeSdk();
    const env = { PATH: "/usr/bin", SAFE_VALUE: "yes" };
    await createSdkDaemonClient({ sdk: sdk.module, env });

    expect(sdk.connectOptions()).toMatchObject({ env });
  });

  test("createSession threads gateway unattended policy to the agent", async () => {
    const sdk = fakeSdk();
    const client = await createSdkDaemonClient({
      sdk: sdk.module,
      unattendedAllow: ["SendUserMessage", "Brief"],
      unattendedDeny: ["Bash"],
    });

    await client.createSession({ label: "telegram|agent|group" });

    expect(sdk.spawnCalls[0]).toMatchObject({
      unattendedAllow: ["SendUserMessage", "Brief"],
      unattendedDeny: ["Bash"],
    });
    expect(sdk.spawnCalls[0].metadata).toMatchObject({
      unattendedAllow: "SendUserMessage,Brief",
      unattendedDeny: "Bash",
    });
  });

  test("createSession fails loudly when the agent has no session", async () => {
    const sdk = fakeSdk({ sessionIdForSpawn: null });
    const client = await createSdkDaemonClient({ sdk: sdk.module });

    await expect(client.createSession()).rejects.toThrow(
      /created without a session/,
    );
  });

  test("attachSession resumes the persisted session id without spawning", async () => {
    const sdk = fakeSdk();
    const client = await createSdkDaemonClient({ sdk: sdk.module });

    const session = await client.attachSession("persisted-id");

    expect(sdk.spawnCalls).toHaveLength(0);
    expect(sdk.resumedIds).toEqual(["persisted-id"]);
    expect(session.sessionId).toBe("persisted-id");
  });

  test("close closes the SDK client", async () => {
    const sdk = fakeSdk();
    const client = await createSdkDaemonClient({ sdk: sdk.module });
    await client.close();
    expect(sdk.isClosed()).toBe(true);
  });
});

describe("isDaemonAgentGoneError", () => {
  test("matches the daemon lifecycle error codes in error.data.code", () => {
    for (const code of [
      "AGENT_NOT_FOUND",
      "BACKGROUND_RUNNER_UNAVAILABLE",
      "SESSION_NOT_FOUND",
      "SESSION_CLOSED",
    ]) {
      const error = Object.assign(new Error("rpc failed"), {
        data: { code },
      });
      expect(isDaemonAgentGoneError(error)).toBe(true);
    }
  });

  test("falls back to the daemon's error message shapes", () => {
    for (const message of [
      "AgenC daemon agent not found: agent_default",
      "AgenC daemon agent not running: session-x",
      "AgenC daemon agent recovered without a live runtime: session-x",
      "AgenC daemon session not found or closed: session-y",
    ]) {
      expect(isDaemonAgentGoneError(new Error(message))).toBe(true);
    }
  });

  test("does not match unrelated errors", () => {
    expect(isDaemonAgentGoneError(new Error("network timeout"))).toBe(false);
    expect(
      isDaemonAgentGoneError(
        Object.assign(new Error("denied"), { data: { code: "INVALID_ARGUMENT" } }),
      ),
    ).toBe(false);
    expect(isDaemonAgentGoneError(null)).toBe(false);
    expect(isDaemonAgentGoneError("agent not found")).toBe(false);
  });
});

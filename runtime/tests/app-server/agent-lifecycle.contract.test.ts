import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgenCSessionSnapshotPolicy } from "../state/snapshot-policy.js";
import { upsertAgentRun } from "../state/agent-runs.js";
import { RolloutStore } from "../session/rollout-store.js";
import type { RolloutItem } from "../session/rollout-item.js";
import { FileThreadStore } from "../thread-store/store.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import {
  AgenCDaemonAgentLifecycleError,
  AgenCDaemonAgentManager,
} from "./agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
} from "./protocol/index.js";
import {
  AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
  createAgenCPortalAgentCreateRequest,
  createAgenCPortalAgentListRequest,
  createAgenCPortalAgentStopRequest,
  createAgenCPortalDaemonInitializeRequest,
} from "../app-server-protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import type {
  AgenCBackgroundAgentSnapshot,
  AgenCBackgroundAgentRunner,
  AgenCBackgroundAgentSessionEventBinding,
  AgenCBackgroundAgentStartParams,
} from "./background-agent-runner.js";

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}

function createThreadStoreTestDirs(): {
  readonly cwd: string;
  readonly home: string;
  readonly restoreEnv: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "agenc-agent-lifecycle-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "agenc-agent-lifecycle-home-"));
  const previous = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  return {
    cwd,
    home,
    restoreEnv: () => {
      if (previous === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previous;
    },
  };
}

function openRollout(cwd: string, sessionId: string): RolloutStore {
  const rollout = new RolloutStore({
    cwd,
    sessionId,
    agencVersion: "0.2.0",
  });
  rollout.open({
    sessionId,
    timestamp: "2026-05-01T12:30:00.000Z",
    cwd,
    originator: "agent-lifecycle-test",
    agencVersion: "0.2.0",
    model: "grok-4",
    modelProvider: "xai",
  });
  return rollout;
}

function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshotCount(driver: StateSqliteDriver, sessionId: string): number {
  return (
    driver
      .prepareState<[string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM session_state_snapshots
         WHERE session_id = ?`,
      )
      .get(sessionId)?.count ?? 0
  );
}

function latestSnapshot(
  driver: StateSqliteDriver,
  sessionId: string,
): {
  readonly conversation: unknown;
  readonly toolState: unknown;
} {
  const row = driver
    .prepareState<
      [string],
      { conversation_json: string; tool_state_json: string }
    >(
      `SELECT conversation_json, tool_state_json
       FROM session_state_snapshots
       WHERE session_id = ?
       ORDER BY snapshot_at DESC
       LIMIT 1`,
    )
    .get(sessionId);
  if (row === undefined) throw new Error("snapshot missing");
  return {
    conversation: JSON.parse(row.conversation_json),
    toolState: JSON.parse(row.tool_state_json),
  };
}

function agentRunRow(
  driver: StateSqliteDriver,
  agentId: string,
): {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly started_at: string;
  readonly last_active_at: string;
  readonly current_session_id: string | null;
} {
  const row = driver
    .prepareState<
      [string],
      {
        id: string;
        objective: string;
        status: string;
        started_at: string;
        last_active_at: string;
        current_session_id: string | null;
      }
    >(
      `SELECT
         id,
         objective,
         status,
         started_at,
         last_active_at,
         current_session_id
       FROM agent_runs
       WHERE id = ?`,
    )
    .get(agentId);
  if (row === undefined) throw new Error(`missing agent run ${agentId}`);
  return row;
}

function agentRunMetadata(
  driver: StateSqliteDriver,
  agentId: string,
): Record<string, unknown> {
  const row = driver
    .prepareState<[string], { metadata_json: string | null }>(
      `SELECT metadata_json
       FROM agent_runs
       WHERE id = ?`,
    )
    .get(agentId);
  if (row === undefined) throw new Error(`missing agent run ${agentId}`);
  return row.metadata_json === null ? {} : JSON.parse(row.metadata_json);
}

describe("AgenC background agent lifecycle", () => {
  it("lists stored on-disk agent threads after manager recreation", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "stored-agent");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "stored-agent",
        rolloutStore: rollout,
        source: "agent",
        cwd,
        model: "grok-4",
        modelProvider: "xai",
      });
      threadStore.updateThreadMetadata({
        threadId: "stored-agent",
        includeArchived: false,
        patch: { name: "Recovered objective" },
      });
      threadStore.shutdownThread("stored-agent");

      const recreated = new AgenCDaemonAgentManager({ threadStore });
      await expect(recreated.listAgents()).resolves.toMatchObject({
        agents: [
          {
            agentId: "stored-agent",
            objective: "Recovered objective",
            status: "idle",
            cwd,
            activeSessionIds: ["stored-agent"],
            metadata: {
              source: "agent",
              model: "grok-4",
              modelProvider: "xai",
              recovered: true,
            },
          },
        ],
      });
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reads stored agent rollout history as a plain transcript", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "stored-agent-log");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "stored-agent-log",
        rolloutStore: rollout,
        source: "agent",
        cwd,
      });
      rollout.appendRollout({
        type: "response_item",
        payload: { role: "user", content: "build the parser" },
      });
      rollout.appendRollout({
        type: "event_msg",
        payload: {
          id: "assistant-delta",
          msg: {
            type: "agent_message_delta",
            payload: { delta: "parser done" },
          },
        },
      });
      threadStore.shutdownThread("stored-agent-log");

      const recreated = new AgenCDaemonAgentManager({ threadStore });
      await expect(
        recreated.getAgentLogs({ agentId: "stored-agent-log" }),
      ).resolves.toMatchObject({
        agentId: "stored-agent-log",
        sessions: [
          {
            sessionId: "stored-agent-log",
            itemCount: 3,
          },
        ],
        transcript: expect.stringContaining("user:\nbuild the parser"),
      });
      await expect(
        recreated.getAgentLogs({ agentId: "stored-agent-log" }),
      ).resolves.toMatchObject({
        transcript: expect.stringContaining("assistant:\nparser done"),
      });
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("serves session.transcript from the persisted thread when no live agent exists", async () => {
    // A `conv-*` terminal session (source "cli_main") persists a thread but
    // runs its agent in its OWN process, so the daemon has no live agent for
    // it. session.transcript must fall back to the persisted thread store
    // instead of throwing "AgenC daemon agent not found/not running".
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "conv-terminal-fallback");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "conv-terminal-fallback",
        rolloutStore: rollout,
        source: "cli_main",
        cwd,
      });
      // response_item history (the same shape the live-agent path reads).
      rollout.appendRollout({
        type: "response_item",
        payload: { role: "user", content: "build the parser" },
      });
      rollout.appendRollout({
        type: "response_item",
        payload: {
          role: "assistant",
          content: [{ type: "text", text: "parser done" }],
        },
      });
      // event_msg user/agent messages (the persisted-event equivalents a
      // terminal session emits) must also surface.
      rollout.appendRollout({
        type: "event_msg",
        payload: {
          id: "user-event",
          msg: {
            type: "user_message",
            payload: { message: "and add tests", displayText: "and add tests" },
          },
        },
      });
      rollout.appendRollout({
        type: "event_msg",
        payload: {
          id: "agent-event",
          msg: { type: "agent_message", payload: { message: "tests added" } },
        },
      });
      threadStore.shutdownThread("conv-terminal-fallback");

      // No live agent: the session materializes from the thread store with
      // agentId "agent_default" but nothing is running for it.
      const sessions = new AgenCDaemonSessionManager({ threadStore });

      // Case A: a runner WITHOUT getAgentSessionTranscript (the
      // BACKGROUND_RUNNER_UNAVAILABLE branch) still serves the persisted
      // transcript instead of throwing.
      const noTranscriptRunner = new AgenCDaemonAgentManager({
        threadStore,
        sessionManager: sessions,
        runner: {
          startAgent: async () => ({
            agentId: "unused",
            startedAt: "2026-05-01T12:00:00.000Z",
            status: "running",
          }),
        },
      });
      await expect(
        noTranscriptRunner.getSessionTranscript({
          sessionId: "conv-terminal-fallback",
        }),
      ).resolves.toEqual({
        sessionId: "conv-terminal-fallback",
        messages: [
          { role: "user", text: "build the parser" },
          { role: "assistant", text: "parser done" },
          { role: "user", text: "and add tests" },
          { role: "assistant", text: "tests added" },
        ],
      });

      // Case B: a runner WITH getAgentSessionTranscript that throws the
      // "not running" error because the lifecycle map has no live agent for
      // the session — the resolve fails with AGENT_NOT_FOUND and we still
      // fall back to the persisted thread.
      const liveCapableRunner = new AgenCDaemonAgentManager({
        threadStore,
        sessionManager: sessions,
        runner: {
          startAgent: async () => ({
            agentId: "unused",
            startedAt: "2026-05-01T12:00:00.000Z",
            status: "running",
          }),
          getAgentSessionTranscript: async () => {
            throw new Error(
              "AgenC daemon agent not running: agent_default",
            );
          },
        },
      });
      await expect(
        liveCapableRunner.getSessionTranscript({
          sessionId: "conv-terminal-fallback",
        }),
      ).resolves.toMatchObject({
        sessionId: "conv-terminal-fallback",
        messages: expect.arrayContaining([
          { role: "user", text: "build the parser" },
          { role: "assistant", text: "parser done" },
        ]),
      });
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reads persisted agent logs when source agent id differs from thread id", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "thread-distinct-agent-log");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "thread-distinct-agent-log",
        rolloutStore: rollout,
        source: {
          kind: "agent",
          agentId: "agent-distinct-log",
          objective: "Distinct persisted objective",
        },
        cwd,
      });
      rollout.appendRollout({
        type: "response_item",
        payload: { role: "assistant", content: "distinct agent transcript" },
      });
      threadStore.shutdownThread("thread-distinct-agent-log");

      const recreated = new AgenCDaemonAgentManager({ threadStore });
      await expect(recreated.listAgents()).resolves.toMatchObject({
        agents: [
          {
            agentId: "agent-distinct-log",
            objective: "Distinct persisted objective",
            activeSessionIds: ["thread-distinct-agent-log"],
          },
        ],
      });
      await expect(
        recreated.getAgentLogs({ agentId: "agent-distinct-log" }),
      ).resolves.toMatchObject({
        agentId: "agent-distinct-log",
        sessions: [
          {
            sessionId: "thread-distinct-agent-log",
          },
        ],
        transcript: expect.stringContaining("distinct agent transcript"),
      });
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("attaches to persisted agents when source agent id differs from thread id", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "thread-distinct-agent-attach");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "thread-distinct-agent-attach",
        rolloutStore: rollout,
        source: {
          kind: "agent",
          agentId: "agent-distinct-attach",
          objective: "Attach persisted objective",
        },
        cwd,
      });
      threadStore.shutdownThread("thread-distinct-agent-attach");

      const sessionManager = new AgenCDaemonSessionManager({
        threadStore,
        createAttachmentId: sequence(["attachment-persisted-agent"]),
        now: sequence(["2026-05-01T12:31:00.000Z"]),
      });
      const recreated = new AgenCDaemonAgentManager({
        threadStore,
        sessionManager,
      });

      await expect(recreated.listAgents()).resolves.toMatchObject({
        agents: [
          {
            agentId: "agent-distinct-attach",
            objective: "Attach persisted objective",
            activeSessionIds: ["thread-distinct-agent-attach"],
          },
        ],
      });
      await expect(
        recreated.attachAgent({
          agentId: "agent-distinct-attach",
          clientId: "tui_1",
        }),
      ).resolves.toMatchObject({
        agentId: "agent-distinct-attach",
        attachmentId: "attachment-persisted-agent",
        runtimeSessionId: "agent-distinct-attach",
        sessionIds: ["thread-distinct-agent-attach"],
        sessions: [
          {
            sessionId: "thread-distinct-agent-attach",
            agentId: "agent-distinct-attach",
            status: "waiting",
          },
        ],
      });
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("gets persisted agents when source agent id differs from thread id", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "thread-distinct-agent-get");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "thread-distinct-agent-get",
        rolloutStore: rollout,
        source: {
          kind: "agent",
          agentId: "agent-distinct-get",
          objective: "Get persisted objective",
        },
        cwd,
      });
      threadStore.shutdownThread("thread-distinct-agent-get");

      const recreated = new AgenCDaemonAgentManager({ threadStore });

      await expect(recreated.listAgents()).resolves.toMatchObject({
        agents: [
          {
            agentId: "agent-distinct-get",
            objective: "Get persisted objective",
            activeSessionIds: ["thread-distinct-agent-get"],
          },
        ],
      });
      await expect(recreated.getAgent("agent-distinct-get")).resolves.toMatchObject(
        {
          agentId: "agent-distinct-get",
          objective: "Get persisted objective",
          activeSessionIds: ["thread-distinct-agent-get"],
        },
      );
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stops persisted agents when source agent id differs from thread id", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "thread-distinct-agent-stop");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "thread-distinct-agent-stop",
        rolloutStore: rollout,
        source: {
          kind: "agent",
          agentId: "agent-distinct-stop",
          objective: "Stop persisted objective",
        },
        cwd,
      });
      threadStore.shutdownThread("thread-distinct-agent-stop");

      const sessionManager = new AgenCDaemonSessionManager({
        threadStore,
        now: sequence(["2026-05-01T12:32:00.000Z"]),
      });
      const recreated = new AgenCDaemonAgentManager({
        threadStore,
        sessionManager,
        now: sequence(["2026-05-01T12:31:00.000Z"]),
      });

      await expect(recreated.listAgents()).resolves.toMatchObject({
        agents: [
          {
            agentId: "agent-distinct-stop",
            objective: "Stop persisted objective",
            activeSessionIds: ["thread-distinct-agent-stop"],
          },
        ],
      });
      await expect(
        recreated.stopAgent({
          agentId: "agent-distinct-stop",
          reason: "operator stop",
        }),
      ).resolves.toEqual({
        agentId: "agent-distinct-stop",
        stopped: true,
      });
      await expect(recreated.listAgents()).resolves.toEqual({ agents: [] });

      const fresh = new AgenCDaemonAgentManager({ threadStore });
      await expect(fresh.listAgents()).resolves.toEqual({ agents: [] });
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects logs for existing persisted non-agent thread ids", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "non-agent-thread-log");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "non-agent-thread-log",
        rolloutStore: rollout,
        source: "cli_main",
        cwd,
      });
      rollout.appendRollout({
        type: "response_item",
        payload: { role: "assistant", content: "not an agent transcript" },
      });
      threadStore.shutdownThread("non-agent-thread-log");

      const recreated = new AgenCDaemonAgentManager({ threadStore });
      await expect(recreated.listAgents()).resolves.toEqual({ agents: [] });
      await expect(
        recreated.getAgentLogs({ agentId: "non-agent-thread-log" }),
      ).rejects.toMatchObject({
        code: "AGENT_NOT_FOUND",
      });
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reads agent rollout history from the agent cwd when daemon cwd differs", async () => {
    const daemonCwd = mkdtempSync(join(tmpdir(), "agenc-agent-daemon-cwd-"));
    const agentCwd = mkdtempSync(join(tmpdir(), "agenc-agent-worker-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "agenc-agent-route-home-"));
    const previous = process.env.AGENC_HOME;
    process.env.AGENC_HOME = home;
    const rollout = openRollout(agentCwd, "session-agent-cwd-log");
    const daemonThreadStore = new FileThreadStore({
      cwd: daemonCwd,
      agencHome: home,
    });
    const agentThreadStore = new FileThreadStore({
      cwd: agentCwd,
      agencHome: home,
    });
    try {
      agentThreadStore.createThread({
        threadId: "session-agent-cwd-log",
        rolloutStore: rollout,
        source: "agent",
        cwd: agentCwd,
      });
      rollout.appendRollout({
        type: "response_item",
        payload: { role: "user", content: "inspect worker project" },
      });
      agentThreadStore.shutdownThread("session-agent-cwd-log");

      const routes: unknown[] = [];
      const recreated = new AgenCDaemonAgentManager({
        threadStore: daemonThreadStore,
        threadStoreForAgentLogs: (route) => {
          routes.push(route);
          return route.cwd === agentCwd ? agentThreadStore : daemonThreadStore;
        },
      });
      await recreated.restoreAgent({
        agentId: "agent-cwd-log",
        objective: "inspect project",
        cwd: agentCwd,
        sessionIds: ["session-agent-cwd-log"],
      });

      await expect(
        recreated.getAgentLogs({ agentId: "agent-cwd-log" }),
      ).resolves.toMatchObject({
        agentId: "agent-cwd-log",
        sessions: [
          {
            sessionId: "session-agent-cwd-log",
            itemCount: 2,
          },
        ],
        transcript: expect.stringContaining("inspect worker project"),
      });
      expect(routes).toEqual([
        {
          agentId: "agent-cwd-log",
          sessionIds: ["agent-cwd-log", "session-agent-cwd-log"],
          cwd: agentCwd,
        },
      ]);
    } finally {
      daemonThreadStore.close();
      agentThreadStore.close();
      rollout.close();
      if (previous === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previous;
      rmSync(home, { recursive: true, force: true });
      rmSync(agentCwd, { recursive: true, force: true });
      rmSync(daemonCwd, { recursive: true, force: true });
    }
  });

  it("includes generic log records for every persisted rollout item and event", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "stored-agent-full-log");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "stored-agent-full-log",
        rolloutStore: rollout,
        source: "agent",
        cwd,
      });
      rollout.appendRollout({
        type: "event_msg",
        payload: {
          id: "turn-started",
          msg: { type: "turn_started", payload: { turnId: "turn-1" } },
        },
      });
      rollout.appendRollout({
        type: "event_msg",
        payload: {
          id: "token-count",
          msg: {
            type: "token_count",
            payload: {
              promptTokens: 30,
              completionTokens: 12,
              totalTokens: 42,
              model: "grok-4",
              provider: "xai",
            },
          },
        },
      });
      rollout.appendRollout({
        type: "event_msg",
        payload: {
          id: "permission-request",
          msg: {
            type: "request_permissions",
            payload: {
              callId: "call-perms",
              toolName: "Bash",
              permissions: ["network"],
            },
          },
        },
      });
      rollout.appendRollout({
        type: "turn_context",
        payload: {
          turnId: "turn-1",
          model: "grok-4",
          provider: "xai",
        },
      } as RolloutItem);
      threadStore.shutdownThread("stored-agent-full-log");

      const recreated = new AgenCDaemonAgentManager({ threadStore });
      const result = await recreated.getAgentLogs({
        agentId: "stored-agent-full-log",
      });

      expect(result.transcript).toContain("rollout:session_meta");
      expect(result.transcript).toContain("event:turn_started");
      expect(result.transcript).toContain('"turnId": "turn-1"');
      expect(result.transcript).toContain("event:token_count");
      expect(result.transcript).toContain('"totalTokens": 42');
      expect(result.transcript).toContain("event:request_permissions");
      expect(result.transcript).toContain('"permissions":');
      expect(result.transcript).toContain("rollout:turn_context");
      expect(result.transcript).toContain('"provider": "xai"');
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("includes rotated tool-output reader results in agent logs", async () => {
    const agents = new AgenCDaemonAgentManager({
      readAgentToolOutputs: ({ sessionIds }) =>
        sessionIds.includes("session-output")
          ? [
              {
                sessionId: "session-output",
                toolCallId: "tool-output",
                toolName: "Bash",
                status: "completed",
                output: "abcdef",
                outputBytes: 6,
                outputLogPath: "/tmp/agenc/tool-output.log",
                outputLogBytes: 2,
              },
            ]
          : [],
    });
    await agents.restoreAgent({
      agentId: "agent-output",
      objective: "inspect output",
      sessionIds: ["session-output"],
    });

    await expect(
      agents.getAgentLogs({ agentId: "agent-output" }),
    ).resolves.toMatchObject({
      agentId: "agent-output",
      toolOutputs: [
        {
          sessionId: "session-output",
          toolCallId: "tool-output",
          output: "abcdef",
        },
      ],
      transcript: expect.stringContaining("tool_outputs"),
    });
  });

  it("retains stopped agent session ids for tool-output log reads", async () => {
    const outputSessionIds: string[][] = [];
    const stopAgent = vi.fn(async () => {});
    const agents = new AgenCDaemonAgentManager({
      runner: { stopAgent },
      readAgentToolOutputs: ({ sessionIds }) => {
        outputSessionIds.push([...sessionIds]);
        return sessionIds.includes("session-stopped-output")
          ? [
              {
                sessionId: "session-stopped-output",
                toolCallId: "tool-stopped-output",
                toolName: "Bash",
                status: "completed",
                output: "stopped output",
                outputBytes: 14,
              },
            ]
          : [];
      },
    });
    await agents.restoreAgent({
      agentId: "agent-stopped-output",
      objective: "inspect stopped output",
      sessionIds: ["session-stopped-output"],
    });

    await expect(
      agents.stopAgent({ agentId: "agent-stopped-output" }),
    ).resolves.toEqual({ agentId: "agent-stopped-output", stopped: true });
    await expect(
      agents.getAgentLogs({ agentId: "agent-stopped-output" }),
    ).resolves.toMatchObject({
      agentId: "agent-stopped-output",
      toolOutputs: [
        {
          sessionId: "session-stopped-output",
          toolCallId: "tool-stopped-output",
          output: "stopped output",
        },
      ],
      transcript: expect.stringContaining("stopped output"),
    });
    expect(outputSessionIds.at(-1)).toEqual([
      "agent-stopped-output",
      "session-stopped-output",
    ]);
  });

  it("allows restored agents marked runtime-available to accept messages", async () => {
    const sessions = new AgenCDaemonSessionManager({
      now: () => "2026-05-01T12:07:01.000Z",
    });
    await sessions.restoreSession({
      sessionId: "session-runtime-restored",
      agentId: "agent-runtime-restored",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const submitted: unknown[] = [];
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        submitAgentMessage: async (agentId, params) => {
          submitted.push({ agentId, params });
        },
      },
    });
    await agents.restoreAgent({
      agentId: "agent-runtime-restored",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-runtime-restored"],
      runtimeAvailable: true,
    });

    await expect(
      agents.streamAgentMessage({
        sessionId: "session-runtime-restored",
        content: "resume",
        messageId: "message-runtime-restored",
        streamId: "stream-runtime-restored",
        acceptedAt: "2026-05-01T12:06:00.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(submitted).toEqual([
      {
        agentId: "agent-runtime-restored",
        params: expect.objectContaining({
          sessionId: "session-runtime-restored",
          content: "resume",
        }),
      },
    ]);
  });

  it("routes session.clear to the runner that owns the daemon session", async () => {
    const sessions = new AgenCDaemonSessionManager({
      now: () => "2026-05-01T12:07:01.000Z",
    });
    await sessions.restoreSession({
      sessionId: "session-clear-restored",
      agentId: "agent-clear-restored",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const clearAgentSession = vi.fn(async () => {});
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: () => "2026-05-01T12:06:00.000Z",
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        clearAgentSession,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-clear-restored",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-clear-restored"],
      runtimeAvailable: true,
    });

    await expect(
      agents.clearSessionHistory({ sessionId: "session-clear-restored" }),
    ).resolves.toEqual({
      sessionId: "session-clear-restored",
      cleared: true,
      clearedAt: "2026-05-01T12:06:00.000Z",
    });
    expect(clearAgentSession).toHaveBeenCalledWith("agent-clear-restored", {
      sessionId: "session-clear-restored",
      clearedAt: "2026-05-01T12:06:00.000Z",
    });
  });

  it("routes session.mcp.addServer to the runner that owns the daemon session", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-mcp-restored",
      agentId: "agent-mcp-restored",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const addMcpServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 1,
    }));
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        addMcpServer,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-mcp-restored",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-mcp-restored"],
      runtimeAvailable: true,
    });

    await expect(
      agents.addMcpServerToSession({
        sessionId: "session-mcp-restored",
        config: {
          name: "audit-ping",
          transport: "stdio",
          command: "node",
          args: [".agenc/mcp/audit-ping.mjs"],
          enabled: true,
        },
      }),
    ).resolves.toEqual({
      sessionId: "session-mcp-restored",
      serverName: "audit-ping",
      success: true,
      toolCount: 1,
    });
    expect(addMcpServer).toHaveBeenCalledWith("agent-mcp-restored", {
      sessionId: "session-mcp-restored",
      config: {
        name: "audit-ping",
        transport: "stdio",
        command: "node",
        args: [".agenc/mcp/audit-ping.mjs"],
        enabled: true,
      },
    });
  });

  it("routes session.mcp.reconnect/enable/disable to the runner that owns the daemon session", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-mcp-restored",
      agentId: "agent-mcp-restored",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const reconnectMcpServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 4,
    }));
    const enableMcpServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 4,
    }));
    const disableMcpServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 0,
    }));
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        reconnectMcpServer,
        enableMcpServer,
        disableMcpServer,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-mcp-restored",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-mcp-restored"],
      runtimeAvailable: true,
    });

    await expect(
      agents.reconnectMcpServerOnSession({
        sessionId: "session-mcp-restored",
        serverName: "audit-ping",
      }),
    ).resolves.toEqual({
      sessionId: "session-mcp-restored",
      serverName: "audit-ping",
      success: true,
      toolCount: 4,
    });
    expect(reconnectMcpServer).toHaveBeenCalledWith("agent-mcp-restored", {
      sessionId: "session-mcp-restored",
      serverName: "audit-ping",
    });

    await expect(
      agents.enableMcpServerOnSession({
        sessionId: "session-mcp-restored",
        serverName: "audit-ping",
      }),
    ).resolves.toEqual({
      sessionId: "session-mcp-restored",
      serverName: "audit-ping",
      success: true,
      toolCount: 4,
    });
    expect(enableMcpServer).toHaveBeenCalledWith("agent-mcp-restored", {
      sessionId: "session-mcp-restored",
      serverName: "audit-ping",
    });

    await expect(
      agents.disableMcpServerOnSession({
        sessionId: "session-mcp-restored",
        serverName: "audit-ping",
      }),
    ).resolves.toEqual({
      sessionId: "session-mcp-restored",
      serverName: "audit-ping",
      success: true,
      toolCount: 0,
    });
    expect(disableMcpServer).toHaveBeenCalledWith("agent-mcp-restored", {
      sessionId: "session-mcp-restored",
      serverName: "audit-ping",
    });
  });

  it("routes session.cancelTurn to the runner's interruptAgentTurn for an active session", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-cancel-active",
      agentId: "agent-cancel-active",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const interruptAgentTurn = vi.fn(async () => true);
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: () => "2026-05-01T12:07:00.000Z",
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        interruptAgentTurn,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-cancel-active",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-cancel-active"],
      runtimeAvailable: true,
    });

    await expect(
      agents.cancelSessionTurn({
        sessionId: "session-cancel-active",
        reason: "user_interrupt",
      }),
    ).resolves.toEqual({
      sessionId: "session-cancel-active",
      cancelled: true,
      reason: "user_interrupt",
    });
    expect(interruptAgentTurn).toHaveBeenCalledWith(
      "agent-cancel-active",
      "user_interrupt",
    );
  });

  it("routes session.setModel to the runner that owns the daemon session", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-setmodel",
      agentId: "agent-setmodel",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const setAgentModel = vi.fn(async () => ({
      applied: true,
      summary: "Model switched to \"gpt-x\" on \"openai\".",
    }));
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        setAgentModel,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-setmodel",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-setmodel"],
      runtimeAvailable: true,
    });

    await expect(
      agents.setSessionModel({
        sessionId: "session-setmodel",
        model: "gpt-x",
        provider: "openai",
      }),
    ).resolves.toEqual({
      sessionId: "session-setmodel",
      applied: true,
      summary: "Model switched to \"gpt-x\" on \"openai\".",
    });
    expect(setAgentModel).toHaveBeenCalledWith("agent-setmodel", {
      sessionId: "session-setmodel",
      model: "gpt-x",
      provider: "openai",
    });
  });

  it("routes session.setPermissionMode to the runner that owns the daemon session", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-setmode",
      agentId: "agent-setmode",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const setAgentPermissionMode = vi.fn(async () => ({
      applied: true,
      previousMode: "default",
      mode: "plan",
    }));
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        setAgentPermissionMode,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-setmode",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-setmode"],
      runtimeAvailable: true,
    });

    await expect(
      agents.setSessionPermissionMode({
        sessionId: "session-setmode",
        mode: "plan",
      }),
    ).resolves.toEqual({
      sessionId: "session-setmode",
      applied: true,
      previousMode: "default",
      mode: "plan",
    });
    expect(setAgentPermissionMode).toHaveBeenCalledWith("agent-setmode", {
      sessionId: "session-setmode",
      mode: "plan",
    });
  });

  it("routes session.hooks.status to the runner that owns the daemon session", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-hooks",
      agentId: "agent-hooks",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const getAgentHooksStatus = vi.fn(async () => ({
      available: true,
      sourcePath: "/home/agent/.agenc/config.toml",
      disabled: false,
      issues: [],
      hooks: [
        {
          event: "PreToolUse",
          command: { type: "command", command: "printf ok" },
          source: "config",
          sourcePath: "/home/agent/.agenc/config.toml",
          enabled: true,
          index: 0,
        },
      ],
      diagnostics: [],
    }));
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        getAgentHooksStatus,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-hooks",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-hooks"],
      runtimeAvailable: true,
    });

    await expect(
      agents.getSessionHooksStatus({ sessionId: "session-hooks" }),
    ).resolves.toMatchObject({
      sessionId: "session-hooks",
      available: true,
      sourcePath: "/home/agent/.agenc/config.toml",
      hooks: [{ event: "PreToolUse", index: 0 }],
    });
    expect(getAgentHooksStatus).toHaveBeenCalledWith("agent-hooks");
  });

  it("routes session.hooks.setDisabled to the runner that owns the daemon session", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-hooks-toggle",
      agentId: "agent-hooks-toggle",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const setAgentHooksDisabled = vi.fn(async () => ({
      applied: true,
      disabled: true,
    }));
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        setAgentHooksDisabled,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-hooks-toggle",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-hooks-toggle"],
      runtimeAvailable: true,
    });

    await expect(
      agents.setSessionHooksDisabled({
        sessionId: "session-hooks-toggle",
        disabled: true,
      }),
    ).resolves.toEqual({
      sessionId: "session-hooks-toggle",
      applied: true,
      disabled: true,
    });
    expect(setAgentHooksDisabled).toHaveBeenCalledWith("agent-hooks-toggle", {
      disabled: true,
    });
  });

  it("routes session.applyConfig to the runner that owns the daemon session", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-applyconfig",
      agentId: "agent-applyconfig",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const applyAgentConfig = vi.fn(async () => ({
      applied: true,
      summary: "profile fast applied: reasoning effort ->high",
    }));
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        applyAgentConfig,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-applyconfig",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-applyconfig"],
      runtimeAvailable: true,
    });

    await expect(
      agents.applyConfigToSession({
        sessionId: "session-applyconfig",
        profile: "fast",
      }),
    ).resolves.toEqual({
      sessionId: "session-applyconfig",
      applied: true,
      summary: "profile fast applied: reasoning effort ->high",
    });
    expect(applyAgentConfig).toHaveBeenCalledWith("agent-applyconfig", {
      sessionId: "session-applyconfig",
      profile: "fast",
    });
  });

  it("rejects session.applyConfig when no runner is available", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-applyconfig-norunner",
      agentId: "agent-applyconfig-norunner",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
      },
    });
    await agents.restoreAgent({
      agentId: "agent-applyconfig-norunner",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-applyconfig-norunner"],
      runtimeAvailable: true,
    });

    await expect(
      agents.applyConfigToSession({
        sessionId: "session-applyconfig-norunner",
      }),
    ).rejects.toMatchObject({
      code: "BACKGROUND_RUNNER_UNAVAILABLE",
    });
  });

  it("does not cancel a recovered session without a live runtime", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-cancel-recovered",
      agentId: "agent-cancel-recovered",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "inspect recovery",
    });
    const interruptAgentTurn = vi.fn(async () => true);
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: () => "2026-05-01T12:07:00.000Z",
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        interruptAgentTurn,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-cancel-recovered",
      objective: "inspect recovery",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-cancel-recovered"],
      runtimeAvailable: false,
    });

    await expect(
      agents.attachAgent({ agentId: "agent-cancel-recovered" }),
    ).resolves.toMatchObject({
      sessionIds: ["session-cancel-recovered"],
    });
    await expect(
      agents.cancelSessionTurn({
        sessionId: "session-cancel-recovered",
        reason: "user_interrupt",
      }),
    ).resolves.toEqual({
      sessionId: "session-cancel-recovered",
      cancelled: false,
      reason: "user_interrupt",
    });
    expect(interruptAgentTurn).not.toHaveBeenCalled();
  });

  it("stops recovered agents without a live runtime when no runner stop is available", async () => {
    const sessions = new AgenCDaemonSessionManager({
      now: () => "2026-05-01T12:07:01.000Z",
    });
    await sessions.restoreSession({
      sessionId: "session-stop-recovered",
      agentId: "agent-stop-recovered",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "inspect recovery",
    });
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: sequence([
        "2026-05-01T12:07:00.000Z",
        "2026-05-01T12:07:01.000Z",
      ]),
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
      },
    });
    await agents.restoreAgent({
      agentId: "agent-stop-recovered",
      objective: "inspect recovery",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-stop-recovered"],
      runtimeAvailable: false,
    });

    await expect(
      agents.stopAgent({
        agentId: "agent-stop-recovered",
        reason: "operator stop",
      }),
    ).resolves.toEqual({
      agentId: "agent-stop-recovered",
      stopped: true,
    });
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(
      sessions.getSession("session-stop-recovered"),
    ).resolves.toMatchObject({
      status: "closed",
      closedAt: "2026-05-01T12:07:01.000Z",
    });
  });

  it("drops recovered agents after their only session is terminated", async () => {
    const sessions = new AgenCDaemonSessionManager({
      now: sequence([
        "2026-05-01T12:08:00.000Z",
        "2026-05-01T12:08:01.000Z",
      ]),
    });
    await sessions.restoreSession({
      sessionId: "session-terminate-recovered",
      agentId: "agent-terminate-recovered",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "inspect recovery",
    });
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: () => "2026-05-01T12:08:01.000Z",
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
      },
    });
    await agents.restoreAgent({
      agentId: "agent-terminate-recovered",
      objective: "inspect recovery",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-terminate-recovered"],
      runtimeAvailable: false,
    });

    await expect(agents.listAgents()).resolves.toMatchObject({
      agents: [
        {
          agentId: "agent-terminate-recovered",
          activeSessionIds: ["session-terminate-recovered"],
        },
      ],
    });
    await sessions.terminateSession({
      sessionId: "session-terminate-recovered",
      reason: "session.terminate",
    });

    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(
      agents.getAgent("agent-terminate-recovered"),
    ).resolves.toMatchObject({
      agentId: "agent-terminate-recovered",
      status: "stopped",
    });
    await expect(
      agents.attachAgent({ agentId: "agent-terminate-recovered" }),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("stops live agents after their only session is terminated", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session-terminate-live"]),
      now: sequence([
        "2026-05-01T12:09:00.000Z",
        "2026-05-01T12:09:01.000Z",
      ]),
    });
    const stopAgent = vi.fn(async () => {});
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: sequence([
        "2026-05-01T12:09:00.000Z",
        "2026-05-01T12:09:02.000Z",
      ]),
      runner: {
        startAgent: async () => ({
          agentId: "agent-terminate-live",
          startedAt: "2026-05-01T12:09:00.500Z",
          status: "running",
        }),
        stopAgent,
      },
    });

    await expect(
      agents.createAgent({ objective: "inspect live termination" }),
    ).resolves.toMatchObject({
      agentId: "agent-terminate-live",
      sessionId: "session-terminate-live",
    });
    await sessions.terminateSession({
      sessionId: "session-terminate-live",
      reason: "session.terminate",
    });

    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    expect(stopAgent).toHaveBeenCalledWith(
      "agent-terminate-live",
      "session_terminated",
    );
    await expect(agents.getAgent("agent-terminate-live")).resolves.toMatchObject(
      {
        agentId: "agent-terminate-live",
        status: "stopped",
      },
    );
    await expect(
      agents.attachAgent({ agentId: "agent-terminate-live" }),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("session.cancelTurn returns cancelled=false for an unknown session (idle no-op)", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const interruptAgentTurn = vi.fn(async () => false);
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: () => "2026-05-01T12:07:00.000Z",
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        interruptAgentTurn,
      },
    });

    await expect(
      agents.cancelSessionTurn({ sessionId: "nope" }),
    ).resolves.toEqual({
      sessionId: "nope",
      cancelled: false,
      reason: "interrupted",
    });
    expect(interruptAgentTurn).not.toHaveBeenCalled();
  });

  it("session.cancelTurn defaults reason to 'interrupted' when caller omits one", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-cancel-default",
      agentId: "agent-cancel-default",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const interruptAgentTurn = vi.fn(async () => true);
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: () => "2026-05-01T12:07:00.000Z",
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        interruptAgentTurn,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-cancel-default",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-cancel-default"],
      runtimeAvailable: true,
    });

    await agents.cancelSessionTurn({ sessionId: "session-cancel-default" });
    expect(interruptAgentTurn).toHaveBeenCalledWith(
      "agent-cancel-default",
      "interrupted",
    );
  });

  it("rejects session.clear for recovered agents without live runtime", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session-clear-recovered",
      agentId: "agent-clear-recovered",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const clearAgentSession = vi.fn(async () => {});
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        clearAgentSession,
      },
    });
    await agents.restoreAgent({
      agentId: "agent-clear-recovered",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session-clear-recovered"],
      runtimeAvailable: false,
    });

    await expect(
      agents.clearSessionHistory({ sessionId: "session-clear-recovered" }),
    ).rejects.toMatchObject({
      code: "BACKGROUND_RUNNER_UNAVAILABLE",
    });
    expect(clearAgentSession).not.toHaveBeenCalled();
  });

  it("rebinds restored runtime events so terminal status updates persist", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-agent-restore-events-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-agent-restore-events-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      const policy = new AgenCSessionSnapshotPolicy(driver, {
        now: sequence([
          "2026-05-01T12:05:00.000Z",
          "2026-05-01T12:05:00.000Z",
        ]),
      });
      upsertAgentRun(driver, {
        id: "agent-restored-terminal",
        objective: "recover terminal event",
        status: "running",
        startedAt: "2026-05-01T12:00:00.000Z",
        lastActiveAt: "2026-05-01T12:04:00.000Z",
        currentSessionId: "session-restored-terminal",
        metadata: {
          agentPath: "/root/agent-restored-terminal",
        },
      });
      const runner: AgenCBackgroundAgentRunner = {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        attachAgentSessionEvents: async (_agentId, binding) => {
          await binding.emit({
            jsonrpc: JSON_RPC_VERSION,
            method: "event.agent_status",
            params: {
              sessionId: binding.sessionId,
              eventId: "restored-terminal",
              agentId: "agent-restored-terminal",
              status: "idle",
              runStatus: "completed",
            },
          });
        },
      };
      const agents = new AgenCDaemonAgentManager({
        runner,
        broadcastSessionEvent: (sessionId, event) => {
          policy.recordSessionEvent(sessionId, event);
        },
      });

      await agents.restoreAgent({
        agentId: "agent-restored-terminal",
        objective: "recover terminal event",
        status: "idle",
        createdAt: "2026-05-01T12:00:00.000Z",
        startedAt: "2026-05-01T12:00:00.000Z",
        lastActiveAt: "2026-05-01T12:04:00.000Z",
        sessionIds: ["session-restored-terminal"],
        runtimeAvailable: true,
      });

      expect(agentRunRow(driver, "agent-restored-terminal")).toMatchObject({
        status: "completed",
        last_active_at: "2026-05-01T12:05:00.000Z",
        current_session_id: "session-restored-terminal",
      });
    } finally {
      driver.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("agent.create launches a running background agent and seeds its session", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence(["2026-05-01T12:00:01.000Z", "2026-05-01T12:00:02.000Z"]),
    });
    const starts: AgenCBackgroundAgentStartParams[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async (params) => {
        starts.push(params);
        return {
          agentId: "agent_1",
          agentPath: "/root/agent_1",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      runner,
      sessionManager: sessions,
    });

    await expect(
      agents.createAgent({
        objective: "  build the parser  ",
        metadata: { ticket: "F-06a" },
      }),
    ).resolves.toEqual({
      agentId: "agent_1",
      agentPath: "/root/agent_1",
      objective: "build the parser",
      status: "running",
      createdAt: "2026-05-01T12:00:00.000Z",
      startedAt: "2026-05-01T12:00:00.500Z",
      lastActiveAt: "2026-05-01T12:00:00.500Z",
      cwd: "/workspace",
      activeSessionIds: ["session_1"],
      metadata: {
        ticket: "F-06a",
        unattendedAllow: [],
        unattendedDeny: [],
      },
      sessionId: "session_1",
    });
    expect(starts).toEqual([
      {
        objective: "build the parser",
        cwd: "/workspace",
        metadata: {
          ticket: "F-06a",
          unattendedAllow: [],
          unattendedDeny: [],
        },
        unattendedAllow: [],
        unattendedDeny: [],
      },
    ]);
    await expect(sessions.getSession("session_1")).resolves.toEqual({
      sessionId: "session_1",
      agentId: "agent_1",
      status: "idle",
      createdAt: "2026-05-01T12:00:01.000Z",
      cwd: "/workspace",
      metadata: {
        ticket: "F-06a",
        objective: "build the parser",
        source: "agent.start",
        unattendedAllow: [],
        unattendedDeny: [],
      },
    });
    await expect(agents.listAgents()).resolves.toEqual({
      agents: [
        {
          agentId: "agent_1",
          agentPath: "/root/agent_1",
          objective: "build the parser",
          status: "running",
          createdAt: "2026-05-01T12:00:00.000Z",
          startedAt: "2026-05-01T12:00:00.500Z",
          lastActiveAt: "2026-05-01T12:00:00.500Z",
          cwd: "/workspace",
          activeSessionIds: ["session_1"],
          metadata: {
            ticket: "F-06a",
            unattendedAllow: [],
            unattendedDeny: [],
          },
        },
      ],
    });
    await expect(
      agents.attachAgent({ agentId: "agent_1", clientId: "tui_1" }),
    ).resolves.toEqual({
      agentId: "agent_1",
      attachmentId: "attachment_1",
      sessionIds: ["session_1"],
      runtimeSessionId: "agent_1",
      sessions: [
        {
          sessionId: "session_1",
          agentId: "agent_1",
          status: "idle",
          createdAt: "2026-05-01T12:00:01.000Z",
          cwd: "/workspace",
          metadata: {
            ticket: "F-06a",
            objective: "build the parser",
            source: "agent.start",
            unattendedAllow: [],
            unattendedDeny: [],
          },
          activeAttachmentIds: ["attachment_1"],
        },
      ],
    });
    await expect(sessions.getSession("session_1")).resolves.toMatchObject({
      activeAttachmentIds: ["attachment_1"],
    });
  });

  it("persists live agent run rows with current session ids and terminal stop state", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-agent-run-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-agent-run-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      const sessions = new AgenCDaemonSessionManager({
        createSessionId: sequence(["session_agent_run"]),
        now: sequence([
          "2026-05-01T12:00:01.000Z",
          "2026-05-01T12:00:03.000Z",
        ]),
      });
      const policy = new AgenCSessionSnapshotPolicy(driver);
      const runner: AgenCBackgroundAgentRunner = {
        startAgent: async () => ({
          agentId: "agent_run_live",
          agentPath: "/root/agent_run_live",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        stopAgent: async () => {},
      };
      const agents = new AgenCDaemonAgentManager({
        defaultCwd: () => cwd,
        now: sequence([
          "2026-05-01T12:00:00.000Z",
          "2026-05-01T12:00:02.000Z",
        ]),
        sessionManager: sessions,
        runner,
        recordAgentRun: (run) => {
          upsertAgentRun(driver, run);
        },
        recordAgentStatusTransition: (transition) => {
          policy.recordAgentStatusTransition(transition);
        },
      });

      await agents.createAgent({ objective: "persist me", cwd });
      expect(agentRunRow(driver, "agent_run_live")).toMatchObject({
        id: "agent_run_live",
        objective: "persist me",
        status: "running",
        started_at: "2026-05-01T12:00:00.500Z",
        last_active_at: "2026-05-01T12:00:00.500Z",
        current_session_id: "session_agent_run",
      });
      expect(agentRunMetadata(driver, "agent_run_live")).toMatchObject({
        agentPath: "/root/agent_run_live",
      });

      await expect(
        agents.stopAgent({
          agentId: "agent_run_live",
          reason: "operator stop",
        }),
      ).resolves.toEqual({ agentId: "agent_run_live", stopped: true });
      expect(agentRunRow(driver, "agent_run_live")).toMatchObject({
        status: "stopped",
        last_active_at: "2026-05-01T12:00:02.000Z",
        current_session_id: "session_agent_run",
      });
    } finally {
      driver.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps replayed terminal runner status from being overwritten by agent.create persistence", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-agent-run-replay-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-agent-run-replay-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      const sessions = new AgenCDaemonSessionManager({
        createSessionId: sequence(["session_replayed_terminal"]),
        now: sequence(["2026-05-01T12:00:01.000Z"]),
      });
      const policy = new AgenCSessionSnapshotPolicy(driver, {
        now: sequence([
          "2026-05-01T12:00:01.500Z",
          "2026-05-01T12:00:01.750Z",
          "2026-05-01T12:00:02.000Z",
          "2026-05-01T12:00:02.500Z",
        ]),
      });
      const runner: AgenCBackgroundAgentRunner = {
        startAgent: async () => ({
          agentId: "agent_replayed_terminal",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        attachAgentSessionEvents: async (_agentId, binding) => {
          await binding.emit({
            jsonrpc: JSON_RPC_VERSION,
            method: "event.agent_status",
            params: {
              sessionId: binding.sessionId,
              eventId: "terminal-replay",
              agentId: "agent_replayed_terminal",
              status: "stopped",
              runStatus: "completed",
            },
          });
        },
      };
      const agents = new AgenCDaemonAgentManager({
        defaultCwd: () => cwd,
        now: sequence(["2026-05-01T12:00:00.000Z"]),
        sessionManager: sessions,
        runner,
        broadcastSessionEvent: (sessionId, event) => {
          policy.recordSessionEvent(sessionId, event);
        },
        recordAgentStatusTransition: (transition) => {
          policy.recordAgentStatusTransition(transition);
        },
        recordAgentRun: (run) => {
          upsertAgentRun(driver, run);
        },
      });

      await agents.createAgent({ objective: "persist terminal replay", cwd });

      expect(agentRunRow(driver, "agent_replayed_terminal")).toMatchObject({
        id: "agent_replayed_terminal",
        objective: "persist terminal replay",
        status: "completed",
        started_at: "2026-05-01T12:00:00.500Z",
        last_active_at: "2026-05-01T12:00:01.750Z",
        current_session_id: "session_replayed_terminal",
      });
    } finally {
      driver.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("marks inserted agent run errored when agent.create rolls back after attach failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-agent-run-rollback-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-agent-run-rollback-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      const sessions = new AgenCDaemonSessionManager({
        createSessionId: sequence(["session_rollback"]),
        now: sequence(["2026-05-01T12:00:01.000Z"]),
      });
      const policy = new AgenCSessionSnapshotPolicy(driver, {
        now: sequence([
          "2026-05-01T12:00:01.500Z",
          "2026-05-01T12:00:02.500Z",
        ]),
      });
      const stopAgent = vi.fn(async () => {});
      const runner: AgenCBackgroundAgentRunner = {
        startAgent: async () => ({
          agentId: "agent_rollback",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        attachAgentSessionEvents: async () => {
          throw new Error("attach failed");
        },
        stopAgent,
      };
      const agents = new AgenCDaemonAgentManager({
        defaultCwd: () => cwd,
        now: sequence([
          "2026-05-01T12:00:00.000Z",
          "2026-05-01T12:00:03.000Z",
        ]),
        sessionManager: sessions,
        runner,
        recordAgentRun: (run) => {
          upsertAgentRun(driver, run);
        },
        recordAgentStatusTransition: (transition) => {
          policy.recordAgentStatusTransition(transition);
        },
      });

      await expect(
        agents.createAgent({ objective: "rollback attach failure", cwd }),
      ).rejects.toThrow("attach failed");
      expect(stopAgent).toHaveBeenCalledWith(
        "agent_rollback",
        "agent.create rollback after lifecycle failure",
      );
      expect(agentRunRow(driver, "agent_rollback")).toMatchObject({
        status: "errored",
        current_session_id: "session_rollback",
      });
    } finally {
      driver.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("agent.stop shuts down the runner and persists the stopped summary", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence([
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
        "2026-05-01T12:00:03.000Z",
      ]),
    });
    const stopAgent = vi.fn(async () => {});
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_stop",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z", "2026-05-01T12:00:02.000Z"]),
      runner,
      sessionManager: sessions,
    });

    await agents.createAgent({ objective: "build the parser" });
    await expect(
      agents.attachAgent({ agentId: "agent_stop", clientId: "tui_1" }),
    ).resolves.toMatchObject({
      agentId: "agent_stop",
      sessionIds: ["session_1"],
    });

    await expect(
      agents.stopAgent({ agentId: "agent_stop", reason: "operator stop" }),
    ).resolves.toEqual({ agentId: "agent_stop", stopped: true });
    expect(stopAgent).toHaveBeenCalledWith("agent_stop", "operator stop");
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(agents.getAgent("agent_stop")).resolves.toEqual({
      agentId: "agent_stop",
      objective: "build the parser",
      status: "stopped",
      createdAt: "2026-05-01T12:00:00.000Z",
      startedAt: "2026-05-01T12:00:00.500Z",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
      cwd: "/workspace",
      metadata: {
        unattendedAllow: [],
        unattendedDeny: [],
      },
    });
    const stoppedSession = await sessions.getSession("session_1");
    expect(stoppedSession).toMatchObject({
      status: "closed",
      closedAt: "2026-05-01T12:00:03.000Z",
    });
    expect(stoppedSession).not.toHaveProperty("activeAttachmentIds");
    await expect(
      agents.attachAgent({ agentId: "agent_stop" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await expect(agents.stopAgent({ agentId: "agent_stop" })).resolves.toEqual({
      agentId: "agent_stop",
      stopped: false,
    });
    expect(stopAgent).toHaveBeenCalledTimes(1);
  });

  it("stops all active background agents during daemon cleanup", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1", "session_2"]),
      createAttachmentId: sequence(["attachment_1", "attachment_2"]),
      now: sequence([
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
        "2026-05-01T12:00:05.000Z",
        "2026-05-01T12:00:06.000Z",
      ]),
    });
    const startedAgents = ["agent_one", "agent_two"];
    const stopAgent = vi.fn(async () => {});
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: startedAgents.shift()!,
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:00.250Z",
        "2026-05-01T12:00:03.000Z",
        "2026-05-01T12:00:04.000Z",
      ]),
      runner,
      sessionManager: sessions,
    });

    await agents.createAgent({ objective: "one" });
    await agents.createAgent({ objective: "two" });

    await expect(agents.stopAll("daemon_shutdown")).resolves.toBe(2);

    expect(stopAgent).toHaveBeenCalledWith("agent_one", "daemon_shutdown");
    expect(stopAgent).toHaveBeenCalledWith("agent_two", "daemon_shutdown");
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(sessions.getSession("session_1")).resolves.toMatchObject({
      status: "closed",
      closedAt: "2026-05-01T12:00:05.000Z",
    });
    await expect(sessions.getSession("session_2")).resolves.toMatchObject({
      status: "closed",
      closedAt: "2026-05-01T12:00:06.000Z",
    });
  });

  it("continues daemon cleanup when one background agent stop fails", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1", "session_2"]),
      createAttachmentId: sequence(["attachment_1", "attachment_2"]),
      now: sequence([
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
        "2026-05-01T12:00:05.000Z",
        "2026-05-01T12:00:06.000Z",
      ]),
    });
    const startedAgents = ["agent_one", "agent_two"];
    const stopAgent = vi.fn(async (agentId: string) => {
      if (agentId === "agent_one") {
        throw new Error("agent one failed to stop");
      }
    });
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: startedAgents.shift()!,
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:00.250Z",
        "2026-05-01T12:00:03.000Z",
        "2026-05-01T12:00:04.000Z",
      ]),
      runner,
      sessionManager: sessions,
    });

    await agents.createAgent({ objective: "one" });
    await agents.createAgent({ objective: "two" });

    await expect(agents.stopAll("daemon_shutdown")).rejects.toThrow(
      "AgenC daemon cleanup failed for 1 agent(s): agent_one",
    );

    expect(stopAgent).toHaveBeenCalledWith("agent_one", "daemon_shutdown");
    expect(stopAgent).toHaveBeenCalledWith("agent_two", "daemon_shutdown");
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(agents.getAgent("agent_one")).resolves.toMatchObject({
      status: "error",
      lastActiveAt: "2026-05-01T12:00:03.000Z",
    });
    await expect(agents.getAgent("agent_two")).resolves.toMatchObject({
      status: "stopped",
      lastActiveAt: "2026-05-01T12:00:04.000Z",
    });
    await expect(sessions.getSession("session_1")).resolves.toMatchObject({
      status: "closed",
      closedAt: "2026-05-01T12:00:05.000Z",
    });
    await expect(sessions.getSession("session_2")).resolves.toMatchObject({
      status: "closed",
      closedAt: "2026-05-01T12:00:06.000Z",
    });
  });

  it("waits for in-flight agent.create before daemon cleanup snapshots agents", async () => {
    const started = createDeferred<{
      readonly agentId: string;
      readonly startedAt: string;
      readonly status: "running";
    }>();
    const stopAgent = vi.fn(async () => {});
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: vi.fn(async () => started.promise),
      stopAgent,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      runner,
    });

    const create = agents.createAgent({ objective: "late create" });
    await Promise.resolve();
    const stopAll = agents.stopAll("daemon_shutdown");
    started.resolve({
      agentId: "agent_late",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running",
    });

    await expect(create).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "agent.start cancelled because the daemon is shutting down",
    });
    await expect(stopAll).resolves.toBe(0);
    expect(stopAgent).toHaveBeenCalledWith("agent_late", "daemon_shutdown");
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(
      agents.createAgent({ objective: "after shutdown" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "agent.start rejected because the daemon is shutting down",
    });
  });

  it("flushes daemon agent snapshots after cleanup transitions", async () => {
    const flushed: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_snapshot",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent: vi.fn(async () => {}),
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
      runner,
      snapshotFlush: async (snapshot) => {
        flushed.push(snapshot);
      },
    });

    await agents.createAgent({ objective: "snapshot me" });
    await agents.stopAll("daemon_shutdown");

    await expect(agents.flushSnapshots("daemon_shutdown")).resolves.toBe(1);
    expect(flushed).toEqual([
      {
        reason: "daemon_shutdown",
        flushedAt: "2026-05-01T12:00:02.000Z",
        agents: [
          {
            agentId: "agent_snapshot",
            objective: "snapshot me",
            status: "stopped",
            createdAt: "2026-05-01T12:00:00.000Z",
            startedAt: "2026-05-01T12:00:00.500Z",
            lastActiveAt: "2026-05-01T12:00:01.000Z",
            cwd: "/workspace",
            metadata: {
              unattendedAllow: [],
              unattendedDeny: [],
            },
          },
        ],
      },
    ]);
  });

  it("keeps final stop state durable while runner shutdown is in flight", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:01.000Z", "2026-05-01T12:00:03.000Z"]),
    });
    const stopStarted = createDeferred();
    const releaseStop = createDeferred();
    let stopping = false;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_race",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      getAgentSnapshot: async () =>
        stopping
          ? null
          : {
              status: "running",
              lastActiveAt: "2026-05-01T12:00:00.500Z",
            },
      stopAgent: async () => {
        stopping = true;
        stopStarted.resolve(undefined);
        await releaseStop.promise;
      },
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z", "2026-05-01T12:00:02.000Z"]),
      runner,
      sessionManager: sessions,
    });

    await agents.createAgent({ objective: "race stop" });
    const stop = agents.stopAgent({ agentId: "agent_race" });
    await stopStarted.promise;

    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(agents.getAgent("agent_race")).resolves.toMatchObject({
      agentId: "agent_race",
      status: "stopping",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
    });
    await expect(
      agents.attachAgent({ agentId: "agent_race" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    releaseStop.resolve(undefined);
    await expect(stop).resolves.toEqual({
      agentId: "agent_race",
      stopped: true,
    });
    await expect(agents.getAgent("agent_race")).resolves.toMatchObject({
      agentId: "agent_race",
      status: "stopped",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
    });
  });

  it("keeps stop failures from being reported as successful stops", async () => {
    const statusSnapshots: unknown[] = [];
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_fail_stop"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_fail_stop",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent: async () => {
        throw new Error("shutdown failed");
      },
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z", "2026-05-01T12:00:02.000Z"]),
      runner,
      sessionManager: sessions,
      recordAgentStatusTransition: async (transition) => {
        statusSnapshots.push(transition);
      },
    });

    await agents.createAgent({ objective: "fail stop" });
    await expect(
      agents.stopAgent({ agentId: "agent_fail_stop" }),
    ).rejects.toThrow("shutdown failed");
    await expect(agents.getAgent("agent_fail_stop")).resolves.toMatchObject({
      agentId: "agent_fail_stop",
      status: "error",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
    });
    expect(statusSnapshots).toEqual([
      {
        sessionId: "session_fail_stop",
        agentId: "agent_fail_stop",
        cwd: "/workspace",
        status: "running",
        transitionAt: "2026-05-01T12:00:00.500Z",
      },
      {
        sessionId: "session_fail_stop",
        agentId: "agent_fail_stop",
        cwd: "/workspace",
        status: "stopping",
        transitionAt: "2026-05-01T12:00:02.000Z",
        reason: "agent.stop",
      },
      {
        sessionId: "session_fail_stop",
        agentId: "agent_fail_stop",
        cwd: "/workspace",
        status: "error",
        transitionAt: "2026-05-01T12:00:02.000Z",
        reason: "agent.stop",
      },
    ]);
  });

  it("refreshes active list status while retaining runner-missing agents", async () => {
    const snapshots = new Map<string, AgenCBackgroundAgentSnapshot | null>();
    const ids = ["agent_active", "agent_done"];
    let startIndex = 0;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => {
        const agentId = ids[startIndex];
        if (agentId === undefined) throw new Error("unexpected start");
        startIndex += 1;
        snapshots.set(agentId, {
          status: "running",
          lastActiveAt: "2026-05-01T12:00:00.500Z",
        });
        return {
          agentId,
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
      getAgentSnapshot: async (agentId) => snapshots.get(agentId) ?? null,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z", "2026-05-01T12:00:01.000Z"]),
      runner,
    });

    await agents.createAgent({ objective: "watch active work" });
    await agents.createAgent({ objective: "finish quickly" });
    snapshots.set("agent_active", {
      status: "idle",
      lastActiveAt: "2026-05-01T12:00:03.000Z",
    });
    snapshots.set("agent_done", null);

    await expect(agents.listAgents()).resolves.toEqual({
      agents: [
        {
          agentId: "agent_active",
          objective: "watch active work",
          status: "idle",
          createdAt: "2026-05-01T12:00:00.000Z",
          startedAt: "2026-05-01T12:00:00.500Z",
          lastActiveAt: "2026-05-01T12:00:03.000Z",
          cwd: "/workspace",
          metadata: {
            unattendedAllow: [],
            unattendedDeny: [],
          },
        },
        {
          agentId: "agent_done",
          objective: "finish quickly",
          status: "running",
          createdAt: "2026-05-01T12:00:01.000Z",
          startedAt: "2026-05-01T12:00:00.500Z",
          lastActiveAt: "2026-05-01T12:00:00.500Z",
          cwd: "/workspace",
          metadata: {
            unattendedAllow: [],
            unattendedDeny: [],
          },
        },
      ],
    });
    await expect(agents.getAgent("agent_done")).resolves.toMatchObject({
      agentId: "agent_done",
      status: "running",
    });
  });

  it("paginates active agents by stable id boundary under churn", async () => {
    const snapshots = new Map<string, AgenCBackgroundAgentSnapshot | null>();
    const ids = ["agent_1", "agent_2", "agent_3"];
    let startIndex = 0;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => {
        const agentId = ids[startIndex];
        if (agentId === undefined) throw new Error("unexpected start");
        startIndex += 1;
        snapshots.set(agentId, {
          status: "running",
          lastActiveAt: "2026-05-01T12:00:00.500Z",
        });
        return {
          agentId,
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
      getAgentSnapshot: async (agentId) => snapshots.get(agentId) ?? null,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
      runner,
    });

    await agents.createAgent({ objective: "first" });
    await agents.createAgent({ objective: "second" });
    await agents.createAgent({ objective: "third" });

    await expect(agents.listAgents({ limit: 2 })).resolves.toMatchObject({
      agents: [
        { agentId: "agent_1", objective: "first" },
        { agentId: "agent_2", objective: "second" },
      ],
      nextCursor: "agent_2",
    });

    snapshots.set("agent_1", null);
    await expect(
      agents.listAgents({ limit: 2, cursor: "agent_2" }),
    ).resolves.toMatchObject({
      agents: [{ agentId: "agent_3", objective: "third" }],
    });
  });

  it("passes startup multimodal content to the background runner atomically", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_image"]),
      createAttachmentId: sequence(["attachment_image"]),
      now: sequence(["2026-05-01T12:00:01.000Z"]),
    });
    const starts: AgenCBackgroundAgentStartParams[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async (params) => {
        starts.push(params);
        return {
          agentId: "agent_image",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
      submitAgentMessage: async () => {
        throw new Error("startup content must not use message.stream");
      },
    };
    const agents = new AgenCDaemonAgentManager({
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      runner,
      sessionManager: sessions,
    });

    await expect(
      agents.createAgent({
        objective: "describe this",
        initialContent: [
          { type: "text", text: "describe this" },
          {
            type: "image_url",
            image_url: { url: "file:///tmp/cat.png" },
          },
        ],
      }),
    ).resolves.toMatchObject({
      agentId: "agent_image",
      sessionId: "session_image",
    });

    expect(starts).toEqual([
      expect.objectContaining({
        objective: "describe this",
        initialContent: [
          { type: "text", text: "describe this" },
          {
            type: "image_url",
            image_url: { url: "file:///tmp/cat.png" },
          },
        ],
      }),
    ]);
    await expect(sessions.getSession("session_image")).resolves.toMatchObject({
      metadata: expect.objectContaining({
        objective: "describe this",
        source: "agent.start",
      }),
    });
  });

  it("preserves structured message.stream content for the background runner", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const submitted: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_structured",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      submitAgentMessage: async (agentId, params) => {
        submitted.push({ agentId, params });
      },
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ objective: "inspect image" });

    await agents.streamAgentMessage({
      sessionId: "session_1",
      content: [
        { type: "text", text: "inspect" },
        {
          type: "image_url",
          image_url: { url: "file:///tmp/screenshot.png" },
        },
      ],
      messageId: "message_1",
      streamId: "stream_1",
      acceptedAt: "2026-05-01T12:00:01.000Z",
      displayUserMessage: null,
    });

    expect(submitted).toEqual([
      {
        agentId: "agent_structured",
        params: {
          sessionId: "session_1",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/screenshot.png" },
            },
          ],
          originalContent: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/screenshot.png" },
            },
          ],
          displayUserMessage: null,
          messageId: "message_1",
          streamId: "stream_1",
          acceptedAt: "2026-05-01T12:00:01.000Z",
        },
      },
    ]);
  });

  it("records snapshot-policy hooks for agent status and message exchanges", async () => {
    const cwd = "/tmp/agenc-snapshot-policy-cwd";
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_snapshot"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const statusSnapshots: unknown[] = [];
    const messageSnapshots: unknown[] = [];
    const sessionRoutes: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_snapshot_policy",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      submitAgentMessage: async () => {},
    };
    const agents = new AgenCDaemonAgentManager({
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      sessionManager: sessions,
      runner,
      recordAgentStatusTransition: async (transition) => {
        statusSnapshots.push(transition);
      },
      recordMessageExchange: async (exchange) => {
        messageSnapshots.push(exchange);
      },
      registerSnapshotSession: async (session) => {
        sessionRoutes.push(session);
      },
    });

    await agents.createAgent({ objective: "snapshot policy", cwd });
    await agents.streamAgentMessage({
      sessionId: "session_snapshot",
      content: "continue",
      messageId: "message_snapshot",
      streamId: "stream_snapshot",
      acceptedAt: "2026-05-01T12:00:01.000Z",
    });

    expect(statusSnapshots).toEqual([
      {
        sessionId: "session_snapshot",
        agentId: "agent_snapshot_policy",
        cwd,
        status: "running",
        transitionAt: "2026-05-01T12:00:00.500Z",
      },
    ]);
    expect(messageSnapshots).toEqual([
      {
        sessionId: "session_snapshot",
        agentId: "agent_snapshot_policy",
        cwd,
        content: "continue",
        messageId: "message_snapshot",
        streamId: "stream_snapshot",
        acceptedAt: "2026-05-01T12:00:01.000Z",
      },
    ]);
    expect(sessionRoutes).toEqual([
      {
        sessionId: "session_snapshot",
        agentId: "agent_snapshot_policy",
        cwd,
      },
    ]);
  });

  it("deduplicates runner events and lifecycle hooks in snapshot policy", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-lifecycle-snapshot-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-lifecycle-snapshot-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      const sessions = new AgenCDaemonSessionManager({
        createSessionId: sequence(["session_combined_snapshot"]),
        now: sequence(["2026-05-01T12:00:00.000Z"]),
      });
      const policy = new AgenCSessionSnapshotPolicy(driver, {
        now: sequence([
          "2026-05-01T12:00:00.500Z",
          "2026-05-01T12:00:01.000Z",
          "2026-05-01T12:00:02.000Z",
          "2026-05-01T12:00:03.000Z",
        ]),
      });
      let binding: AgenCBackgroundAgentSessionEventBinding | undefined;
      const runner: AgenCBackgroundAgentRunner = {
        startAgent: async () => ({
          agentId: "agent_combined_snapshot",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        attachAgentSessionEvents: async (_agentId, nextBinding) => {
          binding = nextBinding;
          await nextBinding.emit({
            jsonrpc: JSON_RPC_VERSION,
            method: "event.agent_status",
            params: {
              sessionId: nextBinding.sessionId,
              eventId: "status-start",
              agentId: "agent_combined_snapshot",
              status: "running",
            },
          });
        },
        submitAgentMessage: async (_agentId, params) => {
          await binding?.emit({
            jsonrpc: JSON_RPC_VERSION,
            method: "event.session_event",
            params: {
              sessionId: params.sessionId,
              eventId: params.messageId,
              agentId: "agent_combined_snapshot",
              event: {
                id: params.messageId,
                type: "user_message",
                messageId: params.messageId,
                streamId: params.streamId,
                acceptedAt: params.acceptedAt,
                payload: {
                  message: params.originalContent,
                  displayText: "continue",
                },
              },
            },
          });
        },
      };
      const agents = new AgenCDaemonAgentManager({
        defaultCwd: () => cwd,
        now: sequence(["2026-05-01T12:00:00.000Z"]),
        sessionManager: sessions,
        runner,
        broadcastSessionEvent: (sessionId, event) => {
          policy.recordSessionEvent(sessionId, event);
        },
        recordAgentStatusTransition: (transition) => {
          policy.recordAgentStatusTransition(transition);
        },
        recordMessageExchange: (exchange) => {
          policy.recordMessageExchange(exchange);
        },
      });

      await agents.createAgent({ objective: "dedupe snapshots", cwd });
      await agents.streamAgentMessage({
        sessionId: "session_combined_snapshot",
        content: "continue",
        messageId: "message_combined_snapshot",
        streamId: "stream_combined_snapshot",
        acceptedAt: "2026-05-01T12:00:01.000Z",
      });

      expect(snapshotCount(driver, "session_combined_snapshot")).toBe(2);
      expect(latestSnapshot(driver, "session_combined_snapshot")).toMatchObject(
        {
          conversation: [
            {
              role: "user",
              messageId: "message_combined_snapshot",
            },
          ],
          toolState: {
            statusTransitions: [
              {
                agentId: "agent_combined_snapshot",
                status: "running",
              },
            ],
          },
        },
      );
    } finally {
      driver.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records runner-observed status transitions during refresh", async () => {
    const cwd = "/tmp/agenc-status-refresh";
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_status_refresh"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const statusSnapshots: unknown[] = [];
    let currentSnapshot: AgenCBackgroundAgentSnapshot = {
      status: "running",
      lastActiveAt: "2026-05-01T12:00:00.500Z",
    };
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_status_refresh",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      getAgentSnapshot: async () => currentSnapshot,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => cwd,
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      sessionManager: sessions,
      runner,
      recordAgentStatusTransition: async (transition) => {
        statusSnapshots.push(transition);
      },
    });

    await agents.createAgent({ objective: "watch status" });
    currentSnapshot = {
      status: "idle",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
    };
    await expect(agents.listAgents()).resolves.toMatchObject({
      agents: [{ agentId: "agent_status_refresh", status: "idle" }],
    });

    expect(statusSnapshots).toEqual([
      {
        sessionId: "session_status_refresh",
        agentId: "agent_status_refresh",
        cwd,
        status: "running",
        transitionAt: "2026-05-01T12:00:00.500Z",
      },
      {
        sessionId: "session_status_refresh",
        agentId: "agent_status_refresh",
        cwd,
        status: "idle",
        transitionAt: "2026-05-01T12:00:02.000Z",
      },
    ]);
  });

  it("persists runner snapshot metadata during status refresh", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-agent-budget-refresh-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-agent-budget-refresh-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      const sessions = new AgenCDaemonSessionManager({
        createSessionId: sequence(["session_budget_refresh"]),
        now: sequence(["2026-05-01T12:00:00.000Z"]),
      });
      const policy = new AgenCSessionSnapshotPolicy(driver, {
        now: sequence([
          "2026-05-01T12:00:00.500Z",
          "2026-05-01T12:00:02.000Z",
        ]),
      });
      const budgetHalt = {
        kind: "token_cap",
        cap: 10,
        observed: 12,
        reason: "agent budget token_cap reached: 12 tokens >= 10",
      };
      let currentSnapshot: AgenCBackgroundAgentSnapshot = {
        status: "running",
        lastActiveAt: "2026-05-01T12:00:00.500Z",
      };
      const runner: AgenCBackgroundAgentRunner = {
        startAgent: async () => ({
          agentId: "agent_budget_refresh",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        getAgentSnapshot: async () => currentSnapshot,
      };
      const agents = new AgenCDaemonAgentManager({
        defaultCwd: () => cwd,
        now: sequence(["2026-05-01T12:00:00.000Z"]),
        sessionManager: sessions,
        runner,
        recordAgentRun: (run) => {
          upsertAgentRun(driver, run);
        },
        recordAgentStatusTransition: (transition) => {
          policy.recordAgentStatusTransition(transition);
        },
      });

      await agents.createAgent({ objective: "watch budget status" });
      currentSnapshot = {
        status: "stopped",
        lastActiveAt: "2026-05-01T12:00:02.000Z",
        metadata: { budgetHalt },
      };
      await expect(agents.listAgents()).resolves.toEqual({ agents: [] });

      expect(agentRunRow(driver, "agent_budget_refresh")).toMatchObject({
        status: "stopped",
        last_active_at: "2026-05-01T12:00:02.000Z",
        current_session_id: "session_budget_refresh",
      });
      expect(agentRunMetadata(driver, "agent_budget_refresh")).toMatchObject({
        budgetHalt,
      });
      expect(latestSnapshot(driver, "session_budget_refresh").toolState)
        .toMatchObject({
          statusTransitions: [
            { agentId: "agent_budget_refresh", status: "running" },
            {
              agentId: "agent_budget_refresh",
              status: "stopped",
              metadataPatch: { budgetHalt },
            },
          ],
        });
    } finally {
      driver.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not fail create or message delivery when snapshot hooks fail", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_snapshot_error"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const submitted: unknown[] = [];
    const errors: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_snapshot_error",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      submitAgentMessage: async (agentId, params) => {
        submitted.push({ agentId, params });
      },
    };
    const agents = new AgenCDaemonAgentManager({
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      sessionManager: sessions,
      runner,
      recordAgentStatusTransition: async () => {
        throw new Error("status snapshot unavailable");
      },
      recordMessageExchange: async () => {
        throw new Error("message snapshot unavailable");
      },
      onSnapshotError: (error) => {
        errors.push(error);
      },
    });

    await expect(
      agents.createAgent({ objective: "snapshot failures should not block" }),
    ).resolves.toMatchObject({
      agentId: "agent_snapshot_error",
      sessionId: "session_snapshot_error",
    });
    await expect(
      agents.streamAgentMessage({
        sessionId: "session_snapshot_error",
        content: "continue",
        messageId: "message_snapshot_error",
        streamId: "stream_snapshot_error",
        acceptedAt: "2026-05-01T12:00:01.000Z",
      }),
    ).resolves.toBeUndefined();

    expect(submitted).toHaveLength(1);
    expect(errors.map((error) => (error as Error).message)).toEqual([
      "status snapshot unavailable",
      "message snapshot unavailable",
    ]);
  });

  it("rejects agent attach for missing and closed sessions", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1", "session_2"]),
      createAttachmentId: sequence(["attachment_inactive"]),
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
        "2026-05-01T12:00:03.000Z",
      ]),
    });
    let active = true;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: active ? "agent_closed" : "agent_inactive",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      getAgentSnapshot: async (agentId) =>
        agentId === "agent_inactive" && !active
          ? null
          : {
              status: "running",
              lastActiveAt: "2026-05-01T12:00:00.500Z",
            },
    };
    const agents = new AgenCDaemonAgentManager({
      runner,
      sessionManager: sessions,
    });

    await expect(
      agents.attachAgent({ agentId: "agent_missing" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    await agents.createAgent({ objective: "closed session" });
    await sessions.terminateSession({
      sessionId: "session_1",
      reason: "test closed",
    });
    await expect(
      agents.attachAgent({ agentId: "agent_closed" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    active = false;
    await agents.createAgent({ objective: "inactive before attach" });
    await expect(
      agents.attachAgent({ agentId: "agent_inactive" }),
    ).resolves.toMatchObject({
      agentId: "agent_inactive",
      attachmentId: "attachment_inactive",
      sessionIds: ["session_2"],
      runtimeSessionId: "agent_inactive",
    });
  });

  it("does not report running when no background runner is available", async () => {
    const agents = new AgenCDaemonAgentManager();

    await expect(
      agents.createAgent({ objective: "build the parser" }),
    ).rejects.toMatchObject({
      code: "BACKGROUND_RUNNER_UNAVAILABLE",
    });
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
  });

  it("stops a launched agent when lifecycle session creation fails", async () => {
    const stopAgent = vi.fn(async () => {});
    const agents = new AgenCDaemonAgentManager({
      runner: {
        startAgent: async () => ({
          agentId: "agent_orphan",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        stopAgent,
      },
      sessionManager: {
        createSession: async () => {
          throw new Error("session store unavailable");
        },
      } as unknown as AgenCDaemonSessionManager,
    });

    await expect(
      agents.createAgent({ objective: "build the parser" }),
    ).rejects.toThrow("session store unavailable");
    expect(stopAgent).toHaveBeenCalledWith(
      "agent_orphan",
      "agent.create rollback after lifecycle failure",
    );
    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
  });

  it("rejects a blank agent start objective", async () => {
    const agents = new AgenCDaemonAgentManager({
      runner: {
        startAgent: async () => {
          throw new Error("runner should not start");
        },
      },
    });
    await expect(
      agents.createAgent({ objective: "   " }),
    ).rejects.toBeInstanceOf(AgenCDaemonAgentLifecycleError);
  });

  it("requires initialize before agent.create on a daemon JSON-RPC connection", async () => {
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_rpc",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent: vi.fn(async () => {}),
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence(["2026-05-01T12:00:00.000Z", "2026-05-01T12:00:01.000Z"]),
      runner,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
      initializeAuthenticator: (params) =>
        params.authCookie === "secret-cookie",
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-init",
        method: "initialize",
        params: [],
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-init",
      error: {
        code: -32602,
        message: "daemon request params must be an object",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "missing-protocol",
        method: "initialize",
        params: {},
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "missing-protocol",
      error: {
        code: -32602,
        message: "initialize requires protocol.version or protocolVersion",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "mismatched-protocol",
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          protocol: { version: "1.1.0" },
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "mismatched-protocol",
      error: {
        code: -32602,
        message: "initialize protocolVersion must match protocol.version",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "future-protocol",
        method: "initialize",
        params: {
          protocol: { version: "1.1.0" },
          clientName: "contract-test",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "future-protocol",
      error: {
        code: -32000,
        message: "Unsupported protocol version",
        data: {
          code: "PROTOCOL_VERSION_UNSUPPORTED",
          clientVersion: "1.1.0",
          serverVersion: "1.0.0",
        },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "auth",
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          protocol: { version: "1.0.0" },
          clientName: "contract-test",
          authCookie: "wrong-cookie",
          capabilities: {},
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "auth",
      error: {
        code: -32000,
        message: "daemon connection authentication failed",
        data: { code: "CONNECTION_AUTHENTICATION_FAILED" },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "agent.create",
        params: { objective: "ship a daemon task", cwd: "/repo" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      error: {
        code: -32000,
        message: "Not initialized",
        data: { code: "CONNECTION_NOT_INITIALIZED" },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          protocol: { version: "1.0.0" },
          clientName: "contract-test",
          authCookie: "secret-cookie",
          capabilities: { experimentalApi: true },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: {
        type: "initialized",
        protocolVersion: "1.0.0",
        protocol: { version: "1.0.0" },
        capabilities: {},
      },
    });
    expect(connection.initializeState).toMatchObject({
      protocol: { version: "1.0.0" },
      clientProtocol: { version: "1.0.0" },
      serverProtocol: { version: "1.0.0" },
      clientCapabilities: { experimentalApi: true },
    });
    expect(
      connection.initializeState?.serverCapabilities[
        AGENC_DAEMON_METHOD_CAPABILITIES_KEY
      ],
    ).toMatchObject({
      "agent.create": true,
      "session.create": false,
      "daemon.reload": false,
      "auth.login": false,
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "dupe-init",
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          protocol: { version: "1.0.0" },
          clientName: "contract-test",
          authCookie: "secret-cookie",
          capabilities: {},
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "dupe-init",
      error: {
        code: -32000,
        message: "Already initialized",
        data: { code: "CONNECTION_ALREADY_INITIALIZED" },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "agent.create",
        params: { objective: "ship a daemon task", cwd: "/repo" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      result: {
        agentId: "agent_rpc",
        objective: "ship a daemon task",
        status: "running",
        createdAt: "2026-05-01T12:00:00.000Z",
        startedAt: "2026-05-01T12:00:00.500Z",
        lastActiveAt: "2026-05-01T12:00:00.500Z",
        cwd: "/repo",
        metadata: {
          unattendedAllow: [],
          unattendedDeny: [],
        },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 3,
        method: "agent.list",
        params: { limit: 1 },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 3,
      result: {
        agents: [
          {
            agentId: "agent_rpc",
            objective: "ship a daemon task",
            status: "running",
            createdAt: "2026-05-01T12:00:00.000Z",
            startedAt: "2026-05-01T12:00:00.500Z",
            lastActiveAt: "2026-05-01T12:00:00.500Z",
            cwd: "/repo",
            metadata: {
              unattendedAllow: [],
              unattendedDeny: [],
            },
          },
        ],
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "logs",
        method: "agent.logs",
        params: { agentId: "agent_rpc" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "logs",
      result: {
        agentId: "agent_rpc",
        sessions: [],
        transcript: "agent_id\tagent_rpc\nNo transcript entries",
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 4,
        method: "agent.stop",
        params: { agentId: "agent_rpc" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 4,
      result: {
        agentId: "agent_rpc",
        stopped: true,
      },
    });
    expect(runner.stopAgent).toHaveBeenCalledWith("agent_rpc", "agent.stop");
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 5,
        method: "agent.list",
        params: { limit: 1 },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 5,
      result: {
        agents: [],
      },
    });
  });

  it("rejects malformed agent.create params before launching the runner", async () => {
    const startAgent = vi.fn(async () => ({
      agentId: "agent_bad",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running" as const,
    }));
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager({
        runner: { startAgent },
      }),
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1.0.0", clientName: "contract-test" },
      }),
    ).resolves.toMatchObject({
      result: { type: "initialized" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-create",
        method: "agent.create",
        params: [],
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-create",
      error: {
        code: -32602,
        message: "daemon request params must be an object",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "agent.create",
        params: { objective: 42 },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      error: {
        code: -32602,
        message: "agent.create param 'objective' must be a string",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-list",
        method: "agent.list",
        params: { limit: "many" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-list",
      error: {
        code: -32602,
        message: "agent.list param 'limit' must be a number",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-attach",
        method: "agent.attach",
        params: { clientId: "tui_1" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-attach",
      error: {
        code: -32602,
        message: "agent.attach requires agentId",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-stop",
        method: "agent.stop",
        params: { reason: "missing id" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-stop",
      error: {
        code: -32602,
        message: "agent.stop requires agentId",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-logs",
        method: "agent.logs",
        params: {},
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-logs",
      error: {
        code: -32602,
        message: "agent.logs requires agentId",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-stream-content",
        method: "message.stream",
        params: {
          sessionId: "session_1",
          content: [{ type: "image", text: "not allowed" }],
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-stream-content",
      error: {
        code: -32602,
        message:
          "message.stream param 'content[0]' must be a text or image_url block",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 3,
        method: "agent.create",
        params: { objective: "ship", unattendedAllow: "FileRead" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 3,
      error: {
        code: -32602,
        message:
          "agent.create param 'unattendedAllow' must be an array of strings",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: 4,
        method: "agent.create",
        params: { objective: "ship", metadata: [] },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 4,
      error: {
        code: -32602,
        message: "agent.create param 'metadata' must be an object",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-env-overrides",
        method: "agent.create",
        params: {
          objective: "ship",
          envOverrides: { AGENC_MCP_SERVERS: [] },
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-env-overrides",
      error: {
        code: -32602,
        message:
          "agent.create param 'envOverrides.AGENC_MCP_SERVERS' must be a string",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    expect(startAgent).not.toHaveBeenCalled();
  });

  it("dispatches portal session attach and message.send through JSON-RPC", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_portal"]),
      createAttachmentId: sequence(["attachment_portal"]),
      now: sequence([
        "2026-05-01T12:10:00.000Z",
        "2026-05-01T12:10:01.000Z",
      ]),
    });
    const submitted: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_portal",
        startedAt: "2026-05-01T12:10:00.500Z",
        status: "running",
      }),
      submitAgentMessage: async (agentId, params) => {
        submitted.push({ agentId, params });
      },
    };
    const agents = new AgenCDaemonAgentManager({
      now: sequence(["2026-05-01T12:10:00.250Z"]),
      runner,
      sessionManager: sessions,
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
      clientMultiplexer,
      sessionManager: sessions,
      now: sequence(["2026-05-01T12:10:02.000Z"]),
    });
    const connection = dispatcher.createConnection({ sendNotification: () => {} });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "init",
        method: "initialize",
        params: { protocolVersion: "1.0.0", clientName: "portal-test" },
      }),
    ).resolves.toMatchObject({ result: { type: "initialized" } });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "create",
        method: "agent.create",
        params: { objective: "answer from the portal" },
      }),
    ).resolves.toMatchObject({
      result: {
        agentId: "agent_portal",
        sessionId: "session_portal",
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "sessions",
        method: "session.list",
        params: { agentId: "agent_portal", limit: 10 },
      }),
    ).resolves.toMatchObject({
      result: {
        sessions: [
          {
            agentId: "agent_portal",
            sessionId: "session_portal",
          },
        ],
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach",
        method: "session.attach",
        params: { sessionId: "session_portal", clientId: "portal-ui" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "attach",
      result: {
        sessionId: "session_portal",
        attachmentId: "attachment_portal",
        attachedAt: "2026-05-01T12:10:01.000Z",
        clientId: "portal-ui",
        activeAttachmentIds: ["attachment_portal"],
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "send",
        method: "message.send",
        params: {
          sessionId: "session_portal",
          content: "Continue from the portal",
          clientMessageId: "portal-message-1",
          metadata: { displayUserMessage: "Continue from the portal" },
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "send",
      result: {
        messageId: "portal-message-1",
        acceptedAt: "2026-05-01T12:10:02.000Z",
      },
    });
    expect(submitted).toEqual([
      {
        agentId: "agent_portal",
        params: {
          sessionId: "session_portal",
          content: "Continue from the portal",
          originalContent: "Continue from the portal",
          displayUserMessage: "Continue from the portal",
          messageId: "portal-message-1",
          streamId: "portal-message-1",
          acceptedAt: "2026-05-01T12:10:02.000Z",
        },
      },
    ]);
  });

  it("dispatches portal background agent dashboard list/start/stop through JSON-RPC", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_dashboard"]),
      now: sequence([
        "2026-05-01T12:15:01.000Z",
        "2026-05-01T12:15:03.000Z",
      ]),
    });
    const starts: AgenCBackgroundAgentStartParams[] = [];
    const stopAgent = vi.fn(async () => {});
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async (params) => {
        starts.push(params);
        return {
          agentId: "agent_dashboard",
          startedAt: "2026-05-01T12:15:00.500Z",
          status: "running",
        };
      },
      stopAgent,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/workspace",
      now: sequence([
        "2026-05-01T12:15:00.000Z",
        "2026-05-01T12:15:02.000Z",
      ]),
      runner,
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch(createAgenCPortalDaemonInitializeRequest()),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "initialize",
      result: {
        type: "initialized",
        protocolVersion: "1.0.0",
      },
    });
    expect(connection.initializeState?.clientCapabilities).toEqual(
      AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
    );
    await expect(
      connection.dispatch(createAgenCPortalAgentListRequest({ limit: 5 })),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "agent.list",
      result: {
        agents: [],
      },
    });
    await expect(
      connection.dispatch(
        createAgenCPortalAgentCreateRequest(
          {
            objective: "  index queued work  ",
            cwd: "/workspace",
            unattendedAllow: ["FileRead"],
            metadata: { source: "portal.dashboard" },
          },
          "start-background",
        ),
      ),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "start-background",
      result: {
        agentId: "agent_dashboard",
        sessionId: "session_dashboard",
        objective: "index queued work",
        status: "running",
        cwd: "/workspace",
        activeSessionIds: ["session_dashboard"],
        metadata: {
          source: "portal.dashboard",
          unattendedAllow: ["FileRead"],
          unattendedDeny: [],
        },
      },
    });
    expect(starts).toEqual([
      {
        objective: "index queued work",
        cwd: "/workspace",
        metadata: {
          source: "portal.dashboard",
          unattendedAllow: ["FileRead"],
          unattendedDeny: [],
        },
        unattendedAllow: ["FileRead"],
        unattendedDeny: [],
      },
    ]);
    await expect(
      connection.dispatch(
        createAgenCPortalAgentListRequest({ limit: 5 }, "list-background"),
      ),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "list-background",
      result: {
        agents: [
          {
            agentId: "agent_dashboard",
            objective: "index queued work",
            status: "running",
            activeSessionIds: ["session_dashboard"],
          },
        ],
      },
    });
    await expect(
      connection.dispatch(
        createAgenCPortalAgentStopRequest(
          "agent_dashboard",
          "portal dashboard stop",
          "stop-background",
        ),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "stop-background",
      result: {
        agentId: "agent_dashboard",
        stopped: true,
      },
    });
    expect(stopAgent).toHaveBeenCalledWith(
      "agent_dashboard",
      "portal dashboard stop",
    );
    await expect(
      connection.dispatch(
        createAgenCPortalAgentListRequest({ limit: 5 }, "list-after-stop"),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "list-after-stop",
      result: {
        agents: [],
      },
    });
  });

  it("validates WP-04 dispatcher params and message.send errors", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_edge"]),
      now: sequence(["2026-05-01T12:20:00.000Z"]),
    });
    const submitted: unknown[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_edge",
        startedAt: "2026-05-01T12:20:00.500Z",
        status: "running",
      }),
      submitAgentMessage: async (agentId, params) => {
        submitted.push({ agentId, params });
      },
    };
    const agents = new AgenCDaemonAgentManager({
      now: sequence(["2026-05-01T12:20:00.250Z"]),
      runner,
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
      sessionManager: sessions,
      now: sequence([
        "2026-05-01T12:20:02.000Z",
        "2026-05-01T12:20:03.000Z",
      ]),
    });
    const connection = dispatcher.createConnection();

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "portal-test" },
    });
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "create",
      method: "agent.create",
      params: { objective: "validate portal actions" },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-session-list",
        method: "session.list",
        params: { limit: "many" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-session-list",
      error: {
        code: -32602,
        message: "session.list param 'limit' must be a number",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-session-attach",
        method: "session.attach",
        params: { clientId: "portal-ui" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-session-attach",
      error: {
        code: -32602,
        message: "session.attach requires sessionId",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "structured-send",
        method: "message.send",
        params: {
          sessionId: "session_edge",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/portal.png" },
            },
          ],
          clientMessageId: "portal-structured",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "structured-send",
      result: {
        messageId: "portal-structured",
        acceptedAt: "2026-05-01T12:20:02.000Z",
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-display",
        method: "message.send",
        params: {
          sessionId: "session_edge",
          content: "continue",
          clientMessageId: "portal-bad-display",
          metadata: { displayUserMessage: 42 },
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-display",
      error: {
        code: -32602,
        message:
          "message.send metadata 'displayUserMessage' must be a string or null",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    expect(submitted).toEqual([
      {
        agentId: "agent_edge",
        params: {
          sessionId: "session_edge",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/portal.png" },
            },
          ],
          originalContent: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/portal.png" },
            },
          ],
          messageId: "portal-structured",
          streamId: "portal-structured",
          acceptedAt: "2026-05-01T12:20:02.000Z",
        },
      },
    ]);
  });

  it("reports message.send service availability with message.send errors", async () => {
    const noSessionManager = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    }).createConnection();
    await noSessionManager.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init-no-session-manager",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "portal-test" },
    });
    await expect(
      noSessionManager.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "send-no-session-manager",
        method: "message.send",
        params: { sessionId: "session_missing", content: "continue" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "send-no-session-manager",
      error: {
        code: -32602,
        message: "message.send requires a daemon session manager",
        data: { code: "INVALID_ARGUMENT" },
      },
    });

    const sessions = new AgenCDaemonSessionManager();
    const noRunner = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager({ sessionManager: sessions }),
      sessionManager: sessions,
    }).createConnection();
    await noRunner.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init-no-runner",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "portal-test" },
    });
    await expect(
      noRunner.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "send-no-runner",
        method: "message.send",
        params: { sessionId: "session_missing", content: "continue" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "send-no-runner",
      error: {
        code: -32602,
        message: "message.send requires a background runner",
        data: { code: "BACKGROUND_RUNNER_UNAVAILABLE" },
      },
    });
  });

  it("dispatches session.clear through JSON-RPC to daemon-owned history", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session_rpc_clear",
      agentId: "agent_rpc_clear",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const clearAgentSession = vi.fn(async () => {});
    const agentManager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: () => "2026-05-01T12:06:00.000Z",
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        clearAgentSession,
      },
    });
    await agentManager.restoreAgent({
      agentId: "agent_rpc_clear",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session_rpc_clear"],
      runtimeAvailable: true,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init-clear",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "portal-test" },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "clear-session",
        method: "session.clear",
        params: { sessionId: "session_rpc_clear" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "clear-session",
      result: {
        sessionId: "session_rpc_clear",
        cleared: true,
        clearedAt: "2026-05-01T12:06:00.000Z",
      },
    });
    expect(clearAgentSession).toHaveBeenCalledWith("agent_rpc_clear", {
      sessionId: "session_rpc_clear",
      clearedAt: "2026-05-01T12:06:00.000Z",
    });
  });

  it("dispatches internal TUI partial compaction through JSON-RPC to daemon-owned history", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session_rpc_compact",
      agentId: "agent_rpc_compact",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const partialCompactFromMessage = vi.fn(async () => ({
      sessionId: "session_rpc_compact",
      ok: true,
      eventAlreadyEmitted: true,
      message: "Conversation summarized",
    }));
    const agentManager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        partialCompactFromMessage,
      },
    });
    await agentManager.restoreAgent({
      agentId: "agent_rpc_compact",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session_rpc_compact"],
      runtimeAvailable: true,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init-partial-compact",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "tui-test" },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "partial-compact-session",
        method: "session.partialCompactFromMessage",
        params: {
          sessionId: "session_rpc_compact",
          messageOrdinal: 1,
          direction: "from",
          feedback: "keep decisions",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "partial-compact-session",
      result: {
        sessionId: "session_rpc_compact",
        ok: true,
        eventAlreadyEmitted: true,
        message: "Conversation summarized",
      },
    });
    expect(partialCompactFromMessage).toHaveBeenCalledWith(
      "agent_rpc_compact",
      {
        sessionId: "session_rpc_compact",
        messageOrdinal: 1,
        direction: "from",
        feedback: "keep decisions",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("dispatches internal TUI conversation rewind through JSON-RPC to daemon-owned history", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session_rpc_rewind",
      agentId: "agent_rpc_rewind",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const rewindConversationToMessage = vi.fn(async () => ({
      sessionId: "session_rpc_rewind",
      ok: true,
      eventAlreadyEmitted: true,
      message: "Conversation rewound",
    }));
    const agentManager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        rewindConversationToMessage,
      },
    });
    await agentManager.restoreAgent({
      agentId: "agent_rpc_rewind",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session_rpc_rewind"],
      runtimeAvailable: true,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init-rewind",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "tui-test" },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "rewind-session",
        method: "session.rewindConversationToMessage",
        params: {
          sessionId: "session_rpc_rewind",
          messageOrdinal: 1,
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "rewind-session",
      result: {
        sessionId: "session_rpc_rewind",
        ok: true,
        eventAlreadyEmitted: true,
        message: "Conversation rewound",
      },
    });
    expect(rewindConversationToMessage).toHaveBeenCalledWith(
      "agent_rpc_rewind",
      expect.objectContaining({
        sessionId: "session_rpc_rewind",
        messageOrdinal: 1,
      }),
    );
  });

  it("cancels internal TUI partial compaction through request.cancel", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session_rpc_compact_cancel",
      agentId: "agent_rpc_compact_cancel",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "continue work",
    });
    const compactStarted = createDeferred();
    let observedSignal: AbortSignal | undefined;
    const partialCompactFromMessage = vi.fn(async (_agentId, params) => {
      observedSignal = params.signal;
      compactStarted.resolve(undefined);
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted === true) {
          resolve();
          return;
        }
        params.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return {
        sessionId: params.sessionId,
        ok: false,
        eventAlreadyEmitted: false,
        code: "ABORTED",
        message: "Conversation summarization was cancelled.",
      };
    });
    const agentManager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        partialCompactFromMessage,
      },
    });
    await agentManager.restoreAgent({
      agentId: "agent_rpc_compact_cancel",
      objective: "continue work",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session_rpc_compact_cancel"],
      runtimeAvailable: true,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init-partial-compact-cancel",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "tui-test" },
    });

    const compacting = connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "partial-compact-cancel",
      method: "session.partialCompactFromMessage",
      params: {
        sessionId: "session_rpc_compact_cancel",
        messageOrdinal: 0,
        direction: "from",
      },
    });
    await compactStarted.promise;

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "cancel-partial-compact",
        method: "request.cancel",
        params: {
          requestId: "partial-compact-cancel",
          reason: "selector closed",
        },
      }),
    ).resolves.toMatchObject({
      result: {
        requestId: "partial-compact-cancel",
        cancelled: true,
        reason: "selector closed",
      },
    });

    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe("selector closed");
    await expect(compacting).resolves.toMatchObject({
      error: {
        code: -32000,
        data: {
          code: "REQUEST_CANCELLED",
          requestId: "partial-compact-cancel",
          reason: "selector closed",
        },
      },
    });
  });

  it("cleans up portal client registration after failed session.attach", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_after_failure", "session_second"]),
      createAttachmentId: sequence([
        "attachment_after_failure",
        "attachment_second",
      ]),
      now: sequence([
        "2026-05-01T12:30:00.000Z",
        "2026-05-01T12:30:01.000Z",
        "2026-05-01T12:30:02.000Z",
        "2026-05-01T12:30:03.000Z",
      ]),
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      clientMultiplexer,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection({ sendNotification: () => {} });

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "portal-test" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach-missing",
        method: "session.attach",
        params: {
          sessionId: "session_missing",
          clientId: "portal-tab",
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "attach-missing",
      error: {
        message: "AgenC daemon session not found: session_missing",
      },
    });

    await sessions.createSession({ agentId: "agent_cleanup" });
    await sessions.createSession({ agentId: "agent_cleanup" });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach-after-cleanup",
        method: "session.attach",
        params: {
          sessionId: "session_after_failure",
          clientId: "portal-tab",
        },
      }),
    ).resolves.toMatchObject({
      result: {
        sessionId: "session_after_failure",
        attachmentId: "attachment_after_failure",
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach-same-connection",
        method: "session.attach",
        params: {
          sessionId: "session_second",
          clientId: "portal-tab",
        },
      }),
    ).resolves.toMatchObject({
      result: {
        sessionId: "session_second",
        attachmentId: "attachment_second",
      },
    });
  });

  it("routes daemon tool approval decisions to the background runner", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const decisions: unknown[] = [];
    const auditLogger = vi.fn(async () => {});
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_approve",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      resolveToolDecision: async (agentId, params) => {
        decisions.push({ agentId, params });
        return true;
      },
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
      permissionAuditLogger: auditLogger,
    });
    await agents.createAgent({ objective: "wait for approval" });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
    });
    const connection = dispatcher.createConnection();

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "approve",
        method: "tool.approve",
        params: {
          sessionId: "session_1",
          requestId: "call_1",
          scope: "session",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "approve",
      result: { requestId: "call_1", decision: "approved" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "deny",
        method: "tool.deny",
        params: {
          sessionId: "session_1",
          requestId: "call_2",
          reason: "no",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "deny",
      result: { requestId: "call_2", decision: "denied" },
    });

    expect(decisions).toEqual([
      {
        agentId: "agent_approve",
        params: {
          requestId: "call_1",
          decision: { kind: "approved_for_session" },
        },
      },
      {
        agentId: "agent_approve",
        params: {
          requestId: "call_2",
          decision: { kind: "denied" },
        },
      },
    ]);
    expect(auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "user_decision",
        decision: "approved",
        source: "daemon-rpc",
        subjectType: "tool_request",
        sessionId: "session_1",
        agentId: "agent_approve",
        requestId: "call_1",
        scope: "session",
        reasonCode: "rpc_approved_for_scope",
      }),
    );
    expect(auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "user_decision",
        decision: "denied",
        source: "daemon-rpc",
        subjectType: "tool_request",
        sessionId: "session_1",
        agentId: "agent_approve",
        requestId: "call_2",
        reasonCode: "rpc_denied",
      }),
    );
  });

  it("promotes allow-all to bypass mode before releasing the pending tool", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_allow_all"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const order: string[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_allow_all",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      setAgentPermissionMode: async (agentId, params) => {
        order.push(`mode:${agentId}:${params.sessionId}:${params.mode}`);
        return {
          applied: true,
          previousMode: "default",
          mode: params.mode,
        };
      },
      resolveToolDecision: async (agentId, params) => {
        order.push(`resolve:${agentId}:${params.requestId}:${params.decision.kind}`);
        return true;
      },
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ objective: "wait for all-tool approval" });

    await expect(
      agents.approveTool({
        sessionId: "session_allow_all",
        requestId: "call_allow_all",
        scope: "session",
        allowAllToolsForSession: true,
      }),
    ).resolves.toEqual({ requestId: "call_allow_all", decision: "approved" });

    expect(order).toEqual([
      "mode:agent_allow_all:session_allow_all:bypassPermissions",
      "resolve:agent_allow_all:call_allow_all:approved_for_session",
    ]);
  });

  it("rolls back allow-all mode when the pending request is stale", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_stale_allow_all"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const modes: string[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_stale_allow_all",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      setAgentPermissionMode: async (_agentId, params) => {
        modes.push(params.mode);
        return {
          applied: true,
          previousMode: "default",
          mode: params.mode,
        };
      },
      resolveToolDecision: async () => false,
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ objective: "stale approval" });

    await expect(
      agents.approveTool({
        sessionId: "session_stale_allow_all",
        requestId: "missing_call",
        scope: "session",
        allowAllToolsForSession: true,
      }),
    ).rejects.toThrow(/not pending/);
    expect(modes).toEqual(["bypassPermissions", "default"]);
  });

  it("keeps daemon tool decisions successful when audit logging fails", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const onPermissionAuditError = vi.fn();
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "agent_audit_failure",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        resolveToolDecision: async () => true,
      },
      permissionAuditLogger: async () => {
        throw new Error("audit unavailable");
      },
      onPermissionAuditError,
    });
    await agents.createAgent({ objective: "wait for approval" });

    await expect(
      agents.approveTool({
        sessionId: "session_1",
        requestId: "call_1",
      }),
    ).resolves.toEqual({ requestId: "call_1", decision: "approved" });
    expect(onPermissionAuditError).toHaveBeenCalledOnce();
  });

  it("routes daemon permission.list through the active background runner", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z"]),
    });
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_permissions",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      listPermissions: async (agentId) => ({
        permissions: [
          {
            permissionId: `mode:${agentId}`,
            subject: "permission-mode",
            action: "default",
            scope: "session",
          },
        ],
      }),
    };
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner,
    });
    await agents.createAgent({ objective: "list permissions" });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
    });
    const connection = dispatcher.createConnection();

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "permissions",
        method: "permission.list",
        params: { sessionId: "session_1" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "permissions",
      result: {
        permissions: [
          {
            permissionId: "mode:agent_permissions",
            subject: "permission-mode",
            action: "default",
            scope: "session",
          },
        ],
      },
    });
  });

  it("returns daemon permission.list resolution errors for missing agents and sessions", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
        listPermissions: async () => ({ permissions: [] }),
      },
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
    });
    const connection = dispatcher.createConnection();

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "missing-agent",
        method: "permission.list",
        params: { agentId: "agent_missing" },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "missing-agent",
      error: {
        code: -32602,
        message: "AgenC daemon agent not found: agent_missing",
        data: { code: "AGENT_NOT_FOUND" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "missing-session",
        method: "permission.list",
        params: { sessionId: "session_missing" },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "missing-session",
      error: {
        code: -32602,
        message: "AgenC daemon session not found or closed: session_missing",
        data: { code: "AGENT_NOT_FOUND" },
      },
    });
  });

  it("rejects duplicate attach client ids instead of retaining a stale socket", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence(["2026-05-01T12:00:01.000Z", "2026-05-01T12:00:02.000Z"]),
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const agents = new AgenCDaemonAgentManager({
      now: sequence(["2026-05-01T12:00:00.000Z"]),
      runner: {
        startAgent: async () => ({
          agentId: "agent_dup",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        }),
      },
      sessionManager: sessions,
      broadcastSessionEvent: async (sessionId, event) => {
        await clientMultiplexer.broadcastSessionEvent(sessionId, event);
      },
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: agents,
      clientMultiplexer,
    });
    const first = dispatcher.createConnection({ sendNotification: () => {} });
    const second = dispatcher.createConnection({ sendNotification: () => {} });

    for (const [id, connection] of [
      ["init-1", first],
      ["init-2", second],
    ] as const) {
      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id,
          method: "initialize",
          params: { protocolVersion: "1.0.0", clientName: "contract-test" },
        }),
      ).resolves.toMatchObject({ result: { type: "initialized" } });
    }
    await expect(
      first.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "create",
        method: "agent.create",
        params: { objective: "run background work" },
      }),
    ).resolves.toMatchObject({
      result: { agentId: "agent_dup", sessionId: "session_1" },
    });
    await expect(
      first.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach-1",
        method: "agent.attach",
        params: { agentId: "agent_dup", clientId: "tui_dup" },
      }),
    ).resolves.toMatchObject({
      result: { agentId: "agent_dup", sessionIds: ["session_1"] },
    });
    await expect(
      second.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach-2",
        method: "agent.attach",
        params: { agentId: "agent_dup", clientId: "tui_dup" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "attach-2",
      error: {
        code: -32602,
        message: "daemon client is already registered: tui_dup",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
  });

  it("registers an attached client only on the primary attached session", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_new", "session_old"]),
      createAttachmentId: sequence(["attachment_new"]),
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
    });
    await sessions.createSession({ agentId: "agent_multi" });
    await sessions.createSession({ agentId: "agent_multi" });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {
        createAgent: async () => {
          throw new Error("createAgent should not be called");
        },
        listAgents: async () => ({ agents: [] }),
        streamAgentMessage: async () => {},
        approveTool: async () => ({
          requestId: "unused",
          decision: "approved",
        }),
        denyTool: async () => ({ requestId: "unused", decision: "denied" }),
        cancelTool: async () => ({
          requestId: "unused",
          decision: "cancelled",
        }),
        getAgentLogs: async () => ({
          agentId: "agent_multi",
          sessions: [],
          transcript: "agent_id\tagent_multi\nNo transcript entries",
        }),
        attachAgent: async () => ({
          agentId: "agent_multi",
          attachmentId: "attachment_new",
          sessionIds: ["session_new", "session_old"],
          sessions: [
            {
              sessionId: "session_new",
              agentId: "agent_multi",
              status: "idle",
              createdAt: "2026-05-01T12:00:00.000Z",
            },
            {
              sessionId: "session_old",
              agentId: "agent_multi",
              status: "idle",
              createdAt: "2026-05-01T12:00:01.000Z",
            },
          ],
        }),
      },
      clientMultiplexer,
    });
    const connection = dispatcher.createConnection({
      sendNotification: () => {},
    });

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach",
        method: "agent.attach",
        params: { agentId: "agent_multi", clientId: "tui_multi" },
      }),
    ).resolves.toMatchObject({
      result: {
        agentId: "agent_multi",
        sessionIds: ["session_new", "session_old"],
      },
    });

    await expect(
      clientMultiplexer.attachedClientIds("session_new"),
    ).resolves.toEqual(["tui_multi"]);
    await expect(
      clientMultiplexer.attachedClientIds("session_old"),
    ).resolves.toEqual([]);
  });

  it("transitions terminal-status agents out of the active list via the runner-terminated hook", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_reaper_start"]),
      now: () => "2026-05-01T12:00:01.000Z",
    });
    let terminatedCallback:
      | ((
          agentId: string,
          snapshot: AgenCBackgroundAgentSnapshot,
        ) => void | Promise<void>)
      | undefined;
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "agent_reaped",
        startedAt: "2026-05-01T12:00:00.500Z",
        status: "running",
      }),
      stopAgent: async () => {},
      setOnActiveAgentTerminated(callback) {
        terminatedCallback = callback;
      },
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/tmp/agenc-reaper",
      now: () => "2026-05-01T12:00:02.500Z",
      sessionManager: sessions,
      runner,
    });
    runner.setOnActiveAgentTerminated?.((id, snapshot) =>
      agents.handleRunnerTerminated(id, snapshot),
    );

    await agents.createAgent({ objective: "do work then end" });
    await expect(agents.listAgents()).resolves.toMatchObject({
      agents: [{ agentId: "agent_reaped", status: "running" }],
    });

    expect(terminatedCallback).toBeDefined();
    await terminatedCallback!("agent_reaped", {
      status: "stopped",
      lastActiveAt: "2026-05-01T12:00:02.000Z",
    });

    const listed = await agents.listAgents();
    expect(
      listed.agents.find((agent) => agent.agentId === "agent_reaped"),
    ).toBeUndefined();
  });

  it("applies terminal runner snapshots that arrive during agent creation", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_fast_done"]),
      now: () => "2026-05-01T12:00:01.000Z",
    });
    let terminatedCallback:
      | ((
          agentId: string,
          snapshot: AgenCBackgroundAgentSnapshot,
        ) => void | Promise<void>)
      | undefined;
    const transitions: Array<{
      readonly agentId: string;
      readonly status: string;
      readonly reason?: string;
    }> = [];
    const runner: AgenCBackgroundAgentRunner = {
      setOnActiveAgentTerminated(callback) {
        terminatedCallback = callback;
      },
      startAgent: async () => {
        await terminatedCallback?.("agent_fast_done", {
          status: "stopped",
          lastActiveAt: "2026-05-01T12:00:00.750Z",
        });
        return {
          agentId: "agent_fast_done",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
      stopAgent: async () => {},
      getAgentSnapshot: async () => null,
    };
    const agents = new AgenCDaemonAgentManager({
      defaultCwd: () => "/tmp/agenc-fast-done",
      now: () => "2026-05-01T12:00:02.000Z",
      sessionManager: sessions,
      runner,
      recordAgentStatusTransition: (transition) => {
        transitions.push({
          agentId: transition.agentId,
          status: transition.status,
          ...(transition.reason !== undefined
            ? { reason: transition.reason }
            : {}),
        });
      },
    });
    runner.setOnActiveAgentTerminated?.((id, snapshot) =>
      agents.handleRunnerTerminated(id, snapshot),
    );

    await agents.createAgent({ objective: "finish immediately" });

    await expect(agents.listAgents()).resolves.toEqual({ agents: [] });
    await expect(sessions.getSession("session_fast_done")).resolves.toMatchObject(
      {
        status: "closed",
      },
    );
    expect(transitions).toContainEqual({
      agentId: "agent_fast_done",
      status: "stopped",
      reason: "runner_terminated",
    });
  });

  it("reaps recovered agents whose runtime never came back", async () => {
    const sessions = new AgenCDaemonSessionManager({
      now: () => "2026-05-01T12:00:00.000Z",
    });
    await sessions.restoreSession({
      sessionId: "session_lost_runtime",
      agentId: "agent_lost_runtime",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "stranded",
    });
    const transitions: Array<{ status: string; reason?: string }> = [];
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      now: () => "2026-05-01T12:00:05.000Z",
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
      },
      recordAgentStatusTransition: (transition) => {
        transitions.push({
          status: transition.status,
          ...(transition.reason !== undefined
            ? { reason: transition.reason }
            : {}),
        });
      },
    });

    await agents.restoreAgent({
      agentId: "agent_lost_runtime",
      objective: "stranded by daemon restart",
      status: "idle",
      sessionIds: ["session_lost_runtime"],
      runtimeAvailable: false,
    });
    await expect(agents.listAgents()).resolves.toMatchObject({
      agents: [
        {
          agentId: "agent_lost_runtime",
          status: "idle",
        },
      ],
    });

    const reaped = await agents.reapStaleAgents();
    expect(reaped).toEqual(["agent_lost_runtime"]);
    expect(transitions.at(-1)).toEqual({
      status: "error",
      reason: "stale_runner",
    });

    const listed = await agents.listAgents();
    expect(
      listed.agents.find((agent) => agent.agentId === "agent_lost_runtime"),
    ).toBeUndefined();

    await expect(agents.reapStaleAgents()).resolves.toEqual([]);
  });
});

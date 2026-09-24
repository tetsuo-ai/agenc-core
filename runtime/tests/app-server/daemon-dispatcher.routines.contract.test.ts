import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import type {
  AgenCBackgroundAgentMessageParams,
  AgenCBackgroundAgentMessageResult,
  AgenCBackgroundAgentRunner,
  AgenCBackgroundAgentSessionEventBinding,
  AgenCBackgroundAgentSnapshot,
  AgenCBackgroundAgentStartParams,
} from "../../src/app-server/background-agent-runner.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type JsonObject,
} from "../../src/app-server/protocol/index.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCStdioTransport } from "../../src/app-server/transport/stdio.js";
import { RemoteAccessBoundary } from "../../src/remote/access.js";
import { createDaemonRoutineExecutor } from "../../src/routines/daemon-executor.js";
import { RoutineService } from "../../src/routines/service.js";
import { RoutineSessionPreparation } from "../../src/routines/session-preparation.js";
import type { Routine, RoutineRun } from "../../src/routines/types.js";
import type { AgentRuntimeOptions } from "../../src/session/runtime-options.js";

/** This harness has no Desktop client, so a routine run starts with the unavailable-tools line. */
const withoutDesktopTools = (instructions: string): string =>
  `Desktop tools (browser, terminal, windows) are unavailable in this run: No Desktop client is connected.\n${instructions}`;

const NOW = "2026-09-06T12:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function request(id: string, method: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

function result<T>(response: { readonly result?: unknown; readonly error?: unknown }): T {
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  return response.result as T;
}

function stdioConnection(connection: ReturnType<AgenCDaemonJsonRpcDispatcher["createConnection"]>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = new Map<string, JsonObject>();
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      const response = JSON.parse(line) as JsonObject;
      responses.set(String(response.id), response);
    }
  });
  const transport = new AgenCStdioTransport({
    input, output,
    onMessage: async (message) => { await transport.send(await connection.dispatch(message)); },
  });
  transport.start();
  return {
    responses,
    send: (id: string, method: string, params: JsonObject = {}) => input.write(JSON.stringify(request(id, method, params)) + "\n"),
    async response(id: string) {
      await vi.waitFor(() => expect(responses.has(id)).toBe(true), { timeout: 2_000 });
      return responses.get(id)!;
    },
    close: () => transport.close(),
  };
}

async function harness(options: { enabled?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-routine-dispatch-")));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
  const authority: AgentRuntimeOptions = {
    simpleMode: false,
    dangerouslyBypassApprovalsAndSandbox: true,
    stdinDataMode: true,
    remoteMode: true,
    allowUntrustedHooks: true,
    sessionTempRoot: join(root, "session-temp"),
    pluginStorageRoot: join(home, "plugins"),
  };
  const terminal = deferred<0 | 1 | 130>();
  const submission = deferred<{ agentId: string; params: AgenCBackgroundAgentMessageParams }>();
  const starts: AgenCBackgroundAgentStartParams[] = [];
  // The live permission mode of each running agent, as its registry would report it.
  const liveModes = new Map<string, string>();
  const bindings = new Map<string, AgenCBackgroundAgentSessionEventBinding>();
  const snapshots = new Map<string, AgenCBackgroundAgentSnapshot>();
  const cancellationOrder: string[] = [];
  const preparingCancellation = new Set<string>();
  let agentSequence = 0;
  let sessionSequence = 0;
  let agents!: AgenCDaemonAgentManager;
  let service!: RoutineService;
  const runner: AgenCBackgroundAgentRunner = {
    async startAgent(params) {
      starts.push(params);
      const agentId = `routine-agent-${++agentSequence}`;
      liveModes.set(agentId, params.permissionMode ?? "default");
      snapshots.set(agentId, { status: "running", lastActiveAt: NOW });
      return { agentId, startedAt: NOW, status: "running" };
    },
    getAgentSnapshot: async (agentId) => snapshots.get(agentId) ?? null,
    getAgentPermissionMode: async (agentId) => liveModes.get(agentId) ?? null,
    async finishAgentRun(agentId) {
      snapshots.set(agentId, { status: "stopped", lastActiveAt: NOW });
      await agents.handleRunnerTerminated(agentId, snapshots.get(agentId)!);
      return undefined;
    },
    attachAgentSessionEvents(agentId, binding) { bindings.set(agentId, binding); },
    async submitAgentMessage(agentId, params): Promise<AgenCBackgroundAgentMessageResult> {
      submission.resolve({ agentId, params });
      const code = await terminal.promise;
      return { disposition: "started", acceptedAt: params.acceptedAt, terminal: { code } };
    },
    async prepareAgentCancellation(agentId) {
      cancellationOrder.push("prepare");
      preparingCancellation.add(agentId);
      return { affectedRunIds: [agentId], voidedHolds: 0, heldUnknownHolds: 0 };
    },
    async interruptAgentTurn() {
      cancellationOrder.push("interrupt");
      terminal.resolve(130);
      return true;
    },
    async stopAgent(agentId) {
      if (!preparingCancellation.has(agentId)) {
        snapshots.set(agentId, { status: "stopped", lastActiveAt: NOW });
        return;
      }
      cancellationOrder.push("canonical_terminal");
      const snapshot: AgenCBackgroundAgentSnapshot = {
        status: "stopped", lastActiveAt: NOW,
        terminal: {
          openedAt: NOW, epoch: 1, eventId: `terminal:${agentId}:1`,
          rolloutPath: join(root, `${agentId}.jsonl`),
          result: {
            runId: agentId, status: "cancelled", exitCode: null,
            stopReason: "Routine run cancelled", finalMessage: null, usage: null,
            lastSequence: 2, finishedAt: NOW,
          },
        },
      };
      snapshots.set(agentId, snapshot);
      await agents.handleRunnerTerminated(agentId, snapshot);
    },
  };
  const sessions = new AgenCDaemonSessionManager({
    createSessionId: () => `routine-session-${++sessionSequence}`,
    now: () => NOW,
  });
  agents = new AgenCDaemonAgentManager({
    agencHome: home, sessionManager: sessions, runner, now: () => NOW,
    // This is the same event fan-out seam used by daemon-cli startup.
    broadcastSessionEvent: async (sessionId, event) => service.observeSessionEvent(sessionId, event),
    cancelRunTreeDurable: async ({ runId }) => {
      cancellationOrder.push("durable_cascade");
      return {
        runId, missing: false, alreadyTerminal: false, rootStatusBefore: "running",
        subtreeRunIds: [runId], cancelledRunIds: [runId],
        priorStatusById: { [runId]: "running" }, closedEdgeChildIds: [],
      };
    },
  });
  service = new RoutineService({
    home, executor: createDaemonRoutineExecutor({ agentManager: agents, runtimeOptions: authority }),
    now: () => new Date(NOW),
  });
  service.start();
  // Session attachments are tracked per connection by the multiplexer, as in
  // daemon-cli: routine authority reads them.
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const routinePreparation = new RoutineSessionPreparation(multiplexer);
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: agents, sessionManager: sessions, clientMultiplexer: multiplexer,
    routinePreparation,
    ...(options.enabled === false ? {} : { routines: service }),
  });
  const connections: ReturnType<AgenCDaemonJsonRpcDispatcher["createConnection"]>[] = [];
  /**
   * A daemon client. `v2` negotiates the wider routine contract and
   * `operator` declares a Routines screen connection.
   */
  async function connect(options: { subscribe?: boolean; v2?: boolean; operator?: boolean; prepare?: boolean } | boolean = {}) {
    const { subscribe = false, v2 = false, operator = false, prepare = false } = typeof options === "boolean" ? { subscribe: options } : options;
    const notifications: JsonObject[] = [];
    const connection = dispatcher.createConnection({ sendNotification: (event) => { notifications.push(event); } });
    connections.push(connection);
    const initialized = await connection.dispatch(request("initialize", "initialize", {
      protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
      capabilities: {
        ...(subscribe ? { "routine.updated.v1": true } : {}),
        ...(v2 ? { "routine.permissionModes.v2": true } : {}),
        ...(operator ? { "routine.operator.v1": true } : {}),
        ...(prepare ? { "routine.session.prepare.v1": true } : {}),
      },
    }));
    return { connection, notifications, initialized };
  }
  let holders = 0;
  /** Attach a session to a connection the way an SDK client does. */
  async function hold(connection: (typeof connections)[number], sessionId: string) {
    result(await connection.dispatch(request(`hold-${++holders}`, "session.attach", { sessionId, clientId: `holder-${holders}` })));
  }
  const client = await connect({ subscribe: true, v2: true });
  cleanups.push(async () => {
    terminal.resolve(130);
    await service.close();
    for (const connection of connections) await dispatcher.closeConnection(connection);
    await dispatcher.close();
    rmSync(root, { recursive: true, force: true });
  });
  const createParams = {
    name: "Review project", description: "A local routine",
    instructions: "Summarize this project's open TODOs.", cwd,
    schedule: { kind: "manual" }, provider: "openai", model: "test-model",
    permissionMode: "default", notifyOnCompletion: true,
  };
  async function create() {
    return result<{ routine: Routine }>(await client.connection.dispatch(
      request("create", "routine.create", createParams),
    )).routine;
  }
  async function run(id: string) {
    return result<{ run: RoutineRun }>(await client.connection.dispatch(request("run", "routine.run", { id }))).run;
  }
  async function history(id: string) {
    return result<{ runs: RoutineRun[] }>(await client.connection.dispatch(request("history", "routine.runs", { id }))).runs;
  }
  /** A live chat session in `mode`, created the way the Desktop creates one. */
  async function chat(mode: string) {
    const created = await agents.createAgent({
      objective: "Interactive session", cwd, deferInitialTurn: true,
      permissionMode: mode as "default", runtimeOptions: authority,
    });
    return { ...created, sessionId: created.sessionId! };
  }
  return {
    ...client, connect, hold, dispatcher, multiplexer, routinePreparation, service, sessions, agents, starts, bindings, liveModes, chat,
    terminal, submission, cancellationOrder, cwd, home, authority, createParams, create, run, history,
  };
}

describe("routine dispatcher and daemon execution contract", () => {
  it("advertises only wired routine methods and gates invalidations on explicit opt-in", async () => {
    const h = await harness();
    const initialized = result<{ capabilities: Record<string, Record<string, boolean>> }>(h.initialized);
    expect(initialized.capabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY]["routine.create"]).toBe(true);
    expect(initialized.capabilities["routine.sessionAuthority.v1"]).toBe(true);
    const ordinary = await h.connect();
    const routine = await h.create();
    await vi.waitFor(() => expect(h.notifications).toHaveLength(1));
    expect(h.notifications[0]).toEqual({
      jsonrpc: JSON_RPC_VERSION, method: "routine.updated",
      params: { id: routine.id, reason: "created" },
    });
    expect(ordinary.notifications).toEqual([]);
    expect(JSON.stringify(h.notifications)).not.toContain(routine.instructions);
    await h.dispatcher.closeConnection(h.connection);
    h.service.update({ id: routine.id, patch: { name: "Updated routine" } });
    expect(h.notifications).toHaveLength(1);

    const unavailable = await harness({ enabled: false });
    const absent = result<{ capabilities: Record<string, Record<string, boolean>> }>(unavailable.initialized);
    expect(absent.capabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY]["routine.create"]).toBe(false);
    expect(absent.capabilities).not.toHaveProperty("routine.sessionAuthority.v1");
    expect(await unavailable.connection.dispatch(request("unavailable", "routine.list"))).toHaveProperty("error");
  });

  it("creates with the held chat's mode while its streamed turn waits for the routine tool answer", async () => {
    const h = await harness();
    const chat = await h.chat("acceptEdits");
    await h.hold(h.connection, chat.sessionId);
    const input = new PassThrough();
    const output = new PassThrough();
    const responses = new Map<string, JsonObject>();
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const response = JSON.parse(line) as JsonObject;
        responses.set(String(response.id), response);
      }
    });
    const transport = new AgenCStdioTransport({
      input, output,
      onMessage: async (message) => { await transport.send(await h.connection.dispatch(message)); },
    });
    transport.start();
    try {
      input.write(JSON.stringify(request("turn", "message.stream", { sessionId: chat.sessionId, content: "Create a routine" })) + "\n");
      await h.submission.promise; // Keep the scripted turn open until its routine tool result arrives.
      const { permissionMode: _unset, ...fields } = h.createParams;
      input.write(JSON.stringify(request("tool", "routine.create", {
        ...fields, permissionAuthority: { kind: "session", sessionId: chat.sessionId },
      })) + "\n");
      await vi.waitFor(() => expect(responses.has("tool")).toBe(true), { timeout: 2_000 });
      expect(responses.has("turn")).toBe(false);
      const routine = result<{ routine: Routine }>(responses.get("tool")!).routine;
      expect(routine.permissionMode).toBe("acceptEdits");
      expect(h.service.get({ id: routine.id }).routine.permissionMode).toBe("acceptEdits");
    } finally {
      h.terminal.resolve(0);
      await transport.close();
    }
  });

  it("keeps update before delete when the update's session grant is delayed", async () => {
    const h = await harness();
    const chat = await h.chat("acceptEdits");
    await h.hold(h.connection, chat.sessionId);
    const routine = await h.create();
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = h.agents.getLiveSessionPermission.bind(h.agents);
    vi.spyOn(h.agents, "getLiveSessionPermission").mockImplementation(async (id) => {
      entered.resolve(); await release.promise; return original(id);
    });
    const wire = stdioConnection(h.connection);
    try {
      wire.send("update", "routine.update", {
        id: routine.id, patch: { name: "Updated first" }, expectedUpdatedAt: routine.updatedAt,
        permissionAuthority: { kind: "session", sessionId: chat.sessionId },
      });
      await entered.promise;
      wire.send("delete", "routine.delete", { id: routine.id, expectedUpdatedAt: routine.updatedAt });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wire.responses.has("delete")).toBe(false);
      release.resolve();
      result(await wire.response("update"));
      expect(await wire.response("delete")).toMatchObject({ error: { data: { code: "ROUTINE_CONFLICT" } } });
      expect(h.service.get({ id: routine.id }).routine.name).toBe("Updated first");
    } finally { release.resolve(); await wire.close(); }
  });

  it("answers an update during its chat turn even after an earlier routine read", async () => {
    const h = await harness();
    const chat = await h.chat("acceptEdits");
    await h.hold(h.connection, chat.sessionId);
    const routine = await h.create();
    const wire = stdioConnection(h.connection);
    try {
      wire.send("turn", "message.stream", { sessionId: chat.sessionId, content: "Update the routine" });
      await h.submission.promise;
      wire.send("read", "routine.get", { id: routine.id });
      wire.send("write", "routine.update", {
        id: routine.id, patch: { name: "Changed by chat" },
        permissionAuthority: { kind: "session", sessionId: chat.sessionId },
      });
      result(await wire.response("read"));
      result(await wire.response("write"));
      expect(wire.responses.has("turn")).toBe(false);
      expect(h.service.get({ id: routine.id }).routine.name).toBe("Changed by chat");
    } finally { h.terminal.resolve(0); await wire.close(); }
  });

  it("does not hold a chat's routine write behind another attachment queued after its turn", async () => {
    const h = await harness();
    const chat = await h.chat("acceptEdits");
    const other = await h.chat("default");
    await h.hold(h.connection, chat.sessionId);
    const routine = await h.create();
    const wire = stdioConnection(h.connection);
    try {
      wire.send("turn", "message.stream", { sessionId: chat.sessionId, content: "Update the routine" });
      await h.submission.promise;
      wire.send("attach", "session.attach", { sessionId: other.sessionId, clientId: "other-holder" });
      wire.send("write", "routine.update", {
        id: routine.id, patch: { name: "Updated despite attach" },
        permissionAuthority: { kind: "session", sessionId: chat.sessionId },
      });
      result(await wire.response("write"));
      expect(wire.responses.has("turn")).toBe(false);
      expect(wire.responses.has("attach")).toBe(false);
    } finally { h.terminal.resolve(0); await wire.close(); }
  });

  it("keeps two updates in arrival order across a delayed session grant", async () => {
    const h = await harness();
    const chat = await h.chat("acceptEdits");
    await h.hold(h.connection, chat.sessionId);
    const routine = await h.create();
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = h.agents.getLiveSessionPermission.bind(h.agents);
    let first = true;
    vi.spyOn(h.agents, "getLiveSessionPermission").mockImplementation(async (id) => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      return original(id);
    });
    const wire = stdioConnection(h.connection);
    const permissionAuthority = { kind: "session", sessionId: chat.sessionId };
    try {
      wire.send("older", "routine.update", { id: routine.id, patch: { name: "Older" }, permissionAuthority });
      await entered.promise;
      wire.send("newer", "routine.update", { id: routine.id, patch: { name: "Newer" }, permissionAuthority });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wire.responses.has("newer")).toBe(false);
      release.resolve();
      result(await wire.response("older"));
      result(await wire.response("newer"));
      expect(h.service.get({ id: routine.id }).routine.name).toBe("Newer");
    } finally { release.resolve(); await wire.close(); }
  });

  it("keeps create ahead of a later update while the create grant is delayed", async () => {
    const h = await harness();
    const chat = await h.chat("acceptEdits");
    await h.hold(h.connection, chat.sessionId);
    const routine = await h.create();
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = h.agents.getLiveSessionPermission.bind(h.agents);
    vi.spyOn(h.agents, "getLiveSessionPermission").mockImplementation(async (id) => {
      entered.resolve(); await release.promise; return original(id);
    });
    const wire = stdioConnection(h.connection);
    const { permissionMode: _unset, ...fields } = h.createParams;
    try {
      wire.send("create", "routine.create", { ...fields, name: "Created first", permissionAuthority: { kind: "session", sessionId: chat.sessionId } });
      await entered.promise;
      wire.send("update", "routine.update", { id: routine.id, patch: { name: "Updated second" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wire.responses.has("update")).toBe(false);
      release.resolve();
      result(await wire.response("create"));
      result(await wire.response("update"));
      expect(h.service.list().routines.map((entry) => entry.name)).toEqual(["Updated second", "Created first"]);
    } finally { release.resolve(); await wire.close(); }
  });

  it("denies an operator write while an earlier pipelined attachment is pending", async () => {
    const h = await harness();
    const screen = await h.connect({ v2: true, operator: true });
    const chat = await h.chat("default");
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = h.multiplexer.attachClientToSession.bind(h.multiplexer);
    vi.spyOn(h.multiplexer, "attachClientToSession").mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; return original(...args);
    });
    const wire = stdioConnection(screen.connection);
    try {
      wire.send("attach", "session.attach", { sessionId: chat.sessionId, clientId: "screen-holder" });
      await entered.promise;
      wire.send("operator", "routine.create", {
        ...h.createParams, permissionMode: "bypassPermissions", permissionAuthority: { kind: "operator" },
      });
      expect(await wire.response("operator")).toMatchObject({ error: { data: { code: "ROUTINE_PERMISSION_DENIED" } } });
      release.resolve();
      result(await wire.response("attach"));
      expect(h.service.list().routines).toEqual([]);
    } finally { release.resolve(); await wire.close(); }
  });

  it.each(["session.setPermissionMode", "session.permissions.mutateRule", "tool.approve", "tool.approve session rule"])("refuses a stale session grant while %s is pending", async (method) => {
    const h = await harness();
    const chat = await h.chat("bypassPermissions");
    await h.hold(h.connection, chat.sessionId);
    const entered = deferred<void>();
    const release = deferred<void>();
    if (method === "session.setPermissionMode") {
      vi.spyOn(h.agents, "setSessionPermissionMode").mockImplementation(async () => {
        entered.resolve(); await release.promise;
        h.liveModes.set(chat.agentId, "default");
        return { sessionId: chat.sessionId, applied: true, previousMode: "bypassPermissions", mode: "default" };
      });
    } else if (method === "session.permissions.mutateRule") {
      vi.spyOn(h.agents, "mutateSessionPermissionRule").mockImplementation(async () => {
        entered.resolve(); await release.promise;
        return { sessionId: chat.sessionId, applied: true, operation: "add", behavior: "deny", rule: "echo test", sessionRules: [] } as never;
      });
    } else {
      vi.spyOn(h.agents, "approveTool").mockImplementation(async () => {
        entered.resolve(); await release.promise;
        h.liveModes.set(chat.agentId, "default");
        return { requestId: "approval", decision: "approved" };
      });
    }
    const wire = stdioConnection(h.connection);
    const { permissionMode: _unset, ...fields } = h.createParams;
    try {
      wire.send("change", method.startsWith("tool.approve") ? "tool.approve" : method, method === "session.setPermissionMode"
        ? { sessionId: chat.sessionId, mode: "default" }
        : method === "session.permissions.mutateRule"
          ? { sessionId: chat.sessionId, operation: "add", behavior: "deny", rule: "echo test" }
          : { sessionId: chat.sessionId, requestId: "approval", ...(method === "tool.approve" ? { allowAllToolsForSession: true } : {}), scope: "session" });
      await entered.promise;
      wire.send("write", "routine.create", { ...fields, permissionAuthority: { kind: "session", sessionId: chat.sessionId } });
      expect(await wire.response("write")).toMatchObject({ error: { data: { code: "ROUTINE_PERMISSION_DENIED" }, message: expect.stringContaining("permission mode is changing") } });
      expect(h.service.list().routines).toEqual([]);
    } finally { release.resolve(); await wire.close(); }
  });

  it("refuses a permission change queued behind the chat turn without waiting for that turn", async () => {
    const h = await harness();
    const chat = await h.chat("bypassPermissions");
    await h.hold(h.connection, chat.sessionId);
    const wire = stdioConnection(h.connection);
    const { permissionMode: _unset, ...fields } = h.createParams;
    try {
      wire.send("turn", "message.stream", { sessionId: chat.sessionId, content: "Create a routine" });
      await h.submission.promise;
      wire.send("change", "session.setPermissionMode", { sessionId: chat.sessionId, mode: "default" });
      wire.send("write", "routine.create", { ...fields, permissionAuthority: { kind: "session", sessionId: chat.sessionId } });
      expect(await wire.response("write")).toMatchObject({ error: { data: { code: "ROUTINE_PERMISSION_DENIED" }, message: expect.stringContaining("permission mode is changing") } });
      expect(wire.responses.has("turn")).toBe(false);
      expect(wire.responses.has("change")).toBe(false);
      expect(h.service.list().routines).toEqual([]);
    } finally { h.terminal.resolve(0); await wire.close(); }
  });

  it("does not refuse a held chat because another session's permission is changing", async () => {
    const h = await harness();
    const chat = await h.chat("acceptEdits");
    const other = await h.chat("default");
    await h.hold(h.connection, chat.sessionId);
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(h.agents, "setSessionPermissionMode").mockImplementation(async () => {
      entered.resolve(); await release.promise;
      return { sessionId: other.sessionId, applied: true, previousMode: "default", mode: "plan" };
    });
    const wire = stdioConnection(h.connection);
    const { permissionMode: _unset, ...fields } = h.createParams;
    try {
      wire.send("change", "session.setPermissionMode", { sessionId: other.sessionId, mode: "plan" });
      await entered.promise;
      wire.send("write", "routine.create", { ...fields, permissionAuthority: { kind: "session", sessionId: chat.sessionId } });
      expect(result<{ routine: Routine }>(await wire.response("write")).routine.permissionMode).toBe("acceptEdits");
    } finally { release.resolve(); await wire.close(); }
  });

  it("waits for its own earlier attach before resolving a session grant", async () => {
    const h = await harness();
    const chat = await h.chat("acceptEdits");
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = h.multiplexer.attachClientToSession.bind(h.multiplexer);
    vi.spyOn(h.multiplexer, "attachClientToSession").mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; return original(...args);
    });
    const wire = stdioConnection(h.connection);
    const { permissionMode: _unset, ...fields } = h.createParams;
    try {
      wire.send("attach", "session.attach", { sessionId: chat.sessionId, clientId: "new-holder" });
      await entered.promise;
      wire.send("write", "routine.create", { ...fields, permissionAuthority: { kind: "session", sessionId: chat.sessionId } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wire.responses.has("write")).toBe(false);
      release.resolve();
      result(await wire.response("attach"));
      expect(result<{ routine: Routine }>(await wire.response("write")).routine.permissionMode).toBe("acceptEdits");
    } finally { release.resolve(); await wire.close(); }
  });

  it("keeps preparation response behind an earlier MCP server install", async () => {
    const h = await harness();
    const chat = await h.chat("default");
    const desktop = await h.connect({ prepare: true });
    const pending = h.routinePreparation.prepare({ sessionId: chat.sessionId, routineId: "routine", runId: "run", cwd: h.cwd }, new AbortController().signal);
    await vi.waitFor(() => expect(desktop.notifications).toHaveLength(1));
    const requestId = (desktop.notifications[0]!.params as { requestId: string }).requestId;
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(h.agents, "addMcpServerToSession").mockImplementation(async () => {
      entered.resolve(); await release.promise;
      return { sessionId: chat.sessionId, serverName: "desktop", success: true, toolCount: 1 };
    });
    const wire = stdioConnection(desktop.connection);
    try {
      wire.send("install", "session.mcp.addServer", { sessionId: chat.sessionId, config: { name: "desktop", transport: "stdio", command: "node" } });
      await entered.promise;
      wire.send("prepared", "routine.session.prepare.respond", { requestId, status: "attached" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wire.responses.has("prepared")).toBe(false);
      release.resolve();
      result(await wire.response("install"));
      expect(await wire.response("prepared")).toMatchObject({ result: { accepted: true } });
      expect(await pending).toEqual({ status: "attached", reason: null });
    } finally { release.resolve(); await wire.close(); }
  });

  it("removes session routine authority from a remote view whose method map denies routine writes", async () => {
    const h = await harness();
    const boundary = new RemoteAccessBoundary(
      { workspaceId: "workspace", workspacePath: h.cwd, sessionIds: [], role: "control", allowFiles: false, allowApprovals: false },
      () => true, async () => null, h.home,
    );
    const remote = h.dispatcher.createConnection({ remoteAccess: boundary });
    try {
      const initialized = result<{ capabilities: Record<string, unknown> }>(await remote.dispatch(request("remote-init", "initialize", {
        protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: {},
      })));
      expect((initialized.capabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY] as Record<string, boolean>)["routine.create"]).toBe(false);
      expect(initialized.capabilities).not.toHaveProperty("routine.sessionAuthority.v1");
    } finally {
      await h.dispatcher.closeConnection(remote);
    }
  });

  it.each([
    { permissionMode: "bypassPermissions" },
    { runtimeOptions: { dangerouslyBypassApprovalsAndSandbox: true } },
    { envOverrides: { OPENAI_API_KEY: "untrusted-client-secret" } },
  ])("rejects caller-supplied authority before creating or running agents: %j", async (override) => {
    const h = await harness();
    const response = await h.connection.dispatch(request("invalid", "routine.create", { ...h.createParams, ...override }));
    expect(response).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_INVALID_ARGUMENT" } } });
    expect(h.service.list().routines).toEqual([]);
    expect(h.starts).toEqual([]);
  });

  it("checks a request-only workspace expectation over RPC before admitting a replaced project", async () => {
    const h = await harness(); const stat = lstatSync(h.cwd, { bigint: true });
    const expectedWorkspace = { cwd: h.cwd, dev: String(stat.dev), ino: String(stat.ino) };
    const routine = result<{ routine: Routine }>(await h.connection.dispatch(request("guarded-create", "routine.create", {
      ...h.createParams, expectedWorkspace,
    }))).routine;
    expect(routine.cwd).toBe(h.cwd); expect(routine).not.toHaveProperty("expectedWorkspace");
    const updated = result<{ routine: Routine }>(await h.connection.dispatch(request("guarded-update", "routine.update", {
      id: routine.id, patch: { cwd: h.cwd, name: "Updated" }, expectedWorkspace,
    }))).routine;
    expect(updated.name).toBe("Updated"); expect(updated).not.toHaveProperty("expectedWorkspace");
    const misplaced = await h.connection.dispatch(request("misplaced-guard", "routine.update", {
      id: routine.id, patch: { name: "No workspace" }, expectedWorkspace,
    }));
    expect(misplaced).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_INVALID_ARGUMENT" } } });
    const outside = `${h.cwd}-outside`; mkdirSync(outside);
    renameSync(h.cwd, `${h.cwd}-original`); symlinkSync(outside, h.cwd, "dir");
    const notices = h.notifications.length;
    for (const [method, params] of [
      ["routine.create", { ...h.createParams, expectedWorkspace }],
      ["routine.update", { id: routine.id, patch: { cwd: h.cwd }, expectedUpdatedAt: updated.updatedAt, expectedWorkspace }],
    ] as const) {
      const response = await h.connection.dispatch(request(`stale-${method}`, method, params));
      expect(response).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_CONFLICT" } } });
    }
    expect(h.service.list().routines).toEqual([updated]); expect(h.starts).toEqual([]);
    expect(h.notifications).toHaveLength(notices); expect(await h.history(routine.id)).toEqual([]);
  });

  it("rejects a stale run revision over RPC before starting agents or creating history", async () => {
    const h = await harness(); const reviewed = await h.create();
    const changed = result<{ routine: Routine }>(await h.connection.dispatch(request("edit-before-run", "routine.update", {
      id: reviewed.id, expectedUpdatedAt: reviewed.updatedAt, patch: { instructions: "Changed after Desktop inspected it" },
    }))).routine;
    const response = await h.connection.dispatch(request("stale-run", "routine.run", {
      id: reviewed.id, expectedUpdatedAt: reviewed.updatedAt,
    }));
    expect(response).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_CONFLICT" } } });
    expect(h.starts).toEqual([]); expect(await h.history(reviewed.id)).toEqual([]);
    const accepted = result<{ run: RoutineRun }>(await h.connection.dispatch(request("current-run", "routine.run", {
      id: changed.id, expectedUpdatedAt: changed.updatedAt,
    })));
    expect(accepted.run.status).toBe("starting");
    const submitted = await h.submission.promise;
    expect(submitted.params.content).toBe(withoutDesktopTools(changed.instructions));
    expect(h.starts).toHaveLength(1);
    h.terminal.resolve(0);
    await vi.waitFor(async () => expect((await h.history(changed.id))[0]?.status).toBe("completed"));
  });

  it.each([{ code: 0, status: "completed" }, { code: 1, status: "failed" } ] as const)(
    "projects Core terminal $code to $status with an owned session and bounded authority",
    async ({ code, status }) => {
      const h = await harness();
      const routine = await h.create();
      const initial = await h.run(routine.id);
      expect(initial.status).toBe("starting");
      const submitted = await h.submission.promise;
      expect(h.starts).toHaveLength(1);
      expect(h.starts[0]).toMatchObject({
        objective: routine.name, cwd: h.cwd, provider: "openai", model: "test-model",
        deferInitialTurn: true, permissionMode: "default",
        metadata: { routineId: routine.id, routineRunId: initial.id },
        runtimeOptions: {
          pluginStorageRoot: h.authority.pluginStorageRoot,
          sessionTempRoot: h.authority.sessionTempRoot,
          dangerouslyBypassApprovalsAndSandbox: false,
          allowUntrustedHooks: false, remoteMode: false, stdinDataMode: false,
        },
      });
      expect(h.starts[0]).not.toHaveProperty("initialContent");
      expect(submitted.params).toMatchObject({
        content: withoutDesktopTools(routine.instructions), originalContent: withoutDesktopTools(routine.instructions), ifBusy: "reject",
      });
      expect((await h.history(routine.id))[0]).toMatchObject({
        id: initial.id, status: "running", agentId: submitted.agentId,
        coreRunId: submitted.agentId, sessionId: submitted.params.sessionId, finishedAt: null,
      });
      h.terminal.resolve(code);
      await vi.waitFor(async () => expect((await h.history(routine.id))[0]?.status).toBe(status));
      const [final] = await h.history(routine.id);
      expect(final.finishedAt).toBe(NOW);
      expect(final.error === null).toBe(code === 0);
      expect(await h.sessions.getSession(submitted.params.sessionId)).toMatchObject({ status: "closed" });
      const listed = result<{ routines: Routine[] }>(await h.connection.dispatch(request("list", "routine.list")));
      expect(listed.routines[0].lastRun).toEqual(final);
    },
  );

  it.each(["bypassPermissions", "acceptEdits", "default"])(
    "gives a routine the live mode of the %s session the Desktop names, and runs it in that mode with the sandbox kept",
    async (mode) => {
      const h = await harness();
      const chat = await h.chat(mode);
      await h.hold(h.connection, chat.sessionId);
      const { permissionMode: _unset, ...fields } = h.createParams;
      const routine = result<{ routine: Routine }>(await h.connection.dispatch(request("from-chat", "routine.create", {
        ...fields, permissionAuthority: { kind: "session", sessionId: chat.sessionId },
      }))).routine;
      expect(routine.permissionMode).toBe(mode);
      expect(routine).not.toHaveProperty("permissionAuthority");
      await h.run(routine.id);
      await h.submission.promise;
      expect(h.starts.at(-1)).toMatchObject({
        permissionMode: mode,
        metadata: { routineId: routine.id },
        runtimeOptions: { dangerouslyBypassApprovalsAndSandbox: false, remoteMode: false },
      });
    },
  );

  it("reads the session's current mode at request time, not the mode it was created with", async () => {
    const h = await harness();
    const chat = await h.chat("default");
    await h.hold(h.connection, chat.sessionId);
    h.liveModes.set(chat.agentId, "bypassPermissions");
    const { permissionMode: _unset, ...fields } = h.createParams;
    const routine = result<{ routine: Routine }>(await h.connection.dispatch(request("switched", "routine.create", {
      ...fields, permissionAuthority: { kind: "session", sessionId: chat.sessionId },
    }))).routine;
    expect(routine.permissionMode).toBe("bypassPermissions");
  });

  it("refuses a wider mode than the session's, a closed or unknown session, and a forged authority", async () => {
    const h = await harness();
    const chat = await h.chat("default");
    await h.hold(h.connection, chat.sessionId);
    const denied = await h.connection.dispatch(request("wider", "routine.create", {
      ...h.createParams, permissionMode: "bypassPermissions", permissionAuthority: { kind: "session", sessionId: chat.sessionId },
    }));
    expect(denied).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_PERMISSION_DENIED" } } });
    const unknown = await h.connection.dispatch(request("unknown", "routine.create", {
      ...h.createParams, permissionAuthority: { kind: "session", sessionId: "session-that-does-not-exist" },
    }));
    expect(unknown).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_PERMISSION_DENIED" } } });
    for (const permissionAuthority of [{ kind: "session" }, { kind: "session", sessionId: chat.sessionId, permissionMode: "bypassPermissions" }, { kind: "model" }, "operator"]) {
      const forged = await h.connection.dispatch(request("forged", "routine.create", { ...h.createParams, permissionAuthority }));
      expect(forged, JSON.stringify(permissionAuthority)).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_INVALID_ARGUMENT" } } });
    }
    await h.agents.stopAgent({ agentId: chat.agentId, reason: "chat closed" });
    const closed = await h.connection.dispatch(request("closed", "routine.create", {
      ...h.createParams, permissionAuthority: { kind: "session", sessionId: chat.sessionId },
    }));
    expect(closed).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_PERMISSION_DENIED" } } });
    expect(h.service.list().routines).toEqual([]);
  });

  it("lets the operator's Routines screen choose any session mode, and keeps an update from a narrower chat off a wider routine", async () => {
    const h = await harness();
    const screen = await h.connect({ v2: true, operator: true });
    const routine = result<{ routine: Routine }>(await screen.connection.dispatch(request("operator", "routine.create", {
      ...h.createParams, permissionMode: "bypassPermissions", permissionAuthority: { kind: "operator" },
    }))).routine;
    expect(routine.permissionMode).toBe("bypassPermissions");
    const chat = await h.chat("default");
    await h.hold(h.connection, chat.sessionId);
    const laundered = await h.connection.dispatch(request("launder", "routine.update", {
      id: routine.id, patch: { instructions: "Something else" }, permissionAuthority: { kind: "session", sessionId: chat.sessionId },
    }));
    expect(laundered).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_PERMISSION_DENIED" } } });
    const paused = result<{ routine: Routine }>(await h.connection.dispatch(request("pause", "routine.update", {
      id: routine.id, patch: { enabled: false }, permissionAuthority: { kind: "session", sessionId: chat.sessionId },
    }))).routine;
    expect(paused).toMatchObject({ enabled: false, permissionMode: "bypassPermissions" });
  });

  it("speaks for a session only from the connection that holds it", async () => {
    const h = await harness();
    const chat = await h.chat("bypassPermissions");
    const { permissionMode: _unset, ...fields } = h.createParams;
    const bystander = await h.connect({ v2: true });
    const borrowed = await bystander.connection.dispatch(request("borrow", "routine.create", {
      ...fields, permissionAuthority: { kind: "session", sessionId: chat.sessionId },
    }));
    expect(borrowed).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_PERMISSION_DENIED" } } });
    expect(JSON.stringify(borrowed)).toContain("not attached to this connection");
    // The agent id names the same session, and borrowing it is refused too.
    const byAgent = await bystander.connection.dispatch(request("borrow-agent", "routine.create", {
      ...fields, permissionAuthority: { kind: "session", sessionId: chat.agentId },
    }));
    expect(byAgent).toMatchObject({ error: { data: { code: "ROUTINE_PERMISSION_DENIED" } } });
    expect(h.service.list().routines).toEqual([]);
    await h.hold(h.connection, chat.sessionId);
    const own = result<{ routine: Routine }>(await h.connection.dispatch(request("own", "routine.create", {
      ...fields, permissionAuthority: { kind: "session", sessionId: chat.agentId },
    }))).routine;
    expect(own.permissionMode).toBe("bypassPermissions");
  });

  it("accepts the operator authority only from a declared Routines screen connection that holds no session", async () => {
    const h = await harness();
    const wide = { ...h.createParams, permissionMode: "bypassPermissions", permissionAuthority: { kind: "operator" } };
    const undeclared = await h.connection.dispatch(request("undeclared", "routine.create", wide));
    expect(undeclared).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_PERMISSION_DENIED" } } });
    const relaying = await h.connect({ v2: true, operator: true });
    const chat = await h.chat("default");
    await h.hold(relaying.connection, chat.sessionId);
    const mixed = await relaying.connection.dispatch(request("mixed", "routine.create", wide));
    expect(mixed).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_PERMISSION_DENIED" } } });
    expect(h.service.list().routines).toEqual([]);
    const screen = await h.connect({ v2: true, operator: true });
    const created = result<{ routine: Routine }>(await screen.connection.dispatch(request("screen", "routine.create", wide))).routine;
    expect(created.permissionMode).toBe("bypassPermissions");
  });

  it("keeps the original routine contract for a connection that did not negotiate routine.permissionModes.v2", async () => {
    const h = await harness();
    const screen = await h.connect({ v2: true, operator: true });
    const wide = result<{ routine: Routine }>(await screen.connection.dispatch(request("wide", "routine.create", {
      ...h.createParams, permissionMode: "bypassPermissions", permissionAuthority: { kind: "operator" },
    }))).routine;
    const plain = await h.create();
    const older = await h.connect({ subscribe: true });
    const capabilities = result<{ permissionModes: string[] }>(await older.connection.dispatch(request("caps", "routine.capabilities")));
    expect(capabilities.permissionModes).toEqual(["default", "plan"]);
    expect(result<{ permissionModes: string[] }>(await h.connection.dispatch(request("caps-v2", "routine.capabilities"))).permissionModes)
      .toEqual(["default", "plan", "acceptEdits", "bypassPermissions"]);
    const listed = result<{ routines: Routine[] }>(await older.connection.dispatch(request("list", "routine.list"))).routines;
    expect(listed.map((routine) => routine.id)).toEqual([plain.id]);
    for (const [method, params] of [
      ["routine.get", { id: wide.id }], ["routine.runs", { id: wide.id }], ["routine.run", { id: wide.id }],
      ["routine.update", { id: wide.id, patch: { enabled: false } }], ["routine.delete", { id: wide.id }],
      ["routine.cancel", { id: wide.id, runId: "routine_run_missing" }],
    ] as const) {
      const hidden = await older.connection.dispatch(request(method, method, params));
      expect(hidden, method).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_NOT_FOUND" } } });
    }
    expect(h.service.get({ id: wide.id }).routine).toMatchObject({ enabled: true, permissionMode: "bypassPermissions" });
    // The authority field is not part of the original contract there.
    const authority = await older.connection.dispatch(request("authority", "routine.create", {
      ...h.createParams, permissionAuthority: { kind: "operator" },
    }));
    expect(authority).toMatchObject({ error: { code: -32602, data: { code: "ROUTINE_INVALID_ARGUMENT" } } });
    // Invalidations carry only an id and a reason, so every subscriber keeps getting them.
    h.service.update({ id: wide.id, patch: { name: "Renamed" } }, { source: "operator", ceiling: "bypassPermissions", defaultMode: "default" });
    await vi.waitFor(() => expect(older.notifications.at(-1)).toMatchObject({ params: { id: wide.id, reason: "updated" } }));
  });

  it("projects bound permission events and cancels through Core's canonical run-tree boundary", async () => {
    const h = await harness();
    const routine = await h.create();
    const initial = await h.run(routine.id);
    const submitted = await h.submission.promise;
    const binding = h.bindings.get(submitted.agentId)!;
    expect(binding.sessionId).toBe(submitted.params.sessionId);
    await binding.emit({
      method: "event.permission_request",
      params: { sessionId: binding.sessionId, requestId: "permission-1", toolName: "Bash" },
    });
    expect((await h.history(routine.id))[0].status).toBe("waiting_permission");
    const cancelled = result<{ run: RoutineRun }>(await h.connection.dispatch(request("cancel", "routine.cancel", {
      id: routine.id, runId: initial.id,
    })));
    expect(cancelled.run).toMatchObject({ id: initial.id, status: "cancelled", finishedAt: NOW });
    expect(h.cancellationOrder).toEqual(["prepare", "interrupt", "canonical_terminal", "durable_cascade"]);
    expect((await h.history(routine.id))[0]).toEqual(cancelled.run);
    expect(await h.sessions.getSession(binding.sessionId)).toMatchObject({ status: "closed" });
  });
});

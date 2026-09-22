import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createDaemonRoutineExecutor } from "../../src/routines/daemon-executor.js";
import { RoutineService } from "../../src/routines/service.js";
import type { Routine, RoutineRun } from "../../src/routines/types.js";
import type { AgentRuntimeOptions } from "../../src/session/runtime-options.js";

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
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: agents, sessionManager: sessions, clientMultiplexer: multiplexer,
    ...(options.enabled === false ? {} : { routines: service }),
  });
  const connections: ReturnType<AgenCDaemonJsonRpcDispatcher["createConnection"]>[] = [];
  /**
   * A daemon client. `v2` negotiates the wider routine contract and
   * `operator` declares a Routines screen connection.
   */
  async function connect(options: { subscribe?: boolean; v2?: boolean; operator?: boolean } | boolean = {}) {
    const { subscribe = false, v2 = false, operator = false } = typeof options === "boolean" ? { subscribe: options } : options;
    const notifications: JsonObject[] = [];
    const connection = dispatcher.createConnection({ sendNotification: (event) => { notifications.push(event); } });
    connections.push(connection);
    const initialized = await connection.dispatch(request("initialize", "initialize", {
      protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
      capabilities: {
        ...(subscribe ? { "routine.updated.v1": true } : {}),
        ...(v2 ? { "routine.permissionModes.v2": true } : {}),
        ...(operator ? { "routine.operator.v1": true } : {}),
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
    ...client, connect, hold, dispatcher, service, sessions, agents, starts, bindings, liveModes, chat,
    terminal, submission, cancellationOrder, cwd, authority, createParams, create, run, history,
  };
}

describe("routine dispatcher and daemon execution contract", () => {
  it("advertises only wired routine methods and gates invalidations on explicit opt-in", async () => {
    const h = await harness();
    const initialized = result<{ capabilities: Record<string, Record<string, boolean>> }>(h.initialized);
    expect(initialized.capabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY]["routine.create"]).toBe(true);
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
    expect(await unavailable.connection.dispatch(request("unavailable", "routine.list"))).toHaveProperty("error");
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
    expect(submitted.params.content).toBe(changed.instructions);
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
        content: routine.instructions, originalContent: routine.instructions, ifBusy: "reject",
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

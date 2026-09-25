import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_INTERNAL_METHODS,
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
} from "./protocol/index.js";
import {
  StartupSessionRestoreAbandonedError,
  StartupSessionRestores,
  type StartupSessionRestoreContext,
  type StartupSessionRestoreSettlement,
} from "./startup-session-restores.js";

interface Target {
  readonly runId: string;
  readonly sessionId?: string;
}

/** Restores that wait until the test releases each one, by run id. */
function gatedRestores(
  runIds: readonly string[],
  options: {
    readonly concurrency?: number;
    readonly fail?: ReadonlySet<string>;
    readonly honorAbort?: boolean;
  } = {},
) {
  const started: string[] = [];
  const settled: StartupSessionRestoreSettlement<Target>[] = [];
  const contexts = new Map<string, StartupSessionRestoreContext>();
  const gates = new Map<string, (outcome: "published" | "unavailable") => void>();
  let inFlight = 0;
  let maxInFlight = 0;
  const restores = new StartupSessionRestores<Target>({
    targets: runIds.map((runId) => ({
      runId,
      sessionId: runId.replace("run-", "session-"),
    })),
    concurrency: options.concurrency ?? 2,
    task: async (target, context) => {
      started.push(target.runId);
      contexts.set(target.runId, context);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const outcome = await new Promise<"published" | "unavailable">(
          (resolve, reject) => {
            gates.set(target.runId, resolve);
            if (options.honorAbort === true) {
              context.signal.addEventListener("abort", () =>
                reject(new Error(`aborted ${target.runId}`)),
              );
            }
          },
        );
        if (options.fail?.has(target.runId) === true) {
          throw new Error(`injected publication failure for ${target.runId}`);
        }
        if (!context.beginPublication()) {
          throw new StartupSessionRestoreAbandonedError();
        }
        return outcome;
      } finally {
        inFlight -= 1;
      }
    },
    onSettled: (entry) => {
      settled.push(entry);
    },
  });
  const release = async (
    runId: string,
    outcome: "published" | "unavailable" = "published",
  ): Promise<void> => {
    await vi.waitFor(() => expect(gates.has(runId)).toBe(true));
    gates.get(runId)!(outcome);
    await vi.waitFor(() =>
      expect(settled.some((entry) => entry.target.runId === runId)).toBe(true),
    );
  };
  return {
    restores,
    started,
    settled,
    contexts,
    release,
    maxInFlight: () => maxInFlight,
  };
}

function settledState<T>(promise: Promise<T>): () => "pending" | "settled" {
  let state: "pending" | "settled" = "pending";
  void promise.then(
    () => {
      state = "settled";
    },
    () => {
      state = "settled";
    },
  );
  return () => state;
}

describe("StartupSessionRestores", () => {
  const runs = ["run-a", "run-b", "run-c", "run-d", "run-e"];

  it("runs a bounded number at a time, in recovery order", async () => {
    const gated = gatedRestores(runs);
    gated.restores.start();
    await vi.waitFor(() => expect(gated.started).toEqual(["run-a", "run-b"]));
    await gated.release("run-b");
    await vi.waitFor(() =>
      expect(gated.started).toEqual(["run-a", "run-b", "run-c"]),
    );
    for (const runId of ["run-a", "run-c", "run-d", "run-e"]) {
      await gated.release(runId);
    }
    await expect(gated.restores.settled).resolves.toMatchObject({
      total: 5,
      published: 5,
      unavailable: 0,
      failed: 0,
      abandoned: 0,
    });
    expect(gated.maxInFlight()).toBe(2);
    expect(gated.restores.pending).toBe(0);
    // Each settles when its own restore finishes, not in recovery order.
    expect(gated.settled.map((entry) => entry.target.runId)).toEqual([
      "run-b",
      "run-a",
      "run-c",
      "run-d",
      "run-e",
    ]);
  });

  it("answers requests that name no pending session at once", async () => {
    const gated = gatedRestores(runs);
    expect(gated.restores.waitForRequest("session.attach", { sessionId: "session-z" })).toBeUndefined();
    expect(gated.restores.waitFor(["run-z"])).toBeUndefined();
    // Listings, health and control never wait, whatever they name.
    for (const method of ["session.list", "agent.list", "health.ready", "request.cancel", "daemon.shutdown"]) {
      expect(gated.restores.waitForRequest(method, { agentId: "run-a" })).toBeUndefined();
    }
    gated.restores.start();
    for (const runId of runs) await gated.release(runId);
    await gated.restores.settled;
    // Once everything has settled nothing waits.
    expect(gated.restores.waitForRequest("session.attach", { sessionId: "session-a" })).toBeUndefined();
  });

  it("finds a pending id anywhere in the params, by run id or session id", async () => {
    const gated = gatedRestores(runs);
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["session.attach", { sessionId: "session-a" }],
      ["agent.attach", { agentId: "run-a" }],
      ["session.transcript.v2", { sessionId: "run-a" }],
      ["run.status", { runId: "run-a" }],
      ["agent.create", { cwd: "/w", resumeSessionId: "run-a" }],
      ["routine.create", { permissionAuthority: { kind: "session", sessionId: "session-a" } }],
      ["remote.pair.begin", { sessionIds: ["session-x", "session-a"] }],
    ];
    for (const [method, params] of cases) {
      expect(gated.restores.waitForRequest(method, params), method).toBeInstanceOf(Promise);
    }
    // A long string is never an id, and the walk stops at a bounded depth.
    expect(
      gated.restores.waitForRequest("message.send", { sessionId: "other", content: `run-a${"x".repeat(4096)}` }),
    ).toBeUndefined();
    expect(
      gated.restores.waitForRequest("agent.create", { a: { b: { c: { d: { e: "run-a" } } } } }),
    ).toBeUndefined();
    gated.restores.start();
    for (const runId of runs) await gated.release(runId);
  });

  it("starts a requested restore next, ahead of the queue", async () => {
    const gated = gatedRestores(runs);
    gated.restores.start();
    await vi.waitFor(() => expect(gated.started).toEqual(["run-a", "run-b"]));
    const waited = gated.restores.waitForRequest("session.attach", { sessionId: "session-e" })!;
    const state = settledState(waited);
    await gated.release("run-a");
    // The requested one takes the free slot, before run-c and run-d.
    await vi.waitFor(() =>
      expect(gated.started).toEqual(["run-a", "run-b", "run-e"]),
    );
    expect(state()).toBe("pending");
    await gated.release("run-e");
    await expect(waited).resolves.toBeUndefined();
    // run-c and run-d have not even started: the wait was one restore plus
    // the one in flight, not the queue.
    expect(gated.started).not.toContain("run-d");
    expect(gated.settled.find((entry) => entry.target.runId === "run-e")?.requested).toBe(true);
    for (const runId of ["run-b", "run-c", "run-d"]) await gated.release(runId);
    await gated.restores.settled;
  });

  it("releases a waiter when its restore fails, and the failure touches only that session", async () => {
    const gated = gatedRestores(runs, { fail: new Set(["run-b"]) });
    gated.restores.start();
    const waited = gated.restores.waitFor(["run-b"])!;
    await gated.release("run-b");
    await expect(waited).resolves.toBeUndefined();
    for (const runId of ["run-a", "run-c", "run-d", "run-e"]) await gated.release(runId, runId === "run-c" ? "unavailable" : "published");
    await expect(gated.restores.settled).resolves.toMatchObject({
      published: 3,
      unavailable: 1,
      failed: 1,
      abandoned: 0,
    });
    const failed = gated.settled.find((entry) => entry.target.runId === "run-b");
    expect(failed).toMatchObject({ outcome: "failed", order: 2, total: 5 });
    expect(String(failed?.error)).toContain("injected publication failure for run-b");
  });

  it("stops: restores not started are abandoned and every waiter gets the shutdown error", async () => {
    const gated = gatedRestores(runs);
    gated.restores.start();
    await vi.waitFor(() => expect(gated.started).toEqual(["run-a", "run-b"]));
    const forQueued = expect(gated.restores.waitFor(["session-e"])).rejects.toBeInstanceOf(
      StartupSessionRestoreAbandonedError,
    );
    const forRunning = expect(gated.restores.waitFor(["run-a"])).rejects.toBeInstanceOf(
      StartupSessionRestoreAbandonedError,
    );
    const shutdown = gated.restores.shutdown({ graceMs: 5_000, abortGraceMs: 5_000 });
    await forQueued;
    // The ones in flight finish and publish during the grace.
    await gated.release("run-a");
    await gated.release("run-b");
    await expect(shutdown).resolves.toEqual([]);
    await forRunning;
    expect(gated.started).toEqual(["run-a", "run-b"]);
    await expect(gated.restores.settled).resolves.toMatchObject({
      published: 2,
      abandoned: 3,
    });
  });

  it("aborts a restore that outlives the grace, then gives up on one that ignores the abort", async () => {
    const honoring = gatedRestores(["run-a"], { honorAbort: true });
    honoring.restores.start();
    await vi.waitFor(() => expect(honoring.started).toEqual(["run-a"]));
    await expect(honoring.restores.shutdown({ graceMs: 10, abortGraceMs: 1_000 })).resolves.toEqual([]);
    expect(honoring.contexts.get("run-a")?.signal.aborted).toBe(true);
    expect(honoring.settled[0]).toMatchObject({ outcome: "failed" });

    const ignoring = gatedRestores(["run-a"]);
    ignoring.restores.start();
    await vi.waitFor(() => expect(ignoring.started).toEqual(["run-a"]));
    await expect(ignoring.restores.shutdown({ graceMs: 10, abortGraceMs: 10 })).resolves.toEqual([
      { runId: "run-a", sessionId: "session-a" },
    ]);
    expect(ignoring.settled[0]).toMatchObject({ outcome: "abandoned" });
    // It can no longer publish when it finally finishes.
    expect(ignoring.contexts.get("run-a")?.beginPublication()).toBe(false);
  });

  it("stops waiting when the request is cancelled", async () => {
    const gated = gatedRestores(runs);
    gated.restores.start();
    const controller = new AbortController();
    const waited = gated.restores.waitFor(["run-a"], controller.signal)!;
    controller.abort(new Error("request.cancel"));
    await expect(waited).rejects.toThrow("request.cancel");
    for (const runId of runs) await gated.release(runId);
  });

  it("keeps settling when the settlement report throws", async () => {
    const restores = new StartupSessionRestores<Target>({
      targets: [{ runId: "run-a" }],
      concurrency: 1,
      task: async () => "published",
      onSettled: () => {
        throw new Error("report failed");
      },
    });
    const waited = restores.waitFor(["run-a"])!;
    restores.start();
    await expect(waited).resolves.toBeUndefined();
    await expect(restores.settled).resolves.toMatchObject({ published: 1 });
  });

  it("settles at once when there is nothing to restore", async () => {
    const restores = new StartupSessionRestores<Target>({
      targets: [],
      concurrency: 4,
      task: async () => "published",
    });
    expect(restores.pending).toBe(0);
    restores.start();
    await expect(restores.settled).resolves.toMatchObject({ total: 0 });
  });
});

describe("daemon dispatcher with sessions still restoring", () => {
  const pending = { runId: "run-pending", sessionId: "session-pending" };
  const namingParams = {
    sessionId: pending.sessionId,
    agentId: pending.runId,
    runId: pending.runId,
    threadId: pending.runId,
    resumeSessionId: pending.runId,
  };

  function dispatcherWithPendingRestore() {
    let publish!: () => void;
    const restores = new StartupSessionRestores<Target>({
      targets: [pending],
      concurrency: 1,
      task: () =>
        new Promise((resolve) => {
          publish = () => resolve("published");
        }),
    });
    const handled: string[] = [];
    const stub = (owner: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) =>
            typeof property === "string" && property !== "then"
              ? async () => {
                  handled.push(`${owner}.${property}`);
                  return {};
                }
              : undefined,
        },
      );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: stub("agentManager") as never,
      sessionManager: stub("sessionManager") as never,
      runInspection: stub("runInspection") as never,
      startupRestores: restores,
    });
    restores.start();
    return { dispatcher, handled, publish: () => publish() };
  }

  it("holds every method that names a session still restoring until it is published", async () => {
    const { dispatcher, handled, publish } = dispatcherWithPendingRestore();
    const neverWait = new Set([
      "initialize",
      "request.cancel",
      "health.ping",
      "health.ready",
      "health.stats",
      "daemon.reload",
      "daemon.shutdown",
      "session.list",
      "agent.list",
    ]);
    const methods = [...AGENC_DAEMON_METHODS, ...AGENC_DAEMON_INTERNAL_METHODS];
    const answers = new Map<string, Promise<unknown>>();
    for (const method of methods) {
      // One connection each: a connection bounds its requests in flight.
      const connection = dispatcher.createConnection();
      await connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "init",
        method: "initialize",
        params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } },
      });
      answers.set(
        method,
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: `request:${method}`,
          method,
          params: namingParams,
        }),
      );
    }
    await delay(50);
    const answeredEarly = new Map<string, unknown>();
    await Promise.all(
      [...answers].map(async ([method, answer]) => {
        const early = await Promise.race([answer, delay(0).then(() => undefined)]);
        if (early !== undefined) answeredEarly.set(method, early);
      }),
    );
    // No handler that could touch the session ran before its restore settled.
    expect(
      handled.filter(
        (call) => call !== "agentManager.listAgents" && call !== "sessionManager.listSessions",
      ),
    ).toEqual([]);
    for (const [method, answer] of answeredEarly) {
      if (neverWait.has(method)) continue;
      // What answers early is a method this dispatcher does not serve at all
      // (no remote, telegram, routine or whisper service here): nothing ran.
      expect(answer, method).toMatchObject({ error: { code: -32601 } });
    }
    const held = methods.filter((method) => !answeredEarly.has(method));
    // Everything that takes a session, agent, run or thread id is held.
    for (const method of [
      "agent.create",
      "agent.attach",
      "agent.stop",
      "agent.logs",
      "run.status",
      "run.result",
      "run.replay",
      "run.evidence",
      "run.cancel",
      "session.attach",
      "session.detach",
      "session.terminate",
      "session.clear",
      "session.snapshot",
      "session.processes.list",
      "session.processes.stop",
      "session.goal",
      "session.transcript",
      "session.transcript.v2",
      "session.artifact.read",
      "session.cancelTurn",
      "session.resolveToolCall",
      "session.mcp.status",
      "session.mcp.addServer",
      "session.mcp.reconnectServer",
      "session.mcp.enableServer",
      "session.mcp.disableServer",
      "session.partialCompactFromMessage",
      "session.rollbackCompaction",
      "session.extendCompactionRollbackRetention",
      "session.rewindConversationToMessage",
      "session.previewFileRewind",
      "session.rewindFilesToMessage",
      "session.shell.execute",
      "session.statusLine.execute",
      "session.setModel",
      "session.setPermissionMode",
      "session.permissions.mutateRule",
      "session.hooks.status",
      "session.hooks.setDisabled",
      "session.applyConfig",
      "message.send",
      "message.stream",
      "tool.approve",
      "tool.deny",
      "tool.cancel",
      "elicitation.respond",
      "permission.list",
      "thread/realtime/appendAudio",
      "thread/realtime/appendText",
      "thread/realtime/stop",
    ]) {
      expect(held, method).toContain(method);
    }
    // Well-formed requests for the same session, held the same way.
    const wellFormed: Array<readonly [string, Record<string, unknown>, string]> = [
      ["session.attach", { sessionId: pending.sessionId }, "sessionManager.attachSession"],
      ["session.transcript.v2", { sessionId: pending.runId }, "agentManager.getSessionTranscriptV2"],
      ["agent.attach", { agentId: pending.runId }, "agentManager.attachAgent"],
    ];
    const wellFormedAnswers: Promise<unknown>[] = [];
    for (const [method, params] of wellFormed) {
      const connection = dispatcher.createConnection();
      await connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "init",
        method: "initialize",
        params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } },
      });
      wellFormedAnswers.push(
        connection.dispatch({ jsonrpc: JSON_RPC_VERSION, id: method, method, params }),
      );
    }
    await delay(20);
    expect(handled.filter((call) => wellFormed.some(([, , handler]) => handler === call))).toEqual([]);
    publish();
    // Once it is published every held request runs, whatever it answers.
    const settledAnswers = await Promise.all(held.map((method) => answers.get(method)));
    for (const answer of settledAnswers) {
      expect(JSON.stringify(answer)).not.toContain("shutting down");
    }
    await Promise.all(wellFormedAnswers);
    expect(handled).toEqual(
      expect.arrayContaining(wellFormed.map(([, , handler]) => handler)),
    );
  });

  it("lets a cancelled request go without running it", async () => {
    const { dispatcher, handled, publish } = dispatcherWithPendingRestore();
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } },
    });
    const send = connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "send",
      method: "message.send",
      params: { sessionId: pending.sessionId, content: "hello" },
    });
    await delay(10);
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "cancel",
        method: "request.cancel",
        params: { requestId: "send" },
      }),
    ).resolves.toMatchObject({ result: { cancelled: true } });
    await expect(send).resolves.toMatchObject({
      error: { data: { code: "REQUEST_CANCELLED" } },
    });
    publish();
    await delay(10);
    expect(handled).not.toContain("agentManager.streamAgentMessage");
  });
});

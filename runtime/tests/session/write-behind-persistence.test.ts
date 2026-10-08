import { fsyncSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I4_FSYNC_RETRY_MS, SessionStore } from "../../src/session/session-store.js";
import { SessionWriteBehindQueue, registerSessionWriteBehind, withSessionWriteBehind } from "../../src/session/write-behind.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { ProviderHttpClientSession } from "../../src/llm/client-session.js";
import { Session } from "../../src/session/session.js";
import { EventLog } from "../../src/session/event-log.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "write-behind-"));
  roots.push(root);
  const store = new SessionStore({ cwd: root, agencHome: root, sessionId: "test", agencVersion: "0.2.0" });
  store.open({ cwd: root, sessionId: "test", agencVersion: "0.2.0", originator: "test", timestamp: "2026-10-08T00:00:00.000Z" });
  return store;
}

function emittingSession(store: SessionStore, seen: string[]): Session {
  const eventLog = new EventLog();
  const session = Object.assign(Object.create(Session.prototype), {
    eventLog,
    phaseEventListeners: new Set(),
    rolloutStore: { store, append: store.append.bind(store) },
    txEvent: { send: (event: { seq: number }) => { seen.push(`transport:${event.seq}`); } },
    isRolloutPersistenceSuspended: () => false,
  }) as Session;
  eventLog.setVisibilityBarrier(() => session.writeBehind.drain());
  return session;
}

describe("write-behind persistence barriers", () => {
  it("drains persistence before advancing a previously opened SQL iterator", () => {
    const store = openStore();
    const writer = openStateDatabases({ cwd: store.cwd, agencHome: store.agencHome, deferLogs: true });
    const driver = openStateDatabases({ cwd: store.cwd, agencHome: store.agencHome, deferLogs: true });
    writer.state.exec("CREATE TABLE wb_cursor(value INTEGER)");
    const iterator = driver.prepareState<[], { value: number }>("SELECT value FROM wb_cursor").iterate();
    try {
      store.writeBehind.beginStep();
      store.writeBehind.defer("insert", () => { writer.prepareState("INSERT INTO wb_cursor VALUES (7)").run(); });
      expect(iterator.next()).toEqual({ value: { value: 7 }, done: false });
      expect(store.writeBehind.pending).toBe(0);
    } finally { iterator.return?.(); driver.close(); writer.close(); store.close(); }
  });

  it("preserves canonical bytes, append order, and fsync calls after flushing", () => {
    const immediate = openStore();
    const deferred = openStore();
    const prefixes = [immediate, deferred].map(store => readFileSync(store.rolloutPath).length);
    const syncs = [0, 0];
    try {
      [immediate, deferred].forEach((store, index) => {
        store.setFsyncImplForTest(fd => { syncs[index]! += 1; fsyncSync(fd); });
      });
      deferred.writeBehind.beginStep();
      for (const store of [immediate, deferred]) {
        store.append({ id: "one", seq: 1, msg: { type: "warning", payload: { cause: "test", message: "first" } } }, { durable: true });
        store.appendRollout({ type: "response_item", payload: { role: "user", content: "history" } });
        store.append({ id: "two", seq: 2, msg: { type: "warning", payload: { cause: "test", message: "last" } } }, { durable: true });
      }
      deferred.writeBehind.finish();
      expect(readFileSync(deferred.rolloutPath).subarray(prefixes[1])).toEqual(readFileSync(immediate.rolloutPath).subarray(prefixes[0]));
      expect(syncs[1]).toBe(syncs[0]);
      expect(syncs[0]).toBeGreaterThan(0);
    } finally { immediate.close(); deferred.close(); }
  });

  it("drains SQL readers opened through a different spelling of the session home", () => {
    const store = openStore();
    const alias = join(store.agencHome, "home-alias");
    symlinkSync(store.agencHome, alias, "dir");
    const driver = openStateDatabases({ cwd: store.cwd, agencHome: alias, deferLogs: true });
    try {
      driver.state.exec("CREATE TABLE wb_alias(value INTEGER)");
      const read = driver.prepareState<[], { value: number }>("SELECT value FROM wb_alias");
      store.writeBehind.beginStep();
      store.writeBehind.defer("insert", () => { driver.prepareState("INSERT INTO wb_alias VALUES (9)").run(); });
      expect(read.get()).toEqual({ value: 9 });
      expect(store.writeBehind.pending).toBe(0);
    } finally { driver.close(); store.close(); }
  });

  it("keeps phase callbacks in the same order as canonical publication", () => {
    const store = openStore();
    const seen: string[] = [];
    const session = emittingSession(store, seen);
    session.subscribeToEvents(() => { seen.push("phase"); });
    try {
      store.writeBehind.beginStep();
      session.emit({ id: "one", msg: { type: "warning", payload: { cause: "test", message: "one" } } }, { durable: true });
      session.emitPhaseEvent({ type: "turn_start", turnIndex: 0 });
      session.emit({ id: "two", msg: { type: "warning", payload: { cause: "test", message: "two" } } }, { durable: true });
      expect(seen).toEqual([]);
      store.writeBehind.finish();
      expect(seen).toEqual(["transport:1", "phase", "transport:2"]);
    } finally { store.close(); }
  });

  it("does not seal a relaxed one-shot after deferred persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "write-behind-seal-"));
    roots.push(root);
    const store = new SessionStore({ cwd: root, agencHome: root, sessionId: "test", agencVersion: "test",
      relaxedOneShot: true, checkpointOneShot: () => {} });
    store.open({ cwd: root, sessionId: "test", agencVersion: "test", originator: "test", timestamp: "2026-10-08T00:00:00.000Z" });
    store.writeBehind.beginStep();
    store.writeBehind.defer("failed", () => { throw new Error("persistence failed"); });
    expect(() => store.close()).toThrow("persistence failed");
    expect(JSON.parse(readFileSync(`${store.rolloutPath}.durability.json`, "utf8")).phase).toBe("active");
  });

  it("retains listener/transport order through a reentrant read and emit", () => {
    const store = openStore();
    const seen: string[] = [];
    const session = emittingSession(store, seen);
    let readSequences: (number | undefined)[] = [];
    session.eventLog.subscribe(event => {
      seen.push(`listener:${event.seq}`);
      if (event.seq === 1) {
        readSequences = store.readAll().filter(item => item.type === "event_msg").map(item => item.payload.seq);
        session.emit({ id: "nested", msg: { type: "warning", payload: { cause: "test", message: "nested" } } }, { durable: true });
      }
    });
    try {
      store.writeBehind.beginStep();
      for (const id of ["one", "two"]) session.emit({ id, msg: { type: "warning", payload: { cause: "test", message: id } } }, { durable: true });
      expect(seen).toEqual([]);
      store.writeBehind.finish();
      expect(readSequences).toEqual([1, 2]);
      expect(seen).toEqual(["listener:1", "transport:1", "listener:2", "transport:2", "listener:3", "transport:3"]);
      expect(store.readAll().filter(item => item.type === "event_msg").map(item => item.payload.seq)).toEqual([1, 2, 3]);
    } finally { store.close(); }
  });

  it.each(["open", "closed"])("retains asynchronous retry diagnostics after deferred fsync failure with the store %s", async state => {
    vi.useFakeTimers();
    const store = openStore();
    const seen: string[] = [];
    const session = emittingSession(store, seen);
    session.eventLog.subscribe(event => { seen.push(`listener:${event.seq}`); });
    store.setDiagnosticListener(() => {
      session.emit({ id: "diagnostic", msg: { type: "warning", payload: { cause: "test", message: "failed" } } });
    });
    store.writeBehind.beginStep();
    session.emit({ id: "one", msg: { type: "warning", payload: { cause: "test", message: "one" } } }, { durable: true });
    session.emit({ id: "two", msg: { type: "warning", payload: { cause: "test", message: "two" } } }, { durable: true });
    store.setFsyncImplForTest(() => { throw Object.assign(new Error("injected fsync error"), { code: "EIO" }); });
    expect(() => store.writeBehind.drain()).toThrow(/was not fsync-committed/);
    expect(seen).toEqual([]);
    expect(() => store.readAll()).toThrow(/was not fsync-committed/);
    store.setFsyncImplForTest(fsyncSync);
    if (state === "closed") expect(() => store.close()).toThrow(/was not fsync-committed/);
    const pending = store.writeBehind.pending;
    await vi.advanceTimersByTimeAsync(I4_FSYNC_RETRY_MS);
    await store.awaitPendingFsyncRetries();
    expect(store.drainBufferedDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ cause: "fsync_retry_succeeded" }),
    ]));
    expect(seen).toEqual([]);
    expect(store.writeBehind.pending).toBe(pending);
    expect(() => store.writeBehind.finish()).toThrow(/was not fsync-committed/);
    if (state === "open") expect(() => store.close()).toThrow(/was not fsync-committed/);
  });

  it("captures caller mutations and writes identical ordered bytes after a read barrier", () => {
    const store = openStore();
    try {
      const before = readFileSync(store.rolloutPath, "utf8");
      store.writeBehind.beginStep();
      const event = { id: "one", seq: 1, msg: { type: "warning" as const, payload: { cause: "test", message: "original" } } };
      store.append(event, { durable: true });
      event.msg.payload.message = "mutated";
      store.append({ id: "two", seq: 2, msg: { type: "warning", payload: { cause: "test", message: "second" } } }, { durable: true });
      expect(readFileSync(store.rolloutPath, "utf8")).toBe(before);
      const events = store.readAll().filter(item => item.type === "event_msg");
      expect(events.map(item => item.payload.seq)).toEqual([1, 2]);
      expect(events[0]!.payload.msg).toMatchObject({ payload: { message: "original" } });
      expect(store.writeBehind.pending).toBe(0);
    } finally { store.close(); }
  });

  it("flushes on close", () => {
    const store = openStore();
    store.writeBehind.beginStep();
    store.append({ id: "one", seq: 1, msg: { type: "warning", payload: { cause: "test", message: "close flush" } } }, { durable: true });
    store.close();
    expect(readFileSync(store.rolloutPath, "utf8")).toContain("close flush");
    expect(store.writeBehind.pending).toBe(0);
  });

  it("drains before executing a retained SQL reader statement", () => {
    const store = openStore();
    const driver = openStateDatabases({ cwd: store.cwd, agencHome: store.agencHome, deferLogs: true });
    const queue = new SessionWriteBehindQueue();
    const unregister = registerSessionWriteBehind(join(dirname(dirname(store.sessionDir)), "sessions", "sql", "rollout.jsonl"), queue);
    try {
      driver.state.exec("CREATE TABLE wb_test(value INTEGER)");
      const read = driver.prepareState<[], { value: number }>("SELECT value FROM wb_test");
      queue.beginStep();
      queue.defer("insert", () => { driver.prepareState("INSERT INTO wb_test VALUES (7)").run(); });
      expect(read.get()).toEqual({ value: 7 });
      expect(queue.pending).toBe(0);
    } finally { unregister(); driver.close(); store.close(); }
  });

  it("sends before flushing and completes the flush before returning provider bytes", async () => {
    const queue = new SessionWriteBehindQueue();
    const seen: string[] = [];
    queue.beginStep();
    queue.defer("persist", () => { seen.push("persist"); });
    const client = new ProviderHttpClientSession({
      providerName: "openai", baseURL: "https://example.test/v1", wireApi: "responses",
      fetchImpl: async () => { seen.push("send"); return new Response("ok"); },
    });
    await withSessionWriteBehind(queue, () => client.requestText({ body: { message: "next" } }));
    expect(seen).toEqual(["send", "persist"]);
    expect(queue.pending).toBe(0);
    expect(queue.deferring).toBe(false);
  });

  it("publishes model deltas while the next response stream is still open", async () => {
    const store = openStore();
    const seen: string[] = [];
    const session = emittingSession(store, seen);
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
    const client = new ProviderHttpClientSession({
      providerName: "openai", baseURL: "https://example.test/v1", wireApi: "responses",
      fetchImpl: async () => { seen.push("send"); return new Response(body); },
    });
    try {
      await withSessionWriteBehind(store.writeBehind, async () => {
        store.writeBehind.beginStep();
        session.emit({ id: "tool-step", msg: { type: "warning", payload: { cause: "test", message: "previous step" } } }, { durable: true });
        expect(seen).toEqual([]);
        const stream = await client.requestStream({ body: {} });
        expect(seen).toEqual(["send", "transport:1"]);
        const reader = stream[Symbol.asyncIterator]();
        try {
          bodyController.enqueue(new TextEncoder().encode("data: first delta\n\n"));
          expect((await reader.next()).done).toBe(false);
          session.emit({ id: "delta", msg: { type: "agent_message_delta", payload: { delta: "first delta" } } });
          expect(seen).toEqual(["send", "transport:1", "transport:2"]);
          expect(store.writeBehind.pending).toBe(0);
        } finally {
          bodyController.close();
          await reader.return?.();
        }
      });
    } finally { store.close(); }
  });

  it("surfaces a flush failure without retrying the model request", async () => {
    const queue = new SessionWriteBehindQueue();
    const failure = new Error("disk unavailable");
    let sends = 0;
    queue.beginStep();
    queue.defer("persist", () => { throw failure; });
    const client = new ProviderHttpClientSession({
      providerName: "openai", baseURL: "https://example.test/v1", wireApi: "responses",
      requestRetry: { maxRetries: 3 },
      fetchImpl: async () => { sends += 1; return new Response("ok"); },
    });
    await expect(withSessionWriteBehind(queue, () => client.requestText({ body: {} }))).rejects.toBe(failure);
    expect(sends).toBe(1);
    expect(queue.pending).toBe(1);
  });
});

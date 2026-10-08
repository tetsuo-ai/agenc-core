import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/session/session-store.js";
import { SessionWriteBehindQueue, registerSessionWriteBehind, withSessionWriteBehind } from "../../src/session/write-behind.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { ProviderHttpClientSession } from "../../src/llm/client-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "write-behind-"));
  roots.push(root);
  const store = new SessionStore({ cwd: root, agencHome: root, sessionId: "test", agencVersion: "0.2.0" });
  store.open({ cwd: root, sessionId: "test", agencVersion: "0.2.0", originator: "test", timestamp: "2026-10-08T00:00:00.000Z" });
  return store;
}

describe("write-behind persistence barriers", () => {
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
  });
});

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../../src/session/session-store.js";
import { assertOneShotRecoverable, promoteOneShotRun, withOneShotWriteScope } from "../../src/durability/one-shot-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { stageSessionSnapshotWrite, writeSessionSnapshotAtomically } from "../../src/state/atomic-snapshot-writes.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, fsyncSync: vi.fn(original.fsyncSync) };
});

const roots: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) { try { f(); } catch {} }
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function setup(relaxed = true) {
  const root = fs.mkdtempSync(join(tmpdir(), "one-shot-snapshot-")); roots.push(root);
  const cwd = join(root, "workspace"), home = join(root, "home"); fs.mkdirSync(cwd); fs.mkdirSync(home);
  const driver = openStateDatabases({ cwd, agencHome: home });
  const store = new SessionStore({ cwd, agencHome: home, sessionId: "run", agencVersion: "test",
    relaxedOneShot: relaxed, checkpointOneShot: () => driver.checkpointDurability() });
  cleanup.push(() => driver.close(), () => store.close());
  store.open({ sessionId: "run", cwd, timestamp: "2026-10-05T00:00:00Z", agencVersion: "test", originator: "test" });
  driver.prepareState("INSERT INTO session_agent_links(session_id, agent_id) VALUES (?, ?)").run("session", "run");
  const record = { sessionId: "session", snapshotAt: "2026-10-05T01:00:00Z", conversationJson: '["answer"]', toolStateJson: '{}', mcpConnectionStateJson: '{}' };
  const options = { replayOnStartup: true, verifyExisting: true, updateRunLastSnapshotAt: true, oneShotRunId: "run" };
  return { cwd, home, driver, store, record, options };
}
const count = (d: StateSqliteDriver) => d.prepareState<[], { n: number }>("SELECT count(*) AS n FROM session_state_snapshots").get()!.n;

describe("one-shot auxiliary snapshot durability", () => {
  it("uses the exact active writer's WAL seal, publishes rows immediately and preserves clean continuation", () => {
    const r = setup(); const sync = vi.mocked(fs.fsyncSync).mockClear(); const levels: unknown[] = [];
    const prepare = r.driver.state.prepare.bind(r.driver.state);
    const spy = vi.spyOn(r.driver.state, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("INSERT INTO session_state_snapshots")) levels.push(r.driver.state.pragma("synchronous", { simple: true }));
      return prepare(sql);
    }) as typeof r.driver.state.prepare);
    writeSessionSnapshotAtomically(r.driver, r.record, r.options);
    expect(count(r.driver)).toBe(1); expect(levels).toEqual([1]); expect(sync).not.toHaveBeenCalled();
    expect(r.driver.state.pragma("synchronous", { simple: true })).toBe(2);
    expect(fs.existsSync(join(r.driver.projectDir, "session_state_snapshots.pending"))).toBe(false);
    spy.mockRestore(); sync.mockClear(); r.store.close();
    expect(() => assertOneShotRecoverable(r.store.rolloutPath)).not.toThrow();
    const reader = openStateDatabases({ cwd: r.cwd, agencHome: r.home }); cleanup.push(() => reader.close());
    expect(count(reader)).toBe(1);
  });
  it.each(["full", "promoted", "foreign-scope", "foreign-driver", "foreign-project", "unbound", "wrong-owner"])("retains staged FULL durability for %s", mode => {
    const r = setup(mode !== "full"); let driver = r.driver;
    if (mode === "promoted") promoteOneShotRun("run");
    if (mode === "foreign-driver") { driver = openStateDatabases({ cwd: r.cwd, agencHome: r.home, durabilityRunId: "other" }); cleanup.push(() => driver.close()); }
    if (mode === "foreign-project") { const cwd = join(r.cwd, "sibling"); fs.mkdirSync(cwd); driver = openStateDatabases({ cwd, agencHome: r.home }); cleanup.push(() => driver.close()); driver.prepareState("INSERT INTO session_agent_links(session_id, agent_id) VALUES (?, ?)").run("session", "run"); }
    if (mode === "unbound") driver.prepareState("DELETE FROM session_agent_links").run();
    if (mode === "wrong-owner") driver.prepareState("UPDATE session_agent_links SET agent_id = ?").run("other");
    const sync = vi.mocked(fs.fsyncSync).mockClear();
    const write = () => writeSessionSnapshotAtomically(driver, r.record, r.options);
    if (mode === "foreign-scope") withOneShotWriteScope(driver.projectDir, "other", write); else write();
    expect(sync).toHaveBeenCalledTimes(3); expect(count(driver)).toBe(1);
    expect(driver.state.pragma("synchronous", { simple: true })).toBe(2);
  });
  it("keeps existing staged retries on the durable path and removes their pending record", () => {
    const r = setup(); const pending = stageSessionSnapshotWrite(r.driver.projectDir, r.record, r.options);
    const sync = vi.mocked(fs.fsyncSync).mockClear(); writeSessionSnapshotAtomically(r.driver, r.record, r.options);
    expect(sync).toHaveBeenCalledTimes(3); expect(fs.existsSync(pending.path)).toBe(false); expect(count(r.driver)).toBe(1);
  });
  it("preserves idempotent verification and rolls back conflicts without changing FULL or the active marker", () => {
    const r = setup(); writeSessionSnapshotAtomically(r.driver, r.record, r.options);
    writeSessionSnapshotAtomically(r.driver, r.record, r.options);
    expect(() => writeSessionSnapshotAtomically(r.driver, { ...r.record, conversationJson: '["changed"]' }, r.options)).toThrow("conflicts");
    expect(count(r.driver)).toBe(1); expect(r.driver.state.pragma("synchronous", { simple: true })).toBe(2);
    expect(JSON.parse(fs.readFileSync(r.store.rolloutPath + ".durability.json", "utf8")).phase).toBe("active");
  });
  it("still rejects nested verified writes before doing any work", () => {
    const r = setup(); expect(() => r.driver.transaction(() => writeSessionSnapshotAtomically(r.driver, r.record, r.options))).toThrow("own transaction");
    expect(count(r.driver)).toBe(0);
  });
});

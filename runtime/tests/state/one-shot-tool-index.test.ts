import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../../src/session/session-store.js";
import { assertOneShotRecoverable, promoteOneShotRun, withOneShotWriteScope } from "../../src/durability/one-shot-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { AgenCSessionSnapshotPolicy } from "../../src/state/snapshot-policy.js";
import { checkUnknownOutcomeMutationGate } from "../../src/state/unknown-outcome-gate.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) f();
});
function setup(relaxed = true) {
  const root = mkdtempSync(join(tmpdir(), "one-shot-tool-index-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd"), home = join(root, "home"); mkdirSync(cwd); mkdirSync(home);
  const driver = openStateDatabases({ cwd, agencHome: home }); cleanup.push(() => driver.close());
  const store = new SessionStore({ cwd, agencHome: home, sessionId: "run", agencVersion: "test",
    relaxedOneShot: relaxed, checkpointOneShot: () => driver.checkpointDurability() });
  cleanup.push(() => store.close());
  store.open({ sessionId: "run", cwd, timestamp: "2026-10-05T00:00:00Z", agencVersion: "test", originator: "test" });
  return { cwd, home, driver, store };
}
function policyFor(driver: StateSqliteDriver, home: string, bind = true) {
  const policy = new AgenCSessionSnapshotPolicy(driver, { agencHome: home, coalesceIntervalMs: 0,
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {} });
  policy.trackSession("session", bind ? "run" : undefined);
  return policy;
}
function start(p: AgenCSessionSnapshotPolicy, id = "call") {
  return p.recordSessionEvent("session", { method: "event.tool_request", params: {
    requestId: id, toolName: "Bash", input: { command: "echo ok" }, recoveryCategory: "side-effecting",
  } });
}
function progress(p: AgenCSessionSnapshotPolicy) {
  return p.recordSessionEvent("session", { method: "event.session_event", params: {
    event: { type: "tool_progress", payload: { callId: "call", chunk: "partial" } },
  } });
}
function complete(p: AgenCSessionSnapshotPolicy, id = "call") {
  return p.recordSessionEvent("session", { method: "event.session_event", params: {
    event: { type: "tool_call_completed", payload: { callId: id, result: "done", isError: false } },
  } });
}
function row(d: StateSqliteDriver, id = "call") {
  return d.prepareState<[string], { status: string; output_partial: string; args_json: string }>(
    "SELECT status, output_partial, args_json FROM in_flight_tool_calls WHERE tool_call_id = ?",
  ).get(id);
}
function watchLevels(d: StateSqliteDriver) {
  const levels: unknown[] = []; const prepare = d.prepareState.bind(d);
  vi.spyOn(d, "prepareState").mockImplementation(((sql: string) => {
    if (/^\s*(INSERT|UPDATE).*in_flight_tool_calls/s.test(sql)) levels.push(d.state.pragma("synchronous", { simple: true }));
    return prepare(sql);
  }) as typeof d.prepareState);
  return levels;
}

describe("one-shot observer tool index transactions", () => {
  it("publishes start/progress/completion independently, restores FULL and seals the shared WAL", () => {
    const r = setup(), p = policyFor(r.driver, r.home), levels = watchLevels(r.driver);
    const reader = openStateDatabases({ cwd: r.cwd, agencHome: r.home }); cleanup.push(() => reader.close());
    start(p); expect(row(reader)?.status).toBe("running");
    expect(JSON.parse(row(reader)!.args_json)).toEqual({ command: "echo ok" });
    progress(p); expect(row(reader)?.output_partial).toBe("partial");
    complete(p); expect(row(reader)).toMatchObject({ status: "completed", output_partial: "done" });
    expect(levels).toEqual([1, 1, 1]); expect(r.driver.state.pragma("synchronous", { simple: true })).toBe(2);
    r.store.close(); expect(() => assertOneShotRecoverable(r.store.rolloutPath)).not.toThrow();
    expect(row(reader)?.status).toBe("completed");
  });
  it.each(["full", "promoted", "foreign-scope", "foreign-driver", "foreign-project", "unbound", "wrong-owner"])("keeps FULL writes for %s", mode => {
    const r = setup(mode !== "full"); let d = r.driver;
    if (mode === "promoted") promoteOneShotRun("run");
    if (mode === "foreign-driver") { d = openStateDatabases({ cwd: r.cwd, agencHome: r.home, durabilityRunId: "other" }); cleanup.push(() => d.close()); }
    if (mode === "foreign-project") { const cwd = join(r.cwd, "sibling"); mkdirSync(cwd); d = openStateDatabases({ cwd, agencHome: r.home }); cleanup.push(() => d.close()); }
    const p = policyFor(d, r.home, mode !== "unbound");
    if (mode === "wrong-owner") d.prepareState("UPDATE session_agent_links SET agent_id = 'other'").run();
    const levels = watchLevels(d); const run = () => { start(p); progress(p); complete(p); };
    if (mode === "foreign-scope") withOneShotWriteScope(d.projectDir, "other", run); else run();
    expect(levels).toEqual([2, 2, 2]); expect(row(d)?.status).toBe("completed");
  });
  it("retains committed start and completion if the later snapshot fails", () => {
    const r = setup(), p = policyFor(r.driver, r.home);
    r.driver.state.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON session_state_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot failed'); END");
    expect(() => start(p)).toThrow("snapshot failed");
    const reader = openStateDatabases({ cwd: r.cwd, agencHome: r.home }); cleanup.push(() => reader.close());
    expect(row(reader)?.status).toBe("running");
    expect(() => complete(p)).toThrow("snapshot failed"); expect(row(reader)?.status).toBe("completed");
    expect(r.driver.state.pragma("synchronous", { simple: true })).toBe(2);
  });
  it("rolls back failed index writes and restores FULL without authorizing recovery", () => {
    const r = setup(), p = policyFor(r.driver, r.home);
    r.driver.state.exec("CREATE TRIGGER reject_index BEFORE INSERT ON in_flight_tool_calls BEGIN SELECT RAISE(ABORT, 'index failed'); END");
    expect(() => start(p)).toThrow("index failed"); expect(row(r.driver)).toBeUndefined();
    expect(r.driver.state.pragma("synchronous", { simple: true })).toBe(2);
    expect(JSON.parse(readFileSync(r.store.rolloutPath + ".durability.json", "utf8")).phase).toBe("active");
  });
  it("retains poison gates, observer flags, locked rows and orphan completion", () => {
    const r = setup(), p = policyFor(r.driver, r.home);
    start(p); r.driver.prepareState("UPDATE in_flight_tool_calls SET status = 'poisoned'").run();
    const snapshot = start(p, "next");
    expect(JSON.stringify(snapshot?.toolState)).toContain("unknownOutcomeGateViolation");
    expect(checkUnknownOutcomeMutationGate(r.driver, { sessionId: "session", recoveryCategory: "side-effecting" }).allowed).toBe(false);
    complete(p); expect(row(r.driver)?.status).toBe("poisoned");
    complete(p, "orphan"); expect(row(r.driver, "orphan")?.status).toBe("completed");
  });
});

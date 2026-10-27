/**
 * The daemon's in-flight index row for an idempotent call is observer state:
 * no recovery, unknown-outcome gate, budget or effect decision reads it. It
 * commits without its own fsync and leaves the connection at FULL; every
 * side-effecting or interactive authority transition keeps its FULL commit.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { AgenCSessionSnapshotPolicy } from "../../src/state/snapshot-policy.js";
import { checkUnknownOutcomeMutationGate } from "../../src/state/unknown-outcome-gate.js";
import { recordInFlightToolCallUnknownOutcome } from "../../src/state/tool-output-rotation.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "observational-tool-index-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd"), home = join(root, "home");
  mkdirSync(cwd); mkdirSync(home);
  const driver = openStateDatabases({ cwd, agencHome: home });
  cleanup.push(() => driver.close());
  const policy = new AgenCSessionSnapshotPolicy(driver, { agencHome: home, coalesceIntervalMs: 0,
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {} });
  policy.trackSession("session", "run");
  return { cwd, home, driver, policy };
}

function watchLevels(driver: StateSqliteDriver): unknown[] {
  const levels: unknown[] = [];
  const prepare = driver.prepareState.bind(driver);
  vi.spyOn(driver, "prepareState").mockImplementation(((sql: string) => {
    if (/^\s*(INSERT|UPDATE).*in_flight_tool_calls/s.test(sql)) {
      levels.push(driver.state.pragma("synchronous", { simple: true }));
    }
    return prepare(sql);
  }) as typeof driver.prepareState);
  return levels;
}

function call(policy: AgenCSessionSnapshotPolicy, id: string, toolName: string, recoveryCategory: string): void {
  policy.recordSessionEvent("session", { method: "event.tool_request", params: {
    requestId: id, toolName, input: { path: "input.txt" }, recoveryCategory,
  } });
  policy.recordSessionEvent("session", { method: "event.session_event", params: {
    event: { type: "tool_progress", payload: { callId: id, chunk: "partial" } },
  } });
  policy.recordSessionEvent("session", { method: "event.session_event", params: {
    event: { type: "tool_call_completed", payload: { callId: id, result: "done", isError: false } },
  } });
}

function row(driver: StateSqliteDriver, id: string) {
  return driver.prepareState<[string], { status: string; recovery_category: string }>(
    "SELECT status, recovery_category FROM in_flight_tool_calls WHERE tool_call_id = ?",
  ).get(id);
}

describe("observer index rows for idempotent calls", () => {
  it("commits idempotent start, progress and completion rows without an fsync, then restores FULL", () => {
    const { cwd, home, driver, policy } = setup();
    const levels = watchLevels(driver);
    call(policy, "read", "FileRead", "idempotent");
    expect(levels).toEqual([1, 1, 1]);
    expect(driver.state.pragma("synchronous", { simple: true })).toBe(2);
    const reader = openStateDatabases({ cwd, agencHome: home });
    cleanup.push(() => reader.close());
    expect(row(reader, "read")).toEqual({ status: "completed", recovery_category: "idempotent" });
  });

  it.each(["side-effecting", "interactive"])("keeps FULL start/completion commits for %s while output-only progress is observational", (category) => {
    const { driver, policy } = setup();
    const levels = watchLevels(driver);
    call(policy, "write", "Write", category);
    expect(levels).toEqual([2, 1, 2]);
    expect(row(driver, "write")?.status).toBe("completed");
  });

  it("leaves the unknown-outcome gate to side-effecting evidence", () => {
    const { driver, policy } = setup();
    call(policy, "read", "FileRead", "idempotent");
    expect(checkUnknownOutcomeMutationGate(driver, { sessionId: "session", recoveryCategory: "side-effecting" }).allowed).toBe(true);
    policy.recordSessionEvent("session", { method: "event.tool_request", params: {
      requestId: "shell", toolName: "exec_command", input: { cmd: "touch x" }, recoveryCategory: "side-effecting",
    } });
    recordInFlightToolCallUnknownOutcome(driver, { sessionId: "session", agentId: "run", toolCallId: "shell",
      toolName: "exec_command", observedAt: new Date().toISOString(), recoveryCategory: "side-effecting" });
    expect(checkUnknownOutcomeMutationGate(driver, { sessionId: "session", recoveryCategory: "side-effecting" }).allowed).toBe(false);
    expect(checkUnknownOutcomeMutationGate(driver, { sessionId: "session", recoveryCategory: "idempotent" }).allowed).toBe(true);
  });
});

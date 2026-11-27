import { copyFileSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openStateDatabases, openStateDatabasePaths, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { recordInFlightToolCallStart, recordInFlightToolCallProgress, recordInFlightToolCallCompletion } from "../../src/state/tool-output-rotation.js";
import { recoverDaemonStateOnStartup } from "../../src/state/recovery.js";
import { checkUnknownOutcomeMutationGate } from "../../src/state/unknown-outcome-gate.js";

let root: string;
const drivers: StateSqliteDriver[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tool-progress-durability-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0).reverse()) driver.close();
  rmSync(root, { recursive: true, force: true });
});
function setup() {
  const cwd = join(root, "cwd"), home = join(root, "home");
  mkdirSync(cwd); mkdirSync(home);
  const driver = openStateDatabases({ cwd, agencHome: home });
  drivers.push(driver);
  driver.state.pragma("wal_autocheckpoint = 0");
  return { driver, home, cwd };
}
const identity = { sessionId: "session", toolCallId: "call", toolName: "exec_command", recoveryCategory: "side-effecting" as const };
function start(driver: StateSqliteDriver, home: string) {
  recordInFlightToolCallStart(driver, { ...identity, agencHome: home, args: { cmd: "write once" }, startedAt: new Date(0).toISOString() });
}
function progress(driver: StateSqliteDriver, home: string, extra = {}) {
  recordInFlightToolCallProgress(driver, { ...identity, agencHome: home, chunk: "partial\n", observedAt: new Date(1).toISOString(), ...extra });
}
function row(driver: StateSqliteDriver) {
  return driver.prepareState<[], { status: string; args_json: string; recovery_category: string; output_partial: string | null }>(
    "SELECT status, args_json, recovery_category, output_partial FROM in_flight_tool_calls WHERE tool_call_id = 'call'",
  ).get()!;
}
function lostTail(driver: StateSqliteDriver, bytes: number, name: string) {
  const image = join(root, name); mkdirSync(image);
  const stateDbPath = join(image, "agenc-state_1.sqlite");
  copyFileSync(driver.stateDbPath, stateDbPath);
  copyFileSync(`${driver.stateDbPath}-wal`, `${stateDbPath}-wal`);
  const fd = openSync(`${stateDbPath}-wal`, "r+");
  try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
  const recovered = openStateDatabasePaths({ projectDir: image, stateDbPath, logsDbPath: join(image, "agenc-logs_1.sqlite") });
  drivers.push(recovered); return recovered;
}
it("publishes partial output to another connection immediately and restores FULL", () => {
  const { driver, home, cwd } = setup(); start(driver, home); progress(driver, home);
  const reader = openStateDatabases({ cwd, agencHome: home }); drivers.push(reader);
  expect(row(reader)).toMatchObject({ status: "running", recovery_category: "side-effecting", output_partial: "partial\n" });
  expect(driver.state.pragma("synchronous", { simple: true })).toBe(2);
});
it("retains the mutation gate if power loss drops every output-only WAL frame", () => {
  const { driver, home } = setup(); start(driver, home);
  const durableBytes = statSync(`${driver.stateDbPath}-wal`).size;
  for (let i = 0; i < 20; i++) progress(driver, home);
  expect(statSync(`${driver.stateDbPath}-wal`).size).toBeGreaterThan(durableBytes);
  const recovered = lostTail(driver, durableBytes, "power-loss");
  expect(row(recovered)).toMatchObject({ status: "running", recovery_category: "side-effecting", output_partial: null, args_json: JSON.stringify({ cmd: "write once" }) });
  for (let i = 0; i < 2; i++) {
    recoverDaemonStateOnStartup(recovered);
    expect(row(recovered).status).toBe("poisoned");
    expect(checkUnknownOutcomeMutationGate(recovered, { sessionId: "session", recoveryCategory: "side-effecting" }).allowed).toBe(false);
  }
});
it("keeps completion durable together with its preceding output", () => {
  const { driver, home } = setup(); start(driver, home); progress(driver, home);
  recordInFlightToolCallCompletion(driver, { ...identity, agencHome: home, result: "done", isError: false, completedAt: new Date(2).toISOString() });
  const recovered = lostTail(driver, statSync(`${driver.stateDbPath}-wal`).size, "completed");
  recoverDaemonStateOnStartup(recovered);
  expect(row(recovered)).toMatchObject({ status: "completed", recovery_category: "side-effecting" });
  expect(checkUnknownOutcomeMutationGate(recovered, { sessionId: "session", recoveryCategory: "side-effecting" }).allowed).toBe(true);
});
it("keeps orphan backfill and category changes at FULL", () => {
  const { driver, home } = setup();
  const levels: number[] = []; const prepare = driver.prepareState.bind(driver);
  vi.spyOn(driver, "prepareState").mockImplementation(((sql: string) => {
    if (/^\s*(INSERT|UPDATE).*in_flight_tool_calls/s.test(sql)) levels.push(Number(driver.state.pragma("synchronous", { simple: true })));
    return prepare(sql);
  }) as typeof driver.prepareState);
  progress(driver, home);
  expect(levels).toEqual([2, 1]);
  levels.length = 0;
  progress(driver, home, { recoveryCategory: "interactive" });
  expect(levels).toEqual([2]);
  expect(row(driver).recovery_category).toBe("interactive");
});
it("writes output at FULL when an observational update matches no row", () => {
  const { driver, home } = setup();
  start(driver, home);
  const prepare = driver.prepareState.bind(driver);
  let observational = 0;
  vi.spyOn(driver, "prepareState").mockImplementation(((sql: string) => {
    if (sql.includes("AND (? IS NULL OR recovery_category = ?)")) {
      observational += 1;
      return { run: () => ({ changes: 0 }) };
    }
    return prepare(sql);
  }) as typeof driver.prepareState);
  progress(driver, home);
  expect(observational).toBe(1);
  expect(row(driver)).toMatchObject({
    status: "running",
    recovery_category: "side-effecting",
    output_partial: "partial\n",
  });
});
it("restores FULL and rolls back an output update that throws", () => {
  const { driver, home } = setup(); start(driver, home);
  const prepare = driver.prepareState.bind(driver);
  vi.spyOn(driver, "prepareState").mockImplementation(((sql: string) => {
    if (sql.includes("SET output_partial = ?, output_log_path = ?, output_log_bytes = ?")) throw new Error("injected write failure");
    return prepare(sql);
  }) as typeof driver.prepareState);
  expect(() => progress(driver, home)).toThrow("injected write failure");
  expect(driver.state.pragma("synchronous", { simple: true })).toBe(2);
  expect(row(driver)).toMatchObject({ status: "running", recovery_category: "side-effecting", output_partial: null });
});

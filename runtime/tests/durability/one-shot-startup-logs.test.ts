import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { ErrorLogSidecar } from "../../src/session/error-log.js";
import { StateSqliteDriver, StateSqliteReader } from "../../src/state/sqlite-driver.js";
import { LogsRepository } from "../../src/state/logs.js";
import { assertOneShotRecoverable, promoteOneShotRun } from "../../src/durability/one-shot-durability.js";

const roots: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function openRun(relaxed = true) {
  const root = mkdtempSync(join(tmpdir(), "one-shot-startup-logs-")); roots.push(root);
  const cwd = join(root, "workspace"), home = join(root, "home"); mkdirSync(cwd); mkdirSync(home);
  let sidecar: ErrorLogSidecar;
  const beforeCheckpoint = vi.fn(() => sidecar.flushStartupIndex());
  const store = new RolloutStore({ cwd, agencHome: home, sessionId: "startup-logs-run", agencVersion: "test",
    sessionTempRoot: root, autoStartScheduler: false, relaxedOneShot: relaxed, beforeOneShotCheckpoint: beforeCheckpoint });
  cleanups.push(() => store.close());
  store.open({ sessionId: "startup-logs-run", cwd, timestamp: "2026-10-04T00:00:00Z", agencVersion: "test", originator: "test" });
  const projectDir = dirname(dirname(dirname(store.rolloutPath)));
  const paths = { projectDir, stateDbPath: join(projectDir, "agenc-state_1.sqlite"), logsDbPath: join(projectDir, "agenc-logs_1.sqlite") };
  sidecar = new ErrorLogSidecar({ projectDir, sessionId: "startup-logs-run", deferStartupIndex: relaxed });
  cleanups.push(() => sidecar.stop());
  const warn = (seq: number) => {
    const event = { id: String(seq), eventId: String(seq), seq,
      msg: { type: "warning" as const, payload: { cause: "cron_storage_unavailable", message: `warning ${seq}` } } };
    expect(store.append(event, { durable: true })).toBe(true); sidecar.onEvent(event);
  };
  const messages = () => {
    const reader = new StateSqliteReader(paths);
    try { return reader.prepareLogs("SELECT message FROM logs ORDER BY id").all(); } finally { reader.close(); }
  };
  warn(1);
  return { store, sidecar, paths, messages, warn, beforeCheckpoint };
}

it.each(["close", "promotion"])("drains before the real FULL checkpoint and %s seal", action => {
  const run = openRun();
  expect(existsSync(run.paths.logsDbPath)).toBe(false);
  const original = StateSqliteDriver.prototype.checkpointDurability;
  const checkpoint = vi.spyOn(StateSqliteDriver.prototype, "checkpointDurability").mockImplementation(function (this: StateSqliteDriver) {
    expect(run.messages()).toEqual([{ message: "warning 1" }]);
    expect(this.state.pragma("synchronous", { simple: true })).toBe(2);
    expect(this.logs.pragma("synchronous", { simple: true })).toBe(2);
    return original.call(this);
  });
  if (action === "close") run.store.close();
  else {
    promoteOneShotRun("startup-logs-run");
    run.warn(2);
    expect(run.messages()).toEqual([{ message: "warning 1" }, { message: "warning 2" }]);
    run.store.close();
  }
  expect(checkpoint).toHaveBeenCalledOnce();
  expect(run.beforeCheckpoint).toHaveBeenCalledOnce();
  expect(() => assertOneShotRecoverable(run.store.rolloutPath)).not.toThrow();
});
it("supports sidecar shutdown before the seal with no duplicate rows", async () => {
  const run = openRun(); await run.sidecar.stop(); run.store.close();
  expect(run.messages()).toEqual([{ message: "warning 1" }]);
  expect(() => assertOneShotRecoverable(run.store.rolloutPath)).not.toThrow();
});
it("does not attach a one-shot checkpoint callback to full sessions", () => {
  const run = openRun(false); run.store.close();
  expect(run.beforeCheckpoint).not.toHaveBeenCalled();
  expect(run.messages()).toEqual([{ message: "warning 1" }]);
});
it("keeps best-effort index loss separate from successful checkpoint/seal", () => {
  const run = openRun();
  const append = vi.spyOn(LogsRepository.prototype, "tryAppend").mockReturnValue(false);
  run.store.close(); run.sidecar.flushStartupIndex();
  expect(append).toHaveBeenCalledOnce();
  expect(run.messages()).toEqual([]);
  expect(() => assertOneShotRecoverable(run.store.rolloutPath)).not.toThrow();
});
it("refuses a completion seal if deferred database creation fails", () => {
  const run = openRun(); mkdirSync(run.paths.logsDbPath);
  expect(() => run.store.close()).toThrow();
  expect(() => assertOneShotRecoverable(run.store.rolloutPath)).toThrow("no valid durable completion seal");
});
it("refuses a completion seal when the logs FULL checkpoint is busy", () => {
  const run = openRun();
  const original = StateSqliteDriver.prototype.checkpointDurability;
  vi.spyOn(StateSqliteDriver.prototype, "checkpointDurability").mockImplementation(function (this: StateSqliteDriver) {
    const pragma = this.logs.pragma.bind(this.logs);
    vi.spyOn(this.logs, "pragma").mockImplementation(((sql: string, options?: unknown) =>
      sql === "wal_checkpoint(FULL)" ? [{ busy: 1, log: 2, checkpointed: 1 }] : pragma(sql, options as never)) as typeof this.logs.pragma);
    return original.call(this);
  });
  expect(() => run.store.close()).toThrow("WAL checkpoint did not complete");
  expect(() => assertOneShotRecoverable(run.store.rolloutPath)).toThrow("no valid durable completion seal");
});

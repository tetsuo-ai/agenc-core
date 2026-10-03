import { fsyncSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOneShotRecoverable, promoteOneShotRun, relaxedOneShotTransaction, selectRelaxedOneShot, withOneShotWriteScope } from "../../src/durability/one-shot-durability.js";
import { commitSessionGoal } from "../../src/goal/session-goal.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { SessionStore } from "../../src/session/session-store.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { withPinnedOfflineRolloutLease } from "../../src/durability/offline-rollout.js";
import { readStartupCliFlags } from "../../src/bin/startup-selection.js";
import { resolveAgentRuntimeOptions, validateAgentRuntimeOptions } from "../../src/session/runtime-options.js";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function environment() {
  const root = mkdtempSync(join(tmpdir(), "one-shot-policy-")); roots.push(root);
  const cwd = join(root, "workspace"), home = join(root, "home");
  mkdirSync(cwd); mkdirSync(home);
  return { root, cwd, home };
}
function openRun(relaxed: boolean, checkpoint?: () => void) {
  const env = environment();
  const driver = openStateDatabases({ cwd: env.cwd, agencHome: env.home, durabilityRunId: "run" });
  const opts = { cwd: env.cwd, agencHome: env.home, sessionId: "run", agencVersion: "test" };
  const store = new SessionStore({ ...opts, relaxedOneShot: relaxed, checkpointOneShot: checkpoint ?? (() => driver.checkpointDurability()) });
  cleanups.push(() => driver.close(), () => store.close());
  store.open({ sessionId: "run", cwd: env.cwd, timestamp: "2026-10-03T00:00:00Z", agencVersion: "test", originator: "test" });
  const append = (seq = 1) => store.append({ id: `event-${seq}`, eventId: `event-${seq}`, seq,
    msg: { type: "agent_message", payload: { message: `answer ${seq}` } } }, { durable: true });
  return { ...env, opts, driver, store, append };
}

describe("one-shot durability selection", () => {
  const eligible = { requested: true, nonInteractive: true, source: "agenc.prompt", mode: "one-shot" };
  it("selects only an explicitly requested fresh print run", () => {
    expect(selectRelaxedOneShot(eligible)).toBe(true);
    for (const override of [{ requested: false }, { requested: undefined }, { nonInteractive: false },
      { source: "desktop" }, { source: undefined }, { mode: "tui" }, { resumed: true },
      { routine: true }, { goal: true }]) expect(selectRelaxedOneShot({ ...eligible, ...override })).toBe(false);
  });
  it("captures an opt-out only in the actual CLI option region", () => {
    expect(readStartupCliFlags(["node", "agenc", "-p", "--full-durability", "work"]).fullDurability).toBe(true);
    expect(readStartupCliFlags(["node", "agenc", "-p", "explain --full-durability"]).fullDurability).toBeUndefined();
    expect(readStartupCliFlags(["node", "agenc", "-p", "--", "--full-durability"]).fullDurability).toBeUndefined();
  });
  it("defaults old wire clients to full and rejects malformed policy", () => {
    const defaults = resolveAgentRuntimeOptions({});
    expect(validateAgentRuntimeOptions(defaults).relaxedOneShot).toBeUndefined();
    expect(validateAgentRuntimeOptions({ ...defaults, relaxedOneShot: true }).relaxedOneShot).toBe(true);
    expect(() => validateAgentRuntimeOptions({ ...defaults, relaxedOneShot: "true" })).toThrow("must be boolean");
  });
});

describe("one-shot physical writes and shared SQLite isolation", () => {
  it.each([false, true])("append sync selection relaxed=%s and clean full continuation", relaxed => {
    const run = openRun(relaxed);
    let syncs = 0;
    run.store.setFsyncImplForTest(fd => { syncs++; fsyncSync(fd); });
    expect(run.append()).toBe(true);
    expect(syncs).toBe(relaxed ? 0 : 1);
    run.store.close();
    if (relaxed) expect(syncs).toBeGreaterThan(0);
    expect(() => assertOneShotRecoverable(run.store.rolloutPath)).not.toThrow();
    const resumed = new SessionStore({ ...run.opts, resume: true, resumeRolloutPath: run.store.rolloutPath });
    cleanups.push(() => resumed.close());
    resumed.open({ sessionId: "run", cwd: run.cwd, timestamp: "2026-10-03T00:00:00Z", agencVersion: "test", originator: "test" });
    let resumedSyncs = 0;
    resumed.setFsyncImplForTest(fd => { resumedSyncs++; fsyncSync(fd); });
    expect(resumed.append({ id: "next", eventId: "next", seq: 2, msg: { type: "agent_message", payload: { message: "continued" } } }, { durable: true })).toBe(true);
    expect(resumedSyncs).toBe(1);
  });
  it("uses NORMAL only inside the explicitly owned transaction and restores FULL on errors", () => {
    const run = openRun(true);
    const shared = openStateDatabases({ cwd: run.cwd, agencHome: run.home }); cleanups.push(() => shared.close());
    const level = (driver: StateSqliteDriver) => driver.state.pragma("synchronous", { simple: true });
    expect(level(run.driver)).toBe(2);
    run.driver.transactionImmediate(() => expect(level(run.driver)).toBe(1));
    shared.transactionImmediate(() => expect(level(shared)).toBe(2));
    withOneShotWriteScope(shared.projectDir, "run", () => shared.transactionImmediate(() => expect(level(shared)).toBe(1)));
    withOneShotWriteScope(shared.projectDir, "interactive", () => shared.transactionImmediate(() => expect(level(shared)).toBe(2)));
    expect(() => withOneShotWriteScope(shared.projectDir, "run", () => shared.transactionImmediate(() => { throw new Error("injected"); }))).toThrow("injected");
    expect(level(shared)).toBe(2);
    expect(() => withOneShotWriteScope(shared.projectDir, "run", () => shared.transactionImmediate(() =>
      withOneShotWriteScope(shared.projectDir, "interactive", () => shared.transactionImmediate(() => {}))))).toThrow("cannot nest");
    expect(level(shared)).toBe(2);
    withOneShotWriteScope(run.driver.projectDir, "interactive", () => run.driver.transactionImmediate(() => {
      expect(level(run.driver)).toBe(2);
      withOneShotWriteScope(run.driver.projectDir, "run", () => run.driver.transactionImmediate(() => expect(level(run.driver)).toBe(2)));
    }));
  });
  it("promotes through the actual goal commit before publishing", () => {
    const run = openRun(true); run.append();
    const emit = vi.fn(() => expect(relaxedOneShotTransaction(run.driver.projectDir, "run")).toBe(false));
    commitSessionGoal({ conversationId: "run", emit, nextInternalSubId: () => "goal" }, {
      id: "goal", objective: "finish", verification: [], criteria: [], constraints: [], budget: { maxRounds: 1 },
      status: "active", rounds: 0, stalledRounds: 0, startedAt: "2026-10-03T00:00:00Z", startCostUsd: 0,
    }, "set");
    expect(emit).toHaveBeenCalledOnce();
  });
  it("promotes at actual spawn admission before returning a lease", async () => {
    const run = openRun(true); run.append();
    const kernel = new ExecutionAdmissionKernel({ agencHome: run.home, ownerId: "test", ownerPid: process.pid });
    cleanups.push(() => kernel.close());
    const client = kernel.bindClient({ cwd: run.cwd, scope: { runId: "run", sessionId: "run", autonomous: false } });
    await client.acquire({ stepId: "spawn", kind: "spawn", maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 });
    expect(relaxedOneShotTransaction(run.driver.projectDir, "run")).toBe(false);
  });
  it("promotes before goals or spawns and keeps subsequent appends and transactions full", () => {
    const run = openRun(true); run.append();
    promoteOneShotRun("run");
    expect(relaxedOneShotTransaction(run.driver.projectDir, "run")).toBe(false);
    let syncs = 0; run.store.setFsyncImplForTest(fd => { syncs++; fsyncSync(fd); });
    run.append(2); expect(syncs).toBe(1);
    run.driver.transactionImmediate(() => expect(run.driver.state.pragma("synchronous", { simple: true })).toBe(2));
  });
  it("refuses a busy or partial WAL checkpoint", () => {
    const run = openRun(true); run.append();
    const original = run.driver.state.pragma.bind(run.driver.state);
    const spy = vi.spyOn(run.driver.state, "pragma").mockImplementation(((sql: string, opts?: unknown) =>
      sql === "wal_checkpoint(FULL)" ? [{ busy: 1, log: 3, checkpointed: 1 }] : original(sql, opts as never)) as typeof run.driver.state.pragma);
    expect(() => run.store.close()).toThrow("WAL checkpoint did not complete");
    spy.mockRestore();
    expect(() => assertOneShotRecoverable(run.store.rolloutPath)).toThrow("no valid durable completion seal");
  });
  it("does not seal a failed final checkpoint", () => {
    const run = openRun(true, () => { throw new Error("injected checkpoint failure"); }); run.append();
    expect(() => run.store.close()).toThrow("injected checkpoint failure");
    expect(() => assertOneShotRecoverable(run.store.rolloutPath)).toThrow("no valid durable completion seal");
  });
  it("keeps a failed final fsync unsealed", () => {
    const run = openRun(true); run.append();
    run.store.setFsyncImplForTest(() => { throw new Error("injected final sync failure"); });
    expect(() => run.store.close()).toThrow("injected final sync failure");
    expect(() => assertOneShotRecoverable(run.store.rolloutPath)).toThrow("no valid durable completion seal");
  });
  it("refuses an invalid seal and failed seal publication", () => {
    const run = openRun(true); run.append();
    const marker = `${run.store.rolloutPath}.durability.json`;
    unlinkSync(marker); mkdirSync(marker);
    expect(() => run.store.close()).toThrow();
    expect(() => assertOneShotRecoverable(run.store.rolloutPath)).toThrow();
    rmSync(marker, { recursive: true });
    writeFileSync(marker, "{truncated");
    expect(() => assertOneShotRecoverable(run.store.rolloutPath)).toThrow("no valid durable completion seal");
  });
  it.each(["partial-row", "complete-row"])("refuses %s suffix loss even with a completed seal before repair", truncation => {
    const run = openRun(true); run.append(); run.append(2); run.store.close();
    const original = readFileSync(run.store.rolloutPath);
    const previousLineEnd = original.lastIndexOf(10, original.length - 2) + 1;
    truncateSync(run.store.rolloutPath, truncation === "complete-row" ? previousLineEnd : original.length - 7);
    const damaged = readFileSync(run.store.rolloutPath);
    expect(() => withPinnedOfflineRolloutLease({ projectDir: run.driver.projectDir, sessionId: "run", sourcePath: run.store.rolloutPath }, () => {}))
      .toThrow("differs from its durable completion seal");
    expect(readFileSync(run.store.rolloutPath)).toEqual(damaged);
    const resumed = new SessionStore({ ...run.opts, resume: true, resumeRolloutPath: run.store.rolloutPath });
    expect(() => resumed.open({ sessionId: "run", cwd: run.cwd, timestamp: "2026-10-03T00:00:00Z", agencVersion: "test", originator: "test" }))
      .toThrow("differs from its durable completion seal");
    expect(readFileSync(run.store.rolloutPath)).toEqual(damaged);
  });
});

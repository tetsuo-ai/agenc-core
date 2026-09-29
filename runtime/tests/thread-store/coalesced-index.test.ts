import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir as temporaryRoot } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { backfillProjectRollouts } from "../../src/state/backfill.js";
import { FileThreadStore } from "../../src/thread-store/store.js";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const directory = mkdtempSync(pathJoin(temporaryRoot(), "agenc-coalesced-index-"));
  const cwd = pathJoin(directory, "project"); const agencHome = pathJoin(directory, "home");
  mkdirSync(pathJoin(cwd, ".git"), { recursive: true });
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new FileThreadStore({ cwd, agencHome });
  const rollout = new RolloutStore({ cwd, agencHome, sessionId: "coalesced", agencVersion: "0.18.0", sessionTempRoot: directory });
  rollout.open({ sessionId: "coalesced", timestamp: "2026-09-29T00:00:00.000Z", cwd, originator: "test", agencVersion: "0.18.0", model: "fixture", modelProvider: "fixture" });
  store.createThread({ threadId: "coalesced", rolloutStore: rollout, model: "fixture" });
  const driver = openStateDatabases({ cwd, agencHome });
  cleanup.push(() => { store.close(); rollout.close(); driver.close(); });
  const append = (content: string) => rollout.appendRollout({ type: "response_item", payload: { role: "user", content } }, { durable: true });
  return { store, rollout, driver, append };
}
function rows(driver: StateSqliteDriver): number {
  return driver.prepareState<[], { n: number }>("SELECT COUNT(*) AS n FROM thread_rollout_items").get()!.n;
}

test("durable appends precede a single coalesced projection", () => {
  const f = fixture(); vi.useFakeTimers();
  const prior = rows(f.driver);
  const project = vi.spyOn(StateThreadRepository.prototype, "commitRolloutProjection");
  f.append("first"); f.append("second");
  expect(readFileSync(f.rollout.rolloutPath, "utf8")).toContain('"content":"second"');
  expect(rows(f.driver)).toBe(prior);
  expect(project).not.toHaveBeenCalled();
  vi.advanceTimersByTime(250);
  expect(rows(f.driver)).toBe(prior + 2);
  expect(project).toHaveBeenCalledTimes(1);
});

test("listing and explicit flush preserve immediate read visibility", () => {
  const f = fixture(); const prior = rows(f.driver);
  f.append("list catches up");
  f.store.listThreads({ pageSize: 10, archived: false, useStateDbOnly: true });
  expect(rows(f.driver)).toBe(prior + 1);
  f.append("flush catches up"); f.store.flushThread("coalesced");
  expect(rows(f.driver)).toBe(prior + 2);
  f.append("close catches up"); f.store.close();
  expect(rows(f.driver)).toBe(prior + 3);
});

test("failed derived projection cannot roll back a durable append and retries on read", () => {
  const f = fixture(); vi.useFakeTimers(); const prior = rows(f.driver);
  const project = vi.spyOn(StateThreadRepository.prototype, "commitRolloutProjection")
    .mockImplementationOnce(() => { throw new Error("index unavailable"); });
  expect(() => f.append("recoverable")).not.toThrow();
  expect(() => vi.advanceTimersByTime(250)).not.toThrow();
  expect(rows(f.driver)).toBe(prior);
  project.mockRestore();
  f.store.listThreads({ pageSize: 10, archived: false, useStateDbOnly: true });
  expect(rows(f.driver)).toBe(prior + 1);
});

test("recovery reconstructs the durable tail when no live projection was published", () => {
  const f = fixture(); const prior = rows(f.driver);
  f.append("survives missing projection");
  expect(rows(f.driver)).toBe(prior);
  // Rebuild uses only canonical bytes, just as after losing the process's queue.
  backfillProjectRollouts({ projectDir: f.driver.projectDir, driver: f.driver });
  expect(rows(f.driver)).toBe(prior + 1);
  f.store.flushThread("coalesced");
  expect(rows(f.driver)).toBe(prior + 1);
});

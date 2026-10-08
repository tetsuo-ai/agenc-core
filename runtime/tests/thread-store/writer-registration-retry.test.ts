import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { FileThreadStore, ThreadNotFoundError } from "../../src/thread-store/store.js";

interface Fixture {
  readonly directory: string;
  readonly store: FileThreadStore;
  readonly rollout: RolloutStore;
  readonly driver: StateSqliteDriver;
}

const fixtures: Fixture[] = [];

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "agenc-writer-retry-"));
  const cwd = join(directory, "project");
  const agencHome = join(directory, "home");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const store = new FileThreadStore({ cwd, agencHome });
  store.listThreads({ pageSize: 10, archived: false });
  const rollout = new RolloutStore({
    cwd, agencHome, sessionId: "thread-retry", agencVersion: "0.17.0", sessionTempRoot: directory,
  });
  rollout.open({
    sessionId: "thread-retry", timestamp: "2026-05-01T00:00:00.000Z", cwd,
    originator: "writer-retry-test", agencVersion: "0.17.0", model: "fixture-model", modelProvider: "fixture",
  });
  rollout.flushDurable();
  const driver = openStateDatabases({ cwd, agencHome });
  const result = { directory, store, rollout, driver };
  fixtures.push(result);
  return result;
}

// Registration reads the requested thread's registry row under the registry lock. Rollout
// indexing also calls getThread, outside the lock, so fail only the first read made under it.
function failRegistryRead(current: Fixture) {
  const lockPath = `${current.store.registryFilePath}.lock`;
  const original = StateThreadRepository.prototype.getThread;
  let failed = false;
  const read = vi.spyOn(StateThreadRepository.prototype, "getThread")
    .mockImplementation(function (this: StateThreadRepository, ...args) {
      if (!failed && existsSync(lockPath)) {
        failed = true;
        throw new Error("registry read failed");
      }
      return original.apply(this, args);
    });
  return { read, reached: () => failed };
}

function register(current: Fixture, operation: "createThread" | "resumeThread"): void {
  current.store[operation]({
    threadId: "thread-retry", rolloutStore: current.rollout, model: "attempt-model",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const current of fixtures.splice(0)) {
    current.store.close();
    current.rollout.close();
    current.driver.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

describe.each(["createThread", "resumeThread"] as const)("%s writer publication", (operation) => {
  test("does not retain a live writer after a registry read failure", () => {
    const current = fixture();
    const fault = failRegistryRead(current);
    expect(() => register(current, operation)).toThrow("registry read failed");
    expect(fault.reached()).toBe(true);
    expect(() => current.store.appendItems({ threadId: "thread-retry", items: [] }))
      .toThrow(ThreadNotFoundError);
    fault.read.mockRestore();
    expect(() => register(current, operation)).not.toThrow();
    expect(current.store.readThread({ threadId: "thread-retry", includeHistory: false, includeArchived: false }).model)
      .toBe("attempt-model");
  });

  test("can retry after the registry mutator reaches a failing SQLite upsert", () => {
    const current = fixture();
    current.driver.state.exec(`CREATE TRIGGER reject_registration BEFORE INSERT ON threads
      WHEN NEW.model = 'attempt-model'
      BEGIN SELECT RAISE(ABORT, 'registry upsert failed'); END`);
    expect(() => register(current, operation)).toThrow("registry upsert failed");
    expect(() => current.store.appendItems({ threadId: "thread-retry", items: [] }))
      .toThrow(ThreadNotFoundError);
    current.driver.state.exec("DROP TRIGGER reject_registration");
    expect(() => register(current, operation)).not.toThrow();
    expect(current.store.readThread({ threadId: "thread-retry", includeHistory: false, includeArchived: false }).model)
      .toBe("attempt-model");
  });

  test("leaves no live writer when registry lock acquisition fails", () => {
    const current = fixture();
    const lockPath = `${current.store.registryFilePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "holder.pid"), String(process.pid));
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 31_000;
      return now;
    });
    expect(() => register(current, operation)).toThrow("failed to acquire registry lock");
    clock.mockRestore();
    rmSync(lockPath, { recursive: true });
    expect(() => current.store.appendItems({ threadId: "thread-retry", items: [] }))
      .toThrow(ThreadNotFoundError);
    expect(() => register(current, operation)).not.toThrow();
  });

  test("preserves a valid writer when a second registration is rejected", () => {
    const current = fixture();
    register(current, operation);
    const callback = vi.spyOn(current.rollout, "setOnRolloutCommitted");
    expect(() => register(current, operation)).toThrow("already has a live local writer");
    expect(callback).not.toHaveBeenCalled();
    expect(() => current.store.appendItems({ threadId: "thread-retry", items: [] })).not.toThrow();
  });

  test.each(["index", "registry"])("preserves the existing rollout callback after a %s failure", (failure) => {
    const current = fixture();
    const previous = vi.fn();
    current.rollout.setOnRolloutCommitted(previous);
    const callback = vi.spyOn(current.rollout, "setOnRolloutCommitted");
    const fault = failure === "index"
      ? vi.spyOn(StateThreadRepository.prototype, "getBackfillFile")
        .mockImplementationOnce(() => { throw new Error("initial index failed"); })
      : failRegistryRead(current).read;
    expect(() => register(current, operation))
      .toThrow(failure === "index" ? "initial index failed" : "registry read failed");
    expect(callback).not.toHaveBeenCalled();
    expect(() => current.store.appendItems({ threadId: "thread-retry", items: [] }))
      .toThrow(ThreadNotFoundError);
    fault.mockRestore();
    current.rollout.appendRollout({
      type: "response_item", payload: { role: "user", content: "prior callback evidence", id: "prior" },
    });
    current.rollout.flushDurable();
    expect(previous).toHaveBeenCalledWith(current.rollout.rolloutPath);
    expect(() => register(current, operation)).not.toThrow();
  });
});

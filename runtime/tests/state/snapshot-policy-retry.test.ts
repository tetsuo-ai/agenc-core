import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgenCSessionSnapshotPolicy, type SnapshotPolicyOptions } from "../../src/state/snapshot-policy.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { replayAtomicSessionSnapshotWrites, writeSessionSnapshotAtomically } from "../../src/state/atomic-snapshot-writes.js";
import { pruneSessionSnapshotsForSession } from "../../src/state/pruning.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

vi.mock("../../src/state/atomic-snapshot-writes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/atomic-snapshot-writes.js")>();
  return { ...actual, writeSessionSnapshotAtomically: vi.fn(actual.writeSessionSnapshotAtomically) };
});

vi.mock("../../src/state/pruning.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/pruning.js")>();
  return { ...actual, pruneSessionSnapshotsForSession: vi.fn(actual.pruneSessionSnapshotsForSession) };
});

interface Fixture {
  readonly directory: string;
  readonly pending: string;
  readonly driver: StateSqliteDriver;
  readonly policy: AgenCSessionSnapshotPolicy;
  readonly errors: unknown[];
}

const fixtures: Fixture[] = [];

function fixture(options: SnapshotPolicyOptions = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "agenc-snapshot-retry-"));
  const cwd = join(directory, "project");
  const home = join(directory, "home");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const driver = openStateDatabases({ cwd, agencHome: home });
  const errors: unknown[] = [];
  const policy = new AgenCSessionSnapshotPolicy(driver, {
    agencHome: home, coalesceIntervalMs: 0, onError: (error) => errors.push(error), ...options,
  });
  const result = { directory, pending: join(driver.projectDir, "session_state_snapshots.pending"), driver, policy, errors };
  fixtures.push(result);
  return result;
}

function message(policy: AgenCSessionSnapshotPolicy, content = "retained conversation"): void {
  policy.recordMessageExchange({
    sessionId: "session-1", agentId: "agent-1", content, messageId: content,
    streamId: "stream-1", acceptedAt: "2026-05-01T00:00:00.000Z",
  });
}

function stored(driver: StateSqliteDriver): readonly { conversation_json: string; snapshot_at: string }[] {
  return driver.prepareState<[], { conversation_json: string; snapshot_at: string }>(
    "SELECT conversation_json, snapshot_at FROM session_state_snapshots ORDER BY snapshot_at",
  ).all();
}

afterEach(() => {
  for (const current of fixtures.splice(0)) {
    try { current.policy.close(); } catch {}
    current.driver.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
  vi.mocked(unlinkSync).mockReset();
  vi.mocked(writeSessionSnapshotAtomically).mockReset();
  vi.mocked(pruneSessionSnapshotsForSession).mockReset();
});

describe("session snapshot persistence retry", () => {
  test.each(["explicit", "periodic"])("retries a staging failure through %s flush", (kind) => {
    const { pending, driver, policy } = fixture();
    writeFileSync(pending, "staging obstruction");
    expect(() => message(policy)).toThrow(/EEXIST|ENOTDIR/u);
    expect(stored(driver)).toEqual([]);
    rmSync(pending);
    const result = kind === "explicit" ? policy.flushSession("session-1") : policy.flushPeriodic()[0];
    expect(result).toBeDefined();
    expect(stored(driver)).toHaveLength(1);
    expect(stored(driver)[0]!.conversation_json).toContain("retained conversation");
    expect(policy.flushSession("session-1")).toBeUndefined();
    expect(policy.flushPeriodic()).toEqual([]);
  });

  test("retains dirty state after close fails", () => {
    const { pending, policy } = fixture();
    policy.hydrateSession({ sessionId: "session-1", conversation: [{ content: "close evidence" }] });
    writeFileSync(pending, "staging obstruction");
    try { policy.close(); } catch {}
    expect(policy.trackedSessionIds()).toContain("session-1");
    rmSync(pending);
    expect(policy.flushSession("session-1")).toBeDefined();
    policy.close();
    expect(policy.trackedSessionIds()).toEqual([]);
  });

  test("keeps failed dirty state without admitting unbounded new sessions", () => {
    const { pending, policy } = fixture({ maxTrackedSessions: 1 });
    policy.hydrateSession({ sessionId: "session-1", conversation: [{ content: "eviction evidence" }] });
    writeFileSync(pending, "staging obstruction");
    try { policy.trackSession("session-2"); } catch {}
    expect(policy.trackedSessionIds()).toEqual(["session-1"]);
    rmSync(pending);
    expect(policy.flushSession("session-1")).toBeDefined();
  });

  test("does not duplicate a successfully persisted snapshot", () => {
    const { driver, policy } = fixture();
    message(policy);
    expect(policy.flushSession("session-1")).toBeUndefined();
    expect(stored(driver)).toHaveLength(1);
  });

  test("retries the same staged bytes after a database failure and preserves newer events", () => {
    const { pending, driver, policy } = fixture();
    driver.state.exec(`CREATE TRIGGER reject_snapshot BEFORE INSERT ON session_state_snapshots
      BEGIN SELECT RAISE(ABORT, 'snapshot commit rejected'); END`);
    expect(() => message(policy)).toThrow("snapshot commit rejected");
    const stagedPath = join(pending, readdirSync(pending)[0]!);
    const staged = readFileSync(stagedPath, "utf8");
    expect(() => message(policy, "newer conversation")).toThrow("snapshot commit rejected");
    expect(readFileSync(stagedPath, "utf8")).toBe(staged);
    expect(readdirSync(pending)).toHaveLength(1);
    driver.state.exec("DROP TRIGGER reject_snapshot");
    expect(policy.flushSession("session-1")).toBeDefined();
    expect(stored(driver)).toHaveLength(2);
    expect(stored(driver)[0]!.snapshot_at).toBe(JSON.parse(staged).record.snapshotAt);
    expect(stored(driver)[0]!.conversation_json).not.toContain("newer conversation");
    expect(stored(driver)[1]!.conversation_json).toContain("newer conversation");
    expect(readdirSync(pending)).toEqual([]);
    replayAtomicSessionSnapshotWrites(driver.state, driver.projectDir);
    expect(stored(driver)).toHaveLength(2);
    expect(policy.flushSession("session-1")).toBeUndefined();
  });

  test.each(["before", "after"])("retains an event delivered %s persistence during retry", (phase) => {
    const { pending, driver, policy } = fixture();
    writeFileSync(pending, "staging obstruction");
    expect(() => message(policy)).toThrow();
    rmSync(pending);
    const persist = vi.mocked(writeSessionSnapshotAtomically).getMockImplementation()!;
    vi.mocked(writeSessionSnapshotAtomically).mockImplementationOnce((...args) => {
      if (phase === "before") message(policy, "reentrant conversation");
      persist(...args);
      if (phase === "after") message(policy, "reentrant conversation");
    });
    expect(policy.flushSession("session-1")!.conversation).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "reentrant conversation" }),
    ]));
    expect(stored(driver)).toHaveLength(2);
    expect(stored(driver)[0]!.conversation_json).not.toContain("reentrant conversation");
    expect(stored(driver)[1]!.conversation_json).toContain("reentrant conversation");
    expect(policy.flushSession("session-1")).toBeUndefined();
  });

  test("retains a newer event when the retry itself fails", () => {
    const { pending, driver, policy } = fixture();
    writeFileSync(pending, "staging obstruction");
    expect(() => message(policy)).toThrow();
    vi.mocked(writeSessionSnapshotAtomically).mockImplementationOnce(() => {
      message(policy, "event during failed retry");
      throw new Error("retry failed");
    });
    expect(() => policy.flushSession("session-1")).toThrow("retry failed");
    rmSync(pending);
    policy.flushSession("session-1");
    expect(stored(driver)).toHaveLength(2);
    expect(stored(driver)[1]!.conversation_json).toContain("event during failed retry");
    expect(policy.flushSession("session-1")).toBeUndefined();
  });

  test("retries post-commit cleanup without duplicating the database row", () => {
    const { pending, driver, policy } = fixture();
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error("cleanup failed"); });
    expect(() => message(policy)).toThrow("cleanup failed");
    const first = stored(driver);
    expect(first).toHaveLength(1);
    expect(readdirSync(pending)).toHaveLength(1);
    policy.flushSession("session-1");
    expect(stored(driver)).toEqual(first);
    expect(readdirSync(pending)).toEqual([]);
    expect(policy.flushSession("session-1")).toBeUndefined();
  });

  test("rejects a conflicting existing row without acknowledging or overwriting it", () => {
    const { pending, driver, policy } = fixture();
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error("cleanup failed"); });
    expect(() => message(policy)).toThrow("cleanup failed");
    const original = stored(driver)[0]!;
    driver.state.exec("UPDATE session_state_snapshots SET conversation_json = '[]'");
    expect(() => policy.flushSession("session-1")).toThrow("conflicts");
    expect(stored(driver)[0]!.conversation_json).toBe("[]");
    expect(readdirSync(pending)).toHaveLength(1);
    driver.prepareState<[string]>("UPDATE session_state_snapshots SET conversation_json = ?")
      .run(original.conversation_json);
    policy.flushSession("session-1");
    expect(stored(driver)).toEqual([original]);
  });

  test.each([false, true])("startup replay verifies an existing row, conflicting=%s", (conflicting) => {
    const { pending, driver, policy } = fixture();
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error("cleanup failed"); });
    expect(() => message(policy)).toThrow("cleanup failed");
    const original = stored(driver)[0]!;
    if (conflicting) driver.state.exec("UPDATE session_state_snapshots SET conversation_json = '[]'");
    const beforeReplay = stored(driver);
    replayAtomicSessionSnapshotWrites(driver.state, driver.projectDir);
    expect(stored(driver)).toEqual(beforeReplay);
    if (conflicting) {
      expect(readdirSync(pending)).toEqual([expect.stringMatching(/\.json\.corrupt$/u)]);
      driver.prepareState<[string]>("UPDATE session_state_snapshots SET conversation_json = ?")
        .run(original.conversation_json);
    } else {
      expect(readdirSync(pending)).toEqual([]);
    }
    policy.flushSession("session-1");
    expect(stored(driver)).toEqual([original]);
    expect(policy.flushSession("session-1")).toBeUndefined();
  });

  test("bounds synchronous draining when every attempt receives a newer event", () => {
    const { driver, policy } = fixture();
    const persist = vi.mocked(writeSessionSnapshotAtomically).getMockImplementation()!;
    let attempts = 0;
    vi.mocked(writeSessionSnapshotAtomically).mockImplementation((...args) => {
      persist(...args);
      attempts += 1;
      message(policy, `new event ${attempts}`);
    });
    expect(() => message(policy)).toThrow("changed repeatedly");
    expect(attempts).toBe(2);
    expect(stored(driver)).toHaveLength(2);
    vi.mocked(writeSessionSnapshotAtomically).mockReset();
    policy.flushSession("session-1");
    expect(stored(driver)).toHaveLength(3);
    expect(stored(driver)[2]!.conversation_json).toContain("new event 2");
    expect(policy.flushSession("session-1")).toBeUndefined();
  });

  test("does not acknowledge a snapshot inside a caller's uncommitted transaction", () => {
    const { driver, policy } = fixture();
    policy.hydrateSession({ sessionId: "session-1", conversation: [{ content: "transaction evidence" }] });
    expect(() => driver.transaction(() => policy.flushSession("session-1")))
      .toThrow("require their own transaction");
    expect(stored(driver)).toEqual([]);
    expect(policy.flushSession("session-1")).toBeDefined();
    expect(stored(driver)).toHaveLength(1);
  });

  test("does not retry an already committed snapshot when retention fails", () => {
    const { driver, policy, errors } = fixture();
    vi.mocked(pruneSessionSnapshotsForSession).mockImplementationOnce(() => {
      throw new Error("retention failed");
    });
    message(policy);
    expect(errors).toEqual([expect.objectContaining({ message: "retention failed" })]);
    expect(policy.flushSession("session-1")).toBeUndefined();
    expect(stored(driver)).toHaveLength(1);
  });

  test("bounds retry timers and stops them on failed close", () => {
    const timers = new Map<object, { callback: () => void; delayMs: number }>();
    const { pending, policy, errors } = fixture({
      setTimeout: (callback, delayMs) => {
        const timer = {};
        timers.set(timer, { callback, delayMs });
        return timer;
      },
      clearTimeout: (timer) => { timers.delete(timer); },
    });
    writeFileSync(pending, "staging obstruction");
    expect(() => message(policy)).toThrow();
    let lastDelay = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(timers.size).toBe(1);
      const [timer, scheduled] = [...timers][0]!;
      expect(scheduled.delayMs).toBeGreaterThanOrEqual(Math.max(250, lastDelay));
      expect(scheduled.delayMs).toBeLessThanOrEqual(30_000);
      lastDelay = scheduled.delayMs;
      timers.delete(timer);
      scheduled.callback();
    }
    expect(errors).toHaveLength(12);
    expect(() => policy.close()).toThrow("retained unpersisted sessions");
    expect(timers.size).toBe(0);
    rmSync(pending);
    expect(policy.flushSession("session-1")).toBeDefined();
    expect(timers.size).toBe(0);
  });

  test("refuses repeated admissions while a dirty eviction cannot persist", () => {
    const { pending, policy } = fixture({ maxTrackedSessions: 1 });
    policy.hydrateSession({ sessionId: "session-1", conversation: [{ content: "bounded evidence" }] });
    writeFileSync(pending, "staging obstruction");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(() => policy.trackSession(`new-${attempt}`)).toThrow();
      expect(policy.trackedSessionIds()).toEqual(["session-1"]);
    }
    rmSync(pending);
    policy.trackSession("new-success");
    expect(policy.trackedSessionIds()).toEqual(["new-success"]);
    expect(policy.loadLatest("session-1")!.conversation).toEqual([{ content: "bounded evidence" }]);
  });

  test("periodic failure does not starve later dirty sessions without retry timers", () => {
    const { driver, policy } = fixture();
    driver.state.exec(`CREATE TRIGGER reject_one_snapshot BEFORE INSERT ON session_state_snapshots
      WHEN NEW.session_id = 'bad-session'
      BEGIN SELECT RAISE(ABORT, 'one session failed'); END`);
    policy.hydrateSession({ sessionId: "bad-session", conversation: [{ content: "retry later" }] });
    policy.hydrateSession({ sessionId: "good-session", conversation: [{ content: "persist now" }] });
    expect(() => policy.flushPeriodic()).toThrow();
    expect(policy.loadLatest("good-session")?.conversation).toEqual([{ content: "persist now" }]);
    expect(policy.loadLatest("bad-session")).toBeUndefined();
    policy.recordSessionEvent("good-session", {
      method: "event.message_chunk", params: { delta: "next tick", eventId: "chunk-next" },
    });
    expect(() => policy.flushPeriodic()).toThrow();
    expect(policy.loadLatest("good-session")?.conversation).toEqual(expect.arrayContaining([
      expect.objectContaining({ delta: "next tick" }),
    ]));
    driver.state.exec("DROP TRIGGER reject_one_snapshot");
    expect(policy.flushPeriodic()).toHaveLength(1);
    expect(policy.flushPeriodic()).toEqual([]);
  });
});

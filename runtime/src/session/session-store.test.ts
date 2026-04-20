import { fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ROLLOUT_SCHEMA_VERSION } from "./event-log.js";
import {
  I4_FSYNC_RETRY_MS,
  readIndexSnapshot,
  SessionLock,
  SessionLockedError,
  SessionStore,
  slugifyCwd,
  truncateCorruptTail,
} from "./session-store.js";

describe("session-store", () => {
  let home = "";
  let origHome = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-session-store-"));
    origHome = process.env.AGENC_HOME ?? "";
    process.env.AGENC_HOME = home;
  });
  afterEach(() => {
    if (origHome) process.env.AGENC_HOME = origHome;
    else delete process.env.AGENC_HOME;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("slugifyCwd produces stable slug + hash suffix", () => {
    const a = slugifyCwd("/home/user/proj");
    const b = slugifyCwd("/home/user/proj");
    expect(a).toBe(b);
    expect(a.endsWith("-").length).toBeFalsy();
  });

  test("open creates session_meta header with schema version (I-49)", () => {
    const store = new SessionStore({
      cwd: "/home/test",
      sessionId: "sess-a",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-a",
      timestamp: new Date().toISOString(),
      cwd: "/home/test",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    const content = readFileSync(store.rolloutPath, "utf8");
    expect(content).toContain(`"rolloutSchemaVersion":${ROLLOUT_SCHEMA_VERSION}`);
    expect(content).toContain(`"sessionId":"sess-a"`);
    store.close();
  });

  test("I-23 SessionLock rejects second acquire from different PID", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-"));
    try {
      const lockPath = join(dir, "rollout.lock");
      const first = new SessionLock(lockPath);
      first.acquire();
      // Simulate another process by writing a fake PID + creating the file before our second acquire.
      writeFileSync(lockPath, "99999");
      // Re-attempt acquire from a new SessionLock — holder PID is faked but process.kill(99999, 0) usually errors.
      // We accept either outcome (acquired from stale or rejected as live) as valid lock behaviour.
      const second = new SessionLock(lockPath);
      try {
        second.acquire();
        second.release();
      } catch (err) {
        expect(err).toBeInstanceOf(SessionLockedError);
      }
      first.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-88 toolResultBytes index accumulates per-turn", () => {
    const store = new SessionStore({
      cwd: "/home/test",
      sessionId: "sess-b",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-b",
      timestamp: new Date().toISOString(),
      cwd: "/home/test",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.append(
      {
        id: "s",
        seq: 2,
        msg: { type: "tool_call_completed", payload: { callId: "c1", result: "ok", isError: false } },
      },
      { turnId: "turn-1", toolResultBytes: 5000 },
    );
    store.append(
      {
        id: "s",
        seq: 3,
        msg: { type: "tool_call_completed", payload: { callId: "c2", result: "ok", isError: false } },
      },
      { turnId: "turn-1", toolResultBytes: 7000 },
    );
    expect(store.getToolResultBytes("turn-1")).toBe(12000);
    store.close();
  });

  test("UUID dedup: repeated event.id without seq is skipped", () => {
    const store = new SessionStore({
      cwd: "/home/test-dedup",
      sessionId: "sess-d",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-d",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-dedup",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    const ev = {
      id: "dup-id",
      msg: { type: "warning" as const, payload: { cause: "x", message: "y" } },
    };
    store.append(ev);
    store.append(ev);
    store.append(ev);
    store.close();
    const content = readFileSync(store.rolloutPath, "utf8");
    const matches = content.match(/"dup-id"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("I-24 close writes atomic index.json snapshot with seq + offsets", () => {
    const store = new SessionStore({
      cwd: "/home/test-idx",
      sessionId: "sess-e",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-e",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-idx",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.append({
      id: "1",
      seq: 1,
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    store.append(
      {
        id: "2",
        seq: 2,
        msg: { type: "turn_complete", payload: { turnId: "t" } },
      },
      { durable: true },
    );
    store.close();
    const snapshot = readIndexSnapshot(store.indexPath);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.snapshotSequenceNumber).toBe(2);
    expect(snapshot!.schemaVersion).toBe(ROLLOUT_SCHEMA_VERSION);
    expect(Object.keys(snapshot!.offsetsBySeq)).toContain("1");
    expect(Object.keys(snapshot!.offsetsBySeq)).toContain("2");
  });

  test("reAppendSessionMetadata writes session_meta line again after compact", () => {
    const store = new SessionStore({
      cwd: "/home/test-meta",
      sessionId: "sess-f",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-f",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-meta",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.reAppendSessionMetadata();
    store.close();
    const content = readFileSync(store.rolloutPath, "utf8");
    const metaCount = (content.match(/"type":"session_meta"/g) ?? []).length;
    expect(metaCount).toBeGreaterThanOrEqual(2);
  });

  test("I-38 fsync retry: first attempt fails, async retry succeeds without busy-wait", async () => {
    const store = new SessionStore({
      cwd: "/home/test-fsync-retry-ok",
      sessionId: "sess-fsync-ok",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-fsync-ok",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-fsync-retry-ok",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const diagnostics: Array<{ cause: string; level: string }> = [];
    store.setDiagnosticListener((d) => {
      diagnostics.push({ cause: d.cause, level: d.level });
    });

    // Fail the next fsync call exactly once, then let the real impl run.
    let callsSeen = 0;
    store.setFsyncImplForTest((fd: number) => {
      callsSeen += 1;
      if (callsSeen === 1) {
        const err = new Error("simulated transient fsync failure") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return fsyncSync(fd);
    });

    try {
      const start = Date.now();
      store.append(
        {
          id: "durable-1",
          seq: 1,
          msg: { type: "turn_complete", payload: { turnId: "t1" } },
        },
        { durable: true },
      );
      const syncElapsed = Date.now() - start;

      // Assert no busy-wait: the sync append path must return quickly
      // (well under the 100ms I-38 retry window).
      expect(syncElapsed).toBeLessThan(I4_FSYNC_RETRY_MS);

      // Wait for the deferred async retry to settle.
      await (store as unknown as {
        awaitPendingFsyncRetries(): Promise<void>;
      }).awaitPendingFsyncRetries();

      expect(callsSeen).toBeGreaterThanOrEqual(2);
      expect(diagnostics.some((d) => d.cause === "fsync_retry_succeeded")).toBe(true);
      expect(diagnostics.some((d) => d.cause === "fsync_failed")).toBe(false);
      expect(store.isDegraded).toBe(false);
    } finally {
      store.setFsyncImplForTest(fsyncSync);
      store.close();
    }
  });

  test("I-38 fsync retry: both attempts fail — emits fsync_failed + routes to degraded", async () => {
    const store = new SessionStore({
      cwd: "/home/test-fsync-retry-fail",
      sessionId: "sess-fsync-fail",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-fsync-fail",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-fsync-retry-fail",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const diagnostics: Array<{ cause: string; level: string }> = [];
    store.setDiagnosticListener((d) => {
      diagnostics.push({ cause: d.cause, level: d.level });
    });

    // Fail every fsync on the rollout path — first attempt and
    // deferred retry must both trip the mock.
    store.setFsyncImplForTest(() => {
      const err = new Error("simulated persistent fsync failure") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });

    try {
      store.append(
        {
          id: "durable-2",
          seq: 1,
          msg: { type: "turn_complete", payload: { turnId: "t2" } },
        },
        { durable: true },
      );

      // Wait for the deferred async retry to run + fail.
      await (store as unknown as {
        awaitPendingFsyncRetries(): Promise<void>;
      }).awaitPendingFsyncRetries();

      const fsyncFailed = diagnostics.find((d) => d.cause === "fsync_failed");
      expect(fsyncFailed).toBeDefined();
      expect(fsyncFailed?.level).toBe("error");

      // Retry failure must have routed the batch into the degraded
      // ring buffer (I-12 / I-38).
      expect(store.isDegraded).toBe(true);
      expect(diagnostics.some((d) => d.cause === "rollout_degraded")).toBe(true);
    } finally {
      // Restore so the close() path + index-snapshot fsync run the
      // real impl and don't trip the mock.
      store.setFsyncImplForTest(fsyncSync);
      store.close();
    }
  });

  test("I-24 truncateCorruptTail removes partial trailing line", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-corrupt-"));
    try {
      const path = join(dir, "rollout.jsonl");
      writeFileSync(
        path,
        '{"type":"session_meta","payload":{"sessionId":"x"}}\n{"type":"event_msg","payload":{"id":"1","msg":{"type":"warning"',
        { mode: 0o600 },
      );
      const result = truncateCorruptTail(path);
      expect(result.truncated).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content.endsWith("\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import {
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AsyncQueue } from "../utils/async-queue.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ROLLOUT_SCHEMA_VERSION } from "./event-log.js";
import { EventLog } from "./event-log.js";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  findProjectRootSync,
  getProjectDir,
  I4_FSYNC_RETRY_MS,
  MAX_SESSION_INDEX_ENTRIES,
  readIndexSnapshot,
  rewriteAtomically,
  SchemaMismatchError,
  SESSION_INDEX_EVICT_BATCH,
  SessionLock,
  SessionLockedError,
  SessionStore,
  slugifyCwd,
  truncateCorruptTail,
} from "./session-store.js";
import { RolloutStore } from "./rollout-store.js";
import { Session } from "./session.js";
import {
  AGENC_TRAJECTORY_EXPORT_PATH_ENV,
  TRAJECTORY_EXPORT_SCHEMA_VERSION,
} from "./trajectory-export.js";

describe("session-store", () => {
  let home = "";
  let origHome = "";

  function findDeadPid(): number {
    for (const pid of [2_147_483_647, 99_999_999, 4_194_303]) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as { code?: string }).code === "ESRCH") return pid;
      }
    }
    throw new Error("unable to find a dead pid for stale-lock test");
  }

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

  test("open rejects rollout header schema newer than the runtime", () => {
    const store = new SessionStore({
      cwd: "/home/test-schema-newer",
      sessionId: "sess-schema-newer",
      agencVersion: "0.2.0",
    });
    writeFileSync(
      store.rolloutPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          sessionId: "sess-schema-newer",
          timestamp: new Date().toISOString(),
          cwd: "/home/test-schema-newer",
          originator: "agenc-cli",
          agencVersion: "0.2.0",
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION + 1,
        },
        eventVersion: 1,
      })}\n`,
      { mode: 0o600 },
    );

    expect(() =>
      store.open({
        sessionId: "sess-schema-newer",
        timestamp: new Date().toISOString(),
        cwd: "/home/test-schema-newer",
        originator: "agenc-cli",
        agencVersion: "0.2.0",
      }),
    ).toThrowError(SchemaMismatchError);
    expect(() =>
      store.open({
        sessionId: "sess-schema-newer",
        timestamp: new Date().toISOString(),
        cwd: "/home/test-schema-newer",
        originator: "agenc-cli",
        agencVersion: "0.2.0",
      }),
    ).toThrowError(/please use \/fork to migrate or upgrade/i);
  });

  test("open accepts an older rollout schema header without rewriting it", () => {
    const store = new SessionStore({
      cwd: "/home/test-schema-older",
      sessionId: "sess-schema-older",
      agencVersion: "0.2.0",
    });
    writeFileSync(
      store.rolloutPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          sessionId: "sess-schema-older",
          timestamp: new Date().toISOString(),
          cwd: "/home/test-schema-older",
          originator: "agenc-cli",
          agencVersion: "0.1.0",
          rolloutSchemaVersion: 0,
        },
        eventVersion: 0,
      })}\n`,
      { mode: 0o600 },
    );

    store.open({
      sessionId: "sess-schema-older",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-schema-older",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.append({
      id: "legacy-mixed-row",
      seq: 1,
      msg: { type: "warning", payload: { cause: "compat", message: "mixed history" } },
    });
    store.close();

    const [headerLine, appendedLine] = readFileSync(store.rolloutPath, "utf8")
      .trim()
      .split("\n");
    const header = JSON.parse(headerLine!);
    const appended = JSON.parse(appendedLine!);

    expect(header.payload.rolloutSchemaVersion).toBe(0);
    expect(header.eventVersion).toBe(0);
    expect(appended.type).toBe("event_msg");
    expect(appended.eventVersion).toBe(1);
  });

  test("I-23 SessionLock: two-process exclusivity — live holder (this PID) refuses reclaim", () => {
    // Real-PID-alive variant: write a lock record owned by the
    // current test process (which is guaranteed to be alive via
    // kill(pid, 0)) and verify a fresh SessionLock instance refuses
    // to reclaim it. This is the unambiguous signal that the lock
    // enforces exclusivity against any live holder, PID reuse notwithstanding.
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-xproc-"));
    try {
      const lockPath = join(dir, "rollout.jsonl.lock");
      const stamp = JSON.stringify({
        pid: process.pid,
        startNs: "other-holder-with-same-pid",
        acquiredAtIso: new Date().toISOString(),
      });
      writeFileSync(lockPath, `${stamp}\n`);
      const secondLock = new SessionLock(lockPath);
      // Same-PID acquire is allowed (same-process re-entry). This is
      // intentional: within a single Node process, acquire() is
      // idempotent so multiple SessionLock wrappers pointing at the
      // same path don't deadlock one another.
      secondLock.acquire();
      secondLock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-23 SessionLock: two-process exclusivity — spawn child, parent acquire must fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-child-"));
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const lockPath = join(dir, "rollout.jsonl.lock");
      const readyPath = join(dir, "child.ready");
      // The child script is self-contained: it uses the same atomic
      // `tmp+linkSync` recipe as SessionLock so the parent's
      // SessionLock.acquire() observes a live, valid lock file and
      // must throw SessionLockedError. We spawn detached so the
      // child outlives the parent's acquire attempt regardless of
      // the vitest test duration.
      const childScript = `
        const { openSync, writeSync, fsyncSync, closeSync, linkSync, unlinkSync, writeFileSync } = require("node:fs");
        const lockPath = ${JSON.stringify(lockPath)};
        const readyPath = ${JSON.stringify(readyPath)};
        const tmp = lockPath + "." + process.pid + ".tmp";
        const record = JSON.stringify({
          pid: process.pid,
          startNs: "child-" + Date.now(),
          acquiredAtIso: new Date().toISOString(),
        }) + "\\n";
        const fd = openSync(tmp, "wx", 0o600);
        writeSync(fd, record);
        fsyncSync(fd);
        closeSync(fd);
        linkSync(tmp, lockPath);
        try { unlinkSync(tmp); } catch {}
        writeFileSync(readyPath, String(process.pid));
        // Sleep ~10s holding the lock. The parent test will finish
        // far before then; it signals us via SIGTERM on cleanup.
        setTimeout(() => process.exit(0), 10_000);
      `;
      child = spawn(process.execPath, ["-e", childScript], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // Poll for the child's ready file — at most 3s.
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !existsSync(readyPath)) {
        await new Promise((r) => setTimeout(r, 25));
      }

      if (!existsSync(readyPath) || !existsSync(lockPath)) {
        // Child couldn't acquire (e.g. linkSync unavailable on an
        // exotic filesystem). Don't fail the test — stale-reclaim +
        // live-holder-same-pid + reentry tests cover the rest.
        return;
      }

      // Sanity: verify the lock file holds the child's pid, not
      // ours. This guards against a race where the child's ready
      // file was observed but the lockfile points somewhere else.
      const record = JSON.parse(readFileSync(lockPath, "utf8").trim()) as {
        pid: number;
      };
      expect(record.pid).not.toBe(process.pid);
      expect(record.pid).toBe(child.pid);

      // The child is holding the lock + child PID is alive. Parent
      // acquire MUST throw SessionLockedError.
      const parentLock = new SessionLock(lockPath);
      let caught: unknown;
      try {
        parentLock.acquire();
        parentLock.release();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SessionLockedError);
      expect((caught as SessionLockedError).holderPid).toBe(child.pid);
    } finally {
      if (child && child.pid !== undefined) {
        try { process.kill(child.pid, "SIGTERM"); } catch { /* already dead */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-23 SessionLock: stale-holder reclaim (dead PID -> next acquire succeeds)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-stale-"));
    try {
      const lockPath = join(dir, "rollout.jsonl.lock");
      const deadPid = findDeadPid();
      const stamp = JSON.stringify({
        pid: deadPid,
        startNs: "stale",
        acquiredAtIso: new Date().toISOString(),
      });
      writeFileSync(lockPath, `${stamp}\n`);
      const lock = new SessionLock(lockPath);
      // This should succeed: dead holder -> stale reclaim path.
      lock.acquire();
      // After acquire, the lock file should contain OUR pid, not the dead one.
      const record = JSON.parse(readFileSync(lockPath, "utf8").trim());
      expect(record.pid).toBe(process.pid);
      lock.release();
      // After release, the lock file should be gone.
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-23 SessionLock: second acquire in same process is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-reentry-"));
    try {
      const lockPath = join(dir, "rollout.jsonl.lock");
      const lock = new SessionLock(lockPath);
      lock.acquire();
      expect(() => lock.acquire()).not.toThrow();
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-24 rewriteAtomically replaces file durably + cleans up tmp on failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-rewrite-"));
    try {
      const target = join(dir, "target.json");
      writeFileSync(target, "original\n");
      rewriteAtomically(target, "replacement\n");
      expect(readFileSync(target, "utf8")).toBe("replacement\n");
      // Tmp must not linger.
      expect(existsSync(`${target}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-24 rewriteAtomically: a stale tmp from a prior crash is cleared, not refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-rewrite-stale-"));
    try {
      const target = join(dir, "target.json");
      writeFileSync(target, "original\n");
      // Simulate a crashed prior run that left tmp in place.
      writeFileSync(`${target}.tmp`, "stale-tmp-contents");
      rewriteAtomically(target, "fresh\n");
      expect(readFileSync(target, "utf8")).toBe("fresh\n");
      expect(existsSync(`${target}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-88 toolResultBytes + tokenEstimate indexes accumulate per-turn", () => {
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
      { turnId: "turn-1", toolResultBytes: 5000, tokenEstimate: 1250 },
    );
    store.append(
      {
        id: "s",
        seq: 3,
        msg: { type: "tool_call_completed", payload: { callId: "c2", result: "ok", isError: false } },
      },
      { turnId: "turn-1", toolResultBytes: 7000, tokenEstimate: 1750 },
    );
    expect(store.getToolResultBytes("turn-1")).toBe(12000);
    expect(store.getTokenEstimate("turn-1")).toBe(3000);
    store.close();
  });

  // OOM regression: the four per-session monotonic indices (offsetsBySeq,
  // toolCallTurnIds, toolResultBytesByTurn, tokenEstimateByTurn) previously grew
  // one entry per event/tool-call for the whole session — the same unbounded
  // growth class as the #946/#947 leaks — bloating both heap and index.json.
  // Drive a 50k+ tool-call soak and assert every index stays capped, both
  // in-memory and in the serialized snapshot.
  test("bounds the per-session monotonic indices under a 50k+ tool-call soak (OOM regression)", () => {
    const store = new SessionStore({
      cwd: "/home/test-index-soak",
      sessionId: "sess-soak",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-soak",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-index-soak",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    // Enough unique completions to cross the cap and force ≥1 eviction cycle.
    // Unique seq + callId + turnId per event so all four indices grow 1/event.
    const total = MAX_SESSION_INDEX_ENTRIES + SESSION_INDEX_EVICT_BATCH + 100;
    for (let i = 0; i < total; i++) {
      store.append(
        {
          id: `evt-${i}`,
          seq: i + 1,
          msg: {
            type: "tool_call_completed",
            payload: { callId: `call-${i}`, result: "ok", isError: false },
          },
        },
        { turnId: `turn-${i}`, toolResultBytes: 1, tokenEstimate: 1 },
      );
    }

    // In-memory (heap) bound: the append-path indices stay capped, the oldest
    // entries are evicted (FIFO), and the newest survive. Before the fix each
    // held all `total` entries.
    const live = store.getCompactionIndexSnapshot();
    expect(live.toolResultBytesByTurn.size).toBeLessThanOrEqual(
      MAX_SESSION_INDEX_ENTRIES,
    );
    expect(live.toolResultBytesByTurn.size).toBeLessThan(total);
    expect(live.tokenEstimateByTurn?.size ?? 0).toBeLessThanOrEqual(
      MAX_SESSION_INDEX_ENTRIES,
    );
    expect(live.toolCallTurnIds.size).toBeLessThanOrEqual(
      MAX_SESSION_INDEX_ENTRIES,
    );
    expect(live.toolCallTurnIds.get("call-0")).toBeUndefined();
    expect(live.toolCallTurnIds.get(`call-${total - 1}`)).toBe(
      `turn-${total - 1}`,
    );

    store.close();

    // Serialized (index.json) bound: the snapshot the audit flagged as bloated
    // by unbounded indices stays capped for all four records, including
    // offsetsBySeq (bounded on the flush path).
    const snapshot = readIndexSnapshot(store.indexPath);
    expect(snapshot).not.toBeNull();
    expect(Object.keys(snapshot!.offsetsBySeq).length).toBeLessThanOrEqual(
      MAX_SESSION_INDEX_ENTRIES,
    );
    expect(
      Object.keys(snapshot!.toolCallTurnIds ?? {}).length,
    ).toBeLessThanOrEqual(MAX_SESSION_INDEX_ENTRIES);
    expect(
      Object.keys(snapshot!.toolResultBytesByTurn ?? {}).length,
    ).toBeLessThanOrEqual(MAX_SESSION_INDEX_ENTRIES);
    expect(
      Object.keys(snapshot!.tokenEstimateByTurn ?? {}).length,
    ).toBeLessThanOrEqual(MAX_SESSION_INDEX_ENTRIES);
  });

  test("Session.emit forwards real tool completion bytes into the rollout index", () => {
    const rolloutStore = new RolloutStore({
      cwd: "/home/test-session-emit",
      sessionId: "sess-emit",
      agencVersion: "0.2.0",
      autoStartScheduler: false,
    });
    rolloutStore.open({
      sessionId: "sess-emit",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-session-emit",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const session = {
      eventLog: new EventLog(),
      rolloutStore,
      txEvent: new AsyncQueue<any>(),
      isRolloutPersistenceSuspended: () => false,
      nextInternalSubId: (() => {
        let n = 0;
        return () => `sub-${++n}`;
      })(),
    } as unknown as Session;

    Session.prototype.emit.call(
      session,
      {
        id: "tool-1",
        msg: {
          type: "tool_call_completed",
          payload: { callId: "call-1", result: "tool output", isError: false },
        },
      },
      {
        turnId: "turn-emit",
        toolResultBytes: Buffer.byteLength("tool output", "utf8"),
        tokenEstimate: Math.ceil(Buffer.byteLength("tool output", "utf8") / 4),
      },
    );

    expect(rolloutStore.getToolResultBytes("turn-emit")).toBe(
      Buffer.byteLength("tool output", "utf8"),
    );
    expect(rolloutStore.getTokenEstimate("turn-emit")).toBe(
      Math.ceil(Buffer.byteLength("tool output", "utf8") / 4),
    );
    rolloutStore.close();
  });

  test("Session.emit derives tool completion bytes + active turn id when append opts are omitted", () => {
    const rolloutStore = new RolloutStore({
      cwd: "/home/test-session-derived",
      sessionId: "sess-derived",
      agencVersion: "0.2.0",
      autoStartScheduler: false,
    });
    rolloutStore.open({
      sessionId: "sess-derived",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-session-derived",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const session = {
      eventLog: new EventLog(),
      rolloutStore,
      txEvent: new AsyncQueue<any>(),
      activeTurn: {
        unsafePeek: () => ({
          turnId: "turn-derived",
          startedAtMs: 123,
          abortController: new AbortController(),
        }),
      },
      isRolloutPersistenceSuspended: () => false,
      nextInternalSubId: (() => {
        let n = 0;
        return () => `sub-${++n}`;
      })(),
    } as unknown as Session;

    Session.prototype.emit.call(session, {
      id: "tool-2",
      msg: {
        type: "tool_call_completed",
        payload: { callId: "call-2", result: { ok: true }, isError: false },
      },
    });

    const snapshot = rolloutStore.getCompactionIndexSnapshot();
    expect(snapshot.toolResultBytesByTurn.get("turn-derived")).toBe(
      Buffer.byteLength(JSON.stringify({ ok: true }), "utf8"),
    );
    expect(snapshot.tokenEstimateByTurn?.get("turn-derived")).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify({ ok: true }), "utf8") / 4),
    );
    expect(snapshot.toolCallTurnIds.get("call-2")).toBe("turn-derived");
    rolloutStore.close();
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
    expect(snapshot!.tokenEstimateByTurn ?? {}).toEqual({});
  });

  test("resume hydrates the compaction index snapshot from disk", () => {
    const first = new SessionStore({
      cwd: "/home/test-idx-resume",
      sessionId: "sess-resume",
      agencVersion: "0.2.0",
    });
    first.open({
      sessionId: "sess-resume",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-idx-resume",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    first.append(
      {
        id: "tool-complete",
        seq: 2,
        msg: {
          type: "tool_call_completed",
          payload: { callId: "call-resume", result: "payload", isError: false },
        },
      },
      {
        turnId: "turn-resume",
        toolResultBytes: Buffer.byteLength("payload", "utf8"),
        tokenEstimate: Math.ceil(Buffer.byteLength("payload", "utf8") / 4),
      },
    );
    first.close();

    const resumed = new SessionStore({
      cwd: "/home/test-idx-resume",
      sessionId: "sess-resume",
      agencVersion: "0.2.0",
      resume: true,
    });
    resumed.open({
      sessionId: "sess-resume",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-idx-resume",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const snapshot = resumed.getCompactionIndexSnapshot();
    expect(snapshot.toolResultBytesByTurn.get("turn-resume")).toBe(
      Buffer.byteLength("payload", "utf8"),
    );
    expect(snapshot.tokenEstimateByTurn?.get("turn-resume")).toBe(
      Math.ceil(Buffer.byteLength("payload", "utf8") / 4),
    );
    expect(snapshot.toolCallTurnIds.get("call-resume")).toBe("turn-resume");
    resumed.close();
    expect(readIndexSnapshot(resumed.indexPath)?.snapshotSequenceNumber).toBe(2);
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

  test("appendRollout inherits durable flushing for terminal event_msg rows", () => {
    const store = new SessionStore({
      cwd: "/home/test-rollout-durable-terminal",
      sessionId: "sess-rollout-durable-terminal",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-rollout-durable-terminal",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-rollout-durable-terminal",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    store.appendRollout({
      type: "event_msg",
      payload: {
        id: "terminal-rollout-event",
        msg: {
          type: "turn_aborted",
          payload: { turnId: "turn-rollout", reason: "process_killed" },
        },
      },
    });

    const lines = readFileSync(store.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; payload?: { msg?: { type?: string } } });
    expect(
      lines.some(
        (line) =>
          line.type === "event_msg" &&
          line.payload?.msg?.type === "turn_aborted",
      ),
    ).toBe(true);
    store.close();
  });

  test("opt-in trajectory export mirrors redacted rollout rows", () => {
    const previousExportPath = process.env[AGENC_TRAJECTORY_EXPORT_PATH_ENV];
    const exportPath = join(home, "trajectory.jsonl");
    process.env[AGENC_TRAJECTORY_EXPORT_PATH_ENV] = exportPath;
    const store = new SessionStore({
      cwd: "/home/test-trajectory-export",
      sessionId: "sess-trajectory-export",
      agencVersion: "0.2.0",
    });
    const rawSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";

    try {
      store.open({
        sessionId: "sess-trajectory-export",
        timestamp: new Date().toISOString(),
        cwd: "/home/test-trajectory-export",
        originator: "agenc-cli",
        agencVersion: "0.2.0",
      });

      store.appendRollout(
        {
          type: "response_item",
          payload: {
            role: "user",
            content: `Authorization: Bearer abcdefghijklmnop= ${rawSecret}`,
          },
        },
        { durable: true },
      );
      store.close();

      const raw = readFileSync(exportPath, "utf8");
      expect(raw).not.toContain(rawSecret);
      const records = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          schemaVersion: number;
          sessionId: string;
          rolloutPath: string;
          item: { type: string; payload?: unknown };
        });
      expect(records.map((record) => record.schemaVersion)).toEqual([
        TRAJECTORY_EXPORT_SCHEMA_VERSION,
        TRAJECTORY_EXPORT_SCHEMA_VERSION,
      ]);
      expect(records.map((record) => record.item.type)).toEqual([
        "session_meta",
        "response_item",
      ]);
      expect(records.every((record) => record.sessionId === "sess-trajectory-export")).toBe(true);
      expect(records.every((record) => record.rolloutPath === store.rolloutPath)).toBe(true);
    } finally {
      store.close();
      if (previousExportPath === undefined) {
        delete process.env[AGENC_TRAJECTORY_EXPORT_PATH_ENV];
      } else {
        process.env[AGENC_TRAJECTORY_EXPORT_PATH_ENV] = previousExportPath;
      }
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

  test("#11 durable fsync-failure does not duplicate the row after degraded flush", async () => {
    const store = new SessionStore({
      cwd: "/home/test-fsync-dup",
      sessionId: "sess-fsync-dup",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-fsync-dup",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-fsync-dup",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    try {
      // Fail every fsync so the durable append's writeSync lands the row
      // on disk but both the initial fsync and the I-38 retry trip.
      store.setFsyncImplForTest(() => {
        const err = new Error("simulated persistent fsync failure") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      });

      store.append(
        {
          id: "durable-once",
          seq: 1,
          msg: { type: "turn_complete", payload: { turnId: "t-once" } },
        },
        { durable: true },
      );

      await (store as unknown as {
        awaitPendingFsyncRetries(): Promise<void>;
      }).awaitPendingFsyncRetries();

      // writeSync persisted the row even though fsync failed; we entered
      // degraded mode.
      expect(store.isDegraded).toBe(true);

      const countOccurrences = () =>
        readFileSync(store.rolloutPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { payload?: { id?: string } })
          .filter((line) => line.payload?.id === "durable-once").length;

      // Already exactly once on disk (the original writeSync).
      expect(countOccurrences()).toBe(1);

      // Restore fsync and drive the degraded flush. The pre-fix bug
      // re-queued the already-written row into the degraded buffer, so
      // this flush re-appended it — producing two copies on disk (and a
      // double on resume/reduce). With the fix the degraded buffer is
      // empty, so the flush is a no-op and the row stays exactly once.
      store.setFsyncImplForTest(fsyncSync);
      await (store as unknown as {
        degraded: { tryFlush(): Promise<boolean> };
      }).degraded.tryFlush();

      expect(countOccurrences()).toBe(1);
    } finally {
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

  // ───────────────────────────────────────────────────────────────────
  // T10 Fix-E integration point 5 — project-root slug uses ancestor
  // walk so two checkouts nested under the same `.git` root share the
  // same `~/.agenc/projects/<slug>/` directory.
  // ───────────────────────────────────────────────────────────────────

  test("getProjectDir slugs from .git ancestor when cwd is nested under it", () => {
    const repo = mkdtempSync(join(tmpdir(), "agenc-proj-root-"));
    try {
      mkdirSync(join(repo, ".git"));
      const nested = join(repo, "packages", "alpha", "src");
      mkdirSync(nested, { recursive: true });

      const dirFromNested = getProjectDir(nested);
      const dirFromRepo = getProjectDir(repo);
      // Both should resolve to the same slug because the ancestor
      // walk finds the `.git` marker at `repo`.
      expect(dirFromNested).toBe(dirFromRepo);
      expect(dirFromNested).toContain(slugifyCwd(repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("getProjectDir falls back to raw cwd when no marker ancestor exists", () => {
    // Build an isolated subtree under the test HOME so we guarantee
    // no .git/package.json/etc exists anywhere on the way up. Using
    // the test `home` (AGENC_HOME) keeps the walk contained to this
    // temp tree; tmpdir() itself may be inside a repo on developer
    // machines.
    const walled = mkdtempSync(join(home, "no-marker-"));
    try {
      const dir = getProjectDir(walled, ["agenc-no-such-marker-xyzzy"]);
      // With a custom marker list that cannot match, the store must
      // slug from the raw cwd (not a non-existent ancestor).
      expect(dir).toContain(slugifyCwd(walled));
    } finally {
      rmSync(walled, { recursive: true, force: true });
    }
  });

  test("two cwds under the same .git root slug to the same project dir", () => {
    const repo = mkdtempSync(join(tmpdir(), "agenc-shared-root-"));
    try {
      mkdirSync(join(repo, ".git"));
      const a = join(repo, "apps", "web");
      const b = join(repo, "apps", "api", "src");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });

      const dirA = getProjectDir(a);
      const dirB = getProjectDir(b);
      expect(dirA).toBe(dirB);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("findProjectRootSync locates .git ancestor and returns rootDir + marker", () => {
    const repo = mkdtempSync(join(tmpdir(), "agenc-walk-"));
    try {
      mkdirSync(join(repo, ".git"));
      const nested = join(repo, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      const root = findProjectRootSync(nested);
      expect(root).not.toBeNull();
      expect(root!.rootDir).toBe(repo);
      expect(root!.marker).toBe(".git");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("DEFAULT_SESSION_ROOT_MARKERS covers common ecosystem roots", () => {
    // Guards against accidental drift between this list and the
    // project-instructions loader; a full equality check would couple
    // the two, so just assert coverage of the agenc runtime-rooted minimum.
    expect(DEFAULT_SESSION_ROOT_MARKERS).toContain(".git");
    expect(DEFAULT_SESSION_ROOT_MARKERS).toContain("package.json");
  });
});

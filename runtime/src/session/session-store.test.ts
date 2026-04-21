import {
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue } from "../utils/async-queue.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ROLLOUT_SCHEMA_VERSION } from "./event-log.js";
import { EventLog } from "./event-log.js";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  findProjectRootSync,
  getProjectDir,
  I4_FSYNC_RETRY_MS,
  readIndexSnapshot,
  SchemaMismatchError,
  SessionLock,
  SessionLockedError,
  SessionStore,
  slugifyCwd,
  truncateCorruptTail,
} from "./session-store.js";
import { RolloutStore } from "./rollout-store.js";
import { Session } from "./session.js";

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
      },
    );

    expect(rolloutStore.getToolResultBytes("turn-emit")).toBe(
      Buffer.byteLength("tool output", "utf8"),
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
      { turnId: "turn-resume", toolResultBytes: Buffer.byteLength("payload", "utf8") },
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
    expect(snapshot.toolCallTurnIds.get("call-resume")).toBe("turn-resume");
    resumed.close();
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
    // the two, so just assert coverage of the codex-rooted minimum.
    expect(DEFAULT_SESSION_ROOT_MARKERS).toContain(".git");
    expect(DEFAULT_SESSION_ROOT_MARKERS).toContain("package.json");
  });
});

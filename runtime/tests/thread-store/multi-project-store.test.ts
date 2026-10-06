import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MultiProjectFileThreadStore } from "../../src/thread-store/multi-project-store.js";
import { resolveDaemonDefaultCwd } from "../../src/app-server/daemon-workspace.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import * as sqlite from "../../src/state/sqlite-driver.js";
import { StateSchemaMismatchError } from "../../src/state/errors.js";

let agencHome = "";
let originalAgencHome = "";

function openRollout(opts: {
  cwd: string;
  sessionId: string;
}): RolloutStore {
  const store = new RolloutStore({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    agencVersion: "0.6.0",
    sessionTempRoot: tmpdir(),
  });
  store.open({
    sessionId: opts.sessionId,
    timestamp: new Date().toISOString(),
    cwd: opts.cwd,
    originator: "multi-project-test",
    agencVersion: "0.6.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-mp-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
});

afterEach(() => {
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
});

describe("MultiProjectFileThreadStore (DAE-03) — behavioral", () => {
  it("rejects queries after closing a never-materialized primary store", () => {
    const primary = mkdtempSync(join(tmpdir(), "agenc-mp-closed-"));
    const multi = new MultiProjectFileThreadStore({ primaryCwd: primary, agencHome });
    try {
      multi.close();
      expect(() => multi.countThreads({ archived: false })).toThrow("multi-project thread store is closed");
      expect(() => multi.listThreads({ pageSize: 10, archived: false, useStateDbOnly: true }))
        .toThrow("multi-project thread store is closed");
      expect(() => multi.listThreads({ pageSize: 10, archived: false }))
        .toThrow("multi-project thread store is closed");
    } finally { rmSync(primary, { recursive: true, force: true }); }
  });

  it("does not create an unused primary database, but opens it on the first write", () => {
    const primary = mkdtempSync(join(tmpdir(), "agenc-mp-lazy-"));
    const paths = sqlite.resolveStateDatabasePaths({ cwd: primary, agencHome });
    const multi = new MultiProjectFileThreadStore({ primaryCwd: primary, agencHome });
    let rollout: RolloutStore | undefined;
    try {
      expect(multi.listThreads({ pageSize: 10, archived: false }).items).toEqual([]);
      expect(multi.listThreads({ pageSize: 10, archived: false, useStateDbOnly: true }).items).toEqual([]);
      expect(multi.countThreads({ archived: false })).toBe(0);
      expect(existsSync(paths.projectDir)).toBe(false);
      rollout = openRollout({ cwd: primary, sessionId: "lazy-primary" });
      multi.createThread({ threadId: "lazy-primary", rolloutStore: rollout });
      expect(existsSync(paths.stateDbPath)).toBe(true);
      expect(multi.readThread({ threadId: "lazy-primary", includeArchived: false }))
        .toMatchObject({ threadId: "lazy-primary" });
      multi.shutdownThread("lazy-primary");
      multi.close();
      const reopened = new MultiProjectFileThreadStore({ primaryCwd: primary, agencHome });
      try {
        expect(reopened.listThreads({ pageSize: 10, archived: false }).items)
          .toEqual([expect.objectContaining({ threadId: "lazy-primary" })]);
      } finally { reopened.close(); }
    } finally {
      multi.close();
      rollout?.close();
      rmSync(primary, { recursive: true, force: true });
    }
  });

  it("still validates an existing primary database before accepting work", () => {
    const primary = mkdtempSync(join(tmpdir(), "agenc-mp-existing-"));
    const driver = sqlite.openStateDatabases({ cwd: primary, agencHome });
    try {
      driver.state.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(1_000_000, "future");
    } finally { driver.close(); }
    try {
      expect(() => new MultiProjectFileThreadStore({ primaryCwd: primary, agencHome }))
        .toThrow(StateSchemaMismatchError);
    } finally { rmSync(primary, { recursive: true, force: true }); }
  });

  it("reuses an open project before doing another SQLite open or recovery", () => {
    const primary = mkdtempSync(join(tmpdir(), "agenc-mp-reuse-"));
    const first = openRollout({ cwd: primary, sessionId: "reuse-first" });
    const second = openRollout({ cwd: primary, sessionId: "reuse-second" });
    const multi = new MultiProjectFileThreadStore({ primaryCwd: primary, agencHome });
    multi.createThread({ threadId: "reuse-first", cwd: primary, rolloutStore: first });
    const open = vi.spyOn(sqlite, "openStateDatabasePaths");
    const openForCwd = vi.spyOn(sqlite, "openStateDatabases");
    try {
      multi.createThread({ threadId: "reuse-second", cwd: primary, rolloutStore: second });
      expect(multi.listThreads({ pageSize: 10, archived: false }).items).toHaveLength(2);
      expect(open).not.toHaveBeenCalled();
      expect(openForCwd).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      openForCwd.mockRestore();
      multi.close(); first.close(); second.close();
      rmSync(primary, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("keeps a nonprimary project open for its second live writer", () => {
    const primary = mkdtempSync(join(tmpdir(), "agenc-mp-primary-"));
    const project = mkdtempSync(join(tmpdir(), "agenc-mp-shared-"));
    const first = openRollout({ cwd: project, sessionId: "shared-a" });
    const second = openRollout({ cwd: project, sessionId: "shared-b" });
    const multi = new MultiProjectFileThreadStore({ primaryCwd: primary, agencHome });
    const baseline = readdirSync("/dev/fd").length;
    try {
      multi.createThread({ threadId: "shared-a", cwd: project, rolloutStore: first });
      multi.createThread({ threadId: "shared-b", cwd: project, rolloutStore: second });
      const bothLive = readdirSync("/dev/fd").length;
      multi.shutdownThread("shared-a");
      first.close();
      multi.flushThread("shared-b");
      expect(multi.readThread({ threadId: "shared-b", includeArchived: false })).toMatchObject({ threadId: "shared-b" });
      expect(readdirSync("/dev/fd").length).toBeGreaterThanOrEqual(bothLive - 6);
      multi.shutdownThread("shared-b");
      second.close();
      expect(readdirSync("/dev/fd").length).toBeLessThanOrEqual(baseline + 2);
    } finally {
      multi.close();
      first.close();
      second.close();
      rmSync(primary, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("unions listThreads and readThread across two project cwds", () => {
    const cwdA = mkdtempSync(join(tmpdir(), "agenc-mp-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "agenc-mp-b-"));
    const rolloutA = openRollout({ cwd: cwdA, sessionId: "thread-a" });
    const rolloutB = openRollout({ cwd: cwdB, sessionId: "thread-b" });
    try {
      const multi = new MultiProjectFileThreadStore({
        primaryCwd: cwdA,
        agencHome,
      });
      multi.createThread({
        threadId: "thread-a",
        cwd: cwdA,
        rolloutStore: rolloutA,
      });
      multi.createThread({
        threadId: "thread-b",
        cwd: cwdB,
        rolloutStore: rolloutB,
      });

      const page = multi.listThreads({
        pageSize: 50,
        archived: false,
      });
      const ids = page.items.map((t) => t.threadId).sort();
      expect(ids).toEqual(["thread-a", "thread-b"]);

      const boundedFirst = multi.listThreads({
        pageSize: 1,
        archived: false,
        useStateDbOnly: true,
      });
      expect(boundedFirst.items).toHaveLength(1);
      expect(boundedFirst.nextCursor).toMatch(/^mp:bounded-v1:/);
      const boundedSecond = multi.listThreads({
        pageSize: 1,
        archived: false,
        useStateDbOnly: true,
        cursor: boundedFirst.nextCursor!,
      });
      expect(
        [...boundedFirst.items, ...boundedSecond.items]
          .map((thread) => thread.threadId)
          .sort(),
      ).toEqual(["thread-a", "thread-b"]);

      const readB = multi.readThread({
        threadId: "thread-b",
        includeArchived: false,
        includeHistory: false,
      });
      expect(readB.threadId).toBe("thread-b");

      multi.close();
    } finally {
      rolloutA.close();
      rolloutB.close();
      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    }
  });

  it("paginates the unified list with mp: cursors", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-mp-page-"));
    const rollouts: RolloutStore[] = [];
    try {
      const multi = new MultiProjectFileThreadStore({
        primaryCwd: cwd,
        agencHome,
      });
      for (const id of ["t1", "t2", "t3"]) {
        const r = openRollout({ cwd, sessionId: id });
        rollouts.push(r);
        multi.createThread({ threadId: id, cwd, rolloutStore: r });
      }
      const first = multi.listThreads({ pageSize: 2, archived: false });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toMatch(/^mp:/);

      const second = multi.listThreads({
        pageSize: 2,
        archived: false,
        cursor: first.nextCursor,
      });
      expect(second.items).toHaveLength(1);
      multi.close();
    } finally {
      for (const r of rollouts) r.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("resolveDaemonDefaultCwd (DAE-02) — shipped helper", () => {
  it("prefers AGENC_WORKSPACE then AGENC_PROJECT_DIR then PWD", () => {
    expect(resolveDaemonDefaultCwd({ AGENC_WORKSPACE: "/ws" })).toBe("/ws");
    expect(
      resolveDaemonDefaultCwd({
        AGENC_PROJECT_DIR: "/proj",
        PWD: "/pwd",
      }),
    ).toBe("/proj");
    expect(resolveDaemonDefaultCwd({ PWD: "/pwd" })).toBe("/pwd");
  });

  it("falls back to process.cwd when no workspace env is set", () => {
    const env = { ...process.env };
    delete env.AGENC_WORKSPACE;
    delete env.AGENC_PROJECT_DIR;
    delete env.PWD;
    expect(resolveDaemonDefaultCwd(env)).toBe(process.cwd());
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MultiProjectFileThreadStore } from "../../src/thread-store/multi-project-store.js";
import { resolveDaemonDefaultCwd } from "../../src/app-server/daemon-workspace.js";
import { RolloutStore } from "../../src/session/rollout-store.js";

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

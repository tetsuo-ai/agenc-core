/**
 * Leaving a split run's stray rows out of session.list
 * (split-run-session-list.test.ts) is only de-duplication. So it must cost no
 * reads for ordinary rows, must never make a listing or a daemon start fail,
 * must never hide a chat's only listed saved session, and must not hand back
 * an empty page while the listing goes on. Each case is a finding of the
 * independent reviews of this change.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/state/split-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/split-run.js")>();
  return {
    ...actual,
    splitRunDatabases: vi.fn(actual.splitRunDatabases),
    runsBoundOnlyElsewhere: vi.fn(actual.runsBoundOnlyElsewhere),
  };
});

import { discoverAgenCDaemonStartupState, type AgenCDaemonSavedSessionListing } from "../../src/app-server/daemon-cli.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import * as sqliteDriver from "../../src/state/sqlite-driver.js";
import * as sqliteEngine from "../../src/state/sqlite-engine.js";
import { runsBoundOnlyElsewhere, splitRunDatabases } from "../../src/state/split-run.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { MultiProjectFileThreadStore } from "../../src/thread-store/multi-project-store.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { splitChat } from "../helpers/split-chat-fixture.js";

let root = "";

beforeEach(async () => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-split-list-robust-"));
  const actual = await vi.importActual<typeof import("../../src/state/split-run.js")>("../../src/state/split-run.js");
  vi.mocked(splitRunDatabases).mockReset().mockImplementation(actual.splitRunDatabases);
  vi.mocked(runsBoundOnlyElsewhere).mockReset().mockImplementation(actual.runsBoundOnlyElsewhere);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** An ordinary chat: its own project, its rollout bound there, a thread row with its folder. */
function ordinaryChat(home: string, cwd: string, runId: string, createdAt = new Date().toISOString()): void {
  mkdirSync(cwd, { recursive: true });
  const store = new RolloutStore({ cwd, sessionId: runId, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false });
  store.open({ sessionId: runId, timestamp: new Date().toISOString(), cwd, originator: "agenc-cli",
    source: "interactive-root", agencVersion: VERSION, model: "base-model", modelProvider: "grok" });
  const rolloutPath = store.rolloutPath;
  store.close();
  const driver = sqliteDriver.openStateDatabases({ cwd, agencHome: home });
  try {
    new StateThreadRepository(driver).upsertThread({ threadId: runId, createdAt, updatedAt: createdAt, rolloutPath, cwd,
      model: "base-model", modelProvider: "grok" });
  } finally {
    driver.close();
  }
}

function openStore(agencHome: string, warn?: (message: string) => void): MultiProjectFileThreadStore {
  return new MultiProjectFileThreadStore({ primaryCwd: join(root, "elsewhere"), agencHome, deferPrimary: true,
    ...(warn !== undefined ? { warn } : {}) });
}

function list(agencHome: string, pageSize = 50) {
  const store = openStore(agencHome);
  try {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = store.listThreads({ pageSize, archived: false, useStateDbOnly: true, ...(cursor !== undefined ? { cursor } : {}) });
      pages.push(page.items.map((item) => item.threadId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return pages;
  } finally {
    store.close();
  }
}

describe("leaving a split run's stray rows out of session.list", () => {
  it("reads no other database for ordinary rows, also through another path to AGENC_HOME", () => {
    const home = join(root, "agenc-home");
    for (const name of ["one", "two", "three"]) {
      mkdirSync(join(root, name, ".git"), { recursive: true });
      ordinaryChat(home, join(root, name), `conv-${name}`);
    }
    const link = join(root, "home-link");
    symlinkSync(home, link);
    const readonlyOpens = (agencHome: string): number => {
      const opened = vi.spyOn(sqliteEngine, "openSqliteDatabase");
      expect(list(agencHome).flat().sort()).toEqual(["conv-one", "conv-three", "conv-two"]);
      const count = opened.mock.calls.filter(([, options]) => (options as { readonly?: boolean } | undefined)?.readonly === true).length;
      opened.mockRestore();
      return count;
    };
    // The rows name their rollouts by the real path; the listing reaches them through the link.
    expect(readonlyOpens(link)).toBe(readonlyOpens(home));
    expect(splitRunDatabases).not.toHaveBeenCalled();
  });

  it("works the split rule out once per run in one listing", async () => {
    const chat = await splitChat(root);
    expect(list(chat.home).flat().filter((id) => id === chat.runId)).toHaveLength(1);
    expect(splitRunDatabases).toHaveBeenCalledTimes(1);
  });

  it("lists as before, says so once, and starts, when a database cannot be read", async () => {
    const chat = await splitChat(root);
    vi.mocked(splitRunDatabases).mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    const warn = vi.fn();
    const store = openStore(chat.home, warn);
    try {
      for (let listing = 0; listing < 2; listing += 1) {
        expect(store.listThreads({ pageSize: 50, archived: false, useStateDbOnly: true }).items
          .filter((item) => item.threadId === chat.runId)).toHaveLength(2);
      }
    } finally {
      store.close();
    }
    // Once per listing call for the run, and one line for the store.
    expect(splitRunDatabases).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("database disk image is malformed");
    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    const startupWarn = vi.fn();
    expect(() => discoverAgenCDaemonStartupState(chat.home, chat.workspace, listings, startupWarn)).not.toThrow();
    expect([...listings.values()].some((listing) => listing.splitRunStray === true)).toBe(false);
    expect(startupWarn).toHaveBeenCalledWith(expect.stringContaining(`run ${chat.runId} is listed without the split-run check`));
  });

  it("never hides the chat's only saved session", async () => {
    // The first project's run row is done; only the second database still has a saved session for the chat.
    const chat = await splitChat(root, { firstStatus: "completed" });
    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    const report = discoverAgenCDaemonStartupState(chat.home, chat.workspace, listings);
    expect(report.recoveredRuns.filter((run) => run.id === chat.runId).map((run) => run.projectDir)).toEqual([chat.folderProject]);
    expect([...listings.values()].some((listing) => listing.splitRunStray === true)).toBe(false);
  });

  it("never hides the chat's only listed saved session", async () => {
    // The first project's saved session names no daemon session, so session.list never lists it.
    const chat = await splitChat(root, { firstSessionId: null });
    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    const report = discoverAgenCDaemonStartupState(chat.home, chat.workspace, listings);
    expect(report.recoveredRuns.filter((run) => run.id === chat.runId).map((run) => [run.projectDir, run.currentSessionId ?? null]).sort())
      .toEqual([[chat.firstProject, null], [chat.folderProject, "session-2"]].sort());
    expect([...listings.values()].some((listing) => listing.splitRunStray === true)).toBe(false);
  });

  it("reads each candidate database once at startup", async () => {
    const chat = await splitChat(root);
    // A second saved run in the second database whose thread row names no rollout: also a candidate there.
    const driver = sqliteDriver.openStateDatabases({ cwd: chat.workspace, agencHome: chat.home });
    try {
      const now = new Date().toISOString();
      upsertAgentRun(driver, { id: "conv-unbound", objective: "Interactive session", status: "suspended", startedAt: now,
        lastActiveAt: now, currentSessionId: "session-unbound" });
    } finally {
      driver.close();
    }
    discoverAgenCDaemonStartupState(chat.home, chat.workspace, new Map());
    const calls = vi.mocked(runsBoundOnlyElsewhere).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].projectDir).toBe(chat.folderProject);
    expect([...calls[0]![1]].sort()).toEqual(["conv-unbound", chat.runId].sort());
  });

  it("does not hand back an empty page while the listing goes on", async () => {
    const chat = await splitChat(root);
    // An older chat in the second project: its page holds the stray row first, then this one.
    ordinaryChat(chat.home, join(chat.workspace, "..", "older"), "conv-older", "2026-01-01T00:00:00.000Z");
    const pages = list(chat.home, 1);
    expect(pages.slice(0, -1).every((page) => page.length === 1)).toBe(true);
    expect(pages.flat().sort()).toEqual([chat.runId, "conv-older"].sort());
  });
});

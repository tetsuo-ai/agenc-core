/**
 * Leaving a split run's stray rows out of session.list
 * (split-run-session-list.test.ts) is only de-duplication. So it must cost no
 * reads for ordinary rows, must never make a listing or a daemon start fail,
 * must never hide a chat's only saved session, and must not hand back an
 * empty page while the listing goes on. Each case is a finding of the
 * independent review of this change.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/state/split-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/split-run.js")>();
  return { ...actual, splitRunStrayDatabases: vi.fn(actual.splitRunStrayDatabases) };
});

import { discoverAgenCDaemonStartupState, type AgenCDaemonSavedSessionListing } from "../../src/app-server/daemon-cli.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import * as sqliteDriver from "../../src/state/sqlite-driver.js";
import * as sqliteEngine from "../../src/state/sqlite-engine.js";
import { splitRunStrayDatabases } from "../../src/state/split-run.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { MultiProjectFileThreadStore } from "../../src/thread-store/multi-project-store.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { splitChat } from "../helpers/split-chat-fixture.js";

let root = "";

beforeEach(async () => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-split-list-robust-"));
  const actual = await vi.importActual<typeof import("../../src/state/split-run.js")>("../../src/state/split-run.js");
  vi.mocked(splitRunStrayDatabases).mockReset().mockImplementation(actual.splitRunStrayDatabases);
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

function list(agencHome: string, pageSize = 50) {
  const store = new MultiProjectFileThreadStore({ primaryCwd: join(root, "elsewhere"), agencHome, deferPrimary: true });
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
    expect(splitRunStrayDatabases).not.toHaveBeenCalled();
  });

  it("works the split rule out once per run in one listing", async () => {
    const chat = await splitChat(root);
    expect(list(chat.home).flat().filter((id) => id === chat.runId)).toHaveLength(1);
    expect(splitRunStrayDatabases).toHaveBeenCalledTimes(1);
  });

  it("lists as before, and starts, when a database cannot be read", async () => {
    const chat = await splitChat(root);
    vi.mocked(splitRunStrayDatabases).mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    expect(list(chat.home).flat().filter((id) => id === chat.runId)).toHaveLength(2);
    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    expect(() => discoverAgenCDaemonStartupState(chat.home, chat.workspace, listings)).not.toThrow();
    expect([...listings.values()].some((listing) => listing.splitRunStray === true)).toBe(false);
  });

  it("never hides the chat's only saved session", async () => {
    // The first project's run row is done; only the second database still has a saved session for the chat.
    const chat = await splitChat(root, { firstStatus: "completed" });
    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    const report = discoverAgenCDaemonStartupState(chat.home, chat.workspace, listings);
    expect(report.recoveredRuns.filter((run) => run.id === chat.runId).map((run) => run.projectDir)).toEqual([chat.folderProject]);
    expect([...listings.values()].some((listing) => listing.splitRunStray === true)).toBe(false);
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

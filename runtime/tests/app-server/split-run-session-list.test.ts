/**
 * A chat split by an earlier resume is listed once per kind of row, from the
 * database that holds its rollout.
 *
 * Core before agenc-core #3609 could split a chat across two project
 * databases (run-inspection.split-run.test.ts makes such a split the same
 * way, as does tests/helpers/split-chat-fixture.ts). After a daemon restart
 * session.list then named the chat four times: the saved session and the
 * thread row of each database. The second database's two rows are the newest
 * and name no folder, so a client that kept one could not reopen the chat
 * ("has no recorded workspace"). They are the rows run inspection leaves out
 * of a split run; the listing now leaves them out by the same rule.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverAgenCDaemonStartupState, type AgenCDaemonSavedSessionListing } from "../../src/app-server/daemon-cli.js";
import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import * as sqliteDriver from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { MultiProjectFileThreadStore } from "../../src/thread-store/multi-project-store.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { splitChat } from "../helpers/split-chat-fixture.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-split-list-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function inspection(home: string): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

describe("session.list of a chat an earlier resume split", () => {
  it("leaves out the second database's saved session, and keeps both as restore targets", async () => {
    const chat = await splitChat(root);
    // Run inspection reads the chat partial, leaving the folder's database out.
    expect(inspection(chat.home).status({ runId: chat.runId }).source.partial)
      .toEqual({ reason: "split_run", omittedProjectDirs: [chat.folderProject] });

    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    const report = discoverAgenCDaemonStartupState(chat.home, chat.workspace, listings);
    expect(report.recoveredRuns.filter((run) => run.id === chat.runId).map((run) => [run.projectDir, run.currentSessionId]).sort())
      .toEqual([[chat.firstProject, "session-1"], [chat.folderProject, "session-2"]].sort());
    const byProject = new Map([...listings].map(([key, listing]) => [key.split("\0")[0], listing]));
    expect(byProject.get(chat.firstProject)).toEqual({ cwd: chat.workspace, model: "base-model", modelProvider: "grok" });
    expect(byProject.get(chat.folderProject)).toEqual({ model: "base-model", modelProvider: "grok", splitRunStray: true });
  });

  it("lists the chat's thread row from the database that holds its rollout only", async () => {
    const chat = await splitChat(root);
    const store = new MultiProjectFileThreadStore({ primaryCwd: join(root, "elsewhere"), agencHome: chat.home, deferPrimary: true });
    try {
      // The bounded page session.list reads, and the filtered listing.
      for (const params of [
        { pageSize: 50, archived: false, useStateDbOnly: true },
        { pageSize: 50, archived: false, useStateDbOnly: true, searchTerm: "" },
      ] as const) {
        const rows = store.listThreads(params).items.filter((item) => item.threadId === chat.runId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ cwd: chat.workspace, rolloutPath: chat.rolloutPath });
      }
    } finally {
      store.close();
    }
  });

  it("keeps listing both databases' rows when the split is one the reader refuses", async () => {
    const chat = await splitChat(root);
    // The second database's thread row now names another rollout: not a split
    // the reader accepts, so nothing is left out and inspection refuses.
    const driver = sqliteDriver.openStateDatabases({ cwd: chat.workspace, agencHome: chat.home });
    try {
      const now = new Date().toISOString();
      new StateThreadRepository(driver).upsertThread({ threadId: chat.runId, createdAt: now, updatedAt: now,
        rolloutPath: join(chat.folderProject, "sessions", chat.runId, "rollout-elsewhere.jsonl") });
    } finally {
      driver.close();
    }
    expect(() => inspection(chat.home).status({ runId: chat.runId }))
      .toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "project_split" }));
    const listings = new Map<string, AgenCDaemonSavedSessionListing>();
    discoverAgenCDaemonStartupState(chat.home, chat.workspace, listings);
    expect([...listings.values()].some((listing) => listing.splitRunStray === true)).toBe(false);
    const store = new MultiProjectFileThreadStore({ primaryCwd: join(root, "elsewhere"), agencHome: chat.home, deferPrimary: true });
    try {
      expect(store.listThreads({ pageSize: 50, archived: false, useStateDbOnly: true }).items
        .filter((item) => item.threadId === chat.runId)).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

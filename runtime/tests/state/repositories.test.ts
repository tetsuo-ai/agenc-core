import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogsRepository } from "./logs.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

let home = "";
let cwd = "";
let originalAgencHome = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-state-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-state-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
});

afterEach(() => {
  driver.close();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("state repositories", () => {
  it("mirrors logs without throwing through tryAppend", () => {
    const logs = new LogsRepository(driver);
    expect(
      logs.tryAppend({
        timestamp: new Date().toISOString(),
        level: "warning",
        message: "indexed",
        payload: { ok: true },
      }),
    ).toBe(true);
  });

  it("reads deterministic thread pages from a keyset boundary", () => {
    const threads = new StateThreadRepository(driver);
    for (const [index, threadId] of ["a", "b", "c", "d"].entries()) {
      threads.upsertThread({
        threadId,
        createdAt: `2026-07-18T00:00:0${index}.000Z`,
        updatedAt: `2026-07-18T00:00:0${index}.000Z`,
      });
    }
    threads.upsertThread({
      threadId: "archived",
      createdAt: "2026-07-18T00:00:09.000Z",
      updatedAt: "2026-07-18T00:00:09.000Z",
      archivedAt: "2026-07-18T00:01:00.000Z",
    });

    const first = threads.listThreadPage({
      limit: 2,
      archived: false,
      sortKey: "created_at",
      sortDirection: "desc",
    });
    expect(first.items.map((thread) => thread.threadId)).toEqual(["d", "c"]);
    expect(first.hasMore).toBe(true);

    const second = threads.listThreadPage({
      limit: 2,
      archived: false,
      sortKey: "created_at",
      sortDirection: "desc",
      after: {
        sortValue: first.items.at(-1)!.createdAt,
        threadId: first.items.at(-1)!.threadId,
      },
    });
    expect(second.items.map((thread) => thread.threadId)).toEqual(["b", "a"]);
    expect(second.hasMore).toBe(false);
  });
});

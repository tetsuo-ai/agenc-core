import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROLLOUT_SCHEMA_VERSION } from "../session/event-log.js";
import { serializeRolloutItem } from "../session/rollout-item.js";
import { FileThreadStore } from "../thread-store/index.js";
import { backfillProjectRollouts } from "./backfill.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

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

describe("backfillProjectRollouts", () => {
  it("indexes rollout files idempotently and rebuilds changed rows", () => {
    const sessionDir = join(driver.projectDir, "sessions", "thread-1");
    mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = join(
      sessionDir,
      "rollout-2026-04-29T00-00-00-000Z-thread-1.jsonl",
    );
    writeFileSync(
      rolloutPath,
      serializeRolloutItem({
        type: "session_meta",
        payload: {
          sessionId: "thread-1",
          timestamp: "2026-04-29T00:00:00.000Z",
          cwd,
          originator: "test",
          agencVersion: "0.2.0",
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
          model: "grok-4",
          modelProvider: "xai",
        },
      }) +
        serializeRolloutItem({
          type: "response_item",
          payload: { role: "user", content: "hello" },
        }),
    );
    expect(backfillProjectRollouts({ projectDir: driver.projectDir, driver }))
      .toMatchObject({ filesIndexed: 1, itemsIndexed: 2 });
    expect(backfillProjectRollouts({ projectDir: driver.projectDir, driver }))
      .toMatchObject({ filesIndexed: 1, itemsIndexed: 2 });
    expect(
      driver
        .prepareState<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM thread_rollout_items",
        )
        .get()?.count,
    ).toBe(2);
    expect(
      driver
        .prepareState<[], { model: string | null; model_provider: string | null }>(
          "SELECT model, model_provider FROM threads WHERE thread_id = 'thread-1'",
        )
        .get(),
    ).toEqual({ model: "grok-4", model_provider: "xai" });

    driver
      .prepareState<[string, string, string]>(
        "UPDATE threads SET name = ?, archived_at = ? WHERE thread_id = ?",
      )
      .run("saved title", "2026-05-01T00:00:00.000Z", "thread-1");

    writeFileSync(
      rolloutPath,
      serializeRolloutItem({
        type: "session_meta",
        payload: {
          sessionId: "thread-1",
          timestamp: "2026-04-29T00:00:00.000Z",
          cwd,
          originator: "test",
          agencVersion: "0.2.0",
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
          model: "grok-4-fast",
          modelProvider: "xai",
        },
      }),
    );
    backfillProjectRollouts({ projectDir: driver.projectDir, driver });
    expect(
      driver
        .prepareState<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM thread_rollout_items",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      driver
        .prepareState<
          [],
          {
            name: string | null;
            archived_at: string | null;
            model: string | null;
            model_provider: string | null;
          }
        >(
          "SELECT name, archived_at, model, model_provider FROM threads WHERE thread_id = 'thread-1'",
        )
        .get(),
    ).toEqual({
      name: "saved title",
      archived_at: null,
      model: "grok-4-fast",
      model_provider: "xai",
    });
  });

  it("keeps archived rollout files out of active thread listings", () => {
    const sessionDir = join(driver.projectDir, "archived_sessions", "archived-1");
    mkdirSync(sessionDir, { recursive: true });
    const rolloutPath = join(
      sessionDir,
      "rollout-2026-04-29T00-00-00-000Z-archived-1.jsonl",
    );
    writeFileSync(
      rolloutPath,
      serializeRolloutItem({
        type: "session_meta",
        payload: {
          sessionId: "archived-1",
          timestamp: "2026-04-29T00:00:00.000Z",
          cwd,
          originator: "test",
          agencVersion: "0.2.0",
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
          model: "grok-4",
          modelProvider: "xai",
        },
      }),
    );

    backfillProjectRollouts({ projectDir: driver.projectDir, driver });

    const store = new FileThreadStore({ cwd });
    try {
      expect(
        store
          .listThreads({ pageSize: 10, archived: false, useStateDbOnly: true })
          .items.map((thread) => thread.threadId),
      ).toEqual([]);
      expect(
        store
          .listThreads({ pageSize: 10, archived: true, useStateDbOnly: true })
          .items.map((thread) => thread.threadId),
      ).toEqual(["archived-1"]);
    } finally {
      store.close();
    }
  });
});

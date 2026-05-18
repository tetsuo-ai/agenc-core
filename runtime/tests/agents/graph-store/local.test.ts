import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../state/sqlite-driver.js";
import type { AgentGraphStoreError } from "./errors.js";
import { LocalAgentGraphStore } from "./local.js";
import type { ThreadSpawnEdgeStatus } from "./types.js";

let home = "";
let cwd = "";
let originalAgencHome: string | undefined;
let driver: StateSqliteDriver;
let store: LocalAgentGraphStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-agent-graph-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-agent-graph-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
  store = new LocalAgentGraphStore(driver);
});

afterEach(() => {
  driver.close();
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("LocalAgentGraphStore", () => {
  it("upserts and lists direct children with stable status filters", async () => {
    await store.upsertThreadSpawnEdge("root", "child-b", "closed");
    await store.upsertThreadSpawnEdge("root", "child-a", "open");

    await expect(store.listThreadSpawnChildren("root")).resolves.toEqual([
      "child-a",
      "child-b",
    ]);
    await expect(
      store.listThreadSpawnChildren("root", undefined),
    ).resolves.toEqual(["child-a", "child-b"]);
    await expect(store.listThreadSpawnChildren("root", null)).resolves.toEqual([
      "child-a",
      "child-b",
    ]);
    await expect(
      store.listThreadSpawnChildren("root", "open"),
    ).resolves.toEqual(["child-a"]);
    await expect(
      store.listThreadSpawnChildren("root", "closed"),
    ).resolves.toEqual(["child-b"]);
  });

  it("updates edge status and treats missing children as a no-op", async () => {
    await expect(
      store.setThreadSpawnEdgeStatus("missing-child", "closed"),
    ).resolves.toBeUndefined();

    await store.upsertThreadSpawnEdge("root", "child-a", "open");
    await store.setThreadSpawnEdgeStatus("child-a", "closed");

    await expect(
      store.listThreadSpawnChildren("root", "open"),
    ).resolves.toEqual([]);
    await expect(
      store.listThreadSpawnChildren("root", "closed"),
    ).resolves.toEqual(["child-a"]);
  });

  it("lists descendants breadth-first by depth and child thread id", async () => {
    for (const [parent, child, status] of [
      ["root", "child-b", "open"],
      ["root", "child-a", "open"],
      ["child-a", "grand-b", "open"],
      ["child-b", "grand-a", "closed"],
      ["root", "child-c", "closed"],
      ["child-c", "great-a", "closed"],
    ] as const) {
      await store.upsertThreadSpawnEdge(parent, child, status);
    }

    await expect(store.listThreadSpawnDescendants("root")).resolves.toEqual([
      "child-a",
      "child-b",
      "child-c",
      "grand-a",
      "grand-b",
      "great-a",
    ]);
    await expect(
      store.listThreadSpawnDescendants("root", "open"),
    ).resolves.toEqual(["child-a", "child-b", "grand-b"]);
    await expect(
      store.listThreadSpawnDescendants("root", "closed"),
    ).resolves.toEqual(["child-c", "great-a"]);
  });

  it("terminates descendant traversal when persisted graph rows contain a cycle", async () => {
    await store.upsertThreadSpawnEdge("root", "child-a", "open");
    await store.upsertThreadSpawnEdge("child-a", "root", "open");

    await expect(store.listThreadSpawnDescendants("root")).resolves.toEqual([
      "child-a",
    ]);
  });

  it("rejects invalid runtime statuses before hitting storage", async () => {
    const invalidStatus = "stale" as ThreadSpawnEdgeStatus;

    await expect(
      store.upsertThreadSpawnEdge("root", "child-a", invalidStatus),
    ).rejects.toMatchObject({
      kind: "invalid_request",
    } satisfies Partial<AgentGraphStoreError>);
    await expect(
      store.setThreadSpawnEdgeStatus("child-a", invalidStatus),
    ).rejects.toMatchObject({
      kind: "invalid_request",
    } satisfies Partial<AgentGraphStoreError>);
    await expect(
      store.listThreadSpawnChildren("root", invalidStatus),
    ).rejects.toMatchObject({
      kind: "invalid_request",
    } satisfies Partial<AgentGraphStoreError>);
    await expect(
      store.listThreadSpawnDescendants("root", invalidStatus),
    ).rejects.toMatchObject({
      kind: "invalid_request",
    } satisfies Partial<AgentGraphStoreError>);
  });

  it("wraps read-side SQLite failures in the graph-store error boundary", async () => {
    driver.close();

    await expect(store.listThreadSpawnChildren("root")).rejects.toMatchObject({
      kind: "internal",
    } satisfies Partial<AgentGraphStoreError>);
    await expect(
      store.listThreadSpawnDescendants("root"),
    ).rejects.toMatchObject({
      kind: "internal",
    } satisfies Partial<AgentGraphStoreError>);
  });

  it("preserves existing AgenC edge metadata when graph-only upserts change topology", async () => {
    driver
      .prepareState<[string, string, string, string, string]>(
        `INSERT INTO thread_spawn_edges (
          child_thread_id,
          parent_thread_id,
          parent_path,
          metadata_json,
          status
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "child-a",
        "root",
        "/root/existing",
        JSON.stringify({ depth: 2, agentPath: "/root/existing/child" }),
        "open",
      );

    await store.upsertThreadSpawnEdge("new-root", "child-a", "closed");

    expect(
      driver
        .prepareState<
          [string],
          {
            parent_thread_id: string;
            parent_path: string;
            metadata_json: string;
            status: string;
          }
        >(
          `SELECT parent_thread_id, parent_path, metadata_json, status
           FROM thread_spawn_edges
           WHERE child_thread_id = ?`,
        )
        .get("child-a"),
    ).toEqual({
      parent_thread_id: "new-root",
      parent_path: "/root/existing",
      metadata_json: JSON.stringify({
        depth: 2,
        agentPath: "/root/existing/child",
      }),
      status: "closed",
    });
  });
});

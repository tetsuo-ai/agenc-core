import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { AgentMetadata } from "../agents/registry.js";
import { resolveStateDatabasePaths } from "../state/sqlite-driver.js";
import { RolloutStore } from "./rollout-store.js";
import { getProjectDir, getSessionDir } from "./session-store.js";

let agencHome = "";
let originalAgencHome = "";

function openStore(opts: {
  cwd: string;
  sessionId: string;
  resume?: boolean;
}): RolloutStore {
  const store = new RolloutStore({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    agencVersion: "0.2.0",
    ...(opts.resume ? { resume: true } : {}),
  });
  store.open({
    sessionId: opts.sessionId,
    timestamp: new Date().toISOString(),
    cwd: opts.cwd,
    originator: "rollout-store-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  return store;
}

function metadata(
  agentId: string,
  agentPath: string,
  depth: number,
): AgentMetadata {
  return {
    agentId,
    agentPath,
    agentNickname: agentPath.split("/").at(-1) ?? agentId,
    agentRole: "default",
    depth,
  };
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-rollout-store-home-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
});

afterEach(() => {
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
});

describe("RolloutStore thread-spawn edges", () => {
  it("redacts secrets from persisted live transcript rows", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "transcript-secret";
    const store = openStore({ cwd, sessionId });
    const rawSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";
    const opaqueSecret = "opaque-value-12345";

    try {
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
      store.appendRollout(
        {
          type: "compacted",
          payload: {
            message: `api_key=${opaqueSecret}`,
            replacementHistory: [
              {
                role: "assistant",
                content: rawSecret,
              },
            ],
          },
        },
        { durable: true },
      );
      store.appendRollout(
        {
          type: "event_msg",
          payload: {
            id: "secret-error",
            msg: {
              type: "error",
              payload: {
                cause: "provider_failed",
                message: "Authorization: Bearer abcdefghijklmnop=",
                stack: `token=${opaqueSecret}`,
              },
            },
          },
        },
        { durable: true },
      );

      const content = readFileSync(store.rolloutPath, "utf8");
      expect(content).not.toContain(rawSecret);
      expect(content).not.toContain(opaqueSecret);
      expect(content).not.toContain("abcdefghijklmnop=");
      expect(content).toContain("[REDACTED_SECRET]");
      expect(store.readAll().some((item) => JSON.stringify(item).includes(rawSecret)))
        .toBe(false);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists edge metadata and status across reopen", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-persist";
    const original = openStore({ cwd, sessionId });
    const childMetadata: AgentMetadata = {
      ...metadata("child-1", "/root/alpha", 1),
      agentRoleWorkspaceId: cwd,
    };

    try {
      original.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-1",
        parentPath: "/root",
        metadata: childMetadata,
        status: "open",
      });
      original.setThreadSpawnEdgeStatus("child-1", "closed");
      (childMetadata as { agentPath?: string }).agentPath = "/root/stale";
      original.close();

      const reopened = openStore({ cwd, sessionId, resume: true });
      try {
        expect(
          reopened.listThreadSpawnChildrenWithStatus("root-1", "open"),
        ).toEqual([]);
        expect(
          reopened.listThreadSpawnChildrenWithStatus("root-1", "closed"),
        ).toEqual([
          {
            parentThreadId: "root-1",
            childThreadId: "child-1",
            parentPath: "/root",
            metadata: {
              agentId: "child-1",
              agentPath: "/root/alpha",
              agentNickname: "alpha",
              agentRole: "default",
              agentRoleWorkspaceId: cwd,
              depth: 1,
            },
            status: "closed",
          },
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed instead of reopening a corrupted persisted edge status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-invalid-status";
    const original = openStore({ cwd, sessionId });
    try {
      original.createThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-invalid-status",
        parentPath: "/root",
        metadata: metadata(
          "child-invalid-status",
          "/root/child_invalid_status",
          1,
        ),
        status: "open",
      });
      original.close();

      const raw = new Database(resolveStateDatabasePaths({ cwd }).stateDbPath);
      try {
        raw.prepare(
          `UPDATE thread_spawn_edges
           SET status = 'corrupted'
           WHERE child_thread_id = ?`,
        ).run("child-invalid-status");
      } finally {
        raw.close();
      }

      expect(() => openStore({ cwd, sessionId, resume: true })).toThrow(
        /invalid thread-spawn edge status: corrupted/,
      );
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a legacy metadata rewrite that would remove provenance", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-legacy-rewrite";
    const original = openStore({ cwd, sessionId });
    try {
      original.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-legacy",
        parentPath: "/root",
        metadata: {
          ...metadata("child-legacy", "/root/legacy", 1),
          agentRoleWorkspaceId: cwd,
        },
        status: "open",
      });
      original.close();

      const raw = new Database(resolveStateDatabasePaths({ cwd }).stateDbPath);
      try {
        expect(() =>
          raw.prepare(
            `UPDATE thread_spawn_edges
             SET metadata_json = ?, status = 'closed'
             WHERE child_thread_id = ?`,
          ).run(
            JSON.stringify(metadata("child-legacy", "/root/legacy", 1)),
            "child-legacy",
          ),
        ).toThrow(/identity is immutable/);
      } finally {
        raw.close();
      }

      const reopened = openStore({ cwd, sessionId, resume: true });
      try {
        expect(reopened.getThreadSpawnEdge("child-legacy")?.metadata).toEqual({
          ...metadata("child-legacy", "/root/legacy", 1),
          agentRoleWorkspaceId: cwd,
        });
        expect(reopened.getThreadSpawnEdge("child-legacy")?.status).toBe("open");
      } finally {
        reopened.close();
      }
    } finally {
      original.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps spawn identity create-only and publishes only durable status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const otherWorkspace = join(cwd, "other-workspace");
    const sessionId = "thread-spawn-provenance-immutability";
    const store = openStore({ cwd, sessionId });
    const baseMetadata = {
      ...metadata("child-immutable", "/root/immutable", 1),
      agentRoleWorkspaceId: cwd,
      agentRoleFingerprint: "default-role-fingerprint",
    };
    try {
      store.createThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-immutable",
        parentPath: "/root",
        metadata: baseMetadata,
        status: "open",
      });
      store.setThreadSpawnEdgeStatus("child-immutable", "closed");
      expect(store.getThreadSpawnEdge("child-immutable")).toMatchObject({
        status: "closed",
        metadata: {
          agentRoleWorkspaceId: cwd,
          agentRoleFingerprint: "default-role-fingerprint",
          agentRole: "default",
        },
      });

      const paths = resolveStateDatabasePaths({ cwd });
      const raw = new Database(paths.stateDbPath);
      try {
        const before = raw
          .prepare(
            `SELECT parent_thread_id, parent_path, metadata_json,
                    agent_role_workspace_id, agent_role_fingerprint, status
             FROM thread_spawn_edges
             WHERE child_thread_id = ?`,
          )
          .get("child-immutable");
        const inMemoryBefore = store.getThreadSpawnEdge("child-immutable");

        expect(() =>
          store.createThreadSpawnEdge({
            parentThreadId: "attacker-root",
            childThreadId: "child-immutable",
            parentPath: "/root",
            metadata: {
              ...baseMetadata,
              agentRoleWorkspaceId: otherWorkspace,
            },
            status: "open",
          }),
        ).toThrow(/agent thread id already exists/);
        expect(store.getThreadSpawnEdge("child-immutable")).toEqual(
          inMemoryBefore,
        );
        expect(
          raw
            .prepare(
              `SELECT parent_thread_id, parent_path, metadata_json,
                      agent_role_workspace_id, agent_role_fingerprint, status
               FROM thread_spawn_edges
               WHERE child_thread_id = ?`,
            )
            .get("child-immutable"),
        ).toEqual(before);

        expect(() =>
          store.createThreadSpawnEdge({
            parentThreadId: "root-1",
            childThreadId: "child-immutable",
            parentPath: "/root",
            metadata: {
              ...baseMetadata,
              agentRole: "worker",
              agentRoleFingerprint: "worker-role-fingerprint",
            },
            status: "open",
          }),
        ).toThrow(/agent thread id already exists/);
        expect(store.getThreadSpawnEdge("child-immutable")).toEqual(
          inMemoryBefore,
        );

        expect(() =>
          store.createThreadSpawnEdge({
            parentThreadId: "root-1",
            childThreadId: "child-immutable",
            parentPath: "/root",
            metadata: baseMetadata,
            status: "open",
          }),
        ).toThrow(/agent thread id already exists/);
        expect(store.getThreadSpawnEdge("child-immutable")).toEqual(
          inMemoryBefore,
        );

        expect(() =>
          store.createThreadSpawnEdge({
            parentThreadId: "root-1",
            childThreadId: "edge-key",
            parentPath: "/root",
            metadata: metadata("metadata-id", "/root/metadata-id", 1),
            status: "open",
          }),
        ).toThrow(/child identity/);
        expect(store.getThreadSpawnEdge("edge-key")).toBeUndefined();

        expect(() =>
          store.createThreadSpawnEdge({
            parentThreadId: "root-1",
            childThreadId: "invalid-status-edge",
            parentPath: "/root",
            metadata: metadata(
              "invalid-status-edge",
              "/root/invalid_status_edge",
              1,
            ),
            status: "corrupted" as "open",
          }),
        ).toThrow(/invalid thread-spawn edge record or child identity/);
        expect(store.getThreadSpawnEdge("invalid-status-edge")).toBeUndefined();
        expect(
          raw
            .prepare(
              "SELECT child_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?",
            )
            .get("invalid-status-edge"),
        ).toBeUndefined();

        store.createThreadSpawnEdge({
          parentThreadId: "root-1",
          childThreadId: "status-failure-child",
          parentPath: "/root",
          metadata: metadata(
            "status-failure-child",
            "/root/status_failure_child",
            1,
          ),
          status: "open",
        });
        raw.exec(`
          CREATE TRIGGER reject_spawn_edge_status_update
          BEFORE UPDATE OF status ON thread_spawn_edges
          WHEN OLD.child_thread_id = 'status-failure-child'
            AND NEW.status = 'closed'
          BEGIN
            SELECT RAISE(ABORT, 'forced status persistence failure');
          END;
        `);
        expect(() =>
          store.setThreadSpawnEdgeStatus("status-failure-child", "closed"),
        ).toThrow(/forced status persistence failure/);
        expect(store.getThreadSpawnEdge("status-failure-child")?.status).toBe(
          "open",
        );
        expect(
          raw
            .prepare(
              "SELECT status FROM thread_spawn_edges WHERE child_thread_id = ?",
            )
            .get("status-failure-child"),
        ).toEqual({ status: "open" });
      } finally {
        raw.close();
      }
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("lets exactly one concurrent store create a child identity", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const first = openStore({ cwd, sessionId: "create-race-first" });
    const second = openStore({ cwd, sessionId: "create-race-second" });
    try {
      first.createThreadSpawnEdge({
        parentThreadId: "root-first",
        childThreadId: "race-child",
        parentPath: "/root",
        metadata: metadata("race-child", "/root/race_child", 1),
        status: "open",
      });
      const winner = first.getThreadSpawnEdge("race-child");

      expect(() =>
        second.createThreadSpawnEdge({
          parentThreadId: "root-second",
          childThreadId: "race-child",
          parentPath: "/root",
          metadata: metadata("race-child", "/root/attacker", 1),
          status: "closed",
        }),
      ).toThrow(/agent thread id already exists/);
      expect(second.getThreadSpawnEdge("race-child")).toEqual(winner);
      expect(first.getThreadSpawnEdge("race-child")).toEqual(winner);
    } finally {
      first.close();
      second.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("publishes a monotonic close across live stores", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const first = openStore({ cwd, sessionId: "close-coherence-first" });
    first.createThreadSpawnEdge({
      parentThreadId: "root-1",
      childThreadId: "close-coherence-child",
      parentPath: "/root",
      metadata: metadata(
        "close-coherence-child",
        "/root/close_coherence_child",
        1,
      ),
      status: "open",
    });
    const second = openStore({ cwd, sessionId: "close-coherence-second" });

    try {
      expect(second.getThreadSpawnEdge("close-coherence-child")?.status).toBe(
        "open",
      );

      first.setThreadSpawnEdgeStatus("close-coherence-child", "closed");

      expect(second.getThreadSpawnEdge("close-coherence-child")?.status).toBe(
        "closed",
      );
      expect(() =>
        second.setThreadSpawnEdgeStatus("close-coherence-child", "open"),
      ).toThrow(/cannot transition.*closed.*open/i);

      // A second close is a successful idempotent acknowledgement of the
      // already-durable terminal state, even from another live store.
      second.setThreadSpawnEdgeStatus("close-coherence-child", "closed");
      first.setThreadSpawnEdgeStatus("close-coherence-child", "closed");
      expect(first.getThreadSpawnEdge("close-coherence-child")?.status).toBe(
        "closed",
      );
    } finally {
      first.close();
      second.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reads current direct and descendant lists across live stores", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const first = openStore({ cwd, sessionId: "list-coherence-first" });
    first.createThreadSpawnEdge({
      parentThreadId: "root-1",
      childThreadId: "list-coherence-existing",
      parentPath: "/root",
      metadata: metadata(
        "list-coherence-existing",
        "/root/list_coherence_existing",
        1,
      ),
      status: "open",
    });
    const second = openStore({ cwd, sessionId: "list-coherence-second" });

    try {
      first.setThreadSpawnEdgeStatus("list-coherence-existing", "closed");
      first.createThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "list-coherence-late",
        parentPath: "/root",
        metadata: metadata(
          "list-coherence-late",
          "/root/list_coherence_late",
          1,
        ),
        status: "open",
      });

      expect(
        second
          .listThreadSpawnChildrenWithStatus("root-1", "open")
          .map((edge) => edge.childThreadId),
      ).toEqual(["list-coherence-late"]);
      expect(
        second
          .listThreadSpawnChildrenWithStatus("root-1", "closed")
          .map((edge) => edge.childThreadId),
      ).toEqual(["list-coherence-existing"]);
      expect(
        second.listThreadSpawnDescendants("root-1").map((edge) => ({
          childThreadId: edge.childThreadId,
          status: edge.status,
        })),
      ).toEqual([
        { childThreadId: "list-coherence-existing", status: "closed" },
        { childThreadId: "list-coherence-late", status: "open" },
      ]);

      // The second store did not have this row at construction time. Closing
      // it must still reach SQLite instead of returning from a stale cache.
      second.setThreadSpawnEdgeStatus("list-coherence-late", "closed");
      expect(first.getThreadSpawnEdge("list-coherence-late")?.status).toBe(
        "closed",
      );
      expect(
        second.listThreadSpawnChildrenWithStatus("root-1", "open"),
      ).toEqual([]);
    } finally {
      first.close();
      second.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("lists status-filtered and unfiltered descendants breadth-first", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-descendants";
    const store = openStore({ cwd, sessionId });

    try {
      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-z",
        parentPath: "/root",
        metadata: metadata("child-z", "/root/alpha", 1),
        status: "closed",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-a",
        parentPath: "/root",
        metadata: metadata("child-a", "/root/zulu", 1),
        status: "open",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "child-z",
        childThreadId: "grandchild-a",
        parentPath: "/root/alpha",
        metadata: metadata("grandchild-a", "/root/alpha/scout", 2),
        status: "open",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "child-a",
        childThreadId: "grandchild-b",
        parentPath: "/root/zulu",
        metadata: metadata("grandchild-b", "/root/zulu/worker", 2),
        status: "closed",
      });

      expect(
        store
          .listThreadSpawnDescendantsWithStatus("root-1", "open")
          .map((edge) => edge.childThreadId),
      ).toEqual(["child-a"]);
      expect(
        store
          .listThreadSpawnDescendantsWithStatus("root-1", "closed")
          .map((edge) => edge.childThreadId),
      ).toEqual(["child-z"]);
      expect(
        store
          .listThreadSpawnDescendants("root-1")
          .map((edge) => edge.childThreadId),
      ).toEqual(["child-a", "child-z", "grandchild-a", "grandchild-b"]);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("finds direct children and descendants by canonical agent path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-path";
    const store = openStore({ cwd, sessionId });

    try {
      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-open",
        parentPath: "/root",
        metadata: metadata("child-open", "/root/open", 1),
        status: "open",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-closed",
        parentPath: "/root",
        metadata: metadata("child-closed", "/root/closed", 1),
        status: "closed",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "child-closed",
        childThreadId: "grandchild-open",
        parentPath: "/root/closed",
        metadata: metadata("grandchild-open", "/root/closed/open", 2),
        status: "open",
      });

      expect(store.findThreadSpawnChildByPath("root-1", "/root/open")).toBe(
        "child-open",
      );
      expect(store.findThreadSpawnChildByPath("root-1", "/root/closed")).toBe(
        "child-closed",
      );
      expect(
        store.findThreadSpawnChildByPath("root-1", "/root/closed/open"),
      ).toBeUndefined();
      expect(
        store.findThreadSpawnDescendantByPath("root-1", "/root/closed/open"),
      ).toBe("grandchild-open");
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws when path lookup matches multiple spawned threads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-path-collision";
    const store = openStore({ cwd, sessionId });

    try {
      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-a",
        parentPath: "/root",
        metadata: metadata("child-a", "/root/duplicate", 1),
        status: "open",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-b",
        parentPath: "/root",
        metadata: metadata("child-b", "/root/duplicate", 1),
        status: "closed",
      });

      expect(() =>
        store.findThreadSpawnChildByPath("root-1", "/root/duplicate"),
      ).toThrow(/multiple spawned threads matched agent path/);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("imports obvious legacy snapshots with implicit open status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-legacy";
    const sessionDir = getSessionDir(cwd, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "thread-spawn-edges.json"),
      `${JSON.stringify({
        threadSpawnEdges: {
          "child-legacy": {
            parentThreadId: "root-1",
            parentPath: "/root",
            metadata: metadata("child-legacy", "/root/legacy", 1),
          },
        },
      })}\n`,
      "utf8",
    );

    const store = openStore({ cwd, sessionId, resume: true });
    try {
      expect(store.getThreadSpawnEdge("child-legacy")).toEqual({
        childThreadId: "child-legacy",
        parentThreadId: "root-1",
        parentPath: "/root",
        metadata: metadata("child-legacy", "/root/legacy", 1),
        status: "open",
      });
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("backs up corrupt snapshots and starts with an empty graph", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-corrupt";
    const sessionDir = getSessionDir(cwd, sessionId);
    const snapshotPath = join(sessionDir, "thread-spawn-edges.json");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(snapshotPath, "{not-json", "utf8");

    const store = openStore({ cwd, sessionId, resume: true });
    try {
      expect(store.listThreadSpawnChildren("root-1")).toEqual([]);
      const corruptDir = join(getProjectDir(cwd), "state-corrupt");
      const backups = readdirSync(corruptDir).filter((entry) =>
        entry.startsWith("thread-spawn-edges-") && entry.endsWith(".json"),
      );
      expect(backups).toHaveLength(1);
      expect(existsSync(snapshotPath)).toBe(true);

      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-after-corrupt",
        parentPath: "/root",
        metadata: metadata("child-after-corrupt", "/root/recovered", 1),
        status: "open",
      });
      expect(existsSync(snapshotPath)).toBe(true);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

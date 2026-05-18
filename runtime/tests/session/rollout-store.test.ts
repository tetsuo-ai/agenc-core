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
import type { AgentMetadata } from "../agents/registry.js";
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
    const childMetadata = metadata("child-1", "/root/alpha", 1);

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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMetadata } from "../agents/registry.js";
import { RolloutStore } from "./rollout-store.js";

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

  it("lists open descendants breadth-first in stable path order", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-rollout-store-cwd-"));
    const sessionId = "thread-spawn-descendants";
    const store = openStore({ cwd, sessionId });

    try {
      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-b",
        parentPath: "/root",
        metadata: metadata("child-b", "/root/bravo", 1),
        status: "open",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "root-1",
        childThreadId: "child-a",
        parentPath: "/root",
        metadata: metadata("child-a", "/root/alpha", 1),
        status: "open",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "child-a",
        childThreadId: "grandchild-a",
        parentPath: "/root/alpha",
        metadata: metadata("grandchild-a", "/root/alpha/scout", 2),
        status: "open",
      });
      store.upsertThreadSpawnEdge({
        parentThreadId: "child-b",
        childThreadId: "grandchild-b",
        parentPath: "/root/bravo",
        metadata: metadata("grandchild-b", "/root/bravo/worker", 2),
        status: "closed",
      });

      expect(
        store
          .listThreadSpawnDescendantsWithStatus("root-1", "open")
          .map((edge) => edge.childThreadId),
      ).toEqual(["child-a", "child-b", "grandchild-a"]);
    } finally {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { MemoryBackend } from "../memory/types.js";
import { SessionSummaryStore } from "./session-summary-store.js";

function createMemoryBackendStub(): MemoryBackend {
  const kv = new Map<string, unknown>();
  return {
    name: "stub",
    addEntry: async () => {
      throw new Error("not implemented");
    },
    getThread: async () => [],
    query: async () => [],
    deleteThread: async () => 0,
    listSessions: async () => [],
    set: async (key: string, value: unknown) => {
      kv.set(key, value);
    },
    get: async <T = unknown>(key: string) => kv.get(key) as T | undefined,
    delete: async (key: string) => kv.delete(key),
    has: async (key: string) => kv.has(key),
    listKeys: async (prefix?: string) =>
      [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    getDurability: () => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    }),
    flush: async () => {},
    clear: async () => {
      kv.clear();
    },
    close: async () => {},
    healthCheck: async () => true,
  };
}

describe("SessionSummaryStore", () => {
  it("writes, loads, and clears owner-scoped summaries", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-summary-store-"));
    const store = new SessionSummaryStore({ rootDir });

    const ref = await store.compareAndSet({
      ownerKeyHash: "owner-hash-1",
      sessionId: "session-1",
      ownerSessionId: "session-1",
      expectedBoundarySeq: 4,
      expectedTranscriptNextSeq: 9,
      content: "session summary",
    });

    expect(await readFile(ref.path, "utf8")).toBe("session summary");
    expect(await store.load("owner-hash-1", "session-1")).toBe("session summary");

    await store.clear("owner-hash-1", "session-1");
    expect(await store.load("owner-hash-1", "session-1")).toBeUndefined();
  });

  it("garbage-collects orphaned summary directories", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-summary-store-gc-"));
    const memoryBackend = createMemoryBackendStub();
    const sessionStore = {
      loadSession: async (sessionId: string) =>
        sessionId === "kept-session"
          ? ({
              sessionId,
              ownerKey: "owner-1",
              version: 1,
              label: "kept",
              createdAt: 0,
              updatedAt: 0,
              lastActiveAt: 0,
              messageCount: 1,
            } as const)
          : undefined,
    };
    const store = new SessionSummaryStore({
      rootDir,
      memoryBackend,
      sessionStore,
    });

    await store.compareAndSet({
      ownerKeyHash: "owner-hash-1",
      sessionId: "orphan-session",
      ownerSessionId: "orphan-session",
      content: "orphan",
    });
    await store.compareAndSet({
      ownerKeyHash: "owner-hash-1",
      sessionId: "kept-session",
      ownerSessionId: "kept-session",
      content: "kept",
    });

    await store.gcOrphans();

    expect(await store.load("owner-hash-1", "orphan-session")).toBeUndefined();
    expect(await store.load("owner-hash-1", "kept-session")).toBe("kept");
  });
});

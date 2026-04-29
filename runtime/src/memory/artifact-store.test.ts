import { describe, expect, it } from "vitest";

import {
  MemoryArtifactStore,
  type ArtifactCompactionState,
  type ContextArtifactRecord,
} from "./artifact-store.js";
import type {
  AddEntryOptions,
  DurabilityInfo,
  MemoryBackend,
  MemoryEntry,
  MemoryQuery,
} from "./types.js";

class TestMemoryBackend implements MemoryBackend {
  readonly name = "test-memory";
  private readonly kv = new Map<string, unknown>();

  async addEntry(_options: AddEntryOptions): Promise<MemoryEntry> {
    throw new Error("not implemented");
  }

  async getThread(_sessionId: string, _limit?: number): Promise<MemoryEntry[]> {
    return [];
  }

  async query(_query: MemoryQuery): Promise<MemoryEntry[]> {
    return [];
  }

  async deleteThread(_sessionId: string): Promise<number> {
    return 0;
  }

  async listSessions(_prefix?: string): Promise<string[]> {
    return [];
  }

  async set(key: string, value: unknown): Promise<void> {
    this.kv.set(key, value);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.kv.get(key) as T | undefined;
  }

  async delete(key: string): Promise<boolean> {
    return this.kv.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.kv.has(key);
  }

  async listKeys(prefix = ""): Promise<string[]> {
    return [...this.kv.keys()].filter((key) => key.startsWith(prefix));
  }

  getDurability(): DurabilityInfo {
    return {
      level: "none",
      supportsFlush: false,
      description: "test",
    };
  }

  async flush(): Promise<void> {}
  async clear(): Promise<void> {
    this.kv.clear();
  }
  async close(): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

class FailingRecordBackend extends TestMemoryBackend {
  override async set(key: string, value: unknown): Promise<void> {
    if (key === "session-artifacts:record:session-1:b") {
      throw new Error("simulated record write failure");
    }
    await super.set(key, value);
  }
}

function createState(
  artifactIds: readonly string[],
): ArtifactCompactionState {
  return {
    version: 1,
    snapshotId: `snapshot:${artifactIds.join("-")}`,
    sessionId: "session-1",
    createdAt: 1,
    source: "session_compaction",
    historyDigest: "digest",
    sourceMessageCount: 3,
    retainedTailCount: 2,
    openLoops: [],
    artifactRefs: artifactIds.map((id) => ({
      id,
      kind: "tool_result",
      title: id,
      summary: id,
      createdAt: 1,
      digest: id,
      tags: [id],
    })),
  };
}

function createRecord(id: string): ContextArtifactRecord {
  return {
    id,
    sessionId: "session-1",
    kind: "tool_result",
    title: id,
    summary: id,
    content: id,
    createdAt: 1,
    digest: id,
    tags: [id],
    source: "session_compaction",
  };
}

describe("MemoryArtifactStore", () => {
  it("deletes superseded artifact records when a new snapshot replaces them", async () => {
    const backend = new TestMemoryBackend();
    const store = new MemoryArtifactStore(backend);

    await store.persistSnapshot({
      state: createState(["a", "b"]),
      records: [createRecord("a"), createRecord("b")],
    });
    await store.persistSnapshot({
      state: createState(["b", "c"]),
      records: [createRecord("b"), createRecord("c")],
    });

    expect(await backend.has("session-artifacts:record:session-1:a")).toBe(false);
    expect(await backend.has("session-artifacts:record:session-1:b")).toBe(true);
    expect(await backend.has("session-artifacts:record:session-1:c")).toBe(true);
  });

  it("does not publish a snapshot pointer before all records are written", async () => {
    const backend = new FailingRecordBackend();
    const store = new MemoryArtifactStore(backend);

    await expect(
      store.persistSnapshot({
        state: createState(["a", "b"]),
        records: [createRecord("a"), createRecord("b")],
      }),
    ).rejects.toThrow("simulated record write failure");

    expect(await backend.has("session-artifacts:snapshot:session-1")).toBe(false);
  });
});

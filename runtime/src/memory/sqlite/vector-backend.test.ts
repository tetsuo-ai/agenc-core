import { describe, it, expect, afterEach } from "vitest";
import { SqliteVectorBackend } from "./vector-backend.js";

describe("SqliteVectorBackend", () => {
  const backends: SqliteVectorBackend[] = [];

  function create(config?: { dimension?: number }): SqliteVectorBackend {
    const backend = new SqliteVectorBackend({
      dbPath: ":memory:",
      ...config,
    });
    backends.push(backend);
    return backend;
  }

  afterEach(async () => {
    for (const b of backends) {
      await b.close();
    }
    backends.length = 0;
  });

  it("stores and retrieves vectors via cosine similarity", async () => {
    const backend = create();
    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "hello world" },
      [1, 0, 0],
    );
    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "goodbye world" },
      [0, 1, 0],
    );

    const results = await backend.searchSimilar([1, 0, 0], { limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.entry.content).toBe("hello world");
    expect(results[0]!.score).toBeCloseTo(1.0, 5);
    expect(results[1]!.entry.content).toBe("goodbye world");
    expect(results[1]!.score).toBeCloseTo(0.0, 5);
  });

  it("infers dimension from first embedding", async () => {
    const backend = create();
    expect(backend.getVectorDimension()).toBe(0);

    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "test" },
      [1, 2, 3, 4],
    );
    expect(backend.getVectorDimension()).toBe(4);
  });

  it("gracefully handles dimension mismatch (stores entry without vector)", async () => {
    const backend = create({ dimension: 3 });
    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "ok" },
      [1, 0, 0],
    );

    // Phase 1.5: dimension mismatch stores entry but without vector
    // (degrades to keyword-only search for this entry)
    const entry = await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "different dimension" },
      [1, 0, 0, 0],
    );
    expect(entry.content).toBe("different dimension");

    // Entry stored but not in vector search (wrong dimension)
    const results = await backend.searchSimilar([1, 0, 0]);
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.content).toBe("ok");
  });

  it("skips vector storage for empty embeddings (noop provider)", async () => {
    const backend = create();
    const entry = await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "noop" },
      [],
    );
    expect(entry.content).toBe("noop");
    expect(backend.getVectorDimension()).toBe(0);

    // Should not appear in vector search
    const results = await backend.searchSimilar([1, 0, 0]);
    expect(results).toHaveLength(0);
  });

  it("performs hybrid vector + BM25 search", async () => {
    const backend = create();
    await backend.storeWithEmbedding(
      {
        sessionId: "s1",
        role: "assistant",
        content: "python calculator argparse",
        metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
      },
      [1, 0, 0],
    );
    await backend.storeWithEmbedding(
      {
        sessionId: "s1",
        role: "assistant",
        content: "rust linked list implementation",
        metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
      },
      [0, 1, 0],
    );

    const results = await backend.searchHybrid(
      "python calculator",
      [0.9, 0.1, 0],
      { memoryRoles: ["semantic"], limit: 2 },
    );
    expect(results).toHaveLength(2);
    // Python entry should score higher (both vector + keyword match)
    expect(results[0]!.entry.content).toContain("python");
  });

  it("filters by sessionId", async () => {
    const backend = create();
    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "session one" },
      [1, 0, 0],
    );
    await backend.storeWithEmbedding(
      { sessionId: "s2", role: "assistant", content: "session two" },
      [1, 0, 0],
    );

    const results = await backend.searchSimilar([1, 0, 0], {
      sessionId: "s1",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.sessionId).toBe("s1");
  });

  it("filters by time range using after parameter", async () => {
    const backend = create();
    const beforeStore = Date.now();
    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "first entry" },
      [1, 0, 0],
    );
    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "second entry" },
      [0.9, 0.1, 0],
    );

    // All entries are recent — searching with after=0 should find both
    const allResults = await backend.searchSimilar([1, 0, 0], { after: 0 });
    expect(allResults).toHaveLength(2);

    // Searching with after=future should find none
    const futureResults = await backend.searchSimilar([1, 0, 0], {
      after: Date.now() + 100_000,
    });
    expect(futureResults).toHaveLength(0);
  });

  it("filters by memory roles", async () => {
    const backend = create();
    await backend.storeWithEmbedding(
      {
        sessionId: "s1",
        role: "assistant",
        content: "working memory",
        metadata: { memoryRole: "working", memoryRoles: ["working"] },
      },
      [1, 0, 0],
    );
    await backend.storeWithEmbedding(
      {
        sessionId: "s1",
        role: "assistant",
        content: "semantic fact",
        metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
      },
      [1, 0, 0],
    );

    const results = await backend.searchSimilar([1, 0, 0], {
      memoryRoles: ["semantic"],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.content).toBe("semantic fact");
  });

  it("persists vectors across close and reopen", async () => {
    // This is THE critical test for Phase 1
    const tmpPath = `/tmp/agenc-test-vector-persist-${Date.now()}.db`;

    // Store vectors in first instance
    {
      const b = new SqliteVectorBackend({ dbPath: tmpPath });
      await b.storeWithEmbedding(
        {
          sessionId: "s1",
          role: "assistant",
          content: "persisted fact",
          metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
        },
        [1, 0, 0],
      );
      await b.close();
    }

    // Reopen in second instance and search
    const b2 = new SqliteVectorBackend({ dbPath: tmpPath });
    backends.push(b2); // cleanup handles this one
    const loaded = await b2.loadVectors();
    expect(loaded).toBe(1);
    expect(b2.getVectorDimension()).toBe(3);

    const results = await b2.searchSimilar([1, 0, 0]);
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.content).toBe("persisted fact");
    expect(results[0]!.score).toBeCloseTo(1.0, 5);
  });

  it("cleans up vectors on deleteThread", async () => {
    const backend = create();
    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "to delete" },
      [1, 0, 0],
    );

    await backend.deleteThread("s1");
    const results = await backend.searchSimilar([1, 0, 0]);
    expect(results).toHaveLength(0);
  });

  it("clears all vectors on clear()", async () => {
    const backend = create();
    await backend.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "will be cleared" },
      [1, 0, 0],
    );

    await backend.clear();
    expect(backend.getVectorDimension()).toBe(0);
    const results = await backend.searchSimilar([1, 0, 0]);
    expect(results).toHaveLength(0);
  });

  it("reports sync durability", () => {
    const backend = create();
    expect(backend.getDurability().level).toBe("sync");
  });

  it("delegates KV operations to underlying SqliteBackend", async () => {
    const backend = create();
    await backend.set("test-key", { foo: "bar" });
    const value = await backend.get<{ foo: string }>("test-key");
    expect(value).toEqual({ foo: "bar" });
  });
});

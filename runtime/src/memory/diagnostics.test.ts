import { describe, it, expect, vi } from "vitest";
import { collectMemoryHealthReport, formatMemoryHealthReport } from "./diagnostics.js";
import { InMemoryBackend } from "./in-memory/backend.js";
import { InMemoryVectorStore } from "./vector-store.js";
import { NoopEmbeddingProvider } from "./embeddings.js";
import { MemoryGraph } from "./graph.js";

describe("collectMemoryHealthReport", () => {
  it("collects health from all components", async () => {
    const backend = new InMemoryBackend();
    await backend.addEntry({ sessionId: "s1", role: "user", content: "hello" });

    const vectorStore = new InMemoryVectorStore({ dimension: 128 });
    const embeddingProvider = new NoopEmbeddingProvider(128);
    const graph = new MemoryGraph(new InMemoryBackend());

    const report = await collectMemoryHealthReport({
      memoryBackend: backend,
      vectorStore,
      embeddingProvider,
      graph,
    });

    expect(report.healthy).toBe(true);
    expect(report.backendType).toBe("in-memory");
    expect(report.durability).toBe("none");
    expect(report.sessionCount).toBeGreaterThanOrEqual(1);
    expect(report.vectorStore).not.toBeNull();
    expect(report.vectorStore!.dimension).toBe(128);
    expect(report.embeddingProvider).not.toBeNull();
    expect(report.embeddingProvider!.name).toBe("noop");
    expect(report.embeddingProvider!.available).toBe(true);
    expect(report.knowledgeGraph).not.toBeNull();
    expect(report.knowledgeGraph!.nodeCount).toBe(0);
  });

  it("handles missing components gracefully", async () => {
    const report = await collectMemoryHealthReport({});

    expect(report.healthy).toBe(false);
    expect(report.backendType).toBe("none");
    expect(report.vectorStore).toBeNull();
    expect(report.embeddingProvider).toBeNull();
    expect(report.knowledgeGraph).toBeNull();
  });

  it("handles backend failure gracefully", async () => {
    const backend = new InMemoryBackend();
    vi.spyOn(backend, "healthCheck").mockRejectedValueOnce(new Error("fail"));

    const report = await collectMemoryHealthReport({ memoryBackend: backend });
    expect(report.healthy).toBe(false);
  });
});

describe("formatMemoryHealthReport", () => {
  it("formats a complete report", () => {
    const formatted = formatMemoryHealthReport({
      backendType: "sqlite-vector",
      durability: "sync",
      entryCount: 1500,
      sessionCount: 42,
      vectorStore: { dimension: 1536, entryCount: 1000, persistent: true },
      embeddingProvider: { name: "openai", dimension: 1536, available: true },
      knowledgeGraph: { nodeCount: 150, edgeCount: 320 },
      healthy: true,
    });

    expect(formatted).toContain("## Memory System Health");
    expect(formatted).toContain("sqlite-vector");
    expect(formatted).toContain("healthy");
    expect(formatted).toContain("1536");
    expect(formatted).toContain("SQLite");
    expect(formatted).toContain("150");
    expect(formatted).toContain("320");
  });

  it("formats minimal report", () => {
    const formatted = formatMemoryHealthReport({
      backendType: "none",
      durability: "none",
      entryCount: 0,
      sessionCount: 0,
      vectorStore: null,
      embeddingProvider: null,
      knowledgeGraph: null,
      healthy: false,
    });

    expect(formatted).toContain("unhealthy");
    expect(formatted).not.toContain("Vector Store");
  });
});

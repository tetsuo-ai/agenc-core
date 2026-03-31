import { describe, it, expect, vi } from "vitest";
import { MemoryTraceLogger, createNoopMemoryTraceLogger } from "./trace-logger.js";

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("MemoryTraceLogger", () => {
  it("emits retrieval trace events", () => {
    const logger = createMockLogger();
    const tracer = new MemoryTraceLogger(logger as any);

    tracer.traceRetrieval({
      sessionId: "s1",
      query: "test query",
      candidateCount: 20,
      selectedCount: 5,
      estimatedTokens: 500,
      roles: { working: 2, semantic: 3 },
      workspaceId: "ws1",
      durationMs: 45,
    });

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug.mock.calls[0][0]).toContain("memory.retrieval");
    expect(logger.debug.mock.calls[0][0]).toContain("session=s1");
    expect(logger.debug.mock.calls[0][0]).toContain("ws=ws1");
  });

  it("emits scoring trace events", () => {
    const logger = createMockLogger();
    const tracer = new MemoryTraceLogger(logger as any);

    tracer.traceScoring({
      sessionId: "s1",
      entryId: "e1",
      role: "semantic",
      relevanceScore: 0.85,
      recencyScore: 0.7,
      activationBoost: 0.3,
      trustScore: 0.9,
      combinedScore: 0.72,
      included: true,
    });

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug.mock.calls[0][0]).toContain("memory.retrieval.scoring");
  });

  it("emits ingestion trace events", () => {
    const logger = createMockLogger();
    const tracer = new MemoryTraceLogger(logger as any);

    tracer.traceIngestion({
      sessionId: "s1",
      workspaceId: "ws1",
      indexed: true,
      salienceScore: 0.65,
      duplicate: false,
    });

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug.mock.calls[0][0]).toContain("memory.ingestion.turn");
  });

  it("emits consolidation trace events", () => {
    const logger = createMockLogger();
    const tracer = new MemoryTraceLogger(logger as any);

    tracer.traceConsolidation({
      workspaceId: "ws1",
      episodicBefore: 50,
      semanticAfter: 10,
      clustersFound: 5,
      factsCreated: 3,
      durationMs: 200,
    });

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug.mock.calls[0][0]).toContain("memory.consolidation");
  });

  it("emits trust filter trace events", () => {
    const logger = createMockLogger();
    const tracer = new MemoryTraceLogger(logger as any);

    tracer.traceTrustFilter({
      entryId: "e1",
      trustScore: 0.2,
      threshold: 0.3,
      excluded: true,
      source: "external",
    });

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug.mock.calls[0][0]).toContain("memory.trust.filter");
  });

  it("emits error trace events", () => {
    const logger = createMockLogger();
    const tracer = new MemoryTraceLogger(logger as any);

    tracer.traceError({
      operation: "ingestion",
      error: "embedding failed",
      sessionId: "s1",
    });

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.debug.mock.calls[0][0]).toContain("memory.error");
  });

  it("does not emit when disabled", () => {
    const logger = createMockLogger();
    const tracer = new MemoryTraceLogger(logger as any, false);

    tracer.traceRetrieval({
      sessionId: "s1",
      query: "test",
      candidateCount: 0,
      selectedCount: 0,
      estimatedTokens: 0,
      roles: {},
      durationMs: 0,
    });

    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("createNoopMemoryTraceLogger creates a disabled logger", () => {
    const noop = createNoopMemoryTraceLogger();
    // Should not throw
    noop.traceRetrieval({
      sessionId: "s1",
      query: "test",
      candidateCount: 0,
      selectedCount: 0,
      estimatedTokens: 0,
      roles: {},
      durationMs: 0,
    });
  });

  it("truncates long queries in retrieval traces", () => {
    const logger = createMockLogger();
    const tracer = new MemoryTraceLogger(logger as any);

    const longQuery = "a".repeat(500);
    tracer.traceRetrieval({
      sessionId: "s1",
      query: longQuery,
      candidateCount: 0,
      selectedCount: 0,
      estimatedTokens: 0,
      roles: {},
      durationMs: 0,
    });

    const loggedPayload = logger.debug.mock.calls[0][0];
    // Query should be truncated to 200 chars
    expect(loggedPayload.length).toBeLessThan(600);
  });
});

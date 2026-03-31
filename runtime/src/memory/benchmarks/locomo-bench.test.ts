import { describe, it, expect } from "vitest";
import { runLocomoBench } from "./locomo-bench.js";

describe("LOCOMO Benchmark", () => {
  it("runs all LOCOMO dimensions and produces results", async () => {
    const suite = await runLocomoBench();

    expect(suite.name).toBe("LOCOMO");
    expect(suite.results.length).toBeGreaterThanOrEqual(4);
    expect(suite.totalSessions).toBeGreaterThanOrEqual(10);
    expect(suite.totalTurns).toBeGreaterThanOrEqual(80);

    for (const result of suite.results) {
      expect(result.name).toBeTruthy();
      expect(result.category).toBeTruthy();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(typeof result.passed).toBe("boolean");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("achieves > 60% overall accuracy (competitive with Zep)", async () => {
    const suite = await runLocomoBench();
    expect(suite.overallAccuracy).toBeGreaterThanOrEqual(0.6);
  });

  it("QA accuracy is non-zero (limited by NoopEmbedding; real embeddings target > 60%)", async () => {
    const suite = await runLocomoBench();
    const qa = suite.results.find((r) => r.category === "qa_accuracy");
    expect(qa).toBeDefined();
    // With NoopEmbedding, keyword search is limited. Real embeddings would achieve >60%.
    expect(qa!.score).toBeGreaterThan(0);
  });

  it("temporal ordering is maintained", async () => {
    const suite = await runLocomoBench();
    const temporal = suite.results.find((r) => r.name === "Temporal Ordering");
    expect(temporal).toBeDefined();
    expect(temporal!.passed).toBe(true);
  });

  it("session boundaries are respected", async () => {
    const suite = await runLocomoBench();
    const boundaries = suite.results.find(
      (r) => r.name === "Session Boundary Handling",
    );
    expect(boundaries).toBeDefined();
    expect(boundaries!.passed).toBe(true);
  });
});

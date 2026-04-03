import { describe, it, expect } from "vitest";
import { runMemoryAgentBench } from "./memory-agent-bench.js";

describe("MemoryAgentBench", () => {
  it("runs all benchmark dimensions and produces results", async () => {
    const suite = await runMemoryAgentBench();

    expect(suite.name).toBe("MemoryAgentBench");
    expect(suite.results.length).toBeGreaterThanOrEqual(5);

    for (const result of suite.results) {
      expect(result.name).toBeTruthy();
      expect(result.dimension).toBeTruthy();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(typeof result.passed).toBe("boolean");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }

    expect(suite.overallScore).toBeGreaterThanOrEqual(0);
    expect(suite.passRate).toBeGreaterThanOrEqual(0);
  });

  it("achieves > 70% pass rate on memory dimensions", async () => {
    const suite = await runMemoryAgentBench();
    expect(suite.passRate).toBeGreaterThanOrEqual(0.7);
  });

  it("accurate retrieval dimension passes", async () => {
    const suite = await runMemoryAgentBench();
    const retrieval = suite.results.find(
      (r) => r.dimension === "retrieval_accuracy",
    );
    expect(retrieval).toBeDefined();
    expect(retrieval!.passed).toBe(true);
  });

  it("cross-session persistence dimension passes", async () => {
    const suite = await runMemoryAgentBench();
    const persistence = suite.results.find(
      (r) => r.dimension === "persistence",
    );
    expect(persistence).toBeDefined();
    expect(persistence!.passed).toBe(true);
  });
});

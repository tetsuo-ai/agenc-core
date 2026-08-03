import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_SCHEDULER_BENCHMARK_ELAPSED_MS,
  runWorkflowScheduler1024Benchmark,
  WORKFLOW_SCHEDULER_BENCHMARK_FAN_IN,
} from "../../benchmarks/workflow-scheduler-1024.js";
import { MAX_WORKFLOW_STEPS } from "../../src/agents/workflow-manifest-schema.js";
import { MAX_WORKFLOW_STEP_PREVIEW_BYTES } from "../../src/agents/workflow-handoff-schema.js";
import { allocateFairWorkflowGroupPreviews } from "../../src/agents/workflow-scheduler.js";

describe("1,024-step workflow scheduler benchmark", () => {
  it("keeps graph validation visits proportional to V + E", () => {
    const { half, full } = runWorkflowScheduler1024Benchmark();

    expect(half.nodeCount).toBe(MAX_WORKFLOW_STEPS / 2);
    expect(full.nodeCount).toBe(MAX_WORKFLOW_STEPS);
    expect(full.edgeCount).toBe(expectedEdgeCount(MAX_WORKFLOW_STEPS));
    expect(full.operationCounts).toEqual({
      nodeVisits: full.nodeCount,
      referenceVisits: full.edgeCount,
      expandedEdgeVisits: full.edgeCount,
      kahnEdgeVisits: full.edgeCount,
    });
    expect(full.elapsedMs).toBeLessThanOrEqual(
      MAX_WORKFLOW_SCHEDULER_BENCHMARK_ELAPSED_MS,
    );

    const workRatio =
      (full.nodeCount + full.edgeCount) / (half.nodeCount + half.edgeCount);
    expect(workRatio).toBeGreaterThan(1.9);
    expect(workRatio).toBeLessThan(2.2);
  });

  it("uses cursor FIFO operations rather than array-front removal or insertion", () => {
    const source = readFileSync(
      new URL("../../src/agents/workflow-scheduler.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("readyCursor += 1");
    expect(source).not.toMatch(/\bready\.(?:shift|unshift|splice)\s*\(/u);
  });

  it("allocates 1,024 maximum previews in linear work and bounded RSS", () => {
    const rssBefore = process.memoryUsage().rss;
    const values = Array.from(
      { length: MAX_WORKFLOW_STEPS },
      (_, ordinal) =>
        String(ordinal % 10).repeat(MAX_WORKFLOW_STEP_PREVIEW_BYTES),
    );
    const startedAt = performance.now();
    const allocation = allocateFairWorkflowGroupPreviews(
      values,
      MAX_WORKFLOW_STEP_PREVIEW_BYTES,
    );
    const elapsedMs = performance.now() - startedAt;
    const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - rssBefore);

    expect(allocation.operationCounts.demandCodePointVisits).toBe(
      MAX_WORKFLOW_STEPS * MAX_WORKFLOW_STEP_PREVIEW_BYTES,
    );
    expect(
      allocation.operationCounts.allocationCodePointVisits,
    ).toBeLessThanOrEqual(
      allocation.operationCounts.retainedCodePointChunks + MAX_WORKFLOW_STEPS,
    );
    expect(allocation.operationCounts.retainedCodePointChunks).toBeLessThanOrEqual(
      MAX_WORKFLOW_STEP_PREVIEW_BYTES,
    );
    expect(allocation.previews.every((preview) => preview.length > 0)).toBe(
      true,
    );
    expect(elapsedMs).toBeLessThanOrEqual(
      MAX_WORKFLOW_SCHEDULER_BENCHMARK_ELAPSED_MS,
    );
    expect(rssGrowthBytes).toBeLessThanOrEqual(128 * 1_024 * 1_024);
  });
});

function expectedEdgeCount(nodeCount: number): number {
  let edges = 0;
  for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
    edges += Math.min(ordinal, WORKFLOW_SCHEDULER_BENCHMARK_FAN_IN);
  }
  return edges;
}

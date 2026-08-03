import { pathToFileURL } from "node:url";

import {
  compileWorkflowGraph,
  type WorkflowGraphOperationCounts,
} from "../src/agents/workflow-graph.js";
import {
  MAX_WORKFLOW_EXPANDED_EDGES,
  MAX_WORKFLOW_STEPS,
  type WorkflowDagManifestV2,
  type WorkflowStepV2,
} from "../src/agents/workflow-manifest-schema.js";

export const WORKFLOW_SCHEDULER_BENCHMARK_FAN_IN = 64;
export const MAX_WORKFLOW_SCHEDULER_BENCHMARK_ELAPSED_MS = 5_000;

export interface WorkflowSchedulerBenchmarkSample {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly elapsedMs: number;
  readonly operationCounts: WorkflowGraphOperationCounts;
}

export interface WorkflowScheduler1024BenchmarkResult {
  readonly half: WorkflowSchedulerBenchmarkSample;
  readonly full: WorkflowSchedulerBenchmarkSample;
}

/**
 * Exercise stable Kahn compilation near the expanded-edge ceiling. The explicit
 * counters make an accidental transitive walk fail independently of wall time.
 */
export function runWorkflowScheduler1024Benchmark(): WorkflowScheduler1024BenchmarkResult {
  const half = compileSample(MAX_WORKFLOW_STEPS / 2);
  const full = compileSample(MAX_WORKFLOW_STEPS);
  assertLinearVisitAccounting(half);
  assertLinearVisitAccounting(full);
  if (half.elapsedMs > MAX_WORKFLOW_SCHEDULER_BENCHMARK_ELAPSED_MS) {
    throw new Error("half workflow scheduler benchmark exceeded its time bound");
  }
  if (full.elapsedMs > MAX_WORKFLOW_SCHEDULER_BENCHMARK_ELAPSED_MS) {
    throw new Error("full workflow scheduler benchmark exceeded its time bound");
  }
  return Object.freeze({ half, full });
}

function compileSample(nodeCount: number): WorkflowSchedulerBenchmarkSample {
  const steps: WorkflowStepV2[] = Array.from(
    { length: nodeCount },
    (_, ordinal) => ({
      id: `step-${ordinal}`,
      message: `bounded work item ${ordinal}`,
      ...(ordinal === 0
        ? {}
        : {
            after: Array.from(
              {
                length: Math.min(ordinal, WORKFLOW_SCHEDULER_BENCHMARK_FAN_IN),
              },
              (_, offset) => ({ step: `step-${ordinal - offset - 1}` }),
            ),
          }),
    }),
  );
  const manifest: WorkflowDagManifestV2 = {
    format_version: 2,
    kind: "agent_dag",
    steps,
  };
  const startedAt = performance.now();
  const graph = compileWorkflowGraph(manifest, {
    maximumExpandedEdges: MAX_WORKFLOW_EXPANDED_EDGES,
  });
  const elapsedMs = performance.now() - startedAt;
  return Object.freeze({
    nodeCount: graph.nodes.length,
    edgeCount: graph.edgeCount,
    elapsedMs,
    operationCounts: graph.operationCounts,
  });
}

function assertLinearVisitAccounting(
  sample: WorkflowSchedulerBenchmarkSample,
): void {
  const { operationCounts } = sample;
  if (operationCounts.nodeVisits !== sample.nodeCount) {
    throw new Error("workflow compiler did not visit every node exactly once");
  }
  if (
    operationCounts.referenceVisits !== sample.edgeCount ||
    operationCounts.expandedEdgeVisits !== sample.edgeCount ||
    operationCounts.kahnEdgeVisits !== sample.edgeCount
  ) {
    throw new Error("workflow compiler did not visit every edge exactly once per phase");
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stdout.write(
    `${JSON.stringify(runWorkflowScheduler1024Benchmark())}\n`,
  );
}

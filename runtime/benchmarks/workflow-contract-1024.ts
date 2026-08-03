import { pathToFileURL } from "node:url";

import {
  MAX_WORKFLOW_JSON_NODES,
  MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES,
  MAX_WORKFLOW_STEPS,
  validateWorkflowManifestValue,
} from "../src/agents/workflow-manifest-schema.js";
import {
  MAX_WORKFLOW_FINAL_RESPONSE_BYTES,
  MAX_WORKFLOW_STEP_PREVIEW_BYTES,
} from "../src/agents/workflow-handoff-schema.js";

export const MAX_WORKFLOW_CONTRACT_BENCHMARK_RSS_DELTA_BYTES = 67_108_864;
export const MAX_WORKFLOW_CONTRACT_BENCHMARK_ELAPSED_MS = 5_000;

export interface WorkflowContractBenchmarkResult {
  readonly stepCount: number;
  readonly maximumJsonNodes: number;
  readonly maximumAggregateStringUtf8Bytes: number;
  readonly elapsedMs: number;
  readonly rssDeltaBytes: number;
  readonly maximumAggregatePreviewBytes: number;
  readonly finalResponseBytes: number;
  readonly manifestDigest: string;
}

export function runWorkflowContract1024Benchmark(): WorkflowContractBenchmarkResult {
  const steps = Array.from({ length: MAX_WORKFLOW_STEPS }, (_, index) => ({
    id: `step-${index}`,
    message: `bounded work item ${index}`,
    ...(index === 0 ? {} : { after: [{ step: `step-${index - 1}` }] }),
  }));
  const beforeRss = process.memoryUsage.rss();
  const startedAt = performance.now();
  const document = validateWorkflowManifestValue({
    format_version: 2,
    kind: "agent_dag",
    max_concurrency: 16,
    max_handoff_tokens: 8_192,
    steps,
  });
  const elapsedMs = performance.now() - startedAt;
  const rssDeltaBytes = Math.max(0, process.memoryUsage.rss() - beforeRss);
  const maximumAggregatePreviewBytes =
    MAX_WORKFLOW_STEPS * MAX_WORKFLOW_STEP_PREVIEW_BYTES;
  const finalResponse = JSON.stringify({
    workflow: "benchmark-1024",
    steps: steps.map((step) => ({
      id: step.id,
      status: "handoff_committed",
      digest: `sha256:${"0".repeat(64)}`,
      byte_length: MAX_WORKFLOW_STEP_PREVIEW_BYTES,
      token_count: 512,
    })),
  });
  const finalResponseBytes = Buffer.byteLength(finalResponse, "utf8");

  if (document.kind !== "agent_dag") {
    throw new Error("workflow contract benchmark normalized to the wrong kind");
  }
  if (elapsedMs > MAX_WORKFLOW_CONTRACT_BENCHMARK_ELAPSED_MS) {
    throw new Error(
      `workflow contract benchmark exceeded ${MAX_WORKFLOW_CONTRACT_BENCHMARK_ELAPSED_MS}ms`,
    );
  }
  if (rssDeltaBytes > MAX_WORKFLOW_CONTRACT_BENCHMARK_RSS_DELTA_BYTES) {
    throw new Error(
      `workflow contract benchmark exceeded ${MAX_WORKFLOW_CONTRACT_BENCHMARK_RSS_DELTA_BYTES} RSS bytes`,
    );
  }
  if (finalResponseBytes > MAX_WORKFLOW_FINAL_RESPONSE_BYTES) {
    throw new Error(
      `workflow contract benchmark exceeded ${MAX_WORKFLOW_FINAL_RESPONSE_BYTES} response bytes`,
    );
  }

  return Object.freeze({
    stepCount: document.manifest.steps.length,
    maximumJsonNodes: MAX_WORKFLOW_JSON_NODES,
    maximumAggregateStringUtf8Bytes: MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES,
    elapsedMs,
    rssDeltaBytes,
    maximumAggregatePreviewBytes,
    finalResponseBytes,
    manifestDigest: document.manifestDigest,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stdout.write(
    `${JSON.stringify(runWorkflowContract1024Benchmark())}\n`,
  );
}

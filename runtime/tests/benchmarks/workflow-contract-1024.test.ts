import { describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_CONTRACT_BENCHMARK_ELAPSED_MS,
  MAX_WORKFLOW_CONTRACT_BENCHMARK_RSS_DELTA_BYTES,
  runWorkflowContract1024Benchmark,
} from "../../benchmarks/workflow-contract-1024.js";
import {
  MAX_WORKFLOW_JSON_NODES,
  MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES,
  MAX_WORKFLOW_STEPS,
} from "../../src/agents/workflow-manifest-schema.js";
import {
  MAX_WORKFLOW_FINAL_RESPONSE_BYTES,
  MAX_WORKFLOW_STEP_PREVIEW_BYTES,
} from "../../src/agents/workflow-handoff-schema.js";

describe("1,024-step workflow contract benchmark", () => {
  it("stays within validation RSS, time, preview, and response bounds", () => {
    const result = runWorkflowContract1024Benchmark();

    expect(result.stepCount).toBe(MAX_WORKFLOW_STEPS);
    expect(result.maximumJsonNodes).toBe(MAX_WORKFLOW_JSON_NODES);
    expect(result.maximumJsonNodes).toBe(100_000);
    expect(result.maximumAggregateStringUtf8Bytes).toBe(
      MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES,
    );
    expect(result.maximumAggregateStringUtf8Bytes).toBe(8_388_608);
    expect(result.elapsedMs).toBeLessThanOrEqual(
      MAX_WORKFLOW_CONTRACT_BENCHMARK_ELAPSED_MS,
    );
    expect(result.rssDeltaBytes).toBeLessThanOrEqual(
      MAX_WORKFLOW_CONTRACT_BENCHMARK_RSS_DELTA_BYTES,
    );
    expect(result.maximumAggregatePreviewBytes).toBe(
      MAX_WORKFLOW_STEPS * MAX_WORKFLOW_STEP_PREVIEW_BYTES,
    );
    expect(result.finalResponseBytes).toBeLessThanOrEqual(
      MAX_WORKFLOW_FINAL_RESPONSE_BYTES,
    );
    expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

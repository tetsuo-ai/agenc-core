import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MAX_WORKFLOW_FINAL_RESPONSE_BYTES } from "../../src/agents/workflow-handoff-schema.js";
import {
  DEFAULT_WORKFLOW_MAX_CONCURRENCY,
  DEFAULT_WORKFLOW_MAX_HANDOFF_TOKENS,
  MAX_WORKFLOW_HANDOFF_TOKENS,
  MAX_WORKFLOW_MAX_CONCURRENCY,
} from "../../src/agents/workflow-manifest-schema.js";
import {
  WORKFLOW_CANCELLATION_CAUSES,
  WORKFLOW_RESULT_VERSION,
  WORKFLOW_RUN_OUTCOMES_V2,
  WORKFLOW_STEP_OUTCOMES_V2,
  type WorkflowRunResultV2 as RuntimeWorkflowRunResultV2,
} from "../../src/agents/workflow-result.js";
import { WorkflowRunResultV2Schema } from "../../src/entrypoints/sdk/coreSchemas.js";
import {
  AGENC_DEFAULT_WORKFLOW_MAX_CONCURRENCY,
  AGENC_DEFAULT_WORKFLOW_MAX_HANDOFF_TOKENS,
  AGENC_MAX_WORKFLOW_FINAL_RESPONSE_BYTES,
  AGENC_MAX_WORKFLOW_HANDOFF_TOKENS,
  AGENC_MAX_WORKFLOW_MAX_CONCURRENCY,
  AGENC_WORKFLOW_CANCELLATION_CAUSES,
  AGENC_WORKFLOW_RESULT_VERSION,
  AGENC_WORKFLOW_RUN_OUTCOMES_V2,
  AGENC_WORKFLOW_STEP_OUTCOMES_V2,
  type WorkflowRunResultV2 as PackageWorkflowRunResultV2,
} from "../../../packages/agenc-sdk/src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const generatedTypesCheckPath = resolve(
  testDirectory,
  "../../scripts/check-sdk-generated-types.mjs",
);

const result = Object.freeze({
  workflow_result_version: 2,
  run_id: "run",
  workflow_id: "workflow",
  manifest_format_version: 2,
  manifest_digest: `sha256:${"0".repeat(64)}`,
  outcome: "completed",
  effective_limits: {
    max_concurrency: 16,
    max_handoff_tokens: 8_192,
    failure_policy: "continue_independent",
  },
  steps: [
    {
      id: "step",
      ordinal: 0,
      outcome: "succeeded",
      handoff: {
        artifact_id: `wh_${"0".repeat(48)}`,
        storage_ref: `workflow-handoff:wh_${"0".repeat(48)}`,
        digest: `sha256:${"0".repeat(64)}`,
        byte_length: 4,
        token_count: 1,
        preview: "done",
        preview_truncated: false,
      },
    },
  ],
  groups: [],
  operation_counts: {
    node_transitions: 1,
    edge_consumptions: 0,
    ready_enqueues: 1,
    ready_dequeues: 1,
    launches: 1,
  },
} as const satisfies RuntimeWorkflowRunResultV2 & PackageWorkflowRunResultV2);

describe("public workflow result contract", () => {
  it("keeps runtime, generated schemas, and package SDK unions aligned", () => {
    expect(AGENC_WORKFLOW_RESULT_VERSION).toBe(WORKFLOW_RESULT_VERSION);
    expect(AGENC_WORKFLOW_STEP_OUTCOMES_V2).toEqual(
      WORKFLOW_STEP_OUTCOMES_V2,
    );
    expect(AGENC_WORKFLOW_RUN_OUTCOMES_V2).toEqual(WORKFLOW_RUN_OUTCOMES_V2);
    expect(AGENC_WORKFLOW_CANCELLATION_CAUSES).toEqual(
      WORKFLOW_CANCELLATION_CAUSES,
    );
    expect(WorkflowRunResultV2Schema().parse(result)).toEqual(result);
  });

  it("rejects legacy or internal scheduler states on version-2 fields", () => {
    for (const legacyOutcome of [
      "completed",
      "errored",
      "interrupted",
      "aborted",
      "skipped",
      "queued",
      "running",
    ]) {
      expect(() =>
        WorkflowRunResultV2Schema().parse({
          ...result,
          steps: [{ ...result.steps[0], outcome: legacyOutcome }],
        }),
      ).toThrow();
    }
    expect(() =>
      WorkflowRunResultV2Schema().parse({
        ...result,
        workflow_result_version: 1,
      }),
    ).toThrow();
  });

  it("keeps published limit constants aligned with the runtime authorities", () => {
    expect(AGENC_DEFAULT_WORKFLOW_MAX_CONCURRENCY).toBe(
      DEFAULT_WORKFLOW_MAX_CONCURRENCY,
    );
    expect(AGENC_MAX_WORKFLOW_MAX_CONCURRENCY).toBe(
      MAX_WORKFLOW_MAX_CONCURRENCY,
    );
    expect(AGENC_DEFAULT_WORKFLOW_MAX_HANDOFF_TOKENS).toBe(
      DEFAULT_WORKFLOW_MAX_HANDOFF_TOKENS,
    );
    expect(AGENC_MAX_WORKFLOW_HANDOFF_TOKENS).toBe(MAX_WORKFLOW_HANDOFF_TOKENS);
    expect(AGENC_MAX_WORKFLOW_FINAL_RESPONSE_BYTES).toBe(
      MAX_WORKFLOW_FINAL_RESPONSE_BYTES,
    );
  });

  it("keeps the generated-type check marker-only for the public result file", () => {
    const checkSource = readFileSync(generatedTypesCheckPath, "utf8");

    expect(checkSource).toContain(
      "../packages/agenc-sdk/src/workflow-result.generated.ts",
    );
    expect(checkSource).not.toContain(
      "../packages/agenc-sdk/src/workflow-handoff.generated.ts",
    );
    expect(checkSource).not.toMatch(/renderWorkflowResultGenerated/u);
    expect(checkSource).toContain(
      "export const AGENC_WORKFLOW_RESULT_VERSION = 2 as const",
    );
    expect(checkSource).toContain(
      "export const AGENC_WORKFLOW_STEP_OUTCOMES_V2",
    );
    expect(checkSource).toContain("export const AGENC_WORKFLOW_RUN_OUTCOMES_V2");
    expect(checkSource).toContain("export interface WorkflowRunResultV2");
    expect(checkSource).toContain('"blocked_dependency_unknown"');
    expect(checkSource).toContain('"unknown_outcome"');
    expect(checkSource).toMatch(
      /packageWorkflowResult\.includes\(marker\)/u,
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_EXPANDED_EDGES,
  MAX_WORKFLOW_GROUPS,
  MAX_WORKFLOW_HANDOFF_TOKENS,
  MAX_WORKFLOW_INPUT_ALIASES_PER_STEP,
  MAX_WORKFLOW_INPUT_ALIASES_TOTAL,
  MAX_WORKFLOW_JSON_NODES,
  MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES,
  MAX_WORKFLOW_MAX_CONCURRENCY,
  MAX_WORKFLOW_STEP_MESSAGE_BYTES,
  MAX_WORKFLOW_STEPS,
  MAX_WORKFLOW_TOTAL_MESSAGE_BYTES,
  validateWorkflowManifestValue,
  WorkflowManifestValidationError,
  type WorkflowRef,
} from "../../src/agents/workflow-manifest-schema.js";
import {
  MAX_WORKFLOW_NAME_CODEPOINTS,
  MAX_WORKFLOW_NAME_UTF8_BYTES,
  validateWorkflowName,
} from "../../src/agents/workflow-manifest.js";
import { validateWorkflowInvocationValue } from "../../src/agents/workflow-invocation.js";

function manifest(
  steps: readonly unknown[],
  limits: Record<string, unknown> = {},
) {
  return validateWorkflowManifestValue({
    format_version: 2,
    kind: "agent_dag",
    ...limits,
    steps,
  });
}

function aliases(
  count: number,
  reference: WorkflowRef = { step: "root" },
): Record<string, WorkflowRef> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `input_${index}`,
      "step" in reference
        ? { step: reference.step }
        : { group: reference.group },
    ]),
  );
}

describe("workflow manifest named boundaries", () => {
  it("freezes the finite-tree and aggregate-string ingestion ceilings", () => {
    expect(MAX_WORKFLOW_JSON_NODES).toBe(100_000);
    expect(MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES).toBe(8_388_608);
  });

  it("accepts exact concurrency and handoff ceilings and rejects plus one", () => {
    const steps = [{ id: "root", message: "root" }];
    expect(
      manifest(steps, {
        max_concurrency: MAX_WORKFLOW_MAX_CONCURRENCY,
        max_handoff_tokens: MAX_WORKFLOW_HANDOFF_TOKENS,
      }),
    ).toMatchObject({ manifest: { kind: "agent_dag" } });
    expect(() =>
      manifest(steps, { max_concurrency: MAX_WORKFLOW_MAX_CONCURRENCY + 1 }),
    ).toThrow();
    expect(() =>
      manifest(steps, { max_handoff_tokens: MAX_WORKFLOW_HANDOFF_TOKENS + 1 }),
    ).toThrow(WorkflowManifestValidationError);
    expect(() =>
      validateWorkflowInvocationValue({
        name: "bounded",
        args: {
          max_concurrency: MAX_WORKFLOW_MAX_CONCURRENCY,
          max_handoff_tokens: MAX_WORKFLOW_HANDOFF_TOKENS,
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkflowInvocationValue({
        name: "bounded",
        args: { max_handoff_tokens: MAX_WORKFLOW_HANDOFF_TOKENS + 1 },
      }),
    ).toThrow();
  });

  it("accepts the exact per-step message ceiling", () => {
    expect(() =>
      manifest([
        { id: "exact", message: "x".repeat(MAX_WORKFLOW_STEP_MESSAGE_BYTES) },
      ]),
    ).not.toThrow();
    expect(() =>
      manifest([
        {
          id: "plus-one",
          message: "x".repeat(MAX_WORKFLOW_STEP_MESSAGE_BYTES + 1),
        },
      ]),
    ).toThrow();
  });

  it("keeps the message ceiling subordinate to the whole-document string budget", () => {
    expect(MAX_WORKFLOW_TOTAL_MESSAGE_BYTES).toBe(
      MAX_WORKFLOW_JSON_TOTAL_STRING_UTF8_BYTES,
    );
    const fullMessages =
      MAX_WORKFLOW_TOTAL_MESSAGE_BYTES / MAX_WORKFLOW_STEP_MESSAGE_BYTES;
    const exactMessagePayload = Array.from(
      { length: fullMessages },
      (_, index) => ({
        id: `message-${index}`,
        message: "x".repeat(MAX_WORKFLOW_STEP_MESSAGE_BYTES),
      }),
    );

    // Object keys, step ids, and schema discriminants share the frozen 8 MiB
    // aggregate-string budget. The nominal message cap is therefore an upper
    // bound, not permission to add 8 MiB of messages plus metadata.
    expect(() => manifest(exactMessagePayload)).toThrow(
      /aggregate string UTF-8 bytes/u,
    );
  });

  it("accepts exactly 256 groups and rejects 257", () => {
    const exact = Array.from({ length: MAX_WORKFLOW_GROUPS }, (_, index) => ({
      id: `step-${index}`,
      group: `group-${index}`,
      message: "bounded",
    }));
    expect(() => manifest(exact)).not.toThrow();
    expect(() =>
      manifest([
        ...exact,
        {
          id: "group-plus-one",
          group: `group-${MAX_WORKFLOW_GROUPS}`,
          message: "bounded",
        },
      ]),
    ).toThrow(WorkflowManifestValidationError);
  });

  it("accepts 256 aliases per step and rejects 257", () => {
    expect(() =>
      manifest([
        { id: "root", message: "root" },
        {
          id: "consumer",
          message: "consumer",
          inputs: aliases(MAX_WORKFLOW_INPUT_ALIASES_PER_STEP),
        },
      ]),
    ).not.toThrow();
    expect(() =>
      manifest([
        { id: "root", message: "root" },
        {
          id: "consumer",
          message: "consumer",
          inputs: aliases(MAX_WORKFLOW_INPUT_ALIASES_PER_STEP + 1),
        },
      ]),
    ).toThrow(WorkflowManifestValidationError);
  });

  it("keeps the alias ceiling subordinate to the finite-tree node budget", () => {
    expect(MAX_WORKFLOW_INPUT_ALIASES_TOTAL).toBe(65_536);
    const fullSteps =
      MAX_WORKFLOW_INPUT_ALIASES_TOTAL / MAX_WORKFLOW_INPUT_ALIASES_PER_STEP;
    const exactConsumers = Array.from({ length: fullSteps }, (_, index) => ({
      id: `consumer-${index}`,
      message: "consumer",
      inputs: aliases(MAX_WORKFLOW_INPUT_ALIASES_PER_STEP),
    }));
    // Each alias contains a reference object and a string value. The frozen
    // 100,000-node whole-document ceiling rejects this adversarial shape before
    // it reaches the independent semantic alias ceiling.
    expect(() =>
      manifest([{ id: "root", message: "root" }, ...exactConsumers]),
    ).toThrow(/100000 JSON nodes/u);
  });

  it("accepts exactly 65,536 expanded edges and rejects 65,537", () => {
    const groupMembers = Array.from(
      { length: MAX_WORKFLOW_STEPS - 1 },
      (_, index) => ({
        id: `member-${index}`,
        group: "all",
        message: "member",
      }),
    );
    const groupReferenceCount = Math.floor(
      MAX_WORKFLOW_EXPANDED_EDGES / groupMembers.length,
    );
    const stepReferenceCount =
      MAX_WORKFLOW_EXPANDED_EDGES - groupReferenceCount * groupMembers.length;
    const inputs = {
      ...aliases(groupReferenceCount, { group: "all" }),
      ...Object.fromEntries(
        Array.from({ length: stepReferenceCount }, (_, index) => [
          `step_input_${index}`,
          { step: "member-0" },
        ]),
      ),
    };
    const exact = [
      ...groupMembers,
      { id: "consumer", message: "consumer", inputs },
    ];
    expect(() => manifest(exact)).not.toThrow();
    const plusOneInputs = { ...inputs, plus_one: { step: "member-0" } };
    expect(Object.keys(plusOneInputs).length).toBeLessThanOrEqual(
      MAX_WORKFLOW_INPUT_ALIASES_PER_STEP,
    );
    expect(() =>
      manifest([
        ...groupMembers,
        { id: "consumer", message: "consumer", inputs: plusOneInputs },
      ]),
    ).toThrow(WorkflowManifestValidationError);
  });

  it("keeps code-point, UTF-8, and filesystem component name bounds explicit", () => {
    expect(() =>
      validateWorkflowName("a".repeat(MAX_WORKFLOW_NAME_CODEPOINTS)),
    ).not.toThrow();
    expect(() =>
      validateWorkflowName("a".repeat(MAX_WORKFLOW_NAME_CODEPOINTS + 1)),
    ).toThrow();
    const exactUtf8 = "é".repeat(MAX_WORKFLOW_NAME_UTF8_BYTES / 2);
    expect(Buffer.byteLength(exactUtf8, "utf8")).toBe(
      MAX_WORKFLOW_NAME_UTF8_BYTES,
    );
    expect(() => validateWorkflowName(exactUtf8)).not.toThrow();
    expect(() => validateWorkflowName(`${exactUtf8}é`)).toThrow();
    expect(() => validateWorkflowName("a", 6)).not.toThrow();
    expect(() => validateWorkflowName("aa", 6)).toThrow();
  });
});

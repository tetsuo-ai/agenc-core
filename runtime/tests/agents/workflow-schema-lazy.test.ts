import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function exerciseCachedValidation(
  validate: (value: unknown) => unknown,
  valid: unknown,
  invalid: unknown,
  code: string,
  first: "valid" | "invalid",
  compileCount: () => number,
): void {
  const reject = () => expect(() => validate(invalid)).toThrowError(
    expect.objectContaining({ code }),
  );
  if (first === "valid") expect(() => validate(valid)).not.toThrow();
  else reject();
  expect(compileCount()).toBe(1);
  expect(() => validate(valid)).not.toThrow();
  reject();
  reject();
  expect(compileCount()).toBe(1);
}

function validArtifact() {
  return {
    format_version: 1,
    kind: "workflow_handoff",
    compatibility_epoch: "workflow_handoff.v1/state-schema.22",
    artifact_id: `wh_${"a".repeat(48)}`,
    owner: { run_id: "run", workflow_id: "workflow", producer_step_id: "step" },
    digest: `sha256:${"b".repeat(64)}`,
    byte_length: 4,
    token_count: 1,
    media_type: "text/plain",
    encoding: "utf-8",
    storage_ref: `workflow-handoff:wh_${"a".repeat(48)}`,
    created_at_ms: 1,
    committed_at_ms: 2,
    commit_sequence: 1,
    preview: "body",
    preview_truncated: false,
  };
}

describe("workflow schema compilation on first validation", () => {
  it.each(["valid", "invalid"] as const)(
    "compiles the manifest once after a %s first call and preserves its original constraints",
    async (first) => {
      const compile = vi.spyOn(Ajv.prototype, "compile");
      const module = await import("../../src/agents/workflow-manifest-schema.js");
      expect(compile).not.toHaveBeenCalled();
      const message = module.WORKFLOW_MANIFEST_V2_SCHEMA.properties.steps.items.properties.message;
      const original = message.minLength;
      message.minLength = 0;
      try {
        exerciseCachedValidation(
          module.validateWorkflowManifestValue,
          { format_version: 2, kind: "agent_dag", steps: [{ id: "step", message: "work" }] },
          { format_version: 2, kind: "agent_dag", steps: [{ id: "step", message: "" }] },
          "WORKFLOW_SCHEMA",
          first,
          () => compile.mock.calls.length,
        );
      } finally {
        message.minLength = original;
      }
    },
  );

  it.each(["valid", "invalid"] as const)(
    "compiles the invocation once after a %s first call without compiling the manifest",
    async (first) => {
      const compile = vi.spyOn(Ajv.prototype, "compile");
      const module = await import("../../src/agents/workflow-invocation.js");
      expect(compile).not.toHaveBeenCalled();
      const concurrency = module.WORKFLOW_INVOCATION_SCHEMA.properties.args.properties.max_concurrency;
      const original = concurrency.maximum;
      concurrency.maximum = Number.MAX_SAFE_INTEGER;
      try {
        exerciseCachedValidation(
          module.validateWorkflowInvocationValue,
          { name: "workflow", args: { max_concurrency: 1 } },
          { name: "workflow", args: { max_concurrency: original + 1 } },
          "WORKFLOW_INVOCATION_SCHEMA",
          first,
          () => compile.mock.calls.length,
        );
      } finally {
        concurrency.maximum = original;
      }
    },
  );

  it.each(["valid", "invalid"] as const)(
    "compiles the handoff once after a %s first call and preserves its original constraints",
    async (first) => {
      const compile = vi.spyOn(Ajv.prototype, "compile");
      const module = await import("../../src/agents/workflow-handoff-schema.js");
      expect(compile).not.toHaveBeenCalled();
      const tokens = module.WORKFLOW_HANDOFF_ARTIFACT_SCHEMA.properties.token_count;
      const original = tokens.maximum;
      tokens.maximum = Number.MAX_SAFE_INTEGER;
      try {
        exerciseCachedValidation(
          module.validateWorkflowHandoffArtifactValue,
          validArtifact(),
          { ...validArtifact(), token_count: original + 1 },
          "WORKFLOW_HANDOFF_SCHEMA",
          first,
          () => compile.mock.calls.length,
        );
      } finally {
        tokens.maximum = original;
      }
    },
  );

  it("retains the handoff relationship keyword and rejects inconsistent metadata", async () => {
    const compile = vi.spyOn(Ajv.prototype, "compile");
    const { validateWorkflowHandoffArtifactValue } = await import("../../src/agents/workflow-handoff-schema.js");
    expect(compile).not.toHaveBeenCalled();
    const valid = validArtifact();
    for (const invalid of [
      { ...valid, storage_ref: `workflow-handoff:wh_${"c".repeat(48)}` },
      { ...valid, committed_at_ms: 0 },
      { ...valid, preview_truncated: true },
      { ...valid, owner: { ...valid.owner, run_id: "🙂".repeat(300) } },
    ]) {
      expect(() => validateWorkflowHandoffArtifactValue(invalid)).toThrowError(
        expect.objectContaining({
          code: "WORKFLOW_HANDOFF_SCHEMA",
          issues: expect.arrayContaining([expect.stringContaining("x-agenc-post-validation")]),
        }),
      );
    }
    expect(validateWorkflowHandoffArtifactValue(valid)).toEqual(valid);
    expect(compile).toHaveBeenCalledTimes(1);
  });
});

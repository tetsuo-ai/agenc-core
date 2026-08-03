import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DURABLE_ARTIFACT_KINDS,
  LEGACY_TOOL_RESULT_ARTIFACT_KIND,
  MAX_WORKFLOW_ARTIFACT_BYTES,
  MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
  MAX_WORKFLOW_STEP_PREVIEW_BYTES,
  MAX_WORKFLOW_STEP_RESULT_TOKENS,
  assertKnownDurableArtifactKind,
  validateWorkflowHandoffArtifactValue,
  WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION,
  WORKFLOW_HANDOFF_ARTIFACT_KIND,
  WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH,
  WORKFLOW_HANDOFF_POST_VALIDATION_CONSTRAINTS,
} from "../../src/agents/workflow-handoff-schema.js";
import { WorkflowHandoffArtifactSchema } from "../../src/entrypoints/sdk/coreSchemas.js";
import {
  AGENC_MAX_WORKFLOW_HANDOFF_ARTIFACT_BYTES,
  AGENC_MAX_WORKFLOW_HANDOFF_OWNER_FIELD_UTF8_BYTES,
  AGENC_MAX_WORKFLOW_STEP_PREVIEW_BYTES,
  AGENC_MAX_WORKFLOW_STEP_RESULT_TOKENS,
  AGENC_WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION,
  AGENC_WORKFLOW_HANDOFF_ARTIFACT_KIND,
  AGENC_WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH,
  validateWorkflowHandoffArtifact,
  type WorkflowHandoffArtifact as SdkWorkflowHandoffArtifact,
} from "../../../packages/agenc-sdk/src/index.js";

const schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/agents/workflow-handoff-artifact.v1.schema.json",
);

const artifact = Object.freeze({
  format_version: 1,
  kind: "workflow_handoff",
  compatibility_epoch: "workflow_handoff.v1/state-schema.22",
  artifact_id: `wh_${"0".repeat(48)}`,
  owner: {
    run_id: "run",
    workflow_id: "workflow",
    producer_step_id: "step",
  },
  digest: `sha256:${"0".repeat(64)}`,
  byte_length: 4,
  token_count: 1,
  media_type: "text/plain",
  encoding: "utf-8",
  storage_ref: `workflow-handoff:wh_${"0".repeat(48)}`,
  created_at_ms: 1,
  committed_at_ms: 2,
  commit_sequence: 1,
  preview: "data",
  preview_truncated: false,
} as const satisfies SdkWorkflowHandoffArtifact);

describe("public workflow handoff artifact contract", () => {
  it("keeps JSON schema, runtime validation, and SDK constants aligned", () => {
    const jsonSchema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      readonly properties: {
        readonly format_version: { readonly const: number };
        readonly kind: { readonly const: string };
        readonly compatibility_epoch: { readonly const: string };
        readonly byte_length: { readonly maximum: number };
        readonly token_count: { readonly maximum: number };
      };
      readonly "x-agenc-post-validation": {
        readonly ownerFieldMaxUtf8Bytes: number;
        readonly previewMaxUtf8Bytes: number;
        readonly requireWellFormedUnicode: boolean;
        readonly storageRefMustMatchArtifactId: boolean;
        readonly committedAtMustNotPrecedeCreatedAt: boolean;
        readonly previewBytesMustMatchByteLengthAndTruncation: boolean;
      };
    };

    expect(jsonSchema.properties.format_version.const).toBe(
      WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION,
    );
    expect(jsonSchema.properties.kind.const).toBe(WORKFLOW_HANDOFF_ARTIFACT_KIND);
    expect(jsonSchema.properties.compatibility_epoch.const).toBe(
      WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH,
    );
    expect(jsonSchema.properties.byte_length.maximum).toBe(
      MAX_WORKFLOW_ARTIFACT_BYTES,
    );
    expect(jsonSchema.properties.token_count.maximum).toBe(
      MAX_WORKFLOW_STEP_RESULT_TOKENS,
    );
    expect(AGENC_WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION).toBe(
      WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION,
    );
    expect(AGENC_WORKFLOW_HANDOFF_ARTIFACT_KIND).toBe(
      WORKFLOW_HANDOFF_ARTIFACT_KIND,
    );
    expect(AGENC_WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH).toBe(
      WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH,
    );
    expect(AGENC_MAX_WORKFLOW_HANDOFF_ARTIFACT_BYTES).toBe(
      MAX_WORKFLOW_ARTIFACT_BYTES,
    );
    expect(AGENC_MAX_WORKFLOW_STEP_RESULT_TOKENS).toBe(
      MAX_WORKFLOW_STEP_RESULT_TOKENS,
    );
    expect(AGENC_MAX_WORKFLOW_STEP_PREVIEW_BYTES).toBe(
      MAX_WORKFLOW_STEP_PREVIEW_BYTES,
    );
    expect(AGENC_MAX_WORKFLOW_HANDOFF_OWNER_FIELD_UTF8_BYTES).toBe(
      MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
    );
    expect(jsonSchema["x-agenc-post-validation"]).toEqual(
      WORKFLOW_HANDOFF_POST_VALIDATION_CONSTRAINTS,
    );
    expect(validateWorkflowHandoffArtifactValue(artifact)).toEqual(artifact);
    expect(WorkflowHandoffArtifactSchema().parse(artifact)).toEqual(artifact);
    expect(validateWorkflowHandoffArtifact(artifact)).toEqual(artifact);
    expect(artifact).not.toHaveProperty("minimum_reader_runtime");
  });

  it("keeps both legacy and workflow kinds explicit and preserves unknown bytes", () => {
    expect(DURABLE_ARTIFACT_KINDS).toEqual([
      LEGACY_TOOL_RESULT_ARTIFACT_KIND,
      WORKFLOW_HANDOFF_ARTIFACT_KIND,
    ]);
    for (const kind of DURABLE_ARTIFACT_KINDS) {
      expect(() => assertKnownDurableArtifactKind(kind)).not.toThrow();
    }
    const unknownBytes = Buffer.from("future opaque artifact");
    const before = Buffer.from(unknownBytes);
    expect(() => assertKnownDurableArtifactKind("future_kind")).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_DURABLE_ARTIFACT_KIND" }),
    );
    expect(unknownBytes).toEqual(before);
  });

  it("rejects extra fields and relationship mismatches", () => {
    expect(() =>
      WorkflowHandoffArtifactSchema().parse({ ...artifact, extra: true }),
    ).toThrow();
    expect(() =>
      validateWorkflowHandoffArtifactValue({
        ...artifact,
        storage_ref: `workflow-handoff:wh_${"1".repeat(48)}`,
      }),
    ).toThrow();
  });

  it("rejects the same adversarial UTF-8 and relationship values on every SDK surface", () => {
    const adversarial: readonly (readonly [string, unknown])[] = [
      ["oversize owner", {
        ...artifact,
        owner: { ...artifact.owner, run_id: "x".repeat(1_025) },
      }],
      [
        "invalid owner Unicode",
        {
          ...artifact,
          owner: { ...artifact.owner, run_id: "bad\ud800" },
        },
      ],
      ["oversize preview", {
        ...artifact,
        byte_length: 2_049,
        preview: "x".repeat(2_049),
      }],
      [
        "invalid preview Unicode",
        { ...artifact, preview: "bad\udc00", byte_length: 4 },
      ],
      ["storage reference mismatch", {
        ...artifact,
        storage_ref: `workflow-handoff:wh_${"1".repeat(48)}`,
      }],
      [
        "timestamp order",
        { ...artifact, created_at_ms: 3, committed_at_ms: 2 },
      ],
      [
        "complete preview mismatch",
        { ...artifact, byte_length: 5, preview_truncated: false },
      ],
      [
        "truncated preview mismatch",
        { ...artifact, byte_length: 4, preview_truncated: true },
      ],
      [
        "unsafe timestamp",
        { ...artifact, created_at_ms: Number.MAX_SAFE_INTEGER + 1 },
      ],
      [
        "false minimum runtime claim",
        { ...artifact, minimum_reader_runtime: "0.13.0" },
      ],
    ];
    const validators: readonly (readonly [
      string,
      (value: unknown) => unknown,
    ])[] = [
      [
        "runtime",
        (value: unknown) => validateWorkflowHandoffArtifactValue(value),
      ],
      [
        "runtime SDK",
        (value: unknown) => WorkflowHandoffArtifactSchema().parse(value),
      ],
      [
        "package SDK",
        (value: unknown) => validateWorkflowHandoffArtifact(value),
      ],
    ];

    for (const [caseName, candidate] of adversarial) {
      for (const [surface, validate] of validators) {
        expect(() => validate(candidate), `${caseName}: ${surface}`).toThrow();
      }
    }
  });
});

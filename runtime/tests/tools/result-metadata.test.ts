import { describe, expect, it } from "vitest";

import {
  buildFileMutationMetadata,
  buildRecoverableToolFailureMetadata,
  recoverableFailureKind,
  type RecoverableToolFailureKind,
} from "../../src/tools/result-metadata.js";

const RECOVERABLE_KINDS: readonly RecoverableToolFailureKind[] = [
  "input_validation",
  "mcp_tool_not_shell_command",
  "shell_workspace_write_policy",
  "exec_detach_unavailable",
];

describe("buildRecoverableToolFailureMetadata", () => {
  it("stamps the hidden recoverable contract without dropping existing fields", () => {
    expect(
      buildRecoverableToolFailureMetadata("input_validation", {
        preflightCode: "schema",
      }),
    ).toEqual({
      preflightCode: "schema",
      recoverable: true,
      hiddenFromTranscript: true,
      kind: "input_validation",
    });
  });

  it("overwrites a caller that tried to keep the failure visible", () => {
    expect(
      buildRecoverableToolFailureMetadata("exec_detach_unavailable", {
        recoverable: false,
        hiddenFromTranscript: false,
        kind: "input_validation",
      }),
    ).toEqual({
      recoverable: true,
      hiddenFromTranscript: true,
      kind: "exec_detach_unavailable",
    });
  });
});

describe("recoverableFailureKind", () => {
  it.each(RECOVERABLE_KINDS)("accepts a complete %s stamp", (kind) => {
    expect(recoverableFailureKind(buildRecoverableToolFailureMetadata(kind))).toBe(
      kind,
    );
  });

  it.each([
    undefined,
    {},
    { recoverable: true, hiddenFromTranscript: true },
    { recoverable: true, hiddenFromTranscript: true, kind: "timeout" },
    { recoverable: false, hiddenFromTranscript: true, kind: "input_validation" },
    { recoverable: true, hiddenFromTranscript: false, kind: "input_validation" },
    { recoverable: "true", hiddenFromTranscript: true, kind: "input_validation" },
  ])("rejects incomplete or unknown metadata: %j", (metadata) => {
    expect(
      recoverableFailureKind(metadata as Readonly<Record<string, unknown>> | undefined),
    ).toBeNull();
  });
});

describe("buildFileMutationMetadata", () => {
  it("counts added and removed lines for a single-file edit", () => {
    expect(
      buildFileMutationMetadata({
        filePath: "src/app.ts",
        operation: "edit",
        beforeText: "const a = 1;\nconst b = 2;\n",
        afterText: "const a = 1;\nconst b = 3;\nconst c = 4;\n",
      }),
    ).toEqual({
      ui: {
        kind: "file_mutation",
        filePath: "src/app.ts",
        operation: "edit",
        additions: 2,
        removals: 1,
      },
    });
  });

  it("records a create as additions only and keeps an explicit replacement count", () => {
    expect(
      buildFileMutationMetadata({
        filePath: "README.md",
        operation: "create",
        beforeText: "",
        afterText: "hello\nworld\n",
        replacements: 0,
      }),
    ).toEqual({
      ui: {
        kind: "file_mutation",
        filePath: "README.md",
        operation: "create",
        additions: 2,
        removals: 0,
        replacements: 0,
      },
    });
  });

  it("reports a no-op write as a mutation with zero hunks", () => {
    expect(
      buildFileMutationMetadata({
        filePath: "same.txt",
        operation: "write",
        beforeText: "unchanged\n",
        afterText: "unchanged\n",
      }),
    ).toEqual({
      ui: {
        kind: "file_mutation",
        filePath: "same.txt",
        operation: "write",
        additions: 0,
        removals: 0,
      },
    });
  });
});

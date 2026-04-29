import { describe, expect, it } from "vitest";

import type { EffectRecord } from "../workflow/effects.js";
import { evaluateEffectLedgerCompleteness } from "./effect-ledger-checks.js";

function effectFixture(
  overrides: Partial<EffectRecord> = {},
): EffectRecord {
  return {
    version: "v1",
    id: "effect-1",
    idempotencyKey: "idem-1",
    toolCallId: "tool-1",
    toolName: "system.writeFile",
    args: { path: "/tmp/a.txt", content: "hello" },
    scope: { sessionId: "session-1" },
    kind: "filesystem_write",
    effectClass: "filesystem_write",
    status: "succeeded",
    createdAt: 1,
    updatedAt: 2,
    intentSummary: "write file",
    targets: [{ kind: "path", path: "/tmp/a.txt" }],
    attempts: [],
    approval: {
      requestId: "approval-1",
      disposition: "yes",
      requestedAt: 1,
      resolvedAt: 2,
    },
    preExecutionSnapshots: [
      { path: "/tmp/a.txt", exists: false, entryType: "missing" },
    ],
    postExecutionSnapshots: [
      {
        path: "/tmp/a.txt",
        exists: true,
        entryType: "file",
        sha256: "abc",
      },
    ],
    result: {
      success: true,
      isError: false,
      completedAt: 2,
      resultSnippet: "ok",
    },
    compensation: { status: "available", actions: [] },
    ...overrides,
  };
}

describe("effect-ledger completeness checks", () => {
  it("reports full completeness for a grounded filesystem effect", () => {
    const artifact = evaluateEffectLedgerCompleteness([effectFixture()]);
    expect(artifact.totalEffects).toBe(1);
    expect(artifact.completeEffects).toBe(1);
    expect(artifact.completenessRate).toBe(1);
  });

  it("flags missing snapshots, results, and duplicate idempotency keys", () => {
    const artifact = evaluateEffectLedgerCompleteness([
      effectFixture({
        id: "effect-a",
        idempotencyKey: "dup",
        preExecutionSnapshots: [],
        postExecutionSnapshots: [],
        result: undefined,
      }),
      effectFixture({
        id: "effect-b",
        idempotencyKey: "dup",
      }),
    ]);
    expect(artifact.duplicateIdempotencyKeys).toBe(1);
    expect(artifact.missingPreExecutionSnapshots).toBe(1);
    expect(artifact.missingPostExecutionSnapshots).toBe(1);
    expect(artifact.missingResultSummaries).toBe(1);
    expect(artifact.completenessRate).toBeLessThan(1);
  });
});

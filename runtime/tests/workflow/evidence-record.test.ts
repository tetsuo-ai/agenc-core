import { describe, expect, test } from "vitest";

import {
  assembleVerifiedChangeRecord,
  computeSpecDigest,
  validateVerifiedChangeRecord,
  VERIFIED_CHANGE_RECORD_KIND,
  type VerifiedChangeRecord,
} from "../../src/workflow/evidence-record.js";
import type {
  RunArtifactPointer,
  WorkflowSpec,
} from "../../src/contracts/run-contracts.js";

const HEX_40 = "a".repeat(40);
const HEX_64 = "b".repeat(64);

function goldenSpec(): WorkflowSpec {
  return {
    runId: "run-golden-1",
    goal: "Fix the flaky retry counter in the sync worker.",
    repoPath: "/repo/root",
    baseCommit: HEX_40,
    baseDirty: { dirty: false, summaryDigest: `sha256:${HEX_64}`, fileCount: 0 },
    reviewerModel: "grok-4.5",
    permissionMode: "acceptEdits",
    budget: { maxCostUsd: 5 },
    requiredVerification: [{ label: "unit", script: "npm test" }],
    maxImplementAttempts: 2,
  };
}

function artifact(
  role: RunArtifactPointer["role"],
  stepId: string,
): RunArtifactPointer {
  return {
    step: { runId: "run-golden-1", stepId },
    role,
    digest: `sha256:${HEX_64}`,
    bytes: 128,
    storagePath: `cas://sha256/${HEX_64}`,
    recordedAt: "2026-07-20T12:00:00Z",
  };
}

function goldenInput() {
  const spec = goldenSpec();
  return {
    runId: spec.runId,
    specDigest: computeSpecDigest(spec),
    spec,
    startedAt: "2026-07-20T11:00:00Z",
    finishedAt: "2026-07-20T12:00:00Z",
    terminal: {
      status: "completed" as const,
      stopReason: null,
      finalMessage: "Verified change ready for review.",
    },
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.42 },
    baseCommit: HEX_40,
    headCommit: HEX_40,
    steps: [
      {
        stepId: "workflow.finalize",
        stage: "workflow.finalize" as const,
        status: "committed" as const,
        attempt: 1,
        startedAt: "2026-07-20T11:50:00Z",
        finishedAt: "2026-07-20T12:00:00Z",
        artifacts: [
          artifact("patch", "workflow.finalize"),
          artifact("changed_files", "workflow.finalize"),
          artifact("test_result", "workflow.verify"),
          artifact("independent_review", "workflow.review"),
        ],
      },
    ],
    verificationCommands: [
      {
        label: "unit",
        script: "npm test",
        exitCode: 0,
        timedOut: false,
        truncated: false,
        durationMs: 12_000,
        stdoutDigest: `sha256:${HEX_64}` as const,
        stderrDigest: `sha256:${HEX_64}` as const,
      },
    ],
    review: {
      reviewerModel: "grok-4.5",
      overallCorrectness: "correct",
      overallConfidenceScore: 0.9,
      blockerCount: 0,
      findingCount: 1,
      artifact: artifact("independent_review", "workflow.review"),
    },
    unresolvedRisks: [],
    evidenceLedger: {
      eventCount: 12,
      headEventDigest: `sha256:${HEX_64}` as const,
      sealed: true,
    },
  };
}

describe("verified-change evidence record (M5)", () => {
  test("golden completed record assembles, self-validates, and is digest-stable", () => {
    const record = assembleVerifiedChangeRecord(goldenInput());
    expect(record.kind).toBe(VERIFIED_CHANGE_RECORD_KIND);
    expect(validateVerifiedChangeRecord(record).valid).toBe(true);
    // Reassembly of identical input yields an identical digest.
    expect(assembleVerifiedChangeRecord(goldenInput()).documentDigest).toBe(
      record.documentDigest,
    );
  });

  test("completed without required artifact roles is rejected", () => {
    const input = goldenInput();
    const stripped = {
      ...input,
      steps: input.steps.map((step) => ({
        ...step,
        artifacts: step.artifacts.filter(
          (candidate) =>
            candidate.role !== "test_result" &&
            candidate.role !== "independent_review",
        ),
      })),
    };
    expect(() => assembleVerifiedChangeRecord(stripped)).toThrow(
      /missing required artifact role/,
    );
  });

  test("completed with an unresolved review blocker is rejected", () => {
    const input = goldenInput();
    expect(() =>
      assembleVerifiedChangeRecord({
        ...input,
        review: { ...input.review, blockerCount: 1 },
      }),
    ).toThrow(/unresolved review blockers/);
  });

  test("completed with a failing verification command is rejected", () => {
    const input = goldenInput();
    expect(() =>
      assembleVerifiedChangeRecord({
        ...input,
        verificationCommands: [
          { ...input.verificationCommands[0], exitCode: 1 },
        ],
      }),
    ).toThrow(/failing verification command/);
  });

  test("completed with an unsealed ledger is rejected", () => {
    const input = goldenInput();
    expect(() =>
      assembleVerifiedChangeRecord({
        ...input,
        evidenceLedger: { ...input.evidenceLedger, sealed: false },
      }),
    ).toThrow(/sealed evidence ledger/);
  });

  test("non-completed terminal status requires a machine-readable stopReason", () => {
    const input = goldenInput();
    expect(() =>
      assembleVerifiedChangeRecord({
        ...input,
        terminal: { status: "failed", stopReason: null, finalMessage: null },
      }),
    ).toThrow(/requires a stopReason/);
    const failed = assembleVerifiedChangeRecord({
      ...input,
      terminal: {
        status: "failed",
        stopReason: "verification_failed",
        finalMessage: "unit tests failed",
      },
      review: null,
      evidenceLedger: { ...input.evidenceLedger, sealed: false },
      unresolvedRisks: ["unit suite failing on retry counter"],
    });
    expect(failed.terminal.stopReason).toBe("verification_failed");
  });

  test("tampered document digest is detected", () => {
    const record = assembleVerifiedChangeRecord(goldenInput());
    const tampered: VerifiedChangeRecord = {
      ...record,
      headCommit: "c".repeat(40),
    };
    const validation = validateVerifiedChangeRecord(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/documentDigest does not match/);
  });

  test("spec digest binding is enforced", () => {
    const record = assembleVerifiedChangeRecord(goldenInput());
    const alteredSpec = {
      ...record,
      spec: { ...record.spec, goal: "a different goal entirely" },
    };
    const validation = validateVerifiedChangeRecord(alteredSpec);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/specDigest does not match/);
  });
});

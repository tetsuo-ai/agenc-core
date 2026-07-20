import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildReviewerMessages,
  extractBlockers,
  ReviewParseError,
  runIndependentReview,
  type ReviewerInvoker,
} from "../../src/workflow/independent-review.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
} from "../../src/contracts/run-contracts.js";
import type { EvidenceArtifactSink } from "../../src/workflow/worktree-lifecycle.js";
import type { VerifiedChangeCommandRecord } from "../../src/workflow/evidence-record.js";

const STEP: RunStepIdentity = { runId: "run-r", stepId: "workflow.review" };
const HEX = "e".repeat(64);

const COMMANDS: VerifiedChangeCommandRecord[] = [
  {
    label: "unit",
    script: "npm test",
    exitCode: 0,
    timedOut: false,
    truncated: false,
    durationMs: 900,
    stdoutDigest: `sha256:${HEX}`,
    stderrDigest: `sha256:${HEX}`,
  },
];

class MemorySink implements EvidenceArtifactSink {
  readonly artifacts: Array<{ role: string; text: string }> = [];

  async recordArtifact(input: {
    step: RunStepIdentity;
    role: RunArtifactPointer["role"];
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<RunArtifactPointer> {
    const hex = createHash("sha256").update(input.bytes).digest("hex");
    this.artifacts.push({ role: input.role, text: new TextDecoder().decode(input.bytes) });
    return {
      step: input.step,
      role: input.role,
      digest: `sha256:${hex}`,
      bytes: input.bytes.byteLength,
      storagePath: `cas://sha256/${hex}`,
      recordedAt: "2026-07-20T12:00:00Z",
    };
  }
}

function reviewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    findings: [],
    overallCorrectness: "correct",
    overallExplanation: "looks right",
    overallConfidenceScore: 0.8,
    ...overrides,
  });
}

function finding(priority: number, confidenceScore: number, title: string) {
  return {
    title,
    body: "detail",
    confidenceScore,
    priority,
    codeLocation: {
      absolutePath: "/wt/src/index.ts",
      lineRange: { start: 1, end: 2 },
    },
  };
}

const SPEC = { goal: "Fix the retry counter.", reviewerModel: "grok-4.5" };

describe("M5 independent review", () => {
  it("parses a structured review, records the artifact, and extracts no blockers for a clean pass", async () => {
    const sink = new MemorySink();
    const invoker: ReviewerInvoker = {
      invoke: async () => reviewJson({ findings: [finding(2, 0.9, "style nit")] }),
    };
    const result = await runIndependentReview({
      spec: SPEC,
      patchText: "diff --git a/x b/x",
      changedFilesText: "M\tsrc/index.ts",
      verification: COMMANDS,
      verificationVerdict: "PASS",
      invoker,
      sink,
      step: STEP,
    });
    expect(result.blockers).toEqual([]);
    expect(result.review.findings).toHaveLength(1);
    expect(sink.artifacts).toEqual([
      expect.objectContaining({ role: "independent_review" }),
    ]);
    expect(sink.artifacts[0].text).toContain('"reviewerModel":"grok-4.5"');
  });

  it("high-priority high-confidence findings and incorrect verdicts are blockers", () => {
    expect(
      extractBlockers({
        findings: [
          finding(0, 0.9, "breaks rollback"),
          finding(1, 0.5, "unguarded null"),
          finding(1, 0.3, "low confidence guess"),
          finding(2, 1.0, "important but not blocking"),
        ],
        overallCorrectness: "correct",
        overallExplanation: "",
        overallConfidenceScore: 0.7,
      }),
    ).toEqual(["breaks rollback", "unguarded null"]);
    expect(
      extractBlockers({
        findings: [],
        overallCorrectness: "incorrect",
        overallExplanation: "patch does not fix the issue",
        overallConfidenceScore: 0.9,
      })[0],
    ).toMatch(/reviewer overall verdict: incorrect/);
  });

  it("a free-text (unparseable) reviewer response fails the step — never a silent approval", async () => {
    const invoker: ReviewerInvoker = {
      invoke: async () => "LGTM! Great work, ship it.",
    };
    await expect(
      runIndependentReview({
        spec: SPEC,
        patchText: "diff",
        changedFilesText: "",
        verification: COMMANDS,
        verificationVerdict: "PASS",
        invoker,
        sink: new MemorySink(),
        step: STEP,
      }),
    ).rejects.toThrow(ReviewParseError);
  });

  it("context hygiene: the invoker receives exactly the assembled prompt and nothing else", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const invoker: ReviewerInvoker = {
      invoke: async (input) => {
        captured.push({ ...input });
        return reviewJson();
      },
    };
    const inputs = {
      spec: SPEC,
      patchText: "diff --git a/src/index.ts b/src/index.ts\n-41\n+42",
      changedFilesText: "M\tsrc/index.ts",
      verification: COMMANDS,
      verificationVerdict: "PASS" as const,
    };
    await runIndependentReview({
      ...inputs,
      invoker,
      sink: new MemorySink(),
      step: STEP,
    });
    expect(captured).toHaveLength(1);
    // The transport contract is closed: exactly these five fields, so no
    // future call site can smuggle implementer context alongside them.
    // `runId` is routing metadata for the daemon-backed invoker (Phase 5);
    // prompt assembly never reads it.
    expect(Object.keys(captured[0]).sort()).toEqual([
      "reviewerModel", "runId", "systemPrompt", "timeoutMs", "userMessage",
    ]);
    expect(captured[0].runId).toBe(STEP.runId);
    // And the user message is byte-identical to the single assembly point's
    // output for the same task+diff+evidence inputs.
    const expected = buildReviewerMessages({
      goal: inputs.spec.goal,
      patchText: inputs.patchText,
      changedFilesText: inputs.changedFilesText,
      verification: inputs.verification,
      verificationVerdict: inputs.verificationVerdict,
    });
    expect(captured[0].userMessage).toBe(expected.userMessage);
    expect(captured[0].systemPrompt).toBe(expected.systemPrompt);
    expect(String(captured[0].userMessage)).toContain("Fix the retry counter.");
    expect(String(captured[0].userMessage)).toContain("+42");
  });
});

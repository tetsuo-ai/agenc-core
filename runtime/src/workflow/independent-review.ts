/**
 * M5 independent fresh-context review executor.
 *
 * Pure library: the reviewer invocation is injected (`ReviewerInvoker`),
 * which the controller backs with the session one-shot review delegate
 * (`runAgenCReviewOneShot`) using the spec's PINNED reviewer model, and
 * tests back with scripts.
 *
 * Context hygiene is the load-bearing property: the reviewer prompt is
 * built HERE, exclusively from the task goal, the exported patch, and the
 * verification evidence summary. The implementer's conversation never
 * enters — `buildReviewerMessages` is the single prompt assembly point and
 * the context-hygiene test locks it.
 */

import type {
  RunArtifactPointer,
  RunStepIdentity,
  WorkflowSpec,
} from "../contracts/run-contracts.js";
import {
  parseReviewOutput,
  REVIEW_SYSTEM_PROMPT,
  type ReviewOutput,
} from "../session/review.js";
import type { VerifiedChangeCommandRecord } from "./evidence-record.js";
import type { EvidenceArtifactSink } from "./worktree-lifecycle.js";
import { canonicalizeJson } from "../eval-contract/canonical-json.js";

export interface ReviewerInvoker {
  invoke(input: {
    readonly systemPrompt: string;
    readonly userMessage: string;
    readonly reviewerModel: string;
    readonly timeoutMs: number;
    /**
     * Owning workflow run id (additive, Phase 5): lets a daemon-backed
     * invoker route the one-shot review through the run's own session.
     * Prompt assembly never reads it — context hygiene is unchanged.
     */
    readonly runId?: string;
  }): Promise<string>;
}

export class ReviewParseError extends Error {
  constructor(detail: string) {
    super(`independent review output was not parseable: ${detail}`);
    this.name = "ReviewParseError";
  }
}

export const DEFAULT_REVIEW_TIMEOUT_MS = 600_000;

/**
 * A finding blocks completion when the reviewer marked it high priority
 * with real confidence. Priority follows the P0/P1 convention (lower is
 * more severe); the threshold and floor are pinned in the spec digest via
 * the workflow evidence, not tunable per run after the fact.
 */
export const BLOCKER_PRIORITY_THRESHOLD = 1;
export const BLOCKER_CONFIDENCE_FLOOR = 0.5;

export function extractBlockers(review: ReviewOutput): readonly string[] {
  const blockers: string[] = [];
  for (const finding of review.findings) {
    if (
      finding.priority <= BLOCKER_PRIORITY_THRESHOLD &&
      finding.confidenceScore >= BLOCKER_CONFIDENCE_FLOOR
    ) {
      blockers.push(finding.title);
    }
  }
  if (review.overallCorrectness.toLowerCase() === "incorrect") {
    blockers.push(
      `reviewer overall verdict: incorrect — ${review.overallExplanation.slice(0, 200)}`,
    );
  }
  return blockers;
}

export interface ReviewerPromptInput {
  readonly goal: string;
  readonly patchText: string;
  readonly changedFilesText: string;
  readonly verification: readonly VerifiedChangeCommandRecord[];
  readonly verificationVerdict: string | undefined;
}

/**
 * THE single reviewer prompt assembly point. Takes ONLY task + diff +
 * verification evidence; adding any other parameter is a contract change
 * the context-hygiene test exists to catch.
 */
export function buildReviewerMessages(input: ReviewerPromptInput): {
  readonly systemPrompt: string;
  readonly userMessage: string;
} {
  const verificationSummary = input.verification
    .map(
      (record) =>
        `- ${record.label}: exit ${record.exitCode}` +
        `${record.timedOut ? " (timed out)" : ""} in ${record.durationMs}ms`,
    )
    .join("\n");
  const userMessage = [
    "You are reviewing a proposed code change produced for the task below.",
    "You have NO other context: judge only what is in this message.",
    "",
    "## Task",
    input.goal,
    "",
    "## Changed files",
    input.changedFilesText.trim() || "(none reported)",
    "",
    "## Verification evidence",
    verificationSummary || "(no commands recorded)",
    `Adversarial verification verdict: ${input.verificationVerdict ?? "missing"}`,
    "",
    "## Unified diff",
    "```diff",
    input.patchText,
    "```",
    "",
    "Respond with a single JSON object matching ReviewOutput:",
    '{"findings":[{"title","body","confidenceScore":0..1,"priority":0..3,',
    '"codeLocation":{"absolutePath","lineRange":{"start","end"}}}],',
    '"overallCorrectness":"correct"|"incorrect",',
    '"overallExplanation":"...","overallConfidenceScore":0..1}',
    "Priority 0-1 findings are release blockers; reserve them for defects",
    "that make the change wrong, unsafe, or untested.",
  ].join("\n");
  return { systemPrompt: REVIEW_SYSTEM_PROMPT, userMessage };
}

export interface IndependentReviewResult {
  readonly review: ReviewOutput;
  readonly artifact: RunArtifactPointer;
  readonly blockers: readonly string[];
}

export async function runIndependentReview(opts: {
  readonly spec: Pick<WorkflowSpec, "goal" | "reviewerModel">;
  readonly patchText: string;
  readonly changedFilesText: string;
  readonly verification: readonly VerifiedChangeCommandRecord[];
  readonly verificationVerdict: string | undefined;
  readonly invoker: ReviewerInvoker;
  readonly sink: EvidenceArtifactSink;
  readonly step: RunStepIdentity;
  readonly timeoutMs?: number;
}): Promise<IndependentReviewResult> {
  const prompt = buildReviewerMessages({
    goal: opts.spec.goal,
    patchText: opts.patchText,
    changedFilesText: opts.changedFilesText,
    verification: opts.verification,
    verificationVerdict: opts.verificationVerdict,
  });
  const raw = await opts.invoker.invoke({
    systemPrompt: prompt.systemPrompt,
    userMessage: prompt.userMessage,
    reviewerModel: opts.spec.reviewerModel,
    timeoutMs: opts.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    runId: opts.step.runId,
  });
  const review = parseReviewOutput(raw);
  // parseReviewOutput's plain-text fallback has this exact shape; a review
  // that did not produce structured output FAILS the step — it is never
  // treated as an approval.
  if (review.overallCorrectness === "" && review.findings.length === 0) {
    throw new ReviewParseError(
      `no structured ReviewOutput in reviewer response (${raw.length} chars)`,
    );
  }
  const artifact = await opts.sink.recordArtifact({
    step: opts.step,
    role: "independent_review",
    bytes: new TextEncoder().encode(
      canonicalizeJson({ review, reviewerModel: opts.spec.reviewerModel }),
    ),
    mediaType: "application/json",
  });
  return { review, artifact, blockers: extractBlockers(review) };
}

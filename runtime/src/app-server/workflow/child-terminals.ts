/**
 * M5 A1 — durable workflow child terminals for cross-restart adoption.
 *
 * Extracted from `session-adapters.ts` so BOTH the session-backed spawner
 * and the workflow controller (which settles the independent-review child
 * inside its own effect execution) can durably record child terminals
 * through the EXISTING run machinery without the controller importing the
 * daemon session stack. `session-adapters.ts` re-exports everything here,
 * so existing importers are unchanged.
 */

import type {
  RunArtifactPointer,
} from "../../contracts/run-contracts.js";
import { canonicalizeJson } from "../../eval-contract/canonical-json.js";
import type { ReviewOutput } from "../../session/review.js";
import type { StateRunDurabilityRepository } from "../../state/run-durability.js";
import type { WorkflowChildOutcome } from "./verified-change-controller.js";

/** Deterministic event id for a child's durable terminal record. */
export const WORKFLOW_CHILD_TERMINAL_EVENT_PREFIX = "workflow-child-terminal:";

/**
 * Durably record a workflow child's terminal outcome in the owning run's
 * state database, keyed by the deterministic child run id that the parent
 * effect intent already carries. This honestly extends the EXISTING run
 * machinery — the child gets its own `run_lifecycle_epochs` row and its own
 * immutable `run_terminal_results` row (no new store, no parallel table) —
 * so a post-restart `spawner.inspect(childRunId)` can adopt the outcome
 * instead of reporting "unknown".
 *
 * Idempotent: re-recording an existing terminal is a no-op; the sticky
 * per-(run, epoch) terminal-conflict rules of the repository still apply to
 * genuinely conflicting content.
 */
export function recordWorkflowChildTerminal(
  repo: StateRunDurabilityRepository,
  childRunId: string,
  outcome: WorkflowChildOutcome,
  now: () => Date = () => new Date(),
): void {
  const at = now().toISOString();
  repo.ensureInitialEpoch({ runId: childRunId, openedAt: at });
  const epoch = repo.currentEpoch(childRunId)?.epoch ?? 1;
  if (repo.getTerminalResult(childRunId, epoch) !== undefined) return;
  repo.recordTerminalResult({
    epoch,
    eventId: `${WORKFLOW_CHILD_TERMINAL_EVENT_PREFIX}${childRunId}`,
    result: {
      runId: childRunId,
      status: outcome.status,
      exitCode: outcome.status === "completed" ? 0 : 1,
      stopReason: null,
      finalMessage: outcome.finalMessage,
      usage: outcome.usage,
      lastSequence: null,
      finishedAt: at,
    },
  });
}

/**
 * D3 adoption source of truth after a daemon restart: the child's durable
 * terminal, if one was recorded before the crash. A child that genuinely
 * died mid-flight with the daemon recorded nothing and stays `undefined`
 * (the caller reports "unknown" → the run terminates `unknown_outcome`).
 */
export function inspectWorkflowChildTerminal(
  repo: StateRunDurabilityRepository,
  childRunId: string,
): WorkflowChildOutcome | undefined {
  const terminal = repo.getCurrentTerminalResult(childRunId);
  if (terminal === undefined) return undefined;
  return {
    status: terminal.status,
    finalMessage: terminal.finalMessage,
    usage: terminal.usage,
  };
}

// ---------------------------------------------------------------------------
// Independent-review child terminal payload
// ---------------------------------------------------------------------------

/**
 * The review child settles inside the review effect's own execution, so its
 * durable terminal must carry enough to complete the parent effect honestly
 * on adoption: the parsed ReviewOutput plus the recorded
 * `independent_review` artifact pointer. The payload rides the terminal's
 * `finalMessage` as canonical JSON with a versioned kind marker; a terminal
 * whose payload does not decode stays honestly unknowable.
 */
export const WORKFLOW_REVIEW_TERMINAL_KIND =
  "agenc.workflow.review-terminal.v1";

export interface WorkflowReviewTerminalPayload {
  readonly kind: typeof WORKFLOW_REVIEW_TERMINAL_KIND;
  readonly review: ReviewOutput;
  readonly reviewerModel: string;
  readonly artifact: RunArtifactPointer;
}

export function encodeWorkflowReviewTerminal(
  payload: Omit<WorkflowReviewTerminalPayload, "kind">,
): string {
  return canonicalizeJson({
    kind: WORKFLOW_REVIEW_TERMINAL_KIND,
    review: payload.review,
    reviewerModel: payload.reviewerModel,
    artifact: payload.artifact,
  });
}

export function decodeWorkflowReviewTerminal(
  finalMessage: string | null | undefined,
): WorkflowReviewTerminalPayload | undefined {
  if (finalMessage === null || finalMessage === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalMessage);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.kind !== WORKFLOW_REVIEW_TERMINAL_KIND) return undefined;
  const review = candidate.review;
  if (
    review === null ||
    typeof review !== "object" ||
    !Array.isArray((review as { findings?: unknown }).findings) ||
    typeof (review as { overallCorrectness?: unknown }).overallCorrectness !==
      "string"
  ) {
    return undefined;
  }
  const artifact = candidate.artifact;
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    typeof (artifact as { digest?: unknown }).digest !== "string"
  ) {
    return undefined;
  }
  if (typeof candidate.reviewerModel !== "string") return undefined;
  return {
    kind: WORKFLOW_REVIEW_TERMINAL_KIND,
    review: review as ReviewOutput,
    reviewerModel: candidate.reviewerModel,
    artifact: artifact as RunArtifactPointer,
  };
}

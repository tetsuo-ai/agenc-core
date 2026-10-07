import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkflowContinuation, WorkflowSpec } from "../../contracts/run-contracts.js";
import { computeSpecDigest } from "../../workflow/evidence-record.js";
import { canonicalizeJson, sha256Digest } from "../../eval-contract/canonical-json.js";
import type { StateRunDurabilityRepository } from "../../state/run-durability.js";
import { readWorkflowStepEvidence } from "./steps.js";

function repositoryKey(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function continuationRunId(sourceRunId: string, requestId: string): string {
  const hash = sha256Digest(canonicalizeJson({ sourceRunId, requestId })).slice(7);
  // UUIDv8 preserves the existing run ID shape while the request fixes its
  // identity across retries and restarts. The full digest remains in the spec.
  const variant = ((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16);
  return `wf-${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Resolve only immutable completed workflow authority, never a client revision. */
export function completedContinuationSource(input: {
  readonly repo: StateRunDurabilityRepository;
  readonly sourceRunId: string;
  readonly repoPath: string;
  readonly requestId: string;
  readonly requestDigest: string;
}): WorkflowContinuation {
  const { repo, sourceRunId } = input;
  const terminal = repo.getCurrentTerminalResult(sourceRunId);
  const intake = repo.getEffect(sourceRunId, "workflow.intake");
  const finalize = repo.getEffect(sourceRunId, "workflow.finalize");
  if (terminal?.status !== "completed" || intake?.outcome !== "committed" || finalize?.outcome !== "committed") {
    throw new TypeError("Continue requires a completed verified Goal result.");
  }
  const intakeEvidence = readWorkflowStepEvidence(intake);
  const spec = intakeEvidence.spec as WorkflowSpec | undefined;
  if (spec === undefined || spec.runId !== sourceRunId || typeof spec.repoPath !== "string"
    || repositoryKey(spec.repoPath) !== repositoryKey(input.repoPath)
    || intakeEvidence.specDigest !== computeSpecDigest(spec) || intake.intentDigest !== intakeEvidence.specDigest) {
    throw new TypeError("The source Goal spec is missing, changed, or belongs to another repository.");
  }
  const finalized = readWorkflowStepEvidence(finalize);
  const result = finalized.finalize;
  const patch = finalized.artifacts?.find(artifact => artifact.role === "patch");
  const commit = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
  const digest = /^sha256:[0-9a-f]{64}$/u;
  if (result === undefined || !commit.test(result.headCommit ?? "") || !commit.test(result.treeHash ?? "")
    || !commit.test(spec.baseCommit) || !digest.test(result.sealDigest ?? "")
    || patch?.step.runId !== sourceRunId || !digest.test(patch?.digest ?? "")) {
    throw new TypeError("The source Goal has no valid verified snapshot to continue.");
  }
  const prior = spec.continuationOf;
  const earlierCost = prior === undefined ? 0 : prior.previousCostUsd;
  if (prior !== undefined && (typeof prior.seriesRootRunId !== "string"
    || (earlierCost !== null && (!Number.isFinite(earlierCost) || earlierCost < 0)))) {
    throw new TypeError("The source Goal continuation history is invalid.");
  }
  const usage = terminal.usage;
  const sourceCost = usage !== null && usage.costKnown !== false && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
    ? usage.costUsd : null;
  const totalCost = sourceCost === null || earlierCost === null ? null : earlierCost + sourceCost;
  return {
    sourceRunId, sourceSpecDigest: intakeEvidence.specDigest!, sourceBaseCommit: spec.baseCommit,
    sourceHeadCommit: result.headCommit!, sourceTreeHash: result.treeHash!, sourcePatchDigest: patch!.digest,
    sourceSealDigest: result.sealDigest!, seriesRootRunId: prior?.seriesRootRunId ?? sourceRunId,
    requestId: input.requestId, requestDigest: input.requestDigest,
    previousCostUsd: totalCost !== null && Number.isFinite(totalCost) ? totalCost : null,
    ...(usage?.costEstimated === true || prior?.previousCostEstimated === true ? { previousCostEstimated: true } : {}),
    sourceUsage: usage,
  };
}

/**
 * M5 Phase 4 — pure step-id and projection helpers for the verified-change
 * workflow controller.
 *
 * Everything in this module is a pure function over the frozen contract
 * vocabulary (`WORKFLOW_STEP_IDS`) and durable `run_effects` rows. The
 * controller and the status projection both derive step/stage state from
 * here so there is exactly one interpretation of the durable rows.
 *
 * Step-id grammar (frozen in contracts/run-contracts.ts):
 *   - `workflow.<stage>`            first attempt of a pipeline stage
 *   - `workflow.<stage>#N`          Nth attempt (N >= 2); run_effects
 *                                   outcomes are sticky per (run_id, step_id),
 *                                   so a retried stage always gets a NEW id.
 *   - `workflow.verify.cmd.<i>`     verification command fan-out (1-based)
 *   - `workflow.verify.agent`       the adversarial verification agent spawn
 *   both verify forms accept the same `#N` attempt suffix.
 */

import { createHash } from "node:crypto";

import {
  WORKFLOW_STEP_IDS,
  WORKFLOW_STEP_PREREQUISITES,
  type RunArtifactPointer,
  type WorkflowStepId,
  type WorkflowStepStatus,
} from "../../contracts/run-contracts.js";
import type { DurableRunEffect } from "../../state/run-durability.js";
import type { VerifiedChangeCommandRecord } from "../../workflow/evidence-record.js";

export const WORKFLOW_VERIFY_COMMAND_PREFIX = "workflow.verify.cmd." as const;
export const WORKFLOW_VERIFY_AGENT_BASE = "workflow.verify.agent" as const;

export type WorkflowStepRole = "stage" | "verify_command" | "verify_agent";

export interface ParsedWorkflowStepId {
  readonly stage: WorkflowStepId;
  readonly attempt: number;
  readonly role: WorkflowStepRole;
  /** 1-based index into the spec's requiredVerification list. */
  readonly commandIndex?: number;
}

function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError(`workflow step attempt must be >= 1, got ${attempt}`);
  }
}

function attemptSuffix(attempt: number): string {
  assertAttempt(attempt);
  return attempt === 1 ? "" : `#${attempt}`;
}

/** `workflow.implement`, `workflow.implement#2`, ... */
export function stageStepId(stage: WorkflowStepId, attempt: number): string {
  return `${stage}${attemptSuffix(attempt)}`;
}

/** `workflow.verify.cmd.3`, `workflow.verify.cmd.3#2`, ... (1-based index). */
export function verifyCommandStepId(index: number, attempt: number): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError(`verify command index must be >= 1, got ${index}`);
  }
  return `${WORKFLOW_VERIFY_COMMAND_PREFIX}${index}${attemptSuffix(attempt)}`;
}

/** `workflow.verify.agent`, `workflow.verify.agent#2`, ... */
export function verifyAgentStepId(attempt: number): string {
  return `${WORKFLOW_VERIFY_AGENT_BASE}${attemptSuffix(attempt)}`;
}

export function parseWorkflowStepId(
  stepId: string,
): ParsedWorkflowStepId | undefined {
  let base = stepId;
  let attempt = 1;
  const hash = stepId.lastIndexOf("#");
  if (hash >= 0) {
    const suffix = stepId.slice(hash + 1);
    if (!/^[0-9]+$/.test(suffix)) return undefined;
    attempt = Number.parseInt(suffix, 10);
    if (!Number.isSafeInteger(attempt) || attempt < 2) return undefined;
    base = stepId.slice(0, hash);
  }
  if (base === WORKFLOW_VERIFY_AGENT_BASE) {
    return { stage: "workflow.verify", attempt, role: "verify_agent" };
  }
  if (base.startsWith(WORKFLOW_VERIFY_COMMAND_PREFIX)) {
    const rest = base.slice(WORKFLOW_VERIFY_COMMAND_PREFIX.length);
    if (!/^[0-9]+$/.test(rest)) return undefined;
    const commandIndex = Number.parseInt(rest, 10);
    if (!Number.isSafeInteger(commandIndex) || commandIndex < 1) {
      return undefined;
    }
    return {
      stage: "workflow.verify",
      attempt,
      role: "verify_command",
      commandIndex,
    };
  }
  if ((WORKFLOW_STEP_IDS as readonly string[]).includes(base)) {
    return { stage: base as WorkflowStepId, attempt, role: "stage" };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Content-derived idempotency keys (D3)
// ---------------------------------------------------------------------------

function sha256Key(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** The intake key IS the canonical spec digest — the spec's durable identity. */
export function intakeIdempotencyKey(specDigest: string): string {
  return specDigest;
}

/** Deterministic worktree pointer: `slug@baseCommit`. */
export function worktreeIdempotencyKey(
  slug: string,
  baseCommit: string,
): string {
  return `${slug}@${baseCommit}`;
}

/** sha256(script + treeHash) — same tree + same script = same command. */
export function verifyCommandIdempotencyKey(
  script: string,
  treeHash: string,
): string {
  return sha256Key("m5.verify.cmd", [script, treeHash]);
}

/** sha256(patchDigest + baseCommit) — same patch onto the same base. */
export function finalizeIdempotencyKey(
  patchDigest: string,
  baseCommit: string,
): string {
  return sha256Key("m5.finalize", [patchDigest, baseCommit]);
}

// ---------------------------------------------------------------------------
// Effect evidence — the single serialized shape the controller writes and
// every projection reads back
// ---------------------------------------------------------------------------

export interface WorkflowChildEvidence {
  readonly childRunId: string;
  readonly status: string;
  readonly finalMessage?: string;
  /**
   * Reconciled actual usage of the child's own admissions (absent =
   * honestly unknown; reserved amounts are never reported as spent).
   */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costUsd: number;
  };
  /** Child reservations held unknown — noted, never summed into `usage`. */
  readonly usageHeldUnknown?: number;
}

export interface WorkflowReviewEvidence {
  readonly blockerCount: number;
  readonly findingCount: number;
  readonly overallCorrectness: string;
  readonly overallConfidenceScore: number;
  readonly blockers: readonly string[];
  readonly nonBlockingFindings: readonly string[];
  readonly reviewerModel: string;
}

export interface WorkflowFinalizeEvidence {
  readonly headCommit: string;
  readonly treeHash: string;
  readonly sealDigest?: string;
  readonly baseMovement: string;
  readonly conflictFiles?: readonly string[];
  readonly recordDigest?: string;
}

export interface WorkflowStepEvidence {
  readonly stage?: WorkflowStepId;
  readonly attempt?: number;
  readonly spec?: unknown;
  readonly specDigest?: string;
  readonly worktree?: {
    readonly slug: string;
    readonly branch: string;
    readonly path: string;
    readonly baseCommit: string;
    readonly created: boolean;
  };
  readonly child?: WorkflowChildEvidence;
  readonly command?: VerifiedChangeCommandRecord;
  readonly excerpts?: { readonly stdout: string; readonly stderr: string };
  readonly verdict?: string;
  readonly review?: WorkflowReviewEvidence;
  readonly finalize?: WorkflowFinalizeEvidence;
  readonly artifacts?: readonly RunArtifactPointer[];
  readonly failure?: { readonly reason: string; readonly message?: string };
}

export function readWorkflowStepEvidence(
  effect: DurableRunEffect,
): WorkflowStepEvidence {
  const evidence = effect.evidence;
  if (
    evidence !== null &&
    typeof evidence === "object" &&
    !Array.isArray(evidence)
  ) {
    return evidence as WorkflowStepEvidence;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Stage projection over durable run_effects rows
// ---------------------------------------------------------------------------

export interface WorkflowStageProjection {
  readonly stage: WorkflowStepId;
  /** Aggregated status of the LATEST attempt ("pending" when never begun). */
  readonly status: WorkflowStepStatus;
  /** Highest attempt number recorded for the stage (0 = never begun). */
  readonly attempts: number;
  /** The representative step id of the latest attempt (base id when pending). */
  readonly latestStepId: string;
  /** Machine verdict where the stage has one (verify/review). */
  readonly verdict?: string;
  /**
   * Committed stages only: whether the stage's in-evidence verdicts pass
   * (verification exit codes + agent VERDICT; review blocker count).
   * `undefined` until the stage commits; non-verdict stages commit as `true`.
   */
  readonly verdictPassed?: boolean;
  readonly artifacts: readonly RunArtifactPointer[];
}

interface ParsedRow {
  readonly effect: DurableRunEffect;
  readonly parsed: ParsedWorkflowStepId;
}

function aggregateStatus(rows: readonly ParsedRow[]): WorkflowStepStatus {
  if (rows.some((row) => row.effect.outcome === undefined)) return "running";
  if (rows.some((row) => row.effect.outcome === "unknown_outcome")) {
    return "unknown_outcome";
  }
  if (rows.some((row) => row.effect.outcome === "cancelled")) return "cancelled";
  if (rows.some((row) => row.effect.outcome === "failed")) return "failed";
  return "committed";
}

function commandPassed(evidence: WorkflowStepEvidence): boolean {
  const record = evidence.command;
  return record !== undefined && record.exitCode === 0 && !record.timedOut;
}

/** Derive one stage's projection from ALL of the run's effect rows. */
export function deriveStageProjection(
  stage: WorkflowStepId,
  effects: readonly DurableRunEffect[],
): WorkflowStageProjection {
  const rows: ParsedRow[] = [];
  for (const effect of effects) {
    const parsed = parseWorkflowStepId(effect.stepId);
    if (parsed !== undefined && parsed.stage === stage) {
      rows.push({ effect, parsed });
    }
  }
  if (rows.length === 0) {
    return {
      stage,
      status: "pending",
      attempts: 0,
      latestStepId: stage,
      artifacts: [],
    };
  }
  const attempts = Math.max(...rows.map((row) => row.parsed.attempt));
  const latest = rows.filter((row) => row.parsed.attempt === attempts);
  let status = aggregateStatus(latest);

  const artifacts: RunArtifactPointer[] = [];
  for (const row of latest) {
    const evidence = readWorkflowStepEvidence(row.effect);
    if (Array.isArray(evidence.artifacts)) artifacts.push(...evidence.artifacts);
  }

  let verdict: string | undefined;
  let verdictPassed: boolean | undefined;
  let latestStepId = latest[latest.length - 1].effect.stepId;

  if (stage === "workflow.verify") {
    const agent = latest.find((row) => row.parsed.role === "verify_agent");
    const commands = latest.filter(
      (row) => row.parsed.role === "verify_command",
    );
    // The verify stage is only complete once its agent row exists; committed
    // command rows without the agent are still mid-stage.
    if (status === "committed" && agent === undefined) status = "running";
    const commandsPassed =
      commands.length > 0 &&
      commands.every(
        (row) =>
          row.effect.outcome === "committed" &&
          commandPassed(readWorkflowStepEvidence(row.effect)),
      );
    const agentVerdict =
      agent === undefined
        ? undefined
        : readWorkflowStepEvidence(agent.effect).verdict;
    verdict = agentVerdict ?? (status === "committed" ? "FAIL" : undefined);
    if (status === "committed") {
      verdictPassed = commandsPassed && agentVerdict === "PASS";
    }
    if (agent !== undefined) latestStepId = agent.effect.stepId;
    else latestStepId = verifyAgentStepId(attempts);
  } else if (stage === "workflow.review") {
    if (status === "committed") {
      const review = readWorkflowStepEvidence(latest[0].effect).review;
      verdictPassed = review !== undefined && review.blockerCount === 0;
      verdict = verdictPassed ? "approved" : "rejected";
    }
  } else if (status === "committed") {
    verdictPassed = true;
  }

  return {
    stage,
    status,
    attempts,
    latestStepId,
    ...(verdict !== undefined ? { verdict } : {}),
    ...(verdictPassed !== undefined ? { verdictPassed } : {}),
    artifacts,
  };
}

/** Projection of every pipeline stage, in fixed pipeline order. */
export function deriveAllStageProjections(
  effects: readonly DurableRunEffect[],
): ReadonlyMap<WorkflowStepId, WorkflowStageProjection> {
  const map = new Map<WorkflowStepId, WorkflowStageProjection>();
  for (const stage of WORKFLOW_STEP_IDS) {
    map.set(stage, deriveStageProjection(stage, effects));
  }
  return map;
}

/**
 * A stage may begin only when every prerequisite stage is committed AND its
 * in-evidence verdicts pass (frozen contract semantics).
 */
export function stagePrerequisitesMet(
  stage: WorkflowStepId,
  effects: readonly DurableRunEffect[],
): boolean {
  return WORKFLOW_STEP_PREREQUISITES[stage].every((prerequisite) => {
    const projection = deriveStageProjection(prerequisite, effects);
    return (
      projection.status === "committed" && projection.verdictPassed !== false
    );
  });
}

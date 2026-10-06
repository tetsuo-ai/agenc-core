/**
 * M5 Phase 4 — the durable verified-change workflow controller.
 *
 * Drives the fixed pipeline
 *   intake → worktree → plan → implement → verify → review → finalize
 * as durable effects over the EXISTING M3/M4 stack:
 *
 * - The workflow run IS a daemon agent run (D1). Its canonical journal is
 *   the run's rollout store; the controller writes effect intents/results
 *   exclusively through the injected {@link WorkflowJournalWriter}, whose
 *   contract is journal-append-then-project (mirroring
 *   `RolloutStore.recordEffectEvent`). The controller NEVER writes effect
 *   rows around the journal.
 * - No new tables (D2). The frozen WorkflowSpec persists as the
 *   `workflow.intake` effect's evidence; step state is a projection of
 *   `run_effects`; the worktree pointer is the deterministic slug plus the
 *   `workflow.worktree` effect evidence; artifact pointers ride evidence.
 * - Effect classification (D3): intake/worktree/finalize and each
 *   verification command are `idempotent` with content-derived idempotency
 *   keys; plan/implement/review and the verification agent are
 *   `side-effecting` spawns. Recovery: idempotent intent-without-outcome
 *   re-executes under the same key; side-effecting intent-without-outcome
 *   ADOPTS the child's durable terminal result (never respawns); an
 *   unknowable child marks the effect `unknown_outcome` and the run
 *   terminates `unknown_outcome` / `unknown_outcome_effect`.
 * - Approvals resolve at intake (D5): a mid-pipeline
 *   `AdmissionDeniedError` with decision `approval_required` terminates the
 *   run `failed`/`approval_required`. There is no parking.
 * - ONE terminal choke point (D6): `completed` demands all stages
 *   committed, every required command exit 0, verification agent
 *   `VERDICT: PASS`, a reviewer with zero blockers, a self-validated
 *   evidence record, and a sealed ledger. `recordTerminalResult` runs on
 *   every exit path, including resume.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderWaitScope, type ProviderWait } from "../../recovery/provider-wait.js";
import { workflowApprovalFailureCause } from "../../permissions/approval-failure.js";

import {
  type AdmissionKind,
  type RunArtifactPointer,
  type RunStepIdentity,
  type RunTerminalStatus,
  type RunUsageTotals,
  type WorkflowSpec,
  type WorkflowContinuation,
  type WorkflowStepId,
  type WorkflowStopReason,
} from "../../contracts/run-contracts.js";
import {
  AdmissionDeniedError,
  type ExecutionAdmissionClient,
} from "../../budget/admission-client.js";
import type {
  AdmissionLease,
  AdmissionUsage,
} from "../../budget/admission-types.js";
import {
  hitM5WorkflowFailpoint,
  M5WorkflowFailpointError,
  type M5WorkflowFailpoint,
} from "../../durability/failpoints.js";
import {
  canonicalizeJson,
  sha256Digest,
} from "../../eval-contract/canonical-json.js";
import type { Sha256Digest } from "../../eval-contract/types.js";
import type {
  DurableRunEffect,
  StateRunDurabilityRepository,
} from "../../state/run-durability.js";
import type { ToolRecoveryCategory } from "../../tools/types.js";
import type { WorktreeHandle } from "../../agents/worktree.js";
import {
  assembleVerifiedChangeRecord,
  computeSpecDigest,
  type VerifiedChangeCommandRecord,
  type VerifiedChangeRecord,
  type VerifiedChangeReviewRecord,
  type VerifiedChangeStepRecord,
} from "../../workflow/evidence-record.js";
import {
  extractBlockers,
  ReviewInvocationError,
  ReviewParseError,
  runIndependentReview,
  type ReviewerInvoker,
} from "../../workflow/independent-review.js";
import type { ReviewOutput } from "../../session/review.js";
import type { PermissionMode } from "../../permissions/types.js";
import {
  formatVerificationCommand,
  formatVerificationResult,
  isTrivialVerificationCommand,
  plannedVerification,
  parseVerificationVerdict,
  type WorkflowCommandRunner,
} from "../../workflow/verification.js";
import {
  mintSealedEvidenceProof,
  workflowWorktreeSlug,
  type BaseMovementCheck,
  type BaseState,
  type CancelledRunProof,
  type EvidenceArtifactSink,
  type ExportedPatchArtifacts,
  type SealedEvidenceProof,
} from "../../workflow/worktree-lifecycle.js";
import {
  decodeWorkflowReviewTerminal,
  encodeWorkflowReviewTerminal,
  recordWorkflowChildTerminal,
} from "./child-terminals.js";
import { PLAN_BLOCKED_INSTRUCTIONS, parsePlanBlockedResponse, readPlanBlocked } from "./plan-blocked.js";
import { boundedWorkflowDiagnostic } from "../../workflow/diagnostics.js";
import { projectWorkflowStatus, type WorkflowRunStatus } from "./status-projection.js";
import { isWorkflowChildStopReason, workflowAdmissionStopReason, workflowStopMessage, type WorkflowChildStopReason } from "./stop-reasons.js";
import { WORKFLOW_PAUSE_PREFIX, workflowControlState } from "./control-state.js";
import { AgenCDaemonWorkflowControlError } from "./run-control-service.js";
import type { RunPauseParams, RunResumeParams, RunWorkflowControlState, RunWorkflowRuntimeFailure } from "../protocol/index.js";
import { completedContinuationSource, continuationRunId } from "./continuation.js";
import {
  deriveStageProjection,
  finalizeIdempotencyKey,
  intakeIdempotencyKey,
  parseWorkflowStepId,
  readWorkflowStepEvidence,
  stagePrerequisitesMet,
  stageStepId,
  verifyAgentStepId,
  verifyCommandIdempotencyKey,
  verifyCommandStepId,
  worktreeIdempotencyKey,
  type WorkflowStepEvidence,
} from "./steps.js";

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

export interface WorkflowEffectEventRef {
  readonly eventId: string;
  readonly sequence: number;
}

/**
 * The run's canonical journal handle. Implementations MUST fsync-append the
 * effect event to the run's rollout journal BEFORE projecting it into the
 * durability repository (the `RolloutStore.recordEffectEvent` contract);
 * test writers assign sequences from a counter and call the repository
 * directly, which preserves the same observable projection semantics.
 */
export interface WorkflowRunJournal {
  readonly runId: string;
  /** Current Session authority, absent when the owned Session is unavailable. */
  readonly effectivePermissionMode?: PermissionMode;
  /** Subordinate daemon session identity — never substitutes for runId. */
  readonly sessionId: string;
  /** Current durable lifecycle epoch (initial epoch ensured on open). */
  readonly epoch: number;
  appendIntent(input: {
    readonly stepId: string;
    readonly callId?: string;
    readonly toolName: string;
    readonly recoveryCategory: ToolRecoveryCategory;
    readonly idempotencyKey?: string;
    readonly intentDigest: string;
    readonly childRunId?: string;
    readonly intentAt: string;
  }): WorkflowEffectEventRef;
  appendResult(input: {
    readonly stepId: string;
    readonly outcome: "committed" | "failed" | "cancelled";
    readonly resultDigest?: string;
    readonly evidence?: unknown;
    readonly completedAt: string;
  }): WorkflowEffectEventRef;
  appendUnknown(input: {
    readonly stepId: string;
    readonly reason: string;
    readonly evidence?: unknown;
    readonly observedAt: string;
  }): WorkflowEffectEventRef;
  /**
   * Journal the terminal event; its sequence becomes the replay upper bound.
   * The optional intent (additive, Phase 5) lets a real rollout-backed
   * journal emit a faithful `run_terminal` event; test journals ignore it.
   */
  appendTerminal(intent?: WorkflowTerminalJournalIntent): WorkflowEffectEventRef;
  /** Suspend only after every effect has durably settled. */
  appendSuspended?(input: { readonly suspendedAt: string }): WorkflowEffectEventRef;
  close(): Promise<void>;
}

/** Terminal facts available when the terminal journal event is allocated. */
export interface WorkflowTerminalJournalIntent {
  readonly status: RunTerminalStatus;
  readonly stopReason: WorkflowStopReason | null;
  readonly finalMessage: string | null;
  readonly usage: RunUsageTotals | null;
  readonly finishedAt: string;
}

/**
 * Optional per-run resolution for the durability repository (additive,
 * Phase 5): the daemon backs each run with the state database of the run's
 * own repository path, so the journal projection and the controller's reads
 * stay in ONE database. Callers that ignore the context (tests, single-project
 * daemons) keep the Phase 4 behavior.
 */
export interface WorkflowDurabilityContext {
  readonly runId?: string;
  readonly repoPath?: string;
}

/**
 * The frozen spec's execution policy, applied to the run's bootstrapped
 * session (Phase 6): the session-backed journal writer mirrors the
 * background-agent runner (`--permission-mode`/`--dangerously-bypass-approvals-and-sandbox` bootstrap argv +
 * `installUnattendedPermissionPolicy`) so children never run under the
 * daemon's default policy. Resumed runs re-resolve it from the durable
 * intake spec.
 */
export interface WorkflowRunSessionPolicy {
  readonly permissionMode: WorkflowSpec["permissionMode"];
  readonly lightMode?: boolean;
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  /**
   * The model and provider the run was started with. The run's own session
   * is bootstrapped like any other agent, which means it takes the daemon's
   * default unless it is told otherwise: without these, `run start --model`
   * was accepted, frozen into the spec, and then ignored.
   */
  readonly model?: string;
  readonly provider?: string;
}

export interface WorkflowJournalWriter {
  /** Read only. Never opens a Session or substitutes a frozen requested mode. */
  currentPermissionMode?(runId: string): PermissionMode | undefined;
  open(
    runId: string,
    context?: {
      readonly repoPath?: string;
      readonly policy?: WorkflowRunSessionPolicy;
      /** In-memory bootstrap authority only, never journal evidence. */
      readonly envOverrides?: Readonly<Record<string, string>>;
      /** Explicit authority to resume this exact user-paused checkpoint. */
      readonly resumeSuspensionId?: string;
    },
  ): Promise<WorkflowRunJournal>;
}

export type WorkflowSpawnKind = "plan" | "implement" | "verify_agent" | "review";

export interface WorkflowChildOutcome {
  readonly status: RunTerminalStatus;
  readonly stopReason?: WorkflowChildStopReason;
  readonly finalMessage: string | null;
  /**
   * Reconciled actual usage for the child's own admissions (null = nothing
   * reconciled / honestly unknown). Already charged against the budget by
   * the child's own reservations — reported into the run's usage rollup,
   * never re-reconciled against the parent spawn reservation.
   */
  readonly usage: RunUsageTotals | null;
  /**
   * Admission reservations of the child whose spend is unknowable
   * (`held_unknown`); surfaced as a count, NEVER summed into `usage`.
   */
  readonly usageHeldUnknownCount?: number;
}

export type WorkflowChildInspection =
  | { readonly state: "terminal"; readonly outcome: WorkflowChildOutcome }
  | { readonly state: "live"; readonly outcome: Promise<WorkflowChildOutcome> }
  | { readonly state: "unknown" };

/** Spawn seam for the side-effecting pipeline stages. */
export interface WorkflowAgentSpawner {
  spawn(input: {
    readonly kind: WorkflowSpawnKind;
    readonly childRunId: string;
    readonly spec: WorkflowSpec;
    readonly worktreePath: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }): Promise<WorkflowChildOutcome>;
  /** D3 adoption: durable inspection of a previously dispatched child run. */
  inspect(childRunId: string): Promise<WorkflowChildInspection>;
}

/** Worktree/git seam over the Phase 2 worktree-lifecycle library. */
export interface WorkflowWorktreeBroker {
  /** The optional context (additive, Phase 5) routes the daemon adapter to the run's session broker. */
  captureBaseState(
    repoPath: string,
    context?: { readonly runId?: string },
  ): Promise<BaseState>;
  provision(
    spec: Pick<WorkflowSpec, "runId" | "repoPath" | "baseCommit" | "continuationOf">,
  ): Promise<WorktreeHandle>;
  validateContinuation?(input: { readonly runId: string; readonly repoPath: string; readonly source: WorkflowContinuation }): Promise<void>;
  exportPatch(input: {
    readonly handle: WorktreeHandle;
    readonly baseCommit: string;
    readonly step: RunStepIdentity;
    readonly sink: EvidenceArtifactSink;
  }): Promise<ExportedPatchArtifacts>;
  checkBaseMovement(input: {
    readonly spec: Pick<WorkflowSpec, "runId" | "repoPath" | "baseCommit">;
    readonly patchBytes: Uint8Array;
  }): Promise<BaseMovementCheck>;
  cleanup(input: {
    readonly proof: SealedEvidenceProof;
    readonly handle: WorktreeHandle;
    /** The delivered snapshot, pinned under a durable ref before the
     *  worktree branch — its only other name — is deleted. */
    readonly headCommit: string;
  }): Promise<void>;
  /** Remove a cancelled run's worktree and branch; nothing is pinned. */
  discard(input: {
    readonly proof: CancelledRunProof;
    readonly handle: WorktreeHandle;
  }): Promise<void>;
}

export interface WorkflowEvidenceLedgerHead {
  readonly eventCount: number;
  readonly headEventDigest: Sha256Digest;
  readonly sealed: boolean;
}

/**
 * Narrow per-run evidence ledger seam the controller drives. The daemon
 * adapter backs it with the eval-contract evidence ledger
 * (`appendEvidenceEvent` with `artifact.recorded` payloads under
 * `<agencHome>/run-evidence/<runId>/`); tests use an in-memory ledger.
 * `recordArtifact` and `seal` must be idempotent for crash-resume.
 */
export interface WorkflowEvidenceLedger extends EvidenceArtifactSink {
  head(): WorkflowEvidenceLedgerHead;
  readArtifact(pointer: RunArtifactPointer): Promise<Uint8Array>;
  seal(sealedAt: string): Promise<{ readonly sealDigest: string }>;
  /** Persist the final record OUTSIDE the sealed ledger (best-effort). */
  persistRecord?(record: VerifiedChangeRecord): Promise<void>;
}

export interface VerifiedChangeWorkflowControllerDeps {
  readonly durability: (
    context?: WorkflowDurabilityContext,
  ) => StateRunDurabilityRepository;
  readonly journal: WorkflowJournalWriter;
  readonly admission: (input: {
    readonly runId: string;
    readonly sessionId: string;
    readonly workspaceId?: string;
    readonly spec: WorkflowSpec;
  }) => ExecutionAdmissionClient;
  readonly worktrees: WorkflowWorktreeBroker;
  readonly commands: WorkflowCommandRunner;
  readonly spawner: WorkflowAgentSpawner;
  readonly reviewer: ReviewerInvoker;
  /**
   * The model the daemon would give a new session, used as the reviewer model
   * when the caller pins neither `reviewerModel` nor `model`. Without it the
   * spec froze a placeholder that reached the provider as a model id (desktop
   * soak, 2026-09-06: a 404 on `default-reviewer` ended a goal in
   * `unknown_outcome` after every other stage had committed).
   */
  readonly defaultReviewerModel?: () => string | undefined;
  readonly evidenceLedger: (spec: WorkflowSpec) => Promise<WorkflowEvidenceLedger>;
  readonly warn: (message: string) => void;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
}

// ---------------------------------------------------------------------------
// Public parameter/result types
// ---------------------------------------------------------------------------

export interface WorkflowStartParams {
  readonly continuation?: { readonly sourceRunId: string; readonly requestId: string };
  readonly goal: string;
  readonly lightMode?: boolean;
  readonly repoPath: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reviewerModel?: string;
  readonly permissionMode?: WorkflowSpec["permissionMode"];
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  readonly budget?: WorkflowSpec["budget"];
  readonly requiredVerification: readonly {
    readonly label: string;
    readonly script: string;
  }[];
  readonly maxImplementAttempts?: number;
  readonly workspaceId?: string;
  /** Deterministic run id (tests / dispatcher-minted ids). */
  readonly runId?: string;
}

export interface WorkflowStartResult {
  readonly replayed?: boolean;
  readonly continuationOf?: WorkflowContinuation;
  readonly runId: string;
  readonly lightMode?: boolean;
  readonly requestedPermissionMode: WorkflowSpec["permissionMode"];
  readonly effectivePermissionMode?: PermissionMode;
  readonly specDigest: Sha256Digest;
  readonly baseCommit: string;
  readonly baseDirty: WorkflowSpec["baseDirty"];
}

/** Intake failed before the pipeline began; the terminal result is durable. */
/** The journaled failure message of a non-committed effect, as a suffix, or "". */
function describeEffectFailure(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const failure = (result as { readonly failure?: unknown }).failure;
  if (typeof failure !== "object" || failure === null) return "";
  const message = (failure as { readonly message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? `: ${message}` : "";
}

export class WorkflowIntakeError extends Error {
  constructor(
    readonly runId: string,
    readonly stopReason: WorkflowStopReason | null,
    message: string,
  ) {
    super(`workflow ${runId} intake failed: ${message}`);
    this.name = "WorkflowIntakeError";
  }
}

const DEFAULT_MAX_IMPLEMENT_ATTEMPTS = 2;
const DEFAULT_PERMISSION_MODE: WorkflowSpec["permissionMode"] = "acceptEdits";

export function resolveWorkflowPermissionMode(
  requested: WorkflowSpec["permissionMode"] | undefined,
): WorkflowSpec["permissionMode"] {
  return requested ?? DEFAULT_PERMISSION_MODE;
}
/** Bounded per-stage retry budget for stage-level (non-verdict) failures. */
const MAX_STAGE_ATTEMPTS = 2;
const ZERO_ESTIMATE = {
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxCostUsd: 0,
} as const;
const EVIDENCE_MESSAGE_LIMIT = 20_000;

// ---------------------------------------------------------------------------
// Internal control flow
// ---------------------------------------------------------------------------

/** Outcome of closing a run that no live pipeline is driving (see cancelDetached). */
export type WorkflowDetachedCancelOutcome =
  | "live"
  | "not_a_workflow"
  | "already_terminal"
  | "cancelled"
  | "not_recorded";

/** Event id prefix for terminals recorded without a session journal. */
const WORKFLOW_DETACHED_TERMINAL_EVENT_PREFIX = "workflow-detached-terminal:";

interface WorkflowTerminalIntent {
  readonly status: RunTerminalStatus;
  readonly stopReason: WorkflowStopReason | null;
  readonly finalMessage: string | null;
}

/** Planned pipeline stop; the single carrier into the terminal choke point. */
class WorkflowHaltError extends Error {
  constructor(readonly terminal: WorkflowTerminalIntent) {
    super(
      `workflow halt: ${terminal.status}` +
        (terminal.stopReason === null ? "" : ` (${terminal.stopReason})`),
    );
    this.name = "WorkflowHaltError";
  }
}

class WorkflowPausedError extends Error {}

/** Gates the terminal choke point demands before it will record `completed`. */
interface CompletedGates {
  readonly record: VerifiedChangeRecord;
  readonly allCommandsPassed: boolean;
  readonly verificationVerdict: string | undefined;
  readonly reviewBlockerCount: number;
  readonly ledgerSealed: boolean;
}

interface EffectExecution {
  readonly outcome: "committed" | "failed" | "cancelled";
  readonly evidence: WorkflowStepEvidence;
  /** Usage reconciled against THIS step's admission reservation. */
  readonly usage?: AdmissionUsage;
  /**
   * Usage already reconciled at its durable source (the child run's own
   * admission reservations): accumulated into the run's usage rollup only,
   * never re-reconciled against this step's reservation — reconciling it
   * here would double-charge the shared allocation scopes.
   */
  readonly rollupUsage?: AdmissionUsage;
}

interface EffectStepPlan {
  readonly stepId: string;
  readonly stage: WorkflowStepId;
  readonly attempt: number;
  readonly toolName: string;
  readonly kind: AdmissionKind;
  readonly recoveryCategory: "idempotent" | "side-effecting";
  readonly idempotencyKey?: string;
  readonly intentDigest: string;
  readonly childRunId?: string;
  readonly estimate: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxCostUsd: number | null;
  };
  readonly model?: string;
  readonly provider?: string;
  readonly beforeExecuteFailpoint?: M5WorkflowFailpoint;
  readonly beforeCommitFailpoints?: readonly M5WorkflowFailpoint[];
  readonly afterCommitFailpoint?: M5WorkflowFailpoint;
  readonly execute: (signal: AbortSignal) => Promise<EffectExecution>;
  /**
   * D3 adoption for side-effecting steps: resolve a previously dispatched
   * child's durable outcome. `undefined` = unknowable.
   */
  readonly adopt?: (
    existing: DurableRunEffect,
  ) => Promise<EffectExecution | undefined>;
}

interface EffectStepResult {
  readonly outcome: "committed" | "failed" | "cancelled" | "unknown_outcome";
  readonly evidence: WorkflowStepEvidence;
  readonly replayed: boolean;
}

interface RunContext {
  readonly runId: string;
  readonly spec: WorkflowSpec;
  readonly specDigest: Sha256Digest;
  readonly repo: StateRunDurabilityRepository;
  readonly journal: WorkflowRunJournal;
  readonly admission: ExecutionAdmissionClient;
  readonly startedAt: string;
  ledger?: WorkflowEvidenceLedger;
  handle?: WorktreeHandle;
  planText?: string;
  plannedChecks?: WorkflowSpec["requiredVerification"];
  verification?: {
    readonly records: readonly VerifiedChangeCommandRecord[];
    readonly allPassed: boolean;
    readonly testResult: RunArtifactPointer;
  };
  verifyVerdict?: string;
  verifyExplicitVerdict?: boolean;
  /**
   * The verification agent's final message from the latest verify attempt,
   * read back from the committed child evidence so a resumed run carries it
   * too. Soak F73: without it the re-implement prompt said only
   * `Agent verdict: FAIL` and the implementer changed nothing, while the
   * second verifier re-derived the same defects from scratch.
   */
  verifyReport?: string;
  review?: VerifiedChangeReviewRecord;
  reviewNonBlocking?: readonly string[];
  export?: ExportedPatchArtifacts;
  usage: { input: number; output: number; cost: number; any: boolean };
  terminalized: boolean;
}

function truncate(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined) return undefined;
  return text.length > EVIDENCE_MESSAGE_LIMIT
    ? `${text.slice(0, EVIDENCE_MESSAGE_LIMIT)}…[truncated]`
    : text;
}

function failedStepMessage(summary: string, result: EffectStepResult): string {
  const detail = result.evidence.child?.finalMessage ?? result.evidence.failure?.message;
  return detail?.trim() ? `${summary}. ${boundedWorkflowDiagnostic(detail)}` : summary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class VerifiedChangeWorkflowController {
  readonly #deps: VerifiedChangeWorkflowControllerDeps;
  readonly #now: () => Date;
  readonly #newRunId: () => string;
  readonly #active = new Map<string, Promise<void>>();
  readonly #contexts = new Map<string, RunContext>();
  readonly #resuming = new Map<string, { suspensionId: string; promise: Promise<RunWorkflowControlState> }>();
  /** Includes starts waiting on bootstrap and stopped runs awaiting durable status. */
  readonly #repositoryOwners = new Map<string, string>();
  readonly #providerWaits = new Map<string, { stepId: string; scope: ProviderWaitScope }>();
  /** One bounded observation per stopped run; never an alternative terminal authority. */
  readonly #runtimeFailures = new Map<string, RunWorkflowRuntimeFailure>();
  readonly #continuationRequests = new Map<string, { digest: string; promise: Promise<WorkflowStartResult> }>();

  constructor(deps: VerifiedChangeWorkflowControllerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#newRunId = deps.newRunId ?? (() => `wf-${randomUUID()}`);
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }

  /**
   * Intake: freeze the spec against the captured base state, resolve
   * policy/budget through admission, and durably commit the intake effect.
   * Returns after the intake commit; the rest of the pipeline continues
   * asynchronously (track it with {@link awaitRun}).
   */
  async start(
    params: WorkflowStartParams,
    envOverrides?: Readonly<Record<string, string>>,
  ): Promise<WorkflowStartResult> {
    if (params.continuation === undefined) return this.#start(params, envOverrides);
    const request = params.continuation;
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(request.requestId) || !request.sourceRunId.trim()) {
      throw new TypeError("Continue requires a source Goal and a bounded request ID.");
    }
    if (params.runId !== undefined) throw new TypeError("A continuation run ID is assigned from its request ID.");
    if (!params.goal.trim() || !Number.isFinite(params.budget?.maxCostUsd) || params.budget!.maxCostUsd! <= 0
      || params.budget?.deadlineAt === undefined || !Number.isFinite(Date.parse(params.budget.deadlineAt))) {
      throw new TypeError("Continue requires a new goal, an explicit additional cost limit, and a deadline.");
    }
    const runId = continuationRunId(request.sourceRunId, request.requestId);
    const requestDigest = sha256Digest(canonicalizeJson(params));
    const pending = this.#continuationRequests.get(runId);
    if (pending !== undefined) {
      if (pending.digest !== requestDigest) throw new TypeError("This continuation request ID was already used with different instructions or limits.");
      return { ...await pending.promise, replayed: true };
    }
    const repo = this.#deps.durability({ runId, repoPath: params.repoPath });
    const previous = repo.getEffect(runId, "workflow.intake");
    if (previous !== undefined) {
      const evidence = readWorkflowStepEvidence(previous);
      const spec = evidence.spec as WorkflowSpec | undefined;
      if (previous.outcome !== "committed" || spec?.continuationOf?.requestDigest !== requestDigest
        || spec.runId !== runId || evidence.specDigest !== computeSpecDigest(spec)) {
        throw new TypeError("This continuation request ID is already recorded with different instructions or incomplete intake. Inspect its run before retrying.");
      }
      return { runId, specDigest: evidence.specDigest!, baseCommit: spec.baseCommit, baseDirty: spec.baseDirty,
        requestedPermissionMode: spec.permissionMode, lightMode: spec.lightMode === true,
        continuationOf: spec.continuationOf, replayed: true };
    }
    if (repo.currentEpoch(runId) !== undefined) {
      throw new TypeError("This continuation request already opened a run but did not commit intake. Inspect its run before creating another request.");
    }
    if (Date.parse(params.budget.deadlineAt) <= this.#now().getTime()) throw new TypeError("The continuation deadline must be in the future.");
    const source = completedContinuationSource({ repo: this.#deps.durability({ runId: request.sourceRunId }),
      sourceRunId: request.sourceRunId, repoPath: params.repoPath, requestId: request.requestId, requestDigest });
    const sourceIntake = this.#deps.durability({ runId: request.sourceRunId }).getEffect(request.sourceRunId, "workflow.intake")!;
    const sourceSpec = readWorkflowStepEvidence(sourceIntake).spec as WorkflowSpec;
    const continuationParams = params.lightMode === undefined
      ? { ...params, lightMode: sourceSpec.lightMode === true }
      : params;
    // Reserve the request before bootstrap can yield. The durable intake is
    // the retry authority once this short-lived promise is removed.
    const promise = this.#start({ ...continuationParams, runId }, envOverrides, source);
    this.#continuationRequests.set(runId, { digest: requestDigest, promise });
    try { return await promise; }
    finally { if (this.#continuationRequests.get(runId)?.promise === promise) this.#continuationRequests.delete(runId); }
  }

  async #start(
    params: WorkflowStartParams,
    envOverrides?: Readonly<Record<string, string>>,
    continuationOf?: WorkflowContinuation,
  ): Promise<WorkflowStartResult> {
    for (const command of params.requiredVerification) {
      if (isTrivialVerificationCommand(command.script)) {
        throw new TypeError(
          "required verification must test the goal, not a no-op or constant-output command; " +
          "for a new project, specify the tests, build, or smoke check the implementation will create",
        );
      }
    }
    const runId = params.runId ?? this.#newRunId();
    const repositoryKey = this.#repositoryKey(params.repoPath);
    const repo = this.#deps.durability({ runId, repoPath: params.repoPath });
    let owner = this.#repositoryOwners.get(repositoryKey);
    if (owner !== undefined && repo.getCurrentTerminalResult(owner) !== undefined) {
      this.#releaseRepository(owner);
      owner = undefined;
    }
    if (owner === undefined) {
      // A new request can arrive before the startup recovery sweep finishes.
      // Durable ownership also protects that interval and an interrupted run.
      owner = repo.listRunIdsWithStep("workflow.intake").find((candidate) => {
        if (repo.getCurrentTerminalResult(candidate) !== undefined) return false;
        const intake = repo.getEffect(candidate, "workflow.intake");
        const spec = intake === undefined ? undefined : readWorkflowStepEvidence(intake).spec as WorkflowSpec | undefined;
        return spec !== undefined && this.#repositoryKey(spec.repoPath) === repositoryKey;
      });
    }
    if (owner !== undefined) {
      throw new TypeError(`A Goal is already active for this repository (${owner}). Wait for it to finish or stop it before starting another Goal.`);
    }
    // No await before this reservation: two concurrent run.start calls cannot
    // both open sessions or buy separate budgets for the same repository.
    this.#repositoryOwners.set(repositoryKey, runId);
    let journal: WorkflowRunJournal | undefined;
    let admission: ExecutionAdmissionClient | undefined;
    let ctx: RunContext | undefined;
    try {
      journal = await this.#deps.journal.open(runId, {
        repoPath: params.repoPath,
        ...(envOverrides !== undefined ? { envOverrides } : {}),
        policy: {
          permissionMode: resolveWorkflowPermissionMode(params.permissionMode),
          ...(params.lightMode !== undefined ? { lightMode: params.lightMode } : {}),
          ...(params.unattendedAllow !== undefined
            ? { unattendedAllow: params.unattendedAllow }
            : {}),
          ...(params.unattendedDeny !== undefined
            ? { unattendedDeny: params.unattendedDeny }
            : {}),
          // The model the run was asked for, on start as well as on resume:
          // the session is bootstrapped from this policy, and without them it
          // takes the daemon's default no matter what the caller requested.
          ...(params.model !== undefined ? { model: params.model } : {}),
          ...(params.provider !== undefined ? { provider: params.provider } : {}),
        },
      });
      const base = await this.#deps.worktrees.captureBaseState(params.repoPath, {
        runId,
      });
      if (continuationOf !== undefined) {
        if (base.dirty || (base.baseCommit !== continuationOf.sourceBaseCommit && base.baseCommit !== continuationOf.sourceHeadCommit)) {
          throw new TypeError("The checkout changed since the source Goal. Continue from its unchanged clean base or its exact delivered commit.");
        }
        if (this.#deps.worktrees.validateContinuation === undefined) throw new TypeError("This runtime cannot validate a delivered Goal for continuation.");
        await this.#deps.worktrees.validateContinuation({ runId, repoPath: params.repoPath, source: continuationOf });
      }
      const spec = freezeWorkflowSpec(
        runId,
        params,
        base,
        this.#deps.defaultReviewerModel?.(),
        continuationOf,
      );
      const specDigest = computeSpecDigest(spec);
      admission = this.#deps.admission({
        runId,
        sessionId: journal.sessionId,
        ...(params.workspaceId !== undefined
          ? { workspaceId: params.workspaceId }
          : {}),
        spec,
      });
      ctx = {
        runId,
        spec,
        specDigest,
        repo,
        journal,
        admission,
        startedAt: this.#nowIso(),
        usage: { input: 0, output: 0, cost: 0, any: false },
        terminalized: false,
      };
      await this.#stageIntake(ctx);
    } catch (error) {
      try {
        if (error instanceof M5WorkflowFailpointError) throw error;
        const terminal =
          error instanceof WorkflowHaltError
            ? error.terminal
            : ({
                status: "failed",
                stopReason: null,
                finalMessage: `workflow intake error: ${errorMessage(error)}`,
              } satisfies WorkflowTerminalIntent);
        if (journal !== undefined) {
          ctx ??= this.#bareContext(runId, repo, journal);
          await this.#terminalize(ctx, terminal);
        }
        throw new WorkflowIntakeError(
          runId,
          terminal.stopReason,
          terminal.finalMessage ?? terminal.status,
        );
      } finally {
        if (journal !== undefined) await this.#closeJournal(ctx ?? this.#bareContext(runId, repo, journal));
        admission?.release?.();
        if (ctx?.terminalized === true || repo.getEffect(runId, "workflow.intake") === undefined) {
          this.#repositoryOwners.delete(repositoryKey);
        }
      }
    }
    const effectivePermissionMode = ctx.journal.effectivePermissionMode;
    const pipeline = this.#continue(ctx);
    this.#active.set(runId, pipeline);
    return {
      runId,
      lightMode: ctx.spec.lightMode === true,
      specDigest: ctx.specDigest,
      baseCommit: ctx.spec.baseCommit,
      baseDirty: ctx.spec.baseDirty,
      ...(ctx.spec.continuationOf !== undefined ? { continuationOf: ctx.spec.continuationOf } : {}),
      requestedPermissionMode: ctx.spec.permissionMode,
      ...(effectivePermissionMode !== undefined ? { effectivePermissionMode } : {}),
    };
  }

  #repositoryKey(repoPath: string): string {
    try { return realpathSync(repoPath); }
    catch { return resolve(repoPath); }
  }

  #releaseRepository(runId: string): void {
    this.#runtimeFailures.delete(runId);
    for (const [key, owner] of this.#repositoryOwners) {
      if (owner === runId) this.#repositoryOwners.delete(key);
    }
  }

  /** Await the asynchronous pipeline for a started/resumed run (test hook). */
  awaitRun(runId: string): Promise<void> {
    return this.#active.get(runId) ?? Promise.resolve();
  }

  activeRunIds(): readonly string[] {
    return [...this.#active.keys()];
  }

  controlState(runId: string): RunWorkflowControlState {
    const repo = this.#deps.durability({ runId });
    if (repo.getEffect(runId, "workflow.intake") === undefined) {
      throw new AgenCDaemonWorkflowControlError("RUN_NOT_FOUND", "Goal run was not found.");
    }
    return workflowControlState({ runId, effects: repo.listEffects(runId),
      suspensions: repo.listSuspensions(runId), terminal: repo.getCurrentTerminalResult(runId) !== undefined });
  }

  async requestPause(params: RunPauseParams): Promise<RunWorkflowControlState> {
    const state = this.controlState(params.runId);
    if (state.state !== "running") return state;
    const ctx = this.#contexts.get(params.runId);
    if (ctx === undefined || ctx.journal.appendSuspended === undefined) {
      throw new AgenCDaemonWorkflowControlError("WORKFLOW_CONTROL_FAILED", "The Goal has no live writer. Reconnect after recovery before pausing it.");
    }
    const stepId = `${WORKFLOW_PAUSE_PREFIX}${sha256Digest(params.requestId).slice(7)}`;
    const existing = ctx.repo.getEffect(params.runId, stepId);
    // Retried delivery of an old request must not pause a later stage again.
    if (existing?.outcome !== undefined) return state;
    const requestedAt = existing?.intentAt ?? this.#nowIso();
    if (existing === undefined) ctx.journal.appendIntent({
      stepId, callId: params.requestId, toolName: "workflow.control.pause",
      recoveryCategory: "idempotent", idempotencyKey: stepId,
      intentDigest: sha256Digest(canonicalizeJson({ runId: params.runId, requestId: params.requestId })),
      intentAt: requestedAt,
    });
    ctx.journal.appendResult({ stepId, outcome: "committed", evidence: { requestId: params.requestId, requestedAt }, completedAt: this.#nowIso() });
    return this.controlState(params.runId);
  }

  async resumePaused(params: RunResumeParams): Promise<RunWorkflowControlState> {
    const pending = this.#resuming.get(params.runId);
    if (pending !== undefined) {
      if (pending.suspensionId !== params.suspensionId) throw new AgenCDaemonWorkflowControlError("WORKFLOW_CONTROL_CONFLICT", "A different checkpoint is already being resumed.");
      return pending.promise;
    }
    const state = this.controlState(params.runId);
    if (state.state === "terminal") return state;
    const repo = this.#deps.durability({ runId: params.runId });
    if (state.state !== "paused") {
      const replayed = repo.listSuspensions(params.runId).find(item => item.eventId === params.suspensionId && item.resumeReason === "workflow_user_resume");
      if (replayed !== undefined) return state;
      throw new AgenCDaemonWorkflowControlError("WORKFLOW_NOT_PAUSED", "The Goal has not reached a paused checkpoint.");
    }
    if (state.suspensionId !== params.suspensionId) {
      throw new AgenCDaemonWorkflowControlError("WORKFLOW_CONTROL_CONFLICT", "This pause checkpoint is stale. Refresh Goal status and resume the current checkpoint.");
    }
    const resume = (async () => {
      // A pause is visible as soon as its boundary commits. Wait for the old
      // writer to close before opening the exact same run and budget identity.
      await this.awaitRun(params.runId);
      try { await this.#resumeRun(repo, params.runId, params); }
      catch (error) {
        // Before the resume boundary commits, the original pause is still
        // authoritative. Once consumed, a failed bootstrap must not look live.
        if (repo.getActiveSuspension(params.runId)?.reason !== "workflow_user_pause") {
          this.#recordDetachedTerminal(repo, params.runId, "failed",
            `The Goal could not resume: ${errorMessage(error)}.${this.#retainedWork(repo, params.runId)}`,
            { usage: this.#checkpointUsage(repo, params.runId) });
        }
        throw error;
      }
      return this.controlState(params.runId);
    })();
    this.#resuming.set(params.runId, { suspensionId: params.suspensionId, promise: resume });
    try { return await resume; }
    finally { if (this.#resuming.get(params.runId)?.promise === resume) this.#resuming.delete(params.runId); }
  }

  /** Observe live authority without opening or bootstrapping a run. */
  currentPermissionMode(runId: string): PermissionMode | undefined {
    return this.#deps.journal.currentPermissionMode?.(runId);
  }

  /** Live retry state is scoped to one exact step attempt, never replayed. */
  currentProviderWait(runId: string, stepId: string): ProviderWait | undefined {
    const active = this.#providerWaits.get(runId);
    return active?.stepId === stepId ? active.scope.current() : undefined;
  }

  /** Runtime-only health survives writer closure, but a durable terminal wins. */
  currentRuntimeFailure(runId: string): RunWorkflowRuntimeFailure | undefined {
    const failure = this.#runtimeFailures.get(runId);
    if (failure === undefined) return undefined;
    try {
      if (this.#deps.durability({ runId }).getCurrentTerminalResult(runId) !== undefined) {
        this.#runtimeFailures.delete(runId);
        return undefined;
      }
    } catch {
      // Unreadable storage must not hide an already observed execution stop.
    }
    return failure;
  }

  /** Durable status projection with optional live session details. */
  status(runId: string): WorkflowRunStatus | undefined {
    const repo = this.#deps.durability({ runId });
    const effects = repo.listEffects(runId);
    const terminal = repo.getCurrentTerminalResult(runId);
    if (effects.length === 0 && terminal === undefined) return undefined;
    const projected = projectWorkflowStatus({
      runId,
      effects,
      suspensions: repo.listSuspensions(runId),
      ...(terminal !== undefined ? { terminal } : {}),
    });
    const runtimeFailure = this.currentRuntimeFailure(runId);
    const effectivePermissionMode = terminal === undefined && runtimeFailure === undefined
      ? this.currentPermissionMode(runId)
      : undefined;
    return {
      ...projected,
      ...(runtimeFailure !== undefined ? { runtimeFailure } : {}),
      steps: projected.steps.map((step) => {
        const providerWait = terminal === undefined && runtimeFailure === undefined && step.status === "running"
          ? this.currentProviderWait(runId, step.stepId)
          : undefined;
        return { ...step, ...(providerWait !== undefined ? { providerWait } : {}) };
      }),
      ...(effectivePermissionMode !== undefined ? { effectivePermissionMode } : {}),
    };
  }

  /**
   * D3 startup recovery: rebuild every open workflow run from its durable
   * rows and continue it. Idempotent steps re-execute under their recorded
   * keys; side-effecting steps adopt their child's durable outcome; an
   * unknowable child terminates the run `unknown_outcome`. A run whose
   * intake intent never committed lost its (never-durable, read-only) spec
   * and is terminalized `failed` with a diagnostic.
   */
  async resumeOpenWorkflows(): Promise<readonly string[]> {
    const repo = this.#deps.durability();
    const resumed: string[] = [];
    for (const runId of repo.listRunIdsWithStep("workflow.intake")) {
      if (this.#resuming.has(runId)) continue;
      if (repo.getCurrentTerminalResult(runId) !== undefined) continue;
      if (repo.getActiveSuspension(runId)?.reason === "workflow_user_pause") continue;
      try {
        const started = await this.#resumeRun(repo, runId);
        if (started) resumed.push(runId);
      } catch (error) {
        if (error instanceof M5WorkflowFailpointError) throw error;
        const message = errorMessage(error);
        this.#deps.warn(`workflow resume failed for ${runId}: ${message}`);
        // Nothing is driving this run any more and, when the journal itself
        // failed to open, nothing can journal through its session. Left as
        // it is, the run reads "running" forever and run.cancel cannot reach
        // it (a goal that survived a daemon restart used to do exactly
        // that). Close it durably as failed instead.
        this.#recordDetachedTerminal(
          repo,
          runId,
          "failed",
          `workflow resume failed after a daemon restart: ${message}. Any worktree the run created is left in place for review; re-submit the request to continue the work.`,
        );
      }
    }
    return resumed;
  }

  /**
   * `run.cancel` reaches a live pipeline through the admission cascade, which
   * the pipeline observes and terminalizes as cancelled. A run with no live
   * pipeline in this process (its resume failed, or the process that ran it
   * is gone) has nothing observing that cascade: the agents-rail row turns
   * cancelled while the workflow projection stays "running". Close the
   * projection directly so status and cancel agree.
   */
  cancelDetached(runId: string, reason: string): WorkflowDetachedCancelOutcome {
    if (this.#active.has(runId) || this.#resuming.has(runId)) return "live";
    const repo = this.#deps.durability({ runId });
    if (repo.getEffect(runId, "workflow.intake") === undefined) {
      return "not_a_workflow";
    }
    if (repo.getCurrentTerminalResult(runId) !== undefined) {
      return "already_terminal";
    }
    return this.#recordDetachedTerminal(
      repo,
      runId,
      "cancelled",
      `Goal cancelled (${reason}).${this.#retainedWork(repo, runId)}`,
      { usage: this.#checkpointUsage(repo, runId) },
    )
      ? "cancelled"
      : "not_recorded";
  }

  #retainedWork(repo: StateRunDurabilityRepository, runId: string): string {
    const worktree = repo.listEffects(runId).map(readWorkflowStepEvidence).find(item => item.worktree !== undefined)?.worktree;
    return worktree === undefined ? "" : ` Work is retained in ${worktree.path} (branch ${worktree.branch}).`;
  }

  #checkpointUsage(repo: StateRunDurabilityRepository, runId: string): RunUsageTotals | null {
    const checkpoint = repo.listEffects(runId).filter(effect => effect.toolName === "workflow.control.checkpoint" && effect.outcome === "committed")
      .sort((a,b) => (b.resultSequence ?? 0) - (a.resultSequence ?? 0))[0];
    return (checkpoint?.evidence as { usage?: RunUsageTotals | null } | undefined)?.usage ?? null;
  }

  /**
   * Durable-only terminal for a run without a live writer, the same offline
   * authority run.cancel and child terminals already use. Never throws: a
   * failure here is logged and the caller reports it, because the run is
   * already beyond any journal this process can open.
   */
  #recordDetachedTerminal(
    repo: StateRunDurabilityRepository,
    runId: string,
    status: "failed" | "cancelled",
    finalMessage: string,
    details: { readonly stopReason?: WorkflowStopReason | null; readonly usage?: RunUsageTotals | null } = {},
  ): boolean {
    try {
      if (repo.getCurrentTerminalResult(runId) !== undefined) {
        this.#releaseRepository(runId);
        return true;
      }
      const epoch = repo.currentEpoch(runId)?.epoch;
      if (epoch === undefined) return false;
      repo.recordTerminalResult({
        epoch,
        eventId: `${WORKFLOW_DETACHED_TERMINAL_EVENT_PREFIX}${runId}:${epoch}`,
        result: {
          runId,
          status,
          exitCode: 1,
          stopReason: details.stopReason ?? null,
          finalMessage,
          usage: details.usage ?? null,
          lastSequence: null,
          finishedAt: this.#nowIso(),
        },
      });
      this.#releaseRepository(runId);
      return true;
    } catch (error) {
      this.#deps.warn(
        `workflow ${runId} could not record its ${status} terminal: ${errorMessage(error)}`,
      );
      this.#observePersistenceFailure(repo, runId, error, { usage: details.usage });
      return false;
    }
  }

  #observePersistenceFailure(
    repo: StateRunDurabilityRepository,
    runId: string,
    error: unknown,
    details: { readonly usage?: RunUsageTotals | null; readonly worktree?: { readonly path: string; readonly branch: string } } = {},
  ): void {
    let worktree = details.worktree;
    if (worktree === undefined) {
      try {
        const recorded = repo.listEffects(runId).map(readWorkflowStepEvidence).find(item => item.worktree !== undefined)?.worktree;
        if (recorded !== undefined) worktree = { path: recorded.path, branch: recorded.branch };
      } catch { /* Storage may be unreadable as well as unwritable. */ }
    }
    const previous = this.#runtimeFailures.get(runId);
    this.#runtimeFailures.set(runId, {
      state: "stopped", reason: "terminal_persistence_failed",
      observedAt: previous?.observedAt ?? this.#nowIso(),
      message: `Goal stopped, but its final status could not be saved. Check disk space and storage access. ${errorMessage(error).slice(0, 2048)}`,
      ...(worktree !== undefined ? { worktree } : previous?.worktree !== undefined ? { worktree: previous.worktree } : {}),
      ...(details.usage != null ? { usage: { ...details.usage } } : previous?.usage !== undefined ? { usage: previous.usage } : {}),
    });
  }

  async #resumeRun(
    repo: StateRunDurabilityRepository,
    runId: string,
    resume?: RunResumeParams,
  ): Promise<boolean> {
    if (this.#active.has(runId)) return false;
    const journal = await this.#deps.journal.open(runId, resume === undefined ? undefined : {
      resumeSuspensionId: resume.suspensionId,
      ...(resume.envOverrides !== undefined ? { envOverrides: resume.envOverrides } : {}),
    });
    try { return await this.#resumeOpened(repo, runId, journal); }
    catch (error) {
      try { await journal.close(); }
      catch (closeError) { this.#deps.warn(`Goal ${runId} resume cleanup failed: ${errorMessage(closeError)}`); }
      throw error;
    }
  }

  async #resumeOpened(repo: StateRunDurabilityRepository, runId: string, journal: WorkflowRunJournal): Promise<boolean> {
    if (repo.getCurrentTerminalResult(runId) !== undefined) {
      await journal.close();
      return false;
    }
    const intake = repo.getEffect(runId, "workflow.intake");
    if (intake === undefined) {
      await journal.close();
      return false;
    }
    if (intake.outcome === undefined) {
      // The spec only becomes durable in the intake result evidence; an
      // intent-only intake is unrecoverable. Intake is read-only, so failing
      // closed loses nothing — the caller re-submits.
      journal.appendResult({
        stepId: "workflow.intake",
        outcome: "failed",
        evidence: {
          stage: "workflow.intake",
          attempt: 1,
          failure: {
            reason: "intake_interrupted",
            message: "spec was not durably committed before the interruption",
          },
        } satisfies WorkflowStepEvidence,
        completedAt: this.#nowIso(),
      });
      const ctx = this.#bareContext(runId, repo, journal);
      await this.#terminalize(ctx, {
        status: "failed",
        stopReason: null,
        finalMessage:
          "The Goal stopped before its instructions were saved. Start it again.",
      });
      await this.#closeJournal(ctx);
      return true;
    }
    const evidence = readWorkflowStepEvidence(intake);
    const spec = evidence.spec as WorkflowSpec | undefined;
    if (intake.outcome !== "committed" || spec === undefined) {
      const ctx = this.#bareContext(runId, repo, journal);
      await this.#terminalize(ctx, {
        status: intake.outcome === "cancelled" ? "cancelled" : "failed",
        stopReason: null,
        finalMessage: `workflow intake terminally ${intake.outcome}; nothing to resume`,
      });
      await this.#closeJournal(ctx);
      return true;
    }
    const specDigest = (evidence.specDigest ?? computeSpecDigest(spec)) as Sha256Digest;
    const repositoryKey = this.#repositoryKey(spec.repoPath);
    const owner = this.#repositoryOwners.get(repositoryKey);
    if (owner !== undefined && owner !== runId) {
      await journal.close();
      throw new Error(`Another Goal is active for this repository (${owner}). The interrupted work is retained.`);
    }
    this.#repositoryOwners.set(repositoryKey, runId);
    const admission = this.#deps.admission({
      runId,
      sessionId: journal.sessionId,
      spec,
    });
    const ctx: RunContext = {
      runId,
      spec,
      specDigest,
      repo,
      journal,
      admission,
      startedAt: intake.intentAt,
      usage: { input: 0, output: 0, cost: 0, any: false },
      terminalized: false,
    };
    try {
      ctx.ledger = await this.#deps.evidenceLedger(spec);
      // Rebuild derived in-memory context from committed evidence.
      const effects = repo.listEffects(runId);
      const plan = deriveStageProjection("workflow.plan", effects);
      if (plan.status === "committed") {
        const planEffect = repo.getEffect(runId, plan.latestStepId);
        ctx.planText =
          planEffect === undefined
            ? undefined
            : readWorkflowStepEvidence(planEffect).child?.finalMessage;
      }
      this.#runtimeFailures.delete(runId);
      const pipeline = this.#continue(ctx);
      this.#active.set(runId, pipeline);
      return true;
    } catch (error) {
      admission.release?.();
      throw error;
    }
  }

  #bareContext(
    runId: string,
    repo: StateRunDurabilityRepository,
    journal: WorkflowRunJournal,
  ): RunContext {
    return {
      runId,
      spec: undefined as unknown as WorkflowSpec,
      specDigest: "sha256:" as Sha256Digest,
      repo,
      journal,
      admission: undefined as unknown as ExecutionAdmissionClient,
      startedAt: this.#nowIso(),
      usage: { input: 0, output: 0, cost: 0, any: false },
      terminalized: false,
    };
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  async #continue(ctx: RunContext): Promise<void> {
    this.#contexts.set(ctx.runId, ctx);
    try {
      this.#pauseAtCheckpoint(ctx);
      await this.#stageWorktree(ctx);
      this.#pauseAtCheckpoint(ctx);
      await this.#stagePlan(ctx);
      this.#pauseAtCheckpoint(ctx);
      await this.#implementVerifyLoop(ctx);
      this.#pauseAtCheckpoint(ctx);
      await this.#stageReview(ctx);
      this.#pauseAtCheckpoint(ctx);
      await this.#stageFinalize(ctx);
    } catch (error) {
      if (error instanceof WorkflowPausedError) return;
      if (error instanceof M5WorkflowFailpointError) throw error;
      const terminal =
        error instanceof WorkflowHaltError
          ? error.terminal
          : ({
              status: "failed",
              stopReason: null,
              finalMessage: `workflow internal error: ${errorMessage(error)}`,
            } satisfies WorkflowTerminalIntent);
      if (!(error instanceof WorkflowHaltError)) {
        this.#deps.warn(
          `workflow ${ctx.runId} internal error: ${errorMessage(error)}`,
        );
      }
      await this.#terminalize(ctx, terminal);
    } finally {
      if (ctx.terminalized) this.#releaseRepository(ctx.runId);
      try {
        await this.#closeJournal(ctx);
      } finally {
        try { ctx.admission.release?.(); }
        finally {
          this.#active.delete(ctx.runId);
          this.#contexts.delete(ctx.runId);
        }
      }
    }
  }

  #pauseAtCheckpoint(ctx: RunContext): void {
    const control = this.controlState(ctx.runId);
    if (control.state !== "pause_requested") return;
    // Recover an interrupted request append before suspending. A caller whose
    // acknowledgement was lost can retry the same id without another action.
    for (const effect of ctx.repo.listEffects(ctx.runId)) {
      if (effect.stepId.startsWith(WORKFLOW_PAUSE_PREFIX) && effect.outcome === undefined) {
        ctx.journal.appendResult({ stepId: effect.stepId, outcome: "committed",
          evidence: { requestId: effect.callId, requestedAt: effect.intentAt }, completedAt: this.#nowIso() });
      }
      if (effect.toolName === "workflow.control.checkpoint" && effect.outcome === undefined) {
        ctx.journal.appendResult({ stepId: effect.stepId, outcome: "committed",
          evidence: { usage: this.#canonicalUsage(ctx) }, completedAt: this.#nowIso() });
      }
    }
    // Recovery may still need to adopt an already-dispatched child first.
    if (ctx.repo.listEffects(ctx.runId).some(effect => effect.outcome === undefined || effect.reviewStatus === "pending")) return;
    if (ctx.journal.appendSuspended === undefined) throw new Error("Goal journal cannot persist a paused checkpoint.");
    const checkpointId = `workflow.control.checkpoint.${sha256Digest(control.requestId!).slice(7)}`;
    if (ctx.repo.getEffect(ctx.runId, checkpointId)?.outcome !== "committed") {
      const at = this.#nowIso();
      if (ctx.repo.getEffect(ctx.runId, checkpointId) === undefined) ctx.journal.appendIntent({
        stepId: checkpointId, toolName: "workflow.control.checkpoint", recoveryCategory: "idempotent",
        idempotencyKey: checkpointId, intentDigest: sha256Digest(checkpointId), intentAt: at,
      });
      ctx.journal.appendResult({ stepId: checkpointId, outcome: "committed", evidence: { usage: this.#canonicalUsage(ctx) }, completedAt: at });
    }
    ctx.journal.appendSuspended({ suspendedAt: this.#nowIso() });
    throw new WorkflowPausedError("Goal paused at a durable checkpoint.");
  }

  async #closeJournal(ctx: RunContext): Promise<void> {
    try {
      await ctx.journal.close();
    } catch (error) {
      this.#deps.warn(
        `workflow ${ctx.runId} journal close failed: ${errorMessage(error)}`,
      );
    }
  }

  async #stageIntake(ctx: RunContext): Promise<void> {
    const result = await this.#driveEffect(ctx, {
      stepId: "workflow.intake",
      stage: "workflow.intake",
      attempt: 1,
      toolName: "workflow.intake",
      kind: "tool_exec",
      recoveryCategory: "idempotent",
      idempotencyKey: intakeIdempotencyKey(ctx.specDigest),
      intentDigest: ctx.specDigest,
      estimate: ZERO_ESTIMATE,
      beforeCommitFailpoints: ["before_intake_commit"],
      afterCommitFailpoint: "after_intake_commit",
      execute: async () => {
        ctx.ledger = await this.#deps.evidenceLedger(ctx.spec);
        return {
          outcome: "committed",
          evidence: {
            stage: "workflow.intake",
            attempt: 1,
            spec: ctx.spec,
            specDigest: ctx.specDigest,
          },
        };
      },
    });
    if (result.outcome !== "committed") {
      // The journal keeps the failure; the client used to see only
      // "workflow intake failed" while the cause sat in run_effects.
      const failure = describeEffectFailure(result);
      throw new WorkflowHaltError({
        status: result.outcome === "cancelled" ? "cancelled" : "failed",
        stopReason: null,
        finalMessage: `workflow intake ${result.outcome}${failure}`,
      });
    }
    if (ctx.ledger === undefined) {
      ctx.ledger = await this.#deps.evidenceLedger(ctx.spec);
    }
  }

  async #stageWorktree(ctx: RunContext): Promise<void> {
    const slug = workflowWorktreeSlug(ctx.runId);
    const { result } = await this.#runStageWithRetries(ctx, {
      stage: "workflow.worktree",
      maxAttempts: MAX_STAGE_ATTEMPTS,
      makePlan: (attempt) => ({
        stepId: stageStepId("workflow.worktree", attempt),
        stage: "workflow.worktree",
        attempt,
        toolName: "workflow.worktree",
        kind: "tool_exec",
        recoveryCategory: "idempotent",
        idempotencyKey: worktreeIdempotencyKey(slug, ctx.spec.baseCommit),
        intentDigest: sha256Digest(
          canonicalizeJson({ slug, baseCommit: ctx.spec.baseCommit }),
        ),
        estimate: ZERO_ESTIMATE,
        beforeExecuteFailpoint: "before_worktree_provision",
        afterCommitFailpoint: "after_worktree_provision",
        execute: async () => {
          try {
            const handle = await this.#deps.worktrees.provision(ctx.spec);
            ctx.handle = handle;
            return {
              outcome: "committed",
              evidence: {
                stage: "workflow.worktree",
                attempt,
                worktree: {
                  slug,
                  branch: handle.branch,
                  path: handle.path,
                  baseCommit: ctx.spec.baseCommit,
                  created: handle.created,
                },
              },
            };
          } catch (error) {
            return {
              outcome: "failed",
              evidence: {
                stage: "workflow.worktree",
                attempt,
                failure: {
                  reason: "worktree_provision_failed",
                  message: errorMessage(error),
                },
              },
            };
          }
        },
      }),
    });
    if (result.replayed || ctx.handle === undefined) {
      // Idempotent fast-resume of the deterministic slug rebuilds the handle.
      ctx.handle = await this.#deps.worktrees.provision(ctx.spec);
    }
  }

  async #stagePlan(ctx: RunContext): Promise<void> {
    const { result } = await this.#runStageWithRetries(ctx, {
      stage: "workflow.plan",
      maxAttempts: MAX_STAGE_ATTEMPTS,
      makePlan: (attempt) => {
        const previous = attempt > 1
          ? ctx.repo.getEffect(ctx.runId, stageStepId("workflow.plan", attempt - 1))
          : undefined;
        return this.#spawnPlan(ctx, {
          stage: "workflow.plan",
          stepId: stageStepId("workflow.plan", attempt),
          attempt,
          spawnKind: "plan",
          childRunId: `${ctx.runId}:plan#${attempt}`,
          prompt: buildPlanPrompt(ctx.spec, previous === undefined
            ? undefined : readWorkflowStepEvidence(previous).failure?.message),
          decorate: (outcome) => {
            if (outcome.status !== "completed") return {};
            const planBlocked = parsePlanBlockedResponse(outcome.finalMessage);
            if (planBlocked !== undefined) return { planBlocked };
            if (ctx.spec.requiredVerification.length > 0) return {};
            try {
              // Freeze checks from the full response before bounding retained prose.
              return { requiredVerification: plannedVerification(outcome.finalMessage ?? "") };
            } catch (error) {
              return { failure: { reason: "invalid_planned_verification", message: errorMessage(error) } };
            }
          },
        });
      },
    });
    const planBlocked = readPlanBlocked(result.evidence.planBlocked);
    if (planBlocked !== undefined) {
      throw new WorkflowHaltError({ status: "failed", stopReason: "requirement_conflict",
        finalMessage: `The planner found conflicting requirements: ${boundedWorkflowDiagnostic(planBlocked.explanation)}` });
    }
    ctx.planText = result.evidence.child?.finalMessage;
    if (ctx.spec.requiredVerification.length === 0) {
      ctx.plannedChecks = result.evidence.requiredVerification;
      if (ctx.plannedChecks === undefined || ctx.plannedChecks.length === 0) {
        throw new WorkflowHaltError({ status: "failed", stopReason: "evidence_invalid",
          finalMessage: "The committed plan has no frozen verification commands." });
      }
    }
  }

  async #implementVerifyLoop(ctx: RunContext): Promise<void> {
    const spec = ctx.spec;
    let attempt = Math.max(
      1,
      deriveStageProjection(
        "workflow.implement",
        ctx.repo.listEffects(ctx.runId),
      ).attempts,
    );
    for (;;) {
      this.#pauseAtCheckpoint(ctx);
      const implement = await this.#driveEffect(
        ctx,
        this.#spawnPlan(ctx, {
          stage: "workflow.implement",
          stepId: stageStepId("workflow.implement", attempt),
          attempt,
          spawnKind: "implement",
          childRunId: `${ctx.runId}:implement#${attempt}`,
          prompt: buildImplementPrompt(ctx, attempt),
        }),
      );
      if (implement.outcome === "cancelled") {
        throw new WorkflowHaltError({
          status: "cancelled",
          stopReason: null,
          finalMessage: "workflow cancelled during implement",
        });
      }
      if (implement.outcome === "unknown_outcome") {
        throw new WorkflowHaltError({
          status: "unknown_outcome",
          stopReason: "unknown_outcome_effect",
          finalMessage: `implement step ${stageStepId("workflow.implement", attempt)} has an unresolved unknown outcome`,
        });
      }
      if (implement.outcome === "failed") {
        this.#haltPermanentChildFailure(implement);
        if (attempt >= spec.maxImplementAttempts) {
          throw new WorkflowHaltError({
            status: "failed",
            stopReason: "step_retries_exhausted",
            finalMessage: failedStepMessage(`implement failed terminally after ${attempt} attempt(s)`, implement),
          });
        }
        attempt += 1;
        continue;
      }
      this.#pauseAtCheckpoint(ctx);
      const passed = await this.#stageVerify(ctx, attempt);
      this.#pauseAtCheckpoint(ctx);
      if (passed) return;
      if (attempt >= spec.maxImplementAttempts) {
        throw new WorkflowHaltError({
          status: "failed",
          stopReason: "verification_failed",
          finalMessage:
            (ctx.verification?.allPassed === true
              ? ctx.verifyVerdict === "PARTIAL"
                ? "The verification commands passed, but the verifier judged the result partial or incomplete"
                : ctx.verifyExplicitVerdict === false
                  ? "The verification commands passed, but the verifier did not return a verdict"
                  : "The verification commands passed, but the verifier judged the result incorrect"
              : "A required verification command failed or timed out") +
            ` after ${attempt} implement attempt(s) (agent verdict ${ctx.verifyVerdict ?? "missing"}).`,
        });
      }
      attempt += 1;
    }
  }

  /** Returns true when every required command exits 0 AND the agent says PASS. */
  async #stageVerify(ctx: RunContext, attempt: number): Promise<boolean> {
    const spec = ctx.spec;
    const handle = this.#requireHandle(ctx);
    const ledger = this.#requireLedger(ctx);
    // Export the reviewable patch for this tree; re-export of an unchanged
    // worktree is byte-identical, so this is safe on every resume.
    const exported = await this.#deps.worktrees.exportPatch({
      handle,
      baseCommit: spec.baseCommit,
      step: { runId: ctx.runId, stepId: stageStepId("workflow.verify", attempt) },
      sink: ledger,
    });
    ctx.export = exported;

    const records: VerifiedChangeCommandRecord[] = [];
    for (const [index, command] of (ctx.plannedChecks ?? spec.requiredVerification).entries()) {
      const stepId = verifyCommandStepId(index + 1, attempt);
      const intentDigest = sha256Digest(canonicalizeJson({
        script: command.script,
        treeHash: exported.treeHash,
      }));
      const previous = ctx.repo.getEffect(ctx.runId, stepId);
      if (previous !== undefined && previous.intentDigest !== intentDigest) {
        // Replaying a passing command for a changed tree would claim checks
        // that never ran on the delivered files. Preserve the work for review.
        throw new WorkflowHaltError({
          status: "failed",
          stopReason: "evidence_invalid",
          finalMessage: "The Goal worktree changed since its verification was recorded. The saved checks cannot verify the changed files. Review the preserved work and run its checks again.",
        });
      }
      const result = await this.#driveEffect(ctx, {
        stepId,
        stage: "workflow.verify",
        attempt,
        toolName: "workflow.verify.cmd",
        kind: "tool_exec",
        recoveryCategory: "idempotent",
        idempotencyKey: verifyCommandIdempotencyKey(
          command.script,
          exported.treeHash,
        ),
        intentDigest,
        estimate: ZERO_ESTIMATE,
        execute: async (signal) =>
          this.#executeVerificationCommand(ctx, command, attempt, signal),
      });
      this.#haltPermanentChildFailure(result);
      const record = result.evidence.command;
      if (result.outcome === "committed" && record !== undefined) {
        records.push(record);
      } else {
        // A durable command row without a usable record can never pass.
        records.push({
          label: command.label,
          script: command.script,
          exitCode: 127,
          timedOut: false,
          truncated: false,
          durationMs: 0,
          stdoutDigest: sha256Digest(new Uint8Array(0)),
          stderrDigest: sha256Digest(new Uint8Array(0)),
        });
      }
    }
    const allPassed = records.every(
      (record) => record.exitCode === 0 && !record.timedOut,
    );
    const testResult = await ledger.recordArtifact({
      step: { runId: ctx.runId, stepId: verifyAgentStepId(attempt) },
      role: "test_result",
      bytes: new TextEncoder().encode(canonicalizeJson({ commands: records })),
      mediaType: "application/json",
    });

    const agent = await this.#driveEffect(
      ctx,
      this.#spawnPlan(ctx, {
        stage: "workflow.verify",
        stepId: verifyAgentStepId(attempt),
        attempt,
        spawnKind: "verify_agent",
        childRunId: `${ctx.runId}:verify-agent#${attempt}`,
        prompt: buildVerifyAgentPrompt(
          ctx.spec,
          records,
          ctx.planText,
          attempt > 1 && ctx.verifyReport !== undefined
            ? {
                attempt: attempt - 1,
                verdict: ctx.verifyVerdict ?? "FAIL",
                report: ctx.verifyReport,
              }
            : undefined,
        ),
        decorate: (outcome) => {
          const verdict = parseVerificationVerdict(outcome.finalMessage ?? "");
          return {
            // The shared parser accepts whole plain or bold verdict lines.
            // A missing/malformed verdict is a FAIL, never an implicit pass.
            verdict: verdict ?? "FAIL",
            explicitVerdict: verdict !== undefined,
            artifacts: [testResult],
          };
        },
        beforeCommitFailpoints: [
          "after_spawn_before_effect_result",
          "before_verify_commit",
        ],
        afterCommitFailpoint: "after_verify_commit",
      }),
    );
    if (agent.outcome === "cancelled") {
      throw new WorkflowHaltError({
        status: "cancelled",
        stopReason: null,
        finalMessage: "workflow cancelled during verification",
      });
    }
    if (agent.outcome === "unknown_outcome") {
      throw new WorkflowHaltError({
        status: "unknown_outcome",
        stopReason: "unknown_outcome_effect",
        finalMessage: `verification agent ${verifyAgentStepId(attempt)} has an unresolved unknown outcome`,
      });
    }
    if (agent.outcome === "failed") {
      this.#haltPermanentChildFailure(agent);
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "step_retries_exhausted",
        finalMessage: failedStepMessage("adversarial verification agent run failed terminally", agent),
      });
    }
    const verdict = agent.evidence.verdict ?? "FAIL";
    ctx.verification = { records, allPassed, testResult };
    ctx.verifyVerdict = verdict;
    ctx.verifyExplicitVerdict = agent.evidence.explicitVerdict ??
      (parseVerificationVerdict(agent.evidence.child?.finalMessage ?? "") !== undefined);
    ctx.verifyReport = agent.evidence.child?.finalMessage;
    return allPassed && verdict === "PASS";
  }

  async #executeVerificationCommand(
    ctx: RunContext,
    command: { readonly label: string; readonly script: string },
    attempt: number,
    signal: AbortSignal,
  ): Promise<EffectExecution> {
    const handle = this.#requireHandle(ctx);
    const startedAt = performance.now();
    let exitCode: number;
    let stdout: Uint8Array;
    let stderr: Uint8Array;
    let timedOut = false;
    let truncated = false;
    let durationMs: number;
    try {
      signal.throwIfAborted();
      const result = await this.#deps.commands.run({
        script: command.script,
        cwd: handle.path,
        signal,
      });
      signal.throwIfAborted();
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
      timedOut = result.timedOut;
      truncated = result.truncated;
      durationMs = result.durationMs;
    } catch (error) {
      // Preserve admission cancellation for #driveEffect's cancelled result
      // and held-unknown accounting, including a runner that resolves on abort.
      if (signal.aborted) throw error;
      const approvalFailure = workflowApprovalFailureCause(error);
      if (approvalFailure !== undefined) {
        return { outcome: "failed", evidence: { stage: "workflow.verify", attempt,
          failure: { reason: approvalFailure.stopReason, message: approvalFailure.message } } };
      }
      // A runner crash is a failing command with diagnostic stderr, never a
      // silently missing record (verification.ts discipline).
      exitCode = 127;
      stdout = new Uint8Array(0);
      stderr = new TextEncoder().encode(errorMessage(error));
      durationMs = Math.round(performance.now() - startedAt);
    }
    const record: VerifiedChangeCommandRecord = {
      label: command.label,
      script: command.script,
      exitCode,
      timedOut,
      truncated,
      durationMs,
      stdoutDigest: sha256Digest(stdout),
      stderrDigest: sha256Digest(stderr),
    };
    const decoder = new TextDecoder("utf8", { fatal: false });
    return {
      outcome: "committed",
      evidence: {
        stage: "workflow.verify",
        attempt,
        command: record,
        excerpts: {
          stdout: decoder.decode(stdout.subarray(0, 4096)).replace(/�/g, ""),
          stderr: decoder.decode(stderr.subarray(0, 4096)).replace(/�/g, ""),
        },
      },
    };
  }

  async #stageReview(ctx: RunContext): Promise<void> {
    const ledger = this.#requireLedger(ctx);
    const { result } = await this.#runStageWithRetries(ctx, {
      stage: "workflow.review",
      maxAttempts: MAX_STAGE_ATTEMPTS,
      makePlan: (attempt) => {
        const stepId = stageStepId("workflow.review", attempt);
        const childRunId = `${ctx.runId}:review#${attempt}`;
        return {
          stepId,
          stage: "workflow.review",
          attempt,
          toolName: "workflow.review",
          kind: "spawn",
          recoveryCategory: "side-effecting",
          intentDigest: sha256Digest(
            canonicalizeJson({ stepId, childRunId, reviewer: ctx.spec.reviewerModel }),
          ),
          childRunId,
          estimate: ZERO_ESTIMATE,
          ...(ctx.spec.reviewerModel !== undefined
            ? { model: ctx.spec.reviewerModel }
            : {}),
          beforeCommitFailpoints: ["before_review_commit"] as const,
          afterCommitFailpoint: "after_review_commit" as const,
          execute: async (): Promise<EffectExecution> => {
            const exported = this.#requireExport(ctx);
            const verification = ctx.verification;
            if (verification === undefined) {
              throw new Error("review started without verification evidence");
            }
            const patchText = new TextDecoder().decode(exported.patchBytes);
            const changedFilesText = new TextDecoder().decode(
              await ledger.readArtifact(exported.changedFiles),
            );
            try {
              const review = await runIndependentReview({
                spec: ctx.spec,
                patchText,
                changedFilesText,
                verification: verification.records,
                verificationVerdict: ctx.verifyVerdict,
                invoker: this.#deps.reviewer,
                sink: ledger,
                step: { runId: ctx.runId, stepId },
              });
              // A1 for the review child: the reviewer settled inside this
              // effect execution, so ITS terminal becomes durable here —
              // strictly before the review effect_result can commit. The
              // payload carries the parsed ReviewOutput and the recorded
              // independent_review artifact pointer, enough to complete the
              // parent effect honestly on post-restart adoption.
              this.#recordReviewChildTerminal(ctx, childRunId, {
                status: "completed",
                finalMessage: encodeWorkflowReviewTerminal({
                  review: review.review,
                  reviewerModel: ctx.spec.reviewerModel,
                  artifact: review.artifact,
                }),
                usage: null,
              });
              return this.#reviewExecution(
                attempt,
                review.review,
                ctx.spec.reviewerModel,
                review.artifact,
              );
            } catch (error) {
              const approvalFailure = workflowApprovalFailureCause(error);
              const stopReason = approvalFailure?.stopReason ?? workflowAdmissionStopReason(error);
              if (stopReason !== undefined) {
                const message = approvalFailure?.message ?? workflowStopMessage(stopReason);
                this.#recordReviewChildTerminal(ctx, childRunId, {
                  status: "failed",
                  stopReason,
                  finalMessage: message,
                  usage: null,
                });
                return {
                  outcome: "failed",
                  evidence: {
                    stage: "workflow.review", attempt,
                    failure: { reason: stopReason, message },
                  },
                };
              }
              if (
                error instanceof ReviewParseError ||
                error instanceof ReviewInvocationError
              ) {
                // A settled-but-unparseable reviewer, or one whose single
                // call failed before any output (soak F76: a 403 on the
                // reviewer's token), is a KNOWN failure — durable for
                // adoption too, so a crash in the commit window resumes
                // into the same failed outcome (and its bounded retry),
                // never into unknown_outcome.
                this.#recordReviewChildTerminal(ctx, childRunId, {
                  status: "failed",
                  finalMessage: error.message,
                  usage: null,
                });
                return {
                  outcome: "failed",
                  evidence: {
                    stage: "workflow.review",
                    attempt,
                    failure: {
                      reason:
                        error instanceof ReviewParseError
                          ? "review_unparseable"
                          : "review_invocation_failed",
                      message: error.message,
                    },
                  },
                };
              }
              throw error;
            }
          },
          adopt: async (existing) => this.#adoptReview(ctx, existing, attempt),
        } satisfies EffectStepPlan;
      },
    });
    const review = result.evidence.review;
    if (review === undefined) {
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "evidence_invalid",
        finalMessage: "review committed without durable review evidence",
      });
    }
    const artifact = (result.evidence.artifacts ?? [])[0];
    if (artifact === undefined) {
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "evidence_invalid",
        finalMessage: "review committed without its independent_review artifact",
      });
    }
    ctx.review = {
      reviewerModel: review.reviewerModel,
      overallCorrectness: review.overallCorrectness,
      overallConfidenceScore: review.overallConfidenceScore,
      blockerCount: review.blockerCount,
      findingCount: review.findingCount,
      artifact,
    };
    ctx.reviewNonBlocking = review.nonBlockingFindings;
    if (review.blockerCount > 0) {
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "review_rejected",
        finalMessage: `independent review raised ${review.blockerCount} blocker(s): ${review.blockers.join("; ")}`,
      });
    }
  }

  async #stageFinalize(ctx: RunContext): Promise<void> {
    const spec = ctx.spec;
    const handle = this.#requireHandle(ctx);
    const ledger = this.#requireLedger(ctx);
    const verified = this.#requireExport(ctx);
    hitM5WorkflowFailpoint("before_patch_export");
    const exported = await this.#deps.worktrees.exportPatch({
      handle,
      baseCommit: spec.baseCommit,
      step: { runId: ctx.runId, stepId: "workflow.finalize" },
      sink: ledger,
    });
    if (exported.treeHash !== verified.treeHash || exported.patch.digest !== verified.patch.digest) {
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "evidence_invalid",
        finalMessage: "The Goal worktree changed after verification began. The result was not finalized because its checks and review cover a different snapshot. Review the preserved work and run its checks again.",
      });
    }
    ctx.export = exported;
    const movement = await this.#deps.worktrees.checkBaseMovement({
      spec,
      patchBytes: exported.patchBytes,
    });

    const risks: string[] = [];
    if (movement.kind === "rebase_clean") {
      risks.push(
        `base moved to ${movement.newBaseCommit} after intake; the patch applies cleanly (3-way)`,
      );
    }
    if (spec.baseDirty.dirty) {
      risks.push(
        `user checkout was dirty at intake (${spec.baseDirty.fileCount} file(s)); the change was built from the clean base commit`,
      );
    }
    for (const finding of ctx.reviewNonBlocking ?? []) {
      risks.push(`non-blocking review finding: ${finding}`);
    }

    const finalizeStep = await this.#driveEffect(ctx, {
      stepId: "workflow.finalize",
      stage: "workflow.finalize",
      attempt: 1,
      toolName: "workflow.finalize",
      kind: "tool_exec",
      recoveryCategory: "idempotent",
      idempotencyKey: finalizeIdempotencyKey(
        exported.patch.digest,
        spec.baseCommit,
      ),
      intentDigest: sha256Digest(
        canonicalizeJson({
          patchDigest: exported.patch.digest,
          baseCommit: spec.baseCommit,
        }),
      ),
      estimate: ZERO_ESTIMATE,
      execute: async (): Promise<EffectExecution> => {
        if (movement.kind === "conflict") {
          return {
            outcome: "failed",
            evidence: {
              stage: "workflow.finalize",
              attempt: 1,
              finalize: {
                headCommit: exported.headCommit,
                treeHash: exported.treeHash,
                baseMovement: movement.kind,
                conflictFiles: movement.conflictFiles,
              },
            },
          };
        }
        let riskRegister: RunArtifactPointer | undefined;
        if (risks.length > 0) {
          riskRegister = await ledger.recordArtifact({
            step: { runId: ctx.runId, stepId: "workflow.finalize" },
            role: "risk_register",
            bytes: new TextEncoder().encode(canonicalizeJson({ risks })),
            mediaType: "application/json",
          });
        }
        hitM5WorkflowFailpoint("after_patch_export_before_seal");
        const seal = await ledger.seal(this.#nowIso());
        return {
          outcome: "committed",
          evidence: {
            stage: "workflow.finalize",
            attempt: 1,
            finalize: {
              headCommit: exported.headCommit,
              treeHash: exported.treeHash,
              sealDigest: seal.sealDigest,
              baseMovement: movement.kind,
            },
            artifacts: [
              exported.patch,
              exported.changedFiles,
              ...(riskRegister !== undefined ? [riskRegister] : []),
            ],
          },
        };
      },
    });
    if (finalizeStep.outcome !== "committed") {
      if (movement.kind === "conflict") {
        throw new WorkflowHaltError({
          status: "failed",
          stopReason: "base_moved_conflict",
          finalMessage:
            `base moved to ${movement.newBaseCommit} and the patch conflicts: ` +
            movement.conflictFiles.join(", "),
        });
      }
      throw new WorkflowHaltError({
        status: finalizeStep.outcome === "cancelled" ? "cancelled" : "failed",
        stopReason:
          finalizeStep.outcome === "unknown_outcome"
            ? "unknown_outcome_effect"
            : finalizeStep.evidence.finalize?.baseMovement === "conflict"
              ? "base_moved_conflict"
              : "evidence_invalid",
        finalMessage: `workflow finalize ${finalizeStep.outcome}`,
      });
    }
    const sealDigest = finalizeStep.evidence.finalize?.sealDigest;
    if (sealDigest === undefined) {
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "evidence_invalid",
        finalMessage: "finalize committed without a sealed-ledger digest",
      });
    }

    // Assemble + self-validate the verified-change record (D6). All durable
    // rows — including the just-committed finalize — feed the record.
    let record: VerifiedChangeRecord;
    const head = ledger.head();
    try {
      record = this.#assembleRecord(ctx, {
        headCommit: exported.headCommit,
        risks,
        ledgerHead: head,
        sealDigest,
      });
    } catch (error) {
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "evidence_invalid",
        finalMessage: `verified-change record failed self-validation: ${errorMessage(error)}`,
      });
    }
    if (ledger.persistRecord !== undefined) {
      try {
        await ledger.persistRecord(record);
      } catch (error) {
        this.#deps.warn(
          `workflow ${ctx.runId} record persistence failed: ${errorMessage(error)}`,
        );
      }
    }
    hitM5WorkflowFailpoint("after_seal_before_terminal");
    const verification = ctx.verification;
    const review = ctx.review;
    if (verification === undefined || review === undefined) {
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "evidence_invalid",
        finalMessage: "finalize reached without verification/review context",
      });
    }
    const riskSuffix =
      risks.length > 0
        ? ` Non-blocking risks recorded in the risk register: ${risks.join(" | ")}`
        : "";
    await this.#terminalize(
      ctx,
      {
        status: "completed",
        stopReason: null,
        finalMessage:
          `verified change completed at ${exported.headCommit} ` +
          `(record ${record.documentDigest}, ledger seal ${sealDigest}).` +
          riskSuffix,
      },
      {
        record,
        allCommandsPassed: verification.allPassed,
        verificationVerdict: ctx.verifyVerdict,
        reviewBlockerCount: review.blockerCount,
        ledgerSealed: head.sealed,
      },
    );
    hitM5WorkflowFailpoint("after_terminal_before_cleanup");
    // A sealed ledger alone does not authorize removing a resumable tree.
    // If status storage failed, recovery still needs the exact worktree.
    if (ctx.repo.getCurrentTerminalResult(ctx.runId)?.status !== "completed") return;
    try {
      await this.#deps.worktrees.cleanup({
        proof: mintSealedEvidenceProof({ runId: ctx.runId, sealDigest }),
        handle,
        headCommit: exported.headCommit,
      });
    } catch (error) {
      this.#deps.warn(
        `workflow ${ctx.runId} worktree cleanup failed after sealed evidence: ${errorMessage(error)}`,
      );
    }
  }

  #assembleRecord(
    ctx: RunContext,
    input: {
      readonly headCommit: string;
      readonly risks: readonly string[];
      readonly ledgerHead: WorkflowEvidenceLedgerHead;
      /** Ledger seal digest — pins the exported bundle's seal in the record. */
      readonly sealDigest: string;
    },
  ): VerifiedChangeRecord {
    const effects = ctx.repo.listEffects(ctx.runId);
    const steps: VerifiedChangeStepRecord[] = [];
    for (const effect of effects) {
      const evidence = readWorkflowStepEvidence(effect);
      const stage = evidence.stage;
      if (stage === undefined) continue;
      const status =
        effect.outcome === undefined
          ? "running"
          : effect.outcome === "committed"
            ? "committed"
            : effect.outcome;
      steps.push({
        stepId: effect.stepId,
        stage,
        status,
        attempt: evidence.attempt ?? 1,
        startedAt: effect.intentAt,
        finishedAt: effect.completedAt ?? null,
        ...(evidence.verdict !== undefined
          ? { verdict: evidence.verdict }
          : {}),
        artifacts: evidence.artifacts ?? [],
      });
    }
    const verification = ctx.verification;
    const review = ctx.review;
    if (verification === undefined || review === undefined) {
      throw new Error("record assembly requires verification and review context");
    }
    const usage = this.#canonicalUsage(ctx);
    return assembleVerifiedChangeRecord({
      runId: ctx.runId,
      specDigest: ctx.specDigest,
      spec: ctx.spec,
      startedAt: ctx.startedAt,
      finishedAt: this.#nowIso(),
      terminal: { status: "completed", stopReason: null, finalMessage: null },
      usage,
      baseCommit: ctx.spec.baseCommit,
      headCommit: input.headCommit,
      steps,
      verificationCommands: verification.records,
      review,
      unresolvedRisks: input.risks,
      evidenceLedger: {
        eventCount: input.ledgerHead.eventCount,
        headEventDigest: input.ledgerHead.headEventDigest,
        sealed: input.ledgerHead.sealed,
        sealDigest: input.sealDigest as Sha256Digest,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Spawn-step plan builder (plan / implement / verify agent / review adopt)
  // -------------------------------------------------------------------------

  #spawnPlan(
    ctx: RunContext,
    input: {
      readonly stage: WorkflowStepId;
      readonly stepId: string;
      readonly attempt: number;
      readonly spawnKind: WorkflowSpawnKind;
      readonly childRunId: string;
      readonly prompt: string;
      readonly decorate?: (
        outcome: WorkflowChildOutcome,
      ) => Partial<WorkflowStepEvidence>;
      readonly beforeCommitFailpoints?: readonly M5WorkflowFailpoint[];
      readonly afterCommitFailpoint?: M5WorkflowFailpoint;
    },
  ): EffectStepPlan {
    const spec = ctx.spec;
    const toEvidence = (outcome: WorkflowChildOutcome): EffectExecution => {
      const decorated = input.decorate?.(outcome) ?? {};
      const heldUnknown = outcome.usageHeldUnknownCount ?? 0;
      const evidence: WorkflowStepEvidence = {
        stage: input.stage,
        attempt: input.attempt,
        child: {
          childRunId: input.childRunId,
          status: outcome.status,
          ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
          ...(truncate(outcome.finalMessage) !== undefined
            ? { finalMessage: truncate(outcome.finalMessage)! }
            : {}),
          ...(outcome.usage !== null ? { usage: outcome.usage } : {}),
          ...(heldUnknown > 0 ? { usageHeldUnknown: heldUnknown } : {}),
        },
        ...decorated,
      };
      const mapped: "committed" | "failed" | "cancelled" =
        outcome.status === "completed"
          ? decorated.failure === undefined ? "committed" : "failed"
          : outcome.status === "cancelled"
            ? "cancelled"
            : "failed";
      const rollupUsage =
        outcome.usage === null
          ? undefined
          : {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              costUsd: outcome.usage.costUsd,
            };
      return {
        outcome: mapped,
        evidence,
        ...(rollupUsage !== undefined ? { rollupUsage } : {}),
      };
    };
    return {
      stepId: input.stepId,
      stage: input.stage,
      attempt: input.attempt,
      toolName: `workflow.${input.spawnKind}`,
      kind: "spawn",
      recoveryCategory: "side-effecting",
      intentDigest: sha256Digest(
        canonicalizeJson({
          stepId: input.stepId,
          childRunId: input.childRunId,
          promptDigest: sha256Digest(input.prompt),
        }),
      ),
      childRunId: input.childRunId,
      estimate: ZERO_ESTIMATE,
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.provider !== undefined ? { provider: spec.provider } : {}),
      beforeCommitFailpoints: input.beforeCommitFailpoints ?? [
        "after_spawn_before_effect_result",
      ],
      ...(input.afterCommitFailpoint !== undefined
        ? { afterCommitFailpoint: input.afterCommitFailpoint }
        : {}),
      execute: async (signal) => {
        const handle = this.#requireHandle(ctx);
        const outcome = await this.#deps.spawner.spawn({
          kind: input.spawnKind,
          childRunId: input.childRunId,
          spec,
          worktreePath: handle.path,
          prompt: input.prompt,
          signal,
        });
        if (outcome.status === "unknown_outcome") {
          // The child itself is durably unresolved; the parent effect is
          // unknowable by construction.
          throw new Error(
            `child run ${input.childRunId} terminated unknown_outcome`,
          );
        }
        return toEvidence(outcome);
      },
      adopt: async (existing) => {
        const adopted = await this.#adoptChild(ctx, existing);
        if (adopted === undefined) return undefined;
        // Re-decorate verdict-bearing evidence from the adopted message,
        // preserving the durable terminal's usage rollup.
        const child = adopted.evidence.child;
        if (child !== undefined) {
          return toEvidence({
            status: child.status as RunTerminalStatus,
            ...(child.stopReason !== undefined ? { stopReason: child.stopReason } : {}),
            finalMessage: child.finalMessage ?? null,
            usage: child.usage ?? null,
            ...(child.usageHeldUnknown !== undefined
              ? { usageHeldUnknownCount: child.usageHeldUnknown }
              : {}),
          });
        }
        return adopted;
      },
    };
  }

  /** Best-effort durable terminal for the review child (never fatal). */
  #recordReviewChildTerminal(
    ctx: RunContext,
    childRunId: string,
    outcome: WorkflowChildOutcome,
  ): void {
    try {
      recordWorkflowChildTerminal(ctx.repo, childRunId, outcome, this.#now);
    } catch (error) {
      this.#deps.warn(
        `workflow review child ${childRunId} terminal was not durably recorded: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * The ONE assembly point for committed review-effect evidence — used by
   * the live execution and by durable-terminal adoption, so both paths
   * derive identical blockers/non-blocking findings from the ReviewOutput.
   */
  #reviewExecution(
    attempt: number,
    review: ReviewOutput,
    reviewerModel: string,
    artifact: RunArtifactPointer,
  ): EffectExecution {
    const blockers = extractBlockers(review);
    const nonBlocking = review.findings
      .map((finding) => finding.title)
      .filter((title) => !blockers.includes(title));
    return {
      outcome: "committed",
      evidence: {
        stage: "workflow.review",
        attempt,
        review: {
          blockerCount: blockers.length,
          findingCount: review.findings.length,
          overallCorrectness: review.overallCorrectness,
          overallConfidenceScore: review.overallConfidenceScore,
          blockers,
          nonBlockingFindings: nonBlocking,
          reviewerModel,
        },
        artifacts: [artifact],
      },
    };
  }

  /**
   * D3 adoption for the independent-review child: a durable terminal whose
   * payload decodes to the recorded ReviewOutput + independent_review
   * artifact completes the parent effect exactly as the live execution
   * would. A reviewer that genuinely died mid-flight recorded no terminal
   * (or an undecodable one) and honestly stays unknowable.
   */
  async #adoptReview(
    _ctx: RunContext,
    existing: DurableRunEffect,
    attempt: number,
  ): Promise<EffectExecution | undefined> {
    const childRunId = existing.childRunId;
    if (childRunId === undefined) return undefined;
    const inspection = await this.#deps.spawner.inspect(childRunId);
    if (inspection.state === "unknown") return undefined;
    const outcome =
      inspection.state === "terminal"
        ? inspection.outcome
        : await inspection.outcome;
    if (outcome.status === "unknown_outcome") return undefined;
    if (outcome.status === "completed") {
      const payload = decodeWorkflowReviewTerminal(outcome.finalMessage);
      if (payload === undefined) {
        this.#deps.warn(
          `workflow review child ${childRunId} terminal carries no decodable review payload; the outcome stays unknown`,
        );
        return undefined;
      }
      return this.#reviewExecution(
        attempt,
        payload.review,
        payload.reviewerModel,
        payload.artifact,
      );
    }
    return {
      outcome: outcome.status === "cancelled" ? "cancelled" : "failed",
      evidence: {
        stage: "workflow.review",
        attempt,
        failure: {
          reason:
            outcome.stopReason ?? (outcome.status === "cancelled"
              ? "review_cancelled"
              : "review_unparseable"),
          ...(outcome.finalMessage !== null
            ? { message: outcome.finalMessage }
            : {}),
        },
      },
    };
  }

  async #adoptChild(
    _ctx: RunContext,
    existing: DurableRunEffect,
  ): Promise<EffectExecution | undefined> {
    const childRunId = existing.childRunId;
    if (childRunId === undefined) return undefined;
    const inspection = await this.#deps.spawner.inspect(childRunId);
    if (inspection.state === "unknown") return undefined;
    const outcome =
      inspection.state === "terminal"
        ? inspection.outcome
        : await inspection.outcome;
    if (outcome.status === "unknown_outcome") return undefined;
    // Intent-only rows carry no evidence yet; derive stage/attempt from the
    // durable step id itself.
    const parsed = parseWorkflowStepId(existing.stepId);
    const mapped: "committed" | "failed" | "cancelled" =
      outcome.status === "completed"
        ? "committed"
        : outcome.status === "cancelled"
          ? "cancelled"
          : "failed";
    const heldUnknown = outcome.usageHeldUnknownCount ?? 0;
    return {
      outcome: mapped,
      evidence: {
        ...(parsed !== undefined
          ? { stage: parsed.stage, attempt: parsed.attempt }
          : {}),
        child: {
          childRunId,
          status: outcome.status,
          ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
          // toEvidence decorates the full report before bounding it for commit.
          ...(outcome.finalMessage !== null
            ? { finalMessage: outcome.finalMessage }
            : {}),
          ...(outcome.usage !== null ? { usage: outcome.usage } : {}),
          ...(heldUnknown > 0 ? { usageHeldUnknown: heldUnknown } : {}),
        },
      },
      ...(outcome.usage !== null
        ? {
            rollupUsage: {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              costUsd: outcome.usage.costUsd,
            },
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Per-step durable driver
  // -------------------------------------------------------------------------

  async #runStageWithRetries(
    ctx: RunContext,
    input: {
      readonly stage: WorkflowStepId;
      readonly maxAttempts: number;
      readonly makePlan: (attempt: number) => EffectStepPlan;
    },
  ): Promise<{ readonly result: EffectStepResult; readonly attempt: number }> {
    let attempt = Math.max(
      1,
      deriveStageProjection(input.stage, ctx.repo.listEffects(ctx.runId))
        .attempts,
    );
    for (;;) {
      const result = await this.#driveEffect(ctx, input.makePlan(attempt));
      if (result.outcome === "committed") return { result, attempt };
      if (result.outcome === "cancelled") {
        throw new WorkflowHaltError({
          status: "cancelled",
          stopReason: null,
          finalMessage: `workflow cancelled during ${input.stage}`,
        });
      }
      if (result.outcome === "unknown_outcome") {
        throw new WorkflowHaltError({
          status: "unknown_outcome",
          stopReason: "unknown_outcome_effect",
          finalMessage: `${input.stage} attempt ${attempt} has an unresolved unknown outcome`,
        });
      }
      this.#haltPermanentChildFailure(result);
      if (attempt >= input.maxAttempts) {
        throw new WorkflowHaltError({
          status: "failed",
          stopReason: "step_retries_exhausted",
          finalMessage: failedStepMessage(`${input.stage} failed terminally after ${attempt} attempt(s)`, result),
        });
      }
      attempt += 1;
    }
  }

  #haltPermanentChildFailure(result: EffectStepResult): void {
    const stopReason = result.evidence.child?.stopReason ?? result.evidence.failure?.reason;
    if (!isWorkflowChildStopReason(stopReason)) return;
    throw new WorkflowHaltError({
      status: "failed",
      stopReason: stopReason === "approval_required" || stopReason === "policy_denied"
        ? stopReason : "budget_exhausted",
      finalMessage: workflowStopMessage(stopReason),
    });
  }

  /**
   * The durable per-step driver: replay short-circuit → D3 recovery →
   * admission acquire → intent journal → dispatch → execute → result
   * journal → budget reconcile, with failpoints at every boundary.
   */
  async #driveEffect(
    ctx: RunContext,
    plan: EffectStepPlan,
  ): Promise<EffectStepResult> {
    const existing = ctx.repo.getEffect(ctx.runId, plan.stepId);
    if (existing?.outcome !== undefined) {
      // Sticky durable outcome — replay, never re-execute. A replayed spawn
      // step re-accumulates its durably recorded child usage so the
      // post-restart terminal rollup stays honest (the in-memory rollup
      // restarts at zero on resume; the durable evidence is the source).
      const evidence = readWorkflowStepEvidence(existing);
      const childUsage = evidence.child?.usage;
      if (childUsage !== undefined) {
        this.#accumulateUsage(ctx, {
          inputTokens: childUsage.inputTokens,
          outputTokens: childUsage.outputTokens,
          costUsd: childUsage.costUsd,
        });
      }
      return {
        outcome: existing.outcome,
        evidence,
        replayed: true,
      };
    }
    if (existing !== undefined && plan.recoveryCategory === "side-effecting") {
      // D3: ADOPT, never respawn.
      const adopted = plan.adopt === undefined
        ? undefined
        : await plan.adopt(existing);
      if (adopted === undefined) {
        ctx.journal.appendUnknown({
          stepId: plan.stepId,
          reason: "child_outcome_unknowable_after_recovery",
          evidence: {
            stage: plan.stage,
            attempt: plan.attempt,
            ...(existing.childRunId !== undefined
              ? { childRunId: existing.childRunId }
              : {}),
          },
          observedAt: this.#nowIso(),
        });
        return {
          outcome: "unknown_outcome",
          evidence: readWorkflowStepEvidence(
            ctx.repo.getEffect(ctx.runId, plan.stepId)!,
          ),
          replayed: false,
        };
      }
      if (adopted.rollupUsage !== undefined) {
        this.#accumulateUsage(ctx, adopted.rollupUsage);
      }
      return this.#commitResult(ctx, plan, adopted, false);
    }
    // Fresh execution (or idempotent re-execution under the same durable
    // key). Admission gates EVERY execution.
    if (existing === undefined && plan.stage !== "workflow.intake") {
      const effects = ctx.repo.listEffects(ctx.runId);
      if (!stagePrerequisitesMet(plan.stage, effects)) {
        throw new WorkflowHaltError({
          status: "failed",
          stopReason: null,
          finalMessage: `internal prerequisite violation: ${plan.stage} attempted before its prerequisites committed`,
        });
      }
    }
    let lease: AdmissionLease;
    try {
      lease = await ctx.admission.acquire({
        stepId: plan.stepId,
        kind: plan.kind,
        sessionId: ctx.journal.sessionId,
        maxInputTokens: plan.estimate.maxInputTokens,
        maxOutputTokens: plan.estimate.maxOutputTokens,
        maxCostUsd: plan.estimate.maxCostUsd,
        ...(plan.model !== undefined ? { model: plan.model } : {}),
        ...(plan.provider !== undefined ? { provider: plan.provider } : {}),
        ...(ctx.spec.budget.deadlineAt !== undefined
          ? { deadlineAt: ctx.spec.budget.deadlineAt }
          : {}),
      });
    } catch (error) {
      if (error instanceof AdmissionDeniedError) {
        throw this.#admissionHalt(plan, error);
      }
      throw error;
    }
    const reservationId = lease.reservation.reservationId;
    let crashInjected = false;
    let settled = false;
    let dispatched = false;
    try {
      if (existing === undefined) {
        ctx.journal.appendIntent({
          stepId: plan.stepId,
          callId: plan.stepId,
          toolName: plan.toolName,
          recoveryCategory: plan.recoveryCategory,
          ...(plan.idempotencyKey !== undefined
            ? { idempotencyKey: plan.idempotencyKey }
            : {}),
          intentDigest: plan.intentDigest,
          ...(plan.childRunId !== undefined
            ? { childRunId: plan.childRunId }
            : {}),
          intentAt: this.#nowIso(),
        });
      }
      if (lease.signal.aborted) {
        const bound = workflowAdmissionStopReason(lease.signal.reason);
        const result = this.#commitResult(
          ctx,
          plan,
          {
            outcome: bound === undefined ? "cancelled" : "failed",
            evidence: {
              stage: plan.stage,
              attempt: plan.attempt,
              failure: { reason: bound ?? "cancelled_before_dispatch" },
            },
          },
          false,
        );
        ctx.admission.void(reservationId, "workflow_cancelled_before_dispatch");
        settled = true;
        return result;
      }
      if (plan.beforeExecuteFailpoint !== undefined) {
        hitM5WorkflowFailpoint(plan.beforeExecuteFailpoint);
      }
      ctx.admission.markDispatched(reservationId, {
        boundary: plan.kind === "spawn" ? "spawn_commit" : "tool_effect",
        details: { toolName: plan.toolName, stepId: plan.stepId },
      });
      dispatched = true;
      const scope = new ProviderWaitScope();
      this.#providerWaits.set(ctx.runId, { stepId: plan.stepId, scope });
      let execution: EffectExecution;
      try {
        execution = await scope.run(() => plan.execute(lease.signal));
      } finally {
        this.#providerWaits.delete(ctx.runId);
      }
      const bound = lease.signal.aborted ? workflowAdmissionStopReason(lease.signal.reason) : undefined;
      if (bound !== undefined) {
        execution = { ...execution, outcome: "failed", evidence: { ...execution.evidence,
          failure: { reason: bound, message: workflowStopMessage(bound) } } };
      }
      for (const failpoint of plan.beforeCommitFailpoints ?? []) {
        hitM5WorkflowFailpoint(failpoint);
      }
      const result = this.#commitResult(ctx, plan, execution, false);
      if (plan.afterCommitFailpoint !== undefined) {
        hitM5WorkflowFailpoint(plan.afterCommitFailpoint);
      }
      if (execution.usage !== undefined) {
        ctx.admission.reconcile(reservationId, execution.usage);
        this.#accumulateUsage(ctx, execution.usage);
      } else {
        ctx.admission.reconcile(reservationId, {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
      }
      if (execution.rollupUsage !== undefined) {
        this.#accumulateUsage(ctx, execution.rollupUsage);
      }
      settled = true;
      return result;
    } catch (error) {
      if (error instanceof M5WorkflowFailpointError) {
        crashInjected = true;
        throw error;
      }
      if (error instanceof WorkflowHaltError) {
        if (!settled) {
          if (dispatched) {
            ctx.admission.holdUnknown(reservationId, "workflow_halt_after_dispatch");
          } else {
            ctx.admission.void(reservationId, "workflow_halt_before_dispatch");
          }
          settled = true;
        }
        throw error;
      }
      if (!settled) {
        if (lease.signal.aborted) {
          const bound = workflowAdmissionStopReason(lease.signal.reason);
          this.#commitResult(
            ctx,
            plan,
            {
              outcome: bound === undefined ? "cancelled" : "failed",
              evidence: {
                stage: plan.stage,
                attempt: plan.attempt,
                failure: {
                  reason: bound ?? (dispatched ? "cancelled_after_dispatch" : "cancelled_before_dispatch"),
                  message: errorMessage(error),
                },
              },
            },
            dispatched,
          );
          if (dispatched) ctx.admission.holdUnknown(reservationId, "workflow_cancelled_after_dispatch");
          else ctx.admission.void(reservationId, "workflow_cancelled_before_dispatch");
          settled = true;
          throw new WorkflowHaltError({
            status: bound === undefined ? "cancelled" : "failed",
            stopReason: bound === undefined ? null : "budget_exhausted",
            finalMessage: bound === undefined ? `workflow cancelled during ${plan.stepId}` : workflowStopMessage(bound),
          });
        }
        if (dispatched && plan.recoveryCategory === "side-effecting") {
          // The physical spawn may or may not have taken effect: the ONLY
          // honest durable state is unknown_outcome (D3).
          ctx.journal.appendUnknown({
            stepId: plan.stepId,
            reason: "spawn_failed_after_dispatch_without_acknowledgement",
            evidence: {
              stage: plan.stage,
              attempt: plan.attempt,
              failure: { reason: "spawn_error", message: errorMessage(error) },
            },
            observedAt: this.#nowIso(),
          });
          ctx.admission.holdUnknown(reservationId, "workflow_spawn_unknown");
          settled = true;
          throw new WorkflowHaltError({
            status: "unknown_outcome",
            stopReason: "unknown_outcome_effect",
            finalMessage: `${plan.stepId} failed after dispatch without acknowledgement: ${errorMessage(error)}`,
          });
        }
        // Idempotent execution failure is a KNOWN failure: durable, retryable
        // under a new attempt id.
        this.#commitResult(
          ctx,
          plan,
          {
            outcome: "failed",
            evidence: {
              stage: plan.stage,
              attempt: plan.attempt,
              failure: {
                reason: "step_execution_failed",
                message: errorMessage(error),
              },
            },
          },
          true,
        );
        if (dispatched) {
          ctx.admission.reconcile(reservationId, {
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          });
        } else {
          ctx.admission.void(reservationId, "workflow_step_failed_before_dispatch");
        }
        settled = true;
        return {
          outcome: "failed",
          evidence: readWorkflowStepEvidence(
            ctx.repo.getEffect(ctx.runId, plan.stepId)!,
          ),
          replayed: false,
        };
      }
      throw error;
    } finally {
      if (!crashInjected) {
        ctx.admission.acknowledgeCompletion(reservationId);
      }
    }
  }

  #commitResult(
    ctx: RunContext,
    plan: EffectStepPlan,
    execution: EffectExecution,
    swallowJournalErrors: boolean,
  ): EffectStepResult {
    try {
      ctx.journal.appendResult({
        stepId: plan.stepId,
        outcome: execution.outcome,
        resultDigest: sha256Digest(canonicalizeJson(execution.evidence)),
        evidence: execution.evidence,
        completedAt: this.#nowIso(),
      });
    } catch (error) {
      if (error instanceof M5WorkflowFailpointError || !swallowJournalErrors) {
        throw error;
      }
      this.#deps.warn(
        `workflow ${ctx.runId} failed to journal ${plan.stepId} ${execution.outcome}: ${errorMessage(error)}`,
      );
    }
    return {
      outcome: execution.outcome,
      evidence: execution.evidence,
      replayed: false,
    };
  }

  #admissionHalt(
    plan: EffectStepPlan,
    error: AdmissionDeniedError,
  ): WorkflowHaltError {
    const bound = workflowAdmissionStopReason(error);
    if (bound !== undefined) {
      return new WorkflowHaltError({ status: "failed", stopReason: "budget_exhausted",
        finalMessage: workflowStopMessage(bound) });
    }
    if (error.decision === "cancelled") {
      return new WorkflowHaltError({
        status: "cancelled",
        stopReason: null,
        finalMessage: `workflow cancelled at ${plan.stepId}: ${error.reason}`,
      });
    }
    if (error.decision === "approval_required") {
      // D5: approvals resolve at intake; a mid-pipeline approval requirement
      // terminates the run — durable, honest, replayable. No parking.
      return new WorkflowHaltError({
        status: "failed",
        stopReason: "approval_required",
        finalMessage: "The Goal stopped because a required approval was not received. Please try again and approve the requested action.",
      });
    }
    return new WorkflowHaltError({
      status: "failed",
      stopReason:
        plan.stage === "workflow.intake" ? "policy_denied" : "budget_exhausted",
      finalMessage: `admission denied at ${plan.stepId}: ${error.reason}`,
    });
  }

  #accumulateUsage(ctx: RunContext, usage: AdmissionUsage): void {
    ctx.usage.input += usage.inputTokens;
    ctx.usage.output += usage.outputTokens;
    ctx.usage.cost += usage.costUsd ?? 0;
    ctx.usage.any = true;
  }

  // -------------------------------------------------------------------------
  // D6 — the single terminal choke point
  // -------------------------------------------------------------------------

  async #terminalize(
    ctx: RunContext,
    terminal: WorkflowTerminalIntent,
    gates?: CompletedGates,
  ): Promise<void> {
    if (ctx.terminalized) return;
    const existing = ctx.repo.getCurrentTerminalResult(ctx.runId);
    if (existing !== undefined) {
      ctx.terminalized = true;
      return;
    }
    if (terminal.status !== "completed" && ctx.handle !== undefined) {
      terminal = {
        ...terminal,
        finalMessage: `${terminal.finalMessage ?? "The Goal stopped."} Work is preserved in ${ctx.handle.path} (branch ${ctx.handle.branch}).`,
      };
    }
    if (terminal.status === "completed") {
      const failures: string[] = [];
      if (gates === undefined) failures.push("completed gates missing");
      else {
        if (!gates.allCommandsPassed) {
          failures.push("a required verification command did not exit 0");
        }
        if (gates.verificationVerdict !== "PASS") {
          failures.push(
            `verification agent verdict is ${gates.verificationVerdict ?? "missing"}, not PASS`,
          );
        }
        if (gates.reviewBlockerCount !== 0) {
          failures.push(
            `independent review holds ${gates.reviewBlockerCount} blocker(s)`,
          );
        }
        if (!gates.ledgerSealed) failures.push("evidence ledger is not sealed");
        // gates.record already passed assembleVerifiedChangeRecord's
        // mechanical self-validation or we would never have gotten here.
      }
      if (failures.length > 0) {
        this.#deps.warn(
          `workflow ${ctx.runId} refused a completed terminal: ${failures.join("; ")}`,
        );
        await this.#terminalize(ctx, {
          status: "failed",
          stopReason: "evidence_invalid",
          finalMessage: `completed gates failed: ${failures.join("; ")}`,
        });
        return;
      }
    }
    let terminalWrite: Parameters<StateRunDurabilityRepository["recordTerminalResult"]>[0] | undefined;
    let usage: RunUsageTotals | null = null;
    try {
      try {
        usage = this.#canonicalUsage(ctx);
      } catch (error) {
        this.#deps.warn(
          `workflow ${ctx.runId} canonical usage is unavailable: ${errorMessage(error)}`,
        );
      }
      const finishedAt = this.#nowIso();
      const terminalEvent = ctx.journal.appendTerminal({
        status: terminal.status,
        stopReason: terminal.stopReason,
        finalMessage: terminal.finalMessage,
        usage,
        finishedAt,
      });
      terminalWrite = {
        epoch: ctx.journal.epoch,
        eventId: terminalEvent.eventId,
        result: {
          runId: ctx.runId,
          status: terminal.status,
          exitCode: terminal.status === "completed" ? 0 : 1,
          stopReason: terminal.stopReason,
          finalMessage: terminal.finalMessage,
          usage,
          lastSequence: terminalEvent.sequence,
          finishedAt,
        },
      };
      ctx.repo.recordTerminalResult(terminalWrite);
      ctx.terminalized = true;
    } catch (error) {
      if (error instanceof M5WorkflowFailpointError) throw error;
      this.#deps.warn(
        `workflow ${ctx.runId} failed to record its terminal result: ${errorMessage(error)}`,
      );
      if (terminalWrite !== undefined) {
        // The journal append succeeded. Retry its exact projection so replay
        // cannot later encounter a conflicting terminal event or timestamp.
        try {
          ctx.repo.recordTerminalResult(terminalWrite);
          ctx.terminalized = true;
        } catch (retryError) {
          this.#deps.warn(`workflow ${ctx.runId} terminal projection retry failed: ${errorMessage(retryError)}`);
        }
      } else {
        // A broken rollout file must not leave a stopped Goal looking live.
        // The same durable-only path used by offline cancellation remains
        // available when SQLite is writable. Never call this completion:
        // without a terminal journal boundary the work needs recovery.
        ctx.terminalized = this.#recordDetachedTerminal(
          ctx.repo,
          ctx.runId,
          terminal.status === "cancelled" ? "cancelled" : "failed",
          `The Goal stopped because its final status could not be saved to the run journal: ${errorMessage(error)}. ${terminal.finalMessage ?? ""}` +
            (terminal.status === "completed" && ctx.handle !== undefined
              ? ` Work is preserved in ${ctx.handle.path} (branch ${ctx.handle.branch}).`
              : ""),
          { usage, stopReason: terminal.status === "completed" ? "evidence_invalid" : terminal.stopReason },
        );
      }
      if (!ctx.terminalized) {
        this.#observePersistenceFailure(ctx.repo, ctx.runId, error, {
          usage,
          ...(ctx.handle !== undefined ? { worktree: { path: ctx.handle.path, branch: ctx.handle.branch } } : {}),
        });
      }
    }
  }

  #canonicalUsage(ctx: RunContext): RunUsageTotals | null {
    const summary = ctx.admission?.getUsageSummary?.();
    if (summary !== undefined && summary.runId !== ctx.runId) {
      throw new Error(`canonical usage belongs to ${summary.runId}, not workflow ${ctx.runId}`);
    }
    if (summary === undefined || summary.hasUnknownCost) return null;
    return {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      totalTokens: summary.totalTokens,
      costUsd: summary.costUsd,
      ...(summary.costEstimated !== undefined ? { costEstimated: summary.costEstimated } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Context guards
  // -------------------------------------------------------------------------

  #requireHandle(ctx: RunContext): WorktreeHandle {
    if (ctx.handle === undefined) {
      throw new Error("workflow worktree handle is not provisioned");
    }
    return ctx.handle;
  }

  #requireLedger(ctx: RunContext): WorkflowEvidenceLedger {
    if (ctx.ledger === undefined) {
      throw new Error("workflow evidence ledger is not initialized");
    }
    return ctx.ledger;
  }

  #requireExport(ctx: RunContext): ExportedPatchArtifacts {
    if (ctx.export === undefined) {
      throw new Error("workflow patch export is not available");
    }
    return ctx.export;
  }
}

// ---------------------------------------------------------------------------
// Spec freeze + prompts
// ---------------------------------------------------------------------------

/**
 * The reviewer model is resolved once, here, and pinned: the caller's
 * `reviewerModel`, else the caller's `model`, else the model the daemon gives
 * a new session. A start that can name none is refused instead of freezing a
 * name the provider has never heard of.
 */
function resolveReviewerModel(
  runId: string,
  params: WorkflowStartParams,
  daemonDefaultModel: string | undefined,
): string {
  const candidate =
    params.reviewerModel ?? params.model ?? daemonDefaultModel;
  const trimmed = candidate?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new WorkflowIntakeError(
      runId,
      null,
      "no reviewer model: pass `reviewerModel` or `model`, or configure the daemon's default model",
    );
  }
  return trimmed;
}

function freezeWorkflowSpec(
  runId: string,
  params: WorkflowStartParams,
  base: BaseState,
  daemonDefaultModel: string | undefined,
  continuationOf?: WorkflowContinuation,
): WorkflowSpec {
  return {
    runId,
    goal: params.goal,
    ...(params.lightMode !== undefined ? { lightMode: params.lightMode } : {}),
    repoPath: params.repoPath,
    baseCommit: base.baseCommit,
    ...(continuationOf !== undefined ? { continuationOf } : {}),
    baseDirty: {
      dirty: base.dirty,
      summaryDigest: base.summaryDigest,
      fileCount: base.fileCount,
    },
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    reviewerModel: resolveReviewerModel(runId, params, daemonDefaultModel),
    permissionMode: resolveWorkflowPermissionMode(params.permissionMode),
    ...(params.unattendedAllow !== undefined
      ? { unattendedAllow: params.unattendedAllow }
      : {}),
    ...(params.unattendedDeny !== undefined
      ? { unattendedDeny: params.unattendedDeny }
      : {}),
    budget: params.budget ?? {},
    requiredVerification: params.requiredVerification,
    maxImplementAttempts:
      params.maxImplementAttempts ?? DEFAULT_MAX_IMPLEMENT_ATTEMPTS,
  };
}

const AUTONOMOUS_GOAL_INSTRUCTIONS = [
  "Goal mode is autonomous. For an open-ended goal or an obvious typo, choose a reasonable interpretation, state it as an assumption, and proceed.",
  "Ask the user for clarification only when no reasonable interpretation exists; a missing product name, architecture, or existing project is not by itself a blocker.",
  "When the workspace has no project, create a small, complete, runnable project that fits the goal, with real tests, a build, or a smoke run that checks its behavior.",
  "Keep existing-project changes focused. Do not weaken, skip, or replace required verification to get a pass.",
].join("\n");

function buildPlanPrompt(spec: WorkflowSpec, previousFailure?: string): string {
  return [
    "You are the planning stage of a verified-change workflow.",
    "Produce a concrete implementation plan sufficient to fulfill the goal below.",
    AUTONOMOUS_GOAL_INSTRUCTIONS,
    "Include your interpretation, deliverables, and how each required command will verify them. In a greenfield workspace, plan the files and real checks the implementer must create; do not substitute true, :, exit 0, or echo.",
    "Do NOT modify any files. Respond with the plan or an explicit requirement conflict report.",
    PLAN_BLOCKED_INSTRUCTIONS,
    ...(previousFailure === undefined ? [] : [
      "## Previous plan validation failure",
      boundedWorkflowDiagnostic(previousFailure),
      "Correct the plan's check construction without weakening the goal or its acceptance criteria. No implementation has started.",
    ]),
    "",
    "## Goal",
    spec.goal,
    "",
    "## Required verification (every command must exit 0)",
    ...(spec.requiredVerification.length === 0 ? [
      "No client checks were supplied. Inspect the repository and select its real test, build or lint commands.",
      "For a new project, choose the commands the implementation will create, including tests and a CLI smoke run when applicable.",
      "These commands will be frozen when this plan commits and must pass unchanged. Run from the repository root; include any needed cd. Commands run in listed order.",
      "Commands are shell scripts. Do not use legacy backtick command substitution. Literal Markdown backticks must be single-quoted or escaped; double quotes still allow shell substitution. Prefer repository test scripts. For a complex assertion, plan a test file and invoke it instead of embedding code in a shell string.",
      'For an ordinary implementation plan, end with exactly one fenced agenc-verification block containing a JSON array of command strings, for example:',
      '```agenc-verification',
      '["npm test", "npm run build && node dist/cli.js --help"]',
      '```',
    ] : []),
    ...spec.requiredVerification.map(
      (command) => `- ${formatVerificationCommand(command.script)}`,
    ),
  ].join("\n");
}

function buildImplementPrompt(ctx: RunContext, attempt: number): string {
  const lines = [
    "You are the implementation stage of a verified-change workflow.",
    "Implement the goal below inside the current worktree.",
    "This worktree is owned by Goal. Leave changed and new files here.",
    "The Goal controller stages files, creates snapshot commits, exports evidence, and delivers the reviewable result.",
    "Do not run git add, git commit, git merge, or git push, or edit Git metadata.",
    "After the required checks, report changed files and test results. A child commit is not required for this stage.",
    AUTONOMOUS_GOAL_INSTRUCTIONS,
    "If the plan only asks for clarification despite a reasonable interpretation, correct that plan and implement the goal. Create any missing project and verification files, then run the required checks.",
    "",
    "## Goal",
    ctx.spec.goal,
    "",
    "## Plan",
    ctx.planText ?? "(no plan text recorded)",
    "",
    "## Required verification (every command must exit 0)",
    ...(ctx.plannedChecks ?? ctx.spec.requiredVerification).map((command) => `- ${formatVerificationCommand(command.script)}`),
  ];
  if (attempt > 1 && ctx.verification !== undefined) {
    lines.push(
      "",
      `## Previous verification failure (attempt ${attempt - 1})`,
      `Agent verdict: ${ctx.verifyVerdict ?? "missing"}`,
      ...ctx.verification.records.map(
        (record) => `- ${formatVerificationResult(record)}`,
      ),
    );
    // Soak F73: the verdict alone told the implementer nothing; the report
    // names the failures it has to fix.
    if (ctx.verifyReport !== undefined) {
      lines.push("", "### Verifier's report", ctx.verifyReport);
    }
    lines.push("", "Fix every failure reported above, then stop.");
  }
  return lines.join("\n");
}

function buildVerifyAgentPrompt(
  spec: WorkflowSpec,
  records: readonly VerifiedChangeCommandRecord[],
  planText: string | undefined,
  previous?: {
    readonly attempt: number;
    readonly verdict: string;
    readonly report: string;
  },
): string {
  return [
    "You are an ADVERSARIAL verification agent for a proposed code change.",
    "Independently verify the change in the current worktree against the goal.",
    "Re-run spot checks; do not trust the implementer's claims.",
    "Evaluate whether the stated interpretation reasonably fulfills an open-ended goal, including obvious typo corrections. Do not require clarification merely because several reasonable implementations exist.",
    "For a greenfield build goal, an empty workspace or a missing implementation is FAIL, not an environmental PARTIAL. Require a runnable deliverable and meaningful checks; a no-op command passing is not evidence of completion.",
    // Soak F65: the verifier wrote its fixtures to /tmp and by redirection into
    // tracked paths, and the sandbox refused both; say where scratch may go.
    "Write any scratch files or fixtures you need under `tmp/` inside the worktree:",
    "the sandbox refuses writes outside the workspace (including /tmp) and shell",
    "redirection into other workspace paths.",
    "",
    "## Goal",
    spec.goal,
    "",
    "## Plan and stated assumptions (assess independently against the goal)",
    planText ?? "(no plan text recorded)",
    "",
    // Soak F77: shown only `- verify: exit 0`, the verifier ran `verify` as a
    // command, got 127, and failed a change whose `npm test` had passed. The
    // label is a name for people. Name each command by its script, and say
    // the workflow already ran it.
    "## Required commands, already run",
    "The workflow ran each required command below in this worktree before you",
    "started. Each line is the complete command, exactly as the workflow ran it,",
    "then the exit code the workflow recorded.",
    ...records.map((record) => `- ${formatVerificationResult(record)}`),
    // Soak F73: a second verifier that starts blind re-derives the previous
    // findings from scratch; hand it the report and have it re-check those
    // first, then keep verifying independently.
    ...(previous !== undefined
      ? [
          "",
          `## Previous verification attempt ${previous.attempt} (verdict ${previous.verdict})`,
          "The change was re-implemented after this report. Re-check every",
          "failure it lists first, then continue your own independent verification.",
          "",
          previous.report,
        ]
      : []),
    "",
    "End your final message with exactly one line:",
    "VERDICT: PASS | FAIL | PARTIAL",
  ].join("\n");
}

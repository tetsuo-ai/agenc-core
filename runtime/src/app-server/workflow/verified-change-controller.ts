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

import {
  type AdmissionKind,
  type RunArtifactPointer,
  type RunStepIdentity,
  type RunTerminalStatus,
  type RunUsageTotals,
  type WorkflowSpec,
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
  ReviewParseError,
  runIndependentReview,
  type ReviewerInvoker,
} from "../../workflow/independent-review.js";
import type { ReviewOutput } from "../../session/review.js";
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  parseVerificationVerdict,
  type WorkflowCommandRunner,
} from "../../workflow/verification.js";
import {
  mintSealedEvidenceProof,
  workflowWorktreeSlug,
  type BaseMovementCheck,
  type BaseState,
  type EvidenceArtifactSink,
  type ExportedPatchArtifacts,
  type SealedEvidenceProof,
} from "../../workflow/worktree-lifecycle.js";
import {
  decodeWorkflowReviewTerminal,
  encodeWorkflowReviewTerminal,
  recordWorkflowChildTerminal,
} from "./child-terminals.js";
import { projectWorkflowStatus, type WorkflowRunStatus } from "./status-projection.js";
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
 * background-agent runner (`--permission-mode`/`--yolo` bootstrap argv +
 * `installUnattendedPermissionPolicy`) so children never run under the
 * daemon's default policy. Resumed runs re-resolve it from the durable
 * intake spec.
 */
export interface WorkflowRunSessionPolicy {
  readonly permissionMode: WorkflowSpec["permissionMode"];
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
}

export interface WorkflowJournalWriter {
  open(
    runId: string,
    context?: {
      readonly repoPath?: string;
      readonly policy?: WorkflowRunSessionPolicy;
    },
  ): Promise<WorkflowRunJournal>;
}

export type WorkflowSpawnKind = "plan" | "implement" | "verify_agent" | "review";

export interface WorkflowChildOutcome {
  readonly status: RunTerminalStatus;
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
    spec: Pick<WorkflowSpec, "runId" | "repoPath" | "baseCommit">,
  ): Promise<WorktreeHandle>;
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
  readonly evidenceLedger: (spec: WorkflowSpec) => Promise<WorkflowEvidenceLedger>;
  readonly warn: (message: string) => void;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
}

// ---------------------------------------------------------------------------
// Public parameter/result types
// ---------------------------------------------------------------------------

export interface WorkflowStartParams {
  readonly goal: string;
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
  readonly runId: string;
  readonly specDigest: Sha256Digest;
  readonly baseCommit: string;
  readonly baseDirty: WorkflowSpec["baseDirty"];
}

/** Intake failed before the pipeline began; the terminal result is durable. */
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
/** Bounded per-stage retry budget for stage-level (non-verdict) failures. */
const MAX_STAGE_ATTEMPTS = 2;
const ZERO_ESTIMATE = {
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxCostUsd: 0,
} as const;
const SPAWN_ESTIMATE_INPUT_TOKENS = 1_000_000;
const SPAWN_ESTIMATE_OUTPUT_TOKENS = 200_000;
const EVIDENCE_MESSAGE_LIMIT = 20_000;

// ---------------------------------------------------------------------------
// Internal control flow
// ---------------------------------------------------------------------------

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
  verification?: {
    readonly records: readonly VerifiedChangeCommandRecord[];
    readonly allPassed: boolean;
    readonly testResult: RunArtifactPointer;
  };
  verifyVerdict?: string;
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
  async start(params: WorkflowStartParams): Promise<WorkflowStartResult> {
    if (params.requiredVerification.length === 0) {
      throw new TypeError(
        "verified-change workflow requires at least one verification command",
      );
    }
    const runId = params.runId ?? this.#newRunId();
    const repo = this.#deps.durability({ runId, repoPath: params.repoPath });
    const journal = await this.#deps.journal.open(runId, {
      repoPath: params.repoPath,
      policy: {
        permissionMode: params.permissionMode ?? DEFAULT_PERMISSION_MODE,
        ...(params.unattendedAllow !== undefined
          ? { unattendedAllow: params.unattendedAllow }
          : {}),
        ...(params.unattendedDeny !== undefined
          ? { unattendedDeny: params.unattendedDeny }
          : {}),
      },
    });
    const base = await this.#deps.worktrees.captureBaseState(params.repoPath, {
      runId,
    });
    const spec = freezeWorkflowSpec(runId, params, base);
    const specDigest = computeSpecDigest(spec);
    const admission = this.#deps.admission({
      runId,
      sessionId: journal.sessionId,
      ...(params.workspaceId !== undefined
        ? { workspaceId: params.workspaceId }
        : {}),
      spec,
    });
    const ctx: RunContext = {
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
    try {
      await this.#stageIntake(ctx);
    } catch (error) {
      if (error instanceof M5WorkflowFailpointError) throw error;
      const terminal =
        error instanceof WorkflowHaltError
          ? error.terminal
          : ({
              status: "failed",
              stopReason: null,
              finalMessage: `workflow intake error: ${errorMessage(error)}`,
            } satisfies WorkflowTerminalIntent);
      await this.#terminalize(ctx, terminal);
      await this.#closeJournal(ctx);
      throw new WorkflowIntakeError(
        runId,
        terminal.stopReason,
        terminal.finalMessage ?? terminal.status,
      );
    }
    const pipeline = this.#continue(ctx);
    this.#active.set(runId, pipeline);
    return {
      runId,
      specDigest,
      baseCommit: spec.baseCommit,
      baseDirty: spec.baseDirty,
    };
  }

  /** Await the asynchronous pipeline for a started/resumed run (test hook). */
  awaitRun(runId: string): Promise<void> {
    return this.#active.get(runId) ?? Promise.resolve();
  }

  /** Durable status projection — works after restart, no live state needed. */
  status(runId: string): WorkflowRunStatus | undefined {
    const repo = this.#deps.durability({ runId });
    const effects = repo.listEffects(runId);
    const terminal = repo.getCurrentTerminalResult(runId);
    if (effects.length === 0 && terminal === undefined) return undefined;
    return projectWorkflowStatus({
      runId,
      effects,
      ...(terminal !== undefined ? { terminal } : {}),
    });
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
      if (repo.getCurrentTerminalResult(runId) !== undefined) continue;
      try {
        const started = await this.#resumeRun(repo, runId);
        if (started) resumed.push(runId);
      } catch (error) {
        if (error instanceof M5WorkflowFailpointError) throw error;
        this.#deps.warn(
          `workflow resume failed for ${runId}: ${errorMessage(error)}`,
        );
      }
    }
    return resumed;
  }

  async #resumeRun(
    repo: StateRunDurabilityRepository,
    runId: string,
  ): Promise<boolean> {
    const journal = await this.#deps.journal.open(runId);
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
          "workflow interrupted before the intake commit; the spec was never durable — re-submit the request",
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
    const pipeline = this.#continue(ctx);
    this.#active.set(runId, pipeline);
    return true;
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
    try {
      await this.#stageWorktree(ctx);
      await this.#stagePlan(ctx);
      await this.#implementVerifyLoop(ctx);
      await this.#stageReview(ctx);
      await this.#stageFinalize(ctx);
    } catch (error) {
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
      this.#active.delete(ctx.runId);
      await this.#closeJournal(ctx);
    }
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
      throw new WorkflowHaltError({
        status: result.outcome === "cancelled" ? "cancelled" : "failed",
        stopReason: null,
        finalMessage: `workflow intake ${result.outcome}`,
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
      makePlan: (attempt) =>
        this.#spawnPlan(ctx, {
          stage: "workflow.plan",
          stepId: stageStepId("workflow.plan", attempt),
          attempt,
          spawnKind: "plan",
          childRunId: `${ctx.runId}:plan#${attempt}`,
          prompt: buildPlanPrompt(ctx.spec),
        }),
    });
    ctx.planText = result.evidence.child?.finalMessage;
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
        if (attempt >= spec.maxImplementAttempts) {
          throw new WorkflowHaltError({
            status: "failed",
            stopReason: "step_retries_exhausted",
            finalMessage: `implement failed terminally after ${attempt} attempt(s)`,
          });
        }
        attempt += 1;
        continue;
      }
      const passed = await this.#stageVerify(ctx, attempt);
      if (passed) return;
      if (attempt >= spec.maxImplementAttempts) {
        throw new WorkflowHaltError({
          status: "failed",
          stopReason: "verification_failed",
          finalMessage:
            `verification did not pass after ${attempt} implement attempt(s): ` +
            `commands ${ctx.verification?.allPassed === true ? "passed" : "failed"}, ` +
            `agent verdict ${ctx.verifyVerdict ?? "missing"}`,
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
    for (const [index, command] of spec.requiredVerification.entries()) {
      const stepId = verifyCommandStepId(index + 1, attempt);
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
        intentDigest: sha256Digest(
          canonicalizeJson({
            script: command.script,
            treeHash: exported.treeHash,
          }),
        ),
        estimate: ZERO_ESTIMATE,
        execute: async () =>
          this.#executeVerificationCommand(ctx, command, attempt),
      });
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
        prompt: buildVerifyAgentPrompt(ctx.spec, records),
        decorate: (outcome) => {
          const verdict = parseVerificationVerdict(outcome.finalMessage ?? "");
          return {
            // A missing/malformed verdict is a FAIL, never an implicit pass.
            verdict: verdict ?? "FAIL",
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
      throw new WorkflowHaltError({
        status: "failed",
        stopReason: "step_retries_exhausted",
        finalMessage: "adversarial verification agent run failed terminally",
      });
    }
    const verdict = agent.evidence.verdict ?? "FAIL";
    ctx.verification = { records, allPassed, testResult };
    ctx.verifyVerdict = verdict;
    return allPassed && verdict === "PASS";
  }

  async #executeVerificationCommand(
    ctx: RunContext,
    command: { readonly label: string; readonly script: string },
    attempt: number,
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
      const result = await this.#deps.commands.run({
        script: command.script,
        cwd: handle.path,
        timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
      });
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
      timedOut = result.timedOut;
      truncated = result.truncated;
      durationMs = result.durationMs;
    } catch (error) {
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
          estimate: {
            maxInputTokens: SPAWN_ESTIMATE_INPUT_TOKENS,
            maxOutputTokens: SPAWN_ESTIMATE_OUTPUT_TOKENS,
            maxCostUsd: ctx.spec.budget.maxCostUsd ?? null,
          },
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
              if (error instanceof ReviewParseError) {
                // A settled-but-unparseable reviewer is a KNOWN failure —
                // durable for adoption too, so a crash in the commit window
                // resumes into the same failed outcome (and its bounded
                // retry), never into unknown_outcome.
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
                      reason: "review_unparseable",
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
    hitM5WorkflowFailpoint("before_patch_export");
    const exported = await this.#deps.worktrees.exportPatch({
      handle,
      baseCommit: spec.baseCommit,
      step: { runId: ctx.runId, stepId: "workflow.finalize" },
      sink: ledger,
    });
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
    try {
      await this.#deps.worktrees.cleanup({
        proof: mintSealedEvidenceProof({ runId: ctx.runId, sealDigest }),
        handle,
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
    const usage = ctx.usage.any
      ? {
          inputTokens: ctx.usage.input,
          outputTokens: ctx.usage.output,
          totalTokens: ctx.usage.input + ctx.usage.output,
          costUsd: ctx.usage.cost,
        }
      : null;
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
          ? "committed"
          : outcome.status === "cancelled"
            ? "cancelled"
            : "failed";
      // The child's usage is already reconciled at its durable source (the
      // child run's own admission reservations charge the shared allocation
      // scopes), so it rides `rollupUsage` — accumulated into the run's
      // terminal usage rollup, never re-reconciled against the parent spawn
      // reservation (that would double-charge the budget).
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
      estimate: {
        maxInputTokens: SPAWN_ESTIMATE_INPUT_TOKENS,
        maxOutputTokens: SPAWN_ESTIMATE_OUTPUT_TOKENS,
        maxCostUsd: spec.budget.maxCostUsd ?? null,
      },
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
        if (input.decorate !== undefined && child !== undefined) {
          return toEvidence({
            status: child.status as RunTerminalStatus,
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
            outcome.status === "cancelled"
              ? "review_cancelled"
              : "review_unparseable",
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
          ...(truncate(outcome.finalMessage) !== undefined
            ? { finalMessage: truncate(outcome.finalMessage)! }
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
      if (attempt >= input.maxAttempts) {
        throw new WorkflowHaltError({
          status: "failed",
          stopReason: "step_retries_exhausted",
          finalMessage: `${input.stage} failed terminally after ${attempt} attempt(s)`,
        });
      }
      attempt += 1;
    }
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
        const result = this.#commitResult(
          ctx,
          plan,
          {
            outcome: "cancelled",
            evidence: {
              stage: plan.stage,
              attempt: plan.attempt,
              failure: { reason: "cancelled_before_dispatch" },
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
      const execution = await plan.execute(lease.signal);
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
        if (dispatched && lease.signal.aborted) {
          this.#commitResult(
            ctx,
            plan,
            {
              outcome: "cancelled",
              evidence: {
                stage: plan.stage,
                attempt: plan.attempt,
                failure: {
                  reason: "cancelled_after_dispatch",
                  message: errorMessage(error),
                },
              },
            },
            true,
          );
          ctx.admission.holdUnknown(reservationId, "workflow_cancelled_after_dispatch");
          settled = true;
          throw new WorkflowHaltError({
            status: "cancelled",
            stopReason: null,
            finalMessage: `workflow cancelled during ${plan.stepId}`,
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
        finalMessage: `admission requires approval at ${plan.stepId}: ${error.reason}`,
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
    try {
      const usage = ctx.usage.any
        ? {
            inputTokens: ctx.usage.input,
            outputTokens: ctx.usage.output,
            totalTokens: ctx.usage.input + ctx.usage.output,
            costUsd: ctx.usage.cost,
          }
        : null;
      const terminalEvent = ctx.journal.appendTerminal({
        status: terminal.status,
        stopReason: terminal.stopReason,
        finalMessage: terminal.finalMessage,
        usage,
        finishedAt: this.#nowIso(),
      });
      ctx.repo.recordTerminalResult({
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
          finishedAt: this.#nowIso(),
        },
      });
      ctx.terminalized = true;
    } catch (error) {
      if (error instanceof M5WorkflowFailpointError) throw error;
      // Terminal recording must never take the daemon down; the run stays
      // open and startup recovery terminalizes it on the next resume.
      this.#deps.warn(
        `workflow ${ctx.runId} failed to record its terminal result: ${errorMessage(error)}`,
      );
    }
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

function freezeWorkflowSpec(
  runId: string,
  params: WorkflowStartParams,
  base: BaseState,
): WorkflowSpec {
  return {
    runId,
    goal: params.goal,
    repoPath: params.repoPath,
    baseCommit: base.baseCommit,
    baseDirty: {
      dirty: base.dirty,
      summaryDigest: base.summaryDigest,
      fileCount: base.fileCount,
    },
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    reviewerModel:
      params.reviewerModel ?? params.model ?? "default-reviewer",
    permissionMode: params.permissionMode ?? DEFAULT_PERMISSION_MODE,
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

function buildPlanPrompt(spec: WorkflowSpec): string {
  return [
    "You are the planning stage of a verified-change workflow.",
    "Produce a concrete, minimal implementation plan for the goal below.",
    "Do NOT modify any files — respond with the plan only.",
    "",
    "## Goal",
    spec.goal,
    "",
    "## Required verification (every command must exit 0)",
    ...spec.requiredVerification.map(
      (command) => `- ${command.label}: ${command.script}`,
    ),
  ].join("\n");
}

function buildImplementPrompt(ctx: RunContext, attempt: number): string {
  const lines = [
    "You are the implementation stage of a verified-change workflow.",
    "Implement the goal below inside the current worktree.",
    "",
    "## Goal",
    ctx.spec.goal,
    "",
    "## Plan",
    ctx.planText ?? "(no plan text recorded)",
  ];
  if (attempt > 1 && ctx.verification !== undefined) {
    lines.push(
      "",
      `## Previous verification failure (attempt ${attempt - 1})`,
      `Agent verdict: ${ctx.verifyVerdict ?? "missing"}`,
      ...ctx.verification.records.map(
        (record) =>
          `- ${record.label}: exit ${record.exitCode}` +
          (record.timedOut ? " (timed out)" : ""),
      ),
      "",
      "Fix the failures above, then stop.",
    );
  }
  return lines.join("\n");
}

function buildVerifyAgentPrompt(
  spec: WorkflowSpec,
  records: readonly VerifiedChangeCommandRecord[],
): string {
  return [
    "You are an ADVERSARIAL verification agent for a proposed code change.",
    "Independently verify the change in the current worktree against the goal.",
    "Re-run spot checks; do not trust the implementer's claims.",
    "",
    "## Goal",
    spec.goal,
    "",
    "## Required command results",
    ...records.map(
      (record) =>
        `- ${record.label}: exit ${record.exitCode}` +
        (record.timedOut ? " (timed out)" : ""),
    ),
    "",
    "End your final message with exactly one line:",
    "VERDICT: PASS | FAIL | PARTIAL",
  ].join("\n");
}

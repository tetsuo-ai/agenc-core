/**
 * M5 Phase 5 — daemon session-backed adapters for the verified-change
 * workflow's session-coupled seams.
 *
 * Each started (or resumed) workflow run gets ONE daemon-owned runtime
 * session, bootstrapped exactly like a background agent
 * (`bootstrapLocalRuntimeSession` with `conversationId = runId`, cwd = the
 * run's repository path, the shared execution-admission kernel, unattended
 * budget policy). That session provides every seam the Phase 4 controller
 * left pending:
 *
 * - journal: effect events are fsync-appended to the session's canonical
 *   rollout (`Session.emit` with `durable: true`, journal-assigned
 *   sequences) and then projected into the run's durability repository —
 *   the `RolloutStore.recordEffectEvent` journal-append-then-project
 *   contract, with the workflow's `childRunId` preserved on spawn intents.
 * - worktrees/commands: git and verification-command execution go through
 *   the session's sandbox execution broker (`forkForCwd`, supervised
 *   processes), never a bare child_process.
 * - spawner: plan/implement/verify-agent stages are `agents/delegate.ts`
 *   child agents inside the workflow worktree (the verification agent uses
 *   the built-in "verification" role). Live children are re-awaitable in
 *   process; a child from a previous daemon process is honestly `unknown`.
 * - reviewer: the independent review is `runAgenCReviewOneShot` through an
 *   isolated child session pinned to the spec's reviewer model.
 */

import { randomUUID } from "node:crypto";

import type {
  AgenCBootstrapFunction,
} from "../background-agent-runner.js";
import {
  bootstrapLocalRuntimeSession,
  type LocalRuntimeBootstrap,
} from "../../bin/bootstrap.js";
import { ensureAgentControl } from "../../bin/delegate-tool.js";
import { delegate } from "../../agents/delegate.js";
import type { AgentPath } from "../../agents/registry.js";
import type { ExecutionAdmissionKernel } from "../../budget/execution-admission-kernel.js";
import type { AuthBackend } from "../../auth/backend.js";
import type {
  EffectIntentEvent,
  EffectResultEvent,
  EffectUnknownOutcomeEvent,
  Event,
  EventMsg,
  RunTerminalEvent,
} from "../../session/event-log.js";
import {
  buildGuardianReviewSessionConfig,
  runAgenCReviewOneShot,
  type AgenCDelegateSessionLike,
} from "../../session/agenc-delegate.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";
import { runSupervisedProcess } from "../../utils/supervisedProcess.js";
import { applyUnattendedPermissionPolicyToContext } from "../../permissions/unattended-policy.js";
import type { PermissionModeRegistry } from "../../permissions/permission-mode.js";
import type { StateRunDurabilityRepository } from "../../state/run-durability.js";
import type { ReviewerInvoker } from "../../workflow/independent-review.js";
import type {
  WorkflowCommandResult,
  WorkflowCommandRunner,
} from "../../workflow/verification.js";
import {
  captureBaseState as captureBaseStateInRepo,
  checkBaseMovement as checkBaseMovementInRepo,
  cleanupAfterEvidence,
  exportPatchArtifacts,
  provisionWorkflowWorktree,
  workflowWorktreeSlug,
} from "../../workflow/worktree-lifecycle.js";
import type {
  WorkflowAgentSpawner,
  WorkflowChildInspection,
  WorkflowChildOutcome,
  WorkflowJournalWriter,
  WorkflowRunJournal,
  WorkflowRunSessionPolicy,
  WorkflowTerminalJournalIntent,
  WorkflowWorktreeBroker,
} from "./verified-change-controller.js";
import { parseWorkflowStepId } from "./steps.js";

const COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SETTLED_CHILDREN_LIMIT = 64;

/** Session-coupled seam failure with a stable, typed diagnostic. */
export class WorkflowSessionSeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSessionSeamError";
  }
}

export interface WorkflowSessionSeamsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly authBackend?: AuthBackend;
  readonly kernel: ExecutionAdmissionKernel;
  /**
   * The run's durability repository (same resolution the controller uses),
   * so journal projection and controller reads share one database.
   */
  readonly durability: (context: {
    readonly runId: string;
    readonly repoPath?: string;
  }) => StateRunDurabilityRepository;
  /**
   * Resolve a resumable run's recorded repository path from its durable
   * intake spec. `undefined` = never durably recorded (fall back to
   * `fallbackCwd` so the failure diagnostic itself stays journalable).
   */
  readonly resolveRunRepoPath: (runId: string) => string | undefined;
  /**
   * Resolve a resumable run's frozen permission policy from its durable
   * intake spec so a restarted daemon re-applies the SAME policy the run
   * was admitted under. `undefined` = no durable spec (the session keeps
   * the daemon default, which only ever happens for runs that are about to
   * be fail-closed anyway).
   */
  readonly resolveRunPolicy: (
    runId: string,
  ) => WorkflowRunSessionPolicy | undefined;
  readonly fallbackCwd: string;
  readonly warn: (message: string) => void;
  /** Test seam — production uses {@link bootstrapLocalRuntimeSession}. */
  readonly bootstrap?: AgenCBootstrapFunction;
}

export interface WorkflowSessionSeams {
  readonly journal: WorkflowJournalWriter;
  readonly worktrees: WorkflowWorktreeBroker;
  readonly commands: WorkflowCommandRunner;
  readonly spawner: WorkflowAgentSpawner;
  readonly reviewer: ReviewerInvoker;
  close(): Promise<void>;
}

interface RunSessionEntry {
  readonly runId: string;
  readonly repoPath: string;
  readonly bootstrap: LocalRuntimeBootstrap;
  readonly repo: StateRunDurabilityRepository;
  readonly liveChildren: Map<string, Promise<WorkflowChildOutcome>>;
  readonly settledChildren: Map<string, WorkflowChildOutcome>;
}

interface SessionEmitter {
  emit(
    event: { readonly id: string; readonly msg: EventMsg },
    opts: { readonly durable: boolean },
  ): Event;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalEventId(event: Event): string {
  if (typeof event.eventId === "string" && event.eventId.length > 0) {
    return event.eventId;
  }
  return `legacy-event:${event.seq}:${event.id}`;
}

function requireSequence(event: Event, what: string): number {
  const seq = event.seq;
  if (!Number.isSafeInteger(seq) || (seq ?? 0) <= 0) {
    throw new WorkflowSessionSeamError(
      `workflow ${what} event was journaled without a positive sequence`,
    );
  }
  return seq!;
}

function sessionBroker(
  entry: RunSessionEntry,
  cwd: string,
): SandboxExecutionBrokerLike {
  const broker = entry.bootstrap.session.services?.sandboxExecutionBroker;
  if (broker === undefined) {
    throw new WorkflowSessionSeamError(
      `workflow run ${entry.runId} session has no sandbox execution broker`,
    );
  }
  return broker.cwd === cwd ? broker : broker.forkForCwd(cwd);
}

/** Owning run id for a controller-minted child id (`<runId>:<kind>#<n>`). */
function ownerRunIdOfChild(childRunId: string): string | undefined {
  const separator = childRunId.lastIndexOf(":");
  return separator > 0 ? childRunId.slice(0, separator) : undefined;
}

// ---------------------------------------------------------------------------
// A1 — durable child terminals for cross-restart adoption
// ---------------------------------------------------------------------------

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
// A2 — spec permission policy on the run session
// ---------------------------------------------------------------------------

/**
 * Bootstrap argv for the spec's frozen permission mode — the exact
 * background-agent-runner mechanism (`buildBootstrapArgv`):
 * `bypassPermissions` rides `--yolo` (startup-selection wires the full
 * bypass semantics off that flag); every other mode rides
 * `--permission-mode <mode>`. Duplicate flags already present on the
 * daemon's argv are never doubled.
 */
export function workflowPermissionModeArgv(
  permissionMode: WorkflowRunSessionPolicy["permissionMode"],
  baseArgv: readonly string[] = process.argv,
): readonly string[] {
  const argv = [...baseArgv];
  if (
    permissionMode === "bypassPermissions" &&
    !argv.includes("--yolo") &&
    !argv.includes("--dangerously-bypass-approvals-and-sandbox") &&
    !argv.includes("--allow-dangerously-skip-permissions")
  ) {
    argv.push("--yolo");
  }
  if (
    permissionMode !== "bypassPermissions" &&
    !argv.includes("--permission-mode")
  ) {
    argv.push("--permission-mode", permissionMode);
  }
  return argv;
}

/**
 * Install the spec's unattended allow/deny lists on the run session —
 * mirrors the runner's `installUnattendedPermissionPolicy`. Explicit modes
 * (`bypassPermissions`/`plan`/`acceptEdits`) are preserved by
 * `applyUnattendedPermissionPolicyToContext`; `default` becomes
 * `unattended` with the declared lists.
 */
async function installWorkflowUnattendedPolicy(
  registry: PermissionModeRegistry,
  policy: WorkflowRunSessionPolicy,
): Promise<void> {
  if (
    policy.unattendedAllow === undefined &&
    policy.unattendedDeny === undefined
  ) {
    return;
  }
  const next = applyUnattendedPermissionPolicyToContext(registry.current(), {
    ...(policy.unattendedAllow !== undefined
      ? { allowlist: policy.unattendedAllow }
      : {}),
    ...(policy.unattendedDeny !== undefined
      ? { denylist: policy.unattendedDeny }
      : {}),
  });
  await registry.update(next);
}

interface StepJournalContext {
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryCategory: "idempotent" | "side-effecting" | "interactive";
  readonly idempotencyKey?: string;
  readonly intentEventSeq: number;
}

/**
 * Rollout-backed run journal: fsync-append the effect event to the run's
 * canonical rollout FIRST (journal-assigned sequence), then project it into
 * the durability repository. Projection goes through the repository
 * directly (the same observable semantics as
 * `RolloutStore.recordEffectEvent`) so the workflow's `childRunId` is
 * preserved on spawn intents.
 */
class SessionWorkflowJournal implements WorkflowRunJournal {
  readonly runId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly #entry: RunSessionEntry;
  readonly #onClose: () => Promise<void>;
  readonly #contexts = new Map<string, StepJournalContext>();
  #lastSequence = 0;

  constructor(entry: RunSessionEntry, onClose: () => Promise<void>) {
    this.#entry = entry;
    this.#onClose = onClose;
    this.runId = entry.runId;
    this.sessionId = entry.bootstrap.session.conversationId;
    this.epoch = entry.bootstrap.rolloutStore.runEpoch;
  }

  #emitDurable(msg: EventMsg, what: string): Event {
    const emitter = this.#entry.bootstrap.session as unknown as SessionEmitter;
    if (typeof emitter.emit !== "function") {
      throw new WorkflowSessionSeamError(
        `workflow run ${this.runId} session cannot journal ${what} events`,
      );
    }
    const event = emitter.emit({ id: randomUUID(), msg }, { durable: true });
    this.#lastSequence = requireSequence(event, what);
    return event;
  }

  #stepContext(stepId: string): StepJournalContext {
    const known = this.#contexts.get(stepId);
    if (known !== undefined) return known;
    // Adoption/resume path: the intent was journaled by a previous process.
    // Recover the durable identity fields from the projected effect row.
    const effect = this.#entry.repo.getEffect(this.runId, stepId);
    if (effect === undefined) {
      throw new WorkflowSessionSeamError(
        `workflow step ${stepId} has no journaled intent to acknowledge`,
      );
    }
    const context: StepJournalContext = {
      callId: effect.callId,
      toolName: effect.toolName,
      recoveryCategory: effect.recoveryCategory,
      ...(effect.idempotencyKey !== undefined
        ? { idempotencyKey: effect.idempotencyKey }
        : {}),
      intentEventSeq: effect.intentSequence,
    };
    this.#contexts.set(stepId, context);
    return context;
  }

  appendIntent(input: Parameters<WorkflowRunJournal["appendIntent"]>[0]) {
    const callId = input.callId ?? input.stepId;
    const payload: EffectIntentEvent = {
      runId: this.runId,
      stepId: input.stepId,
      callId,
      toolName: input.toolName,
      recoveryCategory: input.recoveryCategory,
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
      intentDigest: input.intentDigest,
      attempt: parseWorkflowStepId(input.stepId)?.attempt ?? 1,
      recordedAt: input.intentAt,
    };
    const event = this.#emitDurable(
      { type: "effect_intent", payload },
      "effect_intent",
    );
    const eventId = canonicalEventId(event);
    const sequence = requireSequence(event, "effect_intent");
    this.#entry.repo.beginEffect({
      runId: this.runId,
      epoch: this.epoch,
      stepId: input.stepId,
      ...(input.childRunId !== undefined
        ? { childRunId: input.childRunId }
        : {}),
      sessionId: this.sessionId,
      callId,
      toolName: input.toolName,
      recoveryCategory: input.recoveryCategory,
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
      intentDigest: input.intentDigest,
      eventId,
      eventSequence: sequence,
      intentAt: input.intentAt,
    });
    this.#contexts.set(input.stepId, {
      callId,
      toolName: input.toolName,
      recoveryCategory: input.recoveryCategory,
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
      intentEventSeq: sequence,
    });
    return { eventId, sequence };
  }

  appendResult(input: Parameters<WorkflowRunJournal["appendResult"]>[0]) {
    const context = this.#stepContext(input.stepId);
    const payload: EffectResultEvent = {
      runId: this.runId,
      stepId: input.stepId,
      callId: context.callId,
      toolName: context.toolName,
      recoveryCategory: context.recoveryCategory,
      ...(context.idempotencyKey !== undefined
        ? { idempotencyKey: context.idempotencyKey }
        : {}),
      intentEventSeq: context.intentEventSeq,
      outcome: input.outcome,
      ...(input.resultDigest !== undefined
        ? { resultDigest: input.resultDigest }
        : {}),
      ...(input.evidence !== undefined
        ? { evidence: input.evidence as Readonly<Record<string, unknown>> }
        : {}),
      recordedAt: input.completedAt,
    };
    const event = this.#emitDurable(
      { type: "effect_result", payload },
      "effect_result",
    );
    const eventId = canonicalEventId(event);
    const sequence = requireSequence(event, "effect_result");
    this.#entry.repo.completeEffect({
      runId: this.runId,
      stepId: input.stepId,
      outcome: input.outcome,
      eventId,
      eventSequence: sequence,
      ...(input.resultDigest !== undefined
        ? { resultDigest: input.resultDigest }
        : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      completedAt: input.completedAt,
    });
    return { eventId, sequence };
  }

  appendUnknown(input: Parameters<WorkflowRunJournal["appendUnknown"]>[0]) {
    const context = this.#stepContext(input.stepId);
    const payload: EffectUnknownOutcomeEvent = {
      runId: this.runId,
      stepId: input.stepId,
      callId: context.callId,
      toolName: context.toolName,
      recoveryCategory: context.recoveryCategory,
      ...(context.idempotencyKey !== undefined
        ? { idempotencyKey: context.idempotencyKey }
        : {}),
      intentEventSeq: context.intentEventSeq,
      outcome: "unknown_outcome",
      reason: input.reason,
      requiresReview: true,
      recordedAt: input.observedAt,
    };
    const event = this.#emitDurable(
      { type: "effect_unknown_outcome", payload },
      "effect_unknown_outcome",
    );
    const eventId = canonicalEventId(event);
    const sequence = requireSequence(event, "effect_unknown_outcome");
    this.#entry.repo.markEffectUnknown({
      runId: this.runId,
      stepId: input.stepId,
      eventId,
      eventSequence: sequence,
      reason: input.reason,
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      observedAt: input.observedAt,
    });
    return { eventId, sequence };
  }

  appendTerminal(intent?: WorkflowTerminalJournalIntent) {
    if (intent === undefined) {
      throw new WorkflowSessionSeamError(
        "the daemon workflow journal requires the terminal intent to journal run_terminal",
      );
    }
    const payload: RunTerminalEvent = {
      runId: this.runId,
      epoch: this.epoch,
      status: intent.status,
      exitCode: intent.status === "completed" ? 0 : 1,
      stopReason: intent.stopReason,
      finalMessage: intent.finalMessage,
      usage: intent.usage,
      lastSequenceBeforeTerminal:
        this.#lastSequence > 0 ? this.#lastSequence : null,
      finishedAt: intent.finishedAt,
    };
    const event = this.#emitDurable(
      { type: "run_terminal", payload },
      "run_terminal",
    );
    return {
      eventId: canonicalEventId(event),
      sequence: requireSequence(event, "run_terminal"),
    };
  }

  async close(): Promise<void> {
    await this.#onClose();
  }
}

/**
 * Build the real session-backed workflow seams. One daemon session per
 * started/resumed run, shared by every seam and torn down when the
 * controller closes the run's journal.
 */
export function createWorkflowSessionSeams(
  options: WorkflowSessionSeamsOptions,
): WorkflowSessionSeams {
  const bootstrap = options.bootstrap ?? bootstrapLocalRuntimeSession;
  const entries = new Map<string, Promise<RunSessionEntry>>();
  const worktreeRunIds = new Map<string, string>();

  const openEntry = (
    runId: string,
    repoPath?: string,
    policy?: WorkflowRunSessionPolicy,
  ): Promise<RunSessionEntry> => {
    const existing = entries.get(runId);
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<RunSessionEntry> => {
      const resolvedRepoPath =
        repoPath ?? options.resolveRunRepoPath(runId) ?? options.fallbackCwd;
      // A2: the frozen spec's policy governs the run session — explicit on
      // start, re-resolved from the durable intake spec on resume.
      const resolvedPolicy = policy ?? options.resolveRunPolicy(runId);
      const boot = await bootstrap({
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.authBackend !== undefined
          ? { authBackend: options.authBackend }
          : {}),
        conversationId: runId,
        // A started run is a fresh conversation; a resumed run re-opens the
        // rollout it journaled before the restart.
        resumeConversation: repoPath === undefined,
        cwd: resolvedRepoPath,
        ...(resolvedPolicy !== undefined
          ? { argv: workflowPermissionModeArgv(resolvedPolicy.permissionMode) }
          : {}),
        executionAdmissionAutonomous: true,
        executionAdmissionKernel: options.kernel,
        executionAdmissionBudgetIdentity: runId,
      });
      if (resolvedPolicy !== undefined) {
        await installWorkflowUnattendedPolicy(
          boot.session.permissionModeRegistry,
          resolvedPolicy,
        );
      }
      return {
        runId,
        repoPath: resolvedRepoPath,
        bootstrap: boot,
        repo: options.durability({ runId, repoPath: resolvedRepoPath }),
        liveChildren: new Map(),
        settledChildren: new Map(),
      };
    })();
    entries.set(runId, pending);
    pending.catch(() => {
      if (entries.get(runId) === pending) entries.delete(runId);
    });
    return pending;
  };

  const closeEntry = async (runId: string): Promise<void> => {
    const pending = entries.get(runId);
    if (pending === undefined) return;
    entries.delete(runId);
    try {
      const entry = await pending;
      await entry.bootstrap.shutdown();
    } catch (error) {
      options.warn(
        `workflow run ${runId} session shutdown failed: ${errorMessage(error)}`,
      );
    }
  };

  const requireEntry = async (
    runId: string | undefined,
    seam: string,
  ): Promise<RunSessionEntry> => {
    if (runId === undefined) {
      throw new WorkflowSessionSeamError(
        `workflow seam ${seam} was invoked without a run id`,
      );
    }
    const pending = entries.get(runId);
    if (pending === undefined) {
      throw new WorkflowSessionSeamError(
        `workflow seam ${seam} has no open session for run ${runId}`,
      );
    }
    return pending;
  };

  const journal: WorkflowJournalWriter = {
    open: async (runId, context) => {
      const entry = await openEntry(runId, context?.repoPath, context?.policy);
      return new SessionWorkflowJournal(entry, () => closeEntry(runId));
    },
  };

  const worktrees: WorkflowWorktreeBroker = {
    captureBaseState: async (repoPath, context) => {
      const entry = await requireEntry(
        context?.runId,
        "worktrees.captureBaseState",
      );
      return captureBaseStateInRepo(repoPath, sessionBroker(entry, repoPath));
    },
    provision: async (spec) => {
      const entry = await requireEntry(spec.runId, "worktrees.provision");
      const handle = await provisionWorkflowWorktree(
        spec,
        sessionBroker(entry, spec.repoPath),
      );
      worktreeRunIds.set(handle.path, spec.runId);
      return handle;
    },
    exportPatch: async (input) => {
      const entry = await requireEntry(
        input.step.runId,
        "worktrees.exportPatch",
      );
      return exportPatchArtifacts({
        handle: input.handle,
        baseCommit: input.baseCommit,
        step: input.step,
        sink: input.sink,
        broker: sessionBroker(entry, input.handle.gitRoot),
      });
    },
    checkBaseMovement: async (input) => {
      const entry = await requireEntry(
        input.spec.runId,
        "worktrees.checkBaseMovement",
      );
      return checkBaseMovementInRepo({
        spec: input.spec,
        patchBytes: input.patchBytes,
        broker: sessionBroker(entry, input.spec.repoPath),
      });
    },
    cleanup: async (input) => {
      const entry = await requireEntry(input.proof.runId, "worktrees.cleanup");
      worktreeRunIds.delete(input.handle.path);
      return cleanupAfterEvidence({
        proof: input.proof,
        handle: input.handle,
        broker: sessionBroker(entry, input.handle.gitRoot),
        warn: options.warn,
      });
    },
  };

  const commands: WorkflowCommandRunner = {
    run: async (input): Promise<WorkflowCommandResult> => {
      const runId = worktreeRunIds.get(input.cwd);
      const entry = await requireEntry(runId, "commands.run");
      const broker = sessionBroker(entry, input.cwd);
      const command = broker.prepareSpawn("child_agent", {
        program: "bash",
        args: ["-lc", input.script],
        cwd: input.cwd,
        env: Object.fromEntries(
          Object.entries(options.env ?? process.env).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string",
          ),
        ),
        argv0: "bash",
        trustedExecutable: true,
      });
      const startedAt = performance.now();
      const result = await runSupervisedProcess(command, {
        timeoutMs: input.timeoutMs,
        maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
      });
      return {
        exitCode:
          result.stopReason === "spawn_error"
            ? 127
            : (result.exitCode ?? (result.stopReason !== undefined ? 1 : 0)),
        stdout: new Uint8Array(result.stdout),
        stderr:
          result.error !== undefined && result.stderr.byteLength === 0
            ? new TextEncoder().encode(result.error.message)
            : new Uint8Array(result.stderr),
        timedOut: result.stopReason === "timeout",
        truncated: result.stopReason === "output_limit",
        durationMs: Math.round(performance.now() - startedAt),
      };
    },
  };

  const rememberSettled = (
    entry: RunSessionEntry,
    childRunId: string,
    outcome: WorkflowChildOutcome,
  ): void => {
    entry.settledChildren.set(childRunId, outcome);
    while (entry.settledChildren.size > SETTLED_CHILDREN_LIMIT) {
      const oldest = entry.settledChildren.keys().next().value;
      if (oldest === undefined) break;
      entry.settledChildren.delete(oldest);
    }
  };

  const spawner: WorkflowAgentSpawner = {
    spawn: async (input): Promise<WorkflowChildOutcome> => {
      const entry = await requireEntry(input.spec.runId, "spawner.spawn");
      const session = entry.bootstrap.session;
      const { control, registry } = ensureAgentControl(session);
      const pending = (async (): Promise<WorkflowChildOutcome> => {
        const outcome = await delegate({
          parent: session,
          parentPath: "/root" as AgentPath,
          control,
          registry,
          taskPrompt: input.prompt,
          ...(input.kind === "verify_agent" ? { role: "verification" } : {}),
          agentName: input.childRunId.replace(/[^a-zA-Z0-9._-]/g, "-"),
          ...(input.spec.model !== undefined
            ? { model: input.spec.model }
            : {}),
          // Fresh context by construction: the child sees ONLY its prompt.
          parentMessagesOverride: [],
          // Reuse the run's own deterministic worktree; getOrCreateWorktree
          // fast-resumes the existing checkout at the same slug.
          isolation: "worktree",
          worktreeSlug: workflowWorktreeSlug(input.spec.runId),
          runInBackground: false,
          forceSynchronous: true,
          silent: true,
          externalSignal: input.signal,
        });
        if (outcome.kind === "rejected") {
          return {
            status: "failed",
            finalMessage: `workflow ${input.kind} spawn rejected: ${outcome.reason}`,
            usage: null,
          };
        }
        if (outcome.kind !== "sync_completed") {
          throw new WorkflowSessionSeamError(
            `workflow ${input.kind} spawn did not run synchronously`,
          );
        }
        const result = outcome.result;
        const status: WorkflowChildOutcome["status"] =
          result.outcome === "completed"
            ? "completed"
            : result.outcome === "interrupted" || result.outcome === "aborted"
              ? "cancelled"
              : "failed";
        return {
          status,
          finalMessage: result.finalMessage ?? null,
          usage: null,
        };
      })();
      entry.liveChildren.set(input.childRunId, pending);
      try {
        const outcome = await pending;
        // A1: make the child's terminal durable BEFORE the parent effect
        // result can commit, keyed by the deterministic child run id the
        // effect intent recorded. This is exactly the window the M5 exit
        // criterion exercises — child finished, daemon dies before the
        // parent `effect_result` — and adoption recovers it after restart.
        try {
          recordWorkflowChildTerminal(entry.repo, input.childRunId, outcome);
        } catch (error) {
          options.warn(
            `workflow child ${input.childRunId} terminal was not durably recorded: ${errorMessage(error)}`,
          );
        }
        rememberSettled(entry, input.childRunId, outcome);
        return outcome;
      } finally {
        entry.liveChildren.delete(input.childRunId);
      }
    },
    inspect: async (childRunId): Promise<WorkflowChildInspection> => {
      const ownerRunId = ownerRunIdOfChild(childRunId);
      if (ownerRunId === undefined) return { state: "unknown" };
      const pending = entries.get(ownerRunId);
      const entry = pending === undefined ? undefined : await pending;
      if (entry !== undefined) {
        const settled = entry.settledChildren.get(childRunId);
        if (settled !== undefined) {
          return { state: "terminal", outcome: settled };
        }
        const live = entry.liveChildren.get(childRunId);
        if (live !== undefined) {
          return { state: "live", outcome: live };
        }
      }
      // A1 cross-restart adoption: a child from a previous daemon process
      // died with that process, but its terminal outcome may have been
      // durably recorded (keyed by this child id) before the crash. Adopt
      // that durable terminal. A child with NO durable terminal genuinely
      // has an unknowable outcome — the only honest answer stays `unknown`
      // (D3: the run terminates unknown_outcome with review pending, never
      // a silent respawn).
      try {
        const repo =
          entry?.repo ?? options.durability({ runId: ownerRunId });
        const durable = inspectWorkflowChildTerminal(repo, childRunId);
        if (durable !== undefined) {
          return { state: "terminal", outcome: durable };
        }
      } catch (error) {
        options.warn(
          `workflow child ${childRunId} durable-terminal inspection failed: ${errorMessage(error)}`,
        );
      }
      return { state: "unknown" };
    },
  };

  const reviewer: ReviewerInvoker = {
    invoke: async (input): Promise<string> => {
      const entry = await requireEntry(input.runId, "reviewer.invoke");
      const boot = entry.bootstrap;
      const outcome = await runAgenCReviewOneShot(
        boot.session as unknown as AgenCDelegateSessionLike,
        {
          subId: `workflow-review-${randomUUID()}`,
          config: buildGuardianReviewSessionConfig({
            parentConfig: boot.config,
            activeModel: input.reviewerModel,
            baseInstructions: input.systemPrompt,
          }),
          parentContext: boot.ctx,
          input: [{ role: "user", content: input.userMessage }],
          request: {
            target: "verified-change workflow",
            userFacingHint: "independent fresh-context review",
          },
          reviewerModel: input.reviewerModel,
          systemPrompt: input.systemPrompt,
          timeoutMs: input.timeoutMs,
          reuseKey: false,
        },
      );
      if (outcome.rawText === null) {
        throw (
          outcome.error ??
          new WorkflowSessionSeamError(
            `independent review produced no output (${outcome.verdict})`,
          )
        );
      }
      return outcome.rawText;
    },
  };

  return {
    journal,
    worktrees,
    commands,
    spawner,
    reviewer,
    close: async () => {
      const runIds = [...entries.keys()];
      for (const runId of runIds) {
        await closeEntry(runId);
      }
    },
  };
}

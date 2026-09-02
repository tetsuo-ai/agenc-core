/**
 * In-memory daemon lifecycle for user-started background agents.
 *
 * F-06a owns the launch path: start the background delegate loop, record its
 * daemon-visible agent summary, and seed the first daemon session with the
 * objective. F-06d adds explicit stop while keeping the final stopped summary
 * available for follow-up inspection.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RunRuntimeSettingsSnapshot } from "../contracts/run-contracts.js";
import { cloneFrozenRuntimeSettingsSnapshot } from "../state/runtime-settings-snapshot.js";

import { AsyncLock } from "../utils/async-lock.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import {
  createOperatorEffectReviewResolution,
  resolveDurableEffectReview,
} from "../state/effect-review.js";
import { StateRunDurabilityRepository } from "../state/run-durability.js";
import {
  listUnresolvedUnknownOutcomeEffects,
  resolveUnknownOutcomeEffect,
} from "../state/unknown-outcome-gate.js";
import {
  requireAbsoluteWorkspaceCwd,
  WorkspaceCwdError,
} from "./workspace-cwd.js";
import {
  AgenCBackgroundAgentMessageError,
  AgenCBackgroundAgentSuspensionShutdownError,
  sessionTranscriptV2FromRollout,
  type AgenCBackgroundAgentMessageResult,
  type AgenCBackgroundAgentSnapshot,
  type AgenCBackgroundAgentStartResult,
  type AgenCBackgroundAgentTerminalSnapshot,
  type AgenCBackgroundAgentRunner,
} from "./background-agent-runner.js";
import type {
  AgentAttachParams,
  AgentAttachResult,
  AgentAttachSessionSummary,
  AgentCreateParams,
  AgentCreateResult,
  AgentListParams,
  AgentListResult,
  AgentLogSession,
  AgentLogsParams,
  AgentLogsResult,
  AgentStopParams,
  AgentStopResult,
  AgentStatus,
  AgentSummary,
  AgentToolOutputLog,
  ElicitationRespondParams,
  ElicitationRespondResult,
  ExitPlanApprovalPayload,
  JsonObject,
  JsonValue,
  MessageContent,
  PermissionListParams,
  PermissionListResult,
  RunCancelParams,
  RunCancelResult,
  SessionCancelTurnParams,
  SessionCancelTurnResult,
  SessionClearParams,
  SessionClearResult,
  SessionMcpAddServerParams,
  SessionMcpAddServerResult,
  SessionMcpStatusParams,
  SessionMcpStatusResult,
  SessionMcpStatusServer,
  SessionMcpStatusTool,
  SessionMcpServerByNameParams,
  SessionMcpServerMutationResult,
  SessionSnapshotParams,
  SessionSnapshotResult,
  SessionTranscriptParams,
  SessionTranscriptResult,
  SessionTranscriptV2Params,
  SessionTranscriptV2Result,
  SessionPartialCompactFromMessageParams,
  SessionPartialCompactFromMessageResult,
  SessionRollbackCompactionParams,
  SessionRollbackCompactionResult,
  SessionExtendCompactionRollbackRetentionParams,
  SessionExtendCompactionRollbackRetentionResult,
  SessionResolveToolCallEvidenceParams,
  SessionResolveToolCallParams,
  SessionResolveToolCallResult,
  SessionRewindConversationToMessageParams,
  SessionRewindConversationToMessageResult,
  SessionFileRewindParams,
  SessionPreviewFileRewindResult,
  SessionRewindFilesToMessageResult,
  SessionShellExecuteParams,
  SessionShellExecuteResult,
  SessionSetModelParams,
  SessionSetModelResult,
  SessionSetPermissionModeParams,
  SessionSetPermissionModeResult,
  SessionPermissionRuleMutationParams,
  SessionPermissionRuleMutationResult,
  SessionHooksStatusParams,
  SessionHooksStatusResult,
  SessionHooksSetDisabledParams,
  SessionHooksSetDisabledResult,
  SessionApplyConfigParams,
  SessionApplyConfigResult,
  SessionSummary,
  ToolApproveParams,
  ToolCancelParams,
  ToolDecisionResult,
  ToolDenyParams,
} from "./protocol/index.js";
import {
  validateAgentRuntimeOptions,
  type AgentRuntimeOptions,
} from "../session/runtime-options.js";
import type { SessionEditorInteraction } from "../session/autonomous-mode.js";
import {
  getAgencHomeDir,
  createResumeRolloutDescriptorLease,
  hasSupportedFileIdentity,
  isSafeSessionIdSegment,
  resolveCanonicalSessionCwd,
  type ResumeRolloutDescriptorLease,
} from "../session/session-store.js";
import {
  ROLLOUT_SCHEMA_VERSION,
  type SessionMetaLine,
} from "../session/event-log.js";
import { parseRolloutLine, type RolloutItem } from "../session/rollout-item.js";
import { StrictCanonicalJournalValidator } from "../state/recovery-journal-contract.js";
import {
  DEFAULT_MAX_STARTUP_RECOVERY_MS,
  MAX_RECOVERY_CANONICAL_EVENTS,
  MAX_RECOVERY_CANONICAL_LINE_BYTES,
  MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
} from "../state/recovery-contract.js";
import {
  ABORT,
  APPROVED,
  APPROVED_FOR_SESSION,
  DENIED,
} from "../permissions/review-decision.js";
import {
  recordPermissionAuditEvent,
  type PermissionAuditErrorHandler,
  type PermissionAuditLogger,
} from "../permissions/permission-audit-log.js";
import { DEFAULT_UNATTENDED_ALLOWLIST } from "../permissions/unattended-policy.js";
import {
  consumeExitPlanModeApproval,
  recordExitPlanModeApproval,
  type ExitPlanModeApproval,
} from "../planning/exit-plan-approval.js";
import {
  dropAskUserQuestionResponse,
  parseAskUserQuestionInput,
  recordAskUserQuestionResponse,
} from "../tools/ask-user-question/tool.js";
import type { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import {
  ThreadNotFoundError,
  ThreadStoreInvalidRequestError,
  type StoredThread,
  type ThreadSource,
  type ThreadStore,
} from "../thread-store/store.js";
import {
  isAgentThreadSource,
  threadSourceStringField,
} from "../thread-store/thread-source.js";
import type { Event } from "../session/event-log.js";
import type { ResponseItem } from "../session/rollout-item.js";
import type { AgenCStateAgentRunRecord } from "../state/agent-runs.js";
import type { CancelAgentRunTreeReport } from "../state/run-cancellation.js";
import type { CodePredictionSource } from "../services/code-prediction/types.js";

export type AgenCDaemonAgentLifecycleErrorCode =
  | "AGENT_NOT_FOUND"
  | "BACKGROUND_RUNNER_UNAVAILABLE"
  | "CANONICAL_SESSION_ALREADY_ACTIVE"
  | "EXECUTION_ADMISSION_REQUIRED"
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "RUN_NOT_FOUND"
  | "RUN_CANCEL_UNAVAILABLE"
  | "TURN_IN_PROGRESS"
  | "CLIENT_MESSAGE_ID_CONFLICT"
  | "PROMPT_BLOCKED";

export class AgenCDaemonAgentLifecycleError extends Error {
  readonly code: AgenCDaemonAgentLifecycleErrorCode;

  constructor(code: AgenCDaemonAgentLifecycleErrorCode, message: string) {
    super(message);
    this.name = "AgenCDaemonAgentLifecycleError";
    this.code = code;
  }
}

async function startNewBackgroundAgent(
  runner: AgenCBackgroundAgentRunner,
  params: Parameters<AgenCBackgroundAgentRunner["startAgent"]>[0],
): Promise<AgenCBackgroundAgentStartResult> {
  try {
    return await runner.startAgent(params);
  } catch (error) {
    if (error instanceof AgenCBackgroundAgentMessageError) {
      throw new AgenCDaemonAgentLifecycleError(error.code, error.message);
    }
    throw error;
  }
}

export interface AgentLifecycleResumeSourceTestHooks {
  readonly beforeSessionDirectoryClose?: (
    sessionDir: string,
    closeEarly: () => void,
  ) => void;
  /** Test-only closeSync failure seams after the real descriptors are closed. */
  readonly afterResumeRolloutLeaseClose?: () => void;
  readonly afterResumeCwdClose?: () => void;
}

let resumeSourceTestHooks: AgentLifecycleResumeSourceTestHooks = {};

/** Install deterministic resume-source filesystem seams for contract tests. */
export function __setAgentLifecycleResumeSourceTestHooksForTest(
  hooks: AgentLifecycleResumeSourceTestHooks = {},
): void {
  resumeSourceTestHooks = hooks;
}

export interface AgenCDaemonAgentManagerOptions {
  /** Canonical daemon home captured at process ingress. */
  readonly agencHome?: string;
  /**
   * @deprecated DAE-02: no longer used for agent.create (cwd is required).
   * Retained only for optional test/back-compat options objects.
   */
  readonly defaultCwd?: () => string;
  readonly now?: () => string;
  readonly runner?: AgenCBackgroundAgentRunner;
  readonly sessionManager?: AgenCDaemonSessionManager;
  readonly threadStore?: ThreadStore;
  readonly threadStoreForAgentLogs?: (
    route: AgenCDaemonAgentLogThreadStoreRoute,
  ) => ThreadStore | undefined;
  readonly readAgentToolOutputs?: (
    params: AgenCDaemonAgentToolOutputReadParams,
  ) => Promise<readonly AgentToolOutputLog[]> | readonly AgentToolOutputLog[];
  readonly snapshotFlush?: (
    snapshot: AgenCDaemonAgentSnapshotFlush,
  ) => void | Promise<void>;
  readonly broadcastSessionEvent?: (
    sessionId: string,
    event: JsonObject,
  ) => void | Promise<void>;
  readonly recordMessageExchange?: (
    exchange: AgenCDaemonMessageExchangeSnapshot,
  ) => void | Promise<void>;
  readonly recordAgentStatusTransition?: (
    transition: AgenCDaemonAgentStatusSnapshot,
  ) => void | Promise<void>;
  readonly recordAgentRun?: (
    run: AgenCDaemonAgentRunSnapshot,
  ) => void | Promise<void>;
  readonly recordRunTerminal?: (
    terminal: AgenCDaemonRunTerminalSnapshot,
  ) => void | Promise<void>;
  readonly registerSnapshotSession?: (
    session: AgenCDaemonSnapshotSessionRoute,
  ) => void | Promise<void>;
  readonly onSnapshotError?: (error: unknown) => void;
  readonly permissionAuditLogger?: PermissionAuditLogger;
  readonly onPermissionAuditError?: PermissionAuditErrorHandler;
  /**
   * Durable tree-scoped cancellation projection. Applies
   * `cancelAgentRunTree` against every project state DB that holds the run
   * row; the daemon-cli wiring owns DB discovery. REQUIRED for run.cancel.
   * When a canonical writer is live, the lifecycle first seals its
   * cancellation terminal in the rollout and only then applies this
   * rebuildable SQLite projection. Inactive/legacy runs have no writer, so
   * this callback remains their honest cancellation authority.
   */
  readonly cancelRunTreeDurable?: (params: {
    readonly runId: string;
    readonly reason: string;
    readonly cancelledAt: string;
  }) => CancelAgentRunTreeReport | Promise<CancelAgentRunTreeReport>;
  /**
   * Frozen `voided` reservation resolution for cancelled runs: release
   * open budget holds for the given agent ids (spend history untouched).
   * Returns the number of holds voided.
   */
  readonly voidBudgetHoldsForAgents?: (
    agentIds: readonly string[],
  ) => number | Promise<number>;
}

export interface AgenCDaemonAgentToolOutputReadParams {
  readonly agentId: string;
  readonly sessionIds: readonly string[];
}

export interface AgenCDaemonAgentLogThreadStoreRoute {
  readonly agentId: string;
  readonly sessionIds: readonly string[];
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

export interface AgenCDaemonMessageExchangeSnapshot {
  readonly sessionId: string;
  readonly agentId: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
  readonly content: JsonValue;
  readonly messageId: string;
  readonly streamId: string;
  readonly acceptedAt: string;
}

export interface AgenCDaemonAgentStatusSnapshot {
  readonly sessionId: string;
  readonly agentId: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
  readonly status: AgentStatus;
  readonly runStatus?: string;
  readonly transitionAt: string;
  readonly reason?: string;
  readonly metadataPatch?: JsonObject;
}

export interface AgenCDaemonAgentRunSnapshot extends AgenCStateAgentRunRecord {
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

export interface AgenCDaemonRunTerminalSnapshot extends AgenCBackgroundAgentTerminalSnapshot {
  readonly agentId: string;
  /** Canonical rollout session identity (the root managed-thread id). */
  readonly sessionId: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

export interface AgenCDaemonSnapshotSessionRoute {
  readonly sessionId: string;
  readonly agentId: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

export interface AgenCDaemonAgentSnapshotFlush extends JsonObject {
  readonly reason: string;
  readonly flushedAt: string;
  readonly agents: readonly AgentSummary[];
}

export interface AgenCDaemonAgentRestoreRecord {
  readonly agentId: string;
  readonly objective: string;
  readonly status?: AgentStatus;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly lastActiveAt?: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
  readonly metadata?: JsonObject;
  readonly sessionIds?: readonly string[];
  readonly runtimeAvailable?: boolean;
  /** Internal generation token for startup publication rollback only. */
  readonly restoreAttemptId?: string;
}

interface MutableAgent {
  agentId: string;
  agentPath?: string;
  objective: string;
  status: AgentStatus;
  createdAt: string;
  startedAt: string;
  /** When the runner first stopped answering for this agent; cleared on
   *  the next successful snapshot. The reaper only acts once this has
   *  persisted past the grace window — a transient null (registration
   *  race, post-turn blip) must never error a live run. */
  runtimeUnavailableSince?: string;
  lastActiveAt: string;
  cwd?: string;
  stateProjectDir?: string;
  metadata?: JsonObject;
  restoreAttemptId?: string;
  sessionIds: string[];
  logSessionIds: string[];
  recovered?: boolean;
  runtimeAvailable?: boolean;
}

interface AgenCDaemonSnapshotRoute {
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

interface AgentAttachmentTarget {
  readonly agentId: string;
  readonly sessionIds: readonly string[];
}

interface AgentLifecycleState {
  agents: Map<string, MutableAgent>;
}

interface PendingRunnerTermination {
  readonly snapshot: AgenCBackgroundAgentSnapshot;
  readonly transitionAt: string;
}

interface PendingCanonicalRunCancellation {
  snapshot?: AgenCBackgroundAgentSnapshot;
  target?: RunnerTerminationTarget;
}

interface RunnerTerminationTarget {
  readonly sessionIds: readonly string[];
  readonly route: AgenCDaemonSnapshotRoute;
  readonly status: AgentStatus;
  readonly transitionAt: string;
  readonly metadata?: JsonObject;
  readonly terminal?: AgenCBackgroundAgentTerminalSnapshot;
}

function isEvidenceToolCallResolution(
  params: SessionResolveToolCallParams,
): params is SessionResolveToolCallEvidenceParams {
  return Object.prototype.hasOwnProperty.call(params, "disposition");
}

export class AgenCDaemonAgentManager {
  readonly #agencHome: string;
  readonly #now: () => string;
  readonly #runner: AgenCBackgroundAgentRunner | undefined;
  readonly #sessionManager: AgenCDaemonSessionManager | undefined;
  readonly #threadStore: ThreadStore | undefined;
  readonly #threadStoreForAgentLogs:
    | ((route: AgenCDaemonAgentLogThreadStoreRoute) => ThreadStore | undefined)
    | undefined;
  readonly #readAgentToolOutputs:
    | ((
        params: AgenCDaemonAgentToolOutputReadParams,
      ) =>
        Promise<readonly AgentToolOutputLog[]> | readonly AgentToolOutputLog[])
    | undefined;
  readonly #snapshotFlush:
    | ((snapshot: AgenCDaemonAgentSnapshotFlush) => void | Promise<void>)
    | undefined;
  readonly #broadcastSessionEvent:
    | ((sessionId: string, event: JsonObject) => void | Promise<void>)
    | undefined;
  readonly #recordMessageExchange:
    | ((exchange: AgenCDaemonMessageExchangeSnapshot) => void | Promise<void>)
    | undefined;
  readonly #recordAgentStatusTransition:
    | ((transition: AgenCDaemonAgentStatusSnapshot) => void | Promise<void>)
    | undefined;
  readonly #recordAgentRun:
    ((run: AgenCDaemonAgentRunSnapshot) => void | Promise<void>) | undefined;
  readonly #recordRunTerminal:
    | ((terminal: AgenCDaemonRunTerminalSnapshot) => void | Promise<void>)
    | undefined;
  readonly #registerSnapshotSession:
    | ((session: AgenCDaemonSnapshotSessionRoute) => void | Promise<void>)
    | undefined;
  readonly #onSnapshotError: (error: unknown) => void;
  readonly #permissionAuditLogger: PermissionAuditLogger | undefined;
  readonly #onPermissionAuditError: PermissionAuditErrorHandler | undefined;
  readonly #cancelRunTreeDurable:
    | ((params: {
        readonly runId: string;
        readonly reason: string;
        readonly cancelledAt: string;
      }) => CancelAgentRunTreeReport | Promise<CancelAgentRunTreeReport>)
    | undefined;
  readonly #voidBudgetHoldsForAgents:
    ((agentIds: readonly string[]) => number | Promise<number>) | undefined;
  #shuttingDown = false;
  #shutdownDisposition: "cancel" | "suspend_idle" = "cancel";
  #activeCreates = 0;
  readonly #createWaiters = new Set<() => void>();
  readonly #pendingResumeCreates = new Map<
    string,
    {
      readonly params: AgentCreateParams;
      readonly result: Promise<AgentCreateResult>;
    }
  >();
  readonly #pendingRunnerTerminations = new Map<
    string,
    PendingRunnerTermination
  >();
  readonly #pendingCanonicalRunCancellations = new Map<
    string,
    PendingCanonicalRunCancellation
  >();
  readonly #runCancellationTasks = new Map<string, Promise<RunCancelResult>>();
  readonly #state = new AsyncLock<AgentLifecycleState>({
    agents: new Map(),
  });

  constructor(options: AgenCDaemonAgentManagerOptions = {}) {
    void options.defaultCwd; // DAE-02: ignored — create requires absolute cwd
    this.#agencHome = getAgencHomeDir(options.agencHome);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#runner = options.runner;
    this.#sessionManager = options.sessionManager;
    this.#threadStore = options.threadStore;
    this.#threadStoreForAgentLogs = options.threadStoreForAgentLogs;
    this.#readAgentToolOutputs = options.readAgentToolOutputs;
    this.#snapshotFlush = options.snapshotFlush;
    this.#broadcastSessionEvent = options.broadcastSessionEvent;
    this.#recordMessageExchange = options.recordMessageExchange;
    this.#recordAgentStatusTransition = options.recordAgentStatusTransition;
    this.#recordAgentRun = options.recordAgentRun;
    this.#recordRunTerminal = options.recordRunTerminal;
    this.#registerSnapshotSession = options.registerSnapshotSession;
    this.#onSnapshotError = options.onSnapshotError ?? (() => {});
    this.#permissionAuditLogger = options.permissionAuditLogger;
    this.#onPermissionAuditError = options.onPermissionAuditError;
    this.#cancelRunTreeDurable = options.cancelRunTreeDurable;
    this.#voidBudgetHoldsForAgents = options.voidBudgetHoldsForAgents;
  }

  createAgent(params: AgentCreateParams): Promise<AgentCreateResult> {
    const resumeSessionId = normalizeNonEmpty(params.resumeSessionId);
    if (resumeSessionId === undefined) {
      return this.#createAgentOnce(params);
    }
    const pending = this.#pendingResumeCreates.get(resumeSessionId);
    if (pending !== undefined) {
      if (!isDeepStrictEqual(pending.params, params)) {
        return Promise.reject(
          new AgenCDaemonAgentLifecycleError(
            "INVALID_ARGUMENT",
            `canonical session ${resumeSessionId} is already being resumed with different authority`,
          ),
        );
      }
      return pending.result;
    }

    const result = this.#createAgentOnce(params);
    const reservation = {
      params: structuredClone(params),
      result,
    };
    this.#pendingResumeCreates.set(resumeSessionId, reservation);
    void result.then(
      () => {
        if (this.#pendingResumeCreates.get(resumeSessionId) === reservation) {
          this.#pendingResumeCreates.delete(resumeSessionId);
        }
      },
      () => {
        if (this.#pendingResumeCreates.get(resumeSessionId) === reservation) {
          this.#pendingResumeCreates.delete(resumeSessionId);
        }
      },
    );
    return result;
  }

  async #createAgentOnce(
    params: AgentCreateParams,
  ): Promise<AgentCreateResult> {
    const finishCreate = this.#beginCreate();
    let resumeProof: ResumeSourceProof | undefined;
    let primaryFailure: unknown;
    let createFailed = false;
    if (this.#runner === undefined) {
      finishCreate();
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "agent.start requires a background runner",
      );
    }
    try {
      const resumeSessionId = normalizeNonEmpty(params.resumeSessionId);
      const resumeRolloutPath = normalizeNonEmpty(params.resumeRolloutPath);
      const resumeSourceProof = params.resumeSourceProof;
      let retainedAgent: MutableAgent | undefined;
      let retainedAgentPath: string | undefined;
      if (
        params.resumeSessionId !== undefined &&
        resumeSessionId === undefined
      ) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          "agent.create resumeSessionId must be non-empty",
        );
      }
      if (
        resumeSessionId !== undefined &&
        !isSafeSessionIdSegment(resumeSessionId)
      ) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          "agent.create resumeSessionId must be a safe single path segment",
        );
      }
      if (
        (resumeSessionId === undefined) !==
        (resumeRolloutPath === undefined)
      ) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          "agent.create resumeSessionId and resumeRolloutPath must be provided together",
        );
      }
      if (
        (resumeSessionId === undefined) !==
        (resumeSourceProof === undefined)
      ) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          "agent.create resumeSessionId and resumeSourceProof must be provided together",
        );
      }
      if (
        resumeSessionId !== undefined &&
        (params.objective !== undefined ||
          params.instructions !== undefined ||
          params.initialContent !== undefined ||
          params.deferInitialTurn !== undefined ||
          params.initialDisplayUserMessage !== undefined ||
          params.initialEditorInteraction !== undefined ||
          params.metadata !== undefined ||
          params.unattendedAllow !== undefined ||
          params.unattendedDeny !== undefined)
      ) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          "agent.create resumeSessionId cannot override objective, initial turn content, metadata, or unattended policy",
        );
      }
      if (resumeSessionId !== undefined) {
        const existing = await this.#state.with(
          (state) =>
            state.agents.get(resumeSessionId) ??
            this.#listPersistedAgents(state).find(
              (agent) => agent.agentId === resumeSessionId,
            ),
        );
        retainedAgent = existing;
        retainedAgentPath =
          existing?.agentPath ??
          metadataString(existing?.metadata, "agentPath");
        if (retainedAgentPath !== undefined && retainedAgentPath !== "/root") {
          throw new AgenCDaemonAgentLifecycleError(
            "INVALID_ARGUMENT",
            `canonical session ${resumeSessionId} is a child agent and cannot be resumed as an interactive root`,
          );
        }
        if (
          existing !== undefined &&
          isActiveAgent(existing) &&
          !isRecoveredRuntimeUnavailable(existing) &&
          !isStaleAgent(existing)
        ) {
          throw new AgenCDaemonAgentLifecycleError(
            "CANONICAL_SESSION_ALREADY_ACTIVE",
            `canonical session ${resumeSessionId} already has a live daemon agent`,
          );
        }
      }
      let cwd: string;
      try {
        cwd = requireAbsoluteWorkspaceCwd(params.cwd, "agent.create");
      } catch (error) {
        if (error instanceof WorkspaceCwdError) {
          throw new AgenCDaemonAgentLifecycleError(
            "INVALID_ARGUMENT",
            error.message,
          );
        }
        throw error;
      }
      if (resumeRolloutPath !== undefined && resumeSessionId !== undefined) {
        resumeProof = assertAuthoritativeResumeSource({
          agencHome: this.#agencHome,
          sessionId: resumeSessionId,
          rolloutPath: resumeRolloutPath,
          cwd,
          sourceProof: resumeSourceProof!,
          allowLegacyRetainedRoot: retainedAgentPath === "/root",
        });
        // A cancelled session is a settled terminal outcome: the interrupted
        // turn is durably over, its rollout is intact, and an explicit
        // interactive resume reopens it as a fresh epoch exactly like a
        // completed terminal run. Refusing it made the everyday
        // Ctrl-C-then-continue workflow permanently unresumable (#1750).
        // `unknown_outcome` stays refused: its evidence is unsettled and
        // daemon recovery must reconcile it into a real terminal state first.
        if (resumeProof.terminalStatus === "unknown_outcome") {
          throw new AgenCDaemonAgentLifecycleError(
            "INVALID_ARGUMENT",
            `canonical session ${resumeSessionId} ended with ${resumeProof.terminalStatus} and cannot be resumed`,
          );
        }
        assertCanonicalRuntimeSettingsProjection(
          cwd,
          resumeSessionId,
          resumeProof,
          this.#agencHome,
        );
        /*
         * The retained objective is NOT a session identity. A client that
         * defers the initial turn (every interactive session: the desktop
         * app, `agenc` itself) passes a label like "Interactive session"
         * while the rollout's canonical objective is whatever the user
         * typed first, so the two never agree and strict equality refused
         * 100% of legitimate interactive resumes — the same failure shape
         * as the retained `createdAt` equality fixed in #1750. The label is
         * disposable either way: a successful resume replaces it with
         * `resumeProof.objective` a few lines below.
         *
         * A rollout swapped in from another session is still refused, by
         * evidence rather than by label: the path must live under
         * `sessions/<resumeSessionId>/` and its filename must end in
         * `-<resumeSessionId>.jsonl`, the caller's dev/ino/size/sha256
         * proof is revalidated here against the real file, and the journal
         * is validated with `expectedRunId` set to this session id.
         */
        if (
          retainedAgent?.createdAt !== undefined &&
          !retainedCreatedAtMatchesRollout(
            retainedAgent.createdAt,
            resumeProof.createdAt,
          )
        ) {
          throw new AgenCDaemonAgentLifecycleError(
            "INVALID_ARGUMENT",
            `canonical session ${resumeSessionId} retained creation time disagrees with the rollout`,
          );
        }
      }
      const objective =
        resumeSessionId === undefined
          ? normalizeObjective(params)
          : (resumeProof?.objective ??
            (() => {
              throw new AgenCDaemonAgentLifecycleError(
                "INVALID_ARGUMENT",
                `canonical session ${resumeSessionId} has no retained objective`,
              );
            })());
      const createdAt =
        resumeSessionId === undefined
          ? (retainedAgent?.createdAt ?? this.#now())
          : resumeProof!.createdAt;
      const retainedMetadata = retainedAgent?.metadata;
      const retainedModel = metadataString(retainedMetadata, "model");
      const retainedProvider =
        metadataString(retainedMetadata, "provider") ??
        metadataString(retainedMetadata, "modelProvider");
      const retainedConfigPath = metadataString(retainedMetadata, "configPath");
      const canonicalRuntimeSettings = resumeProof?.runtimeSettings;
      if (
        canonicalRuntimeSettings === undefined &&
        resumeProof?.model !== undefined &&
        retainedModel !== undefined &&
        resumeProof.model !== retainedModel
      ) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          `canonical session ${resumeSessionId} retained model disagrees with the rollout`,
        );
      }
      if (
        canonicalRuntimeSettings === undefined &&
        resumeProof?.provider !== undefined &&
        retainedProvider !== undefined &&
        resumeProof.provider !== retainedProvider
      ) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          `canonical session ${resumeSessionId} retained provider disagrees with the rollout`,
        );
      }
      const canonicalPermissionMode =
        canonicalRuntimeSettings === undefined
          ? resumeProof?.legacyPermissionMode
          : interactivePermissionModeFromRuntimeSettings(
              canonicalRuntimeSettings,
              cwd,
              resumeSessionId!,
            );
      const model =
        params.model ??
        canonicalRuntimeSettings?.model ??
        resumeProof?.model ??
        retainedModel;
      const provider =
        params.provider ??
        canonicalRuntimeSettings?.provider ??
        resumeProof?.provider ??
        retainedProvider;
      const profile =
        params.profile ??
        (canonicalRuntimeSettings === undefined
          ? metadataString(retainedMetadata, "profile")
          : (canonicalRuntimeSettings.profile ?? undefined));
      const configPath = params.configPath ?? retainedConfigPath;
      if (configPath !== undefined && !isAbsolute(configPath)) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          "agent.create configPath must be an absolute path",
        );
      }
      const permissionMode =
        params.permissionMode ??
        canonicalPermissionMode ??
        metadataUserPermissionMode(retainedMetadata);
      const unattendedAllow = normalizeStringList(
        params.unattendedAllow,
        metadataStringList(retainedMetadata, "unattendedAllow") ??
          DEFAULT_UNATTENDED_ALLOWLIST,
      );
      const unattendedDeny = normalizeStringList(
        params.unattendedDeny,
        metadataStringList(retainedMetadata, "unattendedDeny") ?? [],
      );
      const requestedRuntimeOptions = validateAgentRuntimeOptions(
        params.runtimeOptions,
      );
      const retainedRuntimeOptions =
        resumeSessionId !== undefined &&
        retainedMetadata?.runtimeOptions !== undefined
          ? validateAgentRuntimeOptions(retainedMetadata.runtimeOptions)
          : undefined;
      const runtimeOptions = Object.freeze({
        ...requestedRuntimeOptions,
        // A cold attach may supply fresh shell/temp/plugin inputs, but it must
        // not silently drop the original session's explicit sandbox escape.
        // Omitting the new field in historical metadata normalizes to false.
        dangerouslyBypassApprovalsAndSandbox:
          requestedRuntimeOptions.dangerouslyBypassApprovalsAndSandbox ||
          retainedRuntimeOptions?.dangerouslyBypassApprovalsAndSandbox === true,
      });
      const metadata: JsonObject = {
        ...(retainedMetadata ?? {}),
        ...(resumeSessionId === undefined ? (params.metadata ?? {}) : {}),
        ...(resumeSessionId !== undefined
          ? {
              resumedFromSessionId: resumeSessionId,
              agentPath: resumeProof!.agentPath,
            }
          : {}),
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(canonicalRuntimeSettings !== undefined
          ? { profile: profile ?? null }
          : profile !== undefined
            ? { profile }
            : {}),
        ...(configPath !== undefined ? { configPath } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        unattendedAllow,
        unattendedDeny,
        // Session operator inputs are part of the durable run identity. A
        // daemon restart must restore the exact values captured at create
        // time, never reinterpret the daemon's current process environment.
        runtimeOptions,
      };
      const resumeRestoreAttemptId =
        resumeSessionId === undefined ? undefined : randomUUID();
      const started =
        resumeSessionId === undefined
          ? await startNewBackgroundAgent(this.#runner, {
              objective,
              cwd,
              ...(model !== undefined ? { model } : {}),
              ...(provider !== undefined ? { provider } : {}),
              ...(profile !== undefined ? { profile } : {}),
              ...(configPath !== undefined ? { configPath } : {}),
              ...(params.initialContent !== undefined
                ? { initialContent: params.initialContent }
                : {}),
              ...(params.deferInitialTurn !== undefined
                ? { deferInitialTurn: params.deferInitialTurn }
                : {}),
              ...(params.initialDisplayUserMessage !== undefined
                ? {
                    initialDisplayUserMessage: params.initialDisplayUserMessage,
                  }
                : {}),
              ...(params.initialEditorInteraction !== undefined
                ? {
                    initialEditorInteraction: params.initialEditorInteraction,
                  }
                : {}),
              metadata,
              unattendedAllow,
              unattendedDeny,
              runtimeOptions,
              ...(permissionMode !== undefined ? { permissionMode } : {}),
              ...(params.envOverrides !== undefined
                ? { envOverrides: params.envOverrides }
                : {}),
            })
          : await this.#resumeTerminalAgent({
              agentId: resumeSessionId,
              resumeRolloutPath: resumeRolloutPath!,
              resumeCwdIdentity: resumeProof!.cwdIdentity,
              resumeRolloutLease: resumeProof!.rolloutLease,
              resumeCwdFd: resumeProof!.cwdFd,
              rolloutDev: resumeProof!.rolloutDev,
              rolloutIno: resumeProof!.rolloutIno,
              agentPath: resumeProof!.agentPath,
              lifecycleState: resumeProof!.lifecycleState,
              startupActivationPending: resumeProof!.startupActivationPending,
              restoreAttemptId: resumeRestoreAttemptId!,
              objective,
              cwd,
              createdAt,
              metadata,
              runtimeOptions,
              ...(model !== undefined ? { model } : {}),
              ...(provider !== undefined ? { provider } : {}),
              ...(profile !== undefined ? { profile } : {}),
              ...(configPath !== undefined ? { configPath } : {}),
              ...(permissionMode !== undefined ? { permissionMode } : {}),
              ...(canonicalRuntimeSettings !== undefined
                ? { runtimeSettings: canonicalRuntimeSettings }
                : {}),
              ...(params.envOverrides !== undefined
                ? { envOverrides: params.envOverrides }
                : {}),
            });

      if (this.#shuttingDown) {
        if (
          resumeSessionId !== undefined &&
          this.#shutdownDisposition === "suspend_idle" &&
          this.#runner.suspendIdleAgentForDaemonShutdown !== undefined
        ) {
          const disposition =
            await this.#runner.suspendIdleAgentForDaemonShutdown(
              started.agentId,
            );
          if (disposition.disposition !== "suspended") {
            throw new AgenCDaemonAgentLifecycleError(
              "INVALID_ARGUMENT",
              "resumed canonical session could not be suspended during daemon shutdown",
            );
          }
        } else {
          await this.#runner.stopAgent?.(started.agentId, "daemon_shutdown");
        }
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          "agent.start cancelled because the daemon is shutting down",
        );
      }

      const agentMetadata: JsonObject = {
        ...metadata,
        ...(started.rolloutPath !== undefined
          ? { canonicalRolloutPath: started.rolloutPath }
          : {}),
        ...(started.rolloutDev !== undefined
          ? { canonicalRolloutDev: started.rolloutDev }
          : {}),
        ...(started.rolloutIno !== undefined
          ? { canonicalRolloutIno: started.rolloutIno }
          : {}),
      };

      const agent: MutableAgent = {
        agentId: started.agentId,
        ...(started.agentPath !== undefined
          ? { agentPath: started.agentPath }
          : retainedAgent?.agentPath !== undefined
            ? { agentPath: retainedAgent.agentPath }
            : resumeProof?.agentPath !== undefined
              ? { agentPath: resumeProof.agentPath }
              : {}),
        objective,
        status: started.status,
        createdAt,
        startedAt: started.startedAt,
        lastActiveAt: started.startedAt,
        sessionIds: retainedAgent?.sessionIds.slice() ?? [],
        logSessionIds: retainedAgent?.logSessionIds.slice() ?? [],
        cwd,
        metadata: agentMetadata,
        ...(retainedAgent?.stateProjectDir !== undefined
          ? { stateProjectDir: retainedAgent.stateProjectDir }
          : {}),
      };

      let createdLifecycleSessionId: string | undefined;
      try {
        if (this.#sessionManager !== undefined) {
          const session = await this.#sessionManager.createSession({
            agentId: agent.agentId,
            cwd,
            initialPrompt: objective,
            metadata: {
              ...agentMetadata,
              objective,
              source:
                resumeSessionId === undefined ? "agent.start" : "agent.resume",
              unattendedAllow,
              unattendedDeny,
            },
          });
          createdLifecycleSessionId = session.sessionId;
          agent.sessionIds.push(session.sessionId);
          agent.logSessionIds.push(session.sessionId);
          await this.#registerSnapshotSessionRoute(session.sessionId, agent);
        }
        await this.#recordAgentRunSnapshot(agent, { required: true });
        await this.#recordAgentStatusSnapshots(
          agent.sessionIds,
          agent.agentId,
          agent.status,
          agent.lastActiveAt,
          undefined,
          snapshotRouteForAgent(agent),
        );
        if (this.#sessionManager !== undefined) {
          for (const sessionId of agent.sessionIds) {
            await this.#runner.attachAgentSessionEvents?.(agent.agentId, {
              sessionId,
              emit: (event) => this.#broadcastSessionEvent?.(sessionId, event),
            });
          }
        }

        const { result, pendingTermination } = await this.#state.with(
          (state) => {
            state.agents.set(agent.agentId, agent);
            const pending = this.#pendingRunnerTerminations.get(agent.agentId);
            let pendingTermination: RunnerTerminationTarget | null = null;
            if (pending !== undefined) {
              this.#pendingRunnerTerminations.delete(agent.agentId);
              pendingTermination = this.#applyRunnerTerminationLocked(
                state,
                agent.agentId,
                pending.snapshot,
                pending.transitionAt,
              );
            }
            return {
              result: toAgentCreateResult(agent),
              pendingTermination,
            };
          },
        );
        if (pendingTermination !== null) {
          await this.#finalizeRunnerTermination(
            agent.agentId,
            pendingTermination,
          );
        }
        return result;
      } catch (error) {
        this.#pendingRunnerTerminations.delete(agent.agentId);
        const cleanupErrors: unknown[] = [];
        if (resumeSessionId !== undefined) {
          if (
            resumeRestoreAttemptId === undefined ||
            this.#runner.rollbackRestoredAgent === undefined
          ) {
            cleanupErrors.push(
              new Error(
                "background runner cannot safely roll back the unpublished restored generation",
              ),
            );
          } else {
            try {
              await this.#runner.rollbackRestoredAgent(
                agent.agentId,
                resumeRestoreAttemptId,
              );
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          }
        } else {
          try {
            await this.#runner.stopAgent?.(
              agent.agentId,
              "agent.create rollback after lifecycle failure",
            );
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (
          createdLifecycleSessionId !== undefined &&
          this.#sessionManager !== undefined
        ) {
          try {
            await this.#sessionManager.terminateSession({
              sessionId: createdLifecycleSessionId,
              reason: "agent.create rollback after lifecycle failure",
            });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        const rollbackStatus =
          resumeSessionId === undefined
            ? ("error" as const)
            : ("stopped" as const);
        await this.#recordAgentStatusSnapshots(
          createdLifecycleSessionId === undefined
            ? []
            : [createdLifecycleSessionId],
          agent.agentId,
          rollbackStatus,
          this.#now(),
          "agent.create rollback after lifecycle failure",
          snapshotRouteForAgent(agent),
          undefined,
          resumeSessionId === undefined ? undefined : "stopped",
        );
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            error instanceof Error
              ? `${error.message}; restored agent cleanup also failed`
              : "agent.create failed; restored agent cleanup also failed",
          );
        }
        throw error;
      }
    } catch (error) {
      createFailed = true;
      primaryFailure = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        if (resumeProof !== undefined) {
          try {
            resumeProof.rolloutLease.closeUnclaimed();
            resumeSourceTestHooks.afterResumeRolloutLeaseClose?.();
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            resumeProof.closeCwd();
            resumeSourceTestHooks.afterResumeCwdClose?.();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      } finally {
        finishCreate();
      }
      if (cleanupErrors.length > 0) {
        if (createFailed) {
          throw new AggregateError(
            [primaryFailure, ...cleanupErrors],
            primaryFailure instanceof Error
              ? `${primaryFailure.message}; resume source cleanup also failed`
              : "agent.create failed; resume source cleanup also failed",
            { cause: primaryFailure },
          );
        }
        throw new AggregateError(
          cleanupErrors,
          "agent.create resume source cleanup failed",
        );
      }
    }
  }

  async #resumeTerminalAgent(params: {
    readonly agentId: string;
    readonly resumeRolloutPath: string;
    readonly resumeCwdIdentity: { readonly dev: string; readonly ino: string };
    readonly resumeRolloutLease: ResumeRolloutDescriptorLease;
    readonly resumeCwdFd: number;
    readonly rolloutDev: string;
    readonly rolloutIno: string;
    readonly agentPath: "/root";
    readonly lifecycleState: "open" | "suspended" | "terminal";
    readonly startupActivationPending: boolean;
    readonly restoreAttemptId: string;
    readonly objective: string;
    readonly cwd: string;
    readonly createdAt: string;
    readonly model?: string;
    readonly provider?: string;
    readonly profile?: string;
    readonly configPath?: string;
    readonly permissionMode?:
      | "default"
      | "plan"
      | "acceptEdits"
      | "bypassPermissions"
      | "dontAsk"
      | "auto";
    readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
    readonly runtimeOptions: AgentRuntimeOptions;
    readonly envOverrides?: { readonly [key: string]: string };
    readonly metadata: JsonObject;
  }): Promise<AgenCBackgroundAgentStartResult> {
    if (this.#runner?.restoreAgent === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "agent resume requires a background runner with restore support",
      );
    }
    const restored = await this.#runner.restoreAgent({
      agentId: params.agentId,
      objective: params.objective,
      cwd: params.cwd,
      startedAt: params.createdAt,
      metadata: params.metadata,
      explicitColdResume: true,
      restoreAttemptId: params.restoreAttemptId,
      // An explicit cold resume reopens a terminal epoch by intent. The
      // lifecycle proof reads the JSONL journal while the open-time guard
      // checks the SQLite epoch, and a crash between the two reopen writes
      // leaves them disagreeing (journal already reopened, SQLite still
      // terminal — #1750). Pass the flag for "open" too: the reopen boundary
      // append is itself conditional on a real terminal event, so a genuinely
      // open epoch continues in place unchanged.
      ...(params.lifecycleState === "terminal" ||
      params.lifecycleState === "open"
        ? { reopenTerminalRun: true }
        : {}),
      ...(params.lifecycleState === "suspended"
        ? {
            resumeSuspendedRun: true,
            suspendedResumeReason: "explicit_continue" as const,
          }
        : {}),
      ...(params.startupActivationPending
        ? { resumeStartupActivationPending: true }
        : {}),
      resumeRolloutPath: params.resumeRolloutPath,
      resumeRolloutLease: params.resumeRolloutLease,
      resumeCwdIdentity: params.resumeCwdIdentity,
      resumeCwdFd: params.resumeCwdFd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
      ...(params.profile !== undefined ? { profile: params.profile } : {}),
      ...(params.configPath !== undefined
        ? { configPath: params.configPath }
        : {}),
      ...(params.permissionMode !== undefined
        ? { permissionMode: params.permissionMode }
        : {}),
      ...(params.runtimeSettings !== undefined
        ? { runtimeSettings: params.runtimeSettings }
        : {}),
      runtimeOptions: params.runtimeOptions,
      ...(params.envOverrides !== undefined
        ? { envOverrides: params.envOverrides }
        : {}),
    });
    if (!restored) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        `daemon could not resume canonical session ${params.agentId}`,
      );
    }
    return {
      agentId: params.agentId,
      agentPath: params.agentPath,
      startedAt: params.createdAt,
      status: "running",
      rolloutPath: params.resumeRolloutPath,
      rolloutDev: params.rolloutDev,
      rolloutIno: params.rolloutIno,
      restoreAttemptId: params.restoreAttemptId,
    };
  }

  async restoreAgent(
    record: AgenCDaemonAgentRestoreRecord,
  ): Promise<AgentSummary> {
    const agentId = normalizeNonEmpty(record.agentId);
    const objective = normalizeNonEmpty(record.objective);
    if (agentId === undefined || objective === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "agent restore requires agentId and objective",
      );
    }
    const createdAt = normalizeNonEmpty(record.createdAt) ?? this.#now();
    const startedAt = normalizeNonEmpty(record.startedAt) ?? createdAt;
    const lastActiveAt = normalizeNonEmpty(record.lastActiveAt) ?? startedAt;
    const agent: MutableAgent = {
      agentId,
      objective,
      status: record.status ?? "running",
      createdAt,
      startedAt,
      lastActiveAt,
      sessionIds: normalizeStringList(record.sessionIds, []),
      logSessionIds: normalizeStringList(record.sessionIds, []),
      recovered: true,
      runtimeAvailable: record.runtimeAvailable === true,
      ...(record.restoreAttemptId !== undefined
        ? { restoreAttemptId: record.restoreAttemptId }
        : {}),
    };
    if (record.cwd !== undefined) agent.cwd = record.cwd;
    if (record.stateProjectDir !== undefined) {
      agent.stateProjectDir = record.stateProjectDir;
    }
    if (record.metadata !== undefined) agent.metadata = record.metadata;
    const restoredAgentPath = metadataString(record.metadata, "agentPath");
    if (restoredAgentPath !== undefined) agent.agentPath = restoredAgentPath;

    let inserted: MutableAgent | undefined;
    const summary = await this.#state.with((state) => {
      const existing = state.agents.get(agentId);
      if (existing !== undefined) return toAgentSummary(existing);
      state.agents.set(agentId, agent);
      inserted = agent;
      return toAgentSummary(agent);
    });
    if (inserted?.runtimeAvailable === true) {
      try {
        for (const sessionId of inserted.sessionIds) {
          await this.#runner?.attachAgentSessionEvents?.(inserted.agentId, {
            sessionId,
            emit: (event) => this.#broadcastSessionEvent?.(sessionId, event),
          });
        }
      } catch (error) {
        // Preserve the token so the startup coordinator can remove only this
        // unpublished generation after it rolls the runner back.
        throw error;
      }
      delete inserted.restoreAttemptId;
    }
    return summary;
  }

  /** Remove only the unpublished startup record bound to one restore attempt. */
  async rollbackRestoredAgentRecord(
    agentId: string,
    expectedRestoreAttemptId: string,
  ): Promise<void> {
    if (expectedRestoreAttemptId.length === 0) {
      throw new TypeError(
        "restored agent record rollback requires an attempt id",
      );
    }
    await this.#state.with((state) => {
      const existing = state.agents.get(agentId);
      if (existing === undefined) return;
      if (
        existing.recovered !== true ||
        existing.runtimeAvailable !== true ||
        existing.restoreAttemptId !== expectedRestoreAttemptId
      ) {
        throw new Error(
          `restored agent record generation no longer owns ${agentId}`,
        );
      }
      state.agents.delete(agentId);
      this.#pendingRunnerTerminations.delete(agentId);
    });
  }

  #beginCreate(): () => void {
    if (this.#shuttingDown) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "agent.start rejected because the daemon is shutting down",
      );
    }
    this.#activeCreates += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#activeCreates -= 1;
      if (this.#activeCreates === 0) {
        this.#pendingRunnerTerminations.clear();
        for (const waiter of this.#createWaiters) {
          waiter();
        }
        this.#createWaiters.clear();
      }
    };
  }

  async #waitForActiveCreates(): Promise<void> {
    if (this.#activeCreates === 0) return;
    await new Promise<void>((resolve) => {
      this.#createWaiters.add(resolve);
    });
  }

  async listAgents(params: AgentListParams = {}): Promise<AgentListResult> {
    return this.#state.with(async (state) => {
      await this.#refreshAgentsFromRunner(state);
      await this.#reconcileSessionBackedAgents(state);
      const cursor = normalizeCursor(params.cursor);
      const limit = normalizeLimit(params.limit);
      const agents = [...state.agents.values()]
        .filter(isActiveAgent)
        .concat(this.#listPersistedAgents(state))
        .sort(compareAgentsForList);
      const pageStart =
        cursor === undefined
          ? 0
          : agents.findIndex((agent) => agent.agentId > cursor);
      const page =
        pageStart < 0 ? [] : agents.slice(pageStart, pageStart + limit);
      const nextCursor =
        pageStart >= 0 && pageStart + limit < agents.length
          ? page.at(-1)?.agentId
          : undefined;
      return {
        agents: page.map(toAgentSummary),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    });
  }

  #listPersistedAgents(state: AgentLifecycleState): MutableAgent[] {
    if (this.#threadStore === undefined) return [];
    const result: MutableAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = this.#threadStore.listThreads({
        pageSize: 500,
        archived: false,
        useStateDbOnly: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const thread of page.items) {
        const agent = storedThreadToAgent(thread);
        if (agent === undefined || state.agents.has(agent.agentId)) continue;
        result.push(agent);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
  }

  async attachAgent(
    params: AgentAttachParams,
    registerSessionRoute: (
      sessionId: string,
    ) => Promise<() => Promise<void> | void> | (() => Promise<void> | void),
  ): Promise<AgentAttachResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "agent.attach requires a daemon session manager",
      );
    }

    const target = await this.#resolveAttachmentTarget(params.agentId);
    const sessions = (
      await Promise.all(
        target.sessionIds.map((sessionId) =>
          this.#sessionManager!.getSession(sessionId),
        ),
      )
    ).filter(
      (session): session is SessionSummary =>
        session !== null && isActiveSession(session),
    );
    const session = newestSession(sessions);
    if (session === null) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon agent has no active session: ${params.agentId}`,
      );
    }
    let runtimeOptions: AgentRuntimeOptions;
    try {
      runtimeOptions = validateAgentRuntimeOptions(
        session.metadata?.runtimeOptions,
      );
    } catch {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `daemon session ${session.sessionId} has no valid runtime-options authority`,
      );
    }
    if (this.#runner?.getAgentSnapshot === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `daemon agent ${target.agentId} has no live runtime-settings authority`,
      );
    }

    const attachment = await this.#sessionManager.attachSession({
      sessionId: session.sessionId,
      ...(params.clientId !== undefined ? { clientId: params.clientId } : {}),
    });
    let rollbackRoute: (() => Promise<void> | void) | undefined;
    try {
      rollbackRoute = await registerSessionRoute(session.sessionId);
      const runnerSnapshot = await this.#runner.getAgentSnapshot(target.agentId);
      if (
        runnerSnapshot?.runtimeSettings === undefined ||
        runnerSnapshot.runtimeSettingsEventId === undefined
      ) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          `daemon agent ${target.agentId} has no live runtime-settings authority`,
        );
      }
      const orderedSessionIds = [
        session.sessionId,
        ...sessions
          .map((activeSession) => activeSession.sessionId)
          .filter((sessionId) => sessionId !== session.sessionId),
      ];
      const attachedSessions: AgentAttachSessionSummary[] = await Promise.all(
        orderedSessionIds.map(async (sessionId) => {
          const activeSession =
            await this.#sessionManager!.getSession(sessionId);
          const cwd = activeSession?.cwd;
          if (
            activeSession === null ||
            !isActiveSession(activeSession) ||
            activeSession.agentId !== target.agentId ||
            typeof cwd !== "string" ||
            cwd.trim() !== cwd ||
            cwd.length === 0 ||
            Buffer.byteLength(cwd, "utf8") > 4_096 ||
            !isAbsolute(cwd)
          ) {
            throw new AgenCDaemonAgentLifecycleError(
              "INVALID_ARGUMENT",
              `daemon agent ${target.agentId} has no valid active session authority for ${sessionId}`,
            );
          }
          return { ...activeSession, cwd };
        }),
      );
      return {
        agentId: target.agentId,
        attachmentId: attachment.attachmentId,
        sessionIds: orderedSessionIds,
        runtimeOptions,
        runtimeSettings: cloneFrozenRuntimeSettingsSnapshot(
          runnerSnapshot.runtimeSettings,
        ) as RunRuntimeSettingsSnapshot & JsonObject,
        runtimeSettingsEventId: runnerSnapshot.runtimeSettingsEventId,
        runtimeSessionId: target.agentId,
        sessions: attachedSessions,
      };
    } catch (error) {
      await Promise.resolve(rollbackRoute?.()).catch(() => {});
      await this.#sessionManager
        .detachSession({
          sessionId: session.sessionId,
          attachmentId: attachment.attachmentId,
        })
        .catch(() => {});
      throw error;
    }
  }

  async getAgent(agentId: string): Promise<AgentSummary | null> {
    return this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed !== undefined) {
        return toAgentSummary(refreshed);
      }
      const persisted = this.#listPersistedAgents(state).find(
        (candidate) => candidate.agentId === agentId,
      );
      return persisted === undefined ? null : toAgentSummary(persisted);
    });
  }

  async getAgentLogs(params: AgentLogsParams): Promise<AgentLogsResult> {
    const agentId = normalizeRequiredAgentId(params.agentId, "agent.logs");
    const target = await this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
        await this.#reconcileAgentSessions(agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed !== undefined) {
        return {
          sessionIds: logSessionIdsForAgent(refreshed),
          ...snapshotRouteForAgent(refreshed),
        };
      }
      const persisted = this.#listPersistedAgents(state).find(
        (agent) => agent.agentId === agentId,
      );
      return persisted === undefined
        ? null
        : {
            sessionIds: logSessionIdsForAgent(persisted),
            ...snapshotRouteForAgent(persisted),
          };
    });
    if (target === null) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon agent not found: ${agentId}`,
      );
    }

    const sessionIds = uniqueNonEmptyStrings([agentId, ...target.sessionIds]);
    const sessions = this.#readLogSessions({
      agentId,
      sessionIds,
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      ...(target.stateProjectDir !== undefined
        ? { stateProjectDir: target.stateProjectDir }
        : {}),
    });

    const toolOutputs =
      this.#readAgentToolOutputs === undefined
        ? []
        : [
            ...(await this.#readAgentToolOutputs({
              agentId,
              sessionIds,
            })),
          ];
    const transcript = formatAgentLogsTranscript(
      agentId,
      sessions,
      toolOutputs,
    );
    return {
      agentId,
      transcript,
      sessions,
      ...(toolOutputs.length > 0 ? { toolOutputs } : {}),
    };
  }

  #readLogSessions(
    route: AgenCDaemonAgentLogThreadStoreRoute,
  ): AgentLogSession[] {
    const threadStore =
      this.#threadStoreForAgentLogs?.(route) ?? this.#threadStore;
    if (threadStore === undefined) return [];
    const sessions: AgentLogSession[] = [];
    const seen = new Set<string>();
    for (const sessionId of route.sessionIds) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      try {
        const thread = threadStore.readThread({
          threadId: sessionId,
          includeArchived: true,
          includeHistory: true,
        });
        sessions.push(storedThreadToAgentLogSession(thread));
      } catch (error) {
        if (isThreadLogReadMiss(error)) continue;
        throw error;
      }
    }
    return sessions;
  }

  async stopAgent(params: AgentStopParams): Promise<AgentStopResult> {
    const agentId = normalizeRequiredAgentId(params.agentId, "agent.stop");
    const reason = normalizeNonEmpty(params.reason) ?? "agent.stop";
    const runner = this.#runner;
    const stopRunner = runner?.stopAgent?.bind(runner);
    let transitionAt: string | undefined;
    const target = await this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed === undefined) {
        const persisted = this.#listPersistedAgents(state).find(
          (candidate) => candidate.agentId === agentId,
        );
        if (persisted === undefined) {
          throw new AgenCDaemonAgentLifecycleError(
            "AGENT_NOT_FOUND",
            `AgenC daemon agent not found: ${agentId}`,
          );
        }
        if (!isActiveAgent(persisted)) {
          return null;
        }
        transitionAt = this.#now();
        return {
          sessionIds: [...persisted.sessionIds],
          route: snapshotRouteForAgent(persisted),
          persistedOnly: true,
          runnerStopRequired: false,
        };
      }
      if (!isActiveAgent(refreshed)) {
        return null;
      }
      const runnerStopRequired = !isStaleAgent(refreshed);
      if (stopRunner === undefined && runnerStopRequired) {
        throw new AgenCDaemonAgentLifecycleError(
          "BACKGROUND_RUNNER_UNAVAILABLE",
          "agent.stop requires a background runner",
        );
      }
      transitionAt = this.#now();
      refreshed.status = "stopping";
      refreshed.lastActiveAt = transitionAt;
      return {
        sessionIds: [...refreshed.sessionIds],
        route: snapshotRouteForAgent(refreshed),
        persistedOnly: false,
        runnerStopRequired,
      };
    });

    if (target === null) {
      return { agentId, stopped: false };
    }
    await this.#recordAgentStatusSnapshots(
      target.sessionIds,
      agentId,
      "stopping",
      transitionAt ?? this.#now(),
      reason,
      target.route,
    );
    if (target.runnerStopRequired && stopRunner === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "agent.stop requires a background runner",
      );
    }
    if (target.runnerStopRequired) {
      try {
        await stopRunner!(agentId, reason);
      } catch (error) {
        const failedAt = transitionAt ?? this.#now();
        await this.#markAgentStopFailed(agentId, failedAt);
        await this.#recordAgentStatusSnapshots(
          target.sessionIds,
          agentId,
          "error",
          failedAt,
          reason,
          target.route,
        );
        throw error;
      }
    }

    const stoppedAt = transitionAt ?? this.#now();
    if (!target.persistedOnly) {
      await this.#state.with((state) => {
        const agent = state.agents.get(agentId);
        if (agent === undefined) return;
        agent.status = "stopped";
        agent.lastActiveAt = stoppedAt;
        agent.logSessionIds = uniqueNonEmptyStrings([
          ...agent.logSessionIds,
          ...agent.sessionIds,
        ]);
        agent.sessionIds = [];
      });
    }
    await this.#recordAgentStatusSnapshots(
      target.sessionIds,
      agentId,
      "stopped",
      stoppedAt,
      reason,
      target.route,
    );
    await this.#terminateAgentSessions(target.sessionIds, reason);
    return { agentId, stopped: true };
  }

  /**
   * run.cancel (frozen Wave-B method): tree-scoped cancel of the run plus
   * its queued and running descendants. A live canonical rollout writer is
   * quiesced first and must return a fsync-committed cancelled terminal;
   * SQLite is a rebuildable projection of that evidence. If no writer is
   * active, the durable tree cascade remains the honest offline authority
   * and `run.result` may report legacy output as unavailable. Concurrent
   * requests for one run share one cancellation operation so the canonical
   * terminal is emitted once.
   */
  async cancelRunTree(params: RunCancelParams): Promise<RunCancelResult> {
    const runId = normalizeRequiredAgentId(params.runId, "run.cancel");
    const reason = normalizeNonEmpty(params.reason) ?? "run.cancel";
    const inFlight = this.#runCancellationTasks.get(runId);
    if (inFlight !== undefined) return inFlight;
    const task = this.#cancelRunTreeOnce(runId, reason);
    this.#runCancellationTasks.set(runId, task);
    try {
      return await task;
    } finally {
      if (this.#runCancellationTasks.get(runId) === task) {
        this.#runCancellationTasks.delete(runId);
      }
    }
  }

  async #cancelRunTreeOnce(
    runId: string,
    reason: string,
  ): Promise<RunCancelResult> {
    const cancelDurable = this.#cancelRunTreeDurable;
    if (cancelDurable === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "RUN_CANCEL_UNAVAILABLE",
        "run.cancel requires durable state wiring (cancelRunTreeDurable)",
      );
    }
    const cancelledAt = this.#now();
    const pendingCanonical: PendingCanonicalRunCancellation = {};
    this.#pendingCanonicalRunCancellations.set(runId, pendingCanonical);
    const interruptedLiveAgentIds: string[] = [];
    let report: CancelAgentRunTreeReport;
    let preparedLiveCancellation = false;
    let liveTerminalAlreadyPresent = false;
    let preparedVoidedHolds = 0;
    let terminationFinalized = false;
    try {
      const liveSnapshot = await this.#liveRunWriterSnapshot(runId);
      const observedSnapshot =
        pendingCanonical.snapshot?.terminal !== undefined
          ? pendingCanonical.snapshot
          : liveSnapshot;
      if (observedSnapshot?.terminal !== undefined) {
        liveTerminalAlreadyPresent = true;
        if (!isCanonicalRunTerminal(observedSnapshot.terminal, runId)) {
          throw new AgenCDaemonAgentLifecycleError(
            "RUN_CANCEL_UNAVAILABLE",
            `run.cancel observed invalid canonical terminal evidence for ${runId}`,
          );
        }
        pendingCanonical.snapshot = observedSnapshot;
        // A terminal may become visible between installing the cancellation
        // marker and reading the runner snapshot. Route it through the same
        // lifecycle handler so the legacy status cannot be DB-cancelled while
        // a completed canonical result is waiting to be projected.
        if (pendingCanonical.target === undefined) {
          await this.handleRunnerTerminated(runId, observedSnapshot);
        }
        if (observedSnapshot.terminal.result.status !== "cancelled") {
          const target = pendingCanonical.target;
          if (target !== undefined) {
            await this.#finalizeRunnerTermination(runId, target);
            terminationFinalized = true;
          }
        }
      } else if (liveSnapshot !== null) {
        const runner = this.#runner;
        const prepareCancellation =
          runner?.prepareAgentCancellation?.bind(runner);
        const stopRunner = runner?.stopAgent?.bind(runner);
        if (prepareCancellation === undefined || stopRunner === undefined) {
          throw new AgenCDaemonAgentLifecycleError(
            "RUN_CANCEL_UNAVAILABLE",
            `run.cancel cannot seal live run ${runId}: two-phase background cancellation is unavailable`,
          );
        }
        const preparation = await prepareCancellation(runId, reason);
        preparedLiveCancellation = true;
        preparedVoidedHolds = preparation.voidedHolds;
        try {
          const interrupted =
            (await runner?.interruptAgentTurn?.(runId, reason)) ?? false;
          if (interrupted) interruptedLiveAgentIds.push(runId);
        } catch (error) {
          // Full stop is the authoritative quiescence boundary. Preserve the
          // failed early interrupt as diagnostics, but do not skip it.
          this.#onSnapshotError(error);
        }

        let stopError: unknown;
        try {
          await stopRunner(runId, reason);
        } catch (error) {
          stopError = error;
        }
        if (pendingCanonical.snapshot?.terminal === undefined) {
          try {
            const stoppedSnapshot = await runner?.getAgentSnapshot?.(runId);
            if (stoppedSnapshot?.terminal !== undefined) {
              pendingCanonical.snapshot = stoppedSnapshot;
            }
          } catch (error) {
            stopError ??= error;
          }
        }
        const terminal = pendingCanonical.snapshot?.terminal;
        if (!isCanonicalCancellationTerminal(terminal, runId)) {
          if (stopError !== undefined) throw stopError;
          throw new AgenCDaemonAgentLifecycleError(
            "RUN_CANCEL_UNAVAILABLE",
            `run.cancel stopped live run ${runId} without canonical cancellation evidence`,
          );
        }
        if (stopError !== undefined) {
          // The terminal event proves quiescence crossed its durable close
          // boundary. Keep teardown diagnostics without discarding the
          // canonical cancellation or skipping projection convergence.
          this.#onSnapshotError(stopError);
        }
      }

      // Canonical-first for a live writer; durable-only for an inactive run.
      // A crash on either side is recoverable: a live terminal rebuilds the
      // projection, while an offline DB cancellation honestly has no output.
      report = await cancelDurable({ runId, reason, cancelledAt });
      if (report.missing) {
        throw new AgenCDaemonAgentLifecycleError(
          "RUN_NOT_FOUND",
          `run.cancel: no agent run found for id: ${runId}`,
        );
      }

      const deferredTermination = pendingCanonical.target;
      if (deferredTermination !== undefined && !terminationFinalized) {
        // The canonical event is already committed and the DB cascade has now
        // converged. Only at this point may the ordinary lifecycle writer
        // advance the legacy status and publish terminal notifications.
        await this.#finalizeRunnerTermination(runId, deferredTermination);
      }

      // Live cancellation already settled and canonicalized admissions before
      // stopAgent sealed the terminal tail. Offline/legacy runs have no writer,
      // so the compatibility follow-up remains responsible for live leases.
      let voidedHolds = preparedLiveCancellation
        ? preparedVoidedHolds
        : (report.admissionVoidedReservations ?? 0);
      const voidHolds = this.#voidBudgetHoldsForAgents;
      if (
        !preparedLiveCancellation &&
        !liveTerminalAlreadyPresent &&
        voidHolds !== undefined &&
        report.subtreeRunIds.length > 0
      ) {
        try {
          const followupVoids = await voidHolds(report.subtreeRunIds);
          if (report.admissionVoidedReservations === undefined) {
            voidedHolds = followupVoids;
          }
        } catch (error) {
          this.#onSnapshotError(error);
        }
      }

      return {
        runId,
        alreadyTerminal: report.alreadyTerminal,
        cancelledRunIds: report.cancelledRunIds,
        closedEdgeChildIds: report.closedEdgeChildIds,
        interruptedLiveAgentIds,
        voidedHolds,
      };
    } finally {
      this.#pendingCanonicalRunCancellations.delete(runId);
    }
  }

  async #liveRunWriterSnapshot(
    runId: string,
  ): Promise<AgenCBackgroundAgentSnapshot | null> {
    const readSnapshot = this.#runner?.getAgentSnapshot?.bind(this.#runner);
    if (readSnapshot !== undefined) {
      return (await readSnapshot(runId)) ?? null;
    }
    if (this.#runner !== undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "RUN_CANCEL_UNAVAILABLE",
        `run.cancel cannot prove whether run ${runId} has a live canonical writer`,
      );
    }
    return null;
  }

  /**
   * Apply a runner-initiated terminal snapshot to a tracked agent.
   *
   * Invoked by the background runner immediately before it removes an
   * agent from `#active` (turn ended, errored, shutdown). Without this
   * hook the lifecycle's poll-based `getAgentSnapshot` lookup hits null
   * after cleanup and `agent.status` stays at the initial `running`
   * value, leaving stale rows in `agent.list` for every completed
   * agent. The snapshot's `status` is already mapped to the daemon
   * vocabulary by `mapThreadStatus` in the runner — typically
   * `"stopped"` for a completed/shutdown thread or `"error"` for an
   * errored one.
   */
  async handleRunnerTerminated(
    agentId: string,
    snapshot: AgenCBackgroundAgentSnapshot,
  ): Promise<void> {
    const transitionAt = this.#now();
    const target = await this.#state.with((state) => {
      const target = this.#applyRunnerTerminationLocked(
        state,
        agentId,
        snapshot,
        transitionAt,
      );
      if (target !== null) return target;
      if (this.#activeCreates > 0 && !state.agents.has(agentId)) {
        this.#pendingRunnerTerminations.set(agentId, {
          snapshot,
          transitionAt,
        });
      }
      return null;
    });
    const pendingCancellation =
      this.#pendingCanonicalRunCancellations.get(agentId);
    if (pendingCancellation !== undefined) {
      pendingCancellation.snapshot = snapshot;
      if (target !== null) pendingCancellation.target = target;
      // run.cancel owns the ordering while this marker is installed:
      // canonical terminal -> tree cascade -> legacy status/notifications.
      // Returning here prevents the runner callback from racing a terminal
      // SQLite status ahead of the descendant cascade.
      return;
    }
    if (target === null) return;
    await this.#finalizeRunnerTermination(agentId, target);
  }

  #applyRunnerTerminationLocked(
    state: AgentLifecycleState,
    agentId: string,
    snapshot: AgenCBackgroundAgentSnapshot,
    transitionAt: string,
  ): RunnerTerminationTarget | null {
    const agent = state.agents.get(agentId);
    if (agent === undefined) return null;
    if (!isActiveAgent(agent)) return null;
    const sessionIds = [...agent.sessionIds];
    const route = snapshotRouteForAgent(agent);
    applyAgentSnapshot(agent, snapshot);
    agent.runtimeAvailable = false;
    // Mirror stopAgent end-state: move active sessionIds into
    // logSessionIds so subsequent log reads still address the
    // archived sessions, and clear sessionIds so the agent is no
    // longer treated as live.
    agent.logSessionIds = uniqueNonEmptyStrings([
      ...agent.logSessionIds,
      ...agent.sessionIds,
    ]);
    agent.sessionIds = [];
    return {
      sessionIds,
      route,
      status: snapshot.status,
      transitionAt,
      ...(snapshot.metadata !== undefined
        ? { metadata: snapshot.metadata }
        : {}),
      ...(snapshot.terminal !== undefined
        ? { terminal: snapshot.terminal }
        : {}),
    };
  }

  async #finalizeRunnerTermination(
    agentId: string,
    target: RunnerTerminationTarget,
  ): Promise<void> {
    if (
      target.terminal !== undefined &&
      this.#recordRunTerminal !== undefined
    ) {
      try {
        await this.#recordRunTerminal({
          agentId,
          sessionId: agentId,
          ...target.route,
          ...target.terminal,
        });
      } catch (error) {
        // Do not advance the legacy agent row to a terminal status when the
        // durable terminal projection failed. The canonical JSONL event can
        // be replayed on restart/query and remains the recovery authority.
        this.#onSnapshotError(error);
        return;
      }
    }
    await this.#recordAgentStatusSnapshots(
      target.sessionIds,
      agentId,
      target.status,
      target.transitionAt,
      "runner_terminated",
      target.route,
      target.metadata,
    );
    await this.#terminateAgentSessions(target.sessionIds, "runner_terminated");
  }

  async stopAll(
    reason = "daemon_shutdown",
    options: { readonly disposition?: "cancel" | "suspend_idle" } = {},
  ): Promise<number> {
    this.#shuttingDown = true;
    this.#shutdownDisposition = options.disposition ?? "cancel";
    await this.#waitForActiveCreates();
    const targets = await this.#state.with(async (state) => {
      await this.#refreshAgentsFromRunner(state);
      return [...state.agents.values()].filter(isActiveAgent).map((agent) => ({
        agentId: agent.agentId,
        sessionIds: [...agent.sessionIds],
        route: snapshotRouteForAgent(agent),
      }));
    });
    const failures: Array<{
      readonly agentId: string;
      readonly error: unknown;
    }> = [];
    let stopped = 0;
    for (const target of targets) {
      const stopRunner = this.#runner?.stopAgent?.bind(this.#runner);
      const suspendRunner =
        this.#runner?.suspendIdleAgentForDaemonShutdown?.bind(this.#runner);
      let stopFailed = false;
      let runStatus: "suspended" | undefined;
      if (
        options.disposition === "suspend_idle" &&
        suspendRunner !== undefined
      ) {
        try {
          const result = await suspendRunner(target.agentId);
          if (result.disposition === "suspended") runStatus = "suspended";
        } catch (error) {
          if (error instanceof AgenCBackgroundAgentSuspensionShutdownError) {
            runStatus = "suspended";
          }
          stopFailed = true;
          failures.push({ agentId: target.agentId, error });
        }
      } else if (stopRunner !== undefined) {
        try {
          await stopRunner(target.agentId, reason);
        } catch (error) {
          stopFailed = true;
          failures.push({ agentId: target.agentId, error });
        }
      }
      const stoppedAt = this.#now();
      const finalStatus = stopFailed ? "error" : "stopped";
      await this.#state.with((state) => {
        const agent = state.agents.get(target.agentId);
        if (agent === undefined) return;
        agent.status = finalStatus;
        agent.lastActiveAt = stoppedAt;
        agent.logSessionIds = uniqueNonEmptyStrings([
          ...agent.logSessionIds,
          ...agent.sessionIds,
        ]);
        agent.sessionIds = [];
      });
      await this.#recordAgentStatusSnapshots(
        target.sessionIds,
        target.agentId,
        finalStatus,
        stoppedAt,
        reason,
        target.route,
        undefined,
        runStatus,
      );
      try {
        await this.#terminateAgentSessions(target.sessionIds, reason);
      } catch (error) {
        failures.push({ agentId: target.agentId, error });
      }
      stopped += 1;
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `AgenC daemon cleanup failed for ${failures.length} agent(s): ${failures
          .map((failure) => failure.agentId)
          .join(", ")}`,
      );
    }
    return stopped;
  }

  async flushSnapshots(reason = "daemon_shutdown"): Promise<number> {
    const flushedAt = this.#now();
    const agents = await this.#state.with((state) =>
      [...state.agents.values()].map(toAgentSummary),
    );
    await this.#snapshotFlush?.({ reason, flushedAt, agents });
    return agents.length;
  }

  /**
   * Transition agents to `error` when the runner has gone away without
   * firing the terminal callback, or when a recovered run came back
   * without a live runtime. Without this sweep, `agent.list` keeps
   * showing those entries as `running`/`idle` and the durable
   * `agent_runs.status` never reaches a terminal value, so the next
   * daemon restart loads them right back into the same broken state.
   *
   * Safe to call repeatedly. Returns the agent ids that were reaped.
   */
  async reapStaleAgents(
    options: { readonly reason?: string } = {},
  ): Promise<readonly string[]> {
    const reason = options.reason ?? "stale_runner";
    const candidates = await this.#state.with(async (state) => {
      await this.#refreshAgentsFromRunner(state);
      return [...state.agents.values()].filter((agent) => isStaleAgent(agent));
    });
    if (candidates.length === 0) return [];
    const reaped: string[] = [];
    for (const candidate of candidates) {
      const transitionAt = this.#now();
      const target = await this.#state.with((state) => {
        const agent = state.agents.get(candidate.agentId);
        if (agent === undefined || !isStaleAgent(agent)) return null;
        agent.status = "error";
        agent.lastActiveAt = transitionAt;
        agent.runtimeAvailable = false;
        const sessionIds = [...agent.sessionIds];
        agent.logSessionIds = uniqueNonEmptyStrings([
          ...agent.logSessionIds,
          ...agent.sessionIds,
        ]);
        agent.sessionIds = [];
        return { sessionIds, route: snapshotRouteForAgent(agent) };
      });
      if (target === null) continue;
      reaped.push(candidate.agentId);
      await this.#recordAgentStatusSnapshots(
        target.sessionIds,
        candidate.agentId,
        "error",
        transitionAt,
        reason,
        target.route,
      );
      await this.#terminateAgentSessions(target.sessionIds, reason);
    }
    return reaped;
  }

  async listPermissions(
    params: PermissionListParams = {},
  ): Promise<PermissionListResult> {
    if (this.#runner?.listPermissions === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "permission.list requires a background runner",
      );
    }
    const agentId = await this.#resolvePermissionListAgentId(params);
    const result = await this.#runner.listPermissions(agentId);
    if (result === null) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon agent not found: ${agentId}`,
      );
    }
    return result;
  }

  async approveTool(params: ToolApproveParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
    );
    const allowAllToolsForSession = params.allowAllToolsForSession === true;
    if (allowAllToolsForSession && params.scope !== "session") {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "allowAllToolsForSession requires session approval scope",
      );
    }
    if (
      allowAllToolsForSession &&
      this.#runner?.setAgentPermissionMode === undefined
    ) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session-wide all-tool approval requires a permission-mode capable runner",
      );
    }
    // Record the plan-mode approval choice BEFORE resolving the decision so the
    // deferred ExitPlanMode tool (same daemon process) can consume it via
    // consumeExitPlanModeApproval({ __callId: requestId }). requestId === the
    // tool's __callId end-to-end (both are invocation.callId).
    if (params.exitPlan !== undefined) {
      const approval = toExitPlanModeApproval(params.exitPlan);
      recordExitPlanModeApproval(params.requestId, approval);
    }
    // Same side-channel for AskUserQuestion: the TUI's picker records the
    // user's answers client-side and ships the merged input with
    // `tool.approve`; the daemon-side tool execution consumes it from THIS
    // process's answeredInputs map via consumeAnsweredInput(__callId) —
    // without recording here, the tool runs with "User did not provide
    // answers." even though the user answered.
    if (params.askUserQuestionInput !== undefined) {
      const parsed = parseAskUserQuestionInput(params.askUserQuestionInput);
      if (!parsed.ok) {
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          `tool.approve param 'askUserQuestionInput' is invalid: ${parsed.error}`,
        );
      }
      recordAskUserQuestionResponse(params.requestId, parsed.input);
    }
    // `tool.approve` is a preemptive daemon RPC. Apply the real session mode
    // inside this same request before releasing the currently-blocked tool so
    // a second tool in the same model turn cannot race ahead and prompt again.
    // Plain scope=session intentionally retains its historic per-rule cache.
    const modeChange = allowAllToolsForSession
      ? await this.#runner!.setAgentPermissionMode!(agentId, {
          sessionId: params.sessionId,
          mode: "bypassPermissions",
          bypassAuthority: "operator_tool_approval",
        })
      : undefined;
    let resolved = false;
    try {
      resolved = await this.#runner!.resolveToolDecision!(agentId, {
        requestId: params.requestId,
        decision:
          params.scope === "session" || params.scope === "agent"
            ? APPROVED_FOR_SESSION
            : APPROVED,
      });
    } catch (error) {
      await this.#rollbackAllToolsPermissionMode(
        agentId,
        params.sessionId,
        modeChange,
      );
      throw error;
    }
    if (!resolved) {
      await this.#rollbackAllToolsPermissionMode(
        agentId,
        params.sessionId,
        modeChange,
      );
      // The request is no longer pending, so the deferred ExitPlanMode tool will
      // never run to consume the approval recorded above. Drop it here so it does
      // not leak permanently into the module-global approvals Map (consume's
      // delete is the only production removal path).
      if (params.exitPlan !== undefined) {
        consumeExitPlanModeApproval({ __callId: params.requestId });
      }
      if (params.askUserQuestionInput !== undefined) {
        dropAskUserQuestionResponse(params.requestId);
      }
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon tool request is not pending: ${params.requestId}`,
      );
    }
    await this.#recordToolDecisionAudit({
      decision: "approved",
      sessionId: params.sessionId,
      agentId,
      requestId: params.requestId,
      ...(params.scope !== undefined ? { scope: params.scope } : {}),
      reasonCode: allowAllToolsForSession
        ? "rpc_approved_all_tools_for_session"
        : params.scope === "session" || params.scope === "agent"
          ? "rpc_approved_for_scope"
          : "rpc_approved_once",
    });
    return { requestId: params.requestId, decision: "approved" };
  }

  /** Undo a mode promotion if the pending request disappeared mid-approval. */
  async #rollbackAllToolsPermissionMode(
    agentId: string,
    sessionId: string,
    modeChange:
      | {
          readonly applied: boolean;
          readonly previousMode: string;
          readonly rollback?: () => Promise<void>;
        }
      | undefined,
  ): Promise<void> {
    if (!modeChange?.applied) return;
    try {
      if (modeChange.rollback !== undefined) {
        await modeChange.rollback();
        return;
      }
      await this.#runner!.setAgentPermissionMode!(agentId, {
        sessionId,
        mode: modeChange.previousMode,
      });
    } catch {
      // Preserve the original stale/failed decision error. The production
      // runner supplies an exact-context rollback; this fallback exists for
      // third-party/test runners and must not mask the actionable failure.
    }
  }

  async denyTool(params: ToolDenyParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
    );
    const resolved = await this.#runner!.resolveToolDecision!(agentId, {
      requestId: params.requestId,
      decision: DENIED,
    });
    if (!resolved) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon tool request is not pending: ${params.requestId}`,
      );
    }
    await this.#recordToolDecisionAudit({
      decision: "denied",
      sessionId: params.sessionId,
      agentId,
      requestId: params.requestId,
      reasonCode: "rpc_denied",
    });
    return { requestId: params.requestId, decision: "denied" };
  }

  /**
   * Interrupt the active turn for a daemon-owned session. Resolves to
   * `{ cancelled: false }` for an idle session (no error — pressing
   * ESC at the prompt is a no-op, not a failure). Resolves to
   * `{ cancelled: true }` when the agent's interrupt was dispatched.
   *
   * Implementation: find the agent owning this session, then ask the
   * background runner to fire `AgentControl.interrupt(agentId, reason)`,
   * which signals the agent's AbortController and cascades to
   * descendant subagents.
   */
  async resolveSessionToolCall(
    params: SessionResolveToolCallParams,
  ): Promise<SessionResolveToolCallResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.resolveToolCall requires a daemon session manager",
      );
    }
    const session = await this.#sessionManager.getSession(params.sessionId);
    if (session === null || !isActiveSession(session)) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon session not found or closed: ${params.sessionId}`,
      );
    }
    // The production runner appends through the Session that owns the live
    // journal lease. The offline resolver remains only for injected runners
    // and legacy rows that have no live canonical effect journal.
    if (session.cwd === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon session has no working directory: ${params.sessionId}`,
      );
    }
    const driver = openStateDatabases({ cwd: session.cwd });
    try {
      const candidates =
        params.toolCallId !== undefined
          ? [
              {
                sessionId: params.sessionId,
                toolCallId: params.toolCallId,
                toolName: "",
                startedAt: "",
              },
            ]
          : [...listUnresolvedUnknownOutcomeEffects(driver, params.sessionId)];
      const resolved: SessionResolveToolCallResult["resolved"][number][] = [];

      if (!isEvidenceToolCallResolution(params)) {
        const durableEffects = new StateRunDurabilityRepository(driver);
        for (const effect of candidates) {
          // The published 1.0 request carried no disposition or evidence. It
          // remains valid only for pre-durability poisoned rows; every durable
          // v1/v2 effect stays pending until an evidence-bearing request arrives.
          if (
            durableEffects.getEffectBySessionCall(
              params.sessionId,
              effect.toolCallId,
            ) !== undefined
          ) {
            continue;
          }
          if (
            resolveUnknownOutcomeEffect(driver, {
              sessionId: params.sessionId,
              toolCallId: effect.toolCallId,
            })
          ) {
            resolved.push({
              toolCallId: effect.toolCallId,
              toolName: effect.toolName,
            });
          }
        }
        return {
          sessionId: params.sessionId,
          resolved,
          remaining: listUnresolvedUnknownOutcomeEffects(
            driver,
            params.sessionId,
          ).length,
        };
      }

      const reviewedAt = new Date().toISOString();
      const reviewedBy = params.reviewer?.trim() || "tui_operator";
      const resolution = createOperatorEffectReviewResolution({
        disposition: params.disposition,
        actorId: reviewedBy,
        evidenceRef: params.evidenceRef,
        evidenceSha256: params.evidenceSha256,
        reviewedAt,
      });
      for (const effect of candidates) {
        const reviewOptions = {
          sessionId: params.sessionId,
          toolCallId: effect.toolCallId,
          resolution,
        } as const;
        const outcome =
          this.#runner?.resolveLiveEffectReview !== undefined
            ? await this.#runner.resolveLiveEffectReview(
                session.agentId,
                reviewOptions,
              )
            : resolveDurableEffectReview(driver, reviewOptions);
        if (outcome.kind === "resolved") {
          resolved.push({
            toolCallId: effect.toolCallId,
            toolName: effect.toolName,
            ...(outcome.durable &&
            "eventId" in outcome &&
            typeof outcome.eventId === "string"
              ? { eventId: outcome.eventId }
              : {}),
          });
        }
      }
      const remaining = listUnresolvedUnknownOutcomeEffects(
        driver,
        params.sessionId,
      ).length;
      return { sessionId: params.sessionId, resolved, remaining };
    } finally {
      driver.close();
    }
  }

  async cancelSessionTurn(
    params: SessionCancelTurnParams,
  ): Promise<SessionCancelTurnResult> {
    const reason = params.reason ?? "interrupted";
    if (this.#sessionManager === undefined || this.#runner === undefined) {
      return { sessionId: params.sessionId, cancelled: false, reason };
    }
    const session = await this.#sessionManager.getSession(params.sessionId);
    if (session === null || !isActiveSession(session)) {
      return { sessionId: params.sessionId, cancelled: false, reason };
    }
    const canCancel = await this.#state.with(async (state) => {
      const agent = state.agents.get(session.agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(session.agentId);
      return (
        refreshed !== undefined &&
        isActiveAgent(refreshed) &&
        !isRecoveredRuntimeUnavailable(refreshed)
      );
    });
    if (!canCancel) {
      return { sessionId: params.sessionId, cancelled: false, reason };
    }
    if (this.#runner.interruptAgentTurn === undefined) {
      return { sessionId: params.sessionId, cancelled: false, reason };
    }
    if (params.expectedTurnId !== undefined) {
      if (this.#runner.interruptAgentTurnIfMatches === undefined) {
        return {
          sessionId: params.sessionId,
          cancelled: false,
          reason,
          stale: true,
        };
      }
      const result = await this.#runner.interruptAgentTurnIfMatches(
        session.agentId,
        reason,
        params.expectedTurnId,
      );
      return {
        sessionId: params.sessionId,
        cancelled: result.cancelled,
        reason,
        ...(result.activeTurnId !== undefined
          ? { activeTurnId: result.activeTurnId }
          : {}),
        ...(result.stale !== undefined ? { stale: result.stale } : {}),
      };
    }
    const cancelled = await this.#runner.interruptAgentTurn(
      session.agentId,
      reason,
    );
    return { sessionId: params.sessionId, cancelled, reason };
  }

  async cancelTool(params: ToolCancelParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      {
        allowCancelTool: true,
      },
    );
    let resolved = false;
    if (this.#runner!.cancelTool !== undefined) {
      resolved = await this.#runner!.cancelTool(agentId, {
        requestId: params.requestId,
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      });
    }
    if (!resolved && this.#runner!.resolveToolDecision !== undefined) {
      resolved = await this.#runner!.resolveToolDecision(agentId, {
        requestId: params.requestId,
        decision: ABORT,
      });
    }
    if (!resolved) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon tool request is not pending: ${params.requestId}`,
      );
    }
    return { requestId: params.requestId, decision: "cancelled" };
  }

  async executeSessionShell(
    params: SessionShellExecuteParams,
    signal?: AbortSignal,
  ): Promise<SessionShellExecuteResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.shell.execute requires a daemon session manager",
      );
    }
    if (this.#runner?.executeAgentShell === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.shell.execute requires a live daemon runtime",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowExecuteShell: true },
    );
    return this.#runner.executeAgentShell(agentId, params, signal);
  }

  async respondToElicitation(
    params: ElicitationRespondParams,
  ): Promise<ElicitationRespondResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowElicitationResponse: true },
    );
    const resolved = await this.#runner!.respondToElicitation!(agentId, {
      requestId: params.requestId,
      kind: params.kind,
      ...(params.serverName !== undefined
        ? { serverName: params.serverName }
        : {}),
      response: params.response,
    });
    if (!resolved) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon elicitation request is not pending: ${String(params.requestId)}`,
      );
    }
    return { requestId: params.requestId, resolved };
  }

  async clearSessionHistory(
    params: SessionClearParams,
  ): Promise<SessionClearResult> {
    const clearedAt = this.#now();
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.clear requires a daemon session manager",
      );
    }
    if (this.#runner?.clearAgentSession === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.clear requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowClearSession: true },
    );
    await this.#runner.clearAgentSession(agentId, {
      sessionId: params.sessionId,
      clearedAt,
    });
    return {
      sessionId: params.sessionId,
      cleared: true,
      clearedAt,
    };
  }

  async addMcpServerToSession(
    params: SessionMcpAddServerParams,
  ): Promise<SessionMcpAddServerResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.mcp.addServer requires a daemon session manager",
      );
    }
    if (this.#runner?.addMcpServer === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.mcp.addServer requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowMcpAddServer: true },
    );
    const result = await this.#runner.addMcpServer(agentId, {
      sessionId: params.sessionId,
      config: params.config,
    });
    return {
      sessionId: params.sessionId,
      serverName: result.serverName,
      success: result.success,
      toolCount: result.toolCount,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async getMcpStatusForSession(
    params: SessionMcpStatusParams,
  ): Promise<SessionMcpStatusResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.mcp.status requires a daemon session manager",
      );
    }
    if (this.#runner?.getMcpStatus === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.mcp.status requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowMcpStatus: true },
    );
    const snapshot = await this.#runner.getMcpStatus(agentId);
    return {
      sessionId: params.sessionId,
      revision: snapshot.revision,
      servers: snapshot.servers.map((server): SessionMcpStatusServer => ({
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
        required: server.required,
        state: server.state,
        ...(server.displayTarget !== undefined
          ? { displayTarget: server.displayTarget }
          : {}),
        toolCount: server.toolCount,
      })),
      tools: snapshot.tools.map((tool): SessionMcpStatusTool => ({
        serverName: tool.serverName,
        name: tool.name,
      })),
    };
  }

  async reconnectMcpServerOnSession(
    params: SessionMcpServerByNameParams,
  ): Promise<SessionMcpServerMutationResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.mcp.reconnectServer requires a daemon session manager",
      );
    }
    if (this.#runner?.reconnectMcpServer === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.mcp.reconnectServer requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowMcpReconnectServer: true },
    );
    const result = await this.#runner.reconnectMcpServer(agentId, {
      sessionId: params.sessionId,
      serverName: params.serverName,
    });
    return {
      sessionId: params.sessionId,
      serverName: result.serverName,
      success: result.success,
      toolCount: result.toolCount,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async enableMcpServerOnSession(
    params: SessionMcpServerByNameParams,
  ): Promise<SessionMcpServerMutationResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.mcp.enableServer requires a daemon session manager",
      );
    }
    if (this.#runner?.enableMcpServer === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.mcp.enableServer requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowMcpEnableServer: true },
    );
    const result = await this.#runner.enableMcpServer(agentId, {
      sessionId: params.sessionId,
      serverName: params.serverName,
    });
    return {
      sessionId: params.sessionId,
      serverName: result.serverName,
      success: result.success,
      toolCount: result.toolCount,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async disableMcpServerOnSession(
    params: SessionMcpServerByNameParams,
  ): Promise<SessionMcpServerMutationResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.mcp.disableServer requires a daemon session manager",
      );
    }
    if (this.#runner?.disableMcpServer === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.mcp.disableServer requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowMcpDisableServer: true },
    );
    const result = await this.#runner.disableMcpServer(agentId, {
      sessionId: params.sessionId,
      serverName: params.serverName,
    });
    return {
      sessionId: params.sessionId,
      serverName: result.serverName,
      success: result.success,
      toolCount: result.toolCount,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async snapshotSession(
    params: SessionSnapshotParams,
  ): Promise<SessionSnapshotResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.snapshot requires a daemon session manager",
      );
    }
    if (this.#runner?.snapshotAgentSession === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.snapshot requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowSnapshot: true },
    );
    return this.#runner.snapshotAgentSession(agentId, {
      sessionId: params.sessionId,
    });
  }

  async getSessionTranscript(
    params: SessionTranscriptParams,
  ): Promise<SessionTranscriptResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.transcript requires a daemon session manager",
      );
    }
    // A persisted "terminal" session (created by `agenc` running in its own
    // process) leaves a thread in the store but no live agent in this daemon.
    // A joining client (e.g. the iOS app) still needs the conversation
    // history. When no live agent is available, fall back to reading the
    // persisted thread from the same thread store `agenc agent logs` uses,
    // rather than throwing. The live-agent path below is unchanged.
    if (this.#runner?.getAgentSessionTranscript === undefined) {
      const persisted = this.#readPersistedSessionTranscript(params.sessionId);
      if (persisted !== undefined) return persisted;
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.transcript requires a background runner",
      );
    }
    let agentId: string;
    try {
      agentId = await this.#resolveActiveAgentIdForSession(params.sessionId, {
        allowSnapshot: true,
      });
    } catch (error) {
      if (isNoLiveAgentError(error)) {
        const persisted = this.#readPersistedSessionTranscript(
          params.sessionId,
        );
        if (persisted !== undefined) return persisted;
      }
      throw error;
    }
    try {
      return await this.#runner.getAgentSessionTranscript(agentId, {
        sessionId: params.sessionId,
      });
    } catch (error) {
      // The lifecycle map can still consider the agent "active" while the
      // runner has no live in-memory agent for it (e.g. a recovered terminal
      // session). Fall back to the persisted thread for the same reason.
      if (isNoLiveAgentRunnerError(error)) {
        const persisted = this.#readPersistedSessionTranscript(
          params.sessionId,
        );
        if (persisted !== undefined) return persisted;
      }
      throw error;
    }
  }

  async getSessionTranscriptV2(
    params: SessionTranscriptV2Params,
  ): Promise<SessionTranscriptV2Result> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.transcript.v2 requires a daemon session manager",
      );
    }
    if (this.#runner?.getAgentSessionTranscriptV2 === undefined) {
      const persisted = this.#readPersistedSessionTranscriptV2(
        params.sessionId,
      );
      if (persisted !== undefined) return persisted;
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.transcript.v2 requires a background runner",
      );
    }
    let agentId: string;
    try {
      agentId = await this.#resolveActiveAgentIdForSession(params.sessionId, {
        allowSnapshot: true,
      });
    } catch (error) {
      if (isNoLiveAgentError(error)) {
        const persisted = this.#readPersistedSessionTranscriptV2(
          params.sessionId,
        );
        if (persisted !== undefined) return persisted;
      }
      throw error;
    }
    try {
      return await this.#runner.getAgentSessionTranscriptV2(agentId, {
        sessionId: params.sessionId,
      });
    } catch (error) {
      if (isNoLiveAgentRunnerError(error)) {
        const persisted = this.#readPersistedSessionTranscriptV2(
          params.sessionId,
        );
        if (persisted !== undefined) return persisted;
      }
      throw error;
    }
  }

  /**
   * Read the persisted conversation for a session straight from the thread
   * store (the same source `agenc agent logs <id>` prints via
   * {@link storedThreadToAgentLogSession}). Returns the user/assistant text
   * in {@link SessionTranscriptResult} shape, matching the extraction the
   * live-agent transcript path performs over the in-memory history. Returns
   * `undefined` when there is no persisted thread to read so callers can
   * decide whether to surface the original no-live-agent error.
   */
  #readPersistedSessionTranscript(
    sessionId: string,
  ): SessionTranscriptResult | undefined {
    const threadStore = this.#threadStore;
    if (threadStore === undefined) return undefined;
    let thread: StoredThread;
    try {
      thread = threadStore.readThread({
        threadId: sessionId,
        includeArchived: true,
        includeHistory: true,
      });
    } catch (error) {
      if (isThreadLogReadMiss(error)) return undefined;
      throw error;
    }
    const messages = transcriptMessagesFromRolloutItems(
      thread.history?.items ?? [],
    );
    return { sessionId, messages };
  }

  #readPersistedSessionTranscriptV2(
    sessionId: string,
  ): SessionTranscriptV2Result | undefined {
    const threadStore = this.#threadStore;
    if (threadStore === undefined) return undefined;
    let thread: StoredThread;
    try {
      thread = threadStore.readThread({
        threadId: sessionId,
        includeArchived: true,
        includeHistory: true,
      });
    } catch (error) {
      if (isThreadLogReadMiss(error)) return undefined;
      throw error;
    }
    return sessionTranscriptV2FromRollout(
      thread.history?.items ?? [],
      sessionId,
      thread.threadId,
    );
  }

  async partialCompactFromMessage(
    params: SessionPartialCompactFromMessageParams,
    signal?: AbortSignal,
  ): Promise<SessionPartialCompactFromMessageResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.partialCompactFromMessage requires a daemon session manager",
      );
    }
    if (this.#runner?.partialCompactFromMessage === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.partialCompactFromMessage requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowPartialCompact: true },
    );
    return await this.#runner.partialCompactFromMessage(agentId, {
      sessionId: params.sessionId,
      messageOrdinal: params.messageOrdinal,
      direction: params.direction,
      ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async rollbackCompaction(
    params: SessionRollbackCompactionParams,
  ): Promise<SessionRollbackCompactionResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.rollbackCompaction requires a daemon session manager",
      );
    }
    if (this.#runner?.rollbackCompaction === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.rollbackCompaction requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowCompactionOperator: true },
    );
    return await this.#runner.rollbackCompaction(agentId, {
      sessionId: params.sessionId,
      attemptId: params.attemptId,
      ...(params.reviewedBranchTargetSessionId !== undefined
        ? {
            reviewedBranchTargetSessionId: params.reviewedBranchTargetSessionId,
          }
        : {}),
    });
  }

  async extendCompactionRollbackRetention(
    params: SessionExtendCompactionRollbackRetentionParams,
  ): Promise<SessionExtendCompactionRollbackRetentionResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.extendCompactionRollbackRetention requires a daemon session manager",
      );
    }
    if (this.#runner?.extendCompactionRollbackRetention === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.extendCompactionRollbackRetention requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowCompactionOperator: true },
    );
    return await this.#runner.extendCompactionRollbackRetention(agentId, {
      sessionId: params.sessionId,
      attemptId: params.attemptId,
      extendedUntilMs: params.extendedUntilMs,
    });
  }

  async rewindConversationToMessage(
    params: SessionRewindConversationToMessageParams,
    signal?: AbortSignal,
  ): Promise<SessionRewindConversationToMessageResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.rewindConversationToMessage requires a daemon session manager",
      );
    }
    if (this.#runner?.rewindConversationToMessage === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.rewindConversationToMessage requires a background runner",
      );
    }
    if (signal?.aborted) {
      throw Object.assign(new Error("request cancelled"), {
        name: "AbortError",
      });
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowConversationRewind: true },
    );
    return await this.#runner.rewindConversationToMessage(agentId, {
      sessionId: params.sessionId,
      messageOrdinal: params.messageOrdinal,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async previewFileRewind(
    params: SessionFileRewindParams,
  ): Promise<SessionPreviewFileRewindResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.previewFileRewind requires a daemon session manager",
      );
    }
    if (this.#runner?.previewFileRewind === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.previewFileRewind requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowConversationRewind: true },
    );
    return await this.#runner.previewFileRewind(agentId, {
      sessionId: params.sessionId,
      messageOrdinal: params.messageOrdinal,
    });
  }

  async rewindFilesToMessage(
    params: SessionFileRewindParams,
  ): Promise<SessionRewindFilesToMessageResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.rewindFilesToMessage requires a daemon session manager",
      );
    }
    if (this.#runner?.rewindFilesToMessage === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.rewindFilesToMessage requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowConversationRewind: true },
    );
    return await this.#runner.rewindFilesToMessage(agentId, {
      sessionId: params.sessionId,
      messageOrdinal: params.messageOrdinal,
    });
  }

  async setSessionModel(
    params: SessionSetModelParams,
  ): Promise<SessionSetModelResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.setModel requires a daemon session manager",
      );
    }
    if (this.#runner?.setAgentModel === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.setModel requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowSetModel: true },
    );
    const summary = await this.#runner.setAgentModel(agentId, {
      sessionId: params.sessionId,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
    });
    return {
      sessionId: params.sessionId,
      applied: summary.applied,
      provider: summary.provider,
      model: summary.model,
      runtimeSettingsEventId: summary.runtimeSettingsEventId,
      summary: summary.summary,
    };
  }

  async setSessionPermissionMode(
    params: SessionSetPermissionModeParams,
  ): Promise<SessionSetPermissionModeResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.setPermissionMode requires a daemon session manager",
      );
    }
    if (this.#runner?.setAgentPermissionMode === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.setPermissionMode requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowSetPermissionMode: true },
    );
    const result = await this.#runner.setAgentPermissionMode(agentId, {
      sessionId: params.sessionId,
      mode: params.mode,
      // Operator consent for a live switch to bypassPermissions. The
      // runner has always honored this; the RPC route dropped it, so no
      // client could ever switch a running session into bypass.
      ...(params.bypassAuthority === "operator_tool_approval"
        ? { bypassAuthority: params.bypassAuthority }
        : {}),
    });
    return {
      sessionId: params.sessionId,
      applied: result.applied,
      previousMode: result.previousMode,
      mode: result.mode,
    };
  }

  async mutateSessionPermissionRule(
    params: SessionPermissionRuleMutationParams,
  ): Promise<SessionPermissionRuleMutationResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.permissions.mutateRule requires a daemon session manager",
      );
    }
    if (this.#runner?.mutateAgentPermissionRule === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.permissions.mutateRule requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowMutatePermissionRule: true },
    );
    const result = await this.#runner.mutateAgentPermissionRule(agentId, {
      sessionId: params.sessionId,
      operation: params.operation,
      behavior: params.behavior,
      rule: params.rule,
    });
    return {
      sessionId: params.sessionId,
      applied: result.applied,
      operation: result.operation,
      behavior: result.behavior,
      rule: result.rule,
      sessionRules: result.sessionRules,
    };
  }

  async getSessionHooksStatus(
    params: SessionHooksStatusParams,
  ): Promise<SessionHooksStatusResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.hooks.status requires a daemon session manager",
      );
    }
    if (this.#runner?.getAgentHooksStatus === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.hooks.status requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowHooksStatus: true },
    );
    const status = await this.#runner.getAgentHooksStatus(agentId);
    return {
      sessionId: params.sessionId,
      available: status.available,
      sourcePath: status.sourcePath,
      disabled: status.disabled,
      hardSuppressed: status.hardSuppressed,
      effectiveDisabled: status.effectiveDisabled,
      suppressionReason: status.suppressionReason,
      issues: status.issues,
      hooks: status.hooks,
      diagnostics: status.diagnostics,
    };
  }

  async setSessionHooksDisabled(
    params: SessionHooksSetDisabledParams,
  ): Promise<SessionHooksSetDisabledResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.hooks.setDisabled requires a daemon session manager",
      );
    }
    if (this.#runner?.setAgentHooksDisabled === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.hooks.setDisabled requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowSetHooksDisabled: true },
    );
    const result = await this.#runner.setAgentHooksDisabled(agentId, {
      disabled: params.disabled,
    });
    return {
      sessionId: params.sessionId,
      applied: result.applied,
      disabled: result.disabled,
      hardSuppressed: result.hardSuppressed,
      effectiveDisabled: result.effectiveDisabled,
      suppressionReason: result.suppressionReason,
    };
  }

  async applyConfigToSession(
    params: SessionApplyConfigParams,
  ): Promise<SessionApplyConfigResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.applyConfig requires a daemon session manager",
      );
    }
    if (this.#runner?.applyAgentConfig === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.applyConfig requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowApplyConfig: true },
    );
    const result = await this.#runner.applyAgentConfig(agentId, {
      sessionId: params.sessionId,
      ...(params.profile !== undefined ? { profile: params.profile } : {}),
      ...(params.reload !== undefined ? { reload: params.reload } : {}),
    });
    return {
      sessionId: params.sessionId,
      applied: result.applied,
      ...(result.provider === undefined ? {} : { provider: result.provider }),
      ...(result.model === undefined ? {} : { model: result.model }),
      ...(result.runtimeSettingsEventId === undefined
        ? {}
        : { runtimeSettingsEventId: result.runtimeSettingsEventId }),
      summary: result.summary,
    };
  }

  async resolveCodePredictionSource(
    sessionId: string,
  ): Promise<CodePredictionSource> {
    const agentId = await this.#resolveActiveAgentIdForSession(sessionId, {
      allowCodePrediction: true,
    });
    const resolveSource = this.#runner?.resolveCodePredictionSource;
    if (resolveSource === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "editor prediction requires a live daemon runtime",
      );
    }
    return await resolveSource.call(this.#runner, agentId);
  }

  async streamAgentMessage(params: {
    readonly sessionId: string;
    readonly content: MessageContent;
    readonly messageId: string;
    readonly streamId: string;
    readonly acceptedAt: string;
    readonly ifBusy?: "reject";
    readonly displayUserMessage?: string | null;
    readonly editorInteraction?: SessionEditorInteraction;
    readonly methodName?: "message.send" | "message.stream";
  }): Promise<AgenCBackgroundAgentMessageResult> {
    const methodName = params.methodName ?? "message.stream";
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `${methodName} requires a daemon session manager`,
      );
    }
    if (this.#runner?.submitAgentMessage === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        `${methodName} requires a background runner`,
      );
    }

    const session = await this.#sessionManager.getSession(params.sessionId);
    if (session === null || !isActiveSession(session)) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon session not found or closed: ${params.sessionId}`,
      );
    }

    // NOTE (persisted terminal sessions): a `conv-*` session created by a
    // separate `agenc` terminal process leaves a thread in the store but no
    // live agent here, so the lookup below throws AGENT_NOT_FOUND. We do NOT
    // resume it into a daemon agent for message.send: the originating terminal
    // process holds an exclusive PID-flock on the rollout for its entire
    // lifetime (SessionStore.acquire → SessionLockedError; see
    // session/session-store.ts), so a second appender in this process would
    // either fail to acquire the lock or race/corrupt the shared rollout.
    // Resume only becomes safe once that terminal process has exited (its lock
    // is released and reclaimable as stale). Read-only history is still served
    // via getSessionTranscript's thread-store fallback. Keep the throw.
    const messageTarget = await this.#state.with(async (state) => {
      const agent = state.agents.get(session.agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(session.agentId);
      if (refreshed === undefined || !isActiveAgent(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          inactiveAgentMessage(session.agentId, refreshed),
        );
      }
      return {
        recoveredRuntimeUnavailable: isRecoveredRuntimeUnavailable(refreshed),
        route: snapshotRouteForAgent(refreshed),
      };
    });
    if (messageTarget.recoveredRuntimeUnavailable) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        `AgenC daemon agent recovered without a live runtime: ${session.agentId}`,
      );
    }

    let submission: AgenCBackgroundAgentMessageResult;
    try {
      submission = (await this.#runner.submitAgentMessage(session.agentId, {
        sessionId: params.sessionId,
        content: params.content,
        originalContent: params.content,
        ...(params.displayUserMessage !== undefined
          ? { displayUserMessage: params.displayUserMessage }
          : {}),
        ...(params.editorInteraction !== undefined
          ? { editorInteraction: params.editorInteraction }
          : {}),
        ...(params.ifBusy !== undefined ? { ifBusy: params.ifBusy } : {}),
        messageId: params.messageId,
        streamId: params.streamId,
        acceptedAt: params.acceptedAt,
      })) ?? {
        // Compatibility for injected pre-1.2 runners whose submit method
        // returned void. Production 1.2 runners return the richer result.
        disposition: "started",
        acceptedAt: params.acceptedAt,
      };
    } catch (error) {
      if (error instanceof AgenCBackgroundAgentMessageError) {
        throw new AgenCDaemonAgentLifecycleError(error.code, error.message);
      }
      throw error;
    }
    if (submission.disposition === "started") {
      await this.#recordMessageExchangeSnapshot({
        sessionId: params.sessionId,
        agentId: session.agentId,
        ...messageTarget.route,
        content: params.content as JsonValue,
        messageId: params.messageId,
        streamId: params.streamId,
        acceptedAt: params.acceptedAt,
      });
    }
    return submission;
  }

  async #refreshAgentsFromRunner(state: AgentLifecycleState): Promise<void> {
    for (const agent of [...state.agents.values()]) {
      await this.#refreshAgentFromRunner(state, agent);
    }
  }

  async #recordAgentStatusSnapshots(
    sessionIds: readonly string[],
    agentId: string,
    status: AgentStatus,
    transitionAt: string,
    reason?: string,
    route: AgenCDaemonSnapshotRoute = {},
    metadataPatch?: JsonObject,
    runStatus?: string,
  ): Promise<void> {
    if (this.#recordAgentStatusTransition === undefined) return;
    for (const sessionId of sessionIds) {
      try {
        await this.#recordAgentStatusTransition({
          sessionId,
          agentId,
          ...route,
          status,
          ...(runStatus !== undefined ? { runStatus } : {}),
          transitionAt,
          ...(reason !== undefined ? { reason } : {}),
          ...(metadataPatch !== undefined ? { metadataPatch } : {}),
        });
      } catch (error) {
        this.#onSnapshotError(error);
      }
    }
  }

  async #recordAgentRunSnapshot(
    agent: MutableAgent,
    options: { readonly required?: boolean } = {},
  ): Promise<void> {
    if (this.#recordAgentRun === undefined) return;
    try {
      const currentSessionId = latestSessionIdForAgentRun(agent);
      await this.#recordAgentRun({
        id: agent.agentId,
        objective: agent.objective,
        status: "running",
        startedAt: agent.startedAt,
        lastActiveAt: agent.lastActiveAt,
        ...(currentSessionId !== undefined ? { currentSessionId } : {}),
        metadata: agentRunMetadata(agent),
        ...snapshotRouteForAgent(agent),
      });
    } catch (error) {
      if (options.required === true) throw error;
      this.#onSnapshotError(error);
    }
  }

  async #recordMessageExchangeSnapshot(
    exchange: AgenCDaemonMessageExchangeSnapshot,
  ): Promise<void> {
    if (this.#recordMessageExchange === undefined) return;
    try {
      await this.#recordMessageExchange(exchange);
    } catch (error) {
      this.#onSnapshotError(error);
    }
  }

  async #registerSnapshotSessionRoute(
    sessionId: string,
    agent: MutableAgent,
  ): Promise<void> {
    if (this.#registerSnapshotSession === undefined) return;
    try {
      await this.#registerSnapshotSession({
        sessionId,
        agentId: agent.agentId,
        ...snapshotRouteForAgent(agent),
      });
    } catch (error) {
      this.#onSnapshotError(error);
    }
  }

  async #resolveActiveAgentIdForSession(
    sessionId: string,
    options: {
      readonly allowCancelTool?: boolean;
      readonly allowClearSession?: boolean;
      readonly allowElicitationResponse?: boolean;
      readonly allowListPermissions?: boolean;
      readonly allowPartialCompact?: boolean;
      readonly allowCompactionOperator?: boolean;
      readonly allowConversationRewind?: boolean;
      readonly allowMcpStatus?: boolean;
      readonly allowMcpAddServer?: boolean;
      readonly allowMcpReconnectServer?: boolean;
      readonly allowMcpEnableServer?: boolean;
      readonly allowMcpDisableServer?: boolean;
      readonly allowSnapshot?: boolean;
      readonly allowSetModel?: boolean;
      readonly allowSetPermissionMode?: boolean;
      readonly allowMutatePermissionRule?: boolean;
      readonly allowHooksStatus?: boolean;
      readonly allowSetHooksDisabled?: boolean;
      readonly allowApplyConfig?: boolean;
      readonly allowCodePrediction?: boolean;
      readonly allowExecuteShell?: boolean;
    } = {},
  ): Promise<string> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "tool decision requires a daemon session manager",
      );
    }
    const hasToolDecisionRunner =
      this.#runner?.resolveToolDecision !== undefined;
    const hasCancelRunner =
      options.allowCancelTool === true &&
      this.#runner?.cancelTool !== undefined;
    const hasElicitationRunner =
      options.allowElicitationResponse === true &&
      this.#runner?.respondToElicitation !== undefined;
    const hasClearSessionRunner =
      options.allowClearSession === true &&
      this.#runner?.clearAgentSession !== undefined;
    const hasPermissionListRunner =
      options.allowListPermissions === true &&
      this.#runner?.listPermissions !== undefined;
    const hasPartialCompactRunner =
      options.allowPartialCompact === true &&
      this.#runner?.partialCompactFromMessage !== undefined;
    const hasCompactionOperatorRunner =
      options.allowCompactionOperator === true &&
      this.#runner?.rollbackCompaction !== undefined &&
      this.#runner.extendCompactionRollbackRetention !== undefined;
    const hasConversationRewindRunner =
      options.allowConversationRewind === true &&
      this.#runner?.rewindConversationToMessage !== undefined;
    const hasMcpStatusRunner =
      options.allowMcpStatus === true &&
      this.#runner?.getMcpStatus !== undefined;
    const hasMcpAddServerRunner =
      options.allowMcpAddServer === true &&
      this.#runner?.addMcpServer !== undefined;
    const hasMcpReconnectServerRunner =
      options.allowMcpReconnectServer === true &&
      this.#runner?.reconnectMcpServer !== undefined;
    const hasMcpEnableServerRunner =
      options.allowMcpEnableServer === true &&
      this.#runner?.enableMcpServer !== undefined;
    const hasMcpDisableServerRunner =
      options.allowMcpDisableServer === true &&
      this.#runner?.disableMcpServer !== undefined;
    const hasSnapshotRunner =
      options.allowSnapshot === true &&
      this.#runner?.snapshotAgentSession !== undefined;
    const hasSetModelRunner =
      options.allowSetModel === true &&
      this.#runner?.setAgentModel !== undefined;
    const hasSetPermissionModeRunner =
      options.allowSetPermissionMode === true &&
      this.#runner?.setAgentPermissionMode !== undefined;
    const hasMutatePermissionRuleRunner =
      options.allowMutatePermissionRule === true &&
      this.#runner?.mutateAgentPermissionRule !== undefined;
    const hasHooksStatusRunner =
      options.allowHooksStatus === true &&
      this.#runner?.getAgentHooksStatus !== undefined;
    const hasSetHooksDisabledRunner =
      options.allowSetHooksDisabled === true &&
      this.#runner?.setAgentHooksDisabled !== undefined;
    const hasApplyConfigRunner =
      options.allowApplyConfig === true &&
      this.#runner?.applyAgentConfig !== undefined;
    const hasCodePredictionRunner =
      options.allowCodePrediction === true &&
      this.#runner?.resolveCodePredictionSource !== undefined;
    const hasExecuteShellRunner =
      options.allowExecuteShell === true &&
      this.#runner?.executeAgentShell !== undefined;
    if (
      !hasToolDecisionRunner &&
      !hasCancelRunner &&
      !hasElicitationRunner &&
      !hasClearSessionRunner &&
      !hasPermissionListRunner &&
      !hasPartialCompactRunner &&
      !hasCompactionOperatorRunner &&
      !hasConversationRewindRunner &&
      !hasMcpStatusRunner &&
      !hasMcpAddServerRunner &&
      !hasMcpReconnectServerRunner &&
      !hasMcpEnableServerRunner &&
      !hasMcpDisableServerRunner &&
      !hasSnapshotRunner &&
      !hasSetModelRunner &&
      !hasSetPermissionModeRunner &&
      !hasMutatePermissionRuleRunner &&
      !hasHooksStatusRunner &&
      !hasSetHooksDisabledRunner &&
      !hasApplyConfigRunner &&
      !hasCodePredictionRunner &&
      !hasExecuteShellRunner
    ) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session request requires a background runner",
      );
    }

    const session = await this.#sessionManager.getSession(sessionId);
    if (session === null || !isActiveSession(session)) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon session not found or closed: ${sessionId}`,
      );
    }
    await this.#state.with(async (state) => {
      const agent = state.agents.get(session.agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(session.agentId);
      if (refreshed === undefined || !isActiveAgent(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          inactiveAgentMessage(session.agentId, refreshed),
        );
      }
      if (isRecoveredRuntimeUnavailable(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "BACKGROUND_RUNNER_UNAVAILABLE",
          `AgenC daemon agent recovered without a live runtime: ${session.agentId}`,
        );
      }
    });
    return session.agentId;
  }

  async #recordToolDecisionAudit(params: {
    readonly decision: "approved" | "denied";
    readonly sessionId: string;
    readonly agentId: string;
    readonly requestId: string;
    readonly reasonCode: string;
    readonly scope?: string;
  }): Promise<void> {
    await recordPermissionAuditEvent(
      this.#permissionAuditLogger,
      {
        eventKind: "user_decision",
        decision: params.decision,
        source: "daemon-rpc",
        subjectType: "tool_request",
        sessionId: params.sessionId,
        agentId: params.agentId,
        requestId: params.requestId,
        reasonCode: params.reasonCode,
        ...(params.scope !== undefined ? { scope: params.scope } : {}),
      },
      this.#onPermissionAuditError,
    );
  }

  async #resolvePermissionListAgentId(
    params: PermissionListParams,
  ): Promise<string> {
    const agentId = normalizeNonEmpty(params.agentId);
    const sessionId = normalizeNonEmpty(params.sessionId);
    if (agentId !== undefined && sessionId !== undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "permission.list accepts agentId or sessionId, not both",
      );
    }
    if (sessionId !== undefined) {
      return this.#resolveActiveAgentIdForSession(sessionId, {
        allowListPermissions: true,
      });
    }
    if (agentId === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "permission.list requires agentId or sessionId",
      );
    }
    await this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
        await this.#reconcileAgentSessions(agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed === undefined || !isActiveAgent(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          `AgenC daemon agent not found: ${agentId}`,
        );
      }
      if (isRecoveredRuntimeUnavailable(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "BACKGROUND_RUNNER_UNAVAILABLE",
          `AgenC daemon agent recovered without a live runtime: ${agentId}`,
        );
      }
    });
    return agentId;
  }

  async #refreshAgentFromRunner(
    _state: AgentLifecycleState,
    agent: MutableAgent,
  ): Promise<void> {
    if (!isActiveAgent(agent)) return;
    const snapshot = await this.#runner?.getAgentSnapshot?.(agent.agentId);
    if (snapshot === undefined) return;
    if (snapshot === null) {
      // The runner returned null — agent isn't in its #active map. This
      // SHOULD only happen after an explicit stop or daemon-shutdown
      // cleanup, not on a transient race after a turn completes. The
      // earlier eviction here was the second symptom of the
      // GAP-DMN-AGENT-NOT-FOUND class: the runner's getAgentSnapshot
      // would briefly return null for completed-status agents (now
      // fixed in background-agent-runner), and the lifecycle would
      // evict before the snapshot stabilized, dooming the next user
      // turn's message.stream. Defense in depth: only delete if the
      // runner has explicitly removed the agent from its registry AND
      // we have an authoritative terminal-state signal (via
      // recordAgentStatusSnapshots / stopAgent). Without that signal,
      // a null snapshot is a no-op refresh — leave state.agents alone.
      if (agent.recovered === true) return;
      // Mark the runner as unavailable but keep the agent record so
      // the next message.stream finds it. The next refresh that
      // returns a real snapshot (or an explicit stop event) will
      // reconcile.
      agent.runtimeAvailable = false;
      agent.runtimeUnavailableSince ??= this.#now();
      return;
    }
    const previousStatus = agent.status;
    const sessionIds = [...agent.sessionIds];
    agent.recovered = false;
    agent.runtimeAvailable = true;
    agent.runtimeUnavailableSince = undefined;
    applyAgentSnapshot(agent, snapshot);
    if (agent.status !== previousStatus) {
      await this.#recordAgentStatusSnapshots(
        sessionIds,
        agent.agentId,
        agent.status,
        agent.lastActiveAt,
        undefined,
        snapshotRouteForAgent(agent),
        snapshot.metadata,
      );
    }
  }

  async #reconcileSessionBackedAgents(
    state: AgentLifecycleState,
  ): Promise<void> {
    if (this.#sessionManager === undefined) return;
    for (const agent of state.agents.values()) {
      await this.#reconcileAgentSessions(agent);
    }
  }

  async #reconcileAgentSessions(agent: MutableAgent): Promise<void> {
    if (this.#sessionManager === undefined || agent.sessionIds.length === 0) {
      return;
    }
    const activeSessionIds: string[] = [];
    const inactiveSessionIds: string[] = [];
    for (const sessionId of agent.sessionIds) {
      const session = await this.#sessionManager.getSession(sessionId);
      if (session !== null && isActiveSession(session)) {
        activeSessionIds.push(sessionId);
      } else {
        inactiveSessionIds.push(sessionId);
      }
    }
    if (inactiveSessionIds.length === 0) return;
    agent.logSessionIds = uniqueNonEmptyStrings([
      ...agent.logSessionIds,
      ...inactiveSessionIds,
    ]);
    agent.sessionIds = activeSessionIds;
    if (activeSessionIds.length === 0 && isActiveAgent(agent)) {
      const stoppable = !isRecoveredRuntimeUnavailable(agent);
      agent.status = "stopped";
      agent.lastActiveAt = this.#now();
      agent.runtimeAvailable = false;
      // The runner stop must NOT be awaited here: every reconcile caller
      // holds the #state lock, and stopAgent's termination path re-acquires
      // it (handleRunnerTerminated), so an in-lock await self-deadlocks the
      // whole daemon the moment a zombie agent exists. The state mutation
      // above is the observable outcome; the runtime teardown runs after
      // the lock is released, matching the public stopAgent path.
      if (stoppable) this.#scheduleReconcileRunnerStop(agent.agentId);
    }
  }

  /** Deduplicates deferred session_terminated runner stops per agent. */
  readonly #pendingReconcileRunnerStops = new Set<string>();

  #scheduleReconcileRunnerStop(agentId: string): void {
    const stopRunner = this.#runner?.stopAgent?.bind(this.#runner);
    if (stopRunner === undefined) return;
    if (this.#pendingReconcileRunnerStops.has(agentId)) return;
    this.#pendingReconcileRunnerStops.add(agentId);
    void stopRunner(agentId, "session_terminated")
      .catch(async () => {
        // The synchronous reconcile already published "stopped"; a failed
        // runtime teardown downgrades it so operators can see the wreck.
        await this.#state
          .with((state) => {
            const current = state.agents.get(agentId);
            if (
              current !== undefined &&
              current.status === "stopped" &&
              current.runtimeAvailable === false
            ) {
              current.status = "error";
            }
          })
          .catch(() => {});
      })
      .finally(() => {
        this.#pendingReconcileRunnerStops.delete(agentId);
      });
  }

  async #resolveAttachmentTarget(
    agentId: string,
  ): Promise<AgentAttachmentTarget> {
    return this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
        await this.#reconcileAgentSessions(agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed === undefined || !isActiveAgent(refreshed)) {
        const persisted = this.#listPersistedAgents(state).find(
          (candidate) => candidate.agentId === agentId,
        );
        if (persisted !== undefined) {
          return {
            agentId: persisted.agentId,
            sessionIds: [...persisted.sessionIds],
          };
        }
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          `AgenC daemon agent not found: ${agentId}`,
        );
      }
      return {
        agentId: refreshed.agentId,
        sessionIds: [...refreshed.sessionIds],
      };
    });
  }

  async #terminateAgentSessions(
    sessionIds: readonly string[],
    reason: string,
  ): Promise<void> {
    if (this.#sessionManager === undefined) return;
    for (const sessionId of sessionIds) {
      await this.#sessionManager.terminateSession({ sessionId, reason });
    }
  }

  async #markAgentStopFailed(
    agentId: string,
    failedAt: string | undefined,
  ): Promise<void> {
    await this.#state.with((state) => {
      const agent = state.agents.get(agentId);
      if (agent === undefined || agent.status !== "stopping") return;
      agent.status = "error";
      agent.lastActiveAt = failedAt ?? this.#now();
    });
  }
}

function normalizeObjective(params: AgentCreateParams): string {
  const objective = normalizeNonEmpty(params.objective ?? params.instructions);
  if (objective === undefined) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      "agent.start requires a non-empty objective",
    );
  }
  return objective;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function metadataString(
  metadata: JsonObject | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function metadataStringList(
  metadata: JsonObject | undefined,
  key: string,
): readonly string[] | undefined {
  const value = metadata?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function metadataUserPermissionMode(
  metadata: JsonObject | undefined,
): AgentCreateParams["permissionMode"] {
  const value = metadata?.permissionMode;
  return value === "default" ||
    value === "plan" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "dontAsk" ||
    value === "auto"
    ? value
    : undefined;
}

interface ResumeFileIdentity {
  readonly dev: string;
  readonly ino: string;
}

interface ResumeSourceProof {
  readonly cwdIdentity: ResumeFileIdentity;
  readonly cwdFd: number;
  readonly closeCwd: () => void;
  readonly rolloutLease: ResumeRolloutDescriptorLease;
  readonly rolloutPath: string;
  readonly rolloutDev: string;
  readonly rolloutIno: string;
  readonly createdAt: string;
  readonly objective: string;
  readonly agentPath: "/root";
  readonly activeEpoch: number;
  readonly lifecycleState: "open" | "suspended" | "terminal";
  readonly startupActivationPending: boolean;
  readonly terminalStatus?:
    "completed" | "failed" | "cancelled" | "unknown_outcome";
  readonly model?: string;
  readonly provider?: string;
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
  readonly runtimeSettingsEventId?: string;
  readonly legacyPermissionMode?: "plan";
}

function interactivePermissionModeFromRuntimeSettings(
  settings: RunRuntimeSettingsSnapshot,
  cwd: string,
  sessionId: string,
): NonNullable<AgentCreateParams["permissionMode"]> {
  const mode = settings.permissionMode;
  if (mode === "unattended") {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      `canonical session ${sessionId} is unattended and cannot be resumed as an interactive root`,
    );
  }
  const bypassTransitionCritical =
    mode === "bypassPermissions" ||
    (mode === "plan" && settings.prePlanMode === "bypassPermissions");
  if (
    (settings.autoModeActive && !settings.autoModeAvailable) ||
    (settings.bypassPermissionsConsentWorkspace !== null &&
      (settings.bypassPermissionsConsentWorkspace !== cwd ||
        !settings.bypassPermissionsModeAvailable)) ||
    (bypassTransitionCritical &&
      (settings.bypassPermissionsWorkspace !== cwd ||
        !settings.bypassPermissionsModeAvailable ||
        settings.bypassPermissionsConsentWorkspace !== cwd)) ||
    (!bypassTransitionCritical && settings.bypassPermissionsWorkspace !== null)
  ) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      `canonical session ${sessionId} has invalid bypass permission authority`,
    );
  }
  return mode;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  return String(error);
}

export function assertCanonicalRuntimeSettingsProjection(
  cwd: string,
  runId: string,
  proof: ResumeSourceProof,
  agencHome: string,
): void {
  let driver: ReturnType<typeof openStateDatabases>;
  try {
    // The daemon's home is passed explicitly. Resolving it through the
    // ambient current-session accessor refused with "Ambiguous runtime
    // session" as soon as more than one session lived in the daemon, so no
    // session could be resumed after a restart while others were open.
    driver = openStateDatabases({ cwd, agencHome });
  } catch (error) {
    // Say why. A live resume failed for an hour with this sentence and
    // nothing else; the cause (a locked database, a schema mismatch, a bad
    // cwd) is what the operator needs to see.
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      `canonical session ${runId} runtime settings projection is unavailable: ${describeError(error)}`,
    );
  }
  let projected: ReturnType<
    StateRunDurabilityRepository["getCurrentRuntimeSettings"]
  >;
  let primaryError: unknown;
  try {
    projected = new StateRunDurabilityRepository(
      driver,
    ).getCurrentRuntimeSettings(runId);
  } catch (error) {
    primaryError = error;
    projected = undefined;
  }
  try {
    driver.close();
  } catch (error) {
    primaryError ??= error;
  }
  if (primaryError !== undefined) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      `canonical session ${runId} runtime settings projection could not be verified: ${describeError(primaryError)}`,
    );
  }
  if (projected === undefined) {
    // SQLite is rebuildable. A missing row may lag canonical journal evidence;
    // RolloutStore's ordered replay will reconstruct it under the writer lease.
    return;
  }
  if (
    proof.runtimeSettings === undefined ||
    proof.runtimeSettingsEventId === undefined ||
    projected.eventId !== proof.runtimeSettingsEventId ||
    !runtimeSettingsSnapshotsEqual(projected, proof.runtimeSettings)
  ) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      `canonical session ${runId} runtime settings projection is ahead of or disagrees with the rollout`,
    );
  }
}

function runtimeSettingsSnapshotsEqual(
  left: RunRuntimeSettingsSnapshot,
  right: RunRuntimeSettingsSnapshot,
): boolean {
  return (
    left.permissionMode === right.permissionMode &&
    left.prePlanMode === right.prePlanMode &&
    left.autoModeActive === right.autoModeActive &&
    left.autoModeAvailable === right.autoModeAvailable &&
    left.bypassPermissionsModeAvailable ===
      right.bypassPermissionsModeAvailable &&
    left.bypassPermissionsWorkspace === right.bypassPermissionsWorkspace &&
    left.bypassPermissionsConsentWorkspace ===
      right.bypassPermissionsConsentWorkspace &&
    left.model === right.model &&
    left.provider === right.provider &&
    left.profile === right.profile &&
    left.reasoningEffort === right.reasoningEffort &&
    left.modelVerbosity === right.modelVerbosity &&
    left.serviceTier === right.serviceTier &&
    left.hooksDisabled === right.hooksDisabled
  );
}

const MAX_RESUME_ROLLOUT_FILES_PER_SESSION = 256;
const MAX_RESUME_DIRECTORY_ENTRIES = 4_096;
const MAX_RESUME_SOURCE_DISCOVERY_MS = DEFAULT_MAX_STARTUP_RECOVERY_MS;
const MAX_RESUME_CANONICAL_SCAN_BYTES =
  MAX_RECOVERY_CANONICAL_LINE_BYTES + 64 * 1024;
const MAX_RESUME_CANONICAL_LINE_BYTES = MAX_RECOVERY_CANONICAL_LINE_BYTES;
const MAX_RESUME_CANONICAL_LINES = 2_048;
const MAX_RESUME_CANONICAL_VALIDATION_MS = DEFAULT_MAX_STARTUP_RECOVERY_MS;

/**
 * The retained agent record stamps `createdAt` with the daemon clock at
 * `agent.create` time, while the rollout header timestamp is stamped
 * separately by the session writer, so the two legitimately disagree by
 * milliseconds (a session's own rollout filename and header already differ).
 * Strict equality made every retained root session unresumable while its
 * retained record existed (#1750). A genuinely mismatched rollout swapped in
 * from another session still trips the objective/model/provider identity
 * checks and this bounded window.
 */
const RETAINED_CREATED_AT_TOLERANCE_MS = 5_000;

export function retainedCreatedAtMatchesRollout(
  retainedCreatedAt: string,
  rolloutCreatedAt: string,
): boolean {
  if (retainedCreatedAt === rolloutCreatedAt) return true;
  const retained = Date.parse(retainedCreatedAt);
  const rollout = Date.parse(rolloutCreatedAt);
  if (!Number.isFinite(retained) || !Number.isFinite(rollout)) return false;
  return Math.abs(retained - rollout) <= RETAINED_CREATED_AT_TOLERANCE_MS;
}

function assertAuthoritativeResumeSource(params: {
  readonly agencHome: string;
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly cwd: string;
  readonly sourceProof: NonNullable<AgentCreateParams["resumeSourceProof"]>;
  readonly allowLegacyRetainedRoot: boolean;
}): ResumeSourceProof {
  const fail = (message: string): never => {
    throw new AgenCDaemonAgentLifecycleError("INVALID_ARGUMENT", message);
  };
  if (
    !isAbsolute(params.rolloutPath) ||
    resolve(params.rolloutPath) !== params.rolloutPath
  ) {
    fail("agent.create resume rollout path must be absolute and normalized");
  }
  const projectsRoot = (() => {
    try {
      return realpathSync(resolve(params.agencHome, "projects"));
    } catch {
      return fail("agent.create daemon projects directory is unavailable");
    }
  })();
  const contained = relative(projectsRoot, params.rolloutPath);
  if (
    contained.length === 0 ||
    contained === ".." ||
    contained.startsWith("../") ||
    contained.startsWith("..\\") ||
    isAbsolute(contained)
  ) {
    fail(
      "agent.create resume rollout must be under daemon AGENC_HOME/projects",
    );
  }
  const sessionDir = dirname(params.rolloutPath);
  const projectDir = dirname(dirname(sessionDir));
  if (
    basename(sessionDir) !== params.sessionId ||
    basename(dirname(sessionDir)) !== "sessions" ||
    dirname(projectDir) !== projectsRoot ||
    basename(projectDir).length === 0 ||
    !basename(params.rolloutPath).startsWith("rollout-") ||
    !basename(params.rolloutPath).endsWith(`-${params.sessionId}.jsonl`)
  ) {
    fail("agent.create resume rollout is not bound to its session id");
  }
  const discoveryDeadline = Date.now() + MAX_RESUME_SOURCE_DISCOVERY_MS;
  const candidates = (() => {
    let directory;
    try {
      directory = opendirSync(sessionDir);
    } catch {
      return fail("agent.create resume session directory is unavailable");
    }
    const discovered: Array<{
      readonly path: string;
      readonly mtimeNs: bigint;
    }> = [];
    let entryCount = 0;
    let discoveryError: unknown;
    try {
      for (;;) {
        if (Date.now() >= discoveryDeadline) {
          return fail(
            "agent.create resume source discovery exceeded its time budget",
          );
        }
        const entry = directory.readSync();
        if (entry === null) break;
        entryCount += 1;
        if (entryCount > MAX_RESUME_DIRECTORY_ENTRIES) {
          return fail(
            "agent.create resume source discovery exceeded its entry budget",
          );
        }
        if (
          entry.isFile() &&
          entry.name.startsWith("rollout-") &&
          entry.name.endsWith(".jsonl")
        ) {
          if (discovered.length >= MAX_RESUME_ROLLOUT_FILES_PER_SESSION) {
            return fail(
              "agent.create resume source discovery exceeded its file budget",
            );
          }
          const candidatePath = join(sessionDir, entry.name);
          let stats;
          try {
            stats = lstatSync(candidatePath, { bigint: true });
          } catch {
            return fail("agent.create resume source changed during discovery");
          }
          if (
            stats.isFile() &&
            !stats.isSymbolicLink() &&
            stats.nlink === 1n &&
            !hasSupportedFileIdentity(stats)
          ) {
            return fail(
              "agent.create resume source filesystem identity is unsupported",
            );
          }
          if (stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n) {
            discovered.push({ path: candidatePath, mtimeNs: stats.mtimeNs });
          }
        }
      }
    } catch (error) {
      discoveryError = error;
    }
    let closeError: unknown;
    try {
      resumeSourceTestHooks.beforeSessionDirectoryClose?.(sessionDir, () =>
        directory.closeSync(),
      );
    } catch (error) {
      closeError = error;
    }
    try {
      directory.closeSync();
    } catch (error) {
      closeError ??= error;
    }
    if (discoveryError !== undefined) {
      throw discoveryError;
    }
    if (closeError !== undefined) {
      return fail(
        "agent.create resume session directory could not be closed safely",
      );
    }
    return discovered;
  })();
  const normalCandidates = candidates.filter(
    (candidate) => !basename(candidate.path).startsWith("rollout-recovery-"),
  );
  const eligibleCandidates =
    normalCandidates.length > 0 ? normalCandidates : candidates;
  const authoritative = eligibleCandidates.sort((left, right) =>
    left.mtimeNs === right.mtimeNs
      ? right.path.localeCompare(left.path)
      : left.mtimeNs > right.mtimeNs
        ? -1
        : 1,
  )[0]?.path;
  if (authoritative !== params.rolloutPath) {
    fail("agent.create resume rollout is not the authoritative session source");
  }
  const sourcePathStats = (() => {
    try {
      const stats = lstatSync(params.rolloutPath, { bigint: true });
      if (!hasSupportedFileIdentity(stats)) {
        fail("agent.create resume source filesystem identity is unsupported");
      }
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1n ||
        realpathSync(params.rolloutPath) !== params.rolloutPath
      ) {
        fail("agent.create resume rollout must be a regular non-symlink file");
      }
      return stats;
    } catch (error) {
      if (error instanceof AgenCDaemonAgentLifecycleError) throw error;
      return fail("agent.create resume rollout is unavailable");
    }
  })();
  const noFollow =
    "O_NOFOLLOW" in fsConstants ? (fsConstants.O_NOFOLLOW as number) : 0;
  const sourceFd = (() => {
    try {
      return openSync(
        params.rolloutPath,
        fsConstants.O_RDWR | fsConstants.O_APPEND | noFollow,
      );
    } catch {
      return fail("agent.create resume rollout could not be opened safely");
    }
  })();
  let cwdProof: ReturnType<typeof proveCanonicalResumeCwd> | undefined;
  try {
    const opened = fstatSync(sourceFd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !hasSupportedFileIdentity(opened) ||
      opened.dev !== sourcePathStats.dev ||
      opened.ino !== sourcePathStats.ino ||
      opened.size !== sourcePathStats.size
    ) {
      fail("agent.create resume rollout changed while being opened");
    }
    const canonical = readCanonicalResumeSource(
      sourceFd,
      params.sessionId,
      fail,
    );
    const reopened = fstatSync(sourceFd, { bigint: true });
    const observed = lstatSync(params.rolloutPath, { bigint: true });
    if (
      reopened.dev !== opened.dev ||
      reopened.ino !== opened.ino ||
      reopened.size !== opened.size ||
      observed.dev !== opened.dev ||
      observed.ino !== opened.ino ||
      observed.size !== opened.size ||
      observed.nlink !== 1n ||
      !observed.isFile() ||
      observed.isSymbolicLink()
    ) {
      fail("agent.create resume rollout changed during validation");
    }
    if (
      sourcePathStats.dev.toString(10) !== params.sourceProof.dev ||
      sourcePathStats.ino.toString(10) !== params.sourceProof.ino ||
      sourcePathStats.size.toString(10) !== params.sourceProof.size ||
      canonical.sourceSha256 !== params.sourceProof.sha256
    ) {
      fail(
        "agent.create resume rollout no longer matches the trusted source proof",
      );
    }
    const meta = canonical.meta;
    if (canonical.cancellationRequestEventId !== undefined) {
      fail(
        "agent.create resume canonical run has a pending cancellation request",
      );
    }
    const metadataCwd = resolveCanonicalSessionCwd(meta.cwd);
    if (metadataCwd.kind === "identity_unsupported") {
      fail("agent.create resume cwd filesystem identity is unsupported");
    }
    if (
      meta.sessionId !== params.sessionId ||
      metadataCwd.kind !== "ok" ||
      metadataCwd.cwd !== params.cwd ||
      metadataCwd.dev.toString(10) !== params.sourceProof.cwdDev ||
      metadataCwd.ino.toString(10) !== params.sourceProof.cwdIno
    ) {
      fail(
        "agent.create resume rollout metadata does not match session id and cwd",
      );
    }
    const explicitlyTopLevel =
      meta.originator === "agenc-cli" && meta.source === "interactive-root";
    const retainedLegacyTopLevel =
      meta.originator === "agenc-cli" &&
      meta.source === undefined &&
      params.allowLegacyRetainedRoot;
    if (!explicitlyTopLevel && !retainedLegacyTopLevel) {
      fail(
        "agent.create resume rollout is not a top-level interactive session",
      );
    }
    cwdProof = proveCanonicalResumeCwd(params.cwd, fail);
    if (
      cwdProof.identity.dev !== params.sourceProof.cwdDev ||
      cwdProof.identity.ino !== params.sourceProof.cwdIno
    ) {
      fail(
        "agent.create resume cwd no longer matches the trusted source proof",
      );
    }
    const rolloutLease = createResumeRolloutDescriptorLease(
      params.rolloutPath,
      sourceFd,
    );
    return {
      cwdIdentity: cwdProof.identity,
      cwdFd: cwdProof.fd,
      closeCwd: cwdProof.close,
      rolloutLease,
      rolloutPath: params.rolloutPath,
      rolloutDev: params.sourceProof.dev,
      rolloutIno: params.sourceProof.ino,
      createdAt: meta.timestamp,
      objective: canonical.objective,
      agentPath: "/root",
      activeEpoch: canonical.activeEpoch,
      lifecycleState: canonical.lifecycleState,
      startupActivationPending:
        canonical.startupActivationResumeEventId !== undefined,
      ...(canonical.terminalStatus !== undefined
        ? { terminalStatus: canonical.terminalStatus }
        : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.modelProvider !== undefined
        ? { provider: meta.modelProvider }
        : {}),
      ...(canonical.runtimeSettings !== undefined
        ? {
            runtimeSettings: canonical.runtimeSettings,
            runtimeSettingsEventId: canonical.runtimeSettingsEventId!,
          }
        : {}),
      ...(canonical.legacyPermissionMode !== undefined
        ? { legacyPermissionMode: canonical.legacyPermissionMode }
        : {}),
    };
  } catch (error) {
    // Cleanup is unconditional, but a cleanup report must never replace the
    // authoritative validation failure that caused this path.
    try {
      cwdProof?.close();
    } catch {
      /* preserve primary validation error */
    }
    try {
      closeSync(sourceFd);
    } catch {
      /* preserve primary validation error */
    }
    throw error;
  }
}

interface CanonicalResumeSource {
  readonly meta: SessionMetaLine;
  readonly objective: string;
  readonly activeEpoch: number;
  readonly lifecycleState: "open" | "suspended" | "terminal";
  readonly sourceSha256: string;
  readonly cancellationRequestEventId?: string;
  readonly startupActivationResumeEventId?: string;
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
  readonly runtimeSettingsEventId?: string;
  readonly legacyPermissionMode?: "plan";
  readonly terminalStatus?:
    "completed" | "failed" | "cancelled" | "unknown_outcome";
}

function readCanonicalResumeSource(
  fd: number,
  expectedSessionId: string,
  fail: (message: string) => never,
): CanonicalResumeSource {
  const chunk = Buffer.allocUnsafe(16 * 1024);
  let pending = Buffer.alloc(0);
  let position = 0;
  let objectiveScanBytes = 0;
  let lineCount = 0;
  let meta: SessionMetaLine | undefined;
  let objective: string | undefined;
  const validationDeadline = Date.now() + MAX_RESUME_CANONICAL_VALIDATION_MS;
  const validator = new StrictCanonicalJournalValidator({
    expectedRunId: expectedSessionId,
    retainRecords: false,
    maxLineBytes: MAX_RECOVERY_CANONICAL_LINE_BYTES,
    maxSourceBytes: MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
    maxEvents: MAX_RECOVERY_CANONICAL_EVENTS,
    checkOperationalBudget: () => {
      if (Date.now() >= validationDeadline) {
        fail(
          "agent.create resume canonical validation exceeded its time budget",
        );
      }
    },
  });
  const inspectLine = (lineBytes: Buffer): string | undefined => {
    lineCount += 1;
    if (lineCount > MAX_RESUME_CANONICAL_LINES) {
      return fail(
        "agent.create resume canonical scan exceeded its line budget",
      );
    }
    if (lineBytes.byteLength > MAX_RESUME_CANONICAL_LINE_BYTES) {
      return fail("agent.create resume canonical row exceeded its byte budget");
    }
    const line = lineBytes.toString("utf8").trim();
    if (line.length === 0) return undefined;
    let item: RolloutItem | null;
    try {
      item = parseRolloutLine(line);
    } catch {
      return fail(
        "agent.create resume canonical source contains malformed JSON",
      );
    }
    if (item === null) return undefined;
    if (meta === undefined) {
      if (item.type !== "session_meta") {
        return fail(
          "agent.create resume canonical source has no initial metadata",
        );
      }
      if (
        !isValidResumeMeta(item.payload) ||
        item.payload.rolloutSchemaVersion > ROLLOUT_SCHEMA_VERSION
      ) {
        return fail("agent.create resume canonical metadata is unsupported");
      }
      meta = item.payload;
      return undefined;
    }
    return canonicalObjectiveFromItem(item);
  };
  for (;;) {
    if (Date.now() >= validationDeadline) {
      return fail(
        "agent.create resume canonical validation exceeded its time budget",
      );
    }
    const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) {
      if (objective === undefined && pending.byteLength > 0) {
        objective = inspectLine(pending);
      }
      if (objective === undefined || meta === undefined) {
        return fail(
          "agent.create resume rollout has no bounded canonical user objective",
        );
      }
      let journal;
      try {
        journal = validator.finish();
      } catch {
        return fail(
          "agent.create resume rollout failed strict canonical validation",
        );
      }
      return {
        meta,
        objective,
        activeEpoch: journal.activeEpoch,
        lifecycleState: journal.activeLifecycleState,
        sourceSha256: journal.sourceSha256,
        ...(journal.activeCancellationRequestEventId !== undefined
          ? {
              cancellationRequestEventId:
                journal.activeCancellationRequestEventId,
            }
          : {}),
        ...(journal.activeTerminalStatus !== undefined
          ? { terminalStatus: journal.activeTerminalStatus }
          : {}),
        ...(journal.activeStartupActivationResumeEventId !== undefined
          ? {
              startupActivationResumeEventId:
                journal.activeStartupActivationResumeEventId,
            }
          : {}),
        ...(journal.activeRuntimeSettings !== undefined
          ? {
              runtimeSettings: journal.activeRuntimeSettings,
              runtimeSettingsEventId: journal.activeRuntimeSettingsEventId!,
            }
          : {}),
        ...(journal.legacyPermissionMode !== undefined
          ? { legacyPermissionMode: journal.legacyPermissionMode }
          : {}),
      };
    }
    position += bytesRead;
    try {
      validator.push(chunk.subarray(0, bytesRead));
    } catch {
      return fail(
        "agent.create resume rollout failed strict canonical validation",
      );
    }
    if (objective !== undefined) continue;
    objectiveScanBytes += bytesRead;
    if (objectiveScanBytes > MAX_RESUME_CANONICAL_SCAN_BYTES) {
      return fail(
        "agent.create resume canonical objective exceeded its scan budget",
      );
    }
    pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (pending.byteLength > MAX_RESUME_CANONICAL_LINE_BYTES) {
          return fail(
            "agent.create resume canonical row exceeded its byte budget",
          );
        }
        break;
      }
      const candidate = inspectLine(pending.subarray(0, newline));
      pending = pending.subarray(newline + 1);
      if (candidate !== undefined && meta !== undefined) {
        objective = candidate;
        pending = Buffer.alloc(0);
        break;
      }
    }
  }
}

function isValidResumeMeta(value: SessionMetaLine): boolean {
  return (
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.timestamp === "string" &&
    Number.isFinite(Date.parse(value.timestamp)) &&
    typeof value.cwd === "string" &&
    isAbsolute(value.cwd) &&
    typeof value.originator === "string" &&
    typeof value.agencVersion === "string" &&
    Number.isSafeInteger(value.rolloutSchemaVersion) &&
    value.rolloutSchemaVersion >= 0
  );
}

function canonicalObjectiveFromItem(item: RolloutItem): string | undefined {
  if (item.type === "response_item" && item.payload.role === "user") {
    return canonicalUserText(item.payload.content);
  }
  if (item.type === "event_msg" && item.payload.msg.type === "user_message") {
    return canonicalUserText(item.payload.msg.payload.message);
  }
  return undefined;
}

function canonicalUserText(
  content: string | readonly unknown[],
): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((part) =>
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          )
          .join("\n");
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function proveCanonicalResumeCwd(
  cwd: string,
  fail: (message: string) => never,
): {
  readonly identity: ResumeFileIdentity;
  readonly fd: number;
  readonly close: () => void;
} {
  const before = (() => {
    try {
      const stats = lstatSync(cwd, { bigint: true });
      if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        !hasSupportedFileIdentity(stats) ||
        realpathSync(cwd) !== cwd
      ) {
        fail(
          "agent.create resume cwd must be a canonical non-symlink directory",
        );
      }
      return stats;
    } catch (error) {
      if (error instanceof AgenCDaemonAgentLifecycleError) throw error;
      return fail("agent.create resume cwd is unavailable");
    }
  })();
  const noFollow =
    "O_NOFOLLOW" in fsConstants ? (fsConstants.O_NOFOLLOW as number) : 0;
  const directoryOnly =
    "O_DIRECTORY" in fsConstants ? (fsConstants.O_DIRECTORY as number) : 0;
  let fd: number;
  try {
    fd = openSync(cwd, fsConstants.O_RDONLY | noFollow | directoryOnly);
  } catch {
    return fail("agent.create resume cwd could not be opened safely");
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const after = lstatSync(cwd, { bigint: true });
    if (
      !opened.isDirectory() ||
      !hasSupportedFileIdentity(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !after.isDirectory() ||
      after.isSymbolicLink()
    ) {
      return fail("agent.create resume cwd changed during validation");
    }
    let openFd: number | undefined = fd;
    return {
      identity: {
        dev: opened.dev.toString(10),
        ino: opened.ino.toString(10),
      },
      fd,
      close: () => {
        if (openFd === undefined) return;
        const closing = openFd;
        openFd = undefined;
        closeSync(closing);
      },
    };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* preserve primary cwd validation error */
    }
    throw error;
  }
}

function normalizeRequiredAgentId(value: string, methodName: string): string {
  const normalized = normalizeNonEmpty(value);
  if (normalized === undefined) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      `${methodName} requires agentId`,
    );
  }
  return normalized;
}

function normalizeStringList(
  value: readonly string[] | undefined,
  fallback: readonly string[],
): string[] {
  const raw = value === undefined ? fallback : value;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeCursor(cursor: string | undefined): string | undefined {
  return cursor === undefined || cursor.length === 0 ? undefined : cursor;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      "agent list limit must be a positive integer",
    );
  }
  return Math.min(limit, 500);
}

function applyAgentSnapshot(
  agent: MutableAgent,
  snapshot: AgenCBackgroundAgentSnapshot,
): void {
  agent.status = snapshot.status;
  agent.lastActiveAt = snapshot.lastActiveAt;
  if (snapshot.metadata !== undefined) {
    agent.metadata = {
      ...(agent.metadata ?? {}),
      ...snapshot.metadata,
    };
  }
}

function agentRunMetadata(agent: MutableAgent): JsonObject {
  return {
    ...agent.metadata,
    ...(agent.agentPath !== undefined ? { agentPath: agent.agentPath } : {}),
  };
}

function snapshotRouteForAgent(agent: MutableAgent): AgenCDaemonSnapshotRoute {
  return {
    ...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
    ...(agent.stateProjectDir !== undefined
      ? { stateProjectDir: agent.stateProjectDir }
      : {}),
  };
}

function logSessionIdsForAgent(agent: MutableAgent): string[] {
  return uniqueNonEmptyStrings([...agent.logSessionIds, ...agent.sessionIds]);
}

function latestSessionIdForAgentRun(agent: MutableAgent): string | undefined {
  return agent.sessionIds.at(-1) ?? agent.logSessionIds.at(-1);
}

function isActiveAgent(agent: MutableAgent): boolean {
  return (
    agent.status !== "stopping" &&
    agent.status !== "stopped" &&
    agent.status !== "error"
  );
}

/**
 * Message for a send/attach against an agent that cannot take work.
 *
 * "not found" is only true when the registry has no such agent. When the agent
 * IS present but inactive — status error/stopped/stopping — reporting it as
 * missing sends the reader hunting for a lookup bug instead of the run that
 * ended. Observed: a model turn was denied `context_window_exceeded`, the run
 * went to `errored` 9ms later, and every subsequent send answered
 * "agent not found", which is two layers below the cause and points away from
 * it. The registry knows the status here; say it.
 */
function inactiveAgentMessage(
  agentId: string,
  agent: MutableAgent | undefined,
): string {
  if (agent === undefined) {
    return `AgenC daemon agent not found: ${agentId}`;
  }
  return (
    `AgenC daemon agent ${agentId} is no longer running (status: ${agent.status}). ` +
    `Its run has ended and cannot accept new input — start a new session to continue. ` +
    `Run \`agenc run status ${agentId}\` for why it ended.`
  );
}

/** Test seam for {@link inactiveAgentMessage}; not part of the daemon API. */
export function inactiveAgentMessageForTest(
  agentId: string,
  agent: { readonly status: string } | undefined,
): string {
  return inactiveAgentMessage(agentId, agent as MutableAgent | undefined);
}

function isRecoveredRuntimeUnavailable(agent: MutableAgent): boolean {
  return agent.recovered === true && agent.runtimeAvailable !== true;
}

/**
 * Lifecycle still treats the agent as active but the runner has gone
 * away. `#refreshAgentFromRunner` flips `runtimeAvailable` to false
 * either when the runner reports no snapshot for a live agent or when
 * the daemon restored the run from durable state without an attached
 * runtime. Either way the agent can no longer make progress and is a
 * reaper target.
 */
/** How long the runner must stay silent before an agent is reapable. */
const RUNTIME_UNAVAILABLE_GRACE_MS = 60_000;

// Exported as a test seam: reap eligibility is load-bearing for live runs.
export function isStaleAgent(agent: MutableAgent, nowIso?: string): boolean {
  if (!isActiveAgent(agent)) return false;
  if (agent.runtimeAvailable !== false) return false;
  // A daemon-restart recovery restored the record without a runtime; it
  // can never come back on its own, so it is reapable immediately.
  if (agent.recovered === true) return true;
  const since = agent.runtimeUnavailableSince;
  if (since === undefined) return false;
  const now = nowIso !== undefined ? Date.parse(nowIso) : Date.now();
  const start = Date.parse(since);
  if (!Number.isFinite(now) || !Number.isFinite(start)) return true;
  return now - start >= RUNTIME_UNAVAILABLE_GRACE_MS;
}

function compareAgentsForList(left: MutableAgent, right: MutableAgent): number {
  return left.agentId.localeCompare(right.agentId);
}

function isActiveSession(session: SessionSummary): boolean {
  return session.status !== "closed" && session.status !== "error";
}

function newestSession(
  sessions: readonly SessionSummary[],
): SessionSummary | null {
  if (sessions.length === 0) return null;
  return [...sessions].sort(compareNewestSessionFirst)[0] ?? null;
}

function compareNewestSessionFirst(
  left: SessionSummary,
  right: SessionSummary,
): number {
  const rightTime = Date.parse(right.createdAt);
  const leftTime = Date.parse(left.createdAt);
  if (Number.isFinite(rightTime) && Number.isFinite(leftTime)) {
    return rightTime - leftTime;
  }
  return right.createdAt.localeCompare(left.createdAt);
}

function storedThreadToAgent(thread: StoredThread): MutableAgent | undefined {
  if (!isAgentThreadSource(thread.source)) return undefined;
  const agentId = agentIdForThread(thread);
  const agentPath = threadSourceStringField(thread.source, "agentPath");
  const metadata: JsonObject = {
    source:
      thread.source === undefined
        ? undefined
        : threadSourceToJson(thread.source),
    model: thread.model,
    modelProvider: thread.modelProvider,
    rolloutPath: thread.rolloutPath,
    recovered: true,
  };
  return {
    agentId,
    ...(agentPath !== undefined ? { agentPath } : {}),
    objective:
      thread.name ??
      threadSourceStringField(thread.source, "objective") ??
      thread.threadId,
    status: "idle",
    createdAt: thread.createdAt,
    startedAt: thread.createdAt,
    lastActiveAt: thread.updatedAt,
    sessionIds: [thread.threadId],
    logSessionIds: [thread.threadId],
    recovered: true,
    runtimeAvailable: false,
    ...(thread.cwd !== undefined ? { cwd: thread.cwd } : {}),
    metadata,
  };
}

function agentIdForThread(thread: StoredThread): string {
  const direct =
    threadSourceStringField(thread.source, "agentId") ??
    threadSourceStringField(thread.source, "agent_id");
  if (direct !== undefined) return direct;
  return thread.threadId;
}

function threadSourceToJson(source: ThreadSource): JsonValue {
  return typeof source === "string" ? source : (source as JsonObject);
}

function toAgentCreateResult(agent: MutableAgent): AgentCreateResult {
  const summary = toAgentSummary(agent);
  const sessionId = agent.sessionIds[0];
  return {
    ...summary,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function toAgentSummary(agent: MutableAgent): AgentSummary {
  return {
    agentId: agent.agentId,
    ...(agent.agentPath !== undefined ? { agentPath: agent.agentPath } : {}),
    objective: agent.objective,
    status: agent.status,
    createdAt: agent.createdAt,
    startedAt: agent.startedAt,
    lastActiveAt: agent.lastActiveAt,
    ...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
    ...(agent.sessionIds.length > 0
      ? { activeSessionIds: [...agent.sessionIds] }
      : {}),
    ...(agent.metadata !== undefined ? { metadata: agent.metadata } : {}),
  };
}

function storedThreadToAgentLogSession(thread: StoredThread): AgentLogSession {
  const items = [...(thread.history?.items ?? [])];
  return {
    sessionId: thread.threadId,
    itemCount: items.length,
    transcript: formatRolloutItemsForAgentLog(items),
    ...(thread.rolloutPath !== undefined
      ? { rolloutPath: thread.rolloutPath }
      : {}),
    ...(thread.source !== undefined
      ? { source: formatThreadSourceForLog(thread.source) }
      : {}),
  };
}

function formatAgentLogsTranscript(
  agentId: string,
  sessions: readonly AgentLogSession[],
  toolOutputs: readonly AgentToolOutputLog[],
): string {
  if (sessions.length === 0 && toolOutputs.length === 0) {
    return [`agent_id\t${agentId}`, "No transcript entries"].join("\n");
  }
  const sections: string[] = [];
  for (const session of sessions) {
    const header = [
      `agent_id\t${agentId}`,
      `session_id\t${session.sessionId}`,
      ...(session.rolloutPath !== undefined
        ? [`rollout_path\t${session.rolloutPath}`]
        : []),
    ];
    sections.push(
      [
        ...header,
        "",
        session.transcript.length > 0
          ? session.transcript
          : "No transcript entries",
      ].join("\n"),
    );
  }
  if (toolOutputs.length > 0) {
    sections.push(formatToolOutputSection(toolOutputs));
  }
  return sections.join("\n\n");
}

function formatRolloutItemsForAgentLog(items: readonly RolloutItem[]): string {
  const lines: string[] = [];
  let assistantDelta = "";
  const flushAssistantDelta = (): void => {
    if (assistantDelta.length === 0) return;
    lines.push(formatTranscriptLine("assistant", assistantDelta));
    assistantDelta = "";
  };

  for (const item of items) {
    if (item.type === "event_msg") {
      const line = formatEventMessageForLog(item.payload, {
        appendAssistantDelta: (delta) => {
          assistantDelta += delta;
        },
        flushAssistantDelta,
      });
      if (line !== null) lines.push(line);
      continue;
    }
    flushAssistantDelta();
    if (item.type === "response_item") {
      lines.push(formatResponseItemForLog(item.payload));
    } else if (item.type === "compacted") {
      lines.push(
        formatTranscriptLine(
          "system",
          `context compacted${item.payload.message ? `: ${item.payload.message}` : ""}`,
        ),
      );
    } else if (item.type === "unknown") {
      lines.push(
        formatTranscriptLine(
          "unknown",
          `skipped rollout item ${item.payload.originalType}`,
        ),
      );
    } else {
      lines.push(formatGenericRolloutItemForLog(item));
    }
  }
  flushAssistantDelta();
  return lines.join("\n\n");
}

function formatEventMessageForLog(
  event: Event,
  delta: {
    readonly appendAssistantDelta: (delta: string) => void;
    readonly flushAssistantDelta: () => void;
  },
): string | null {
  const msg = event.msg;
  switch (msg.type) {
    case "agent_message_delta":
      delta.appendAssistantDelta(msg.payload.delta);
      return null;
    case "agent_message":
      delta.flushAssistantDelta();
      return formatTranscriptLine("assistant", msg.payload.message);
    case "user_message":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "user",
        messageContentText(msg.payload.displayText ?? msg.payload.message),
      );
    case "turn_complete":
      delta.flushAssistantDelta();
      return msg.payload.lastAgentMessage
        ? formatTranscriptLine("assistant", msg.payload.lastAgentMessage)
        : formatTranscriptLine("system", `turn complete ${msg.payload.turnId}`);
    case "turn_aborted":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "system",
        `turn aborted: ${msg.payload.reason}`,
      );
    case "tool_call_started":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `${msg.payload.toolName} started (${msg.payload.callId})\n${msg.payload.args}`,
      );
    case "tool_call_completed":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `completed (${msg.payload.callId})${msg.payload.isError ? " with error" : ""}\n${msg.payload.result}`,
      );
    case "tool_progress":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `${msg.payload.toolName} progress (${msg.payload.callId})\n${msg.payload.chunk}`,
      );
    case "exec_command_begin":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "exec",
        `started (${msg.payload.callId})\n${msg.payload.command}`,
      );
    case "exec_command_end":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "exec",
        [
          `completed (${msg.payload.callId}) exit=${String(msg.payload.exitCode)}`,
          msg.payload.stdout ? `stdout:\n${msg.payload.stdout}` : "",
          msg.payload.stderr ? `stderr:\n${msg.payload.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    case "mcp_tool_call_begin":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `${msg.payload.server}.${msg.payload.toolName} started (${msg.payload.callId})\n${msg.payload.args}`,
      );
    case "mcp_tool_call_end":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `completed (${msg.payload.callId})${msg.payload.isError ? " with error" : ""}\n${msg.payload.result}`,
      );
    case "warning":
      delta.flushAssistantDelta();
      return formatTranscriptLine("warning", msg.payload.message);
    case "error":
    case "stream_error":
      delta.flushAssistantDelta();
      return formatTranscriptLine("error", msg.payload.message);
    case "context_compacted":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "system",
        `context compacted${msg.payload.summary ? `: ${msg.payload.summary}` : ""}`,
      );
    case "plan_started":
      delta.flushAssistantDelta();
      return formatTranscriptLine("plan", msg.payload.title ?? "started");
    case "plan_delta":
      delta.flushAssistantDelta();
      return formatTranscriptLine("plan", msg.payload.delta);
    case "plan_item_completed":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "plan",
        `completed: ${msg.payload.finalText}`,
      );
    case "plan_exited":
      delta.flushAssistantDelta();
      return formatTranscriptLine("plan", "exited");
    default:
      delta.flushAssistantDelta();
      return formatGenericEventForLog(event);
  }
}

function formatResponseItemForLog(item: ResponseItem): string {
  return formatTranscriptLine(item.role, messageContentText(item.content));
}

function formatGenericEventForLog(event: Event): string {
  return formatTranscriptLine(
    `event:${event.msg.type}`,
    stringifyJsonForLog({
      id: event.id,
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      payload: event.msg.payload,
    }),
  );
}

function formatGenericRolloutItemForLog(item: RolloutItem): string {
  return formatTranscriptLine(
    `rollout:${item.type}`,
    stringifyJsonForLog(
      item.eventVersion === undefined
        ? item.payload
        : {
            eventVersion: item.eventVersion,
            payload: item.payload,
          },
    ),
  );
}

function formatToolOutputSection(
  toolOutputs: readonly AgentToolOutputLog[],
): string {
  return [
    "tool_outputs",
    ...toolOutputs.map((output) =>
      [
        `session_id\t${output.sessionId}`,
        `tool_call_id\t${output.toolCallId}`,
        `tool_name\t${output.toolName}`,
        `status\t${output.status}`,
        ...(output.outputLogPath !== undefined
          ? [`output_log_path\t${output.outputLogPath}`]
          : []),
        "",
        output.output,
      ].join("\n"),
    ),
  ].join("\n\n");
}

function formatTranscriptLine(role: string, content: string): string {
  return `${role}:\n${content.trimEnd()}`;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part !== null &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return stringifyJsonForLog(part);
      })
      .join("\n");
  }
  return stringifyJsonForLog(content);
}

function stringifyJsonForLog(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatThreadSourceForLog(source: ThreadSource): string {
  return typeof source === "string" ? source : (JSON.stringify(source) ?? "");
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isCanonicalCancellationTerminal(
  terminal: AgenCBackgroundAgentTerminalSnapshot | undefined,
  runId: string,
): terminal is AgenCBackgroundAgentTerminalSnapshot {
  return (
    isCanonicalRunTerminal(terminal, runId) &&
    terminal.result.status === "cancelled"
  );
}

function isCanonicalRunTerminal(
  terminal: AgenCBackgroundAgentTerminalSnapshot | undefined,
  runId: string,
): terminal is AgenCBackgroundAgentTerminalSnapshot {
  return (
    terminal !== undefined &&
    terminal.result.runId === runId &&
    typeof terminal.eventId === "string" &&
    terminal.eventId.trim().length > 0 &&
    Number.isSafeInteger(terminal.epoch) &&
    terminal.epoch > 0 &&
    typeof terminal.rolloutPath === "string" &&
    terminal.rolloutPath.trim().length > 0 &&
    Number.isSafeInteger(terminal.result.lastSequence) &&
    (terminal.result.lastSequence ?? 0) > 0
  );
}

function isThreadLogReadMiss(error: unknown): boolean {
  return (
    error instanceof ThreadNotFoundError ||
    error instanceof ThreadStoreInvalidRequestError
  );
}

/**
 * Whether a lifecycle-level resolve error means "there is no live agent for
 * this session" (so a persisted-thread transcript fallback is appropriate).
 * Both codes are raised by {@link AgenCDaemonAgentManager.#resolveActiveAgentIdForSession}
 * when the agent is absent from, or recovered-without-a-runtime in, the
 * lifecycle map.
 */
function isNoLiveAgentError(error: unknown): boolean {
  return (
    error instanceof AgenCDaemonAgentLifecycleError &&
    (error.code === "AGENT_NOT_FOUND" ||
      error.code === "BACKGROUND_RUNNER_UNAVAILABLE")
  );
}

/**
 * Whether the runner's `getAgentSessionTranscript` threw because it has no
 * live in-memory agent for the resolved id. The runner reports this with a
 * plain Error (`AgenC daemon agent not found/not running: <agentId>`); the
 * lifecycle map can still hold the agent as "active" for a recovered terminal
 * session, so this fallback covers that gap.
 */
function isNoLiveAgentRunnerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /AgenC daemon agent not (found|running):/.test(error.message) &&
    !(error instanceof AgenCDaemonAgentLifecycleError)
  );
}

/**
 * Extract the user/assistant text transcript from a persisted thread's
 * rollout items. Mirrors the live-agent extraction in
 * `BackgroundAgentRunner.getAgentSessionTranscript` (which reads the
 * in-memory `ResponseItem[]` history): only user/assistant turns with
 * non-empty text are surfaced. `response_item` rollout entries carry the same
 * `{ role, content }` history the live path reads; `user_message` /
 * `agent_message` events are the persisted-event equivalents emitted by a
 * terminal session, so both sources are honored.
 */
function transcriptMessagesFromRolloutItems(
  items: readonly RolloutItem[],
): { role: string; text: string }[] {
  const responseItemKeys = new Set<string>();
  for (const item of items) {
    if (item.type !== "response_item") continue;
    const role = item.payload.role;
    const text = messageContentText(item.payload.content);
    if ((role === "user" || role === "assistant") && text.length > 0) {
      responseItemKeys.add(`${role}\u0000${text}`);
    }
  }
  const messages: { role: string; text: string }[] = [];
  const push = (role: string, text: string): void => {
    if ((role === "user" || role === "assistant") && text.length > 0) {
      messages.push({ role, text });
    }
  };
  for (const item of items) {
    if (item.type === "response_item") {
      push(item.payload.role, messageContentText(item.payload.content));
    } else if (item.type === "event_msg") {
      const transcribed = transcriptMessageFromEvent(item.payload);
      if (transcribed !== undefined) {
        const key = `${transcribed.role}\u0000${transcribed.text}`;
        if (!responseItemKeys.has(key)) {
          push(transcribed.role, transcribed.text);
        }
      }
    }
  }
  // Terminal rollouts can carry both canonical `response_item` entries and
  // exact `user_message`/`agent_message` event duplicates. Keep response items
  // as the canonical copy, but still retain event-only turns.
  return messages;
}

function transcriptMessageFromEvent(
  event: Event,
): { role: string; text: string } | undefined {
  const msg = event.msg;
  if (msg.type === "user_message") {
    return {
      role: "user",
      text: messageContentText(msg.payload.displayText ?? msg.payload.message),
    };
  }
  if (msg.type === "agent_message") {
    return { role: "assistant", text: messageContentText(msg.payload.message) };
  }
  return undefined;
}

/**
 * Map the wire-level ExitPlanApprovalPayload (from tool.approve) onto the
 * planning module's ExitPlanModeApproval, omitting absent optional fields so
 * the consuming execute() observes exactly what the UI chose.
 */
function toExitPlanModeApproval(
  exitPlan: ExitPlanApprovalPayload,
): ExitPlanModeApproval {
  if (exitPlan.action === "revise") {
    return {
      action: "revise",
      ...(exitPlan.feedback !== undefined
        ? { feedback: exitPlan.feedback }
        : {}),
    };
  }
  return {
    action: "approve",
    ...(exitPlan.mode !== undefined ? { mode: exitPlan.mode } : {}),
    ...(exitPlan.applyAllowedPrompts !== undefined
      ? { applyAllowedPrompts: exitPlan.applyAllowedPrompts }
      : {}),
    ...(exitPlan.clearContext !== undefined
      ? { clearContext: exitPlan.clearContext }
      : {}),
  };
}

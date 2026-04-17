/**
 * BackgroundRunSupervisor — daemon-owned long-running task supervision for user sessions.
 *
 * Converts explicit long-running user objectives into a bounded background loop:
 * actor step (ChatExecutor + tools) -> verifier step (structured decision) -> reschedule/update.
 *
 * This keeps control in the runtime instead of trusting one chat turn to own
 * the entire task lifecycle.
 *
 * @module
 */

import type { ChatExecutor } from "../llm/chat-executor.js";
import type {
  ChatExecutionTraceEvent,
  ChatExecutorResult,
} from "../llm/chat-executor-types.js";
import { executeChatToLegacyResult } from "../llm/execute-chat.js";
import { normalizePromptEnvelope } from "../llm/prompt-envelope.js";
import { buildModelOnlyChatOptions } from "../llm/model-only-options.js";
import { getCompactPrompt, formatCompactSummary } from "../llm/compact/prompt.js";
import type { LLMMessage, LLMProvider, ToolHandler } from "../llm/types.js";
import { partitionByAnchorPreserve } from "../llm/types.js";
import { collectAttachments } from "../llm/attachment-injection.js";
import {
  containsVerdictMarkerInToolResult,
  isMutatingTool,
  isVerifierSpawnFromRecord,
  messageContainsVerifyReminderPrefix,
} from "../llm/verify-reminder.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import {
  createExecutionTraceEventLogger,
  createProviderTraceEventLogger,
  logStructuredTraceEvent,
} from "../llm/provider-trace-logger.js";
import type { ProgressTracker } from "./progress.js";
import type { PolicyDecision, PolicyEngine, PolicyEvaluationScope } from "../policy/index.js";
import type { TelemetryCollector } from "../telemetry/types.js";
import type {
  RuntimeDependencyDomain,
  RuntimeDependencyMode,
  RuntimeIncidentDiagnostics,
} from "../telemetry/incident-diagnostics.js";
import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";
import { startReplaySpan } from "../replay/trace.js";
import {
  AGENT_RUN_SCHEMA_VERSION,
  assertAgentRunStateTransition,
  assertValidAgentRunContract,
  isTerminalAgentRunState,
} from "./agent-run-contract.js";
import type {
  BackgroundRunControlAction,
  BackgroundRunEventRecord,
  BackgroundRunOperatorDetail,
  BackgroundRunOperatorSummary,
} from "./background-run-operator.js";
import { BackgroundRunNotifier } from "./background-run-notifier.js";
import {
  assertValidBackgroundRunLineage,
  type BackgroundRunLineage,
} from "./subrun-contract.js";
import {
  appendShellProfilePromptSection,
  DEFAULT_SESSION_SHELL_PROFILE,
} from "./shell-profile.js";
import {
  BackgroundRunStore,
  DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
  isBackgroundRunFenceConflictError,
  type BackgroundRunEvent,
  type BackgroundRunEventType,
  type BackgroundRunDispatchItem,
  type BackgroundRunContract,
  type BackgroundRunRecentSnapshot,
  type BackgroundRunSignal,
  type BackgroundRunState,
  type BackgroundRunWorkerPool,
  type BackgroundRunWakeReason,
  type PersistedBackgroundRun,
} from "./background-run-store.js";
import { BackgroundRunWakeBus } from "./background-run-wake-bus.js";
import type { RunDomainRetryPolicy } from "./run-domains.js";
import {
  buildInteractivePromptSnapshot,
  buildInteractiveToolScopeFingerprint,
  cloneInteractiveContextState,
  normalizeInteractiveExecutionLocation,
  type InteractiveContextRequest,
  type InteractiveContextState,
} from "./interactive-context.js";

// --- Re-export from extracted constants ---
import {
  DEFAULT_POLL_INTERVAL_MS,
  BUSY_RETRY_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  FAST_FOLLOWUP_POLL_INTERVAL_MS,
  STABLE_POLL_STEP_MS,
  ACTIVE_CYCLE_HEARTBEAT_INITIAL_MS,
  ACTIVE_CYCLE_HEARTBEAT_REPEAT_MS,
  HEARTBEAT_MIN_DELAY_MS,
  HEARTBEAT_MAX_DELAY_MS,
  MAX_USER_UPDATE_CHARS,
  BACKGROUND_RUN_ACTOR_REQUEST_TIMEOUT_MS,
  BACKGROUND_RUN_MAX_TOOL_ROUNDS,
  BACKGROUND_RUN_MAX_TOOL_BUDGET,
  BACKGROUND_RUN_MAX_MODEL_RECALLS,
  MAX_CONSECUTIVE_ERROR_CYCLES,
  DEFAULT_WORKER_HEARTBEAT_MS,
  DEFAULT_DISPATCH_RETRY_MS,
  DEFAULT_DISPATCH_QUEUE_MAX_TOTAL,
  DEFAULT_DISPATCH_QUEUE_MAX_PER_POOL,
  MAX_BACKGROUND_RUN_ALERTS,
  BACKGROUND_ACTOR_SECTION,
  DECISION_SYSTEM_PROMPT,
  CONTRACT_SYSTEM_PROMPT,
  CARRY_FORWARD_SYSTEM_PROMPT,
  UNTIL_STOP_RE,
  KEEP_UPDATING_RE,
  BACKGROUND_RE,
  CONTINUOUS_RE,
  STOP_REQUEST_RE,
  PAUSE_REQUEST_RE,
  RESUME_REQUEST_RE,
  STATUS_REQUEST_RE,
  HISTORY_COMPACTION_THRESHOLD,
} from "./background-run-supervisor-constants.js";
import {
  formatAnchorFilesSection,
  mergeAnchorRegistrations,
  refreshAnchorFiles,
} from "./background-run-anchor-files.js";
import { resolveAtMentionAttachments } from "./at-mention-attachments.js";

// --- Re-export from extracted types ---
export type {
  BackgroundRunStatusSnapshot,
  BackgroundRunAlert,
  BackgroundRunFleetStatusSnapshot,
  BackgroundRunSupervisorConfig,
} from "./background-run-supervisor-types.js";
import type {
  ActiveBackgroundRun,
  BackgroundRunDecision,
  BackgroundRunSupervisorConfig,
  CarryForwardRefreshReason,
  PreparedCycleContext,
  ResolvedCycleOutcome,
  StartBackgroundRunParams,
} from "./background-run-supervisor-types.js";
import type {
  BackgroundRunStatusSnapshot,
  BackgroundRunAlert,
  BackgroundRunFleetStatusSnapshot,
} from "./background-run-supervisor-types.js";
import {
  toPersistedRun,
  toRecentSnapshot,
  toStatusSnapshot,
  toActiveRun,
  toRunMessage,
  toOperatorEventRecords,
  trimHistory,
} from "./background-run-supervisor-types.js";

// --- Re-export from extracted helpers ---
import {
  truncate,
  clampPollIntervalMs,
  normalizePositiveInteger,
  normalizeOptionalBudgetLimit,
  normalizeOperatorStringList,
  summarizeToolCalls,
  sanitizeWorkerPools,
  cloneSignals,
  removeConsumedSignals,
  dropSyntheticInternalSignals,
  formatSignals,
  formatCarryForwardState,
  formatObservedTargets,
  buildInternalToolSignals,
  getWakeEventDomain,
  buildWakeDedupeKey,
  recordToolEvidence,
  recordProviderCompactionArtifacts,
  buildFallbackCarryForwardState,
  buildCarryForwardAnchors,
  deriveCarryForwardRefreshReason,
  detectCarryForwardDrift,
  repairCarryForwardState,
  parseCarryForwardState,
  buildInitialBudgetState,
  buildInitialCompactionState,
  recordRunActivity,
  refreshDerivedBudgetState,
  clearRunBlockers,
  resolveWorkerPool,
  resolveWorkerAffinityKey,
  getScopedAllowedTools,
  applyRunToolScopeDecision,
  buildBlockerState,
  buildFallbackDecision,
  groundDecision,
  computeConsecutiveErrorCycles,
  applyRepeatedErrorGuard,
  applyZeroToolCompletionGuard,
  buildDecisionPrompt,
  buildContractPrompt,
  buildCarryForwardPrompt,
  parseDecision,
  parseContract,
  buildFallbackContract,
  buildBackgroundRunTraceIds,
  toOperatorSummary,
} from "./background-run-supervisor-helpers.js";
import { evaluateCycleContinuationInjections } from "./background-run-continuation.js";
import { isRuntimeLimitExceeded } from "../llm/runtime-limit-policy.js";

// --- Re-export from extracted managed-process module ---
import {
  getRunDomain,
  buildDeterministicRunDomainDecision,
  buildPreCycleDomainDecision,
  toDecisionFromDomainVerification,
  observeManagedProcessExitSignal,
  observeManagedProcessTargets,
  getManagedProcessSurface,
  managedProcessStopToolName,
  buildManagedProcessStopArgs,
  buildManagedProcessIdentity,
  findLatestManagedProcessTarget,
  listRunningManagedProcessTargets,
} from "./background-run-supervisor-managed-process.js";
import {
  buildNativeActorResult,
  executeNativeToolCall,
} from "./run-domain-native-tools.js";
import { extractToolFailureText } from "../llm/chat-executor-tool-utils.js";
import type { EffectLedger } from "../workflow/effect-ledger.js";
import type { EffectRecord } from "../workflow/effects.js";
import { mergeWorkflowProgressSnapshots } from "../workflow/completion-progress.js";
import {
  FaultInjectionError,
  type FaultInjectionPoint,
  type RuntimeFaultInjector,
} from "../eval/fault-injection.js";
import { hasStopHookHandlers, runStopHookPhase } from "../llm/hooks/stop-hooks.js";

// ---------------------------------------------------------------------------
// Domain-dependent free functions (kept here to avoid circular deps)
// ---------------------------------------------------------------------------

function resolveRunNextCheckClampMaxMs(
  run: ActiveBackgroundRun,
  retryPolicy?: RunDomainRetryPolicy,
): number {
  return Math.max(
    MAX_POLL_INTERVAL_MS,
    retryPolicy?.maxNextCheckMs ?? getRunDomain(run).retryPolicy?.(run)?.maxNextCheckMs ?? 0,
  );
}

function buildActorPrompt(run: ActiveBackgroundRun): string {
  const recentHistory = run.lastUserUpdate
    ? `Latest published status: ${run.lastUserUpdate}\n`
    : "";
  const recentToolEvidence = run.lastToolEvidence
    ? `Latest tool evidence:\n${run.lastToolEvidence}\n`
    : "";
  const anchorFilesText = formatAnchorFilesSection(run.anchorFiles);
  const anchorFilesSection = anchorFilesText ? `${anchorFilesText}\n` : "";
  const carryForward = formatCarryForwardState(run.carryForward);
  const carryForwardSection = carryForward
    ? `Carry-forward state:\n${carryForward}\n`
    : "";
  const pendingSignals = formatSignals(run.pendingSignals);
  const signalSection = pendingSignals
    ? `Pending external signals:\n${pendingSignals}\n`
    : "";
  const observedTargets = formatObservedTargets(run.observedTargets);
  const observedTargetSection = observedTargets
    ? `Runtime observed targets:\n${observedTargets}\n`
    : "";
  const completionProgressSection = formatCompletionProgressState(
    run.completionProgress,
  );
  const completionProgressText = completionProgressSection
    ? `Completion progress:\n${completionProgressSection}\n`
    : "";
  const domain = getRunDomain(run);
  const domainPlannerContract = domain.plannerContract(run);
  const domainVerifierContract = domain.verifierContract(run);
  const domainArtifactContract = domain.artifactContract(run);
  const contractSummary =
    `Run contract:\n${JSON.stringify(run.contract, null, 2)}\n`;
  const firstCycleGuidance = run.cycleCount === 1
    ? "This is the first cycle. Establish the baseline and start any required long-running process before relying on status checks alone.\n"
    : "";
  return (
    `Background objective:\n${run.objective}\n\n` +
    `Cycle: ${run.cycleCount}\n` +
    contractSummary +
    `Domain planner contract:\n- ${domainPlannerContract.join("\n- ")}\n` +
    `Domain verifier contract:\n- ${domainVerifierContract.join("\n- ")}\n` +
    `Domain artifact contract:\n- ${domainArtifactContract.join("\n- ")}\n` +
    carryForwardSection +
    completionProgressText +
    signalSection +
    observedTargetSection +
    anchorFilesSection +
    recentHistory +
    recentToolEvidence +
    firstCycleGuidance +
    "Continue from where you left off. Do not stop until the full objective is satisfied. " +
    "Use tools to make progress. If you completed a phase or milestone, continue to the next one immediately without stopping. " +
    "Only stop calling tools when the ENTIRE objective is done, not just one part of it.\n"
  );
}

function resolveRunWorkspaceRoot(
  run: ActiveBackgroundRun,
  runtimeWorkspaceRoot?: string,
): string | undefined {
  return (
    runtimeWorkspaceRoot ??
    run.interactiveContextState?.executionLocation?.workspaceRoot ??
    run.lineage?.scope.workspaceRoot
  );
}

function buildBackgroundRunInteractiveContextState(params: {
  readonly run: ActiveBackgroundRun;
  readonly promptEnvelope: ReturnType<typeof normalizePromptEnvelope>;
  readonly runtimeWorkspaceRoot?: string;
  readonly advertisedToolNames?: readonly string[];
}): InteractiveContextState {
  const executionLocation = normalizeInteractiveExecutionLocation({
    mode:
      params.run.lineage?.scope.workspaceRoot ||
      params.run.interactiveContextState?.executionLocation?.mode === "worktree"
        ? params.run.interactiveContextState?.executionLocation?.mode ?? "local"
        : "local",
    workspaceRoot: resolveRunWorkspaceRoot(
      params.run,
      params.runtimeWorkspaceRoot,
    ),
    workingDirectory: resolveRunWorkspaceRoot(
      params.run,
      params.runtimeWorkspaceRoot,
    ),
    gitRoot: params.run.interactiveContextState?.executionLocation?.gitRoot,
    worktreePath:
      params.run.interactiveContextState?.executionLocation?.worktreePath,
    worktreeRef:
      params.run.interactiveContextState?.executionLocation?.worktreeRef,
  });
  const existing = params.run.interactiveContextState;
  const advertisedToolNames =
    params.advertisedToolNames && params.advertisedToolNames.length > 0
      ? params.advertisedToolNames
      : existing?.defaultAdvertisedToolNames ?? [];
  const discoveredToolNames = existing?.discoveredToolNames ?? [];
  return {
    version: 1,
    readSeeds: existing?.readSeeds ?? [],
    ...(executionLocation ? { executionLocation } : {}),
    cacheSafePromptSnapshot: buildInteractivePromptSnapshot({
      baseSystemPrompt: params.promptEnvelope.baseSystemPrompt,
      systemContextBlocks: params.promptEnvelope.systemSections,
      userContextBlocks: params.promptEnvelope.userSections,
      sessionStartContextMessages:
        existing?.cacheSafePromptSnapshot?.sessionStartContextMessages ?? [],
      toolScopeFingerprint: buildInteractiveToolScopeFingerprint([
        ...advertisedToolNames,
        ...discoveredToolNames,
      ]),
    }),
    ...(advertisedToolNames.length > 0
      ? { defaultAdvertisedToolNames: advertisedToolNames }
      : {}),
    ...(discoveredToolNames.length > 0 ? { discoveredToolNames } : {}),
    ...(existing?.summaryRef ? { summaryRef: existing.summaryRef } : {}),
    ...(existing?.forkCarryover ? { forkCarryover: existing.forkCarryover } : {}),
  };
}

function resolveBackgroundContinuationMode(
  _actorResult: ChatExecutorResult,
): "provider_continuation" | "transcript_resume" | "full_replay_fallback" {
  return "transcript_resume";
}

function formatCompletionProgressState(
  progress: ActiveBackgroundRun["completionProgress"],
): string | undefined {
  if (!progress) {
    return undefined;
  }
  const parts = [`Current completion state: ${progress.completionState}`];
  if (progress.satisfiedRequirements.length > 0) {
    parts.push(`Already satisfied: ${progress.satisfiedRequirements.join(", ")}`);
  }
  if (progress.remainingRequirements.length > 0) {
    parts.push(`Still required: ${progress.remainingRequirements.join(", ")}`);
  }
  if (progress.reusableEvidence.length > 0) {
    parts.push(
      `Reusable grounded evidence: ${progress.reusableEvidence
        .slice(-3)
        .map((entry) => entry.summary)
        .join(" | ")}`,
    );
  }
  if (progress.stopReasonDetail) {
    parts.push(`Latest completion detail: ${truncate(progress.stopReasonDetail, 160)}`);
  }
  return parts.join("\n");
}

function toOperatorEffectEventRecords(
  effects: readonly EffectRecord[],
): BackgroundRunEventRecord[] {
  return effects.map((effect) => ({
    summary: `${effect.toolName} -> ${effect.status}`,
    timestamp: effect.updatedAt,
    eventType: `effect.${effect.status}`,
    data: {
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      toolName: effect.toolName,
      status: effect.status,
      kind: effect.kind,
      effectClass: effect.effectClass,
      compensationStatus: effect.compensation.status,
    },
  }));
}

function buildHeartbeatMessage(run: ActiveBackgroundRun): string {
  const domainSummary = getRunDomain(run).summarizeStatus(run);
  const nextCheckMs =
    run.nextCheckAt !== undefined
      ? Math.max(0, run.nextCheckAt - Date.now())
      : undefined;
  const lastVerifiedAgeMs =
    run.lastVerifiedAt !== undefined
      ? Math.max(0, Date.now() - run.lastVerifiedAt)
      : undefined;
  const lastVerifiedText = domainSummary
    ? truncate(domainSummary, 120)
    : run.lastUserUpdate
    ? truncate(run.lastUserUpdate, 120)
    : "Task is still active.";

  return truncate(
    "Still working in the background. " +
      `Last verified update: ${lastVerifiedText}` +
      (lastVerifiedAgeMs !== undefined
        ? ` (${Math.max(1, Math.round(lastVerifiedAgeMs / 1000))}s ago). `
        : " ") +
      (nextCheckMs !== undefined
        ? `Next verification in ~${Math.max(1, Math.ceil(nextCheckMs / 1000))}s.`
        : "Next verification is pending."),
    MAX_USER_UPDATE_CHARS,
  );
}

function buildActiveCycleHeartbeatMessage(run: ActiveBackgroundRun): string {
  const domainSummary = getRunDomain(run).summarizeStatus(run);
  const lastVerifiedText = domainSummary
    ? truncate(domainSummary, 120)
    : run.lastUserUpdate
    ? truncate(run.lastUserUpdate, 120)
    : "No verified update has been published yet.";
  const cycleAgeMs = Math.max(0, Date.now() - run.updatedAt);

  return truncate(
    "Still working on the current background cycle. " +
      `Last verified update: ${lastVerifiedText} ` +
      `(cycle active for ~${Math.max(1, Math.ceil(cycleAgeMs / 1000))}s).`,
    MAX_USER_UPDATE_CHARS,
  );
}

function chooseNextCheckMs(params: {
  run: ActiveBackgroundRun;
  actorResult: ChatExecutorResult;
  decision: BackgroundRunDecision;
  previousToolEvidence?: string;
}): { nextCheckMs: number; stableWorkingCycles: number; heartbeatMs?: number } {
  const { run, actorResult, decision, previousToolEvidence } = params;
  const domainRetryPolicy = getRunDomain(run).retryPolicy?.(run);
  const nextCheckClampMaxMs = resolveRunNextCheckClampMaxMs(run, domainRetryPolicy);
  const successfulToolCalls = actorResult.toolCalls.filter((toolCall) => !toolCall.isError);
  const failedToolCalls = actorResult.toolCalls.filter((toolCall) => toolCall.isError);
  const currentEvidence = summarizeToolCalls(actorResult.toolCalls);
  const evidenceChanged = currentEvidence !== previousToolEvidence;
  const nextUserUpdate = truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS);
  const updateChanged = nextUserUpdate !== run.lastUserUpdate;

  if (failedToolCalls.length > 0) {
    return {
      nextCheckMs: MIN_POLL_INTERVAL_MS,
      stableWorkingCycles: 0,
    };
  }

  if (run.cycleCount === 1 && successfulToolCalls.length > 0) {
    return {
      nextCheckMs: domainRetryPolicy?.fastFollowupMs ?? FAST_FOLLOWUP_POLL_INTERVAL_MS,
      stableWorkingCycles: 0,
    };
  }

  if (successfulToolCalls.length > 0 && (evidenceChanged || updateChanged)) {
    return {
      nextCheckMs: Math.min(
        clampPollIntervalMs(decision.nextCheckMs, {
          maxMs: nextCheckClampMaxMs,
        }),
        domainRetryPolicy?.idleNextCheckMs ?? DEFAULT_POLL_INTERVAL_MS,
      ),
      stableWorkingCycles: 0,
    };
  }

  const stableWorkingCycles = evidenceChanged || updateChanged
    ? 0
    : run.stableWorkingCycles + 1;
  const nextCheckMs = clampPollIntervalMs(
    Math.min(
      domainRetryPolicy?.maxNextCheckMs ?? MAX_POLL_INTERVAL_MS,
      (domainRetryPolicy?.idleNextCheckMs ?? DEFAULT_POLL_INTERVAL_MS) +
        (stableWorkingCycles * (domainRetryPolicy?.stableStepMs ?? STABLE_POLL_STEP_MS)),
    ),
    {
      maxMs: nextCheckClampMaxMs,
    },
  );

  return {
    nextCheckMs,
    stableWorkingCycles,
    heartbeatMs:
      nextCheckMs >= (domainRetryPolicy?.heartbeatMinMs ?? HEARTBEAT_MIN_DELAY_MS)
        ? Math.min(
          domainRetryPolicy?.heartbeatMaxMs ?? HEARTBEAT_MAX_DELAY_MS,
          Math.max(
            domainRetryPolicy?.heartbeatMinMs ?? HEARTBEAT_MIN_DELAY_MS,
            Math.floor(nextCheckMs / 2),
          ),
        )
        : undefined,
  };
}

export function inferBackgroundRunIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return (
    UNTIL_STOP_RE.test(text) ||
    KEEP_UPDATING_RE.test(text) ||
    BACKGROUND_RE.test(text) ||
    CONTINUOUS_RE.test(text)
  );
}

export function isBackgroundRunStopRequest(message: string): boolean {
  return STOP_REQUEST_RE.test(message.trim());
}

export function isBackgroundRunPauseRequest(message: string): boolean {
  return PAUSE_REQUEST_RE.test(message.trim());
}

export function isBackgroundRunResumeRequest(message: string): boolean {
  return RESUME_REQUEST_RE.test(message.trim());
}

export function isBackgroundRunStatusRequest(message: string): boolean {
  return STATUS_REQUEST_RE.test(message.trim());
}

export class BackgroundRunSupervisor {
  private readonly chatExecutor: ChatExecutor;
  private readonly supervisorLlm: LLMProvider;
  private readonly supervisorFastLlm: LLMProvider;
  private readonly compactionThresholdTokens: number | undefined;
  private readonly compactionCharPerToken: number;
  private readonly getSystemPrompt: () => string;
  private readonly createToolHandler: BackgroundRunSupervisorConfig["createToolHandler"];
  private readonly resolveExecutionContext?: BackgroundRunSupervisorConfig["resolveExecutionContext"];
  private readonly buildToolRoutingDecision?: BackgroundRunSupervisorConfig["buildToolRoutingDecision"];
  private readonly resolveAdvertisedToolNames?: BackgroundRunSupervisorConfig["resolveAdvertisedToolNames"];
  private readonly seedHistoryForSession?: BackgroundRunSupervisorConfig["seedHistoryForSession"];
  private readonly readTodosForSession?: BackgroundRunSupervisorConfig["readTodosForSession"];
  private readonly readTasksForSession?: BackgroundRunSupervisorConfig["readTasksForSession"];
  private readonly readOpenTasksForSession?: BackgroundRunSupervisorConfig["readOpenTasksForSession"];
  private readonly isSessionBusy?: BackgroundRunSupervisorConfig["isSessionBusy"];
  private readonly onStatus?: BackgroundRunSupervisorConfig["onStatus"];
  private readonly publishUpdate: BackgroundRunSupervisorConfig["publishUpdate"];
  private readonly progressTracker?: ProgressTracker;
  private readonly runStore: BackgroundRunStore;
  private readonly policyEngine?: PolicyEngine;
  private readonly resolvePolicyScope?: BackgroundRunSupervisorConfig["resolvePolicyScope"];
  private readonly telemetry?: TelemetryCollector;
  private readonly notifier?: BackgroundRunNotifier;
  private readonly resolveStopHookRuntime?: BackgroundRunSupervisorConfig["resolveStopHookRuntime"];
  private readonly effectLedger?: EffectLedger;
  private readonly incidentDiagnostics?: RuntimeIncidentDiagnostics;
  private readonly faultInjector?: RuntimeFaultInjector;
  private readonly wakeBus: BackgroundRunWakeBus;
  private readonly logger: Logger;
  private readonly traceProviderPayloads: boolean;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly workerPools: readonly BackgroundRunWorkerPool[];
  private readonly workerMaxConcurrentRuns: number;
  private readonly activeRuns = new Map<string, ActiveBackgroundRun>();
  private readonly statusSnapshots = new Map<string, BackgroundRunStatusSnapshot>();
  private readonly recentAlerts: BackgroundRunAlert[] = [];
  private readonly terminatingSessions = new Set<string>();
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledDispatchAt?: number;
  private lastDispatchBeaconRevision?: number;
  private workerHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatchPumpRunning = false;
  private workerDraining = false;
  /**
   * In-flight concurrent dispatch cycles. The pump fills this set up
   * to `workerMaxConcurrentRuns` and keeps draining the claim queue
   * as slots free up. Without this, a single long-running cycle
   * (e.g. a subagent tool loop) would serially block every other
   * session's scheduled wake-up even though Node handles those
   * sessions' I/O awaits concurrently at the event loop level.
   */
  private readonly inFlightDispatches = new Set<Promise<void>>();
  /**
   * Set of sessionIds currently running a dispatched cycle. Ensures
   * the concurrent pump never runs two cycles of the SAME session
   * simultaneously — a late operator signal overlapping an expired
   * timer dispatch would otherwise show up as two separate claimed
   * items, and without this guard both would run, double-cycling
   * the session.
   */
  private readonly inFlightSessionIds = new Set<string>();

  constructor(config: BackgroundRunSupervisorConfig) {
    this.chatExecutor = config.chatExecutor;
    this.supervisorLlm = config.supervisorLlm;
    this.supervisorFastLlm = config.supervisorFastLlm ?? config.supervisorLlm;
    this.compactionThresholdTokens =
      typeof config.compactionThresholdTokens === "number" &&
      Number.isFinite(config.compactionThresholdTokens) &&
      config.compactionThresholdTokens > 0
        ? Math.floor(config.compactionThresholdTokens)
        : undefined;
    this.compactionCharPerToken =
      typeof config.compactionCharPerToken === "number" &&
      Number.isFinite(config.compactionCharPerToken) &&
      config.compactionCharPerToken > 0
        ? config.compactionCharPerToken
        : 4;
    this.getSystemPrompt = config.getSystemPrompt;
    this.createToolHandler = config.createToolHandler;
    this.resolveExecutionContext = config.resolveExecutionContext;
    this.buildToolRoutingDecision = config.buildToolRoutingDecision;
    this.resolveAdvertisedToolNames = config.resolveAdvertisedToolNames;
    this.seedHistoryForSession = config.seedHistoryForSession;
    this.readTodosForSession = config.readTodosForSession;
    this.readTasksForSession = config.readTasksForSession;
    this.readOpenTasksForSession = config.readOpenTasksForSession;
    this.isSessionBusy = config.isSessionBusy;
    this.onStatus = config.onStatus;
    this.publishUpdate = config.publishUpdate;
    this.progressTracker = config.progressTracker;
    this.runStore = config.runStore;
    this.policyEngine = config.policyEngine;
    this.resolvePolicyScope = config.resolvePolicyScope;
    this.telemetry = config.telemetry;
    this.notifier = config.notifier;
    this.resolveStopHookRuntime = config.resolveStopHookRuntime;
    this.effectLedger = config.effectLedger;
    this.incidentDiagnostics = config.incidentDiagnostics;
    this.faultInjector = config.faultInjector;
    this.logger = config.logger ?? silentLogger;
    this.traceProviderPayloads = config.traceProviderPayloads ?? false;
    this.instanceId =
      config.instanceId ??
      `background-supervisor-${Math.random().toString(36).slice(2, 10)}`;
    this.now = config.now ?? (() => Date.now());
    this.workerPools = sanitizeWorkerPools(config.workerPools);
    // Default to 8 concurrent cycles per worker. The dispatch pump
    // runs this many in parallel (see `pumpDispatchQueue`). Pre-8
    // default was 1, which meant a single long cycle serialized
    // every other session's scheduled wake-up. 8 is comfortably
    // below typical per-host socket limits for outbound HTTPS and
    // leaves headroom for MCP + tool I/O. Operators can override
    // via `autonomy.backgroundRuns.workerMaxConcurrentRuns`.
    this.workerMaxConcurrentRuns = Math.max(
      1,
      Math.floor(config.workerMaxConcurrentRuns ?? 8),
    );
    this.wakeBus = new BackgroundRunWakeBus({
      runStore: this.runStore,
      logger: this.logger,
      now: this.now,
      onWakeReady: async (sessionId) => {
        await this.enqueueDispatchForSession({
          sessionId,
          reason: "external_event",
          preferredWorkerId:
            this.activeRuns.get(sessionId)?.preferredWorkerId ?? this.instanceId,
        });
      },
    });
    void this.heartbeatWorker().catch((error) => {
      this.logger.debug("Initial background worker heartbeat failed", {
        workerId: this.instanceId,
        error: toErrorMessage(error),
      });
    });
    void this.armDispatchLoop().catch((error) => {
      this.logger.debug("Initial background dispatch loop failed", {
        workerId: this.instanceId,
        error: toErrorMessage(error),
      });
    });
  }

  private emitCycleTrace(
    run: ActiveBackgroundRun,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.traceProviderPayloads) return;
    logStructuredTraceEvent({
      logger: this.logger,
      traceLabel: "background_run.cycle",
      traceId: `background:${run.sessionId}:${run.id}:${run.cycleCount}:cycle`,
      sessionId: run.sessionId,
      staticFields: {
        runId: run.id,
        cycleCount: run.cycleCount,
      },
      eventType,
      payload,
    });
  }

  private summarizeActorResult(
    actorResult: ChatExecutorResult | undefined,
  ): Record<string, unknown> {
    if (!actorResult) {
      return { present: false };
    }
    return {
      present: true,
      stopReason: actorResult.stopReason,
      stopReasonDetail: actorResult.stopReasonDetail,
      usedFallback: actorResult.usedFallback,
      toolCalls: actorResult.toolCalls.map((toolCall) => ({
        name: toolCall.name,
        isError: toolCall.isError,
        durationMs: toolCall.durationMs,
      })),
      plannerSummary: actorResult.plannerSummary
        ? {
          used: actorResult.plannerSummary.used,
          plannerCalls: actorResult.plannerSummary.plannerCalls,
          routeReason: actorResult.plannerSummary.routeReason,
          plannedSteps: actorResult.plannerSummary.plannedSteps,
          deterministicStepsExecuted:
            actorResult.plannerSummary.deterministicStepsExecuted,
          diagnostics: actorResult.plannerSummary.diagnostics,
        }
        : undefined,
    };
  }

  hasActiveRun(sessionId: string): boolean {
    const run = this.activeRuns.get(sessionId);
    return run !== undefined && !isTerminalAgentRunState(run.state);
  }

  getStatusSnapshot(sessionId: string): BackgroundRunStatusSnapshot | undefined {
    const run = this.activeRuns.get(sessionId);
    if (!run) return this.statusSnapshots.get(sessionId);
    const scheduledCheckCount =
      run.state === "working" && run.nextCheckAt !== undefined ? 1 : 0;
    return toStatusSnapshot({
      run,
      pendingSignals:
        run.pendingSignals.length +
        this.wakeBus.getQueuedCount(sessionId) +
        scheduledCheckCount,
    });
  }

  async getRecentSnapshot(
    sessionId: string,
  ): Promise<BackgroundRunRecentSnapshot | undefined> {
    const active = this.activeRuns.get(sessionId);
    if (active) return toRecentSnapshot(active, this.wakeBus.getQueuedCount(sessionId));
    return this.runStore.loadRecentSnapshot(sessionId);
  }

  async loadRunRecord(
    sessionId: string,
  ): Promise<PersistedBackgroundRun | undefined> {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      return toPersistedRun(active);
    }
    const persisted = await this.runStore.loadRun(sessionId);
    if (persisted) {
      return persisted;
    }
    return this.runStore.loadCheckpoint(sessionId);
  }

  async listRunRecords(): Promise<readonly PersistedBackgroundRun[]> {
    const [persisted, checkpoints] = await Promise.all([
      this.runStore.listRuns(),
      this.runStore.listCheckpoints(),
    ]);
    const bySessionId = new Map<string, PersistedBackgroundRun>();
    for (const run of persisted) {
      bySessionId.set(run.sessionId, run);
    }
    for (const run of checkpoints) {
      if (!bySessionId.has(run.sessionId)) {
        bySessionId.set(run.sessionId, run);
      }
    }
    for (const run of this.activeRuns.values()) {
      bySessionId.set(run.sessionId, toPersistedRun(run));
    }
    return [...bySessionId.values()];
  }

  async updateRunLineage(
    sessionId: string,
    lineage: BackgroundRunLineage,
  ): Promise<void> {
    assertValidBackgroundRunLineage(lineage);
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.lineage = lineage;
      active.updatedAt = this.now();
      await this.persistRun(active, {
        type: "subrun_joined",
        summary: truncate(`Updated durable run lineage for ${active.id}.`, 200),
        timestamp: this.now(),
        data: {
          role: lineage.role,
          rootRunId: lineage.rootRunId,
          parentRunId: lineage.parentRunId,
          childRunIds: [...lineage.childRunIds],
        },
      });
      return;
    }
    const persisted = await this.runStore.loadRun(sessionId);
    if (!persisted) {
      throw new Error(`Background run "${sessionId}" not found`);
    }
    const updatedRun: PersistedBackgroundRun = {
      ...persisted,
      lineage,
      updatedAt: this.now(),
    };
    await this.runStore.saveRun(updatedRun);
    await this.runStore.saveRecentSnapshot(
      toRecentSnapshot(toActiveRun(updatedRun), await this.runStore.getQueuedWakeEventCount(sessionId)),
    );
    await this.runStore.appendEvent(updatedRun, {
      type: "subrun_joined",
      summary: truncate(`Updated durable run lineage for ${updatedRun.id}.`, 200),
      timestamp: this.now(),
      data: {
        role: lineage.role,
        rootRunId: lineage.rootRunId,
        parentRunId: lineage.parentRunId,
        childRunIds: [...lineage.childRunIds],
      },
    });
  }

  async appendRunEvent(
    sessionId: string,
    event: BackgroundRunEvent,
  ): Promise<void> {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      await this.persistRun(active, event);
      return;
    }
    const persisted = await this.loadRunRecord(sessionId);
    if (!persisted) {
      throw new Error(`Background run "${sessionId}" not found`);
    }
    await this.runStore.appendEvent(persisted, event);
    if (this.notifier?.isEnabled()) {
      const detail = await this.getOperatorDetail(sessionId, 1);
      if (detail) {
        await this.notifier.notify({
          occurredAt: event.timestamp,
          internalEventType: event.type,
          summary: event.summary,
          run: detail,
        });
      }
    }
  }

  getFleetStatusSnapshot(): BackgroundRunFleetStatusSnapshot {
    const stateCounts: Record<BackgroundRunState, number> = {
      pending: 0,
      running: 0,
      working: 0,
      blocked: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      suspended: 0,
    };
    const mergedSnapshots = new Map<string, BackgroundRunStatusSnapshot>();
    for (const [sessionId, snapshot] of this.statusSnapshots.entries()) {
      mergedSnapshots.set(sessionId, snapshot);
    }
    for (const [sessionId] of this.activeRuns.entries()) {
      mergedSnapshots.set(sessionId, this.getStatusSnapshot(sessionId)!);
    }

    let activeTotal = 0;
    let queuedSignalsTotal = 0;
    for (const snapshot of mergedSnapshots.values()) {
      stateCounts[snapshot.state] += 1;
      queuedSignalsTotal += snapshot.pendingSignals;
      if (!isTerminalAgentRunState(snapshot.state)) {
        activeTotal += 1;
      }
    }

    return {
      activeTotal,
      stateCounts,
      queuedSignalsTotal,
      recentAlerts: [...this.recentAlerts],
    };
  }

  async listOperatorSummaries(
    sessionIds?: readonly string[],
  ): Promise<readonly BackgroundRunOperatorSummary[]> {
    const filter = sessionIds ? new Set(sessionIds) : undefined;
    const [recentSnapshots, persistedRuns] = await Promise.all([
      this.runStore.listRecentSnapshots(),
      this.runStore.listRuns(),
    ]);
    const sessionIdSet = new Set<string>();
    for (const snapshot of recentSnapshots) {
      if (!filter || filter.has(snapshot.sessionId)) {
        sessionIdSet.add(snapshot.sessionId);
      }
    }
    for (const run of persistedRuns) {
      if (!filter || filter.has(run.sessionId)) {
        sessionIdSet.add(run.sessionId);
      }
    }
    for (const sessionId of this.activeRuns.keys()) {
      if (!filter || filter.has(sessionId)) {
        sessionIdSet.add(sessionId);
      }
    }

    const details = await Promise.all(
      [...sessionIdSet].map(async (sessionId) => {
        const detail = await this.getOperatorDetail(sessionId);
        return detail;
      }),
    );
    return details
      .filter(
        (detail): detail is BackgroundRunOperatorDetail => detail !== undefined,
      )
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async getOperatorDetail(
    sessionId: string,
    eventLimit = 16,
  ): Promise<BackgroundRunOperatorDetail | undefined> {
    const activeRun = this.activeRuns.get(sessionId);
    const [persistedRun, checkpoint, recentSnapshot] = await Promise.all([
      activeRun ? Promise.resolve<PersistedBackgroundRun | undefined>(toPersistedRun(activeRun)) : this.runStore.loadRun(sessionId),
      this.runStore.loadCheckpoint(sessionId),
      activeRun
        ? Promise.resolve<BackgroundRunRecentSnapshot | undefined>(
          toRecentSnapshot(activeRun, this.wakeBus.getQueuedCount(sessionId)),
        )
        : this.runStore.loadRecentSnapshot(sessionId),
    ]);
    const durableRun = activeRun
      ? toPersistedRun(activeRun)
      : persistedRun ?? checkpoint;
    const snapshot =
      recentSnapshot ??
      (durableRun ? toRecentSnapshot(toActiveRun(durableRun), 0) : undefined);
    if (!durableRun || !snapshot) {
      return undefined;
    }
    const [eventEntries, recentEffects] = await Promise.all([
      this.runStore.listEvents(durableRun.id, eventLimit),
      this.effectLedger?.listRunEffects(durableRun.id, eventLimit),
    ]);
    const summary = toOperatorSummary({
      snapshot,
      contract: durableRun.contract,
      blocker: durableRun.blocker,
      approvalState: durableRun.approvalState,
      checkpointAvailable: checkpoint !== undefined,
      now: this.now(),
    });

    return {
      ...summary,
      policyScope: durableRun.policyScope,
      contract: durableRun.contract,
      blocker: durableRun.blocker,
      approval: durableRun.approvalState,
      budget: durableRun.budgetState,
      compaction: durableRun.compaction,
      artifacts: durableRun.carryForward?.artifacts ?? [],
      observedTargets: durableRun.observedTargets,
      watchRegistrations: durableRun.watchRegistrations,
      completionProgress: durableRun.completionProgress,
      recentEvents: [
        ...toOperatorEventRecords(eventEntries),
        ...(recentEffects ? toOperatorEffectEventRecords(recentEffects) : []),
      ].sort((left, right) => right.timestamp - left.timestamp).slice(0, eventLimit),
    };
  }

  async applyOperatorControl(
    action: BackgroundRunControlAction,
  ): Promise<BackgroundRunOperatorDetail | undefined> {
    switch (action.action) {
      case "pause":
        await this.pauseRun(action.sessionId, action.reason);
        break;
      case "resume":
        await this.resumeRun(action.sessionId, action.reason);
        break;
      case "stop":
        await this.stopRun(action.sessionId, action.reason);
        break;
      case "cancel":
        await this.cancelRun(action.sessionId, action.reason);
        break;
      case "edit_objective":
        await this.updateRunObjective(
          action.sessionId,
          action.objective,
          action.reason,
        );
        break;
      case "amend_constraints":
        await this.amendRunConstraints(
          action.sessionId,
          action.constraints,
          action.reason,
        );
        break;
      case "adjust_budget":
        await this.adjustRunBudget(
          action.sessionId,
          action.budget,
          action.reason,
        );
        break;
      case "force_compact":
        await this.forceCompactRun(action.sessionId, action.reason);
        break;
      case "reassign_worker":
        await this.reassignRunWorker(
          action.sessionId,
          action.worker,
          action.reason,
        );
        break;
      case "retry_from_checkpoint":
        await this.retryRunFromCheckpoint(action.sessionId, action.reason);
        break;
      case "retry_from_step":
        await this.retryRunFromStep(action.sessionId, {
          stepName: action.stepName,
          traceId: action.traceId,
          reason: action.reason,
        });
        break;
      case "retry_from_trace":
        await this.retryRunFromTrace(action.sessionId, {
          traceId: action.traceId,
          stepName: action.stepName,
          reason: action.reason,
        });
        break;
      case "fork_from_checkpoint":
        await this.forkRunFromCheckpoint(action.sessionId, {
          targetSessionId: action.targetSessionId,
          objective: action.objective,
          reason: action.reason,
        });
        return this.getOperatorDetail(action.targetSessionId);
      case "verification_override":
        await this.applyVerificationOverride(action.sessionId, action.override);
        break;
    }
    return this.getOperatorDetail(action.sessionId);
  }

  private isActiveRun(run: ActiveBackgroundRun): boolean {
    return this.activeRuns.get(run.sessionId) === run;
  }

  private rememberStatusSnapshot(
    run: ActiveBackgroundRun,
    queuedWakeCount = 0,
    extraPendingCount = 0,
  ): void {
    const scheduledCheckCount =
      run.state === "working" && run.nextCheckAt !== undefined ? 1 : 0;
    this.statusSnapshots.set(
      run.sessionId,
      toStatusSnapshot({
        run,
        pendingSignals:
          run.pendingSignals.length +
          queuedWakeCount +
          scheduledCheckCount +
          extraPendingCount,
      }),
    );
  }

  private resolveRunPolicyScope(
    run: ActiveBackgroundRun,
  ): PolicyEvaluationScope | undefined {
    const resolved =
      run.policyScope ??
      this.resolvePolicyScope?.({
        sessionId: run.sessionId,
        runId: run.id,
      });
    if (!resolved) {
      return undefined;
    }
    run.policyScope = {
      ...resolved,
      runId: resolved.runId ?? run.id,
      sessionId: resolved.sessionId ?? run.sessionId,
      channel: resolved.channel ?? "webchat",
    };
    return run.policyScope;
  }

  private async buildScopedManagedProcessCounts(
    run: ActiveBackgroundRun,
  ): Promise<Partial<Record<"global" | "tenant" | "project" | "run", number>>> {
    const scope = this.resolveRunPolicyScope(run);
    const persistedRuns = await this.runStore.listRuns();
    const mergedRuns = new Map<string, PersistedBackgroundRun>();
    for (const persisted of persistedRuns) {
      mergedRuns.set(persisted.sessionId, persisted);
    }
    for (const activeRun of this.activeRuns.values()) {
      refreshDerivedBudgetState(activeRun);
      mergedRuns.set(activeRun.sessionId, toPersistedRun(activeRun));
    }
    refreshDerivedBudgetState(run);
    mergedRuns.set(run.sessionId, toPersistedRun(run));

    const countFor = (
      matcher: (candidate: PersistedBackgroundRun) => boolean,
    ): number => {
      let total = 0;
      for (const candidate of mergedRuns.values()) {
        if (isTerminalAgentRunState(candidate.state) || !matcher(candidate)) {
          continue;
        }
        total += candidate.budgetState.managedProcessCount;
      }
      return total;
    };

    return {
      global: countFor(() => true),
      tenant: scope?.tenantId
        ? countFor((candidate) => candidate.policyScope?.tenantId === scope.tenantId)
        : undefined,
      project: scope?.projectId
        ? countFor((candidate) => candidate.policyScope?.projectId === scope.projectId)
        : undefined,
      run: run.budgetState.managedProcessCount,
    };
  }

  private buildPolicyBudgetDecision(
    decision: PolicyDecision,
  ): BackgroundRunDecision {
    const primaryViolation = decision.violations[0];
    const details = primaryViolation?.details ?? {};
    const scopeLabel =
      typeof details.scope === "string" ? details.scope : "runtime";

    if (primaryViolation?.code === "process_budget_exceeded") {
      return {
        state: "working",
        userUpdate:
          `Background run is waiting for available managed-process capacity (${scopeLabel} scope).`,
        internalSummary: primaryViolation.message,
        nextCheckMs: DEFAULT_DISPATCH_RETRY_MS,
        shouldNotifyUser: true,
      };
    }

    const failureMessage = (() => {
      switch (primaryViolation?.code) {
        case "token_budget_exceeded":
          return "Background run exhausted its token budget before the objective completed.";
        case "runtime_budget_exceeded":
          return "Background run exceeded its runtime budget before the objective completed.";
        case "action_budget_exceeded":
          return "Background run exhausted its action budget before the objective completed.";
        case "spend_budget_exceeded":
          return "Background run exhausted its spend budget before the objective completed.";
        default:
          return primaryViolation?.message ?? "Background run was blocked by runtime policy.";
      }
    })();

    return {
      state: "failed",
      userUpdate: failureMessage,
      internalSummary: primaryViolation?.message ?? failureMessage,
      shouldNotifyUser: true,
    };
  }

  private buildSupervisorPolicyAction(params: {
    run: ActiveBackgroundRun;
    tokenCount?: number;
    processCounts: Partial<Record<"global" | "tenant" | "project" | "run", number>>;
  }) {
    const scope = this.resolveRunPolicyScope(params.run);
    if (!scope) {
      return undefined;
    }
    const elapsedRuntimeMs = Math.max(
      0,
      this.now() - params.run.budgetState.runtimeStartedAt,
    );
    return {
      type: "task_execution" as const,
      name: "background_run.supervision",
      access: "write" as const,
      scope,
      budgetConsumptionMode:
        params.tokenCount !== undefined
          ? ("post_hoc_actual" as const)
          : ("preflight" as const),
      ...(params.tokenCount !== undefined ? { tokenCount: params.tokenCount } : {}),
      elapsedRuntimeMs,
      elapsedRuntimeMsByScope: {
        global: elapsedRuntimeMs,
        tenant: elapsedRuntimeMs,
        project: elapsedRuntimeMs,
        run: elapsedRuntimeMs,
      },
      processCount: params.processCounts.global ?? params.run.budgetState.managedProcessCount,
      processCountByScope: params.processCounts,
      metadata: {
        runId: params.run.id,
        sessionId: params.run.sessionId,
        domain: params.run.contract.domain,
        contractKind: params.run.contract.kind,
      },
    };
  }

  private async evaluateRunGovernance(
    run: ActiveBackgroundRun,
    params: { tokenCount?: number },
  ): Promise<BackgroundRunDecision | undefined> {
    if (!this.policyEngine) {
      return undefined;
    }
    const processCounts = await this.buildScopedManagedProcessCounts(run);
    const action = this.buildSupervisorPolicyAction({
      run,
      tokenCount: params.tokenCount,
      processCounts,
    });
    if (!action) {
      return undefined;
    }
    const decision = this.policyEngine.evaluate(action);
    return decision.allowed ? undefined : this.buildPolicyBudgetDecision(decision);
  }

  private recordRunTelemetry(
    metricName: string,
    value: number,
    run: ActiveBackgroundRun,
    extraLabels?: Record<string, string>,
  ): void {
    this.telemetry?.histogram(metricName, value, {
      domain: run.contract.domain,
      contract_kind: run.contract.kind,
      ...(extraLabels ?? {}),
    });
  }

  private incrementRunTelemetryCounter(
    metricName: string,
    run: ActiveBackgroundRun,
    extraLabels?: Record<string, string>,
  ): void {
    this.telemetry?.counter(metricName, 1, {
      domain: run.contract.domain,
      contract_kind: run.contract.kind,
      ...(extraLabels ?? {}),
    });
  }

  private updateActiveGauge(): void {
    const byDomain = new Map<string, number>();
    for (const run of this.activeRuns.values()) {
      byDomain.set(run.contract.domain, (byDomain.get(run.contract.domain) ?? 0) + 1);
    }
    this.telemetry?.gauge(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_ACTIVE_TOTAL,
      this.activeRuns.size,
      { scope: "all" },
    );
    for (const [domain, count] of byDomain.entries()) {
      this.telemetry?.gauge(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_ACTIVE_TOTAL,
        count,
        { scope: "domain", domain },
      );
    }
  }

  private recordAlert(params: {
    severity: "info" | "warn" | "error";
    code: string;
    message: string;
    run?: Pick<ActiveBackgroundRun, "id" | "sessionId">;
  }): void {
    const alert: BackgroundRunAlert = {
      id: `${params.code}:${this.now()}:${Math.random().toString(36).slice(2, 8)}`,
      severity: params.severity,
      code: params.code,
      message: truncate(params.message, 240),
      createdAt: this.now(),
      sessionId: params.run?.sessionId,
      runId: params.run?.id,
    };
    this.recentAlerts.unshift(alert);
    if (this.recentAlerts.length > MAX_BACKGROUND_RUN_ALERTS) {
      this.recentAlerts.length = MAX_BACKGROUND_RUN_ALERTS;
    }
  }

  private getRuntimeMode(): RuntimeDependencyMode {
    return this.incidentDiagnostics?.getSnapshot().runtimeMode ?? "healthy";
  }

  private isSafeModeActive(): boolean {
    return this.getRuntimeMode() === "safe_mode";
  }

  private reportIncident(params: {
    domain: RuntimeDependencyDomain;
    mode: Exclude<RuntimeDependencyMode, "healthy">;
    severity: "warn" | "error";
    code: string;
    message: string;
    run?: Pick<ActiveBackgroundRun, "id" | "sessionId">;
  }): void {
    this.incidentDiagnostics?.report({
      domain: params.domain,
      mode: params.mode,
      severity: params.severity,
      code: params.code,
      message: params.message,
      ...(params.run?.sessionId ? { sessionId: params.run.sessionId } : {}),
      ...(params.run?.id ? { runId: params.run.id } : {}),
    });
    this.recordAlert({
      severity: params.severity,
      code: params.code,
      message: params.message,
      run: params.run,
    });
  }

  private maybeInjectFault(
    point: FaultInjectionPoint,
    params?: {
      run?: Pick<ActiveBackgroundRun, "id" | "sessionId">;
      operation?: string;
      provider?: string;
    },
  ): void {
    this.faultInjector?.maybeThrow({
      point,
      ...(params?.run?.sessionId ? { sessionId: params.run.sessionId } : {}),
      ...(params?.run?.id ? { runId: params.run.id } : {}),
      ...(params?.operation ? { operation: params.operation } : {}),
      ...(params?.provider ? { provider: params.provider } : {}),
    });
  }

  private classifyFaultDomain(error: unknown): RuntimeDependencyDomain | undefined {
    if (error instanceof FaultInjectionError) {
      switch (error.point) {
        case "provider_timeout":
          return "provider";
        case "tool_timeout":
          return "tool";
        case "persistence_failure":
          return "persistence";
        case "approval_store_failure":
          return "approval_store";
        case "child_run_crash":
          return "child_run";
        case "daemon_restart":
          return "daemon";
      }
    }
    return undefined;
  }

  private forgetStatusSnapshot(sessionId: string): void {
    this.statusSnapshots.delete(sessionId);
  }

  private async heartbeatWorker(): Promise<void> {
    if (this.workerHeartbeatTimer) {
      clearTimeout(this.workerHeartbeatTimer);
      this.workerHeartbeatTimer = null;
    }
    const leasedRuns = [...this.activeRuns.values()].filter(
      (run) => run.leaseOwnerId === this.instanceId,
    );
    const inFlightRuns = leasedRuns.filter((run) => run.state === "running");
    await this.runStore.heartbeatWorker({
      workerId: this.instanceId,
      pools: this.workerPools,
      maxConcurrentRuns: this.workerMaxConcurrentRuns,
      state: this.workerDraining ? "draining" : "active",
      currentSessionIds: inFlightRuns.map((run) => run.sessionId),
      affinityKeys: leasedRuns.map((run) => resolveWorkerAffinityKey(run)),
      now: this.now(),
    });
    await this.runStore.garbageCollect({ now: this.now() });
    await this.armDispatchLoop();
    this.workerHeartbeatTimer = setTimeout(() => {
      void this.heartbeatWorker().catch((error) => {
        this.logger.debug("Background worker heartbeat failed", {
          workerId: this.instanceId,
          error: toErrorMessage(error),
        });
      });
    }, DEFAULT_WORKER_HEARTBEAT_MS);
  }

  private async armDispatchLoop(): Promise<void> {
    if (this.dispatchPumpRunning || this.workerDraining) {
      return;
    }
    const beacon = await this.runStore.loadDispatchBeacon();
    const nextAvailableAt = beacon.nextAvailableAt;
    if (nextAvailableAt === undefined) {
      if (this.dispatchTimer) {
        clearTimeout(this.dispatchTimer);
        this.dispatchTimer = null;
      }
      this.scheduledDispatchAt = undefined;
      this.lastDispatchBeaconRevision = beacon.revision;
      return;
    }
    if (
      this.dispatchTimer &&
      this.scheduledDispatchAt === nextAvailableAt &&
      this.lastDispatchBeaconRevision === beacon.revision
    ) {
      return;
    }
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    const delayMs = Math.max(0, nextAvailableAt - this.now());
    this.scheduledDispatchAt = nextAvailableAt;
    this.lastDispatchBeaconRevision = beacon.revision;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.scheduledDispatchAt = undefined;
      void this.pumpDispatchQueue().catch((error) => {
        this.logger.debug("Background worker dispatch pump failed", {
          workerId: this.instanceId,
          error: toErrorMessage(error),
        });
      });
    }, delayMs);
  }

  private async pumpDispatchQueue(): Promise<void> {
    if (this.dispatchPumpRunning || this.workerDraining) {
      return;
    }
    this.dispatchPumpRunning = true;
    try {
      await this.heartbeatWorker();
      // Concurrent dispatch: the pump claims up to
      // `workerMaxConcurrentRuns` dispatches and runs them in
      // parallel via `handleClaimedDispatch`. Whenever a slot frees,
      // we try to claim more. Without this, a single long cycle
      // (subagent tool loops are the typical offender) would block
      // every other session's scheduled wake even though JS I/O
      // awaits in the cycle already yield to the event loop —
      // concurrent sessions would run fine, the bottleneck is
      // strictly the old serial claim→await loop below.
      while (!this.workerDraining) {
        while (
          !this.workerDraining &&
          this.inFlightDispatches.size < this.workerMaxConcurrentRuns
        ) {
          const claim = await this.runStore.claimDispatchForWorker({
            workerId: this.instanceId,
            pools: this.workerPools,
            now: this.now(),
          });
          if (!claim.claimed || !claim.item) {
            break;
          }
          const item = claim.item;
          // Per-session serialization: if we already have an
          // in-flight dispatch for this session (e.g. a late signal
          // claim racing with an already-running timer claim),
          // release the duplicate back to the queue instead of
          // double-running the cycle.
          if (this.inFlightSessionIds.has(item.sessionId)) {
            await this.runStore.releaseDispatch({
              dispatchId: item.id,
              workerId: this.instanceId,
              now: this.now(),
              availableAt: this.now() + DEFAULT_DISPATCH_RETRY_MS,
              preferredWorkerId: item.preferredWorkerId,
            });
            continue;
          }
          this.inFlightSessionIds.add(item.sessionId);
          const inFlight = (async () => {
            try {
              await this.handleClaimedDispatch(item);
            } finally {
              this.inFlightSessionIds.delete(item.sessionId);
              try {
                await this.heartbeatWorker();
              } catch {
                // Heartbeat failures are logged inside
                // `heartbeatWorker`'s call sites; ignore here so the
                // slot still frees for the next claim.
              }
            }
          })();
          this.inFlightDispatches.add(inFlight);
          inFlight.finally(() => {
            this.inFlightDispatches.delete(inFlight);
          });
        }
        if (this.inFlightDispatches.size === 0) {
          // Nothing in flight AND no new items claimed → queue drained.
          break;
        }
        // Wait until at least one in-flight dispatch finishes before
        // attempting the next claim round. `Promise.race` returns on
        // the first settle (fulfill or reject); individual error
        // handling is inside `handleClaimedDispatch`.
        await Promise.race(this.inFlightDispatches).catch(() => undefined);
      }
      // Drain any still-in-flight dispatches before marking the pump
      // idle so callers that await `pumpDispatchQueue` see the true
      // completion boundary.
      if (this.inFlightDispatches.size > 0) {
        await Promise.allSettled(this.inFlightDispatches);
      }
    } finally {
      this.dispatchPumpRunning = false;
      this.scheduledDispatchAt = undefined;
      await this.armDispatchLoop();
    }
  }

  private async handleClaimedDispatch(
    item: BackgroundRunDispatchItem,
  ): Promise<void> {
    try {
      if (this.isSafeModeActive()) {
        await this.runStore.releaseDispatch({
          dispatchId: item.id,
          workerId: this.instanceId,
          now: this.now(),
          availableAt: this.now() + DEFAULT_DISPATCH_RETRY_MS,
          preferredWorkerId: item.preferredWorkerId,
        });
        return;
      }
      const run = await this.ensureRunLoaded(item.sessionId);
      if (!run) {
        await this.runStore.completeDispatch({
          dispatchId: item.id,
          workerId: this.instanceId,
          now: this.now(),
        });
        return;
      }
      await this.runStore.pruneDispatchesForSession({
        sessionId: item.sessionId,
        excludeDispatchId: item.id,
        now: this.now(),
      });
      run.preferredWorkerId = this.instanceId;
      run.workerAffinityKey = resolveWorkerAffinityKey(run);
      await this.persistRun(run);
      this.maybeInjectFault("child_run_crash", {
        run,
        operation: "execute_cycle",
      });
      await this.executeCycle(item.sessionId);
      await this.runStore.completeDispatch({
        dispatchId: item.id,
        workerId: this.instanceId,
        now: this.now(),
      });
    } catch (error) {
      this.logger.debug("Background dispatch execution failed", {
        workerId: this.instanceId,
        dispatchId: item.id,
        sessionId: item.sessionId,
        error: toErrorMessage(error),
      });
      const domain = this.classifyFaultDomain(error);
      if (domain) {
        this.reportIncident({
          domain,
          mode: domain === "persistence" || domain === "approval_store"
            ? "safe_mode"
            : "degraded",
          severity: "error",
          code: `${domain}_failure`,
          message: toErrorMessage(error),
        });
      }
      await this.runStore.releaseDispatch({
        dispatchId: item.id,
        workerId: this.instanceId,
        now: this.now(),
        availableAt: this.now() + DEFAULT_DISPATCH_RETRY_MS,
        preferredWorkerId: item.preferredWorkerId,
      });
    }
  }

  private async ensureRunLoaded(
    sessionId: string,
  ): Promise<ActiveBackgroundRun | undefined> {
    if (this.terminatingSessions.has(sessionId)) {
      return undefined;
    }
    const active = this.activeRuns.get(sessionId);
    if (active) {
      return active;
    }
    const lease = await this.runStore.claimLease(
      sessionId,
      this.instanceId,
      this.now(),
    );
    if (!lease.claimed || !lease.run) {
      return undefined;
    }
    const run = toActiveRun(lease.run);
    if (run.state === "running" || run.state === "suspended") {
      assertAgentRunStateTransition(
        run.state,
        "working",
        "ensureRunLoaded recovery",
      );
      run.state = "working";
      run.updatedAt = this.now();
      run.nextCheckAt = this.now();
      run.nextHeartbeatAt = undefined;
      run.lastWakeReason = "recovery";
    }
    run.preferredWorkerId = this.instanceId;
    run.workerAffinityKey = resolveWorkerAffinityKey(run);
    run.policyScope = this.resolveRunPolicyScope(run);
    this.activeRuns.set(sessionId, run);
    await this.wakeBus.recoverSession(sessionId);
    return run;
  }

  private async enqueueDispatchForSession(params: {
    sessionId: string;
    reason:
      | BackgroundRunWakeReason
      | "resume"
      | "heartbeat"
      | "recovery"
      | "admission_retry";
    availableAt?: number;
    priority?: number;
    preferredWorkerId?: string;
  }): Promise<void> {
    const run =
      this.activeRuns.get(params.sessionId) ??
      (await this.runStore.loadRun(params.sessionId));
    if (!run) {
      return;
    }
    const pool = resolveWorkerPool(run);
    const dispatchStats = await this.runStore.getDispatchStats();
    const saturated =
      dispatchStats.totalQueued >= DEFAULT_DISPATCH_QUEUE_MAX_TOTAL ||
      dispatchStats.queuedByPool[pool] >= DEFAULT_DISPATCH_QUEUE_MAX_PER_POOL[pool];
    const dispatchReason =
      saturated && params.reason !== "admission_retry"
        ? "admission_retry"
        : params.reason;
    const availableAt =
      saturated && params.reason !== "admission_retry"
        ? Math.max(params.availableAt ?? this.now(), this.now() + DEFAULT_DISPATCH_RETRY_MS)
        : params.availableAt;
    if (dispatchReason === "admission_retry") {
      this.logger.debug("Background dispatch deferred by admission control", {
        sessionId: params.sessionId,
        pool,
        totalQueued: dispatchStats.totalQueued,
        queuedInPool: dispatchStats.queuedByPool[pool],
      });
    }
    await this.runStore.enqueueDispatch({
      sessionId: params.sessionId,
      runId: run.id,
      pool,
      reason: dispatchReason,
      createdAt: this.now(),
      availableAt,
      priority: params.priority,
      dedupeKey: `dispatch:${params.sessionId}:${dispatchReason}`,
      preferredWorkerId:
        params.preferredWorkerId ?? run.preferredWorkerId ?? this.instanceId,
      affinityKey: resolveWorkerAffinityKey(run),
      data: {
        runId: run.id,
        sessionId: params.sessionId,
        reason: dispatchReason,
      },
    });
    const readyAt = availableAt ?? this.now();
    if (!this.workerDraining && readyAt <= this.now()) {
      queueMicrotask(() => {
        void this.pumpDispatchQueue().catch((error) => {
          this.logger.debug("Immediate background dispatch failed", {
            sessionId: params.sessionId,
            workerId: this.instanceId,
            error: toErrorMessage(error),
          });
        });
      });
      return;
    }
    await this.armDispatchLoop();
  }

  async recoverRuns(): Promise<number> {
    try {
      this.maybeInjectFault("daemon_restart", { operation: "recover_runs" });
      await this.heartbeatWorker();
      await this.runStore.garbageCollect({ now: this.now() });
      const persistedRuns = await this.runStore.listRuns();
      const activeWorkers = new Map(
        (await this.runStore.listWorkers())
          .filter(
            (worker) =>
              worker.lastHeartbeatAt + worker.heartbeatTtlMs > this.now() &&
              worker.state === "active",
          )
          .map((worker) => [worker.workerId, worker] as const),
      );
      let recovered = 0;
      for (const persistedRun of persistedRuns) {
      if (isTerminalAgentRunState(persistedRun.state)) {
        await this.runStore.deleteRun(persistedRun.sessionId);
        continue;
      }
      if (
        persistedRun.preferredWorkerId &&
        persistedRun.preferredWorkerId !== this.instanceId &&
        activeWorkers.has(persistedRun.preferredWorkerId)
      ) {
        continue;
      }
      const lease = await this.runStore.claimLease(
        persistedRun.sessionId,
        this.instanceId,
        this.now(),
      );
      if (!lease.claimed || !lease.run) {
        continue;
      }
      const run = toActiveRun(lease.run);
      if (
        (run.state === "running" || run.state === "suspended") &&
        (!run.leaseOwnerId ||
          run.leaseOwnerId === this.instanceId ||
          (run.leaseExpiresAt !== undefined && run.leaseExpiresAt <= this.now()))
      ) {
        assertAgentRunStateTransition(
          run.state,
          "working",
          "recover persisted run",
        );
        run.state = "working";
        run.updatedAt = this.now();
        run.nextCheckAt = this.now();
        run.nextHeartbeatAt = undefined;
        run.lastWakeReason = "recovery";
        run.leaseOwnerId = undefined;
        run.leaseExpiresAt = undefined;
      }
      run.preferredWorkerId = run.preferredWorkerId ?? this.instanceId;
      run.workerAffinityKey = resolveWorkerAffinityKey(run);
      run.policyScope = this.resolveRunPolicyScope(run);
      await this.runStore.saveRun(toPersistedRun(run));
      await this.runStore.saveRecentSnapshot(
        toRecentSnapshot(run, await this.runStore.getQueuedWakeEventCount(run.sessionId)),
      );
      this.rememberStatusSnapshot(
        run,
        await this.runStore.getQueuedWakeEventCount(run.sessionId),
      );
      await this.wakeBus.recoverSession(run.sessionId);
      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "run_recovered",
        summary: `Recovered background run: ${truncate(run.objective, 200)}`,
        timestamp: this.now(),
        data: { previousState: persistedRun.state },
      });
      this.incrementRunTelemetryCounter(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_RECOVERED_TOTAL,
        run,
      );
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_RECOVERY_SUCCESS_RATE,
        1,
        run,
      );
      this.incidentDiagnostics?.clearDomain("daemon");
      this.recordAlert({
        severity: "info",
        code: "run_recovered",
        message: `Recovered background run "${truncate(run.objective, 120)}".`,
        run,
      });
      if (run.state !== "paused") {
        const nextQueuedWakeAt = await this.runStore.getNextWakeAvailability(
          run.sessionId,
        );
        const hasReadyWake =
          nextQueuedWakeAt !== undefined && nextQueuedWakeAt <= this.now();
        const shouldQueue =
          run.pendingSignals.length > 0 ||
          hasReadyWake ||
          run.state !== "blocked" ||
          run.nextCheckAt !== undefined;
        if (shouldQueue) {
          await this.enqueueDispatchForSession({
            sessionId: run.sessionId,
            reason: "recovery",
            availableAt:
              run.pendingSignals.length > 0 || hasReadyWake
                ? this.now()
                : run.nextCheckAt,
            preferredWorkerId: run.preferredWorkerId,
          });
        }
      }
        recovered += 1;
      }
      this.updateActiveGauge();
      await this.armDispatchLoop();
      return recovered;
    } catch (error) {
      this.reportIncident({
        domain: "daemon",
        mode: "degraded",
        severity: "error",
        code: "daemon_restart_failure",
        message: toErrorMessage(error),
      });
      throw error;
    }
  }

  async startRun(params: StartBackgroundRunParams): Promise<BackgroundRunStatusSnapshot> {
    if (this.isSafeModeActive()) {
      throw new Error(
        "Background runs are paused because the runtime is in safe mode.",
      );
    }
    await this.cancelRun(params.sessionId, "Replaced by a new background run.");
    await this.runStore.deleteCheckpoint(params.sessionId);
    await this.runStore.resetConversationHistory(params.sessionId);
    if (params.options?.lineage) {
      assertValidBackgroundRunLineage(params.options.lineage);
    }

    const now = this.now();
    const contract =
      params.options?.contract ?? await this.planRunContract(
        params.objective,
        params.sessionId,
      );
    const initialShellProfile =
      params.options?.shellProfile ??
      params.options?.lineage?.shellProfile ??
      DEFAULT_SESSION_SHELL_PROFILE;
    const initialExecutionContext = await this.resolveExecutionContext?.({
      sessionId: params.sessionId,
      objective: params.objective,
      shellProfile: initialShellProfile,
      history: [],
    });
    const initialAnchorFiles = initialExecutionContext?.anchorRegistrations?.length
      ? await mergeAnchorRegistrations({
          sessionId: params.sessionId,
          existing: [],
          registrations: initialExecutionContext.anchorRegistrations,
          now,
        })
      : [];
    const run: ActiveBackgroundRun = {
      version: AGENT_RUN_SCHEMA_VERSION,
      id: `bg-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: params.sessionId,
      objective: params.objective.trim(),
      shellProfile:
        params.options?.shellProfile ??
        params.options?.lineage?.shellProfile ??
        DEFAULT_SESSION_SHELL_PROFILE,
      policyScope: undefined,
      contract,
      state: "pending",
      fenceToken: 1,
      createdAt: now,
      updatedAt: now,
      cycleCount: 0,
      stableWorkingCycles: 0,
      consecutiveErrorCycles: 0,
      mutatingEditsSinceLastVerifierSpawn: 0,
      // Infinity so the first verify_reminder is eligible to fire as
      // soon as the edit threshold is reached on a fresh run.
      assistantTurnsSinceLastVerifyReminder: Number.POSITIVE_INFINITY,
      cyclesSinceTaskTool: 0,
      consecutiveNudgeCycles: 0,
      anchorFiles: initialAnchorFiles,
      lastVerifiedAt: undefined,
      lastUserUpdate: undefined,
      lastToolEvidence: undefined,
      lastHeartbeatContent: undefined,
      lastWakeReason: "start",
      completionProgress: undefined,
      carryForward: undefined,
      interactiveContextState: undefined,
      continuationMode: undefined,
      verifierSessionId: undefined,
      verifierStage: "inactive",
      blocker: undefined,
      approvalState: { status: "none" },
      budgetState: buildInitialBudgetState(contract, now),
      compaction: buildInitialCompactionState(),
      pendingSignals: [],
      observedTargets: [],
      watchRegistrations: [],
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      internalHistory: [
        ...(
          params.options?.seedHistory?.slice(-6) ??
          this.seedHistoryForSession?.(params.sessionId)?.slice(-6) ??
          []
        ),
      ],
      lineage: params.options?.lineage,
      preferredWorkerId: this.instanceId,
      workerAffinityKey: `session:${params.sessionId}`,
      leaseOwnerId: undefined,
      leaseExpiresAt: undefined,
      timer: null,
      heartbeatTimer: null,
      abortController: null,
    };
    run.policyScope = this.resolveRunPolicyScope(run);
    await this.runStore.seedConversationHistory(
      params.sessionId,
      run.internalHistory,
    );

    await this.persistRun(run, {
      type: "run_started",
      summary: `Background run started: ${truncate(run.objective, 200)}`,
      timestamp: now,
      data: {
        contractKind: run.contract.kind,
        nextCheckMs: run.contract.nextCheckMs,
      },
    });
    await this.progressTracker?.append({
      sessionId: params.sessionId,
      type: "task_started",
      summary: truncate(`Background run started: ${run.objective}`, 200),
    });

    if (!params.options?.silent) {
      await this.publishUpdate(
        params.sessionId,
        "Started a background run for this session. I’ll keep working and send updates here until it completes or you tell me to stop.",
      );
      run.lastUserUpdate = truncate(
        "Started a background run for this session. I’ll keep working and send updates here until it completes or you tell me to stop.",
        MAX_USER_UPDATE_CHARS,
      );
    }
    run.budgetState = {
      ...run.budgetState,
      firstAcknowledgedAt: run.budgetState.firstAcknowledgedAt ?? this.now(),
    };
    const firstAcknowledgedAt = run.budgetState.firstAcknowledgedAt ?? now;
    this.incrementRunTelemetryCounter(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_STARTED_TOTAL,
      run,
    );
    this.recordRunTelemetry(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_TIME_TO_FIRST_ACK_MS,
      firstAcknowledgedAt - run.createdAt,
      run,
    );
    if (!params.options?.silent && run.lastUserUpdate) {
      await this.persistRun(run, {
        type: "user_update",
        summary: run.lastUserUpdate,
        timestamp: this.now(),
        data: {
          kind: "ack",
          verified: false,
        },
      });
    }
    this.updateActiveGauge();
    await this.enqueueDispatchForSession({
      sessionId: params.sessionId,
      reason: "start",
      availableAt: now,
      preferredWorkerId: this.instanceId,
    });
    return toStatusSnapshot({
      run,
      pendingSignals: 0,
    });
  }

  async signalRun(params: {
    sessionId: string;
    content: string;
    type?: Exclude<
      BackgroundRunWakeReason,
      "start" | "timer" | "busy_retry" | "recovery" | "daemon_shutdown"
    >;
    data?: Record<string, unknown>;
  }): Promise<boolean> {
    const content = params.content.trim();
    if (!content) return false;

    const activeRun = this.activeRuns.get(params.sessionId);
    const persistedRun = activeRun
      ? undefined
      : await this.runStore.loadRun(params.sessionId);
    const run = activeRun ?? (persistedRun ? toActiveRun(persistedRun) : undefined);
    if (!run) return false;

    const type = params.type ?? "user_input";
    const now = this.now();

    // Merge any new `@mention` anchors from the inbound signal so the
    // next cycle's actor has the referenced files pinned without
    // depending on rolling-history survival. Failures here must not
    // block signal delivery — anchor freshness is a best-effort
    // augmentation on top of the wake path.
    try {
      const workspaceRoot = resolveRunWorkspaceRoot(run);
      if (workspaceRoot) {
        const resolution = await resolveAtMentionAttachments({
          content,
          workspaceRoot,
        });
        if (resolution.anchorRegistrations.length > 0) {
          const mergedAnchors = await mergeAnchorRegistrations({
            sessionId: params.sessionId,
            existing: run.anchorFiles,
            registrations: resolution.anchorRegistrations,
            now,
          });
          run.anchorFiles = mergedAnchors;
        }
      }
    } catch {
      // Do not fail signal delivery when anchor refresh hits a fs or
      // resolution error. The existing wake path still proceeds.
    }
    await this.wakeBus.enqueue({
      sessionId: params.sessionId,
      runId: run.id,
      type,
      domain: getWakeEventDomain(type),
      content,
      data: params.data ? { ...params.data } : undefined,
      createdAt: now,
      availableAt: now,
      dedupeKey: buildWakeDedupeKey({
        sessionId: params.sessionId,
        runId: run.id,
        type,
        data: params.data,
      }),
      dispatchReady: false,
    });
    if (activeRun) {
      run.updatedAt = now;
      run.lastWakeReason = type;
      run.nextCheckAt = run.state === "paused" ? run.nextCheckAt : now;
      if (run.state !== "paused") {
        run.budgetState = {
          ...run.budgetState,
          nextCheckIntervalMs: 0,
        };
      }
      recordRunActivity(run, run.updatedAt);
      await this.persistRun(run, {
        type: "run_signalled",
        summary: truncate(`Background run signalled: ${content}`, 200),
        timestamp: now,
        data: { signalType: type },
      });
    } else {
      await this.runStore.appendEvent(run, {
        type: "run_signalled",
        summary: truncate(`Background run signalled: ${content}`, 200),
        timestamp: now,
        data: { signalType: type },
      });
    }

    if (run.state === "paused") {
      const snapshotRun =
        this.activeRuns.has(params.sessionId)
          ? run
          : toActiveRun(run);
      const queuedDispatchCount = await this.runStore.getQueuedDispatchCountForSession(
        params.sessionId,
      );
      this.rememberStatusSnapshot(
        snapshotRun,
        this.wakeBus.getQueuedCount(params.sessionId),
        queuedDispatchCount,
      );
      return true;
    }

    if (run.state !== "running") {
      await this.enqueueDispatchForSession({
        sessionId: params.sessionId,
        reason: type,
        availableAt: now,
        preferredWorkerId: run.preferredWorkerId,
      });
    }

    if (activeRun && run.state !== "running") {
      if (run.state !== "blocked" && run.state !== "suspended") {
        const completionDecision = buildDeterministicRunDomainDecision(run);
        if (completionDecision && completionDecision.state !== "working") {
          await this.finishRun(run, completionDecision);
          return true;
        }
      }
    }

    return true;
  }

  async pauseRun(
    sessionId: string,
    reason = "Paused the active background run for this session.",
  ): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      const lease = await this.runStore.claimLease(sessionId, this.instanceId, this.now());
      if (!lease.claimed || !lease.run) return false;
      const persistedRun = toActiveRun(lease.run);
      if (persistedRun.state === "paused") {
        await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
          ...toPersistedRun(persistedRun),
        });
        return true;
      }
      assertAgentRunStateTransition(persistedRun.state, "paused", "pauseRun persisted");
      persistedRun.state = "paused";
      persistedRun.updatedAt = this.now();
      persistedRun.lastWakeReason = "user_input";
      persistedRun.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      persistedRun.preferredWorkerId = this.instanceId;
      persistedRun.workerAffinityKey = resolveWorkerAffinityKey(persistedRun);
      recordRunActivity(persistedRun, persistedRun.updatedAt, "progress");
      await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
        ...toPersistedRun(persistedRun),
      });
      await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
      this.rememberStatusSnapshot(
        persistedRun,
        0,
        await this.runStore.getQueuedDispatchCountForSession(sessionId),
      );
      await this.runStore.appendEvent(toPersistedRun(persistedRun), {
        type: "run_paused",
        summary: truncate(`Background run paused: ${reason}`, 200),
        timestamp: this.now(),
      });
      await this.publishUpdate(sessionId, persistedRun.lastUserUpdate);
      return true;
    }
    if (run.state === "paused") return true;

    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    assertAgentRunStateTransition(run.state, "paused", "pauseRun");
    run.state = "paused";
    run.updatedAt = this.now();
    run.lastWakeReason = "user_input";
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    recordRunActivity(run, run.updatedAt, "progress");

    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: truncate(`Background run paused: ${reason}`, 200),
    });
    await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
      ...toPersistedRun(run),
    });
    this.activeRuns.delete(sessionId);
    await this.runStore.saveRecentSnapshot(
      toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
    );
    this.rememberStatusSnapshot(
      run,
      this.wakeBus.getQueuedCount(run.sessionId),
      await this.runStore.getQueuedDispatchCountForSession(sessionId),
    );
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: "run_paused",
      summary: truncate(`Background run paused: ${reason}`, 200),
      timestamp: this.now(),
    });
    await this.publishUpdate(sessionId, run.lastUserUpdate);
    return true;
  }

  async resumeRun(
    sessionId: string,
    reason = "Resumed the background run for this session.",
  ): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      const lease = await this.runStore.claimLease(sessionId, this.instanceId, this.now());
      if (!lease.claimed || !lease.run) return false;
      const persistedRun = toActiveRun(lease.run);
      if (persistedRun.state !== "paused") {
        await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
          ...toPersistedRun(persistedRun),
        });
        return false;
      }
      assertAgentRunStateTransition(persistedRun.state, "working", "resumeRun persisted");
      persistedRun.state = "working";
      persistedRun.updatedAt = this.now();
      persistedRun.lastWakeReason = "resume";
      persistedRun.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      persistedRun.lastHeartbeatContent = undefined;
      persistedRun.preferredWorkerId = this.instanceId;
      persistedRun.workerAffinityKey = resolveWorkerAffinityKey(persistedRun);
      clearRunBlockers(persistedRun);
      recordRunActivity(persistedRun, persistedRun.updatedAt, "progress");
      await this.runStore.releaseLease(sessionId, this.instanceId, this.now(), {
        ...toPersistedRun(persistedRun),
      });
      await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
      this.rememberStatusSnapshot(persistedRun, 0);
      await this.runStore.appendEvent(toPersistedRun(persistedRun), {
        type: "run_resumed",
        summary: truncate(`Background run resumed: ${reason}`, 200),
        timestamp: this.now(),
      });
      await this.publishUpdate(sessionId, persistedRun.lastUserUpdate);
      await this.enqueueDispatchForSession({
        sessionId,
        reason: "resume",
        availableAt: this.now(),
        preferredWorkerId: persistedRun.preferredWorkerId,
      });
      return true;
    }
    if (run.state !== "paused") return false;

    assertAgentRunStateTransition(run.state, "working", "resumeRun");
    run.state = "working";
    run.updatedAt = this.now();
    run.lastWakeReason = "resume";
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    run.lastHeartbeatContent = undefined;
    clearRunBlockers(run);
    recordRunActivity(run, run.updatedAt, "progress");

    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: truncate(`Background run resumed: ${reason}`, 200),
    });
    await this.persistRun(run, {
      type: "run_resumed",
      summary: truncate(`Background run resumed: ${reason}`, 200),
      timestamp: this.now(),
    });
    await this.publishUpdate(sessionId, run.lastUserUpdate);
    await this.enqueueDispatchForSession({
      sessionId,
      reason: "resume",
      availableAt: this.now(),
      preferredWorkerId: run.preferredWorkerId,
    });
    return true;
  }

  async stopRun(
    sessionId: string,
    reason = "Stopped by user.",
  ): Promise<boolean> {
    this.terminatingSessions.add(sessionId);
    try {
      const run = this.activeRuns.get(sessionId);
      if (run) {
        return this.executeOperatorStop(run, reason);
      }
      const lease = await this.runStore.claimLease(sessionId, this.instanceId, this.now());
      if (!lease.claimed || !lease.run) {
        return false;
      }
      const persistedRun = toActiveRun(lease.run);
      persistedRun.preferredWorkerId = this.instanceId;
      persistedRun.workerAffinityKey = resolveWorkerAffinityKey(persistedRun);
      return this.executeOperatorStop(persistedRun, reason);
    } finally {
      this.terminatingSessions.delete(sessionId);
    }
  }

  async cancelRun(sessionId: string, reason = "Stopped by user."): Promise<boolean> {
    this.terminatingSessions.add(sessionId);
    try {
      const stopRequestedAt = this.now();
      const run = this.activeRuns.get(sessionId);
      if (!run) {
        const lease = await this.runStore.claimLease(sessionId, this.instanceId, this.now());
        if (!lease.claimed || !lease.run) return false;
        const persistedRun = toActiveRun(lease.run);
        assertAgentRunStateTransition(
          persistedRun.state,
          "cancelled",
          "cancelRun persisted",
        );
        persistedRun.state = "cancelled";
        persistedRun.updatedAt = stopRequestedAt;
        persistedRun.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
        persistedRun.budgetState = {
          ...persistedRun.budgetState,
          stopRequestedAt,
        };
        persistedRun.preferredWorkerId = this.instanceId;
        persistedRun.workerAffinityKey = resolveWorkerAffinityKey(persistedRun);
        recordRunActivity(persistedRun, persistedRun.updatedAt, "progress");
        await this.runStore.saveCheckpoint(toPersistedRun(persistedRun));
        await this.runStore.deleteRun(sessionId);
        await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
        this.forgetStatusSnapshot(sessionId);
        await this.runStore.appendEvent(toPersistedRun(persistedRun), {
          type: "run_cancelled",
          summary: truncate(`Background run cancelled: ${reason}`, 200),
          timestamp: stopRequestedAt,
          data: {
            stopRequestedAt,
          },
        });
        await this.wakeBus.clearSession(sessionId);
        await this.progressTracker?.append({
          sessionId,
          type: "task_completed",
          summary: truncate(`Background run cancelled: ${reason}`, 200),
        });
        await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
        this.recordAlert({
          severity: "info",
          code: "run_cancelled",
          message: truncate(reason, 200),
          run: persistedRun,
        });
        return true;
      }

      this.clearRunTimers(run);
      run.abortController?.abort();
      run.abortController = null;
      assertAgentRunStateTransition(run.state, "cancelled", "cancelRun");
      run.state = "cancelled";
      run.updatedAt = stopRequestedAt;
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      run.budgetState = {
        ...run.budgetState,
        stopRequestedAt,
      };
      recordRunActivity(run, run.updatedAt, "progress");
      this.activeRuns.delete(sessionId);
      this.forgetStatusSnapshot(sessionId);
      await this.runStore.saveCheckpoint(toPersistedRun(run));
      await this.runStore.deleteRun(sessionId);
      await this.runStore.saveRecentSnapshot(
        toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
      );
      await this.wakeBus.clearSession(sessionId);

      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "run_cancelled",
        summary: truncate(`Background run cancelled: ${reason}`, 200),
        timestamp: stopRequestedAt,
        data: {
          stopRequestedAt,
        },
      });
      await this.progressTracker?.append({
        sessionId,
        type: "task_completed",
        summary: truncate(`Background run cancelled: ${reason}`, 200),
      });
      await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
      this.recordAlert({
        severity: "info",
        code: "run_cancelled",
        message: truncate(reason, 200),
        run,
      });
      this.updateActiveGauge();
      return true;
    } finally {
      this.terminatingSessions.delete(sessionId);
    }
  }

  private async executeOperatorStop(
    run: ActiveBackgroundRun,
    reason: string,
  ): Promise<boolean> {
    const stopRequestedAt = this.now();
    run.budgetState = {
      ...run.budgetState,
      stopRequestedAt,
    };
    run.lastWakeReason = "user_input";
    run.updatedAt = stopRequestedAt;
    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;

    const runningTargets = listRunningManagedProcessTargets(run);
    if (runningTargets.length === 0) {
      const latestTarget = findLatestManagedProcessTarget(run.observedTargets);
      const alreadyStoppedDecision: BackgroundRunDecision | undefined =
        latestTarget?.currentState === "exited"
          ? {
              state: "completed",
              userUpdate: truncate(
                `Managed process ${buildManagedProcessIdentity(latestTarget)} is already stopped. Objective satisfied.`,
                MAX_USER_UPDATE_CHARS,
              ),
              internalSummary:
                "Operator stop completed without issuing another tool call because the managed process was already exited.",
              shouldNotifyUser: true,
            }
          : undefined;
      if (alreadyStoppedDecision) {
        await this.finishRun(run, alreadyStoppedDecision);
        return true;
      }
      await this.finishRun(run, {
        state: "cancelled",
        userUpdate: truncate(reason, MAX_USER_UPDATE_CHARS),
        internalSummary:
          "Operator stop found no running durable managed process targets and cancelled supervision only.",
        shouldNotifyUser: true,
      });
      return true;
    }

    const operatorToolHandler = this.createToolHandler({
      sessionId: run.sessionId,
      runId: run.id,
      cycleIndex: run.cycleCount + 1,
      shellProfile: run.shellProfile ?? DEFAULT_SESSION_SHELL_PROFILE,
    });
    const stopCalls: ChatExecutorResult["toolCalls"][number][] = [];
    for (const target of runningTargets) {
      this.onStatus?.(run.sessionId, {
        phase: "tool_call",
        detail: `Calling ${managedProcessStopToolName(getManagedProcessSurface(target))}`,
      });
      stopCalls.push(
        await executeNativeToolCall(
          operatorToolHandler,
          managedProcessStopToolName(getManagedProcessSurface(target)),
          buildManagedProcessStopArgs(target),
        ),
      );
    }

    const actorResult = buildNativeActorResult(
      stopCalls,
      `Stopped ${runningTargets.length} managed process target${runningTargets.length === 1 ? "" : "s"}.`,
      "managed-process-stop",
    );
    observeManagedProcessTargets(run, actorResult, stopRequestedAt);
    run.lastVerifiedAt = stopRequestedAt;
    recordToolEvidence(run, stopCalls);
    await this.refreshCarryForwardState({ run, actorResult, force: true });

    const failedStop = stopCalls.find((toolCall) => toolCall.isError);
    if (failedStop) {
      const failureText = extractToolFailureText(failedStop);
      await this.parkBlockedRun(run, {
        state: "blocked",
        userUpdate: truncate(
          `Operator stop failed while stopping the managed process: ${failureText}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: `Operator stop failed: ${failureText}`,
        shouldNotifyUser: true,
      });
      return true;
    }

    const stoppedIdentities = runningTargets.map((target) =>
      buildManagedProcessIdentity(target),
    );
    await this.finishRun(run, {
      state: "completed",
      userUpdate: truncate(
        `${reason} Stopped ${stoppedIdentities.join(", ")}. Objective satisfied.`,
        MAX_USER_UPDATE_CHARS,
      ),
      internalSummary:
        "Operator stop completed after stopping the observed durable managed process targets.",
      shouldNotifyUser: true,
    });
    return true;
  }

  async updateRunObjective(
    sessionId: string,
    objective: string,
    reason = "Updated the run objective.",
  ): Promise<boolean> {
    const nextObjective = objective.trim();
    if (nextObjective.length === 0) {
      return false;
    }
    const nextContract = await this.planRunContract(nextObjective, sessionId);
    const now = this.now();
    const updateMessage = truncate(
      `${reason} Objective is now: ${nextObjective}`,
      MAX_USER_UPDATE_CHARS,
    );
    const apply = (run: ActiveBackgroundRun): void => {
      run.objective = nextObjective;
      run.contract = nextContract;
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = updateMessage;
      run.lastHeartbeatContent = undefined;
      clearRunBlockers(run);
      run.budgetState = {
        ...run.budgetState,
        nextCheckIntervalMs: nextContract.nextCheckMs,
        heartbeatIntervalMs: nextContract.heartbeatMs,
        maxIdleMs:
          nextContract.kind === "until_stopped"
            ? undefined
            : run.budgetState.maxIdleMs ?? DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
      };
      run.preferredWorkerId = this.instanceId;
      run.workerAffinityKey = resolveWorkerAffinityKey(run);
      recordRunActivity(run, now, "progress");
    };
    const run = this.activeRuns.get(sessionId);
    if (run) {
      apply(run);
      await this.persistRun(run, {
        type: "run_objective_updated",
        summary: truncate(`Background run objective updated: ${nextObjective}`, 200),
        timestamp: now,
        data: { reason },
      });
      await this.publishUpdate(sessionId, updateMessage);
      if (run.state !== "running" && run.state !== "paused") {
        await this.enqueueDispatchForSession({
          sessionId,
          reason: "user_input",
          availableAt: now,
          preferredWorkerId: run.preferredWorkerId,
        });
      }
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    apply(persistedRun);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_objective_updated",
      summary: truncate(`Background run objective updated: ${nextObjective}`, 200),
      timestamp: now,
      data: { reason },
    });
    await this.publishUpdate(sessionId, updateMessage);
    if (persistedRun.state !== "paused") {
      await this.enqueueDispatchForSession({
        sessionId,
        reason: "user_input",
        availableAt: now,
        preferredWorkerId: persistedRun.preferredWorkerId,
      });
    }
    return true;
  }

  async signalManagedProcessExit(params: {
    processId: string;
    label?: string;
    exitCode?: number | null;
    signal?: string | null;
    occurredAt?: number;
    source?: string;
  }): Promise<boolean> {
    const sessionId = [...this.activeRuns.values()].find((run) =>
      run.observedTargets.some(
        (target) =>
          target.kind === "managed_process" &&
          (target.processId === params.processId ||
            (params.label !== undefined && target.label === params.label)),
      ),
    )?.sessionId;
    if (!sessionId) {
      return false;
    }
    const labelPrefix = params.label ? `"${params.label}" ` : "";
    const statusBits = [
      params.exitCode !== undefined ? `exitCode=${params.exitCode}` : undefined,
      params.signal ? `signal=${params.signal}` : undefined,
    ].filter(Boolean);
    const content =
      `Managed process ${labelPrefix}(${params.processId}) exited` +
      (statusBits.length > 0 ? ` (${statusBits.join(", ")}).` : ".");
    return this.signalRun({
      sessionId,
      type: "process_exit",
      content,
      data: {
        processId: params.processId,
        ...(params.label ? { label: params.label } : {}),
        ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        ...(params.occurredAt !== undefined ? { occurredAt: params.occurredAt } : {}),
        ...(params.source ? { source: params.source } : {}),
      },
    });
  }

  async amendRunConstraints(
    sessionId: string,
    constraints: {
      readonly successCriteria?: readonly string[];
      readonly completionCriteria?: readonly string[];
      readonly blockedCriteria?: readonly string[];
      readonly nextCheckMs?: number;
      readonly heartbeatMs?: number;
    },
    reason = "Updated the run constraints.",
  ): Promise<boolean> {
    const now = this.now();
    const apply = (run: ActiveBackgroundRun): void => {
      const nextContract: BackgroundRunContract = {
        ...run.contract,
        successCriteria: normalizeOperatorStringList(
          constraints.successCriteria,
          run.contract.successCriteria,
        ),
        completionCriteria: normalizeOperatorStringList(
          constraints.completionCriteria,
          run.contract.completionCriteria,
        ),
        blockedCriteria: normalizeOperatorStringList(
          constraints.blockedCriteria,
          run.contract.blockedCriteria,
        ),
        nextCheckMs: clampPollIntervalMs(
          constraints.nextCheckMs ?? run.contract.nextCheckMs,
        ),
        heartbeatMs:
          constraints.heartbeatMs !== undefined
            ? normalizePositiveInteger(constraints.heartbeatMs) ??
              run.contract.heartbeatMs
            : run.contract.heartbeatMs,
      };
      assertValidAgentRunContract(nextContract, "amendRunConstraints");
      run.contract = nextContract;
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      run.lastHeartbeatContent = undefined;
      clearRunBlockers(run);
      run.budgetState = {
        ...run.budgetState,
        nextCheckIntervalMs: nextContract.nextCheckMs,
        heartbeatIntervalMs: nextContract.heartbeatMs,
        maxIdleMs:
          nextContract.kind === "until_stopped"
            ? undefined
            : run.budgetState.maxIdleMs ?? DEFAULT_BACKGROUND_RUN_MAX_IDLE_MS,
      };
      recordRunActivity(run, now, "progress");
    };
    const run = this.activeRuns.get(sessionId);
    if (run) {
      apply(run);
      await this.persistRun(run, {
        type: "run_contract_amended",
        summary: truncate(`Background run constraints updated: ${reason}`, 200),
        timestamp: now,
      });
      await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
      if (run.state !== "running" && run.state !== "paused") {
        await this.enqueueDispatchForSession({
          sessionId,
          reason: "user_input",
          availableAt: now,
          preferredWorkerId: run.preferredWorkerId,
        });
      }
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    apply(persistedRun);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_contract_amended",
      summary: truncate(`Background run constraints updated: ${reason}`, 200),
      timestamp: now,
    });
    await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
    if (persistedRun.state !== "paused") {
      await this.enqueueDispatchForSession({
        sessionId,
        reason: "user_input",
        availableAt: now,
        preferredWorkerId: persistedRun.preferredWorkerId,
      });
    }
    return true;
  }

  async adjustRunBudget(
    sessionId: string,
    budget: {
      readonly maxRuntimeMs?: number;
      readonly maxCycles?: number;
      readonly maxIdleMs?: number;
    },
    reason = "Adjusted the run budget.",
  ): Promise<boolean> {
    const now = this.now();
    const apply = (run: ActiveBackgroundRun): void => {
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      run.budgetState = {
        ...run.budgetState,
        maxRuntimeMs:
          normalizeOptionalBudgetLimit(budget.maxRuntimeMs) ??
          run.budgetState.maxRuntimeMs,
        maxCycles:
          normalizeOptionalBudgetLimit(budget.maxCycles) ??
          run.budgetState.maxCycles,
        maxIdleMs:
          budget.maxIdleMs !== undefined
            ? normalizeOptionalBudgetLimit(budget.maxIdleMs) ??
              run.budgetState.maxIdleMs
            : run.budgetState.maxIdleMs,
      };
      recordRunActivity(run, now, "progress");
    };
    const run = this.activeRuns.get(sessionId);
    if (run) {
      apply(run);
      await this.persistRun(run, {
        type: "run_budget_adjusted",
        summary: truncate(`Background run budget adjusted: ${reason}`, 200),
        timestamp: now,
        data: { ...budget },
      });
      await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    apply(persistedRun);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_budget_adjusted",
      summary: truncate(`Background run budget adjusted: ${reason}`, 200),
      timestamp: now,
      data: { ...budget },
    });
    await this.publishUpdate(sessionId, truncate(reason, MAX_USER_UPDATE_CHARS));
    return true;
  }

  async forceCompactRun(
    sessionId: string,
    reason = "Forced a carry-forward refresh for this run.",
  ): Promise<boolean> {
    const now = this.now();
    const run = this.activeRuns.get(sessionId);
    if (run) {
      await this.refreshCarryForwardState({ run, force: true });
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      await this.persistRun(run, {
        type: "run_compaction_forced",
        summary: truncate(reason, 200),
        timestamp: now,
      });
      await this.publishUpdate(sessionId, run.lastUserUpdate);
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    await this.refreshCarryForwardState({ run: persistedRun, force: true });
    persistedRun.updatedAt = now;
    persistedRun.lastWakeReason = "user_input";
    persistedRun.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_compaction_forced",
      summary: truncate(reason, 200),
      timestamp: now,
    });
    await this.publishUpdate(sessionId, persistedRun.lastUserUpdate);
    return true;
  }

  async reassignRunWorker(
    sessionId: string,
    worker: {
      readonly preferredWorkerId?: string;
      readonly workerAffinityKey?: string;
    },
    reason = "Updated worker assignment for this run.",
  ): Promise<boolean> {
    const now = this.now();
    const apply = (run: ActiveBackgroundRun): void => {
      run.updatedAt = now;
      run.lastWakeReason = "user_input";
      run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
      run.preferredWorkerId = worker.preferredWorkerId?.trim() || undefined;
      run.workerAffinityKey =
        worker.workerAffinityKey?.trim() || resolveWorkerAffinityKey(run);
      recordRunActivity(run, now, "progress");
    };
    const run = this.activeRuns.get(sessionId);
    if (run) {
      apply(run);
      await this.persistRun(run, {
        type: "run_worker_reassigned",
        summary: truncate(reason, 200),
        timestamp: now,
        data: {
          preferredWorkerId: run.preferredWorkerId,
          workerAffinityKey: run.workerAffinityKey,
        },
      });
      await this.publishUpdate(sessionId, run.lastUserUpdate ?? truncate(reason, MAX_USER_UPDATE_CHARS));
      if (run.state !== "running" && run.state !== "paused") {
        await this.enqueueDispatchForSession({
          sessionId,
          reason: "user_input",
          availableAt: now,
          preferredWorkerId: run.preferredWorkerId,
        });
      }
      return true;
    }

    const lease = await this.runStore.claimLease(sessionId, this.instanceId, now);
    if (!lease.claimed || !lease.run) {
      return false;
    }
    const persistedRun = toActiveRun(lease.run);
    apply(persistedRun);
    await this.runStore.releaseLease(sessionId, this.instanceId, now, {
      ...toPersistedRun(persistedRun),
    });
    await this.runStore.saveRecentSnapshot(toRecentSnapshot(persistedRun, 0));
    this.rememberStatusSnapshot(persistedRun, 0);
    await this.runStore.appendEvent(toPersistedRun(persistedRun), {
      type: "run_worker_reassigned",
      summary: truncate(reason, 200),
      timestamp: now,
      data: {
        preferredWorkerId: persistedRun.preferredWorkerId,
        workerAffinityKey: persistedRun.workerAffinityKey,
      },
    });
    await this.publishUpdate(sessionId, persistedRun.lastUserUpdate ?? truncate(reason, MAX_USER_UPDATE_CHARS));
    if (persistedRun.state !== "paused") {
      await this.enqueueDispatchForSession({
        sessionId,
        reason: "user_input",
        availableAt: now,
        preferredWorkerId: persistedRun.preferredWorkerId,
      });
    }
    return true;
  }

  async retryRunFromCheckpoint(
    sessionId: string,
    reason = "Retrying the run from its last durable checkpoint.",
  ): Promise<boolean> {
    const now = this.now();
    const checkpoint =
      (await this.runStore.loadRun(sessionId)) ??
      (await this.runStore.loadCheckpoint(sessionId));
    if (!checkpoint) {
      return false;
    }

    const run = toActiveRun(checkpoint);
    run.state = "working";
    run.updatedAt = now;
    run.nextCheckAt = undefined;
    run.nextHeartbeatAt = undefined;
    run.lastWakeReason = "user_input";
    run.lastHeartbeatContent = undefined;
    run.lastUserUpdate = truncate(reason, MAX_USER_UPDATE_CHARS);
    run.pendingSignals = [];
    run.leaseOwnerId = undefined;
    run.leaseExpiresAt = undefined;
    run.preferredWorkerId = this.instanceId;
    run.workerAffinityKey = resolveWorkerAffinityKey(run);
    clearRunBlockers(run);
    recordRunActivity(run, now, "progress");

    await this.persistRun(run, {
      type: "run_retried",
      summary: truncate(`Background run retried: ${reason}`, 200),
      timestamp: now,
    });
    await this.runStore.seedConversationHistory(sessionId, run.internalHistory);
    await this.runStore.saveCheckpoint(toPersistedRun(run));
    await this.publishUpdate(sessionId, run.lastUserUpdate);
    await this.enqueueDispatchForSession({
      sessionId,
      reason: "recovery",
      availableAt: now,
      preferredWorkerId: run.preferredWorkerId,
    });
    return true;
  }

  async retryRunFromStep(
    sessionId: string,
    params: {
      stepName: string;
      traceId?: string;
      reason?: string;
    },
  ): Promise<boolean> {
    const stepName = params.stepName.trim();
    if (!stepName) {
      return false;
    }
    const reason = params.reason?.trim() || [
      `Retrying the durable run from its latest checkpoint for step "${stepName}".`,
      params.traceId ? `Trace: ${params.traceId}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const retried = await this.retryRunFromCheckpoint(sessionId, reason);
    if (!retried) {
      return false;
    }
    const detail = await this.getOperatorDetail(sessionId);
    const runId = detail?.runId;
    if (runId) {
      await this.runStore.appendEvent(
        {
          id: runId,
          sessionId,
        },
        {
          type: "run_retried_from_step",
          summary: truncate(`Retried from step "${stepName}".`, 200),
          timestamp: this.now(),
          data: {
            stepName,
            ...(params.traceId ? { traceId: params.traceId } : {}),
          },
        },
      );
    }
    return true;
  }

  async retryRunFromTrace(
    sessionId: string,
    params: {
      traceId: string;
      stepName?: string;
      reason?: string;
    },
  ): Promise<boolean> {
    const traceId = params.traceId.trim();
    if (!traceId) {
      return false;
    }
    const reason = params.reason?.trim() || [
      `Retrying the durable run from its latest checkpoint for trace "${traceId}".`,
      params.stepName?.trim() ? `Step: ${params.stepName.trim()}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const retried = await this.retryRunFromCheckpoint(sessionId, reason);
    if (!retried) {
      return false;
    }
    const detail = await this.getOperatorDetail(sessionId);
    const runId = detail?.runId;
    if (runId) {
      await this.runStore.appendEvent(
        {
          id: runId,
          sessionId,
        },
        {
          type: "run_retried_from_trace",
          summary: truncate(`Retried from trace "${traceId}".`, 200),
          timestamp: this.now(),
          data: {
            traceId,
            ...(params.stepName?.trim() ? { stepName: params.stepName.trim() } : {}),
          },
        },
      );
    }
    return true;
  }

  async forkRunFromCheckpoint(
    sessionId: string,
    params: {
      targetSessionId: string;
      objective?: string;
      reason?: string;
    },
  ): Promise<boolean> {
    const targetSessionId = params.targetSessionId.trim();
    if (!targetSessionId || targetSessionId === sessionId) {
      return false;
    }
    const [targetRun, targetCheckpoint] = await Promise.all([
      this.runStore.loadRun(targetSessionId),
      this.runStore.loadCheckpoint(targetSessionId),
    ]);
    if (targetRun || targetCheckpoint || this.activeRuns.has(targetSessionId)) {
      throw new Error(
        `Target session "${targetSessionId}" already has an active or checkpointed durable run.`,
      );
    }

    const source =
      (await this.runStore.loadRun(sessionId)) ??
      (await this.runStore.loadCheckpoint(sessionId));
    if (!source) {
      return false;
    }

    const now = this.now();
    const run = toActiveRun(source);
    run.id = `bg-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    run.sessionId = targetSessionId;
    run.objective = params.objective?.trim() || source.objective;
    run.state = "pending";
    run.updatedAt = now;
    run.createdAt = now;
    run.cycleCount = 0;
    run.stableWorkingCycles = 0;
    run.consecutiveErrorCycles = 0;
    run.nextCheckAt = undefined;
    run.nextHeartbeatAt = undefined;
    run.lastWakeReason = "recovery";
    run.lastHeartbeatContent = undefined;
    run.lastUserUpdate = truncate(
      params.reason?.trim() ||
        `Forked background run from ${sessionId} into ${targetSessionId}.`,
      MAX_USER_UPDATE_CHARS,
    );
    run.pendingSignals = [];
    run.leaseOwnerId = undefined;
    run.leaseExpiresAt = undefined;
    run.preferredWorkerId = this.instanceId;
    run.workerAffinityKey = resolveWorkerAffinityKey(run);
    clearRunBlockers(run);
    run.abortController = null;
    run.timer = null;
    run.heartbeatTimer = null;
    run.policyScope = this.resolveRunPolicyScope(run);
    if (run.lineage) {
      run.lineage = {
        ...run.lineage,
        parentRunId: source.id,
        rootRunId: run.lineage.rootRunId || source.id,
        depth: run.lineage.depth + 1,
        childRunIds: [],
      };
    }

    await this.persistRun(run, {
      type: "run_forked",
      summary: truncate(
        `Forked from ${sessionId} into ${targetSessionId}: ${run.lastUserUpdate}`,
        200,
      ),
      timestamp: now,
      data: {
        sourceSessionId: sessionId,
        sourceRunId: source.id,
      },
    });
    await this.runStore.forkConversationHistory(sessionId, targetSessionId);
    await this.runStore.saveCheckpoint(toPersistedRun(run));
    await this.publishUpdate(targetSessionId, run.lastUserUpdate);
    await this.enqueueDispatchForSession({
      sessionId: targetSessionId,
      reason: "recovery",
      availableAt: now,
      preferredWorkerId: run.preferredWorkerId,
    });
    return true;
  }

  async applyVerificationOverride(
    sessionId: string,
    override: {
      readonly mode: "continue" | "complete" | "fail";
      readonly reason: string;
      readonly userUpdate?: string;
    },
  ): Promise<boolean> {
    const summary = truncate(
      `Operator verification override (${override.mode}): ${override.reason}`,
      200,
    );
    if (override.mode === "continue") {
      const retried = await this.retryRunFromCheckpoint(
        sessionId,
        override.userUpdate ??
          `Operator override: continue. ${override.reason}`,
      );
      if (retried) {
        const detail = await this.getOperatorDetail(sessionId);
        const runId = detail?.runId;
        if (runId) {
          const runRef = {
            id: runId,
            sessionId,
          };
          await this.runStore.appendEvent(runRef, {
            type: "run_verification_overridden",
            summary,
            timestamp: this.now(),
            data: { mode: override.mode },
          });
        }
      }
      return retried;
    }

    const activeRun = this.activeRuns.get(sessionId);
    const checkpoint =
      activeRun
        ? undefined
        : (await this.runStore.loadRun(sessionId)) ??
          (await this.runStore.loadCheckpoint(sessionId));
    const run = activeRun ?? (checkpoint ? toActiveRun(checkpoint) : undefined);
    if (!run) {
      return false;
    }
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: "run_verification_overridden",
      summary,
      timestamp: this.now(),
      data: { mode: override.mode },
    });
    await this.finishRun(run, {
      state: override.mode === "complete" ? "completed" : "failed",
      userUpdate:
        override.userUpdate ??
        `Operator override recorded: ${override.reason}`,
      internalSummary: summary,
      shouldNotifyUser: true,
    });
    return true;
  }

  async shutdown(): Promise<void> {
    this.workerDraining = true;
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    this.scheduledDispatchAt = undefined;
    if (this.workerHeartbeatTimer) {
      clearTimeout(this.workerHeartbeatTimer);
      this.workerHeartbeatTimer = null;
    }
    // Audit S3.1: log the drain-state set failure so an operator can
    // observe a worker that failed to mark itself draining. The
    // failure is intentionally not propagated because the shutdown
    // sequence still needs to proceed (releasing leases below) — but
    // a silent drop made resurrection-after-stale-worker bugs hard
    // to debug.
    await this.runStore.setWorkerDrainState({
      workerId: this.instanceId,
      draining: true,
      now: this.now(),
    }).catch((err: unknown) => {
      this.logger.warn(
        `[background-run-supervisor] failed to set worker drain state during stop: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    });
    const runs = [...this.activeRuns.values()];
    for (const run of runs) {
      this.clearRunTimers(run);
      run.abortController?.abort();
      run.abortController = null;
      if (run.state === "running" || run.state === "working" || run.state === "pending") {
        assertAgentRunStateTransition(run.state, "suspended", "shutdown");
        run.state = "suspended";
        run.nextCheckAt = this.now();
        run.nextHeartbeatAt = undefined;
        run.lastWakeReason = "recovery";
        recordRunActivity(run, this.now());
      }
      await this.runStore.releaseLease(
        run.sessionId,
        this.instanceId,
        this.now(),
        {
          ...toPersistedRun(run),
          state: run.state,
          nextCheckAt: run.nextCheckAt,
          nextHeartbeatAt: run.nextHeartbeatAt,
          lastWakeReason: "daemon_shutdown",
        },
      );
      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "run_suspended",
        summary: "Background run suspended for daemon shutdown and will recover on next boot.",
        timestamp: this.now(),
      });
      await this.runStore.saveRecentSnapshot(
        toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
      );
      this.activeRuns.delete(run.sessionId);
      await this.wakeBus.clearSession(run.sessionId);
    }
    // Audit S3.1: log worker removal failure for the same reason as
    // setWorkerDrainState above. A silent drop here leaves a stale
    // worker registration that can confuse leader election on the
    // next boot.
    await this.runStore.removeWorker(this.instanceId).catch((err: unknown) => {
      this.logger.warn(
        `[background-run-supervisor] failed to remove worker registration during stop: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    });
    this.wakeBus.dispose();
  }

  private schedule(
    run: ActiveBackgroundRun,
    delayMs: number,
    wakeReason: BackgroundRunWakeReason = "timer",
  ): void {
    if (this.activeRuns.get(run.sessionId) !== run) return;
    const now = this.now();
    run.nextCheckAt = now + delayMs;
    run.lastWakeReason = wakeReason;
    run.budgetState = {
      ...run.budgetState,
      nextCheckIntervalMs: delayMs,
    };
    void (async () => {
      await this.persistRun(run);
      await this.enqueueDispatchForSession({
        sessionId: run.sessionId,
        reason: wakeReason,
        availableAt: run.nextCheckAt,
        preferredWorkerId: run.preferredWorkerId,
      });
    })().catch((error) => {
      this.logger.debug("Failed to schedule background wake", {
        sessionId: run.sessionId,
        wakeReason,
        error: toErrorMessage(error),
      });
    });
    run.timer = null;
  }

  private clearRunTimers(run: ActiveBackgroundRun): void {
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.nextCheckAt = undefined;
    run.nextHeartbeatAt = undefined;
  }

  private scheduleHeartbeat(run: ActiveBackgroundRun, delayMs: number | undefined): void {
    if (this.activeRuns.get(run.sessionId) !== run) return;
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.nextHeartbeatAt = undefined;
    if (delayMs === undefined || delayMs <= 0) return;
    run.nextHeartbeatAt = this.now() + delayMs;
    run.budgetState = {
      ...run.budgetState,
      heartbeatIntervalMs: delayMs,
    };
    void this.persistRun(run).catch((error) => {
      this.logger.debug("Failed to persist background heartbeat schedule", {
        sessionId: run.sessionId,
        error: toErrorMessage(error),
      });
    });
    run.heartbeatTimer = setTimeout(() => {
      void this.emitHeartbeat(run.sessionId).catch((error) => {
        this.logger.warn("Background heartbeat emission failed", {
          sessionId: run.sessionId,
          runId: run.id,
          error: toErrorMessage(error),
        });
      });
    }, delayMs);
  }

  private async emitHeartbeat(sessionId: string): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;

    if (this.isSessionBusy?.(sessionId)) {
      this.scheduleHeartbeat(run, BUSY_RETRY_INTERVAL_MS);
      return;
    }

    if (run.state === "running") {
      const content = buildActiveCycleHeartbeatMessage(run);
      run.lastHeartbeatContent = content;
      run.nextHeartbeatAt = undefined;
      this.onStatus?.(sessionId, {
        phase: "background_run",
        detail: `Background run cycle ${run.cycleCount} is still in progress`,
      });
      this.scheduleHeartbeat(run, ACTIVE_CYCLE_HEARTBEAT_REPEAT_MS);
      return;
    }

    if (run.state !== "working") return;

    const content = buildHeartbeatMessage(run);
    if (run.lastHeartbeatContent === content) return;

    run.lastHeartbeatContent = content;
    run.nextHeartbeatAt = undefined;
    this.onStatus?.(sessionId, {
        phase: "background_wait",
        detail:
          run.nextCheckAt !== undefined
            ? `Next verification in ~${Math.max(1, Math.ceil((run.nextCheckAt - this.now()) / 1000))}s`
            : "Background run waiting for next verification",
      });
    try {
      await this.persistRun(run);
    } catch (error) {
      if (!isBackgroundRunFenceConflictError(error)) {
        throw error;
      }
      const refreshedRun = await this.runStore.loadRun(sessionId);
      this.logger.debug("Skipped stale background heartbeat persistence", {
        sessionId,
        runId: run.id,
        attemptedFenceToken: error.attemptedFenceToken,
        currentFenceToken: error.currentFenceToken,
      });
      if (!refreshedRun || refreshedRun.leaseOwnerId !== this.instanceId) {
        this.clearRunTimers(run);
        this.activeRuns.delete(sessionId);
        this.forgetStatusSnapshot(sessionId);
        this.updateActiveGauge();
        return;
      }
      run.fenceToken = refreshedRun.fenceToken;
      run.leaseOwnerId = refreshedRun.leaseOwnerId;
      run.leaseExpiresAt = refreshedRun.leaseExpiresAt;
    }
  }

  private async prepareCycleRun(
    run: ActiveBackgroundRun,
    sessionId: string,
  ): Promise<ToolHandler | undefined> {
    const leaseIsCurrent =
      run.leaseOwnerId === this.instanceId &&
      typeof run.leaseExpiresAt === "number" &&
      run.leaseExpiresAt > this.now();
    if (!leaseIsCurrent) {
      const leasedRun = await this.runStore.renewLease(
        toPersistedRun(run),
        this.instanceId,
        this.now(),
      );
      if (!leasedRun) {
        this.clearRunTimers(run);
        this.activeRuns.delete(sessionId);
        return undefined;
      }
      run.leaseOwnerId = leasedRun.leaseOwnerId;
      run.leaseExpiresAt = leasedRun.leaseExpiresAt;
      run.fenceToken = leasedRun.fenceToken;
    }
    const deliveredWakeBatch = await this.wakeBus.drainDueWakeEvents(sessionId);
    if (deliveredWakeBatch.run) {
      run.pendingSignals = cloneSignals(deliveredWakeBatch.run.pendingSignals);
      run.updatedAt = deliveredWakeBatch.run.updatedAt;
      run.fenceToken = deliveredWakeBatch.run.fenceToken;
      run.leaseOwnerId = deliveredWakeBatch.run.leaseOwnerId;
      run.leaseExpiresAt = deliveredWakeBatch.run.leaseExpiresAt;
    }
    if (run.pendingSignals.some((signal) => signal.type === "process_exit")) {
      observeManagedProcessExitSignal(run);
    }
    if (this.isSessionBusy?.(sessionId)) {
      this.schedule(run, BUSY_RETRY_INTERVAL_MS, "busy_retry");
      return undefined;
    }
    if (
      run.contract.kind !== "until_stopped" &&
      isRuntimeLimitExceeded(
        this.now() - run.budgetState.runtimeStartedAt,
        run.budgetState.maxRuntimeMs,
      )
    ) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run timed out before the objective was completed.",
        internalSummary: "Exceeded maximum background runtime budget.",
        shouldNotifyUser: true,
      });
      return undefined;
    }
    if (
      run.contract.kind !== "until_stopped" &&
      isRuntimeLimitExceeded(run.cycleCount, run.budgetState.maxCycles)
    ) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run hit its cycle budget before completing.",
        internalSummary: "Exceeded maximum background cycle budget.",
        shouldNotifyUser: true,
      });
      return undefined;
    }
    if (
      run.budgetState.maxIdleMs !== undefined &&
      isRuntimeLimitExceeded(
        this.now() - run.budgetState.lastActivityAt,
        run.budgetState.maxIdleMs,
      )
    ) {
      await this.finishRun(run, {
        state: "failed",
        userUpdate: "Background run exhausted its idle budget before the objective completed.",
        internalSummary: "Exceeded maximum background idle budget.",
        shouldNotifyUser: true,
      });
      return undefined;
    }

    assertAgentRunStateTransition(run.state, "running", "executeCycle start");
    run.state = "running";
    run.updatedAt = this.now();
    run.cycleCount += 1;
    run.nextHeartbeatAt = undefined;
    clearRunBlockers(run);
    recordRunActivity(run, run.updatedAt);
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
    }
    run.abortController = new AbortController();
    this.onStatus?.(sessionId, {
      phase: "background_run",
      detail: `Background run cycle ${run.cycleCount}`,
    });
    await this.persistRun(run, {
      type: "cycle_started",
      summary: `Background run cycle ${run.cycleCount} started.`,
      timestamp: this.now(),
    });
    this.scheduleHeartbeat(run, ACTIVE_CYCLE_HEARTBEAT_INITIAL_MS);

    return this.createToolHandler({
      sessionId,
      runId: run.id,
      cycleIndex: run.cycleCount,
      shellProfile: run.shellProfile ?? DEFAULT_SESSION_SHELL_PROFILE,
    });
  }

  private resetIdleHookBlockStreak(run: ActiveBackgroundRun): void {
    if ((run.budgetState.idleHookBlockStreak ?? 0) === 0) {
      return;
    }
    run.budgetState = {
      ...run.budgetState,
      idleHookBlockStreak: 0,
    };
  }

  private async maybeHandleWorkerIdleStopHooks(params: {
    readonly run: ActiveBackgroundRun;
    readonly sessionId: string;
    readonly nextCheckMs: number;
  }): Promise<boolean> {
    const { run, sessionId, nextCheckMs } = params;
    const runtime = this.resolveStopHookRuntime?.();
    if (!runtime || !hasStopHookHandlers(runtime, "WorkerIdle")) {
      this.resetIdleHookBlockStreak(run);
      return false;
    }

    const hookResult = await runStopHookPhase({
      runtime,
      phase: "WorkerIdle",
      matchKey: run.id,
      context: {
        phase: "WorkerIdle",
        sessionId,
        workerIdle: {
          runId: run.id,
          objective: run.objective,
          pendingSignals: run.pendingSignals.length,
          nextCheckMs,
          idleHookBlockStreak: run.budgetState.idleHookBlockStreak ?? 0,
        },
      },
    });
    if (hookResult.outcome === "pass") {
      this.resetIdleHookBlockStreak(run);
      return false;
    }

    const nextStreak = (run.budgetState.idleHookBlockStreak ?? 0) + 1;
    run.budgetState = {
      ...run.budgetState,
      idleHookBlockStreak: nextStreak,
    };

    const blockMessage = truncate(
      hookResult.outcome === "prevent_continuation"
        ? hookResult.stopReason ??
          "Background run was blocked by the worker-idle stop-hook chain."
        : hookResult.blockingMessage ??
          "Background run was blocked by the worker-idle stop-hook chain.",
      MAX_USER_UPDATE_CHARS,
    );
    const blockSummary = truncate(
      `Background run idle hook blocked continuation: ${blockMessage}`,
      200,
    );

    if (nextStreak >= 3) {
      await this.parkBlockedRun(run, {
        state: "blocked",
        userUpdate: blockMessage,
        internalSummary: blockSummary,
        shouldNotifyUser: true,
      });
      return true;
    }

    const retryDelayMs = clampPollIntervalMs(
      Math.max(BUSY_RETRY_INTERVAL_MS, nextCheckMs * Math.max(1, nextStreak)),
      {
        maxMs: resolveRunNextCheckClampMaxMs(run),
      },
    );
    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: blockSummary,
    });
    await this.publishUpdateIfChanged(run, blockMessage);
    this.scheduleHeartbeat(run, undefined);
    this.onStatus?.(sessionId, {
      phase: "background_wait",
      detail: `Retrying worker-idle validation in ~${Math.max(1, Math.ceil(retryDelayMs / 1000))}s`,
    });
    await this.persistRun(run, {
      type: "cycle_working",
      summary: blockSummary,
      timestamp: this.now(),
      data: {
        nextCheckMs: retryDelayMs,
        idleHookBlockStreak: nextStreak,
        hookIds: hookResult.hookOutcomes.map((outcome) => outcome.hookId),
      },
    });
    this.schedule(run, retryDelayMs, "timer");
    return true;
  }

  private async handleWorkingDecision(params: {
    run: ActiveBackgroundRun;
    sessionId: string;
    actorResult: ChatExecutorResult | undefined;
    decision: BackgroundRunDecision;
    heartbeatMs?: number;
    carryForwardRefreshPromise?: Promise<void>;
  }): Promise<boolean> {
    const {
      run,
      sessionId,
      actorResult,
      decision,
      heartbeatMs,
      carryForwardRefreshPromise,
    } = params;
    if (carryForwardRefreshPromise !== undefined) {
      await carryForwardRefreshPromise;
    } else {
      const carryForwardSignalSnapshot = cloneSignals(run.pendingSignals);
      await this.refreshCarryForwardState({
        run,
        actorResult,
        signalSnapshot: carryForwardSignalSnapshot,
      });
    }
    if (!this.isActiveRun(run)) {
      return true;
    }
    const postRefreshSignalDrivenCompletion = buildDeterministicRunDomainDecision(run);
    if (
      postRefreshSignalDrivenCompletion &&
      postRefreshSignalDrivenCompletion.state !== "working"
    ) {
      await this.finishRun(run, postRefreshSignalDrivenCompletion);
      return true;
    }

    const pendingSignalWake = run.pendingSignals[0];
    const hasPendingSignals = pendingSignalWake !== undefined;
    const nextQueuedWakeAt = this.wakeBus.getNextAvailableAt(sessionId);
    const hasReadyQueuedWakes =
      nextQueuedWakeAt !== undefined && nextQueuedWakeAt <= this.now();
    const nextCheckMs = hasPendingSignals || hasReadyQueuedWakes
      ? 0
      : clampPollIntervalMs(decision.nextCheckMs, {
        maxMs: resolveRunNextCheckClampMaxMs(run),
      });

    assertAgentRunStateTransition(run.state, "working", "executeCycle continue");
    run.state = "working";
    run.updatedAt = this.now();
    await this.progressTracker?.append({
      sessionId,
      type: "decision",
      summary: truncate(
        `Background run working: ${decision.internalSummary}`,
        200,
      ),
    });
    if (decision.shouldNotifyUser && !hasPendingSignals && !hasReadyQueuedWakes) {
      await this.publishUpdateIfChanged(run, decision.userUpdate);
    }
    if (!this.isActiveRun(run)) {
      return true;
    }
    if (hasPendingSignals || hasReadyQueuedWakes) {
      this.resetIdleHookBlockStreak(run);
    } else if (
      await this.maybeHandleWorkerIdleStopHooks({
        run,
        sessionId,
        nextCheckMs,
      })
    ) {
      return true;
    }
    if (!hasPendingSignals && !hasReadyQueuedWakes) {
      this.scheduleHeartbeat(run, heartbeatMs);
    }
    this.onStatus?.(sessionId, {
      phase: "background_wait",
      detail: hasPendingSignals || hasReadyQueuedWakes
        ? "Processing newly arrived external signals"
        : `Next verification in ~${Math.max(1, Math.ceil(nextCheckMs / 1000))}s`,
    });
    await this.persistRun(run, {
      type: "cycle_working",
      summary: truncate(
        `Background run working: ${decision.internalSummary}`,
        200,
      ),
      timestamp: this.now(),
      data: {
        nextCheckMs,
        consecutiveErrorCycles: run.consecutiveErrorCycles,
        pendingSignals: run.pendingSignals.length,
      },
    });
    this.emitCycleTrace(run, "working_applied", {
      summary: decision.internalSummary,
      userUpdate: decision.userUpdate,
      nextCheckMs,
      heartbeatMs,
      hasPendingSignals,
      hasReadyQueuedWakes,
      pendingSignals: run.pendingSignals.length,
    });
    if (!this.isActiveRun(run)) {
      return true;
    }
    if (hasPendingSignals || hasReadyQueuedWakes) {
      this.wakeBus.dispatchNow(sessionId);
      return true;
    }
    this.schedule(run, nextCheckMs, "timer");
    return true;
  }

  private shouldUseActorLoopParity(run: ActiveBackgroundRun): boolean {
    return (
      run.contract.domain === "workspace" ||
      run.contract.domain === "pipeline"
    );
  }

  private async resolveCycleDecision(params: {
    run: ActiveBackgroundRun;
    sessionId: string;
    cycleToolHandler: ToolHandler;
    actorPrompt: string;
    actorPromptEnvelope: import("../llm/prompt-envelope.js").PromptEnvelopeV1;
  }): Promise<{
    actorResult?: ChatExecutorResult;
    decision: BackgroundRunDecision;
    heartbeatMs?: number;
    carryForwardRefreshPromise?: Promise<void>;
  }> {
    const { run, sessionId, cycleToolHandler, actorPrompt, actorPromptEnvelope } = params;
    let actorResult: ChatExecutorResult | undefined;
    let decision: BackgroundRunDecision;
    let heartbeatMs: number | undefined;
    let carryForwardRefreshPromise: Promise<void> | undefined;
    // Per-tool-call observer that updates the verify_reminder
    // counters on `ActiveBackgroundRun`. Runs INSIDE the actor turn
    // (one event per tool dispatch_finished), not after the turn
    // ends. Without this, a single long actor turn with hundreds of
    // tool calls would never increment the counter from
    // `collectAttachments`'s perspective until the cycle boundary —
    // and verify_reminder would never fire on long-running cycles.
    // Always installed regardless of `traceProviderPayloads`; trace
    // logging itself is gated separately below.
    const updateVerifyReminderCountersFromExecutionEvent = (
      event: ChatExecutionTraceEvent,
    ): void => {
      if (event.type !== "tool_dispatch_finished") return;
      const payload = event.payload as Record<string, unknown>;
      const toolName =
        typeof payload.tool === "string" ? payload.tool : undefined;
      if (!toolName) return;
      if (isMutatingTool(toolName)) {
        run.mutatingEditsSinceLastVerifierSpawn += 1;
      }
      const args =
        payload.args && typeof payload.args === "object"
          ? (payload.args as Record<string, unknown>)
          : undefined;
      if (args && isVerifierSpawnFromRecord({ name: toolName, args })) {
        run.mutatingEditsSinceLastVerifierSpawn = 0;
      }
      const rawResult = payload.result;
      const resultString =
        typeof rawResult === "string"
          ? rawResult
          : rawResult === undefined || rawResult === null
            ? ""
            : JSON.stringify(rawResult);
      if (
        containsVerdictMarkerInToolResult({
          name: toolName,
          result: resultString,
        })
      ) {
        run.mutatingEditsSinceLastVerifierSpawn = 0;
      }
    };

    const actorExecutionTraceLogger = this.traceProviderPayloads
      ? createExecutionTraceEventLogger({
          logger: this.logger,
          traceLabel: "background_run.executor",
          traceId: `background:${sessionId}:${run.id}:${run.cycleCount}:actor`,
          sessionId,
          staticFields: {
            runId: run.id,
            cycleCount: run.cycleCount,
            phase: "actor",
          },
        })
      : undefined;

    const actorTrace = {
      includeProviderPayloads: this.traceProviderPayloads,
      onExecutionTraceEvent: (event: ChatExecutionTraceEvent): void => {
        // Counter mutation is always-on; trace logging gated.
        updateVerifyReminderCountersFromExecutionEvent(event);
        actorExecutionTraceLogger?.(event);
      },
      ...(this.traceProviderPayloads
        ? {
            onProviderTraceEvent: createProviderTraceEventLogger({
              logger: this.logger,
              traceLabel: "background_run.provider",
              traceId: `background:${sessionId}:${run.id}:${run.cycleCount}:actor`,
              sessionId,
              staticFields: {
                runId: run.id,
                cycleCount: run.cycleCount,
                phase: "actor",
              },
            }),
          }
        : {}),
    };

    try {
      const previousToolEvidence = run.lastToolEvidence;
      const nativeCycle = await getRunDomain(run).executeNativeCycle?.(run, {
        toolHandler: cycleToolHandler,
        now: this.now(),
      });
      if (nativeCycle) {
        actorResult = nativeCycle.actorResult;
        decision = toDecisionFromDomainVerification(nativeCycle.verification);
      } else {
        const advertisedToolNames =
          this.resolveAdvertisedToolNames?.(
            sessionId,
            run.shellProfile ?? DEFAULT_SESSION_SHELL_PROFILE,
            run.interactiveContextState?.discoveredToolNames,
          ) ??
          run.interactiveContextState?.defaultAdvertisedToolNames ??
          [];
        const baseToolRoutingDecision = this.buildToolRoutingDecision?.(
          sessionId,
          actorPrompt,
          run.internalHistory,
          run.shellProfile ?? DEFAULT_SESSION_SHELL_PROFILE,
        );
        const resolvedExecutionContext =
          await this.resolveExecutionContext?.({
            sessionId,
            objective: run.objective,
            shellProfile: run.shellProfile ?? DEFAULT_SESSION_SHELL_PROFILE,
            history: run.internalHistory,
          });
        const toolRoutingDecision = applyRunToolScopeDecision({
          allowedTools: getScopedAllowedTools(run),
          toolRoutingDecision: baseToolRoutingDecision,
        });
        const interactiveContextState = buildBackgroundRunInteractiveContextState({
          run,
          promptEnvelope: actorPromptEnvelope,
          runtimeWorkspaceRoot: resolvedExecutionContext?.runtimeContext?.workspaceRoot,
          advertisedToolNames,
        });
        run.interactiveContextState = cloneInteractiveContextState(
          interactiveContextState,
        );
        const abortSignal = run.abortController?.signal;
        if (!abortSignal) {
          throw new Error("Background cycle missing abort signal");
        }
        // Phase E: background-run supervisor migrated to drain the
        // Phase C generator inside the cycle loop.
        const routedToolNames =
          toolRoutingDecision?.routedToolNames ?? advertisedToolNames;
        const expandedToolNames = Array.from(
          new Set([
            ...advertisedToolNames,
            ...(toolRoutingDecision?.expandedToolNames ?? []),
          ]),
        );
        actorResult = await executeChatToLegacyResult(this.chatExecutor, {
          message: toRunMessage(actorPrompt, sessionId, run.id, run.cycleCount),
          history: run.internalHistory,
          promptEnvelope: actorPromptEnvelope,
          sessionId,
          runtimeContext: resolvedExecutionContext?.runtimeContext,
          requiredToolEvidence: resolvedExecutionContext?.requiredToolEvidence,
          interactiveContext: {
            state: interactiveContextState,
            ...(typeof run.carryForward?.summary === "string" &&
            run.carryForward.summary.trim().length > 0
              ? { summaryText: run.carryForward.summary.trim() }
              : {}),
          } satisfies InteractiveContextRequest,
          requestTimeoutMs: BACKGROUND_RUN_ACTOR_REQUEST_TIMEOUT_MS,
          toolHandler: cycleToolHandler,
          signal: abortSignal,
          maxToolRounds: BACKGROUND_RUN_MAX_TOOL_ROUNDS,
          toolBudgetPerRequest: BACKGROUND_RUN_MAX_TOOL_BUDGET,
          maxModelRecallsPerRequest: BACKGROUND_RUN_MAX_MODEL_RECALLS,
          toolRouting:
            routedToolNames.length > 0 || expandedToolNames.length > 0
              ? {
                advertisedToolNames,
                routedToolNames,
                expandedToolNames,
                expandOnMiss: true,
                persistDiscovery: true,
              }
              : undefined,
          trace: actorTrace,
        });

        const extendedHistory: LLMMessage[] = [
          ...run.internalHistory,
          { role: "user", content: actorPrompt } as LLMMessage,
          { role: "assistant", content: actorResult.content, phase: "commentary" } as LLMMessage,
        ];
        if (this.shouldCompactHistory(extendedHistory)) {
          run.internalHistory = await this.compactInternalHistory(
            run,
            extendedHistory,
          );
        } else {
          run.internalHistory = extendedHistory;
        }
        run.internalHistory = trimHistory(run.internalHistory);
        await this.runStore.appendConversationTurn(sessionId, [
          { role: "user", content: actorPrompt },
          { role: "assistant", content: actorResult.content, phase: "commentary" },
        ]);
        run.lastVerifiedAt = this.now();
        recordToolEvidence(run, actorResult.toolCalls);
        // verify_reminder counter is updated per-tool-call inside the
        // actor turn via `updateVerifyReminderCountersFromExecutionEvent`
        // wired into the actorTrace.onExecutionTraceEvent callback.
        // The previous end-of-actor-turn aggregation loop is removed
        // because, on a long actor turn (hundreds of tool calls in
        // one cycle), counters need to advance continuously — not in
        // a single batch at cycle boundary — so that the next cycle's
        // `collectAttachments` sees the accumulated work.
        //
        // The turn counter still resets only when the reminder actually
        // fires (see prepareCycleContext below) — spawning a verifier
        // does NOT suppress the next reminder; the model has to keep
        // making edits without a fresh verdict for the threshold to
        // re-cross.
        run.assistantTurnsSinceLastVerifyReminder += 1;
        recordProviderCompactionArtifacts(run, actorResult);
        run.continuationMode = resolveBackgroundContinuationMode(actorResult);
        const verifierStages = actorResult.runtimeContractSnapshot?.verifierStages;
        run.verifierSessionId = verifierStages?.taskId ?? run.verifierSessionId;
        run.verifierStage = verifierStages?.stageStatus ?? run.verifierStage;
        if (actorResult.toolCalls.length > 0) {
          run.pendingSignals = [
            ...run.pendingSignals,
            ...buildInternalToolSignals({
              sessionId,
              cycleCount: run.cycleCount,
              actorResult,
              observedAt: run.lastVerifiedAt,
            }),
          ];
        }
        getRunDomain(run).observeActorResult?.(run, actorResult, run.lastVerifiedAt);
        const domainDecision = buildDeterministicRunDomainDecision(run);
        // Non-parity decision resolution runs an LLM call
        // (`evaluateDecision`). Downstream cycle handling will also
        // run `refreshCarryForwardState`, which is another LLM call
        // for non-parity runs. Those two calls are independent — they
        // read the same cycle state and write to disjoint fields.
        // Start the refresh in parallel with the decision call and
        // hand its Promise to the branch handlers via the outcome,
        // so the two supervisor LLM calls run concurrently rather
        // than serially.
        const shouldShortCircuitOnDomainDecision =
          domainDecision !== undefined && domainDecision.state !== "working";
        const isParity = this.shouldUseActorLoopParity(run);
        // Kick off both LLM calls before awaiting either, so they run
        // concurrently inside the provider adapter. evaluateDecision is
        // started BEFORE refreshCarryForwardState so its `.chat()`
        // invocation is queued first — mock sequences in tests, and
        // the observable provider request order in production logs,
        // remain `decision → refresh`. The pre-refresh uses the same
        // non-forced semantics as the working-path branch: the
        // `deriveCarryForwardRefreshReason` heuristic decides whether
        // the LLM call actually runs. Non-working branches still
        // force-refresh themselves if needed, so we don't speculate
        // on a force refresh here.
        const decisionPromise: Promise<BackgroundRunDecision | undefined> =
          shouldShortCircuitOnDomainDecision
            ? Promise.resolve(domainDecision)
            : isParity
              ? Promise.resolve(undefined)
              : this.evaluateDecision(run, actorResult);
        if (
          !shouldShortCircuitOnDomainDecision &&
          !isParity
        ) {
          carryForwardRefreshPromise = this.refreshCarryForwardState({
            run,
            actorResult,
            signalSnapshot: cloneSignals(run.pendingSignals),
          });
        }
        const resolvedDecision = await decisionPromise;
        decision =
          resolvedDecision ?? buildFallbackDecision(run, actorResult);
        decision = groundDecision(run, actorResult, decision, domainDecision);
      }

      run.completionProgress = mergeWorkflowProgressSnapshots({
        previous: run.completionProgress,
        next: actorResult.completionProgress,
      });

      const cycleTokens = actorResult.tokenUsage.totalTokens;
      run.budgetState = {
        ...run.budgetState,
        lastCycleTokens: cycleTokens,
        totalTokens: run.budgetState.totalTokens + Math.max(0, cycleTokens),
      };
      const governanceDecision = await this.evaluateRunGovernance(run, {
        tokenCount: cycleTokens > 0 ? cycleTokens : undefined,
      });
      if (governanceDecision) {
        decision = governanceDecision;
      }

      const consecutiveErrorCycles = computeConsecutiveErrorCycles(run, actorResult);
      run.consecutiveErrorCycles = consecutiveErrorCycles;
      decision = groundDecision(run, actorResult, decision);
      decision = applyRepeatedErrorGuard(decision, consecutiveErrorCycles);
      const zeroToolGuardResult = applyZeroToolCompletionGuard(
        run,
        actorResult,
        decision,
      );
      decision = zeroToolGuardResult.decision;
      const zeroToolGuardFired = zeroToolGuardResult.guardFired;
      const anyTaskToolCall = actorResult.toolCalls.some((toolCall) =>
        toolCall.name.startsWith("task."),
      );
      run.cyclesSinceTaskTool = anyTaskToolCall
        ? 0
        : run.cyclesSinceTaskTool + 1;
      const hasSuccessfulToolCalls = actorResult.toolCalls.some(
        (toolCall) => !toolCall.isError,
      );
      if (hasSuccessfulToolCalls) {
        run.consecutiveNudgeCycles = 0;
      } else if (zeroToolGuardFired) {
        run.consecutiveNudgeCycles += 1;
      }
      run.pendingSignals = dropSyntheticInternalSignals(run.pendingSignals);
      recordRunActivity(
        run,
        this.now(),
        actorResult.toolCalls.some((toolCall) => !toolCall.isError) ||
          decision.state !== "working"
          ? "progress"
          : "activity",
      );
      if (decision.state === "working") {
        const cadence = chooseNextCheckMs({
          run,
          actorResult,
          decision,
          previousToolEvidence,
        });
        run.stableWorkingCycles = cadence.stableWorkingCycles;
        decision = {
          ...decision,
          nextCheckMs: cadence.nextCheckMs,
        };
        heartbeatMs = cadence.heartbeatMs;
      } else {
        run.stableWorkingCycles = 0;
      }
    } catch (error) {
      if (run.abortController?.signal.aborted) {
        throw error;
      }
      const injectedDomain = this.classifyFaultDomain(error);
      if (injectedDomain) {
        this.reportIncident({
          domain: injectedDomain,
          mode:
            injectedDomain === "persistence" ||
            injectedDomain === "approval_store"
              ? "safe_mode"
              : "degraded",
          severity: "error",
          code: `${injectedDomain}_failure`,
          message: toErrorMessage(error),
          run,
        });
      } else if (/timed out/i.test(toErrorMessage(error))) {
        this.reportIncident({
          domain: "provider",
          mode: "degraded",
          severity: "warn",
          code: "provider_timeout",
          message: toErrorMessage(error),
          run,
        });
      }
      run.consecutiveErrorCycles += 1;
      recordRunActivity(run, this.now());
      decision = {
        state:
          run.consecutiveErrorCycles >= MAX_CONSECUTIVE_ERROR_CYCLES
            ? "failed"
            : "working",
        userUpdate: truncate(
          `Background run failed: ${toErrorMessage(error)}`,
          MAX_USER_UPDATE_CHARS,
        ),
        internalSummary: toErrorMessage(error),
        nextCheckMs:
          run.consecutiveErrorCycles >= MAX_CONSECUTIVE_ERROR_CYCLES
            ? undefined
            : MIN_POLL_INTERVAL_MS,
        shouldNotifyUser: true,
      };
    }

    if (decision.state !== "failed") {
      this.incidentDiagnostics?.clearDomain("provider");
      this.incidentDiagnostics?.clearDomain("tool");
      this.incidentDiagnostics?.clearDomain("child_run");
    }

    return {
      actorResult,
      decision,
      heartbeatMs,
      ...(carryForwardRefreshPromise === undefined
        ? {}
        : { carryForwardRefreshPromise }),
    };
  }

  private async prepareCycleContext(
    sessionId: string,
  ): Promise<PreparedCycleContext | undefined> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    if (run.state === "paused") return;
    const cycleToolHandler = await this.prepareCycleRun(run, sessionId);
    if (!cycleToolHandler) return;
    if (run.anchorFiles.length > 0) {
      run.anchorFiles = await refreshAnchorFiles({
        sessionId,
        anchors: run.anchorFiles,
        now: this.now(),
      });
    }

    // Runtime-injected attachments (today: the TodoWrite 10-turn
    // reminder). Shared with the webchat chat-executor via
    // `collectAttachments` so both surfaces emit identical nudges.
    const activeToolNames = new Set<string>(
      this.resolveAdvertisedToolNames?.(
        sessionId,
        run.shellProfile ?? DEFAULT_SESSION_SHELL_PROFILE,
      ) ?? [],
    );
    const todos = this.readTodosForSession
      ? await this.readTodosForSession(sessionId)
      : [];
    const tasks = this.readTasksForSession
      ? await this.readTasksForSession(sessionId)
      : [];
    const attachments = collectAttachments({
      history: run.internalHistory,
      activeToolNames,
      todos,
      tasks,
      mutatingEditsSinceLastVerifierSpawn:
        run.mutatingEditsSinceLastVerifierSpawn,
      assistantTurnsSinceLastVerifyReminder:
        run.assistantTurnsSinceLastVerifyReminder,
    });
    for (const attachment of attachments.messages) {
      run.internalHistory.push(attachment);
    }
    // Reset the turn counter if a verify_reminder was just emitted.
    // Scans up to ~3 messages (the attachment payload is tiny) —
    // cheaper than extending AttachmentInjectionResult and keeping
    // the webchat/text-channel call sites in sync with a field they
    // would never use.
    if (
      attachments.messages.some((m) => messageContainsVerifyReminderPrefix(m))
    ) {
      run.assistantTurnsSinceLastVerifyReminder = 0;
    }

    const openTasks = this.readOpenTasksForSession
      ? await this.readOpenTasksForSession(sessionId, 20)
      : [];
    const continuationInjections = evaluateCycleContinuationInjections({
      cycleCount: run.cycleCount + 1,
      consecutiveNudgeCycles: run.consecutiveNudgeCycles,
      cyclesSinceTaskTool: run.cyclesSinceTaskTool,
      lastToolEvidencePresent: Boolean(run.lastToolEvidence),
      remainingRequirements:
        run.completionProgress?.remainingRequirements ?? [],
      history: run.internalHistory,
      openTasks,
    });
    if (continuationInjections.length > 0) {
      run.internalHistory.push(...continuationInjections);
      // xAI stateful chain break: a fresh user-turn injection must not
      // be paired with a prior `previous_response_id` or the provider
      // will replay stale context. Mirrors Fix B from bf218e4.
      if (run.carryForward) {
        run.carryForward = {
          ...run.carryForward,
          providerContinuation: undefined,
        };
      }
    }

    return {
      run,
      sessionId,
      cycleToolHandler,
      actorPrompt: buildActorPrompt(run),
      actorPromptEnvelope: normalizePromptEnvelope({
        baseSystemPrompt: appendShellProfilePromptSection({
          systemPrompt: this.getSystemPrompt(),
          profile: run.shellProfile ?? DEFAULT_SESSION_SHELL_PROFILE,
        }),
        systemSections: [
          {
            source: "background_actor",
            content: BACKGROUND_ACTOR_SECTION,
          },
        ],
        userSections: [],
      }),
    };
  }

  private async resolvePreparedCycleOutcome(
    context: PreparedCycleContext,
  ): Promise<ResolvedCycleOutcome | undefined> {
    const { run, sessionId, cycleToolHandler, actorPrompt, actorPromptEnvelope } = context;
    const trace = buildBackgroundRunTraceIds(run, "execute_cycle");
    const cycleSpan = startReplaySpan({
      name: "background_run.execute_cycle",
      trace: {
        traceId: trace.traceId,
        spanId: trace.spanId,
        sampled: true,
      },
      attributes: {
        code: "background_run.execute_cycle",
      },
      emitOtel: true,
    });
    let actorResult: ChatExecutorResult | undefined;
    let decision: BackgroundRunDecision;
    let heartbeatMs: number | undefined;
    let carryForwardRefreshPromise: Promise<void> | undefined;
    try {
      const preCycleDecision = buildPreCycleDomainDecision(run);
      if (preCycleDecision) {
        return {
          run,
          sessionId,
          actorResult: undefined,
          decision: preCycleDecision,
          heartbeatMs: undefined,
        };
      }
      const governanceDecision = await this.evaluateRunGovernance(run, {});
      if (governanceDecision) {
        return {
          run,
          sessionId,
          actorResult: undefined,
          decision: governanceDecision,
          heartbeatMs: undefined,
        };
      }
      ({
        actorResult,
        decision,
        heartbeatMs,
        carryForwardRefreshPromise,
      } = await this.resolveCycleDecision({
        run,
        sessionId,
        cycleToolHandler,
        actorPrompt,
        actorPromptEnvelope,
      }));
    } catch (error) {
      if (run.abortController?.signal.aborted) {
        cycleSpan.end();
        return;
      }
      cycleSpan.end(error);
      throw error;
    } finally {
      run.abortController = null;
    }

    const signalDrivenCompletion = buildDeterministicRunDomainDecision(run);
    if (
      !this.shouldUseActorLoopParity(run) &&
      signalDrivenCompletion &&
      signalDrivenCompletion.state !== "working"
    ) {
      decision = signalDrivenCompletion;
    }

    cycleSpan.end();
    this.emitCycleTrace(run, "decision_resolved", {
      decisionState: decision.state,
      decisionInternalSummary: decision.internalSummary,
      decisionUserUpdate: decision.userUpdate,
      decisionNextCheckMs: decision.nextCheckMs,
      heartbeatMs,
      pendingSignals: run.pendingSignals.length,
      observedTargets: run.observedTargets.map((target) => ({
        kind: target.kind,
        label: target.label,
        processId: target.processId,
        currentState: target.currentState,
        desiredState: target.desiredState,
      })),
      actor: this.summarizeActorResult(actorResult),
    });
    return {
      run,
      sessionId,
      actorResult,
      decision,
      heartbeatMs,
      ...(carryForwardRefreshPromise === undefined
        ? {}
        : { carryForwardRefreshPromise }),
    };
  }

  private async handleResolvedCycleOutcome(
    outcome: ResolvedCycleOutcome,
  ): Promise<void> {
    const {
      run,
      sessionId,
      actorResult,
      decision,
      heartbeatMs,
      carryForwardRefreshPromise,
    } = outcome;

    if (decision.state === "working") {
      if (await this.handleWorkingDecision({
        run,
        sessionId,
        actorResult,
        carryForwardRefreshPromise,
        decision,
        heartbeatMs,
      })) {
        return;
      }
      return;
    }

    await this.finishNonWorkingCycle({
      run,
      actorResult,
      decision,
      carryForwardRefreshPromise,
    });
  }

  private async finishNonWorkingCycle(params: {
    run: ActiveBackgroundRun;
    actorResult?: ChatExecutorResult;
    decision: BackgroundRunDecision;
    carryForwardRefreshPromise?: Promise<void>;
  }): Promise<void> {
    const { run, actorResult, decision, carryForwardRefreshPromise } = params;
    // The parallel pre-refresh ran under the `derive…Reason` heuristic
    // (no `force`) so a working-path outcome wouldn't over-refresh.
    // Finalizing a non-working run still wants the forced refresh the
    // original path used, so await the pre-refresh first and then run
    // the force pass. The forced pass is a no-op if the heuristic had
    // already refreshed, since it re-reads the same state; the extra
    // LLM round-trip only happens when the heuristic skipped and the
    // run is actually terminating.
    if (carryForwardRefreshPromise !== undefined) {
      await carryForwardRefreshPromise;
    }
    await this.refreshCarryForwardState({ run, actorResult, force: true });
    if (!this.isActiveRun(run)) {
      return;
    }
    if (decision.state === "blocked") {
      this.emitCycleTrace(run, "terminal_applied", {
        state: decision.state,
        summary: decision.internalSummary,
        userUpdate: decision.userUpdate,
      });
      await this.parkBlockedRun(run, decision);
      return;
    }
    this.emitCycleTrace(run, "terminal_applied", {
      state: decision.state,
      summary: decision.internalSummary,
      userUpdate: decision.userUpdate,
    });
    await this.finishRun(run, decision);
  }

  private async executeCycle(sessionId: string): Promise<void> {
    const context = await this.prepareCycleContext(sessionId);
    if (!context) {
      return;
    }

    const outcome = await this.resolvePreparedCycleOutcome(context);
    if (!outcome) {
      return;
    }
    await this.handleResolvedCycleOutcome(outcome);
  }

  /**
   * Return true when `history` should be compacted before the next
   * actor turn. Matches the upstream reference runtime's trigger:
   * compact reactively when the estimated prompt tokens approach the
   * effective context window, NOT proactively on every cycle.
   *
   * When a token threshold is configured (via
   * `compactionThresholdTokens`), the gate is token-aware and
   * message-count is ignored. When no token threshold is configured
   * (dev/test fixtures), falls back to the legacy message-count
   * heuristic so existing test scaffolds keep working.
   */
  private shouldCompactHistory(history: readonly LLMMessage[]): boolean {
    if (this.compactionThresholdTokens !== undefined) {
      return (
        this.estimateHistoryTokens(history) >= this.compactionThresholdTokens
      );
    }
    return history.length >= HISTORY_COMPACTION_THRESHOLD;
  }

  /**
   * Cheap char-based token estimate. Sum the serialized content
   * length across messages and divide by `compactionCharPerToken`.
   * Good enough for a compaction trigger — the actual prompt
   * budgeting happens later during packing.
   */
  private estimateHistoryTokens(history: readonly LLMMessage[]): number {
    let totalChars = 0;
    for (const message of history) {
      const content = message.content;
      if (typeof content === "string") {
        totalChars += content.length;
      } else if (Array.isArray(content) || typeof content === "object") {
        totalChars += JSON.stringify(content).length;
      }
    }
    return Math.ceil(totalChars / this.compactionCharPerToken);
  }

  private async compactInternalHistory(
    run: ActiveBackgroundRun,
    history: LLMMessage[],
  ): Promise<LLMMessage[]> {
    const keepTail = 4;
    if (history.length <= keepTail + 1) {
      return history;
    }
    const toSummarize = history.slice(0, -keepTail);
    const kept = history.slice(-keepTail);
    // Anchor-marked messages survive compaction boundaries —
    // upstream's `messagesToKeep` pattern. Runtime-injected
    // reminders rely on their own prior presence as a re-emission
    // anti-spam anchor; if compaction summarized them away, the
    // next cycle would re-inject immediately.
    const { anchorPreserved, rest: toActuallySummarize } =
      partitionByAnchorPreserve(toSummarize);
    // Breaking the xAI stateful chain is independent of whether
    // summarization actually runs — any compaction pass clears it.
    const breakProviderContinuation = (): void => {
      run.compaction = {
        ...run.compaction,
        refreshCount: run.compaction.refreshCount + 1,
      };
      // Break the xAI stateful chain so the server starts fresh
      // with just the compacted history. Without this, the server
      // accumulates ALL prior messages and input_tokens grows
      // unbounded (~166K+ observed) even though local history is
      // trimmed to 12 messages.
      if (run.carryForward) {
        run.carryForward = {
          ...run.carryForward,
          providerContinuation: undefined,
        };
      }
    };
    // All summarizable messages were anchor-preserved → nothing to
    // ask the summarizer model. Emit a stub system message so the
    // result always starts with a system role (consistent with the
    // normal compaction output) and skip the provider call.
    if (toActuallySummarize.length === 0) {
      breakProviderContinuation();
      return [
        {
          role: "system",
          content:
            "[previous messages compacted; anchor-preserved reminders retained]",
        } as LLMMessage,
        ...anchorPreserved,
        ...kept,
      ];
    }
    try {
      const historyText = toActuallySummarize
        .map((m) => `[${m.role}]: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
        .join("\n\n");
      // Trace the supervisor's compaction LLM call alongside the
      // actor's. Without this, compaction is one of the silent
      // contributors to the per-cycle gap between actor turn end
      // and the next request — the call happens, takes 5-15s, and
      // emits no provider.request/.response trace events. The
      // wrapping pattern matches `evaluateDecision` /
      // `refreshCarryForwardState` / `planRunContract` which use the
      // same `createProviderTraceEventLogger` shape; phase label
      // `compaction` distinguishes the cause.
      const providerTrace = this.traceProviderPayloads
        ? {
            trace: {
              includeProviderPayloads: true as const,
              onProviderTraceEvent: createProviderTraceEventLogger({
                logger: this.logger,
                traceLabel: "background_run.provider",
                traceId: `background:${run.sessionId}:${run.id}:${run.cycleCount}:compaction`,
                sessionId: run.sessionId,
                staticFields: {
                  runId: run.id,
                  cycleCount: run.cycleCount,
                  phase: "compaction",
                },
              }),
            },
          }
        : undefined;
      const response = await this.supervisorLlm.chat(
        [
          { role: "system", content: getCompactPrompt() },
          { role: "user", content: historyText },
        ],
        buildModelOnlyChatOptions({
          toolChoice: "none",
          ...(providerTrace ?? {}),
        }),
      );
      const summary = formatCompactSummary(response.content).trim();
      if (summary.length === 0) {
        return history;
      }
      breakProviderContinuation();
      return [
        { role: "system", content: summary } as LLMMessage,
        ...anchorPreserved,
        ...kept,
      ];
    } catch {
      return history;
    }
  }

  private async evaluateDecision(
    run: ActiveBackgroundRun,
    actorResult: ChatExecutorResult,
  ): Promise<BackgroundRunDecision | undefined> {
    try {
      const providerTrace =
        this.traceProviderPayloads
          ? {
            trace: {
              includeProviderPayloads: true as const,
              onProviderTraceEvent: createProviderTraceEventLogger({
                logger: this.logger,
                traceLabel: "background_run.provider",
                traceId: `background:${run.sessionId}:${run.id}:${run.cycleCount}:decision`,
                sessionId: run.sessionId,
                staticFields: {
                  runId: run.id,
                  cycleCount: run.cycleCount,
                  phase: "decision",
                },
              }),
            },
          }
          : undefined;
      const response = await this.supervisorFastLlm.chat([
        { role: "system", content: DECISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildDecisionPrompt({
            contract: run.contract,
            objective: run.objective,
            actorResult,
            previousUpdate: run.lastUserUpdate,
            completionProgressSummary: formatCompletionProgressState(
              run.completionProgress,
            ),
          }),
        },
      ], buildModelOnlyChatOptions({
        toolChoice: "none",
        ...(providerTrace ?? {}),
      }));
      return parseDecision(response.content);
    } catch (error) {
      this.logger.debug("Background run decision evaluation failed", {
        sessionId: run.sessionId,
        runId: run.id,
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  private async refreshCarryForwardState(params: {
    run: ActiveBackgroundRun;
    actorResult?: ChatExecutorResult;
    force?: boolean;
    signalSnapshot?: readonly BackgroundRunSignal[];
  }): Promise<void> {
    const { run, actorResult, force, signalSnapshot } = params;
    const now = this.now();
    const previousCarryForward = run.carryForward;
    const pendingSignals = signalSnapshot ?? run.pendingSignals;
    const refreshReason = deriveCarryForwardRefreshReason({
      run,
      actorResult,
      force,
      pendingSignals,
    });
    if (!refreshReason) return;
    let finalReason: CarryForwardRefreshReason = refreshReason;
    if (this.shouldUseActorLoopParity(run)) {
      const fallbackState = buildFallbackCarryForwardState({
        previous: previousCarryForward,
        latestUpdate: actorResult?.content ?? run.lastUserUpdate,
        latestToolEvidence: run.lastToolEvidence,
        pendingSignals,
        now,
      });
      run.carryForward = {
        ...fallbackState,
        artifacts: previousCarryForward?.artifacts ?? [],
        memoryAnchors: buildCarryForwardAnchors({
          previous: previousCarryForward?.memoryAnchors ?? [],
          pendingSignals,
          actorResult,
          now,
        }),
        summaryHealth: {
          status: "healthy",
          driftCount: previousCarryForward?.summaryHealth.driftCount ?? 0,
          lastDriftAt: previousCarryForward?.summaryHealth.lastDriftAt,
          lastRepairAt: previousCarryForward?.summaryHealth.lastRepairAt,
          lastDriftReason: previousCarryForward?.summaryHealth.lastDriftReason,
        },
        lastCompactedAt: now,
      };
    } else {
      try {
        const providerTrace =
          this.traceProviderPayloads
            ? {
              trace: {
                includeProviderPayloads: true as const,
                onProviderTraceEvent: createProviderTraceEventLogger({
                  logger: this.logger,
                  traceLabel: "background_run.provider",
                  traceId: `background:${run.sessionId}:${run.id}:${run.cycleCount}:carry_forward`,
                  sessionId: run.sessionId,
                  staticFields: {
                    runId: run.id,
                    cycleCount: run.cycleCount,
                    phase: "carry_forward",
                  },
                }),
              },
            }
            : undefined;
        const response = await this.supervisorFastLlm.chat([
          { role: "system", content: CARRY_FORWARD_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildCarryForwardPrompt({
              objective: run.objective,
              contract: run.contract,
              previous: previousCarryForward,
              actorResult,
              latestUpdate: run.lastUserUpdate,
              latestToolEvidence: run.lastToolEvidence,
              pendingSignals,
              observedTargets: run.observedTargets,
            }),
          },
        ], buildModelOnlyChatOptions({
          toolChoice: "none",
          ...(providerTrace ?? {}),
        }));
        const parsed =
          parseCarryForwardState(response.content, now) ??
          buildFallbackCarryForwardState({
            previous: previousCarryForward,
            latestUpdate: run.lastUserUpdate,
            latestToolEvidence: run.lastToolEvidence,
            pendingSignals,
            now,
          });
        const driftReason = detectCarryForwardDrift({
          candidate: parsed,
          actorResult,
          previous: previousCarryForward,
        });
        if (driftReason) {
          finalReason = "repair";
          run.carryForward = repairCarryForwardState({
            previous: previousCarryForward,
            latestUpdate: run.lastUserUpdate,
            latestToolEvidence: run.lastToolEvidence,
            pendingSignals,
            actorResult,
            now,
            reason: driftReason,
          });
          this.logger.warn("Background run carry-forward drift detected", {
            sessionId: run.sessionId,
            runId: run.id,
            reason: driftReason,
          });
        } else {
          run.carryForward = {
            ...parsed,
            artifacts: previousCarryForward?.artifacts ?? [],
            memoryAnchors: buildCarryForwardAnchors({
              previous: previousCarryForward?.memoryAnchors ?? [],
              pendingSignals,
              actorResult,
              now,
            }),
            summaryHealth: {
              status: "healthy",
              driftCount: previousCarryForward?.summaryHealth.driftCount ?? 0,
              lastDriftAt: previousCarryForward?.summaryHealth.lastDriftAt,
              lastRepairAt: previousCarryForward?.summaryHealth.lastRepairAt,
              lastDriftReason: previousCarryForward?.summaryHealth.lastDriftReason,
            },
            lastCompactedAt: now,
          };
        }
      } catch (error) {
        this.logger.debug("Background run carry-forward refresh failed", {
          sessionId: run.sessionId,
          runId: run.id,
          error: toErrorMessage(error),
        });
        run.carryForward = buildFallbackCarryForwardState({
          previous: previousCarryForward,
          latestUpdate: run.lastUserUpdate,
          latestToolEvidence: run.lastToolEvidence,
          pendingSignals,
          now,
        });
        run.carryForward = {
          ...run.carryForward,
          memoryAnchors: buildCarryForwardAnchors({
            previous: previousCarryForward?.memoryAnchors ?? [],
            pendingSignals,
            actorResult,
            now,
          }),
          summaryHealth: previousCarryForward?.summaryHealth ?? {
            status: "healthy",
            driftCount: 0,
          },
        };
      }
    }

    run.compaction = {
      ...run.compaction,
      lastCompactedAt: run.carryForward.lastCompactedAt,
      lastCompactedCycle: run.cycleCount,
      refreshCount: run.compaction.refreshCount + 1,
      lastHistoryLength: run.internalHistory.length,
      lastMilestoneAt:
        finalReason === "milestone" || finalReason === "repair"
          ? now
          : run.compaction.lastMilestoneAt,
      lastCompactionReason: finalReason,
      repairCount:
        finalReason === "repair"
          ? run.compaction.repairCount + 1
          : run.compaction.repairCount,
      lastProviderAnchorAt: run.compaction.lastProviderAnchorAt,
    };
    const latestProviderCompactionArtifact = [...run.carryForward.artifacts]
      .reverse()
      .find((artifact) =>
        artifact.kind === "opaque_provider_state" &&
        artifact.source.endsWith(":provider_state")
      );
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: "memory_compacted",
      summary: truncate(
        `Background run memory ${finalReason === "repair" ? "repaired" : "refreshed"} (${finalReason}).`,
        200,
      ),
      timestamp: now,
      data: {
        reason: finalReason,
        refreshCount: run.compaction.refreshCount,
        repairCount: run.compaction.repairCount,
        providerResponseId: run.carryForward.providerContinuation?.responseId,
        providerCompactionArtifact: latestProviderCompactionArtifact?.locator,
        providerCompactionDigest: latestProviderCompactionArtifact?.digest,
      },
    });

    if (pendingSignals.length > 0) {
      run.pendingSignals = removeConsumedSignals(run.pendingSignals, pendingSignals);
    }
  }

  private async planRunContract(
    objective: string,
    sessionId?: string,
  ): Promise<BackgroundRunContract> {
    try {
      const providerTrace =
        this.traceProviderPayloads
          ? {
            trace: {
              includeProviderPayloads: true as const,
              onProviderTraceEvent: createProviderTraceEventLogger({
                logger: this.logger,
                traceLabel: "background_run.provider",
                traceId: `background:${sessionId ?? "unscoped"}:contract:${Date.now()}`,
                ...(sessionId ? { sessionId } : {}),
                staticFields: {
                  phase: "contract",
                },
              }),
            },
          }
          : undefined;
      const response = await this.supervisorLlm.chat([
        { role: "system", content: CONTRACT_SYSTEM_PROMPT },
        { role: "user", content: buildContractPrompt(objective) },
      ], buildModelOnlyChatOptions({
        toolChoice: "none",
        ...(providerTrace ?? {}),
      }));
      return parseContract(response.content, objective) ?? buildFallbackContract(objective);
    } catch (error) {
      this.logger.debug("Background run contract planning failed", {
        objective: truncate(objective, 120),
        error: toErrorMessage(error),
      });
      return buildFallbackContract(objective);
    }
  }

  private async persistRun(
    run: ActiveBackgroundRun,
    event?: BackgroundRunEvent,
  ): Promise<void> {
    refreshDerivedBudgetState(run);
    this.resolveRunPolicyScope(run);
    const queuedSignals = this.wakeBus.getQueuedCount(run.sessionId);
    const persistedRun = toPersistedRun(run);
    const recentSnapshot = toRecentSnapshot(run, queuedSignals);
    this.rememberStatusSnapshot(run, queuedSignals);
    try {
      this.maybeInjectFault("persistence_failure", {
        run,
        operation: "persist_run",
      });
      await this.runStore.saveRun(persistedRun);
      await this.runStore.saveRecentSnapshot(recentSnapshot);
      if (event) {
        await this.runStore.appendEvent(persistedRun, event);
        if (this.notifier?.isEnabled()) {
          const summary = toOperatorSummary({
            snapshot: recentSnapshot,
            contract: persistedRun.contract,
            blocker: persistedRun.blocker,
            approvalState: persistedRun.approvalState,
            checkpointAvailable: false,
            now: this.now(),
          });
          await this.notifier.notify({
            occurredAt: event.timestamp,
            internalEventType: event.type,
            summary: event.summary,
            run: summary,
          });
        }
      }
      this.incidentDiagnostics?.clearDomain("persistence");
    } catch (error) {
      this.reportIncident({
        domain: "persistence",
        mode: "safe_mode",
        severity: "error",
        code: "persistence_failure",
        message: toErrorMessage(error),
        run,
      });
      throw error;
    }
  }

  private async publishUpdateIfChanged(
    run: ActiveBackgroundRun,
    content: string,
  ): Promise<void> {
    const next = truncate(content, MAX_USER_UPDATE_CHARS);
    if (run.lastUserUpdate === next) return;
    run.lastUserUpdate = next;
    run.lastHeartbeatContent = undefined;
    if (
      run.lastVerifiedAt !== undefined &&
      run.budgetState.firstVerifiedUpdateAt === undefined
    ) {
      run.budgetState = {
        ...run.budgetState,
        firstVerifiedUpdateAt: this.now(),
      };
      const firstVerifiedUpdateAt =
        run.budgetState.firstVerifiedUpdateAt ?? run.updatedAt;
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_TIME_TO_FIRST_VERIFIED_UPDATE_MS,
        firstVerifiedUpdateAt - run.createdAt,
        run,
      );
    }
    recordRunActivity(run, this.now(), "progress");
    if (run.heartbeatTimer) {
      clearTimeout(run.heartbeatTimer);
      run.heartbeatTimer = null;
      run.nextHeartbeatAt = undefined;
    }
    await this.publishUpdate(run.sessionId, next);
    await this.persistRun(run, {
      type: "user_update",
      summary: next,
      timestamp: this.now(),
      data: {
        kind:
          run.budgetState.firstVerifiedUpdateAt !== undefined
            ? "verified_update"
            : "progress_update",
        verified: run.lastVerifiedAt !== undefined,
      },
    });
  }

  private async parkBlockedRun(
    run: ActiveBackgroundRun,
    decision: BackgroundRunDecision,
  ): Promise<void> {
    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    assertAgentRunStateTransition(run.state, "blocked", "parkBlockedRun");
    run.state = "blocked";
    run.updatedAt = this.now();
    const blockerState = buildBlockerState(decision, run.updatedAt);
    run.blocker = blockerState.blocker;
    run.approvalState = blockerState.approvalState;
    recordRunActivity(run, run.updatedAt, "progress");
    if (decision.shouldNotifyUser) {
      run.lastUserUpdate = truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS);
    }
    run.lastHeartbeatContent = undefined;

    await this.progressTracker?.append({
      sessionId: run.sessionId,
      type: "decision",
      summary: truncate(`Background run blocked: ${decision.internalSummary}`, 200),
    });
    await this.persistRun(run, {
      type: "run_blocked",
      summary: truncate(`Background run blocked: ${decision.internalSummary}`, 200),
      timestamp: this.now(),
      data: {
        pendingSignals: run.pendingSignals.length,
      },
    });
    this.incrementRunTelemetryCounter(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_BLOCKED_TOTAL,
      run,
    );
    this.recordRunTelemetry(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_BLOCKED_WITHOUT_NOTICE_RATE,
      decision.shouldNotifyUser ? 0 : 1,
      run,
    );
    this.recordAlert({
      severity: decision.shouldNotifyUser ? "warn" : "error",
      code: "run_blocked",
      message: decision.internalSummary,
      run,
    });
    await this.runStore.releaseLease(run.sessionId, this.instanceId, this.now(), {
      ...toPersistedRun(run),
    });
    this.activeRuns.delete(run.sessionId);
    this.updateActiveGauge();
    await this.runStore.saveRecentSnapshot(
      toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
    );
    this.rememberStatusSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId));
    this.onStatus?.(run.sessionId, {
      phase: "background_blocked",
      detail: "Background run is blocked and waiting for a new signal or intervention",
    });
    if (decision.shouldNotifyUser) {
      await this.runStore.appendEvent(toPersistedRun(run), {
        type: "user_update",
        summary: truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS),
        timestamp: this.now(),
        data: {
          kind: "blocked_notice",
          verified: run.lastVerifiedAt !== undefined,
        },
      });
      await this.publishUpdate(run.sessionId, truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS));
    }
  }

  private async finishRun(
    run: ActiveBackgroundRun,
    decision: BackgroundRunDecision,
  ): Promise<void> {
    this.clearRunTimers(run);
    run.abortController?.abort();
    run.abortController = null;
    assertAgentRunStateTransition(run.state, decision.state, "finishRun");
    run.state = decision.state;
    run.updatedAt = this.now();
    clearRunBlockers(run);
    recordRunActivity(run, run.updatedAt, "progress");
    if (decision.shouldNotifyUser) {
      run.lastUserUpdate = truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS);
    }
    this.activeRuns.delete(run.sessionId);
    this.forgetStatusSnapshot(run.sessionId);
    await this.runStore.saveCheckpoint(toPersistedRun(run));
    await this.runStore.saveRecentSnapshot(
      toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
    );
    await this.wakeBus.clearSession(run.sessionId);

    const progressType = decision.state === "completed"
      ? "task_completed"
      : "error";
    await this.progressTracker?.append({
      sessionId: run.sessionId,
      type: progressType,
      summary: truncate(
        `Background run ${decision.state}: ${decision.internalSummary}`,
        200,
      ),
    });
    const eventType: BackgroundRunEventType =
      decision.state === "completed"
        ? "run_completed"
        : decision.state === "failed"
          ? "run_failed"
          : "run_cancelled";
    await this.runStore.appendEvent(toPersistedRun(run), {
      type: eventType,
      summary: truncate(
        `Background run ${decision.state}: ${decision.internalSummary}`,
        200,
      ),
      timestamp: this.now(),
      data:
        decision.state === "cancelled" && run.budgetState.stopRequestedAt !== undefined
          ? {
              stopRequestedAt: run.budgetState.stopRequestedAt,
            }
          : undefined,
    });
    if (this.notifier?.isEnabled()) {
      const summary = toOperatorSummary({
        snapshot: toRecentSnapshot(run, this.wakeBus.getQueuedCount(run.sessionId)),
        contract: run.contract,
        blocker: run.blocker,
        approvalState: run.approvalState,
        checkpointAvailable: true,
        now: this.now(),
      });
      await this.notifier.notify({
        occurredAt: this.now(),
        internalEventType: eventType,
        summary: truncate(
          `Background run ${decision.state}: ${decision.internalSummary}`,
          200,
        ),
        run: summary,
      });
    }
    const latencyMs = Math.max(0, run.updatedAt - run.createdAt);
    const durationSec = Math.max(1, Math.round(latencyMs / 1000));
    const completionDetail = decision.userUpdate || run.lastUserUpdate || "";
    const terminalPhase =
      decision.state === "completed"
        ? "background_completed"
        : decision.state === "failed"
          ? "background_failed"
          : "idle";
    this.onStatus?.(run.sessionId, {
      phase: terminalPhase,
      detail: completionDetail.length > 0
        ? `Background run ${decision.state} (${run.cycleCount} cycles, ${durationSec}s). ${completionDetail}`
        : `Background run ${decision.state} (${run.cycleCount} cycles, ${durationSec}s)`,
    });
    this.recordRunTelemetry(
      TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_LATENCY_MS,
      latencyMs,
      run,
    );
    if (decision.state === "completed") {
      this.incrementRunTelemetryCounter(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_COMPLETED_TOTAL,
        run,
      );
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_FALSE_COMPLETION_RATE,
        run.lastVerifiedAt === undefined ? 1 : 0,
        run,
      );
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_VERIFIER_ACCURACY,
        run.lastVerifiedAt === undefined ? 0 : 1,
        run,
      );
      this.recordAlert({
        severity: "info",
        code: "run_completed",
        message: decision.internalSummary,
        run,
      });
    } else if (decision.state === "failed") {
      this.incrementRunTelemetryCounter(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUNS_FAILED_TOTAL,
        run,
      );
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_VERIFIER_ACCURACY,
        run.lastVerifiedAt === undefined ? 0 : 1,
        run,
      );
      this.recordAlert({
        severity: "error",
        code: "run_failed",
        message: decision.internalSummary,
        run,
      });
    } else if (run.budgetState.stopRequestedAt !== undefined) {
      this.recordRunTelemetry(
        TELEMETRY_METRIC_NAMES.BACKGROUND_RUN_STOP_LATENCY_MS,
        Math.max(0, run.updatedAt - run.budgetState.stopRequestedAt),
        run,
      );
    }
    await this.runStore.deleteRun(run.sessionId);
    this.updateActiveGauge();

    if (decision.shouldNotifyUser) {
      await this.publishUpdate(run.sessionId, truncate(decision.userUpdate, MAX_USER_UPDATE_CHARS));
    }
  }
}

/**
 * Starts daemon-owned background agents through the existing delegate runtime.
 *
 * F-06a keeps the daemon surface narrow: `agent.create` requests become
 * `delegate(..., runInBackground: true)` launches, and the daemon holds the
 * bootstrap/session handles so the child loop remains alive after the JSON-RPC
 * response is returned.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { roughTokenCountEstimation } from "../llm/token-estimation.js";
import {
  bootstrapLocalRuntimeSession,
  type LocalRuntimeBootstrap,
} from "../bin/bootstrap.js";
import { ensureAgentControl } from "../bin/delegate-tool.js";
import { clearSession } from "../commands/clear.js";
import { runTurn } from "../session/run-turn.js";
import {
  prepareUserPromptForTurn,
  userPromptDisplayText,
} from "../hooks/user-prompt-ingress.js";
import type { AgentPath } from "../agents/registry.js";
import type { ManagedThread } from "../agents/thread-manager.js";
import { ConversationThreadManager } from "../conversation/thread-manager.js";
import type { RunAgentProgressEvent } from "../agents/run-agent.js";
import type { AuthBackend } from "../auth/backend.js";
import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import { routerFromRegistry } from "../tools/router.js";
import { buildLiveToolDispatchOptions } from "../phases/execute-tools.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import { stableStringify } from "../utils/stableStringify.js";
import { logForDebugging } from "../utils/debug.js";
import {
  runWithBootstrapSessionScope,
  runWithCurrentRuntimeSession,
} from "../session/current-session.js";
import {
  runWithCanonicalSettingsAuthority,
} from "../utils/settings/canonicalAuthority.js";
import { resolveDefaultShell } from "../utils/shell/resolveDefaultShell.js";
import { escapeXml } from "../utils/xml.js";
import {
  canCycleToAuto,
  createDisabledAutoModeContext,
  transitionPermissionMode,
} from "../permissions/permission-mode.js";
import {
  applyPermissionRulesSnapshot,
  loadPermissionRulesSnapshot,
} from "../permissions/settings.js";
import { parseRuleString, serializeRuleValue } from "../permissions/rules.js";
import {
  authorizeBypassPermissionsConsent,
  canonicalizeBypassPermissionsCwd,
  loadBypassPermissionsConsent,
} from "../permissions/bypass-consent-state.js";
import {
  isPermissionMode,
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";
import {
  mutatePermissionRuleSource,
  PermissionRuleMutationPrecommitError,
} from "../permissions/permission-updates.js";
import { applyModelSwitch } from "../commands/model.js";
import type {
  ProviderModelSelectionOutcome,
} from "../contracts/provider-model-selection.js";
import {
  readSessionSelection,
  resolveProviderModelSelection,
} from "../session/provider-model-selection.js";
import { applyProviderSwitch } from "../commands/provider.js";
import { resolveProfile } from "../config/profiles.js";
import {
  resolveLiveEffectPoison,
} from "../budget/effect-settlement-supervisor.js";
import {
  resolveLiveDurableEffectReview,
  type ResolveDurableEffectReviewOptions,
  type ResolveDurableEffectReviewResult,
} from "../state/effect-review.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import { mergeDaemonClientEnvironment } from "./client-env-snapshot.js";
import {
  permissionGrantsFromToolPermissionContext,
} from "../permissions/permission-grants.js";
import {
  ABORT,
  DENIED,
  TIMED_OUT,
  type ReviewDecision,
} from "../permissions/review-decision.js";
import type {
  McpServerMutationResult,
  McpSurfaceSnapshot,
  PreparedSessionProviderSwitch,
  Session,
} from "../session/session.js";
import type { Event } from "../session/event-log.js";
import type { TurnContext } from "../session/turn-context.js";
import {
  editorInteractionSystemPrompt,
} from "../session/editor-interaction.js";
import type {
  CodePredictionSource,
} from "../services/code-prediction/types.js";
import { respondToSessionElicitation } from "../elicitation/respond.js";
import type {
  AgentStatus as DaemonAgentStatus,
  JsonObject,
  PermissionListResult,
  SessionPartialCompactFromMessageResult,
  SessionRollbackCompactionResult,
  SessionExtendCompactionRollbackRetentionResult,
  SessionRewindConversationToMessageResult,
  SessionPreviewFileRewindResult,
  SessionRewindFilesToMessageResult,
  SessionSnapshotResult,
  SessionTranscriptResult,
  SessionTranscriptV2Result,
  SessionPermissionRuleMutationParams,
  SessionShellExecuteParams,
  SessionShellExecuteResult,
} from "./protocol/index.js";
import type { AgenCRealtimeThreadBinding } from "./realtime.js";
import type { AgenCRealtimeCallClient } from "./realtime-transport.js";
import type {
  RealtimeTransportConnection,
} from "../conversation/realtime/conversation.js";
import type {
  RealtimeStartupContextSessionLike,
} from "../conversation/realtime/context.js";
import {
  createAgenCDaemonRuntimeAuthBackend,
  type AgenCDaemonRuntimeAuthBackend,
} from "./provider-key-vending.js";
import type {
  ExecutionAdmissionKernel,
} from "../budget/execution-admission-kernel.js";
import type {
  CsvAgentJobsRepositoryProvider,
} from "./csv-agent-jobs-authority.js";
import {
  RUN_RUNTIME_MODEL_VERBOSITIES,
  RUN_RUNTIME_REASONING_EFFORTS,
  RUN_RUNTIME_SERVICE_TIERS,
  type RunRuntimeSettingsChangeReason,
  type RunRuntimeSettingsSnapshot,
} from "../contracts/run-contracts.js";
import {
  cloneFrozenRuntimeSettingsSnapshot,
} from "../state/runtime-settings-snapshot.js";
import { runWithAgentRuntimeOptions } from "../session/runtime-options.js";

import {
  AgenCBackgroundAgentSuspensionShutdownError,
  AgenCBackgroundAgentMessageError,
  DAEMON_USER_PROMPT_PREPARED,
  positiveSequence,
  finiteNumber,
  messageContentFingerprint,
  metadataStringList,
  isJsonObject,
  isToolRecoveryCategory,
  hashStable,
} from "./background-agent-runner/shared.js";
import type {
  AgenCBackgroundAgentStartParams,
  AgenCBackgroundAgentStartResult,
  AgenCBackgroundAgentRestoreParams,
  AgenCBackgroundAgentReplayToolCall,
  AgenCBackgroundAgentReplayToolResult,
  AgenCBackgroundAgentSnapshot,
  AgenCBackgroundAgentDaemonShutdownResult,
  AgenCBackgroundAgentCancellationPreparation,
  AgenCBackgroundAgentTurnCancellationResult,
  AgenCBackgroundAgentSessionEventBinding,
  AgenCBackgroundAgentMessageParams,
  AgenCBackgroundAgentMessageResult,
  DaemonSessionSubmitOptions,
  AgenCBackgroundAgentClearSessionParams,
  AgenCBackgroundAgentSnapshotSessionParams,
  AgenCBackgroundAgentMcpAddServerParams,
  AgenCBackgroundAgentMcpServerByNameParams,
  AgenCBackgroundAgentPartialCompactParams,
  AgenCBackgroundAgentRollbackCompactionParams,
  AgenCBackgroundAgentExtendCompactionRetentionParams,
  AgenCBackgroundAgentConversationRewindParams,
  AgenCBackgroundAgentSetModelParams,
  AgenCBackgroundAgentSetModelResult,
  AgenCBackgroundAgentSetPermissionModeParams,
  AgenCBackgroundAgentSetPermissionModeResult,
  AgenCBackgroundAgentPermissionRuleMutationResult,
  AgenCBackgroundAgentHooksStatusResult,
  AgenCBackgroundAgentSetHooksDisabledParams,
  AgenCBackgroundAgentSetHooksDisabledResult,
  AgenCBackgroundAgentApplyConfigParams,
  AgenCBackgroundAgentApplyConfigResult,
  AgenCBackgroundAgentToolDecisionParams,
  AgenCBackgroundAgentToolCancelParams,
  AgenCBackgroundAgentElicitationResponseParams,
  AgenCBackgroundAgentRunner,
  AgenCBootstrapFunction,
  AgenCEnsureAgentControlFunction,
  AgenCBackgroundRealtimeTransportConnector,
  ActiveBackgroundAgent,
  ActiveMessageSubmission,
  ActiveShellExecution,
  BackgroundAgentDaemonEvent,
  AgenCDelegateBackgroundAgentRunnerOptions,
  AgenCDelegateBackgroundAgentRunnerRuntimeConfig,
} from "./background-agent-runner/shared.js";
import {
  boundBufferedAgentEvents,
  terminalUsageForActiveAgent,
  pruneShellExecutionCache,
  pruneMessageSubmissionCache,
} from "./background-agent-runner/snapshot-retention.js";
import {
  phaseEventToProgressEvent,
  canonicalSessionEventFromRecoveredProgress,
  interruptedToolResultContent,
} from "./background-agent-runner/progress-events.js";
import {
  sessionUserMessageEventFromDaemonEvent,
  correlateDaemonEvent,
  projectTelemetryErrorAsSessionOnly,
  scopeDirectShellDaemonEvent,
  notificationFromDaemonEvent,
  daemonStatusFromRunTerminal,
  daemonEventFromUnboundSessionEvent,
  mapThreadStatus,
  eventFromThreadStatus,
} from "./background-agent-runner/daemon-events.js";
import {
  historyEpochFromRollout,
  findPersistedMessageSubmission,
  sessionTranscriptV2FromRollout,
  currentRunEpochFromRollout,
} from "./background-agent-runner/journal-reconstruction.js";
import {
  isRunnableActiveAgent,
  isInterruptibleActiveAgent,
  hasRuntimeActiveTurn,
  hasOpenAgentDescendants,
  runtimeActiveTurnId,
  isClearInFlight,
  shellSubmissionMessageId,
  shellEventKey,
  throwIfShellRequestAborted,
  normalizeSessionShellResult,
  clientMessageIdConflict,
  messageContentToLlmParts,
  commitDurableRunStartupActivation,
  awaitTerminalStatus,
  commitDurableRunCancellationRequest,
  commitDurableRunTerminal,
  commitDurableRunSuspension,
  cancelledTerminalResult,
  terminalResultFromThread,
  messageContentToAgentInput,
  submitStructuredAgentInput,
  messageContentDisplayText,
} from "./background-agent-runner/turn-lifecycle.js";
import {
  replayRecoveredToolCalls,
  hydrateRecoveredSessionHistory,
  resolvePermissionDecisionTimeoutMs,
  readApprovalAgentId,
} from "./background-agent-runner/tool-recovery.js";
import {
  configuredHookExecutionState,
  runtimeWorkspaceRoot,
  requireCanonicalRuntimeSettingsSupport,
  failClosedDaemonRuntimeAuthority,
  installDaemonPermissionAuthorityCoordinator,
  prepareMcpAuthorityRefresh,
  captureRuntimeSettings,
  normalizeRuntimeSetting,
  installRuntimeSettingsPreCommit,
  withRuntimeSettingsMutation,
  ensureInitialRuntimeSettings,
  compensateRuntimeSettingsChange,
  compensatePreparedRuntimeSettingsChange,
  applyRestoredRuntimeSettings,
  currentCanonicalRuntimeStateFromRollout,
  commitDurableRuntimeSettingsChange,
  prepareDurableRuntimeSettingsChange,
  restoreBootstrapSelection,
  runtimeSettingsWithRestoreOverrides,
  buildBootstrapArgv,
  installUnattendedPermissionPolicy,
} from "./background-agent-runner/runtime-settings.js";
import type {
  PreparedRuntimeSettingsChange,
} from "./background-agent-runner/runtime-settings.js";

export {
  AgenCBackgroundAgentSuspensionShutdownError,
  AgenCBackgroundAgentMessageError,
} from "./background-agent-runner/shared.js";
export type {
  AgenCBackgroundAgentStartParams,
  AgenCBackgroundAgentStartResult,
  AgenCBackgroundAgentRestoreParams,
  AgenCBackgroundAgentReplayToolCall,
  AgenCBackgroundAgentReplayToolResult,
  AgenCBackgroundAgentSnapshot,
  AgenCBackgroundAgentTerminalSnapshot,
  AgenCBackgroundAgentSuspensionSnapshot,
  AgenCBackgroundAgentDaemonShutdownResult,
  AgenCBackgroundAgentCancellationPreparation,
  AgenCBackgroundAgentTurnCancellationResult,
  AgenCBackgroundAgentSessionEventBinding,
  AgenCBackgroundAgentMessageParams,
  AgenCBackgroundAgentMessageResult,
  AgenCBackgroundAgentMessageTerminal,
  AgenCBackgroundAgentMessageErrorCode,
  AgenCBackgroundAgentClearSessionParams,
  AgenCBackgroundAgentSnapshotSessionParams,
  AgenCBackgroundAgentMcpAddServerParams,
  AgenCBackgroundAgentMcpServerByNameParams,
  AgenCBackgroundAgentPartialCompactParams,
  AgenCBackgroundAgentRollbackCompactionParams,
  AgenCBackgroundAgentExtendCompactionRetentionParams,
  AgenCBackgroundAgentConversationRewindParams,
  AgenCBackgroundAgentSetModelParams,
  AgenCBackgroundAgentSetModelResult,
  AgenCBackgroundAgentSetPermissionModeParams,
  AgenCBackgroundAgentSetPermissionModeResult,
  AgenCBackgroundAgentPermissionRuleMutationResult,
  AgenCBackgroundAgentHooksStatusResult,
  AgenCBackgroundAgentSetHooksDisabledParams,
  AgenCBackgroundAgentSetHooksDisabledResult,
  AgenCBackgroundAgentApplyConfigParams,
  AgenCBackgroundAgentApplyConfigResult,
  AgenCBackgroundAgentToolDecisionParams,
  AgenCBackgroundAgentToolCancelParams,
  AgenCBackgroundAgentElicitationResponseParams,
  AgenCBackgroundAgentRunner,
  AgenCRunAgentFunction,
  AgenCBootstrapFunction,
  AgenCEnsureAgentControlFunction,
  AgenCBackgroundRealtimeTransportConnector,
  AgenCDelegateBackgroundAgentRunnerOptions,
  AgenCDelegateBackgroundAgentRunnerRuntimeConfig,
} from "./background-agent-runner/shared.js";
export {
  managedTokenUsage,
} from "./background-agent-runner/snapshot-retention.js";
export {
  phaseEventToProgressEvent,
} from "./background-agent-runner/progress-events.js";
export {
  notificationFromDaemonEvent,
  daemonEventFromUnboundSessionEvent,
} from "./background-agent-runner/daemon-events.js";
export {
  sessionTranscriptV2FromRollout,
} from "./background-agent-runner/journal-reconstruction.js";
export {
  resolvePermissionDecisionTimeoutMs,
  planApprovalPayloadFields,
} from "./background-agent-runner/tool-recovery.js";

export class AgenCDelegateBackgroundAgentRunner implements AgenCBackgroundAgentRunner {
  readonly #bootstrap: AgenCBootstrapFunction;
  readonly #requireSandboxReadyAtStartup: boolean;
  readonly #ensureAgentControl: AgenCEnsureAgentControlFunction;
  #authBackend: AgenCDaemonRuntimeAuthBackend | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #executionAdmissionKernel: ExecutionAdmissionKernel | undefined;
  readonly #csvAgentJobsRepositories:
    CsvAgentJobsRepositoryProvider | undefined;
  readonly #argv: readonly string[] | undefined;
  readonly #now: () => string;
  #realtimeCallClient: AgenCRealtimeCallClient | undefined;
  #realtimeConnectTransport: AgenCBackgroundRealtimeTransportConnector;
  readonly #active = new Map<string, ActiveBackgroundAgent>();
  readonly #pendingExplicitRestores = new Set<string>();
  readonly #pendingEvents = new Map<string, BackgroundAgentDaemonEvent[]>();
  readonly #pendingActiveToolCallIds = new Map<string, Set<string>>();
  readonly #assistantTextByAgent = new Map<string, string>();
  readonly #pendingToolDecisions = new Map<
    string,
    Map<string, (decision: ReviewDecision) => void>
  >();
  #onActiveAgentTerminated:
    | ((
        agentId: string,
        snapshot: AgenCBackgroundAgentSnapshot,
      ) => void | Promise<void>)
    | undefined;

  constructor(options: AgenCDelegateBackgroundAgentRunnerOptions = {}) {
    this.#bootstrap = options.bootstrap ?? bootstrapLocalRuntimeSession;
    this.#requireSandboxReadyAtStartup = options.bootstrap === undefined;
    this.#ensureAgentControl = options.ensureAgentControl ?? ensureAgentControl;
    this.updateAuthBackend(options.authBackend);
    this.#executionAdmissionKernel = options.executionAdmissionKernel;
    this.#csvAgentJobsRepositories = options.csvAgentJobsRepositories;
    this.#env = options.env;
    this.#argv = options.argv;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#realtimeCallClient = options.realtimeCallClient;
    this.#realtimeConnectTransport =
      options.realtimeConnectTransport ?? unavailableRealtimeTransport;
    this.#onActiveAgentTerminated = options.onActiveAgentTerminated;
  }

  setOnActiveAgentTerminated(
    callback: (
      agentId: string,
      snapshot: AgenCBackgroundAgentSnapshot,
    ) => void | Promise<void>,
  ): void {
    this.#onActiveAgentTerminated = callback;
  }

  updateRuntimeConfig(
    options: AgenCDelegateBackgroundAgentRunnerRuntimeConfig,
  ): void {
    this.updateAuthBackend(options.authBackend);
    this.#realtimeCallClient = options.realtimeCallClient;
    this.#realtimeConnectTransport =
      options.realtimeConnectTransport ?? unavailableRealtimeTransport;
  }

  updateAuthBackend(authBackend: AuthBackend | undefined): void {
    if (authBackend === undefined) {
      this.#authBackend = undefined;
      return;
    }
    if (this.#authBackend === undefined) {
      this.#authBackend = createAgenCDaemonRuntimeAuthBackend(authBackend);
      return;
    }
    this.#authBackend.replaceBackend(authBackend);
  }

  async startAgent(
    params: AgenCBackgroundAgentStartParams,
  ): Promise<AgenCBackgroundAgentStartResult> {
    // Materialize the client's complete allowlisted snapshot on top of the
    // runner's captured env. Protocol clear markers become absent runtime keys
    // so daemon-start provider/config values cannot leak into this session.
    const mergedEnv = mergeDaemonClientEnvironment(
      this.#env,
      params.envOverrides,
    );
    // Bootstrap runs helper code that resolves the runtime-options
    // authority ambiently. With a second live session in this process the
    // module-level session fallback is ambiguous by design, so the
    // options must ride the async context — the same scope the daemon-only
    // TUI client establishes before ITS bound context is created.
    const bootstrap = await runWithAgentRuntimeOptions(
      params.runtimeOptions,
      () =>
        runWithBootstrapSessionScope(() =>
          this.#bootstrap({
      ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
      ...(this.#authBackend !== undefined
        ? { authBackend: this.#authBackend }
        : {}),
      argv: buildBootstrapArgv(params, this.#argv),
      runtimeOptions: params.runtimeOptions,
      // Daemon agents are unattended execution for budget policy, but this
      // hint deliberately does not enable autonomous keepalive ticks.
      executionAdmissionAutonomous: true,
      ...(params.initialEditorInteraction !== undefined ||
      params.deferInitialTurn === true
        ? {
            deferSessionStartHooks: true,
            deferAgentStartupSideEffects: true,
          }
        : {}),
      ...(this.#requireSandboxReadyAtStartup
        ? { requireSandboxReadyAtStartup: true }
        : {}),
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(this.#executionAdmissionKernel !== undefined
        ? { executionAdmissionKernel: this.#executionAdmissionKernel }
        : {}),
      ...(this.#csvAgentJobsRepositories !== undefined
        ? { csvAgentJobsRepositories: this.#csvAgentJobsRepositories }
        : {}),
          }),
        ),
    );
    const uninstallApprovalBridge = this.#installDaemonApprovalBridge(
      bootstrap.session,
    );
    installDaemonTurnDriverHooks(bootstrap.session, bootstrap.configStore);

    let authorityOwner: ActiveBackgroundAgent | undefined;
    let uninstallPermissionAuthorityCoordinator = (): void => {};
    try {
      uninstallPermissionAuthorityCoordinator =
        installDaemonPermissionAuthorityCoordinator(
          bootstrap,
          () => authorityOwner,
        );
      const { control } = this.#ensureAgentControl(bootstrap.session);
      // The unattended policy is an internal daemon execution boundary, not
      // the user's durable interactive authority. Preserve the bootstrap
      // selection before installing that boundary so a default TUI session is
      // canonically resumable as `default` after a daemon restart.
      let initialInteractivePermissionContext =
        bootstrap.session.permissionModeRegistry.current();
      const initialBypassTransition =
        initialInteractivePermissionContext.mode === "bypassPermissions" ||
        (initialInteractivePermissionContext.mode === "plan" &&
          initialInteractivePermissionContext.prePlanMode ===
            "bypassPermissions");
      const explicitlyRequestedBypassTransition =
        params.permissionMode === "bypassPermissions" ||
        (params.permissionMode === "plan" && initialBypassTransition);
      const workspaceRoot = canonicalizeBypassPermissionsCwd(
        runtimeWorkspaceRoot(bootstrap),
      );
      if (
        explicitlyRequestedBypassTransition &&
        !initialInteractivePermissionContext.bypassPermissionsAcceptedIn?.includes(
          workspaceRoot,
        )
      ) {
        // `--dangerously-bypass-approvals-and-sandbox` is explicit operator authority for this exact startup
        // workspace. Bind that authority into the live registry before the
        // durable snapshot is captured; otherwise canonical persistence would
        // either invent a broader grant or reject the legitimate startup.
        initialInteractivePermissionContext = {
          ...initialInteractivePermissionContext,
          bypassPermissionsAcceptedIn: [
            ...(initialInteractivePermissionContext.bypassPermissionsAcceptedIn ??
              []),
            workspaceRoot,
          ],
        };
        await bootstrap.session.permissionModeRegistry.update(
          initialInteractivePermissionContext,
        );
      }
      await installUnattendedPermissionPolicy(
        bootstrap.session.permissionModeRegistry,
        params.unattendedAllow,
        params.unattendedDeny,
      );

      // Upstream-parity top-level executor: bootstrap already registered
      // the root session as a ManagedThread via
      // ConversationThreadManager.registerConversationRootSession
      // (bin/bootstrap.ts:1303). The first user message arrives via
      // message.stream — the session is idle at startAgent time. No
      // forkSubagent, no buildDirective, no AgentTool dispatcher.
      const conversationThreadManager = (
        bootstrap.session.services as {
          conversationThreadManager?: ConversationThreadManager;
        }
      ).conversationThreadManager;
      if (conversationThreadManager === undefined) {
        throw new Error(
          "bootstrap.session is missing conversationThreadManager",
        );
      }
      if (
        !conversationThreadManager.hasThread(bootstrap.session.conversationId)
      ) {
        throw new Error(
          `expected root managed thread for ${bootstrap.session.conversationId}`,
        );
      }
      const managedThread = conversationThreadManager.getThread(
        bootstrap.session.conversationId,
      );
      if (managedThread.kind !== "root") {
        throw new Error(
          `expected root managed thread, got kind=${managedThread.kind}`,
        );
      }

      const taskContent =
        params.deferInitialTurn === true
          ? []
          : messageContentToLlmParts(params.initialContent);
      const firstInput: string | readonly LLMContentPart[] =
        taskContent ?? params.objective;
      const hasFirstInput =
        typeof firstInput === "string"
          ? firstInput.trim().length > 0
          : firstInput.length > 0;
      const startedAt = this.#now();
      const active: ActiveBackgroundAgent = {
        bootstrap,
        control,
        thread: managedThread,
        status: "running",
        startedAt,
        runEpoch: currentRunEpochFromRollout(bootstrap, managedThread.threadId),
        canonicalEventBridgeInstalled: false,
        durableTerminalFinalizerInstalled: false,
        lastActiveAt: startedAt,
        uninstallApprovalBridge,
        bufferedEvents: boundBufferedAgentEvents(
          this.#pendingEvents.get(managedThread.threadId) ?? [],
          managedThread.threadId,
        ),
        activeToolCallIds:
          this.#pendingActiveToolCallIds.get(managedThread.threadId) ??
          new Set(),
        historyEpoch: historyEpochFromRollout(
          bootstrap.rolloutStore.readAll(),
          managedThread.threadId,
        ),
        messageSubmissionQueue: Promise.resolve(),
        runtimeSettingsMutationQueue: Promise.resolve(),
        cleanupComplete: Promise.resolve(),
        pendingMessageSubmissionCount: 0,
        messageSubmissionsById: new Map(),
        pendingShellExecutionCount: 0,
        shellExecutionsById: new Map(),
        dispatchChain: Promise.resolve(),
      };
      authorityOwner = active;
      // Prompt preparation emits canonical warnings and errors. Subscribe as
      // soon as the unpublished active record exists so those events are
      // buffered for the eventual attach instead of falling into the gap
      // between bootstrap and active-map publication.
      active.unsubscribeElicitationEvents =
        this.#installSessionEventLogBridge(active);

      let preparedFirstInput = firstInput;
      if (hasFirstInput && params.initialEditorInteraction === undefined) {
        const prepared = await prepareDaemonUserPrompt({
          session: bootstrap.session,
          configStore: bootstrap.configStore,
          input: firstInput,
        });
        if (prepared.blocked) {
          throw new AgenCBackgroundAgentMessageError(
            "PROMPT_BLOCKED",
            prepared.blockMessage ?? "UserPromptSubmit hook blocked the prompt",
          );
        }
        preparedFirstInput = prepared.input;
      }

      requireCanonicalRuntimeSettingsSupport(active, managedThread.threadId);
      const initialRuntimeSettings = captureRuntimeSettings(active, {
        permissionContext: initialInteractivePermissionContext,
        ...(params.profile !== undefined ? { profile: params.profile } : {}),
      });
      commitDurableRuntimeSettingsChange(
        active,
        managedThread.threadId,
        initialRuntimeSettings,
        "initial",
      );
      const uninstallRuntimeSettingsPreCommit = installRuntimeSettingsPreCommit(
        active,
        managedThread.threadId,
      );
      active.uninstallRuntimeSettingsPreCommit = () => {
        uninstallRuntimeSettingsPreCommit();
        uninstallPermissionAuthorityCoordinator();
      };
      this.#pendingEvents.delete(managedThread.threadId);
      this.#pendingActiveToolCallIds.delete(managedThread.threadId);
      this.#active.set(managedThread.threadId, active);
      active.unsubscribeMcpSurfaceInvalidations =
        this.#installMcpSurfaceInvalidationBridge(active);
      this.#installDurableTerminalFinalizer(active, managedThread.threadId);
      this.#trackAgentStatus(active);
      // Phase events update runner-local bookkeeping only. Canonical live
      // delivery comes from Session.EventLog so replay and live clients see
      // the exact same event id + positive sequence.
      active.unsubscribePhaseEvents = bootstrap.session.subscribeToEvents(
        (phase) => {
          const progress = phaseEventToProgressEvent(phase);
          if (progress === null) return;
          void this.#recordPhaseProgressEvent(managedThread.threadId, progress);
        },
      );
      active.cleanupComplete = this.#cleanupWhenComplete(
        managedThread.threadId,
        active,
      );

      // Deliver the first user input through the same path turn N uses:
      // ManagedThread.submit({type: "user_input"}) → submitToSession →
      // session.submit(input) → runTurn. No directive, no fork, no
      // AgentTool dispatcher. This mirrors the upstream `turn_start`
      // shape for the first message.
      if (hasFirstInput) {
        // Emit the user_message daemon event for the initial content so
        // the TUI transcript can render it. Turn 2+ goes through
        // `submitAgentMessage` (message.stream RPC) which emits its own
        // user_message event directly. Turn 1 reaches the session via
        // `managedThread.submit({type: "user_input"})` → runTurn, but
        // the daemon turn-driver hooks force `displayUserMessage: null`
        // on runTurn to prevent dedup-incompatible duplicate emits.
        // Without this explicit emit the first user prompt is invisible
        // in the transcript.
        //
        // The event is buffered when `sessionBinding === undefined`
        // (the TUI's `agent.attach` has not yet completed) and replayed
        // when the binding attaches, so it always reaches the
        // subscriber.
        const transcriptContent = params.initialContent ?? params.objective;
        if (params.initialDisplayUserMessage !== null) {
          const displayText =
            params.initialDisplayUserMessage ??
            messageContentDisplayText(transcriptContent);
          if (displayText.length > 0) {
            await this.#emitPersistedUserMessage(active, {
              id: `user-initial-${managedThread.threadId}`,
              type: "user_message",
              payload: {
                message: transcriptContent,
                displayText,
              },
            });
          }
        }
        const firstSubmitOptions: DaemonSessionSubmitOptions = {
          ...(params.initialEditorInteraction === undefined
            ? { [DAEMON_USER_PROMPT_PREPARED]: true as const }
            : {}),
          displayUserMessage:
            params.initialDisplayUserMessage === undefined
              ? messageContentDisplayText(transcriptContent)
              : params.initialDisplayUserMessage,
          ...(params.initialEditorInteraction !== undefined
            ? {
                editorInteraction: params.initialEditorInteraction,
              }
            : {}),
        };
        active.pendingMessageSubmissionCount += 1;
        const initialSubmission = active.messageSubmissionQueue.then(() =>
          runWithCurrentRuntimeSession(active.bootstrap.session, () =>
            managedThread.submit({
              type: "user_input",
              input: preparedFirstInput,
              submitOptions: firstSubmitOptions,
            }),
          ),
        );
        const trackedInitialSubmission = initialSubmission.finally(() => {
          active.pendingMessageSubmissionCount = Math.max(
            0,
            active.pendingMessageSubmissionCount - 1,
          );
        });
        active.messageSubmissionQueue = trackedInitialSubmission.then(
          () => {},
          () => {},
        );
        void trackedInitialSubmission.catch(() => {
          /* first-turn submission errors surface via session events */
        });
      }

      const rolloutIdentity =
        bootstrap.rolloutStore.store?.canonicalSourceIdentity?.();
      return {
        agentId: managedThread.threadId,
        agentPath: managedThread.agentPath ?? ("/root" as AgentPath),
        startedAt,
        status: "running",
        ...(rolloutIdentity !== undefined
          ? {
              rolloutPath: rolloutIdentity.rolloutPath,
              rolloutDev: rolloutIdentity.dev,
              rolloutIno: rolloutIdentity.ino,
            }
          : {}),
      };
    } catch (error) {
      uninstallPermissionAuthorityCoordinator();
      uninstallApprovalBridge();
      await bootstrap.shutdown().catch(() => {});
      throw error;
    }
  }

  async getAgentSnapshot(
    agentId: string,
  ): Promise<AgenCBackgroundAgentSnapshot | null> {
    const active = this.#active.get(agentId);
    if (active === undefined) return null;
    // The active map is the source of truth for "agent exists." A turn
    // reaching a `final` thread status (completed / cancelled / failed
    // mid-turn) does NOT mean the agent has been stopped — only
    // `stopAgent` removes from `#active`. Returning null here used to
    // mislead AgentLifecycle.#refreshAgentFromRunner into evicting the
    // agent from `state.agents`, so the next user turn's `message.stream`
    // resolved to AGENT_NOT_FOUND and crashed the TUI client. Snapshot
    // the real status; let the caller decide whether to re-engage.
    return withRuntimeSettingsMutation(active, async () => {
      if (this.#active.get(agentId) !== active) return null;
      return {
        status: active.status,
        lastActiveAt: active.lastActiveAt,
        ...(active.runtimeSettings !== undefined
          ? {
              runtimeSettings: cloneFrozenRuntimeSettingsSnapshot(
                active.runtimeSettings,
              ),
            }
          : {}),
        ...(active.runtimeSettingsEventId !== undefined
          ? { runtimeSettingsEventId: active.runtimeSettingsEventId }
          : {}),
        ...(active.terminal !== undefined ? { terminal: active.terminal } : {}),
        ...(active.suspension !== undefined
          ? { suspension: active.suspension }
          : {}),
      };
    });
  }

  async listPermissions(agentId: string): Promise<PermissionListResult | null> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) return null;
    return {
      permissions: permissionGrantsFromToolPermissionContext(
        active.bootstrap.session.permissionModeRegistry.current(),
      ),
    };
  }

  async resolveRealtimeThread(
    threadId: string,
  ): Promise<AgenCRealtimeThreadBinding | null> {
    const active = this.#active.get(threadId);
    if (active === undefined || !isRunnableActiveAgent(active)) return null;
    return {
      threadId,
      conversation: active.bootstrap.session.conversation,
      session: active.bootstrap
        .session as unknown as RealtimeStartupContextSessionLike,
      connectTransport: this.#realtimeConnectTransport,
      ...(this.#realtimeCallClient !== undefined
        ? { callClient: this.#realtimeCallClient }
        : {}),
      routeRealtimeTextInput: (text) =>
        active.control.sendInput(threadId, text),
    };
  }

  async restoreAgent(
    params: AgenCBackgroundAgentRestoreParams,
  ): Promise<boolean> {
    if (
      params.restoreAttemptId !== undefined &&
      params.restoreAttemptId.length === 0
    ) {
      throw new TypeError("restore attempt id must be non-empty");
    }
    const explicitRestore =
      params.explicitColdResume === true ||
      params.reopenTerminalRun === true ||
      params.resumeSuspendedRun === true;
    if (explicitRestore && this.#pendingExplicitRestores.has(params.agentId)) {
      throw new Error(
        `canonical session ${params.agentId} is already being restored`,
      );
    }
    if (explicitRestore) this.#pendingExplicitRestores.add(params.agentId);
    try {
      const previous = this.#active.get(params.agentId);
      if (previous !== undefined) {
        if (!explicitRestore) return true;
        await previous.cleanupComplete;
        if (this.#active.get(params.agentId) === previous) {
          throw new Error(
            `terminal generation ${params.agentId} did not relinquish its runtime`,
          );
        }
        if (this.#active.has(params.agentId)) {
          throw new Error(
            `canonical session ${params.agentId} gained another live generation`,
          );
        }
      }
      let bootstrap: LocalRuntimeBootstrap | undefined;
      let uninstallApprovalBridge: (() => void) | undefined;
      let authorityOwner: ActiveBackgroundAgent | undefined;
      let uninstallPermissionAuthorityCoordinator = (): void => {};
      let insertedGeneration: ActiveBackgroundAgent | undefined;
      try {
        // Restores retain the same complete per-client snapshot semantics as
        // first start, including removal of cleared daemon-start state.
        const mergedEnv = mergeDaemonClientEnvironment(
          this.#env,
          params.envOverrides,
        );
        // Same ambient-authority scope as first start: restores also run
        // bootstrap helpers outside any session context.
        bootstrap = await runWithAgentRuntimeOptions(
          params.runtimeOptions,
          () =>
            runWithBootstrapSessionScope(() =>
              this.#bootstrap({
          ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
          ...(this.#authBackend !== undefined
            ? { authBackend: this.#authBackend }
            : {}),
          conversationId: params.agentId,
          runtimeOptions: params.runtimeOptions,
          resumeConversation: true,
          ...(params.resumeRolloutPath !== undefined
            ? { resumeRolloutPath: params.resumeRolloutPath }
            : {}),
          ...(params.resumeRolloutLease !== undefined
            ? { resumeRolloutLease: params.resumeRolloutLease }
            : {}),
          ...(params.resumeCwdIdentity !== undefined
            ? { resumeCwdIdentity: params.resumeCwdIdentity }
            : {}),
          ...(params.resumeCwdFd !== undefined
            ? { resumeCwdFd: params.resumeCwdFd }
            : {}),
          ...(params.reopenTerminalRun === true
            ? { reopenTerminalConversation: true }
            : {}),
          ...(params.resumeSuspendedRun === true
            ? {
                resumeSuspendedConversation: true,
                suspendedResumeReason:
                  params.suspendedResumeReason ?? "explicit_continue",
              }
            : {}),
          deferSessionStartHooks: true,
          ...(params.resumeSuspendedRun === true ||
          params.resumeStartupActivationPending === true
            ? {
                deferAgentStartupSideEffects: true,
              }
            : {}),
          argv: buildBootstrapArgv(
            restoreBootstrapSelection(params),
            this.#argv,
          ),
          executionAdmissionAutonomous: true,
          ...(this.#requireSandboxReadyAtStartup
            ? { requireSandboxReadyAtStartup: true }
            : {}),
          ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
          ...(this.#executionAdmissionKernel !== undefined
            ? { executionAdmissionKernel: this.#executionAdmissionKernel }
            : {}),
          ...(this.#csvAgentJobsRepositories !== undefined
            ? { csvAgentJobsRepositories: this.#csvAgentJobsRepositories }
            : {}),
              }),
            ),
        );
        uninstallApprovalBridge = this.#installDaemonApprovalBridge(
          bootstrap.session,
        );
        installDaemonTurnDriverHooks(bootstrap.session, bootstrap.configStore);
        uninstallPermissionAuthorityCoordinator =
          installDaemonPermissionAuthorityCoordinator(
            bootstrap,
            () => authorityOwner,
          );
        const { control } = this.#ensureAgentControl(bootstrap.session);
        await installUnattendedPermissionPolicy(
          bootstrap.session.permissionModeRegistry,
          metadataStringList(params.metadata, "unattendedAllow"),
          metadataStringList(params.metadata, "unattendedDeny"),
        );
        const canonicalRuntimeState = currentCanonicalRuntimeStateFromRollout(
          bootstrap,
          params.agentId,
        );
        if (
          params.runtimeSettings !== undefined &&
          stableStringify(params.runtimeSettings) !==
            stableStringify(canonicalRuntimeState.runtimeSettings)
        ) {
          throw new Error(
            `restoreAgent runtime settings disagree with canonical run ${params.agentId}`,
          );
        }
        let restoredRuntimeSettings = canonicalRuntimeState.runtimeSettings;
        if (restoredRuntimeSettings !== undefined) {
          restoredRuntimeSettings = await applyRestoredRuntimeSettings(
            bootstrap,
            restoredRuntimeSettings,
          );
        }
        if (
          params.resumeSuspendedRun !== true &&
          params.resumeStartupActivationPending !== true
        ) {
          await bootstrap.session.flushDeferredSessionStartHook();
        }

        // Upstream-parity restore: the bootstrap session is already
        // hydrated from its rollout file (bootstrapLocalRuntimeSession
        // reads existingItems and replays them via
        // ConversationThreadManager.replayRolloutIntoSession in
        // bin/bootstrap.ts). The root ManagedThread is already registered
        // by registerConversationRootSession.
        const conversationThreadManager = (
          bootstrap.session.services as {
            conversationThreadManager?: ConversationThreadManager;
          }
        ).conversationThreadManager;
        if (conversationThreadManager === undefined) {
          throw new Error(
            "bootstrap.session is missing conversationThreadManager",
          );
        }
        if (
          !conversationThreadManager.hasThread(bootstrap.session.conversationId)
        ) {
          throw new Error(
            `AgenC daemon agent cannot be restored: ${params.agentId}`,
          );
        }
        const managedThread = conversationThreadManager.getThread(
          bootstrap.session.conversationId,
        );
        if (managedThread.kind !== "root") {
          throw new Error(
            `expected root managed thread on restore, got kind=${managedThread.kind}`,
          );
        }
        // Identity gate (acceptance gate 13): the resumed thread must
        // adopt the persisted conversationId so callers using the
        // pre-restart agentId find the live thread on the post-restart
        // map. Bootstrap is responsible for resolving its conversationId
        // from the persisted rollout for this cwd; if it differs, the
        // active map's `params.agentId` key would diverge from
        // `managedThread.threadId`, breaking interrupt/cancel/clear
        // routing for top-level sessions. Throw with a precise message
        // so the bootstrap argv-builder can be fixed at the right layer
        // rather than silently routing requests to a dead handle.
        if (managedThread.threadId !== params.agentId) {
          throw new Error(
            `restoreAgent identity mismatch: persisted agentId=${params.agentId} ` +
              `but bootstrap session conversationId=${managedThread.threadId}. ` +
              `bootstrap argv must resume the persisted conversation.`,
          );
        }

        const restoredAt = this.#now();
        const startedAt = params.startedAt ?? restoredAt;
        const activationMustBePending =
          params.resumeSuspendedRun === true ||
          params.resumeStartupActivationPending === true;
        if (
          (params.resumeRolloutPath !== undefined ||
            params.resumeRolloutLease !== undefined ||
            canonicalRuntimeState.pendingStartupActivationResumeEventId !==
              undefined) &&
          activationMustBePending !==
            (canonicalRuntimeState.pendingStartupActivationResumeEventId !==
              undefined)
        ) {
          throw new Error(
            `restoreAgent startup activation state disagrees with canonical run ${params.agentId}`,
          );
        }
        const active: ActiveBackgroundAgent = {
          bootstrap,
          control,
          thread: managedThread,
          status: "running",
          startedAt,
          ...(params.restoreAttemptId !== undefined
            ? { restoreAttemptId: params.restoreAttemptId }
            : {}),
          runEpoch: currentRunEpochFromRollout(bootstrap, params.agentId),
          canonicalEventBridgeInstalled: false,
          durableTerminalFinalizerInstalled: false,
          ...(canonicalRuntimeState.pendingStartupActivationResumeEventId !==
          undefined
            ? {
                pendingStartupActivationResumeEventId:
                  canonicalRuntimeState.pendingStartupActivationResumeEventId,
              }
            : {}),
          ...(canonicalRuntimeState.runtimeSettings !== undefined
            ? { runtimeSettings: canonicalRuntimeState.runtimeSettings }
            : {}),
          ...(canonicalRuntimeState.runtimeSettingsEventId !== undefined
            ? {
                runtimeSettingsEventId:
                  canonicalRuntimeState.runtimeSettingsEventId,
              }
            : {}),
          lastActiveAt: restoredAt,
          uninstallApprovalBridge,
          bufferedEvents: boundBufferedAgentEvents(
            this.#pendingEvents.get(params.agentId) ?? [],
            params.agentId,
          ),
          activeToolCallIds:
            this.#pendingActiveToolCallIds.get(params.agentId) ?? new Set(),
          historyEpoch: historyEpochFromRollout(
            bootstrap.rolloutStore.readAll(),
            params.agentId,
          ),
          messageSubmissionQueue: Promise.resolve(),
          runtimeSettingsMutationQueue: Promise.resolve(),
          cleanupComplete: Promise.resolve(),
          pendingMessageSubmissionCount: 0,
          messageSubmissionsById: new Map(),
          pendingShellExecutionCount: 0,
          shellExecutionsById: new Map(),
          dispatchChain: Promise.resolve(),
        };
        authorityOwner = active;
        if (
          canonicalRuntimeState.runtimeSettings !== undefined &&
          restoredRuntimeSettings !== undefined &&
          stableStringify(restoredRuntimeSettings) !==
            stableStringify(canonicalRuntimeState.runtimeSettings)
        ) {
          commitDurableRuntimeSettingsChange(
            active,
            params.agentId,
            restoredRuntimeSettings,
            "config_applied",
          );
        }
        if (active.runtimeSettings !== undefined) {
          const restoredBaseline = active.runtimeSettings;
          const restoreOverrides = runtimeSettingsWithRestoreOverrides(
            restoredBaseline,
            params,
            runtimeWorkspaceRoot(bootstrap),
            bootstrap.configStore.current(),
          );
          if (
            stableStringify(restoreOverrides) !==
            stableStringify(restoredBaseline)
          ) {
            const previousSettings = restoredBaseline;
            const reason: RunRuntimeSettingsChangeReason =
              restoreOverrides.permissionMode !==
              previousSettings.permissionMode
                ? "permission_mode_changed"
                : restoreOverrides.profile !== previousSettings.profile
                  ? "config_applied"
                  : "model_provider_changed";
            commitDurableRuntimeSettingsChange(
              active,
              params.agentId,
              restoreOverrides,
              reason,
            );
            const overrideEventId = active.runtimeSettingsEventId!;
            try {
              await applyRestoredRuntimeSettings(bootstrap, restoreOverrides);
            } catch (error) {
              const cleanupErrors: unknown[] = [];
              try {
                compensateRuntimeSettingsChange(
                  active,
                  params.agentId,
                  previousSettings,
                  overrideEventId,
                );
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError);
              }
              try {
                await applyRestoredRuntimeSettings(bootstrap, previousSettings);
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError);
              }
              if (cleanupErrors.length > 0) {
                throw new AggregateError(
                  [error, ...cleanupErrors],
                  `restored canonical session ${params.agentId} override rollback failed`,
                  { cause: error },
                );
              }
              throw error;
            }
          }
        }
        requireCanonicalRuntimeSettingsSupport(active, params.agentId);
        const uninstallRuntimeSettingsPreCommit =
          installRuntimeSettingsPreCommit(active, params.agentId);
        active.uninstallRuntimeSettingsPreCommit = () => {
          uninstallRuntimeSettingsPreCommit();
          uninstallPermissionAuthorityCoordinator();
        };
        this.#pendingEvents.delete(params.agentId);
        this.#pendingActiveToolCallIds.delete(params.agentId);
        this.#active.set(params.agentId, active);
        active.unsubscribeMcpSurfaceInvalidations =
          this.#installMcpSurfaceInvalidationBridge(active);
        insertedGeneration = active;
        this.#installDurableTerminalFinalizer(active, params.agentId);
        active.unsubscribeElicitationEvents =
          this.#installSessionEventLogBridge(active);
        this.#trackAgentStatus(active);
        active.unsubscribePhaseEvents = bootstrap.session.subscribeToEvents(
          (phase) => {
            const progress = phaseEventToProgressEvent(phase);
            if (progress === null) return;
            void this.#recordPhaseProgressEvent(params.agentId, progress);
          },
        );
        active.cleanupComplete = this.#cleanupWhenComplete(
          params.agentId,
          active,
        );
        await this.#hydrateRecoveredAgentState({
          agentId: params.agentId,
          session: bootstrap.session,
          registry: bootstrap.registry,
          thread: managedThread,
          initialMessages: params.initialMessages ?? [],
          replayToolCalls: params.replayToolCalls ?? [],
          currentSessionId: params.currentSessionId,
          onReplayToolResult: params.onReplayToolResult,
        });
        return true;
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        uninstallPermissionAuthorityCoordinator();
        if (
          insertedGeneration !== undefined &&
          this.#active.get(params.agentId) === insertedGeneration
        ) {
          try {
            await this.#retireUnpublishedRestoreGeneration(
              params.agentId,
              insertedGeneration,
            );
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        } else {
          uninstallApprovalBridge?.();
          try {
            await bootstrap?.shutdown();
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (explicitRestore) {
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [error, ...cleanupErrors],
              `restored canonical session ${params.agentId} cleanup failed after restore failure`,
            );
          }
          throw error;
        }
        return false;
      }
    } finally {
      if (explicitRestore) this.#pendingExplicitRestores.delete(params.agentId);
    }
  }

  async rollbackRestoredAgent(
    agentId: string,
    restoreAttemptId: string,
  ): Promise<void> {
    if (restoreAttemptId.length === 0) {
      throw new TypeError("restore rollback requires a non-empty attempt id");
    }
    const active = this.#active.get(agentId);
    if (active === undefined || active.restoreAttemptId !== restoreAttemptId) {
      throw new Error(
        `restore rollback generation no longer owns canonical session ${agentId}`,
      );
    }

    await this.#retireUnpublishedRestoreGeneration(agentId, active);
  }

  async #retireUnpublishedRestoreGeneration(
    agentId: string,
    active: ActiveBackgroundAgent,
  ): Promise<void> {
    // Publication never completed, so this generation has no daemon ingress
    // authority. Detach the close-boundary finalizer before shutdown: an
    // already reopened/resumed epoch remains canonically open and is recovered
    // exactly like a process crash, including its effect/review gates.
    active.ingressClosed = true;
    active.status = "stopping";
    this.#abortPendingToolDecisions(agentId);
    active.unsubscribeDurableTerminalFinalizer?.();
    active.unsubscribeStatus?.();
    active.uninstallApprovalBridge?.();
    active.uninstallRuntimeSettingsPreCommit?.();
    active.unsubscribeElicitationEvents?.();
    active.unsubscribePhaseEvents?.();
    active.unsubscribeMcpSurfaceInvalidations?.();
    if (this.#active.get(agentId) === active) {
      this.#active.delete(agentId);
      this.#pendingEvents.delete(agentId);
      this.#assistantTextByAgent.delete(agentId);
      this.#pendingActiveToolCallIds.delete(agentId);
    }
    this.#authBackend?.clearVendedKeysForSession(agentId);

    const errors: unknown[] = [];
    try {
      await this.#drainDispatchChain(active);
    } catch (error) {
      errors.push(error);
    }
    try {
      await active.bootstrap.shutdown();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#drainDispatchChain(active);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `restored canonical session ${agentId} rollback failed`,
      );
    }
  }

  async prepareAgentCancellation(
    agentId: string,
    reason: string,
  ): Promise<AgenCBackgroundAgentCancellationPreparation> {
    const active = this.#active.get(agentId);
    if (active === undefined) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    if (
      active.ingressClosed === true ||
      active.pendingSuspension !== undefined ||
      active.suspension !== undefined
    ) {
      throw new Error(
        `AgenC daemon agent is already crossing a shutdown boundary: ${agentId}`,
      );
    }
    if (active.terminal !== undefined) {
      return {
        affectedRunIds: [],
        voidedHolds: 0,
        heldUnknownHolds: 0,
      };
    }
    if (active.pendingTerminal === undefined) {
      active.status = "stopping";
      active.lastActiveAt = this.#now();
      active.pendingTerminal = cancelledTerminalResult(
        active,
        agentId,
        reason,
        active.lastActiveAt,
      );
    } else if (
      active.pendingTerminal.status !== "cancelled" ||
      active.pendingTerminal.stopReason !== reason
    ) {
      throw new Error(
        `run ${agentId} already has a different terminal transition pending`,
      );
    }

    commitDurableRunCancellationRequest(active, agentId, reason);
    this.#abortPendingToolDecisions(agentId);
    const cancelAdmissions =
      active.bootstrap.session.services.executionAdmission?.cancelAdmissions;
    if (typeof cancelAdmissions !== "function") {
      throw new Error(
        `run ${agentId} cannot prepare cancellation: admissions-only cancellation is unavailable`,
      );
    }
    const summary = cancelAdmissions.call(
      active.bootstrap.session.services.executionAdmission,
      reason,
    );
    return {
      affectedRunIds: summary.affectedRunIds,
      voidedHolds: summary.voidedReservations,
      heldUnknownHolds: summary.heldUnknownReservations,
    };
  }

  async stopAgent(
    agentId: string,
    reason = "daemon_agent_stop",
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) return;
    active.status = "stopping";
    active.lastActiveAt = this.#now();
    let stopError: unknown;
    active.pendingTerminal ??= cancelledTerminalResult(
      active,
      agentId,
      reason,
      active.lastActiveAt,
    );
    // Resolve permission continuations while the canonical writer is still
    // open. Session shutdown drains their tracked durable decision records
    // before its terminal finalizer is allowed to seal the journal.
    this.#abortPendingToolDecisions(agentId);
    try {
      if (!active.durableTerminalFinalizerInstalled) {
        commitDurableRunTerminal(active, agentId, active.pendingTerminal);
      }
    } catch (error) {
      // Stopping must still revoke execution authority, but the caller needs
      // to know that the durable final-result contract could not be met.
      stopError = error;
    }
    try {
      // Bootstrap lifecycle quiesces the root turn, descendants, execs, hooks,
      // and tracked durable continuations before Session's close-boundary
      // callback appends the terminal as the canonical tail.
      await this.#drainDispatchChain(active);
      await active.bootstrap.shutdown();
      await this.#drainDispatchChain(active);
    } catch (error) {
      stopError ??= error;
    }
    stopError ??= active.terminalCommitError;
    if (active.terminal === undefined) {
      stopError ??= new Error(
        `run ${agentId} shutdown completed without a durable terminal result`,
      );
    }
    await this.#notifyActiveAgentTerminated(agentId, active);
    if (this.#active.get(agentId) === active) {
      this.#active.delete(agentId);
      this.#pendingEvents.delete(agentId);
      this.#assistantTextByAgent.delete(agentId);
      this.#pendingActiveToolCallIds.delete(agentId);
    }
    active.unsubscribeStatus?.();
    if (active.terminal !== undefined) {
      active.unsubscribeDurableTerminalFinalizer?.();
    }
    active.uninstallApprovalBridge?.();
    active.uninstallRuntimeSettingsPreCommit?.();
    active.unsubscribeElicitationEvents?.();
    active.unsubscribePhaseEvents?.();
    active.unsubscribeMcpSurfaceInvalidations?.();
    // gaphunt3 #48: the agentId is the session/conversationId used as the
    // vended-key cache key, so evict this session's entries on stop —
    // otherwise non-expiring keys leak for the daemon's lifetime.
    this.#authBackend?.clearVendedKeysForSession(agentId);
    if (stopError !== undefined) {
      active.status = "error";
      active.lastActiveAt = this.#now();
      throw stopError;
    }
  }

  async suspendIdleAgentForDaemonShutdown(
    agentId: string,
  ): Promise<AgenCBackgroundAgentDaemonShutdownResult> {
    const active = this.#active.get(agentId);
    if (active === undefined) return { disposition: "cancelled" };

    // This synchronous ingress fence is the linearization point. Every runner
    // mutation path consults isRunnableActiveAgent before accepting work.
    active.ingressClosed = true;
    active.status = "stopping";
    active.lastActiveAt = this.#now();
    await this.#drainDispatchChain(active);

    if (!this.#canSuspendIdleAgent(agentId, active)) {
      await this.stopAgent(agentId, "daemon_shutdown_not_idle");
      return {
        disposition: "cancelled",
        ...(active.terminal !== undefined ? { terminal: active.terminal } : {}),
      };
    }

    active.pendingSuspension = {
      eventId: `run-suspended:${agentId}:${active.runEpoch}:${randomUUID()}`,
      reason: "daemon_shutdown_idle",
      suspendedAt: this.#now(),
    };
    const shutdownErrors: unknown[] = [];
    try {
      await active.bootstrap.shutdown();
    } catch (error) {
      shutdownErrors.push(error);
    }
    try {
      await this.#drainDispatchChain(active);
    } catch (error) {
      shutdownErrors.push(error);
    }

    let result: AgenCBackgroundAgentDaemonShutdownResult | undefined;
    if (active.suspension !== undefined) {
      result = { disposition: "suspended", suspension: active.suspension };
    } else if (active.terminal !== undefined) {
      result = { disposition: "cancelled", terminal: active.terminal };
    } else {
      shutdownErrors.push(
        new Error(
          `run ${agentId} shutdown completed without a durable suspension or terminal result`,
        ),
      );
    }

    // Daemon shutdown revokes this generation even when bootstrap cleanup
    // failed. Leaving it registered would retain ingress, listeners, cached
    // credentials, or a later asynchronous finalizer after cleanup returned.
    if (this.#active.get(agentId) === active) {
      this.#active.delete(agentId);
      this.#pendingEvents.delete(agentId);
      this.#assistantTextByAgent.delete(agentId);
      this.#pendingActiveToolCallIds.delete(agentId);
    }
    active.unsubscribeStatus?.();
    active.unsubscribeDurableTerminalFinalizer?.();
    active.uninstallApprovalBridge?.();
    active.uninstallRuntimeSettingsPreCommit?.();
    active.unsubscribeElicitationEvents?.();
    active.unsubscribePhaseEvents?.();
    active.unsubscribeMcpSurfaceInvalidations?.();
    this.#abortPendingToolDecisions(agentId);
    this.#authBackend?.clearVendedKeysForSession(agentId);
    if (shutdownErrors.length > 0) {
      active.status = "error";
      active.lastActiveAt = this.#now();
      const cause =
        shutdownErrors.length === 1
          ? shutdownErrors[0]
          : new AggregateError(
              shutdownErrors,
              "daemon suspension cleanup failed",
            );
      if (active.suspension !== undefined) {
        throw new AgenCBackgroundAgentSuspensionShutdownError(
          active.suspension,
          cause,
        );
      }
      throw cause;
    }
    return result!;
  }

  #canSuspendIdleAgent(
    agentId: string,
    active: ActiveBackgroundAgent,
  ): boolean {
    if (
      active.ingressClosed !== true ||
      !active.durableTerminalFinalizerInstalled ||
      active.terminal !== undefined ||
      active.suspension !== undefined ||
      active.pendingTerminal !== undefined ||
      active.cancellationRequest !== undefined ||
      active.pendingMessageSubmissionCount !== 0 ||
      active.pendingShellExecutionCount !== 0 ||
      active.messageSubmission !== undefined ||
      [...active.messageSubmissionsById.values()].some(
        (submission) => !submission.settled,
      ) ||
      [...active.shellExecutionsById.values()].some(
        (execution) => !execution.settled,
      ) ||
      hasRuntimeActiveTurn(active.bootstrap.session) ||
      hasOpenAgentDescendants(active.control, active.thread.threadId) ||
      active.activeToolCallIds.size !== 0 ||
      this.#pendingToolDecisions.has(agentId)
    ) {
      return false;
    }
    try {
      active.bootstrap.rolloutStore.assertRunSuspendable();
      return true;
    } catch {
      return false;
    }
  }

  async #hydrateRecoveredAgentState(params: {
    readonly agentId: string;
    readonly session: LocalRuntimeBootstrap["session"];
    readonly registry: ToolRegistry;
    readonly thread: ManagedThread;
    readonly initialMessages: ReadonlyArray<LLMMessage>;
    readonly replayToolCalls: readonly AgenCBackgroundAgentReplayToolCall[];
    readonly currentSessionId?: string;
    readonly onReplayToolResult?: (
      result: AgenCBackgroundAgentReplayToolResult,
    ) => void | Promise<void>;
  }): Promise<void> {
    const replayedMessages = await replayRecoveredToolCalls({
      thread: params.thread,
      parent: params.session,
      registry: params.registry,
      initialMessages: params.initialMessages,
      replayToolCalls: params.replayToolCalls,
      currentSessionId: params.currentSessionId,
      onReplayToolResult: params.onReplayToolResult,
      onProgress: (event) =>
        this.#recordRecoveredProgressEvent(
          params.agentId,
          params.session,
          event,
        ),
    });
    await hydrateRecoveredSessionHistory(params.session, {
      initialMessages: params.initialMessages,
      replayedMessages,
    });
  }

  async attachAgentSessionEvents(
    agentId: string,
    binding: AgenCBackgroundAgentSessionEventBinding,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) {
      const replay = this.#pendingEvents.get(agentId)?.splice(0) ?? [];
      if (replay.length === 0) return;
      this.#pendingEvents.delete(agentId);
      for (const event of replay) {
        await binding.emit(
          notificationFromDaemonEvent(binding.sessionId, agentId, event),
        );
      }
      return;
    }
    active.sessionBinding = binding;
    const replay = active.bufferedEvents.splice(0);
    for (const event of replay) {
      await this.#emitDaemonEvent(active, event);
    }
  }

  #installMcpSurfaceInvalidationBridge(
    active: ActiveBackgroundAgent,
  ): (() => void) | undefined {
    const manager = active.bootstrap.session.services.mcpManager;
    if (manager === undefined) return undefined;
    const subscribe = manager.subscribeMcpSurfaceInvalidations;
    if (subscribe === undefined) return undefined;
    const agentId = active.thread.threadId;
    let disposed = false;
    let pendingRevision: number | undefined;
    let drainScheduled = false;
    const drain = (): void => {
      if (drainScheduled || pendingRevision === undefined) return;
      drainScheduled = true;
      const tail = active.dispatchChain
        .then(async () => {
          while (pendingRevision !== undefined) {
            const revision = pendingRevision;
            pendingRevision = undefined;
            if (
              disposed ||
              this.#active.get(agentId) !== active ||
              !isRunnableActiveAgent(active)
            ) {
              return;
            }
            const binding = active.sessionBinding;
            if (binding === undefined) continue;
            await binding.emit(
              notificationFromDaemonEvent(binding.sessionId, agentId, {
                id: `mcp-status:${agentId}:${revision}`,
                type: "mcp_status_changed",
                payload: { revision },
              }),
            );
          }
        })
        .catch((error: unknown) => {
          logForDebugging(
            `MCP status invalidation delivery failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { level: "error" },
          );
        })
        .finally(() => {
          drainScheduled = false;
          if (!disposed && pendingRevision !== undefined) drain();
        });
      active.dispatchChain = tail;
    };
    const unsubscribe = subscribe.call(manager, (revision) => {
      if (
        disposed ||
        this.#active.get(agentId) !== active ||
        !isRunnableActiveAgent(active)
      ) {
        return;
      }
      // This is an ephemeral invalidation, not transcript state. A client that
      // attaches later fetches the current snapshot explicitly, so never queue
      // a pre-attachment revision for replay.
      if (active.sessionBinding === undefined) return;
      pendingRevision =
        pendingRevision === undefined
          ? revision
          : Math.max(pendingRevision, revision);
      drain();
    });
    return () => {
      if (disposed) return;
      disposed = true;
      pendingRevision = undefined;
      unsubscribe();
    };
  }

  async submitAgentMessage(
    agentId: string,
    params: AgenCBackgroundAgentMessageParams,
  ): Promise<AgenCBackgroundAgentMessageResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const contentFingerprint = messageContentFingerprint(
      params.originalContent,
    );
    const duplicate = active.messageSubmissionsById.get(params.messageId);
    if (duplicate !== undefined) {
      if (duplicate.contentFingerprint !== contentFingerprint) {
        throw clientMessageIdConflict(params.messageId);
      }
      return duplicate.promise.then((result) => ({
        ...result,
        disposition: "duplicate" as const,
        duplicateState: "completed" as const,
      }));
    }

    const persisted = findPersistedMessageSubmission(
      active.bootstrap.rolloutStore.readAll(),
      params.messageId,
    );
    if (persisted !== undefined) {
      if (persisted.contentFingerprint !== contentFingerprint) {
        throw clientMessageIdConflict(params.messageId);
      }
      return {
        disposition: "duplicate",
        duplicateState:
          persisted.terminal === undefined ? "incomplete" : "completed",
        acceptedAt: persisted.acceptedAt ?? params.acceptedAt,
        ...(persisted.turnId !== undefined ? { turnId: persisted.turnId } : {}),
        ...(persisted.terminal !== undefined
          ? { terminal: persisted.terminal }
          : {}),
      };
    }

    if (
      params.ifBusy === "reject" &&
      (active.pendingMessageSubmissionCount > 0 ||
        active.pendingShellExecutionCount > 0 ||
        hasRuntimeActiveTurn(active.bootstrap.session))
    ) {
      throw new AgenCBackgroundAgentMessageError(
        "TURN_IN_PROGRESS",
        `session ${params.sessionId} already has an active or queued turn`,
      );
    }

    let resolveSubmission!: (result: AgenCBackgroundAgentMessageResult) => void;
    let rejectSubmission!: (error: unknown) => void;
    const promise = new Promise<AgenCBackgroundAgentMessageResult>(
      (resolve, reject) => {
        resolveSubmission = resolve;
        rejectSubmission = reject;
      },
    );
    const submission: ActiveMessageSubmission = {
      clientMessageId: params.messageId,
      contentFingerprint,
      streamId: params.streamId,
      acceptedAt: params.acceptedAt,
      assistantMessageOrdinal: 0,
      promise,
      settled: false,
    };
    active.messageSubmissionsById.set(params.messageId, submission);
    active.pendingMessageSubmissionCount += 1;

    const execute = active.messageSubmissionQueue.then(() =>
      runWithCurrentRuntimeSession(active.bootstrap.session, async () => {
        if (!isRunnableActiveAgent(active)) {
          throw new Error(`AgenC daemon agent not running: ${agentId}`);
        }
        active.messageSubmission = submission;
        try {
          return await this.#executeAgentMessageSubmission(
            active,
            agentId,
            params,
            submission,
          );
        } finally {
          if (active.messageSubmission === submission) {
            active.messageSubmission = undefined;
          }
        }
      }),
    );
    active.messageSubmissionQueue = execute.then(
      () => {},
      () => {},
    );
    void execute.then(resolveSubmission, rejectSubmission).finally(() => {
      submission.settled = true;
      active.pendingMessageSubmissionCount = Math.max(
        0,
        active.pendingMessageSubmissionCount - 1,
      );
      pruneMessageSubmissionCache(active.messageSubmissionsById);
    });
    return promise;
  }

  async executeAgentShell(
    agentId: string,
    params: SessionShellExecuteParams,
    signal?: AbortSignal,
  ): Promise<SessionShellExecuteResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const boundSessionId = active.sessionBinding?.sessionId;
    if (boundSessionId !== undefined && params.sessionId !== boundSessionId) {
      throw new Error(
        `Shell session mismatch: ${params.sessionId} is not owned by ${agentId}`,
      );
    }
    throwIfShellRequestAborted(signal);

    const commandFingerprint = messageContentFingerprint(params.command);
    const duplicate = active.shellExecutionsById.get(params.commandId);
    if (duplicate !== undefined) {
      if (duplicate.commandFingerprint !== commandFingerprint) {
        throw new Error(
          `Shell command id ${params.commandId} was already used for different content`,
        );
      }
      return duplicate.promise;
    }

    const persisted = findPersistedMessageSubmission(
      active.bootstrap.rolloutStore.readAll(),
      shellSubmissionMessageId(params.commandId),
    );
    if (persisted !== undefined) {
      if (persisted.contentFingerprint !== commandFingerprint) {
        throw new Error(
          `Shell command id ${params.commandId} has conflicting durable content`,
        );
      }
      throw new Error(
        `Shell command ${params.commandId} already has durable execution evidence. Its response outcome is unknown, so AgenC will not run it again.`,
      );
    }

    if (hasRuntimeActiveTurn(active.bootstrap.session)) {
      throw new Error(
        `Cannot run a direct shell command while session ${params.sessionId} has an active or queued model turn`,
      );
    }

    active.pendingShellExecutionCount += 1;
    const execution = active.messageSubmissionQueue.then(() => {
      if (hasRuntimeActiveTurn(active.bootstrap.session)) {
        throw new Error(
          `Cannot run a direct shell command while session ${params.sessionId} has an active or queued model turn`,
        );
      }
      return this.#executeAgentShellCommand(active, agentId, params, signal);
    });
    const entry: ActiveShellExecution = {
      commandFingerprint,
      promise: execution,
      settled: false,
    };
    active.shellExecutionsById.set(params.commandId, entry);
    active.messageSubmissionQueue = execution.then(
      () => {},
      () => {},
    );
    const settle = (): void => {
      entry.settled = true;
      active.pendingShellExecutionCount = Math.max(
        0,
        active.pendingShellExecutionCount - 1,
      );
      pruneShellExecutionCache(active.shellExecutionsById);
    };
    void execution.then(settle, settle);
    return execution;
  }

  async #executeAgentShellCommand(
    active: ActiveBackgroundAgent,
    agentId: string,
    params: SessionShellExecuteParams,
    signal?: AbortSignal,
  ): Promise<SessionShellExecuteResult> {
    if (
      !isRunnableActiveAgent(active) ||
      this.#active.get(agentId) !== active
    ) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    throwIfShellRequestAborted(signal);

    const session = active.bootstrap.session;
    const executionSignal =
      signal === undefined
        ? session.abortController.signal
        : AbortSignal.any([signal, session.abortController.signal]);
    throwIfShellRequestAborted(executionSignal);
    const acceptedAt = this.#now();
    const eventKey = shellEventKey(params.commandId);
    session.emit(
      {
        eventId: `shell-submission:${eventKey}`,
        id: `shell-submission:${eventKey}`,
        msg: {
          type: "message_submission",
          payload: {
            contentFingerprint: messageContentFingerprint(params.command),
            messageId: shellSubmissionMessageId(params.commandId),
            streamId: "session.shell.execute",
            acceptedAt,
          },
        },
      },
      { durable: true },
    );
    session.emit(
      {
        eventId: `shell-input:${eventKey}`,
        id: `shell-input:${eventKey}`,
        msg: {
          type: "user_message",
          payload: {
            message: `<bash-input>${escapeXml(params.command)}</bash-input>`,
            displayText: `<bash-input>${escapeXml(params.command)}</bash-input>`,
            queuedCommandUuid: params.commandId,
          },
        },
      },
      { durable: true },
    );
    const shellTurnId = `shell-${eventKey}`;
    let startedTool:
      | { readonly name: string; readonly turnId: string }
      | undefined;
    const emitToolStart = (toolName: string): void => {
      session.emit(
        {
          eventId: `shell-tool-start:${eventKey}`,
          id: params.commandId,
          msg: {
            type: "tool_call_started",
            payload: {
              callId: params.commandId,
              toolName,
              args: JSON.stringify({ command: params.command }),
            },
          },
        },
        { durable: true },
      );
    };
    const emitToolCompletion = (
      toolName: string,
      completion: {
        readonly result: string;
        readonly isError: boolean;
        readonly turnId: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      },
    ): void => {
      session.emit(
        {
          eventId: `shell-tool-result:${eventKey}`,
          id: `shell-tool-result:${eventKey}`,
          msg: {
            type: "tool_call_completed",
            payload: {
              callId: params.commandId,
              toolName,
              result: completion.result,
              isError: completion.isError,
              metadata: {
                ...completion.metadata,
                toolName,
                source: "direct",
              },
            },
          },
        },
        {
          durable: true,
          turnId: completion.turnId,
          toolResultBytes: Buffer.byteLength(completion.result, "utf8"),
        },
      );
    };
    let dispatch: {
      readonly result: ToolDispatchResult;
      readonly toolName: string;
      readonly turnId: string;
    };
    try {
      await active.dispatchChain;
      dispatch = await runWithCurrentRuntimeSession(session, () =>
        runWithCanonicalSettingsAuthority(
          active.bootstrap.configStore,
          async () => {
            throwIfShellRequestAborted(executionSignal);
            const turn = session.newDefaultTurnWithSubId(shellTurnId);
            const workspaceRoot = runtimeWorkspaceRoot(active.bootstrap);
            if (
              turn.cwd !== workspaceRoot ||
              active.bootstrap.workspaceRoot !== workspaceRoot
            ) {
              throw new Error(
                `Shell cwd authority mismatch for session ${params.sessionId}`,
              );
            }
            const toolName =
              resolveDefaultShell() === "powershell"
                ? "PowerShell"
                : "system.bash";
            if (
              !session.services.registry.tools.some(
                (tool) => tool.name === toolName,
              )
            ) {
              throw new Error(
                `Configured shell ${toolName} is not available in session ${params.sessionId}`,
              );
            }
            startedTool = { name: toolName, turnId: turn.subId };
            emitToolStart(toolName);
            await active.dispatchChain;
            const router = routerFromRegistry(session.services.registry);
            const result = await router.dispatchModelToolCall(
              {
                id: params.commandId,
                name: toolName,
                arguments: JSON.stringify({ command: params.command }),
              },
              {
                ...buildLiveToolDispatchOptions(turn, session, executionSignal),
                source: "direct",
              },
            );
            return { result, toolName, turnId: turn.subId };
          },
        ),
      );
    } catch (error) {
      if (startedTool === undefined) {
        let toolName = "system.bash";
        try {
          toolName = runWithCurrentRuntimeSession(session, () =>
            runWithCanonicalSettingsAuthority(
              active.bootstrap.configStore,
              () => resolveDefaultShell() === "powershell"
                ? "PowerShell"
                : "system.bash",
            ),
          );
        } catch {
          // The fallback name is used only to durably close a failed request.
        }
        startedTool = { name: toolName, turnId: shellTurnId };
        emitToolStart(startedTool.name);
      }
      const failure = error instanceof Error ? error.message : String(error);
      emitToolCompletion(startedTool.name, {
        turnId: startedTool.turnId,
        result: failure,
        isError: true,
      });
      await active.dispatchChain;
      throw error;
    }
    const result = normalizeSessionShellResult(
      params.commandId,
      dispatch.result,
    );
    emitToolCompletion(dispatch.toolName, {
      turnId: dispatch.turnId,
      result: dispatch.result.content,
      isError: dispatch.result.isError === true,
      ...(dispatch.result.metadata !== undefined
        ? { metadata: dispatch.result.metadata }
        : {}),
    });
    await active.dispatchChain;
    const transcriptOutput =
      `<bash-stdout>${escapeXml(result.stdout)}</bash-stdout>` +
      `<bash-stderr>${escapeXml(result.stderr)}</bash-stderr>`;
    session.emit(
      {
        eventId: `shell-output:${eventKey}`,
        id: `shell-output:${eventKey}`,
        msg: {
          type: "user_message",
          payload: {
            message: transcriptOutput,
            displayText: transcriptOutput,
            queuedCommandUuid: params.commandId,
          },
        },
      },
      { durable: true },
    );
    await active.dispatchChain;
    active.lastActiveAt = this.#now();
    return result;
  }

  async #executeAgentMessageSubmission(
    active: ActiveBackgroundAgent,
    agentId: string,
    params: AgenCBackgroundAgentMessageParams,
    submission: ActiveMessageSubmission,
  ): Promise<AgenCBackgroundAgentMessageResult> {
    let input = messageContentToAgentInput(params.content);
    if (params.editorInteraction === undefined) {
      const prepared = await prepareDaemonUserPrompt({
        session: active.bootstrap.session,
        configStore: active.bootstrap.configStore,
        input,
        hookPrompt: userPromptDisplayText(
          messageContentToAgentInput(params.originalContent),
        ),
      });
      if (prepared.blocked) {
        throw new AgenCBackgroundAgentMessageError(
          "PROMPT_BLOCKED",
          prepared.blockMessage ?? "UserPromptSubmit hook blocked the prompt",
        );
      }
      input = prepared.input;
    }
    commitDurableRunStartupActivation(active, agentId, this.#now());
    active.lastActiveAt = this.#now();
    if (params.displayUserMessage === null) {
      // Hidden editor/internal prompts still need an fsync-durable admission
      // identity. This marker is intentionally not bridged as a transcript
      // event, but lets restart retries prove same-content idempotency.
      active.bootstrap.session.emit(
        {
          id: `message-submission:${params.messageId}`,
          msg: {
            type: "message_submission",
            payload: {
              contentFingerprint: submission.contentFingerprint,
              messageId: params.messageId,
              streamId: params.streamId,
              acceptedAt: params.acceptedAt,
            },
          },
        },
        { durable: true },
      );
    } else {
      const displayText =
        params.displayUserMessage ?? messageContentDisplayText(params.content);
      await this.#emitPersistedUserMessage(active, {
        id: params.messageId,
        type: "user_message",
        messageId: params.messageId,
        streamId: params.streamId,
        acceptedAt: params.acceptedAt,
        clientMessageId: params.messageId,
        payload: {
          message: params.originalContent,
          displayText,
          messageId: params.messageId,
          streamId: params.streamId,
          acceptedAt: params.acceptedAt,
        },
      });
    }
    const submitOptions: DaemonSessionSubmitOptions = {
      ...(params.editorInteraction === undefined
        ? { [DAEMON_USER_PROMPT_PREPARED]: true as const }
        : {}),
      displayUserMessage:
        params.displayUserMessage === undefined
          ? messageContentDisplayText(params.originalContent)
          : params.displayUserMessage,
      ...(params.editorInteraction !== undefined
        ? { editorInteraction: params.editorInteraction }
        : {}),
    };
    if (typeof input === "string") {
      await active.control.sendInput(agentId, input, submitOptions);
    } else {
      await submitStructuredAgentInput(
        active,
        input,
        messageContentDisplayText(params.content),
        submitOptions,
      );
    }
    await active.dispatchChain;
    return {
      disposition: "started",
      acceptedAt: submission.acceptedAt,
      ...(submission.turnId !== undefined ? { turnId: submission.turnId } : {}),
      terminal: submission.terminal ?? { code: 0 },
    };
  }

  resolveCodePredictionSource(agentId: string): CodePredictionSource {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    return {
      // Model/provider switches replace this session service in place. Reading
      // it at request time prevents predictions from following a stale route.
      provider: active.bootstrap.session.services.provider,
      workspaceRoot: active.bootstrap.workspaceRoot,
    };
  }

  async clearAgentSession(
    agentId: string,
    params: AgenCBackgroundAgentClearSessionParams,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    if (isClearInFlight(active)) {
      throw new Error(
        "Cannot clear right now: a turn is currently in flight; wait for it to complete before running /clear.",
      );
    }
    await clearSession(active.bootstrap.session);
    await active.control.clearConversationHistory(agentId);
    active.activeToolCallIds.clear();
    this.#assistantTextByAgent.delete(agentId);
    active.lastActiveAt = params.clearedAt;
    const clearedAtMs = Date.parse(params.clearedAt);
    active.bootstrap.session.emit(
      {
        id: `history-cleared-${params.sessionId}-${params.clearedAt}`,
        msg: {
          type: "history_cleared",
          payload: {
            timestamp: Number.isFinite(clearedAtMs) ? clearedAtMs : Date.now(),
          },
        },
      },
      { durable: true },
    );
    await active.dispatchChain;
  }

  async addMcpServer(
    agentId: string,
    params: AgenCBackgroundAgentMcpAddServerParams,
  ): Promise<McpServerMutationResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const addServer = active.bootstrap.session.services.mcpManager.addServer;
    if (typeof addServer !== "function") {
      throw new Error(
        "MCP addServer is not available for this daemon session.",
      );
    }
    const result = await addServer(params.config);
    return {
      serverName: result.serverName,
      success: result.success,
      toolCount: result.toolCount,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async getMcpStatus(agentId: string): Promise<McpSurfaceSnapshot> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const manager = active.bootstrap.session.services.mcpManager;
    if (manager === undefined) {
      throw new Error(
        "MCP status projection is not available for this daemon session.",
      );
    }
    const snapshot = manager.mcpSurfaceSnapshot;
    if (snapshot === undefined) {
      throw new Error(
        "MCP status projection is not available for this daemon session.",
      );
    }
    return snapshot.call(manager);
  }

  async reconnectMcpServer(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const reconnectServer =
      active.bootstrap.session.services.mcpManager.reconnectServer;
    if (typeof reconnectServer !== "function") {
      throw new Error(
        "MCP reconnect is not available for this daemon session.",
      );
    }
    const result = await reconnectServer(params.serverName);
    return {
      serverName: result.serverName,
      success: result.success,
      toolCount: result.toolCount,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async enableMcpServer(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const enableServer =
      active.bootstrap.session.services.mcpManager.enableServer;
    if (typeof enableServer !== "function") {
      throw new Error("MCP enable is not available for this daemon session.");
    }
    const result = await enableServer(params.serverName);
    return {
      serverName: result.serverName,
      success: result.success,
      toolCount: result.toolCount,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async disableMcpServer(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const disableServer =
      active.bootstrap.session.services.mcpManager.disableServer;
    if (typeof disableServer !== "function") {
      throw new Error("MCP disable is not available for this daemon session.");
    }
    const result = await disableServer(params.serverName);
    return {
      serverName: result.serverName,
      success: result.success,
      toolCount: result.toolCount,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async snapshotAgentSession(
    agentId: string,
    params: AgenCBackgroundAgentSnapshotSessionParams,
  ): Promise<SessionSnapshotResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const usage = terminalUsageForActiveAgent(active);
    // Turn count comes from the session's history length. Each completed
    // user/assistant exchange appends entries; using length gives the
    // size of the live transcript without trying to count turn-pairs.
    const state = active.bootstrap.session.state?.unsafePeek?.();
    const historyLength = Array.isArray(
      (state as { history?: unknown[] } | undefined)?.history,
    )
      ? ((state as { history?: unknown[] }).history as unknown[]).length
      : 0;
    // Approximate turn count from history: each turn pushes a user
    // message + at least one assistant message. Halving overstates
    // when tool-use rounds split a single turn into multiple history
    // items, but it's a closer signal than the raw item count.
    const turnCount = Math.max(0, Math.floor(historyLength / 2));
    const cache = await this.#sessionCacheStatsSnapshot(active);
    const breakdown = this.#sessionContextBreakdown(active);
    return {
      sessionId: params.sessionId,
      turnCount,
      tokenUsage: {
        inputTokens: finiteNumber(usage.inputTokens),
        outputTokens: finiteNumber(usage.outputTokens),
        totalTokens: finiteNumber(usage.totalTokens),
        costUsd: finiteNumber(usage.costUsd),
      },
      cacheStats: cache,
      ...(breakdown !== undefined ? { contextBreakdown: breakdown } : {}),
    };
  }

  /**
   * What occupies the context window, by source. Every figure is measured
   * from this session's own material — the live tool registry, the MCP
   * catalog, the memory files on disk, the conversation history — so a
   * client can show where the window went instead of guessing.
   *
   * Token counts are the runtime's standard rough estimate (the same one
   * budgeting uses); they are not a tokenizer round-trip.
   */
  #sessionContextBreakdown(
    active: ActiveBackgroundAgent,
  ): SessionSnapshotResult["contextBreakdown"] {
    try {
      const bootstrap = active.bootstrap;
      const estimate = (text: string): number =>
        text.length > 0 ? roughTokenCountEstimation(text) : 0;

      const llmTools = bootstrap.registry.toLLMTools();
      let systemToolTokens = 0;
      let systemToolCount = 0;
      let mcpToolTokens = 0;
      let mcpToolCount = 0;
      for (const tool of llmTools) {
        const tokens = estimate(JSON.stringify(tool));
        // MCP tools are namespaced `mcp.<server>.<tool>` by the registry.
        if (tool.function.name.startsWith("mcp.")) {
          mcpToolTokens += tokens;
          mcpToolCount += 1;
        } else {
          systemToolTokens += tokens;
          systemToolCount += 1;
        }
      }

      // Deferred tools are searchable but not resident, so they cost
      // nothing until loaded — reported apart from the resident rows.
      const discovered = bootstrap.registry.getDiscoveredToolNames?.();
      const residentNames = new Set(llmTools.map((tool) => tool.function.name));
      let deferredToolTokens = 0;
      let deferredToolCount = 0;
      for (const tool of bootstrap.registry.tools) {
        if (residentNames.has(tool.name)) continue;
        if (discovered?.has(tool.name) === true) continue;
        deferredToolCount += 1;
        deferredToolTokens += estimate(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          }),
        );
      }

      let memoryFileTokens = 0;
      let memoryFileCount = 0;
      for (const path of this.#memoryFilePaths(bootstrap)) {
        try {
          const text = readFileSync(path, "utf8");
          memoryFileTokens += estimate(text);
          memoryFileCount += 1;
        } catch {
          // absent or unreadable: not in the window either
        }
      }

      const state = bootstrap.session.state?.unsafePeek?.();
      const history = Array.isArray(
        (state as { history?: unknown[] } | undefined)?.history,
      )
        ? ((state as { history: unknown[] }).history as unknown[])
        : [];
      let messageTokens = 0;
      for (const item of history) {
        try {
          messageTokens += estimate(JSON.stringify(item));
        } catch {
          // unserializable history item: skip rather than guess
        }
      }

      const instructions =
        (
          bootstrap.session as unknown as {
            baseInstructions?: string;
            instructions?: string;
          }
        ).baseInstructions ??
        (bootstrap.session as unknown as { instructions?: string })
          .instructions ??
        "";

      return {
        windowTokens: finiteNumber(bootstrap.modelInfo.contextWindow ?? 0),
        messageTokens: finiteNumber(messageTokens),
        systemPromptTokens: finiteNumber(estimate(instructions)),
        systemToolTokens: finiteNumber(systemToolTokens),
        systemToolCount,
        mcpToolTokens: finiteNumber(mcpToolTokens),
        mcpToolCount,
        deferredToolTokens: finiteNumber(deferredToolTokens),
        deferredToolCount,
        memoryFileTokens: finiteNumber(memoryFileTokens),
        memoryFileCount,
      };
    } catch {
      // Never fail a snapshot over the breakdown; the client treats an
      // absent breakdown as "not measured".
      return undefined;
    }
  }

  /** AGENTS.md-style memory the session loads, if present. */
  #memoryFilePaths(bootstrap: {
    readonly memoryMdPath?: string;
    readonly memoryDir?: string;
  }): readonly string[] {
    const paths: string[] = [];
    if (bootstrap.memoryMdPath !== undefined) paths.push(bootstrap.memoryMdPath);
    if (bootstrap.memoryDir !== undefined) {
      try {
        for (const entry of readdirSync(bootstrap.memoryDir)) {
          if (entry.endsWith(".md")) {
            paths.push(joinPath(bootstrap.memoryDir, entry));
          }
        }
      } catch {
        // no memory dir: nothing to add
      }
    }
    return paths;
  }

  async getAgentSessionTranscript(
    agentId: string,
    params: { readonly sessionId: string },
  ): Promise<SessionTranscriptResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    // The session's conversation history (ResponseItem[]: { role, content }). content is a string or
    // an array of blocks; we surface user/assistant text so a joining client can render the transcript.
    const state = active.bootstrap.session.state?.unsafePeek?.();
    const history = Array.isArray(
      (state as { history?: unknown[] } | undefined)?.history,
    )
      ? ((state as { history: unknown[] }).history as unknown[])
      : [];
    const messages: { role: string; text: string }[] = [];
    for (const raw of history) {
      const item = raw as { role?: string; content?: unknown };
      if (item.role !== "user" && item.role !== "assistant") continue;
      let text = "";
      if (typeof item.content === "string") {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        text = item.content
          .map((b) =>
            b &&
            typeof b === "object" &&
            typeof (b as { text?: unknown }).text === "string"
              ? (b as { text: string }).text
              : "",
          )
          .filter((s) => s.length > 0)
          .join("");
      }
      if (text.length > 0) messages.push({ role: item.role, text });
    }
    return { sessionId: params.sessionId, messages };
  }

  async getAgentSessionTranscriptV2(
    agentId: string,
    params: { readonly sessionId: string },
  ): Promise<SessionTranscriptV2Result> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    return sessionTranscriptV2FromRollout(
      active.bootstrap.rolloutStore.readAll(),
      params.sessionId,
      active.thread.threadId,
      active.messageSubmission?.turnId === undefined
        ? undefined
        : {
            turnId: active.messageSubmission.turnId,
            clientMessageId: active.messageSubmission.clientMessageId,
          },
    );
  }

  async resolveLiveEffectReview(
    agentId: string,
    params: ResolveDurableEffectReviewOptions,
  ): Promise<ResolveDurableEffectReviewResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    if (active.bootstrap.session.conversationId !== params.sessionId) {
      throw new Error(
        `AgenC daemon agent ${agentId} does not own session ${params.sessionId}`,
      );
    }
    const driver = openStateDatabases({ cwd: active.bootstrap.workspaceRoot });
    try {
      const outcome = resolveLiveDurableEffectReview(driver, params, {
        readAll: () => active.bootstrap.rolloutStore.readAll(),
        append: (eventId, payload) =>
          active.bootstrap.session.emit(
            {
              eventId,
              id: eventId,
              msg: { type: "effect_review_resolved", payload },
            },
            { durable: true },
          ),
        project: (event) =>
          active.bootstrap.rolloutStore.recordEffectEvent(event),
      });
      if (
        outcome.kind !== "not_found" &&
        outcome.durable &&
        params.resolution.workflowStatus !== "pending"
      ) {
        resolveLiveEffectPoison(active.bootstrap.session, {
          callId: params.toolCallId,
          ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}),
          ...(outcome.stepId !== undefined ? { stepId: outcome.stepId } : {}),
        });
      }
      return outcome;
    } finally {
      driver.close();
    }
  }

  // Read the global session-level cache stats tracker (lives in the
  // daemon process, fed by the upstream SDK call sites). Provider
  // flows that bypass the tracker (lmstudio / xAI / chat-completions)
  // legitimately return zeros — that's accurate, not a bug. The
  // canonical-authority refactor retired the tracker module itself, so
  // until it returns this degrades to zeros through the tolerant
  // import below rather than breaking the snapshot surface.
  async #sessionCacheStatsSnapshot(
    _active: ActiveBackgroundAgent,
  ): Promise<SessionSnapshotResult["cacheStats"]> {
    const trackerPath = "../services/api/cacheStatsTracker.js";
    const mod: unknown = await import(/* @vite-ignore */ trackerPath).catch(
      () => null,
    );
    if (mod === null) {
      return {
        requestCount: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheTotalInputTokens: 0,
        hitRate: null,
      };
    }
    const metrics = (
      mod as {
        getSessionCacheMetrics?: () => {
          readonly requestCount?: number;
          readonly cacheReadInputTokens?: number;
          readonly cacheCreationInputTokens?: number;
          readonly cacheTotalInputTokens?: number;
          readonly hitRate?: number | null;
        };
      }
    ).getSessionCacheMetrics?.();
    return {
      requestCount: finiteNumber(metrics?.requestCount ?? 0),
      cacheReadInputTokens: finiteNumber(metrics?.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: finiteNumber(
        metrics?.cacheCreationInputTokens ?? 0,
      ),
      cacheTotalInputTokens: finiteNumber(metrics?.cacheTotalInputTokens ?? 0),
      hitRate:
        metrics?.hitRate === null || metrics?.hitRate === undefined
          ? null
          : finiteNumber(metrics.hitRate),
    };
  }

  async partialCompactFromMessage(
    agentId: string,
    params: AgenCBackgroundAgentPartialCompactParams,
  ): Promise<SessionPartialCompactFromMessageResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const compact = active.bootstrap.session.partialCompactFromMessage;
    if (compact === undefined) {
      throw new Error("session.partialCompactFromMessage is not available");
    }
    const result = await compact.call(active.bootstrap.session, {
      messageOrdinal: params.messageOrdinal,
      direction: params.direction,
      ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
    if (result.ok && result.event !== undefined) {
      await this.#persistTranscriptEpoch(
        active,
        result.event as unknown as JsonObject,
      );
      await this.#emitOrBufferEvent(active, result.event as never);
      return {
        sessionId: params.sessionId,
        ok: true,
        eventAlreadyEmitted: true,
        ...(result.attemptId !== undefined
          ? { attemptId: result.attemptId }
          : {}),
        ...(result.displayText !== undefined
          ? { displayText: result.displayText }
          : {}),
        event: result.event as unknown as JsonObject,
      };
    }
    return {
      sessionId: params.sessionId,
      ok: false,
      eventAlreadyEmitted: true,
      code: result.ok ? "NO_EVENT" : result.code,
      message: result.ok
        ? "No replacement event was produced."
        : result.message,
    };
  }

  async rollbackCompaction(
    agentId: string,
    params: AgenCBackgroundAgentRollbackCompactionParams,
  ): Promise<SessionRollbackCompactionResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const result = await active.bootstrap.session.rollbackCompaction({
      attemptId: params.attemptId,
      ...(params.reviewedBranchTargetSessionId !== undefined
        ? {
            reviewedBranchTargetSessionId: params.reviewedBranchTargetSessionId,
          }
        : {}),
    });
    if (result.ok && result.event !== undefined) {
      await this.#persistTranscriptEpoch(
        active,
        result.event as unknown as JsonObject,
      );
      await this.#emitOrBufferEvent(active, result.event as never);
    }
    return result.ok
      ? {
          sessionId: params.sessionId,
          ok: true,
          eventAlreadyEmitted: true,
          attemptId: result.attemptId,
          mode: result.mode,
          targetSessionId: result.targetSessionId,
          displayText: result.displayText,
          ...(result.event !== undefined
            ? { event: result.event as unknown as JsonObject }
            : {}),
        }
      : {
          sessionId: params.sessionId,
          ok: false,
          eventAlreadyEmitted: true,
          code: result.code,
          message: result.message,
        };
  }

  async extendCompactionRollbackRetention(
    agentId: string,
    params: AgenCBackgroundAgentExtendCompactionRetentionParams,
  ): Promise<SessionExtendCompactionRollbackRetentionResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    return await active.bootstrap.session.extendCompactionRollbackRetention({
      attemptId: params.attemptId,
      extendedUntilMs: params.extendedUntilMs,
    });
  }

  async rewindConversationToMessage(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionRewindConversationToMessageResult> {
    if (params.signal?.aborted) {
      throw Object.assign(new Error("request cancelled"), {
        name: "AbortError",
      });
    }
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const rewind = active.bootstrap.session.rewindConversationToMessage;
    if (rewind === undefined) {
      throw new Error("session.rewindConversationToMessage is not available");
    }
    const result = await rewind.call(active.bootstrap.session, {
      messageOrdinal: params.messageOrdinal,
    });
    if (result.ok && result.event !== undefined) {
      await this.#persistTranscriptEpoch(
        active,
        result.event as unknown as JsonObject,
      );
      await this.#emitOrBufferEvent(active, result.event as never);
      return {
        sessionId: params.sessionId,
        ok: true,
        eventAlreadyEmitted: true,
        event: result.event as unknown as JsonObject,
      };
    }
    return {
      sessionId: params.sessionId,
      ok: false,
      eventAlreadyEmitted: true,
      code: result.ok ? "NO_EVENT" : result.code,
      message: result.ok
        ? "No replacement event was produced."
        : result.message,
    };
  }

  async #persistTranscriptEpoch(
    active: ActiveBackgroundAgent,
    replacementEvent: JsonObject,
  ): Promise<void> {
    const id =
      typeof replacementEvent.id === "string"
        ? replacementEvent.id
        : `history-replaced-${active.thread.threadId}-${Date.now()}`;
    const payload = isJsonObject(replacementEvent.payload)
      ? replacementEvent.payload
      : {};
    const reason =
      payload.reason === "rewind" ||
      payload.reason === "compaction_rollback" ||
      payload.reason === "partial_compact"
        ? payload.reason
        : "partial_compact";
    active.bootstrap.session.emit(
      {
        eventId: `transcript-epoch:${id}`,
        id: `transcript-epoch:${id}`,
        msg: { type: "transcript_epoch", payload: { reason } },
      },
      { durable: true },
    );
    await active.dispatchChain;
  }

  async previewFileRewind(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionPreviewFileRewindResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const preview = active.bootstrap.session.previewFileRewind;
    if (preview === undefined) {
      throw new Error("session.previewFileRewind is not available");
    }
    const result = await preview.call(active.bootstrap.session, {
      messageOrdinal: params.messageOrdinal,
    });
    if (result.ok) {
      return {
        sessionId: params.sessionId,
        ok: true,
        canRestoreFiles: result.canRestoreFiles,
        filesChanged: [...result.filesChanged],
        insertions: result.insertions,
        deletions: result.deletions,
      };
    }
    return {
      sessionId: params.sessionId,
      ok: false,
      code: result.code,
      message: result.message,
    };
  }

  async rewindFilesToMessage(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionRewindFilesToMessageResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const rewindFiles = active.bootstrap.session.rewindFilesToMessage;
    if (rewindFiles === undefined) {
      throw new Error("session.rewindFilesToMessage is not available");
    }
    const result = await rewindFiles.call(active.bootstrap.session, {
      messageOrdinal: params.messageOrdinal,
    });
    if (result.ok) {
      return {
        sessionId: params.sessionId,
        ok: true,
        restoredFiles: [...result.restoredFiles],
        displayText: result.displayText,
      };
    }
    return {
      sessionId: params.sessionId,
      ok: false,
      code: result.code,
      message: result.message,
    };
  }

  async setAgentModel(
    agentId: string,
    params: AgenCBackgroundAgentSetModelParams,
  ): Promise<AgenCBackgroundAgentSetModelResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    return withRuntimeSettingsMutation(active, async () => {
      if (!isRunnableActiveAgent(active)) {
        throw new Error(`AgenC daemon agent not running: ${agentId}`);
      }
      const session = active.bootstrap.session;
      const previousPending = session.pendingProviderSwitch;
      const previousSettings = ensureInitialRuntimeSettings(active, agentId);
      let preparedSettingsChange: PreparedRuntimeSettingsChange | undefined;
      let preparedSettings: RunRuntimeSettingsSnapshot | undefined;
      let preparedProviderSwitch: PreparedSessionProviderSwitch | undefined;
      let stagedProviderSwitch: PreparedSessionProviderSwitch | undefined;
      const stage = async (selection: {
        readonly provider: string;
        readonly model: string;
      }): Promise<void> => {
        if (preparedSettingsChange !== undefined) {
          throw new Error(
            `run ${agentId} model switch prepared more than once`,
          );
        }
        preparedProviderSwitch = await runWithCurrentRuntimeSession(
          session,
          () =>
            runWithCanonicalSettingsAuthority(
              active.bootstrap.configStore,
              () => session.prepareProviderSwitch(selection),
            ),
        );
        const nextSettings: RunRuntimeSettingsSnapshot = {
          ...captureRuntimeSettings(active),
          provider: selection.provider,
          model: selection.model,
        };
        preparedSettings = nextSettings;
        preparedSettingsChange = prepareDurableRuntimeSettingsChange(
          active,
          agentId,
          nextSettings,
          "model_provider_changed",
        );
        session.stagePreparedProviderSwitch(
          preparedProviderSwitch,
          previousPending,
        );
        stagedProviderSwitch = preparedProviderSwitch;
      };
      let outcome: ProviderModelSelectionOutcome;
      try {
        if (params.model !== undefined) {
          outcome = await applyModelSwitch(
            session,
            params.model,
            params.provider,
            { stage },
          );
        } else if (params.provider !== undefined) {
          outcome = await applyProviderSwitch(
            session,
            params.provider,
            undefined,
            { stage },
          );
        } else {
          const settingsEventId = active.runtimeSettingsEventId;
          if (settingsEventId === undefined) {
            throw new Error(`run ${agentId} has no runtime-settings cursor`);
          }
          return {
            applied: false,
            provider: previousSettings.provider,
            model: previousSettings.model,
            runtimeSettingsEventId: settingsEventId,
            summary: "No model or provider was supplied.",
          };
        }
        if (outcome.applied !== (preparedSettingsChange !== undefined)) {
          throw new Error(
            `run ${agentId} model outcome disagrees with its prepared runtime-settings successor`,
          );
        }
        if (
          outcome.applied &&
          (preparedSettings?.provider !== outcome.provider ||
            preparedSettings?.model !== outcome.model)
        ) {
          throw new Error(
            `run ${agentId} model outcome does not match its prepared provider/model pair`,
          );
        }
        if (outcome.applied) {
          if (
            preparedProviderSwitch === undefined ||
            stagedProviderSwitch !== preparedProviderSwitch ||
            session.pendingProviderSwitch !== preparedProviderSwitch.pending
          ) {
            throw new Error(
              `run ${agentId} model switch lost its prepared provider binding`,
            );
          }
        }
      } catch (error) {
        if (preparedSettingsChange !== undefined) {
          const rollbackErrors: unknown[] = [];
          if (
            stagedProviderSwitch !== undefined &&
            session.pendingProviderSwitch === stagedProviderSwitch.pending
          ) {
            try {
              session.setPendingProviderSwitch(previousPending);
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          if (rollbackErrors.length === 0) {
            try {
              compensatePreparedRuntimeSettingsChange(
                active,
                agentId,
                previousSettings,
                preparedSettingsChange,
              );
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [error, ...rollbackErrors],
              `agent model rollback failed for ${agentId}`,
              { cause: error },
            );
          }
        }
        throw error;
      }
      preparedSettingsChange?.finalize();
      const settings = active.runtimeSettings ?? previousSettings;
      const settingsEventId = active.runtimeSettingsEventId;
      if (settingsEventId === undefined) {
        throw new Error(`run ${agentId} has no runtime-settings cursor`);
      }
      return {
        applied: outcome.applied,
        provider: settings.provider,
        model: settings.model,
        runtimeSettingsEventId: settingsEventId,
        summary: outcome.summary,
      };
    });
  }

  async setAgentPermissionMode(
    agentId: string,
    params: AgenCBackgroundAgentSetPermissionModeParams,
  ): Promise<AgenCBackgroundAgentSetPermissionModeResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    if (!isPermissionMode(params.mode)) {
      throw new Error(
        `Unknown permission mode: "${params.mode}". Expected one of: ${USER_ADDRESSABLE_PERMISSION_MODES.join(", ")}`,
      );
    }
    const target = params.mode as PermissionMode;
    if (
      !(
        USER_ADDRESSABLE_PERMISSION_MODES as readonly PermissionMode[]
      ).includes(target)
    ) {
      throw new Error(
        `Permission mode "${params.mode}" is internal-only and cannot be set this way.`,
      );
    }
    // Mutate the daemon's REAL permission registry — the one the tool
    // evaluator reads on every tool call (background-agent-runner installs
    // it from bootstrap.session.permissionModeRegistry).
    const registry = active.bootstrap.session.permissionModeRegistry;
    return registry.transact<AgenCBackgroundAgentSetPermissionModeResult>(
      async (liveCurrent) => {
        if (!isRunnableActiveAgent(active)) {
          throw new Error(`AgenC daemon agent not running: ${agentId}`);
        }
        const sameModeAutoAuthorityRevoked =
          liveCurrent.mode === "auto" &&
          target === "auto" &&
          !runWithCurrentRuntimeSession(active.bootstrap.session, () =>
            canCycleToAuto(liveCurrent),
          );
        if (
          liveCurrent.mode === target &&
          target !== "bypassPermissions" &&
          !sameModeAutoAuthorityRevoked
        ) {
          return {
            next: null,
            result: () => ({
              applied: false,
              previousMode: liveCurrent.mode,
              mode: target,
            }),
          };
        }

        let transitionContext = liveCurrent;
        let workspacePath: string | undefined;
        if (target === "bypassPermissions") {
          try {
            const canonicalCwd = canonicalizeBypassPermissionsCwd(
              runtimeWorkspaceRoot(active.bootstrap),
            );
            workspacePath = canonicalCwd;
            const stateRepository =
              active.bootstrap.configStore?.stateRepository;
            if (stateRepository !== undefined) {
              for (const acceptedCwd of loadBypassPermissionsConsent(
                stateRepository,
                canonicalCwd,
                { reload: true },
              )) {
                transitionContext = authorizeBypassPermissionsConsent(
                  transitionContext,
                  acceptedCwd,
                );
              }
            }
            if (params.bypassAuthority === "operator_tool_approval") {
              transitionContext = authorizeBypassPermissionsConsent(
                transitionContext,
                canonicalCwd,
              );
            }
          } catch {
            throw new Error(
              "Switching to bypassPermissions requires explicit consent for a stable canonical cwd",
            );
          }
        }
        let nextCtx: ToolPermissionContext;
        if (sameModeAutoAuthorityRevoked) {
          nextCtx = createDisabledAutoModeContext(liveCurrent);
        } else {
          const transitioned = runWithCurrentRuntimeSession(
            active.bootstrap.session,
            () => {
              if (target !== "bypassPermissions") {
                return transitionPermissionMode(
                  transitionContext.mode,
                  target,
                  transitionContext,
                );
              }
              if (workspacePath === undefined) {
                throw new Error(
                  "Switching to bypassPermissions requires a canonical workspace",
                );
              }
              return transitionPermissionMode(
                transitionContext.mode,
                target,
                transitionContext,
                { workspacePath },
              );
            },
          );
          if ("error" in transitioned) {
            throw new Error(
              "Switching to bypassPermissions requires explicit consent for this exact cwd",
            );
          }
          nextCtx = { ...transitioned, mode: target };
        }
        const applied =
          sameModeAutoAuthorityRevoked || liveCurrent.mode !== target;
        return {
          next: nextCtx,
          metadata: {
            runtimeSettings: {
              reason: "permission_mode_changed",
              rollbackOfSettingsEventId: null,
            },
          },
          result: () => {
            const appliedSettingsEventId = active.runtimeSettingsEventId;
            const result: AgenCBackgroundAgentSetPermissionModeResult = {
              applied,
              previousMode: liveCurrent.mode,
              mode: nextCtx.mode,
            };
            if (!applied || sameModeAutoAuthorityRevoked) return result;
            // Keep the transaction hook out of JSON and ordinary result equality;
            // session.setPermissionMode's public result remains unchanged.
            Object.defineProperty(result, "rollback", {
              value: async () => {
                await registry.transact(() => {
                  if (
                    appliedSettingsEventId === undefined ||
                    active.runtimeSettingsEventId !== appliedSettingsEventId
                  ) {
                    throw new Error(
                      "permission-mode rollback no longer follows the applied settings event",
                    );
                  }
                  return {
                    next: liveCurrent,
                    metadata: {
                      runtimeSettings: {
                        reason: "compensating_rollback",
                        rollbackOfSettingsEventId: appliedSettingsEventId,
                      },
                    },
                    result: () => undefined,
                  };
                });
              },
              enumerable: false,
            });
            return result;
          },
        };
      },
    );
  }

  async mutateAgentPermissionRule(
    agentId: string,
    params: SessionPermissionRuleMutationParams,
  ): Promise<AgenCBackgroundAgentPermissionRuleMutationResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    if (params.operation !== "add" && params.operation !== "remove") {
      throw new PermissionRuleMutationPrecommitError(
        `Unknown permission rule operation: ${params.operation}`,
      );
    }
    if (
      params.behavior !== "allow" &&
      params.behavior !== "deny" &&
      params.behavior !== "ask"
    ) {
      throw new PermissionRuleMutationPrecommitError(
        `Unknown permission rule behavior: ${params.behavior}`,
      );
    }
    const parsed = parseRuleString(params.rule);
    if (parsed === null || serializeRuleValue(parsed) !== params.rule) {
      throw new PermissionRuleMutationPrecommitError(
        "Permission rule must use the canonical serialized rule format",
      );
    }
    const canonicalRule = serializeRuleValue(parsed);
    const registry = active.bootstrap.session.permissionModeRegistry;
    return registry.transact(async (current) => {
      try {
        if (!isRunnableActiveAgent(active)) {
          throw new Error(`AgenC daemon agent not running: ${agentId}`);
        }
        const policy = await loadPermissionRulesSnapshot({
          configStore: active.bootstrap.configStore,
          cwd: runtimeWorkspaceRoot(active.bootstrap),
        });
        if (policy.managedOnly) {
          throw new Error(
            "Session permission rules are disabled by managed-only policy",
          );
        }

        const mutation = mutatePermissionRuleSource(
          current,
          "session",
          params.operation,
          params.behavior,
          parsed,
        );
        return {
          next: mutation.applied ? mutation.next : null,
          result: () => ({
            applied: mutation.applied,
            operation: params.operation,
            behavior: params.behavior,
            rule: canonicalRule,
            sessionRules: mutation.buckets,
          }),
        };
      } catch (error) {
        if (error instanceof PermissionRuleMutationPrecommitError) throw error;
        throw new PermissionRuleMutationPrecommitError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
    });
  }

  async getAgentHooksStatus(
    agentId: string,
  ): Promise<AgenCBackgroundAgentHooksStatusResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    // Read the daemon session's REAL configured-hooks runtime (the one the
    // daemon's tool evaluator consults) — bootstrap.session.services.hooksRuntime.
    const rt = active.bootstrap.session.services?.hooksRuntime;
    if (rt === undefined) {
      return {
        available: false,
        sourcePath: "",
        disabled: true,
        hardSuppressed:
          active.bootstrap.session.services.runtimeOptions.simpleMode,
        effectiveDisabled: true,
        suppressionReason: active.bootstrap.session.services.runtimeOptions
          .simpleMode
          ? "bare_mode"
          : null,
        issues: [],
        hooks: [],
        diagnostics: [],
      };
    }
    // Spread the readonly arrays into plain arrays so they serialize cleanly
    // over the daemon RPC transport.
    return {
      available: true,
      sourcePath: rt.sourcePath(),
      ...configuredHookExecutionState(rt),
      issues: rt.issues().map((issue) => ({
        level: issue.level,
        message: issue.message,
      })),
      hooks: rt.listHooks().map((hook) => ({
        event: hook.event,
        ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
        command: {
          type: hook.command.type,
          command: hook.command.command,
          ...(hook.command.timeout_ms !== undefined
            ? { timeout_ms: hook.command.timeout_ms }
            : {}),
          ...(hook.command.statusMessage !== undefined
            ? { statusMessage: hook.command.statusMessage }
            : {}),
        },
        source: hook.source,
        sourcePath: hook.sourcePath,
        enabled: hook.enabled,
        index: hook.index,
      })),
      diagnostics: rt.latestDiagnostics().map((diag) => ({
        id: diag.id,
        event: diag.event,
        ...(diag.matcher !== undefined ? { matcher: diag.matcher } : {}),
        command: diag.command,
        status: diag.status,
        ...(diag.exitCode !== undefined ? { exitCode: diag.exitCode } : {}),
        durationMs: diag.durationMs,
        stdout: diag.stdout,
        stderr: diag.stderr,
        ...(diag.error !== undefined ? { error: diag.error } : {}),
        startedAtUnixMs: diag.startedAtUnixMs,
      })),
    };
  }

  async setAgentHooksDisabled(
    agentId: string,
    params: AgenCBackgroundAgentSetHooksDisabledParams,
  ): Promise<AgenCBackgroundAgentSetHooksDisabledResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    return withRuntimeSettingsMutation(active, async () => {
      if (!isRunnableActiveAgent(active)) {
        throw new Error(`AgenC daemon agent not running: ${agentId}`);
      }
      const rt = active.bootstrap.session.services?.hooksRuntime;
      if (rt === undefined) {
        throw new Error("Hooks runtime is not available on the daemon session");
      }
      const previousSettings = ensureInitialRuntimeSettings(active, agentId);
      if (previousSettings.hooksDisabled === params.disabled) {
        return { applied: false, ...configuredHookExecutionState(rt) };
      }
      const nextSettings = {
        ...captureRuntimeSettings(active),
        hooksDisabled: params.disabled,
      } satisfies RunRuntimeSettingsSnapshot;
      const preparedSettingsChange = prepareDurableRuntimeSettingsChange(
        active,
        agentId,
        nextSettings,
        "hooks_changed",
      );
      try {
        rt.setDisabled(params.disabled);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          rt.setDisabled(previousSettings.hooksDisabled);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length === 0) {
          try {
            compensatePreparedRuntimeSettingsChange(
              active,
              agentId,
              previousSettings,
              preparedSettingsChange,
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            `agent hooks rollback failed for ${agentId}`,
            { cause: error },
          );
        }
        throw error;
      }
      preparedSettingsChange.finalize();
      return { applied: true, ...configuredHookExecutionState(rt) };
    });
  }

  async applyAgentConfig(
    agentId: string,
    params: AgenCBackgroundAgentApplyConfigParams,
  ): Promise<AgenCBackgroundAgentApplyConfigResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const session = active.bootstrap.session;
    const configStore = session.services.configStore;
    if (configStore === undefined) {
      return {
        applied: false,
        summary:
          "No config store is available on the live session; nothing applied.",
      };
    }
    if (params.profile !== undefined) {
      resolveProfile(configStore.current(), params.profile);
    }
    const changes: string[] = [];
    let applied = false;
    let preparedReloadSelection:
      ReturnType<typeof resolveProviderModelSelection> | undefined;
    let preparedReloadProviderSwitch: PreparedSessionProviderSwitch | undefined;
    if (params.reload === true) {
      const preparedConfigReload = await configStore.prepareReload();
      const preparedMcpAuthorityRefresh = prepareMcpAuthorityRefresh(session);
      try {
        const preparedConfig = preparedConfigReload.config;
        const preparedResolved =
          params.profile !== undefined
            ? resolveProfile(preparedConfig, params.profile)
            : preparedConfig;
        if (
          typeof preparedResolved.model === "string" ||
          typeof preparedResolved.model_provider === "string"
        ) {
          preparedReloadSelection = resolveProviderModelSelection(
            preparedConfig,
            readSessionSelection(session, {
              includePending: true,
              fallbackConfig: preparedConfig,
            }),
            {
              ...(typeof preparedResolved.model_provider === "string"
                ? { model_provider: preparedResolved.model_provider }
                : {}),
              ...(typeof preparedResolved.model === "string"
                ? { model: preparedResolved.model }
                : {}),
            },
          );
          preparedReloadProviderSwitch = await runWithCurrentRuntimeSession(
            session,
            () =>
              runWithCanonicalSettingsAuthority(
                preparedConfigReload.authority,
                () =>
                  session.prepareProviderSwitch(
                    {
                      ...preparedReloadSelection!,
                      ...(params.profile !== undefined
                        ? { profile: params.profile }
                        : {}),
                    },
                    preparedConfig,
                  ),
              ),
          );
        }
        const permissionSnapshot = await loadPermissionRulesSnapshot({
          configStore: preparedConfigReload.authority,
        });
        await session.permissionModeRegistry.transact((current) => {
          const next = applyPermissionRulesSnapshot(
            current,
            permissionSnapshot,
          );
          const configuredExecutionAuthority =
            active.bootstrap.prepareConfiguredExecutionAuthority(
              preparedConfigReload.config,
              next,
            );
          return {
            next,
            metadata: {
              runtimeSettings: {
                reason: "config_applied" as const,
                rollbackOfSettingsEventId: null,
              },
              configuredExecutionAuthority,
              preparedConfigReload,
              ...(preparedMcpAuthorityRefresh !== undefined
                ? { preparedMcpAuthorityRefresh }
                : {}),
            },
            result: () => undefined,
          };
        });
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (!preparedConfigReload.settled) {
          if (preparedConfigReload.state !== "rolled_back") {
            try {
              preparedConfigReload.rollback();
            } catch (rollbackError) {
              cleanupErrors.push(rollbackError);
            }
          }
          try {
            preparedConfigReload.settle();
          } catch (settleError) {
            cleanupErrors.push(settleError);
          }
        }
        if (cleanupErrors.length > 0) {
          failClosedDaemonRuntimeAuthority(
            active,
            new AggregateError(
              [error, ...cleanupErrors],
              "canonical config reload rollback was incomplete",
              { cause: error },
            ),
            {
              brokerReason:
                "daemon permission authority failed after canonical publication",
              abortReason: "permission_authority_failure",
              abortFailureMessage: `agent config reload failed and session abort was incomplete for ${agentId}`,
            },
          );
        }
        throw error;
      }
      changes.push("config reloaded from disk");
      if (preparedMcpAuthorityRefresh !== undefined) {
        const refreshed = preparedMcpAuthorityRefresh.result;
        if (refreshed === undefined) {
          throw new Error(
            "coordinated MCP authority refresh completed without a result",
          );
        }
        changes.push(
          `MCP refreshed (${refreshed.configuredServers.length} configured, ${refreshed.requiredServers.length} required)`,
        );
      }
      applied = true;
      if (params.profile !== undefined) {
        resolveProfile(configStore.current(), params.profile);
      }
    }
    return withRuntimeSettingsMutation(active, async () => {
      if (!isRunnableActiveAgent(active)) {
        throw new Error(`AgenC daemon agent not running: ${agentId}`);
      }
      const canonicalConfig = configStore.current();
      const base = canonicalConfig as unknown as Record<string, unknown>;
      const resolved =
        params.profile !== undefined
          ? (resolveProfile(
              configStore.current(),
              params.profile,
            ) as unknown as Record<string, unknown>)
          : base;
      const previousSettings = ensureInitialRuntimeSettings(active, agentId);
      const previousPending = session.pendingProviderSwitch;
      const previousConfiguration = session.sessionConfiguration;
      const requestedModel =
        typeof resolved.model === "string" ? resolved.model : undefined;
      const requestedProvider =
        typeof resolved.model_provider === "string"
          ? resolved.model_provider
          : undefined;
      const currentModel =
        typeof base.model === "string" ? base.model : undefined;
      const targetSelection =
        preparedReloadSelection ??
        (requestedModel !== undefined || requestedProvider !== undefined
          ? resolveProviderModelSelection(
              canonicalConfig,
              readSessionSelection(session, {
                includePending: true,
                fallbackConfig: canonicalConfig,
              }),
              {
                ...(requestedProvider !== undefined
                  ? { model_provider: requestedProvider }
                  : {}),
                ...(requestedModel !== undefined
                  ? { model: requestedModel }
                  : {}),
              },
            )
          : undefined);
      const targetModel = targetSelection?.model;
      const stageProvider = targetSelection?.provider;
      const pendingSelection =
        targetModel !== undefined && stageProvider !== undefined
          ? {
              provider: stageProvider,
              model: targetModel,
              ...(params.profile !== undefined
                ? { profile: params.profile }
                : {}),
            }
          : undefined;
      const preparedProviderSwitch =
        pendingSelection === undefined
          ? undefined
          : (preparedReloadProviderSwitch ??
            (await runWithCurrentRuntimeSession(session, () =>
              runWithCanonicalSettingsAuthority(configStore, () =>
                session.prepareProviderSwitch(pendingSelection),
              ),
            )));
      const nextReasoning = normalizeRuntimeSetting(
        resolved.reasoning_effort,
        RUN_RUNTIME_REASONING_EFFORTS,
        "reasoning effort",
      );
      const nextVerbosity = normalizeRuntimeSetting(
        resolved.model_verbosity,
        RUN_RUNTIME_MODEL_VERBOSITIES,
        "model verbosity",
      );
      const nextServiceTier = normalizeRuntimeSetting(
        resolved.service_tier,
        RUN_RUNTIME_SERVICE_TIERS,
        "service tier",
      );
      const nextSettings: RunRuntimeSettingsSnapshot = {
        ...captureRuntimeSettings(active),
        ...(targetModel !== undefined && stageProvider !== undefined
          ? { model: targetModel, provider: stageProvider }
          : {}),
        ...(params.profile !== undefined ? { profile: params.profile } : {}),
        ...(nextReasoning !== null ? { reasoningEffort: nextReasoning } : {}),
        ...(nextVerbosity !== null ? { modelVerbosity: nextVerbosity } : {}),
        ...(nextServiceTier !== null ? { serviceTier: nextServiceTier } : {}),
      };
      const settingsChanged =
        stableStringify(nextSettings) !== stableStringify(previousSettings);
      let preparedSettingsChange: PreparedRuntimeSettingsChange | undefined;
      let stagedProviderSwitch: PreparedSessionProviderSwitch | undefined;
      if (settingsChanged) {
        preparedSettingsChange = prepareDurableRuntimeSettingsChange(
          active,
          agentId,
          nextSettings,
          "config_applied",
        );
      }
      try {
        if (
          nextReasoning !== null ||
          nextVerbosity !== null ||
          nextServiceTier !== null
        ) {
          await session.state.with((state) => {
            const configuration = state.sessionConfiguration;
            state.sessionConfiguration = {
              ...configuration,
              collaborationMode: {
                ...configuration.collaborationMode,
                ...(nextReasoning !== null
                  ? { reasoningEffort: nextReasoning }
                  : {}),
              } as typeof configuration.collaborationMode,
              ...(nextVerbosity !== null
                ? { modelVerbosity: nextVerbosity }
                : {}),
              ...(nextServiceTier !== null
                ? { serviceTier: nextServiceTier }
                : {}),
            };
          });
          if (nextReasoning !== null) {
            changes.push(`reasoning effort ->${nextReasoning}`);
          }
          if (nextVerbosity !== null)
            changes.push(`verbosity ->${nextVerbosity}`);
          if (nextServiceTier !== null) {
            changes.push(`service tier ->${nextServiceTier}`);
          }
          applied = true;
        }
        if (preparedProviderSwitch !== undefined) {
          session.stagePreparedProviderSwitch(
            preparedProviderSwitch,
            previousPending,
          );
          stagedProviderSwitch = preparedProviderSwitch;
          changes.push(
            targetModel !== currentModel
              ? `model ${currentModel ?? "?"}->${targetModel}`
              : `model ${targetModel}`,
          );
          applied = true;
        }
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (
          stagedProviderSwitch !== undefined &&
          session.pendingProviderSwitch === stagedProviderSwitch.pending
        ) {
          try {
            session.setPendingProviderSwitch(previousPending);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        try {
          await session.state.with((state) => {
            state.sessionConfiguration = previousConfiguration;
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (
          rollbackErrors.length === 0 &&
          preparedSettingsChange !== undefined
        ) {
          try {
            compensatePreparedRuntimeSettingsChange(
              active,
              agentId,
              previousSettings,
              preparedSettingsChange,
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            `agent config rollback failed for ${agentId}`,
            { cause: error },
          );
        }
        throw error;
      }
      preparedSettingsChange?.finalize();
      const runtimeSettings = active.runtimeSettings ?? previousSettings;
      const runtimeSettingsEventId = active.runtimeSettingsEventId;
      const label =
        params.profile !== undefined
          ? `profile ${params.profile}`
          : params.reload === true
            ? "config reload"
            : "config";
      return {
        applied,
        ...(runtimeSettingsEventId === undefined
          ? {}
          : {
              provider: runtimeSettings.provider,
              model: runtimeSettings.model,
              runtimeSettingsEventId,
            }),
        summary:
          changes.length > 0
            ? `${label} applied: ${changes.join(", ")}`
            : `${label}: no changes to apply`,
      };
    });
  }

  async resolveToolDecision(
    agentId: string,
    params: AgenCBackgroundAgentToolDecisionParams,
  ): Promise<boolean> {
    const active = this.#active.get(agentId);
    if (active !== undefined && !isRunnableActiveAgent(active)) return false;
    const pendingForAgent = this.#pendingToolDecisions.get(agentId);
    const resolve = pendingForAgent?.get(params.requestId);
    if (resolve === undefined) return false;
    pendingForAgent!.delete(params.requestId);
    if (pendingForAgent!.size === 0) {
      this.#pendingToolDecisions.delete(agentId);
    }
    resolve(params.decision);
    return true;
  }

  async cancelTool(
    agentId: string,
    params: AgenCBackgroundAgentToolCancelParams,
  ): Promise<boolean> {
    const active = this.#active.get(agentId);
    if (active !== undefined && !isRunnableActiveAgent(active)) return false;
    const pendingResolved = await this.resolveToolDecision(agentId, {
      requestId: params.requestId,
      decision: ABORT,
    });
    if (active === undefined) return pendingResolved;
    const activeToolMatched = active.activeToolCallIds.has(params.requestId);
    if (!pendingResolved && !activeToolMatched) return false;
    void active.thread
      .submit({
        type: "interrupt",
        reason: params.reason ?? `tool.cancel:${params.requestId}`,
      })
      .catch(() => {
        /* interrupt delivery surfaces via session events */
      });
    active.lastActiveAt = this.#now();
    return true;
  }

  /**
   * Interrupt the agent's active turn. Returns `true` when the agent
   * was found and the interrupt was dispatched (mirrors `cancelTool`'s
   * shape). The interrupt cascades to descendants (subagents) via
   * {@link AgentControl.interrupt} and fires the agent's
   * AbortController so the run-turn loop observes it on next tick.
   * When the agent was idle the interrupt is harmless.
   */
  async interruptAgentTurn(agentId: string, reason: string): Promise<boolean> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isInterruptibleActiveAgent(active))
      return false;
    try {
      await active.bootstrap.session.abortAllTasks("interrupted");
    } catch {
      /* interrupt delivery still falls through the managed thread path */
    }
    void active.thread.submit({ type: "interrupt", reason }).catch(() => {
      /* interrupt delivery surfaces via session events */
    });
    for (const [childThreadId] of active.control.openThreadSpawnChildren(
      active.thread.threadId,
    )) {
      active.control.interrupt(childThreadId, reason);
    }
    active.lastActiveAt = this.#now();
    return true;
  }

  async interruptAgentTurnIfMatches(
    agentId: string,
    reason: string,
    expectedTurnId: string,
  ): Promise<AgenCBackgroundAgentTurnCancellationResult> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isInterruptibleActiveAgent(active)) {
      return { cancelled: false };
    }
    const activeTurnId =
      runtimeActiveTurnId(active.bootstrap.session) ??
      active.messageSubmission?.turnId;
    if (activeTurnId !== expectedTurnId) {
      return {
        cancelled: false,
        ...(activeTurnId !== undefined ? { activeTurnId } : {}),
        stale: true,
      };
    }
    let cancelled = false;
    try {
      cancelled = await active.bootstrap.session.abortTurnIfActive(
        expectedTurnId,
        "interrupted",
      );
    } catch {
      return { cancelled: false, activeTurnId: expectedTurnId };
    }
    if (!cancelled) {
      const turnAfterAttempt = runtimeActiveTurnId(active.bootstrap.session);
      return {
        cancelled: false,
        ...(turnAfterAttempt !== undefined
          ? { activeTurnId: turnAfterAttempt }
          : {}),
        ...(turnAfterAttempt !== expectedTurnId ? { stale: true } : {}),
      };
    }
    for (const [childThreadId] of active.control.openThreadSpawnChildren(
      active.thread.threadId,
    )) {
      active.control.interrupt(childThreadId, reason);
    }
    active.lastActiveAt = this.#now();
    return { cancelled: true, activeTurnId: expectedTurnId };
  }

  async respondToElicitation(
    agentId: string,
    params: AgenCBackgroundAgentElicitationResponseParams,
  ): Promise<boolean> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) return false;
    const resolved = await respondToSessionElicitation(
      active.bootstrap.session,
      params,
    );
    if (resolved) {
      active.lastActiveAt = this.#now();
    }
    return resolved;
  }

  #installDaemonApprovalBridge(
    session: LocalRuntimeBootstrap["session"],
  ): () => void {
    const services = (
      session as {
        services?: {
          approvalResolver?: ApprovalResolver;
        };
      }
    ).services;
    if (services === undefined) return () => {};
    const previousResolver = services.approvalResolver;
    const resolver: ApprovalResolver = {
      request: (ctx) => this.#requestDaemonToolDecision(ctx),
    };
    services.approvalResolver = resolver;
    return () => {
      if (services.approvalResolver === resolver) {
        if (previousResolver === undefined) {
          delete services.approvalResolver;
        } else {
          services.approvalResolver = previousResolver;
        }
      }
    };
  }

  #installDurableTerminalFinalizer(
    active: ActiveBackgroundAgent,
    agentId: string,
  ): void {
    const session = active.bootstrap
      .session as LocalRuntimeBootstrap["session"] & {
      onBeforeDurableClose?: (
        listener: () => void | Promise<void>,
      ) => () => void;
    };
    if (typeof session.onBeforeDurableClose !== "function") return;
    active.durableTerminalFinalizerInstalled = true;
    active.unsubscribeDurableTerminalFinalizer = session.onBeforeDurableClose(
      () => {
        if (active.terminal !== undefined || active.suspension !== undefined) {
          return;
        }
        if (active.pendingSuspension !== undefined) {
          if (this.#canSuspendIdleAgent(agentId, active)) {
            try {
              commitDurableRunSuspension(active, agentId);
              return;
            } catch {
              // No suspension evidence was committed. Fall through to the
              // ordinary cancelled poison boundary while the writer is open.
            }
          }
          active.pendingSuspension = undefined;
          active.pendingTerminal ??= cancelledTerminalResult(
            active,
            agentId,
            "daemon_shutdown_not_idle",
            this.#now(),
          );
        }
        if (this.#pendingToolDecisions.has(agentId)) {
          const error = new Error(
            `cannot finalize run ${agentId} while permission decisions remain pending`,
          );
          active.terminalCommitError = error;
          throw error;
        }
        const result =
          active.pendingTerminal ??
          cancelledTerminalResult(
            active,
            agentId,
            "session_shutdown",
            this.#now(),
          );
        try {
          commitDurableRunTerminal(active, agentId, result);
        } catch (error) {
          active.terminalCommitError = error;
          throw error;
        }
      },
    );
  }

  #installSessionEventLogBridge(active: ActiveBackgroundAgent): () => void {
    const eventLog = (
      active.bootstrap.session as {
        eventLog?: {
          subscribe?: (
            listener: (event: {
              readonly eventId?: unknown;
              readonly id?: unknown;
              readonly seq?: unknown;
              readonly msg?: {
                readonly type?: unknown;
                readonly payload?: unknown;
              };
            }) => void,
          ) => () => void;
        };
      }
    ).eventLog;
    if (typeof eventLog?.subscribe !== "function") return () => {};
    active.canonicalEventBridgeInstalled = true;
    return eventLog.subscribe((event) => {
      const uncorrelated = daemonEventFromUnboundSessionEvent(event);
      if (uncorrelated === null) return;
      const daemonEvent = projectTelemetryErrorAsSessionOnly(
        scopeDirectShellDaemonEvent(
          active,
          correlateDaemonEvent(active, uncorrelated),
        ),
      );
      active.lastActiveAt = this.#now();
      this.#applyCanonicalEventBookkeeping(active, daemonEvent);
      void this.#emitOrBufferEvent(active, daemonEvent);
    });
  }

  #applyCanonicalEventBookkeeping(
    active: ActiveBackgroundAgent,
    event: BackgroundAgentDaemonEvent,
  ): void {
    if (event.statusProjection === "session_only") return;
    const payload = event.payload;
    switch (event.type) {
      case "agent_message_delta":
        if (typeof payload?.delta === "string") {
          const previous =
            this.#assistantTextByAgent.get(active.thread.threadId) ?? "";
          this.#assistantTextByAgent.set(
            active.thread.threadId,
            previous + payload.delta,
          );
        }
        return;
      case "tool_call_started":
        if (typeof payload?.callId === "string") {
          active.activeToolCallIds.add(payload.callId);
        }
        return;
      case "tool_call_completed":
        if (typeof payload?.callId === "string") {
          active.activeToolCallIds.delete(payload.callId);
        }
        return;
      case "turn_started":
        active.status = "running";
        return;
      case "turn_complete":
        active.status = "idle";
        return;
      case "turn_aborted":
        active.status = "idle";
        active.activeToolCallIds.clear();
        return;
      case "error":
        active.status = "error";
        active.activeToolCallIds.clear();
        return;
      case "run_reopened": {
        const epoch = positiveSequence(payload?.epoch);
        if (epoch !== undefined) active.runEpoch = epoch;
        active.status = "idle";
        return;
      }
      case "run_terminal":
        active.status = daemonStatusFromRunTerminal(payload?.status);
        active.activeToolCallIds.clear();
        return;
      default:
        return;
    }
  }

  async #requestDaemonToolDecision(ctx: ApprovalCtx): Promise<ReviewDecision> {
    const agentId = readApprovalAgentId(ctx);
    if (agentId === null) return DENIED;
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) return DENIED;
    const requestId = ctx.callId;
    const timeoutMs = resolvePermissionDecisionTimeoutMs();
    const decision = new Promise<ReviewDecision>((resolve) => {
      let pendingForAgent = this.#pendingToolDecisions.get(agentId);
      if (pendingForAgent === undefined) {
        pendingForAgent = new Map();
        this.#pendingToolDecisions.set(agentId, pendingForAgent);
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: ReviewDecision): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        pendingForAgent!.delete(requestId);
        if (pendingForAgent!.size === 0) {
          this.#pendingToolDecisions.delete(agentId);
        }
        resolve(value);
      };
      pendingForAgent.set(requestId, (value) => settle(value));
      const abort = (): void => {
        settle(ABORT);
      };
      ctx.signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle(TIMED_OUT);
        }, timeoutMs);
      }
    });
    return decision;
  }

  /** Force-resolve all pending permission decisions for an agent (todo-109). */
  #abortPendingToolDecisions(agentId: string): void {
    const pending = this.#pendingToolDecisions.get(agentId);
    if (pending === undefined) return;
    for (const resolve of pending.values()) {
      resolve(ABORT);
    }
    this.#pendingToolDecisions.delete(agentId);
  }

  #trackAgentStatus(active: ActiveBackgroundAgent): void {
    active.unsubscribeStatus = active.thread.subscribeStatus((status) => {
      active.status = mapThreadStatus(status);
      if (status.status === "running") {
        this.#assistantTextByAgent.set(active.thread.threadId, "");
      } else if (
        status.status === "completed" ||
        status.status === "errored" ||
        status.status === "interrupted" ||
        status.status === "shutdown" ||
        status.status === "not_found"
      ) {
        this.#assistantTextByAgent.delete(active.thread.threadId);
      }
      active.lastActiveAt = this.#now();
      if (!active.canonicalEventBridgeInstalled) {
        void this.#emitOrBufferEvent(active, eventFromThreadStatus(status));
      }
    });
  }

  #cleanupWhenComplete(
    agentId: string,
    generation: ActiveBackgroundAgent,
  ): Promise<void> {
    return awaitTerminalStatus(generation.thread)
      .then(async (terminalStatus) => {
        const active = this.#active.get(agentId);
        if (active !== generation) return;
        // Notify the lifecycle of terminal status BEFORE deleting from
        // `#active`. After deletion, `getAgentSnapshot` returns null
        // and the lifecycle's poll-based refresh has no way to observe
        // the transition, so it leaves `agent.status` at the initial
        // `running` value. The callback runs synchronously (awaited)
        // so the lifecycle's record is updated before any subsequent
        // `agent.list` resolves.
        if (
          active.terminal === undefined &&
          active.suspension === undefined &&
          active.pendingSuspension === undefined
        ) {
          active.pendingTerminal = terminalResultFromThread(
            active,
            agentId,
            terminalStatus,
          );
          try {
            if (!active.durableTerminalFinalizerInstalled) {
              commitDurableRunTerminal(active, agentId, active.pendingTerminal);
            }
          } catch {
            // A terminal transition is not advertised as M4-durable when its
            // canonical event could not be fsync-committed. The canonical
            // recovery path may still find a write that reached disk before
            // an injected post-commit failure.
          }
        }
        // Session status becomes terminal synchronously after turn_complete is
        // journaled, while daemon delivery is intentionally serialized on an
        // async chain. Drain that already-committed turn tail before shutdown
        // can close the writer or lifecycle teardown can retire its route.
        await this.#drainDispatchChain(active);
        await active.bootstrap.shutdown().catch(() => {});
        // The durable close finalizer appends run_terminal during shutdown.
        // Keep the session route live until that new canonical tail has also
        // crossed the same ordered delivery chain.
        await this.#drainDispatchChain(active);
        await this.#notifyActiveAgentTerminated(agentId, active);
        if (this.#active.get(agentId) !== generation) return;
        const bufferedEvents = active.bufferedEvents.splice(0);
        this.#active.delete(agentId);
        if (bufferedEvents.length > 0) {
          const pending = this.#pendingEvents.get(agentId) ?? [];
          pending.push(...bufferedEvents);
          this.#pendingEvents.set(
            agentId,
            boundBufferedAgentEvents(pending, agentId),
          );
        } else {
          this.#pendingEvents.delete(agentId);
        }
        this.#assistantTextByAgent.delete(agentId);
        this.#pendingActiveToolCallIds.delete(agentId);
        active.unsubscribeStatus?.();
        if (active.terminal !== undefined || active.suspension !== undefined) {
          active.unsubscribeDurableTerminalFinalizer?.();
        }
        active.uninstallApprovalBridge?.();
        active.uninstallRuntimeSettingsPreCommit?.();
        active.unsubscribeElicitationEvents?.();
        active.unsubscribePhaseEvents?.();
        active.unsubscribeMcpSurfaceInvalidations?.();
        // gaphunt3 #48: the agentId is the session/conversationId used as the
        // vended-key cache key, so evict this session's entries on terminal
        // cleanup — otherwise non-expiring keys leak for the daemon's lifetime.
        this.#authBackend?.clearVendedKeysForSession(agentId);
      })
      .catch(() => {});
  }

  async #notifyActiveAgentTerminated(
    agentId: string,
    active: ActiveBackgroundAgent,
  ): Promise<void> {
    if (active.terminationNotified === true) return;
    if (
      active.pendingSuspension !== undefined ||
      active.suspension !== undefined
    ) {
      return;
    }
    if (active.canonicalEventBridgeInstalled && active.terminal === undefined) {
      // Never project a legacy terminal status for a canonical run whose
      // durable terminal append failed. Startup recovery can project an append
      // that committed before a failpoint; otherwise the run stays honestly
      // non-terminal instead of exposing a result that cannot be fetched.
      return;
    }
    active.terminationNotified = true;
    if (this.#onActiveAgentTerminated === undefined) return;
    const terminalSnapshot: AgenCBackgroundAgentSnapshot = {
      status: active.status,
      lastActiveAt: active.lastActiveAt,
      ...(active.terminal !== undefined ? { terminal: active.terminal } : {}),
    };
    try {
      await this.#onActiveAgentTerminated(agentId, terminalSnapshot);
    } catch {
      // Lifecycle owns projection error reporting; cleanup must still revoke
      // runtime resources and execution authority.
    }
  }

  async #recordProgressEvent(
    agentId: string,
    progress: RunAgentProgressEvent,
  ): Promise<void> {
    this.#trackActiveToolCall(agentId, progress);
    const active = this.#active.get(agentId);
    const event = this.#eventFromProgress(agentId, progress);
    const events = [
      ...this.#takeInterruptedToolCompletionEvents(agentId, progress),
      ...(event !== null ? [event] : []),
    ];
    if (events.length === 0) return;
    if (active === undefined) {
      const pending = this.#pendingEvents.get(agentId) ?? [];
      pending.push(...events);
      this.#pendingEvents.set(
        agentId,
        boundBufferedAgentEvents(pending, agentId),
      );
      return;
    }
    this.#applyProgressStatus(active, progress);
    for (const nextEvent of events) {
      await this.#emitOrBufferEvent(active, nextEvent);
    }
  }

  async #recordPhaseProgressEvent(
    agentId: string,
    progress: RunAgentProgressEvent,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined || !active.canonicalEventBridgeInstalled) {
      await this.#recordProgressEvent(agentId, progress);
      return;
    }
    this.#trackActiveToolCall(agentId, progress);
    if (progress.kind === "message" && progress.message.role === "assistant") {
      this.#assistantTextByAgent.set(
        agentId,
        messageText(progress.message.content),
      );
    }
    if (
      progress.kind === "run_interrupted" ||
      progress.kind === "turn_interrupted"
    ) {
      active.activeToolCallIds.clear();
    }
    this.#applyProgressStatus(active, progress);
  }

  async #recordRecoveredProgressEvent(
    agentId: string,
    session: LocalRuntimeBootstrap["session"],
    progress: RunAgentProgressEvent,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active?.canonicalEventBridgeInstalled !== true) {
      await this.#recordProgressEvent(agentId, progress);
      return;
    }
    const event = canonicalSessionEventFromRecoveredProgress(progress);
    if (event !== null) {
      session.emit(event);
      return;
    }
    await this.#recordPhaseProgressEvent(agentId, progress);
  }

  #applyProgressStatus(
    active: ActiveBackgroundAgent,
    progress: RunAgentProgressEvent,
  ): void {
    let status: DaemonAgentStatus | null = null;
    switch (progress.kind) {
      case "run_error":
        status = "error";
        // The reason the run ended. Without this line the cause reached
        // neither the rollout nor any log: agents flipped to status=error
        // with nothing recorded anywhere to say why.
        process.stderr.write(
          `[agenc-daemon] agent ${active.thread.threadId} run error: ${String(
            (progress as { error?: unknown }).error ?? "unknown",
          ).slice(0, 800)}\n`,
        );
        break;
      case "run_interrupted":
        status = "stopped";
        break;
      case "turn_interrupted":
        status = "idle";
        break;
      case "run_complete":
      case "turn_complete":
        status = "idle";
        break;
      default:
        return;
    }
    active.status = status;
    active.lastActiveAt = this.#now();
  }

  #trackActiveToolCall(agentId: string, progress: RunAgentProgressEvent): void {
    if (progress.kind !== "tool_call" && progress.kind !== "tool_result") {
      return;
    }
    const active = this.#active.get(agentId);
    const activeToolCallIds =
      active?.activeToolCallIds ??
      this.#pendingActiveToolCallIds.get(agentId) ??
      new Set<string>();
    if (progress.kind === "tool_call") {
      activeToolCallIds.add(progress.callId);
    } else {
      activeToolCallIds.delete(progress.callId);
    }
    if (active === undefined) {
      if (activeToolCallIds.size === 0) {
        this.#pendingActiveToolCallIds.delete(agentId);
      } else {
        this.#pendingActiveToolCallIds.set(agentId, activeToolCallIds);
      }
    }
  }

  #takeInterruptedToolCompletionEvents(
    agentId: string,
    progress: RunAgentProgressEvent,
  ): BackgroundAgentDaemonEvent[] {
    if (
      progress.kind !== "turn_interrupted" &&
      progress.kind !== "run_interrupted"
    ) {
      return [];
    }
    const active = this.#active.get(agentId);
    const activeToolCallIds =
      active?.activeToolCallIds ?? this.#pendingActiveToolCallIds.get(agentId);
    if (activeToolCallIds === undefined || activeToolCallIds.size === 0) {
      return [];
    }
    const events = [...activeToolCallIds].map((callId) => ({
      id: `tool-interrupted-${agentId}-${callId}-${hashStable(progress.reason)}`,
      type: "tool_call_completed",
      payload: {
        callId,
        result: interruptedToolResultContent(callId, progress.reason),
        isError: true,
        metadata: {
          cause: "user_interrupted",
        },
      },
    }));
    activeToolCallIds.clear();
    if (active === undefined) {
      this.#pendingActiveToolCallIds.delete(agentId);
    }
    return events;
  }

  #eventFromProgress(
    agentId: string,
    progress: RunAgentProgressEvent,
  ): BackgroundAgentDaemonEvent | null {
    if (progress.kind === "message" && progress.message.role === "assistant") {
      // Initial-replay assistant messages must not surface as deltas
      // either — replaying a prior fork's assistant turn into the
      // parent transcript would leak content the user never asked
      // for. See run-agent.ts:isInitialReplay.
      if (progress.isInitialReplay === true) return null;
      const text = messageText(progress.message.content);
      const previous = this.#assistantTextByAgent.get(agentId) ?? "";
      const delta = text.startsWith(previous)
        ? text.slice(previous.length)
        : text;
      this.#assistantTextByAgent.set(agentId, text);
      if (delta.length === 0) return null;
      return {
        id: `delta-${agentId}-${hashStable(`${previous.length}:${delta}`)}`,
        type: "agent_message_delta",
        payload: { delta },
      };
    }
    return eventFromProgress(agentId, progress);
  }

  async #emitOrBufferEvent(
    active: ActiveBackgroundAgent,
    event: BackgroundAgentDaemonEvent | null,
  ): Promise<void> {
    if (event === null) return;
    // Serialize emission per agent on the agent's dispatch chain. Several
    // call sites are fire-and-forget (`void this.#emitOrBufferEvent(...)`)
    // and `#emitDaemonEvent` awaits an async-locked broadcast, so two
    // emits from one callback could otherwise complete out of order.
    // Chaining keeps per-agent delivery in arrival order while preserving
    // cross-agent concurrency (each agent owns its own chain). A rejection
    // is isolated to the awaiting caller and never poisons the chain for
    // later events. Mirrors AgenCStdioTransport.#dispatchChain.
    let emitError: unknown;
    let raised = false;
    const tail = active.dispatchChain.then(() =>
      this.#emitDaemonEvent(active, event).catch((error: unknown) => {
        emitError = error;
        raised = true;
      }),
    );
    active.dispatchChain = tail;
    await tail;
    if (raised) throw emitError;
  }

  async #drainDispatchChain(active: ActiveBackgroundAgent): Promise<void> {
    for (;;) {
      const tail = active.dispatchChain;
      await tail;
      if (active.dispatchChain === tail) return;
    }
  }

  async #emitPersistedUserMessage(
    active: ActiveBackgroundAgent,
    event: BackgroundAgentDaemonEvent,
  ): Promise<void> {
    const sessionEvent = sessionUserMessageEventFromDaemonEvent(event);
    if (sessionEvent === null) {
      await this.#emitOrBufferEvent(active, event);
      return;
    }

    const previousDispatch = active.dispatchChain;
    const session = active.bootstrap.session as {
      emit?: (event: Event) => void;
    };
    if (typeof session.emit !== "function") {
      await this.#emitOrBufferEvent(active, event);
      return;
    }
    session.emit(sessionEvent);
    if (active.dispatchChain === previousDispatch) {
      await this.#emitOrBufferEvent(active, event);
      return;
    }
    await active.dispatchChain;
  }

  async #emitDaemonEvent(
    active: ActiveBackgroundAgent,
    event: BackgroundAgentDaemonEvent,
  ): Promise<void> {
    const binding = active.sessionBinding;
    if (binding === undefined) {
      active.bufferedEvents.push(event);
      boundBufferedAgentEvents(active.bufferedEvents, active.thread.threadId);
      return;
    }
    await binding.emit(
      notificationFromDaemonEvent(
        binding.sessionId,
        active.thread.threadId,
        event,
      ),
    );
  }
}

async function unavailableRealtimeTransport(): Promise<RealtimeTransportConnection> {
  throw new Error("realtime transport connector is unavailable");
}

function eventFromProgress(
  agentId: string,
  progress: RunAgentProgressEvent,
): BackgroundAgentDaemonEvent | null {
  const correlation = {
    ...(progress.turnId !== undefined ? { turnId: progress.turnId } : {}),
    ...(progress.taskId !== undefined ? { taskId: progress.taskId } : {}),
  };
  switch (progress.kind) {
    case "status":
      return {
        id: `status-${agentId}-${hashStable(progress.text)}`,
        type: "warning",
        payload: {
          cause: "background_agent_status",
          message: progress.text,
          ...correlation,
        },
      };
    case "message": {
      // Suppress initial-replay messages. run-agent yields the
      // agent's initialMessages at start so observability recorders
      // can capture replay state — but the parent TUI's transcript
      // must NOT render those as user_message rows or the subagent's
      // initial prompt appears as if the user typed it.
      if (progress.isInitialReplay === true) return null;
      const text = messageText(progress.message.content);
      if (progress.message.role === "user") {
        return {
          id: `user-${agentId}-${hashStable(text)}`,
          type: "user_message",
          payload: {
            message: progress.message.content,
            displayText: text,
            ...correlation,
          },
        };
      }
      return {
        id: `agent-${agentId}-${hashStable(text)}`,
        type: "agent_message",
        payload: {
          message: text,
          ...correlation,
        },
      };
    }
    case "tool_call":
      return {
        id: progress.callId,
        type: "tool_call_started",
        payload: {
          callId: progress.callId,
          toolName: progress.toolName,
          args: progress.arguments ?? "{}",
          ...correlation,
          ...(isToolRecoveryCategory(progress.recoveryCategory)
            ? { recoveryCategory: progress.recoveryCategory }
            : {}),
        },
      };
    case "tool_result":
      return {
        id: `tool-result-${progress.callId}`,
        type: "tool_call_completed",
        payload: {
          callId: progress.callId,
          result: progress.result,
          isError: progress.isError,
          metadata: {
            toolName: progress.toolName,
            ...correlation,
          },
        },
      };
    case "usage_update":
      return null;
    case "run_error":
      return {
        id: `error-${agentId}-${hashStable(progress.error)}`,
        type: "agent_status",
        payload: {
          status: "error",
          runStatus: "errored",
          message: progress.error,
          ...correlation,
        },
      };
    case "run_interrupted":
      return {
        id: `interrupted-${agentId}-${hashStable(progress.reason)}`,
        type: "agent_status",
        payload: {
          status: "stopped",
          runStatus: "stopped",
          message: progress.reason,
          ...correlation,
        },
      };
    case "turn_interrupted":
      return {
        id: `turn-interrupted-${agentId}-${progress.turnId}`,
        type: "agent_status",
        payload: {
          status: "idle",
          runStatus: "completed",
          turnId: progress.turnId,
          ...(progress.taskId !== undefined ? { taskId: progress.taskId } : {}),
          message: progress.reason,
        },
      };
    case "run_complete":
      return {
        id: `complete-${agentId}-${hashStable(
          `${progress.toolCallCount}:${progress.finalMessage ?? ""}`,
        )}`,
        type: "agent_status",
        payload: {
          status: "idle",
          runStatus: "completed",
          ...(progress.finalMessage !== undefined
            ? { message: progress.finalMessage }
            : {}),
          ...correlation,
        },
      };
    case "turn_complete":
      return {
        id: `turn-complete-${agentId}-${progress.turnId}`,
        type: "turn_complete",
        payload: {
          turnId: progress.turnId,
          ...(progress.taskId !== undefined ? { taskId: progress.taskId } : {}),
          toolCallCount: progress.toolCallCount,
          ...(progress.worktree !== undefined
            ? { worktree: progress.worktree }
            : {}),
          ...(progress.worktreeEvidence !== undefined
            ? {
                worktreeEvidence:
                  progress.worktreeEvidence as unknown as JsonObject,
              }
            : {}),
          ...(progress.finalMessage !== undefined
            ? { lastAgentMessage: progress.finalMessage }
            : {}),
        },
      };
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function prepareDaemonUserPrompt(params: {
  readonly session: Session;
  readonly configStore: LocalRuntimeBootstrap["configStore"];
  readonly input: string | readonly LLMContentPart[];
  readonly hookPrompt?: string;
}) {
  return runWithCurrentRuntimeSession(params.session, () =>
    prepareUserPromptForTurn({
      session: params.session,
      configStore: params.configStore,
      input: params.input,
      ...(params.hookPrompt !== undefined
        ? { hookPrompt: params.hookPrompt }
        : {}),
    }),
  );
}

// Install the daemon turn driver. Prompt ingress normally runs before durable
// message publication, while this driver retains the same authority for direct
// Session.submit callers that do not cross the daemon message boundary.
function installDaemonTurnDriverHooks(
  session: LocalRuntimeBootstrap["session"],
  configStore: LocalRuntimeBootstrap["configStore"],
  runTurnFn: typeof runTurn = runTurn,
): void {
  const installer = (
    session as unknown as {
      installTurnDriverHooks?: (hooks: {
        readonly submit: (
          message: string | readonly LLMContentPart[],
          opts?: DaemonSessionSubmitOptions,
        ) => Promise<void>;
        readonly flushEventLog?: () => Promise<void> | void;
      }) => void;
    }
  ).installTurnDriverHooks;
  if (typeof installer !== "function") return;
  installer.call(session, {
    submit: async (message, opts) => {
      let turnInput = message;
      let promptDisplayText =
        typeof message === "string" ? message : userPromptDisplayText(message);
      if (
        opts?.editorInteraction === undefined &&
        opts?.[DAEMON_USER_PROMPT_PREPARED] !== true
      ) {
        const prepared = await prepareDaemonUserPrompt({
          session,
          configStore,
          input: message,
        });
        if (prepared.blocked) {
          throw new AgenCBackgroundAgentMessageError(
            "PROMPT_BLOCKED",
            prepared.blockMessage ?? "UserPromptSubmit hook blocked the prompt",
          );
        }
        turnInput = prepared.input;
        promptDisplayText = prepared.displayInput ?? promptDisplayText;
      }
      const baseCtx = (
        session as unknown as { newDefaultTurn: () => unknown }
      ).newDefaultTurn();
      const ctx =
        opts?.editorInteraction === undefined
          ? baseCtx
          : {
              ...(baseCtx as TurnContext),
              editorInteraction: opts.editorInteraction,
            };
      const rootHumanTurnText =
        opts?.source !== "autonomous_tick" && opts?.displayUserMessage !== null
          ? (opts?.displayUserMessage ?? promptDisplayText)
          : undefined;
      // displayUserMessage: null suppresses the run-turn user_message
      // emit. On the daemon path, submitAgentMessage above already
      // emits the user_message event (with the displayUserMessage
      // metadata threaded through from the TUI). Without this guard
      // both emits fire with different ids, so the transcript-reducer
      // (which dedups by id) renders the user message twice.
      for await (const event of runTurnFn(
        session as never,
        ctx as never,
        turnInput,
        {
          // This runner owns a root ManagedThread fed by daemon/phone human input. Bootstrap may
          // carry an agent-scoped querySource, which would make runTurn treat the same human prompt
          // as synthetic and omit ActiveTurn.rootHumanTurn. Pin the root daemon driver to the SDK
          // main-thread source; subagents use their own sessions and autonomous ticks are still
          // excluded by rootHumanTurnText below.
          querySource: "sdk",
          displayUserMessage: null,
          ...(rootHumanTurnText !== undefined ? { rootHumanTurnText } : {}),
          ...(opts?.editorInteraction !== undefined
            ? {
                systemPrompt: editorInteractionSystemPrompt(
                  opts.editorInteraction,
                ),
                systemPromptTrust: "trusted_internal" as const,
              }
            : {}),
        },
      )) {
        (
          session as unknown as { emitPhaseEvent: (e: unknown) => void }
        ).emitPhaseEvent(event);
      }
    },
    flushEventLog: async () => {
      /* daemon path has no extra event log to flush. */
    },
  });
}

export const __installDaemonTurnDriverHooksForTest =
  installDaemonTurnDriverHooks;

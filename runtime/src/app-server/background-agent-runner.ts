/**
 * Starts daemon-owned background agents through the existing delegate runtime.
 *
 * F-06a keeps the daemon surface narrow: `agent.create` requests become
 * `delegate(..., runInBackground: true)` launches, and the daemon holds the
 * bootstrap/session handles so the child loop remains alive after the JSON-RPC
 * response is returned.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";

import { roughTokenCountEstimation } from "../llm/token-estimation.js";
import {
  bootstrapLocalRuntimeSession,
  type BootstrapLocalRuntimeSessionOptions,
  type LocalRuntimeBootstrap,
  type PreparedConfiguredExecutionAuthority,
} from "../bin/bootstrap.js";
import { buildStructuredSessionBootstrapArgv } from "./session-bootstrap-argv.js";
import { ensureAgentControl } from "../bin/delegate-tool.js";
import { clearSession } from "../commands/clear.js";
import type { AgentControl } from "../agents/control.js";
import { MailboxClosedError } from "../agents/mailbox.js";
import { runTurn } from "../session/run-turn.js";
import {
  prepareUserPromptForTurn,
  userPromptDisplayText,
} from "../hooks/user-prompt-ingress.js";
import {
  ROOT_AGENT_PATH,
  joinAgentPath,
  normalizeAgentMetadata,
  normalizeAgentNameForPath,
  type AgentMetadata,
  type AgentPath,
} from "../agents/registry.js";
import type { AgentThread } from "../agents/thread.js";
import type { ManagedThread } from "../agents/thread-manager.js";
import { ConversationThreadManager } from "../conversation/thread-manager.js";
import {
  runAgent,
  type RunAgentProgressEvent,
  type RunAgentResult,
} from "../agents/run-agent.js";
import type { AuthBackend } from "../auth/backend.js";
import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import { routerFromRegistry } from "../tools/router.js";
import { buildLiveToolDispatchOptions } from "../phases/execute-tools.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolResultContent,
} from "../tools/untrusted-tool-result-framing.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import { getPlan, getPlanFilePath } from "../utils/plans.js";
import { stableStringify } from "../utils/stableStringify.js";
import { logForDebugging } from "../utils/debug.js";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../tools/ExitPlanModeTool/constants.js";
import type { AgentId } from "../types/ids.js";
import {
  computeUsdCost,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../session/cost.js";
import {
  runWithBootstrapSessionScope,
  runWithCurrentRuntimeSession,
} from "../session/current-session.js";
import { runWithCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { resolveDefaultShell } from "../utils/shell/resolveDefaultShell.js";
import { escapeXml } from "../utils/xml.js";
import {
  canCycleToAuto,
  createDisabledAutoModeContext,
  transitionPermissionMode,
  type PermissionContextPublication,
  type PermissionModeRegistry,
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
import type { ProviderModelSelectionOutcome } from "../contracts/provider-model-selection.js";
import {
  readSessionSelection,
  resolveProviderModelSelection,
} from "../session/provider-model-selection.js";
import { applyProviderSwitch } from "../commands/provider.js";
import { resolveProfile } from "../config/profiles.js";
import { mergeProviderModelLayer } from "../config/provider-model-authority.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  COORDINATED_CONFIG_STORE_PUBLICATION,
  type PreparedConfigStoreReload,
} from "../config/store.js";
import type { McpRefreshResult } from "../session/mcp-startup.js";
import { resolveLiveEffectPoison } from "../budget/effect-settlement-supervisor.js";
import {
  resolveLiveDurableEffectReview,
  type ResolveDurableEffectReviewOptions,
  type ResolveDurableEffectReviewResult,
} from "../state/effect-review.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import { mergeDaemonClientEnvironment } from "./client-env-snapshot.js";

import { permissionGrantsFromToolPermissionContext } from "../permissions/permission-grants.js";
import { applyUnattendedPermissionPolicyToContext } from "../permissions/unattended-policy.js";
import {
  ABORT,
  DENIED,
  TIMED_OUT,
  type ReviewDecision,
} from "../permissions/review-decision.js";
import type { AgentStatus as ThreadAgentStatus } from "../agents/status.js";
import type {
  McpServerMutationResult,
  McpSurfaceSnapshot,
  PreparedSessionProviderSwitch,
  Session,
} from "../session/session.js";
import type { Event } from "../session/event-log.js";
import type { RolloutItem } from "../session/rollout-item.js";
import { reconstructFromRollout } from "../session/rollout-reconstruction.js";
import type { TurnContext } from "../session/turn-context.js";
import type {
  SessionEditorInteraction,
  SessionSubmitOptions,
} from "../session/autonomous-mode.js";
import { editorInteractionSystemPrompt } from "../session/editor-interaction.js";
import type { CodePredictionSource } from "../services/code-prediction/types.js";
import {
  respondToSessionElicitation,
  type SessionElicitationResponseParams,
} from "../elicitation/respond.js";
import type {
  AgenCDaemonSessionNotification,
  AgentRunStatus,
  AgentStatus as DaemonAgentStatus,
  JsonObject,
  JsonValue,
  MessageContent,
  PermissionListResult,
  SessionMcpServerConfig,
  SessionPartialCompactFromMessageParams,
  SessionPartialCompactFromMessageResult,
  SessionRollbackCompactionResult,
  SessionExtendCompactionRollbackRetentionResult,
  SessionRewindConversationToMessageResult,
  SessionPreviewFileRewindResult,
  SessionRewindFilesToMessageResult,
  SessionSnapshotResult,
  SessionTranscriptResult,
  SessionTranscriptV2Result,
  SessionHookConfigShape,
  SessionHookValidationIssueShape,
  SessionHookRunDiagnosticShape,
  SessionPermissionRuleMutationParams,
  SessionPermissionRuleMutationResult,
  SessionShellExecuteParams,
  SessionShellExecuteResult,
} from "./protocol/index.js";
import type { AgenCRealtimeThreadBinding } from "./realtime.js";
import type { AgenCRealtimeCallClient } from "./realtime-transport.js";
import type {
  RealtimeTransportConnection,
  RealtimeTransportRequest,
} from "../conversation/realtime/conversation.js";
import type { RealtimeStartupContextSessionLike } from "../conversation/realtime/context.js";
import {
  JSON_RPC_VERSION,
  MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES,
} from "./protocol/index.js";
import {
  createAgenCDaemonRuntimeAuthBackend,
  type AgenCDaemonRuntimeAuthBackend,
} from "./provider-key-vending.js";
import { isRecord } from "../utils/record.js";
import type { ExecutionAdmissionKernel } from "../budget/execution-admission-kernel.js";
import type { CsvAgentJobsRepositoryProvider } from "./csv-agent-jobs-authority.js";
import {
  EVENT_GAP_EVENT,
  RUN_RUNTIME_MODEL_VERBOSITIES,
  RUN_RUNTIME_PERMISSION_MODES,
  RUN_RUNTIME_REASONING_EFFORTS,
  RUN_RUNTIME_SERVICE_TIERS,
  RUN_RUNTIME_SETTINGS_CHANGE_REASONS,
  type RunResumeReason,
  type RunRuntimeSettingsChangeReason,
  type RunRuntimeSettingsSnapshot,
  type RunTerminalResult,
} from "../contracts/run-contracts.js";
import { cloneFrozenRuntimeSettingsSnapshot } from "../state/runtime-settings-snapshot.js";
import type { ResumeRolloutDescriptorLease } from "../session/session-store.js";
import type { AgentRuntimeOptions } from "../session/runtime-options.js";
import { runWithAgentRuntimeOptions } from "../session/runtime-options.js";
import {
  applySessionExecutionAuthority,
  executionAuthorityForPermissionContext,
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
} from "../session/configuration.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { transitionSandboxExecutionBrokerAuthority } from "../sandbox/execution-lifecycle.js";

export interface AgenCBackgroundAgentStartParams {
  readonly objective: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly initialContent?: MessageContent;
  readonly deferInitialTurn?: boolean;
  readonly initialDisplayUserMessage?: string | null;
  readonly initialEditorInteraction?: SessionEditorInteraction;
  readonly metadata?: JsonObject;
  readonly unattendedAllow: readonly string[];
  readonly unattendedDeny: readonly string[];
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
  readonly runtimeOptions: AgentRuntimeOptions;
  /**
   * Per-invocation env overrides forwarded from the CLI. Merged on
   * top of `this.#env` so the user's latest `OPENAI_BASE_URL` /
   * proxy / API key for THIS agent invocation wins over the frozen
   * env snapshot captured when the daemon was launched.
   */
  readonly envOverrides?: { readonly [key: string]: string };
}

export interface AgenCBackgroundAgentStartResult {
  readonly agentId: string;
  readonly agentPath?: string;
  /** Internal pre-publication rollback token; never serialized to clients. */
  readonly restoreAttemptId?: string;
  readonly startedAt: string;
  readonly status: "running";
  readonly rolloutPath?: string;
  readonly rolloutDev?: string;
  readonly rolloutIno?: string;
}

export interface AgenCBackgroundAgentRestoreParams {
  readonly agentId: string;
  readonly objective: string;
  readonly cwd?: string;
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
  readonly runtimeOptions: AgentRuntimeOptions;
  /** Exact canonical rollout selected by the trusted CLI resolver. */
  readonly resumeRolloutPath?: string;
  /** One-shot daemon descriptor authority transferred into SessionStore. */
  readonly resumeRolloutLease?: ResumeRolloutDescriptorLease;
  /** Server-observed workspace identity, reproved inside bootstrap. */
  readonly resumeCwdIdentity?: { readonly dev: string; readonly ino: string };
  /** Daemon-held directory descriptor pinned across bootstrap acquisition. */
  readonly resumeCwdFd?: number;
  readonly envOverrides?: { readonly [key: string]: string };
  /** User-requested continuation of a cleanly terminal canonical run. */
  readonly reopenTerminalRun?: boolean;
  /** Resume a daemon-suspended canonical run without changing its epoch. */
  readonly resumeSuspendedRun?: boolean;
  /** Internal suspension disposition; never inferred from caller prose. */
  readonly suspendedResumeReason?: RunResumeReason;
  /** Canonical open run still awaiting its durable first-input activation. */
  readonly resumeStartupActivationPending?: boolean;
  /** Complete canonical overlay restored before this generation accepts ingress. */
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
  /** Exact-generation cleanup barrier for a user-selected disk continuation. */
  readonly explicitColdResume?: boolean;
  /** Opaque caller-owned generation token for pre-publication rollback only. */
  readonly restoreAttemptId?: string;
  readonly startedAt?: string;
  readonly currentSessionId?: string;
  readonly initialMessages?: ReadonlyArray<LLMMessage>;
  readonly replayToolCalls?: readonly AgenCBackgroundAgentReplayToolCall[];
  readonly onReplayToolResult?: (
    result: AgenCBackgroundAgentReplayToolResult,
  ) => void | Promise<void>;
  readonly metadata?: JsonObject;
}

export interface AgenCBackgroundAgentReplayToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
}

export interface AgenCBackgroundAgentReplayToolResult {
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly result: string;
  readonly isError: boolean;
  readonly terminalStatus?: "completed" | "failed" | "poisoned";
  readonly recoveryCategory?: ToolRecoveryCategory;
}

export interface AgenCBackgroundAgentSnapshot {
  readonly status: DaemonAgentStatus;
  readonly lastActiveAt: string;
  readonly metadata?: JsonObject;
  /** Live daemon-owned session authority, captured after its durable commit. */
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
  /** Canonical cursor for strict successor reconciliation on attached clients. */
  readonly runtimeSettingsEventId?: string;
  /** Present only after the canonical run_terminal event was fsync-committed. */
  readonly terminal?: AgenCBackgroundAgentTerminalSnapshot;
  /** Present only after the canonical run_suspended event was fsync-committed. */
  readonly suspension?: AgenCBackgroundAgentSuspensionSnapshot;
}

export interface AgenCBackgroundAgentTerminalSnapshot {
  readonly openedAt: string;
  readonly epoch: number;
  readonly eventId: string;
  readonly rolloutPath: string;
  readonly result: RunTerminalResult;
}

export interface AgenCBackgroundAgentSuspensionSnapshot {
  readonly openedAt: string;
  readonly epoch: number;
  readonly eventId: string;
  readonly sequence: number;
  readonly rolloutPath: string;
  readonly reason: "daemon_shutdown_idle";
  readonly suspendedAt: string;
}

export type AgenCBackgroundAgentDaemonShutdownResult =
  | {
      readonly disposition: "suspended";
      readonly suspension: AgenCBackgroundAgentSuspensionSnapshot;
    }
  | {
      readonly disposition: "cancelled";
      readonly terminal?: AgenCBackgroundAgentTerminalSnapshot;
    };

/**
 * The canonical suspension committed, but local daemon runtime teardown did
 * not complete cleanly. Callers must preserve the suspended projection while
 * still treating daemon cleanup as failed.
 */
export class AgenCBackgroundAgentSuspensionShutdownError extends Error {
  override readonly name = "AgenCBackgroundAgentSuspensionShutdownError";

  constructor(
    readonly suspension: AgenCBackgroundAgentSuspensionSnapshot,
    cause: unknown,
  ) {
    super(
      `run suspension ${suspension.eventId} committed but daemon runtime shutdown failed`,
      { cause },
    );
  }
}

export interface AgenCBackgroundAgentCancellationPreparation {
  readonly affectedRunIds: readonly string[];
  readonly voidedHolds: number;
  readonly heldUnknownHolds: number;
}

export interface AgenCBackgroundAgentTurnCancellationResult {
  readonly cancelled: boolean;
  readonly activeTurnId?: string;
  readonly stale?: boolean;
}

export interface AgenCBackgroundAgentSessionEventBinding {
  readonly sessionId: string;
  readonly emit: (event: JsonObject) => void | Promise<void>;
}

export interface AgenCBackgroundAgentMessageParams {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly originalContent: MessageContent;
  readonly displayUserMessage?: string | null;
  readonly editorInteraction?: SessionEditorInteraction;
  readonly messageId: string;
  readonly streamId: string;
  readonly acceptedAt: string;
  readonly ifBusy?: "reject";
}

export interface AgenCBackgroundAgentMessageResult {
  readonly disposition: "started" | "duplicate";
  readonly acceptedAt: string;
  readonly duplicateState?: "completed" | "incomplete";
  readonly turnId?: string;
  readonly terminal?: AgenCBackgroundAgentMessageTerminal;
}

export interface AgenCBackgroundAgentMessageTerminal extends JsonObject {
  readonly code: 0 | 1 | 130;
  readonly message?: string;
}

export type AgenCBackgroundAgentMessageErrorCode =
  "TURN_IN_PROGRESS" | "CLIENT_MESSAGE_ID_CONFLICT" | "PROMPT_BLOCKED";

export class AgenCBackgroundAgentMessageError extends Error {
  readonly code: AgenCBackgroundAgentMessageErrorCode;

  constructor(code: AgenCBackgroundAgentMessageErrorCode, message: string) {
    super(message);
    this.name = "AgenCBackgroundAgentMessageError";
    this.code = code;
  }
}

const DAEMON_USER_PROMPT_PREPARED: unique symbol = Symbol(
  "agenc.daemon-user-prompt-prepared",
);

type DaemonSessionSubmitOptions = SessionSubmitOptions & {
  readonly [DAEMON_USER_PROMPT_PREPARED]?: true;
};

export interface AgenCBackgroundAgentClearSessionParams {
  readonly sessionId: string;
  readonly clearedAt: string;
}

export interface AgenCBackgroundAgentSnapshotSessionParams {
  readonly sessionId: string;
}

export interface AgenCBackgroundAgentMcpAddServerParams {
  readonly sessionId: string;
  readonly config: SessionMcpServerConfig;
}

export interface AgenCBackgroundAgentMcpServerByNameParams {
  readonly sessionId: string;
  readonly serverName: string;
}

export interface AgenCBackgroundAgentPartialCompactParams {
  readonly sessionId: string;
  readonly messageOrdinal: number;
  readonly direction: SessionPartialCompactFromMessageParams["direction"];
  readonly feedback?: string;
  readonly signal?: AbortSignal;
}

export interface AgenCBackgroundAgentRollbackCompactionParams {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly reviewedBranchTargetSessionId?: string;
}

export interface AgenCBackgroundAgentExtendCompactionRetentionParams {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly extendedUntilMs: number;
}

export interface AgenCBackgroundAgentConversationRewindParams {
  readonly sessionId: string;
  readonly messageOrdinal: number;
  /** When aborted (request.cancel), refuse mid-flight rewind work (todo-108). */
  readonly signal?: AbortSignal;
}

export interface AgenCBackgroundAgentSetModelParams {
  readonly sessionId: string;
  readonly model?: string;
  readonly provider?: string;
}

export interface AgenCBackgroundAgentSetModelResult {
  readonly applied: boolean;
  readonly provider: string;
  readonly model: string;
  readonly runtimeSettingsEventId: string;
  readonly summary: string;
}

export interface AgenCBackgroundAgentSetPermissionModeParams {
  readonly sessionId: string;
  readonly mode: string;
  /** Bound only by an explicit allow-all decision in the tool approval flow. */
  readonly bypassAuthority?: "operator_tool_approval";
}

export interface AgenCBackgroundAgentSetPermissionModeResult {
  readonly applied: boolean;
  readonly previousMode: string;
  readonly mode: string;
  /** Internal transaction hook; never serialized by session.setPermissionMode. */
  readonly rollback?: () => Promise<void>;
}

export interface AgenCBackgroundAgentPermissionRuleMutationResult {
  readonly applied: boolean;
  readonly operation: SessionPermissionRuleMutationParams["operation"];
  readonly behavior: SessionPermissionRuleMutationParams["behavior"];
  readonly rule: string;
  readonly sessionRules: SessionPermissionRuleMutationResult["sessionRules"];
}

export interface AgenCBackgroundAgentHooksStatusResult {
  readonly available: boolean;
  readonly sourcePath: string;
  readonly disabled: boolean;
  readonly hardSuppressed: boolean;
  readonly effectiveDisabled: boolean;
  readonly suppressionReason: "bare_mode" | "session_disabled" | null;
  readonly issues: readonly SessionHookValidationIssueShape[];
  readonly hooks: readonly SessionHookConfigShape[];
  readonly diagnostics: readonly SessionHookRunDiagnosticShape[];
}

export interface AgenCBackgroundAgentSetHooksDisabledParams {
  readonly disabled: boolean;
}

export interface AgenCBackgroundAgentSetHooksDisabledResult {
  readonly applied: boolean;
  readonly disabled: boolean;
  readonly hardSuppressed: boolean;
  readonly effectiveDisabled: boolean;
  readonly suppressionReason: "bare_mode" | "session_disabled" | null;
}

function configuredHookExecutionState(runtime: {
  isDisabled(): boolean;
  isHardSuppressed(): boolean;
  isExecutionSuppressed(): boolean;
}): Omit<AgenCBackgroundAgentSetHooksDisabledResult, "applied"> {
  const disabled = runtime.isDisabled();
  const hardSuppressed = runtime.isHardSuppressed();
  return {
    disabled,
    hardSuppressed,
    effectiveDisabled: runtime.isExecutionSuppressed(),
    suppressionReason: hardSuppressed
      ? "bare_mode"
      : disabled
        ? "session_disabled"
        : null,
  };
}

export interface AgenCBackgroundAgentApplyConfigParams {
  readonly sessionId: string;
  readonly profile?: string;
  readonly reload?: boolean;
}

export interface AgenCBackgroundAgentApplyConfigResult {
  readonly applied: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeSettingsEventId?: string;
  readonly summary: string;
}

export interface AgenCBackgroundAgentToolDecisionParams {
  readonly requestId: string;
  readonly decision: ReviewDecision;
}

export interface AgenCBackgroundAgentToolCancelParams {
  readonly requestId: string;
  readonly reason?: string;
}

export type AgenCBackgroundAgentElicitationResponseParams =
  SessionElicitationResponseParams;

export interface AgenCBackgroundAgentRunner {
  startAgent(
    params: AgenCBackgroundAgentStartParams,
  ): Promise<AgenCBackgroundAgentStartResult>;
  getAgentSnapshot?(
    agentId: string,
  ): Promise<AgenCBackgroundAgentSnapshot | null>;
  restoreAgent?(
    params: AgenCBackgroundAgentRestoreParams,
  ): Promise<boolean> | boolean;
  /**
   * Revoke an unpublished restored generation without poisoning its canonical
   * open epoch. The opaque attempt id prevents cleanup from touching a newer
   * generation installed under the same run id.
   */
  rollbackRestoredAgent?(
    agentId: string,
    restoreAttemptId: string,
  ): Promise<void>;
  /**
   * Gate ingress and fsync cancellation/admission evidence while the Session
   * journal listener is still live. `stopAgent` then owns quiescence and the
   * terminal-tail append; the lifecycle projects legacy state afterward.
   */
  prepareAgentCancellation?(
    agentId: string,
    reason: string,
  ): Promise<AgenCBackgroundAgentCancellationPreparation>;
  stopAgent?(agentId: string, reason?: string): Promise<void>;
  /** Daemon-only shutdown disposition; caller prose cannot select suspension. */
  suspendIdleAgentForDaemonShutdown?(
    agentId: string,
  ): Promise<AgenCBackgroundAgentDaemonShutdownResult>;
  attachAgentSessionEvents?(
    agentId: string,
    binding: AgenCBackgroundAgentSessionEventBinding,
  ): Promise<void> | void;
  submitAgentMessage?(
    agentId: string,
    params: AgenCBackgroundAgentMessageParams,
  ): Promise<AgenCBackgroundAgentMessageResult>;
  executeAgentShell?(
    agentId: string,
    params: SessionShellExecuteParams,
    signal?: AbortSignal,
  ): Promise<SessionShellExecuteResult>;
  /** Resolve the live route without exposing the primary provider to callers. */
  resolveCodePredictionSource?(
    agentId: string,
  ): Promise<CodePredictionSource> | CodePredictionSource;
  clearAgentSession?(
    agentId: string,
    params: AgenCBackgroundAgentClearSessionParams,
  ): Promise<void>;
  snapshotAgentSession?(
    agentId: string,
    params: AgenCBackgroundAgentSnapshotSessionParams,
  ): Promise<SessionSnapshotResult>;
  getAgentSessionTranscript?(
    agentId: string,
    params: { readonly sessionId: string },
  ): Promise<SessionTranscriptResult>;
  getAgentSessionTranscriptV2?(
    agentId: string,
    params: { readonly sessionId: string },
  ): Promise<SessionTranscriptV2Result>;
  resolveLiveEffectReview?(
    agentId: string,
    params: ResolveDurableEffectReviewOptions,
  ): Promise<ResolveDurableEffectReviewResult>;
  addMcpServer?(
    agentId: string,
    params: AgenCBackgroundAgentMcpAddServerParams,
  ): Promise<McpServerMutationResult>;
  reconnectMcpServer?(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult>;
  enableMcpServer?(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult>;
  disableMcpServer?(
    agentId: string,
    params: AgenCBackgroundAgentMcpServerByNameParams,
  ): Promise<McpServerMutationResult>;
  getMcpStatus?(agentId: string): Promise<McpSurfaceSnapshot>;
  partialCompactFromMessage?(
    agentId: string,
    params: AgenCBackgroundAgentPartialCompactParams,
  ): Promise<SessionPartialCompactFromMessageResult>;
  rollbackCompaction?(
    agentId: string,
    params: AgenCBackgroundAgentRollbackCompactionParams,
  ): Promise<SessionRollbackCompactionResult>;
  extendCompactionRollbackRetention?(
    agentId: string,
    params: AgenCBackgroundAgentExtendCompactionRetentionParams,
  ): Promise<SessionExtendCompactionRollbackRetentionResult>;
  rewindConversationToMessage?(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionRewindConversationToMessageResult>;
  previewFileRewind?(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionPreviewFileRewindResult>;
  rewindFilesToMessage?(
    agentId: string,
    params: AgenCBackgroundAgentConversationRewindParams,
  ): Promise<SessionRewindFilesToMessageResult>;
  setAgentModel?(
    agentId: string,
    params: AgenCBackgroundAgentSetModelParams,
  ): Promise<AgenCBackgroundAgentSetModelResult>;
  setAgentPermissionMode?(
    agentId: string,
    params: AgenCBackgroundAgentSetPermissionModeParams,
  ): Promise<AgenCBackgroundAgentSetPermissionModeResult>;
  mutateAgentPermissionRule?(
    agentId: string,
    params: SessionPermissionRuleMutationParams,
  ): Promise<AgenCBackgroundAgentPermissionRuleMutationResult>;
  getAgentHooksStatus?(
    agentId: string,
  ): Promise<AgenCBackgroundAgentHooksStatusResult>;
  setAgentHooksDisabled?(
    agentId: string,
    params: AgenCBackgroundAgentSetHooksDisabledParams,
  ): Promise<AgenCBackgroundAgentSetHooksDisabledResult>;
  applyAgentConfig?(
    agentId: string,
    params: AgenCBackgroundAgentApplyConfigParams,
  ): Promise<AgenCBackgroundAgentApplyConfigResult>;
  resolveToolDecision?(
    agentId: string,
    params: AgenCBackgroundAgentToolDecisionParams,
  ): Promise<boolean>;
  cancelTool?(
    agentId: string,
    params: AgenCBackgroundAgentToolCancelParams,
  ): Promise<boolean>;
  /**
   * Interrupt the agent's currently-running turn (if any). Resolves to
   * `true` when an active turn was found and the agent's
   * AbortController was fired; `false` when the agent was idle.
   * Implementation MUST cascade to descendants so subagent turns are
   * also stopped — see {@link AgentControl.interrupt}.
   */
  interruptAgentTurn?(agentId: string, reason: string): Promise<boolean>;
  interruptAgentTurnIfMatches?(
    agentId: string,
    reason: string,
    expectedTurnId: string,
  ): Promise<AgenCBackgroundAgentTurnCancellationResult>;
  /**
   * Register a callback invoked once per agent immediately before the
   * runner removes that agent from its `#active` registry on terminal
   * status. The callback receives the final per-agent snapshot so the
   * lifecycle layer can record the terminal-state transition before the
   * underlying snapshot becomes unobservable. Without this hook,
   * `getAgentSnapshot` returns null after cleanup and the lifecycle's
   * lazy poll never observes the transition — leaving stale `running`
   * entries in `agent.list`.
   */
  setOnActiveAgentTerminated?(
    callback: (
      agentId: string,
      snapshot: AgenCBackgroundAgentSnapshot,
    ) => void | Promise<void>,
  ): void;
  respondToElicitation?(
    agentId: string,
    params: AgenCBackgroundAgentElicitationResponseParams,
  ): Promise<boolean>;
  listPermissions?(agentId: string): Promise<PermissionListResult | null>;
  resolveRealtimeThread?(
    threadId: string,
  ):
    | AgenCRealtimeThreadBinding
    | null
    | Promise<AgenCRealtimeThreadBinding | null>;
}

export type AgenCRunAgentFunction = typeof runAgent;
export type AgenCBootstrapFunction = (
  options: BootstrapLocalRuntimeSessionOptions,
) => Promise<LocalRuntimeBootstrap>;
export type AgenCEnsureAgentControlFunction = typeof ensureAgentControl;
export type AgenCBackgroundRealtimeTransportConnector = (
  request: RealtimeTransportRequest,
) => Promise<RealtimeTransportConnection> | RealtimeTransportConnection;

interface ActiveBackgroundAgent {
  readonly bootstrap: LocalRuntimeBootstrap;
  readonly control: AgentControl;
  readonly thread: ManagedThread;
  status: DaemonAgentStatus;
  readonly startedAt: string;
  /** Opaque generation proof retained only until publication succeeds/fails. */
  readonly restoreAttemptId?: string;
  /** Current canonical lifecycle epoch, recovered from run_reopened events. */
  runEpoch: number;
  /** True once daemon delivery is sourced from the Session EventLog. */
  canonicalEventBridgeInstalled: boolean;
  /** Cached immediately after the fsync-committed run_terminal append. */
  terminal?: AgenCBackgroundAgentTerminalSnapshot;
  /** Cached immediately after the fsync-committed run_suspended append. */
  suspension?: AgenCBackgroundAgentSuspensionSnapshot;
  /** Set only by the daemon-only clean shutdown path. */
  pendingSuspension?: {
    readonly eventId: string;
    readonly reason: "daemon_shutdown_idle";
    readonly suspendedAt: string;
  };
  /** Closes every runner ingress route before idle state is observed. */
  ingressClosed?: boolean;
  /** Result selected before shutdown quiescence; committed at journal close. */
  pendingTerminal?: RunTerminalResult;
  /** Fsync-committed operator intent that precedes admission cancellation. */
  cancellationRequest?: {
    readonly eventId: string;
    readonly sequence: number;
    readonly reason: string;
    readonly requestedAt: string;
  };
  /** Resume event that must be durably activated before ordinary input. */
  pendingStartupActivationResumeEventId?: string;
  /** Captured once so append ambiguity retries preserve exact evidence. */
  pendingStartupActivationActivatedAt?: string;
  runtimeSettings?: RunRuntimeSettingsSnapshot;
  runtimeSettingsEventId?: string;
  runtimeSettingsMutationQueue: Promise<void>;
  /** Preserves a close-boundary append failure through fail-soft teardown. */
  terminalCommitError?: unknown;
  /** True when a real Session owns the before-close terminal finalizer. */
  durableTerminalFinalizerInstalled: boolean;
  unsubscribeDurableTerminalFinalizer?: () => void;
  terminationNotified?: boolean;
  lastActiveAt: string;
  unsubscribeStatus?: () => void;
  uninstallApprovalBridge?: () => void;
  uninstallRuntimeSettingsPreCommit?: () => void;
  unsubscribeElicitationEvents?: () => void;
  unsubscribePhaseEvents?: () => void;
  unsubscribeMcpSurfaceInvalidations?: () => void;
  sessionBinding?: AgenCBackgroundAgentSessionEventBinding;
  bufferedEvents: BackgroundAgentDaemonEvent[];
  activeToolCallIds: Set<string>;
  historyEpoch: string;
  messageSubmission?: ActiveMessageSubmission;
  messageSubmissionQueue: Promise<void>;
  /** Resolves only after this exact generation has relinquished #active. */
  cleanupComplete: Promise<void>;
  pendingMessageSubmissionCount: number;
  readonly messageSubmissionsById: Map<string, ActiveMessageSubmission>;
  pendingShellExecutionCount: number;
  readonly shellExecutionsById: Map<string, ActiveShellExecution>;
  /**
   * True when no initial turn was submitted at spawn (deferInitialTurn
   * spawns and restored agents). Their thread sits in pending_init until
   * the first accepted message initializes it, so pending_init must not
   * count as busy for `ifBusy: "reject"` — rejecting there deadlocks the
   * session: the message that would initialize the thread is the message
   * being refused.
   */
  /**
   * Per-agent emission serialization chain. `#emitOrBufferEvent` awaits
   * an async-locked broadcast, so two fire-and-forget emits from a
   * single callback (e.g. status + budget-usage) can otherwise complete
   * out of order. Each emission is chained on this promise so events for
   * ONE agent are delivered in arrival order; cross-agent concurrency is
   * preserved because every ActiveBackgroundAgent owns its own chain.
   * Mirrors AgenCStdioTransport's #dispatchChain (transport/stdio.ts).
   */
  dispatchChain: Promise<void>;
}

interface ActiveMessageSubmission {
  readonly clientMessageId: string;
  readonly contentFingerprint: string;
  readonly streamId: string;
  readonly acceptedAt: string;
  turnId?: string;
  assistantMessageOrdinal: number;
  activeAssistantMessageId?: string;
  terminal?: AgenCBackgroundAgentMessageTerminal;
  readonly promise: Promise<AgenCBackgroundAgentMessageResult>;
  settled: boolean;
}

interface ActiveShellExecution {
  readonly commandFingerprint: string;
  readonly promise: Promise<SessionShellExecuteResult>;
  settled: boolean;
}

interface BackgroundAgentDaemonEvent {
  /** Existing session/subscription correlation envelope. */
  readonly id: string;
  /** Canonical run-journal identity, distinct from the reusable envelope id. */
  readonly eventId?: string;
  /** Canonical rollout sequence when this event originated in Session.EventLog. */
  readonly sequence?: number;
  readonly type: string;
  readonly payload?: JsonObject;
  readonly messageId?: string;
  readonly streamId?: string;
  readonly acceptedAt?: string;
  readonly runId?: string;
  readonly historyEpoch?: string;
  readonly turnId?: string;
  readonly clientMessageId?: string;
  /** Keep operation-scoped events out of model/run status projection. */
  readonly statusProjection?: "session_only";
}

interface AgentTerminalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/**
 * Upper bound on daemon events buffered for a single agent while no
 * session binding is attached (and on the per-agent `#pendingEvents`
 * detach buffer). A detached or pre-attach agent that never gets an
 * `agent.attach` would otherwise accumulate events on the heap without
 * limit. When the cap is exceeded the oldest events are dropped (FIFO
 * eviction) so the newest events — the ones most useful when the TUI
 * finally attaches — are retained. Mirrors
 * MAX_RETAINED_NOTIFICATIONS (tasks/lifecycle.ts) and the
 * per-session caps in agent-cli.ts / client-multiplexer.ts.
 */
const MAX_BUFFERED_AGENT_EVENTS = 1_000;

const BACKGROUND_RUNNER_GAP_SOURCE = "background_runner_retention";

/**
 * Drops the oldest events in-place until `events` is within
 * {@link MAX_BUFFERED_AGENT_EVENTS}. Returns the same array so callers
 * can push then bound, matching `bufferSessionEvent` in
 * client-multiplexer.ts.
 */
function boundBufferedAgentEvents(
  events: BackgroundAgentDaemonEvent[],
  runId?: string,
): BackgroundAgentDaemonEvent[] {
  const previousMarkers = events.filter(isBackgroundRunnerGapEvent);
  const realEvents = events.filter(
    (event) => !isBackgroundRunnerGapEvent(event),
  );
  const retired =
    realEvents.length > MAX_BUFFERED_AGENT_EVENTS
      ? realEvents.splice(0, realEvents.length - MAX_BUFFERED_AGENT_EVENTS)
      : [];
  const previousRetiredCount = previousMarkers.reduce(
    (total, marker) => total + positiveInteger(marker.payload?.retiredCount),
    0,
  );
  const retiredCount = previousRetiredCount + retired.length;
  if (retiredCount === 0) {
    events.splice(0, events.length, ...realEvents);
    return events;
  }

  const priorAfterSequence = previousMarkers
    .map((marker) => nonNegativeSequence(marker.payload?.afterSequence))
    .find((value) => value !== undefined);
  const previousCoordinatesUnknown = previousMarkers.some(
    (marker) => marker.payload?.coordinatesAvailable === false,
  );
  const retiredSequences = retired.map((event) =>
    positiveSequence(event.sequence),
  );
  const firstRetiredSequence = retiredSequences[0];
  const allNewRetiredEventsSequenced = retiredSequences.every(
    (value) => value !== undefined,
  );
  const afterSequence =
    !previousCoordinatesUnknown && priorAfterSequence !== undefined
      ? priorAfterSequence
      : !previousCoordinatesUnknown &&
          retired.length > 0 &&
          allNewRetiredEventsSequenced &&
          firstRetiredSequence !== undefined
        ? firstRetiredSequence - 1
        : undefined;
  const firstAvailableSequence = positiveSequence(realEvents[0]?.sequence);
  const coordinatesAvailable =
    afterSequence !== undefined &&
    afterSequence >= 0 &&
    firstAvailableSequence !== undefined &&
    firstAvailableSequence > afterSequence;
  const resolvedRunId = runId ?? gapRunId(previousMarkers);
  const marker: BackgroundAgentDaemonEvent = {
    id: `runner-gap:${resolvedRunId ?? "unknown"}`,
    type: EVENT_GAP_EVENT,
    payload: {
      kind: EVENT_GAP_EVENT,
      reason: "retention",
      source: BACKGROUND_RUNNER_GAP_SOURCE,
      retiredCount,
      coordinatesAvailable,
      ...(resolvedRunId !== undefined ? { runId: resolvedRunId } : {}),
      ...(coordinatesAvailable
        ? { afterSequence, firstAvailableSequence }
        : {}),
    },
  };
  events.splice(0, events.length, marker, ...realEvents);
  return events;
}

function isBackgroundRunnerGapEvent(
  event: BackgroundAgentDaemonEvent,
): boolean {
  return (
    event.type === EVENT_GAP_EVENT &&
    event.payload?.source === BACKGROUND_RUNNER_GAP_SOURCE
  );
}

function positiveSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function gapRunId(
  markers: readonly BackgroundAgentDaemonEvent[],
): string | undefined {
  return markers
    .map((marker) => marker.payload?.runId)
    .find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
}

export interface AgenCDelegateBackgroundAgentRunnerOptions {
  readonly bootstrap?: AgenCBootstrapFunction;
  readonly ensureAgentControl?: AgenCEnsureAgentControlFunction;
  readonly authBackend?: AuthBackend;
  readonly executionAdmissionKernel?: ExecutionAdmissionKernel;
  readonly csvAgentJobsRepositories?: CsvAgentJobsRepositoryProvider;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: () => string;
  readonly realtimeCallClient?: AgenCRealtimeCallClient;
  readonly realtimeConnectTransport?: AgenCBackgroundRealtimeTransportConnector;
  readonly onActiveAgentTerminated?: (
    agentId: string,
    snapshot: AgenCBackgroundAgentSnapshot,
  ) => void | Promise<void>;
}

export type AgenCDelegateBackgroundAgentRunnerRuntimeConfig = Pick<
  AgenCDelegateBackgroundAgentRunnerOptions,
  "realtimeCallClient" | "realtimeConnectTransport"
> & {
  readonly authBackend: AuthBackend | undefined;
};

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
          const configuredExecutionAuthority =
            active.bootstrap.prepareConfiguredExecutionAuthority(
              preparedConfigReload.config,
            );
          return {
            next: applyPermissionRulesSnapshot(current, permissionSnapshot),
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
      const daemonEvent = scopeDirectShellDaemonEvent(
        active,
        correlateDaemonEvent(active, uncorrelated),
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

function sessionUserMessageEventFromDaemonEvent(
  event: BackgroundAgentDaemonEvent,
): Event | null {
  if (
    event.type !== "user_message" ||
    event.payload === undefined ||
    event.payload.message === undefined
  ) {
    return null;
  }
  return {
    id: event.id,
    msg: {
      type: "user_message",
      payload: {
        message: event.payload.message as string | readonly LLMContentPart[],
        ...(typeof event.payload.displayText === "string"
          ? { displayText: event.payload.displayText }
          : {}),
        ...(Array.isArray(event.payload.images)
          ? { images: stringArray(event.payload.images) }
          : {}),
        ...(typeof event.payload.queuedCommandUuid === "string"
          ? { queuedCommandUuid: event.payload.queuedCommandUuid }
          : {}),
        ...(typeof event.messageId === "string"
          ? { messageId: event.messageId }
          : {}),
        ...(typeof event.streamId === "string"
          ? { streamId: event.streamId }
          : {}),
        ...(typeof event.acceptedAt === "string"
          ? { acceptedAt: event.acceptedAt }
          : {}),
      },
    },
  };
}

function terminalUsageForActiveAgent(
  active: ActiveBackgroundAgent,
): AgentTerminalUsage {
  const live = managedTokenUsage(active.thread);
  return {
    inputTokens: finiteNumber(live.inputTokens),
    outputTokens: finiteNumber(live.outputTokens),
    totalTokens: finiteNumber(live.totalTokens),
    costUsd: agentCostUsd(active),
  };
}

function agentCostUsd(active: ActiveBackgroundAgent): number {
  const tokenUsage = managedTokenUsage(active.thread);
  const model = activeAgentModel(active);
  const provider = activeAgentProvider(active);
  // LiveAgent currently exposes aggregate input/output token counters.
  // Preserve that limited basis in the terminal usage snapshot without
  // pretending cached/reasoning/search dimensions were observed.
  const usage: ModelUsage = {
    model,
    ...(provider !== undefined ? { provider } : {}),
    inputTokens: finiteNumber(tokenUsage.inputTokens),
    outputTokens: finiteNumber(tokenUsage.outputTokens),
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: finiteNumber(tokenUsage.totalTokens),
    turns: 0,
  };
  return computeUsdCost(usage, DEFAULT_MODEL_COSTS);
}

function activeAgentModel(active: ActiveBackgroundAgent): string {
  return (
    stringRecordField(active.thread.configSnapshot?.(), "model") ?? "agenc"
  );
}

function activeAgentProvider(
  active: ActiveBackgroundAgent,
): string | undefined {
  return (
    stringRecordField(active.thread.configSnapshot?.(), "provider") ??
    stringRecordField(active.thread.configSnapshot?.(), "model_provider")
  );
}

function stringRecordField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRunnableActiveAgent(active: ActiveBackgroundAgent): boolean {
  return (
    active.ingressClosed !== true &&
    active.pendingTerminal === undefined &&
    active.pendingSuspension === undefined
  );
}

function isInterruptibleActiveAgent(active: ActiveBackgroundAgent): boolean {
  return (
    active.ingressClosed !== true &&
    (active.pendingTerminal === undefined ||
      active.cancellationRequest !== undefined)
  );
}

interface ActiveTurnPeek {
  unsafePeek?: () => unknown;
}

function hasRuntimeActiveTurn(
  session: LocalRuntimeBootstrap["session"],
): boolean {
  const activeTurn = (session as unknown as { activeTurn?: ActiveTurnPeek })
    .activeTurn;
  return (
    typeof activeTurn?.unsafePeek === "function" &&
    activeTurn.unsafePeek() !== null
  );
}

function hasOpenAgentDescendants(
  control: AgentControl,
  rootThreadId: string,
): boolean {
  const childrenByParent = control.liveThreadSpawnChildren();
  const pending = [rootThreadId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const parent = pending.pop()!;
    if (visited.has(parent)) continue;
    visited.add(parent);
    const children = childrenByParent.get(parent) ?? [];
    if (children.length > 0) return true;
    for (const [childThreadId] of children) pending.push(childThreadId);
  }
  return false;
}

function runtimeActiveTurnId(
  session: LocalRuntimeBootstrap["session"],
): string | undefined {
  const activeTurn = (session as unknown as { activeTurn?: ActiveTurnPeek })
    .activeTurn;
  if (typeof activeTurn?.unsafePeek !== "function") return undefined;
  const value = activeTurn.unsafePeek();
  if (!isJsonObject(value) || typeof value.turnId !== "string") {
    return undefined;
  }
  return value.turnId;
}

function isClearInFlight(active: ActiveBackgroundAgent): boolean {
  return (
    active.pendingMessageSubmissionCount > 0 ||
    active.pendingShellExecutionCount > 0 ||
    active.messageSubmission !== undefined ||
    hasRuntimeActiveTurn(active.bootstrap.session) ||
    active.activeToolCallIds.size > 0
  );
}

function correlateDaemonEvent(
  active: ActiveBackgroundAgent,
  event: BackgroundAgentDaemonEvent,
): BackgroundAgentDaemonEvent {
  const runId = active.thread.threadId;
  if (event.type === "history_cleared" || event.type === "transcript_epoch") {
    active.historyEpoch = historyEpochForBoundary(
      runId,
      event.eventId ?? event.id,
    );
    return { ...event, runId, historyEpoch: active.historyEpoch };
  }

  const submission = active.messageSubmission;
  const isSubmissionUserMarker =
    submission !== undefined &&
    event.type === "user_message" &&
    (event.messageId === submission.clientMessageId ||
      event.payload?.messageId === submission.clientMessageId);
  if (
    submission !== undefined &&
    submission.turnId === undefined &&
    event.type !== "turn_started" &&
    !isSubmissionUserMarker
  ) {
    // The durable user marker is visible before the queued input owns a
    // runtime turn. Do not stamp tail events from the preceding turn with the
    // new submission's identity while waiting for its turn_started boundary.
    return {
      ...event,
      runId,
      historyEpoch: active.historyEpoch,
      ...(typeof event.payload?.turnId === "string"
        ? { turnId: event.payload.turnId }
        : {}),
    };
  }
  if (
    submission !== undefined &&
    event.type === "turn_started" &&
    typeof event.payload?.turnId === "string"
  ) {
    submission.turnId = event.payload.turnId;
  }

  const turnId =
    submission?.turnId ??
    (typeof event.payload?.turnId === "string"
      ? event.payload.turnId
      : undefined);
  let messageId = event.messageId;
  if (
    submission !== undefined &&
    (event.type === "agent_message_delta" || event.type === "agent_message")
  ) {
    if (submission.activeAssistantMessageId === undefined) {
      submission.activeAssistantMessageId = assistantMessageId(
        turnId ?? submission.clientMessageId,
        submission.assistantMessageOrdinal,
      );
    }
    messageId = submission.activeAssistantMessageId;
    if (event.type === "agent_message") {
      submission.activeAssistantMessageId = undefined;
      submission.assistantMessageOrdinal += 1;
    }
  } else if (
    submission === undefined &&
    event.type === "agent_message" &&
    messageId === undefined
  ) {
    messageId = `assistant:${event.eventId ?? event.id}`;
  }
  if (submission !== undefined) {
    const terminal = messageTerminalFromDaemonEvent(event, submission.turnId);
    if (terminal !== undefined) submission.terminal = terminal;
  }

  return {
    ...event,
    runId,
    historyEpoch: active.historyEpoch,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(submission !== undefined
      ? { clientMessageId: submission.clientMessageId }
      : {}),
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

function messageTerminalFromDaemonEvent(
  event: BackgroundAgentDaemonEvent,
  expectedTurnId: string | undefined,
): AgenCBackgroundAgentMessageTerminal | undefined {
  const eventTurnId =
    event.turnId ??
    (typeof event.payload?.turnId === "string"
      ? event.payload.turnId
      : undefined);
  if (
    expectedTurnId !== undefined &&
    eventTurnId !== undefined &&
    eventTurnId !== expectedTurnId
  ) {
    return undefined;
  }
  if (event.type === "turn_complete") {
    return {
      code: 0,
      ...(typeof event.payload?.lastAgentMessage === "string"
        ? { message: event.payload.lastAgentMessage }
        : {}),
    };
  }
  if (event.type === "turn_aborted") {
    return {
      code: 130,
      ...(typeof event.payload?.reason === "string"
        ? { message: event.payload.reason }
        : {}),
    };
  }
  if (event.type === "error") {
    return {
      code: 1,
      ...(typeof event.payload?.message === "string"
        ? { message: event.payload.message }
        : {}),
    };
  }
  return undefined;
}

function assistantMessageId(turnId: string, ordinal: number): string {
  return `assistant:${turnId}:${ordinal}`;
}

function historyEpochForBoundary(runId: string, boundaryId: string): string {
  return `history:${runId}:${boundaryId}`;
}

function historyEpochFromRollout(
  items: readonly RolloutItem[],
  runId: string,
): string {
  return historyEpochForBoundary(
    runId,
    latestTranscriptBoundary(items, runId)?.id ?? "initial",
  );
}

interface TranscriptBoundary {
  readonly index: number;
  readonly id: string;
  readonly kind: "cleared" | "replaced";
  readonly sequence?: number;
}

function latestTranscriptBoundary(
  items: readonly RolloutItem[],
  runId: string,
): TranscriptBoundary | undefined {
  let latest: TranscriptBoundary | undefined;
  for (const [index, item] of items.entries()) {
    if (
      item.type === "event_msg" &&
      (item.payload.msg.type === "history_cleared" ||
        item.payload.msg.type === "transcript_epoch")
    ) {
      latest = {
        index,
        id: canonicalEventId(item.payload),
        kind:
          item.payload.msg.type === "history_cleared" ? "cleared" : "replaced",
        ...(positiveSequence(item.payload.seq) !== undefined
          ? { sequence: positiveSequence(item.payload.seq) }
          : {}),
      };
      continue;
    }
    if (
      item.type === "compacted" &&
      item.payload.replacementHistory !== undefined
    ) {
      latest = {
        index,
        id: `compacted:${index}:${hashStable(JSON.stringify(item.payload.replacementHistory))}`,
        kind: "replaced",
      };
      continue;
    }
    if (item.type === "compaction_committed") {
      latest = {
        index,
        id: `compaction:${item.payload.attempt_id}`,
        kind: "replaced",
      };
      continue;
    }
    if (
      item.type === "compaction_rollback_committed" &&
      item.payload.target_session_id === runId
    ) {
      latest = {
        index,
        id: `compaction-rollback:${item.payload.attempt_id}`,
        kind: "replaced",
      };
    }
  }
  return latest;
}

function messageContentFingerprint(content: unknown): string {
  return createHash("sha256")
    .update(stableStringify(content) ?? "undefined", "utf8")
    .digest("hex");
}

const MAX_RETAINED_SHELL_EXECUTIONS = 256;
const SHELL_RESULT_TRUNCATION_MARKER = "\n[truncated]";

function shellSubmissionMessageId(commandId: string): string {
  return `shell:${commandId}`;
}

function shellEventKey(commandId: string): string {
  return createHash("sha256")
    .update(commandId, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function scopeDirectShellDaemonEvent(
  active: ActiveBackgroundAgent,
  event: BackgroundAgentDaemonEvent,
): BackgroundAgentDaemonEvent {
  const payload = event.payload;
  const correlationIds = [
    event.id,
    payload?.callId,
    payload?.queuedCommandUuid,
  ];
  if (
    !correlationIds.some(
      (candidate) =>
        typeof candidate === "string" &&
        active.shellExecutionsById.has(candidate),
    )
  ) {
    return event;
  }
  return { ...event, statusProjection: "session_only" };
}

function throwIfShellRequestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "Shell command cancelled",
  );
}

function pruneShellExecutionCache(
  cache: Map<string, ActiveShellExecution>,
): void {
  if (cache.size <= MAX_RETAINED_SHELL_EXECUTIONS) return;
  for (const [commandId, execution] of cache) {
    if (!execution.settled) continue;
    cache.delete(commandId);
    if (cache.size <= MAX_RETAINED_SHELL_EXECUTIONS) return;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundShellResultText(value: string): {
  readonly value: string;
  readonly truncated: boolean;
} {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES) {
    return { value, truncated: false };
  }
  const marker = Buffer.from(SHELL_RESULT_TRUNCATION_MARKER, "utf8");
  let end = Math.max(
    0,
    MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES - marker.byteLength,
  );
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: `${encoded.subarray(0, end).toString("utf8")}${SHELL_RESULT_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function normalizeSessionShellResult(
  commandId: string,
  dispatch: ToolDispatchResult,
): SessionShellExecuteResult {
  const metadata = recordValue(dispatch.metadata);
  const codeMode = recordValue(dispatch.codeModeResult);
  const metadataStdout =
    typeof metadata.stdout === "string" ? metadata.stdout : undefined;
  const codeModeOutput =
    typeof codeMode.output === "string" ? codeMode.output : undefined;
  const rawStdout =
    metadataStdout ??
    codeModeOutput ??
    (dispatch.isError === true ? "" : dispatch.content);
  const rawStderr =
    typeof metadata.stderr === "string"
      ? metadata.stderr
      : dispatch.isError === true && rawStdout.length === 0
        ? dispatch.content
        : "";
  const metadataExitCode = metadata.exitCode;
  const codeModeExitCode = codeMode.exit_code;
  const exitCode =
    typeof metadataExitCode === "number" &&
    Number.isSafeInteger(metadataExitCode)
      ? metadataExitCode
      : typeof codeModeExitCode === "number" &&
          Number.isSafeInteger(codeModeExitCode)
        ? codeModeExitCode
        : null;
  const timedOut = metadata.timedOut === true || codeMode.timed_out === true;
  const content = boundShellResultText(dispatch.content);
  const stdout = boundShellResultText(rawStdout);
  const stderr = boundShellResultText(rawStderr);
  const truncated =
    metadata.truncated === true ||
    content.truncated ||
    stdout.truncated ||
    stderr.truncated;
  return {
    commandId,
    content: content.value,
    stdout: stdout.value,
    stderr: stderr.value,
    exitCode,
    timedOut,
    truncated,
    isError:
      dispatch.isError === true ||
      timedOut ||
      (exitCode !== null && exitCode !== 0),
  };
}

interface PersistedMessageSubmission {
  readonly contentFingerprint: string;
  readonly acceptedAt?: string;
  readonly turnId?: string;
  readonly terminal?: AgenCBackgroundAgentMessageTerminal;
}

function findPersistedMessageSubmission(
  items: readonly RolloutItem[],
  clientMessageId: string,
): PersistedMessageSubmission | undefined {
  let match: PersistedMessageSubmission | undefined;
  for (const item of items) {
    if (item.type !== "event_msg") continue;
    const event = item.payload;
    if (
      match === undefined &&
      ((event.msg.type === "user_message" &&
        event.msg.payload.messageId === clientMessageId) ||
        (event.msg.type === "message_submission" &&
          event.msg.payload.messageId === clientMessageId))
    ) {
      const contentFingerprint =
        event.msg.type === "message_submission"
          ? event.msg.payload.contentFingerprint
          : messageContentFingerprint(event.msg.payload.message);
      const acceptedAt = event.msg.payload.acceptedAt;
      match = {
        contentFingerprint,
        ...(acceptedAt !== undefined ? { acceptedAt } : {}),
      };
      continue;
    }
    if (match === undefined) continue;
    // A user_message starts the next admitted submission. Never let a
    // crash-tail retry inherit that later submission's turn_started or
    // terminal outcome.
    if (
      event.msg.type === "user_message" ||
      event.msg.type === "message_submission"
    ) {
      return match;
    }
    if (event.msg.type === "turn_started" && match.turnId === undefined) {
      match = { ...match, turnId: event.msg.payload.turnId };
      continue;
    }
    if (match.turnId === undefined) continue;
    const terminal = messageTerminalFromEvent(event.msg, match.turnId);
    if (terminal !== undefined) {
      return { ...match, terminal };
    }
  }
  return match;
}

function messageTerminalFromEvent(
  event: Event["msg"],
  expectedTurnId: string | undefined,
): AgenCBackgroundAgentMessageTerminal | undefined {
  if (event.type === "turn_complete") {
    if (
      expectedTurnId !== undefined &&
      event.payload.turnId !== expectedTurnId
    ) {
      return undefined;
    }
    return {
      code: 0,
      ...(event.payload.lastAgentMessage !== undefined
        ? { message: event.payload.lastAgentMessage }
        : {}),
    };
  }
  if (event.type === "turn_aborted") {
    if (
      expectedTurnId !== undefined &&
      event.payload.turnId !== undefined &&
      event.payload.turnId !== expectedTurnId
    ) {
      return undefined;
    }
    return { code: 130, message: event.payload.reason };
  }
  if (event.type === "error") {
    if (
      expectedTurnId !== undefined &&
      event.payload.turnId !== undefined &&
      event.payload.turnId !== expectedTurnId
    ) {
      return undefined;
    }
    return { code: 1, message: event.payload.message };
  }
  return undefined;
}

function clientMessageIdConflict(
  clientMessageId: string,
): AgenCBackgroundAgentMessageError {
  return new AgenCBackgroundAgentMessageError(
    "CLIENT_MESSAGE_ID_CONFLICT",
    `clientMessageId ${clientMessageId} was already used for different content`,
  );
}

const MAX_MESSAGE_SUBMISSION_CACHE = 1_024;

function pruneMessageSubmissionCache(
  submissions: Map<string, ActiveMessageSubmission>,
): void {
  if (submissions.size <= MAX_MESSAGE_SUBMISSION_CACHE) return;
  for (const [clientMessageId, submission] of submissions) {
    if (!submission.settled) continue;
    submissions.delete(clientMessageId);
    if (submissions.size <= MAX_MESSAGE_SUBMISSION_CACHE) return;
  }
}

function canonicalEventId(event: Event): string {
  return (
    event.eventId ??
    (event.seq !== undefined
      ? `legacy-event:${event.seq}:${event.id}`
      : event.id)
  );
}

interface MutableTranscriptV2Message extends JsonObject {
  messageId: string;
  commitEventId: string;
  role: "user" | "assistant";
  text: string;
  turnId?: string;
  clientMessageId?: string;
  committedSequence: number;
}

export function sessionTranscriptV2FromRollout(
  items: readonly RolloutItem[],
  sessionId: string,
  runId: string,
  activeTurn?: { readonly turnId: string; readonly clientMessageId: string },
): SessionTranscriptV2Result {
  const boundary = latestTranscriptBoundary(items, runId);
  const boundaryIndex = boundary?.index ?? -1;
  const boundaryId = boundary?.id ?? "initial";
  let asOfSequence = 0;
  for (const item of items) {
    if (item.type !== "event_msg") continue;
    const event = item.payload;
    if (
      event.seq !== undefined &&
      Number.isSafeInteger(event.seq) &&
      event.seq > asOfSequence
    ) {
      asOfSequence = event.seq;
    }
  }

  const messages: MutableTranscriptV2Message[] = [];
  let currentTurnId: string | undefined;
  let currentClientMessageId: string | undefined;
  let pendingUserIndex: number | undefined;
  let pendingClientMessageId: string | undefined;
  const assistantOrdinals = new Map<string, number>();

  if (boundary?.kind === "replaced") {
    const replacement = reconstructFromRollout(
      items.slice(0, boundary.index + 1),
    ).history;
    const replacementSequence =
      boundary.sequence ?? maxEventSequence(items.slice(0, boundary.index + 1));
    let ordinal = 0;
    for (const item of replacement) {
      if (item.role !== "user" && item.role !== "assistant") continue;
      const text = responseItemDisplayText(item.content);
      if (text.length === 0) continue;
      const messageId = `replacement:${boundary.id}:${ordinal}`;
      messages.push({
        messageId,
        commitEventId: messageId,
        role: item.role,
        text,
        committedSequence: replacementSequence,
      });
      ordinal += 1;
    }
  }

  const transcriptStartIndex = boundaryIndex + 1;
  const firstCanonicalTranscriptIndex = items.findIndex(
    (item, index) =>
      index >= transcriptStartIndex &&
      item.type === "event_msg" &&
      (item.payload.msg.type === "user_message" ||
        item.payload.msg.type === "message_submission" ||
        item.payload.msg.type === "agent_message"),
  );
  const legacyEndIndex =
    firstCanonicalTranscriptIndex < 0
      ? items.length
      : firstCanonicalTranscriptIndex;
  let legacyOrdinal = 0;
  for (let index = transcriptStartIndex; index < legacyEndIndex; index += 1) {
    const item = items[index]!;
    if (item.type !== "response_item") continue;
    if (item.payload.role !== "user" && item.payload.role !== "assistant") {
      continue;
    }
    const text = responseItemDisplayText(item.payload.content);
    if (text.length === 0) continue;
    const messageId = `legacy:${boundaryId}:${legacyOrdinal}`;
    messages.push({
      messageId,
      commitEventId: messageId,
      role: item.payload.role,
      text,
      committedSequence: 0,
    });
    legacyOrdinal += 1;
  }

  // Scan canonical turn context from the epoch boundary, not merely from the
  // first visible transcript row. Hidden-user submissions deliberately have
  // no user_message, so their preceding turn_started is the only durable
  // source for the assistant message identity.
  for (let index = transcriptStartIndex; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.type !== "event_msg") continue;
    const event = item.payload;
    const sequence = positiveSequence(event.seq);
    if (sequence === undefined) continue;
    if (event.msg.type === "message_submission") {
      pendingUserIndex = undefined;
      pendingClientMessageId = event.msg.payload.messageId;
      continue;
    }
    if (event.msg.type === "user_message") {
      const text =
        event.msg.payload.displayText ??
        unknownMessageContentDisplayText(event.msg.payload.message);
      if (text.length === 0) continue;
      const commitEventId = canonicalEventId(event);
      const clientMessageId = event.msg.payload.messageId;
      messages.push({
        messageId: clientMessageId ?? `message:${commitEventId}`,
        commitEventId,
        role: "user",
        text,
        ...(clientMessageId !== undefined ? { clientMessageId } : {}),
        committedSequence: sequence,
      });
      pendingUserIndex = messages.length - 1;
      pendingClientMessageId = clientMessageId;
      continue;
    }
    if (event.msg.type === "turn_started") {
      currentTurnId = event.msg.payload.turnId;
      if (pendingUserIndex !== undefined) {
        messages[pendingUserIndex]!.turnId = currentTurnId;
        pendingUserIndex = undefined;
      }
      currentClientMessageId = pendingClientMessageId;
      pendingClientMessageId = undefined;
      continue;
    }
    if (event.msg.type === "agent_message") {
      const commitEventId = canonicalEventId(event);
      const correlationId = currentTurnId ?? commitEventId;
      const ordinal = assistantOrdinals.get(correlationId) ?? 0;
      assistantOrdinals.set(correlationId, ordinal + 1);
      const text = event.msg.payload.message;
      // Empty durable commits are not transcript rows, but they still occupy
      // an ordinal because the live identity allocator observes them.
      if (text.length === 0) continue;
      messages.push({
        messageId:
          currentTurnId === undefined
            ? `assistant:${commitEventId}`
            : assistantMessageId(currentTurnId, ordinal),
        commitEventId,
        role: "assistant",
        text,
        ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
        ...(currentClientMessageId !== undefined
          ? { clientMessageId: currentClientMessageId }
          : {}),
        committedSequence: sequence,
      });
      continue;
    }
    if (
      event.msg.type === "turn_complete" ||
      event.msg.type === "turn_aborted" ||
      event.msg.type === "error"
    ) {
      const terminalTurnId =
        "turnId" in event.msg.payload &&
        typeof event.msg.payload.turnId === "string"
          ? event.msg.payload.turnId
          : undefined;
      if (
        (currentTurnId === undefined && pendingUserIndex !== undefined) ||
        (currentTurnId !== undefined &&
          terminalTurnId !== undefined &&
          terminalTurnId !== currentTurnId)
      ) {
        continue;
      }
      currentTurnId = undefined;
      currentClientMessageId = undefined;
    }
  }

  return {
    schemaVersion: 2,
    sessionId,
    runId,
    historyEpoch: historyEpochForBoundary(runId, boundaryId),
    asOfSequence,
    messages,
    ...(activeTurn !== undefined ? { activeTurn } : {}),
  };
}

function maxEventSequence(items: readonly RolloutItem[]): number {
  let max = 0;
  for (const item of items) {
    if (item.type !== "event_msg") continue;
    const sequence = positiveSequence(item.payload.seq);
    if (sequence !== undefined) max = Math.max(max, sequence);
  }
  return max;
}

function responseItemDisplayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isJsonObject(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

function unknownMessageContentDisplayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isJsonObject(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (part.type === "image") return "[image]";
      if (part.type === "document") return "[document]";
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

async function unavailableRealtimeTransport(): Promise<RealtimeTransportConnection> {
  throw new Error("realtime transport connector is unavailable");
}

export function notificationFromDaemonEvent(
  sessionId: string,
  agentId: string,
  event: BackgroundAgentDaemonEvent,
): AgenCDaemonSessionNotification {
  const base = eventBaseParams(sessionId, agentId, event);
  const payload = event.payload;
  if (
    event.type === "mcp_status_changed" &&
    isJsonObject(payload) &&
    typeof payload.revision === "number" &&
    Number.isSafeInteger(payload.revision) &&
    payload.revision >= 0
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_status_changed",
      params: {
        sessionId,
        revision: payload.revision,
      },
    };
  }
  if (
    event.type === "agent_message_delta" &&
    isJsonObject(payload) &&
    typeof payload.delta === "string"
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.message_chunk",
      params: {
        ...base,
        ...(event.messageId !== undefined
          ? { messageId: event.messageId }
          : {}),
        ...(event.streamId !== undefined ? { streamId: event.streamId } : {}),
        delta: payload.delta,
      },
    };
  }
  if (
    event.type === "tool_call_started" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.toolName === "string"
  ) {
    const input = toolRequestInputFromPayload(payload);
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.tool_request",
      params: {
        ...base,
        requestId: payload.callId,
        toolName: payload.toolName,
        ...(input !== undefined ? { input } : {}),
        ...(isToolRecoveryCategory(payload.recoveryCategory)
          ? { recoveryCategory: payload.recoveryCategory }
          : {}),
      },
    };
  }
  if (
    event.type === "request_permissions" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string"
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.permission_request",
      params: {
        ...base,
        requestId: payload.callId,
        ...(typeof payload.toolName === "string"
          ? { toolName: payload.toolName }
          : {}),
        ...(typeof payload.turnId === "string"
          ? { turnId: payload.turnId }
          : {}),
        permissions: stringArray(payload.permissions),
        ...(payload.input !== undefined ? { input: payload.input } : {}),
        ...(typeof payload.reason === "string"
          ? { reason: payload.reason }
          : {}),
        ...(typeof payload.planContent === "string"
          ? { planContent: payload.planContent }
          : {}),
        ...(typeof payload.planFilePath === "string"
          ? { planFilePath: payload.planFilePath }
          : {}),
      },
    };
  }
  if (
    event.type === "request_user_input" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.turnId === "string" &&
    Array.isArray(payload.questions)
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.user_input_request",
      params: {
        ...base,
        requestId:
          typeof payload.requestId === "string"
            ? payload.requestId
            : payload.callId,
        callId: payload.callId,
        turnId: payload.turnId,
        questions: jsonObjectArray(payload.questions),
        ...(isJsonObject(payload.clientAction)
          ? { clientAction: payload.clientAction }
          : {}),
      },
    };
  }
  if (
    event.type === "mcp_elicitation_request" &&
    isJsonObject(payload) &&
    typeof payload.serverName === "string" &&
    (typeof payload.requestId === "string" ||
      typeof payload.requestId === "number") &&
    typeof payload.turnId === "string" &&
    isJsonObject(payload.request)
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_elicitation_request",
      params: {
        ...base,
        requestId: payload.requestId,
        serverName: payload.serverName,
        turnId: payload.turnId,
        request: payload.request,
      },
    };
  }
  if (
    event.type === "agent_status" &&
    isJsonObject(payload) &&
    typeof payload.status === "string"
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        ...base,
        agentId: base.agentId ?? sessionId,
        status:
          payload.status === "error" || payload.status === "stopped"
            ? payload.status
            : "idle",
        ...(agentRunStatusFromPayload(payload.runStatus) !== undefined
          ? { runStatus: agentRunStatusFromPayload(payload.runStatus) }
          : {}),
        ...(typeof payload.turnId === "string"
          ? { turnId: payload.turnId }
          : {}),
        ...(typeof payload.message === "string"
          ? { message: payload.message }
          : {}),
        ...(isJsonObject(payload.budgetHalt)
          ? { budgetHalt: payload.budgetHalt }
          : {}),
        ...(isJsonObject(payload.budgetUsage)
          ? { budgetUsage: payload.budgetUsage }
          : {}),
      },
    };
  }
  if (
    event.type === "run_terminal" &&
    isJsonObject(payload) &&
    typeof payload.status === "string"
  ) {
    const terminalStatus = daemonStatusFromRunTerminal(payload.status);
    const runStatus = agentRunStatusFromRunTerminal(payload.status);
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        ...base,
        agentId: base.agentId ?? sessionId,
        status: terminalStatus,
        runStatus,
        ...(typeof payload.finalMessage === "string"
          ? { message: payload.finalMessage }
          : typeof payload.stopReason === "string"
            ? { message: payload.stopReason }
            : {}),
      },
    };
  }
  if (
    event.type === EVENT_GAP_EVENT &&
    isJsonObject(payload) &&
    payload.source === BACKGROUND_RUNNER_GAP_SOURCE &&
    typeof payload.runId === "string" &&
    payload.runId.length > 0 &&
    positiveInteger(payload.retiredCount) > 0
  ) {
    const afterSequence = nonNegativeSequence(payload.afterSequence);
    const firstAvailableSequence = positiveSequence(
      payload.firstAvailableSequence,
    );
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.event_gap",
      params: {
        ...base,
        type: EVENT_GAP_EVENT,
        kind: EVENT_GAP_EVENT,
        runId: payload.runId,
        reason: "retention",
        source: BACKGROUND_RUNNER_GAP_SOURCE,
        retiredCount: positiveInteger(payload.retiredCount),
        ...(typeof payload.coordinatesAvailable === "boolean"
          ? { coordinatesAvailable: payload.coordinatesAvailable }
          : {}),
        ...(afterSequence !== undefined ? { afterSequence } : {}),
        ...(firstAvailableSequence !== undefined
          ? { firstAvailableSequence }
          : {}),
      },
    };
  }
  if (
    (event.type === "turn_started" ||
      event.type === "turn_complete" ||
      event.type === "turn_aborted" ||
      event.type === "error") &&
    event.statusProjection !== "session_only" &&
    isJsonObject(payload)
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        ...base,
        agentId: base.agentId ?? sessionId,
        status: agentStatusFromEventType(event.type),
        runStatus: agentRunStatusFromEventType(event.type),
        ...(typeof payload.turnId === "string"
          ? { turnId: payload.turnId }
          : {}),
        ...(typeof payload.message === "string"
          ? { message: payload.message }
          : typeof payload.reason === "string"
            ? { message: payload.reason }
            : typeof payload.lastAgentMessage === "string"
              ? { message: payload.lastAgentMessage }
              : {}),
        ...(isJsonObject(payload.budgetHalt)
          ? { budgetHalt: payload.budgetHalt }
          : {}),
        ...(isJsonObject(payload.budgetUsage)
          ? { budgetUsage: payload.budgetUsage }
          : {}),
      },
    };
  }
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: "event.session_event",
    params: {
      ...base,
      event: {
        id: event.id,
        type: event.type,
        ...(event.messageId !== undefined
          ? { messageId: event.messageId }
          : {}),
        ...(event.streamId !== undefined ? { streamId: event.streamId } : {}),
        ...(event.acceptedAt !== undefined
          ? { acceptedAt: event.acceptedAt }
          : {}),
        ...(payload !== undefined ? { payload } : {}),
      },
    },
  };
}

function eventBaseParams(
  sessionId: string,
  agentId: string,
  event: BackgroundAgentDaemonEvent,
): {
  readonly sessionId: string;
  readonly eventId: string;
  readonly agentId: string;
  readonly runId?: string;
  readonly historyEpoch?: string;
  readonly sequence?: number;
  readonly acceptedAt?: string;
  readonly turnId?: string;
  readonly clientMessageId?: string;
  readonly messageId?: string;
} {
  return {
    sessionId,
    eventId: event.eventId ?? event.id,
    agentId,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ...(event.historyEpoch !== undefined
      ? { historyEpoch: event.historyEpoch }
      : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.acceptedAt !== undefined ? { acceptedAt: event.acceptedAt } : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.clientMessageId !== undefined
      ? { clientMessageId: event.clientMessageId }
      : {}),
    ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
  };
}

function agentStatusFromEventType(type: string): DaemonAgentStatus {
  switch (type) {
    case "turn_started":
      return "running";
    case "error":
      return "error";
    case "turn_aborted":
      return "idle";
    case "turn_complete":
    default:
      return "idle";
  }
}

function daemonStatusFromRunTerminal(status: unknown): DaemonAgentStatus {
  switch (status) {
    case "completed":
      return "idle";
    case "failed":
    case "unknown_outcome":
      return "error";
    case "cancelled":
    default:
      return "stopped";
  }
}

function agentRunStatusFromRunTerminal(status: unknown): AgentRunStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "unknown_outcome":
      return "errored";
    case "cancelled":
    default:
      return "stopped";
  }
}

function agentRunStatusFromEventType(type: string): AgentRunStatus {
  switch (type) {
    case "turn_started":
      return "running";
    case "error":
      return "errored";
    case "turn_aborted":
      return "completed";
    case "turn_complete":
    default:
      return "completed";
  }
}

async function runRestoredAgentToCompletion(
  runAgentFn: AgenCRunAgentFunction,
  opts: {
    readonly thread: AgentThread;
    readonly parent: LocalRuntimeBootstrap["session"];
    readonly registry: ToolRegistry;
    readonly taskPrompt: string;
    readonly initialMessages: ReadonlyArray<LLMMessage>;
    readonly replayToolCalls: readonly AgenCBackgroundAgentReplayToolCall[];
    readonly currentSessionId?: string;
    readonly onReplayToolResult?: (
      result: AgenCBackgroundAgentReplayToolResult,
    ) => void | Promise<void>;
    readonly model?: string;
    readonly onProgress?: (
      event: RunAgentProgressEvent,
      thread: AgentThread,
    ) => void | Promise<void>;
  },
): Promise<RunAgentResult> {
  const replayedMessages = await replayRecoveredToolCalls(opts);
  const initialMessages =
    replayedMessages.length === 0
      ? opts.initialMessages
      : [...opts.initialMessages, ...replayedMessages];
  const iter = runAgentFn({
    live: opts.thread.live,
    parent: opts.parent,
    initialMessages,
    taskPrompt: opts.taskPrompt,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await iter.next();
    if (step.done) {
      return step.value;
    }
    await opts.onProgress?.(step.value, opts.thread);
  }
}

async function replayRecoveredToolCalls<
  TThread extends AgentThread | ManagedThread,
>(opts: {
  readonly thread: TThread;
  readonly parent: LocalRuntimeBootstrap["session"];
  readonly registry: ToolRegistry;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly replayToolCalls: readonly AgenCBackgroundAgentReplayToolCall[];
  readonly currentSessionId?: string;
  readonly onReplayToolResult?: (
    result: AgenCBackgroundAgentReplayToolResult,
  ) => void | Promise<void>;
  readonly onProgress?: (
    event: RunAgentProgressEvent,
    thread: TThread,
  ) => void | Promise<void>;
}): Promise<LLMMessage[]> {
  const messages: LLMMessage[] = [];
  for (const replay of opts.replayToolCalls) {
    const args = stringifyReplayToolArguments(replay.args);
    const registeredTool = opts.registry.tools.find(
      (tool) => tool.name === replay.toolName,
    );
    if (registeredTool?.recoveryCategory !== "idempotent") {
      if (opts.currentSessionId !== undefined) {
        await opts.onReplayToolResult?.({
          sessionId: opts.currentSessionId,
          callId: replay.callId,
          toolName: replay.toolName,
          result: `Recovered tool call ${replay.callId} was not replayed because the current tool registration is missing or not idempotent.`,
          isError: true,
          terminalStatus: "poisoned",
          ...(registeredTool?.recoveryCategory !== undefined
            ? { recoveryCategory: registeredTool.recoveryCategory }
            : {}),
        });
      }
      continue;
    }
    await opts.onProgress?.(
      {
        kind: "tool_call",
        callId: replay.callId,
        toolName: replay.toolName,
        arguments: args,
        recoveryCategory: "idempotent",
      },
      opts.thread,
    );
    const result = await dispatchReplayToolCall({
      registry: opts.registry,
      session: opts.parent,
      toolCall: {
        id: replay.callId,
        name: replay.toolName,
        arguments: args,
      },
    });
    if (opts.currentSessionId !== undefined) {
      await opts.onReplayToolResult?.({
        sessionId: opts.currentSessionId,
        callId: replay.callId,
        toolName: replay.toolName,
        result: result.content,
        isError: result.isError === true,
        terminalStatus: result.isError === true ? "failed" : "completed",
        recoveryCategory: "idempotent",
      });
    }
    await opts.onProgress?.(
      {
        kind: "tool_result",
        callId: replay.callId,
        toolName: replay.toolName,
        result: result.content,
        isError: result.isError === true,
      },
      opts.thread,
    );
    if (
      !hasAssistantToolCall(
        [...opts.initialMessages, ...messages],
        replay.callId,
      )
    ) {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: replay.callId,
            name: replay.toolName,
            arguments: args,
          },
        ],
      });
    }
    messages.push({
      role: "tool",
      content: frameUntrustedToolResultContent(
        replay.toolName,
        result.content,
        classifyUntrustedToolResult(replay.toolName, registeredTool),
      ),
      toolCallId: replay.callId,
      toolName: replay.toolName,
    });
  }
  return messages;
}

async function hydrateRecoveredSessionHistory(
  session: LocalRuntimeBootstrap["session"],
  params: {
    readonly initialMessages: ReadonlyArray<LLMMessage>;
    readonly replayedMessages: ReadonlyArray<LLMMessage>;
  },
): Promise<void> {
  if (
    params.initialMessages.length === 0 &&
    params.replayedMessages.length === 0
  ) {
    return;
  }
  const stateLock = (
    session as {
      readonly state?: {
        with?: (
          fn: (state: { history?: unknown }) => void | Promise<void>,
        ) => Promise<void> | void;
      };
    }
  ).state;
  if (typeof stateLock?.with !== "function") return;
  await stateLock.with((state) => {
    const current = Array.isArray(state.history) ? state.history : [];
    const next =
      current.length === 0
        ? [...params.initialMessages, ...params.replayedMessages]
        : [
            ...current,
            ...params.replayedMessages.filter(
              (message) => !historyContainsRecoveredMessage(current, message),
            ),
          ];
    state.history = next.map(cloneRecoveredLlmMessage);
  });
}

function historyContainsRecoveredMessage(
  history: ReadonlyArray<unknown>,
  message: LLMMessage,
): boolean {
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    const ids = new Set(message.toolCalls.map((toolCall) => toolCall.id));
    return history.some((entry) => {
      if (entry === null || typeof entry !== "object") return false;
      const toolCalls = (entry as { readonly toolCalls?: unknown }).toolCalls;
      return (
        Array.isArray(toolCalls) &&
        toolCalls.some(
          (toolCall) =>
            toolCall !== null &&
            typeof toolCall === "object" &&
            ids.has(String((toolCall as { readonly id?: unknown }).id)),
        )
      );
    });
  }
  if (message.role === "tool" && typeof message.toolCallId === "string") {
    return history.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { readonly role?: unknown }).role === "tool" &&
        (entry as { readonly toolCallId?: unknown }).toolCallId ===
          message.toolCallId,
    );
  }
  return false;
}

function cloneRecoveredLlmMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part }))
      : message.content,
    ...(message.toolCalls !== undefined
      ? {
          toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
        }
      : {}),
  };
}

function hasAssistantToolCall(
  messages: readonly LLMMessage[],
  toolCallId: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((toolCall) => toolCall.id === toolCallId) ===
        true,
  );
}

function stringifyReplayToolArguments(value: JsonValue): string {
  return JSON.stringify(value);
}

async function dispatchReplayToolCall(opts: {
  readonly registry: ToolRegistry;
  readonly session: LocalRuntimeBootstrap["session"];
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
}): Promise<{ readonly content: string; readonly isError?: boolean }> {
  try {
    const tool = opts.registry.tools.find(
      (candidate) => candidate.name === opts.toolCall.name,
    );
    if (tool === undefined || typeof tool.execute !== "function") {
      return {
        content:
          "Recovered tool call could not be replayed because the current tool registration is not executable.",
        isError: true,
      };
    }
    const router = routerFromRegistry(opts.registry);
    const permissionModeRegistry = opts.session.permissionModeRegistry;
    const permissionContext = permissionModeRegistry
      ? buildReplayPermissionContext(opts.session, permissionModeRegistry)
      : null;
    const modeChangeRegistry =
      typeof permissionModeRegistry?.subscribeToModeChange === "function"
        ? permissionModeRegistry
        : undefined;
    return await router.dispatchModelToolCall(opts.toolCall, {
      session: opts.session as Session,
      turn: buildReplayTurnContext(opts.session, opts.toolCall.id),
      tracker: replayNoopTracker,
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      ...(permissionContext !== null
        ? {
            canUseTool: hasPermissionsToUseTool,
            permissionContext,
            ...(modeChangeRegistry !== undefined ? { modeChangeRegistry } : {}),
          }
        : {}),
    });
  } catch (error) {
    return {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

const replayNoopTracker = {
  appendFileDiff: () => {},
  snapshot: () => [],
  clear: () => {},
};

function buildReplayPermissionContext(
  session: LocalRuntimeBootstrap["session"],
  permissionModeRegistry: PermissionModeRegistry,
): ToolEvaluatorContext {
  const denialTracking =
    (
      session as {
        readonly denialTracking?: ReturnType<typeof freshDenialTracking>;
      }
    ).denialTracking ?? freshDenialTracking();
  return attachContextDefaults({
    session: session as Session,
    denialTracking,
    executionSurface: "headless",
    getAppState: (): AppStateSnapshot => {
      const current = permissionModeRegistry.current();
      return {
        toolPermissionContext: current,
        denialTracking,
        autoModeActive: current.autoModeActive === true,
      };
    },
  });
}

function buildReplayTurnContext(
  session: LocalRuntimeBootstrap["session"],
  subId: string,
): TurnContext {
  const sessionRecord = session as {
    readonly config?: unknown;
    readonly modelInfo?: unknown;
    readonly provider?: unknown;
    readonly cwd?: unknown;
  };
  const config = (sessionRecord.config ?? {}) as TurnContext["config"];
  return {
    subId,
    config,
    configSnapshot: config,
    modelInfo: (sessionRecord.modelInfo ?? {
      slug: "background-replay",
      effectiveContextWindowPercent: 100,
      contextWindow: 8192,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    }) as TurnContext["modelInfo"],
    provider: (sessionRecord.provider ?? {}) as TurnContext["provider"],
    cwd: typeof sessionRecord.cwd === "string" ? sessionRecord.cwd : "/tmp",
    realtimeActive: false,
    modelProviderId: "background-replay",
    reasoningSummary: "auto",
    sessionSource: "sdk",
    dynamicTools: [],
    depth: 0,
    toolCallGate: {
      isReady: () => true,
      signal: () => {},
      wait: async () => {},
    },
  } as unknown as TurnContext;
}

function restoredAgentMetadata(
  params: AgenCBackgroundAgentRestoreParams,
): AgentMetadata {
  const metadata = params.metadata;
  const agentPath =
    metadataStringField(metadata, "agentPath") ??
    metadataStringField(metadata, "agent_path") ??
    joinAgentPath(ROOT_AGENT_PATH, normalizeAgentNameForPath(params.agentId));
  return normalizeAgentMetadata({
    agentId: params.agentId,
    agentPath,
    ...(metadata?.agentNickname !== undefined
      ? { agentNickname: metadata.agentNickname }
      : {}),
    ...(metadata?.agentRole !== undefined
      ? { agentRole: metadata.agentRole }
      : {}),
    ...(metadata?.agentRoleWorkspaceId !== undefined
      ? { agentRoleWorkspaceId: metadata.agentRoleWorkspaceId }
      : {}),
    ...(metadata?.agentRoleFingerprint !== undefined
      ? { agentRoleFingerprint: metadata.agentRoleFingerprint }
      : {}),
    depth: metadata?.depth ?? 1,
  });
}

function metadataStringField(
  value: JsonObject | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim().length > 0
    ? field.trim()
    : undefined;
}

function messageContentToLlmParts(
  content: MessageContent | undefined,
): readonly LLMContentPart[] | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image_url",
      image_url: { url: part.image_url.url },
    };
  });
}

function metadataStringList(
  value: JsonObject | undefined,
  key: string,
): readonly string[] | undefined {
  if (
    value === undefined ||
    !Object.prototype.hasOwnProperty.call(value, key)
  ) {
    return undefined;
  }
  const field = value[key];
  if (!Array.isArray(field)) return undefined;
  return field.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}

function agentRunStatusFromPayload(value: unknown): AgentRunStatus | undefined {
  switch (value) {
    case "pending":
    case "running":
    case "working":
    case "paused":
    case "blocked":
    case "suspended":
    case "completed":
    case "errored":
    case "stopped":
      return value;
    default:
      return undefined;
  }
}

function toolRequestInputFromPayload(
  payload: JsonObject,
): JsonValue | undefined {
  if (payload.input !== undefined && isJsonValue(payload.input)) {
    return payload.input;
  }
  if (typeof payload.args !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(payload.args);
    return isJsonValue(parsed) ? parsed : payload.args;
  } catch {
    return payload.args;
  }
}

/**
 * Translate session-level events that the PhaseEvent → RunAgentProgressEvent
 * pipeline does not cover into BackgroundAgentDaemonEvents the daemon's
 * notification fan-out can deliver. Currently:
 *
 *   - elicitation/user-input requests (`request_user_input`,
 *     `mcp_elicitation_request`, `mcp_elicitation_complete`)
 *   - durable user transcript messages emitted by runtime turns
 *   - collab-agent lifecycle events emitted by `spawn_agent`,
 *     `wait_agent`, `send_message`, and `close_agent`
 *   - runtime warnings emitted before or during a turn
 *   - streaming tool progress chunks (`tool_progress`)
 *   - extended-thinking + reasoning-summary streaming events
 *     (`assistant_thinking_block_start`/`delta`/`block_stop`,
 *     `agent_thinking`)
 *
 * The bridge subscribes to `session.eventLog` (live; writes to the rollout
 * are a separate downstream consumer) and forwards a translated event into
 * the same `#emitOrBufferEvent` pipeline that PhaseEvents use.
 */
const COLLAB_AGENT_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "collab_agent_spawn_begin",
  "collab_agent_spawn_end",
  "collab_agent_status",
  "collab_agent_interaction_begin",
  "collab_agent_interaction_end",
  "collab_waiting_begin",
  "collab_waiting_end",
  "collab_close_begin",
  "collab_close_end",
]);

/**
 * Core run events whose live representation must be the exact canonical
 * Session.EventLog record. Returning null for an unsequenced record is
 * intentional: synthesizing an identity here would make live delivery
 * impossible to reconcile with run.replay after reconnect.
 */
const CANONICAL_CORE_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "history_cleared",
  "transcript_epoch",
  "agent_message_delta",
  "tool_call_started",
  "tool_call_completed",
  "turn_started",
  "turn_complete",
  "turn_aborted",
  "warning",
  "error",
  "stream_error",
  "effect_intent",
  "effect_result",
  "effect_unknown_outcome",
  "effect_review_resolved",
  "request_permissions",
  "permission_decision",
  "execution_admission",
  "artifact_intent",
  "artifact_committed",
  "recovery_decision",
  "run_terminal",
  "run_reopened",
  "run_suspended",
  "run_resumed",
  "run_runtime_settings_changed",
  "run_cancel_requested",
]);

export function daemonEventFromUnboundSessionEvent(event: {
  readonly eventId?: unknown;
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly msg?: {
    readonly type?: unknown;
    readonly payload?: unknown;
  };
}): BackgroundAgentDaemonEvent | null {
  const type = event.msg?.type;
  const payload = event.msg?.payload;
  const id =
    typeof event.id === "string" && event.id.length > 0
      ? event.id
      : typeof type === "string"
        ? type
        : "elicitation";
  const sequence =
    typeof event.seq === "number" &&
    Number.isSafeInteger(event.seq) &&
    event.seq > 0
      ? event.seq
      : undefined;
  const eventId =
    typeof event.eventId === "string" && event.eventId.length > 0
      ? event.eventId
      : sequence !== undefined
        ? `legacy-event:${sequence}:${id}`
        : id;
  if (
    typeof type === "string" &&
    CANONICAL_CORE_SESSION_EVENT_TYPES.has(type)
  ) {
    if (sequence === undefined || !isJsonObject(payload)) return null;
    return { id, eventId, sequence, type, payload };
  }
  if (
    type === "request_user_input" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.turnId === "string" &&
    Array.isArray(payload.questions)
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        callId: payload.callId,
        requestId:
          typeof payload.requestId === "string"
            ? payload.requestId
            : payload.callId,
        turnId: payload.turnId,
        questions: jsonObjectArray(payload.questions),
        ...(isJsonObject(payload.clientAction)
          ? { clientAction: payload.clientAction }
          : {}),
      },
    };
  }
  if (
    type === "mcp_elicitation_request" &&
    isJsonObject(payload) &&
    typeof payload.serverName === "string" &&
    (typeof payload.requestId === "string" ||
      typeof payload.requestId === "number") &&
    typeof payload.turnId === "string" &&
    isJsonObject(payload.request)
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        serverName: payload.serverName,
        requestId: payload.requestId,
        turnId: payload.turnId,
        request: payload.request,
      },
    };
  }
  if (
    type === "mcp_elicitation_complete" &&
    isJsonObject(payload) &&
    typeof payload.serverName === "string" &&
    typeof payload.elicitationId === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        serverName: payload.serverName,
        elicitationId: payload.elicitationId,
      },
    };
  }
  if (
    type === "user_message" &&
    isJsonObject(payload) &&
    payload.message !== undefined
  ) {
    const messageId =
      typeof payload.messageId === "string" ? payload.messageId : undefined;
    const streamId =
      typeof payload.streamId === "string" ? payload.streamId : undefined;
    const acceptedAt =
      typeof payload.acceptedAt === "string" ? payload.acceptedAt : undefined;
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(streamId !== undefined ? { streamId } : {}),
      ...(acceptedAt !== undefined ? { acceptedAt } : {}),
      payload: {
        message: payload.message,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(streamId !== undefined ? { streamId } : {}),
        ...(acceptedAt !== undefined ? { acceptedAt } : {}),
        ...(typeof payload.displayText === "string"
          ? { displayText: payload.displayText }
          : {}),
        ...(Array.isArray(payload.images)
          ? { images: stringArray(payload.images) }
          : {}),
        ...(typeof payload.queuedCommandUuid === "string"
          ? { queuedCommandUuid: payload.queuedCommandUuid }
          : {}),
      },
    };
  }
  if (
    typeof type === "string" &&
    COLLAB_AGENT_SESSION_EVENT_TYPES.has(type) &&
    isJsonObject(payload) &&
    typeof payload.callId === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Provider token accounting for the latest model call. Telemetry like
  // collab_agent_status: clients drive live context gauges off it, and
  // without forwarding it a UI can only estimate context from transcript
  // characters — blind to tool output, which is where context really goes.
  if (
    type === "token_count" &&
    isJsonObject(payload) &&
    typeof payload.promptTokens === "number" &&
    typeof payload.totalTokens === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  if (
    type === "tool_progress" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.toolName === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Assistant message-complete boundaries. `agent_message` is emitted per
  // completed assistant message segment (run-turn) and persisted to the
  // rollout, but the live wire only carried `agent_message_delta` — so a
  // daemon-attached TUI accumulated the deltas of CONSECUTIVE messages
  // into one streaming buffer with no separator ("…subagents.No M1-named
  // files…"). The reducer's agent_message case is what closes a segment
  // (pushes the completed row, clears the buffer); forward it live.
  if (
    type === "agent_message" &&
    isJsonObject(payload) &&
    typeof payload.message === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Per-stream provider usage. Emitted via `session.emit` from
  // `phases/stream-model.ts` (T6 #119) and persisted to the rollout, but
  // never bridged live — so a daemon-attached TUI had no usage source at
  // all: its synthesized assistant messages carry zero usage and the
  // workbench ctx% read 0 for the whole session. Forward the payload
  // verbatim; the TUI reducer derives `latestUsage` from it.
  if (type === "token_count" && isJsonObject(payload)) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Streaming tool-argument events (input_json_delta family). Same live
  // bridge gap as the thinking events below: providers that stream tool
  // arguments (grok function_call_arguments deltas, Messages-API
  // input_json_delta) emit these through stream-model, and the TUI needs
  // them for in-flight tool rendering, the spinner's cumulative token
  // estimate, and stream-liveness accounting.
  if (
    type === "tool_input_block_start" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.index === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  if (
    type === "tool_input_delta" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.index === "number" &&
    typeof payload.partialJson === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Extended-thinking + reasoning-summary events. These are emitted via
  // `session.emit` from `phases/stream-model.ts` and persisted to the
  // rollout, but the live notification path needs an explicit bridge:
  // the PhaseEvent → RunAgentProgressEvent → BackgroundAgentDaemonEvent
  // pipeline at `phaseEventToProgressEvent` does not carry them, so the
  // TUI's `event.session_event` catch-all never sees them without this.
  if (
    type === "assistant_thinking_block_start" &&
    isJsonObject(payload) &&
    typeof payload.index === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        index: payload.index,
        redacted: payload.redacted === true,
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
      },
    };
  }
  if (
    type === "assistant_thinking_delta" &&
    isJsonObject(payload) &&
    typeof payload.delta === "string" &&
    typeof payload.index === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        delta: payload.delta,
        index: payload.index,
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
      },
    };
  }
  if (
    type === "assistant_thinking_block_stop" &&
    isJsonObject(payload) &&
    typeof payload.index === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        index: payload.index,
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
      },
    };
  }
  if (
    type === "agent_thinking" &&
    isJsonObject(payload) &&
    typeof payload.text === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        text: payload.text,
        ...(payload.redacted === true ? { redacted: true } : {}),
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
      },
    };
  }
  return null;
}

function jsonObjectArray(value: readonly unknown[]): JsonObject[] {
  return value.filter(isJsonObject);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value).every(
        (item) => item === undefined || isJsonValue(item),
      );
    default:
      return false;
  }
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isToolRecoveryCategory(
  value: unknown,
): value is "idempotent" | "side-effecting" | "interactive" {
  return (
    value === "idempotent" ||
    value === "side-effecting" ||
    value === "interactive"
  );
}

interface ManagedTokenUsageShape {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export function managedTokenUsage(
  thread: Pick<ManagedThread, "totalTokenUsage">,
): ManagedTokenUsageShape {
  const usage = thread.totalTokenUsage?.();
  if (typeof usage !== "object" || usage === null) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const u = usage as Record<string, unknown>;
  // Two shapes reach this seam: run-agent's live counter uses
  // inputTokens/outputTokens, while a daemon session's cross-turn
  // accumulator (stream-model.ts, the TokenUsageInfo port) uses
  // promptTokens/completionTokens. Reading only the former zeroed
  // input/output in every session.snapshot (totalTokens matched both
  // shapes, which is why the bug shipped as {0, 0, N}).
  const field = (...names: readonly string[]): number => {
    for (const name of names) {
      const value = u[name];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  };
  const inputTokens = field("inputTokens", "promptTokens");
  const outputTokens = field("outputTokens", "completionTokens");
  const totalTokens = field("totalTokens");
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
  };
}

// Translate Session PhaseEvents only for runner-local status/tool bookkeeping.
// Live delivery is owned by the canonical Session.EventLog bridge above; using
// this phase shape for delivery would invent competing IDs without sequences.
// Exported as a test seam: the stop-reason mapping decides whether a turn
// outcome ends the turn or the whole run.
export function phaseEventToProgressEvent(
  event: import("../phases/events.js").PhaseEvent,
): RunAgentProgressEvent | null {
  switch (event.type) {
    case "turn_start":
      return null;
    case "history_cleared":
      return null;
    case "queued_command":
      return null;
    case "assistant_text":
      return {
        kind: "message",
        message: { role: "assistant", content: event.content },
      };
    case "tool_call":
      return {
        kind: "tool_call",
        callId: event.toolCall.id,
        toolName: event.toolCall.name,
        arguments: event.toolCall.arguments,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        callId: event.toolCall.id,
        toolName: event.toolCall.name,
        result: event.result.content,
        isError: event.result.isError === true,
      };
    case "turn_complete": {
      const turnId = `turn-${event.stopReason}-${event.content.length}-${
        event.usage?.totalTokens ?? 0
      }`;
      if (event.stopReason === "cancelled") {
        return {
          kind: "turn_interrupted",
          reason: "cancelled",
          turnId,
        };
      }
      if (event.stopReason === "error") {
        return {
          kind: "run_error",
          error: event.error?.message ?? "turn errored",
        };
      }
      // Bounded stops — the backstop, a turn cap, the cost cap — are
      // per-TURN outcomes, not run deaths. Mapping them to run_error
      // bricked the whole session: the user saw "no longer running
      // (status: error)" and could never prompt again after one bad
      // turn. The turn ends honestly with its message; the session
      // stays available for the next prompt, exactly like "completed".
      const boundedStopFallback: Partial<Record<string, string>> = {
        max_turns: "Turn capped: iteration limit hit; send a new prompt to continue.",
        max_budget_usd: "Turn capped: cost ceiling hit; send a new prompt to continue.",
        no_progress: "Turn halted by the progress backstop; send a new prompt to continue.",
      };
      const boundedFallback = boundedStopFallback[event.stopReason];
      if (boundedFallback !== undefined) {
        return {
          kind: "turn_complete",
          turnId,
          toolCallCount: 0,
          finalMessage: event.content.length > 0 ? event.content : boundedFallback,
        };
      }
      // "completed" | "empty_response" — a per-turn completion. Emit
      // turn_complete (NOT run_complete — the session continues across
      // turns; run_complete would trigger cleanup).
      return {
        kind: "turn_complete",
        turnId,
        toolCallCount: 0,
        ...(event.content.length > 0 ? { finalMessage: event.content } : {}),
      };
    }
  }
}

function canonicalSessionEventFromRecoveredProgress(
  progress: RunAgentProgressEvent,
): Event | null {
  if (progress.kind === "tool_call") {
    return {
      id: `recovery-tool-start:${progress.callId}`,
      msg: {
        type: "tool_call_started",
        payload: {
          callId: progress.callId,
          toolName: progress.toolName,
          args: progress.arguments ?? "{}",
        },
      },
    };
  }
  if (progress.kind === "tool_result") {
    return {
      id: `recovery-tool-result:${progress.callId}`,
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: progress.callId,
          result: progress.result,
          isError: progress.isError === true,
          metadata: {
            toolName: progress.toolName,
            recovered: true,
          },
        },
      },
    };
  }
  return null;
}

type TerminalThreadStatus = Extract<
  ThreadAgentStatus,
  { readonly status: "completed" | "errored" | "shutdown" | "not_found" }
>;

interface CapturedRuntimeSettingsOptions {
  readonly profile?: string;
  readonly permissionContext?: ToolPermissionContext;
}

function runtimeWorkspaceRoot(bootstrap: LocalRuntimeBootstrap): string {
  const broker = bootstrap.session.services.sandboxExecutionBroker;
  if (!(broker instanceof SandboxExecutionBroker)) {
    throw new Error(
      "canonical runtime settings require the live sandbox execution broker cwd",
    );
  }
  const cwd = broker.cwd;
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new Error("live sandbox execution broker cwd is unavailable");
  }
  return canonicalizeBypassPermissionsCwd(cwd);
}

function supportsCanonicalRuntimeSettings(
  active: ActiveBackgroundAgent,
): boolean {
  return (
    typeof active.bootstrap.session.permissionModeRegistry
      .installBeforeUpdateHook === "function" &&
    typeof active.bootstrap.session.permissionModeRegistry
      .installPublicationCoordinator === "function" &&
    active.bootstrap.session.services.sandboxExecutionBroker instanceof
      SandboxExecutionBroker &&
    active.bootstrap.configuredExecutionAuthority !== undefined &&
    typeof active.bootstrap.prepareConfiguredExecutionAuthority ===
      "function" &&
    typeof active.bootstrap.rolloutStore.recordRunRuntimeSettingsEvent ===
      "function"
  );
}

function requireCanonicalRuntimeSettingsSupport(
  active: ActiveBackgroundAgent,
  runId: string,
): void {
  if (!supportsCanonicalRuntimeSettings(active)) {
    throw new Error(
      `run ${runId} requires a canonical permission registry and durable runtime-settings journal`,
    );
  }
}

function failClosedDaemonRuntimeAuthority(
  active: ActiveBackgroundAgent,
  error: unknown,
  options: {
    readonly brokerReason: string;
    readonly abortReason: Parameters<Session["abortTerminal"]>[0];
    readonly abortFailureMessage: string;
  },
): never {
  const session = active.bootstrap.session;
  const broker = session.services.sandboxExecutionBroker;
  if (broker instanceof SandboxExecutionBroker) {
    broker.closeAfterLifecycleAuthorityFailure(options.brokerReason);
  }
  active.ingressClosed = true;
  try {
    session.abortTerminal(options.abortReason);
  } catch (abortError) {
    throw new AggregateError([error, abortError], options.abortFailureMessage, {
      cause: error,
    });
  }
  throw error;
}

function installDaemonPermissionAuthorityCoordinator(
  bootstrap: LocalRuntimeBootstrap,
  owner: () => ActiveBackgroundAgent | undefined,
): () => void {
  const session = bootstrap.session;
  const registry = session.permissionModeRegistry;
  const broker = session.services.sandboxExecutionBroker;
  if (!(broker instanceof SandboxExecutionBroker)) {
    throw new Error(
      "daemon session requires the canonical sandbox execution broker",
    );
  }
  if (
    bootstrap.configuredExecutionAuthority === undefined ||
    typeof bootstrap.prepareConfiguredExecutionAuthority !== "function"
  ) {
    throw new Error(
      "daemon session requires a configured execution-authority snapshot",
    );
  }

  return registry.installPublicationCoordinator(
    async (
      next,
      _current,
      metadata,
      publication: PermissionContextPublication,
    ) => {
      const stagedConfiguredAuthority =
        configuredExecutionAuthorityFromPublicationMetadata(metadata);
      const preparedConfigReload =
        preparedConfigStoreReloadFromPublicationMetadata(metadata);
      const preparedMcpAuthorityRefresh =
        preparedMcpAuthorityRefreshFromPublicationMetadata(metadata);
      const authority = executionAuthorityForPermissionContext(
        stagedConfiguredAuthority?.authority ??
          bootstrap.configuredExecutionAuthority,
        next,
        session.services.runtimeOptions
          ?.dangerouslyBypassApprovalsAndSandbox === true,
      );
      let previousConfiguration: Session["sessionConfiguration"] | undefined;
      let configurationWriteStarted = false;
      let stagedConfiguredAuthorityCommitted = false;
      let preparedConfigReloadCommitted = false;
      let preparedMcpAuthorityRefreshStarted = false;
      let authorityTransitionCompleted = false;
      try {
        await transitionSandboxExecutionBrokerAuthority(
          broker,
          sandboxExecutionBrokerAuthorityFromSessionAuthority(
            authority,
            broker.cwd,
          ),
          {
            commit: async () => {
              configurationWriteStarted = true;
              await session.state.with((state) => {
                previousConfiguration = state.sessionConfiguration;
                state.sessionConfiguration = applySessionExecutionAuthority(
                  state.sessionConfiguration,
                  authority,
                );
              });
              preparedConfigReload?.commit();
              preparedConfigReloadCommitted =
                preparedConfigReload !== undefined;
              stagedConfiguredAuthority?.commit();
              stagedConfiguredAuthorityCommitted =
                stagedConfiguredAuthority !== undefined;
              await publication.commit();
              preparedConfigReload?.publish(
                COORDINATED_CONFIG_STORE_PUBLICATION,
              );
              preparedMcpAuthorityRefreshStarted =
                preparedMcpAuthorityRefresh !== undefined;
              preparedMcpAuthorityRefresh?.start();
              await preparedMcpAuthorityRefresh?.waitUntilDeferred();
            },
            rollback: async () => {
              const rollbackErrors: unknown[] = [];
              try {
                await publication.rollback();
              } catch (error) {
                rollbackErrors.push(error);
              }
              if (stagedConfiguredAuthorityCommitted) {
                try {
                  stagedConfiguredAuthority?.rollback();
                  stagedConfiguredAuthorityCommitted = false;
                } catch (error) {
                  rollbackErrors.push(error);
                }
              }
              if (preparedConfigReloadCommitted) {
                try {
                  preparedConfigReload?.rollback();
                  preparedConfigReloadCommitted = false;
                } catch (error) {
                  rollbackErrors.push(error);
                }
              }
              if (
                configurationWriteStarted &&
                previousConfiguration !== undefined
              ) {
                try {
                  await session.state.with((state) => {
                    state.sessionConfiguration = previousConfiguration!;
                  });
                } catch (error) {
                  rollbackErrors.push(error);
                }
              }
              if (rollbackErrors.length > 0) {
                throw new AggregateError(
                  rollbackErrors,
                  "daemon permission authority rollback incomplete",
                );
              }
            },
          },
        );
        authorityTransitionCompleted = true;
        await preparedMcpAuthorityRefresh?.settle();
        preparedConfigReload?.settle();
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (!authorityTransitionCompleted) {
          try {
            await publication.rollback();
          } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
          }
          if (
            preparedConfigReload !== undefined &&
            !preparedConfigReload.settled
          ) {
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
        } else {
          if (
            preparedConfigReload !== undefined &&
            !preparedConfigReload.settled
          ) {
            try {
              preparedConfigReload.settle();
            } catch (settleError) {
              cleanupErrors.push(settleError);
            }
          }
          if (!broker.isClosedAfterLifecycleAuthorityFailure()) {
            broker.closeAfterLifecycleAuthorityFailure(
              "daemon permission authority failed after canonical publication",
            );
          }
        }
        const failure =
          cleanupErrors.length === 0
            ? error
            : new AggregateError(
                [error, ...cleanupErrors],
                "daemon permission authority cleanup was incomplete",
                { cause: error },
              );
        if (
          (cleanupErrors.length > 0 || preparedMcpAuthorityRefreshStarted) &&
          !broker.isClosedAfterLifecycleAuthorityFailure()
        ) {
          broker.closeAfterLifecycleAuthorityFailure(
            preparedMcpAuthorityRefreshStarted
              ? "daemon permission authority failed after canonical publication"
              : "daemon permission authority cleanup was incomplete",
          );
        }
        if (!broker.isClosedAfterLifecycleAuthorityFailure()) {
          if (
            failure instanceof AggregateError &&
            failure.errors.length === 1
          ) {
            throw failure.errors[0];
          }
          throw failure;
        }
        const active = owner();
        if (active !== undefined) active.ingressClosed = true;
        const terminalFailure =
          failure instanceof AggregateError && failure.errors.length === 1
            ? failure.errors[0]
            : failure;
        try {
          session.abortTerminal("permission_authority_failure");
        } catch (abortError) {
          throw new AggregateError(
            [terminalFailure, abortError],
            "daemon permission authority failed and session abort was incomplete",
            { cause: terminalFailure },
          );
        }
        throw terminalFailure;
      }
    },
  );
}

function preparedConfigStoreReloadFromPublicationMetadata(
  metadata: unknown,
): PreparedConfigStoreReload | undefined {
  if (!isRecord(metadata)) return undefined;
  const prepared = metadata.preparedConfigReload;
  if (!isRecord(prepared)) return undefined;
  if (
    !isRecord(prepared.authority) ||
    typeof prepared.commit !== "function" ||
    typeof prepared.publish !== "function" ||
    typeof prepared.rollback !== "function" ||
    typeof prepared.settle !== "function"
  ) {
    throw new Error("prepared config reload publication metadata is invalid");
  }
  return prepared as unknown as PreparedConfigStoreReload;
}

interface PreparedMcpAuthorityRefresh {
  readonly result: McpRefreshResult | undefined;
  start(): void;
  waitUntilDeferred(): Promise<void>;
  settle(): Promise<void>;
}

function prepareMcpAuthorityRefresh(
  session: Session,
): PreparedMcpAuthorityRefresh | undefined {
  const manager = session.services.mcpManager;
  const refresh = manager?.refreshFromAuthority;
  if (manager === undefined || refresh === undefined) return undefined;
  let task: Promise<McpRefreshResult> | undefined;
  let result: McpRefreshResult | undefined;
  let deferred = false;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const markDeferred = (): void => {
    if (readySettled) return;
    deferred = true;
    readySettled = true;
    resolveReady();
  };
  const failReady = (error: unknown): void => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  };
  return Object.freeze({
    get result() {
      return result;
    },
    start: () => {
      if (task !== undefined) {
        throw new Error("MCP authority refresh was started more than once");
      }
      try {
        task = Promise.resolve(
          refresh.call(manager, {
            onSandboxRefreshDeferred: markDeferred,
          }),
        );
      } catch (error) {
        task = Promise.reject(error);
      }
      void task.then(() => {
        if (!deferred) {
          failReady(
            new Error(
              "MCP authority refresh completed before sandbox deferral was proven",
            ),
          );
        }
      }, failReady);
      void task.catch(() => undefined);
    },
    waitUntilDeferred: () => ready,
    settle: async () => {
      if (task === undefined) {
        throw new Error("MCP authority refresh was not started");
      }
      result = await task;
    },
  });
}

function preparedMcpAuthorityRefreshFromPublicationMetadata(
  metadata: unknown,
): PreparedMcpAuthorityRefresh | undefined {
  if (!isRecord(metadata)) return undefined;
  const prepared = metadata.preparedMcpAuthorityRefresh;
  if (!isRecord(prepared)) return undefined;
  if (
    typeof prepared.start !== "function" ||
    typeof prepared.waitUntilDeferred !== "function" ||
    typeof prepared.settle !== "function"
  ) {
    throw new Error("prepared MCP refresh publication metadata is invalid");
  }
  return prepared as unknown as PreparedMcpAuthorityRefresh;
}

function configuredExecutionAuthorityFromPublicationMetadata(
  metadata: unknown,
): PreparedConfiguredExecutionAuthority | undefined {
  if (!isRecord(metadata)) return undefined;
  const prepared = metadata.configuredExecutionAuthority;
  if (!isRecord(prepared)) return undefined;
  if (
    !isRecord(prepared.authority) ||
    typeof prepared.commit !== "function" ||
    typeof prepared.rollback !== "function"
  ) {
    throw new Error(
      "configured execution authority publication metadata is invalid",
    );
  }
  return prepared as unknown as PreparedConfiguredExecutionAuthority;
}

function captureRuntimeSettings(
  active: ActiveBackgroundAgent,
  options: CapturedRuntimeSettingsOptions = {},
): RunRuntimeSettingsSnapshot {
  const { bootstrap } = active;
  const session = bootstrap.session;
  const workspaceRoot = runtimeWorkspaceRoot(bootstrap);
  const permission =
    options.permissionContext ?? session.permissionModeRegistry.current();
  if (permission.mode === "bubble") {
    throw new Error("root daemon runtime settings cannot persist bubble mode");
  }
  const prePlanMode =
    permission.mode === "plan"
      ? permission.prePlanMode === undefined ||
        permission.prePlanMode === "bubble"
        ? "default"
        : permission.prePlanMode
      : null;
  const bypassTransitionCritical =
    permission.mode === "bypassPermissions" ||
    prePlanMode === "bypassPermissions";
  const hasSessionExactBypassConsent =
    permission.bypassPermissionsAcceptedIn?.includes(workspaceRoot) === true;
  if (bypassTransitionCritical && !hasSessionExactBypassConsent) {
    throw new Error(
      `cannot persist bypass permission authority without exact workspace consent: ${workspaceRoot}`,
    );
  }
  let hasDurableExactBypassConsent = false;
  try {
    hasDurableExactBypassConsent =
      loadBypassPermissionsConsent(
        bootstrap.configStore.stateRepository,
        workspaceRoot,
        { reload: true },
      )[0] === workspaceRoot;
  } catch {
    // A failed state refresh cannot add authority. Session authority remains
    // usable for an already-active transition, but is not widened here.
  }
  const bypassDisabledByPolicy =
    permission.bypassPermissionsModeDisabledByPolicy === true;
  const hasExactBypassConsent =
    !bypassDisabledByPolicy &&
    (hasSessionExactBypassConsent || hasDurableExactBypassConsent);
  const bypassPermissionsModeAvailable =
    !bypassDisabledByPolicy &&
    (permission.isBypassPermissionsModeAvailable === true ||
      hasExactBypassConsent);

  const pending = session.pendingProviderSwitch;
  const selection = readSessionSelection(session, { includePending: true });
  const configuration = (
    session as Session & {
      readonly sessionConfiguration?: Session["sessionConfiguration"];
    }
  ).sessionConfiguration;
  const reasoningEffort = normalizeRuntimeSetting(
    configuration?.collaborationMode.reasoningEffort,
    RUN_RUNTIME_REASONING_EFFORTS,
    "reasoning effort",
  );
  const modelVerbosity = normalizeRuntimeSetting(
    configuration?.modelVerbosity,
    RUN_RUNTIME_MODEL_VERBOSITIES,
    "model verbosity",
  );
  const serviceTier = normalizeRuntimeSetting(
    configuration?.serviceTier,
    RUN_RUNTIME_SERVICE_TIERS,
    "service tier",
  );
  return cloneFrozenRuntimeSettingsSnapshot({
    permissionMode: permission.mode,
    prePlanMode,
    autoModeActive: permission.autoModeActive === true,
    autoModeAvailable: permission.isAutoModeAvailable === true,
    bypassPermissionsModeAvailable,
    bypassPermissionsWorkspace: bypassTransitionCritical ? workspaceRoot : null,
    bypassPermissionsConsentWorkspace: hasExactBypassConsent
      ? workspaceRoot
      : null,
    model: selection.model,
    provider: selection.provider,
    profile:
      options.profile ??
      pending?.profile ??
      active.runtimeSettings?.profile ??
      null,
    reasoningEffort,
    modelVerbosity,
    serviceTier,
    hooksDisabled: session.services?.hooksRuntime?.isDisabled() === true,
  });
}

function normalizeRuntimeSetting<const T extends readonly string[]>(
  value: unknown,
  accepted: T,
  label: string,
): T[number] | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !(accepted as readonly string[]).includes(value)
  ) {
    throw new Error(`cannot persist unsupported ${label}: ${String(value)}`);
  }
  return value as T[number];
}

function installRuntimeSettingsPreCommit(
  active: ActiveBackgroundAgent,
  runId: string,
): () => void {
  const registry = active.bootstrap.session.permissionModeRegistry;
  requireCanonicalRuntimeSettingsSupport(active, runId);
  return registry.installBeforeUpdateHook(async (next, current, metadata) => {
    const release = await acquireRuntimeSettingsMutation(active);
    try {
      if (active.ingressClosed === true) {
        throw new Error(`run ${runId} permission ingress is closed`);
      }
      if (active.runtimeSettingsEventId === undefined) {
        const baseline = captureRuntimeSettings(active, {
          permissionContext: current,
        });
        commitDurableRuntimeSettingsChange(active, runId, baseline, "initial");
      }
      const previousSettings = active.runtimeSettings!;
      const nextSettings = captureRuntimeSettings(active, {
        permissionContext: next,
      });
      if (
        active.runtimeSettings !== undefined &&
        stableStringify(active.runtimeSettings) ===
          stableStringify(nextSettings)
      ) {
        release();
        return undefined;
      }
      const prepared = prepareDurableRuntimeSettingsChange(
        active,
        runId,
        nextSettings,
        runtimeSettingsCommitMetadata(metadata)?.reason ??
          "permission_mode_changed",
        runtimeSettingsCommitMetadata(metadata)?.rollbackOfSettingsEventId ??
          null,
      );
      return {
        commit: () => {
          prepared.finalize();
        },
        rollback: () => {
          if (active.runtimeSettingsEventId === prepared.eventId) {
            compensateRuntimeSettingsChange(
              active,
              runId,
              previousSettings,
              prepared.eventId,
            );
            return;
          }
          compensatePreparedRuntimeSettingsChange(
            active,
            runId,
            previousSettings,
            prepared,
          );
        },
        settle: release,
      };
    } catch (error) {
      release();
      throw error;
    }
  });
}

function runtimeSettingsCommitMetadata(metadata: unknown):
  | {
      readonly reason: RunRuntimeSettingsChangeReason;
      readonly rollbackOfSettingsEventId: string | null;
    }
  | undefined {
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    !("runtimeSettings" in metadata)
  ) {
    return undefined;
  }
  const value = (metadata as { readonly runtimeSettings?: unknown })
    .runtimeSettings;
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as {
    readonly reason?: unknown;
    readonly rollbackOfSettingsEventId?: unknown;
  };
  if (
    typeof candidate.reason !== "string" ||
    !RUN_RUNTIME_SETTINGS_CHANGE_REASONS.includes(candidate.reason as never) ||
    (candidate.rollbackOfSettingsEventId !== null &&
      typeof candidate.rollbackOfSettingsEventId !== "string")
  ) {
    throw new Error("invalid permission runtime-settings commit metadata");
  }
  return {
    reason: candidate.reason as RunRuntimeSettingsChangeReason,
    rollbackOfSettingsEventId: candidate.rollbackOfSettingsEventId,
  };
}

async function withRuntimeSettingsMutation<T>(
  active: ActiveBackgroundAgent,
  mutate: () => Promise<T>,
): Promise<T> {
  const result = active.runtimeSettingsMutationQueue.then(mutate);
  active.runtimeSettingsMutationQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function acquireRuntimeSettingsMutation(
  active: ActiveBackgroundAgent,
): Promise<() => void> {
  const previous = active.runtimeSettingsMutationQueue;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = previous.then(
    () => {},
    () => {},
  );
  active.runtimeSettingsMutationQueue = acquired.then(() => held);
  await acquired;
  return release;
}

function ensureInitialRuntimeSettings(
  active: ActiveBackgroundAgent,
  runId: string,
): RunRuntimeSettingsSnapshot {
  if (
    active.runtimeSettings !== undefined &&
    active.runtimeSettingsEventId !== undefined
  ) {
    return active.runtimeSettings;
  }
  const baseline = captureRuntimeSettings(active);
  commitDurableRuntimeSettingsChange(active, runId, baseline, "initial");
  return active.runtimeSettings!;
}

function failClosedRuntimeSettingsAuthority(
  active: ActiveBackgroundAgent,
  runId: string,
  error: unknown,
): never {
  return failClosedDaemonRuntimeAuthority(active, error, {
    brokerReason: "daemon runtime-settings authority is ambiguous",
    abortReason: "permission_authority_failure",
    abortFailureMessage: `run ${runId} runtime-settings authority failed and session abort was incomplete`,
  });
}

function compensateRuntimeSettingsChange(
  active: ActiveBackgroundAgent,
  runId: string,
  previous: RunRuntimeSettingsSnapshot,
  failedSettingsEventId: string,
): void {
  try {
    if (active.runtimeSettingsEventId !== failedSettingsEventId) {
      throw new Error(
        `run ${runId} settings compensation no longer follows ${failedSettingsEventId}`,
      );
    }
    commitDurableRuntimeSettingsChange(
      active,
      runId,
      previous,
      "compensating_rollback",
      failedSettingsEventId,
    );
  } catch (error) {
    failClosedRuntimeSettingsAuthority(active, runId, error);
  }
}

function compensatePreparedRuntimeSettingsChange(
  active: ActiveBackgroundAgent,
  runId: string,
  previous: RunRuntimeSettingsSnapshot,
  failed: PreparedRuntimeSettingsChange,
): void {
  try {
    if (active.runtimeSettingsEventId !== failed.previousSettingsEventId) {
      throw new Error(
        `run ${runId} settings compensation no longer follows ${failed.eventId}`,
      );
    }
    const compensation = prepareDurableRuntimeSettingsChange(
      active,
      runId,
      previous,
      "compensating_rollback",
      failed.eventId,
      failed.eventId,
    );
    projectDurableRuntimeSettingsEvent(active, failed.event);
    compensation.finalize();
  } catch (error) {
    projectDurableRuntimeSettingsEvent(active, failed.event);
    failClosedRuntimeSettingsAuthority(active, runId, error);
  }
}

async function applyRestoredRuntimeSettings(
  bootstrap: LocalRuntimeBootstrap,
  settings: RunRuntimeSettingsSnapshot,
): Promise<RunRuntimeSettingsSnapshot> {
  const workspaceRoot = canonicalizeBypassPermissionsCwd(
    runtimeWorkspaceRoot(bootstrap),
  );
  assertValidRuntimeSettingsSnapshot(settings, workspaceRoot);
  const bypassTransitionCritical =
    settings.permissionMode === "bypassPermissions" ||
    (settings.permissionMode === "plan" &&
      settings.prePlanMode === "bypassPermissions");
  if (
    (bypassTransitionCritical &&
      settings.bypassPermissionsWorkspace !== workspaceRoot) ||
    (!bypassTransitionCritical && settings.bypassPermissionsWorkspace !== null)
  ) {
    throw new Error(
      "canonical bypass permission workspace does not match restored workspace",
    );
  }
  const session = bootstrap.session;
  const registry = session.permissionModeRegistry;
  const current = registry.current();
  const bypassDisabledByPolicy =
    current.bypassPermissionsModeDisabledByPolicy === true;
  const [persistedBypassConsent] = loadBypassPermissionsConsent(
    bootstrap.configStore.stateRepository,
    workspaceRoot,
    { reload: true },
  );
  const hasCurrentDurableBypassConsent =
    persistedBypassConsent === workspaceRoot;
  const autoModeAvailable =
    settings.autoModeAvailable && current.isAutoModeAvailable === true;
  const retainedConsent =
    !bypassDisabledByPolicy &&
    settings.bypassPermissionsModeAvailable &&
    settings.bypassPermissionsConsentWorkspace === workspaceRoot &&
    hasCurrentDurableBypassConsent;
  const bypassModeAvailable =
    !bypassDisabledByPolicy &&
    (current.isBypassPermissionsModeAvailable === true || retainedConsent);
  let transitionContext: ToolPermissionContext = {
    ...current,
    isAutoModeAvailable: autoModeAvailable,
    isBypassPermissionsModeAvailable: bypassModeAvailable,
    bypassPermissionsAcceptedIn: retainedConsent ? [workspaceRoot] : [],
  };
  if (bypassTransitionCritical) {
    if (bypassDisabledByPolicy) {
      throw new Error(
        "restored bypass permission mode is disabled by managed policy",
      );
    }
    if (!hasCurrentDurableBypassConsent) {
      throw new Error(
        "restored bypass permission mode requires persisted exact-cwd consent",
      );
    }
    transitionContext = authorizeBypassPermissionsConsent(
      {
        ...transitionContext,
        isBypassPermissionsModeAvailable: false,
        bypassPermissionsAcceptedIn: [],
      },
      persistedBypassConsent,
    );
  }
  let transitioned = runWithCurrentRuntimeSession(session, () =>
    settings.permissionMode === "bypassPermissions"
      ? transitionPermissionMode(
          transitionContext.mode,
          settings.permissionMode,
          transitionContext,
          { workspacePath: workspaceRoot },
        )
      : transitionPermissionMode(
          transitionContext.mode,
          settings.permissionMode,
          transitionContext,
        ),
  );
  if ("error" in transitioned) {
    throw new Error(
      "restored bypass permission mode lacks exact canonical workspace consent",
    );
  }
  const bypassAccepted =
    bypassTransitionCritical || retainedConsent ? [workspaceRoot] : [];
  transitioned = {
    ...transitioned,
    mode: settings.permissionMode,
    ...(settings.permissionMode === "plan"
      ? { prePlanMode: settings.prePlanMode ?? "default" }
      : { prePlanMode: undefined }),
    autoModeActive: settings.autoModeActive,
    isAutoModeAvailable: autoModeAvailable,
    isBypassPermissionsModeAvailable: bypassModeAvailable,
    bypassPermissionsAcceptedIn: bypassAccepted,
  };
  await registry.update(transitioned);

  const liveSelection = readSessionSelection(session);
  if (
    liveSelection.provider !== settings.provider ||
    liveSelection.model !== settings.model ||
    settings.profile !== null
  ) {
    session.setPendingProviderSwitch({
      provider: settings.provider,
      model: settings.model,
      ...(settings.profile !== null ? { profile: settings.profile } : {}),
    });
  }
  await session.state.with((state) => {
    const configuration = state.sessionConfiguration;
    state.sessionConfiguration = {
      ...configuration,
      collaborationMode: {
        ...configuration.collaborationMode,
        ...(settings.reasoningEffort !== null
          ? { reasoningEffort: settings.reasoningEffort }
          : { reasoningEffort: undefined }),
      } as typeof configuration.collaborationMode,
      ...(settings.modelVerbosity !== null
        ? { modelVerbosity: settings.modelVerbosity }
        : { modelVerbosity: undefined }),
      ...(settings.serviceTier !== null
        ? { serviceTier: settings.serviceTier }
        : { serviceTier: undefined }),
    };
  });
  session.services?.hooksRuntime?.setDisabled(settings.hooksDisabled);
  return cloneFrozenRuntimeSettingsSnapshot({
    ...settings,
    autoModeAvailable,
    bypassPermissionsModeAvailable: bypassModeAvailable,
    bypassPermissionsConsentWorkspace: retainedConsent ? workspaceRoot : null,
  });
}

function currentCanonicalRuntimeStateFromRollout(
  bootstrap: LocalRuntimeBootstrap,
  runId: string,
): {
  readonly pendingStartupActivationResumeEventId?: string;
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
  readonly runtimeSettingsEventId?: string;
} {
  const epoch = currentRunEpochFromRollout(bootstrap, runId);
  let pendingStartupActivationResumeEventId: string | undefined;
  let runtimeSettings: RunRuntimeSettingsSnapshot | undefined;
  let runtimeSettingsEventId: string | undefined;
  for (const item of bootstrap.rolloutStore.readAll()) {
    if (item.type !== "event_msg") continue;
    const event = item.payload;
    const payload = event.msg.payload as { runId?: unknown; epoch?: unknown };
    if (payload.runId !== runId) continue;
    if (
      event.msg.type === "run_runtime_settings_changed" &&
      typeof payload.epoch === "number" &&
      payload.epoch <= epoch
    ) {
      runtimeSettings = runtimeSettingsSnapshotFromCanonicalEvent(event);
      runtimeSettingsEventId = canonicalEventId(event);
    }
    if (payload.epoch !== epoch) continue;
    if (event.msg.type === "run_resumed") {
      pendingStartupActivationResumeEventId = canonicalEventId(event);
    } else if (event.msg.type === "run_startup_activated") {
      if (
        event.msg.payload.resumeEventId ===
        pendingStartupActivationResumeEventId
      ) {
        pendingStartupActivationResumeEventId = undefined;
      }
    } else if (
      event.msg.type === "run_suspended" ||
      event.msg.type === "run_terminal"
    ) {
      pendingStartupActivationResumeEventId = undefined;
    }
  }
  return {
    ...(pendingStartupActivationResumeEventId !== undefined
      ? { pendingStartupActivationResumeEventId }
      : {}),
    ...(runtimeSettings !== undefined ? { runtimeSettings } : {}),
    ...(runtimeSettingsEventId !== undefined ? { runtimeSettingsEventId } : {}),
  };
}

function runtimeSettingsSnapshotFromCanonicalEvent(
  event: Event,
): RunRuntimeSettingsSnapshot {
  if (event.msg.type !== "run_runtime_settings_changed") {
    throw new Error("expected canonical runtime settings event");
  }
  const payload = event.msg.payload;
  return cloneFrozenRuntimeSettingsSnapshot({
    permissionMode: payload.permissionMode,
    prePlanMode: payload.prePlanMode,
    autoModeActive: payload.autoModeActive,
    autoModeAvailable: payload.autoModeAvailable,
    bypassPermissionsModeAvailable: payload.bypassPermissionsModeAvailable,
    bypassPermissionsWorkspace: payload.bypassPermissionsWorkspace,
    bypassPermissionsConsentWorkspace:
      payload.bypassPermissionsConsentWorkspace,
    model: payload.model,
    provider: payload.provider,
    profile: payload.profile,
    reasoningEffort: payload.reasoningEffort,
    modelVerbosity: payload.modelVerbosity,
    serviceTier: payload.serviceTier,
    hooksDisabled: payload.hooksDisabled,
  });
}

function commitDurableRuntimeSettingsChange(
  active: ActiveBackgroundAgent,
  runId: string,
  settings: RunRuntimeSettingsSnapshot,
  reason: RunRuntimeSettingsChangeReason,
  rollbackOfSettingsEventId: string | null = null,
): void {
  prepareDurableRuntimeSettingsChange(
    active,
    runId,
    settings,
    reason,
    rollbackOfSettingsEventId,
  ).finalize();
}

interface PreparedRuntimeSettingsChange {
  readonly event: Event;
  readonly eventId: string;
  readonly previousSettingsEventId: string | null;
  finalize(): void;
}

function prepareDurableRuntimeSettingsChange(
  active: ActiveBackgroundAgent,
  runId: string,
  settings: RunRuntimeSettingsSnapshot,
  reason: RunRuntimeSettingsChangeReason,
  rollbackOfSettingsEventId: string | null = null,
  preparedPredecessorEventId?: string,
): PreparedRuntimeSettingsChange {
  if (!supportsCanonicalRuntimeSettings(active)) {
    throw new Error(
      `run ${runId} cannot change runtime settings without canonical journal support`,
    );
  }
  const canonicalSettings = cloneFrozenRuntimeSettingsSnapshot(settings);
  assertValidRuntimeSettingsSnapshot(
    canonicalSettings,
    runtimeWorkspaceRoot(active.bootstrap),
  );
  const epoch = active.runEpoch;
  const previousSettingsEventId =
    preparedPredecessorEventId ?? active.runtimeSettingsEventId ?? null;
  if (
    preparedPredecessorEventId !== undefined &&
    (reason !== "compensating_rollback" ||
      rollbackOfSettingsEventId !== preparedPredecessorEventId)
  ) {
    throw new Error(
      `run ${runId} prepared predecessor is only valid for its compensation`,
    );
  }
  if (previousSettingsEventId === null && reason !== "initial") {
    throw new Error(
      `run ${runId} must establish initial runtime settings before ${reason}`,
    );
  }
  if (previousSettingsEventId !== null && reason === "initial") {
    throw new Error(`run ${runId} already has initial runtime settings`);
  }
  const eventId = `run-runtime-settings:${runId}:${epoch}:${randomUUID()}`;
  const changedAt = new Date().toISOString();
  const acceptCommitted = (proveDurable: boolean): Event | undefined => {
    const matches = active.bootstrap.rolloutStore
      .readAll()
      .flatMap((item) =>
        item.type === "event_msg" &&
        (item.payload.eventId === eventId || item.payload.id === eventId)
          ? [item.payload]
          : [],
      );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(`runtime settings ${eventId} has duplicate evidence`);
    }
    const event = matches[0]!;
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      positiveSequence(event.seq) === undefined ||
      event.msg.type !== "run_runtime_settings_changed" ||
      event.msg.payload.runId !== runId ||
      event.msg.payload.epoch !== epoch ||
      event.msg.payload.previousSettingsEventId !== previousSettingsEventId ||
      event.msg.payload.rollbackOfSettingsEventId !==
        rollbackOfSettingsEventId ||
      event.msg.payload.reason !== reason ||
      event.msg.payload.changedAt !== changedAt ||
      stableStringify(runtimeSettingsSnapshotFromCanonicalEvent(event)) !==
        stableStringify(canonicalSettings)
    ) {
      throw new Error(`runtime settings ${eventId} has conflicting evidence`);
    }
    if (proveDurable) {
      active.bootstrap.rolloutStore.syncCanonicalTail();
      return acceptCommitted(false);
    }
    return event;
  };
  let event: Event;
  let publish: () => Event;
  try {
    const candidate = {
      eventId,
      id: eventId,
      msg: {
        type: "run_runtime_settings_changed",
        payload: {
          runId,
          epoch,
          previousSettingsEventId,
          rollbackOfSettingsEventId,
          reason,
          changedAt,
          ...canonicalSettings,
        },
      },
    } satisfies Event;
    const prepared = active.bootstrap.session.prepareEmit(candidate);
    event = prepared.event;
    publish = prepared.publish;
  } catch (error) {
    let recovered: Event | undefined;
    try {
      recovered = acceptCommitted(true);
    } catch (evidenceError) {
      failClosedRuntimeSettingsAuthority(
        active,
        runId,
        new AggregateError(
          [error, evidenceError],
          `runtime settings ${eventId} preparation failed after an ambiguous canonical append`,
          { cause: error },
        ),
      );
    }
    if (recovered === undefined) throw error;
    event = recovered;
    publish = () => active.bootstrap.session.publishPreparedEvent(recovered);
  }
  if (event.eventId !== eventId || positiveSequence(event.seq) === undefined) {
    throw new Error(`runtime settings ${eventId} lacks canonical coordinates`);
  }
  let finalized = false;
  return {
    event,
    eventId,
    previousSettingsEventId,
    finalize: () => {
      if (finalized) return;
      finalized = true;
      active.runtimeSettings = canonicalSettings;
      active.runtimeSettingsEventId = eventId;
      try {
        publish();
      } catch (publishError) {
        let failure: unknown = publishError;
        try {
          const committed = acceptCommitted(true);
          if (committed === undefined) {
            throw new Error(
              `runtime settings ${eventId} publication failed without canonical evidence`,
            );
          }
          projectDurableRuntimeSettingsEvent(active, committed);
        } catch (evidenceError) {
          failure = new AggregateError(
            [publishError, evidenceError],
            `runtime settings ${eventId} publication failed and canonical evidence could not be proved`,
            { cause: publishError },
          );
        }
        failClosedRuntimeSettingsAuthority(active, runId, failure);
      }
      projectDurableRuntimeSettingsEvent(active, event);
    },
  };
}

function projectDurableRuntimeSettingsEvent(
  active: ActiveBackgroundAgent,
  event: Event,
): void {
  try {
    active.bootstrap.rolloutStore.recordRunRuntimeSettingsEvent(event);
  } catch {
    // Canonical fsync evidence is authoritative; SQLite is rebuildable.
  }
}

function assertValidRuntimeSettingsSnapshot(
  settings: RunRuntimeSettingsSnapshot,
  workspaceRoot: string,
): void {
  const bounded = (value: string, maxBytes: number): boolean =>
    value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
  const nullableBounded = (value: string | null, maxBytes: number): boolean =>
    value === null || bounded(value, maxBytes);
  const bypassTransitionCritical =
    settings.permissionMode === "bypassPermissions" ||
    settings.prePlanMode === "bypassPermissions";
  const hasExactBypassConsent =
    settings.bypassPermissionsConsentWorkspace === workspaceRoot;
  let providerModelIsCanonical = false;
  try {
    const selection = mergeProviderModelLayer(
      {},
      {
        model_provider: settings.provider,
        model: settings.model,
      },
    );
    providerModelIsCanonical =
      selection.model_provider === settings.provider &&
      selection.model === settings.model;
  } catch {
    providerModelIsCanonical = false;
  }
  if (
    !RUN_RUNTIME_PERMISSION_MODES.includes(settings.permissionMode) ||
    (settings.prePlanMode !== null &&
      !RUN_RUNTIME_PERMISSION_MODES.includes(settings.prePlanMode)) ||
    (settings.permissionMode === "plan"
      ? settings.prePlanMode === null || settings.prePlanMode === "plan"
      : settings.prePlanMode !== null) ||
    (settings.permissionMode === "auto"
      ? settings.autoModeActive !== true
      : settings.permissionMode !== "plan" &&
        settings.autoModeActive !== false) ||
    typeof settings.autoModeAvailable !== "boolean" ||
    (settings.autoModeActive && !settings.autoModeAvailable) ||
    typeof settings.bypassPermissionsModeAvailable !== "boolean" ||
    (settings.bypassPermissionsConsentWorkspace !== null &&
      !hasExactBypassConsent) ||
    (hasExactBypassConsent && !settings.bypassPermissionsModeAvailable) ||
    (bypassTransitionCritical
      ? settings.bypassPermissionsWorkspace !== workspaceRoot ||
        !settings.bypassPermissionsModeAvailable ||
        !hasExactBypassConsent
      : settings.bypassPermissionsWorkspace !== null) ||
    !bounded(settings.model, 1_024) ||
    !bounded(settings.provider, 256) ||
    !providerModelIsCanonical ||
    !nullableBounded(settings.profile, 256) ||
    (settings.reasoningEffort !== null &&
      !RUN_RUNTIME_REASONING_EFFORTS.includes(settings.reasoningEffort)) ||
    (settings.modelVerbosity !== null &&
      !RUN_RUNTIME_MODEL_VERBOSITIES.includes(settings.modelVerbosity)) ||
    (settings.serviceTier !== null &&
      !RUN_RUNTIME_SERVICE_TIERS.includes(settings.serviceTier)) ||
    typeof settings.hooksDisabled !== "boolean"
  ) {
    throw new Error("runtime settings snapshot is not canonically valid");
  }
}

function commitDurableRunStartupActivation(
  active: ActiveBackgroundAgent,
  runId: string,
  activatedAt: string,
): void {
  const resumeEventId = active.pendingStartupActivationResumeEventId;
  if (resumeEventId === undefined) return;
  const exactActivatedAt =
    active.pendingStartupActivationActivatedAt ?? activatedAt;
  active.pendingStartupActivationActivatedAt = exactActivatedAt;
  const epoch = active.runEpoch;
  const resumeHash = createHash("sha256")
    .update(resumeEventId, "utf8")
    .digest("hex")
    .slice(0, 32);
  const eventId = `run-startup-activated:${runId}:${epoch}:${resumeHash}`;
  const acceptCommitted = (proveDurable: boolean): Event | undefined => {
    const matches = active.bootstrap.rolloutStore
      .readAll()
      .flatMap((item) =>
        item.type === "event_msg" &&
        (item.payload.eventId === eventId || item.payload.id === eventId)
          ? [item.payload]
          : [],
      );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(`startup activation ${eventId} has duplicate evidence`);
    }
    const event = matches[0]!;
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      positiveSequence(event.seq) === undefined ||
      event.msg.type !== "run_startup_activated" ||
      event.msg.payload.runId !== runId ||
      event.msg.payload.epoch !== epoch ||
      event.msg.payload.resumeEventId !== resumeEventId ||
      event.msg.payload.activatedAt !== exactActivatedAt
    ) {
      throw new Error(`startup activation ${eventId} has conflicting evidence`);
    }
    if (proveDurable) {
      active.bootstrap.rolloutStore.syncCanonicalTail();
      return acceptCommitted(false);
    }
    return event;
  };
  let event: Event;
  try {
    event = active.bootstrap.session.emit({
      eventId,
      id: eventId,
      msg: {
        type: "run_startup_activated",
        payload: {
          runId,
          epoch,
          resumeEventId,
          activatedAt: exactActivatedAt,
        },
      },
    });
  } catch (error) {
    const recovered = acceptCommitted(true);
    if (recovered === undefined) throw error;
    event = recovered;
  }
  if (event.eventId !== eventId || positiveSequence(event.seq) === undefined) {
    throw new Error(
      `startup activation ${eventId} lacks canonical coordinates`,
    );
  }
  try {
    active.bootstrap.rolloutStore.recordRunStartupActivationEvent(event);
  } catch {
    // Canonical fsync evidence is authoritative; SQLite is rebuildable.
  }
  active.pendingStartupActivationResumeEventId = undefined;
  active.pendingStartupActivationActivatedAt = undefined;
}

function awaitTerminalStatus(
  thread: ManagedThread,
): Promise<TerminalThreadStatus> {
  return new Promise((resolve) => {
    let settledSynchronously = false;
    let unsubscribe = (): void => {};
    const listener = (status: ThreadAgentStatus): void => {
      if (
        status.status === "completed" ||
        status.status === "errored" ||
        status.status === "shutdown" ||
        status.status === "not_found"
      ) {
        settledSynchronously = true;
        unsubscribe();
        resolve(status);
      }
    };
    unsubscribe = thread.subscribeStatus(listener);
    // ManagedThread subscriptions publish their current value immediately.
    // If it was already terminal, the callback ran before the real
    // unsubscribe function was assigned.
    if (settledSynchronously) unsubscribe();
  });
}

function commitDurableRunCancellationRequest(
  active: ActiveBackgroundAgent,
  runId: string,
  reason: string,
): void {
  const requestedAt = active.pendingTerminal?.finishedAt ?? active.lastActiveAt;
  const existing = active.cancellationRequest;
  if (existing !== undefined) {
    if (existing.reason !== reason || existing.requestedAt !== requestedAt) {
      throw new Error(`run ${runId} has conflicting cancellation intent`);
    }
    return;
  }
  const eventId = `run-cancel-request:${runId}:${active.runEpoch}`;
  const acceptCommitted = (proveDurable = false): boolean => {
    const matches = active.bootstrap.rolloutStore.readAll().flatMap((item) => {
      if (item.type !== "event_msg") return [];
      const event = item.payload;
      if (
        event.eventId !== eventId &&
        event.id !== eventId &&
        !(
          event.msg.type === "run_cancel_requested" &&
          event.msg.payload.runId === runId &&
          event.msg.payload.epoch === active.runEpoch
        )
      ) {
        return [];
      }
      return [event];
    });
    if (matches.length === 0) return false;
    if (matches.length !== 1) {
      throw new Error(
        `run cancellation request ${eventId} has duplicate canonical evidence`,
      );
    }
    const event = matches[0]!;
    const sequence = positiveSequence(event.seq);
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      sequence === undefined ||
      event.msg.type !== "run_cancel_requested" ||
      event.msg.payload.runId !== runId ||
      event.msg.payload.epoch !== active.runEpoch ||
      event.msg.payload.reason !== reason ||
      event.msg.payload.requestedAt !== requestedAt
    ) {
      throw new Error(
        `run cancellation request ${eventId} has conflicting canonical evidence`,
      );
    }
    if (proveDurable) {
      active.bootstrap.rolloutStore.syncCanonicalTail();
      return acceptCommitted(false);
    }
    active.cancellationRequest = {
      eventId,
      sequence,
      reason,
      requestedAt,
    };
    return true;
  };
  if (acceptCommitted(true)) return;
  try {
    const event = active.bootstrap.session.emit({
      eventId,
      id: eventId,
      msg: {
        type: "run_cancel_requested",
        payload: {
          runId,
          epoch: active.runEpoch,
          reason,
          requestedAt,
        },
      },
    });
    const sequence = positiveSequence(event.seq);
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      sequence === undefined
    ) {
      throw new Error(
        `run cancellation request ${eventId} has no canonical coordinates`,
      );
    }
    active.cancellationRequest = {
      eventId,
      sequence,
      reason,
      requestedAt,
    };
  } catch (error) {
    // Session.emit may fail after append+fsync at the publish failpoint. The
    // deterministic identity makes retry safe only when the bytes on disk are
    // exactly the requested cancellation evidence.
    if (!acceptCommitted(true)) throw error;
  }
}

function commitDurableRunTerminal(
  active: ActiveBackgroundAgent,
  runId: string,
  result: RunTerminalResult,
): AgenCBackgroundAgentTerminalSnapshot {
  if (active.terminal !== undefined) return active.terminal;
  const epoch = active.runEpoch;
  const session = active.bootstrap.session;
  const lastSequenceBeforeTerminal =
    positiveSequence(session.eventLog.lastSeq) ?? null;
  const eventId = `run-terminal:${runId}:${epoch}`;
  const event = session.emit({
    eventId,
    id: eventId,
    msg: {
      type: "run_terminal",
      payload: {
        runId,
        epoch,
        status: result.status,
        exitCode: result.exitCode,
        stopReason: result.stopReason,
        finalMessage: result.finalMessage,
        usage: result.usage,
        lastSequenceBeforeTerminal,
        finishedAt: result.finishedAt,
      },
    },
  });
  const sequence = positiveSequence(event.seq);
  if (
    event.id !== eventId ||
    event.eventId !== eventId ||
    sequence === undefined
  ) {
    throw new Error(
      `run_terminal ${eventId} was not assigned its canonical id and positive sequence`,
    );
  }
  const terminal: AgenCBackgroundAgentTerminalSnapshot = {
    openedAt: active.startedAt,
    epoch,
    eventId: event.eventId,
    rolloutPath: active.bootstrap.rolloutStore.rolloutPath,
    result: {
      ...result,
      lastSequence: sequence,
    },
  };
  active.terminal = terminal;
  return terminal;
}

function commitDurableRunSuspension(
  active: ActiveBackgroundAgent,
  runId: string,
): AgenCBackgroundAgentSuspensionSnapshot {
  if (active.suspension !== undefined) return active.suspension;
  const pending = active.pendingSuspension;
  if (pending === undefined) {
    throw new Error(`run ${runId} has no daemon suspension pending`);
  }
  const epoch = active.runEpoch;
  const eventId = pending.eventId;

  const acceptCommitted = (
    proveDurable = false,
  ): AgenCBackgroundAgentSuspensionSnapshot | undefined => {
    const matches = active.bootstrap.rolloutStore.readAll().flatMap((item) => {
      if (item.type !== "event_msg") return [];
      const event = item.payload;
      if (event.eventId !== eventId && event.id !== eventId) {
        return [];
      }
      if (
        event.msg.type !== "run_suspended" ||
        event.msg.payload.runId !== runId ||
        event.msg.payload.epoch !== epoch
      ) {
        return [];
      }
      return [event];
    });
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(
        `run suspension ${eventId} has duplicate canonical evidence`,
      );
    }
    const event = matches[0]!;
    const sequence = positiveSequence(event.seq);
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      sequence === undefined ||
      event.msg.type !== "run_suspended" ||
      event.msg.payload.reason !== pending.reason ||
      event.msg.payload.suspendedAt !== pending.suspendedAt
    ) {
      throw new Error(
        `run suspension ${eventId} has conflicting canonical evidence`,
      );
    }
    if (proveDurable) {
      active.bootstrap.rolloutStore.syncCanonicalTail();
      return acceptCommitted(false);
    }
    const suspension: AgenCBackgroundAgentSuspensionSnapshot = {
      openedAt: active.startedAt,
      epoch,
      eventId,
      sequence,
      rolloutPath: active.bootstrap.rolloutStore.rolloutPath,
      reason: pending.reason,
      suspendedAt: pending.suspendedAt,
    };
    active.suspension = suspension;
    try {
      active.bootstrap.rolloutStore.recordRunSuspensionEvent(event);
    } catch {
      // SQLite is a rebuildable projection. Canonical fsync evidence remains
      // authoritative and startup recovery will replay this boundary.
    }
    return suspension;
  };

  const committed = acceptCommitted(true);
  if (committed !== undefined) return committed;
  try {
    const event = active.bootstrap.session.emit({
      eventId,
      id: eventId,
      msg: {
        type: "run_suspended",
        payload: {
          runId,
          epoch,
          reason: pending.reason,
          suspendedAt: pending.suspendedAt,
        },
      },
    });
    const sequence = positiveSequence(event.seq);
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      sequence === undefined
    ) {
      throw new Error(
        `run_suspended ${eventId} was not assigned canonical coordinates`,
      );
    }
    const suspension: AgenCBackgroundAgentSuspensionSnapshot = {
      openedAt: active.startedAt,
      epoch,
      eventId,
      sequence,
      rolloutPath: active.bootstrap.rolloutStore.rolloutPath,
      reason: pending.reason,
      suspendedAt: pending.suspendedAt,
    };
    active.suspension = suspension;
    try {
      active.bootstrap.rolloutStore.recordRunSuspensionEvent(event);
    } catch {
      // Rebuildable projection; the fsync-committed event is authoritative.
    }
    return suspension;
  } catch (error) {
    const recovered = acceptCommitted(true);
    if (recovered !== undefined) return recovered;
    throw error;
  }
}

function cancelledTerminalResult(
  active: ActiveBackgroundAgent,
  runId: string,
  stopReason: string,
  finishedAt: string,
): RunTerminalResult {
  return {
    runId,
    status: "cancelled",
    exitCode: null,
    stopReason,
    finalMessage: null,
    usage: terminalUsageForActiveAgent(active),
    lastSequence: null,
    finishedAt,
  };
}

function currentRunEpochFromRollout(
  bootstrap: LocalRuntimeBootstrap,
  runId: string,
): number {
  let epoch = 1;
  try {
    const items = bootstrap.rolloutStore.readAll() as ReadonlyArray<{
      readonly type?: unknown;
      readonly payload?: {
        readonly msg?: {
          readonly type?: unknown;
          readonly payload?: {
            readonly runId?: unknown;
            readonly epoch?: unknown;
          };
        };
      };
    }>;
    for (const item of items) {
      if (
        item.type !== "event_msg" ||
        item.payload?.msg?.type !== "run_reopened" ||
        item.payload.msg.payload?.runId !== runId
      ) {
        continue;
      }
      const reopenedEpoch = positiveSequence(item.payload.msg.payload.epoch);
      if (reopenedEpoch !== undefined && reopenedEpoch > epoch) {
        epoch = reopenedEpoch;
      }
    }
  } catch {
    // A new run has no reopen record. Read failures are surfaced when the
    // terminal append itself tries to commit; epoch 1 is the only safe default.
  }
  return epoch;
}

function terminalResultFromThread(
  active: ActiveBackgroundAgent,
  runId: string,
  status: TerminalThreadStatus,
): RunTerminalResult {
  const usage = terminalUsageForActiveAgent(active);
  const finishedAt =
    "endedAtMs" in status && Number.isFinite(status.endedAtMs)
      ? new Date(status.endedAtMs).toISOString()
      : active.lastActiveAt;
  if (status.status === "completed") {
    return {
      runId,
      status: "completed",
      exitCode: 0,
      stopReason: "turn_completed",
      finalMessage: status.lastMessage ?? null,
      usage,
      lastSequence: null,
      finishedAt,
    };
  }
  if (status.status === "errored") {
    return {
      runId,
      status: "failed",
      exitCode: 1,
      stopReason: status.error,
      finalMessage: null,
      usage,
      lastSequence: null,
      finishedAt,
    };
  }
  return {
    runId,
    status: "cancelled",
    exitCode: null,
    stopReason: status.status === "shutdown" ? "shutdown" : "not_found",
    finalMessage: null,
    usage,
    lastSequence: null,
    finishedAt,
  };
}

function mapThreadStatus(status: ThreadAgentStatus): DaemonAgentStatus {
  switch (status.status) {
    case "completed":
    case "not_found":
    case "shutdown":
      return "stopped";
    case "interrupted":
    case "idle":
      return "idle";
    case "errored":
      return "error";
    case "pending_init":
    case "running":
      return "running";
  }
}

function eventFromThreadStatus(
  status: ThreadAgentStatus,
): BackgroundAgentDaemonEvent | null {
  switch (status.status) {
    case "running":
      return {
        id: status.turnId,
        type: "turn_started",
        payload: {
          turnId: status.turnId,
          ...(status.startedAtMs !== undefined
            ? { startedAt: status.startedAtMs }
            : {}),
        },
      };
    case "completed":
      return {
        id: status.turnId,
        type: "turn_complete",
        payload: {
          turnId: status.turnId,
          ...(status.lastMessage !== undefined
            ? { lastAgentMessage: status.lastMessage }
            : {}),
          ...(status.endedAtMs !== undefined
            ? { completedAt: status.endedAtMs }
            : {}),
        },
      };
    case "idle":
      // Keep-alive worker between turns: surface a turn_complete so the daemon
      // flips the agent to idle/completed instead of leaving it "running"
      // forever. The id must be unique per transition (the keep-alive turnId is
      // constant across turns), so suffix the monotonic end timestamp.
      return {
        id: `idle-${status.turnId}-${status.endedAtMs}`,
        type: "turn_complete",
        payload: {
          turnId: status.turnId,
          completedAt: status.endedAtMs,
        },
      };
    case "errored":
      return {
        id: status.turnId,
        type: "error",
        payload: {
          cause: "background_agent_error",
          message: status.error,
          turnId: status.turnId,
        },
      };
    case "interrupted":
      return {
        id: `interrupted-${status.turnId}`,
        type: "agent_status",
        payload: {
          status: "idle",
          runStatus: "completed",
          turnId: status.turnId,
          message: status.reason,
        },
      };
    case "shutdown":
      return {
        id: `shutdown-${status.endedAtMs}`,
        type: "agent_status",
        payload: {
          status: "stopped",
          runStatus: "stopped",
          message: "shutdown",
        },
      };
    case "not_found":
      return {
        id: "not-found",
        type: "agent_status",
        payload: {
          status: "stopped",
          runStatus: "stopped",
          message: "not_found",
        },
      };
    case "pending_init":
      return null;
  }
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

function messageContentToAgentInput(
  content: MessageContent,
): string | readonly LLMContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return { type: "image_url", image_url: { url: part.image_url.url } };
  });
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

async function submitStructuredAgentInput(
  active: ActiveBackgroundAgent,
  input: readonly LLMContentPart[],
  _displayText: string,
  submitOptions?: SessionSubmitOptions,
): Promise<void> {
  try {
    await active.thread.submit({
      type: "user_input",
      input,
      ...(submitOptions !== undefined ? { submitOptions } : {}),
    });
  } catch (error) {
    if (error instanceof MailboxClosedError) {
      throw new Error(
        `AgenC daemon agent not running: ${active.thread.threadId}`,
      );
    }
    throw error;
  }
}

function messageContentDisplayText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function interruptedToolResultContent(callId: string, reason: string): string {
  return JSON.stringify({
    tool_use_id: callId,
    is_error: true,
    content: `<tool_use_error>user interrupted - ${reason}</tool_use_error>`,
  });
}

function hashStable(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function resolvePermissionDecisionTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.AGENC_PERMISSION_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readApprovalAgentId(ctx: ApprovalCtx): string | null {
  const session = ctx.invocation.session as { conversationId?: unknown };
  return typeof session.conversationId === "string" &&
    session.conversationId.length > 0
    ? session.conversationId
    : null;
}

/**
 * For an ExitPlanMode approval, enrich the request_permissions payload with the
 * plan content and path so the TUI overlay can render the plan being approved.
 * Falls back to the tool input's `plan` string when the on-disk plan is empty.
 * Returns an empty object for any other tool.
 *
 * Exported (under a test-scoped name) so the enrichment can be unit-tested
 * directly with mocked getPlan/getPlanFilePath without bootstrapping an agent.
 */
export function planApprovalPayloadFields(
  toolName: string,
  agentId: string,
  input: JsonObject,
): JsonObject {
  if (toolName !== EXIT_PLAN_MODE_TOOL_NAME) return {};
  const fields: Record<string, JsonValue> = {};
  const agent = agentId as AgentId;
  let planContent: string | null = null;
  try {
    planContent = getPlan(agent);
  } catch {
    planContent = null;
  }
  if (
    (planContent === null || planContent.length === 0) &&
    typeof input.plan === "string" &&
    input.plan.length > 0
  ) {
    planContent = input.plan;
  }
  if (typeof planContent === "string" && planContent.length > 0) {
    fields.planContent = planContent;
  }
  let planFilePath: string | undefined;
  try {
    planFilePath = getPlanFilePath(agent);
  } catch {
    planFilePath = undefined;
  }
  if (typeof planFilePath === "string" && planFilePath.length > 0) {
    fields.planFilePath = planFilePath;
  }
  return fields;
}

function restoreBootstrapSelection(params: AgenCBackgroundAgentRestoreParams): {
  readonly provider?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
} {
  const canonical = params.runtimeSettings;
  if (canonical === undefined) return params;
  return {
    provider: canonical.provider,
    model: canonical.model,
    ...(canonical.profile !== null ? { profile: canonical.profile } : {}),
    ...(params.configPath !== undefined
      ? { configPath: params.configPath }
      : {}),
  };
}

function runtimeSettingsWithRestoreOverrides(
  canonical: RunRuntimeSettingsSnapshot,
  params: AgenCBackgroundAgentRestoreParams,
  workspaceRoot: string,
  config: AgenCConfig,
): RunRuntimeSettingsSnapshot {
  const permissionMode = params.permissionMode ?? canonical.permissionMode;
  const permissionChanged = permissionMode !== canonical.permissionMode;
  const prePlanMode =
    permissionMode === "plan"
      ? permissionChanged
        ? canonical.permissionMode
        : canonical.prePlanMode
      : null;
  const bypassTransitionCritical =
    permissionMode === "bypassPermissions" ||
    prePlanMode === "bypassPermissions";
  const resolvedSelection = resolveProviderModelSelection(
    config,
    { provider: canonical.provider, model: canonical.model },
    {
      ...(params.provider !== undefined
        ? { model_provider: params.provider }
        : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
    },
  );
  return {
    ...canonical,
    permissionMode,
    prePlanMode,
    autoModeActive:
      permissionMode === "auto"
        ? true
        : permissionMode === "plan" && !permissionChanged
          ? canonical.autoModeActive
          : false,
    bypassPermissionsWorkspace: bypassTransitionCritical ? workspaceRoot : null,
    model: resolvedSelection.model,
    provider: resolvedSelection.provider,
    profile: params.profile ?? canonical.profile,
  };
}

function buildBootstrapArgv(
  params: {
    readonly provider?: string;
    readonly model?: string;
    readonly profile?: string;
    readonly configPath?: string;
    readonly permissionMode?:
      | "default"
      | "plan"
      | "acceptEdits"
      | "bypassPermissions"
      | "dontAsk"
      | "auto";
  },
  executableArgv: readonly string[] | undefined,
): readonly string[] {
  return buildStructuredSessionBootstrapArgv(
    params,
    executableArgv ?? [process.execPath, process.argv[1] ?? "agenc"],
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

async function installUnattendedPermissionPolicy(
  registry: PermissionModeRegistry,
  allow: readonly string[] | undefined,
  deny: readonly string[] | undefined,
): Promise<void> {
  const next = applyUnattendedPermissionPolicyToContext(registry.current(), {
    ...(allow !== undefined ? { allowlist: allow } : {}),
    ...(deny !== undefined ? { denylist: deny } : {}),
  });
  await registry.update(next);
}

// runRestoredAgentToCompletion / restoredAgentMetadata are retained for
// compatibility with the older fork-loop restore path while the live
// ManagedThread restore path handles replay directly above.
void [runRestoredAgentToCompletion, restoredAgentMetadata];

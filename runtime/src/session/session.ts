/**
 * Session — initialized model agent context.
 *
 * Hand-port of agenc runtime `core/src/session/session.rs` (852 LOC Rust)
 * per `docs/plan/agenc runtime-inventory.md §1` Session struct mapping table.
 * Every field of agenc runtime's `Session` struct has a TypeScript equivalent.
 * Session-facing subsystem contracts (ModelsManager, RolloutRecorder,
 * McpConnectionManager, AgentControl, etc.) are structural service
 * interfaces. Concrete implementations live in their owning runtime
 * modules and are injected through `SessionServices`.
 *
 * "A session has at most 1 running task at a time, and can be
 *  interrupted by user input." — agenc runtime doc-comment, session.rs:5
 *
 * Invariants enforced here:
 *   I-5  (bidirectional mailbox) — Session holds both `mailbox` (its own
 *        inbox) and `childInboxes: Map<threadId, Mailbox>` (per-child
 *        outbound mailboxes for parent→child Interrupt/Resume).
 *   I-7  (stream abort cascade) — `abortTerminal(reason)` signals the
 *        session-level AbortController; phases observe the cascade via
 *        `signal.aborted`.
 *   I-8  (every error site emits) — `emit()` is the single entry point;
 *        errors surface through `emit({type: 'error', ...})`.
 *   I-13 (mid-stream provider/model switch) — `pendingProviderSwitch`
 *        flag honored by run-turn at top-of-loop.
 *   I-27 (event-log FIFO + monotonic seq) — `emit()` assigns the next
 *        seq from `nextSeq` synchronously before any await.
 *   I-33 (async-child mailbox drain on shutdown) — `shutdown()` drains
 *        every `childInboxes` entry; bounded by I-87 timeout.
 *   I-87 (async-child drain timeout, MAX_DRAIN_MS=2000) — `shutdown()`
 *        races each drain against a 2s timeout.
 *
 * @module
 */

import {
  AsyncLock,
  AsyncQueue,
  BehaviorSubject,
  monotonicMs,
} from "./_deps/utils.js";
import type { MCPManager, MCPManagerStartOpts } from "../mcp-client/manager.js";
import {
  projectMcpManagerToConnections,
  type McpConnectionProjection,
  type McpManagerLike,
} from "../mcp-client/tui-connections.js";
import type { MCPServerConnection } from "../services/mcp/types.js";
import { ProviderHttpClient } from "../llm/client.js";
import { setContextWindowUpgradeContext } from "../llm/context-window-upgrade.js";
import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import type { LLMProvider } from "../llm/types.js";
import {
  buildPostCompactMessages,
  partialCompactConversationAsync,
} from "../services/compact/compact.js";
import type {
  CompactContext,
  CompactionResult,
  RuntimeMessage,
} from "../services/compact/types.js";
import type { PartialCompactDirection } from "../services/compact/prompt.js";
import {
  normalizeProviderName,
  normalizeManagedGatewayModel,
  prepareProviderSwitch,
  type ProviderFactoryOptions,
  type PreparedProviderSwitch,
  type ProviderName,
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../llm/provider.js";
import type { ProviderFallbackLadderOptions } from "../llm/api/fallback-ladder.js";
import type { AuthBackend, AuthSubscriptionTier } from "../auth/backend.js";
import { resolveAuthManagedKeysEnabled } from "../auth/selection.js";
import type { BudgetTracker } from "../conversation/token-budget.js";
import type { SessionSubmitOptions } from "./autonomous-mode.js";
import type { CostSidecar } from "./cost.js";
import type { ConfiguredHooksRuntime } from "../hooks/configured-hooks.js";
import type { UserPromptSubmitHook } from "../hooks/user-prompt-submit.js";
import type { ToolRegistry } from "./_deps/tool-registry.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { getAttachmentTrackingState } from "./attachment-state.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";
import type { QuerySource } from "./_deps/query-source.js";
import {
  freshDenialTracking,
  type DenialTrackingState,
} from "../permissions/denial-tracking.js";
import type { ConfigStore } from "../config/store.js";
import {
  resolveProviderSettings,
  type ResolvedProviderSettings,
} from "../config/resolve-provider.js";
import type {
  ApprovalResolver,
  PermissionRequestHook,
} from "../tools/orchestrator.js";
import type {
  PermissionAuditErrorHandler,
  PermissionAuditLogger,
} from "../permissions/permission-audit-log.js";
import {
  startMcpManagerForSession,
  type McpRefreshResult,
  type McpStartupCancellationToken,
} from "./mcp-startup.js";
import type { PendingWorktreeState } from "./pending-worktree.js";
import type { GuardianRejectionCircuitBreaker } from "../permissions/guardian/rejection-circuit-breaker.js";
import type { GuardianApprovalReviewer } from "../permissions/guardian/reviewer.js";
import {
  EventLog,
  isDurableEvent,
  type Event,
  type EventMsg,
  type SessionConfiguredEvent,
  type TurnContextItem,
} from "./event-log.js";
import type { RolloutStore } from "./rollout-store.js";
import type { LiveThread } from "../thread-store/live-thread.js";
import type { RolloutTraceRecorder } from "./rollout-trace.js";
import type { AppendOptions } from "./session-store.js";
import {
  cloneLlmMessage,
  llmMessageToResponseItem,
} from "./message-history-conversion.js";
import {
  createHistoryReplacedEvent,
  type HistoryReplacedEvent,
} from "./transcript-replacement.js";
import {
  buildPerTurnConfig,
  newDefaultTurnWithSubId as buildDefaultTurnWithSubId,
  newTurnWithSubId as buildTurnWithSubId,
  type Config,
  AuthManager,
  Environment,
  JsReplHandle,
  ManagedFeatures,
  ModelInfo,
  NetworkProxy,
  SessionConfiguration,
  SkillLoadOutcome,
  type Personality,
  type TurnContext,
} from "./turn-context.js";
import type { PhaseEvent } from "../phases/events.js";
import type { RunTurnOptions, Terminal } from "./run-turn.js";
import { runWithCurrentRuntimeSession } from "./current-session.js";
import type { UnifiedExecProcessManagerLike } from "../unified-exec/types.js";
import type { CodeModeService } from "../tools/code-mode/types.js";
import type { ToolLatencyStore } from "../tools/tool-latency-store.js";
import type { PolicyLimitsService } from "../services/policyLimits/index.js";
import type { AgentStatus as RuntimeAgentStatus } from "../agents/status.js";
import type {
  SessionStartHookInput,
  SessionStartSource as HookSessionStartSource,
} from "../llm/hooks/types.js";
import type { HookResultMessage } from "../types/message.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationRequest,
  McpElicitationResponse,
  McpRequestId,
  RequestUserInputArgs,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../elicitation/types.js";
import {
  createActiveTurnState,
  createDoneHandle,
  createSessionTaskContext,
  isSteerable,
  nonSteerableTurnKindFrom,
  waitForDoneWithin,
  GRACEFUL_INTERRUPTION_TIMEOUT_MS,
  type ActiveTurnState,
  type RunningTask,
  type SpawnTaskOptions,
  type SteerInputResult,
  type TurnAbortReason,
} from "./tasks.js";
import {
  RealtimeConversationManager as RuntimeRealtimeConversationManager,
  type RealtimeConversation,
} from "../conversation/realtime/conversation.js";

// ─────────────────────────────────────────────────────────────────────
// Session-facing type contracts.
// These exports keep the Session API stable while delegating concrete
// behavior to the subsystem implementations injected through services.
// ─────────────────────────────────────────────────────────────────────

/** agenc runtime `ThreadId`. Conversation/thread unique identifier. */
export type ThreadId = string;

// Event / EventMsg / SessionConfiguredEvent are re-exported from
// event-log.ts below. The T6 canonical shape lives there; session.ts
// used to have a narrow local copy which caused type divergence.
export type { Event, EventMsg, SessionConfiguredEvent };

/** Re-exports for the task-dispatch subsystem. See `./tasks.ts` for details. */
export type {
  ActiveTurnState,
  NonSteerableTurnKind,
  RunningTask,
  SpawnTaskOptions,
  SteerInputAccepted,
  SteerInputError,
  SteerInputRejected,
  SteerInputResult,
  TaskKind,
  TurnAbortReason,
  MailboxDeliveryPhase,
} from "./tasks.js";
export {
  describeSteerInputError,
  isSteerable,
  nonSteerableTurnKindFrom,
} from "./tasks.js";

/** agenc runtime `AgentStatus` FSM, owned by `runtime/src/agents/status.ts`. */
export type AgentStatus = RuntimeAgentStatus;

/** agenc runtime `SessionState`. Mutable state under `state` mutex. */
export interface SessionState {
  /** Active configuration (mutable per `/model`, `/provider`, etc.). */
  sessionConfiguration: SessionConfiguration;
  /** Conversation history items (T6 fleshes out via rollout reducer). */
  history: unknown[];
  /** Resume-time carryover for model-downshift and context-window checks. */
  previousTurnSettings?: {
    readonly model: string;
    readonly realtimeActive?: boolean;
    readonly personality?: Personality;
    readonly contextWindow?: number;
    readonly autoCompactTokenLimit?: number;
    readonly modelInfo?: {
      readonly contextWindow?: number;
      readonly effectiveContextWindowPercent?: number;
      readonly autoCompactTokenLimit?: number;
    };
  };
  /** Resume/fork baseline turn context from rollout reconstruction. */
  referenceContextItem?: TurnContextItem;
  /**
   * Seeded from the last persisted `token_count` event on resume/fork
   * (agenc runtime `last_token_info_from_rollout` at session/mod.rs:1257). UIs
   * that need to display cumulative token usage immediately on resume
   * read this instead of waiting for the first new completion. The
   * live per-turn accounting path continues to update it via the
   * usual budget/token-count emit sites.
   */
  initialTokenUsage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly reasoningOutputTokens?: number;
    readonly webSearchRequests?: number;
  };
  /**
   * Cross-turn cumulative token usage. Mirrors agenc runtime
   * `TokenUsageInfo.total_token_usage` (protocol.rs:2259-2297) and is
   * the authoritative source for the mid-turn compact gate's
   * `total_usage_tokens >= auto_compact_limit` check. The writer in
   * `stream-model.ts` element-wise accumulates every provider-reported
   * `LLMUsage` under the session state lock after each stream
   * completes, matching agenc runtime's `TokenUsageInfo::append_last_usage`
   * (protocol.rs:2294-2297). Undefined until the first response with
   * usage lands so an unpopulated session reports zero.
   */
  totalTokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly cachedInputTokens: number;
    readonly reasoningOutputTokens: number;
  };
  /** Pending session-start hook source (agenc runtime line 841). */
  pendingSessionStartSource?: SessionStartSource;
}

/** agenc runtime `SessionStartSource` from the hook runtime. */
export type SessionStartSource = Extract<
  HookSessionStartSource,
  "startup" | "resume" | "clear"
>;

/**
 * agenc runtime `ResponseInputItem` / `UserInput` — opaque payload the turn
 * machine consumes. Structural alias kept permissive so both text and
 * multimodal items can route through idle-input merge without the
 * session module pulling in the provider-specific shape.
 */
export type UserInput = unknown;

/**
 * Sentinel used as the `metadata.source` tag for idle-input envelopes
 * routed through `Session.mailbox`. Kept as a const so downstream
 * consumers can filter without magic strings.
 */
export const MAILBOX_SOURCE_IDLE_INPUT = "idle";

/**
 * Upstream agenc runtime `state/turn.rs::ActiveTurn`. Holds the running-task
 * registry and the per-turn lock-guarded state (`ActiveTurnState`).
 *
 * Gut originally exposed only `{turnId, startedAtMs, abortController}`
 * as a forward slot; the T5 task-dispatch port (see `session/tasks.ts`)
 * adds the `tasks` registry and the `turnState` lock so
 * `Session.spawnTask` / `Session.onTaskFinished` can enforce the "one
 * turn in flight at a time" invariant. Existing consumers read the
 * original three fields via `session.activeTurn.unsafePeek()` and are
 * unaffected.
 */
export interface ActiveTurn {
  readonly turnId: string;
  readonly startedAtMs: number;
  readonly abortController: AbortController;
  /** Upstream `tasks: IndexMap<sub_id, RunningTask>`. JS Map preserves
   *  insertion order, matching IndexMap semantics. */
  readonly tasks: Map<string, RunningTask>;
  /** Upstream `turn_state: Arc<Mutex<TurnState>>` per translation-conventions. */
  readonly turnState: AsyncLock<ActiveTurnState>;
}

/** agenc runtime `Mailbox` + `MailboxReceiver`. T9 (subagents) provides the
 *  full bidirectional impl per I-5/I-16/I-31/I-64. Today we expose the
 *  shape so Session can hold its own inbox + per-child outbound
 *  mailboxes.
 *
 *  `direction` + `metadata` are optional here so Session.mailbox can
 *  carry idle-input envelopes alongside peer/agent messages (see
 *  `Session.enqueueIdleInput` / `Session.drainIdleInput`); the real
 *  `agents/mailbox.ts` implementation uses the same field names with
 *  a stricter shape (direction is required there). */
export interface InterAgentCommunication {
  readonly author: string;
  readonly recipient: string;
  readonly content: string;
  readonly triggerTurn: boolean;
  readonly seq: number;
  readonly direction?: "up" | "down";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Mailbox<T = InterAgentCommunication> {
  send(msg: Omit<T, "seq">): number;
  hasPending(): boolean;
  drain(): T[];
  close(): void;
  readonly isClosed: boolean;
}

/** Minimal session-local Mailbox impl using AsyncQueue. T9 replaces with
 *  the full bidirectional mailbox per I-5 + I-16 backpressure. */
export class SimpleMailbox<T extends { seq: number }> implements Mailbox<T> {
  private nextSeq = 0;
  private readonly queue: T[] = [];
  private closed = false;
  readonly seqWatch = new BehaviorSubject<number>(0);

  send(msg: Omit<T, "seq">): number {
    if (this.closed) return -1;
    const seq = ++this.nextSeq;
    this.queue.push({ ...(msg as object), seq } as T);
    this.seqWatch.next(seq);
    return seq;
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  drain(): T[] {
    return this.queue.splice(0);
  }

  close(): void {
    this.closed = true;
    this.seqWatch.complete();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function uniqueSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal[] {
  return Array.from(
    new Set(
      signals.filter((signal): signal is AbortSignal => signal !== undefined),
    ),
  );
}

function waitForAbortSignal(signals: readonly (AbortSignal | undefined)[]): {
  readonly aborted: boolean;
  readonly promise: Promise<null>;
  readonly cleanup: () => void;
} {
  const liveSignals = uniqueSignals(signals);
  if (liveSignals.some((signal) => signal.aborted)) {
    return {
      aborted: true,
      promise: Promise.resolve(null),
      cleanup: () => {},
    };
  }
  if (liveSignals.length === 0) {
    return {
      aborted: false,
      promise: new Promise<null>(() => {}),
      cleanup: () => {},
    };
  }
  let cleanup = (): void => {};
  const promise = new Promise<null>((resolve) => {
    const onAbort = (): void => {
      cleanup();
      resolve(null);
    };
    cleanup = () => {
      for (const signal of liveSignals) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    for (const signal of liveSignals) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return { aborted: false, promise, cleanup };
}

function mcpElicitationPendingKey(
  serverName: string,
  requestId: McpRequestId,
): string {
  return `${serverName}\u0000${String(requestId)}`;
}

/** agenc runtime `RealtimeConversationManager`. */
export type RealtimeConversationManager = RealtimeConversation;

/** agenc runtime `GuardianReviewSessionManager`. */
export interface GuardianReviewSessionManager {
  readonly enabled: boolean;
}

/** agenc runtime `RolloutRecorder`. */
export interface RolloutRecorder {
  rolloutPath(): string;
  record(item: unknown): Promise<void>;
  flushAndSync(): Promise<void>;
  setWindowGeneration(n: number): void;
}

/** agenc runtime `ModelsManager`; runtime provider/model catalog. */
export interface ModelsManager {
  getModelInfo(modelSlug: string, config?: unknown): Promise<ModelInfo>;
  tryListModels(): ReadonlyArray<ModelInfo> | undefined;
  listModels(
    strategy?: "online_if_uncached",
  ): Promise<ReadonlyArray<ModelInfo>>;
}

/** agenc runtime `McpManager`. */
export interface McpManager {
  effectiveServers(
    config: unknown,
    auth: unknown,
  ): Promise<Map<string, McpServerInfo>>;
  toolPluginProvenance(config: unknown): Promise<unknown>;
  refreshFromConfig?(config: unknown): Promise<McpRefreshResult>;
  reconnectServer?(name: string): Promise<McpServerMutationResult>;
  enableServer?(name: string): Promise<McpServerMutationResult>;
  disableServer?(name: string): Promise<McpServerMutationResult>;
  addServer?(config: McpSessionServerConfig): Promise<McpServerMutationResult>;
  getTools?(): ReadonlyArray<McpSessionToolInfo>;
  getToolsByServer?(name: string): ReadonlyArray<McpSessionToolInfo>;
  getConfiguredServers?(): readonly McpSessionServerConfig[];
  getConnectionState?(name: string): McpConnectionProjection | undefined;
  getConnectedConnection?(name: string): MCPServerConnection | undefined;
  getResources?(): Promise<ReadonlyArray<unknown>>;
  getResourcesByServer?(name: string): Promise<ReadonlyArray<unknown>>;
  readResource?(namespacedName: string): Promise<unknown | null>;
  /**
   * Live runtime readiness seam used by the delegate/subagent path.
   * Optional so compatibility shims remain structurally valid, but the
   * canonical bootstrap path should expose the real manager's
   * connectivity state here.
   */
  isConnected?(name: string): boolean;
  resolveMcpToolInfo?(
    toolName: string,
  ): { readonly serverName: string; readonly toolName: string } | undefined;
  getServerForTool?(namespacedName: string): string | undefined;
  /**
   * Names of all MCP servers currently bridged. Optional — exposed for
   * the per-turn `mcp_instructions_delta` attachment producer
   * (`runtime/src/prompts/attachments/mcp-delta.ts`).
   */
  getConnectedServers?(): readonly string[];
  /**
   * `InitializeResult.instructions` blob for a connected server, or
   * `undefined` when the server didn't supply one. Optional — same
   * consumer as `getConnectedServers`.
   */
  getServerInstructions?(name: string): string | undefined;
}

export interface McpServerMutationResult {
  readonly serverName: string;
  readonly success: boolean;
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpSessionServerConfig {
  readonly name: string;
  readonly transport?: "stdio" | "sse" | "http" | "websocket" | "ws";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly endpoint?: string;
  readonly enabled?: boolean;
  readonly required?: boolean;
}

export interface McpSessionToolInfo {
  readonly name: string;
  readonly description?: string;
}

export interface McpServerInfo {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly url?: string;
  readonly command?: string;
}

/** agenc runtime `LspManager`. */
export interface LspManager {
  refreshFromConfig?(config: unknown): Promise<void>;
}

/** agenc runtime `McpConnectionManager`. */
export interface McpConnectionManager {
  setApprovalPolicy(policy: unknown): void;
  setSandboxPolicy(policy: unknown): void;
  requiredStartupFailures(
    servers: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<{ server: string; error: string }>>;
}

/** agenc runtime `AgentControl` service facade for subagents. */
export interface AgentControl {
  readonly maxThreads: number;
  spawnAgent(opts: unknown): Promise<unknown>;
  shutdownAgentTree(threadId: ThreadId): Promise<void>;
}

/** agenc runtime `AgentIdentityManager`; owned by the agent registry layer. */
export interface AgentIdentityManager {
  ensureRegistered(): Promise<void>;
}

/** agenc runtime `Hooks`; implemented by `runtime/src/llm/hooks/`. */
export interface Hooks {
  startupWarnings(): ReadonlyArray<string>;
  readonly userPromptSubmitHooks?: readonly UserPromptSubmitHook[];
  processSessionStart?(
    input: SessionStartHookInput,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<HookResultMessage[]>;
  executePreCompact(...args: unknown[]): Promise<unknown>;
  executePostCompact(...args: unknown[]): Promise<unknown>;
  executeStop(...args: unknown[]): Promise<unknown>;
  executeStopFailure(...args: unknown[]): Promise<unknown>;
}

/** agenc runtime `SkillsManager` + `SkillsWatcher` + `PluginsManager`. */
export interface SkillsManager {
  skillsForConfig(input: unknown, fs: unknown): Promise<SkillLoadOutcome>;
  resolveSkill?(
    name: string,
  ): Promise<NonNullable<SkillLoadOutcome["availableSkills"]>[number] | null>;
  renderSkill?(opts: {
    readonly name: string;
    readonly args?: string;
    readonly sessionId?: string;
  }): Promise<{
    readonly skill: NonNullable<SkillLoadOutcome["availableSkills"]>[number];
    readonly content: string;
  } | null>;
  recordInvokedSkill?(record: {
    readonly skillName: string;
    readonly skillPath: string;
    readonly content: string;
    readonly invokedAt: number;
    readonly agentId?: string;
  }): void;
  getInvokedSkillsForAgent?(agentId?: string): ReadonlyMap<
    string,
    {
      readonly skillName: string;
      readonly skillPath: string;
      readonly content: string;
      readonly invokedAt: number;
      readonly agentId?: string;
    }
  >;
  clearInvokedSkillsForAgent?(agentId?: string): void;
  clearSkillCaches?(): void;
  discoverSkillDirsForPaths?(
    paths: readonly string[],
  ): Promise<readonly string[]>;
}
export interface SkillsWatcher {
  start(): void | Promise<void>;
  stop?(): void | Promise<void>;
}
export interface PluginsManager {
  pluginsForConfig(
    config: unknown,
  ): Promise<{ effectiveSkillRoots(): unknown }>;
}

/** agenc runtime `ExecPolicyManager`. */
export interface ExecPolicyManager {
  current(): unknown;
}

/** agenc runtime `ApprovalStore`. */
export interface ApprovalStore {
  hasApproval(key: string): boolean;
  approve(key: string): void;
  clear?(): void;
  withCachedApproval?(opts: {
    readonly keys: readonly unknown[];
    readonly fetchDecision: () => Promise<unknown>;
  }): Promise<unknown>;
}

/** agenc runtime `LocalThreadStore`. */
export interface LocalThreadStore {
  threadName(threadId: ThreadId): Promise<string | undefined>;
  setThreadName(threadId: ThreadId, name: string): Promise<void>;
}

/** Deferred agenc runtime `ModelClient`; live provider dispatch uses `services.provider`. */
export interface ModelClient {
  setWindowGeneration(n: number): void;
  // Deferred until a caller needs the full agenc runtime ModelClient facade.
}

/** agenc runtime `NetworkApprovalService`. */
export interface NetworkApprovalService {
  enabled(): boolean;
  clearSessionHosts?(): void;
  requestNetworkApproval?(opts: unknown): Promise<unknown>;
  requestDeferredApproval?(opts: unknown): Promise<unknown>;
}

/** agenc runtime `Shell`. */
export interface UserShell {
  readonly path: string;
  deriveExecArgs(input: string, useLoginShell: boolean): string[];
}

/** agenc runtime `UnifiedExecProcessManager`. */
export type UnifiedExecProcessManager = UnifiedExecProcessManagerLike;

/** agenc runtime `BehaviorSubject<unknown>` for shell snapshot tx. */
export type ShellSnapshotTx = BehaviorSubject<unknown | null>;

/** agenc runtime `state_db_ctx`. */
export interface StateDbContext {
  readonly path: string;
}

/** agenc runtime `SessionServices` — DI container of all session-scoped services. */
export interface SessionServices {
  readonly mcpConnectionManager: McpConnectionManager;
  readonly mcpStartupCancellationToken: McpStartupCancellationToken;
  readonly unifiedExecManager: UnifiedExecProcessManager;
  readonly shellZshPath?: string;
  readonly mainExecveWrapperExe?: string;
  readonly hooks: Hooks;
  readonly rollout: RolloutRecorder | undefined;
  /**
   * agenc runtime `rollout_trace` (T6 diagnostics). Coexists with `rollout`:
   * `rollout` is the authoritative rollout item log (source of truth),
   * `rolloutTrace` is the best-effort diagnostic trace bundle recorder
   * used for replay analysis and post-mortem debugging.
   *
   * Declared optional (`?`) instead of `RolloutTraceRecorder | undefined`
   * so existing `SessionServices` construction sites in `bin/bootstrap.ts`
   * and test fixtures do not need to be updated in this tranche. Upstream
   * agenc runtime treats this slot as required and passes a disabled handle when
   * tracing is off; AgenC callers can opt in by supplying
   * `createRolloutTraceRecorder(...)` or `RolloutTraceRecorder.disabled()`.
   */
  readonly rolloutTrace?: RolloutTraceRecorder;
  readonly userShell: UserShell;
  readonly agentIdentityManager: AgentIdentityManager;
  readonly shellSnapshotTx: ShellSnapshotTx;
  readonly showRawAgentReasoning: boolean;
  readonly execPolicy: ExecPolicyManager;
  readonly authManager: AuthManager;
  readonly authBackend?: AuthBackend;
  readonly authSubscriptionTier?: AuthSubscriptionTier;
  readonly modelsManager: ModelsManager;
  readonly toolApprovals: ApprovalStore;
  readonly guardianRejections: Map<string, unknown>;
  /**
   * agenc runtime `GuardianRejectionCircuitBreaker` (per-turn guardian-denial
   * counter with consecutive + total thresholds). Ported from upstream
   * agenc runtime `core/src/guardian/mod.rs`. Optional while callers are wired up;
   * the bootstrap default map above stays until every consumer routes
   * denials through the breaker instead.
   *
   * See `../permissions/guardian/rejection-circuit-breaker.ts` for the full contract.
   */
  readonly guardianRejectionCircuitBreaker?: GuardianRejectionCircuitBreaker;
  /**
   * Approval-time automatic reviewer. When `approvalsReviewer` is
   * configured to `auto_review`, the tool orchestrator routes approval
   * prompts through this producer before falling back to the user
   * resolver. Completed denial findings are the live writer for
   * `guardianRejectionCircuitBreaker`.
   */
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  /** T13 review-task port. agenc runtime `session/review.rs` manager analog. */
  readonly reviewManager?: import("./review.js").ReviewManager;
  readonly skillsManager: SkillsManager;
  readonly pluginsManager: PluginsManager;
  readonly mcpManager: McpManager;
  readonly lspManager?: LspManager;
  readonly skillsWatcher: SkillsWatcher;
  /**
   * T9 live: the real `AgentControl` + `AgentRegistry` pair is bound once by
   * `bindSessionAgentControl(session, ...)` in `bin/delegate-tool.ts`
   * immediately after `new Session(...)` returns, and before the first tool
   * call that would reach the delegate path. This field is intentionally
   * non-`readonly` so that single-bind write is a typed assignment instead
   * of a cast-through-`unknown`; all other consumers treat it as immutable.
   *
   * @internal Invariant: written exactly once during bootstrap via
   * `bindSessionAgentControl`, never mutated afterwards.
   */
  agentControl: AgentControl;
  readonly threadManager?: import("../agents/thread-manager.js").ThreadManager;
  readonly conversationThreadManager?: import("../conversation/thread-manager.js").ConversationThreadManager;
  startupPrewarm?: import("./startup-prewarm.js").StartupPrewarmStore;
  readonly networkProxy?: NetworkProxy;
  readonly networkApproval: NetworkApprovalService;
  readonly stateDb?: StateDbContext;
  readonly threadStore: LocalThreadStore;
  /**
   * Upstream agenc runtime `services.live_thread: Option<LiveThread>`
   * (core/src/state/service.rs:66). Optional because gut has no
   * ThreadStore subsystem: the service is populated by callers that
   * construct a `LiveThread` against the session's `RolloutStore`, and
   * left unset in tests / ephemeral sessions. See `live-thread.ts` for
   * the partial port's RESERVED-method list.
   */
  readonly liveThread?: LiveThread;
  readonly modelClient: ModelClient;
  readonly codeModeService: CodeModeService;
  readonly environment?: Environment;
  // T-future: AgenC-specific additions
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly querySource?: QuerySource;
  readonly permissionRequestHooks?: ReadonlyArray<PermissionRequestHook>;
  readonly approvalResolver?: ApprovalResolver;
  readonly permissionAuditLogger?: PermissionAuditLogger;
  readonly onPermissionAuditError?: PermissionAuditErrorHandler;
  requestUserInputResolver?: {
    request(
      event: RequestUserInputEvent,
      signal?: AbortSignal,
    ): Promise<RequestUserInputResponse | null>;
  };
  mcpElicitationResolver?: {
    request(
      event: McpElicitationRequestEvent,
      signal?: AbortSignal,
    ): Promise<McpElicitationResponse | null>;
  };
  /**
   * T11 W3-A: authoritative permission-mode registry. Commands (`/permissions`,
   * `/plan`) and the evaluator both read from the same registry instance so
   * I-3 live-read semantics are honoured. When omitted, `Session`
   * bootstraps a default registry seeded with `createEmptyToolPermissionContext()`
   * so test fixtures can continue constructing Sessions without wiring
   * the full permissions subsystem.
   */
  readonly permissionModeRegistry: PermissionModeRegistry;
  /**
   * T11 W3-A: optional ConfigStore reference so `/config` and `/permissions`
   * can reach the store without plumbing it through `SlashCommandContext`.
   * The `?` is intentional — some test fixtures construct Session without
   * a ConfigStore, and commands already prefer `ctx.configStore` when set.
   */
  readonly configStore?: ConfigStore;
  readonly costSidecar?: CostSidecar;
  readonly hooksRuntime?: ConfiguredHooksRuntime;
  readonly policyLimits?: PolicyLimitsService;
  /**
   * Adaptive per-tool drain-timeout latency store (Goal #4a). In-memory,
   * session-scoped. Optional so minimal/test SessionServices literals need not
   * supply one; the streaming executor falls through to the flat drain
   * deadline (and the recording site is a no-op) when this is absent.
   */
  readonly toolLatencyStore?: ToolLatencyStore;
}

/**
 * I-13 + I-57 staging shape for a mid-stream provider/model switch. The
 * `profile` slot is T11 Wave 2's extension so `/config profile <name>`
 * can stage a profile swap alongside the provider/model pair.
 */
export interface PendingProviderSwitch {
  readonly provider: string;
  readonly model: string;
  readonly profile?: string;
}

export interface AppliedProviderSwitchResult {
  readonly applied: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly reason?: string;
}

function buildProviderFallbackLadderOptions(params: {
  readonly provider: string;
  readonly model: string;
  readonly settings: ResolvedProviderSettings | undefined;
}): ProviderFallbackLadderOptions | undefined {
  const targets = params.settings?.fallbackTargets;
  if (!targets || targets.length === 0) return undefined;
  return {
    provider: params.provider,
    model: params.model,
    targets,
    ...(params.settings?.fallbackMaxFailures !== undefined
      ? { maxFailures: params.settings.fallbackMaxFailures }
      : {}),
    ...(params.settings?.fallbackStatuses !== undefined &&
    params.settings.fallbackStatuses.length > 0
      ? { statuses: params.settings.fallbackStatuses }
      : {}),
  };
}

const MANAGED_KEY_PROVIDERS = new Set<ProviderName>([
  "openrouter",
]);

const MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

function isRemoteAuthBackend(authBackend: AuthBackend | undefined): boolean {
  return authBackend?.kind === "remote";
}

function isSubscriptionEntitled(
  tier: AuthSubscriptionTier | undefined,
): boolean {
  return tier === "pro" || tier === "team" || tier === "enterprise";
}

function requiresHostedModelRouting(provider: string, model: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  return (
    normalizedProvider === "agenc" ||
    normalizedModel === "agenc" ||
    normalizedModel.startsWith("agenc:")
  );
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

async function vendManagedProviderKey(params: {
  readonly provider: ProviderName;
  readonly authBackend: AuthBackend | undefined;
  readonly sessionId: string;
  readonly model: string;
}): Promise<
  | {
    readonly apiKey: string;
    readonly baseURL?: string;
    readonly model?: string;
  }
  | undefined
> {
  if (!params.authBackend || !MANAGED_KEY_PROVIDERS.has(params.provider)) {
    return undefined;
  }
  const key = await params.authBackend.vendKey(
    params.provider,
    params.sessionId,
  );
  const apiKey = firstNonEmpty(key.apiKey);
  if (apiKey === undefined) return undefined;
  const baseURL = firstNonEmpty(key.baseUrl);
  const model = baseURL !== undefined
    ? normalizeManagedGatewayModel(params.provider, params.model)
    : params.model;
  return {
    apiKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    model,
  };
}

async function providerFactoryOptionsFromSettings(params: {
  readonly provider: string;
  readonly model: string;
  readonly settings: ResolvedProviderSettings | undefined;
  readonly authBackend?: AuthBackend;
  readonly authSubscriptionTier?: AuthSubscriptionTier;
  readonly managedKeysEnabled: boolean;
  readonly sessionId: string;
  readonly reusableApiKey?: string;
}): Promise<ProviderFactoryOptions> {
  const extra: Record<string, unknown> = {};
  if (params.settings?.contextWindowTokens !== undefined) {
    extra.contextWindowTokens = params.settings.contextWindowTokens;
  }
  if (params.settings?.maxOutputTokens !== undefined) {
    extra.maxTokens = params.settings.maxOutputTokens;
  }
  const providerFallback = buildProviderFallbackLadderOptions(params);
  if (providerFallback !== undefined) {
    extra.providerFallback = providerFallback;
  }
  const normalizedProvider = normalizeProviderName(params.provider);
  if (normalizedProvider === "agenc" && params.authBackend !== undefined) {
    extra.authBackend = params.authBackend;
    extra.sessionId = params.sessionId;
    if (params.authSubscriptionTier !== undefined) {
      extra.subscriptionTier = params.authSubscriptionTier;
    }
  }
  const byokApiKey = params.settings?.apiKey ?? params.reusableApiKey;
  if (
    isRemoteAuthBackend(params.authBackend) &&
    !isSubscriptionEntitled(params.authSubscriptionTier)
  ) {
    if (requiresHostedModelRouting(params.provider, params.model)) {
      throw new Error(
        "Hosted AgenC model routing requires an active AgenC subscription",
      );
    }
    if (
      params.managedKeysEnabled &&
      byokApiKey === undefined &&
      normalizedProvider !== null &&
      MANAGED_KEY_PROVIDERS.has(normalizedProvider)
    ) {
      throw new Error(
        "Managed provider keys require an active AgenC subscription; configure BYOK provider credentials instead",
      );
    }
  }
  const managedCredential =
    byokApiKey === undefined &&
    params.managedKeysEnabled &&
    normalizedProvider !== null
      ? await vendManagedProviderKey({
          provider: normalizedProvider,
          authBackend: params.authBackend,
          sessionId: params.sessionId,
          model: params.model,
        })
      : undefined;
  if (
    managedCredential !== undefined &&
    normalizedProvider === "openrouter" &&
    params.settings?.maxOutputTokens === undefined
  ) {
    extra.maxTokens = MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS;
  }
  const apiKey = params.settings?.apiKey ?? managedCredential?.apiKey;
  const baseURL = params.settings?.baseURL ?? managedCredential?.baseURL;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(managedCredential?.baseURL !== undefined
      ? { extra: { ...extra, managedGateway: true } }
      : {}),
    ...(managedCredential?.baseURL === undefined && Object.keys(extra).length > 0
      ? { extra }
      : {}),
  };
}

function mergeProviderFactoryOptions(
  base: ProviderFactoryOptions | undefined,
  override: ProviderFactoryOptions,
): ProviderFactoryOptions {
  const mergedExtra = {
    ...(base?.extra ?? {}),
    ...(override.extra ?? {}),
  };
  return {
    ...(base ?? {}),
    ...override,
    ...(Object.keys(mergedExtra).length > 0 ? { extra: mergedExtra } : {}),
  };
}

export const DEFAULT_LEGACY_EVENT_QUEUE_DEPTH = 1024;

/** Abort reason classification (per I-7). */
export type AbortReason =
  | "user_interrupt"
  | "parent_interrupt"
  | "recovery"
  | "mode_changed"
  | "auth_failed"
  | "stdin_lost"
  | "provider_switched"
  | "signal_received"
  | "stream_idle"
  | "token_budget_exceeded"
  | "process_killed";

// ─────────────────────────────────────────────────────────────────────
// Session class — the field-faithful port of agenc runtime `Session` struct.
// ─────────────────────────────────────────────────────────────────────

export interface SessionOpts {
  readonly conversationId: ThreadId;
  readonly initialState: SessionState;
  readonly features: ManagedFeatures;
  readonly services: SessionServices;
  readonly jsRepl: JsReplHandle;
  /** Session-level config snapshot used for per-turn TurnContext builders. */
  readonly config?: Config;
  /** Session-level model metadata used for per-turn TurnContext builders. */
  readonly modelInfo?: ModelInfo;
  /** Existing event-stream consumer. */
  readonly eventQueue?: AsyncQueue<Event>;
  /** Initial AgentStatus (default: idle). */
  readonly agentStatus?: AgentStatus;
  /** I-22: token-budget tracker. Null = budgeting disabled. */
  readonly budgetTracker?: BudgetTracker | null;
  /** Seeded transcript events used by the TUI on first mount. */
  readonly initialTranscriptEvents?: readonly unknown[];
}

export interface SessionTurnDriverHooks {
  readonly submit: (
    message: string | readonly LLMContentPart[],
    opts?: SessionSubmitOptions,
  ) => Promise<void>;
  readonly flushEventLog?: () => Promise<void> | void;
}

export interface SessionPartialCompactFromMessageParams {
  readonly messageOrdinal: number;
  readonly direction: PartialCompactDirection;
  readonly feedback?: string;
  readonly signal?: AbortSignal;
}

export interface SessionRewindConversationToMessageParams {
  readonly messageOrdinal: number;
}

export type SessionPartialCompactErrorCode =
  | "ABORTED"
  | "ACTIVE_TURN"
  | "MESSAGE_NOT_FOUND"
  | "ROLLOUT_UNAVAILABLE"
  | "ROLLOUT_DEGRADED";

export type SessionConversationRewindErrorCode =
  | "ACTIVE_TURN"
  | "MESSAGE_NOT_FOUND"
  | "ROLLOUT_UNAVAILABLE"
  | "ROLLOUT_DEGRADED";

export type SessionPartialCompactFromMessageResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly eventAlreadyEmitted: false;
      readonly event: HistoryReplacedEvent;
      readonly replacementHistory: readonly LLMMessage[];
      readonly displayText: string;
    }
  | {
      readonly ok: false;
      readonly sessionId: string;
      readonly eventAlreadyEmitted: false;
      readonly code: SessionPartialCompactErrorCode;
      readonly message: string;
    };

export type SessionRewindConversationToMessageResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly eventAlreadyEmitted: false;
      readonly event: HistoryReplacedEvent;
      readonly replacementHistory: readonly LLMMessage[];
      readonly displayText: string;
    }
  | {
      readonly ok: false;
      readonly sessionId: string;
      readonly eventAlreadyEmitted: false;
      readonly code: SessionConversationRewindErrorCode;
      readonly message: string;
    };

function readProviderHttpClient(
  provider: LLMProvider | undefined,
): ProviderHttpClient | undefined {
  const candidate = (provider as { client?: unknown } | undefined)?.client;
  return candidate instanceof ProviderHttpClient ? candidate : undefined;
}

function normalizeHistoryMessages(
  history: ReadonlyArray<unknown>,
): LLMMessage[] {
  const normalized: LLMMessage[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<LLMMessage> & {
      role?: unknown;
      content?: unknown;
      phase?: unknown;
      toolCalls?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
    };
    if (
      candidate.role !== "system" &&
      candidate.role !== "developer" &&
      candidate.role !== "user" &&
      candidate.role !== "assistant" &&
      candidate.role !== "tool"
    ) {
      continue;
    }
    const content =
      typeof candidate.content === "string" || Array.isArray(candidate.content)
        ? candidate.content
        : "";
    normalized.push({
      role: candidate.role,
      content: content as LLMMessage["content"],
      ...(candidate.phase === "commentary" || candidate.phase === "final_answer"
        ? { phase: candidate.phase }
        : {}),
      ...(Array.isArray(candidate.toolCalls)
        ? { toolCalls: candidate.toolCalls as LLMMessage["toolCalls"] }
        : {}),
      ...(typeof candidate.toolCallId === "string"
        ? { toolCallId: candidate.toolCallId }
        : {}),
      ...(typeof candidate.toolName === "string"
        ? { toolName: candidate.toolName }
        : {}),
    });
  }
  return normalized;
}

const COMPACT_BOUNDARY_PREFIX = "<compact>";
const COMPACT_SUMMARY_PREFIX =
  "This session is being continued from a previous conversation";
const NON_SELECTABLE_USER_TAGS = [
  "local-command-stdout",
  "local-command-stderr",
  "bash-stdout",
  "bash-stderr",
  "task-notification",
  "tick",
  "teammate-message",
] as const;

function isCompactBoundaryMessage(message: LLMMessage | undefined): boolean {
  return (
    message?.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(COMPACT_BOUNDARY_PREFIX)
  );
}

function isCompactSummaryMessage(message: LLMMessage | undefined): boolean {
  return (
    message?.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(COMPACT_SUMMARY_PREFIX)
  );
}

function lastTextBlock(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const part = content[index];
    if (part?.type === "text") return part.text.trim();
  }
  return "";
}

function isSelectableHistoryUserMessage(message: LLMMessage): boolean {
  if (message.role !== "user") return false;
  if (isCompactBoundaryMessage(message)) return false;
  if (isCompactSummaryMessage(message)) return false;
  const messageText = lastTextBlock(message.content);
  if (messageText.length === 0) return false;
  return !NON_SELECTABLE_USER_TAGS.some(
    (tag) =>
      messageText.includes(`<${tag}`) || messageText.includes(`</${tag}>`),
  );
}

function splitActiveHistory(messages: readonly LLMMessage[]): {
  readonly prefixBeforeActive: readonly LLMMessage[];
  readonly activeHistory: readonly LLMMessage[];
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompactBoundaryMessage(messages[index])) {
      return {
        prefixBeforeActive: messages.slice(0, index + 1).map(cloneLlmMessage),
        activeHistory: messages.slice(index + 1).map(cloneLlmMessage),
      };
    }
  }
  return {
    prefixBeforeActive: [],
    activeHistory: messages.map(cloneLlmMessage),
  };
}

function activeHistoryIndexForOrdinal(
  activeHistory: readonly LLMMessage[],
  ordinal: number,
): number | null {
  if (!Number.isInteger(ordinal) || ordinal < 0) return null;
  let seen = 0;
  for (let index = 0; index < activeHistory.length; index += 1) {
    const message = activeHistory[index];
    if (message === undefined || !isSelectableHistoryUserMessage(message)) {
      continue;
    }
    if (seen === ordinal) return index;
    seen += 1;
  }
  return null;
}

function toCompactRuntimeMessages(
  messages: readonly LLMMessage[],
): RuntimeMessage[] {
  return messages.map((message, index) => {
    const content = toCompactRuntimeContent(message.content);
    const role = toCompactRuntimeRole(message.role);
    return {
      role,
      type: role,
      content,
      message: { role, content },
      uuid: `partial-compact-${role}-${index}`,
      timestamp: new Date(0).toISOString(),
      ...(message.role === role ? {} : { originalRole: message.role }),
      ...(message.toolCalls !== undefined
        ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
        : {}),
      ...(message.toolCallId !== undefined
        ? { toolCallId: message.toolCallId }
        : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.phase !== undefined ? { phase: message.phase } : {}),
      ...(message.role === "tool" ? { isMeta: true } : {}),
    };
  });
}

function toCompactRuntimeRole(
  role: LLMMessage["role"],
): NonNullable<RuntimeMessage["role"]> {
  if (role === "developer") return "system";
  if (role === "tool") return "user";
  return role;
}

function toCompactRuntimeContent(content: LLMMessage["content"]): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "image_url") {
      return {
        type: "image",
        source: { type: "url", url: part.image_url.url },
      };
    }
    return { ...part };
  });
}

function fromCompactRuntimeMessages(
  messages: readonly RuntimeMessage[],
): LLMMessage[] {
  return messages
    .map(fromCompactRuntimeMessage)
    .filter((message): message is LLMMessage => message !== null);
}

function fromCompactRuntimeMessage(message: RuntimeMessage): LLMMessage | null {
  const role = normalizeCompactRuntimeRole(
    message.originalRole ?? message.role,
  );
  if (role === null) return null;
  const content = fromCompactRuntimeContent(
    message.message?.content ?? message.content ?? "",
  );
  return {
    role,
    content,
    ...(message.toolCalls !== undefined
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? "",
          })),
        }
      : {}),
    ...(message.toolCallId !== undefined
      ? { toolCallId: message.toolCallId }
      : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase === "commentary" || message.phase === "final_answer"
      ? { phase: message.phase }
      : {}),
  };
}

function normalizeCompactRuntimeRole(
  value: unknown,
): LLMMessage["role"] | null {
  if (
    value === "system" ||
    value === "developer" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  ) {
    return value;
  }
  return null;
}

function fromCompactRuntimeContent(content: unknown): LLMMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: LLMContentPart[] = [];
  let textOnly = true;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (
      record.type === "image" &&
      record.source &&
      typeof record.source === "object"
    ) {
      const source = record.source as Record<string, unknown>;
      if (typeof source.url === "string") {
        textOnly = false;
        parts.push({ type: "image_url", image_url: { url: source.url } });
      }
      continue;
    }
    if (
      record.type === "image_url" &&
      record.image_url &&
      typeof record.image_url === "object"
    ) {
      const image = record.image_url as Record<string, unknown>;
      if (typeof image.url === "string") {
        textOnly = false;
        parts.push({ type: "image_url", image_url: { url: image.url } });
      }
      continue;
    }
    if (record.type === "document") {
      const source =
        record.source && typeof record.source === "object"
          ? (record.source as Record<string, unknown>)
          : null;
      if (
        source?.type === "base64" &&
        source.media_type === "application/pdf" &&
        typeof source.data === "string"
      ) {
        textOnly = false;
        parts.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: source.data,
          },
          ...(typeof record.title === "string" ? { title: record.title } : {}),
          ...(typeof record.filename === "string"
            ? { filename: record.filename }
            : {}),
          ...(typeof record.fallbackText === "string"
            ? { fallbackText: record.fallbackText }
            : {}),
          ...(typeof record.fallbackTextTruncated === "boolean"
            ? { fallbackTextTruncated: record.fallbackTextTruncated }
            : {}),
          ...(typeof record.fallbackTextError === "string"
            ? { fallbackTextError: record.fallbackTextError }
            : {}),
        });
      }
      continue;
    }
    if (typeof record.text === "string") {
      parts.push({ type: "text", text: record.text });
    }
  }
  if (textOnly) {
    return parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
  }
  return parts;
}

function compactionMessage(result: CompactionResult): string {
  const summary =
    result.summaryMessages.at(-1) ?? result.messagesToKeep?.at(-1);
  if (summary === undefined)
    return result.userDisplayMessage ?? "Conversation summarized";
  const content = summary.message?.content ?? summary.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content))
    return result.userDisplayMessage ?? "Conversation summarized";
  const text = content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.length > 0
    ? text
    : (result.userDisplayMessage ?? "Conversation summarized");
}

function activeAgentDefinitionsFromRoles(
  roles: readonly { readonly name: string; readonly description: string }[],
): unknown[] {
  return roles.map((role) => ({
    agentType: role.name,
    ...(role.description.length > 0 ? { whenToUse: role.description } : {}),
  }));
}

/**
 * Initialized model agent context.
 *
 * Mirrors agenc runtime `Session` struct (session.rs:6-29).
 */
export class Session {
  /** agenc runtime: `conversation_id: ThreadId` */
  readonly conversationId: ThreadId;

  /**
   * Compatibility event stream. EventLog is the source-of-truth fanout path; this
   * bounded queue remains only for older consumers that still call
   * `session.txEvent.stream()`.
   */
  readonly txEvent: AsyncQueue<Event>;

  /** agenc runtime: `agent_status: watch::Sender<AgentStatus>` — status with replay-current. */
  readonly agentStatus: BehaviorSubject<AgentStatus>;

  /** agenc runtime: `out_of_band_elicitation_paused: watch::Sender<bool>` — agenc runtime realtime parity. */
  readonly outOfBandElicitationPaused: BehaviorSubject<boolean>;

  /** agenc runtime: `state: Mutex<SessionState>` — async-locked session state. */
  readonly state: AsyncLock<SessionState>;

  /** agenc runtime: `managed_network_proxy_refresh_lock: Mutex<()>` — serializes proxy rebuilds. */
  readonly managedNetworkProxyRefreshLock: AsyncLock<void>;

  /** agenc runtime: `features: ManagedFeatures` — invariant for the lifetime of the session. */
  readonly features: ManagedFeatures;

  /** agenc runtime: `pending_mcp_server_refresh_config: Mutex<Option<McpServerRefreshConfig>>`. */
  readonly pendingMcpServerRefreshConfig: AsyncLock<unknown | null>;

  /** agenc runtime: `conversation: Arc<RealtimeConversationManager>`. T-future (realtime). */
  readonly conversation: RealtimeConversationManager;

  /** agenc runtime: `active_turn: Mutex<Option<ActiveTurn>>` — at most one running task. */
  readonly activeTurn: AsyncLock<ActiveTurn | null>;

  /** agenc runtime: `mailbox: Mailbox` — Session's own inbox (parent or peer can send). */
  readonly mailbox: Mailbox;

  /** Sequence watcher for root mailbox delivery. */
  readonly mailboxSeqWatch: BehaviorSubject<number>;

  /** agenc runtime: `mailbox_rx: Mutex<MailboxReceiver>` — drain receiver. */
  readonly mailboxRx: AsyncLock<{ drain(): InterAgentCommunication[] }>;

  /** agenc runtime: `guardian_review_session: GuardianReviewSessionManager`. */
  readonly guardianReviewSession: GuardianReviewSessionManager;

  /** agenc runtime: `services: SessionServices` — DI container. */
  readonly services: SessionServices;

  /** agenc runtime: `js_repl: Arc<JsReplHandle>`. */
  readonly jsRepl: JsReplHandle;

  /** Session-root config snapshot used to build per-turn frozen configs. */
  readonly config: Config;

  /** Session-root model metadata used by the turn-context builder. */
  readonly modelInfo: ModelInfo;

  /** agenc runtime: `next_internal_sub_id: AtomicU64` — monotonic sub-id counter. */
  private nextInternalSubIdValue: number;

  /** agenc runtime: `agent_task_registration_lock: Mutex<()>` — serializes task registration. */
  readonly agentTaskRegistrationLock: AsyncLock<void>;

  /**
   * Serializes `spawnTask` + `abortAllTasks` so the "abort old then
   * install new" sequence is atomic w.r.t. other spawn/abort callers.
   * Upstream agenc runtime doesn't need this because `spawn_task` is always
   * called from the single submit dispatcher; gut exposes `spawnTask`
   * to `runTurnKernel`, slash-command adapters, and tests, so we add a
   * dedicated mutex to keep the two-lock sequence race-free. See
   * `session/tasks.ts` for design notes.
   */
  private readonly taskDispatchLock: AsyncLock<void> = new AsyncLock<void>(
    undefined,
  );

  // ───────────────────────────────────────────────────────────
  // AgenC-specific additions (not in agenc runtime):
  // ───────────────────────────────────────────────────────────

  /** I-5: per-child outbound mailboxes (parent → child Interrupt/Resume). */
  readonly childInboxes: Map<ThreadId, Mailbox> = new Map();

  /**
   * I-13 (mid-stream provider/model switch) + I-57 (history-compat check)
   * staging slot. Honored by `run-turn` at top-of-loop: the turn loop
   * consumes this marker, applies the switch atomically, and clears the
   * slot before the next turn.
   *
   * The T11 Wave 2 extension adds `profile?` so `/config profile <name>`
   * can stage a profile swap through the same gate. I-30 (per-turn
   * config-snapshot immutability) forbids mutating the live
   * `sessionConfiguration` mid-turn, so profile resolution must land on
   * the next turn's config snapshot through this slot.
   *
   * Mutators should call `Session.setPendingProviderSwitch(...)` rather
   * than poking the field directly so the I-13 staging site has a
   * single well-typed entry point.
   *
   * Follow-up(T11-W3): surface the active profile name back on the snapshot
   * once ConfigStore tracks it.
   */
  pendingProviderSwitch: PendingProviderSwitch | null = null;

  /**
   * T11 W3: active worktree binding for the slash-command adapters.
   * Stores the entered handle plus the caller's pre-enter cwd so
   * `/exit-worktree` can restore the session directory on success.
   */
  pendingWorktreeState: PendingWorktreeState | null = null;

  /** I-22: token-budget tracker (null = budgeting disabled). Set at
   *  session construction by SessionOpts.budgetTracker; updated per
   *  emitted token by stream-model phase. */
  budgetTracker: BudgetTracker | null = null;

  /** I-7: session-level AbortController; phases observe `signal.aborted`. */
  readonly abortController: AbortController = new AbortController();

  /** T6: in-process event bus (pub/sub). All emit() paths go through
   *  here — EventLog assigns a monotonic seq (I-27) and fans out to
   *  subscribed sidecars (I-43 per-sidecar isolation). */
  readonly eventLog: EventLog = new EventLog();

  /** T6: optional rollout-store for durable JSONL persistence.
   *  When present, every emitted event is appended; durable events
   *  (I-4) force an immediate fsync. */
  rolloutStore: RolloutStore | null = null;

  private outOfBandElicitationPauseCount = 0;

  private rolloutPersistenceSuspendDepth = 0;

  /**
   * TUI-facing PhaseEvent subscribers. The one-shot CLI renders these
   * directly from the generator; the live TUI needs an in-session bus
   * so `useQuery` can observe the same stream.
   */
  private readonly phaseEventListeners = new Set<(event: PhaseEvent) => void>();

  /** Bootstrap-owned submit hook used by the TUI contract. */
  private turnDriverHooks: SessionTurnDriverHooks | null = null;

  /** Serialize submit calls so the session keeps a single active turn. */
  private submitQueue: Promise<void> = Promise.resolve();

  /** Seeded transcript event stream used by the TUI resume path. */
  private initialTranscriptEvents: readonly unknown[] = [];

  /** TUI startup/status notices derived from AGENC.md loader diagnostics. */
  projectMemoryWarnings: readonly string[] = [];

  /** TUI agent-definition status surface. Populated by agent catalog wiring. */
  readonly agentDefinitions: { activeAgents: unknown[] } = {
    activeAgents: [],
  };

  /** Turn ids that have already emitted task-lifecycle abort events. */
  private readonly emittedTaskAbortTurnIds = new Set<string>();

  /**
   * T11 W4: session-scoped denial tracking. Mutated in place by the
   * permission evaluator (matches AgenC's `Object.assign` contract)
   * so denial limits (3 consecutive / 20 total) persist across turns in
   * the same session. Reset by `/clear` via `Object.assign` so the shared
   * reference stays stable.
   */
  readonly denialTracking: DenialTrackingState = freshDenialTracking();

  /** Session creation wall-clock (monotonic ms; for telemetry). */
  readonly createdAtMs: number = monotonicMs();

  /**
   * Session bootstrap.
   *
   * Notable defaults:
   *   - `opts.services.permissionModeRegistry` is constructed with a
   *     default `PermissionModeRegistry` seeded from
   *     `createEmptyToolPermissionContext()` when absent, so test
   *     fixtures that do not wire the full permissions subsystem still
   *     get a working registry. Production bootstrap paths supply the
   *     real registry built during startup by the CLI.
   */
  constructor(opts: SessionOpts) {
    this.conversationId = opts.conversationId;
    this.txEvent =
      opts.eventQueue ??
      new AsyncQueue<Event>({ maxDepth: DEFAULT_LEGACY_EVENT_QUEUE_DEPTH });
    this.agentStatus = new BehaviorSubject<AgentStatus>(
      opts.agentStatus ?? { status: "pending_init" },
    );
    this.outOfBandElicitationPaused = new BehaviorSubject<boolean>(false);
    this.state = new AsyncLock<SessionState>(opts.initialState);
    this.managedNetworkProxyRefreshLock = new AsyncLock<void>(undefined);
    this.features = opts.features;
    this.pendingMcpServerRefreshConfig = new AsyncLock<unknown | null>(null);
    this.conversation = new RuntimeRealtimeConversationManager();
    this.activeTurn = new AsyncLock<ActiveTurn | null>(null);
    const mailbox = new SimpleMailbox<
      InterAgentCommunication & { seq: number }
    >();
    this.mailbox = mailbox as unknown as Mailbox;
    this.mailboxSeqWatch = mailbox.seqWatch;
    this.mailboxRx = new AsyncLock<{ drain(): InterAgentCommunication[] }>({
      drain: () => this.mailbox.drain(),
    });
    this.guardianReviewSession = { enabled: false };
    // Bootstrap a default permission-mode registry when the caller did
    // not supply one. `SessionServices.permissionModeRegistry` is
    // required on the interface, but historical test fixtures that
    // loose-cast through `unknown as SessionServices` can still reach
    // this branch with an `undefined` slot, so treat the cast-through
    // case as a missing registry and fall back to the empty default.
    const rawRegistry = (
      opts.services as unknown as {
        permissionModeRegistry?: PermissionModeRegistry;
      }
    ).permissionModeRegistry;
    const resolvedRegistry =
      rawRegistry ??
      new PermissionModeRegistry(createEmptyToolPermissionContext());
    opts.initialState.sessionConfiguration = {
      ...opts.initialState.sessionConfiguration,
      permissionContext: {
        mode: resolvedRegistry.current().mode,
        ...(resolvedRegistry.current().isAutoModeAvailable !== undefined
          ? {
              isAutoModeAvailable:
                resolvedRegistry.current().isAutoModeAvailable,
            }
          : {}),
        ...(resolvedRegistry.current().autoModeActive !== undefined
          ? { autoModeActive: resolvedRegistry.current().autoModeActive }
          : {}),
        ...(resolvedRegistry.current().bypassPermissionsAcceptedIn !== undefined
          ? {
              bypassPermissionsAcceptedIn:
                resolvedRegistry.current().bypassPermissionsAcceptedIn,
            }
          : {}),
      },
    } as SessionConfiguration;
    this.services = {
      ...opts.services,
      permissionModeRegistry: resolvedRegistry,
      querySource: opts.services.querySource ?? "repl_main_thread",
    };
    this.jsRepl = opts.jsRepl;
    this.config =
      opts.config ??
      deriveMinimalSessionConfig(
        opts.initialState.sessionConfiguration,
        opts.features,
      );
    this.modelInfo =
      opts.modelInfo ??
      deriveMinimalModelInfo(
        opts.initialState.sessionConfiguration.collaborationMode?.model ?? "",
      );
    this.agentDefinitions.activeAgents = activeAgentDefinitionsFromRoles(
      this.config.agentRoles,
    );
    this.nextInternalSubIdValue = 0;
    this.agentTaskRegistrationLock = new AsyncLock<void>(undefined);
    this.budgetTracker = opts.budgetTracker ?? null;
    this.initialTranscriptEvents = opts.initialTranscriptEvents ?? [];
    this.bindProviderConversation();
    resolvedRegistry.subscribeToModeChange((newMode) => {
      void this.syncPermissionContextFromRegistry({
        ...resolvedRegistry.current(),
        mode: newMode,
      });
    });
    // Per-turn attachment exit-pulse wiring. The plan-mode and auto-mode
    // attachment producers fire a one-shot exit reminder when these flags
    // are set; the registry is the canonical event source for mode
    // transitions, so flip the flags here. Mirrors agenc
    // `bootstrap/state.ts:1349-1363` where `handlePlanModeTransition`
    // raises the equivalent pulse on the same boundary.
    resolvedRegistry.subscribeToModeChange((newMode, oldMode) => {
      if (oldMode === "plan" && newMode !== "plan") {
        getAttachmentTrackingState(this).needsPlanModeExitAttachment = true;
      }
      if (oldMode === "auto" && newMode !== "auto") {
        getAttachmentTrackingState(this).needsAutoModeExitAttachment = true;
      }
    });
  }

  // ───────────────────────────────────────────────────────────
  // Methods (AgenC behavior).
  // ───────────────────────────────────────────────────────────

  /**
   * Typed mutator for the I-13 + I-57 staging slot. Commands
   * (`/model`, `/provider`, `/config profile <name>`, recovery
   * fallback) set the pending switch via this helper instead of
   * poking `pendingProviderSwitch` directly, so the staging site has
   * a single well-typed entry point. Pass `null` to clear the slot.
   */
  setPendingProviderSwitch(pendingSwitch: PendingProviderSwitch | null): void {
    this.pendingProviderSwitch = pendingSwitch;
  }

  setPendingWorktreeState(
    pendingWorktreeState: PendingWorktreeState | null,
  ): void {
    const previous = this.pendingWorktreeState;
    this.pendingWorktreeState = pendingWorktreeState;
    const nextCwd = pendingWorktreeState?.handle.path ?? previous?.originalCwd;
    if (!nextCwd) return;
    const state = this.state.unsafePeek();
    state.sessionConfiguration = {
      ...state.sessionConfiguration,
      cwd: nextCwd,
    } as SessionConfiguration;
    (this as { config: Config }).config = {
      ...this.config,
      cwd: nextCwd,
    };
  }

  setProjectMemoryWarnings(warnings: readonly string[]): void {
    this.projectMemoryWarnings = [...warnings];
  }

  /**
   * Bridge accessor for the TUI composer's MCP picker. Walks the live
   * MCP manager and projects each configured server into the upstream
   * `MCPServerConnection` shape so `<PromptInput mcpClients={...}>`
   * can render configured, failed, disabled, and live connected servers.
   * Connected entries require the manager/service facade to expose a
   * real `getConnectedConnection(name)` result; partial manager shapes
   * fall back to pending entries instead of synthesizing SDK clients.
   */
  listMcpClients(): readonly MCPServerConnection[] {
    const manager = this.services.mcpManager as unknown as
      | McpManagerLike
      | null
      | undefined;
    if (
      manager === null ||
      manager === undefined ||
      typeof manager.getConfiguredServers !== "function" ||
      typeof manager.isConnected !== "function"
    ) {
      return [];
    }
    return projectMcpManagerToConnections(manager);
  }

  listMcpTools(): readonly unknown[] {
    const manager = this.services.mcpManager as unknown as
      | Pick<McpManager, "getTools">
      | null
      | undefined;
    if (
      manager === null ||
      manager === undefined ||
      typeof manager.getTools !== "function"
    ) {
      return [];
    }
    return manager.getTools();
  }

  /**
   * Live view of the mutable session configuration. Per-turn callers must
   * still freeze their own snapshot via the TurnContext builder.
   */
  get sessionConfiguration(): SessionConfiguration {
    return this.state.unsafePeek().sessionConfiguration;
  }

  snapshotHistoryMessages(): LLMMessage[] {
    return normalizeHistoryMessages(this.state.unsafePeek().history);
  }

  /**
   * Session-scoped provider accessor for the canonical turn builder path.
   * Throws when a loose-cast test fixture omitted the provider and then
   * attempted to use the live turn owner path.
   */
  get provider(): LLMProvider {
    const provider = (this.services as Partial<SessionServices>).provider;
    if (!provider) {
      throw new Error(
        "Session provider is required to build or run a live turn",
      );
    }
    return provider;
  }

  bindProviderConversation(provider?: LLMProvider): void {
    const target =
      provider ?? (this.services as Partial<SessionServices>).provider;
    readProviderHttpClient(target)?.bindConversationId(this.conversationId);
  }

  clearProviderResponseId(provider?: LLMProvider): void {
    const target =
      provider ?? (this.services as Partial<SessionServices>).provider;
    readProviderHttpClient(target)?.clearResponsesResponseId();
  }

  resetProviderIncrementalState(provider?: LLMProvider): void {
    const target =
      provider ?? (this.services as Partial<SessionServices>).provider;
    const client = readProviderHttpClient(target);
    client?.bindConversationId(this.conversationId);
    client?.resetResponsesContinuation();
  }

  get authManager(): AuthManager | undefined {
    return (this.services as Partial<SessionServices>).authManager;
  }

  get environment(): Environment | undefined {
    return (this.services as Partial<SessionServices>).environment;
  }

  get network(): NetworkProxy | undefined {
    return (this.services as Partial<SessionServices>).networkProxy;
  }

  get permissionModeRegistry(): PermissionModeRegistry {
    return this.services.permissionModeRegistry;
  }

  async syncPermissionContextFromRegistry(
    nextCtx: Pick<
      ToolPermissionContext,
      | "mode"
      | "isAutoModeAvailable"
      | "autoModeActive"
      | "bypassPermissionsAcceptedIn"
    > = this.permissionModeRegistry.current(),
  ): Promise<void> {
    const state = this.state.unsafePeek();
    const currentPermissionContext = (
      state.sessionConfiguration as SessionConfiguration & {
        permissionContext?: {
          readonly mode?: PermissionMode;
          readonly isAutoModeAvailable?: boolean;
          readonly autoModeActive?: boolean;
          readonly bypassPermissionsAcceptedIn?: readonly string[];
        };
      }
    ).permissionContext;
    state.sessionConfiguration = {
      ...state.sessionConfiguration,
      permissionContext: {
        ...(currentPermissionContext ?? {}),
        mode: nextCtx.mode,
        ...(nextCtx.isAutoModeAvailable !== undefined
          ? { isAutoModeAvailable: nextCtx.isAutoModeAvailable }
          : {}),
        ...(nextCtx.autoModeActive !== undefined
          ? { autoModeActive: nextCtx.autoModeActive }
          : {}),
        ...(nextCtx.bypassPermissionsAcceptedIn !== undefined
          ? {
              bypassPermissionsAcceptedIn: nextCtx.bypassPermissionsAcceptedIn,
            }
          : {}),
      },
    } as SessionConfiguration;
  }

  buildPerTurnConfig(overrides?: Partial<Config>): Readonly<Config> {
    return buildPerTurnConfig(this, overrides);
  }

  newDefaultTurnWithSubId(subId: string): TurnContext {
    return buildDefaultTurnWithSubId(this, subId);
  }

  newDefaultTurn(): TurnContext {
    return this.newDefaultTurnWithSubId(this.nextInternalSubId());
  }

  newTurnWithSubId(
    subId: string,
    configOverrides?: Partial<Config>,
  ): TurnContext {
    return buildTurnWithSubId(this, subId, configOverrides);
  }

  async consumePendingProviderSwitch(): Promise<AppliedProviderSwitchResult> {
    const pending = this.pendingProviderSwitch;
    if (!pending) {
      return { applied: false, reason: "no pending provider switch" };
    }

    const peeked = this.state.unsafePeek() as {
      sessionConfiguration?: {
        provider?: { slug?: string };
        collaborationMode?: { model?: string };
      };
    };
    const liveProvider = (this.services as Partial<SessionServices>).provider;
    const liveProviderOptions = liveProvider
      ? readProviderFactoryOptions(liveProvider)
      : undefined;
    const beforeModel =
      liveProviderOptions?.model ??
      peeked.sessionConfiguration?.collaborationMode?.model ??
      "unknown";
    const beforeProvider =
      readProviderIdentity(
        liveProvider,
        peeked.sessionConfiguration?.provider?.slug,
      ) ??
      peeked.sessionConfiguration?.provider?.slug ??
      "unknown";

    let resolvedModel = pending.model;
    let resolvedProvider = pending.provider;
    if (pending.profile) {
      const configStore = (this.services as Partial<SessionServices>)
        .configStore;
      if (configStore && typeof configStore.current === "function") {
        try {
          const { resolveProfile } = await import("../config/profiles.js");
          const overlaid = resolveProfile(
            configStore.current(),
            pending.profile,
          );
          if (overlaid.model && overlaid.model.length > 0) {
            resolvedModel = overlaid.model;
          }
          if (
            typeof overlaid.model_provider === "string" &&
            overlaid.model_provider.length > 0
          ) {
            resolvedProvider = overlaid.model_provider;
          }
        } catch {
          // The staging site already validated the profile; keep the marker's
          // raw model when the overlay lookup is unavailable here.
        }
      }
    }

    let preparedSwitch: PreparedProviderSwitch;
    try {
      const targetNormalizedProvider = normalizeProviderName(resolvedProvider);
      const liveProviderIdentity = readProviderIdentity(
        liveProvider,
        peeked.sessionConfiguration?.provider?.slug,
      );
      const reusableLiveProviderOptions =
        liveProviderOptions &&
        liveProviderIdentity !== null &&
        liveProviderIdentity === targetNormalizedProvider
          ? liveProviderOptions
          : undefined;
      const configStore = (this.services as Partial<SessionServices>)
        .configStore;
      const targetProviderSettings =
        targetNormalizedProvider !== null && configStore?.current
          ? resolveProviderSettings(
              targetNormalizedProvider,
              configStore.current(),
              process.env,
            )
          : undefined;
      const settingsOptions =
        targetNormalizedProvider !== null
          ? await providerFactoryOptionsFromSettings({
              provider: targetNormalizedProvider,
              model: resolvedModel,
              settings: targetProviderSettings,
              authBackend: this.services.authBackend,
              authSubscriptionTier: this.services.authSubscriptionTier,
              managedKeysEnabled: configStore?.current
                ? resolveAuthManagedKeysEnabled(configStore.current())
                : false,
              sessionId: this.conversationId,
              reusableApiKey: reusableLiveProviderOptions?.apiKey,
            })
          : {};
      preparedSwitch = prepareProviderSwitch(resolvedProvider, {
        ...mergeProviderFactoryOptions(
          reusableLiveProviderOptions,
          settingsOptions,
        ),
        model: settingsOptions.model ?? resolvedModel,
        tools: this.services.registry.toLLMTools(),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "provider rebuild failed";
      this.setPendingProviderSwitch(null);
      this.emit({
        id: this.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "provider_switch_rejected",
            message: `provider switch rejected: ${reason}`,
          },
        },
      });
      return { applied: false, reason };
    }

    const nextModelInfo = await deriveNextModelInfo(
      this.services.modelsManager,
      preparedSwitch.model,
    );
    const previousClient = readProviderHttpClient(liveProvider);
    const nextClient = readProviderHttpClient(preparedSwitch.instance);

    await this.state.with((state) => {
      const cfg = (
        state as {
          sessionConfiguration?: {
            provider?: unknown;
            collaborationMode?: { model?: string };
          };
        }
      ).sessionConfiguration;
      if (!cfg) return;
      cfg.provider = { slug: preparedSwitch.provider };
      cfg.collaborationMode = {
        ...(cfg.collaborationMode ?? {}),
        model: preparedSwitch.model,
      };
    });

    (this as { modelInfo: ModelInfo }).modelInfo = nextModelInfo;
    (this as { config: Config }).config = {
      ...this.config,
      model: preparedSwitch.model,
    };
    (this.services as { provider: LLMProvider }).provider =
      preparedSwitch.instance;
    previousClient?.resetResponsesContinuation();
    nextClient?.bindConversationId(this.conversationId);
    nextClient?.resetResponsesContinuation();

    // Keep the sync upgrade-message snapshot in sync with the live model.
    // Bootstrap registers the initial snapshot; subsequent /model switches
    // (or recovery-driven model fallbacks) flow through here so the
    // post-compact stdout breadcrumb continues to surface accurate
    // upgrade tips after a switch.
    setContextWindowUpgradeContext({
      currentModel: preparedSwitch.model,
      modelsManager: this.services.modelsManager,
    });

    this.setPendingProviderSwitch(null);

    this.emit({
      id: this.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "provider_switched",
          message: `provider ${beforeProvider} -> ${preparedSwitch.provider}; model ${beforeModel} -> ${preparedSwitch.model}; previous_response_id reset${
            pending.profile ? `; profile ${pending.profile}` : ""
          }`,
        },
      },
    });
    return {
      applied: true,
      provider: preparedSwitch.provider,
      model: preparedSwitch.model,
    };
  }

  async *runTurn(
    userMessage: string | readonly LLMContentPart[],
    opts: SessionRunTurnOptions = {},
  ): AsyncGenerator<PhaseEvent, Terminal> {
    if (
      opts.ctx !== undefined &&
      (opts.subId !== undefined || opts.configOverrides !== undefined)
    ) {
      throw new Error(
        "Session.runTurn accepts either ctx or subId/configOverrides, not both",
      );
    }
    if (opts.ctx === undefined && this.pendingProviderSwitch !== null) {
      await this.consumePendingProviderSwitch();
    }
    const ctx =
      opts.ctx ??
      (opts.configOverrides !== undefined
        ? this.newTurnWithSubId(
            opts.subId ?? this.nextInternalSubId(),
            opts.configOverrides,
          )
        : this.newDefaultTurnWithSubId(opts.subId ?? this.nextInternalSubId()));
    const {
      ctx: _ctx,
      subId: _subId,
      configOverrides: _configOverrides,
      ...runOpts
    } = opts;
    void _ctx;
    void _subId;
    void _configOverrides;
    const { runTurnKernel } = await import("./run-turn.js");
    const history =
      runOpts.history ??
      normalizeHistoryMessages(this.state.unsafePeek().history);
    const iter = runWithCurrentRuntimeSession(this, () =>
      runTurnKernel(this, ctx, userMessage, {
        ...runOpts,
        history,
      }),
    );
    let completed = false;
    try {
      while (true) {
        const next = await runWithCurrentRuntimeSession(this, () => iter.next());
        if (next.done) {
          completed = true;
          return next.value;
        }
        yield next.value;
      }
    } finally {
      if (!completed) {
        await runWithCurrentRuntimeSession(this, () =>
          iter.return({ reason: "cancelled" }),
        );
      }
    }
  }

  installTurnDriverHooks(hooks: SessionTurnDriverHooks | null): void {
    this.turnDriverHooks = hooks;
  }

  setInitialTranscriptEvents(events: readonly unknown[]): void {
    this.initialTranscriptEvents = events;
  }

  getInitialTranscriptEvents(): readonly unknown[] {
    return this.initialTranscriptEvents;
  }

  subscribeToEvents(cb: (event: PhaseEvent) => void): () => void {
    this.phaseEventListeners.add(cb);
    return () => {
      this.phaseEventListeners.delete(cb);
    };
  }

  emitPhaseEvent(event: PhaseEvent): void {
    for (const listener of this.phaseEventListeners) {
      try {
        listener(event);
      } catch {
        // Keep parity with EventLog subscriber isolation.
      }
    }
  }

  isRolloutPersistenceSuspended(): boolean {
    return this.rolloutPersistenceSuspendDepth > 0;
  }

  async withRolloutPersistenceSuspended<T>(fn: () => Promise<T>): Promise<T> {
    this.rolloutPersistenceSuspendDepth += 1;
    try {
      return await fn();
    } finally {
      this.rolloutPersistenceSuspendDepth -= 1;
    }
  }

  async submit(
    message: string | readonly LLMContentPart[],
    opts: SessionSubmitOptions = {},
  ): Promise<void> {
    const hooks = this.turnDriverHooks;
    if (hooks === null) {
      throw new Error("Session submit hook is not installed");
    }
    const run = this.submitQueue.then(() => hooks.submit(message, opts));
    this.submitQueue = run.catch(() => {
      /* keep the queue alive for the next submit */
    });
    return run;
  }

  async flushEventLog(): Promise<void> {
    const flush = this.turnDriverHooks?.flushEventLog;
    if (flush) {
      await flush();
      return;
    }
    this.rolloutStore?.flushDurable();
  }

  /**
   * Mirrors agenc runtime `Session::next_internal_sub_id` — monotonic id allocation.
   */
  nextInternalSubId(): string {
    const id = this.nextInternalSubIdValue;
    this.nextInternalSubIdValue += 1;
    return `sub-${this.conversationId}-${id}`;
  }

  async partialCompactFromMessage(
    params: SessionPartialCompactFromMessageParams,
  ): Promise<SessionPartialCompactFromMessageResult> {
    const rolloutStore = this.rolloutStore;
    if (rolloutStore === null) {
      return this.partialCompactFailure(
        "ROLLOUT_UNAVAILABLE",
        "Conversation summarization requires a durable session history.",
      );
    }
    if (rolloutStore.isDegraded) {
      return this.partialCompactFailure(
        "ROLLOUT_DEGRADED",
        "Conversation summarization is disabled because durable session history is degraded.",
      );
    }

    const abortController = new AbortController();
    const onCallerAbort = (): void => {
      if (!abortController.signal.aborted) {
        abortController.abort(
          (params.signal as (AbortSignal & { reason?: unknown }) | undefined)
            ?.reason,
        );
      }
    };
    if (params.signal?.aborted === true) {
      onCallerAbort();
    } else {
      params.signal?.addEventListener("abort", onCallerAbort, { once: true });
    }

    let task: RunningTask | null = null;
    try {
      task = await this.beginIdleTask({
        subId: this.nextInternalSubId(),
        kind: "compact",
        autoStart: false,
        abortController,
      });
    } catch (error) {
      params.signal?.removeEventListener("abort", onCallerAbort);
      if (
        error instanceof Error &&
        error.message.includes("turn is currently in flight")
      ) {
        return this.partialCompactFailure(
          "ACTIVE_TURN",
          "Cannot summarize right now: a turn is currently in flight.",
        );
      }
      throw error;
    }

    try {
      this.throwIfPartialCompactAborted(abortController.signal);
      const sourceHistory = this.snapshotHistoryMessages();
      const { prefixBeforeActive, activeHistory } =
        splitActiveHistory(sourceHistory);
      const selectedIndex = activeHistoryIndexForOrdinal(
        activeHistory,
        params.messageOrdinal,
      );
      if (selectedIndex === null) {
        return this.partialCompactFailure(
          "MESSAGE_NOT_FOUND",
          "The selected message is no longer in the active conversation.",
        );
      }

      const context = this.buildPartialCompactContext(abortController);
      const compactionResult = await partialCompactConversationAsync(
        toCompactRuntimeMessages(activeHistory),
        selectedIndex,
        context,
        {
          direction: params.direction,
          ...(params.feedback !== undefined
            ? { feedback: params.feedback }
            : {}),
          signal: abortController.signal,
        },
      );
      this.throwIfPartialCompactAborted(abortController.signal);
      const compactedActiveHistory = fromCompactRuntimeMessages(
        buildPostCompactMessages(compactionResult),
      );
      const replacementHistory = [
        ...prefixBeforeActive,
        ...compactedActiveHistory,
      ].map(cloneLlmMessage);
      const event = createHistoryReplacedEvent({
        replacementHistory,
        id: `history-replaced-${task.subId}`,
      });
      const displayText =
        compactionResult.userDisplayMessage ??
        compactionMessage(compactionResult);

      const commitFailure = await this.commitPartialCompaction({
        task,
        signal: abortController.signal,
        rolloutStore,
        replacementHistory,
        compactionResult,
      });
      if (commitFailure !== null) return commitFailure;

      return {
        ok: true,
        sessionId: this.conversationId,
        eventAlreadyEmitted: false,
        event,
        replacementHistory,
        displayText,
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        return this.partialCompactFailure(
          "ABORTED",
          "Conversation summarization was cancelled.",
        );
      }
      throw error;
    } finally {
      params.signal?.removeEventListener("abort", onCallerAbort);
      if (task !== null) {
        await this.onTaskFinished(task.subId);
      }
    }
  }

  async rewindConversationToMessage(
    params: SessionRewindConversationToMessageParams,
  ): Promise<SessionRewindConversationToMessageResult> {
    const rolloutStore = this.rolloutStore;
    if (rolloutStore === null) {
      return this.conversationRewindFailure(
        "ROLLOUT_UNAVAILABLE",
        "Conversation rewind requires a durable session history.",
      );
    }
    if (rolloutStore.isDegraded) {
      return this.conversationRewindFailure(
        "ROLLOUT_DEGRADED",
        "Conversation rewind is disabled because durable session history is degraded.",
      );
    }

    let task: RunningTask | null = null;
    try {
      task = await this.beginIdleTask({
        subId: this.nextInternalSubId(),
        kind: "compact",
        autoStart: false,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("turn is currently in flight")
      ) {
        return this.conversationRewindFailure(
          "ACTIVE_TURN",
          "Cannot rewind right now: a turn is currently in flight.",
        );
      }
      throw error;
    }

    try {
      const sourceHistory = this.snapshotHistoryMessages();
      const { prefixBeforeActive, activeHistory } =
        splitActiveHistory(sourceHistory);
      const selectedIndex = activeHistoryIndexForOrdinal(
        activeHistory,
        params.messageOrdinal,
      );
      if (selectedIndex === null) {
        return this.conversationRewindFailure(
          "MESSAGE_NOT_FOUND",
          "The selected message is no longer in the active conversation.",
        );
      }

      const replacementHistory = [
        ...prefixBeforeActive,
        ...activeHistory.slice(0, selectedIndex),
      ].map(cloneLlmMessage);
      const event = createHistoryReplacedEvent({
        replacementHistory,
        id: `history-replaced-${task.subId}`,
        reason: "rewind",
      });
      const displayText = "Conversation rewound";

      const commitFailure = await this.commitConversationRewind({
        task,
        rolloutStore,
        replacementHistory,
      });
      if (commitFailure !== null) return commitFailure;

      return {
        ok: true,
        sessionId: this.conversationId,
        eventAlreadyEmitted: false,
        event,
        replacementHistory,
        displayText,
      };
    } finally {
      if (task !== null) {
        await this.onTaskFinished(task.subId);
      }
    }
  }

  private partialCompactFailure(
    code: SessionPartialCompactErrorCode,
    message: string,
  ): SessionPartialCompactFromMessageResult {
    return {
      ok: false,
      sessionId: this.conversationId,
      eventAlreadyEmitted: false,
      code,
      message,
    };
  }

  private conversationRewindFailure(
    code: SessionConversationRewindErrorCode,
    message: string,
  ): SessionRewindConversationToMessageResult {
    return {
      ok: false,
      sessionId: this.conversationId,
      eventAlreadyEmitted: false,
      code,
      message,
    };
  }

  private throwIfPartialCompactAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error("Conversation summarization was cancelled.");
    }
  }

  private async beginIdleTask(opts: SpawnTaskOptions): Promise<RunningTask> {
    return this.taskDispatchLock.with(async () => {
      const active = await this.activeTurn.with((current) => current);
      if (active !== null) {
        throw new Error(
          "Cannot start idle task right now: a turn is currently in flight.",
        );
      }
      return await this.startTask(opts);
    });
  }

  private buildPartialCompactContext(
    abortController: AbortController,
  ): CompactContext {
    const surface = this as unknown as {
      readonly setStreamMode?: CompactContext["setStreamMode"];
      readonly setResponseLength?: CompactContext["setResponseLength"];
      readonly onCompactProgress?: CompactContext["onCompactProgress"];
      readonly setSDKStatus?: CompactContext["setSDKStatus"];
    };
    return {
      abortController,
      provider: this.services.provider,
      setStreamMode: surface.setStreamMode,
      setResponseLength: surface.setResponseLength,
      onCompactProgress: surface.onCompactProgress,
      setSDKStatus: surface.setSDKStatus,
      options: {
        mainLoopModel:
          this.modelInfo.slug ??
          this.sessionConfiguration.collaborationMode?.model,
        ...(this.modelInfo.contextWindow !== undefined
          ? { contextWindowTokens: this.modelInfo.contextWindow }
          : {}),
        ...(this.modelInfo.maxOutputTokens !== undefined
          ? { maxOutputTokens: this.modelInfo.maxOutputTokens }
          : {}),
      },
      deps: {
        cleanup: {
          clearProviderResponseId: () => this.clearProviderResponseId(),
        },
      },
    };
  }

  private async commitPartialCompaction(params: {
    readonly task: RunningTask;
    readonly signal: AbortSignal;
    readonly rolloutStore: RolloutStore;
    readonly replacementHistory: readonly LLMMessage[];
    readonly compactionResult: CompactionResult;
  }): Promise<SessionPartialCompactFromMessageResult | null> {
    let failure: SessionPartialCompactFromMessageResult | null = null;
    await this.taskDispatchLock.with(async () => {
      if (params.signal.aborted) {
        failure = this.partialCompactFailure(
          "ABORTED",
          "Conversation summarization was cancelled.",
        );
        return;
      }
      const ownsTask = await this.activeTurn.with(
        (current) => current?.tasks.has(params.task.subId) === true,
      );
      if (!ownsTask) {
        failure = this.partialCompactFailure(
          "ABORTED",
          "Conversation summarization was cancelled.",
        );
        return;
      }
      if (params.rolloutStore.isDegraded) {
        failure = this.partialCompactFailure(
          "ROLLOUT_DEGRADED",
          "Conversation summarization is disabled because durable session history is degraded.",
        );
        return;
      }
      const postCompactTokens =
        params.compactionResult.truePostCompactTokenCount ??
        params.compactionResult.postCompactTokenCount;
      params.rolloutStore.appendRollout(
        {
          type: "compacted",
          payload: {
            message: compactionMessage(params.compactionResult),
            replacementHistory: params.replacementHistory.map(
              llmMessageToResponseItem,
            ),
            ...(params.compactionResult.preCompactTokenCount !== undefined
              ? {
                  preCompactTokens:
                    params.compactionResult.preCompactTokenCount,
                }
              : {}),
            ...(postCompactTokens !== undefined ? { postCompactTokens } : {}),
          },
        },
        { durable: true },
      );
      await this.state.with((sessionState) => {
        sessionState.history = params.replacementHistory.map(cloneLlmMessage);
      });
      this.clearProviderResponseId();
    });
    return failure;
  }

  private async commitConversationRewind(params: {
    readonly task: RunningTask;
    readonly rolloutStore: RolloutStore;
    readonly replacementHistory: readonly LLMMessage[];
  }): Promise<SessionRewindConversationToMessageResult | null> {
    let failure: SessionRewindConversationToMessageResult | null = null;
    await this.taskDispatchLock.with(async () => {
      const ownsTask = await this.activeTurn.with(
        (current) => current?.tasks.has(params.task.subId) === true,
      );
      if (!ownsTask) {
        failure = this.conversationRewindFailure(
          "ACTIVE_TURN",
          "Conversation rewind was cancelled.",
        );
        return;
      }
      if (params.rolloutStore.isDegraded) {
        failure = this.conversationRewindFailure(
          "ROLLOUT_DEGRADED",
          "Conversation rewind is disabled because durable session history is degraded.",
        );
        return;
      }
      params.rolloutStore.appendRollout(
        {
          type: "compacted",
          payload: {
            message: "Conversation rewound",
            replacementHistory: params.replacementHistory.map(
              llmMessageToResponseItem,
            ),
          },
        },
        { durable: true },
      );
      await this.state.with((sessionState) => {
        sessionState.history = params.replacementHistory.map(cloneLlmMessage);
      });
      this.clearProviderResponseId();
    });
    return failure;
  }

  /**
   * Synchronously emit an event. Routes through:
   *
   *   1. EventLog (T6) — assigns monotonic seq (I-27), fans to
   *      subscribed sidecars (I-43 per-sidecar isolation).
   *   2. RolloutStore (T6, when wired) — appends to the JSONL
   *      rollout; durable events (TurnComplete, TurnAborted, Error,
   *      ContextCompacted) force fsync before returning (I-4).
   *   3. txEvent (compatibility) — kept for consumers that still use
   *      `for await ... of session.txEvent.stream()`.
   *
   * I-8: every error site MUST funnel through this or the dedicated
   * `emitError` helper (event-log.ts).
   */
  emit(event: Event, appendOpts: AppendOptions = {}): void {
    if (
      event.msg.type === "context_compacted" ||
      (event.msg as { type?: string }).type === "compacted"
    ) {
      this.clearProviderResponseId();
    }
    // I-27: assign seq synchronously + fan to subscribers.
    const stamped = this.eventLog.emit(event);
    const derivedTurnId =
      appendOpts.turnId ??
      (stamped.msg.type === "tool_call_completed"
        ? this.activeTurn.unsafePeek()?.turnId
        : undefined);
    const derivedToolResultBytes =
      appendOpts.toolResultBytes ??
      (stamped.msg.type === "tool_call_completed"
        ? measureToolResultBytes(stamped.msg.payload.result)
        : undefined);
    // T6: persist if store is wired. isDurableEvent triggers I-4 fsync.
    if (this.rolloutStore && !this.isRolloutPersistenceSuspended()) {
      this.rolloutStore.append(stamped, {
        durable: isDurableEvent(stamped) || appendOpts.durable === true,
        ...(derivedTurnId !== undefined ? { turnId: derivedTurnId } : {}),
        ...(derivedToolResultBytes !== undefined
          ? { toolResultBytes: derivedToolResultBytes }
          : {}),
      });
    }
    // Compatibility consumer path.
    this.txEvent.send(stamped);
  }

  /**
   * AgenC behavior: send_event with the configured sub_id + msg.
   */
  sendEvent(subId: string, msg: EventMsg): void {
    this.emit({ id: subId, msg });
  }

  emitTurnAbortedOnce(turnId: string, reason: string): void {
    if (this.emittedTaskAbortTurnIds.has(turnId)) return;
    this.emittedTaskAbortTurnIds.add(turnId);
    this.emit({
      id: this.nextInternalSubId(),
      msg: {
        type: "turn_aborted",
        payload: { turnId, reason },
      },
    });
  }

  clearTurnAbortMarker(turnId: string): void {
    this.emittedTaskAbortTurnIds.delete(turnId);
  }

  /**
   * Session-owned MCP startup contract for the live runtime path.
   * Callers may construct the concrete manager, but attach/start
   * ordering lives here so bootstrap/CLI do not each invent their own
   * sequencing.
   */
  async startMcpManager(
    manager: MCPManager,
    opts: MCPManagerStartOpts = {},
  ): Promise<void> {
    await startMcpManagerForSession(manager, this, opts);
  }

  /**
   * AgenC behavior seam for the empty-input fast-path in `run_turn`.
   *
   * Today the active-turn pending-input queue is not ported yet, so the
   * live check covers the mailbox-backed idle/peer traffic that can wake
   * the next turn. This is the only state `run-turn.ts` needs to decide
   * whether an empty submission is a no-op or should continue.
   */
  hasPendingInput(): boolean {
    return this.mailbox.hasPending();
  }

  async waitForMailboxChange(timeoutMs: number): Promise<boolean> {
    if (this.mailbox.hasPending()) {
      return true;
    }
    if (this.mailboxSeqWatch.isClosed) {
      return false;
    }
    const startSeq = this.mailboxSeqWatch.value;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const unsubscribe = this.mailboxSeqWatch.subscribe((seq) => {
        if (seq !== startSeq) {
          finish(true);
        }
      });
    });
  }

  /**
   * Idle-input merge into the session mailbox. Replaces the old
   * `idlePendingInput: AsyncLock<unknown[]>` slot. Idle input is
   * wrapped in an `InterAgentCommunication` envelope with
   * `direction: 'down'` (parent/cockpit → session) and
   * `metadata.source = MAILBOX_SOURCE_IDLE_INPUT`, and `triggerTurn`
   * set to false so the idle-merge point can collect pending items
   * without the mailbox waking the turn machine on its own. The
   * payload is stored on `metadata.payload` so `drainIdleInput()`
   * can round-trip the original `UserInput` back to callers.
   *
   * AgenC behavior: matches `core/src/session/session.rs` line 23's
   * pending-input slot, routed through the same mailbox that carries
   * peer/agent traffic.
   */
  enqueueIdleInput(input: UserInput): number {
    return this.mailbox.send({
      author: this.conversationId,
      recipient: this.conversationId,
      content: "",
      triggerTurn: false,
      direction: "down",
      metadata: {
        source: MAILBOX_SOURCE_IDLE_INPUT,
        payload: input,
      },
    });
  }

  /**
   * Drain all idle-source envelopes currently queued on the session
   * mailbox. Non-idle traffic (peer/agent messages routed through the
   * same mailbox) is preserved and re-enqueued in arrival order so
   * callers that want idle input do not consume unrelated messages.
   *
   * Returns the original `UserInput` payloads in FIFO order — the
   * session-local `InterAgentCommunication` envelope is stripped.
   */
  drainIdleInput(): UserInput[] {
    const drained = this.mailbox.drain();
    const idleItems: UserInput[] = [];
    const passthrough: InterAgentCommunication[] = [];
    for (const msg of drained) {
      const source = msg.metadata?.source;
      if (source === MAILBOX_SOURCE_IDLE_INPUT) {
        idleItems.push(msg.metadata?.payload);
      } else {
        passthrough.push(msg);
      }
    }
    // Re-enqueue non-idle messages so other consumers still see them.
    for (const msg of passthrough) {
      const { seq: _omitted, ...rest } = msg;
      void _omitted;
      this.mailbox.send(rest);
    }
    return idleItems;
  }

  drainPendingInputMessages(): LLMMessage[] {
    const drained = this.mailbox.drain();
    const messages: LLMMessage[] = [];
    for (const msg of drained) {
      const source = msg.metadata?.source;
      if (source === MAILBOX_SOURCE_IDLE_INPUT) {
        const payload = msg.metadata?.payload;
        if (
          payload !== null &&
          typeof payload === "object" &&
          "role" in payload &&
          "content" in payload
        ) {
          messages.push(payload as LLMMessage);
        } else if (typeof payload === "string" && payload.trim().length > 0) {
          messages.push({ role: "user", content: payload });
        }
        continue;
      }
      if (msg.content.trim().length === 0) {
        continue;
      }
      const author = msg.author.trim().length > 0 ? msg.author : "agent";
      messages.push({
        role: "user",
        content: `Message from ${author}:\n${msg.content}`,
      });
    }
    return messages;
  }

  /**
   * Upstream agenc runtime `session/mod.rs::steer_input` (line 2938). Folds
   * `items` into the live turn's mailbox/idle-input pipeline so the
   * running task picks them up at the next idle-merge boundary, and
   * sets the mailbox delivery phase back to `current_turn` so the
   * injected items stay in THIS turn rather than deferring.
   *
   * Rejection surface mirrors upstream 1:1:
   *   - `empty_input` when `items` is empty — matches
   *     `SteerInputError::EmptyInput` (`session/mod.rs:2944`).
   *   - `no_active_turn` when the `activeTurn` slot is `null` OR its
   *     task registry is empty. Carries `items` back to the caller
   *     unchanged so no data is lost. Matches
   *     `SteerInputError::NoActiveTurn(input)` (`session/mod.rs:2950`,
   *     2954, 2978).
   *   - `sub_id_mismatch` when the caller's `subId` does not match
   *     the live turn's first task id. Matches upstream
   *     `SteerInputError::ExpectedTurnMismatch` (`session/mod.rs:2960`),
   *     renamed to fit gut's `subId` naming on `RunningTask`.
   *   - `active_turn_not_steerable` when the live task's `kind` is
   *     `compact` or `review`. Matches upstream's explicit arm
   *     rejection (`session/mod.rs:2967-2979`) via the shared
   *     `isSteerable` predicate in `tasks.ts`.
   *
   * Happy path: appends each item to `Session.mailbox` via the same
   * `enqueueIdleInput` envelope the caller-side path uses (so the
   * existing `drainIdleInput` consumer keeps working without a second
   * code path), then accepts mailbox delivery for the current turn by
   * flipping `ActiveTurnState.mailboxDeliveryPhase` back to
   * `current_turn` under the per-turn lock. Returns the subId that
   * accepted the steer, matching upstream's `Ok(active_turn_id.clone())`.
   */
  async steerInput(
    subId: string,
    items: readonly LLMMessage[],
  ): Promise<SteerInputResult> {
    if (items.length === 0) {
      return { ok: false, error: { kind: "empty_input" } };
    }

    // Upstream takes `active_turn.lock().await` for the whole check +
    // update so steer state stays atomic (see the clippy `expect` at
    // `session/mod.rs:2934-2937`). Gut's `AsyncLock.with` gives the
    // same serialization window — the mailbox + turnState writes
    // happen before we release the lock.
    const result = await this.activeTurn.with(
      async (current): Promise<SteerInputResult> => {
        if (current === null) {
          return {
            ok: false,
            error: { kind: "no_active_turn", items: [...items] },
          };
        }
        const firstEntry = current.tasks.entries().next();
        if (firstEntry.done === true) {
          return {
            ok: false,
            error: { kind: "no_active_turn", items: [...items] },
          };
        }
        const [activeSubId, activeTask] = firstEntry.value;

        if (subId !== activeSubId) {
          return {
            ok: false,
            error: {
              kind: "sub_id_mismatch",
              expected: subId,
              actual: activeSubId,
            },
          };
        }

        if (!isSteerable(activeTask.kind)) {
          const nonSteerable = nonSteerableTurnKindFrom(activeTask.kind);
          // `nonSteerable` is guaranteed non-null when `isSteerable`
          // returned false; the branch is exhaustive on `TaskKind`.
          if (nonSteerable === null) {
            // Unreachable: exhaustive on TaskKind. Kept as an honest
            // branch rather than a `!` assertion so future TaskKind
            // additions show up as a compile error instead of a
            // silent misclassification.
            return {
              ok: false,
              error: { kind: "no_active_turn", items: [...items] },
            };
          }
          return {
            ok: false,
            error: {
              kind: "active_turn_not_steerable",
              turnKind: nonSteerable,
            },
          };
        }

        // Accepted. Route each item through the existing idle-input
        // envelope so `drainIdleInput` sees them in FIFO order with no
        // second consumer path. Upstream calls
        // `turn_state.push_pending_input(input.into())` which lands on
        // `TurnState.pending_input`; gut's `pending_input` is
        // WIRED-EXTERNAL through the mailbox per the classification in
        // `tasks.ts`, so the equivalent gut surface is `enqueueIdleInput`.
        for (const item of items) {
          this.enqueueIdleInput(item);
        }

        // Upstream: `turn_state.accept_mailbox_delivery_for_current_turn()`
        // (`session/mod.rs:2992`). Re-affirm `current_turn` delivery so
        // a late `defer_mailbox_delivery_to_next_turn` earlier in this
        // turn does not strand the steered items.
        await current.turnState.with((ts) => {
          ts.mailboxDeliveryPhase = "current_turn";
        });

        return { ok: true, subId: activeSubId, accepted: items.length };
      },
    );

    return result;
  }

  /**
   * Attach a RolloutStore. Subsequent `emit()` calls will persist to
   * the store. Replaces any previously-mounted store (the previous
   * one should be `close()`d by the caller first).
   *
   * Wires the store's diagnostic listener so I-38/I-83 diagnostics
   * (fsync_failed, event_log_batch_delayed, snapshot_write_failed,
   * rollout_degraded) surface through the event log.
   */
  mountRolloutStore(store: RolloutStore | null): void {
    this.rolloutStore = store;
    if (store) {
      store.store.setDiagnosticListener((d) => {
        this.emit({
          id: this.nextInternalSubId(),
          msg: {
            type: d.level,
            payload: { cause: d.cause, message: d.message },
          } as EventMsg,
        });
      });
    }
  }

  /**
   * AgenC behavior: send_event_raw — emit with caller-supplied envelope.
   * Used for SessionConfigured + DeprecationNotice events at startup
   * (agenc runtime session.rs:746-748).
   */
  sendEventRaw(event: Event): void {
    this.emit(event);
  }

  // ───────────────────────────────────────────────────────────
  // Task dispatch — port of upstream agenc runtime `tasks/mod.rs`.
  // See `session/tasks.ts` for the rationale. These methods own the
  // `activeTurn` lock so the outer "one turn in flight at a time"
  // invariant is enforced at every spawn / finish / abort site.
  // ───────────────────────────────────────────────────────────

  /**
   * Upstream agenc runtime `tasks/mod.rs::spawn_task`. Serializes the new-turn
   * boundary: first aborts any in-flight task with `TurnAbortReason::Replaced`
   * (matching upstream's `abort_all_tasks(TurnAbortReason::Replaced)`),
   * then installs a fresh `ActiveTurn` for the new task keyed by `subId`.
   *
   * Returns the `RunningTask` so callers can pull its `.signal` for the
   * kernel loop and hold onto `resolveDone` / `abortController` for the
   * finish / cancel paths. Callers are expected to invoke
   * `session.onTaskFinished(subId)` in a `finally` so the registry
   * entry is cleaned up on every exit path.
   */
  async spawnTask(opts: SpawnTaskOptions): Promise<RunningTask> {
    return this.taskDispatchLock.with(async () => {
      // Upstream agenc runtime: `spawn_task` always calls
      // `abort_all_tasks(TurnAbortReason::Replaced)` before installing
      // the new task. This is the non-negotiable serialization point.
      await this.abortAllTasksLocked("replaced");
      return await this.startTask(opts);
    });
  }

  /**
   * Upstream agenc runtime `tasks/mod.rs::start_task`. Installs the task under
   * `activeTurn` after the caller has serialized the abort-then-start
   * boundary.
   */
  private async startTask(opts: SpawnTaskOptions): Promise<RunningTask> {
    const abortController = opts.abortController ?? new AbortController();
    const { done, resolveDone } = createDoneHandle();
    const taskObject = opts.task;
    const turnContext = opts.turnContext;
    const taskKind = taskObject?.kind() ?? opts.kind;
    const task: RunningTask = {
      subId: opts.subId,
      kind: taskKind,
      ...(taskObject !== undefined ? { task: taskObject } : {}),
      ...(turnContext !== undefined ? { turnContext } : {}),
      abortController,
      done,
      resolveDone,
      startedAtMs: opts.startedAtMs ?? Date.now(),
    };
    const turnState = new AsyncLock<ActiveTurnState>(createActiveTurnState());
    if (opts.tokenUsageAtTurnStart !== undefined) {
      const seeded = opts.tokenUsageAtTurnStart;
      await turnState.with((s) => {
        s.tokenUsageAtTurnStart = { ...seeded };
      });
    }
    await this.activeTurn.swap({
      turnId: task.subId,
      startedAtMs: task.startedAtMs,
      abortController,
      tasks: new Map([[task.subId, task]]),
      turnState,
    });

    if (
      taskObject !== undefined &&
      turnContext !== undefined &&
      opts.autoStart !== false
    ) {
      const sessionTaskContext = createSessionTaskContext(this);
      task.handle = taskObject
        .run({
          session: sessionTaskContext,
          turnContext,
          input: opts.input ?? [],
          signal: abortController.signal,
        })
        .finally(async () => {
          await this.onTaskFinished(opts.subId);
        });
    }

    return task;
  }

  /**
   * Upstream agenc runtime `tasks/mod.rs::on_task_finished`. Removes the task
   * from the `tasks` registry. When the registry empties, clears the
   * `activeTurn` slot so the next `spawnTask` sees a clean state.
   *
   * This is the normal-exit cleanup; the abort paths go through
   * `abortAllTasks` / `abortTurnIfActive` which also trigger
   * `resolveDone` so `handle_task_abort`'s awaiter unblocks.
   */
  async onTaskFinished(subId: string): Promise<void> {
    await this.activeTurn.update((current) => {
      if (current === null) {
        return { next: null, result: undefined };
      }
      const task = current.tasks.get(subId);
      if (task !== undefined) {
        current.tasks.delete(subId);
        task.resolveDone();
        this.clearTurnAbortMarker(subId);
      }
      return {
        next: current.tasks.size === 0 ? null : current,
        result: undefined,
      };
    });
  }

  /**
   * Upstream agenc runtime `tasks/mod.rs::abort_all_tasks`. Takes the
   * `activeTurn` slot (upstream `take_active_turn`), drains every
   * running task by firing its cancellation token and awaiting its
   * `done` signal under the graceful-interruption budget, then
   * clears pending state and releases.
   */
  async abortAllTasks(reason: TurnAbortReason): Promise<void> {
    await this.taskDispatchLock.with(async () => {
      await this.abortAllTasksLocked(reason);
    });
  }

  /**
   * Body of `abortAllTasks` without retaking `taskDispatchLock`. Callers
   * MUST already hold it (e.g. `spawnTask` holds it for the full
   * abort-then-install sequence).
   */
  private async abortAllTasksLocked(reason: TurnAbortReason): Promise<void> {
    const taken = await this.activeTurn.swap(null);
    if (taken === null) return;
    const tasks = Array.from(taken.tasks.values());
    await Promise.all(tasks.map((task) => this.handleTaskAbort(task, reason)));
    // Upstream: `active_turn.clear_pending().await` — release any
    // dangling approvals / input pre-emptively so interrupted tasks
    // don't surface stale responses. We reach into `turnState` here
    // because the `ActiveTurn` object itself is already taken out.
    await taken.turnState.with((ts) => {
      ts.pendingApprovals.clear();
      ts.pendingRequestPermissions.clear();
      ts.pendingUserInput.clear();
      ts.pendingElicitations.clear();
      ts.pendingDynamicTools.clear();
      ts.pendingInput.length = 0;
    });
  }

  /**
   * Upstream agenc runtime `tasks/mod.rs::abort_turn_if_active`. If the
   * currently-active turn's registry contains `turnId`, aborts it;
   * otherwise returns false.
   */
  async abortTurnIfActive(
    turnId: string,
    reason: TurnAbortReason,
  ): Promise<boolean> {
    const taken = await this.activeTurn.update((current) => {
      if (current === null || !current.tasks.has(turnId)) {
        return { next: current, result: null };
      }
      return { next: null, result: current };
    });
    if (taken === null) return false;
    const tasks = Array.from(taken.tasks.values());
    await Promise.all(tasks.map((task) => this.handleTaskAbort(task, reason)));
    await taken.turnState.with((ts) => {
      ts.pendingApprovals.clear();
      ts.pendingRequestPermissions.clear();
      ts.pendingUserInput.clear();
      ts.pendingElicitations.clear();
      ts.pendingDynamicTools.clear();
      ts.pendingInput.length = 0;
    });
    return true;
  }

  /**
   * Upstream agenc runtime `tasks/mod.rs::handle_task_abort`. Fires the task's
   * cancellation signal, awaits `done` up to `GRACEFUL_INTERRUPTION_TIMEOUT_MS`,
   * then returns even if the task did not signal done in time. We do
   * not call `handle.abort()` like upstream does because JS has no
   * force-kill primitive for a pending Promise; the bounded wait + the
   * task's own cancellation-signal check are the gut equivalents.
   */
  private async handleTaskAbort(
    task: RunningTask,
    reason: TurnAbortReason,
  ): Promise<void> {
    if (task.abortController.signal.aborted) {
      task.resolveDone();
      return;
    }
    task.abortController.abort(reason);
    await waitForDoneWithin(task.done, GRACEFUL_INTERRUPTION_TIMEOUT_MS);
    if (task.task !== undefined && task.turnContext !== undefined) {
      await task.task.abort({
        session: createSessionTaskContext(this),
        turnContext: task.turnContext,
      });
    }
    if (reason === "interrupted") {
      this.emitTurnAbortedOnce(task.subId, reason);
    }
    // Ensure `done` settles even if the task never flipped it on its
    // own — callers awaiting `task.done` must progress after abort.
    task.resolveDone();
  }

  /**
   * Helpers for callers that want to check / mutate the per-turn
   * lock-guarded state. These proxy to `activeTurn.turnState` and
   * are no-ops when no turn is active.
   */
  async withActiveTurnState<R>(
    fn: (state: ActiveTurnState) => Promise<R> | R,
  ): Promise<R | undefined> {
    const current = this.activeTurn.unsafePeek();
    if (current === null) return undefined;
    return current.turnState.with(fn);
  }

  async requestUserInput(
    callId: string,
    args: RequestUserInputArgs,
    signal?: AbortSignal,
  ): Promise<RequestUserInputResponse | null> {
    const current = this.activeTurn.unsafePeek();
    if (current === null) return null;
    const turnId = current.turnId;
    const requestId = callId;
    const event: RequestUserInputEvent = {
      requestId,
      callId,
      turnId,
      questions: args.questions,
    };
    const directResolver = this.services.requestUserInputResolver;
    if (directResolver !== undefined) {
      const abortWaiter = waitForAbortSignal([
        signal,
        current.abortController.signal,
        this.abortController.signal,
      ]);
      if (abortWaiter.aborted) {
        abortWaiter.cleanup();
        return null;
      }
      const resolverAbort = new AbortController();
      const abortPromise = abortWaiter.promise.then((result) => {
        resolverAbort.abort("elicitation_cancelled");
        return result;
      });
      this.emit({
        id: this.nextInternalSubId(),
        msg: {
          type: "request_user_input",
          payload: event,
        },
      });
      try {
        return await Promise.race([
          directResolver.request(event, resolverAbort.signal),
          abortPromise,
        ]);
      } finally {
        resolverAbort.abort("elicitation_settled");
        abortWaiter.cleanup();
      }
    }
    let resolveResponse:
      | ((response: RequestUserInputResponse | null) => void)
      | undefined;
    const responsePromise = new Promise<RequestUserInputResponse | null>(
      (resolve) => {
        resolveResponse = resolve;
      },
    );
    await current.turnState.with((ts) => {
      ts.pendingUserInput.set(requestId, (response) =>
        resolveResponse?.(response as RequestUserInputResponse | null),
      );
    });
    const abortWaiter = waitForAbortSignal([
      signal,
      current.abortController.signal,
      this.abortController.signal,
    ]);
    const cleanup = async (): Promise<void> => {
      abortWaiter.cleanup();
      await current.turnState.with((ts) => {
        ts.pendingUserInput.delete(requestId);
      });
    };
    if (abortWaiter.aborted) {
      await cleanup();
      return null;
    }
    this.emit({
      id: this.nextInternalSubId(),
      msg: {
        type: "request_user_input",
        payload: event,
      },
    });
    try {
      return await Promise.race([responsePromise, abortWaiter.promise]);
    } finally {
      await cleanup();
    }
  }

  async notifyUserInputResponse(
    requestId: string,
    response: RequestUserInputResponse | null,
  ): Promise<boolean> {
    const resolver = await this.withActiveTurnState((ts) => {
      const pending = ts.pendingUserInput.get(requestId);
      if (pending !== undefined) {
        ts.pendingUserInput.delete(requestId);
      }
      return pending;
    });
    if (resolver === undefined) return false;
    resolver(response);
    return true;
  }

  async requestMcpElicitation(
    serverName: string,
    requestId: McpRequestId,
    request: McpElicitationRequest,
    signal?: AbortSignal,
  ): Promise<McpElicitationResponse | null> {
    const current = this.activeTurn.unsafePeek();
    if (current === null) return null;
    const turnId = current.turnId;
    const key = mcpElicitationPendingKey(serverName, requestId);
    const event: McpElicitationRequestEvent = {
      turnId,
      serverName,
      requestId,
      request,
    };
    const directResolver = this.services.mcpElicitationResolver;
    if (directResolver !== undefined) {
      const abortWaiter = waitForAbortSignal([
        signal,
        current.abortController.signal,
        this.abortController.signal,
      ]);
      const releasePause = this.beginOutOfBandElicitationPause();
      if (abortWaiter.aborted) {
        abortWaiter.cleanup();
        releasePause();
        return null;
      }
      const resolverAbort = new AbortController();
      const abortPromise = abortWaiter.promise.then((result) => {
        resolverAbort.abort("elicitation_cancelled");
        return result;
      });
      this.emit({
        id: this.nextInternalSubId(),
        msg: {
          type: "mcp_elicitation_request",
          payload: event,
        },
      });
      try {
        return await Promise.race([
          directResolver.request(event, resolverAbort.signal),
          abortPromise,
        ]);
      } finally {
        resolverAbort.abort("elicitation_settled");
        abortWaiter.cleanup();
        releasePause();
      }
    }
    let resolveResponse:
      | ((response: McpElicitationResponse) => void)
      | undefined;
    const responsePromise = new Promise<McpElicitationResponse>((resolve) => {
      resolveResponse = resolve;
    });
    await current.turnState.with((ts) => {
      ts.pendingElicitations.set(key, (response) =>
        resolveResponse?.(response as McpElicitationResponse),
      );
    });
    const releasePause = this.beginOutOfBandElicitationPause();
    const abortWaiter = waitForAbortSignal([
      signal,
      current.abortController.signal,
      this.abortController.signal,
    ]);
    const cleanup = async (): Promise<void> => {
      abortWaiter.cleanup();
      releasePause();
      await current.turnState.with((ts) => {
        ts.pendingElicitations.delete(key);
      });
    };
    if (abortWaiter.aborted) {
      await cleanup();
      return null;
    }
    this.emit({
      id: this.nextInternalSubId(),
      msg: {
        type: "mcp_elicitation_request",
        payload: event,
      },
    });
    try {
      return await Promise.race([responsePromise, abortWaiter.promise]);
    } finally {
      await cleanup();
    }
  }

  async notifyMcpElicitationResponse(
    serverName: string,
    requestId: McpRequestId,
    response: McpElicitationResponse,
  ): Promise<boolean> {
    const key = mcpElicitationPendingKey(serverName, requestId);
    const resolver = await this.withActiveTurnState((ts) => {
      const pending = ts.pendingElicitations.get(key);
      if (pending !== undefined) {
        ts.pendingElicitations.delete(key);
      }
      return pending;
    });
    if (resolver === undefined) return false;
    resolver(response);
    return true;
  }

  private beginOutOfBandElicitationPause(): () => void {
    this.outOfBandElicitationPauseCount += 1;
    if (this.outOfBandElicitationPauseCount === 1) {
      this.outOfBandElicitationPaused.next(true);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.outOfBandElicitationPauseCount = Math.max(
        0,
        this.outOfBandElicitationPauseCount - 1,
      );
      if (this.outOfBandElicitationPauseCount === 0) {
        this.outOfBandElicitationPaused.next(false);
      }
    };
  }

  /**
   * I-7 (stream abort cascade): signal the session-level AbortController
   * with the reason. Phases observe `signal.aborted` + `signal.reason`
   * and route to the appropriate destination (terminal vs recovery vs
   * provider_switched re-entry).
   */
  abortTerminal(reason: AbortReason): void {
    if (this.abortController.signal.aborted) return;
    const activeTurnId = this.activeTurn.unsafePeek()?.turnId;
    this.abortController.abort(reason);
    // Emit a typed event so I-8 is satisfied.
    this.emit({
      id: this.nextInternalSubId(),
      msg: {
        type: "turn_aborted",
        payload: {
          turnId: activeTurnId,
          reason,
        },
      },
    });
  }

  /**
   * I-33 + I-87: gracefully shut down the session.
   *
   *   - Drain every per-child mailbox under a `MAX_DRAIN_MS` race
   *     (per I-87, default 2,000 ms) so a hung child doesn't block exit.
   *   - Close own mailbox + txEvent.
   *   - Emit final shutdown status.
   */
  async shutdown(): Promise<void> {
    const MAX_DRAIN_MS = 2_000;
    const drained: Array<{ threadId: ThreadId; pending: number }> = [];

    const drainOne = async (
      threadId: ThreadId,
      mailbox: Mailbox,
    ): Promise<void> => {
      const pending = mailbox.hasPending() ? mailbox.drain().length : 0;
      drained.push({ threadId, pending });
      mailbox.close();
    };

    const drainAll = (async () => {
      const tasks = Array.from(this.childInboxes.entries()).map(
        ([threadId, mailbox]) => drainOne(threadId, mailbox),
      );
      await Promise.all(tasks);
    })();

    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, MAX_DRAIN_MS).unref?.();
    });

    await Promise.race([drainAll, timeout]);
    try {
      await this.conversation.shutdown();
    } catch {
      /* best-effort */
    }

    // Any orphans (children that didn't finish draining in time) get
    // a warning event so post-mortem can see the count (I-8 + I-87).
    const orphanCount = this.childInboxes.size - drained.length;
    if (orphanCount > 0) {
      this.emit({
        id: this.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "async_child_drain_timeout",
            message: `${orphanCount} child mailbox(es) did not drain within ${MAX_DRAIN_MS}ms`,
          },
        },
      });
    }

    this.mailbox.close();
    try {
      await this.services.startupPrewarm?.clear();
    } catch {
      /* best-effort */
    }
    const liveThread = (
      this.services as {
        readonly liveThread?: { shutdown(): void };
      }
    ).liveThread;
    try {
      liveThread?.shutdown();
    } catch {
      /* best-effort */
    }
    // Flush + close the rollout store (I-4: final durable fsync).
    if (this.rolloutStore) {
      try {
        this.rolloutStore.flushDurable();
        this.rolloutStore.close();
      } catch {
        /* best-effort */
      }
    }
    try {
      this.services.rolloutTrace?.flush();
      this.services.rolloutTrace?.close();
    } catch {
      /* best-effort */
    }
    this.eventLog.close();
    this.txEvent.close();
    this.agentStatus.next({ status: "shutdown", endedAtMs: monotonicMs() });
    this.agentStatus.complete();
  }
}

function measureToolResultBytes(payload: unknown): number {
  if (typeof payload === "string") {
    return Buffer.byteLength(payload, "utf8");
  }
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? ""), "utf8");
  } catch {
    return 0;
  }
}

export interface SessionRunTurnOptions extends RunTurnOptions {
  readonly ctx?: TurnContext;
  readonly subId?: string;
  readonly configOverrides?: Partial<Config>;
}

function deriveMinimalSessionConfig(
  sessionConfiguration: SessionConfiguration,
  features: ManagedFeatures,
): Config {
  const model =
    sessionConfiguration.collaborationMode?.model ?? "unknown-model";
  const cwd = sessionConfiguration.cwd ?? process.cwd();
  return {
    model,
    cwd,
    features,
    multiAgentV2: {
      minWaitTimeoutMs: 10_000,
      defaultWaitTimeoutMs: 30_000,
      maxWaitTimeoutMs: 3_600_000,
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

/**
 * Structural `ModelInfo` fallback used when test fixtures construct a
 * Session without wiring a real `ModelsManager`. The runtime models manager is
 * the real owner of per-model metadata.
 *
 * `effectiveContextWindowPercent: 100` matches agenc runtime's "no reduction"
 * meaning (agenc runtime backend default is 95; 100 here is the safe fallback when
 * no authoritative per-model metadata is available). The previous `1`
 * value silently truncated the live context window to 1% via
 * `modelContextWindow()` and broke compaction/budgeting math.
 */
function deriveMinimalModelInfo(slug: string): ModelInfo {
  return {
    slug: slug || "unknown-model",
    effectiveContextWindowPercent: 100,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

async function deriveNextModelInfo(
  modelsManager: ModelsManager | undefined,
  model: string,
): Promise<ModelInfo> {
  if (!modelsManager || typeof modelsManager.getModelInfo !== "function") {
    return deriveMinimalModelInfo(model);
  }
  try {
    return await modelsManager.getModelInfo(model);
  } catch {
    return deriveMinimalModelInfo(model);
  }
}

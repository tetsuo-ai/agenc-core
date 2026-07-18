/**
 * Starts daemon-owned background agents through the existing delegate runtime.
 *
 * F-06a keeps the daemon surface narrow: `agent.create` requests become
 * `delegate(..., runInBackground: true)` launches, and the daemon holds the
 * bootstrap/session handles so the child loop remains alive after the JSON-RPC
 * response is returned.
 */

import {
  bootstrapLocalRuntimeSession,
  type BootstrapLocalRuntimeSessionOptions,
  type LocalRuntimeBootstrap,
} from "../bin/bootstrap.js";
import { ensureAgentControl } from "../bin/delegate-tool.js";
import { clearSession } from "../commands/clear.js";
import type { AgentControl } from "../agents/control.js";
import { MailboxClosedError } from "../agents/mailbox.js";
import { runTurn } from "../session/run-turn.js";
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
import type { AgentBudgetConfig } from "../config/schema.js";
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
import type { ToolRecoveryCategory } from "../tools/types.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolResultContent,
} from "../tools/untrusted-tool-result-framing.js";
import type { ToolRegistry } from "../tool-registry.js";
import { getPlan, getPlanFilePath } from "../utils/plans.js";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../tools/ExitPlanModeTool/constants.js";
import type { AgentId } from "../types/ids.js";
import {
  computeUsdCost,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../session/cost.js";
import {
  transitionPermissionMode,
  type PermissionModeRegistry,
} from "../permissions/permission-mode.js";
import {
  isPermissionMode,
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { applyModelSwitch, readSessionSelection } from "../commands/model.js";
import { applyProviderSwitch } from "../commands/provider.js";
import { resolveProfile } from "../config/profiles.js";

import { permissionGrantsFromToolPermissionContext } from "../permissions/permission-grants.js";
import { applyUnattendedPermissionPolicyToContext } from "../permissions/unattended-policy.js";
import {
  ABORT,
  DENIED,
  type ReviewDecision,
} from "../permissions/review-decision.js";
import type { AgentStatus as ThreadAgentStatus } from "../agents/status.js";
import type { McpServerMutationResult, Session } from "../session/session.js";
import type { Event } from "../session/event-log.js";
import type { TurnContext } from "../session/turn-context.js";
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
  SessionRewindConversationToMessageResult,
  SessionPreviewFileRewindResult,
  SessionRewindFilesToMessageResult,
  SessionSnapshotResult,
  SessionTranscriptResult,
  SessionHookConfigShape,
  SessionHookValidationIssueShape,
  SessionHookRunDiagnosticShape,
} from "./protocol/index.js";
import type { AgenCRealtimeThreadBinding } from "./realtime.js";
import type { AgenCRealtimeCallClient } from "./realtime-transport.js";
import type {
  RealtimeTransportConnection,
  RealtimeTransportRequest,
} from "../conversation/realtime/conversation.js";
import type { RealtimeStartupContextSessionLike } from "../conversation/realtime/context.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import {
  createAgenCDaemonRuntimeAuthBackend,
  type AgenCDaemonRuntimeAuthBackend,
} from "./provider-key-vending.js";
import { isRecord } from "../utils/record.js";
import type { ExecutionAdmissionKernel } from "../budget/execution-admission-kernel.js";

export interface AgenCBackgroundAgentStartParams {
  readonly objective: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly initialContent?: MessageContent;
  readonly metadata?: JsonObject;
  readonly unattendedAllow: readonly string[];
  readonly unattendedDeny: readonly string[];
  readonly permissionMode?:
    "default" | "plan" | "acceptEdits" | "bypassPermissions";
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
  readonly startedAt: string;
  readonly status: "running";
}

export interface AgenCBackgroundAgentRestoreParams {
  readonly agentId: string;
  readonly objective: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
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
  readonly messageId: string;
  readonly streamId: string;
  readonly acceptedAt: string;
}

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
  readonly summary: string;
}

export interface AgenCBackgroundAgentSetPermissionModeParams {
  readonly sessionId: string;
  readonly mode: string;
}

export interface AgenCBackgroundAgentSetPermissionModeResult {
  readonly applied: boolean;
  readonly previousMode: string;
  readonly mode: string;
  /** Internal transaction hook; never serialized by session.setPermissionMode. */
  readonly rollback?: () => Promise<void>;
}

export interface AgenCBackgroundAgentHooksStatusResult {
  readonly available: boolean;
  readonly sourcePath: string;
  readonly disabled: boolean;
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
}

export interface AgenCBackgroundAgentApplyConfigParams {
  readonly sessionId: string;
  readonly profile?: string;
  readonly reload?: boolean;
}

export interface AgenCBackgroundAgentApplyConfigResult {
  readonly applied: boolean;
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
  stopAgent?(agentId: string, reason?: string): Promise<void>;
  attachAgentSessionEvents?(
    agentId: string,
    binding: AgenCBackgroundAgentSessionEventBinding,
  ): Promise<void> | void;
  submitAgentMessage?(
    agentId: string,
    params: AgenCBackgroundAgentMessageParams,
  ): Promise<void>;
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
  partialCompactFromMessage?(
    agentId: string,
    params: AgenCBackgroundAgentPartialCompactParams,
  ): Promise<SessionPartialCompactFromMessageResult>;
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
  lastActiveAt: string;
  budget?: ActiveAgentBudget;
  budgetHalt?: JsonObject;
  budgetHaltInProgress?: boolean;
  budgetTimer?: AgenCAgentBudgetTimer;
  unsubscribeStatus?: () => void;
  uninstallApprovalBridge?: () => void;
  unsubscribeElicitationEvents?: () => void;
  unsubscribePhaseEvents?: () => void;
  sessionBinding?: AgenCBackgroundAgentSessionEventBinding;
  bufferedEvents: BackgroundAgentDaemonEvent[];
  activeToolCallIds: Set<string>;
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

interface BackgroundAgentDaemonEvent {
  readonly id: string;
  readonly type: string;
  readonly payload?: JsonObject;
  readonly messageId?: string;
  readonly streamId?: string;
  readonly acceptedAt?: string;
}

interface ActiveAgentBudget {
  readonly tokenCap?: number;
  readonly dollarCap?: number;
  readonly wallClockSeconds?: number;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly model?: string;
  readonly provider?: string;
  readonly priorUsage: AgentBudgetUsage;
}

interface AgentBudgetHalt {
  readonly kind: "token_cap" | "dollar_cap" | "wall_clock_seconds";
  readonly reason: string;
  readonly marker: JsonObject;
}

interface AgentBudgetUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

const MAX_AGENT_BUDGET_TIMER_MS = 2_147_483_647;

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

/**
 * Drops the oldest events in-place until `events` is within
 * {@link MAX_BUFFERED_AGENT_EVENTS}. Returns the same array so callers
 * can push then bound, matching `bufferSessionEvent` in
 * client-multiplexer.ts.
 */
function boundBufferedAgentEvents(
  events: BackgroundAgentDaemonEvent[],
): BackgroundAgentDaemonEvent[] {
  if (events.length > MAX_BUFFERED_AGENT_EVENTS) {
    events.splice(0, events.length - MAX_BUFFERED_AGENT_EVENTS);
  }
  return events;
}

export interface AgenCAgentBudgetTimer {
  readonly unref?: () => void;
}

export interface AgenCDelegateBackgroundAgentRunnerOptions {
  readonly bootstrap?: AgenCBootstrapFunction;
  readonly ensureAgentControl?: AgenCEnsureAgentControlFunction;
  readonly authBackend?: AuthBackend;
  readonly agentBudget?: AgentBudgetConfig;
  readonly executionAdmissionKernel?: ExecutionAdmissionKernel;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: () => string;
  readonly budgetNowMs?: () => number;
  readonly realtimeCallClient?: AgenCRealtimeCallClient;
  readonly realtimeConnectTransport?: AgenCBackgroundRealtimeTransportConnector;
  readonly setBudgetTimer?: (
    callback: () => void,
    delayMs: number,
  ) => AgenCAgentBudgetTimer;
  readonly clearBudgetTimer?: (timer: AgenCAgentBudgetTimer) => void;
  readonly onActiveAgentTerminated?: (
    agentId: string,
    snapshot: AgenCBackgroundAgentSnapshot,
  ) => void | Promise<void>;
}

export type AgenCDelegateBackgroundAgentRunnerRuntimeConfig = Pick<
  AgenCDelegateBackgroundAgentRunnerOptions,
  "agentBudget" | "realtimeCallClient" | "realtimeConnectTransport"
> & {
  readonly authBackend: AuthBackend | undefined;
};

export class AgenCDelegateBackgroundAgentRunner implements AgenCBackgroundAgentRunner {
  readonly #bootstrap: AgenCBootstrapFunction;
  readonly #requireSandboxReadyAtStartup: boolean;
  readonly #ensureAgentControl: AgenCEnsureAgentControlFunction;
  #authBackend: AgenCDaemonRuntimeAuthBackend | undefined;
  #agentBudget: AgentBudgetConfig | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #executionAdmissionKernel: ExecutionAdmissionKernel | undefined;
  /**
   * Compatibility-only monitor for injected test bootstraps. Production
   * sessions enforce `[agent.budget]` inside execution admission, so running
   * this sidecar monitor too would create a second accounting authority.
   */
  readonly #legacyAgentBudgetMonitorEnabled: boolean;
  readonly #argv: readonly string[] | undefined;
  readonly #now: () => string;
  readonly #budgetNowMs: () => number;
  #realtimeCallClient: AgenCRealtimeCallClient | undefined;
  #realtimeConnectTransport: AgenCBackgroundRealtimeTransportConnector;
  readonly #setBudgetTimer: (
    callback: () => void,
    delayMs: number,
  ) => AgenCAgentBudgetTimer;
  readonly #clearBudgetTimer: (timer: AgenCAgentBudgetTimer) => void;
  readonly #active = new Map<string, ActiveBackgroundAgent>();
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
    this.#agentBudget = options.agentBudget;
    this.#executionAdmissionKernel = options.executionAdmissionKernel;
    this.#legacyAgentBudgetMonitorEnabled =
      options.bootstrap !== undefined &&
      options.executionAdmissionKernel === undefined;
    this.#env = options.env;
    this.#argv = options.argv;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#budgetNowMs = options.budgetNowMs ?? (() => Date.now());
    this.#realtimeCallClient = options.realtimeCallClient;
    this.#realtimeConnectTransport =
      options.realtimeConnectTransport ?? unavailableRealtimeTransport;
    this.#setBudgetTimer =
      options.setBudgetTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearBudgetTimer =
      options.clearBudgetTimer ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
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
    this.#agentBudget = options.agentBudget;
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
    // Merge per-invocation envOverrides on top of the runner's
    // captured env snapshot. Without this, the daemon's first-launch
    // env wins for every subsequent agent — so the user's latest
    // OPENAI_BASE_URL / proxy / API key gets silently ignored.
    const mergedEnv =
      params.envOverrides !== undefined && this.#env !== undefined
        ? { ...this.#env, ...params.envOverrides }
        : params.envOverrides !== undefined
          ? (params.envOverrides as NodeJS.ProcessEnv)
          : this.#env;
    const bootstrap = await this.#bootstrap({
      ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
      ...(this.#authBackend !== undefined
        ? { authBackend: this.#authBackend }
        : {}),
      argv: buildBootstrapArgv(params, this.#argv),
      // Daemon agents are unattended execution for budget policy, but this
      // hint deliberately does not enable autonomous keepalive ticks.
      executionAdmissionAutonomous: true,
      ...(this.#requireSandboxReadyAtStartup
        ? { requireSandboxReadyAtStartup: true }
        : {}),
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(this.#executionAdmissionKernel !== undefined
        ? { executionAdmissionKernel: this.#executionAdmissionKernel }
        : {}),
    });
    const uninstallApprovalBridge = this.#installDaemonApprovalBridge(
      bootstrap.session,
    );
    installDaemonTurnDriverHooks(bootstrap.session);

    try {
      const { control } = this.#ensureAgentControl(bootstrap.session);
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

      const startedAt = this.#now();
      const active: ActiveBackgroundAgent = {
        bootstrap,
        control,
        thread: managedThread,
        status: "running",
        lastActiveAt: startedAt,
        uninstallApprovalBridge,
        bufferedEvents: boundBufferedAgentEvents(
          this.#pendingEvents.get(managedThread.threadId) ?? [],
        ),
        activeToolCallIds:
          this.#pendingActiveToolCallIds.get(managedThread.threadId) ??
          new Set(),
        dispatchChain: Promise.resolve(),
      };
      this.#installAgentBudget(active, {
        startedAt,
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.provider !== undefined ? { provider: params.provider } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      });
      this.#pendingEvents.delete(managedThread.threadId);
      this.#pendingActiveToolCallIds.delete(managedThread.threadId);
      this.#trackAgentStatus(active);
      this.#active.set(managedThread.threadId, active);
      active.unsubscribeElicitationEvents =
        this.#installSessionEventLogBridge(active);
      // Pump runTurn PhaseEvents (assistant_text, tool_call, tool_result,
      // turn_complete) into the daemon's session binding. Without this,
      // the directive is gone but the TUI sees no streaming output.
      active.unsubscribePhaseEvents = bootstrap.session.subscribeToEvents(
        (phase) => {
          const progress = phaseEventToProgressEvent(phase);
          if (progress === null) return;
          void this.#recordProgressEvent(managedThread.threadId, progress);
        },
      );
      this.#scheduleAgentBudgetTimer(active);
      void this.#enforceAgentBudget(active);
      this.#cleanupWhenComplete(managedThread.threadId, managedThread);

      // Deliver the first user input through the same path turn N uses:
      // ManagedThread.submit({type: "user_input"}) → submitToSession →
      // session.submit(input) → runTurn. No directive, no fork, no
      // AgentTool dispatcher. This mirrors the upstream `turn_start`
      // shape for the first message.
      const taskContent = messageContentToLlmParts(params.initialContent);
      const firstInput: string | readonly LLMContentPart[] =
        taskContent ?? params.objective;
      const hasFirstInput =
        typeof firstInput === "string"
          ? firstInput.trim().length > 0
          : firstInput.length > 0;
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
        const displayText = messageContentDisplayText(transcriptContent);
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
        void managedThread
          .submit({ type: "user_input", input: firstInput })
          .catch(() => {
            /* first-turn submission errors surface via session events */
          });
      }

      return {
        agentId: managedThread.threadId,
        agentPath: managedThread.agentPath ?? ("/root" as AgentPath),
        startedAt,
        status: "running",
      };
    } catch (error) {
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
    return {
      status: active.status,
      lastActiveAt: active.lastActiveAt,
      ...(active.budgetHalt !== undefined
        ? { metadata: { budgetHalt: active.budgetHalt } }
        : {}),
    };
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
    if (this.#active.has(params.agentId)) return true;
    let bootstrap: LocalRuntimeBootstrap | undefined;
    let uninstallApprovalBridge: (() => void) | undefined;
    try {
      bootstrap = await this.#bootstrap({
        ...(this.#env !== undefined ? { env: this.#env } : {}),
        ...(this.#authBackend !== undefined
          ? { authBackend: this.#authBackend }
          : {}),
        conversationId: params.agentId,
        resumeConversation: true,
        argv: buildBootstrapArgv(params, this.#argv),
        executionAdmissionAutonomous: true,
        ...(this.#requireSandboxReadyAtStartup
          ? { requireSandboxReadyAtStartup: true }
          : {}),
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        ...(this.#executionAdmissionKernel !== undefined
          ? { executionAdmissionKernel: this.#executionAdmissionKernel }
          : {}),
      });
      uninstallApprovalBridge = this.#installDaemonApprovalBridge(
        bootstrap.session,
      );
      installDaemonTurnDriverHooks(bootstrap.session);
      const { control } = this.#ensureAgentControl(bootstrap.session);
      await installUnattendedPermissionPolicy(
        bootstrap.session.permissionModeRegistry,
        metadataStringList(params.metadata, "unattendedAllow"),
        metadataStringList(params.metadata, "unattendedDeny"),
      );

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
      const active: ActiveBackgroundAgent = {
        bootstrap,
        control,
        thread: managedThread,
        status: "running",
        lastActiveAt: restoredAt,
        uninstallApprovalBridge,
        bufferedEvents: boundBufferedAgentEvents(
          this.#pendingEvents.get(params.agentId) ?? [],
        ),
        activeToolCallIds:
          this.#pendingActiveToolCallIds.get(params.agentId) ?? new Set(),
        dispatchChain: Promise.resolve(),
      };
      this.#installAgentBudget(active, {
        startedAt,
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.provider !== undefined ? { provider: params.provider } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      });
      this.#pendingEvents.delete(params.agentId);
      this.#pendingActiveToolCallIds.delete(params.agentId);
      this.#trackAgentStatus(active);
      this.#active.set(params.agentId, active);
      active.unsubscribeElicitationEvents =
        this.#installSessionEventLogBridge(active);
      active.unsubscribePhaseEvents = bootstrap.session.subscribeToEvents(
        (phase) => {
          const progress = phaseEventToProgressEvent(phase);
          if (progress === null) return;
          void this.#recordProgressEvent(params.agentId, progress);
        },
      );
      this.#scheduleAgentBudgetTimer(active);
      void this.#enforceAgentBudget(active);
      this.#cleanupWhenComplete(params.agentId, managedThread);
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
    } catch {
      uninstallApprovalBridge?.();
      await bootstrap?.shutdown().catch(() => {});
      return false;
    }
  }

  async stopAgent(
    agentId: string,
    reason = "daemon_agent_stop",
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) return;
    active.status = "stopping";
    active.lastActiveAt = this.#now();
    this.#clearAgentBudgetTimer(active);
    let stopError: unknown;
    try {
      // ManagedThread.shutdown for a root session calls
      // session.shutdown() via submitToSession; AgentControl.shutdown
      // would no-op for root threads (live.get returns undefined).
      await active.thread.shutdown(reason);
    } catch (error) {
      stopError = error;
    }
    try {
      await active.bootstrap.shutdown();
    } catch (error) {
      stopError ??= error;
    }
    if (stopError !== undefined) {
      active.status = "error";
      active.lastActiveAt = this.#now();
      throw stopError;
    }
    this.#abortPendingToolDecisions(agentId);
    this.#active.delete(agentId);
    this.#pendingEvents.delete(agentId);
    this.#assistantTextByAgent.delete(agentId);
    this.#pendingActiveToolCallIds.delete(agentId);
    active.unsubscribeStatus?.();
    active.uninstallApprovalBridge?.();
    active.unsubscribeElicitationEvents?.();
    // gaphunt3 #48: the agentId is the session/conversationId used as the
    // vended-key cache key, so evict this session's entries on stop —
    // otherwise non-expiring keys leak for the daemon's lifetime.
    this.#authBackend?.clearVendedKeysForSession(agentId);
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
      onProgress: (event) => this.#recordProgressEvent(params.agentId, event),
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

  async submitAgentMessage(
    agentId: string,
    params: AgenCBackgroundAgentMessageParams,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined || !isRunnableActiveAgent(active)) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const input = messageContentToAgentInput(params.content);
    active.lastActiveAt = this.#now();
    if (params.displayUserMessage !== null) {
      const displayText =
        params.displayUserMessage ?? messageContentDisplayText(params.content);
      // The TUI must see the submitted prompt before assistant deltas;
      // sendInput can synchronously stream and complete a whole turn.
      await this.#emitPersistedUserMessage(active, {
        id: params.messageId,
        type: "user_message",
        messageId: params.messageId,
        streamId: params.streamId,
        acceptedAt: params.acceptedAt,
        payload: {
          message: params.originalContent,
          displayText,
          messageId: params.messageId,
          streamId: params.streamId,
          acceptedAt: params.acceptedAt,
        },
      });
    }
    if (typeof input === "string") {
      await active.control.sendInput(agentId, input);
    } else {
      await submitStructuredAgentInput(
        active,
        input,
        messageContentDisplayText(params.content),
      );
    }
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
    await this.#emitOrBufferEvent(active, {
      id: `history-cleared-${params.sessionId}-${params.clearedAt}`,
      type: "history_cleared",
      acceptedAt: params.clearedAt,
      payload: {
        timestamp: Number.isFinite(clearedAtMs) ? clearedAtMs : Date.now(),
      },
    });
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
    const usage = budgetUsageForActiveAgent(active);
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
    };
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

  // Read the global session-level cache stats tracker (lives in the
  // daemon process, fed by the upstream SDK call sites). Provider
  // flows that bypass the tracker (lmstudio / xAI / chat-completions)
  // legitimately return zeros — that's accurate, not a bug.
  async #sessionCacheStatsSnapshot(
    _active: ActiveBackgroundAgent,
  ): Promise<SessionSnapshotResult["cacheStats"]> {
    const mod = await import("../services/api/cacheStatsTracker.js").catch(
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
    const session = active.bootstrap.session;
    // Run the switch against the genuine in-process session so the
    // I-13 (mid-turn abort) + I-57 (history-compat) machinery on the
    // real session actually fires. The turn loop's
    // `consumePendingProviderSwitch` is the authority on the next turn.
    let summary: string;
    if (params.model !== undefined) {
      summary = await applyModelSwitch(session, params.model, params.provider);
    } else if (params.provider !== undefined) {
      summary = await applyProviderSwitch(session, params.provider);
    } else {
      return {
        applied: false,
        summary: "No model or provider was supplied.",
      };
    }
    const applied =
      summary.startsWith("Model switched ") ||
      summary.startsWith("Model switch staged:") ||
      summary.startsWith("Provider switched ") ||
      summary.startsWith("Provider switch staged:");
    // todo-115: do NOT write process-global activeConfigModel here. The daemon
    // hosts N concurrent agents; last-writer-wins poisoned sibling sessions.
    // Util helpers must take explicit session selection (session-local paths).
    if (applied) {
      void this.#resolveEffectiveConfigModel(
        session,
        params.model,
        params.provider,
      );
    }
    return { applied, summary };
  }

  /**
   * Resolve the provider/model the daemon session now points at after a
   * switch, preferring explicit params and filling gaps from the live session
   * selection. Returns undefined when neither source yields a usable pair so
   * we never clobber activeConfigModel with `"unknown"` placeholders.
   */
  #resolveEffectiveConfigModel(
    session: unknown,
    paramModel?: string,
    paramProvider?: string,
  ): { provider: string; model: string } | undefined {
    let current: { provider: string; model: string } | undefined;
    try {
      current = readSessionSelection(session as never);
    } catch {
      current = undefined;
    }
    const provider =
      paramProvider ??
      (current?.provider !== undefined && current.provider !== "unknown"
        ? current.provider
        : undefined);
    // Backfill the model from the live session ONLY when it belongs to the
    // same provider we are resolving for. A provider-only switch is staged
    // and consumed on the NEXT turn, so `current` still reports the
    // pre-switch selection here — backfilling it produced mixed pairs like
    // {provider: "grok", model: "qwen3-coder-next-fp8"} in the process-global
    // activeConfigModel, which later daemon sessions then inherited and sent
    // to the wrong API (bug-audit-2026-07-11.md #10).
    const currentModelUsable =
      current !== undefined &&
      current.model !== "unknown" &&
      current.provider !== "unknown" &&
      (paramProvider === undefined || current.provider === paramProvider);
    const model =
      paramModel ?? (currentModelUsable ? current!.model : undefined);
    if (provider === undefined || model === undefined) return undefined;
    return { provider, model };
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
    const current = registry.current();
    if (current.mode === target) {
      return { applied: false, previousMode: current.mode, mode: target };
    }
    const transitioned = transitionPermissionMode(
      current.mode,
      target,
      current,
    );
    const nextCtx: ToolPermissionContext = { ...transitioned, mode: target };
    await registry.update(nextCtx);
    const result: AgenCBackgroundAgentSetPermissionModeResult = {
      applied: true,
      previousMode: current.mode,
      mode: target,
    };
    // Keep the transaction hook out of JSON and ordinary result equality;
    // session.setPermissionMode's public result remains unchanged.
    Object.defineProperty(result, "rollback", {
      value: async () => registry.update(current),
      enumerable: false,
    });
    return result;
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
      disabled: rt.isDisabled(),
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
    // Toggle the daemon's REAL hooks runtime — setDisabled mutates the live
    // engine that rebuildTarget reads, the exact precedent of
    // setAgentPermissionMode mutating the live permission registry.
    const rt = active.bootstrap.session.services?.hooksRuntime;
    if (rt === undefined) {
      throw new Error("Hooks runtime is not available on the daemon session");
    }
    rt.setDisabled(params.disabled);
    return { applied: true, disabled: params.disabled };
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
    const sessionShim = session as unknown as {
      services?: {
        configStore?: {
          current?: () => unknown;
          reload?: () => Promise<unknown>;
        };
      };
      setPendingProviderSwitch?: (spec: {
        provider: string;
        model: string;
        profile?: string;
      }) => void;
      state?: {
        with?: (fn: (state: unknown) => void) => Promise<void> | void;
        unsafePeek?: () => unknown;
      };
    };
    const configStore = sessionShim.services?.configStore;
    if (configStore?.current === undefined) {
      return {
        applied: false,
        summary:
          "No config store is available on the live session; nothing applied.",
      };
    }

    const changes: string[] = [];
    let applied = false;

    // GAP #12: validate the requested profile against the CURRENT shared
    // snapshot before we reload/mutate anything. resolveProfile throws
    // UnknownProfileError for an unknown profile; doing this first keeps the
    // operation atomic — an unknown-profile error must be a true no-op and
    // must NOT have already advanced the shared store or fired its
    // subscribers (which a pre-validation reload would do).
    if (params.profile !== undefined) {
      resolveProfile(
        configStore.current() as unknown as Parameters<
          typeof resolveProfile
        >[0],
        params.profile,
      );
    }

    // 1. Optionally re-read disk + env into the daemon's own store so the
    //    live session sees the latest on-disk config.
    if (params.reload === true && typeof configStore.reload === "function") {
      await configStore.reload();
      changes.push("config reloaded from disk");
      applied = true;
      // A reload can change which profiles exist; re-validate against the
      // fresh snapshot so a post-reload unknown profile still surfaces (the
      // reload itself is the intended effect and is reported in `changes`).
      if (params.profile !== undefined) {
        resolveProfile(
          configStore.current() as unknown as Parameters<
            typeof resolveProfile
          >[0],
          params.profile,
        );
      }
    }

    // 2. Resolve the target snapshot (profile overlay or plain current).
    const base = configStore.current() as Record<string, unknown>;
    const resolved =
      params.profile !== undefined
        ? (resolveProfile(
            base as unknown as Parameters<typeof resolveProfile>[0],
            params.profile,
          ) as unknown as Record<string, unknown>)
        : base;

    // 3. Stage the model/provider delta through the genuine switch seam so the
    //    turn loop's consumePendingProviderSwitch runs the real I-13/I-57
    //    machinery. Thread the profile name so the overlay is re-resolved.
    const targetModel =
      typeof resolved.model === "string" ? resolved.model : undefined;
    const targetProvider =
      typeof resolved.model_provider === "string"
        ? resolved.model_provider
        : undefined;
    const currentModel =
      typeof base.model === "string" ? base.model : undefined;
    const currentProvider =
      typeof base.model_provider === "string" ? base.model_provider : undefined;
    const stageProvider = targetProvider ?? currentProvider;
    if (
      targetModel !== undefined &&
      stageProvider !== undefined &&
      typeof sessionShim.setPendingProviderSwitch === "function"
    ) {
      sessionShim.setPendingProviderSwitch({
        provider: stageProvider,
        model: targetModel,
        ...(params.profile !== undefined ? { profile: params.profile } : {}),
      });
      if (targetModel !== currentModel) {
        changes.push(`model ${currentModel ?? "?"}->${targetModel}`);
      } else {
        changes.push(`model ${targetModel}`);
      }
      // todo-115: avoid process-global setActiveConfigModel (multi-session).
      applied = true;
    }

    // 4. Apply reasoning effort / verbosity / service tier directly onto the
    //    live sessionConfiguration — the piece the model-switch seam cannot do
    //    (it preserves these but never updates them). Mirrors the write shape
    //    consumePendingProviderSwitch uses for collaborationMode.
    const nextReasoning =
      typeof resolved.reasoning_effort === "string"
        ? resolved.reasoning_effort
        : undefined;
    const nextVerbosity =
      typeof resolved.model_verbosity === "string"
        ? resolved.model_verbosity
        : undefined;
    const nextServiceTier =
      typeof resolved.service_tier === "string"
        ? resolved.service_tier
        : undefined;
    if (
      (nextReasoning !== undefined ||
        nextVerbosity !== undefined ||
        nextServiceTier !== undefined) &&
      typeof sessionShim.state?.with === "function"
    ) {
      await sessionShim.state.with((state) => {
        const cfg = (
          state as {
            sessionConfiguration?: {
              collaborationMode?: { reasoningEffort?: string };
              modelVerbosity?: string;
              serviceTier?: string;
            };
          }
        ).sessionConfiguration;
        if (cfg === undefined) return;
        if (nextReasoning !== undefined) {
          cfg.collaborationMode = {
            ...(cfg.collaborationMode ?? {}),
            reasoningEffort: nextReasoning,
          } as { reasoningEffort?: string };
        }
        if (nextVerbosity !== undefined) {
          (cfg as { modelVerbosity?: string }).modelVerbosity = nextVerbosity;
        }
        if (nextServiceTier !== undefined) {
          (cfg as { serviceTier?: string }).serviceTier = nextServiceTier;
        }
      });
      if (nextReasoning !== undefined) {
        changes.push(`reasoning effort ->${nextReasoning}`);
      }
      if (nextVerbosity !== undefined) {
        changes.push(`verbosity ->${nextVerbosity}`);
      }
      if (nextServiceTier !== undefined) {
        changes.push(`service tier ->${nextServiceTier}`);
      }
      applied = true;
    }

    // 5. Approval policy maps to a permission mode where the registry exposes a
    //    matching mode; otherwise leave permission mode to the dedicated
    //    permissions command. (No automatic mapping table here.)

    // 6. Human-readable summary.
    const label =
      params.profile !== undefined
        ? `profile ${params.profile}`
        : params.reload === true
          ? "config reload"
          : "config";
    const summary =
      changes.length > 0
        ? `${label} applied: ${changes.join(", ")}`
        : `${label}: no changes to apply`;
    return { applied, summary };
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
    if (active === undefined || !isRunnableActiveAgent(active)) return false;
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

  #installSessionEventLogBridge(active: ActiveBackgroundAgent): () => void {
    const eventLog = (
      active.bootstrap.session as {
        eventLog?: {
          subscribe?: (
            listener: (event: {
              readonly id?: unknown;
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
    return eventLog.subscribe((event) => {
      const daemonEvent = daemonEventFromUnboundSessionEvent(event);
      if (daemonEvent === null) return;
      active.lastActiveAt = this.#now();
      void this.#emitOrBufferEvent(active, daemonEvent);
    });
  }

  async #requestDaemonToolDecision(ctx: ApprovalCtx): Promise<ReviewDecision> {
    const agentId = readApprovalAgentId(ctx);
    if (agentId === null) return DENIED;
    const requestId = ctx.callId;
    // todo-109: default timeout so unattended pauses cannot hang forever.
    const timeoutMsRaw = process.env.AGENC_PERMISSION_TIMEOUT_MS;
    const timeoutMsParsed =
      timeoutMsRaw !== undefined ? Number.parseInt(timeoutMsRaw, 10) : NaN;
    const timeoutMs =
      Number.isFinite(timeoutMsParsed) && timeoutMsParsed > 0
        ? timeoutMsParsed
        : 5 * 60 * 1000;
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
      timer = setTimeout(() => {
        settle(DENIED);
      }, timeoutMs);
    });
    const input = approvalInputFromPayload(ctx.invocation.payload);
    await this.#emitOrBufferAgentEvent(agentId, {
      id: requestId,
      type: "request_permissions",
      payload: {
        callId: requestId,
        toolName: ctx.toolName,
        turnId: ctx.turnId,
        permissions: ["tool.use"],
        ...(ctx.retryReason !== undefined ? { reason: ctx.retryReason } : {}),
        input,
        ...planApprovalPayloadFields(ctx.toolName, agentId, input),
      },
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
    let sawInitialStatus = false;
    active.unsubscribeStatus = active.thread.subscribeStatus((status) => {
      if (active.budgetHalt !== undefined) return;
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
      if (sawInitialStatus) {
        active.lastActiveAt = this.#now();
        void this.#emitOrBufferEvent(
          active,
          withAgentBudgetUsage(
            active,
            eventFromThreadStatus(status),
            this.#budgetNowMs(),
          ),
        );
      } else {
        void this.#emitOrBufferEvent(
          active,
          withAgentBudgetUsage(
            active,
            eventFromThreadStatus(status),
            this.#budgetNowMs(),
          ),
        );
      }
      sawInitialStatus = true;
    });
  }

  #cleanupWhenComplete(agentId: string, thread: ManagedThread): void {
    void awaitTerminalStatus(thread)
      .catch(() => {})
      .finally(async () => {
        const active = this.#active.get(agentId);
        if (active === undefined || active.thread !== thread) return;
        // Notify the lifecycle of terminal status BEFORE deleting from
        // `#active`. After deletion, `getAgentSnapshot` returns null
        // and the lifecycle's poll-based refresh has no way to observe
        // the transition, so it leaves `agent.status` at the initial
        // `running` value. The callback runs synchronously (awaited)
        // so the lifecycle's record is updated before any subsequent
        // `agent.list` resolves.
        if (this.#onActiveAgentTerminated !== undefined) {
          const terminalSnapshot: AgenCBackgroundAgentSnapshot = {
            status: active.status,
            lastActiveAt: active.lastActiveAt,
            ...(active.budgetHalt !== undefined
              ? { metadata: { budgetHalt: active.budgetHalt } }
              : {}),
          };
          try {
            await this.#onActiveAgentTerminated(agentId, terminalSnapshot);
          } catch {
            // Swallow callback errors so cleanup never leaks. The
            // lifecycle layer is responsible for its own error
            // surfacing via onSnapshotError.
          }
        }
        const bufferedEvents = active.bufferedEvents.splice(0);
        this.#active.delete(agentId);
        if (bufferedEvents.length > 0) {
          const pending = this.#pendingEvents.get(agentId) ?? [];
          pending.push(...bufferedEvents);
          this.#pendingEvents.set(agentId, boundBufferedAgentEvents(pending));
        } else {
          this.#pendingEvents.delete(agentId);
        }
        this.#assistantTextByAgent.delete(agentId);
        this.#pendingActiveToolCallIds.delete(agentId);
        active.unsubscribeStatus?.();
        active.uninstallApprovalBridge?.();
        active.unsubscribeElicitationEvents?.();
        active.unsubscribePhaseEvents?.();
        this.#clearAgentBudgetTimer(active);
        // gaphunt3 #48: the agentId is the session/conversationId used as the
        // vended-key cache key, so evict this session's entries on terminal
        // cleanup — otherwise non-expiring keys leak for the daemon's lifetime.
        this.#authBackend?.clearVendedKeysForSession(agentId);
        await active.bootstrap.shutdown().catch(() => {});
      });
  }

  async #emitOrBufferAgentEvent(
    agentId: string,
    event: BackgroundAgentDaemonEvent | null,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) {
      if (event !== null) {
        const pending = this.#pendingEvents.get(agentId) ?? [];
        pending.push(event);
        this.#pendingEvents.set(agentId, boundBufferedAgentEvents(pending));
      }
      return;
    }
    await this.#emitOrBufferEvent(active, event);
  }

  async #recordProgressEvent(
    agentId: string,
    progress: RunAgentProgressEvent,
  ): Promise<void> {
    this.#trackActiveToolCall(agentId, progress);
    const active = this.#active.get(agentId);
    if (active !== undefined && (await this.#enforceAgentBudget(active))) {
      return;
    }
    const event = this.#eventFromProgress(agentId, progress);
    const events = [
      ...this.#takeInterruptedToolCompletionEvents(agentId, progress),
      ...(event !== null ? [event] : []),
    ];
    if (events.length === 0) return;
    if (active === undefined) {
      const pending = this.#pendingEvents.get(agentId) ?? [];
      pending.push(...events);
      this.#pendingEvents.set(agentId, boundBufferedAgentEvents(pending));
      return;
    }
    this.#applyProgressStatus(active, progress);
    for (const nextEvent of events) {
      await this.#emitOrBufferEvent(
        active,
        withAgentBudgetUsage(active, nextEvent, this.#budgetNowMs()),
      );
    }
  }

  #applyProgressStatus(
    active: ActiveBackgroundAgent,
    progress: RunAgentProgressEvent,
  ): void {
    if (active.budgetHalt !== undefined) return;
    let status: DaemonAgentStatus | null = null;
    switch (progress.kind) {
      case "run_error":
        status = "error";
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

  #installAgentBudget(
    active: ActiveBackgroundAgent,
    params: {
      readonly startedAt: string;
      readonly model?: string;
      readonly provider?: string;
      readonly metadata?: JsonObject;
    },
  ): void {
    if (!this.#legacyAgentBudgetMonitorEnabled) return;
    const budget = normalizeAgentBudget(this.#agentBudget);
    if (budget === undefined) return;
    const startedAtMs =
      parseBudgetTimestamp(params.startedAt) ?? this.#budgetNowMs();
    active.budget = {
      ...budget,
      startedAt: params.startedAt,
      startedAtMs,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
      priorUsage: budgetUsageFromMetadata(params.metadata),
    };
  }

  #scheduleAgentBudgetTimer(active: ActiveBackgroundAgent): void {
    this.#clearAgentBudgetTimer(active);
    const budget = active.budget;
    if (budget?.wallClockSeconds === undefined) return;
    const deadlineMs = budget.startedAtMs + budget.wallClockSeconds * 1000;
    const remainingMs = deadlineMs - this.#budgetNowMs();
    const delayMs = Math.max(
      0,
      Math.min(remainingMs, MAX_AGENT_BUDGET_TIMER_MS),
    );
    const timer = this.#setBudgetTimer(() => {
      if (this.#active.get(active.thread.threadId) !== active) return;
      if (active.budgetHalt !== undefined) return;
      if (this.#budgetNowMs() < deadlineMs) {
        this.#scheduleAgentBudgetTimer(active);
        return;
      }
      void this.#haltAgentForBudget(
        active.thread.threadId,
        budgetHaltForActiveAgent(active, this.#budgetNowMs()) ??
          wallClockBudgetHalt(active, this.#budgetNowMs()),
      );
    }, delayMs);
    active.budgetTimer = timer;
    timer.unref?.();
  }

  #clearAgentBudgetTimer(active: ActiveBackgroundAgent): void {
    if (active.budgetTimer === undefined) return;
    this.#clearBudgetTimer(active.budgetTimer);
    delete active.budgetTimer;
  }

  async #enforceAgentBudget(active: ActiveBackgroundAgent): Promise<boolean> {
    const halt = budgetHaltForActiveAgent(active, this.#budgetNowMs());
    if (halt === null) return false;
    await this.#haltAgentForBudget(active.thread.threadId, halt);
    return true;
  }

  async #haltAgentForBudget(
    agentId: string,
    halt: AgentBudgetHalt,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) return;
    if (
      active.budgetHalt !== undefined ||
      active.budgetHaltInProgress === true
    ) {
      return;
    }
    active.budgetHalt = halt.marker;
    active.budgetHaltInProgress = true;
    active.status = "stopped";
    active.lastActiveAt = this.#now();
    this.#clearAgentBudgetTimer(active);
    let emitError: unknown;
    try {
      await this.#emitOrBufferEvent(active, {
        id: `agent-budget-${agentId}-${halt.kind}`,
        type: "agent_status",
        payload: {
          status: "stopped",
          runStatus: "stopped",
          message: halt.reason,
          budgetHalt: halt.marker,
          budgetUsage: budgetUsageMarker(active, this.#budgetNowMs()),
        },
      });
    } catch (error) {
      emitError = error;
    }
    try {
      await active.thread.shutdown(halt.reason);
      await active.bootstrap.shutdown();
    } catch (error) {
      active.status = "error";
      active.lastActiveAt = this.#now();
      try {
        await this.#emitOrBufferEvent(active, {
          id: `agent-budget-error-${agentId}-${hashStable(String(error))}`,
          type: "agent_status",
          payload: {
            status: "error",
            runStatus: "errored",
            message: error instanceof Error ? error.message : String(error),
            budgetHalt: halt.marker,
            budgetUsage: budgetUsageMarker(active, this.#budgetNowMs()),
          },
        });
      } catch {
        // The shutdown path must not depend on notification delivery.
      }
    } finally {
      active.budgetHaltInProgress = false;
    }
    if (emitError !== undefined) {
      active.lastActiveAt = this.#now();
    }
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
      boundBufferedAgentEvents(active.bufferedEvents);
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

function normalizeAgentBudget(
  config: AgentBudgetConfig | undefined,
):
  | Omit<
      ActiveAgentBudget,
      "startedAt" | "startedAtMs" | "model" | "provider" | "priorUsage"
    >
  | undefined {
  if (config === undefined) return undefined;
  const tokenCap = normalizeBudgetCap(config.token_cap);
  const dollarCap = normalizeBudgetCap(config.dollar_cap);
  const wallClockSeconds = normalizeBudgetCap(config.wall_clock_seconds);
  if (
    tokenCap === undefined &&
    dollarCap === undefined &&
    wallClockSeconds === undefined
  ) {
    return undefined;
  }
  return {
    ...(tokenCap !== undefined ? { tokenCap } : {}),
    ...(dollarCap !== undefined ? { dollarCap } : {}),
    ...(wallClockSeconds !== undefined ? { wallClockSeconds } : {}),
  };
}

function normalizeBudgetCap(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseBudgetTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function budgetUsageFromMetadata(
  metadata: JsonObject | undefined,
): AgentBudgetUsage {
  const raw = metadata?.budgetUsage;
  if (!isJsonObject(raw)) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  }
  return {
    inputTokens: finiteNumber(raw.inputTokens),
    outputTokens: finiteNumber(raw.outputTokens),
    totalTokens: finiteNumber(raw.totalTokens),
    costUsd: finiteNumber(raw.costUsd),
  };
}

function budgetHaltForActiveAgent(
  active: ActiveBackgroundAgent,
  nowMs: number,
): AgentBudgetHalt | null {
  const budget = active.budget;
  if (budget === undefined) return null;
  const usage = budgetUsageForActiveAgent(active);
  const totalTokens = usage.totalTokens;
  if (budget.tokenCap !== undefined && totalTokens >= budget.tokenCap) {
    const reason = `agent budget token_cap reached: ${totalTokens} tokens >= ${budget.tokenCap}`;
    return {
      kind: "token_cap",
      reason,
      marker: budgetHaltMarker(
        "token_cap",
        budget.tokenCap,
        totalTokens,
        active,
        nowMs,
        reason,
      ),
    };
  }
  const costUsd = usage.costUsd;
  if (budget.dollarCap !== undefined && costUsd >= budget.dollarCap) {
    const reason = `agent budget dollar_cap reached: $${formatBudgetDollars(costUsd)} >= $${formatBudgetDollars(budget.dollarCap)}`;
    return {
      kind: "dollar_cap",
      reason,
      marker: budgetHaltMarker(
        "dollar_cap",
        budget.dollarCap,
        costUsd,
        active,
        nowMs,
        reason,
      ),
    };
  }
  if (budget.wallClockSeconds !== undefined) {
    const elapsedSeconds = elapsedBudgetSeconds(active, nowMs);
    if (elapsedSeconds >= budget.wallClockSeconds) {
      return wallClockBudgetHalt(active, nowMs);
    }
  }
  return null;
}

function wallClockBudgetHalt(
  active: ActiveBackgroundAgent,
  nowMs: number,
): AgentBudgetHalt {
  const cap = active.budget?.wallClockSeconds ?? 0;
  const elapsedSeconds = elapsedBudgetSeconds(active, nowMs);
  const reason = `agent budget wall_clock_seconds reached: ${formatBudgetSeconds(elapsedSeconds)}s >= ${formatBudgetSeconds(cap)}s`;
  return {
    kind: "wall_clock_seconds",
    reason,
    marker: budgetHaltMarker(
      "wall_clock_seconds",
      cap,
      elapsedSeconds,
      active,
      nowMs,
      reason,
    ),
  };
}

function elapsedBudgetSeconds(
  active: ActiveBackgroundAgent,
  nowMs: number,
): number {
  const startedAtMs = active.budget?.startedAtMs ?? nowMs;
  return Math.max(0, (nowMs - startedAtMs) / 1000);
}

function budgetUsageForActiveAgent(
  active: ActiveBackgroundAgent,
): AgentBudgetUsage {
  const prior = active.budget?.priorUsage ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const live = managedTokenUsage(active.thread);
  return {
    inputTokens: prior.inputTokens + finiteNumber(live.inputTokens),
    outputTokens: prior.outputTokens + finiteNumber(live.outputTokens),
    totalTokens: prior.totalTokens + finiteNumber(live.totalTokens),
    costUsd: prior.costUsd + agentCostUsd(active),
  };
}

function agentCostUsd(active: ActiveBackgroundAgent): number {
  const tokenUsage = managedTokenUsage(active.thread);
  const model = budgetModel(active);
  const provider = budgetProvider(active);
  // LiveAgent currently exposes aggregate input/output token counters.
  // The budget marker records this basis so dollar caps are auditable
  // without pretending cached/reasoning/search dimensions were observed.
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

function budgetModel(active: ActiveBackgroundAgent): string {
  return (
    active.budget?.model ??
    stringRecordField(active.thread.configSnapshot?.(), "model") ??
    "agenc"
  );
}

function budgetProvider(active: ActiveBackgroundAgent): string | undefined {
  return (
    active.budget?.provider ??
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

function budgetHaltMarker(
  kind: AgentBudgetHalt["kind"],
  cap: number,
  observed: number,
  active: ActiveBackgroundAgent,
  nowMs: number,
  reason: string,
): JsonObject {
  const usage = budgetUsageForActiveAgent(active);
  const model = budgetModel(active);
  const provider = budgetProvider(active);
  return {
    kind,
    cap,
    observed,
    reason,
    code:
      kind === "token_cap"
        ? `token_cap:${usage.totalTokens}`
        : kind === "dollar_cap"
          ? `dollar_cap:${formatBudgetDollars(observed)}`
          : `wall_clock_seconds:${formatBudgetSeconds(observed)}`,
    haltedAt: new Date(nowMs).toISOString(),
    startedAt: active.budget?.startedAt,
    tokens: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      total: usage.totalTokens,
    },
    costUsd: usage.costUsd,
    costBasis: "input_output_token_usage",
    wallClockSeconds: elapsedBudgetSeconds(active, nowMs),
    model,
    ...(provider !== undefined ? { provider } : {}),
  };
}

function budgetUsageMarker(
  active: ActiveBackgroundAgent,
  nowMs: number,
): JsonObject | undefined {
  if (active.budget === undefined) return undefined;
  const usage = budgetUsageForActiveAgent(active);
  const model = budgetModel(active);
  const provider = budgetProvider(active);
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    costBasis: "input_output_token_usage",
    wallClockSeconds: elapsedBudgetSeconds(active, nowMs),
    updatedAt: new Date(nowMs).toISOString(),
    model,
    ...(provider !== undefined ? { provider } : {}),
  };
}

function withAgentBudgetUsage(
  active: ActiveBackgroundAgent,
  event: BackgroundAgentDaemonEvent | null,
  nowMs: number,
): BackgroundAgentDaemonEvent | null {
  if (event === null || event.type !== "agent_status") return event;
  const budgetUsage = budgetUsageMarker(active, nowMs);
  if (budgetUsage === undefined) return event;
  return {
    ...event,
    payload: {
      ...(event.payload ?? {}),
      budgetUsage,
    },
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatBudgetDollars(value: number): string {
  return value
    .toFixed(value >= 1 ? 2 : 6)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function formatBudgetSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function isRunnableActiveAgent(active: ActiveBackgroundAgent): boolean {
  return active.budgetHalt === undefined;
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

function isClearInFlight(active: ActiveBackgroundAgent): boolean {
  if (hasRuntimeActiveTurn(active.bootstrap.session)) return true;
  if (active.activeToolCallIds.size > 0) return true;
  const status = active.thread.status();
  return status.status === "running" || status.status === "pending_init";
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
    (event.type === "turn_started" ||
      event.type === "turn_complete" ||
      event.type === "turn_aborted" ||
      event.type === "error") &&
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
  readonly acceptedAt?: string;
} {
  return {
    sessionId,
    eventId: event.id,
    agentId,
    ...(event.acceptedAt !== undefined ? { acceptedAt: event.acceptedAt } : {}),
  };
}

function agentStatusFromEventType(type: string): DaemonAgentStatus {
  switch (type) {
    case "turn_started":
      return "running";
    case "error":
      return "error";
    case "turn_aborted":
      return "stopped";
    case "turn_complete":
    default:
      return "idle";
  }
}

function agentRunStatusFromEventType(type: string): AgentRunStatus {
  switch (type) {
    case "turn_started":
      return "running";
    case "error":
      return "errored";
    case "turn_aborted":
      return "stopped";
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

export function daemonEventFromUnboundSessionEvent(event: {
  readonly id?: unknown;
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
  if (
    type === "request_user_input" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.turnId === "string" &&
    Array.isArray(payload.questions)
  ) {
    return {
      id,
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
      type,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(streamId !== undefined ? { streamId } : {}),
      ...(acceptedAt !== undefined ? { acceptedAt } : {}),
      payload: {
        message: payload.message,
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
    return { id, type, payload };
  }
  if (
    type === "tool_progress" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.toolName === "string"
  ) {
    return { id, type, payload };
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

// Translate session-level PhaseEvents into RunAgentProgressEvents so the
// existing #recordProgressEvent / #eventFromProgress / #emitOrBufferEvent
// pipeline (and the agent_message_delta cache) can deliver streaming
// output to the daemon's session binding. The OLD delegate path got these
// via runAgent's onProgress callback. The NEW ManagedThread path drives
// runTurn through Session.submit, which emits PhaseEvents — we subscribe
// in startAgent/restoreAgent and pump them through the same pipeline.
function phaseEventToProgressEvent(
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
      if (event.stopReason === "max_turns") {
        return {
          kind: "run_error",
          error: "Agent exceeded maxTurns",
        };
      }
      if (event.stopReason === "no_progress") {
        return {
          kind: "run_error",
          error:
            "Agent stopped by the no-progress backstop (semantic non-termination)",
        };
      }
      // "completed" | "empty_response" — a per-turn completion. Emit
      // turn_complete (NOT run_complete — the session continues across
      // turns; run_complete would trigger cleanup).
      return {
        kind: "turn_complete",
        turnId,
        ...(event.content.length > 0 ? { finalMessage: event.content } : {}),
      };
    }
  }
}

function awaitTerminalStatus(thread: ManagedThread): Promise<void> {
  return new Promise((resolve) => {
    const unsub = thread.subscribeStatus((status) => {
      if (
        status.status === "completed" ||
        status.status === "errored" ||
        status.status === "shutdown" ||
        status.status === "not_found"
      ) {
        unsub();
        resolve();
      }
    });
  });
}

function mapThreadStatus(status: ThreadAgentStatus): DaemonAgentStatus {
  switch (status.status) {
    case "completed":
    case "not_found":
    case "shutdown":
      return "stopped";
    case "interrupted":
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
  switch (progress.kind) {
    case "status":
      return {
        id: `status-${agentId}-${hashStable(progress.text)}`,
        type: "warning",
        payload: {
          cause: "background_agent_status",
          message: progress.text,
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
          },
        };
      }
      return {
        id: `agent-${agentId}-${hashStable(text)}`,
        type: "agent_message",
        payload: {
          message: text,
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
        },
      };
    case "turn_complete":
      return {
        id: `turn-complete-${agentId}-${progress.turnId}`,
        type: "turn_complete",
        payload: {
          turnId: progress.turnId,
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

async function submitStructuredAgentInput(
  active: ActiveBackgroundAgent,
  input: readonly LLMContentPart[],
  _displayText: string,
): Promise<void> {
  try {
    await active.thread.submit({ type: "user_input", input });
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

function approvalInputFromPayload(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const payload = value as {
    readonly kind?: unknown;
    readonly arguments?: unknown;
    readonly rawArguments?: unknown;
    readonly input?: unknown;
    readonly params?: unknown;
  };
  if (payload.kind === "function" && typeof payload.arguments === "string") {
    return parseJsonObject(payload.arguments);
  }
  if (payload.kind === "mcp" && typeof payload.rawArguments === "string") {
    return parseJsonObject(payload.rawArguments);
  }
  if (payload.kind === "custom" && typeof payload.input === "string") {
    return { input: payload.input };
  }
  if (
    payload.kind === "local_shell" &&
    payload.params !== null &&
    typeof payload.params === "object" &&
    !Array.isArray(payload.params)
  ) {
    return payload.params as JsonObject;
  }
  return {};
}

function parseJsonObject(raw: string): JsonObject {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as JsonObject;
    }
  } catch {
    // Fall through to the raw-input carrier below.
  }
  return { input: raw };
}

function buildBootstrapArgv(
  params: {
    readonly provider?: string;
    readonly model?: string;
    readonly profile?: string;
    readonly permissionMode?:
      "default" | "plan" | "acceptEdits" | "bypassPermissions";
  },
  baseArgv: readonly string[] | undefined,
): readonly string[] {
  const argv = [...(baseArgv ?? process.argv)];
  appendFlag(argv, "--provider", params.provider);
  appendFlag(argv, "--model", params.model);
  appendFlag(argv, "--profile", params.profile);
  // Forward `--yolo` when the caller asked for bypassPermissions mode.
  // bin/bootstrap.ts:1146 keys off cli.allowDangerouslySkipPermissions
  // (which startup-selection.ts sets when --yolo is in argv), so adding
  // the flag here makes the daemon-spawned bootstrap honor the override
  // exactly like the CLI bootstrap does. Avoid duplicate flags if argv
  // already carries one.
  if (
    params.permissionMode === "bypassPermissions" &&
    !argv.includes("--yolo") &&
    !argv.includes("--dangerously-bypass-approvals-and-sandbox") &&
    !argv.includes("--allow-dangerously-skip-permissions")
  ) {
    argv.push("--yolo");
  }
  // Mirror non-bypass modes via `--permission-mode <value>` so plan and
  // acceptEdits also propagate. startup-selection.ts already parses
  // this flag.
  if (
    params.permissionMode !== undefined &&
    params.permissionMode !== "bypassPermissions" &&
    !argv.includes("--permission-mode")
  ) {
    argv.push("--permission-mode", params.permissionMode);
  }
  // todo-114: do not force --autonomous on every daemon agent. Unattended
  // permission policy is installed separately; keepalive ticks only exist on
  // the TUI contract path. Forcing autonomous here made models expect ticks
  // that never arrived and defaulted empty unattended allowlists to pause-all.
  return argv;
}

function appendFlag(
  argv: string[],
  flag: string,
  value: string | undefined,
): void {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return;
  argv.push(flag, trimmed);
}

// Install the minimal turnDriverHooks the daemon path needs so
// session.submit(input) actually drives a turn. The non-daemon TUI
// path installs a richer hook in bin/agenc.ts:1274 (autonomous keep-
// alive, slash-command routing, prepared prompt). The daemon doesn't
// have those concerns — its job is to drive runTurn for each user
// input and emit phase events. Phase events flow out via
// session.subscribeToEvents which background-agent-runner already
// subscribed to in startAgent/restoreAgent.
function installDaemonTurnDriverHooks(
  session: LocalRuntimeBootstrap["session"],
): void {
  const installer = (
    session as unknown as {
      installTurnDriverHooks?: (hooks: {
        readonly submit: (
          message: string | readonly LLMContentPart[],
          opts?: {
            readonly source?: string;
            readonly displayUserMessage?: string | null;
          },
        ) => Promise<void>;
        readonly flushEventLog?: () => Promise<void> | void;
      }) => void;
    }
  ).installTurnDriverHooks;
  if (typeof installer !== "function") return;
  installer.call(session, {
    submit: async (message, opts) => {
      const ctx = (
        session as unknown as { newDefaultTurn: () => unknown }
      ).newDefaultTurn();
      const rootHumanTurnText =
        opts?.source !== "autonomous_tick" && opts?.displayUserMessage !== null
          ? (opts?.displayUserMessage ??
            (typeof message === "string"
              ? message
              : message
                  .map((part) => (part.type === "text" ? part.text : ""))
                  .filter((part) => part.trim().length > 0)
                  .join("\n")))
          : undefined;
      // displayUserMessage: null suppresses the run-turn user_message
      // emit. On the daemon path, submitAgentMessage above already
      // emits the user_message event (with the displayUserMessage
      // metadata threaded through from the TUI). Without this guard
      // both emits fire with different ids, so the transcript-reducer
      // (which dedups by id) renders the user message twice.
      for await (const event of runTurn(
        session as never,
        ctx as never,
        message,
        {
          // This runner owns a root ManagedThread fed by daemon/phone human input. Bootstrap may
          // carry an agent-scoped querySource, which would make runTurn treat the same human prompt
          // as synthetic and omit ActiveTurn.rootHumanTurn. Pin the root daemon driver to the SDK
          // main-thread source; subagents use their own sessions and autonomous ticks are still
          // excluded by rootHumanTurnText below.
          querySource: "sdk",
          displayUserMessage: null,
          ...(rootHumanTurnText !== undefined ? { rootHumanTurnText } : {}),
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

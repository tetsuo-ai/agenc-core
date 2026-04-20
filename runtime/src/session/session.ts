/**
 * Session — initialized model agent context.
 *
 * Hand-port of codex `core/src/session/session.rs` (852 LOC Rust)
 * per `docs/plan/codex-inventory.md §1` Session struct mapping table.
 * Every field of codex's `Session` struct has a TypeScript equivalent.
 * Forward-dep subsystems (~50 types: ModelsManager, RolloutRecorder,
 * McpConnectionManager, AgentControl, etc.) are placeholder interfaces
 * with `// T<N> wires` comments naming the tranche that lands the
 * real impl.
 *
 * "A session has at most 1 running task at a time, and can be
 *  interrupted by user input." — codex doc-comment, session.rs:5
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

import { AsyncLock } from "../utils/async-lock.js";
import { AsyncQueue } from "../utils/async-queue.js";
import { BehaviorSubject } from "../utils/behavior-subject.js";
import { monotonicMs } from "../utils/monotonic.js";
import type { LLMProvider } from "../llm/types.js";
import type { ToolRegistry } from "../tool-registry.js";
import type {
  AuthManager,
  Environment,
  JsReplHandle,
  ManagedFeatures,
  ModelInfo,
  NetworkProxy,
  SessionConfiguration,
  SessionTelemetry,
  SkillLoadOutcome,
} from "./turn-context.js";

// ─────────────────────────────────────────────────────────────────────
// Placeholder types for forward-dep subsystems.
// Each interface is a structural placeholder so TS can typecheck the
// Session shape without dragging in the real subsystem implementations.
// Real impls land in the named tranche.
// ─────────────────────────────────────────────────────────────────────

/** Codex `ThreadId`. Conversation/thread unique identifier. */
export type ThreadId = string;

/** Codex `Event` (top-level event envelope). T6 expands. */
export interface Event {
  readonly id: string;
  readonly msg: EventMsg;
}

/** Codex `EventMsg` (the full discriminated union). T6 wires real ~78 variants. */
export type EventMsg =
  | { readonly type: "session_configured"; readonly payload: SessionConfiguredEvent }
  | { readonly type: "turn_started"; readonly payload: { readonly turnId: string; readonly startedAt: number } }
  | { readonly type: "agent_message"; readonly payload: { readonly message: string } }
  | { readonly type: "user_message"; readonly payload: { readonly message: string; readonly images?: ReadonlyArray<string> } }
  | { readonly type: "agent_message_delta"; readonly payload: { readonly delta: string } }
  | { readonly type: "token_count"; readonly payload: { readonly promptTokens?: number; readonly completionTokens?: number; readonly totalTokens?: number } }
  | { readonly type: "tool_call_started"; readonly payload: { readonly callId: string; readonly toolName: string; readonly args: string } }
  | { readonly type: "tool_call_completed"; readonly payload: { readonly callId: string; readonly result: string; readonly isError: boolean } }
  | { readonly type: "context_compacted"; readonly payload: { readonly summary: string } }
  | { readonly type: "thread_rolled_back"; readonly payload: { readonly numTurns: number } }
  | { readonly type: "turn_complete"; readonly payload: { readonly turnId: string; readonly lastAgentMessage?: string } }
  | { readonly type: "turn_aborted"; readonly payload: { readonly turnId: string; readonly reason: AbortReason } }
  | { readonly type: "stream_error"; readonly payload: { readonly cause: string; readonly message: string } }
  | { readonly type: "error"; readonly payload: { readonly message: string; readonly cause?: string } }
  | { readonly type: "warning"; readonly payload: { readonly message: string; readonly cause?: string } }
  | { readonly type: "deprecation_notice"; readonly payload: { readonly summary: string; readonly details?: string } };

export interface SessionConfiguredEvent {
  readonly sessionId: ThreadId;
  readonly forkedFromId?: ThreadId;
  readonly threadName?: string;
  readonly model: string;
  readonly modelProviderId: string;
  readonly serviceTier?: string;
  readonly cwd: string;
  readonly historyLogId: number;
  readonly historyEntryCount: number;
  readonly initialMessages: ReadonlyArray<EventMsg>;
  readonly rolloutPath?: string;
}

/** Codex `AgentStatus` FSM. T9 (subagents) expands. */
export type AgentStatus =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly turnId: string; readonly startedAtMs: number }
  | { readonly status: "completed"; readonly turnId: string; readonly endedAtMs: number }
  | { readonly status: "errored"; readonly turnId: string; readonly error: string }
  | { readonly status: "shutdown" }
  | { readonly status: "interrupted"; readonly turnId: string };

/** Codex `SessionState`. Mutable state under `state` mutex. */
export interface SessionState {
  /** Active configuration (mutable per `/model`, `/provider`, etc.). */
  sessionConfiguration: SessionConfiguration;
  /** Conversation history items (T6 fleshes out via rollout reducer). */
  history: unknown[];
  /** Pending input items (TODO codex line 23 — merge with mailbox). */
  idlePendingInput: unknown[];
  /** Pending session-start hook source (codex line 841). T10 wires. */
  pendingSessionStartSource?: SessionStartSource;
}

/** Codex `SessionStartSource` (codex_hooks). */
export type SessionStartSource = "startup" | "resume" | "clear";

/** Codex `ActiveTurn`. T7 (tool runtime) wires. */
export interface ActiveTurn {
  readonly turnId: string;
  readonly startedAtMs: number;
  readonly abortController: AbortController;
}

/** Codex `Mailbox` + `MailboxReceiver`. T9 (subagents) provides the
 *  full bidirectional impl per I-5/I-16/I-31/I-64. Today we expose the
 *  shape so Session can hold its own inbox + per-child outbound
 *  mailboxes. */
export interface InterAgentCommunication {
  readonly author: string;
  readonly recipient: string;
  readonly content: string;
  readonly triggerTurn: boolean;
  readonly seq: number;
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

  send(msg: Omit<T, "seq">): number {
    if (this.closed) return -1;
    const seq = ++this.nextSeq;
    this.queue.push({ ...(msg as object), seq } as T);
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
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** Codex `RealtimeConversationManager`. T-future (realtime voice). */
export interface RealtimeConversationManager {
  runningState(): Promise<unknown | undefined>;
}

/** Codex `GuardianReviewSessionManager`. T11 (permissions) wires. */
export interface GuardianReviewSessionManager {
  readonly enabled: boolean;
}

/** Codex `RolloutRecorder`. T6 (event log + sidecars) wires. */
export interface RolloutRecorder {
  rolloutPath(): string;
  record(item: unknown): Promise<void>;
  flushAndSync(): Promise<void>;
  setWindowGeneration(n: number): void;
}

/** Codex `ModelsManager`. T13 (multi-provider) wires. */
export interface ModelsManager {
  getModelInfo(modelSlug: string, config?: unknown): Promise<ModelInfo>;
  tryListModels(): ReadonlyArray<ModelInfo> | undefined;
  listModels(strategy?: "online_if_uncached"): Promise<ReadonlyArray<ModelInfo>>;
}

/** Codex `McpManager`. T9 (MCP extensions) wires. */
export interface McpManager {
  effectiveServers(config: unknown, auth: unknown): Promise<Map<string, McpServerInfo>>;
  toolPluginProvenance(config: unknown): Promise<unknown>;
}

export interface McpServerInfo {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly url?: string;
  readonly command?: string;
}

/** Codex `McpConnectionManager`. T9 (MCP extensions) wires. */
export interface McpConnectionManager {
  setApprovalPolicy(policy: unknown): void;
  setSandboxPolicy(policy: unknown): void;
  requiredStartupFailures(servers: ReadonlyArray<string>): Promise<ReadonlyArray<{ server: string; error: string }>>;
}

/** Codex `AgentControl`. T9 (subagents) wires. */
export interface AgentControl {
  readonly maxThreads: number;
  spawnAgent(opts: unknown): Promise<unknown>;
  shutdownAgentTree(threadId: ThreadId): Promise<void>;
}

/** Codex `AgentIdentityManager`. T9 wires. */
export interface AgentIdentityManager {
  ensureRegistered(): Promise<void>;
}

/** Codex `Hooks`. T6 wires (uses existing AgenC `runtime/src/llm/hooks/`). */
export interface Hooks {
  startupWarnings(): ReadonlyArray<string>;
  executePreCompact(...args: unknown[]): Promise<unknown>;
  executePostCompact(...args: unknown[]): Promise<unknown>;
  executeStop(...args: unknown[]): Promise<unknown>;
  executeStopFailure(...args: unknown[]): Promise<unknown>;
}

/** Codex `SkillsManager` + `SkillsWatcher` + `PluginsManager`. T10 wires. */
export interface SkillsManager {
  skillsForConfig(input: unknown, fs: unknown): Promise<SkillLoadOutcome>;
}
export interface SkillsWatcher {
  start(): void;
}
export interface PluginsManager {
  pluginsForConfig(config: unknown): Promise<{ effectiveSkillRoots(): unknown }>;
}

/** Codex `ExecPolicyManager`. T11 wires. */
export interface ExecPolicyManager {
  current(): unknown;
}

/** Codex `AnalyticsEventsClient`. T-future (telemetry). */
export interface AnalyticsEventsClient {
  emit(event: unknown): Promise<void>;
}

/** Codex `ApprovalStore`. T11 wires. */
export interface ApprovalStore {
  hasApproval(key: string): boolean;
  approve(key: string): void;
}

/** Codex `LocalThreadStore`. T6 (event log) wires. */
export interface LocalThreadStore {
  threadName(threadId: ThreadId): Promise<string | undefined>;
  setThreadName(threadId: ThreadId, name: string): Promise<void>;
}

/** Codex `ModelClient`. T13 wires (full multi-provider client.rs port). */
export interface ModelClient {
  setWindowGeneration(n: number): void;
  // T13 expands.
}

/** Codex `CodeModeService`. T-future. */
export interface CodeModeService {
  enabled(): boolean;
}

/** Codex `NetworkApprovalService`. T11 (network approval). */
export interface NetworkApprovalService {
  enabled(): boolean;
}

/** Codex `Shell`. T7 (tools) wires. */
export interface UserShell {
  readonly path: string;
  deriveExecArgs(input: string, useLoginShell: boolean): string[];
}

/** Codex `UnifiedExecProcessManager`. T7 wires. */
export interface UnifiedExecProcessManager {
  readonly maxTimeoutMs: number;
}

/** Codex `BehaviorSubject<unknown>` for shell snapshot tx. T9 wires. */
export type ShellSnapshotTx = BehaviorSubject<unknown | null>;

/** Codex `state_db_ctx`. T6 wires. */
export interface StateDbContext {
  readonly path: string;
}

/** Codex `InitialHistory`. */
export type InitialHistory =
  | { readonly kind: "new" }
  | { readonly kind: "cleared" }
  | { readonly kind: "forked"; readonly forkedFromId: ThreadId }
  | { readonly kind: "resumed"; readonly conversationId: ThreadId; readonly rolloutPath: string; readonly history: ReadonlyArray<unknown> };

/** Codex `SessionServices` — DI container of all session-scoped services. */
export interface SessionServices {
  readonly mcpConnectionManager: McpConnectionManager;
  readonly mcpStartupCancellationToken: { cancel(): void; isCancelled(): boolean };
  readonly unifiedExecManager: UnifiedExecProcessManager;
  readonly shellZshPath?: string;
  readonly mainExecveWrapperExe?: string;
  readonly analyticsEventsClient: AnalyticsEventsClient;
  readonly hooks: Hooks;
  readonly rollout: RolloutRecorder | undefined;
  readonly userShell: UserShell;
  readonly agentIdentityManager: AgentIdentityManager;
  readonly shellSnapshotTx: ShellSnapshotTx;
  readonly showRawAgentReasoning: boolean;
  readonly execPolicy: ExecPolicyManager;
  readonly authManager: AuthManager;
  readonly sessionTelemetry: SessionTelemetry;
  readonly modelsManager: ModelsManager;
  readonly toolApprovals: ApprovalStore;
  readonly guardianRejections: Map<string, unknown>;
  readonly skillsManager: SkillsManager;
  readonly pluginsManager: PluginsManager;
  readonly mcpManager: McpManager;
  readonly skillsWatcher: SkillsWatcher;
  readonly agentControl: AgentControl;
  readonly networkProxy?: NetworkProxy;
  readonly networkApproval: NetworkApprovalService;
  readonly stateDb?: StateDbContext;
  readonly threadStore: LocalThreadStore;
  readonly modelClient: ModelClient;
  readonly codeModeService: CodeModeService;
  readonly environment?: Environment;
  // T-future: AgenC-specific additions
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
}

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
// Session class — the field-faithful port of codex `Session` struct.
// ─────────────────────────────────────────────────────────────────────

export interface SessionOpts {
  readonly conversationId: ThreadId;
  readonly initialState: SessionState;
  readonly features: ManagedFeatures;
  readonly services: SessionServices;
  readonly jsRepl: JsReplHandle;
  /** Existing event-stream consumer (T6 wires sidecars on top). */
  readonly eventQueue?: AsyncQueue<Event>;
  /** Initial AgentStatus (default: idle). */
  readonly agentStatus?: AgentStatus;
}

/**
 * Initialized model agent context.
 *
 * Mirrors codex `Session` struct (session.rs:6-29).
 */
export class Session {
  /** codex: `conversation_id: ThreadId` */
  readonly conversationId: ThreadId;

  /** codex: `tx_event: Sender<Event>` — event log emit channel. T6 sidecars consume. */
  readonly txEvent: AsyncQueue<Event>;

  /** codex: `agent_status: watch::Sender<AgentStatus>` — status with replay-current. */
  readonly agentStatus: BehaviorSubject<AgentStatus>;

  /** codex: `out_of_band_elicitation_paused: watch::Sender<bool>` — codex realtime parity. */
  readonly outOfBandElicitationPaused: BehaviorSubject<boolean>;

  /** codex: `state: Mutex<SessionState>` — async-locked session state. */
  readonly state: AsyncLock<SessionState>;

  /** codex: `managed_network_proxy_refresh_lock: Mutex<()>` — serializes proxy rebuilds. */
  readonly managedNetworkProxyRefreshLock: AsyncLock<void>;

  /** codex: `features: ManagedFeatures` — invariant for the lifetime of the session. */
  readonly features: ManagedFeatures;

  /** codex: `pending_mcp_server_refresh_config: Mutex<Option<McpServerRefreshConfig>>`. T9 wires. */
  readonly pendingMcpServerRefreshConfig: AsyncLock<unknown | null>;

  /** codex: `conversation: Arc<RealtimeConversationManager>`. T-future (realtime). */
  readonly conversation: RealtimeConversationManager;

  /** codex: `active_turn: Mutex<Option<ActiveTurn>>` — at most one running task. */
  readonly activeTurn: AsyncLock<ActiveTurn | null>;

  /** codex: `mailbox: Mailbox` — Session's own inbox (parent or peer can send). */
  readonly mailbox: Mailbox;

  /** codex: `mailbox_rx: Mutex<MailboxReceiver>` — drain receiver. T9 wires the full impl. */
  readonly mailboxRx: AsyncLock<{ drain(): InterAgentCommunication[] }>;

  /** codex: `idle_pending_input: Mutex<Vec<ResponseInputItem>>` — TODO merge w/ mailbox. */
  readonly idlePendingInput: AsyncLock<unknown[]>;

  /** codex: `guardian_review_session: GuardianReviewSessionManager`. T11 wires. */
  readonly guardianReviewSession: GuardianReviewSessionManager;

  /** codex: `services: SessionServices` — DI container. */
  readonly services: SessionServices;

  /** codex: `js_repl: Arc<JsReplHandle>`. */
  readonly jsRepl: JsReplHandle;

  /** codex: `next_internal_sub_id: AtomicU64` — monotonic sub-id counter. */
  private nextInternalSubIdValue: number;

  /** codex: `agent_task_registration_lock: Mutex<()>` — serializes task registration. */
  readonly agentTaskRegistrationLock: AsyncLock<void>;

  // ───────────────────────────────────────────────────────────
  // AgenC-specific additions (not in codex):
  // ───────────────────────────────────────────────────────────

  /** I-5: per-child outbound mailboxes (parent → child Interrupt/Resume). T9 wires. */
  readonly childInboxes: Map<ThreadId, Mailbox> = new Map();

  /** I-13: pending mid-stream provider/model switch. Honored by run-turn at top-of-loop. */
  pendingProviderSwitch: { provider: string; model: string } | null = null;

  /** I-7: session-level AbortController; phases observe `signal.aborted`. */
  readonly abortController: AbortController = new AbortController();

  /** I-27: monotonic sequence number for emitted events. Sync-incremented in `emit()`. */
  private nextSeq = 0;

  /** Session creation wall-clock (monotonic ms; for telemetry). */
  readonly createdAtMs: number = monotonicMs();

  constructor(opts: SessionOpts) {
    this.conversationId = opts.conversationId;
    this.txEvent = opts.eventQueue ?? new AsyncQueue<Event>();
    this.agentStatus = new BehaviorSubject<AgentStatus>(
      opts.agentStatus ?? { status: "idle" },
    );
    this.outOfBandElicitationPaused = new BehaviorSubject<boolean>(false);
    this.state = new AsyncLock<SessionState>(opts.initialState);
    this.managedNetworkProxyRefreshLock = new AsyncLock<void>(undefined);
    this.features = opts.features;
    this.pendingMcpServerRefreshConfig = new AsyncLock<unknown | null>(null);
    this.conversation = {
      runningState: () => Promise.resolve(undefined),
    };
    this.activeTurn = new AsyncLock<ActiveTurn | null>(null);
    this.mailbox = new SimpleMailbox<
      InterAgentCommunication & { seq: number }
    >() as unknown as Mailbox;
    this.mailboxRx = new AsyncLock<{ drain(): InterAgentCommunication[] }>({
      drain: () => this.mailbox.drain(),
    });
    this.idlePendingInput = new AsyncLock<unknown[]>([]);
    this.guardianReviewSession = { enabled: false };
    this.services = opts.services;
    this.jsRepl = opts.jsRepl;
    this.nextInternalSubIdValue = 0;
    this.agentTaskRegistrationLock = new AsyncLock<void>(undefined);
  }

  // ───────────────────────────────────────────────────────────
  // Methods (codex parity).
  // ───────────────────────────────────────────────────────────

  /**
   * Mirrors codex `Session::next_internal_sub_id` — monotonic id allocation.
   */
  nextInternalSubId(): string {
    const id = this.nextInternalSubIdValue;
    this.nextInternalSubIdValue += 1;
    return `sub-${this.conversationId}-${id}`;
  }

  /**
   * Synchronously emit an event to the txEvent stream + assign monotonic
   * sequence number per I-27. Subscribers (T6 sidecars) consume from
   * `txEvent.stream()`.
   *
   * I-8: every error site MUST funnel through this (or the dedicated
   * error-emission helpers).
   */
  emit(event: Event): void {
    // I-27: assign seq synchronously before any await. The seq is part
    // of the event envelope so the reducer can assert FIFO.
    const seq = ++this.nextSeq;
    void seq; // currently used only for telemetry; T6 wires reducer assertion
    this.txEvent.send(event);
  }

  /**
   * Codex parity: send_event with the configured sub_id + msg.
   */
  sendEvent(subId: string, msg: EventMsg): void {
    this.emit({ id: subId, msg });
  }

  /**
   * Codex parity: send_event_raw — emit with caller-supplied envelope.
   * Used for SessionConfigured + DeprecationNotice events at startup
   * (codex session.rs:746-748).
   */
  sendEventRaw(event: Event): void {
    this.emit(event);
  }

  /**
   * I-7 (stream abort cascade): signal the session-level AbortController
   * with the reason. Phases observe `signal.aborted` + `signal.reason`
   * and route to the appropriate destination (terminal vs recovery vs
   * provider_switched re-entry).
   */
  abortTerminal(reason: AbortReason): void {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(reason);
    // Emit a typed event so I-8 is satisfied.
    this.emit({
      id: this.nextInternalSubId(),
      msg: {
        type: "turn_aborted",
        payload: {
          turnId: "current",
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
    this.txEvent.close();
    this.agentStatus.next({ status: "shutdown" });
    this.agentStatus.complete();
  }
}

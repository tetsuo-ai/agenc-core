/**
 * Per-turn immutable context.
 *
 * Hand-port of agenc runtime `core/src/session/turn_context.rs` (626 LOC Rust)
 * per `docs/plan/translation-conventions.md`. Every field of agenc runtime's
 * `TurnContext` struct has a corresponding TypeScript field. Forward-
 * dep types (whose real implementations land in T7/T9/T10/T11/T13)
 * use placeholder interfaces with `// T<N> wires` comments.
 *
 * Invariants enforced here:
 *   I-1  (subagent depth) — `depth` field passed in at construction
 *   I-30 (config snapshot per-turn-immutable) — every field is `readonly`;
 *        `configSnapshot` holds the frozen config for the lifetime of
 *        this TurnContext
 *
 * @module
 */

import type { LLMProvider } from "../llm/types.js";
import type { PermissionMode } from "../permissions/types.js";
import type { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { normalizePersonality } from "../context/personality-spec-instructions.js";
import type {
  ModelMessages,
  Personality,
} from "../context/personality-spec-instructions.js";
import type {
  BlockedRequestObserver,
  NetworkPolicyDecider,
} from "../sandbox/network-policy.js";
import type { PendingWorktreeState } from "./pending-worktree.js";
import type { RunInstructionEvidence } from "../prompts/instruction-evidence.js";

// ─────────────────────────────────────────────────────────────────────
// Forward-dep structural types. Keep these narrow so TurnContext can carry
// cross-cutting session metadata without importing provider implementations.
// ─────────────────────────────────────────────────────────────────────

/**
 * agenc runtime `AuthManager` metadata. Provider adapters own concrete OAuth refresh.
 *
 * `mode` matches agenc runtime `AuthMode` at the transport level: `bearer_key` for
 * static API keys, `oauth` for any OAuth-authorized session, and
 * `local_no_auth` for local-only loopback providers.
 *
 * `authProvider` narrows an `oauth` session to the specific upstream so
 * gates like `imageGenerationToolAuthAllowed` can match agenc runtime's
 * `AuthMode::Chatgpt`-only behavior instead of lighting up for every
 * OAuth provider.
 */
export type AuthProviderId =
  | "chatgpt"
  | "openai"
  | "openrouter"
  | "xai"
  | "azure"
  | "other";

export interface AuthManager {
  readonly mode: "bearer_key" | "oauth" | "local_no_auth";
  /** Upstream identity for the auth session (only meaningful when `mode === "oauth"`). */
  readonly authProvider?: AuthProviderId;
}

/** agenc runtime `ModelInfo` shape backed by the runtime models manager. */
export interface ModelServiceTier {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface ModelInfo {
  readonly slug: string;
  readonly contextWindow?: number;
  readonly effectiveContextWindowPercent: number;
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensUpperLimit?: number;
  readonly maxOutputTokensExplicit?: boolean;
  readonly maxOutputTokensCappedDefault?: boolean;
  readonly supportedReasoningLevels: ReadonlyArray<ReasoningEffort>;
  readonly defaultReasoningLevel?: ReasoningEffort;
  readonly serviceTiers?: ReadonlyArray<ModelServiceTier>;
  readonly defaultReasoningSummary: ReasoningSummary;
  readonly truncationPolicy: TruncationPolicy;
  readonly supportsToolUse?: boolean;
  readonly supportsParallelToolCalls?: boolean;
  readonly modelMessages?: ModelMessages;
  readonly supportsPersonality?: boolean;
  readonly visibility?: "list" | "hide" | "none";
  readonly showInPicker?: boolean;
  /** Whether the metadata came from a fallback (warn user — see agenc runtime 594-606). */
  readonly usedFallbackModelMetadata: boolean;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "none";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type TruncationPolicy = "head" | "middle" | "off";

/** agenc runtime `Environment`. T7 (tool runtime) wires; today optional placeholder. */
export interface Environment {
  readonly cwd: string;
  // T7 adds: filesystem handle, network proxy ref, sandbox policy ref, etc.
}

/** agenc runtime `CollaborationMode`. T11 (modes + slash commands) lands real impl. */
export interface CollaborationMode {
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly developerInstructions?: string;
}

export type { Personality } from "../context/personality-spec-instructions.js";

/** agenc runtime `Constrained<T>` value carrier with current + allowed-set. */
export interface Constrained<T> {
  readonly value: T;
  readonly allowed?: ReadonlyArray<T>;
}

/** agenc runtime `AskForApproval` enum. T11 (permissions) lands real values. */
export type ApprovalPolicy =
  | "never"
  | "on_failure"
  | "on_request"
  | "granular"
  | "untrusted";

/** agenc runtime `SandboxPolicy` enum. T11 lands real shape. */
export type SandboxPolicy =
  | "danger_full_access"
  | "read_only"
  | "workspace_write"
  | "external_sandbox";

/** agenc runtime `FileSystemSandboxPolicy`. T11 lands real shape. */
export interface FileSystemSandboxPolicy {
  readonly allowWrite: ReadonlyArray<string>;
  readonly denyWrite: ReadonlyArray<string>;
  readonly allowRead: ReadonlyArray<string>;
  readonly denyRead: ReadonlyArray<string>;
}

/** agenc runtime `NetworkSandboxPolicy`. T11 lands real shape. */
export interface NetworkSandboxPolicy {
  readonly allowlist: ReadonlyArray<string>;
  readonly denylist: ReadonlyArray<string>;
  readonly allowManagedDomainsOnly: boolean;
  /** T5 placeholder for agenc runtime `Enabled` vs `Restricted` network access. */
  readonly enabled?: boolean;
}

/** agenc runtime `NetworkProxy`. Managed network transport remains deferred. */
export interface NetworkProxy {
  readonly httpsProxy?: string;
  readonly policyDecider?: NetworkPolicyDecider;
  readonly blockedRequestObserver?: BlockedRequestObserver;
}

/** agenc runtime `WindowsSandboxLevel`. T11 lands real impl. */
export type WindowsSandboxLevel = "none" | "permissive" | "strict";

/** agenc runtime `ShellEnvironmentPolicy`. T11 lands real impl. */
export interface ShellEnvironmentPolicy {
  readonly allowedEnvVars: ReadonlyArray<string>;
  readonly blockedEnvVars: ReadonlyArray<string>;
}

/** agenc runtime `ToolsConfig`. T7 (tool registry + concurrency) lands real impl. */
export interface ToolsConfig {
  readonly webSearchMode?: "auto" | "always" | "never";
  readonly webSearchConfig?: unknown;
  readonly allowLoginShell: boolean;
  readonly hasEnvironment: boolean;
  readonly unifiedExecShellMode?: unknown;
}

/** agenc runtime `ManagedFeatures`. T10 (config feature flags). */
export interface ManagedFeatures {
  /** Returns whether a staged feature key is enabled. */
  readonly enabled?: (feature: string) => boolean;
  /** Returns whether `apps_enabled_for_auth(is_chatgpt_auth)` is true. */
  readonly appsEnabledForAuth: (isChatgptAuth: boolean) => boolean;
  /** Returns whether to use the compatibility Landlock path. */
  readonly useLegacyLandlock: () => boolean;
}

/** agenc runtime `GhostSnapshotConfig`. Defer to a later tranche. */
export interface GhostSnapshotConfig {
  readonly enabled: boolean;
}

/** agenc runtime `ReadinessFlag`. Lightweight one-shot ready-flag (used as
 *  `tool_call_gate`). Real impl is a boolean + waiters list; T7 wires. */
export class ReadinessFlag {
  private ready = false;
  private waiters: Array<() => void> = [];
  isReady(): boolean {
    return this.ready;
  }
  signal(): void {
    if (this.ready) return;
    this.ready = true;
    for (const w of this.waiters.splice(0)) w();
  }
  async wait(): Promise<void> {
    if (this.ready) return;
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

/** agenc runtime `JsReplHandle`. T9 (subagents) wires; today opaque handle. */
export interface JsReplHandle {
  readonly id: string;
}

/** agenc runtime `DynamicToolSpec`. T7 wires. */
export interface DynamicToolSpec {
  readonly name: string;
  readonly description: string;
}

/** agenc runtime `TurnMetadataState`. T6 (event log) wires. */
export interface TurnMetadataState {
  readonly conversationId: string;
  readonly subId: string;
  readonly cwd: string;
  spawnGitEnrichmentTask(): void;
}

/** agenc runtime `TurnSkillsContext`. T10 (memory + skills) wires. */
export interface SkillLoadOutcome {
  readonly invokedSkills: ReadonlyArray<string>;
  readonly availableSkills?: ReadonlyArray<{
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly path: string;
    readonly root: string;
    readonly scope: string;
    readonly source?: string;
    readonly loadedFrom?: string;
    readonly aliases?: readonly string[];
    readonly allowedTools?: readonly string[];
    readonly argumentHint?: string;
    readonly argNames?: readonly string[];
    readonly whenToUse?: string;
    readonly version?: string;
    readonly model?: string;
    readonly disableModelInvocation?: boolean;
    readonly userInvocable?: boolean;
    readonly hooks?: unknown;
    readonly context?: "inline" | "fork";
    readonly agent?: string;
    readonly effort?: string;
    readonly shell?: "bash" | "powershell";
    readonly paths?: readonly string[];
    readonly contentLength?: number;
  }>;
}
export class TurnSkillsContext {
  readonly outcome: SkillLoadOutcome;
  readonly implicitInvocationSeenSkills = new Set<string>();
  constructor(outcome: SkillLoadOutcome) {
    this.outcome = outcome;
  }
}

/** agenc runtime `TurnTimingState`. T6 wires. */
export class TurnTimingState {
  startedAtMs: number = Date.now();
  startedAtUnixSecs: number | undefined;
  firstTokenAtMs: number | undefined;
  firstMessageAtMs: number | undefined;
  readonly samples: Array<{ phase: string; durationMs: number }> = [];

  markTurnStarted(startedAtMs: number = Date.now()): number {
    this.startedAtMs = startedAtMs;
    this.startedAtUnixSecs = Math.trunc(startedAtMs / 1000);
    this.firstTokenAtMs = undefined;
    this.firstMessageAtMs = undefined;
    return startedAtMs;
  }

  completedAtAndDurationMs(nowMs: number = Date.now()): {
    readonly completedAtUnixSecs: number;
    readonly durationMs: number;
  } {
    return {
      completedAtUnixSecs: Math.trunc(nowMs / 1000),
      durationMs: Math.max(0, Math.trunc(nowMs - this.startedAtMs)),
    };
  }

  timeToFirstTokenMs(): number | undefined {
    if (this.firstTokenAtMs === undefined) return undefined;
    return Math.max(0, Math.trunc(this.firstTokenAtMs - this.startedAtMs));
  }

  recordFirstToken(nowMs: number = Date.now()): number | undefined {
    if (this.firstTokenAtMs !== undefined) return undefined;
    this.firstTokenAtMs = nowMs;
    return this.timeToFirstTokenMs();
  }

  recordTtftForPhaseEvent(
    event: { readonly type: string; readonly content?: string },
    nowMs: number = Date.now(),
  ): number | undefined {
    if (!phaseEventRecordsTurnTtft(event)) return undefined;
    return this.recordFirstToken(nowMs);
  }

  recordTtfmForAssistantText(
    content: string,
    nowMs: number = Date.now(),
  ): number | undefined {
    if (content.length === 0) return undefined;
    if (this.firstMessageAtMs !== undefined) return undefined;
    this.firstMessageAtMs = nowMs;
    return Math.max(0, Math.trunc(nowMs - this.startedAtMs));
  }
}

function phaseEventRecordsTurnTtft(event: {
  readonly type: string;
  readonly content?: string;
}): boolean {
  switch (event.type) {
    case "assistant_text":
      return typeof event.content === "string" && event.content.length > 0;
    case "tool_call":
      return true;
    default:
      return false;
  }
}

/** agenc runtime `SessionConfiguration` (the big config blob). T10 lands real shape. */
export interface SessionConfiguration {
  readonly cwd: string;
  readonly approvalPolicy: Constrained<ApprovalPolicy>;
  readonly sandboxPolicy: Constrained<SandboxPolicy>;
  readonly fileSystemSandboxPolicy: FileSystemSandboxPolicy;
  readonly networkSandboxPolicy: NetworkSandboxPolicy;
  readonly windowsSandboxLevel: WindowsSandboxLevel;
  /**
   * Opt-in GPU compute (Metal) inside the platform sandbox (config
   * `sandbox.allow_gpu`). Kernel attack surface — off by default.
   */
  readonly sandboxAllowGpu?: boolean;
  readonly collaborationMode: CollaborationMode;
  readonly personality?: Personality;
  readonly reviewModel?: string;
  readonly modelVerbosity?: "low" | "medium" | "high";
  readonly modelReasoningSummary?: ReasoningSummary;
  readonly serviceTier?: string;
  readonly approvalsReviewer?: string;
  readonly developerInstructions?: string;
  readonly userInstructions?: string;
  readonly compactPrompt?: string;
  readonly appServerClientName?: string;
  readonly dynamicTools: ReadonlyArray<DynamicToolSpec>;
  readonly sessionSource: SessionSource;

  // ─── agenc runtime `SessionConfiguration` fields not yet bound to a real AgenC
  // subsystem. Kept optional/unknown until the naming tranche lands; the
  // shape tracks AgenC behavior so `apply`, builder inputs, and cross-turn
  // state propagation already line up.

  /** Active `LLMProvider` for the session (agenc runtime `provider: SharedModelProvider`). */
  readonly provider?: LLMProvider;
  /** agenc runtime `base_instructions` — baseline system prompt for the session. */
  readonly baseInstructions?: string;
  /** agenc runtime `agenc runtime_home` — directory containing agent state for the session. */
  readonly agencHome?: string;
  /** agenc runtime `thread_name` — optional user-facing thread label. */
  readonly threadName?: string;
  /**
   * agenc runtime `original_config_do_not_use` — raw config snapshot used to derive
   * per-turn config. T10 replaces with the real typed config once the config
   * surface lands.
   */
  readonly originalConfigDoNotUse?: Config;
  /** agenc runtime `metrics_service_name` — optional service name tag for metrics. */
  readonly metricsServiceName?: string;
  /** agenc runtime `app_server_client_version`. Pairs with `appServerClientName`. */
  readonly appServerClientVersion?: string;
  /** agenc runtime `persist_extended_history` — when true, record extended rollout events. */
  readonly persistExtendedHistory?: boolean;
  /**
   * agenc runtime `inherited_shell_snapshot` — opaque shell-snapshot handle inherited
   * by this session. T11 (permissions + shell snapshot) wires the real type.
   */
  readonly inheritedShellSnapshot?: unknown;
  /**
   * agenc runtime `user_shell_override` — operator override for the detected user
   * shell. T11 (shell discovery) wires the real `Shell` type.
   */
  readonly userShellOverride?: unknown;
}

/**
 * agenc runtime `SessionSettingsUpdate` — partial overlay applied via
 * `applySessionConfiguration` when a turn mutates session state.
 *
 * Mirrors agenc runtime `SessionSettingsUpdate`: every field is optional, and a
 * missing field means "keep the previous value". `finalOutputJsonSchema`
 * uses a double-option shape in agenc runtime (`Option<Option<Value>>`); we model
 * it the same way so a caller can set it to `undefined` explicitly to
 * clear the previous schema versus leaving it off entirely to keep it.
 */
export interface SessionSettingsUpdate {
  readonly cwd?: string;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly approvalsReviewer?: string;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly windowsSandboxLevel?: WindowsSandboxLevel;
  readonly collaborationMode?: CollaborationMode;
  readonly reviewModel?: string;
  readonly modelVerbosity?: "low" | "medium" | "high";
  readonly reasoningSummary?: ReasoningSummary;
  readonly serviceTier?: string;
  readonly personality?: Personality;
  readonly appServerClientName?: string;
  readonly appServerClientVersion?: string;
  /**
   * AgenC-style double-option marker. `undefined` means "leave untouched";
   * `{ value: undefined }` means "explicitly clear"; `{ value: schema }`
   * means "set to schema".
   */
  readonly finalOutputJsonSchema?: { readonly value: unknown | undefined };
}

export type SubAgentSource =
  | { readonly kind: "review" }
  | { readonly kind: "compact" }
  | {
      readonly kind: "thread_spawn";
      readonly parentThreadId: string;
      readonly depth: number;
      readonly agentPath?: string;
      readonly agentNickname?: string;
      readonly agentRole?: string;
      readonly agentRoleWorkspaceId?: string;
      readonly agentRoleFingerprint?: string;
    }
  | { readonly kind: "memory_consolidation" }
  | { readonly kind: "other"; readonly label: string };

/** agenc runtime `SessionSource`. */
export type SessionSource =
  | "cli_main"
  | "cli_subagent"
  | "sdk"
  | "ide"
  | { readonly kind: "subagent"; readonly source: SubAgentSource }
  | { kind: "unknown"; raw: string };

/**
 * Stage 2 (tool-result budgeting) knobs. Ports agenc's
 * `toolResultStorage` message-level budget into the AgenC context
 * adapter phase. Thresholds default to AgenC's 2MB/40KB pair; envs
 * `AGENC_TOOL_RESULT_BUDGET_BYTES` / `AGENC_TOOL_RESULT_TRUNCATE_BYTES`
 * override at the helper boundary.
 */
export interface ConfigToolBudget {
  /** Hard running-total budget across all tool-role messages. */
  readonly maxToolResultBudgetBytes?: number;
  /** Cap applied to each over-sized tool-role message body when shedding. */
  readonly truncateToBytes?: number;
}

/** agenc runtime `Config`. The original config blob (large). T10 lands real shape. */
export interface Config {
  readonly model: string;
  readonly reviewModel?: string;
  readonly modelVerbosity?: "low" | "medium" | "high";
  readonly modelReasoningEffort?: ReasoningEffort;
  readonly modelReasoningSummary?: ReasoningSummary;
  readonly serviceTier?: string;
  readonly personality?: Personality;
  readonly autonomousMode?: boolean;
  readonly approvalsReviewer?: string;
  readonly cwd: string;
  readonly features: ManagedFeatures;
  readonly multiAgentV2: {
    readonly maxConcurrentThreadsPerSession?: number;
    readonly minWaitTimeoutMs?: number;
    readonly defaultWaitTimeoutMs?: number;
    readonly maxWaitTimeoutMs?: number;
    readonly usageHintEnabled: boolean;
    readonly usageHintText: string;
    readonly rootAgentUsageHintText?: string;
    readonly subagentUsageHintText?: string;
    readonly hideSpawnAgentMetadata: boolean;
  };
  readonly permissions: {
    readonly allowLoginShell: boolean;
    readonly shellEnvironmentPolicy: ShellEnvironmentPolicy;
    readonly windowsSandboxPrivateDesktop: boolean;
  };
  readonly ghostSnapshot: GhostSnapshotConfig;
  readonly agencSelfExe?: string;
  readonly agencLinuxSandboxExe?: string;
  readonly agentRoles: ReadonlyArray<{ name: string; description: string }>;
  readonly agent_max_threads?: number;
  readonly agent_max_depth?: number;
  readonly maxTurns?: number;
  readonly experimental_realtime_start_instructions?: string;
  readonly experimental_realtime_ws_backend_prompt?: string;
  /** Stage 2 (tool-result budgeting) thresholds. Falls back to defaults
   *  in `applyToolResultBudgeting` when absent. */
  readonly toolBudget?: ConfigToolBudget;
  // T10 expands further.
}

/**
 * agenc runtime `TurnContextItem` — the rollout-stamped shape (T6).
 *
 * Every field here must exist on the rollout-side `TurnContextItem` in
 * `event-log.ts` as well. The rollout reader consumes this type
 * directly (no typed-cast recovery), so a rename on either side must
 * be reflected in both files before merging. The richer fields
 * (`realtimeActive`, `userInstructions`, `developerInstructions`,
 * `finalOutputJsonSchema`, `truncationPolicy`, `collaborationMode`,
 * `fileSystemSandboxPolicy`, `traceId`) round-trip through
 * `toTurnContextItem` + the rollout reader with no lossy narrowing.
 * Model-window metadata also round-trips so resume can evaluate
 * model-downshift compaction against the previous model.
 */
export interface TurnContextItem {
  readonly turnId?: string;
  readonly traceId?: string;
  readonly cwd: string;
  readonly currentDate?: string;
  readonly timezone?: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxPolicy: SandboxPolicy;
  readonly network?: TurnContextNetworkItem;
  readonly fileSystemSandboxPolicy?: FileSystemSandboxPolicy;
  readonly model: string;
  readonly modelContextWindow?: number;
  readonly rawModelContextWindow?: number;
  readonly modelEffectiveContextWindowPercent?: number;
  readonly autoCompactTokenLimit?: number;
  readonly modelProviderId?: string;
  readonly personality?: Personality;
  readonly collaborationMode?: CollaborationMode;
  readonly realtimeActive?: boolean;
  readonly effort?: ReasoningEffort;
  readonly summary?: ReasoningSummary;
  readonly userInstructions?: string;
  readonly developerInstructions?: string;
  readonly finalOutputJsonSchema?: unknown;
  readonly truncationPolicy?: TruncationPolicy;
  /** Content-free provenance for the exact live instruction envelope. */
  readonly instructionEvidence?: RunInstructionEvidence;
}

export interface TurnContextNetworkItem {
  readonly allowedDomains: ReadonlyArray<string>;
  readonly deniedDomains: ReadonlyArray<string>;
}

// ─────────────────────────────────────────────────────────────────────
// TurnContext itself — the per-turn immutable snapshot.
// ─────────────────────────────────────────────────────────────────────

/**
 * The context needed for a single turn of the thread.
 *
 * Faithful port of agenc runtime `TurnContext` struct (turn_context.rs:29-74).
 * All fields `readonly` per I-30 (config snapshot per-turn-immutable).
 */
export interface TurnContext {
  /** Turn id for telemetry + event routing. */
  readonly subId: string;

  /** Distributed trace id (current span). */
  readonly traceId?: string;

  /** Whether realtime conversation is active for this turn. */
  readonly realtimeActive: boolean;

  /** I-30: per-turn frozen config. Phases MUST read from this, never live config. */
  readonly config: Readonly<Config>;

  /** I-13: cached config snapshot used by phases for AsyncCompactCheck etc. */
  readonly configSnapshot: Readonly<Config>;

  /** OAuth / bearer auth manager (provider boundary). */
  readonly authManager?: AuthManager;

  /** Per-(provider,model) capability bitmap. */
  readonly modelInfo: ModelInfo;

  /** The active provider for this turn (multi-provider per provider-matrix.md). */
  readonly provider: LLMProvider;

  /** Stable provider id for rollout/cost attribution. */
  readonly modelProviderId: string;

  /** Reasoning effort selection (o-series + Grok). */
  readonly reasoningEffort?: ReasoningEffort;

  /** Reasoning summary mode. */
  readonly reasoningSummary: ReasoningSummary;

  /** Provider-facing output verbosity hint. */
  readonly modelVerbosity?: "low" | "medium" | "high";

  /** Provider-facing service-tier hint. */
  readonly serviceTier?: string;

  /** Where the session originated (CLI, IDE, SDK, …). */
  readonly sessionSource: SessionSource;

  /** Optional environment (filesystem + network handles). T7 wires. */
  readonly environment?: Environment;

  /** Session's absolute working directory. All relative paths resolve against this. */
  readonly cwd: string;

  /** Wall-clock date string (YYYY-MM-DD) at turn start. */
  readonly currentDate?: string;

  /** IANA timezone at turn start. */
  readonly timezone?: string;

  /** App-server client identifier. */
  readonly appServerClientName?: string;

  /** Baseline system prompt for the active model/session. */
  readonly baseInstructions?: string;

  /** Developer instructions (separate from user instructions). */
  readonly developerInstructions?: string;

  /** Custom compaction prompt; falls back to library default. */
  readonly compactPrompt?: string;

  /** User instructions block (AGENC.md ancestor walk + @include). */
  readonly userInstructions?: string;

  /** Collaboration mode (model + reasoning effort + dev instructions). */
  readonly collaborationMode: CollaborationMode;

  /** Personality string. */
  readonly personality?: Personality;

  /** Approval policy with allowed-set constraint. T11 wires. */
  readonly approvalPolicy: Constrained<ApprovalPolicy>;

  /** Sandbox policy with allowed-set constraint. T11 wires. */
  readonly sandboxPolicy: Constrained<SandboxPolicy>;

  /** Filesystem sandbox split policy. T11 wires. */
  readonly fileSystemSandboxPolicy: FileSystemSandboxPolicy;

  /** Network sandbox split policy. T11 wires. */
  readonly networkSandboxPolicy: NetworkSandboxPolicy;

  /** Optional managed-network proxy. */
  readonly network?: NetworkProxy;

  /** Windows sandbox level. T11 wires. */
  readonly windowsSandboxLevel: WindowsSandboxLevel;

  /** Shell environment policy. T11 wires. */
  readonly shellEnvironmentPolicy: ShellEnvironmentPolicy;

  /** Tool registration + capability config. T7 wires. */
  readonly toolsConfig: ToolsConfig;

  /** Feature flags resolved against the active config layer stack. */
  readonly features: ManagedFeatures;

  /** Ghost-commit snapshot config. */
  readonly ghostSnapshot: GhostSnapshotConfig;

  /** Optional structured-output schema for the final assistant message. */
  readonly finalOutputJsonSchema?: unknown;

  /** Path to the agenc runtime/agenc self exe (for spawning child processes). */
  readonly agencSelfExe?: string;

  /** Linux sandbox helper exe path. */
  readonly agencLinuxSandboxExe?: string;

  /** Tool-call readiness gate (set when tools are ready to dispatch). T7 wires. */
  readonly toolCallGate: ReadinessFlag;

  /** Truncation policy for over-long inputs. */
  readonly truncationPolicy: TruncationPolicy;

  /** JS REPL handle for inline evaluation. T9 wires. */
  readonly jsRepl: JsReplHandle;

  /** Dynamic tools specified per-turn (rare). */
  readonly dynamicTools: ReadonlyArray<DynamicToolSpec>;

  /** Mutable turn metadata + git enrichment task. T6 wires. */
  readonly turnMetadataState: TurnMetadataState;

  /** Skills loaded for this turn. T10 wires. */
  readonly turnSkills: TurnSkillsContext;

  /** Per-turn timing samples. T6 wires. */
  readonly turnTimingState: TurnTimingState;

  /** I-1: subagent recursion depth. Root session = 0; children +=1 (T9 enforces cap). */
  readonly depth: number;

  /**
   * I-30 snapshot of the permission mode at turn start. Captured from
   * `session.services.permissionModeRegistry.current().mode` when the
   * TurnContext is built and never mutated afterwards.
   *
   * IMPORTANT (I-3 re-reads): evaluator paths that need the *live*
   * permission mode MUST call `registry.current()` fresh on every
   * check. They MUST NOT consult this field — it is a snapshot, not
   * the live registry value.
   */
  readonly permissionMode: PermissionMode;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (matching agenc runtime `impl TurnContext` methods).
// ─────────────────────────────────────────────────────────────────────

/**
 * Effective context window: model's context window × `effectiveContextWindowPercent` / 100.
 * Mirrors agenc runtime `TurnContext::model_context_window`.
 */
export function modelContextWindow(ctx: TurnContext): number | undefined {
  const cw = ctx.modelInfo.contextWindow;
  if (cw === undefined) return undefined;
  return Math.floor((cw * ctx.modelInfo.effectiveContextWindowPercent) / 100);
}

/**
 * Snapshot the current TurnContext into a serializable rollout item.
 * Mirrors agenc runtime `TurnContext::to_turn_context_item`.
 */
export function toTurnContextItem(ctx: TurnContext): TurnContextItem {
  return {
    turnId: ctx.subId,
    traceId: ctx.traceId,
    cwd: ctx.cwd,
    currentDate: ctx.currentDate,
    timezone: ctx.timezone,
    approvalPolicy: ctx.approvalPolicy.value,
    sandboxPolicy: ctx.sandboxPolicy.value,
    fileSystemSandboxPolicy: ctx.fileSystemSandboxPolicy,
    model: ctx.modelInfo.slug,
    modelContextWindow: modelContextWindow(ctx),
    rawModelContextWindow: ctx.modelInfo.contextWindow,
    modelEffectiveContextWindowPercent:
      ctx.modelInfo.effectiveContextWindowPercent,
    autoCompactTokenLimit: (ctx.modelInfo as { autoCompactTokenLimit?: number })
      .autoCompactTokenLimit,
    modelProviderId: ctx.modelProviderId,
    personality: normalizePersonality(ctx.personality ?? ctx.config.personality),
    collaborationMode: ctx.collaborationMode,
    realtimeActive: ctx.realtimeActive,
    effort: ctx.reasoningEffort,
    summary: ctx.reasoningSummary,
    userInstructions: ctx.userInstructions,
    developerInstructions: ctx.developerInstructions,
    finalOutputJsonSchema: ctx.finalOutputJsonSchema,
    truncationPolicy: ctx.truncationPolicy,
  };
}

/**
 * Narrow predicate: is this auth session the ChatGPT OAuth mode?
 *
 * agenc runtime gates several features on `AuthMode::Chatgpt` specifically,
 * not on "any OAuth session". Non-ChatGPT OAuth providers (e.g. xAI,
 * OpenRouter) should NOT enable ChatGPT-only tool surfaces.
 */
export function isChatgptAuth(authManager?: AuthManager): boolean {
  return (
    authManager?.mode === "oauth" && authManager.authProvider === "chatgpt"
  );
}

/**
 * Whether the image-generation tool may be used (AgenC behavior with
 * `image_generation_tool_auth_allowed` — only true when the active auth
 * is the ChatGPT OAuth mode, not any OAuth session).
 */
export function imageGenerationToolAuthAllowed(
  authManager?: AuthManager,
): boolean {
  return isChatgptAuth(authManager);
}

/**
 * Compute (currentDate, timezone) at turn-construction time.
 * Falls back to UTC on tz lookup failure (mirrors agenc runtime `local_time_context`).
 */
function localTimeContext(): {
  currentDate: string;
  timezone: string;
} {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
    const date = new Date().toISOString().slice(0, 10);
    return { currentDate: date, timezone: tz };
  } catch {
    return {
      currentDate: new Date().toISOString().slice(0, 10),
      timezone: "Etc/UTC",
    };
  }
}

/**
 * Deep-freeze helper for I-30 enforcement.
 *
 * `Object.freeze` is shallow: nested objects and arrays remain mutable.
 * TurnContext relies on I-30 (per-turn-immutable config snapshot) at
 * depth — phases must never mutate `ctx.config.permissions.*`,
 * `ctx.configSnapshot.*`, etc. This walker freezes the whole object
 * graph (skipping frozen subtrees to keep cycles harmless).
 *
 * Map and Set receive extra protection because `Object.freeze` alone
 * does not stop `.set()/.add()/.delete()/.clear()` from mutating
 * their internal slots. For Map/Set inputs, this helper:
 *   - Object.freezes the container (catches property-bag assignments),
 *   - replaces the `set/add/delete/clear` methods with throwing stubs
 *     on a per-instance own-property basis so later mutation attempts
 *     throw a TypeError instead of silently succeeding,
 *   - recursively freezes each contained entry value (and key, for
 *     Map) so nested structures are locked down the same way object
 *     subtrees are.
 *
 * The guarantee: after `deepFreeze(x)`, no reachable property, array
 * element, Map entry, or Set member can be mutated without a throw.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value as Readonly<T>;

  if (value instanceof Map) {
    // Replace mutating methods before freezing so the own-property
    // assignments succeed (frozen objects reject defineProperty).
    const throwOnMutate = (method: string) => {
      return () => {
        throw new TypeError(
          `Cannot ${method} on a deep-frozen Map (I-30 immutability)`,
        );
      };
    };
    Object.defineProperty(value, "set", {
      value: throwOnMutate("set"),
      writable: false,
      configurable: false,
    });
    Object.defineProperty(value, "delete", {
      value: throwOnMutate("delete"),
      writable: false,
      configurable: false,
    });
    Object.defineProperty(value, "clear", {
      value: throwOnMutate("clear"),
      writable: false,
      configurable: false,
    });
    Object.freeze(value);
    for (const [k, v] of value as Map<unknown, unknown>) {
      if (k && typeof k === "object" && !Object.isFrozen(k)) deepFreeze(k);
      if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
    }
    return value as Readonly<T>;
  }

  if (value instanceof Set) {
    const throwOnMutate = (method: string) => {
      return () => {
        throw new TypeError(
          `Cannot ${method} on a deep-frozen Set (I-30 immutability)`,
        );
      };
    };
    Object.defineProperty(value, "add", {
      value: throwOnMutate("add"),
      writable: false,
      configurable: false,
    });
    Object.defineProperty(value, "delete", {
      value: throwOnMutate("delete"),
      writable: false,
      configurable: false,
    });
    Object.defineProperty(value, "clear", {
      value: throwOnMutate("clear"),
      writable: false,
      configurable: false,
    });
    Object.freeze(value);
    for (const entry of value as Set<unknown>) {
      if (entry && typeof entry === "object" && !Object.isFrozen(entry)) {
        deepFreeze(entry);
      }
    }
    return value as Readonly<T>;
  }

  Object.freeze(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value as Readonly<T>;
}

/**
 * Deep-clone a `Config` for the TurnContext snapshot.
 *
 * Uses `structuredClone` when available (Node 17+) and falls back to a
 * JSON round-trip otherwise. Callers are responsible for re-attaching any
 * non-serializable fields (e.g. `features` callbacks) after cloning.
 */
function cloneConfigForSnapshot(config: Config): Config {
  const sc =
    typeof (globalThis as { structuredClone?: unknown }).structuredClone ===
    "function"
      ? (globalThis as { structuredClone: <X>(x: X) => X }).structuredClone
      : null;
  if (sc) {
    // Strip the non-cloneable `features` callbacks before cloning.
    const { features: _features, ...rest } = config;
    return sc(rest) as Config;
  }
  const { features: _features2, ...rest } = config;
  return JSON.parse(JSON.stringify(rest)) as Config;
}

// ─────────────────────────────────────────────────────────────────────
// SessionConfiguration helpers (agenc runtime `impl SessionConfiguration` parity).
// ─────────────────────────────────────────────────────────────────────

/** Mirror of agenc runtime `SessionConfiguration::agenc runtime_home` — thin accessor. */
export function agencHome(sc: SessionConfiguration): string | undefined {
  return sc.agencHome;
}

/**
 * Shallow snapshot of the thread-shaping fields of `SessionConfiguration`.
 * Mirrors agenc runtime `SessionConfiguration::thread_config_snapshot`. Returns a
 * fresh object so mutations by the caller cannot leak back into the live
 * session configuration.
 */
export interface ThreadConfigSnapshot {
  readonly model: string;
  readonly reviewModel?: string;
  readonly modelVerbosity?: "low" | "medium" | "high";
  readonly serviceTier?: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly approvalsReviewer?: string;
  readonly sandboxPolicy: SandboxPolicy;
  readonly cwd: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly personality?: Personality;
  readonly sessionSource: SessionSource;
}

export function threadConfigSnapshot(
  sc: SessionConfiguration,
): ThreadConfigSnapshot {
  const snap: ThreadConfigSnapshot = {
    model: sc.collaborationMode.model,
    ...(sc.reviewModel !== undefined ? { reviewModel: sc.reviewModel } : {}),
    ...(sc.modelVerbosity !== undefined
      ? { modelVerbosity: sc.modelVerbosity }
      : {}),
    ...(sc.serviceTier !== undefined ? { serviceTier: sc.serviceTier } : {}),
    approvalPolicy: sc.approvalPolicy.value,
    ...(sc.approvalsReviewer !== undefined
      ? { approvalsReviewer: sc.approvalsReviewer }
      : {}),
    sandboxPolicy: sc.sandboxPolicy.value,
    cwd: sc.cwd,
    ...(sc.collaborationMode.reasoningEffort !== undefined
      ? { reasoningEffort: sc.collaborationMode.reasoningEffort }
      : {}),
    ...(sc.personality !== undefined ? { personality: sc.personality } : {}),
    sessionSource: sc.sessionSource,
  };
  return snap;
}

/**
 * Apply a `SessionSettingsUpdate` and return the merged `SessionConfiguration`.
 *
 * Mirrors agenc runtime `SessionConfiguration::apply`. Notable parity:
 *
 *   - Compatibility-FS-policy preservation on cwd-only updates. If only `cwd`
 *     changes and the current `fileSystemSandboxPolicy` matches the
 *     default derived from the compatibility `sandboxPolicy`, re-derive it for
 *     the new cwd; otherwise preserve the richer split policy unchanged.
 *   - Sandbox-policy changes rebuild the derived network/filesystem
 *     split policies from the new compatibility sandbox mode.
 */
export function applySessionConfiguration(
  current: SessionConfiguration,
  updates: SessionSettingsUpdate,
): SessionConfiguration {
  const next: Mutable<SessionConfiguration> = { ...current };
  const fileSystemPolicyMatchesLegacy = fileSystemSandboxPolicyEquals(
    current.fileSystemSandboxPolicy,
    deriveFileSystemSandboxPolicyForMode(
      current.sandboxPolicy.value,
      current.cwd,
    ),
  );

  if (updates.collaborationMode !== undefined) {
    next.collaborationMode = updates.collaborationMode;
  }
  if (updates.reviewModel !== undefined) {
    next.reviewModel = updates.reviewModel;
  }
  if (updates.modelVerbosity !== undefined) {
    next.modelVerbosity = updates.modelVerbosity;
  }
  if (updates.reasoningSummary !== undefined) {
    next.modelReasoningSummary = updates.reasoningSummary;
  }
  if (updates.serviceTier !== undefined) {
    next.serviceTier = updates.serviceTier;
  }
  if (updates.personality !== undefined) {
    next.personality = updates.personality;
  }
  if (updates.approvalPolicy !== undefined) {
    next.approvalPolicy = {
      value: updates.approvalPolicy,
      ...(current.approvalPolicy.allowed
        ? { allowed: current.approvalPolicy.allowed }
        : {}),
    };
  }
  if (updates.approvalsReviewer !== undefined) {
    next.approvalsReviewer = updates.approvalsReviewer;
  }

  let sandboxPolicyChanged = false;
  if (updates.sandboxPolicy !== undefined) {
    next.sandboxPolicy = {
      value: updates.sandboxPolicy,
      ...(current.sandboxPolicy.allowed
        ? { allowed: current.sandboxPolicy.allowed }
        : {}),
    };
    next.networkSandboxPolicy = deriveNetworkSandboxPolicyForMode(
      updates.sandboxPolicy,
      current.networkSandboxPolicy,
    );
    sandboxPolicyChanged = true;
  }
  if (updates.windowsSandboxLevel !== undefined) {
    next.windowsSandboxLevel = updates.windowsSandboxLevel;
  }

  const cwdChanged =
    updates.cwd !== undefined && updates.cwd !== current.cwd;
  if (updates.cwd !== undefined) {
    next.cwd = updates.cwd;
  }

  // AgenC behavior (session.rs `SessionConfiguration::apply`):
  //   - sandbox policy changed -> rebuild the split filesystem policy
  //     from the new compatibility mode. T5 only has the default projection;
  //     T11 wires the richer deny-entry-preserving variant.
  //   - cwd-only change -> reroot only when the current split policy is
  //     still the compatibility-derived one; richer policies survive unchanged.
  if (sandboxPolicyChanged) {
    next.fileSystemSandboxPolicy = deriveFileSystemSandboxPolicyForMode(
      next.sandboxPolicy.value,
      next.cwd,
    );
  } else if (cwdChanged && fileSystemPolicyMatchesLegacy) {
    next.fileSystemSandboxPolicy = deriveFileSystemSandboxPolicyForMode(
      next.sandboxPolicy.value,
      next.cwd,
    );
  }

  if (updates.appServerClientName !== undefined) {
    next.appServerClientName = updates.appServerClientName;
  }
  if (updates.appServerClientVersion !== undefined) {
    next.appServerClientVersion = updates.appServerClientVersion;
  }

  return next;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Rebuild a `FileSystemSandboxPolicy` from a compatibility `SandboxPolicy`
 * mode + cwd. Mirrors agenc runtime
 * `FileSystemSandboxPolicy::from_legacy_sandbox_policy` default
 * projection for each mode:
 *
 *   - `danger_full_access` → fully unrestricted (empty allow/deny).
 *   - `read_only`          → read-only (no writes allowed).
 *   - `workspace_write`    → writes confined to the session cwd;
 *                            reads unrestricted.
 *   - `external_sandbox`   → owned by an out-of-process sandbox; the
 *                            AgenC-side policy is kept empty so no
 *                            internal layer claims authority.
 *
 * The full deny-entry-preserving rebuild (which inspects the previous
 * richer policy) is T11's job; this intermediate helper covers the
 * agenc runtime-parity default projection so a mode change does not silently
 * keep the old policy.
 */
export function deriveFileSystemSandboxPolicyForMode(
  mode: SandboxPolicy,
  cwd: string,
): FileSystemSandboxPolicy {
  switch (mode) {
    case "danger_full_access":
      return {
        allowWrite: [],
        denyWrite: [],
        allowRead: [],
        denyRead: [],
      };
    case "workspace_write":
      return {
        allowWrite: [cwd],
        denyWrite: [],
        allowRead: [],
        denyRead: [],
      };
    case "read_only":
      return {
        allowWrite: [],
        denyWrite: [cwd],
        allowRead: [],
        denyRead: [],
      };
    case "external_sandbox":
      return {
        allowWrite: [],
        denyWrite: [],
        allowRead: [],
        denyRead: [],
      };
  }
}

/**
 * Rebuild a `NetworkSandboxPolicy` from a compatibility `SandboxPolicy`.
 *
 * agenc runtime's real network policy is binary (`Enabled` vs `Restricted`).
 * T5 keeps the placeholder allow/deny lists untouched and mirrors the
 * binary state via `enabled` so sandbox-policy updates do not leave a
 * stale per-session network snapshot behind.
 */
export function deriveNetworkSandboxPolicyForMode(
  mode: SandboxPolicy,
  current?: NetworkSandboxPolicy,
): NetworkSandboxPolicy {
  const enabled = mode === "danger_full_access";
  return {
    allowlist: current?.allowlist ?? [],
    denylist: current?.denylist ?? [],
    allowManagedDomainsOnly: current?.allowManagedDomainsOnly ?? false,
    enabled,
  };
}

function fileSystemSandboxPolicyEquals(
  a: FileSystemSandboxPolicy,
  b: FileSystemSandboxPolicy,
): boolean {
  return (
    readonlyArrayEquals(a.allowWrite, b.allowWrite) &&
    readonlyArrayEquals(a.denyWrite, b.denyWrite) &&
    readonlyArrayEquals(a.allowRead, b.allowRead) &&
    readonlyArrayEquals(a.denyRead, b.denyRead)
  );
}

function readonlyArrayEquals<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ─────────────────────────────────────────────────────────────────────
// TurnContext builder (agenc runtime `Session::make_turn_context` parity).
// Subset matching the AgenC T5 surface; later tranches expand the
// builder as their subsystems land.
// ─────────────────────────────────────────────────────────────────────

export interface BuildTurnContextOptions {
  conversationId: string;
  subId: string;
  config: Config;
  modelInfo: ModelInfo;
  provider: LLMProvider;
  sessionConfiguration: SessionConfiguration;
  authManager?: AuthManager;
  environment?: Environment;
  network?: NetworkProxy;
  jsRepl?: JsReplHandle;
  skillsOutcome?: SkillLoadOutcome;
  /** I-1: depth from spawning parent (root = 0). */
  depth?: number;
  /** Optional override for current date / timezone (testing). */
  clock?: { currentDate: string; timezone: string };
  /**
   * I-30 snapshot of the permission mode at turn start. When absent,
   * the builder falls back to `"default"` so tests that construct
   * TurnContexts without a PermissionModeRegistry keep working.
   * Evaluator I-3 re-reads must continue to call the live registry;
   * this field is strictly the per-turn snapshot.
   */
  permissionMode?: PermissionMode;
}

/**
 * Build a fresh TurnContext for a new turn.
 * Mirrors agenc runtime `Session::make_turn_context` (turn_context.rs:335-447).
 */
export function buildTurnContext(opts: BuildTurnContextOptions): TurnContext {
  const sc = opts.sessionConfiguration;
  const effectiveCwd = opts.config.cwd;
  const reasoningEffort = sc.collaborationMode.reasoningEffort;
  const reasoningSummary =
    sc.modelReasoningSummary ?? opts.modelInfo.defaultReasoningSummary;
  const { currentDate, timezone } = opts.clock ?? localTimeContext();

  const skillsOutcome: SkillLoadOutcome =
    opts.skillsOutcome ?? { invokedSkills: [] };

  const turnMetadataState: TurnMetadataState = {
    conversationId: opts.conversationId,
    subId: opts.subId,
    cwd: effectiveCwd,
    spawnGitEnrichmentTask: () => {
      /* T6 wires git-enrichment background task */
    },
  };

  // I-30: deep-clone then deep-freeze the config for the lifetime of
  // this TurnContext so nested fields (permissions, features,
  // multiAgentV2, …) cannot be mutated by any phase *and* so freezing
  // does not leak back onto the caller's live config object.
  // `structuredClone` strips functions (e.g. `features.appsEnabledForAuth`),
  // so preserve non-serializable subtrees by clone-then-graft.
  const preservedFeatures = opts.config.features;
  const clonedConfig = cloneConfigForSnapshot(opts.config);
  (clonedConfig as Mutable<Config>).features = preservedFeatures;
  const frozenConfig: Readonly<Config> = deepFreeze(clonedConfig);

  return {
    subId: opts.subId,
    traceId: undefined,
    realtimeActive: false,
    config: frozenConfig,
    configSnapshot: frozenConfig,
    authManager: opts.authManager,
    modelInfo: opts.modelInfo,
    provider: opts.provider,
    modelProviderId: opts.provider.name,
    reasoningEffort,
    reasoningSummary,
    modelVerbosity: sc.modelVerbosity,
    serviceTier: sc.serviceTier,
    sessionSource: sc.sessionSource,
    environment: opts.environment,
    cwd: effectiveCwd,
    currentDate,
    timezone,
    appServerClientName: sc.appServerClientName,
    baseInstructions: sc.baseInstructions,
    developerInstructions: sc.developerInstructions,
    compactPrompt: sc.compactPrompt,
    userInstructions: sc.userInstructions,
    collaborationMode: sc.collaborationMode,
    personality: sc.personality,
    approvalPolicy: sc.approvalPolicy,
    sandboxPolicy: sc.sandboxPolicy,
    fileSystemSandboxPolicy: sc.fileSystemSandboxPolicy,
    networkSandboxPolicy: sc.networkSandboxPolicy,
    network: opts.network,
    windowsSandboxLevel: sc.windowsSandboxLevel,
    shellEnvironmentPolicy: frozenConfig.permissions.shellEnvironmentPolicy,
    toolsConfig: {
      allowLoginShell: frozenConfig.permissions.allowLoginShell,
      hasEnvironment: opts.environment !== undefined,
    },
    features: frozenConfig.features,
    ghostSnapshot: frozenConfig.ghostSnapshot,
    finalOutputJsonSchema: undefined,
    agencSelfExe: frozenConfig.agencSelfExe,
    agencLinuxSandboxExe: frozenConfig.agencLinuxSandboxExe,
    toolCallGate: new ReadinessFlag(),
    truncationPolicy: opts.modelInfo.truncationPolicy,
    jsRepl: opts.jsRepl ?? { id: `repl-${opts.conversationId}-${opts.subId}` },
    dynamicTools: sc.dynamicTools,
    turnMetadataState,
    turnSkills: new TurnSkillsContext(skillsOutcome),
    turnTimingState: new TurnTimingState(),
    depth: opts.depth ?? 0,
    // I-30 snapshot of the permission mode at turn start. Evaluator I-3
    // re-reads MUST consult the live registry instead of this field;
    // this slot exists only so per-turn observers can see the mode that
    // was active when the turn began without racing the registry.
    permissionMode: opts.permissionMode ?? "default",
  };
}

// ─────────────────────────────────────────────────────────────────────
// agenc runtime `impl Session` turn-builder helpers.
//
// Mirrors agenc runtime `turn_context.rs:303/449/609/614`. Structural inputs
// keep this module free of a Session-class import (session.ts already
// imports from this module, so a direct dependency would be cyclic).
// ─────────────────────────────────────────────────────────────────────

/**
 * Structural view of the session state this module needs to build a
 * per-turn snapshot. Matches the subset of agenc runtime `Session` that the
 * real `make_turn_context` pulls from.
 */
export interface SessionForTurn {
  readonly conversationId: string;
  readonly sessionConfiguration: SessionConfiguration;
  readonly config: Config;
  readonly modelInfo: ModelInfo;
  readonly provider: LLMProvider;
  readonly authManager?: AuthManager;
  readonly environment?: Environment;
  readonly network?: NetworkProxy;
  readonly jsRepl?: JsReplHandle;
  readonly pendingWorktreeState?: PendingWorktreeState | null;
  /**
   * I-30 snapshot source for the per-turn permission-mode slot. When
   * present, `newDefaultTurnWithSubId` / `newTurnWithSubId` read the
   * current mode once at turn construction and pin it on the
   * TurnContext. Optional so test fixtures that do not need permission
   * wiring can keep omitting it.
   */
  readonly permissionModeRegistry?: PermissionModeRegistry;
  /** Monotonic sub-id allocator (agenc runtime `next_internal_sub_id`). */
  nextInternalSubId(): string;
}

/**
 * agenc runtime `Session::build_per_turn_config` (turn_context.rs:303).
 *
 * Returns a frozen `Config` snapshot for this turn. The snapshot is
 * rebuilt from `SessionConfiguration` atop the original session config
 * blob (`originalConfigDoNotUse`) when available, matching agenc runtime's
 * `build_per_turn_config`, then caller overrides are layered on top
 * before freeze. I-30: callers MUST read the returned snapshot rather
 * than the live session config for the lifetime of the turn —
 * mutating the snapshot throws.
 */
export function buildPerTurnConfig(
  session: SessionForTurn,
  overrides?: Partial<Config>,
): Readonly<Config> {
  const sourceConfig =
    session.sessionConfiguration.originalConfigDoNotUse ?? session.config;
  const effectiveCwd =
    session.pendingWorktreeState?.handle.path ??
    session.sessionConfiguration.cwd;
  const cloned = cloneConfigForSnapshot(sourceConfig);
  const mutableCloned = cloned as Mutable<Config>;
  mutableCloned.features = sourceConfig.features;
  mutableCloned.model = session.sessionConfiguration.collaborationMode.model;
  mutableCloned.cwd = effectiveCwd;
  mutableCloned.reviewModel = session.sessionConfiguration.reviewModel;
  mutableCloned.modelVerbosity = session.sessionConfiguration.modelVerbosity;
  mutableCloned.modelReasoningEffort =
    session.sessionConfiguration.collaborationMode.reasoningEffort;
  mutableCloned.modelReasoningSummary =
    session.sessionConfiguration.modelReasoningSummary;
  mutableCloned.serviceTier = session.sessionConfiguration.serviceTier;
  mutableCloned.personality = session.sessionConfiguration.personality;
  mutableCloned.approvalsReviewer =
    session.sessionConfiguration.approvalsReviewer;
  if (overrides !== undefined) {
    for (const key of Object.keys(overrides) as Array<keyof Config>) {
      const value = overrides[key];
      if (value !== undefined) {
        // Per-key assignment widens Config[keyof Config] to an intersection;
        // cast through `unknown` to sidestep TS's indexed-write narrowing.
        (mutableCloned as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return deepFreeze(cloned);
}

/**
 * agenc runtime `Session::new_default_turn_with_sub_id` (turn_context.rs:614).
 *
 * Builds a `TurnContext` using the session's defaults plus an
 * operator-supplied sub-id (so the caller can join the turn's event
 * stream on a known id).
 */
export function newDefaultTurnWithSubId(
  session: SessionForTurn,
  subId: string,
): TurnContext {
  const perTurnConfig = buildPerTurnConfig(session);
  // I-30 snapshot: read the registry exactly once at turn construction.
  // Evaluator I-3 re-reads stay on the live registry; this snapshot is
  // only for per-turn observers that need to know the mode that was
  // active when the turn began.
  const permissionMode = session.permissionModeRegistry?.current().mode;
  return buildTurnContext({
    conversationId: session.conversationId,
    subId,
    config: perTurnConfig,
    modelInfo: session.modelInfo,
    provider: session.provider,
    sessionConfiguration: session.sessionConfiguration,
    ...(session.authManager !== undefined
      ? { authManager: session.authManager }
      : {}),
    ...(session.environment !== undefined
      ? { environment: session.environment }
      : {}),
    ...(session.network !== undefined ? { network: session.network } : {}),
    ...(session.jsRepl !== undefined ? { jsRepl: session.jsRepl } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  });
}

/**
 * agenc runtime `Session::new_default_turn` (turn_context.rs:609).
 *
 * Convenience wrapper that allocates a fresh sub-id via the session's
 * monotonic allocator, then delegates to
 * {@link newDefaultTurnWithSubId}.
 */
export function newDefaultTurn(session: SessionForTurn): TurnContext {
  return newDefaultTurnWithSubId(session, session.nextInternalSubId());
}

/**
 * agenc runtime `Session::new_turn_with_sub_id` (turn_context.rs:449).
 *
 * Builds a `TurnContext` with a caller-supplied sub-id and optional
 * per-turn `Config` overrides layered on top of the session defaults.
 * The overrides go through {@link buildPerTurnConfig} so the per-turn
 * snapshot is always deep-frozen (I-30) regardless of what the caller
 * passes in.
 */
export function newTurnWithSubId(
  session: SessionForTurn,
  subId: string,
  configOverrides?: Partial<Config>,
): TurnContext {
  const perTurnConfig = buildPerTurnConfig(session, configOverrides);
  // I-30 snapshot: registry read is a single atomic lookup at turn
  // construction. Evaluator I-3 re-reads stay on the live registry.
  const permissionMode = session.permissionModeRegistry?.current().mode;
  return buildTurnContext({
    conversationId: session.conversationId,
    subId,
    config: perTurnConfig,
    modelInfo: session.modelInfo,
    provider: session.provider,
    sessionConfiguration: session.sessionConfiguration,
    ...(session.authManager !== undefined
      ? { authManager: session.authManager }
      : {}),
    ...(session.environment !== undefined
      ? { environment: session.environment }
      : {}),
    ...(session.network !== undefined ? { network: session.network } : {}),
    ...(session.jsRepl !== undefined ? { jsRepl: session.jsRepl } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  });
}

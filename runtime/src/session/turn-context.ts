/**
 * Per-turn immutable context.
 *
 * Hand-port of codex `core/src/session/turn_context.rs` (626 LOC Rust)
 * per `docs/plan/translation-conventions.md`. Every field of codex's
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

// ─────────────────────────────────────────────────────────────────────
// Forward-dep placeholder types (real impls land in later tranches).
// Each `interface` here is a structural placeholder so TS can typecheck
// the TurnContext shape without dragging in the real subsystem.
// ─────────────────────────────────────────────────────────────────────

/**
 * Codex `AuthManager`. T13 wires real OAuth refresh; today stubbed.
 *
 * `mode` matches codex `AuthMode` at the transport level: `bearer_key` for
 * static API keys, `oauth` for any OAuth-authorized session, and
 * `local_no_auth` for local-only loopback providers.
 *
 * `authProvider` narrows an `oauth` session to the specific upstream so
 * gates like `imageGenerationToolAuthAllowed` can match codex's
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

/** Codex `ModelInfo`. T13 (multi-provider capability registry) lands real shape. */
export interface ModelInfo {
  readonly slug: string;
  readonly contextWindow?: number;
  readonly effectiveContextWindowPercent: number;
  readonly maxOutputTokens?: number;
  readonly supportedReasoningLevels: ReadonlyArray<ReasoningEffort>;
  readonly defaultReasoningLevel?: ReasoningEffort;
  readonly defaultReasoningSummary: ReasoningSummary;
  readonly truncationPolicy: TruncationPolicy;
  /** Whether the metadata came from a fallback (warn user — see codex 594-606). */
  readonly usedFallbackModelMetadata: boolean;
}

export type ReasoningEffort = "low" | "medium" | "high" | "none";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type TruncationPolicy = "head" | "middle" | "off";

/** Codex `SessionTelemetry`. T6 (event log + sidecars) lands real impl. */
export interface SessionTelemetry {
  readonly modelSlug?: string;
  // T6 expands: emit timing, retry phase, transport classification, etc.
}

/** Codex `Environment`. T7 (tool runtime) wires; today optional placeholder. */
export interface Environment {
  readonly cwd: string;
  // T7 adds: filesystem handle, network proxy ref, sandbox policy ref, etc.
}

/** Codex `CollaborationMode`. T11 (modes + slash commands) lands real impl. */
export interface CollaborationMode {
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly developerInstructions?: string;
}

/** Codex `Personality`. T10 (config) lands real impl. */
export type Personality = string;

/** Codex `Constrained<T>` value carrier with current + allowed-set. */
export interface Constrained<T> {
  readonly value: T;
  readonly allowed?: ReadonlyArray<T>;
}

/** Codex `AskForApproval` enum. T11 (permissions) lands real values. */
export type ApprovalPolicy =
  | "never"
  | "on_failure"
  | "on_request"
  | "granular"
  | "untrusted";

/** Codex `SandboxPolicy` enum. T11 lands real shape. */
export type SandboxPolicy =
  | "danger_full_access"
  | "read_only"
  | "workspace_write"
  | "external_sandbox";

/** Codex `FileSystemSandboxPolicy`. T11 lands real shape. */
export interface FileSystemSandboxPolicy {
  readonly allowWrite: ReadonlyArray<string>;
  readonly denyWrite: ReadonlyArray<string>;
  readonly allowRead: ReadonlyArray<string>;
  readonly denyRead: ReadonlyArray<string>;
}

/** Codex `NetworkSandboxPolicy`. T11 lands real shape. */
export interface NetworkSandboxPolicy {
  readonly allowlist: ReadonlyArray<string>;
  readonly denylist: ReadonlyArray<string>;
  readonly allowManagedDomainsOnly: boolean;
}

/** Codex `NetworkProxy`. T13 (transport) lands real impl. */
export interface NetworkProxy {
  readonly httpsProxy?: string;
}

/** Codex `WindowsSandboxLevel`. T11 lands real impl. */
export type WindowsSandboxLevel = "none" | "permissive" | "strict";

/** Codex `ShellEnvironmentPolicy`. T11 lands real impl. */
export interface ShellEnvironmentPolicy {
  readonly allowedEnvVars: ReadonlyArray<string>;
  readonly blockedEnvVars: ReadonlyArray<string>;
}

/** Codex `ToolsConfig`. T7 (tool registry + concurrency) lands real impl. */
export interface ToolsConfig {
  readonly webSearchMode?: "auto" | "always" | "never";
  readonly webSearchConfig?: unknown;
  readonly allowLoginShell: boolean;
  readonly hasEnvironment: boolean;
  readonly unifiedExecShellMode?: unknown;
}

/** Codex `ManagedFeatures`. T10 (config feature flags). */
export interface ManagedFeatures {
  /** Returns whether `apps_enabled_for_auth(is_chatgpt_auth)` is true. */
  readonly appsEnabledForAuth: (isChatgptAuth: boolean) => boolean;
  /** Returns whether to use the legacy Landlock path. */
  readonly useLegacyLandlock: () => boolean;
}

/** Codex `GhostSnapshotConfig`. Defer to a later tranche. */
export interface GhostSnapshotConfig {
  readonly enabled: boolean;
}

/** Codex `ReadinessFlag`. Lightweight one-shot ready-flag (used as
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

/** Codex `JsReplHandle`. T9 (subagents) wires; today opaque handle. */
export interface JsReplHandle {
  readonly id: string;
}

/** Codex `DynamicToolSpec`. T7 wires. */
export interface DynamicToolSpec {
  readonly name: string;
  readonly description: string;
}

/** Codex `TurnMetadataState`. T6 (event log) wires. */
export interface TurnMetadataState {
  readonly conversationId: string;
  readonly subId: string;
  readonly cwd: string;
  spawnGitEnrichmentTask(): void;
}

/** Codex `TurnSkillsContext`. T10 (memory + skills) wires. */
export interface SkillLoadOutcome {
  readonly invokedSkills: ReadonlyArray<string>;
}
export class TurnSkillsContext {
  readonly outcome: SkillLoadOutcome;
  readonly implicitInvocationSeenSkills = new Set<string>();
  constructor(outcome: SkillLoadOutcome) {
    this.outcome = outcome;
  }
}

/** Codex `TurnTimingState`. T6 wires. */
export class TurnTimingState {
  readonly startedAtMs: number = performance.now();
  readonly samples: Array<{ phase: string; durationMs: number }> = [];
}

/** Codex `SessionConfiguration` (the big config blob). T10 lands real shape. */
export interface SessionConfiguration {
  readonly cwd: string;
  readonly approvalPolicy: Constrained<ApprovalPolicy>;
  readonly sandboxPolicy: Constrained<SandboxPolicy>;
  readonly fileSystemSandboxPolicy: FileSystemSandboxPolicy;
  readonly networkSandboxPolicy: NetworkSandboxPolicy;
  readonly windowsSandboxLevel: WindowsSandboxLevel;
  readonly collaborationMode: CollaborationMode;
  readonly personality?: Personality;
  readonly modelReasoningSummary?: ReasoningSummary;
  readonly serviceTier?: string;
  readonly approvalsReviewer?: string;
  readonly developerInstructions?: string;
  readonly userInstructions?: string;
  readonly compactPrompt?: string;
  readonly appServerClientName?: string;
  readonly dynamicTools: ReadonlyArray<DynamicToolSpec>;
  readonly sessionSource: SessionSource;

  // ─── codex `SessionConfiguration` fields not yet bound to a real AgenC
  // subsystem. Kept optional/unknown until the naming tranche lands; the
  // shape tracks codex parity so `apply`, builder inputs, and cross-turn
  // state propagation already line up.

  /** Active `LLMProvider` for the session (codex `provider: SharedModelProvider`). */
  readonly provider?: LLMProvider;
  /** Codex `base_instructions` — baseline system prompt for the session. */
  readonly baseInstructions?: string;
  /** Codex `codex_home` — directory containing agent state for the session. */
  readonly codexHome?: string;
  /** Codex `thread_name` — optional user-facing thread label. */
  readonly threadName?: string;
  /**
   * Codex `original_config_do_not_use` — raw config snapshot used to derive
   * per-turn config. T10 replaces with the real typed config once the config
   * surface lands.
   */
  readonly originalConfigDoNotUse?: unknown;
  /** Codex `metrics_service_name` — optional service name tag for metrics. */
  readonly metricsServiceName?: string;
  /** Codex `app_server_client_version`. Pairs with `appServerClientName`. */
  readonly appServerClientVersion?: string;
  /** Codex `persist_extended_history` — when true, record extended rollout events. */
  readonly persistExtendedHistory?: boolean;
  /**
   * Codex `inherited_shell_snapshot` — opaque shell-snapshot handle inherited
   * by this session. T11 (permissions + shell snapshot) wires the real type.
   */
  readonly inheritedShellSnapshot?: unknown;
  /**
   * Codex `user_shell_override` — operator override for the detected user
   * shell. T11 (shell discovery) wires the real `Shell` type.
   */
  readonly userShellOverride?: unknown;
}

/**
 * Codex `SessionSettingsUpdate` — partial overlay applied via
 * `applySessionConfiguration` when a turn mutates session state.
 *
 * Mirrors codex `SessionSettingsUpdate`: every field is optional, and a
 * missing field means "keep the previous value". `finalOutputJsonSchema`
 * uses a double-option shape in codex (`Option<Option<Value>>`); we model
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
  readonly reasoningSummary?: ReasoningSummary;
  readonly serviceTier?: string;
  readonly personality?: Personality;
  readonly appServerClientName?: string;
  readonly appServerClientVersion?: string;
  /**
   * Codex-style double-option marker. `undefined` means "leave untouched";
   * `{ value: undefined }` means "explicitly clear"; `{ value: schema }`
   * means "set to schema".
   */
  readonly finalOutputJsonSchema?: { readonly value: unknown | undefined };
}

/** Codex `SessionSource`. */
export type SessionSource =
  | "cli_main"
  | "cli_subagent"
  | "sdk"
  | "ide"
  | { kind: "unknown"; raw: string };

/** Codex `Config`. The original config blob (large). T10 lands real shape. */
export interface Config {
  readonly model: string;
  readonly modelReasoningEffort?: ReasoningEffort;
  readonly modelReasoningSummary?: ReasoningSummary;
  readonly cwd: string;
  readonly features: ManagedFeatures;
  readonly multiAgentV2: {
    readonly usageHintEnabled: boolean;
    readonly usageHintText: string;
    readonly hideSpawnAgentMetadata: boolean;
  };
  readonly permissions: {
    readonly allowLoginShell: boolean;
    readonly shellEnvironmentPolicy: ShellEnvironmentPolicy;
    readonly windowsSandboxPrivateDesktop: boolean;
  };
  readonly ghostSnapshot: GhostSnapshotConfig;
  readonly codexSelfExe?: string;
  readonly codexLinuxSandboxExe?: string;
  readonly agentRoles: ReadonlyArray<{ name: string; description: string }>;
  // T10 expands further.
}

/** Codex `TurnContextItem` — the rollout-stamped shape (T6). */
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
  readonly personality?: Personality;
  readonly collaborationMode?: CollaborationMode;
  readonly realtimeActive?: boolean;
  readonly effort?: ReasoningEffort;
  readonly summary?: ReasoningSummary;
  readonly userInstructions?: string;
  readonly developerInstructions?: string;
  readonly finalOutputJsonSchema?: unknown;
  readonly truncationPolicy?: TruncationPolicy;
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
 * Faithful port of codex `TurnContext` struct (turn_context.rs:29-74).
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

  /** Telemetry sink for this session. */
  readonly sessionTelemetry: SessionTelemetry;

  /** The active provider for this turn (multi-provider per provider-matrix.md). */
  readonly provider: LLMProvider;

  /** Reasoning effort selection (o-series + Grok). */
  readonly reasoningEffort?: ReasoningEffort;

  /** Reasoning summary mode. */
  readonly reasoningSummary: ReasoningSummary;

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

  /** Developer instructions (separate from user instructions). */
  readonly developerInstructions?: string;

  /** Custom compaction prompt; falls back to library default. */
  readonly compactPrompt?: string;

  /** User instructions block (AGENTS.md ancestor walk + @include). T10 wires. */
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

  /** Optional managed-network proxy. T13 wires. */
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

  /** Path to the codex/agenc self exe (for spawning child processes). */
  readonly codexSelfExe?: string;

  /** Linux sandbox helper exe path. */
  readonly codexLinuxSandboxExe?: string;

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
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (matching codex `impl TurnContext` methods).
// ─────────────────────────────────────────────────────────────────────

/**
 * Effective context window: model's context window × `effectiveContextWindowPercent` / 100.
 * Mirrors codex `TurnContext::model_context_window`.
 */
export function modelContextWindow(ctx: TurnContext): number | undefined {
  const cw = ctx.modelInfo.contextWindow;
  if (cw === undefined) return undefined;
  return Math.floor((cw * ctx.modelInfo.effectiveContextWindowPercent) / 100);
}

/**
 * Resolve a relative path against the turn's `cwd`.
 * Mirrors codex `TurnContext::resolve_path`.
 */
export function resolvePath(ctx: TurnContext, path?: string): string {
  if (!path) return ctx.cwd;
  if (path.startsWith("/")) return path;
  return `${ctx.cwd}/${path}`.replace(/\/{2,}/g, "/");
}

/**
 * Snapshot the current TurnContext into a serializable rollout item.
 * Mirrors codex `TurnContext::to_turn_context_item`.
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
    personality: ctx.personality,
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
 * Codex gates several features on `AuthMode::Chatgpt` specifically,
 * not on "any OAuth session". Non-ChatGPT OAuth providers (e.g. xAI,
 * OpenRouter) should NOT enable ChatGPT-only tool surfaces.
 */
export function isChatgptAuth(authManager?: AuthManager): boolean {
  return (
    authManager?.mode === "oauth" && authManager.authProvider === "chatgpt"
  );
}

/**
 * Whether the image-generation tool may be used (codex parity with
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
 * Falls back to UTC on tz lookup failure (mirrors codex `local_time_context`).
 */
export function localTimeContext(): {
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
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value as Readonly<T>;
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
// SessionConfiguration helpers (codex `impl SessionConfiguration` parity).
// ─────────────────────────────────────────────────────────────────────

/** Mirror of codex `SessionConfiguration::codex_home` — thin accessor. */
export function codexHome(sc: SessionConfiguration): string | undefined {
  return sc.codexHome;
}

/**
 * Shallow snapshot of the thread-shaping fields of `SessionConfiguration`.
 * Mirrors codex `SessionConfiguration::thread_config_snapshot`. Returns a
 * fresh object so mutations by the caller cannot leak back into the live
 * session configuration.
 */
export interface ThreadConfigSnapshot {
  readonly model: string;
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
 * Mirrors codex `SessionConfiguration::apply`. Notable parity:
 *
 *   - Legacy-FS-policy preservation on cwd-only updates. If only `cwd`
 *     changes and the current `fileSystemSandboxPolicy` matches the
 *     default derived from the legacy `sandboxPolicy`, re-derive from
 *     the new cwd; otherwise preserve the existing richer policy.
 *   - Sandbox-policy changes invalidate the derived split policy, so
 *     callers should rebuild it downstream (parity with codex's
 *     `from_legacy_sandbox_policy_preserving_deny_entries` path; here we
 *     simply do not overwrite it — the full rebuild lands with T11).
 */
export function applySessionConfiguration(
  current: SessionConfiguration,
  updates: SessionSettingsUpdate,
): SessionConfiguration {
  const next: Mutable<SessionConfiguration> = { ...current };

  if (updates.collaborationMode !== undefined) {
    next.collaborationMode = updates.collaborationMode;
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

  // codex parity (session.rs ~160-176):
  //   - sandbox policy changed -> we do NOT rederive here (the full
  //     FileSystemSandboxPolicy rebuild with deny-entry preservation is
  //     T11's job). We still keep the previous richer policy so it isn't
  //     silently dropped.
  //   - cwd-only change AND the current split policy is just the legacy
  //     projection -> rederive nothing here (we lack the `from_legacy`
  //     helper pre-T11). We keep the existing policy; the cwd change
  //     alone does not invalidate the allow/deny lists.
  //   - in both branches: never overwrite `fileSystemSandboxPolicy` just
  //     because cwd moved. This matches the stated audit requirement:
  //     cwd-only update preserves `fileSystemSandboxPolicy`.
  void sandboxPolicyChanged;
  void cwdChanged;

  if (updates.appServerClientName !== undefined) {
    next.appServerClientName = updates.appServerClientName;
  }
  if (updates.appServerClientVersion !== undefined) {
    next.appServerClientVersion = updates.appServerClientVersion;
  }

  return next;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ─────────────────────────────────────────────────────────────────────
// TurnContext builder (codex `Session::make_turn_context` parity).
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
}

/**
 * Build a fresh TurnContext for a new turn.
 * Mirrors codex `Session::make_turn_context` (turn_context.rs:335-447).
 */
export function buildTurnContext(opts: BuildTurnContextOptions): TurnContext {
  const sc = opts.sessionConfiguration;
  const reasoningEffort = sc.collaborationMode.reasoningEffort;
  const reasoningSummary =
    sc.modelReasoningSummary ?? opts.modelInfo.defaultReasoningSummary;
  const { currentDate, timezone } = opts.clock ?? localTimeContext();

  const skillsOutcome: SkillLoadOutcome =
    opts.skillsOutcome ?? { invokedSkills: [] };

  const turnMetadataState: TurnMetadataState = {
    conversationId: opts.conversationId,
    subId: opts.subId,
    cwd: sc.cwd,
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
    sessionTelemetry: { modelSlug: opts.modelInfo.slug },
    provider: opts.provider,
    reasoningEffort,
    reasoningSummary,
    sessionSource: sc.sessionSource,
    environment: opts.environment,
    cwd: sc.cwd,
    currentDate,
    timezone,
    appServerClientName: sc.appServerClientName,
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
    codexSelfExe: frozenConfig.codexSelfExe,
    codexLinuxSandboxExe: frozenConfig.codexLinuxSandboxExe,
    toolCallGate: new ReadinessFlag(),
    truncationPolicy: opts.modelInfo.truncationPolicy,
    jsRepl: opts.jsRepl ?? { id: `repl-${opts.conversationId}-${opts.subId}` },
    dynamicTools: sc.dynamicTools,
    turnMetadataState,
    turnSkills: new TurnSkillsContext(skillsOutcome),
    turnTimingState: new TurnTimingState(),
    depth: opts.depth ?? 0,
  };
}

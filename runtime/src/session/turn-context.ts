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

/** Codex `AuthManager`. T13 wires real OAuth refresh; today stubbed. */
export interface AuthManager {
  readonly mode: "bearer_key" | "oauth" | "local_no_auth";
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
 * Whether the image-generation tool may be used (codex parity:
 * only true when ChatGPT-auth is the active mode).
 */
export function imageGenerationToolAuthAllowed(
  authManager?: AuthManager,
): boolean {
  return authManager?.mode === "oauth";
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

  // I-30: freeze config for the lifetime of this TurnContext.
  const frozenConfig: Readonly<Config> = Object.freeze({ ...opts.config });

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
    shellEnvironmentPolicy: opts.config.permissions.shellEnvironmentPolicy,
    toolsConfig: {
      allowLoginShell: opts.config.permissions.allowLoginShell,
      hasEnvironment: opts.environment !== undefined,
    },
    features: opts.config.features,
    ghostSnapshot: opts.config.ghostSnapshot,
    finalOutputJsonSchema: undefined,
    codexSelfExe: opts.config.codexSelfExe,
    codexLinuxSandboxExe: opts.config.codexLinuxSandboxExe,
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

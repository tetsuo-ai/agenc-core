// T10 Group D — AgenC config schema.
//
// Merges AgenC config surfaces, profile selection, and runtime additions
// such as tool budgets, stream watchdog settings, and agenc_home.
//
// All public types are readonly. `defaultConfig()` returns a frozen snapshot;
// `mergeConfigs()` is a right-biased deep merge that preserves immutability
// of the inputs and returns a fresh frozen result.
//
// Unknown keys are preserved on a `_unknown` side table (I-26 forward-compat).

// ─────────────────────────────────────────────────────────────────────
// Core enums / unions
// ─────────────────────────────────────────────────────────────────────

export type ApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

export type PermissionDefaultMode = ApprovalPolicy;

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type SandboxConfigMode =
  | "off"
  | "read-only"
  | "workspace-write";

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

export type Personality = "none" | "friendly" | "pragmatic";

export type WebSearchMode = "auto" | "always" | "never";

export type ModelVerbosity = "low" | "medium" | "high";

export type ServiceTier = "fast" | "flex";

export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

export type EditorMode = "default" | "vim";

/**
 * Permission mode variants accepted by config files. This intentionally
 * excludes the background-agent-only `unattended` runtime mode from
 * `src/permissions/types.ts` so users cannot make it a global default.
 * Kept inline here to avoid a `config → permissions → config` import
 * cycle (permissions settings.ts already depends on `config/schema.ts`).
 *
 * If a user-addressable variant is ever added or removed in
 * `src/permissions/types.ts`, update this union in lockstep.
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk"
  | "auto"
  | "bubble";

const PERMISSION_MODE_VALUES: readonly PermissionMode[] = Object.freeze([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
  "bubble",
] as const);

// ─────────────────────────────────────────────────────────────────────
// Sub-config shapes
// ─────────────────────────────────────────────────────────────────────

export interface SandboxPolicy {
  readonly mode: SandboxMode;
  readonly network_access?: boolean;
  readonly writable_roots?: readonly string[];
}

export interface SandboxConfig {
  readonly mode?: SandboxConfigMode;
}

export interface ShellEnvironmentPolicy {
  readonly inherit?: "all" | "core" | "none";
  readonly ignore_default_excludes?: boolean;
  readonly exclude?: readonly string[];
  readonly set?: Readonly<Record<string, string>>;
  readonly include_only?: readonly string[];
}

export interface ToolsConfig {
  readonly web_search?: boolean | PerToolConfig;
  /**
   * Search backend for the WebSearch tool on providers without native
   * web search. `AGENC_WEB_SEARCH_ENDPOINT` env wins over this value.
   */
  readonly web_search_endpoint?: string;
  /**
   * Response format of `web_search_endpoint`:
   * duckduckgo (instant-answer JSON, default) | searxng | brave | json.
   * `AGENC_WEB_SEARCH_KIND` env wins. Brave API keys come from
   * `AGENC_WEB_SEARCH_API_KEY` (secrets never live in config.toml).
   */
  readonly web_search_endpoint_kind?: "duckduckgo" | "searxng" | "brave" | "json";
  readonly view_image?: boolean | PerToolConfig;
  readonly enabled_tools?: readonly string[];
  readonly disabled_tools?: readonly string[];
  readonly [k: string]: unknown;
}

export interface PerToolConfig {
  readonly enabled?: boolean;
  readonly default_permission_mode?: PermissionDefaultMode;
  readonly defaultPermissionMode?: PermissionDefaultMode;
  /**
   * Compatibility with plugin manifests that call this approval_mode.
   * `auto` means "use the session policy".
   */
  readonly approval_mode?: "auto" | "prompt" | "approve";
}

export interface ProfileOverride {
  readonly model?: string;
  readonly model_provider?: string;
  readonly approval_policy?: ApprovalPolicy;
  readonly sandbox_mode?: SandboxMode;
  readonly reasoning_effort?: ReasoningEffort;
  readonly reasoning_summary?: ReasoningSummary;
  readonly approvals_reviewer?: ApprovalsReviewer;
  readonly model_verbosity?: ModelVerbosity;
  readonly service_tier?: ServiceTier;
  readonly personality?: Personality;
  readonly web_search?: WebSearchMode | boolean;
  readonly tools?: ToolsConfig;
}

export interface ToolBudget {
  // From T10 #11
  readonly max_calls_per_turn?: number;
  readonly max_bytes_per_call?: number;
  readonly max_bytes_per_turn?: number;
  readonly reserved_tokens?: number;
}

export interface AgentBudgetConfig {
  readonly token_cap?: number;
  readonly dollar_cap?: number;
  readonly wall_clock_seconds?: number;
}

export interface AgentRunRetentionConfig {
  readonly completed_days?: number;
  readonly failed_days?: number;
  readonly snapshot_days?: number;
  readonly snapshot_max_count?: number;
  readonly snapshot_max_bytes?: number;
  // Rollout/session disk retention window (days). Lights up the reserved
  // `cleanupPeriodDays`/`history` retention intent: when set, the daemon's
  // throttled sweep deletes session dirs + their rollout JSONL + the
  // thread_rollout_items mirror rows once their newest rollout is older than
  // this many days. Unset → DISABLED (no pruning; the conservative default,
  // since this deletes user data).
  readonly rollout_days?: number;
}

export interface AgentConfig {
  readonly budget?: AgentBudgetConfig;
  readonly retention?: AgentRunRetentionConfig;
}

/**
 * GOAL #4b Stage 1 — durable / checkpointed turns.
 *
 * Conservative defaults: the checkpoint WRITE is cheap and on; the
 * behavior-changing RESUME is gated to the safe-by-default policy.
 * `resume.policy` is NEVER `"idempotent"` in Stage 1 — auto-replay of
 * side-effecting tools (Stage 2, gated on the ACRFence effect log) must not
 * ship before its anti-rollback guard does.
 */
export interface DurableTurnsCheckpointConfig {
  /** Emit fsync-durable `turn_checkpoint` at CB-Iteration / CB-PostAssistant. */
  readonly enabled?: boolean;
  /** Optional throttle for very fast iterations (0 = every boundary). */
  readonly minIntervalMs?: number;
}

export interface DurableTurnsResumeConfig {
  /** Attempt resume-continuation on restart vs today's abort+restart. */
  readonly onRestart?: boolean;
  /**
   * "safe" = re-run only read-only/idempotent dangling tools; HALT on any
   * ambiguous side-effecting/interactive step. Stage 1 supports only "safe".
   */
  readonly policy?: "safe";
  /** Single-writer resume lease (per-turnId flock). */
  readonly requireLease?: boolean;
  /** Refuse cross-build resume (determinism guard via `turn_started.buildId`). */
  readonly buildPinning?: boolean;
}

export interface DurableTurnsConfig {
  readonly checkpoint?: DurableTurnsCheckpointConfig;
  readonly resume?: DurableTurnsResumeConfig;
}

export interface HookCommand {
  readonly type: "command";
  readonly command: string;
  readonly timeout_ms?: number;
  readonly enabled?: boolean;
  readonly statusMessage?: string;
}

export interface HookMatcher {
  readonly matcher?: string;
  readonly enabled?: boolean;
  readonly hooks: readonly HookCommand[];
}

export type HooksMap = Readonly<Record<string, readonly HookMatcher[]>>;

export const HOOK_EVENT_NAMES = Object.freeze([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "UserPromptSubmit",
  "SessionStart",
  "SubagentStop",
  "SessionEnd",
  "Notification",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
] as const);

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export interface ExperimentsConfig {
  readonly [k: string]: boolean | string | number;
}

export interface IdeConnectorConfig {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly [k: string]: unknown;
}

export interface PrivateStorageConfig {
  readonly path?: string;
  readonly [k: string]: unknown;
}

export interface ManagedWorkspacesConfig {
  readonly paths?: readonly string[];
  readonly [k: string]: unknown;
}

export type McpTransport = "stdio" | "sse" | "http" | "websocket" | "ws";

export interface PluginMcpSandboxMetadata {
  readonly mode: "stdio-child-process";
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly serverName: string;
  readonly scopedServerName: string;
}

export interface McpServerConfig {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly env_vars?: readonly string[];
  readonly cwd?: string;
  readonly transport?: McpTransport;
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
  readonly timeout?: number;
  readonly required?: boolean;
  readonly default_tools_approval_mode?: PermissionDefaultMode;
  readonly enabled_tools?: readonly string[];
  readonly disabled_tools?: readonly string[];
  readonly tools?: Readonly<Record<string, PerToolConfig>>;
  readonly pluginSandbox?: PluginMcpSandboxMetadata;
}

export type McpServerModeTransport = "stdio" | "sse";

export interface McpServerModeConfig {
  readonly enabled?: boolean;
  readonly transport?: McpServerModeTransport;
  readonly port?: number;
  readonly host?: string;
}

export interface McpConfig {
  readonly server?: McpServerModeConfig;
}

export type DaemonTransport = "unix" | "stdio";

export interface DaemonConfig {
  readonly transport?: DaemonTransport;
  readonly autostart?: boolean;
}

/**
 * T12 Wave 4-B: status line configuration.
 *
 * Lets operators choose which items the TUI cockpit status line shows
 * and in what order (model slug, permission mode, cwd basename, git
 * branch, etc.). The TUI renderer consumes this through
 * `src/tui/cockpit/StatusLineConfig.tsx`; item keys are validated
 * defensively at render time, so a misspelled key just omits that
 * segment instead of crashing the cockpit.
 */
export interface PartialStatusLineConfig {
  readonly items?: readonly string[];
}

/**
 * T12 Wave 4-B: output style configuration.
 *
 * Thin field reserved for cockpit palette selection (`"dark"`, `"light"`,
 * etc.). Kept deliberately open-ended so later waves can light up
 * additional theme names without another schema round-trip.
 */
export interface PartialOutputStyleConfig {
  readonly theme?: string;
}

/**
 * Prompt attachment configuration for interactive `@file` mentions.
 *
 * By default, mentions may only resolve inside the current workspace.
 * `allowedRoots` explicitly permits additional read roots for teams that keep
 * shared specs or generated artifacts outside the repo checkout.
 */
export interface AttachmentsConfig {
  readonly allowedRoots?: readonly string[];
}

export interface TuiLayoutConfig {
  readonly mode?: "single" | "multi-pane";
  readonly sidePane?: "status" | "context" | "none";
  readonly minColumns?: number;
}

export interface TuiConfig {
  readonly vimMode?: boolean;
}

/**
 * Permissions block as it appears in `~/.agenc/config.toml` (or any
 * settings.json the loader folds in). Mirrors the subset of
 * `SettingsPermissionsBlock` in `src/permissions/settings.ts` that is
 * surfaced through the top-level AgenC config.
 *
 * Rule arrays (`allow` / `deny` / `ask`) carry rule strings in the
 * `Tool(filter)` or bare `Tool` form parsed by
 * `src/permissions/rules.ts::parseRuleString`. `default_mode` is the PE-04
 * scaffold for AgenC's permission approval default and accepts the
 * config-file `ApprovalPolicy` literals. `defaultMode` keeps the
 * upstream-style permission mode surface used by settings files.
 *
 * Precedence (top-down, highest wins) for the runtime permission
 * context — implemented progressively across T11:
 *   1. Flag / CLI override
 *   2. Active profile's `permissions` (see `profiles.ts`)
 *   3. Top-level `permissions` (this field)
 *   4. Built-in defaults
 *
 * The 5-source on-disk rule ingestion (user / project / local / flag /
 * policy settings files) is handled by
 * `src/permissions/settings.ts::loadAllPermissionRulesFromDisk`. Those
 * settings files are the primary source of rule strings; a
 * ConfigStore-backed `permissions` block acts as a session-transient
 * overlay or a TOML-side mirror of the same shape.
 *
 * Follow-up T11-closeout: reconcile ConfigStore.permissions vs settings-file
 * permissions precedence (evaluator currently prefers settings-file
 * sources; top-level config block is reserved for overlays).
 */
export interface PermissionsConfig {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly additionalDirectories?: readonly string[];
  readonly default_mode?: PermissionDefaultMode;
  readonly defaultMode?: PermissionMode;
}

export interface ProviderCapabilityOverrides {
  readonly supportsToolUse?: boolean;
  readonly supportsPromptCaching?: boolean;
  readonly supportsContextEdits?: boolean;
  readonly supportsImageInput?: boolean;
  readonly supportsAudioInput?: boolean;
  readonly supportsAudioOutput?: boolean;
  readonly supportsProviderNativeWebSearch?: boolean;
  readonly supportsExtendedThinking?: boolean;
  readonly acceptsImageHistory?: boolean;
  readonly acceptsAudioHistory?: boolean;
  readonly acceptsThinkingHistory?: boolean;
  readonly acceptsReasoningEffort?: boolean;
}

export interface ProviderFallbackTargetConfig {
  readonly provider?: string;
  readonly model: string;
  readonly reason?: string;
}

export interface ProviderFallbackConfig {
  readonly targets?: readonly ProviderFallbackTargetConfig[];
  readonly models?: readonly string[];
  readonly max_failures?: number;
  readonly statuses?: readonly number[];
}

export interface ProviderConfig {
  readonly api_key_env?: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly context_window_tokens?: number;
  readonly max_output_tokens?: number;
  readonly capability_overrides?: ProviderCapabilityOverrides;
  readonly fallback_models?: readonly string[];
  readonly fallback?: ProviderFallbackConfig;
}

export type AuthBackendConfigKind = "local" | "remote";

export interface AuthManagedKeysConfig {
  readonly enabled?: boolean;
}

export interface AuthConfig {
  readonly backend?: AuthBackendConfigKind;
  readonly managedKeys?: AuthManagedKeysConfig;
}

export interface LspServerConfigInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly workspaceFolder?: string;
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  readonly initializationOptions?: unknown;
  readonly startupTimeout?: number;
  readonly maxRestarts?: number;
}

export interface PluginEntryConfig {
  readonly enabled?: boolean;
  readonly path?: string;
  readonly source?: string;
  readonly version?: string;
  readonly required?: boolean;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly mcp_servers?: Readonly<Record<string, PluginMcpServerConfig>>;
}

export interface PluginMcpServerConfig {
  readonly enabled?: boolean;
  readonly default_tools_approval_mode?: PermissionDefaultMode;
  readonly enabled_tools?: readonly string[];
  readonly disabled_tools?: readonly string[];
  readonly tools?: Readonly<Record<string, PerToolConfig>>;
}

export interface PluginsConfig {
  readonly dirs?: readonly string[];
  readonly enabled?: boolean;
  readonly allowlist?: readonly string[];
  readonly plugins?: Readonly<Record<string, boolean | PluginEntryConfig>>;
}

// ─────────────────────────────────────────────────────────────────────
// Canonical AgenCConfig
// ─────────────────────────────────────────────────────────────────────

export interface AgenCConfig {
  // ── Runtime fields ─────────────────────────────────────────────────
  readonly configVersion?: number;
  readonly model?: string;
  readonly model_provider?: string;
  readonly approval_policy?: ApprovalPolicy;
  readonly sandbox_mode?: SandboxMode;
  readonly sandbox?: SandboxConfig;
  readonly sandbox_policy?: SandboxPolicy;
  readonly shell_environment_policy?: ShellEnvironmentPolicy;
  readonly reasoning_effort?: ReasoningEffort;
  readonly reasoning_summary?: ReasoningSummary;
  readonly review_model?: string;
  readonly approvals_reviewer?: ApprovalsReviewer;
  readonly model_verbosity?: ModelVerbosity;
  readonly service_tier?: ServiceTier;
  readonly personality?: Personality;
  readonly agent_max_threads?: number;
  readonly agent_max_depth?: number;
  readonly auth?: AuthConfig;
  readonly profiles?: Readonly<Record<string, ProfileOverride>>;
  readonly providers?: Readonly<Record<string, ProviderConfig>>;
  readonly project_root_markers?: readonly string[];
  readonly project_doc_max_bytes?: number;
  readonly tools_config?: ToolsConfig;
  readonly compact_prompt?: string;
  readonly experimental_realtime_start_instructions?: string;
  readonly experimental_realtime_ws_backend_prompt?: string;
  readonly hooks?: HooksMap;
  readonly mcp?: McpConfig;
  readonly mcp_servers?: Readonly<Record<string, McpServerConfig>>;
  readonly daemon?: DaemonConfig;
  readonly lsp_servers?: Readonly<Record<string, LspServerConfigInput>>;
  readonly plugins?: PluginsConfig;

  // ── Settings fields ────────────────────────────────────────────────
  readonly autoUpdates?: boolean;
  readonly remoteControlAtStartup?: boolean;
  readonly bypassPermissionsModeAcceptedIn?: readonly string[];
  readonly enabledPlugins?: Readonly<Record<string, boolean | PluginEntryConfig>>;
  readonly experiments?: ExperimentsConfig;
  readonly ideConnector?: IdeConnectorConfig;
  readonly managedWorkspaces?: ManagedWorkspacesConfig;
  readonly permissions?: PermissionsConfig;
  readonly privateStorage?: PrivateStorageConfig;
  readonly statusLine?: PartialStatusLineConfig;
  readonly outputStyle?: PartialOutputStyleConfig;
  readonly attachments?: AttachmentsConfig;
  readonly editorMode?: EditorMode;
  readonly tui?: TuiConfig;
  readonly tuiLayout?: TuiLayoutConfig;
  readonly autoFix?: unknown;

  // ── AgenC-specific additions ──────────────────────────────────────
  readonly agent?: AgentConfig;
  readonly durableTurns?: DurableTurnsConfig;
  readonly toolBudget?: ToolBudget;
  readonly stream_watchdog_timeout_ms?: number;
  readonly max_output_tokens?: number;
  readonly capped_default_max_output_tokens?: boolean;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly autonomous_mode?: boolean;
  readonly agenc_home?: string;
  readonly workspace?: string;
  readonly simpleMode?: boolean;

  // ── Forward-compat side-table ─────────────────────────────────────
  readonly _unknown?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────
// defaultConfig
// ─────────────────────────────────────────────────────────────────────

/*
 * DEFERRED_KEYS — in-file audit trail (T10 A+ Fix-β).
 *
 * Top-level keys accepted by AgenC config surfaces that
 * AgenC intentionally routes into `_unknown` today. They are NOT silent
 * drops: `normalizeRawConfig` preserves them verbatim so a future
 * tranche can light them up without losing operator intent already
 * stored on disk. Grep-anchor: "DEFERRED_KEYS".
 *
 * Runtime deferred:
 *   - notify           → T11 (hook-style post-turn notifications)
 *   - history          → T11 (rollout/history retention policy)
 *   - log_dir          → T11 (operator-overridable log root)
 *   - file_opener      → T11 (editor integration)
 *
 * Settings deferred:
 *   - env              → T11 (shell env injection policy)
 *   - apiKeyHelper     → T11 (external API-key resolver hook)
 *   - cleanupPeriodDays → T11 (rollout/history retention)
 *
 * Lit up by PK-01 (no longer deferred):
 *   - plugins          → see `PluginsConfig` above.
 *   - enabledPlugins   → see `PluginEntryConfig` above.
 *
 * Lit up by T11 (no longer deferred):
 *   - permissions      → see `PermissionsConfig` above.
 *
 * Lit up by T12 Wave 4-B (no longer deferred):
 *   - statusLine       → see `PartialStatusLineConfig` above.
 *   - outputStyle      → see `PartialOutputStyleConfig` above.
 *
 * Lit up by T13 closeout:
 *   - attachments      → see `AttachmentsConfig` above.
 *
 * Lit up by runtime/TUI upstream closeout:
 *   - editorMode       → see `EditorMode` above.
 *   - tui              → see `TuiConfig` above.
 *   - tuiLayout        → see `TuiLayoutConfig` above.
 *
 * Lit up by S-05:
 *   - autoFix          → see `services/autoFix/autoFixConfig.ts`.
 *
 * Lit up by S-07:
 *   - lsp_servers      → see `services/lsp/config.ts`.
 *
 * Lit up by CF-11:
 *   - mcp              → see `McpConfig` above.
 *
 * Adding one of these to the schema means: (a) add it to
 * `KNOWN_CONFIG_KEYS`, (b) add a typed field to `AgenCConfig`, (c)
 * extend the merge + env-override paths if it reaches the runtime,
 * (d) remove it from this block. Don't forget to drop the matching
 * `_unknown` test if the key is tested via `_unknown` today.
 */

export const DEFERRED_SETTINGS_KEYS: readonly string[] = Object.freeze([
  "env",
  "apiKeyHelper",
  "cleanupPeriodDays",
]);

// Known top-level keys — anything else goes into `_unknown` (I-26).
// See the deferred-key block above for keys intentionally absent from this
// array while their tranches catch up. Forward-compat: unknown keys land on
// `_unknown` rather than being dropped.
export const KNOWN_CONFIG_KEYS: readonly string[] = Object.freeze([
  "configVersion",
  "model",
  "model_provider",
  "approval_policy",
  "sandbox_mode",
  "sandbox",
  "sandbox_policy",
  "shell_environment_policy",
  "reasoning_effort",
  "reasoning_summary",
  "review_model",
  "approvals_reviewer",
  "model_verbosity",
  "service_tier",
  "personality",
  "agent_max_threads",
  "agent_max_depth",
  "auth",
  "profiles",
  "providers",
  "project_root_markers",
  "project_doc_max_bytes",
  "tools_config",
  "compact_prompt",
  "experimental_realtime_start_instructions",
  "experimental_realtime_ws_backend_prompt",
  "hooks",
  "mcp",
  "mcp_servers",
  "daemon",
  "lsp_servers",
  "plugins",
  "autoUpdates",
  "remoteControlAtStartup",
  "bypassPermissionsModeAcceptedIn",
  "enabledPlugins",
  "experiments",
  "ideConnector",
  "managedWorkspaces",
  "permissions",
  "privateStorage",
  "statusLine",
  "outputStyle",
  "attachments",
  "editorMode",
  "tui",
  "tuiLayout",
  "autoFix",
  "agent",
  "toolBudget",
  "stream_watchdog_timeout_ms",
  "max_output_tokens",
  "capped_default_max_output_tokens",
  "max_turns",
  "max_budget_usd",
  "autonomous_mode",
  "agenc_home",
  "workspace",
  "simpleMode",
  "_unknown",
]);

export function defaultConfig(): AgenCConfig {
  return Object.freeze({
    configVersion: 1,
    model: "grok-4.3",
    model_provider: "grok",
    approval_policy: "on-request" as ApprovalPolicy,
    sandbox_mode: "workspace-write" as SandboxMode,
    sandbox: Object.freeze({
      mode: "workspace-write",
    }) as SandboxConfig,
    reasoning_effort: "medium" as ReasoningEffort,
    approvals_reviewer: "user" as ApprovalsReviewer,
    agent_max_depth: 1,
    auth: Object.freeze({
      backend: "remote",
      managedKeys: Object.freeze({
        enabled: true,
      }) as AuthManagedKeysConfig,
    }) as AuthConfig,
    plugins: Object.freeze({
      enabled: false,
      allowlist: Object.freeze([]) as readonly string[],
    }) as PluginsConfig,
    mcp: Object.freeze({
      server: Object.freeze({
        enabled: false,
        transport: "stdio",
      }) as McpServerModeConfig,
    }) as McpConfig,
    daemon: Object.freeze({
      transport: "unix",
      autostart: true,
    }) as DaemonConfig,
    permissions: Object.freeze({
      default_mode: "on-request",
    }) as PermissionsConfig,
    project_root_markers: Object.freeze([
      ".git",
      "package.json",
      "Cargo.toml",
      "pyproject.toml",
    ]) as readonly string[],
    project_doc_max_bytes: 32_768,
    stream_watchdog_timeout_ms: 30_000,
    max_turns: 50,
    // NOTE: `autoUpdates` is intentionally NOT defaulted here. The effective
    // auto-update state is governed solely by the global config
    // (`GlobalConfig.autoUpdates`, default undefined = enabled-unless-disabled)
    // and surfaced by `getAutoUpdaterDisabledReason()` / `agenc doctor`. The
    // TOML `AgenCConfig.autoUpdates` field is not read by the auto-updater, so
    // injecting a concrete `false` default here only made `config get
    // autoUpdates` report a hardcoded `false` that contradicted doctor's
    // "enabled" — see runtime/src/utils/config.ts. Leaving it unset makes
    // `config get autoUpdates` report "not set: autoUpdates" when the user has
    // not explicitly configured it, consistent with the effective state.
    editorMode: "default" as EditorMode,
    tuiLayout: Object.freeze({
      mode: "single",
      sidePane: "status",
      minColumns: 120,
    }) as TuiLayoutConfig,
    agent: Object.freeze({
      // Default budget is intentionally empty: caps are designed for
      // explicit `agenc agent start` background agents, but the daemon
      // uses the same budget tracker for foreground TUI sessions. With
      // a 2,000,000 token_cap default, a single substantial interactive
      // turn (e.g. building a project skeleton with ~70 sample requests
      // at ~14k tokens each = ~1M cumulative) tripped the cap and
      // killed the turn. Users who want a cap can set it explicitly via
      // config.toml under [agent.budget].
      budget: Object.freeze({}) as AgentBudgetConfig,
      retention: Object.freeze({
        completed_days: 30,
        failed_days: 90,
        snapshot_days: 3,
        snapshot_max_count: 10_000,
        snapshot_max_bytes: 67_108_864,
      }) as AgentRunRetentionConfig,
    }) as AgentConfig,
    toolBudget: Object.freeze({
      max_calls_per_turn: 32,
      max_bytes_per_call: 256_000,
      max_bytes_per_turn: 2_000_000,
    }) as ToolBudget,
  } satisfies AgenCConfig);
}

// ─────────────────────────────────────────────────────────────────────
// mergeConfigs — right-biased deep merge (plain-object-only recursion)
// ─────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    // Plain objects only — reject Date, Map, Set, class instances, etc.
    (Object.getPrototypeOf(v) === Object.prototype ||
      Object.getPrototypeOf(v) === null)
  );
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    if (overrideVal === undefined) continue;
    const baseVal = out[key];
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      out[key] = deepMerge(baseVal, overrideVal);
    } else if (Array.isArray(overrideVal)) {
      // Arrays are replaced (right-biased), not concatenated.
      out[key] = [...overrideVal];
    } else {
      out[key] = overrideVal;
    }
  }
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Object.isFrozen(v)) return v;
  Object.freeze(v);
  if (Array.isArray(v)) {
    for (const item of v) deepFreeze(item);
  } else {
    for (const key of Object.keys(v as object)) {
      deepFreeze((v as Record<string, unknown>)[key]);
    }
  }
  return v;
}

export function mergeConfigs(
  base: AgenCConfig,
  override: Partial<AgenCConfig>,
): AgenCConfig {
  const merged = deepMerge(
    base as Record<string, unknown>,
    override as Record<string, unknown>,
  ) as AgenCConfig;
  return deepFreeze(merged);
}

// ─────────────────────────────────────────────────────────────────────
// AgenC TOML alias normalization
// ─────────────────────────────────────────────────────────────────────

// AgenC TOML accepts some field names that differ from canonical keys.
// This mapping lets users keep existing config.toml field names and have them
// work. Aliases are applied BEFORE `normalizeRawConfig` so renamed fields
// land on the `KNOWN_CONFIG_KEYS` fast path instead of `_unknown`.
const AGENC_TOP_LEVEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  tools: "tools_config",
  model_reasoning_effort: "reasoning_effort",
  model_reasoning_summary: "reasoning_summary",
});

/**
 * Remap accepted TOML aliases onto canonical AgenC keys.
 *
 * Rules:
 * - Top-level aliases from `AGENC_TOP_LEVEL_ALIASES` are renamed; if the
 *   canonical key is also present, the canonical key wins and the alias is
 *   dropped (forward-compat for mixed configs).
 * - `agents.max_threads` → `agent_max_threads`.
 * - `agents.max_depth` → `agent_max_depth`.
 *
 * The returned object is a shallow copy; nested values are passed through
 * by reference. Callers should not mutate `raw` after calling.
 */
export function normalizeAgenCKeyAliases(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [alias, canonical] of Object.entries(AGENC_TOP_LEVEL_ALIASES)) {
    if (alias in out) {
      if (!(canonical in out)) {
        out[canonical] = out[alias];
      }
      delete out[alias];
    }
  }
  // agents.max_threads → agent_max_threads
  // agents.max_depth → agent_max_depth
  const agents = out.agents;
  if (
    typeof agents === "object" &&
    agents !== null &&
    !Array.isArray(agents)
  ) {
    const agentsObj = agents as Record<string, unknown>;
    if ("max_threads" in agentsObj && !("agent_max_threads" in out)) {
      out.agent_max_threads = agentsObj.max_threads;
    }
    if ("max_depth" in agentsObj && !("agent_max_depth" in out)) {
      out.agent_max_depth = agentsObj.max_depth;
    }
    // Drop the `agents` table if thread/depth aliases were the only things
    // we care about;
    // otherwise leave it for _unknown preservation.
    const remaining = { ...agentsObj };
    delete remaining.max_threads;
    delete remaining.max_depth;
    if (Object.keys(remaining).length === 0) {
      delete out.agents;
    } else {
      out.agents = remaining;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Normalize raw object → AgenCConfig (unknown keys → _unknown)
// ─────────────────────────────────────────────────────────────────────

export function normalizeRawConfig(raw: Record<string, unknown>): AgenCConfig {
  const out: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (KNOWN_CONFIG_KEYS.includes(key)) {
      out[key] = raw[key];
    } else {
      unknown[key] = raw[key];
    }
  }
  if (Object.keys(unknown).length > 0) {
    out._unknown = unknown;
  }
  return deepFreeze(out as AgenCConfig);
}

// ─────────────────────────────────────────────────────────────────────
// Block-level schema validation
// ─────────────────────────────────────────────────────────────────────

class InvalidNamedConfigError extends Error {
  readonly field: string;

  constructor(blockName: string, errorName: string, field: string, detail: string) {
    const path = field.length > 0 ? `${blockName}.${field}` : blockName;
    super(`Invalid ${path}: ${detail}`);
    this.name = errorName;
    this.field = field;
  }
}

export class InvalidAuthConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("auth", "InvalidAuthConfigError", field, detail);
  }
}

export class InvalidProviderConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("providers", "InvalidProviderConfigError", field, detail);
  }
}

export class InvalidAgentConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("agent", "InvalidAgentConfigError", field, detail);
  }
}

export class InvalidPluginsConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("plugins", "InvalidPluginsConfigError", field, detail);
  }
}

export class InvalidMcpServerModeConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("mcp.server", "InvalidMcpServerModeConfigError", field, detail);
  }
}

export class InvalidMcpConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("mcp", "InvalidMcpConfigError", field, detail);
  }
}

type InvalidConfigFactory = (field: string, detail: string) => Error;

function fieldPath(parent: string, child: string): string {
  return parent.length > 0 ? `${parent}.${child}` : child;
}

function requirePlainObject(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw makeError(field, "expected plain object");
  }
  return value;
}

function rejectUnknownFields(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  makeError: InvalidConfigFactory,
  parent = "",
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw makeError(fieldPath(parent, key), "unknown field");
    }
  }
}

function optionalBoolean(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw makeError(field, "expected boolean");
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw makeError(field, "expected string");
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw makeError(field, "expected string[]");
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw makeError(field, `array element is not a string: ${typeof item}`);
    }
  }
  return Object.freeze([...(value as string[])]);
}

function optionalRecord(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  return deepFreeze({ ...requirePlainObject(value, field, makeError) });
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw makeError(field, "expected positive integer");
  }
  return value;
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw makeError(field, "expected non-negative integer");
  }
  return value;
}

function optionalNonNegativeNumber(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw makeError(field, "expected non-negative number");
  }
  return value;
}

function optionalHttpStatusArray(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw makeError(field, "expected HTTP status integer[]");
  }
  const out: number[] = [];
  for (const item of value) {
    if (
      typeof item !== "number" ||
      !Number.isInteger(item) ||
      item < 100 ||
      item > 599
    ) {
      throw makeError(field, `invalid HTTP status: ${String(item)}`);
    }
    out.push(item);
  }
  return Object.freeze(out);
}

const AUTH_KEYS: ReadonlySet<string> = new Set(["backend", "managedKeys"]);
const AUTH_MANAGED_KEYS: ReadonlySet<string> = new Set(["enabled"]);

export function validateAuthConfig(raw: unknown): AuthConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    "",
    (field, detail) => new InvalidAuthConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    AUTH_KEYS,
    (field, detail) => new InvalidAuthConfigError(field, detail),
  );
  const out: { -readonly [K in keyof AuthConfig]: AuthConfig[K] } = {};
  if (record.backend !== undefined) {
    if (record.backend !== "local" && record.backend !== "remote") {
      throw new InvalidAuthConfigError(
        "backend",
        "expected \"local\" or \"remote\"",
      );
    }
    out.backend = record.backend;
  }
  if (record.managedKeys !== undefined) {
    const managedKeys = requirePlainObject(
      record.managedKeys,
      "managedKeys",
      (field, detail) => new InvalidAuthConfigError(field, detail),
    );
    rejectUnknownFields(
      managedKeys,
      AUTH_MANAGED_KEYS,
      (field, detail) => new InvalidAuthConfigError(field, detail),
      "managedKeys",
    );
    const enabled = optionalBoolean(
      managedKeys.enabled,
      "managedKeys.enabled",
      (field, detail) => new InvalidAuthConfigError(field, detail),
    );
    out.managedKeys = Object.freeze({
      ...(enabled !== undefined ? { enabled } : {}),
    }) as AuthManagedKeysConfig;
  }
  return Object.freeze(out as AuthConfig);
}

const PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "api_key_env",
  "base_url",
  "default_model",
  "context_window_tokens",
  "max_output_tokens",
  "capability_overrides",
  "fallback_models",
  "fallback",
]);

const PROVIDER_CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  "supportsToolUse",
  "supportsPromptCaching",
  "supportsContextEdits",
  "supportsImageInput",
  "supportsAudioInput",
  "supportsAudioOutput",
  "supportsProviderNativeWebSearch",
  "supportsExtendedThinking",
  "acceptsImageHistory",
  "acceptsAudioHistory",
  "acceptsThinkingHistory",
  "acceptsReasoningEffort",
]);

const PROVIDER_FALLBACK_KEYS: ReadonlySet<string> = new Set([
  "targets",
  "models",
  "max_failures",
  "statuses",
]);

const PROVIDER_FALLBACK_TARGET_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "model",
  "reason",
]);

function validateProviderCapabilities(
  raw: unknown,
  parent: string,
): ProviderCapabilityOverrides | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    parent,
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    PROVIDER_CAPABILITY_KEYS,
    (field, detail) => new InvalidProviderConfigError(field, detail),
    parent,
  );
  const out: Record<string, boolean> = {};
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    const value = optionalBoolean(
      record[key],
      fieldPath(parent, key),
      (field, detail) => new InvalidProviderConfigError(field, detail),
    );
    if (value !== undefined) out[key] = value;
  }
  return Object.freeze(out) as ProviderCapabilityOverrides;
}

function validateProviderFallbackTarget(
  raw: unknown,
  field: string,
): ProviderFallbackTargetConfig {
  const record = requirePlainObject(
    raw,
    field,
    (path, detail) => new InvalidProviderConfigError(path, detail),
  );
  rejectUnknownFields(
    record,
    PROVIDER_FALLBACK_TARGET_KEYS,
    (path, detail) => new InvalidProviderConfigError(path, detail),
    field,
  );
  const model = optionalString(
    record.model,
    fieldPath(field, "model"),
    (path, detail) => new InvalidProviderConfigError(path, detail),
  );
  if (model === undefined || model.trim().length === 0) {
    throw new InvalidProviderConfigError(
      fieldPath(field, "model"),
      "expected non-empty string",
    );
  }
  const provider = optionalString(
    record.provider,
    fieldPath(field, "provider"),
    (path, detail) => new InvalidProviderConfigError(path, detail),
  );
  const reason = optionalString(
    record.reason,
    fieldPath(field, "reason"),
    (path, detail) => new InvalidProviderConfigError(path, detail),
  );
  return Object.freeze({
    ...(provider !== undefined ? { provider } : {}),
    model,
    ...(reason !== undefined ? { reason } : {}),
  }) as ProviderFallbackTargetConfig;
}

function validateProviderFallback(
  raw: unknown,
  parent: string,
): ProviderFallbackConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    parent,
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    PROVIDER_FALLBACK_KEYS,
    (field, detail) => new InvalidProviderConfigError(field, detail),
    parent,
  );
  const out: { -readonly [K in keyof ProviderFallbackConfig]: ProviderFallbackConfig[K] } = {};
  if (record.targets !== undefined) {
    if (!Array.isArray(record.targets)) {
      throw new InvalidProviderConfigError(
        fieldPath(parent, "targets"),
        "expected target array",
      );
    }
    out.targets = Object.freeze(
      record.targets.map((target, index) =>
        validateProviderFallbackTarget(
          target,
          `${fieldPath(parent, "targets")}.${index}`,
        ),
      ),
    );
  }
  const models = optionalStringArray(
    record.models,
    fieldPath(parent, "models"),
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  if (models !== undefined) out.models = models;
  const maxFailures = optionalPositiveInteger(
    record.max_failures,
    fieldPath(parent, "max_failures"),
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  if (maxFailures !== undefined) out.max_failures = maxFailures;
  const statuses = optionalHttpStatusArray(
    record.statuses,
    fieldPath(parent, "statuses"),
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  if (statuses !== undefined) out.statuses = statuses;
  return Object.freeze(out as ProviderFallbackConfig);
}

function validateSingleProviderConfig(raw: unknown, providerId: string): ProviderConfig {
  const record = requirePlainObject(
    raw,
    providerId,
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    PROVIDER_KEYS,
    (field, detail) => new InvalidProviderConfigError(field, detail),
    providerId,
  );
  const out: { -readonly [K in keyof ProviderConfig]: ProviderConfig[K] } = {};
  for (const key of ["api_key_env", "base_url", "default_model"] as const) {
    const value = optionalString(
      record[key],
      fieldPath(providerId, key),
      (field, detail) => new InvalidProviderConfigError(field, detail),
    );
    if (value !== undefined) out[key] = value;
  }
  const contextWindow = optionalPositiveInteger(
    record.context_window_tokens,
    fieldPath(providerId, "context_window_tokens"),
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  if (contextWindow !== undefined) out.context_window_tokens = contextWindow;
  const maxOutput = optionalPositiveInteger(
    record.max_output_tokens,
    fieldPath(providerId, "max_output_tokens"),
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  if (maxOutput !== undefined) out.max_output_tokens = maxOutput;
  const capabilities = validateProviderCapabilities(
    record.capability_overrides,
    fieldPath(providerId, "capability_overrides"),
  );
  if (capabilities !== undefined) out.capability_overrides = capabilities;
  const fallbackModels = optionalStringArray(
    record.fallback_models,
    fieldPath(providerId, "fallback_models"),
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  if (fallbackModels !== undefined) out.fallback_models = fallbackModels;
  const fallback = validateProviderFallback(
    record.fallback,
    fieldPath(providerId, "fallback"),
  );
  if (fallback !== undefined) out.fallback = fallback;
  return Object.freeze(out as ProviderConfig);
}

export function validateProviderConfig(
  raw: unknown,
): Readonly<Record<string, ProviderConfig>> | undefined {
  if (raw === undefined) return undefined;
  const providers = requirePlainObject(
    raw,
    "",
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  const out: Record<string, ProviderConfig> = {};
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (providerId.trim().length === 0) {
      throw new InvalidProviderConfigError(providerId, "provider id is empty");
    }
    out[providerId] = validateSingleProviderConfig(providerConfig, providerId);
  }
  return deepFreeze(out);
}

const AGENT_KEYS: ReadonlySet<string> = new Set(["budget", "retention"]);
const AGENT_BUDGET_KEYS: ReadonlySet<string> = new Set([
  "token_cap",
  "dollar_cap",
  "wall_clock_seconds",
]);
const AGENT_RETENTION_KEYS: ReadonlySet<string> = new Set([
  "completed_days",
  "failed_days",
  "snapshot_days",
  "snapshot_max_count",
  "snapshot_max_bytes",
  "rollout_days",
]);

function validateAgentBudget(raw: unknown): AgentBudgetConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    "budget",
    (field, detail) => new InvalidAgentConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    AGENT_BUDGET_KEYS,
    (field, detail) => new InvalidAgentConfigError(field, detail),
    "budget",
  );
  const out: { -readonly [K in keyof AgentBudgetConfig]: AgentBudgetConfig[K] } = {};
  const tokenCap = optionalPositiveInteger(
    record.token_cap,
    "budget.token_cap",
    (field, detail) => new InvalidAgentConfigError(field, detail),
  );
  if (tokenCap !== undefined) out.token_cap = tokenCap;
  const dollarCap = optionalNonNegativeNumber(
    record.dollar_cap,
    "budget.dollar_cap",
    (field, detail) => new InvalidAgentConfigError(field, detail),
  );
  if (dollarCap !== undefined) out.dollar_cap = dollarCap;
  const wallClock = optionalPositiveInteger(
    record.wall_clock_seconds,
    "budget.wall_clock_seconds",
    (field, detail) => new InvalidAgentConfigError(field, detail),
  );
  if (wallClock !== undefined) out.wall_clock_seconds = wallClock;
  return Object.freeze(out as AgentBudgetConfig);
}

function validateAgentRetention(raw: unknown): AgentRunRetentionConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    "retention",
    (field, detail) => new InvalidAgentConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    AGENT_RETENTION_KEYS,
    (field, detail) => new InvalidAgentConfigError(field, detail),
    "retention",
  );
  const out: {
    -readonly [K in keyof AgentRunRetentionConfig]: AgentRunRetentionConfig[K];
  } = {};
  for (const key of [
    "completed_days",
    "failed_days",
    "snapshot_days",
    "rollout_days",
  ] as const) {
    const value = optionalNonNegativeNumber(
      record[key],
      fieldPath("retention", key),
      (field, detail) => new InvalidAgentConfigError(field, detail),
    );
    if (value !== undefined) out[key] = value;
  }
  for (const key of ["snapshot_max_count", "snapshot_max_bytes"] as const) {
    const value = optionalPositiveInteger(
      record[key],
      fieldPath("retention", key),
      (field, detail) => new InvalidAgentConfigError(field, detail),
    );
    if (value !== undefined) out[key] = value;
  }
  return Object.freeze(out as AgentRunRetentionConfig);
}

export function validateAgentConfig(raw: unknown): AgentConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    "",
    (field, detail) => new InvalidAgentConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    AGENT_KEYS,
    (field, detail) => new InvalidAgentConfigError(field, detail),
  );
  const out: { -readonly [K in keyof AgentConfig]: AgentConfig[K] } = {};
  const budget = validateAgentBudget(record.budget);
  if (budget !== undefined) out.budget = budget;
  const retention = validateAgentRetention(record.retention);
  if (retention !== undefined) out.retention = retention;
  return Object.freeze(out as AgentConfig);
}

const PER_TOOL_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "default_permission_mode",
  "defaultPermissionMode",
  "approval_mode",
]);

function validatePerToolConfig(raw: unknown, field: string): PerToolConfig {
  const record = requirePlainObject(
    raw,
    field,
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  rejectUnknownFields(
    record,
    PER_TOOL_CONFIG_KEYS,
    (path, detail) => new InvalidPluginsConfigError(path, detail),
    field,
  );
  const out: { -readonly [K in keyof PerToolConfig]: PerToolConfig[K] } = {};
  const enabled = optionalBoolean(
    record.enabled,
    fieldPath(field, "enabled"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (enabled !== undefined) out.enabled = enabled;
  for (const key of ["default_permission_mode", "defaultPermissionMode"] as const) {
    if (record[key] !== undefined) {
      if (!isValidPermissionDefaultMode(record[key])) {
        throw new InvalidPluginsConfigError(
          fieldPath(field, key),
          "unknown approval policy",
        );
      }
      out[key] = record[key];
    }
  }
  if (record.approval_mode !== undefined) {
    if (
      record.approval_mode !== "auto" &&
      record.approval_mode !== "prompt" &&
      record.approval_mode !== "approve"
    ) {
      throw new InvalidPluginsConfigError(
        fieldPath(field, "approval_mode"),
        "expected \"auto\", \"prompt\", or \"approve\"",
      );
    }
    out.approval_mode = record.approval_mode;
  }
  return Object.freeze(out as PerToolConfig);
}

const PLUGIN_MCP_SERVER_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "default_tools_approval_mode",
  "enabled_tools",
  "disabled_tools",
  "tools",
]);

function validatePluginMcpServerConfig(
  raw: unknown,
  field: string,
): PluginMcpServerConfig {
  const record = requirePlainObject(
    raw,
    field,
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  rejectUnknownFields(
    record,
    PLUGIN_MCP_SERVER_KEYS,
    (path, detail) => new InvalidPluginsConfigError(path, detail),
    field,
  );
  const out: {
    -readonly [K in keyof PluginMcpServerConfig]: PluginMcpServerConfig[K];
  } = {};
  const enabled = optionalBoolean(
    record.enabled,
    fieldPath(field, "enabled"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (enabled !== undefined) out.enabled = enabled;
  if (record.default_tools_approval_mode !== undefined) {
    if (!isValidPermissionDefaultMode(record.default_tools_approval_mode)) {
      throw new InvalidPluginsConfigError(
        fieldPath(field, "default_tools_approval_mode"),
        "unknown approval policy",
      );
    }
    out.default_tools_approval_mode = record.default_tools_approval_mode;
  }
  const enabledTools = optionalStringArray(
    record.enabled_tools,
    fieldPath(field, "enabled_tools"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (enabledTools !== undefined) out.enabled_tools = enabledTools;
  const disabledTools = optionalStringArray(
    record.disabled_tools,
    fieldPath(field, "disabled_tools"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (disabledTools !== undefined) out.disabled_tools = disabledTools;
  if (record.tools !== undefined) {
    const tools = requirePlainObject(
      record.tools,
      fieldPath(field, "tools"),
      (path, detail) => new InvalidPluginsConfigError(path, detail),
    );
    const toolOut: Record<string, PerToolConfig> = {};
    for (const [toolName, toolConfig] of Object.entries(tools)) {
      toolOut[toolName] = validatePerToolConfig(
        toolConfig,
        `${fieldPath(field, "tools")}.${toolName}`,
      );
    }
    out.tools = deepFreeze(toolOut);
  }
  return Object.freeze(out as PluginMcpServerConfig);
}

const PLUGIN_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "path",
  "source",
  "version",
  "required",
  "options",
  "mcp_servers",
]);

function validatePluginEntryConfig(raw: unknown, field: string): PluginEntryConfig {
  const record = requirePlainObject(
    raw,
    field,
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  rejectUnknownFields(
    record,
    PLUGIN_ENTRY_KEYS,
    (path, detail) => new InvalidPluginsConfigError(path, detail),
    field,
  );
  const out: { -readonly [K in keyof PluginEntryConfig]: PluginEntryConfig[K] } = {};
  const enabled = optionalBoolean(
    record.enabled,
    fieldPath(field, "enabled"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (enabled !== undefined) out.enabled = enabled;
  for (const key of ["path", "source", "version"] as const) {
    const value = optionalString(
      record[key],
      fieldPath(field, key),
      (path, detail) => new InvalidPluginsConfigError(path, detail),
    );
    if (value !== undefined) out[key] = value;
  }
  const required = optionalBoolean(
    record.required,
    fieldPath(field, "required"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (required !== undefined) out.required = required;
  const options = optionalRecord(
    record.options,
    fieldPath(field, "options"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (options !== undefined) out.options = options;
  if (record.mcp_servers !== undefined) {
    const servers = requirePlainObject(
      record.mcp_servers,
      fieldPath(field, "mcp_servers"),
      (path, detail) => new InvalidPluginsConfigError(path, detail),
    );
    const serverOut: Record<string, PluginMcpServerConfig> = {};
    for (const [serverName, serverConfig] of Object.entries(servers)) {
      serverOut[serverName] = validatePluginMcpServerConfig(
        serverConfig,
        `${fieldPath(field, "mcp_servers")}.${serverName}`,
      );
    }
    out.mcp_servers = deepFreeze(serverOut);
  }
  return Object.freeze(out as PluginEntryConfig);
}

function validatePluginEntryMap(
  raw: unknown,
  field: string,
): Readonly<Record<string, boolean | PluginEntryConfig>> | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    field,
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  const out: Record<string, boolean | PluginEntryConfig> = {};
  for (const [pluginId, pluginConfig] of Object.entries(record)) {
    const pluginField = fieldPath(field, pluginId);
    if (typeof pluginConfig === "boolean") {
      out[pluginId] = pluginConfig;
    } else {
      out[pluginId] = validatePluginEntryConfig(pluginConfig, pluginField);
    }
  }
  return deepFreeze(out);
}

const PLUGINS_KEYS: ReadonlySet<string> = new Set([
  "dirs",
  "enabled",
  "allowlist",
  "plugins",
]);

export function validatePluginsConfig(raw: unknown): PluginsConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    "",
    (field, detail) => new InvalidPluginsConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    PLUGINS_KEYS,
    (field, detail) => new InvalidPluginsConfigError(field, detail),
  );
  const out: Record<string, unknown> = {};
  const dirs = optionalStringArray(
    record.dirs,
    "dirs",
    (field, detail) => new InvalidPluginsConfigError(field, detail),
  );
  if (dirs !== undefined) out.dirs = dirs;
  const allowlist = optionalStringArray(
    record.allowlist,
    "allowlist",
    (field, detail) => new InvalidPluginsConfigError(field, detail),
  );
  if (allowlist !== undefined) out.allowlist = allowlist;
  let legacyEnabledPlugins: Readonly<Record<string, boolean | PluginEntryConfig>> | undefined;
  if (record.enabled !== undefined) {
    if (typeof record.enabled === "boolean") {
      out.enabled = record.enabled;
    } else {
      legacyEnabledPlugins = validatePluginEntryMap(record.enabled, "enabled");
    }
  }
  const plugins = validatePluginEntryMap(record.plugins, "plugins");
  const mergedPlugins = {
    ...(legacyEnabledPlugins ?? {}),
    ...(plugins ?? {}),
  };
  if (Object.keys(mergedPlugins).length > 0) {
    out.plugins = Object.freeze(mergedPlugins);
  }
  return Object.freeze(out) as PluginsConfig;
}

const MCP_SERVER_MODE_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "transport",
  "port",
  "host",
]);

export function validateMcpServerModeConfig(
  raw: unknown,
): McpServerModeConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    "",
    (field, detail) => new InvalidMcpServerModeConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    MCP_SERVER_MODE_KEYS,
    (field, detail) => new InvalidMcpServerModeConfigError(field, detail),
  );
  const out: { -readonly [K in keyof McpServerModeConfig]: McpServerModeConfig[K] } = {};
  const enabled = optionalBoolean(
    record.enabled,
    "enabled",
    (field, detail) => new InvalidMcpServerModeConfigError(field, detail),
  );
  if (enabled !== undefined) out.enabled = enabled;
  if (record.transport !== undefined) {
    if (record.transport !== "stdio" && record.transport !== "sse") {
      throw new InvalidMcpServerModeConfigError(
        "transport",
        "expected \"stdio\" or \"sse\"",
      );
    }
    out.transport = record.transport;
  }
  const port = optionalNonNegativeInteger(
    record.port,
    "port",
    (field, detail) => new InvalidMcpServerModeConfigError(field, detail),
  );
  if (port !== undefined) {
    if (port > 65_535) {
      throw new InvalidMcpServerModeConfigError(
        "port",
        "expected TCP port between 0 and 65535",
      );
    }
    out.port = port;
  }
  const host = optionalString(
    record.host,
    "host",
    (field, detail) => new InvalidMcpServerModeConfigError(field, detail),
  );
  if (host !== undefined) out.host = host;
  return Object.freeze(out as McpServerModeConfig);
}

function validateMcpConfigTable(raw: unknown): Readonly<{
  readonly server?: McpServerModeConfig;
}> {
  const record = requirePlainObject(
    raw,
    "",
    (field, detail) => new InvalidMcpConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    new Set(["server"]),
    (field, detail) => new InvalidMcpConfigError(field, detail),
  );
  const server = validateMcpServerModeConfig(record.server);
  return Object.freeze({
    ...(server !== undefined ? { server } : {}),
  });
}

/**
 * Validate config blocks with closed sub-schemas. Top-level unknown keys still
 * flow to `_unknown` for forward compatibility; once a block is known, its
 * nested fields are deny-by-default so misspellings cannot silently change
 * runtime behavior.
 */
export function validateAgenCConfigBlocks(config: AgenCConfig): AgenCConfig {
  const out: Record<string, unknown> = { ...config };
  let changed = false;

  if (config.configVersion !== undefined) {
    if (
      typeof config.configVersion !== "number" ||
      !Number.isSafeInteger(config.configVersion) ||
      config.configVersion < 1
    ) {
      throw new Error("Invalid configVersion: expected positive safe integer");
    }
    changed = true;
  }

  if (config.auth !== undefined) {
    out.auth = validateAuthConfig(config.auth);
    changed = true;
  }
  if (config.providers !== undefined) {
    out.providers = validateProviderConfig(config.providers);
    changed = true;
  }
  if (config.agent !== undefined) {
    out.agent = validateAgentConfig(config.agent);
    changed = true;
  }
  if (config.plugins !== undefined) {
    out.plugins = validatePluginsConfig(config.plugins);
    changed = true;
  }
  if (config.tui !== undefined) {
    out.tui = validateTuiConfig(config.tui);
    changed = true;
  }

  const configWithMcp = config as AgenCConfig & {
    readonly mcp?: unknown;
  };
  if (configWithMcp.mcp !== undefined) {
    out.mcp = validateMcpConfigTable(configWithMcp.mcp);
    changed = true;
  } else if (isPlainObject(config._unknown?.mcp)) {
    validateMcpConfigTable(config._unknown.mcp);
  } else if (config._unknown?.mcp !== undefined) {
    throw new InvalidMcpConfigError(
      "",
      "expected [mcp] table with optional [mcp.server]",
    );
  }

  return changed ? (deepFreeze(out) as AgenCConfig) : config;
}

export class InvalidTuiConfigError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Invalid tui.${field}: ${detail}`);
    this.name = "InvalidTuiConfigError";
    this.field = field;
  }
}

export function validateTuiConfig(raw: unknown): TuiConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidTuiConfigError("", "expected plain object");
  }

  const out: { -readonly [K in keyof TuiConfig]: TuiConfig[K] } = {};
  if (raw.vimMode !== undefined) {
    if (typeof raw.vimMode !== "boolean") {
      throw new InvalidTuiConfigError("vimMode", "expected boolean");
    }
    out.vimMode = raw.vimMode;
  }
  return Object.freeze(out as TuiConfig);
}

// ─────────────────────────────────────────────────────────────────────
// permissions block validation
// ─────────────────────────────────────────────────────────────────────

/**
 * Error thrown when a permissions block fails schema validation.
 * Carries the offending field path so operator-facing warnings can
 * point at the exact subkey.
 */
export class InvalidPermissionsConfigError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Invalid permissions.${field}: ${detail}`);
    this.name = "InvalidPermissionsConfigError";
    this.field = field;
  }
}

/**
 * Type-guard for `PermissionMode`. Kept local to the schema module so
 * the loader can validate raw TOML values without pulling in the
 * permissions barrel (which would create an import cycle).
 */
export function isValidPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODE_VALUES as readonly string[]).includes(value)
  );
}

export function isValidPermissionDefaultMode(
  value: unknown,
): value is PermissionDefaultMode {
  return (
    value === "untrusted" ||
    value === "on-failure" ||
    value === "on-request" ||
    value === "never"
  );
}

function validateStringArray(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidPermissionsConfigError(field, "expected string[]");
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new InvalidPermissionsConfigError(
        field,
        `array element is not a string: ${typeof item}`,
      );
    }
  }
  return Object.freeze([...(value as string[])]);
}

/**
 * Validate a raw `permissions` block (typically coming from TOML or
 * settings.json) and return a frozen `PermissionsConfig`. Returns
 * `undefined` for `undefined` input. Throws
 * `InvalidPermissionsConfigError` on shape violations (wrong types,
 * unknown mode literal, etc.).
 *
 * Unknown sub-fields are silently dropped — the keys declared on
 * `PermissionsConfig` are the contract surface. If a new key is added
 * to `PermissionsConfig`, it must be wired through here too.
 */
export function validatePermissionsConfig(
  raw: unknown,
): PermissionsConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidPermissionsConfigError("", "expected plain object");
  }

  const out: {
    -readonly [K in keyof PermissionsConfig]: PermissionsConfig[K];
  } = {};

  const allow = validateStringArray(raw.allow, "allow");
  if (allow !== undefined) out.allow = allow;
  const deny = validateStringArray(raw.deny, "deny");
  if (deny !== undefined) out.deny = deny;
  const ask = validateStringArray(raw.ask, "ask");
  if (ask !== undefined) out.ask = ask;
  const addl = validateStringArray(
    raw.additionalDirectories,
    "additionalDirectories",
  );
  if (addl !== undefined) out.additionalDirectories = addl;

  if (raw.defaultMode !== undefined) {
    if (!isValidPermissionMode(raw.defaultMode)) {
      throw new InvalidPermissionsConfigError(
        "defaultMode",
        `unknown mode '${String(raw.defaultMode)}'`,
      );
    }
    out.defaultMode = raw.defaultMode;
  }

  if (raw.default_mode !== undefined) {
    if (!isValidPermissionDefaultMode(raw.default_mode)) {
      throw new InvalidPermissionsConfigError(
        "default_mode",
        `unknown mode '${String(raw.default_mode)}'`,
      );
    }
    out.default_mode = raw.default_mode;
  }

  return Object.freeze(out as PermissionsConfig);
}

// ─────────────────────────────────────────────────────────────────────
// T12 Wave 4-B: statusLine / outputStyle block validation
// ─────────────────────────────────────────────────────────────────────

/**
 * Error thrown when a `statusLine` or `outputStyle` block fails schema
 * validation. Carries the offending field path so operator-facing
 * warnings can point at the exact subkey.
 */
export class InvalidStatusLineConfigError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Invalid statusLine.${field}: ${detail}`);
    this.name = "InvalidStatusLineConfigError";
    this.field = field;
  }
}

export class InvalidOutputStyleConfigError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Invalid outputStyle.${field}: ${detail}`);
    this.name = "InvalidOutputStyleConfigError";
    this.field = field;
  }
}

/**
 * Validate a raw `statusLine` block (typically coming from TOML or
 * settings.json) and return a frozen {@link PartialStatusLineConfig}.
 * Returns `undefined` for `undefined` input. Throws
 * {@link InvalidStatusLineConfigError} on shape violations.
 *
 * Unknown sub-fields are silently dropped — `items` is the single
 * contract surface today. If a new key is added to
 * `PartialStatusLineConfig`, it must be wired through here too.
 */
export function validateStatusLineConfig(
  raw: unknown,
): PartialStatusLineConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidStatusLineConfigError("", "expected plain object");
  }

  const out: { -readonly [K in keyof PartialStatusLineConfig]: PartialStatusLineConfig[K] } = {};

  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items)) {
      throw new InvalidStatusLineConfigError("items", "expected string[]");
    }
    for (const item of raw.items) {
      if (typeof item !== "string") {
        throw new InvalidStatusLineConfigError(
          "items",
          `array element is not a string: ${typeof item}`,
        );
      }
    }
    out.items = Object.freeze([...(raw.items as string[])]);
  }

  return Object.freeze(out as PartialStatusLineConfig);
}

/**
 * Validate a raw `outputStyle` block and return a frozen
 * {@link PartialOutputStyleConfig}. Returns `undefined` for `undefined`
 * input. Throws {@link InvalidOutputStyleConfigError} on shape
 * violations.
 */
export function validateOutputStyleConfig(
  raw: unknown,
): PartialOutputStyleConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidOutputStyleConfigError("", "expected plain object");
  }

  const out: { -readonly [K in keyof PartialOutputStyleConfig]: PartialOutputStyleConfig[K] } = {};

  if (raw.theme !== undefined) {
    if (typeof raw.theme !== "string") {
      throw new InvalidOutputStyleConfigError("theme", "expected string");
    }
    out.theme = raw.theme;
  }

  return Object.freeze(out as PartialOutputStyleConfig);
}

// ─────────────────────────────────────────────────────────────────────
// Hooks block validation
// ─────────────────────────────────────────────────────────────────────

const HOOK_EVENT_ALIASES: Readonly<Record<string, HookEventName>> =
  Object.freeze({
    PreToolUse: "PreToolUse",
    preToolUse: "PreToolUse",
    PostToolUse: "PostToolUse",
    postToolUse: "PostToolUse",
    PostToolUseFailure: "PostToolUseFailure",
    postToolUseFailure: "PostToolUseFailure",
    PermissionRequest: "PermissionRequest",
    permissionRequest: "PermissionRequest",
    UserPromptSubmit: "UserPromptSubmit",
    userPromptSubmit: "UserPromptSubmit",
    SessionStart: "SessionStart",
    sessionStart: "SessionStart",
    SubagentStop: "SubagentStop",
    subagentStop: "SubagentStop",
    SessionEnd: "SessionEnd",
    sessionEnd: "SessionEnd",
    Notification: "Notification",
    notification: "Notification",
    Stop: "Stop",
    stop: "Stop",
    StopFailure: "StopFailure",
    stopFailure: "StopFailure",
    PreCompact: "PreCompact",
    preCompact: "PreCompact",
    PostCompact: "PostCompact",
    postCompact: "PostCompact",
  });

export function normalizeHookEventName(raw: string): HookEventName | undefined {
  return HOOK_EVENT_ALIASES[raw];
}

export class InvalidHooksConfigError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Invalid hooks.${field}: ${detail}`);
    this.name = "InvalidHooksConfigError";
    this.field = field;
  }
}

function validateOptionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new InvalidHooksConfigError(field, "expected boolean");
  }
  return value;
}

function validateOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidHooksConfigError(field, "expected string");
  }
  return value;
}

function validateHookCommand(raw: unknown, field: string): HookCommand {
  if (!isPlainObject(raw)) {
    throw new InvalidHooksConfigError(field, "expected command object");
  }
  if (raw.type !== "command") {
    throw new InvalidHooksConfigError(`${field}.type`, "expected \"command\"");
  }
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    throw new InvalidHooksConfigError(
      `${field}.command`,
      "expected non-empty string",
    );
  }
  const timeout = raw.timeout_ms;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout <= 0)
  ) {
    throw new InvalidHooksConfigError(
      `${field}.timeout_ms`,
      "expected positive integer milliseconds",
    );
  }
  const out: { -readonly [K in keyof HookCommand]: HookCommand[K] } = {
    type: "command",
    command: raw.command,
  };
  if (timeout !== undefined) out.timeout_ms = timeout as number;
  const enabled = validateOptionalBoolean(raw.enabled, `${field}.enabled`);
  if (enabled !== undefined) out.enabled = enabled;
  const statusMessage = validateOptionalString(
    raw.statusMessage,
    `${field}.statusMessage`,
  );
  if (statusMessage !== undefined) out.statusMessage = statusMessage;
  return Object.freeze(out as HookCommand);
}

function validateHookMatcher(raw: unknown, field: string): HookMatcher {
  if (!isPlainObject(raw)) {
    throw new InvalidHooksConfigError(field, "expected matcher object");
  }
  const hooks = raw.hooks;
  if (!Array.isArray(hooks)) {
    throw new InvalidHooksConfigError(`${field}.hooks`, "expected array");
  }
  const out: { -readonly [K in keyof HookMatcher]: HookMatcher[K] } = {
    hooks: Object.freeze(
      hooks.map((hook, index) =>
        validateHookCommand(hook, `${field}.hooks.${index}`),
      ),
    ),
  };
  const matcher = validateOptionalString(raw.matcher, `${field}.matcher`);
  if (matcher !== undefined) out.matcher = matcher;
  const enabled = validateOptionalBoolean(raw.enabled, `${field}.enabled`);
  if (enabled !== undefined) out.enabled = enabled;
  return Object.freeze(out as HookMatcher);
}

export function validateHooksConfig(raw: unknown): HooksMap | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidHooksConfigError("", "expected plain object");
  }
  const out: Record<string, HookMatcher[]> = {};
  for (const [eventKey, matchers] of Object.entries(raw)) {
    const eventName = normalizeHookEventName(eventKey);
    if (eventName === undefined) {
      throw new InvalidHooksConfigError(
        eventKey,
        `unsupported event; expected one of ${HOOK_EVENT_NAMES.join(", ")}`,
      );
    }
    if (!Array.isArray(matchers)) {
      throw new InvalidHooksConfigError(eventKey, "expected matcher array");
    }
    const normalized = matchers.map((matcher, index) =>
      validateHookMatcher(matcher, `${eventKey}.${index}`),
    );
    out[eventName] = [...(out[eventName] ?? []), ...normalized];
  }
  return deepFreeze(out) as HooksMap;
}

// ─────────────────────────────────────────────────────────────────────
// I-60: ambiguous model disambiguation
// ─────────────────────────────────────────────────────────────────────

export interface ProviderModelPair {
  readonly provider: string;
  readonly model: string;
}

export class AmbiguousModelError extends Error {
  readonly candidates: readonly ProviderModelPair[];
  constructor(slug: string, candidates: readonly ProviderModelPair[]) {
    const recommended = candidates
      .map((c) => `${c.provider}:${c.model}`)
      .join(", ");
    super(
      `Model slug "${slug}" is ambiguous — matches ${candidates.length} providers. ` +
        `Recommend explicit provider:model form. Candidates: ${recommended}`,
    );
    this.name = "AmbiguousModelError";
    this.candidates = Object.freeze([...candidates]);
  }
}

export class UnknownModelError extends Error {
  /**
   * Provider ids from the catalog the resolver consulted, frozen so
   * callers (CLI exit path, tests) can reuse the list without risk of
   * mutation. Empty list is legal — it just means the catalog was
   * empty when the error fired.
   */
  readonly providers: readonly string[];

  constructor(slug: string, providers: readonly string[] = []) {
    const frozen = Object.freeze([...providers]);
    const providerList =
      frozen.length > 0 ? frozen.join(", ") : "(none configured)";
    super(
      `unknown model '${slug}'. Known providers: ${providerList}. ` +
        `Use provider:model form.`,
    );
    this.name = "UnknownModelError";
    this.providers = frozen;
  }
}

/**
 * I-60 — hard-fail at init when a bare model slug matches ≥2 providers.
 *
 * `providerCatalog`: provider-id → list of model slugs that provider advertises.
 * `slug`           : bare model (e.g. "grok-4-fast") OR "provider:model".
 *
 * - "provider:model" form short-circuits; validated against the catalog.
 * - 1 match → returned.
 * - ≥2 matches → `AmbiguousModelError` with candidates.
 * - 0 matches → `UnknownModelError`.
 */
export function resolveModelDisambiguated(
  slug: string,
  providerCatalog: Readonly<Record<string, readonly string[]>>,
): ProviderModelPair {
  const providerIds = Object.keys(providerCatalog);
  // Explicit "provider:model" form.
  const colonIdx = slug.indexOf(":");
  if (colonIdx > 0) {
    const provider = slug.slice(0, colonIdx);
    const model = slug.slice(colonIdx + 1);
    const providerModels = providerCatalog[provider];
    if (providerModels) {
      if (!providerModels.includes(model)) {
        throw new UnknownModelError(slug, providerIds);
      }
      return Object.freeze({ provider, model });
    }
  }

  // Invert catalog: model → providers[].
  const candidates: ProviderModelPair[] = [];
  for (const [provider, models] of Object.entries(providerCatalog)) {
    if (models.includes(slug)) {
      candidates.push({ provider, model: slug });
    }
  }

  if (candidates.length === 0) {
    throw new UnknownModelError(slug, providerIds);
  }
  if (candidates.length >= 2) {
    throw new AmbiguousModelError(slug, candidates);
  }
  return Object.freeze(candidates[0]!);
}

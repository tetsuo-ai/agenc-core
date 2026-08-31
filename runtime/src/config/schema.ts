// T10 Group D — AgenC config schema.
//
// Merges AgenC config surfaces, profile selection, and runtime additions
// such as tool budgets and stream watchdog settings.
//
// All public types are readonly. `defaultConfig()` returns a frozen snapshot;
// `mergeConfigs()` is a right-biased deep merge that preserves immutability
// of the inputs and returns a fresh frozen result.
//
// `normalizeRawConfig` retains unknown fields only for the explicit v1/JSON
// migration planner. Canonical schema-v2 documents are closed and reject
// unknown top-level keys before normalization.

import { isAbsolute } from "node:path";
import {
  MarketplaceSourceSchema,
  type MarketplaceSource,
} from "../utils/plugins/schemas.js";
import {
  parseAutoFixConfig,
  type AutoFixInputConfig,
} from "../services/autoFix/autoFixConfig.js";
import {
  validateStrictAgenCConfigFields,
  validateToolsConfig,
} from "./strict-schema.js";
import {
  normalizeProviderIdentity,
  RetiredProviderSelectorError,
} from "../provider-identity.js";
import {
  DEFAULT_BUILT_IN_PROVIDER_SELECTION,
  resolveBuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import {
  USER_ADDRESSABLE_PERMISSION_MODES,
  type UserAddressablePermissionMode,
} from "../types/permissions.js";
import {
  parseRuleString,
} from "../permissions/rules.js";
import { isRemovedLiveToolName } from "../permissions/tool-names.js";
import {
  bindingCommandError,
  isKeybindingContextName,
  keybindingChordError,
  nonRebindableBindingError,
  normalizeKeyForComparison,
} from "../tui/keybindings/grammar.js";
import type {
  BindingCommand,
  KeybindingContextName,
} from "../tui/keybindings/types.js";
import { isDynamicSessionCredentialEnvironmentKey } from "../session/environment.js";
import { mcpServerNameValidationIssue } from "../mcp-client/server-name.js";

// ─────────────────────────────────────────────────────────────────────
// Core enums / unions
// ─────────────────────────────────────────────────────────────────────

export type ApprovalPolicy =
  "untrusted" | "on-failure" | "on-request" | "never";

export type PermissionDefaultMode = ApprovalPolicy;

export type SandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

export type SandboxConfigMode = "off" | "read-only" | "workspace-write";

/**
 * `none` disables reasoning and `max` sits above `xhigh`; both are
 * documented values the type used to reject, so a model that offers them
 * (the gpt-5.6 family tops out at max) could not be driven to its ends.
 */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

export type Personality = "none" | "friendly" | "pragmatic";

export type WebSearchMode = "auto" | "always" | "never";

export type ModelVerbosity = "low" | "medium" | "high";

export type ServiceTier = "priority" | "flex";

export type ApprovalsReviewer = "user" | "auto_review";

export type PermissionMode = UserAddressablePermissionMode;

// ─────────────────────────────────────────────────────────────────────
// Sub-config shapes
// ─────────────────────────────────────────────────────────────────────

export interface SandboxNetworkConfig {
  readonly allowedDomains?: readonly string[];
  readonly allowManagedDomainsOnly?: boolean;
  readonly allowUnixSockets?: readonly string[];
  readonly allowAllUnixSockets?: boolean;
  readonly allowLocalBinding?: boolean;
  readonly httpProxyPort?: number;
  readonly socksProxyPort?: number;
}

export interface SandboxFilesystemConfig {
  readonly allowWrite?: readonly string[];
  readonly denyWrite?: readonly string[];
  readonly denyRead?: readonly string[];
  readonly allowRead?: readonly string[];
  readonly allowManagedReadPathsOnly?: boolean;
}

export interface SandboxRipgrepConfig {
  readonly command: string;
  readonly args?: readonly string[];
}

export type SandboxIgnoreViolations = Readonly<
  Record<string, readonly string[]>
>;

export interface SandboxConfig {
  /** Explicit network policy; defaults to true only in danger-full-access. */
  readonly network_access?: boolean;
  /**
   * Opt-in GPU compute (Metal) inside the macOS sandbox. GPU IOKit user
   * clients are kernel attack surface, so this is off by default; when
   * true, sandboxed commands may open the Apple Silicon GPU
   * (`AGXDeviceUserClient`) for Metal device enumeration, shader
   * compilation, and compute dispatch. Display services (WindowServer)
   * stay denied either way.
   */
  readonly allow_gpu?: boolean;
  readonly autoAllowBashIfSandboxed?: boolean;
  readonly allowUnsandboxedCommands?: boolean;
  readonly network?: SandboxNetworkConfig;
  readonly filesystem?: SandboxFilesystemConfig;
  readonly ignoreViolations?: SandboxIgnoreViolations;
  readonly enableWeakerNestedSandbox?: boolean;
  readonly enableWeakerNetworkIsolation?: boolean;
  readonly excludedCommands?: readonly string[];
  readonly ripgrep?: SandboxRipgrepConfig;
}

export interface ShellEnvironmentPolicy {
  readonly set?: Readonly<Record<string, string>>;
}

export interface ToolsConfig {
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
  readonly web_search_endpoint_kind?:
    "duckduckgo" | "searxng" | "brave" | "json";
  readonly enabled_tools?: readonly string[];
  readonly disabled_tools?: readonly string[];
  readonly [k: string]: unknown;
}

export interface PerToolConfig {
  readonly default_permission_mode?: PermissionDefaultMode;
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
  readonly tools_config?: ToolsConfig;
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
  // `agent.retention.rollout_days` retention intent: when set, the daemon's
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

export type McpTransport = "stdio" | "sse" | "http" | "websocket";

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
}

export type McpServerModeTransport = "stdio" | "sse";

export interface McpServerModeConfig {
  readonly enabled?: boolean;
  readonly transport?: McpServerModeTransport;
  readonly port?: number;
  readonly host?: string;
  /** Absolute workspace exposed by daemon-autostarted read-only MCP tools. */
  readonly workspace?: string;
}

export interface McpConfig {
  readonly server?: McpServerModeConfig;
}

/**
 * A1 — `[protocol]` block: AgenC marketplace protocol transport.
 *
 * Controls whether the `/claim` protocol slash command may attach a
 * READ-ONLY transport. Defaults to fully disabled: with no `[protocol]`
 * block (or `enabled = false`) the protocol commands keep today's honest
 * "transport not attached" stub behavior.
 *
 * `adapter = "marketplace-cli"` shells out to the installed
 * `agenc-marketplace` kit binary for LISTING/DETAIL only — no in-process
 * `@solana/web3.js`/Anchor, no wallet reads, no signing. Mutating
 * protocol verbs stay owner-gated regardless of this block.
 */
export type ProtocolAdapterKind = "marketplace-cli";

export interface DisabledProtocolConfig {
  readonly enabled: false;
}

export interface MarketplaceCliProtocolConfig {
  readonly enabled: true;
  readonly adapter: ProtocolAdapterKind;
  /**
   * Trusted local path override for the `agenc-marketplace` binary.
   * Resolution order: this value → `AGENC_MARKETPLACE_CLI` env →
   * `node_modules/.bin/agenc-marketplace`. `npx` is never used.
   */
  readonly cli_path?: string;
}

export type ProtocolConfig =
  | DisabledProtocolConfig
  | MarketplaceCliProtocolConfig;

export interface DaemonConfig {
  readonly autostart?: boolean;
}

export type GatewayDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export interface GatewayChannelConfig {
  readonly dmPolicy: GatewayDmPolicy;
  readonly allowlist?: readonly string[];
}

export interface GatewayBindingConfig {
  readonly agent: string;
  readonly channelId: string;
  readonly peerId?: string;
  readonly groupId?: string;
}

export interface GatewayHooksConfig {
  readonly enabled?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly allowNonLoopback?: boolean;
}

/** Operator-owned channel-gateway policy persisted only in config.toml. */
export interface GatewayConfig {
  readonly channels?: Readonly<Record<string, GatewayChannelConfig>>;
  readonly bindings?: readonly GatewayBindingConfig[];
  readonly defaultAgent?: string;
  readonly hooks?: GatewayHooksConfig;
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
export interface StatusLineConfig {
  readonly type: "command";
  readonly command: string;
  readonly padding?: number;
}

export interface FileSuggestionConfig {
  readonly type: "command";
  readonly command: string;
}

export interface AttributionConfig {
  readonly commit?: string;
  readonly pr?: string;
}

export interface WorktreeConfig {
  readonly symlinkDirectories?: readonly string[];
  readonly sparsePaths?: readonly string[];
}

export interface SpinnerVerbsConfig {
  readonly mode: "append" | "replace";
  readonly verbs: readonly string[];
}

export type PluginPreferenceValue =
  | string
  | number
  | boolean
  | readonly string[];

export interface PluginPreferenceConfig {
  readonly mcpServers?: Readonly<
    Record<string, Readonly<Record<string, PluginPreferenceValue>>>
  >;
  readonly options?: Readonly<Record<string, PluginPreferenceValue>>;
}

export interface AutoModePreferenceConfig {
  readonly allow?: readonly string[];
  readonly soft_deny?: readonly string[];
  readonly environment?: readonly string[];
}

/** Non-secret OIDC connection metadata for MCP Cross-App Access. */
export interface XaaIdpConfig {
  readonly issuer: string;
  readonly client_id: string;
  readonly callback_port?: number;
}

export interface ManagedMcpServerPolicyEntry {
  readonly serverName?: string;
  readonly serverCommand?: readonly string[];
  readonly serverUrl?: string;
}

export type CustomizationSurface = "skills" | "agents" | "hooks" | "mcp";

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

export const TUI_THEME_SETTINGS = Object.freeze([
  "auto",
  "dark",
  "light",
  "light-daltonized",
  "dark-daltonized",
  "light-ansi",
  "dark-ansi",
] as const);

export type TuiThemeSetting = (typeof TUI_THEME_SETTINGS)[number];

/**
 * One ordered canonical keybinding override block. TOML cannot encode null,
 * so explicit unbindings use `unbind`; actions remain in `bindings`.
 */
export interface TuiKeybindingConfig {
  readonly context: KeybindingContextName;
  readonly bindings?: Readonly<Record<string, BindingCommand>>;
  readonly unbind?: readonly string[];
}

export interface TuiConfig {
  readonly vimMode?: boolean;
  readonly theme?: TuiThemeSetting;
  readonly showTurnDuration?: boolean;
  readonly terminalProgressBarEnabled?: boolean;
  readonly copyOnSelect?: boolean;
  readonly flickerFreeMode?: boolean;
  readonly prStatusFooterEnabled?: boolean;
  readonly keybindings?: readonly TuiKeybindingConfig[];
}

export interface IdeConnectorConfig {
  readonly autoInstallExtension?: boolean;
}

export interface TeammatesConfig {
  readonly mode?: "auto" | "tmux" | "in-process";
  /** "inherit" follows the leader model; absent uses the built-in teammate default. */
  readonly defaultModel?: string;
  readonly preferTmuxOverIterm2?: boolean;
}

export type BufferProviderMode = "auto" | "neovim" | "inline" | "external";
export type BufferTabsMode = "auto" | "always" | "never";
export type BufferNeovimInitMode = "auto" | "user" | "clean";
export type BufferPredictionEnabledMode = "ask" | "on" | "off";

export interface BufferNeovimConfig {
  readonly executable?: string;
  readonly init?: BufferNeovimInitMode;
  readonly discovery_timeout_ms?: number;
  readonly startup_timeout_ms?: number;
  readonly operation_timeout_ms?: number;
  readonly cleanup_timeout_ms?: number;
}

/**
 * Low-latency, transcript-free code prediction for the embedded editor.
 *
 * `ask` is the safe default: the TUI must obtain one-time user consent before
 * sending source context. Provider/model are optional owner-selected route
 * overrides; when omitted the prediction service independently clones the
 * active session route. RPC callers cannot override these trusted settings.
 */
export interface BufferPredictionConfig {
  readonly enabled?: BufferPredictionEnabledMode;
  readonly debounce_ms?: number;
  readonly timeout_ms?: number;
  readonly max_output_tokens?: number;
  readonly provider?: string;
  readonly model?: string;
}

/** Embedded editor configuration for the TUI BUFFER workspace. */
export interface BufferConfig {
  readonly provider?: BufferProviderMode;
  readonly show_tabs?: BufferTabsMode;
  readonly neovim?: BufferNeovimConfig;
  readonly prediction?: BufferPredictionConfig;
}

/**
 * Canonical permissions block as it appears in `config.toml`.
 *
 * Rule arrays (`allow` / `deny` / `ask`) carry rule strings in the
 * `Tool(filter)` or bare `Tool` form parsed by
 * `src/permissions/rules.ts::parseRuleString`. `defaultMode` is the distinct
 * user-facing session mode; approval behavior belongs only to the top-level
 * `approval_policy` key.
 *
 * Precedence (top-down, highest wins) for the runtime permission
 * context — implemented progressively across T11:
 *   1. Flag / CLI override
 *   2. Active profile's `permissions` (see `profiles.ts`)
 *   3. Top-level `permissions` (this field)
 *   4. Built-in defaults
 *
 * The canonical repository resolves user / project / local / flag / managed
 * TOML layers once. Permission consumers project this single resolved block;
 * there is no parallel settings-file authority.
 */
export interface PermissionsConfig {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly additionalDirectories?: readonly string[];
  readonly defaultMode?: PermissionMode;
  readonly bypassPermissionsMode?: "allow" | "disable";
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
  readonly max_failures?: number;
  readonly statuses?: readonly number[];
}

export interface ProviderConfig {
  readonly base_url?: string;
  readonly default_model?: string;
  readonly context_window_tokens?: number;
  readonly max_output_tokens?: number;
  /**
   * Provider request timeout in milliseconds. For streaming responses this
   * is the inter-chunk idle timeout, not a total-stream deadline. 0 disables
   * the timeout entirely. Unset is unbounded.
   */
  readonly timeout_ms?: number;
  readonly capability_overrides?: ProviderCapabilityOverrides;
  readonly fallback?: ProviderFallbackConfig;
  /** Grok-only native capabilities. Rejected on every other provider table. */
  readonly web_search?: boolean;
  readonly x_search?: boolean;
  readonly code_execution?: boolean;
  readonly enable_image_search?: boolean;
  readonly enable_image_understanding?: boolean;
  readonly enable_video_understanding?: boolean;
  readonly collections?: GrokCollectionsConfig;
  readonly remote_mcp?: GrokRemoteMcpConfig;
}

/**
 * `[providers.grok]` native server-tool capability profile.
 * Applied only when session provider is grok on a direct xAI host.
 * See `runtime/src/llm/xai-capability-config.ts`.
 */
export interface GrokCollectionsConfig {
  readonly enabled?: boolean;
  readonly vector_store_ids?: readonly string[];
  readonly max_num_results?: number;
}

export interface GrokRemoteMcpServerConfig {
  readonly server_url: string;
  readonly server_label: string;
  readonly server_description?: string;
  readonly allowed_tools?: readonly string[];
  /** Name of a captured environment variable containing the authorization value. */
  readonly authorization_env?: string;
}

export interface GrokRemoteMcpConfig {
  readonly enabled?: boolean;
  readonly servers?: readonly GrokRemoteMcpServerConfig[];
}

export type GrokCapabilityConfig = Pick<
  ProviderConfig,
  | "web_search"
  | "x_search"
  | "code_execution"
  | "enable_image_search"
  | "enable_image_understanding"
  | "enable_video_understanding"
  | "collections"
  | "remote_mcp"
>;

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
  readonly plugins?: Readonly<Record<string, PluginEntryConfig>>;
}

export type TransactionGuardFailMode = "open" | "closed";

/**
 * `[transaction_guard]` — SLM transaction-guard block
 * (docs/security/slm-transaction-guard.md). The guard runs a local
 * CourtGuard-style classification against an Ollama endpoint before
 * transaction-like tool calls execute. Environment values are converted into
 * this block once by `config/env.ts`; consumers read only the resolved block.
 */
export interface TransactionGuardConfig {
  readonly enabled?: boolean;
  readonly model?: string;
  readonly endpoint?: string;
  readonly fail_mode?: TransactionGuardFailMode;
  readonly timeout_ms?: number;
  readonly max_docket_bytes?: number;
}

/**
 * `[heartbeat]` — proactive autonomous ticks (task 14). Disabled by default.
 * Environment values are layered into this block by `config/env.ts`.
 */
export interface HeartbeatConfig {
  readonly enabled?: boolean;
  readonly interval_seconds?: number;
  /** [startHour, endHour) in local 24h; omit for always-active. */
  readonly active_hours?: readonly number[];
  readonly skip_when_busy?: boolean;
  readonly target_channel?: string;
  readonly target_conversation?: string;
}

/**
 * `[browser]` — built-in browser tool (task 18). Operational settings for the
 * isolated Chromium instance the `Browser` tool drives. Enable/disable the
 * tool itself via `tools_config`; this block only tunes how it runs.
 * Environment values are layered into this block by `config/env.ts`.
 */
export interface BrowserConfig {
  /** Absolute path to a Chromium-family binary; auto-detected when absent. */
  readonly executable_path?: string;
  /** Run headless (default true). */
  readonly headless?: boolean;
  /**
   * Permit private/loopback destinations (default false). Cloud-metadata
   * endpoints stay blocked regardless. Only enable for local-dev targets.
   */
  readonly allow_private_network?: boolean;
  /** Dedicated profile dir; defaults beneath the canonical AgenC home. */
  readonly profile_dir?: string;
  /** Pass Chromium `--no-sandbox` (default false; needed in some containers). */
  readonly no_sandbox?: boolean;
  /** Navigation timeout in ms (default 30000). */
  readonly navigation_timeout_ms?: number;
}

/**
 * `[budget]` — cost-bounded autonomy (task 15). Per-agent hard spend caps
 * enforced daemon-side around autonomous turns. Disabled by default; a cap of
 * 0/absent means no cap. Environment values are layered into this block by
 * `config/env.ts`.
 */
export interface BudgetConfig {
  readonly enabled?: boolean;
  readonly daily_usd?: number;
  readonly monthly_usd?: number;
  readonly daily_tokens?: number;
  readonly monthly_tokens?: number;
  /** Soft-warning fraction [0,1); default 0.8. */
  readonly soft_threshold?: number;
  /** Also enforce on interactive turns (default false: autonomous only). */
  readonly enforce_interactive?: boolean;
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
  readonly shell_environment_policy?: ShellEnvironmentPolicy;
  readonly reasoning_effort?: ReasoningEffort;
  readonly reasoning_summary?: ReasoningSummary;
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
  readonly experimental_realtime_start_instructions?: string;
  readonly experimental_realtime_ws_backend_prompt?: string;
  readonly hooks?: HooksMap;
  readonly mcp?: McpConfig;
  readonly mcp_servers?: Readonly<Record<string, McpServerConfig>>;
  readonly xaa_idp?: XaaIdpConfig;
  readonly daemon?: DaemonConfig;
  readonly gateway?: GatewayConfig;
  readonly protocol?: ProtocolConfig;
  readonly lsp_servers?: Readonly<Record<string, LspServerConfigInput>>;
  readonly plugins?: PluginsConfig;

  // ── Settings fields ────────────────────────────────────────────────
  readonly autoUpdates?: boolean;
  readonly ideConnector?: IdeConnectorConfig;
  readonly permissions?: PermissionsConfig;
  readonly statusLine?: StatusLineConfig;
  /** Named assistant response style. Terminal colors live under `[tui]`. */
  readonly outputStyle?: string;
  readonly attachments?: AttachmentsConfig;
  readonly buffer?: BufferConfig;
  readonly tui?: TuiConfig;
  readonly autoFix?: AutoFixInputConfig;
  readonly fileSuggestion?: FileSuggestionConfig;
  readonly respectGitignore?: boolean;
  readonly transcriptPersistenceEnabled?: boolean;
  readonly attribution?: AttributionConfig;
  readonly includeGitInstructions?: boolean;
  readonly worktree?: WorktreeConfig;
  readonly defaultShell?: "bash" | "powershell";
  readonly language?: string;
  readonly spinnerTipsEnabled?: boolean;
  readonly spinnerVerbs?: SpinnerVerbsConfig;
  readonly syntaxHighlightingDisabled?: boolean;
  readonly alwaysThinkingEnabled?: boolean;
  readonly swarmMode?: boolean;
  readonly fastMode?: boolean;
  readonly promptSuggestionEnabled?: boolean;
  readonly pluginConfigs?: Readonly<Record<string, PluginPreferenceConfig>>;
  readonly autoUpdatesChannel?: "latest" | "stable";
  readonly plansDirectory?: string;
  readonly prefersReducedMotion?: boolean;
  readonly autoMemoryEnabled?: boolean;
  readonly autoMemoryDirectory?: string;
  readonly autoDreamEnabled?: boolean;
  readonly autoDreamMinHours?: number;
  readonly autoDreamMinSessions?: number;
  readonly showThinkingSummaries?: boolean;
  readonly autoMode?: AutoModePreferenceConfig;
  readonly teammates?: TeammatesConfig;
  readonly speculationEnabled?: boolean;
  readonly fileCheckpointingEnabled?: boolean;

  // Canonical managed-policy fields. They remain top-level so existing policy
  // consumers can project them without a second policy schema or precedence
  // engine; only managed TOML should normally set these values.
  readonly availableModels?: readonly string[];
  readonly modelOverrides?: Readonly<Record<string, string>>;
  readonly allowedMcpServers?: readonly ManagedMcpServerPolicyEntry[];
  readonly deniedMcpServers?: readonly ManagedMcpServerPolicyEntry[];
  readonly disableAllHooks?: boolean;
  readonly allowManagedHooksOnly?: boolean;
  readonly allowedHttpHookUrls?: readonly string[];
  readonly httpHookAllowedEnvVars?: readonly string[];
  readonly allowManagedPermissionRulesOnly?: boolean;
  readonly allowManagedMcpServersOnly?: boolean;
  readonly strictPluginOnlyCustomization?: boolean | readonly CustomizationSurface[];
  readonly strictKnownMarketplaces?: readonly MarketplaceSource[];
  readonly blockedMarketplaces?: readonly MarketplaceSource[];
  readonly forceLoginOrgUUID?: string;
  readonly skipWebFetchPreflight?: boolean;
  readonly minimumVersion?: string;
  readonly disableAutoMode?: "disable";
  readonly agencMdExcludes?: readonly string[];
  readonly pluginTrustMessage?: string;

  // ── AgenC-specific additions ──────────────────────────────────────
  readonly agent?: AgentConfig;
  readonly durableTurns?: DurableTurnsConfig;
  readonly stream_watchdog_timeout_ms?: number;
  readonly max_output_tokens?: number;
  readonly capped_default_max_output_tokens?: boolean;
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly autonomous_mode?: boolean;
  /**
   * Coordinator mode: the main session orchestrates work through
   * spawned agents (spawn_agent/send_message/wait_agent) instead of
   * editing code itself. Environment overrides are folded into the canonical
   * snapshot by the config repository.
   */
  readonly coordinator_mode?: boolean;
  /**
   * SLM transaction guard (`[transaction_guard]`). Optional — the guard
   * defaults to disabled; `AGENC_TRANSACTION_GUARD*` env vars override.
   */
  readonly transaction_guard?: TransactionGuardConfig;
  /**
   * Cost-bounded autonomy (`[budget]`). Optional — disabled by default;
   * `AGENC_BUDGET*` env vars override. See `budget/config.ts`.
   */
  readonly budget?: BudgetConfig;
  /**
   * Built-in browser tool (`[browser]`). Optional — operational settings for
   * the isolated Chromium the `Browser` tool drives; `AGENC_BROWSER_*` env
   * vars override. See `browser/config.ts`.
   */
  readonly browser?: BrowserConfig;
  /**
   * Proactive heartbeat (`[heartbeat]`). Optional — disabled by default;
   * `AGENC_HEARTBEAT*` env vars override. See `heartbeat/config.ts`.
   */
  readonly heartbeat?: HeartbeatConfig;
  // ── Explicit-migration side-table ─────────────────────────────────
  // Never populated by the strict schema-v2 repository.
  readonly _unknown?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────
// defaultConfig
// ─────────────────────────────────────────────────────────────────────

// Complete schema-v2 top-level key allowlist. The canonical repository rejects
// anything absent from this list. Migration normalization can retain an
// unrecognized v1/JSON field in `_unknown` so the planner can report it as a
// conflict instead of silently discarding operator data.
export const KNOWN_CONFIG_KEYS: readonly string[] = Object.freeze([
  "configVersion",
  "model",
  "model_provider",
  "approval_policy",
  "sandbox_mode",
  "sandbox",
  "shell_environment_policy",
  "reasoning_effort",
  "reasoning_summary",
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
  "experimental_realtime_start_instructions",
  "experimental_realtime_ws_backend_prompt",
  "hooks",
  "mcp",
  "mcp_servers",
  "xaa_idp",
  "daemon",
  "gateway",
  "protocol",
  "lsp_servers",
  "plugins",
  "autoUpdates",
  "ideConnector",
  "permissions",
  "statusLine",
  "outputStyle",
  "attachments",
  "buffer",
  "tui",
  "autoFix",
  "fileSuggestion",
  "respectGitignore",
  "transcriptPersistenceEnabled",
  "attribution",
  "includeGitInstructions",
  "worktree",
  "defaultShell",
  "language",
  "spinnerTipsEnabled",
  "spinnerVerbs",
  "syntaxHighlightingDisabled",
  "alwaysThinkingEnabled",
  "swarmMode",
  "fastMode",
  "promptSuggestionEnabled",
  "pluginConfigs",
  "autoUpdatesChannel",
  "plansDirectory",
  "prefersReducedMotion",
  "autoMemoryEnabled",
  "autoMemoryDirectory",
  "autoDreamEnabled",
  "autoDreamMinHours",
  "autoDreamMinSessions",
  "showThinkingSummaries",
  "autoMode",
  "teammates",
  "speculationEnabled",
  "fileCheckpointingEnabled",
  "availableModels",
  "modelOverrides",
  "allowedMcpServers",
  "deniedMcpServers",
  "disableAllHooks",
  "allowManagedHooksOnly",
  "allowedHttpHookUrls",
  "httpHookAllowedEnvVars",
  "allowManagedPermissionRulesOnly",
  "allowManagedMcpServersOnly",
  "strictPluginOnlyCustomization",
  "strictKnownMarketplaces",
  "blockedMarketplaces",
  "forceLoginOrgUUID",
  "skipWebFetchPreflight",
  "minimumVersion",
  "disableAutoMode",
  "agencMdExcludes",
  "pluginTrustMessage",
  "agent",
  "stream_watchdog_timeout_ms",
  "max_output_tokens",
  "capped_default_max_output_tokens",
  "max_turns",
  "max_budget_usd",
  "autonomous_mode",
  "coordinator_mode",
  "transaction_guard",
  "budget",
  "browser",
  "heartbeat",
  "durableTurns",
  "_unknown",
]);

export function defaultConfig(): AgenCConfig {
  return Object.freeze({
    configVersion: 2,
    model: DEFAULT_BUILT_IN_PROVIDER_SELECTION.model,
    model_provider: DEFAULT_BUILT_IN_PROVIDER_SELECTION.provider,
    approval_policy: "on-request" as ApprovalPolicy,
    sandbox_mode: "workspace-write" as SandboxMode,
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
      autostart: true,
    }) as DaemonConfig,
    // Full Grok surface on by default (subscription + BYOK). Operators can
    // set individual flags false under the one canonical provider table.
    providers: Object.freeze({
      grok: Object.freeze({
        web_search: true,
        x_search: true,
        code_execution: true,
        enable_image_search: true,
        enable_image_understanding: true,
        enable_video_understanding: true,
      }) as ProviderConfig,
    }),
    project_root_markers: Object.freeze([
      ".git",
      "package.json",
      "Cargo.toml",
      "pyproject.toml",
    ]) as readonly string[],
    project_doc_max_bytes: 32_768,
    // No default stream-idle deadline. Providers can remain silent for hours
    // while reasoning or generating large tool payloads; transport failures
    // still surface as socket errors. Operators may opt in by setting
    // stream_watchdog_timeout_ms explicitly.
    // No default turn cap. Interactive / long-running agents stop on the
    // model’s own stop signal (or explicit cancel / budget). Operators who
    // want a runaway-loop backstop can set `max_turns` (or its documented env
    // override, which the repository maps onto the same canonical field).
    // max_turns intentionally unset.
    // `autoUpdates` is intentionally not defaulted. An absent operator setting
    // means enabled; every consumer reads the effective ConfigStore snapshot.
    buffer: Object.freeze({
      provider: "auto",
      show_tabs: "auto",
      neovim: Object.freeze({
        init: "auto",
        startup_timeout_ms: 10_000,
        operation_timeout_ms: 10_000,
        cleanup_timeout_ms: 1_000,
      }) as BufferNeovimConfig,
      prediction: Object.freeze({
        enabled: "ask",
        debounce_ms: 160,
        timeout_ms: 2_500,
        max_output_tokens: 256,
      }) as BufferPredictionConfig,
    }) as BufferConfig,
    tui: Object.freeze({
      theme: "dark",
      showTurnDuration: true,
      terminalProgressBarEnabled: true,
      copyOnSelect: true,
      flickerFreeMode: true,
      prStatusFooterEnabled: true,
    }) as TuiConfig,
    ideConnector: Object.freeze({
      autoInstallExtension: true,
    }) as IdeConnectorConfig,
    teammates: Object.freeze({
      mode: "auto",
      preferTmuxOverIterm2: false,
    }) as TeammatesConfig,
    speculationEnabled: true,
    fileCheckpointingEnabled: true,
    transcriptPersistenceEnabled: true,
    promptSuggestionEnabled: false,
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
// Canonical raw config normalization
// ─────────────────────────────────────────────────────────────────────

// Normalize migration input → AgenCConfig (unknown keys → _unknown)
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

  constructor(
    blockName: string,
    errorName: string,
    field: string,
    detail: string,
  ) {
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

export class InvalidTransactionGuardConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super(
      "transaction_guard",
      "InvalidTransactionGuardConfigError",
      field,
      detail,
    );
  }
}

export class InvalidMcpServerModeConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("mcp.server", "InvalidMcpServerModeConfigError", field, detail);
  }
}

export class InvalidMcpServersConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("mcp_servers", "InvalidMcpServersConfigError", field, detail);
  }
}

export class InvalidMcpConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("mcp", "InvalidMcpConfigError", field, detail);
  }
}

export class InvalidProtocolConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("protocol", "InvalidProtocolConfigError", field, detail);
  }
}

export class InvalidBufferConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("buffer", "InvalidBufferConfigError", field, detail);
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
        'expected "local" or "remote"',
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
  "base_url",
  "default_model",
  "context_window_tokens",
  "max_output_tokens",
  "timeout_ms",
  "capability_overrides",
  "fallback",
  "web_search",
  "x_search",
  "code_execution",
  "enable_image_search",
  "enable_image_understanding",
  "enable_video_understanding",
  "collections",
  "remote_mcp",
]);

const GROK_CAPABILITY_BOOLEAN_KEYS = Object.freeze([
  "web_search",
  "x_search",
  "code_execution",
  "enable_image_search",
  "enable_image_understanding",
  "enable_video_understanding",
] as const);

function validateGrokCapabilities(
  record: Readonly<Record<string, unknown>>,
  providerId: string,
): Partial<ProviderConfig> {
  const capabilityKeys = [
    ...GROK_CAPABILITY_BOOLEAN_KEYS,
    "collections",
    "remote_mcp",
  ] as const;
  if (
    providerId !== "grok" &&
    capabilityKeys.some(key => record[key] !== undefined)
  ) {
    throw new InvalidProviderConfigError(
      providerId,
      "Grok capability fields are allowed only under providers.grok",
    );
  }
  if (providerId !== "grok") return {};

  const makeError: InvalidConfigFactory = (field, detail) =>
    new InvalidProviderConfigError(field, detail);
  const out: Record<string, unknown> = {};
  for (const key of GROK_CAPABILITY_BOOLEAN_KEYS) {
    const value = optionalBoolean(
      record[key],
      fieldPath(providerId, key),
      makeError,
    );
    if (value !== undefined) out[key] = value;
  }
  if (record.collections !== undefined) {
    const field = fieldPath(providerId, "collections");
    const collections = requirePlainObject(record.collections, field, makeError);
    rejectUnknownFields(
      collections,
      new Set(["enabled", "vector_store_ids", "max_num_results"]),
      makeError,
      field,
    );
    const enabled = optionalBoolean(
      collections.enabled,
      fieldPath(field, "enabled"),
      makeError,
    );
    const vectorStoreIds = optionalStringArray(
      collections.vector_store_ids,
      fieldPath(field, "vector_store_ids"),
      makeError,
    );
    const maxNumResults = optionalPositiveInteger(
      collections.max_num_results,
      fieldPath(field, "max_num_results"),
      makeError,
    );
    out.collections = Object.freeze({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(vectorStoreIds !== undefined
        ? { vector_store_ids: vectorStoreIds }
        : {}),
      ...(maxNumResults !== undefined
        ? { max_num_results: maxNumResults }
        : {}),
    });
  }
  if (record.remote_mcp !== undefined) {
    const field = fieldPath(providerId, "remote_mcp");
    const remote = requirePlainObject(record.remote_mcp, field, makeError);
    rejectUnknownFields(
      remote,
      new Set(["enabled", "servers"]),
      makeError,
      field,
    );
    const enabled = optionalBoolean(
      remote.enabled,
      fieldPath(field, "enabled"),
      makeError,
    );
    let servers: readonly GrokRemoteMcpServerConfig[] | undefined;
    if (remote.servers !== undefined) {
      if (!Array.isArray(remote.servers)) {
        throw makeError(fieldPath(field, "servers"), "expected array");
      }
      servers = Object.freeze(remote.servers.map((value, index) => {
        const serverField = `${field}.servers.${index}`;
        const server = requirePlainObject(value, serverField, makeError);
        rejectUnknownFields(
          server,
          new Set([
            "server_url",
            "server_label",
            "server_description",
            "allowed_tools",
            "authorization_env",
          ]),
          makeError,
          serverField,
        );
        const serverUrl = optionalString(
          server.server_url,
          fieldPath(serverField, "server_url"),
          makeError,
        )?.trim();
        const serverLabel = optionalString(
          server.server_label,
          fieldPath(serverField, "server_label"),
          makeError,
        )?.trim();
        if (!serverUrl) {
          throw makeError(
            fieldPath(serverField, "server_url"),
            "required non-empty string",
          );
        }
        if (!serverLabel) {
          throw makeError(
            fieldPath(serverField, "server_label"),
            "required non-empty string",
          );
        }
        const serverDescription = optionalString(
          server.server_description,
          fieldPath(serverField, "server_description"),
          makeError,
        );
        const allowedTools = optionalStringArray(
          server.allowed_tools,
          fieldPath(serverField, "allowed_tools"),
          makeError,
        );
        const authorizationEnv = optionalString(
          server.authorization_env,
          fieldPath(serverField, "authorization_env"),
          makeError,
        )?.trim();
        if (
          authorizationEnv !== undefined &&
          !isDynamicSessionCredentialEnvironmentKey(authorizationEnv)
        ) {
          throw makeError(
            fieldPath(serverField, "authorization_env"),
            "expected an AGENC_CREDENTIAL_* environment variable name",
          );
        }
        return Object.freeze({
          server_url: serverUrl,
          server_label: serverLabel,
          ...(serverDescription !== undefined
            ? { server_description: serverDescription }
            : {}),
          ...(allowedTools !== undefined
            ? { allowed_tools: allowedTools }
            : {}),
          ...(authorizationEnv !== undefined ? { authorization_env: authorizationEnv } : {}),
        });
      }));
    }
    out.remote_mcp = Object.freeze({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(servers !== undefined ? { servers } : {}),
    });
  }
  return out as Partial<ProviderConfig>;
}

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
  if (provider !== undefined) {
    validateLiveProviderIdentity(
      provider,
      fieldPath(field, "provider"),
      (path, detail) => new InvalidProviderConfigError(path, detail),
    );
  }
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
  const out: {
    -readonly [K in keyof ProviderFallbackConfig]: ProviderFallbackConfig[K];
  } = {};
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

function validateSingleProviderConfig(
  raw: unknown,
  providerId: string,
): ProviderConfig {
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
  for (const key of ["base_url", "default_model"] as const) {
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
  const timeoutMs = optionalNonNegativeInteger(
    record.timeout_ms,
    fieldPath(providerId, "timeout_ms"),
    (field, detail) => new InvalidProviderConfigError(field, detail),
  );
  if (timeoutMs !== undefined) out.timeout_ms = timeoutMs;
  const capabilities = validateProviderCapabilities(
    record.capability_overrides,
    fieldPath(providerId, "capability_overrides"),
  );
  if (capabilities !== undefined) out.capability_overrides = capabilities;
  const fallback = validateProviderFallback(
    record.fallback,
    fieldPath(providerId, "fallback"),
  );
  if (fallback !== undefined) out.fallback = fallback;
  Object.assign(out, validateGrokCapabilities(record, providerId));
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
    validateLiveProviderIdentity(
      providerId,
      providerId,
      (field, detail) => new InvalidProviderConfigError(field, detail),
    );
    const canonicalProvider = resolveBuiltInProviderSlug(providerId);
    if (canonicalProvider === undefined || canonicalProvider !== providerId) {
      throw new InvalidProviderConfigError(
        providerId,
        "expected a canonical built-in provider id",
      );
    }
    out[canonicalProvider] = validateSingleProviderConfig(
      providerConfig,
      canonicalProvider,
    );
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
  const out: {
    -readonly [K in keyof AgentBudgetConfig]: AgentBudgetConfig[K];
  } = {};
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

function validateAgentRetention(
  raw: unknown,
): AgentRunRetentionConfig | undefined {
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
  "default_permission_mode",
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
  if (record.default_permission_mode !== undefined) {
    if (!isValidPermissionDefaultMode(record.default_permission_mode)) {
      throw new InvalidPluginsConfigError(
        fieldPath(field, "default_permission_mode"),
        "unknown approval policy",
      );
    }
    out.default_permission_mode = record.default_permission_mode;
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
  "mcp_servers",
]);

function validatePluginEntryConfig(
  raw: unknown,
  field: string,
): PluginEntryConfig {
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
  const out: {
    -readonly [K in keyof PluginEntryConfig]: PluginEntryConfig[K];
  } = {};
  const enabled = optionalBoolean(
    record.enabled,
    fieldPath(field, "enabled"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (enabled !== undefined) out.enabled = enabled;
  const path = optionalString(
    record.path,
    fieldPath(field, "path"),
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  if (path !== undefined) out.path = path;
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
): Readonly<Record<string, PluginEntryConfig>> | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    field,
    (path, detail) => new InvalidPluginsConfigError(path, detail),
  );
  const out: Record<string, PluginEntryConfig> = {};
  for (const [pluginId, pluginConfig] of Object.entries(record)) {
    const pluginField = fieldPath(field, pluginId);
    out[pluginId] = validatePluginEntryConfig(pluginConfig, pluginField);
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
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") {
      throw new InvalidPluginsConfigError("enabled", "must be a boolean");
    }
    out.enabled = record.enabled;
  }
  const plugins = validatePluginEntryMap(record.plugins, "plugins");
  if (plugins !== undefined) out.plugins = plugins;
  return Object.freeze(out) as PluginsConfig;
}

const PROTOCOL_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "adapter",
  "cli_path",
]);

/**
 * Validate the `[protocol]` block (A1). Deny-by-default on nested
 * fields: a misspelled key can never silently enable a transport.
 */
export function validateProtocolConfig(
  raw: unknown,
): ProtocolConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requirePlainObject(
    raw,
    "",
    (field, detail) => new InvalidProtocolConfigError(field, detail),
  );
  rejectUnknownFields(
    record,
    PROTOCOL_KEYS,
    (field, detail) => new InvalidProtocolConfigError(field, detail),
  );
  const enabled = optionalBoolean(
    record.enabled,
    "enabled",
    (field, detail) => new InvalidProtocolConfigError(field, detail),
  );
  if (enabled === undefined) {
    throw new InvalidProtocolConfigError(
      "enabled",
      "is required when the protocol block is present",
    );
  }
  let adapter: ProtocolAdapterKind | undefined;
  if (record.adapter !== undefined) {
    if (record.adapter !== "marketplace-cli") {
      throw new InvalidProtocolConfigError(
        "adapter",
        'expected "marketplace-cli"',
      );
    }
    adapter = record.adapter;
  }
  const cliPath = optionalString(
    record.cli_path,
    "cli_path",
    (field, detail) => new InvalidProtocolConfigError(field, detail),
  );
  if (enabled && adapter !== "marketplace-cli") {
    throw new InvalidProtocolConfigError(
      "adapter",
      'must be "marketplace-cli" when protocol.enabled is true',
    );
  }
  if (!enabled && adapter !== undefined) {
    throw new InvalidProtocolConfigError(
      "adapter",
      "must be absent when protocol.enabled is false",
    );
  }
  if (!enabled && cliPath !== undefined) {
    throw new InvalidProtocolConfigError(
      "cli_path",
      "must be absent when protocol.enabled is false",
    );
  }
  if (!enabled) return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    adapter: "marketplace-cli",
    ...(cliPath !== undefined ? { cli_path: cliPath } : {}),
  });
}

const EXTERNAL_MCP_SERVER_KEYS: ReadonlySet<string> = new Set([
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
  "transport",
  "endpoint",
  "headers",
  "enabled",
  "timeout",
  "required",
  "default_tools_approval_mode",
  "enabled_tools",
  "disabled_tools",
  "tools",
]);

function validateMcpStringRecord(
  raw: unknown,
  field: string,
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  const makeError: InvalidConfigFactory = (path, detail) =>
    new InvalidMcpServersConfigError(path, detail);
  const record = requirePlainObject(raw, field, makeError);
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      throw makeError(`${field}.${key}`, "expected string");
    }
  }
  return Object.freeze({ ...record }) as Readonly<Record<string, string>>;
}

function validateExternalMcpToolConfig(
  raw: unknown,
  field: string,
): PerToolConfig {
  const makeError: InvalidConfigFactory = (path, detail) =>
    new InvalidMcpServersConfigError(path, detail);
  const record = requirePlainObject(raw, field, makeError);
  rejectUnknownFields(
    record,
    new Set(["default_permission_mode"]),
    makeError,
    field,
  );
  const out: { -readonly [K in keyof PerToolConfig]: PerToolConfig[K] } = {};
  if (record.default_permission_mode !== undefined) {
    if (!isValidPermissionDefaultMode(record.default_permission_mode)) {
      throw makeError(
        `${field}.default_permission_mode`,
        "unknown approval policy",
      );
    }
    out.default_permission_mode = record.default_permission_mode;
  }
  return Object.freeze(out as PerToolConfig);
}

function validateExternalMcpServerConfig(
  raw: unknown,
  serverName: string,
): McpServerConfig {
  const makeError: InvalidConfigFactory = (field, detail) =>
    new InvalidMcpServersConfigError(field, detail);
  const record = requirePlainObject(raw, serverName, makeError);
  rejectUnknownFields(record, EXTERNAL_MCP_SERVER_KEYS, makeError, serverName);
  const out: { -readonly [K in keyof McpServerConfig]: McpServerConfig[K] } = {};

  for (const key of ["command", "cwd", "endpoint"] as const) {
    const value = optionalString(record[key], `${serverName}.${key}`, makeError);
    if (value !== undefined) out[key] = value;
  }
  for (const key of [
    "args",
    "env_vars",
    "enabled_tools",
    "disabled_tools",
  ] as const) {
    const value = optionalStringArray(
      record[key],
      `${serverName}.${key}`,
      makeError,
    );
    if (value !== undefined) out[key] = value;
  }
  const env = validateMcpStringRecord(record.env, `${serverName}.env`);
  if (env !== undefined) out.env = env;
  const headers = validateMcpStringRecord(
    record.headers,
    `${serverName}.headers`,
  );
  if (headers !== undefined) out.headers = headers;

  if (record.transport !== undefined) {
    if (
      record.transport !== "stdio" &&
      record.transport !== "sse" &&
      record.transport !== "http" &&
      record.transport !== "websocket"
    ) {
      throw makeError(
        `${serverName}.transport`,
        'expected "stdio", "sse", "http", or "websocket"',
      );
    }
    out.transport = record.transport;
  }
  for (const key of ["enabled", "required"] as const) {
    const value = optionalBoolean(record[key], `${serverName}.${key}`, makeError);
    if (value !== undefined) out[key] = value;
  }
  const timeout = optionalPositiveInteger(
    record.timeout,
    `${serverName}.timeout`,
    makeError,
  );
  if (timeout !== undefined) out.timeout = timeout;
  if (record.default_tools_approval_mode !== undefined) {
    if (!isValidPermissionDefaultMode(record.default_tools_approval_mode)) {
      throw makeError(
        `${serverName}.default_tools_approval_mode`,
        "unknown approval policy",
      );
    }
    out.default_tools_approval_mode = record.default_tools_approval_mode;
  }
  if (record.tools !== undefined) {
    const tools = requirePlainObject(
      record.tools,
      `${serverName}.tools`,
      makeError,
    );
    out.tools = Object.freeze(Object.fromEntries(
      Object.entries(tools).map(([toolName, config]) => [
        toolName,
        validateExternalMcpToolConfig(
          config,
          `${serverName}.tools.${toolName}`,
        ),
      ]),
    ));
  }
  return Object.freeze(out as McpServerConfig);
}

export function validateMcpServersConfig(
  raw: unknown,
): Readonly<Record<string, McpServerConfig>> | undefined {
  if (raw === undefined) return undefined;
  const makeError: InvalidConfigFactory = (field, detail) =>
    new InvalidMcpServersConfigError(field, detail);
  const record = requirePlainObject(raw, "", makeError);
  const out: Record<string, McpServerConfig> = {};
  for (const [serverName, config] of Object.entries(record)) {
    const serverNameIssue = mcpServerNameValidationIssue(serverName);
    if (serverNameIssue !== undefined) {
      throw makeError(
        "",
        `server name ${JSON.stringify(serverName)} ${serverNameIssue}`,
      );
    }
    out[serverName] = validateExternalMcpServerConfig(config, serverName);
  }
  return Object.freeze(out);
}

const MCP_SERVER_MODE_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "transport",
  "port",
  "host",
  "workspace",
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
  const out: {
    -readonly [K in keyof McpServerModeConfig]: McpServerModeConfig[K];
  } = {};
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
        'expected "stdio" or "sse"',
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
  const workspace = optionalString(
    record.workspace,
    "workspace",
    (field, detail) => new InvalidMcpServerModeConfigError(field, detail),
  );
  if (workspace !== undefined) {
    if (!isAbsolute(workspace)) {
      throw new InvalidMcpServerModeConfigError(
        "workspace",
        "expected an absolute filesystem path",
      );
    }
    out.workspace = workspace;
  }
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
 * Validate config blocks with closed sub-schemas. The strict repository has
 * already rejected unknown top-level fields; known nested blocks are likewise
 * deny-by-default so misspellings cannot silently change runtime behavior.
 */
const TRANSACTION_GUARD_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "model",
  "endpoint",
  "fail_mode",
  "timeout_ms",
  "max_docket_bytes",
]);

export function validateTransactionGuardConfig(
  raw: unknown,
): TransactionGuardConfig | undefined {
  if (raw === undefined) return undefined;
  const makeError: InvalidConfigFactory = (field, detail) =>
    new InvalidTransactionGuardConfigError(field, detail);
  const record = requirePlainObject(raw, "", makeError);
  rejectUnknownFields(record, TRANSACTION_GUARD_KEYS, makeError);
  const out: {
    -readonly [K in keyof TransactionGuardConfig]: TransactionGuardConfig[K];
  } = {};
  const enabled = optionalBoolean(record.enabled, "enabled", makeError);
  if (enabled !== undefined) out.enabled = enabled;
  const model = optionalString(record.model, "model", makeError);
  if (model !== undefined) out.model = model;
  const endpoint = optionalString(record.endpoint, "endpoint", makeError);
  if (endpoint !== undefined) out.endpoint = endpoint;
  if (record.fail_mode !== undefined) {
    if (record.fail_mode !== "open" && record.fail_mode !== "closed") {
      throw makeError("fail_mode", 'expected "open" or "closed"');
    }
    out.fail_mode = record.fail_mode;
  }
  for (const key of ["timeout_ms", "max_docket_bytes"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      throw makeError(key, "expected positive safe integer");
    }
    out[key] = value;
  }
  return Object.freeze(out as TransactionGuardConfig);
}

export class InvalidOperatorPreferenceConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("preferences", "InvalidOperatorPreferenceConfigError", field, detail);
  }
}

export class InvalidProfilesConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("profiles", "InvalidProfilesConfigError", field, detail);
  }
}

export class InvalidSandboxConfigError extends InvalidNamedConfigError {
  constructor(field: string, detail: string) {
    super("sandbox", "InvalidSandboxConfigError", field, detail);
  }
}

const SANDBOX_NETWORK_KEYS: ReadonlySet<string> = new Set([
  "allowedDomains",
  "allowManagedDomainsOnly",
  "allowUnixSockets",
  "allowAllUnixSockets",
  "allowLocalBinding",
  "httpProxyPort",
  "socksProxyPort",
]);

const SANDBOX_FILESYSTEM_KEYS: ReadonlySet<string> = new Set([
  "allowWrite",
  "denyWrite",
  "denyRead",
  "allowRead",
  "allowManagedReadPathsOnly",
]);

const SANDBOX_RIPGREP_KEYS: ReadonlySet<string> = new Set([
  "command",
  "args",
]);

function optionalSandboxTcpPort(
  value: unknown,
  field: string,
  makeError: InvalidConfigFactory,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw makeError(field, "expected integer TCP port in range 1..65535");
  }
  return value;
}

function validateSandboxNetworkConfig(
  raw: unknown,
  makeError: InvalidConfigFactory,
): SandboxNetworkConfig {
  const record = requirePlainObject(raw, "network", makeError);
  rejectUnknownFields(record, SANDBOX_NETWORK_KEYS, makeError, "network");
  const out: {
    -readonly [K in keyof SandboxNetworkConfig]: SandboxNetworkConfig[K];
  } = {};
  for (const key of ["allowedDomains", "allowUnixSockets"] as const) {
    const value = optionalStringArray(record[key], `network.${key}`, makeError);
    if (value !== undefined) out[key] = value;
  }
  for (const key of [
    "allowManagedDomainsOnly",
    "allowAllUnixSockets",
    "allowLocalBinding",
  ] as const) {
    const value = optionalBoolean(record[key], `network.${key}`, makeError);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ["httpProxyPort", "socksProxyPort"] as const) {
    const value = optionalSandboxTcpPort(
      record[key],
      `network.${key}`,
      makeError,
    );
    if (value !== undefined) out[key] = value;
  }
  return deepFreeze(out);
}

function validateSandboxFilesystemConfig(
  raw: unknown,
  makeError: InvalidConfigFactory,
): SandboxFilesystemConfig {
  const record = requirePlainObject(raw, "filesystem", makeError);
  rejectUnknownFields(
    record,
    SANDBOX_FILESYSTEM_KEYS,
    makeError,
    "filesystem",
  );
  const out: {
    -readonly [K in keyof SandboxFilesystemConfig]: SandboxFilesystemConfig[K];
  } = {};
  for (const key of [
    "allowWrite",
    "denyWrite",
    "denyRead",
    "allowRead",
  ] as const) {
    const value = optionalStringArray(
      record[key],
      `filesystem.${key}`,
      makeError,
    );
    if (value !== undefined) out[key] = value;
  }
  const allowManagedReadPathsOnly = optionalBoolean(
    record.allowManagedReadPathsOnly,
    "filesystem.allowManagedReadPathsOnly",
    makeError,
  );
  if (allowManagedReadPathsOnly !== undefined) {
    out.allowManagedReadPathsOnly = allowManagedReadPathsOnly;
  }
  return deepFreeze(out);
}

function validateSandboxRipgrepConfig(
  raw: unknown,
  makeError: InvalidConfigFactory,
): SandboxRipgrepConfig {
  const record = requirePlainObject(raw, "ripgrep", makeError);
  rejectUnknownFields(record, SANDBOX_RIPGREP_KEYS, makeError, "ripgrep");
  const command = optionalString(record.command, "ripgrep.command", makeError);
  if (command === undefined || command.trim().length === 0) {
    throw makeError("ripgrep.command", "expected non-empty string");
  }
  const args = optionalStringArray(record.args, "ripgrep.args", makeError);
  return deepFreeze({
    command,
    ...(args === undefined ? {} : { args }),
  });
}

function validateSandboxIgnoreViolations(
  raw: unknown,
  makeError: InvalidConfigFactory,
): SandboxIgnoreViolations {
  const record = requirePlainObject(raw, "ignoreViolations", makeError);
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(record)) {
    const paths = optionalStringArray(
      value,
      `ignoreViolations.${key}`,
      makeError,
    );
    if (paths !== undefined) out[key] = paths;
  }
  return deepFreeze(out);
}

export function validateSandboxConfig(
  raw: unknown,
): SandboxConfig | undefined {
  if (raw === undefined) return undefined;
  const makeError: InvalidConfigFactory = (field, detail) =>
    new InvalidSandboxConfigError(field, detail);
  const record = requirePlainObject(raw, "", makeError);
  const booleanKeys = [
    "network_access",
    "allow_gpu",
    "autoAllowBashIfSandboxed",
    "allowUnsandboxedCommands",
    "enableWeakerNestedSandbox",
    "enableWeakerNetworkIsolation",
  ] as const;
  rejectUnknownFields(
    record,
    new Set([
      ...booleanKeys,
      "network",
      "filesystem",
      "ripgrep",
      "ignoreViolations",
      "excludedCommands",
    ]),
    makeError,
  );
  const out: {
    -readonly [K in keyof SandboxConfig]: SandboxConfig[K];
  } = {};
  for (const key of booleanKeys) {
    const value = optionalBoolean(record[key], key, makeError);
    if (value !== undefined) out[key] = value;
  }
  const excludedCommands = optionalStringArray(
    record.excludedCommands,
    "excludedCommands",
    makeError,
  );
  if (excludedCommands !== undefined) out.excludedCommands = excludedCommands;
  if (record.network !== undefined) {
    out.network = validateSandboxNetworkConfig(record.network, makeError);
  }
  if (record.filesystem !== undefined) {
    out.filesystem = validateSandboxFilesystemConfig(
      record.filesystem,
      makeError,
    );
  }
  if (record.ignoreViolations !== undefined) {
    out.ignoreViolations = validateSandboxIgnoreViolations(
      record.ignoreViolations,
      makeError,
    );
  }
  if (record.ripgrep !== undefined) {
    out.ripgrep = validateSandboxRipgrepConfig(record.ripgrep, makeError);
  }
  return deepFreeze(out);
}

const OPERATOR_BOOLEAN_FIELDS = Object.freeze([
  "respectGitignore",
  "includeGitInstructions",
  "spinnerTipsEnabled",
  "syntaxHighlightingDisabled",
  "alwaysThinkingEnabled",
  "swarmMode",
  "fastMode",
  "promptSuggestionEnabled",
  "prefersReducedMotion",
  "autoMemoryEnabled",
  "autoDreamEnabled",
  "showThinkingSummaries",
  "transcriptPersistenceEnabled",
] as const);

const OPERATOR_STRING_FIELDS = Object.freeze([
  "outputStyle",
  "language",
  "plansDirectory",
  "autoMemoryDirectory",
] as const);

function operatorPreferenceError(field: string, detail: string): Error {
  return new InvalidOperatorPreferenceConfigError(field, detail);
}

function validateStringRecord(raw: unknown, field: string): void {
  const record = requirePlainObject(raw, field, operatorPreferenceError);
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      throw operatorPreferenceError(`${field}.${key}`, "expected string");
    }
  }
}

function validatePluginPreferenceValue(value: unknown, field: string): void {
  if (
    typeof value === "string" ||
    typeof value === "number" && Number.isFinite(value) ||
    typeof value === "boolean"
  ) return;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return;
  throw operatorPreferenceError(
    field,
    "expected string, finite number, boolean, or string[]",
  );
}

const MANAGED_POLICY_BOOLEAN_FIELDS = Object.freeze([
  "disableAllHooks",
  "allowManagedHooksOnly",
  "allowManagedPermissionRulesOnly",
  "allowManagedMcpServersOnly",
  "skipWebFetchPreflight",
] as const);

const CUSTOMIZATION_SURFACE_VALUES: readonly CustomizationSurface[] = Object.freeze([
  "skills",
  "agents",
  "hooks",
  "mcp",
]);

function validateManagedMcpServerPolicies(
  value: unknown,
  field: "allowedMcpServers" | "deniedMcpServers",
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw operatorPreferenceError(field, "expected array");
  const keys = new Set(["serverName", "serverCommand", "serverUrl"]);
  for (const [index, item] of value.entries()) {
    const itemField = `${field}.${index}`;
    const record = requirePlainObject(item, itemField, operatorPreferenceError);
    rejectUnknownFields(record, keys, operatorPreferenceError, itemField);
    const selectors = [record.serverName, record.serverCommand, record.serverUrl]
      .filter((selector) => selector !== undefined);
    if (selectors.length !== 1) {
      throw operatorPreferenceError(
        itemField,
        "expected exactly one of serverName, serverCommand, or serverUrl",
      );
    }
    if (record.serverName !== undefined) {
      if (
        typeof record.serverName !== "string" ||
        !/^[a-zA-Z0-9_-]+$/u.test(record.serverName)
      ) {
        throw operatorPreferenceError(
          `${itemField}.serverName`,
          "expected letters, numbers, hyphens, and underscores",
        );
      }
    }
    if (record.serverCommand !== undefined) {
      const command = optionalStringArray(
        record.serverCommand,
        `${itemField}.serverCommand`,
        operatorPreferenceError,
      );
      if (command?.length === 0) {
        throw operatorPreferenceError(
          `${itemField}.serverCommand`,
          "expected at least one command element",
        );
      }
    }
    optionalString(record.serverUrl, `${itemField}.serverUrl`, operatorPreferenceError);
  }
}

function validateMarketplaceSourcePolicy(value: unknown, field: string): void {
  const record = requirePlainObject(value, field, operatorPreferenceError);
  const source = record.source;
  if (typeof source !== "string") {
    throw operatorPreferenceError(`${field}.source`, "expected string discriminator");
  }
  const keysBySource: Readonly<Record<string, ReadonlySet<string>>> = {
    url: new Set(["source", "url", "headers"]),
    github: new Set(["source", "repo", "ref", "path", "sparsePaths"]),
    git: new Set(["source", "url", "ref", "path", "sparsePaths"]),
    file: new Set(["source", "path"]),
    directory: new Set(["source", "path"]),
    hostPattern: new Set(["source", "hostPattern"]),
    pathPattern: new Set(["source", "pathPattern"]),
  };
  const allowed = keysBySource[source];
  if (!allowed) {
    throw operatorPreferenceError(`${field}.source`, "unknown marketplace source");
  }
  rejectUnknownFields(record, allowed, operatorPreferenceError, field);

  const parsed = MarketplaceSourceSchema().safeParse(value);
  if (!parsed.success) {
    throw operatorPreferenceError(
      field,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
}

function validateMarketplaceSourcePolicies(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw operatorPreferenceError(field, "expected array");
  for (const [index, source] of value.entries()) {
    validateMarketplaceSourcePolicy(source, `${field}.${index}`);
  }
}

function validateManagedPolicy(config: AgenCConfig): void {
  for (const key of MANAGED_POLICY_BOOLEAN_FIELDS) {
    optionalBoolean(config[key], key, operatorPreferenceError);
  }
  for (const key of [
    "availableModels",
    "allowedHttpHookUrls",
    "httpHookAllowedEnvVars",
    "agencMdExcludes",
  ] as const) {
    optionalStringArray(config[key], key, operatorPreferenceError);
  }
  if (config.modelOverrides !== undefined) {
    validateStringRecord(config.modelOverrides, "modelOverrides");
  }
  validateManagedMcpServerPolicies(config.allowedMcpServers, "allowedMcpServers");
  validateManagedMcpServerPolicies(config.deniedMcpServers, "deniedMcpServers");

  if (config.strictPluginOnlyCustomization !== undefined) {
    if (typeof config.strictPluginOnlyCustomization !== "boolean") {
      const surfaces = optionalStringArray(
        config.strictPluginOnlyCustomization,
        "strictPluginOnlyCustomization",
        operatorPreferenceError,
      );
      for (const surface of surfaces ?? []) {
        if (!CUSTOMIZATION_SURFACE_VALUES.includes(surface as CustomizationSurface)) {
          throw operatorPreferenceError(
            "strictPluginOnlyCustomization",
            `unknown customization surface: ${surface}`,
          );
        }
      }
    }
  }
  validateMarketplaceSourcePolicies(config.strictKnownMarketplaces, "strictKnownMarketplaces");
  validateMarketplaceSourcePolicies(config.blockedMarketplaces, "blockedMarketplaces");

  for (const key of ["forceLoginOrgUUID", "minimumVersion", "pluginTrustMessage"] as const) {
    optionalString(config[key], key, operatorPreferenceError);
  }
  if (config.disableAutoMode !== undefined && config.disableAutoMode !== "disable") {
    throw operatorPreferenceError("disableAutoMode", 'expected "disable"');
  }
}

function validateOperatorPreferences(config: AgenCConfig): void {
  for (const key of OPERATOR_BOOLEAN_FIELDS) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw operatorPreferenceError(key, "expected boolean");
    }
  }
  for (const key of OPERATOR_STRING_FIELDS) {
    if (config[key] !== undefined && typeof config[key] !== "string") {
      throw operatorPreferenceError(key, "expected string");
    }
  }
  if (
    config.autoDreamMinHours !== undefined &&
    (typeof config.autoDreamMinHours !== "number" ||
      !Number.isFinite(config.autoDreamMinHours) || config.autoDreamMinHours <= 0)
  ) throw operatorPreferenceError("autoDreamMinHours", "expected positive number");
  if (
    config.autoDreamMinSessions !== undefined &&
    (!Number.isInteger(config.autoDreamMinSessions) || config.autoDreamMinSessions <= 0)
  ) throw operatorPreferenceError("autoDreamMinSessions", "expected positive integer");

  const enums: readonly [string, unknown, readonly string[]][] = [
    ["defaultShell", config.defaultShell, ["bash", "powershell"]],
    ["autoUpdatesChannel", config.autoUpdatesChannel, ["latest", "stable"]],
  ];
  for (const [field, value, allowed] of enums) {
    if (value !== undefined && !allowed.includes(value as string)) {
      throw operatorPreferenceError(field, `expected one of: ${allowed.join(", ")}`);
    }
  }

  if (config.fileSuggestion !== undefined) {
    const raw = requirePlainObject(config.fileSuggestion, "fileSuggestion", operatorPreferenceError);
    rejectUnknownFields(raw, new Set(["type", "command"]), operatorPreferenceError, "fileSuggestion");
    if (raw.type !== "command") throw operatorPreferenceError("fileSuggestion.type", 'expected "command"');
    if (typeof raw.command !== "string") throw operatorPreferenceError("fileSuggestion.command", "expected string");
  }
  if (config.attribution !== undefined) {
    const raw = requirePlainObject(config.attribution, "attribution", operatorPreferenceError);
    rejectUnknownFields(raw, new Set(["commit", "pr"]), operatorPreferenceError, "attribution");
    for (const key of ["commit", "pr"] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") {
        throw operatorPreferenceError(`attribution.${key}`, "expected string");
      }
    }
  }
  if (config.worktree !== undefined) {
    const raw = requirePlainObject(config.worktree, "worktree", operatorPreferenceError);
    rejectUnknownFields(raw, new Set(["symlinkDirectories", "sparsePaths"]), operatorPreferenceError, "worktree");
    optionalStringArray(raw.symlinkDirectories, "worktree.symlinkDirectories", operatorPreferenceError);
    optionalStringArray(raw.sparsePaths, "worktree.sparsePaths", operatorPreferenceError);
  }
  if (config.spinnerVerbs !== undefined) {
    const raw = requirePlainObject(config.spinnerVerbs, "spinnerVerbs", operatorPreferenceError);
    rejectUnknownFields(raw, new Set(["mode", "verbs"]), operatorPreferenceError, "spinnerVerbs");
    if (raw.mode !== "append" && raw.mode !== "replace") {
      throw operatorPreferenceError("spinnerVerbs.mode", 'expected "append" or "replace"');
    }
    if (optionalStringArray(raw.verbs, "spinnerVerbs.verbs", operatorPreferenceError) === undefined) {
      throw operatorPreferenceError("spinnerVerbs.verbs", "required");
    }
  }
  if (config.autoMode !== undefined) {
    const raw = requirePlainObject(config.autoMode, "autoMode", operatorPreferenceError);
    rejectUnknownFields(raw, new Set(["allow", "soft_deny", "environment"]), operatorPreferenceError, "autoMode");
    for (const key of ["allow", "soft_deny", "environment"] as const) {
      optionalStringArray(raw[key], `autoMode.${key}`, operatorPreferenceError);
    }
  }
  if (config.xaa_idp !== undefined) {
    const raw = requirePlainObject(config.xaa_idp, "xaa_idp", operatorPreferenceError);
    rejectUnknownFields(
      raw,
      new Set(["issuer", "client_id", "callback_port"]),
      operatorPreferenceError,
      "xaa_idp",
    );
    if (typeof raw.issuer !== "string") {
      throw operatorPreferenceError("xaa_idp.issuer", "expected string");
    }
    let issuer: URL;
    try {
      issuer = new URL(raw.issuer);
    } catch {
      throw operatorPreferenceError("xaa_idp.issuer", "expected valid URL");
    }
    const loopbackHttp = issuer.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
    if (issuer.protocol !== "https:" && !loopbackHttp) {
      throw operatorPreferenceError(
        "xaa_idp.issuer",
        "expected https URL (http is allowed only for loopback)",
      );
    }
    if (typeof raw.client_id !== "string" || raw.client_id.length === 0) {
      throw operatorPreferenceError("xaa_idp.client_id", "expected non-empty string");
    }
    if (
      raw.callback_port !== undefined &&
      (!Number.isInteger(raw.callback_port) ||
        (raw.callback_port as number) <= 0 ||
        (raw.callback_port as number) > 65_535)
    ) {
      throw operatorPreferenceError("xaa_idp.callback_port", "expected TCP port");
    }
  }
  if (config.pluginConfigs !== undefined) {
    const plugins = requirePlainObject(config.pluginConfigs, "pluginConfigs", operatorPreferenceError);
    for (const [pluginId, pluginValue] of Object.entries(plugins)) {
      const plugin = requirePlainObject(pluginValue, `pluginConfigs.${pluginId}`, operatorPreferenceError);
      rejectUnknownFields(plugin, new Set(["mcpServers", "options"]), operatorPreferenceError, `pluginConfigs.${pluginId}`);
      if (plugin.options !== undefined) {
        const options = requirePlainObject(plugin.options, `pluginConfigs.${pluginId}.options`, operatorPreferenceError);
        for (const [name, value] of Object.entries(options)) {
          validatePluginPreferenceValue(value, `pluginConfigs.${pluginId}.options.${name}`);
        }
      }
      if (plugin.mcpServers !== undefined) {
        const servers = requirePlainObject(plugin.mcpServers, `pluginConfigs.${pluginId}.mcpServers`, operatorPreferenceError);
        for (const [serverName, serverValue] of Object.entries(servers)) {
          const server = requirePlainObject(serverValue, `pluginConfigs.${pluginId}.mcpServers.${serverName}`, operatorPreferenceError);
          for (const [name, value] of Object.entries(server)) {
            validatePluginPreferenceValue(value, `pluginConfigs.${pluginId}.mcpServers.${serverName}.${name}`);
          }
        }
      }
    }
  }
  if (config.autoFix !== undefined) {
    const autoFix = requirePlainObject(config.autoFix, "autoFix", operatorPreferenceError);
    rejectUnknownFields(
      autoFix,
      new Set(["enabled", "lint", "test", "maxRetries", "timeout"]),
      operatorPreferenceError,
      "autoFix",
    );
    const parsed = parseAutoFixConfig(config.autoFix);
    if (!parsed.success) throw operatorPreferenceError("autoFix", parsed.reason);
  }
  validateManagedPolicy(config);
}

export const PROFILE_OVERRIDE_KEYS = Object.freeze([
  "model",
  "model_provider",
  "approval_policy",
  "sandbox_mode",
  "reasoning_effort",
  "reasoning_summary",
  "approvals_reviewer",
  "model_verbosity",
  "service_tier",
  "personality",
  "tools_config",
] as const satisfies readonly (keyof ProfileOverride)[]);

const PROFILE_OVERRIDE_KEY_SET: ReadonlySet<string> = new Set(PROFILE_OVERRIDE_KEYS);

function validateLiveProviderIdentity(
  value: string,
  field: string,
  makeError: InvalidConfigFactory,
): void {
  try {
    normalizeProviderIdentity(value, `config ${field}`);
  } catch (error) {
    if (error instanceof RetiredProviderSelectorError) {
      throw makeError(
        field,
        `retired provider selector "${error.selector}"; use "${error.replacement}"`,
      );
    }
    throw error;
  }
}

function validateEnumValue(
  value: unknown,
  field: string,
  allowed: readonly string[],
  makeError: InvalidConfigFactory,
): void {
  if (value !== undefined && !allowed.includes(value as string)) {
    throw makeError(field, `expected one of: ${allowed.join(", ")}`);
  }
}

export function validateProfilesConfig(
  raw: unknown,
): Readonly<Record<string, ProfileOverride>> | undefined {
  if (raw === undefined) return undefined;
  const makeError: InvalidConfigFactory = (field, detail) =>
    new InvalidProfilesConfigError(field, detail);
  const profiles = requirePlainObject(raw, "", makeError);
  const out: Record<string, ProfileOverride> = {};
  for (const [name, value] of Object.entries(profiles)) {
    const profile = requirePlainObject(value, name, makeError);
    rejectUnknownFields(profile, PROFILE_OVERRIDE_KEY_SET, makeError, name);
    optionalString(profile.model, `${name}.model`, makeError);
    const modelProvider = optionalString(
      profile.model_provider,
      `${name}.model_provider`,
      makeError,
    );
    if (modelProvider !== undefined) {
      validateLiveProviderIdentity(
        modelProvider,
        `${name}.model_provider`,
        makeError,
      );
    }
    validateEnumValue(
      profile.approval_policy,
      `${name}.approval_policy`,
      ["untrusted", "on-failure", "on-request", "never"],
      makeError,
    );
    validateEnumValue(
      profile.sandbox_mode,
      `${name}.sandbox_mode`,
      ["read-only", "workspace-write", "danger-full-access"],
      makeError,
    );
    validateEnumValue(
      profile.reasoning_effort,
      `${name}.reasoning_effort`,
      ["low", "medium", "high", "xhigh", "none"],
      makeError,
    );
    validateEnumValue(
      profile.reasoning_summary,
      `${name}.reasoning_summary`,
      ["auto", "concise", "detailed", "none"],
      makeError,
    );
    validateEnumValue(
      profile.approvals_reviewer,
      `${name}.approvals_reviewer`,
      ["user", "auto_review"],
      makeError,
    );
    validateEnumValue(
      profile.model_verbosity,
      `${name}.model_verbosity`,
      ["low", "medium", "high"],
      makeError,
    );
    validateEnumValue(
      profile.service_tier,
      `${name}.service_tier`,
      ["priority", "flex"],
      makeError,
    );
    validateEnumValue(
      profile.personality,
      `${name}.personality`,
      ["none", "friendly", "pragmatic"],
      makeError,
    );
    if (profile.tools_config !== undefined) {
      validateToolsConfig(profile.tools_config, `${name}.tools_config`);
    }
    out[name] = deepFreeze({ ...profile }) as ProfileOverride;
  }
  return deepFreeze(out);
}

export function validateAgenCConfigBlocks(config: AgenCConfig): AgenCConfig {
  const rejectRemovedNestedAliases = (value: unknown, path = ""): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        rejectRemovedNestedAliases(entry, path ? `${path}.${index}` : String(index))
      );
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const field = path ? `${path}.${key}` : key;
      if (key === "defaultPermissionMode" || key === "approval_mode") {
        throw new Error(
          `Invalid ${field}: removed alias; use default_permission_mode`,
        );
      }
      rejectRemovedNestedAliases(child, field);
    }
  };
  rejectRemovedNestedAliases(config);
  validateStrictAgenCConfigFields(config);
  if (config.model_provider !== undefined) {
    validateLiveProviderIdentity(
      config.model_provider,
      "model_provider",
      (field, detail) => new Error(`Invalid ${field}: ${detail}`),
    );
  }

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

  if (config.outputStyle !== undefined && typeof config.outputStyle !== "string") {
    throw new Error("Invalid outputStyle: expected string");
  }
  validateOperatorPreferences(config);

  if (config.auth !== undefined) {
    out.auth = validateAuthConfig(config.auth);
    changed = true;
  }
  if (config.permissions !== undefined) {
    out.permissions = validatePermissionsConfig(config.permissions);
    changed = true;
  }
  if (config.tools_config !== undefined) {
    out.tools_config = validateToolsConfig(config.tools_config);
    changed = true;
  }
  if (config.hooks !== undefined) {
    out.hooks = validateHooksConfig(config.hooks);
    changed = true;
  }
  if (config.sandbox !== undefined) {
    out.sandbox = validateSandboxConfig(config.sandbox);
    changed = true;
  }
  if (config.statusLine !== undefined) {
    out.statusLine = validateStatusLineConfig(config.statusLine);
    changed = true;
  }
  if (config.providers !== undefined) {
    out.providers = validateProviderConfig(config.providers);
    changed = true;
  }
  if (config.profiles !== undefined) {
    out.profiles = validateProfilesConfig(config.profiles);
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
  if (config.mcp_servers !== undefined) {
    out.mcp_servers = validateMcpServersConfig(config.mcp_servers);
    changed = true;
  }
  if (config.tui !== undefined) {
    out.tui = validateTuiConfig(config.tui);
    changed = true;
  }
  if (config.buffer !== undefined) {
    out.buffer = validateBufferConfig(config.buffer);
    changed = true;
  }
  if (config.browser !== undefined) {
    out.browser = validateBrowserConfig(config.browser);
    changed = true;
  }
  if (config.transaction_guard !== undefined) {
    out.transaction_guard = validateTransactionGuardConfig(
      config.transaction_guard,
    );
    changed = true;
  }
  if (config.protocol !== undefined) {
    out.protocol = validateProtocolConfig(config.protocol);
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

function validateTuiKeybindings(
  raw: unknown,
): readonly TuiKeybindingConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new InvalidTuiConfigError("keybindings", "expected array");
  }

  const seenByContext = new Map<KeybindingContextName, Map<string, string>>();
  const blocks: TuiKeybindingConfig[] = [];
  raw.forEach((entry, index) => {
    const blockField = `keybindings.${index}`;
    if (!isPlainObject(entry)) {
      throw new InvalidTuiConfigError(blockField, "expected plain object");
    }
    rejectUnknownFields(
      entry,
      new Set(["context", "bindings", "unbind"]),
      (field, detail) => new InvalidTuiConfigError(field, detail),
      blockField,
    );
    if (!isKeybindingContextName(entry.context)) {
      throw new InvalidTuiConfigError(
        `${blockField}.context`,
        "expected a supported keybinding context",
      );
    }
    const context = entry.context;
    if (entry.bindings === undefined && entry.unbind === undefined) {
      throw new InvalidTuiConfigError(
        blockField,
        "expected bindings and/or unbind",
      );
    }

    const seen = seenByContext.get(context) ?? new Map<string, string>();
    seenByContext.set(context, seen);
    const claimChord = (chord: string, field: string): void => {
      const syntaxError = keybindingChordError(chord);
      if (syntaxError !== null) {
        throw new InvalidTuiConfigError(field, syntaxError);
      }
      const normalized = normalizeKeyForComparison(chord);
      const prior = seen.get(normalized);
      if (prior !== undefined) {
        throw new InvalidTuiConfigError(
          field,
          `conflicts with ${prior} after key alias normalization`,
        );
      }
      seen.set(normalized, field);
    };

    let bindings: Readonly<Record<string, BindingCommand>> | undefined;
    if (entry.bindings !== undefined) {
      if (!isPlainObject(entry.bindings)) {
        throw new InvalidTuiConfigError(
          `${blockField}.bindings`,
          "expected plain object",
        );
      }
      const validated: Record<string, BindingCommand> = {};
      for (const [chord, action] of Object.entries(entry.bindings)) {
        const field = `${blockField}.bindings.${JSON.stringify(chord)}`;
        claimChord(chord, field);
        const actionError = bindingCommandError(action, context);
        if (actionError !== null) {
          throw new InvalidTuiConfigError(field, actionError);
        }
        const nonRebindableError = nonRebindableBindingError(
          chord,
          action as BindingCommand,
        );
        if (nonRebindableError !== null) {
          throw new InvalidTuiConfigError(field, nonRebindableError);
        }
        validated[chord] = action as BindingCommand;
      }
      bindings = Object.freeze(validated);
    }

    let unbind: readonly string[] | undefined;
    if (entry.unbind !== undefined) {
      if (
        !Array.isArray(entry.unbind) ||
        entry.unbind.some((chord) => typeof chord !== "string")
      ) {
        throw new InvalidTuiConfigError(
          `${blockField}.unbind`,
          "expected string[]",
        );
      }
      const validated = [...entry.unbind] as string[];
      validated.forEach((chord, chordIndex) => {
        const field = `${blockField}.unbind.${chordIndex}`;
        claimChord(chord, field);
        const nonRebindableError = nonRebindableBindingError(chord, null);
        if (nonRebindableError !== null) {
          throw new InvalidTuiConfigError(field, nonRebindableError);
        }
      });
      unbind = Object.freeze(validated);
    }

    blocks.push(Object.freeze({
      context,
      ...(bindings !== undefined ? { bindings } : {}),
      ...(unbind !== undefined ? { unbind } : {}),
    }));
  });
  return Object.freeze(blocks);
}

export function validateTuiConfig(raw: unknown): TuiConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidTuiConfigError("", "expected plain object");
  }
  rejectUnknownFields(
    raw,
    new Set([
      "vimMode",
      "theme",
      "showTurnDuration",
      "terminalProgressBarEnabled",
      "copyOnSelect",
      "flickerFreeMode",
      "prStatusFooterEnabled",
      "keybindings",
    ]),
    (field, detail) => new InvalidTuiConfigError(field, detail),
  );

  const out: { -readonly [K in keyof TuiConfig]: TuiConfig[K] } = {};
  if (raw.vimMode !== undefined) {
    if (typeof raw.vimMode !== "boolean") {
      throw new InvalidTuiConfigError("vimMode", "expected boolean");
    }
    out.vimMode = raw.vimMode;
  }
  if (raw.theme !== undefined) {
    if (!TUI_THEME_SETTINGS.includes(raw.theme as TuiThemeSetting)) {
      throw new InvalidTuiConfigError(
        "theme",
        `expected one of ${TUI_THEME_SETTINGS.join(", ")}`,
      );
    }
    out.theme = raw.theme as TuiThemeSetting;
  }
  for (const key of [
    "showTurnDuration",
    "terminalProgressBarEnabled",
    "copyOnSelect",
    "flickerFreeMode",
    "prStatusFooterEnabled",
  ] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") {
        throw new InvalidTuiConfigError(key, "expected boolean");
      }
      out[key] = raw[key];
    }
  }
  const keybindings = validateTuiKeybindings(raw.keybindings);
  if (keybindings !== undefined) out.keybindings = keybindings;
  return Object.freeze(out as TuiConfig);
}

export function validateBufferConfig(raw: unknown): BufferConfig | undefined {
  if (raw === undefined) return undefined;
  const makeError: InvalidConfigFactory = (field, detail) =>
    new InvalidBufferConfigError(field, detail);
  const record = requirePlainObject(raw, "", makeError);
  rejectUnknownFields(
    record,
    new Set(["provider", "show_tabs", "neovim", "prediction"]),
    makeError,
  );
  const out: { -readonly [K in keyof BufferConfig]: BufferConfig[K] } = {};
  if (record.provider !== undefined) {
    if (
      record.provider !== "auto" &&
      record.provider !== "neovim" &&
      record.provider !== "inline" &&
      record.provider !== "external"
    ) {
      throw makeError(
        "provider",
        'expected "auto", "neovim", "inline", or "external"',
      );
    }
    out.provider = record.provider;
  }
  if (record.show_tabs !== undefined) {
    if (
      record.show_tabs !== "auto" &&
      record.show_tabs !== "always" &&
      record.show_tabs !== "never"
    ) {
      throw makeError("show_tabs", 'expected "auto", "always", or "never"');
    }
    out.show_tabs = record.show_tabs;
  }
  if (record.neovim !== undefined) {
    const neovim = requirePlainObject(record.neovim, "neovim", makeError);
    rejectUnknownFields(
      neovim,
      new Set([
        "executable",
        "init",
        "discovery_timeout_ms",
        "startup_timeout_ms",
        "operation_timeout_ms",
        "cleanup_timeout_ms",
      ]),
      makeError,
      "neovim",
    );
    const validated: {
      -readonly [K in keyof BufferNeovimConfig]: BufferNeovimConfig[K];
    } = {};
    const executable = optionalString(
      neovim.executable,
      "neovim.executable",
      makeError,
    );
    if (executable !== undefined) {
      if (executable.trim().length === 0) {
        throw makeError("neovim.executable", "expected non-empty string");
      }
      validated.executable = executable;
    }
    if (neovim.init !== undefined) {
      if (
        neovim.init !== "auto" &&
        neovim.init !== "user" &&
        neovim.init !== "clean"
      ) {
        throw makeError("neovim.init", 'expected "auto", "user", or "clean"');
      }
      validated.init = neovim.init;
    }
    for (const key of [
      "discovery_timeout_ms",
      "startup_timeout_ms",
      "operation_timeout_ms",
      "cleanup_timeout_ms",
    ] as const) {
      const value = optionalPositiveInteger(
        neovim[key],
        `neovim.${key}`,
        makeError,
      );
      if (value !== undefined) validated[key] = value;
    }
    out.neovim = Object.freeze(validated as BufferNeovimConfig);
  }
  if (record.prediction !== undefined) {
    const prediction = requirePlainObject(
      record.prediction,
      "prediction",
      makeError,
    );
    rejectUnknownFields(
      prediction,
      new Set([
        "enabled",
        "debounce_ms",
        "timeout_ms",
        "max_output_tokens",
        "provider",
        "model",
      ]),
      makeError,
      "prediction",
    );
    const validated: {
      -readonly [K in keyof BufferPredictionConfig]: BufferPredictionConfig[K];
    } = {};
    if (prediction.enabled !== undefined) {
      if (
        prediction.enabled !== "ask" &&
        prediction.enabled !== "on" &&
        prediction.enabled !== "off"
      ) {
        throw makeError("prediction.enabled", 'expected "ask", "on", or "off"');
      }
      validated.enabled = prediction.enabled;
    }
    const debounceMs = optionalPositiveInteger(
      prediction.debounce_ms,
      "prediction.debounce_ms",
      makeError,
    );
    if (debounceMs !== undefined) {
      if (debounceMs < 25 || debounceMs > 5_000) {
        throw makeError(
          "prediction.debounce_ms",
          "expected integer between 25 and 5000",
        );
      }
      validated.debounce_ms = debounceMs;
    }
    const timeoutMs = optionalPositiveInteger(
      prediction.timeout_ms,
      "prediction.timeout_ms",
      makeError,
    );
    if (timeoutMs !== undefined) {
      if (timeoutMs < 100 || timeoutMs > 30_000) {
        throw makeError(
          "prediction.timeout_ms",
          "expected integer between 100 and 30000",
        );
      }
      validated.timeout_ms = timeoutMs;
    }
    const maxOutputTokens = optionalPositiveInteger(
      prediction.max_output_tokens,
      "prediction.max_output_tokens",
      makeError,
    );
    if (maxOutputTokens !== undefined) {
      if (maxOutputTokens > 2_048) {
        throw makeError(
          "prediction.max_output_tokens",
          "expected integer between 1 and 2048",
        );
      }
      validated.max_output_tokens = maxOutputTokens;
    }
    for (const key of ["provider", "model"] as const) {
      const value = optionalString(
        prediction[key],
        `prediction.${key}`,
        makeError,
      );
      if (value !== undefined) {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          throw makeError(`prediction.${key}`, "expected non-empty string");
        }
        validated[key] = trimmed;
      }
    }
    out.prediction = Object.freeze(validated as BufferPredictionConfig);
  }
  return Object.freeze(out as BufferConfig);
}

export class InvalidBrowserConfigError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Invalid browser.${field}: ${detail}`);
    this.name = "InvalidBrowserConfigError";
    this.field = field;
  }
}

/**
 * Validate the `[browser]` block. Reject non-boolean security toggles so a
 * mistyped `allow_private_network = "off"` cannot survive as a truthy string
 * and silently disable SSRF private-network blocking (see `browser/config.ts`).
 */
export function validateBrowserConfig(raw: unknown): BrowserConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidBrowserConfigError("", "expected plain object");
  }
  rejectUnknownFields(
    raw,
    new Set([
      "executable_path",
      "headless",
      "allow_private_network",
      "profile_dir",
      "no_sandbox",
      "navigation_timeout_ms",
    ]),
    (field, detail) => new InvalidBrowserConfigError(field, detail),
  );
  const out: { -readonly [K in keyof BrowserConfig]: BrowserConfig[K] } = {};
  for (const key of [
    "headless",
    "allow_private_network",
    "no_sandbox",
  ] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") {
        throw new InvalidBrowserConfigError(key, "expected boolean");
      }
      out[key] = raw[key];
    }
  }
  for (const key of ["executable_path", "profile_dir"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string") {
        throw new InvalidBrowserConfigError(key, "expected string");
      }
      out[key] = raw[key];
    }
  }
  if (raw.navigation_timeout_ms !== undefined) {
    if (
      typeof raw.navigation_timeout_ms !== "number" ||
      !Number.isInteger(raw.navigation_timeout_ms) ||
      raw.navigation_timeout_ms <= 0
    ) {
      throw new InvalidBrowserConfigError(
        "navigation_timeout_ms",
        "expected positive integer",
      );
    }
    out.navigation_timeout_ms = raw.navigation_timeout_ms;
  }
  return Object.freeze(out as BrowserConfig);
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
    (USER_ADDRESSABLE_PERMISSION_MODES as readonly string[]).includes(value)
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

function validatePermissionRuleArray(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  const rules = validateStringArray(value, field);
  if (rules === undefined) return undefined;
  for (const rule of rules) {
    const toolName = parseRuleString(rule)?.toolName ?? rule;
    if (isRemovedLiveToolName(toolName)) {
      throw new InvalidPermissionsConfigError(
        field,
        `removed tool name '${toolName}'; run agenc config migrate`,
      );
    }
  }
  return rules;
}

/**
 * Validate a raw canonical TOML `permissions` block and return a frozen
 * `PermissionsConfig`. Returns
 * `undefined` for `undefined` input. Throws
 * `InvalidPermissionsConfigError` on shape violations (wrong types,
 * unknown mode literal, etc.).
 *
 * Unknown sub-fields fail closed. If a new key is added to
 * `PermissionsConfig`, it must be wired through here too.
 */
export function validatePermissionsConfig(
  raw: unknown,
): PermissionsConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidPermissionsConfigError("", "expected plain object");
  }
  rejectUnknownFields(
    raw,
    new Set([
      "allow",
      "deny",
      "ask",
      "additionalDirectories",
      "defaultMode",
      "bypassPermissionsMode",
    ]),
    (field, detail) => new InvalidPermissionsConfigError(field, detail),
  );

  const out: {
    -readonly [K in keyof PermissionsConfig]: PermissionsConfig[K];
  } = {};

  const allow = validatePermissionRuleArray(raw.allow, "allow");
  if (allow !== undefined) out.allow = allow;
  const deny = validatePermissionRuleArray(raw.deny, "deny");
  if (deny !== undefined) out.deny = deny;
  const ask = validatePermissionRuleArray(raw.ask, "ask");
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

  if (raw.bypassPermissionsMode !== undefined) {
    if (
      raw.bypassPermissionsMode !== "allow" &&
      raw.bypassPermissionsMode !== "disable"
    ) {
      throw new InvalidPermissionsConfigError(
        "bypassPermissionsMode",
        'expected "allow" or "disable"',
      );
    }
    out.bypassPermissionsMode = raw.bypassPermissionsMode;
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

/**
 * Validate a raw executable `statusLine` block from canonical TOML.
 * Returns `undefined` for `undefined` input. Throws
 * {@link InvalidStatusLineConfigError} on shape violations.
 *
 * Unknown sub-fields are rejected so this command-bearing surface cannot
 * acquire implicit behavior.
 */
export function validateStatusLineConfig(
  raw: unknown,
): StatusLineConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new InvalidStatusLineConfigError("", "expected plain object");
  }

  rejectUnknownFields(
    raw,
    new Set(["type", "command", "padding"]),
    (field, detail) => new InvalidStatusLineConfigError(field, detail),
  );
  if (raw.type !== "command") {
    throw new InvalidStatusLineConfigError("type", 'expected "command"');
  }
  if (typeof raw.command !== "string" || raw.command.length === 0) {
    throw new InvalidStatusLineConfigError("command", "expected non-empty string");
  }
  if (
    raw.padding !== undefined &&
    (typeof raw.padding !== "number" || !Number.isFinite(raw.padding))
  ) {
    throw new InvalidStatusLineConfigError("padding", "expected finite number");
  }
  return Object.freeze({
    type: "command",
    command: raw.command,
    ...(raw.padding !== undefined ? { padding: raw.padding } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Hooks block validation
// ─────────────────────────────────────────────────────────────────────

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
  rejectUnknownFields(
    raw,
    new Set(["type", "command", "timeout_ms", "enabled", "statusMessage"]),
    (path, detail) => new InvalidHooksConfigError(path, detail),
    field,
  );
  if (raw.type !== "command") {
    throw new InvalidHooksConfigError(`${field}.type`, 'expected "command"');
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
    (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0)
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
  rejectUnknownFields(
    raw,
    new Set(["matcher", "enabled", "hooks"]),
    (path, detail) => new InvalidHooksConfigError(path, detail),
    field,
  );
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
    if (!(HOOK_EVENT_NAMES as readonly string[]).includes(eventKey)) {
      throw new InvalidHooksConfigError(
        eventKey,
        `unsupported event; expected one of ${HOOK_EVENT_NAMES.join(", ")}`,
      );
    }
    const eventName = eventKey as HookEventName;
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

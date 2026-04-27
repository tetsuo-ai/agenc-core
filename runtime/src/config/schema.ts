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

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

export type Personality = "default" | "concise" | "careful" | "fast";

export type WebSearchMode = "auto" | "always" | "never";

export type ModelVerbosity = "low" | "medium" | "high";

export type ServiceTier = "fast" | "flex";

export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

/**
 * Permission mode variants accepted by the runtime. Mirrors the
 * `PermissionMode` union in `src/permissions/types.ts` — kept inline here
 * to avoid a `config → permissions → config` import cycle (permissions
 * settings.ts already depends on `config/schema.ts`).
 *
 * If a variant is ever added or removed in `src/permissions/types.ts`,
 * update this union in lockstep.
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

export interface ShellEnvironmentPolicy {
  readonly inherit?: "all" | "core" | "none";
  readonly ignore_default_excludes?: boolean;
  readonly exclude?: readonly string[];
  readonly set?: Readonly<Record<string, string>>;
  readonly include_only?: readonly string[];
}

export interface ToolsConfig {
  readonly web_search?: boolean;
  readonly view_image?: boolean;
  readonly [k: string]: unknown;
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
  "SessionStart",
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

export type McpTransport = "stdio" | "sse" | "http";

export interface McpServerConfig {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly transport?: McpTransport;
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
  readonly timeout?: number;
  readonly required?: boolean;
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

/**
 * Permissions block as it appears in `~/.agenc/config.toml` (or any
 * settings.json the loader folds in). Mirrors the subset of
 * `SettingsPermissionsBlock` in `src/permissions/settings.ts` that is
 * surfaced through the top-level AgenC config.
 *
 * Rule arrays (`allow` / `deny` / `ask`) carry rule strings in the
 * `Tool(filter)` or bare `Tool` form parsed by
 * `src/permissions/rules.ts::parseRuleString`. `defaultMode` accepts any
 * variant of the `PermissionMode` union.
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
 * TODO T11-closeout: reconcile ConfigStore.permissions vs settings-file
 * permissions precedence (evaluator currently prefers settings-file
 * sources; top-level config block is reserved for overlays).
 */
export interface PermissionsConfig {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly additionalDirectories?: readonly string[];
  readonly defaultMode?: PermissionMode;
}

export interface ProviderCapabilityOverrides {
  readonly supportsPromptCaching?: boolean;
  readonly supportsContextEdits?: boolean;
  readonly supportsImageInput?: boolean;
  readonly supportsAudioInput?: boolean;
  readonly supportsAudioOutput?: boolean;
  readonly supportsExtendedThinking?: boolean;
  readonly acceptsImageHistory?: boolean;
  readonly acceptsAudioHistory?: boolean;
  readonly acceptsThinkingHistory?: boolean;
  readonly acceptsReasoningEffort?: boolean;
}

export interface ProviderConfig {
  readonly api_key_env?: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly context_window_tokens?: number;
  readonly max_output_tokens?: number;
  readonly capability_overrides?: ProviderCapabilityOverrides;
}

// ─────────────────────────────────────────────────────────────────────
// Canonical AgenCConfig
// ─────────────────────────────────────────────────────────────────────

export interface AgenCConfig {
  // ── Runtime fields ─────────────────────────────────────────────────
  readonly model?: string;
  readonly model_provider?: string;
  readonly approval_policy?: ApprovalPolicy;
  readonly sandbox_mode?: SandboxMode;
  readonly sandbox_policy?: SandboxPolicy;
  readonly shell_environment_policy?: ShellEnvironmentPolicy;
  readonly reasoning_effort?: ReasoningEffort;
  readonly reasoning_summary?: ReasoningSummary;
  readonly review_model?: string;
  readonly approvals_reviewer?: ApprovalsReviewer;
  readonly model_verbosity?: ModelVerbosity;
  readonly service_tier?: ServiceTier;
  readonly personality?: Personality;
  readonly agent_max_depth?: number;
  readonly profiles?: Readonly<Record<string, ProfileOverride>>;
  readonly providers?: Readonly<Record<string, ProviderConfig>>;
  readonly project_root_markers?: readonly string[];
  readonly project_doc_max_bytes?: number;
  readonly tools_config?: ToolsConfig;
  readonly compact_prompt?: string;
  readonly hooks?: HooksMap;
  readonly mcp_servers?: Readonly<Record<string, McpServerConfig>>;

  // ── Settings fields ────────────────────────────────────────────────
  readonly autoUpdates?: boolean;
  readonly bypassPermissionsModeAcceptedIn?: readonly string[];
  readonly experiments?: ExperimentsConfig;
  readonly ideConnector?: IdeConnectorConfig;
  readonly managedWorkspaces?: ManagedWorkspacesConfig;
  readonly permissions?: PermissionsConfig;
  readonly privateStorage?: PrivateStorageConfig;
  readonly statusLine?: PartialStatusLineConfig;
  readonly outputStyle?: PartialOutputStyleConfig;
  readonly attachments?: AttachmentsConfig;
  readonly telemetryOptIn?: boolean;

  // ── AgenC-specific additions ──────────────────────────────────────
  readonly toolBudget?: ToolBudget;
  readonly stream_watchdog_timeout_ms?: number;
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
 *   - otel             → T12 (OTel exporters — depends on observability)
 *   - plugins          → T11 (plugin loader)
 *   - history          → T11 (rollout/history retention policy)
 *   - log_dir          → T11 (operator-overridable log root)
 *   - file_opener      → T11 (editor integration)
 *   - analytics        → T12 (analytics opt-in knobs)
 *
 * Settings deferred:
 *   - env              → T11 (shell env injection policy)
 *   - apiKeyHelper     → T11 (external API-key resolver hook)
 *   - cleanupPeriodDays → T11 (rollout/history retention)
 *   - enabledPlugins   → T11 (plugin loader)
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
 * Adding one of these to the schema means: (a) add it to
 * `KNOWN_CONFIG_KEYS`, (b) add a typed field to `AgenCConfig`, (c)
 * extend the merge + env-override paths if it reaches the runtime,
 * (d) remove it from this block. Don't forget to drop the matching
 * `_unknown` test if the key is tested via `_unknown` today.
 */
export const DEFERRED_RUNTIME_KEYS: readonly string[] = Object.freeze([
  "notify",
  "otel",
  "plugins",
  "history",
  "log_dir",
  "file_opener",
  "analytics",
]);

export const DEFERRED_SETTINGS_KEYS: readonly string[] = Object.freeze([
  "env",
  "apiKeyHelper",
  "cleanupPeriodDays",
  "enabledPlugins",
]);

// Known top-level keys — anything else goes into `_unknown` (I-26).
// See DEFERRED_RUNTIME_KEYS / DEFERRED_SETTINGS_KEYS above for the list
// of keys intentionally absent from this array while their tranches
// catch up. Forward-compat: unknown keys land on `_unknown` rather than
// being dropped.
export const KNOWN_CONFIG_KEYS: readonly string[] = Object.freeze([
  "model",
  "model_provider",
  "approval_policy",
  "sandbox_mode",
  "sandbox_policy",
  "shell_environment_policy",
  "reasoning_effort",
  "reasoning_summary",
  "review_model",
  "approvals_reviewer",
  "model_verbosity",
  "service_tier",
  "personality",
  "agent_max_depth",
  "profiles",
  "providers",
  "project_root_markers",
  "project_doc_max_bytes",
  "tools_config",
  "compact_prompt",
  "hooks",
  "mcp_servers",
  "autoUpdates",
  "bypassPermissionsModeAcceptedIn",
  "experiments",
  "ideConnector",
  "managedWorkspaces",
  "permissions",
  "privateStorage",
  "statusLine",
  "outputStyle",
  "attachments",
  "telemetryOptIn",
  "toolBudget",
  "stream_watchdog_timeout_ms",
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
    model: "grok-4-fast",
    approval_policy: "on-request" as ApprovalPolicy,
    sandbox_mode: "workspace-write" as SandboxMode,
    reasoning_effort: "medium" as ReasoningEffort,
    approvals_reviewer: "user" as ApprovalsReviewer,
    personality: "default" as Personality,
    agent_max_depth: 1,
    project_root_markers: Object.freeze([
      ".git",
      "package.json",
      "Cargo.toml",
      "pyproject.toml",
    ]) as readonly string[],
    project_doc_max_bytes: 32_768,
    stream_watchdog_timeout_ms: 30_000,
    max_turns: 50,
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
  // agents.max_depth → agent_max_depth
  const agents = out.agents;
  if (
    typeof agents === "object" &&
    agents !== null &&
    !Array.isArray(agents)
  ) {
    const agentsObj = agents as Record<string, unknown>;
    if ("max_depth" in agentsObj && !("agent_max_depth" in out)) {
      out.agent_max_depth = agentsObj.max_depth;
    }
    // Drop the `agents` table if max_depth was the only thing we care about;
    // otherwise leave it for _unknown preservation.
    const remaining = { ...agentsObj };
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
 * Unknown sub-fields are silently dropped — the five keys declared on
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
    SessionStart: "SessionStart",
    sessionStart: "SessionStart",
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
    if (!providerModels) {
      throw new UnknownModelError(slug, providerIds);
    }
    if (!providerModels.includes(model)) {
      throw new UnknownModelError(slug, providerIds);
    }
    return Object.freeze({ provider, model });
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

// T10 Group D — AgenC config schema.
//
// Merges:
//   - codex `config_toml.rs` / `profile_toml.rs`
//   - openclaude `settings.json` subset
//   - AgenC additions (toolBudget, stream watchdog, agenc_home)
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
  readonly include_apply_patch?: boolean;
  readonly [k: string]: unknown;
}

export interface ProfileOverride {
  readonly model?: string;
  readonly model_provider?: string;
  readonly approval_policy?: ApprovalPolicy;
  readonly sandbox_mode?: SandboxMode;
  readonly reasoning_effort?: ReasoningEffort;
  readonly reasoning_summary?: ReasoningSummary;
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
}

export interface HookMatcher {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

export type HooksMap = Readonly<Record<string, readonly HookMatcher[]>>;

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

// ─────────────────────────────────────────────────────────────────────
// Canonical AgenCConfig
// ─────────────────────────────────────────────────────────────────────

export interface AgenCConfig {
  // ── Codex-rooted fields ────────────────────────────────────────────
  readonly model?: string;
  readonly model_provider?: string;
  readonly approval_policy?: ApprovalPolicy;
  readonly sandbox_mode?: SandboxMode;
  readonly sandbox_policy?: SandboxPolicy;
  readonly shell_environment_policy?: ShellEnvironmentPolicy;
  readonly reasoning_effort?: ReasoningEffort;
  readonly reasoning_summary?: ReasoningSummary;
  readonly personality?: Personality;
  readonly agent_max_depth?: number;
  readonly profiles?: Readonly<Record<string, ProfileOverride>>;
  readonly project_root_markers?: readonly string[];
  readonly project_doc_max_bytes?: number;
  readonly tools_config?: ToolsConfig;
  readonly compact_prompt?: string;
  readonly hooks?: HooksMap;
  readonly mcp_servers?: Readonly<Record<string, McpServerConfig>>;

  // ── Openclaude-rooted fields ──────────────────────────────────────
  readonly autoUpdates?: boolean;
  readonly bypassPermissionsModeAcceptedIn?: readonly string[];
  readonly experiments?: ExperimentsConfig;
  readonly ideConnector?: IdeConnectorConfig;
  readonly managedWorkspaces?: ManagedWorkspacesConfig;
  readonly privateStorage?: PrivateStorageConfig;
  readonly telemetryOptIn?: boolean;

  // ── AgenC-specific additions ──────────────────────────────────────
  readonly toolBudget?: ToolBudget;
  readonly stream_watchdog_timeout_ms?: number;
  readonly max_turns?: number;
  readonly agenc_home?: string;
  readonly workspace?: string;
  readonly simpleMode?: boolean;

  // ── Forward-compat side-table ─────────────────────────────────────
  readonly _unknown?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────
// defaultConfig
// ─────────────────────────────────────────────────────────────────────

// Known top-level keys — anything else goes into `_unknown` (I-26).
export const KNOWN_CONFIG_KEYS: readonly string[] = Object.freeze([
  "model",
  "model_provider",
  "approval_policy",
  "sandbox_mode",
  "sandbox_policy",
  "shell_environment_policy",
  "reasoning_effort",
  "reasoning_summary",
  "personality",
  "agent_max_depth",
  "profiles",
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
  "privateStorage",
  "telemetryOptIn",
  "toolBudget",
  "stream_watchdog_timeout_ms",
  "max_turns",
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
// Codex TOML alias normalization
// ─────────────────────────────────────────────────────────────────────

// Codex TOML uses some field names that differ from AgenC canonical keys.
// This mapping lets users drop a codex config.toml unchanged and have it
// work. Aliases are applied BEFORE `normalizeRawConfig` so renamed fields
// land on the `KNOWN_CONFIG_KEYS` fast path instead of `_unknown`.
const CODEX_TOP_LEVEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  tools: "tools_config",
  model_reasoning_effort: "reasoning_effort",
  model_reasoning_summary: "reasoning_summary",
});

/**
 * Remap codex-style TOML keys onto canonical AgenC keys.
 *
 * Rules:
 * - Top-level aliases from `CODEX_TOP_LEVEL_ALIASES` are renamed; if the
 *   canonical key is also present, the canonical key wins and the alias is
 *   dropped (forward-compat for mixed configs).
 * - `agents.max_depth` → `agent_max_depth` (codex nests this).
 *
 * The returned object is a shallow copy; nested values are passed through
 * by reference. Callers should not mutate `raw` after calling.
 */
export function normalizeCodexKeyAliases(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [alias, canonical] of Object.entries(CODEX_TOP_LEVEL_ALIASES)) {
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
  constructor(slug: string) {
    super(`Unknown model slug "${slug}" — no provider advertises this model`);
    this.name = "UnknownModelError";
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
  // Explicit "provider:model" form.
  const colonIdx = slug.indexOf(":");
  if (colonIdx > 0) {
    const provider = slug.slice(0, colonIdx);
    const model = slug.slice(colonIdx + 1);
    const providerModels = providerCatalog[provider];
    if (!providerModels) {
      throw new UnknownModelError(slug);
    }
    if (!providerModels.includes(model)) {
      throw new UnknownModelError(slug);
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
    throw new UnknownModelError(slug);
  }
  if (candidates.length >= 2) {
    throw new AmbiguousModelError(slug, candidates);
  }
  return Object.freeze(candidates[0]!);
}

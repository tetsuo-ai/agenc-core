/**
 * Agent roles — built-in + user-configurable.
 *
 * Subset port of codex `core/src/agent/role.rs`. Ports:
 *   - Role enum + nickname allocation (Wave 1).
 *   - Config-layer stack (`applyRoleToConfig`, `buildConfigLayerStack`,
 *     `resolveRoleConfig`, `formatRoleList`) (Wave 3).
 *
 * Deferred: TOML role-layer loading (T10 config loader). The
 * `loadRoleLayerToml` function here is a stub that returns `{}`; T10
 * will replace it with real filesystem + parse logic mirroring codex
 * `role.rs:87-119`.
 *
 * AgenC divergences from codex upstream:
 *
 *   - Awaiter kept active. Codex has `awaiter` commented out at
 *     `role.rs:398-414` ("awaiter is temp removed"). AgenC keeps it
 *     because the MCP + long-running tool-poll use case needs a
 *     background polling role.
 *   - Deterministic nickname ordering. Codex shuffles candidates with
 *     `rand::rng()`; AgenC cycles in declaration order so spawn tests
 *     stay reproducible and allocation-collision tests don't flake.
 *   - Registry-as-single-nickname-source. AgenC's `AgentRegistry`
 *     owns nickname bookkeeping, not a process-global pool; free
 *     functions here are thin delegators.
 *   - Config-layer stack is pure shallow-merge, not codex's
 *     `ConfigLayerStack`-with-profile-resolution. Codex layers TOML
 *     documents through `deserialize_config_toml_with_base` and
 *     re-runs `Config::load_config_with_layer_stack` with provider
 *     preservation; AgenC only models the `base → role → user`
 *     precedence needed to project role overrides
 *     (reasoningEffort, allowlist, timeoutMs, background, maxDepth,
 *     description) onto a `SessionConfiguration`-shaped blob. T10
 *     replaces this with the real config-layer machinery when the
 *     config loader lands.
 *
 * Built-in roles:
 *   - `default`  — unrestricted; inherits parent config
 *   - `explorer` — codebase queries; low reasoning; read-only tool set
 *   - `worker`   — execution/production work; medium reasoning;
 *                  inherits parent tool catalog (mirrors codex
 *                  `agent/role.rs:383` `worker` entry)
 *   - `awaiter`  — long-running polling (3600s timeout, low reasoning)
 *
 * User roles register via `registerAgentRole({ name, config })` and
 * override the built-ins.
 *
 * @module
 */

import type { AgentRegistry } from "./registry.js";

export type AgentReasoningEffort = "none" | "low" | "medium" | "high";

export interface AgentRoleConfig {
  readonly description?: string;
  /** Path to a TOML/JSON config this role embeds. T10 wires the
   *  config loader; today the bundle is passed inline. */
  readonly configBundle?: Record<string, unknown>;
  /** Candidate nicknames for this role; registry picks one on spawn. */
  readonly nicknameCandidates?: ReadonlyArray<string>;
  /** Per-turn timeout in ms. Default inherits parent. */
  readonly timeoutMs?: number;
  /** Reasoning effort override. */
  readonly reasoningEffort?: AgentReasoningEffort;
  /** Optional tool allowlist — when present, the child sees ONLY
   *  these tools regardless of the parent's catalog. */
  readonly allowlist?: ReadonlyArray<string>;
  /** Whether this role runs synchronously (parent blocks) or async
   *  (parent registers + continues). */
  readonly background?: boolean;
  /** Max recursion depth override. Uses codex `>=` semantics: the
   *  cap is the smallest rejected childDepth. Defaults to
   *  `MAX_AGENT_DEPTH` (=4 unless overridden by
   *  `AGENC_AGENT_MAX_DEPTH`). */
  readonly maxDepth?: number;
}

export interface AgentRole {
  readonly name: string;
  readonly config: AgentRoleConfig;
}

// ─────────────────────────────────────────────────────────────────────
// Built-in roles
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_ROLE: AgentRole = Object.freeze({
  name: "default",
  config: {
    description: "Unrestricted subagent inheriting parent tools + config.",
    nicknameCandidates: [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
    ],
  },
});

const EXPLORER_ROLE: AgentRole = Object.freeze<AgentRole>({
  name: "explorer",
  config: {
    description:
      "Fast codebase exploration — read-only tools, low-to-medium reasoning.",
    reasoningEffort: "low" as const,
    allowlist: [
      "system.readFile",
      "system.listDir",
      "system.stat",
      "system.glob",
      "system.grep",
      "system.findFiles",
      "http.fetch",
    ],
    nicknameCandidates: ["scout", "ranger", "pathfinder", "seeker"],
  },
});

const WORKER_ROLE: AgentRole = Object.freeze<AgentRole>({
  name: "worker",
  config: {
    description:
      "Execution/production work — implement features, fix tests/bugs, " +
      "split large refactors. Inherits the parent tool catalog.",
    reasoningEffort: "medium" as const,
    nicknameCandidates: ["builder", "smith", "forge", "weaver"],
  },
});

const AWAITER_ROLE: AgentRole = Object.freeze<AgentRole>({
  name: "awaiter",
  config: {
    description: "Long-running polling subagent; low reasoning.",
    reasoningEffort: "low" as const,
    timeoutMs: 3_600_000,
    background: true,
    nicknameCandidates: ["sentinel", "watcher", "guardian", "keeper"],
  },
});

const BUILT_INS: ReadonlyArray<AgentRole> = Object.freeze([
  DEFAULT_ROLE,
  EXPLORER_ROLE,
  WORKER_ROLE,
  AWAITER_ROLE,
]);

// ─────────────────────────────────────────────────────────────────────
// Role registry (process-level)
// ─────────────────────────────────────────────────────────────────────

const registry = new Map<string, AgentRole>();
for (const role of BUILT_INS) registry.set(role.name, role);

export function registerAgentRole(role: AgentRole): void {
  registry.set(role.name, role);
}

export function getAgentRole(name: string): AgentRole | undefined {
  return registry.get(name);
}

export function getDefaultAgentRole(): AgentRole {
  return DEFAULT_ROLE;
}

export function listAgentRoles(): ReadonlyArray<AgentRole> {
  return Array.from(registry.values());
}

export function resolveAgentRole(name: string | undefined): AgentRole {
  if (!name) return DEFAULT_ROLE;
  return registry.get(name) ?? DEFAULT_ROLE;
}

/**
 * Strict role-config lookup. Mirrors codex `resolve_role_config`
 * (`role.rs:121`). Returns the `AgentRoleConfig` for a named role or
 * `undefined` when the role is unknown — the caller is expected to
 * surface the error. Contrast with `resolveAgentRole`, which falls
 * back to the default role for convenience.
 */
export function tryResolveRoleConfig(
  name: string | undefined,
): AgentRoleConfig | undefined {
  if (!name) return undefined;
  return registry.get(name)?.config;
}

// ─────────────────────────────────────────────────────────────────────
// Nickname allocation
//
// Nicknames are owned by the AgentRegistry — the registry is the
// spawn-slot authority, and nicknames live for the same lifetime as
// spawn slots. `allocateNickname`/`releaseNickname` are thin
// delegators that route into the registry's internal pool so there
// is exactly one source of truth for live nicknames.
// ─────────────────────────────────────────────────────────────────────

/**
 * Allocate a nickname for a fresh subagent. On collision, cycles
 * through the candidate list + appends an ordinal suffix
 * ("scout the 2nd"). Mirrors codex `registry.rs::format_agent_nickname`
 * except for nickname ordering (see module-level divergence note).
 */
export function allocateNickname(
  role: AgentRole,
  registry: AgentRegistry,
): string {
  return registry.allocateNickname(role);
}

export function releaseNickname(
  registry: AgentRegistry,
  nickname: string,
): void {
  registry.releaseNickname(nickname);
}

/**
 * Reset the nickname pool for tests.
 *
 * After the registry took ownership of nickname bookkeeping, each
 * test that spins up a fresh `AgentRegistry` already gets a fresh
 * pool. This shim is kept as a no-op so existing tests that call
 * it during setup/teardown continue to compile without touching
 * unrelated test files.
 */
export function _resetNicknamePoolForTesting(): void {
  // No-op: per-registry pools make this reset unnecessary. The hook
  // is preserved so existing test setup/teardown does not break.
}

export function formatNicknameWithSuffix(
  name: string,
  resetCount: number,
): string {
  const value = resetCount + 1;
  const mod100 = value % 100;
  let suffix = "th";
  if (mod100 < 11 || mod100 > 13) {
    switch (value % 10) {
      case 1:
        suffix = "st";
        break;
      case 2:
        suffix = "nd";
        break;
      case 3:
        suffix = "rd";
        break;
      default:
        suffix = "th";
    }
  }
  return `${name} the ${value}${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────
// Config-layer stack (Wave 3 port of codex role.rs:40-270)
//
// Codex layers TOML documents: `base → role-layer → user-layer` with
// provider/profile preservation (`role.rs:131`). AgenC models the
// same precedence as pure shallow merges over a plain object blob so
// `control.ts spawn()` can materialize a child's effective config
// without waiting for T10's real config loader.
//
// The role override projection is intentionally explicit: each field
// in `AgentRoleConfig` that can legitimately rewrite a session's
// effective config is listed by name. Unlisted fields
// (`description`, `nicknameCandidates`, `configBundle`) are metadata
// and do not flow into the config blob.
// ─────────────────────────────────────────────────────────────────────

/**
 * Fields of `AgentRoleConfig` that project into the effective config
 * blob. Kept as an explicit union so adding a new role override
 * requires updating this list + the projector in one place.
 */
const ROLE_CONFIG_OVERRIDE_KEYS = [
  "reasoningEffort",
  "allowlist",
  "timeoutMs",
  "background",
  "maxDepth",
  "description",
] as const;

type RoleConfigOverrideKey = (typeof ROLE_CONFIG_OVERRIDE_KEYS)[number];

/**
 * Role-shaped subset of the effective config blob. Pure-ported from
 * codex `role.rs` — the real `SessionConfiguration` is richer
 * (sandbox, approval, provider, …), but the layered fields this
 * module owns are the role-override fields only. A blob that already
 * carries other session-config keys passes through untouched.
 */
export interface RoleShapedConfig {
  reasoningEffort?: AgentReasoningEffort;
  allowlist?: ReadonlyArray<string>;
  timeoutMs?: number;
  background?: boolean;
  maxDepth?: number;
  description?: string;
  /** Arbitrary sibling fields from the base/user layer flow through. */
  [extra: string]: unknown;
}

/**
 * Project the role override fields onto a base config blob. Mirrors
 * codex `apply_role_to_config` (`role.rs:40`). Pure: returns a new
 * object, never mutates `base`.
 *
 * Divergence from codex: codex rebuilds the full `Config` through
 * `ConfigLayerStack` and preserves the caller's profile/provider
 * unless the role explicitly rewrites them. AgenC's layer is a
 * shallow overlay; provider/profile preservation will move here when
 * T10 wires the real config loader.
 */
export function applyRoleToConfig<Base extends RoleShapedConfig>(
  role: AgentRole,
  base: Base,
): Base {
  return applyRoleToConfigInner(role.config, base, /*userLayer*/ {});
}

/**
 * Internal layered application. Base < role < user, with one
 * exception: fields listed in `preservationPolicy` keep the base
 * value regardless of later layers. Mirrors
 * codex `apply_role_to_config_inner` (`role.rs:58`) +
 * `preservation_policy` (`role.rs:131`).
 */
function applyRoleToConfigInner<Base extends RoleShapedConfig>(
  roleConfig: AgentRoleConfig,
  base: Base,
  userLayer: Partial<RoleShapedConfig>,
  preservationPolicy: ReadonlySet<RoleConfigOverrideKey> = new Set(),
): Base {
  // Start from a shallow copy of base so sibling fields pass through.
  const next: RoleShapedConfig = { ...base };

  for (const key of ROLE_CONFIG_OVERRIDE_KEYS) {
    if (preservationPolicy.has(key)) continue;
    const roleValue = roleConfig[key as keyof AgentRoleConfig];
    if (roleValue !== undefined) {
      (next as Record<string, unknown>)[key] = roleValue;
    }
  }

  // User layer always wins over role layer for non-preserved fields.
  for (const key of ROLE_CONFIG_OVERRIDE_KEYS) {
    if (preservationPolicy.has(key)) continue;
    const userValue = userLayer[key];
    if (userValue !== undefined) {
      (next as Record<string, unknown>)[key] = userValue;
    }
  }

  return next as Base;
}

/**
 * TOML role-layer loader stub.
 *
 * TODO(T10): Replace with the real config loader. Codex
 * (`role.rs:87-119`) reads the role's `config_file`, parses the TOML,
 * and deserializes it under the codex-home base. AgenC will wire
 * this once T10's config loader + role-layer registration lands.
 * Returning `{}` today keeps the call sites honest without pulling
 * in a half-baked TOML parse.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function loadRoleLayerToml(_role: AgentRole): Record<string, unknown> {
  return {};
}

/**
 * Build the layered effective config. Mirrors codex
 * `build_config_layer_stack` + `build_next_config` +
 * `deserialize_effective_config` (`role.rs:155-270`) collapsed into a
 * single pure function.
 *
 * Precedence: `base → role → user`. `preservationPolicy` names
 * fields that must keep the base value even if the role/user layers
 * try to rewrite them (codex uses this for profile/provider
 * stickiness).
 *
 * Returns a fresh object; inputs are never mutated.
 */
export function buildConfigLayerStack<Base extends RoleShapedConfig>(opts: {
  readonly base: Base;
  readonly roleName?: string;
  readonly userLayer?: Partial<RoleShapedConfig>;
  readonly preservationPolicy?: ReadonlySet<RoleConfigOverrideKey>;
}): Base {
  const { base, roleName, userLayer = {}, preservationPolicy } = opts;
  // Strict resolution: an unknown role name yields the base blob
  // unchanged overlaid only with the user layer. This matches codex's
  // `resolve_role_config` returning `None` for unknown roles.
  const roleConfig = tryResolveRoleConfig(roleName);
  if (!roleConfig) {
    return applyRoleToConfigInner(
      { } as AgentRoleConfig,
      base,
      userLayer,
      preservationPolicy,
    );
  }
  return applyRoleToConfigInner(
    roleConfig,
    base,
    userLayer,
    preservationPolicy,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Role-list prompt formatter (Wave 3 port of codex role.rs:280-309)
// ─────────────────────────────────────────────────────────────────────

/**
 * Format a known-roles list for injection into the spawn-agent tool
 * description. Mirrors codex `spawn_tool_spec::build` +
 * `build_from_configs` + `format_role` (`role.rs:280-309`).
 *
 * Roles missing a `description` are rendered as `name: no description`
 * so the list still announces them.
 */
export function formatRoleList(roles: ReadonlyArray<AgentRole>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const role of roles) {
    if (seen.has(role.name)) continue;
    seen.add(role.name);
    lines.push(formatRole(role));
  }
  return [
    `Optional type name for the new agent. If omitted, \`${DEFAULT_ROLE.name}\` is used.`,
    "Available roles:",
    ...lines,
  ].join("\n");
}

function formatRole(role: AgentRole): string {
  const { description } = role.config;
  if (!description) return `${role.name}: no description`;
  // One-line capability hint drawn from the projected override fields
  // so callers see at a glance what a role locks in. Codex embeds a
  // model/reasoning hint read from the role's TOML; AgenC projects
  // from the already-resolved role config.
  const hints: string[] = [];
  if (role.config.reasoningEffort) {
    hints.push(`reasoning=${role.config.reasoningEffort}`);
  }
  if (role.config.allowlist && role.config.allowlist.length > 0) {
    hints.push(`allowlist=${role.config.allowlist.length} tools`);
  }
  if (role.config.timeoutMs) {
    hints.push(`timeout=${role.config.timeoutMs}ms`);
  }
  if (role.config.background) hints.push("background");
  const hintLine = hints.length > 0 ? `\n- ${hints.join(", ")}` : "";
  return `${role.name}: {\n${description}${hintLine}\n}`;
}

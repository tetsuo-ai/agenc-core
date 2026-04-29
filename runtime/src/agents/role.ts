/**
 * Agent roles — built-in + user-configurable.
 *
 * Subset port of Codex runtime `core/src/agent/role.rs`. Ports:
 *   - Role enum + nickname allocation (Wave 1).
 *   - Role/config loading (`loadRoleLayerToml`, `applyRoleToConfig`,
 *     `buildConfigLayerStack`, `formatRoleList`) (Wave 3).
 *
 * TypeScript port notes:
 *
 *   - Registry-as-single-nickname-source. AgenC's `AgentRegistry`
 *     owns nickname bookkeeping, not a process-global pool; free
 *     functions here are thin delegators.
 *   - Role TOML is parsed through AgenC's config loader primitives, but
 *     this module still cannot rebuild a live `SessionConfiguration`
 *     or provider object because the child-session config source is
 *     not wired yet. The layering here preserves `base → role → user`
 *     precedence and profile selection, but it does not recreate
 *     AgenC runtime's full `ConfigLayerStack` / provider-preservation reload.
 *
 * Built-in roles:
 *   - `default`  — unrestricted; inherits parent config
 *   - `explorer` — codebase queries; loads Codex runtime's built-in
 *                  `explorer.toml` role layer
 *   - `worker`   — execution/production work; inherits parent tool
 *                  catalog (mirrors Codex runtime `agent/role.rs:383`
 *                  `worker` entry)
 *
 * User roles register via `registerAgentRole({ name, config })` and
 * override the built-ins.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import type { AgentRegistry } from "./registry.js";
import {
  normalizeAgenCKeyAliases,
  normalizeRawConfig,
  parseToml,
  resolveProfile,
  type AgenCConfig,
} from "../config/index.js";
import { normalizeExternalText } from "./_deps/file-read.js";

export type AgentReasoningEffort = "none" | "low" | "medium" | "high";

export interface AgentRoleConfig {
  readonly description?: string;
  /** AgenC-shaped role layer file. Built-ins resolve against embedded
   *  TOML content; user-defined roles read the path from disk. */
  readonly configFile?: string;
  /** Inline TOML role layer. Useful for tests and bootstrap-time
   *  in-memory role registration. */
  readonly configToml?: string;
  /** Legacy inline parsed config object. Prefer `configToml` or
   *  `configFile` for AgenC behavior. */
  readonly configBundle?: Record<string, unknown>;
  /** Candidate nicknames for this role; registry picks one on spawn. */
  readonly nicknameCandidates?: ReadonlyArray<string>;
  /** Runtime hint derived from the loaded role layer when possible. */
  readonly timeoutMs?: number;
  /** Runtime hint derived from the loaded role layer when possible. */
  readonly reasoningEffort?: AgentReasoningEffort;
  /** Optional explicit tool allowlist. This is runtime metadata, not a
   *  AgenC runtime role-layer config field. */
  readonly allowlist?: ReadonlyArray<string>;
  /** Optional system prompt prepended to child-agent history. */
  readonly systemPrompt?: string;
  /** Whether this role runs synchronously (parent blocks) or async
   *  (parent registers + continues). */
  readonly background?: boolean;
  /** Runtime hint derived from the loaded role layer when possible. */
  readonly maxDepth?: number;
}

export interface AgentRole {
  readonly name: string;
  readonly config: AgentRoleConfig;
}

const BUILT_IN_ROLE_CONFIG_TOML = Object.freeze({
  "explorer.toml": "",
  // Codex keeps awaiter temporarily removed from the built-in role set, but
  // still exposes the embedded role file for user-defined roles that reference
  // `awaiter.toml`.
  "awaiter.toml": `background_terminal_max_timeout = 3600000
model_reasoning_effort = "low"`,
} as const);

const ROLE_DECLARATION_METADATA_KEYS = Object.freeze([
  "name",
  "description",
  "nickname_candidates",
  "developer_instructions",
] as const);

const DEFAULT_AGENT_NICKNAME_CANDIDATES = Object.freeze([
  "Euclid",
  "Archimedes",
  "Ptolemy",
  "Hypatia",
  "Avicenna",
  "Averroes",
  "Aquinas",
  "Copernicus",
  "Kepler",
  "Galileo",
  "Bacon",
  "Descartes",
  "Pascal",
  "Fermat",
  "Huygens",
  "Leibniz",
  "Newton",
  "Halley",
  "Euler",
  "Lagrange",
  "Laplace",
  "Volta",
  "Gauss",
  "Ampere",
  "Faraday",
  "Darwin",
  "Lovelace",
  "Boole",
  "Pasteur",
  "Maxwell",
  "Mendel",
  "Curie",
  "Planck",
  "Tesla",
  "Poincare",
  "Noether",
  "Hilbert",
  "Einstein",
  "Raman",
  "Bohr",
  "Turing",
  "Hubble",
  "Feynman",
  "Franklin",
  "McClintock",
  "Meitner",
  "Herschel",
  "Linnaeus",
  "Wegener",
  "Chandrasekhar",
  "Sagan",
  "Goodall",
  "Carson",
  "Carver",
  "Socrates",
  "Plato",
  "Aristotle",
  "Epicurus",
  "Cicero",
  "Confucius",
  "Mencius",
  "Zeno",
  "Locke",
  "Hume",
  "Kant",
  "Hegel",
  "Kierkegaard",
  "Mill",
  "Nietzsche",
  "Peirce",
  "James",
  "Dewey",
  "Russell",
  "Popper",
  "Sartre",
  "Beauvoir",
  "Arendt",
  "Rawls",
  "Singer",
  "Anscombe",
  "Parfit",
  "Kuhn",
  "Boyle",
  "Hooke",
  "Harvey",
  "Dalton",
  "Ohm",
  "Helmholtz",
  "Gibbs",
  "Lorentz",
  "Schrodinger",
  "Heisenberg",
  "Pauli",
  "Dirac",
  "Bernoulli",
  "Godel",
  "Nash",
  "Banach",
  "Ramanujan",
  "Erdos",
  "Jason",
] as const);

const EXPLORER_DESCRIPTION = `Use \`explorer\` for specific codebase questions.
Explorers are fast and authoritative.
They must be used to ask specific, well-scoped questions on the codebase.
Rules:
- In order to avoid redundant work, you should avoid exploring the same problem that explorers have already covered. Typically, you should trust the explorer results without additional verification. You are still allowed to inspect the code yourself to gain the needed context!
- You are encouraged to spawn up multiple explorers in parallel when you have multiple distinct questions to ask about the codebase that can be answered independently. This allows you to get more information faster without waiting for one question to finish before asking the next. While waiting for the explorer results, you can continue working on other local tasks that do not depend on those results. This parallelism is a key advantage of delegation, so use it whenever you have multiple questions to ask.
- Reuse existing explorers for related questions.`;

const WORKER_DESCRIPTION = `Use for execution and production work.
Typical tasks:
- Implement part of a feature
- Fix tests or bugs
- Split large refactors into independent chunks
Rules:
- Explicitly assign **ownership** of the task (files / responsibility). When the subtask involves code changes, you should clearly specify which files or modules the worker is responsible for. This helps avoid merge conflicts and ensures accountability. For example, you can say "Worker 1 is responsible for updating the authentication module, while Worker 2 will handle the database layer." By defining clear ownership, you can delegate more effectively and reduce coordination overhead.
- Always tell workers they are **not alone in the codebase**, and they should not revert the edits made by others, and they should adjust their implementation to accommodate the changes made by others. This is important because there may be multiple workers making changes in parallel, and they need to be aware of other's work to avoid conflicts and ensure a cohesive final product.`;

const VERIFICATION_DESCRIPTION = `Use this agent to verify that implementation work is correct before reporting completion. Invoke after non-trivial tasks (3+ file edits, backend/API changes, infrastructure changes). Pass the original user task, files changed, approach taken, and plan path when relevant. The agent runs builds, tests, linters, and adversarial probes, then reports VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL with command evidence.`;

const VERIFICATION_SYSTEM_PROMPT = `You are a verification specialist. Your job is not to confirm the implementation works; it is to try to break it.

You are strictly prohibited from creating, modifying, or deleting files in the project directory, installing dependencies, or running git write operations. You may write ephemeral scripts under /tmp or $TMPDIR and clean them up.

For every check, run a real command. Reading code is not verification. Run the build when applicable, run tests, run linters/type-checkers if configured, and exercise the changed behavior directly. Include at least one adversarial probe such as boundary input, idempotency, missing resources, or concurrency when relevant.

Every check in your report must include:

### Check: [what you verified]
**Command run:**
  [exact command]
**Output observed:**
  [actual output, truncated only when necessary]
**Result: PASS** or **Result: FAIL**

End with exactly one line:
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL`;

// ─────────────────────────────────────────────────────────────────────
// Built-in roles
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_ROLE: AgentRole = freezeRole({
  name: "default",
  config: {
    description: "Default agent.",
  },
});

const EXPLORER_ROLE: AgentRole = freezeRole({
  name: "explorer",
  config: {
    description: EXPLORER_DESCRIPTION,
    configFile: "explorer.toml",
  },
});

const WORKER_ROLE: AgentRole = freezeRole({
  name: "worker",
  config: {
    description: WORKER_DESCRIPTION,
  },
});

const VERIFICATION_ROLE: AgentRole = freezeRole({
  name: "verification",
  config: {
    description: VERIFICATION_DESCRIPTION,
    background: true,
    systemPrompt: VERIFICATION_SYSTEM_PROMPT,
    allowlist: Object.freeze([
      "Bash",
      "Read",
      "Glob",
      "Grep",
      "LS",
      "WebFetch",
      "WebSearch",
      "TaskOutput",
    ]),
  },
});

const BUILT_INS: ReadonlyArray<AgentRole> = Object.freeze([
  DEFAULT_ROLE,
  EXPLORER_ROLE,
  WORKER_ROLE,
  VERIFICATION_ROLE,
]);

// ─────────────────────────────────────────────────────────────────────
// Role registry (process-level)
// ─────────────────────────────────────────────────────────────────────

const registry = new Map<string, AgentRole>();
for (const role of BUILT_INS) registry.set(role.name, role);

export function registerAgentRole(role: AgentRole): void {
  registry.set(role.name, freezeRole(role));
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

export function defaultAgentNicknameCandidates(): ReadonlyArray<string> {
  return DEFAULT_AGENT_NICKNAME_CANDIDATES;
}

export function _resetAgentRolesForTesting(): void {
  registry.clear();
  for (const role of BUILT_INS) registry.set(role.name, role);
}

export function resolveAgentRole(name: string | undefined): AgentRole {
  if (!name) return DEFAULT_ROLE;
  return registry.get(name) ?? DEFAULT_ROLE;
}

/**
 * Strict role-config lookup. Mirrors AgenC runtime `resolve_role_config`
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
// is exactly one source of truth for nicknames.
// ─────────────────────────────────────────────────────────────────────

/**
 * Allocate a nickname for a fresh subagent. On collision, cycles
 * through the candidate list + appends an ordinal suffix
 * ("scout the 2nd"). Mirrors AgenC runtime `registry.rs::format_agent_nickname`
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
// Config-layer stack (Wave 3 port of AgenC runtime role.rs:40-270)
//
// AgenC runtime layers TOML documents: `base → role-layer → user-layer` with
// config/profile resolution (`role.rs:155-270`). AgenC now loads role
// TOML through the same config-parser aliases, strips role-only
// metadata, and merges the resulting config keys onto a plain object
// blob so `control.ts spawn()` can keep the seam live before the child
// session config source is wired.
// ─────────────────────────────────────────────────────────────────────

/**
 * Role-shaped subset of the effective config blob. Pure-ported from
 * AgenC runtime `role.rs`: the live child config will eventually be a full
 * session-config snapshot, but today this seam accepts the config keys
 * the role layer can legitimately rewrite plus arbitrary pass-through
 * siblings.
 */
export interface RoleShapedConfig {
  model?: string;
  model_provider?: string;
  approval_policy?: string;
  sandbox_mode?: string;
  reasoning_effort?: string;
  personality?: string;
  web_search?: unknown;
  tools_config?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  agent_max_depth?: number;
  profile?: string;
  /** Arbitrary sibling fields from the base/user layer flow through. */
  [extra: string]: unknown;
}

/**
 * Apply the role's loaded TOML layer onto a base config blob. Mirrors
 * AgenC runtime `apply_role_to_config` (`role.rs:40`) at the config-loading
 * seam: role metadata is ignored, config aliases are normalized, and
 * top-level `profile = "..."` selectors are resolved against the
 * merged config snapshot.
 */
export function applyRoleToConfig<Base extends RoleShapedConfig>(
  role: AgentRole,
  base: Base,
): Base {
  return applyRoleToConfigInner(base, loadRoleLayerToml(role), {});
}

function applyRoleToConfigInner<Base extends RoleShapedConfig>(
  base: Base,
  roleLayerToml: Record<string, unknown>,
  userLayer: Partial<RoleShapedConfig>,
): Base {
  let next = mergeLayer(base, roleTomlToConfigLayer(roleLayerToml));
  const roleProfile = readSelectedProfile(roleLayerToml);
  if (roleProfile) {
    next = applySelectedProfile(next, roleProfile);
  }

  const userProfile = readSelectedProfile(userLayer as Record<string, unknown>);
  next = mergeLayer(next, stripSelectedProfile(userLayer));
  if (userProfile) {
    next = applySelectedProfile(next, userProfile);
  }

  return next;
}

/**
 * Load the role's TOML layer. Mirrors AgenC runtime `load_role_layer_toml`
 * (`role.rs:87-119`) at the module boundary:
 *   - built-ins resolve `configFile` against embedded TOML content
 *   - user-defined role files are read from disk
 *   - role-declaration metadata keys are stripped before the config
 *     layer is returned
 *
 * The returned object is TOML-shaped rather than fully normalized so
 * callers can still inspect AgenC-native keys like
 * `model_reasoning_effort` or `profile`.
 */
export function loadRoleLayerToml(role: AgentRole): Record<string, unknown> {
  const rawLayer = readRoleLayerSource(role);
  return stripRoleDeclarationMetadata(rawLayer);
}

/**
 * Build the layered effective config. Mirrors AgenC runtime
 * `build_config_layer_stack` + `build_next_config` +
 * `deserialize_effective_config` (`role.rs:155-270`) collapsed into a
 * single pure function.
 *
 * Precedence: `base → role → user`.
 *
 * Returns a fresh object; inputs are never mutated.
 */
export function buildConfigLayerStack<Base extends RoleShapedConfig>(opts: {
  readonly base: Base;
  readonly roleName?: string;
  readonly userLayer?: Partial<RoleShapedConfig>;
}): Base {
  const { base, roleName, userLayer = {} } = opts;
  const role = roleName ? getAgentRole(roleName) : undefined;
  return applyRoleToConfigInner(base, role ? loadRoleLayerToml(role) : {}, userLayer);
}

// ─────────────────────────────────────────────────────────────────────
// Role-list prompt formatter (Wave 3 port of AgenC runtime role.rs:280-309)
// ─────────────────────────────────────────────────────────────────────

/**
 * Format a known-roles list for injection into the spawn-agent tool
 * description. Mirrors AgenC runtime `spawn_tool_spec::build` +
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

  const roleLayerToml = tryLoadRoleLayerToml(role);
  const model = asString(roleLayerToml?.model);
  const reasoningEffort = asString(
    roleLayerToml?.model_reasoning_effort ?? roleLayerToml?.reasoning_effort,
  );

  let lockedSettingsNote = "";
  if (model && reasoningEffort) {
    lockedSettingsNote =
      `\n- This role's model is set to \`${model}\`` +
      ` and its reasoning effort is set to \`${reasoningEffort}\`.` +
      " These settings cannot be changed.";
  } else if (model) {
    lockedSettingsNote =
      `\n- This role's model is set to \`${model}\` and cannot be changed.`;
  } else if (reasoningEffort) {
    lockedSettingsNote =
      `\n- This role's reasoning effort is set to ` +
      `\`${reasoningEffort}\` and cannot be changed.`;
  }

  return `${role.name}: {\n${description}${lockedSettingsNote}\n}`;
}

function freezeRole(role: AgentRole): AgentRole {
  const derived = deriveRoleRuntimeHints(role.config, tryLoadRoleLayerToml(role));
  return Object.freeze({
    name: role.name,
    config: Object.freeze({ ...role.config, ...derived }),
  });
}

function tryLoadRoleLayerToml(
  role: AgentRole,
): Record<string, unknown> | undefined {
  try {
    return loadRoleLayerToml(role);
  } catch {
    return undefined;
  }
}

function deriveRoleRuntimeHints(
  config: AgentRoleConfig,
  roleLayerToml: Record<string, unknown> | undefined,
): Partial<AgentRoleConfig> {
  if (!roleLayerToml) return {};

  const normalizedLayer = roleTomlToConfigLayer(roleLayerToml);
  const derived: Partial<{
    -readonly [K in keyof AgentRoleConfig]: AgentRoleConfig[K];
  }> = {};

  if (config.reasoningEffort === undefined) {
    const reasoningEffort = asAgentReasoningEffort(
      normalizedLayer.reasoning_effort,
    );
    if (reasoningEffort) {
      derived.reasoningEffort = reasoningEffort;
    }
  }

  if (config.timeoutMs === undefined) {
    const timeoutMs = asPositiveInteger(
      roleLayerToml.background_terminal_max_timeout,
    );
    if (timeoutMs !== undefined) {
      derived.timeoutMs = timeoutMs;
    }
  }

  if (config.maxDepth === undefined) {
    const maxDepth = asPositiveInteger(normalizedLayer.agent_max_depth);
    if (maxDepth !== undefined) {
      derived.maxDepth = maxDepth;
    }
  }

  return derived;
}

function readRoleLayerSource(role: AgentRole): Record<string, unknown> {
  if (role.config.configBundle) {
    return cloneRecord(role.config.configBundle);
  }

  if (role.config.configToml !== undefined) {
    return parseRoleLayerToml(role.config.configToml);
  }

  const configFile = role.config.configFile;
  if (!configFile) return {};

  const builtInContents =
    BUILT_IN_ROLE_CONFIG_TOML[
      configFile as keyof typeof BUILT_IN_ROLE_CONFIG_TOML
    ];
  if (builtInContents !== undefined) {
    return parseRoleLayerToml(builtInContents);
  }

  const contents = normalizeExternalText(readFileSync(configFile, "utf8"));
  return parseRoleLayerToml(contents);
}

function parseRoleLayerToml(contents: string): Record<string, unknown> {
  const parsed = parseToml(normalizeExternalText(contents));
  if (!isPlainObject(parsed)) {
    throw new Error("role config must parse to a TOML table");
  }
  return parsed;
}

function stripRoleDeclarationMetadata(
  rawLayer: Record<string, unknown>,
): Record<string, unknown> {
  const next = cloneRecord(rawLayer);
  for (const key of ROLE_DECLARATION_METADATA_KEYS) {
    delete next[key];
  }
  return next;
}

function roleTomlToConfigLayer(
  roleLayerToml: Record<string, unknown>,
): Record<string, unknown> {
  const aliased = normalizeAgenCKeyAliases(roleLayerToml);
  const normalized = cloneRecord(
    normalizeRawConfig(aliased) as Record<string, unknown>,
  );
  delete normalized._unknown;
  return normalized;
}

function readSelectedProfile(
  layer: Record<string, unknown>,
): string | undefined {
  return asString(layer.profile);
}

function stripSelectedProfile<T extends Record<string, unknown>>(
  layer: T,
): T {
  const next = cloneRecord(layer);
  delete next.profile;
  return next as T;
}

function applySelectedProfile<Base extends RoleShapedConfig>(
  base: Base,
  profileName: string,
): Base {
  const resolved = resolveProfile(base as unknown as AgenCConfig, profileName);
  return mergeLayer(base, resolved as Record<string, unknown>);
}

function mergeLayer<Base extends Record<string, unknown>>(
  base: Base,
  override: Record<string, unknown>,
): Base {
  const next: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    if (overrideValue === undefined) continue;
    const baseValue = next[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      next[key] = mergeLayer(baseValue, overrideValue);
      continue;
    }
    if (Array.isArray(overrideValue)) {
      next[key] = [...overrideValue];
      continue;
    }
    next[key] = overrideValue;
  }
  return next as Base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return { ...value };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function asAgentReasoningEffort(
  value: unknown,
): AgentReasoningEffort | undefined {
  if (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  ) {
    return value;
  }
  return undefined;
}

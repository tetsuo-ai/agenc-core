/**
 * Agent roles — built-in + user-configurable.
 *
 * Subset port of upstream runtime `core/src/agent/role.rs`. Ports:
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
 *     upstream runtime's full `ConfigLayerStack` / provider-preservation reload.
 *
 * Built-in roles:
 *   - `netrunner` — unrestricted default agent; inherits parent config
 *   - `scanner`   — codebase queries; compatibility alias for the
 *                   internal `explorer` id and loads the upstream runtime's
 *                   built-in `explorer.toml` role layer
 *   - `runner`    — execution/production work; compatibility alias for
 *                   the internal `worker` id and inherits parent tool
 *                   catalog
 *
 * User roles register via `registerAgentRole({ name, config })` and
 * override the built-ins.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import type { AgentRegistry } from "./registry.js";
import { normalizeAgenCKeyAliases, normalizeRawConfig } from "../config/schema.js";
import { parseToml } from "../config/loader.js";
import { resolveProfile } from "../config/profiles.js";
import type { AgenCConfig } from "../config/schema.js";
import { normalizeExternalText } from "./_deps/file-read.js";
import {
  agentRolePresentation,
  canonicalAgentRoleName,
} from "./role-presentation.js";

export type AgentReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface AgentRoleConfig {
  readonly description?: string;
  /** AgenC-shaped role layer file. Built-ins resolve against embedded
   *  TOML content; user-defined roles read the path from disk. */
  readonly configFile?: string;
  /** Inline TOML role layer. Useful for tests and bootstrap-time
   *  in-memory role registration. */
  readonly configToml?: string;
  /** Compatibility inline parsed config object. Prefer `configToml` or
   *  `configFile` for AgenC behavior. */
  readonly configBundle?: Record<string, unknown>;
  /** Candidate nicknames for this role; registry picks one on spawn. */
  readonly nicknameCandidates?: ReadonlyArray<string>;
  /** Runtime hint derived from the loaded role layer when possible. */
  readonly timeoutMs?: number;
  /** Runtime hint derived from the loaded role layer when possible. */
  readonly reasoningEffort?: AgentReasoningEffort;
  /** Optional explicit tool allowlist. This is runtime metadata, not a
   *  upstream runtime role-layer config field. */
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
  // Upstream keeps awaiter temporarily removed from the built-in role set, but
  // still exposes the embedded role file for user-defined roles that reference
  // `awaiter.toml`. The body matches the upstream
  // `core/src/agent/builtins/awaiter.toml` byte-for-byte.
  // Body content matches upstream `core/src/agent/builtins/awaiter.toml`.
  // Upstream uses TOML's `"""..."""` multiline string for
  // `developer_instructions`; AgenC's TOML parser is escape-only
  // (no triple-quoted production), so the body is encoded with `\n`
  // escapes. The string value is identical post-parse.
  "awaiter.toml": `background_terminal_max_timeout = 3600000
model_reasoning_effort = "low"
developer_instructions = "You are an awaiter.\\nYour role is to await the completion of a specific command or task and report its status only when it is finished.\\n\\nBehavior rules:\\n\\n1. When given a command or task identifier, you must:\\n   - Execute or await it using the appropriate tool\\n   - Continue awaiting until the task reaches a terminal state.\\n\\n2. You must NOT:\\n   - Modify the task.\\n   - Interpret or optimize the task.\\n   - Perform unrelated actions.\\n   - Stop awaiting unless explicitly instructed.\\n\\n3. Awaiting behavior:\\n   - If the task is still running, continue polling using tool calls.\\n   - Use repeated tool calls if necessary.\\n   - Do not hallucinate completion.\\n   - Use long timeouts when awaiting for something. If you need multiple awaits, increase the timeouts/yield times exponentially.\\n\\n4. If asked for status:\\n   - Return the current known status.\\n   - Immediately resume awaiting afterward.\\n\\n5. Termination:\\n   - Only exit awaiting when:\\n     - The task completes successfully, OR\\n     - The task fails, OR\\n     - You receive an explicit stop instruction.\\n\\nYou must behave deterministically and conservatively.\\n"`,
} as const);

const ROLE_DECLARATION_METADATA_KEYS = Object.freeze([
  "name",
  "description",
  "nickname_candidates",
  "developer_instructions",
] as const);

const DEFAULT_AGENT_NICKNAME_CANDIDATES = Object.freeze([
  "Snowcrash",
  "Neuromancer",
  "Wintermute",
  "CountZero",
  "MonaLisa",
  "BurningChrome",
  "JohnnyMnemonic",
  "Idoru",
  "DiamondAge",
  "Mirrorshades",
  "VirtualLight",
  "BridgeRunner",
  "SprawlRunner",
  "ChibaCity",
  "NightCity",
  "Metaverse",
  "BlackICE",
  "Flatline",
  "Razorgirl",
  "ConsoleCowboy",
  "StreetSamurai",
  "Cyberdeck",
  "Simstim",
  "LoTek",
  "OnoSendai",
  "TessierAshpool",
  "Armitage",
  "Molly",
  "Case",
  "Hiro",
  "YT",
  "Juanita",
  "Da5id",
  "Deliverator",
  "BlackSun",
  "Librarian",
  "Deckard",
  "Motoko",
  "Kusanagi",
  "Section9",
  "Kaneda",
  "Tetsuo",
  "Major",
  "Netrunner",
  "Edgerunner",
  "Fixer",
  "Ripperdoc",
  "Solo",
  "Nomad",
  "Corpo",
  "Braindance",
  "Monowire",
  "DataShard",
  "Quickhack",
  "Netwatch",
  "ChromeSaint",
  "NeonGhost",
  "GridRunner",
  "PacketSaint",
  "SignalWitch",
  "StaticAngel",
  "NeonOracle",
  "ChromeLotus",
  "ICEBreaker",
  "DeckJockey",
  "MeshRunner",
  "NullVector",
  "ZeroDay",
  "GhostHack",
  "SignalJacker",
  "Mainframe",
  "DataHaven",
  "TerminalBlue",
  "NeonRunner",
  "ChromeRider",
  "DataCourier",
  "MemoryPalace",
  "PatchworkGirl",
  "GlassHammer",
  "Schismatrix",
  "Mechanist",
  "Shaper",
  "Wetwork",
  "Hardwired",
  "Cyberia",
  "Vurt",
  "Synner",
  "Software",
  "Wetware",
  "Freeware",
  "Warez",
  "Headcrash",
  "AlteredCarbon",
  "Kovacs",
  "Takeshi",
  "Envoy",
  "Stack",
  "Needlecast",
  "Peripheral",
  "Jackpot",
  "Agency",
  "Aelita",
  "NewRoseHotel",
] as const);

const EXPLORER_DESCRIPTION = `Use \`scanner\` for specific codebase reconnaissance.
Scanners are fast and authoritative.
They must be used to ask specific, well-scoped questions on the codebase.
Rules:
- Avoid scanning the same problem that scanners have already covered. Typically, you should trust the scanner results without additional verification. You are still allowed to inspect the code yourself to gain the needed context.
- Spawn multiple scanners in parallel when you have distinct codebase questions that can be answered independently. While waiting for scanner results, continue working on local tasks that do not depend on those results.
- Reuse existing scanners for related questions.

Compatibility: \`explorer\` remains accepted as a legacy alias for \`scanner\`.`;

const WORKER_DESCRIPTION = `Use \`runner\` for execution and production work.
Typical tasks:
- Implement part of a feature
- Fix tests or bugs
- Split large refactors into independent chunks
Rules:
- Explicitly assign ownership of the task (files / responsibility). When the subtask involves code changes, clearly specify which files or modules the runner owns. This avoids merge conflicts and makes accountability explicit.
- Always tell runners they are not alone in the codebase. They should not revert edits made by others, and they should adjust their implementation to accommodate changes made by others.

Compatibility: \`worker\` remains accepted as a legacy alias for \`runner\`.`;

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

const BUILT_INS: ReadonlyArray<AgentRole> = Object.freeze([
  DEFAULT_ROLE,
  EXPLORER_ROLE,
  WORKER_ROLE,
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
  return registry.get(name) ?? registry.get(canonicalAgentRoleName(name));
}

export function getDefaultAgentRole(): AgentRole {
  return DEFAULT_ROLE;
}

export class AgentRoleNotFoundError extends Error {
  constructor(public readonly roleName: string) {
    super(`unknown agent_type '${roleName}'`);
    this.name = "AgentRoleNotFoundError";
  }
}

export function requireAgentRole(name: string | undefined): AgentRole {
  if (!name) return DEFAULT_ROLE;
  const role = getAgentRole(name);
  if (!role) throw new AgentRoleNotFoundError(name);
  return role;
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
  return getAgentRole(name) ?? DEFAULT_ROLE;
}

/**
 * Strict role-config lookup. Mirrors upstream runtime `resolve_role_config`
 * (`role.rs:121`). Returns the `AgentRoleConfig` for a named role or
 * `undefined` when the role is unknown — the caller is expected to
 * surface the error. Contrast with `resolveAgentRole`, which falls
 * back to the default role for convenience.
 */
export function tryResolveRoleConfig(
  name: string | undefined,
): AgentRoleConfig | undefined {
  if (!name) return undefined;
  return getAgentRole(name)?.config;
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
 * ("scout the 2nd"). Mirrors upstream runtime `registry.rs::format_agent_nickname`
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
// Config-layer stack (Wave 3 port of upstream runtime role.rs:40-270)
//
// Upstream runtime layers TOML documents: `base → role-layer → user-layer` with
// config/profile resolution (`role.rs:155-270`). AgenC now loads role
// TOML through the same config-parser aliases, strips role-only
// metadata, and merges the resulting config keys onto a plain object
// blob so `control.ts spawn()` can keep the seam live before the child
// session config source is wired.
// ─────────────────────────────────────────────────────────────────────

/**
 * Role-shaped subset of the effective config blob. Pure-ported from
 * upstream runtime `role.rs`: the live child config will eventually be a full
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

/** Optional-keys form of {@link RoleShapedConfig} for caller-supplied user layers. */
export type OptionalRoleShapedConfig = {
  readonly [K in keyof RoleShapedConfig]?: RoleShapedConfig[K];
};

/**
 * Apply the role's loaded TOML layer onto a base config blob. Mirrors
 * upstream runtime `apply_role_to_config` (`role.rs:40`) at the config-loading
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
  userLayer: OptionalRoleShapedConfig,
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
 * Load the role's TOML layer. Mirrors upstream runtime `load_role_layer_toml`
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
 * Build the layered effective config. Mirrors upstream runtime
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
  readonly userLayer?: OptionalRoleShapedConfig;
}): Base {
  const { base, roleName, userLayer = {} } = opts;
  const role = roleName ? getAgentRole(roleName) : undefined;
  return applyRoleToConfigInner(base, role ? loadRoleLayerToml(role) : {}, userLayer);
}

// ─────────────────────────────────────────────────────────────────────
// Role-list prompt formatter (Wave 3 port of upstream runtime role.rs:280-309)
// ─────────────────────────────────────────────────────────────────────

/**
 * Format a known-roles list for injection into the spawn-agent tool
 * description. Mirrors upstream runtime `spawn_tool_spec::build` +
 * `build_from_configs` + `format_role` (`role.rs:280-309`).
 *
 * Roles missing a `description` are rendered as `name: no description`
 * so the list still announces them.
 */
export function formatRoleList(roles: ReadonlyArray<AgentRole>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const role of roles) {
    const presentation = agentRolePresentation(role.name);
    const publicName =
      presentation?.canonicalName === role.name
        ? presentation.publicName
        : role.name;
    if (seen.has(publicName)) continue;
    seen.add(publicName);
    lines.push(formatRole(role));
  }
  return [
    "Optional type name for the new agent. If omitted, `netrunner` is used.",
    "Available roles:",
    ...lines,
  ].join("\n");
}

function formatRole(role: AgentRole): string {
  const { description } = role.config;
  const presentationCandidate = agentRolePresentation(role.name);
  const presentation =
    presentationCandidate?.canonicalName === role.name
      ? presentationCandidate
      : undefined;
  const publicName = presentation?.publicName ?? role.name;
  const aliasNote =
    presentation !== undefined && presentation.canonicalName !== publicName
      ? `\n- Legacy alias accepted: \`${presentation.canonicalName}\`.`
      : "";
  if (!description) return `${publicName}: no description${aliasNote}`;

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

  return `${publicName}: {\n${description}${aliasNote}${lockedSettingsNote}\n}`;
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
): { readonly [K in keyof AgentRoleConfig]?: AgentRoleConfig[K] } {
  if (!roleLayerToml) return {};

  const normalizedLayer = roleTomlToConfigLayer(roleLayerToml);
  const derived: {
    -readonly [K in keyof AgentRoleConfig]?: AgentRoleConfig[K];
  } = {};

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
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

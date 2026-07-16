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
 * Programmatic user roles register via
 * `registerAgentRole(workspace, { name, config })` and override built-ins only
 * inside that workspace.
 *
 * @module
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import yaml from "js-yaml";
import type { AgentRegistry } from "./registry.js";
import { normalizeAgenCKeyAliases, normalizeRawConfig } from "../config/schema.js";
import { parseToml } from "../config/loader.js";
import { resolveProfile } from "../config/profiles.js";
import type { AgenCConfig } from "../config/schema.js";
import { normalizeExternalText } from "./_deps/file-read.js";
import { stableStringify } from "../utils/stableStringify.js";
import {
  agentRolePresentation,
  canonicalAgentRoleName,
} from "./role-presentation.js";
import {
  BUILTIN_READONLY_DISALLOWLIST,
  EXPLORE_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  PLAN_WHEN_TO_USE,
  VERIFICATION_SYSTEM_PROMPT,
  VERIFICATION_WHEN_TO_USE,
} from "./built-in-prompts.js";
import type { AgentRoleWorkspace } from "./role-workspace.js";
export {
  AgentRoleWorkspaceError,
  AgentRoleWorkspaceMismatchError,
  assertAgentRoleWorkspaceMatches,
  createAgentRoleWorkspace,
  normalizeAgentRoleWorkspace,
} from "./role-workspace.js";
export type { AgentRoleWorkspace } from "./role-workspace.js";

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
  readonly model?: string;
  /** Runtime hint derived from the loaded role layer when possible. */
  readonly reasoningEffort?: AgentReasoningEffort;
  /** Runtime hint derived from the loaded role layer when possible. */
  readonly serviceTier?: string;
  /** Optional explicit tool allowlist. This is runtime metadata, not a
   *  upstream runtime role-layer config field. */
  readonly allowlist?: ReadonlyArray<string>;
  /** Optional tool denylist. Tools named here are removed from the spawned
   *  child's registry (both advertised + dispatch-rejected), on top of any
   *  allowlist. Used by read-only built-in roles (scanner/Plan/verification)
   *  to deny edit/write/spawn. Runtime metadata, not an upstream role-layer
   *  config field. */
  readonly disallowlist?: ReadonlyArray<string>;
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

/**
 * Content identity for a resolved role.
 *
 * The workspace id proves where a role came from; this digest proves which
 * effective definition occupied that name. Both are required when reopening a
 * child so removing a restrictive workspace override cannot silently fall
 * through to a less restrictive built-in with the same name.
 */
export function agentRoleFingerprint(role: AgentRole): string {
  // A config-file path is not executable identity: the file can change in
  // place. Resolve the exact effective TOML layer on every digest operation.
  // Read/parse failures intentionally propagate so spawn/resume fails closed.
  const effectiveConfigLayer = loadRoleLayerToml(role);
  return createHash("sha256")
    .update(
      stableStringify({
        name: role.name,
        config: role.config,
        effectiveConfigLayer,
      }),
      "utf8",
    )
    .digest("hex");
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

// `default` is the unrestricted general-purpose role used for an omitted or
// `general-purpose` spawn (the alias lives in role-presentation.ts). It carries
// NO system prompt: `default` is also the role of internal silent spawns
// (MagicDocs/session-memory) that supply their own instructions, and the former
// GENERAL_PURPOSE_AGENT const prompt was dead on HEAD — see built-in-prompts.ts.
const DEFAULT_ROLE: AgentRole = freezeRole({
  name: "default",
  config: {
    description: "Default agent.",
  },
});

// `explorer` (public name `scanner`) is the read-only codebase-reconnaissance
// role. It now carries the Explore agent's system prompt + read-only denylist
// (formerly the stranded EXPLORE_AGENT const). `model` is left undefined
// (inherit) — the const's `haiku` was a model alias the v2 spawn validator
// rejects, and it never ran on the live path; see built-in-prompts.ts.
const EXPLORER_ROLE: AgentRole = freezeRole({
  name: "explorer",
  config: {
    description: EXPLORER_DESCRIPTION,
    configFile: "explorer.toml",
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    disallowlist: BUILTIN_READONLY_DISALLOWLIST,
  },
});

const WORKER_ROLE: AgentRole = freezeRole({
  name: "worker",
  config: {
    description: WORKER_DESCRIPTION,
  },
});

// Read-only software-architect role (formerly the stranded PLAN_AGENT const).
const PLAN_ROLE: AgentRole = freezeRole({
  name: "Plan",
  config: {
    description: PLAN_WHEN_TO_USE,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    disallowlist: BUILTIN_READONLY_DISALLOWLIST,
  },
});

// Read-only adversarial verification role, runs in background (formerly the
// stranded VERIFICATION_AGENT const). The const's `color:'red'` (cosmetic) and
// `criticalSystemReminder_EXPERIMENTAL` are not carried over: the verdict +
// no-edit content already lives verbatim in VERIFICATION_SYSTEM_PROMPT and the
// read-only restriction is enforced via disallowlist; both fields were dead on
// HEAD (the const never dispatched), so dropping them is not a live regression.
const VERIFICATION_ROLE: AgentRole = freezeRole({
  name: "verification",
  config: {
    description: VERIFICATION_WHEN_TO_USE,
    systemPrompt: VERIFICATION_SYSTEM_PROMPT,
    disallowlist: BUILTIN_READONLY_DISALLOWLIST,
    background: true,
  },
});

const BUILT_INS: ReadonlyArray<AgentRole> = Object.freeze([
  DEFAULT_ROLE,
  EXPLORER_ROLE,
  WORKER_ROLE,
  PLAN_ROLE,
  VERIFICATION_ROLE,
]);

// ─────────────────────────────────────────────────────────────────────
// Role registries (built-ins + workspace-scoped definitions)
// ─────────────────────────────────────────────────────────────────────

const builtInRoles = new Map<string, AgentRole>();
for (const role of BUILT_INS) builtInRoles.set(role.name, role);

const registeredRolesByWorkspace = new Map<string, Map<string, AgentRole>>();

interface MarkdownRoleNamespace {
  readonly roles: Map<string, AgentRole>;
  readonly signature: string;
}

// Markdown-loaded roles are namespaced by the requesting workspace so two
// projects with same-named `.agenc/agents/<name>.md` roles resolve independently
// inside one daemon process. There is deliberately no cwd-less fallback.
const markdownRolesByCwd = new Map<string, MarkdownRoleNamespace>();
let markdownAgentRoleReadHookForTesting:
  | ((filePath: string) => void)
  | undefined;

export function registerAgentRole(
  workspace: AgentRoleWorkspace,
  role: AgentRole,
): void {
  const roles = registeredRolesByWorkspace.get(workspace.id) ?? new Map();
  roles.set(role.name, freezeRole(role));
  registeredRolesByWorkspace.set(workspace.id, roles);
}

export function getAgentRole(
  workspace: AgentRoleWorkspace,
  name: string,
): AgentRole | undefined {
  return (
    getAgentRoleByExactName(workspace, name) ??
    lookupRoleByExactName(workspace, canonicalAgentRoleName(name))
  );
}

/**
 * Resolve only the persisted role name, without public-name alias fallback.
 *
 * Durable role provenance must use this lookup: if a workspace override named
 * `scanner` disappears, reopening it as the built-in `explorer` alias would
 * silently weaken the original prompt/tool policy.
 */
export function getAgentRoleByExactName(
  workspace: AgentRoleWorkspace,
  name: string,
): AgentRole | undefined {
  return lookupRoleByExactName(workspace, name);
}

function lookupRoleByExactName(
  workspace: AgentRoleWorkspace,
  name: string,
): AgentRole | undefined {
  return (
    lookupMarkdownRole(workspace, name) ??
    registeredRolesByWorkspace.get(workspace.id)?.get(name) ??
    builtInRoles.get(name)
  );
}

function lookupMarkdownRole(
  workspace: AgentRoleWorkspace,
  name: string,
): AgentRole | undefined {
  loadMarkdownAgentRoles(workspace);
  return markdownRolesByCwd.get(workspace.id)?.roles.get(name);
}

export function getDefaultAgentRole(): AgentRole {
  return DEFAULT_ROLE;
}

class AgentRoleNotFoundError extends Error {
  constructor(public readonly roleName: string) {
    super(`unknown agent_type '${roleName}'`);
    this.name = "AgentRoleNotFoundError";
  }
}

export function requireAgentRole(
  workspace: AgentRoleWorkspace,
  name: string | undefined,
): AgentRole {
  if (!name) return DEFAULT_ROLE;
  const role = getAgentRole(workspace, name);
  if (!role) throw new AgentRoleNotFoundError(name);
  return role;
}

export function listAgentRoles(
  workspace: AgentRoleWorkspace,
): ReadonlyArray<AgentRole> {
  const merged = new Map<string, AgentRole>(builtInRoles);
  for (const role of registeredRolesByWorkspace.get(workspace.id)?.values() ?? []) {
    merged.set(role.name, role);
  }
  loadMarkdownAgentRoles(workspace);
  const namespace = markdownRolesByCwd.get(workspace.id);
  if (namespace) {
    for (const role of namespace.roles.values()) merged.set(role.name, role);
  }
  return Array.from(merged.values());
}

/** Return only roles shipped by the runtime, excluding workspace definitions. */
export function listBuiltInAgentRoles(): ReadonlyArray<AgentRole> {
  return BUILT_INS;
}

/** Return only programmatic definitions registered for this workspace. */
export function listRegisteredAgentRoles(
  workspace: AgentRoleWorkspace,
): ReadonlyArray<AgentRole> {
  return [...(registeredRolesByWorkspace.get(workspace.id)?.values() ?? [])];
}

export function defaultAgentNicknameCandidates(): ReadonlyArray<string> {
  return DEFAULT_AGENT_NICKNAME_CANDIDATES;
}

export function _resetAgentRolesForTesting(): void {
  markdownRolesByCwd.clear();
  registeredRolesByWorkspace.clear();
  markdownAgentRoleReadHookForTesting = undefined;
}

/** Deterministic validation-to-open race seam; tests only. */
export function _setMarkdownAgentRoleReadHookForTesting(
  hook: ((filePath: string) => void) | undefined,
): void {
  markdownAgentRoleReadHookForTesting = hook;
}

export function loadMarkdownAgentRoles(workspace: AgentRoleWorkspace): void {
  const key = workspace.id;
  // Cheap identity/metadata invalidation: inspect candidate role dirs and files
  // on every load so editing a role .md takes effect for new sessions without
  // a daemon restart. Only when the signature changes do we securely open and
  // re-parse the files.
  const signature = markdownAgentRoleSignature(workspace.cwd);
  const existing = markdownRolesByCwd.get(key);
  if (existing !== undefined && existing.signature === signature) return;

  const roles = new Map<string, AgentRole>();
  for (const file of readMarkdownAgentRoleFiles(workspace.cwd)) {
    const role = markdownAgentRoleFromFile(file);
    if (role) roles.set(role.name, freezeRole(role));
  }
  markdownRolesByCwd.set(key, { roles, signature });
}

function markdownAgentRoleSignature(cwd: string): string {
  const parts: string[] = [];
  for (const source of markdownAgentRoleDirs(cwd)) {
    const directory = validateTrustedMarkdownDirectory(source, source.dir);
    parts.push(
      `${source.dir}\u0000${directory === null ? "missing-or-untrusted" : trustedDirectorySignature(directory)}`,
    );
    // A directory's mtime does not change when a contained file is edited
    // in place, so include each trusted markdown file's identity and metadata.
    for (const filePath of collectMarkdownFiles(source)) {
      const file = validateTrustedMarkdownRoleFile(source, filePath);
      if (file !== null) {
        parts.push(
          `${filePath}\u0000${stableEntrySignature(file.fileState)}`,
        );
      }
    }
  }
  return parts.join("\n");
}

export function resolveAgentRole(
  workspace: AgentRoleWorkspace,
  name: string | undefined,
): AgentRole {
  if (!name) return DEFAULT_ROLE;
  return getAgentRole(workspace, name) ?? DEFAULT_ROLE;
}

/**
 * Strict role-config lookup. Mirrors upstream runtime `resolve_role_config`
 * (`role.rs:121`). Returns the `AgentRoleConfig` for a named role or
 * `undefined` when the role is unknown — the caller is expected to
 * surface the error. Contrast with `resolveAgentRole`, which falls
 * back to the default role for convenience.
 */
export function tryResolveRoleConfig(
  workspace: AgentRoleWorkspace,
  name: string | undefined,
): AgentRoleConfig | undefined {
  if (!name) return undefined;
  return getAgentRole(workspace, name)?.config;
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
  service_tier?: string;
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
  readonly workspace: AgentRoleWorkspace;
  readonly roleName?: string;
  readonly userLayer?: OptionalRoleShapedConfig;
}): Base {
  const { base, workspace, roleName, userLayer = {} } = opts;
  const role = roleName ? getAgentRole(workspace, roleName) : undefined;
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
  const serviceTier = asString(roleLayerToml?.service_tier);

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
  if (serviceTier) {
    lockedSettingsNote +=
      `\n- This role's service tier is set to \`${serviceTier}\`.` +
      " If it is supported by the resolved model, it takes precedence over a valid spawn request service tier.";
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

  if (config.model === undefined) {
    const model = asString(normalizedLayer.model);
    if (model !== undefined) {
      derived.model = model;
    }
  }

  if (config.reasoningEffort === undefined) {
    const reasoningEffort = asAgentReasoningEffort(
      normalizedLayer.reasoning_effort,
    );
    if (reasoningEffort) {
      derived.reasoningEffort = reasoningEffort;
    }
  }

  if (config.serviceTier === undefined) {
    const serviceTier = asString(normalizedLayer.service_tier);
    if (serviceTier !== undefined) {
      derived.serviceTier = serviceTier;
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

type MarkdownAgentRoleFile = {
  readonly filePath: string;
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
};

interface MarkdownAgentRoleDirectory {
  readonly dir: string;
  readonly trustAnchor: string;
}

interface StableEntryState {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface TrustedDirectoryComponent {
  readonly path: string;
  readonly canonicalPath: string;
  readonly state: StableEntryState;
}

interface TrustedDirectorySnapshot {
  readonly components: ReadonlyArray<TrustedDirectoryComponent>;
  readonly canonicalAnchor: string;
  readonly canonicalTier: string;
  readonly canonicalDirectory: string;
}

interface TrustedMarkdownRoleFileSnapshot {
  readonly directory: TrustedDirectorySnapshot;
  readonly canonicalFile: string;
  readonly fileState: StableEntryState;
}

interface OpenedMarkdownRoleFile {
  readonly raw: string;
  readonly identity: string;
}

function readMarkdownAgentRoleFiles(cwd: string): MarkdownAgentRoleFile[] {
  const out: MarkdownAgentRoleFile[] = [];
  const seenFiles = new Set<string>();
  for (const source of markdownAgentRoleDirs(cwd)) {
    for (const filePath of collectMarkdownFiles(source)) {
      try {
        const opened = readTrustedMarkdownRoleFile(source, filePath);
        if (opened === null || seenFiles.has(opened.identity)) continue;
        seenFiles.add(opened.identity);
        const { frontmatter, content } = parseMarkdownAgentRole(
          normalizeExternalText(opened.raw),
        );
        out.push({ filePath, frontmatter, content });
      } catch {
        continue;
      }
    }
  }
  return out;
}

function markdownAgentRoleDirs(cwd: string): MarkdownAgentRoleDirectory[] {
  const dirs: MarkdownAgentRoleDirectory[] = [];
  const userRoot = resolve(
    process.env.AGENC_CONFIG_DIR ?? join(homedir(), ".agenc"),
  );
  dirs.push({ dir: join(userRoot, "agents"), trustAnchor: userRoot });

  const projectDirs: MarkdownAgentRoleDirectory[] = [];
  let current = resolve(cwd);
  const home = resolve(homedir());
  while (true) {
    projectDirs.push({
      dir: join(current, ".agenc", "agents"),
      trustAnchor: current,
    });
    if (current === home || current === dirname(current)) break;
    if (existsSync(join(current, ".git"))) break;
    current = dirname(current);
  }
  dirs.push(...projectDirs.reverse());

  const managed = process.env.AGENC_MANAGED_AGENTS_DIR;
  if (managed && managed.trim().length > 0) {
    const managedDir = resolve(managed);
    dirs.push({ dir: managedDir, trustAnchor: dirname(managedDir) });
  }

  return dirs;
}

function collectMarkdownFiles(
  source: MarkdownAgentRoleDirectory,
  dir: string = source.dir,
  visitedDirs = new Set<string>(),
): string[] {
  const before = validateTrustedMarkdownDirectory(source, dir);
  if (before === null) return [];
  const dirState = before.components.at(-1)?.state;
  if (dirState === undefined) return [];
  const dirKey =
    dirState.dev === 0n && dirState.ino === 0n
      ? before.canonicalDirectory
      : `${dirState.dev}:${dirState.ino}`;
  if (visitedDirs.has(dirKey)) return [];
  visitedDirs.add(dirKey);

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { encoding: "utf8", withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(dir, entry.name);
    try {
      const stats = lstatSync(fullPath, { bigint: true });
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        files.push(...collectMarkdownFiles(source, fullPath, visitedDirs));
      } else if (
        stats.isFile() &&
        entry.name.endsWith(".md") &&
        validateTrustedMarkdownRoleFile(source, fullPath) !== null
      ) {
        files.push(fullPath);
      }
    } catch {
      continue;
    }
  }
  const after = validateTrustedMarkdownDirectory(source, dir);
  return after !== null && sameTrustedDirectoryIdentity(before, after)
    ? files.sort()
    : [];
}

function validateTrustedMarkdownDirectory(
  source: MarkdownAgentRoleDirectory,
  candidateDirectory: string,
): TrustedDirectorySnapshot | null {
  try {
    const anchor = resolve(source.trustAnchor);
    const tier = resolve(source.dir);
    const candidate = resolve(candidateDirectory);
    if (
      !isSameOrChildPath(anchor, tier) ||
      !isSameOrChildPath(tier, candidate)
    ) {
      return null;
    }

    const components: TrustedDirectoryComponent[] = [];
    let componentPath = anchor;
    const componentPaths = [anchor];
    const child = relative(anchor, candidate);
    if (child.length > 0) {
      for (const component of child.split(sep)) {
        componentPath = join(componentPath, component);
        componentPaths.push(componentPath);
      }
    }

    for (const path of componentPaths) {
      const before = lstatSync(path, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) return null;
      const canonicalPath = realpathSync(path);
      const after = lstatSync(path, { bigint: true });
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        !sameStableEntryState(stableEntryState(before), stableEntryState(after))
      ) {
        return null;
      }
      components.push({
        path,
        canonicalPath,
        state: stableEntryState(after),
      });
    }

    const anchorComponent = components[0];
    const tierComponent = components.find((component) => component.path === tier);
    const directoryComponent = components.at(-1);
    if (
      anchorComponent === undefined ||
      tierComponent === undefined ||
      directoryComponent === undefined ||
      !isSameOrChildPath(
        anchorComponent.canonicalPath,
        tierComponent.canonicalPath,
      ) ||
      !isSameOrChildPath(
        tierComponent.canonicalPath,
        directoryComponent.canonicalPath,
      )
    ) {
      return null;
    }

    return {
      components,
      canonicalAnchor: anchorComponent.canonicalPath,
      canonicalTier: tierComponent.canonicalPath,
      canonicalDirectory: directoryComponent.canonicalPath,
    };
  } catch {
    return null;
  }
}

function validateTrustedMarkdownRoleFile(
  source: MarkdownAgentRoleDirectory,
  filePath: string,
): TrustedMarkdownRoleFileSnapshot | null {
  try {
    const lexicalFile = resolve(filePath);
    const lexicalTier = resolve(source.dir);
    if (
      lexicalFile === lexicalTier ||
      !isSameOrChildPath(lexicalTier, lexicalFile)
    ) {
      return null;
    }
    const directory = validateTrustedMarkdownDirectory(
      source,
      dirname(lexicalFile),
    );
    if (directory === null) return null;

    const before = lstatSync(lexicalFile, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n
    ) {
      return null;
    }
    const canonicalFile = realpathSync(lexicalFile);
    const after = lstatSync(lexicalFile, { bigint: true });
    const beforeState = stableEntryState(before);
    const afterState = stableEntryState(after);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1n ||
      !sameStableEntryState(beforeState, afterState) ||
      canonicalFile === directory.canonicalDirectory ||
      !isSameOrChildPath(directory.canonicalDirectory, canonicalFile) ||
      !isSameOrChildPath(directory.canonicalTier, canonicalFile)
    ) {
      return null;
    }
    return { directory, canonicalFile, fileState: afterState };
  } catch {
    return null;
  }
}

function readTrustedMarkdownRoleFile(
  source: MarkdownAgentRoleDirectory,
  filePath: string,
): OpenedMarkdownRoleFile | null {
  let fd: number | undefined;
  try {
    const before = validateTrustedMarkdownRoleFile(source, filePath);
    if (before === null) return null;
    markdownAgentRoleReadHookForTesting?.(filePath);

    fd = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(fd, { bigint: true });
    const openedState = stableEntryState(opened);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameStableEntryState(before.fileState, openedState)
    ) {
      return null;
    }

    // The descriptor, not the pathname, is the single source of role bytes.
    const raw = readFileSync(fd, "utf8");
    const afterRead = fstatSync(fd, { bigint: true });
    if (
      !afterRead.isFile() ||
      afterRead.nlink !== 1n ||
      !sameStableEntryState(openedState, stableEntryState(afterRead))
    ) {
      return null;
    }

    const after = validateTrustedMarkdownRoleFile(source, filePath);
    if (
      after === null ||
      after.canonicalFile !== before.canonicalFile ||
      !sameStableEntryState(after.fileState, before.fileState) ||
      !sameTrustedDirectoryIdentity(after.directory, before.directory)
    ) {
      return null;
    }
    return {
      raw,
      identity:
        openedState.dev === 0n && openedState.ino === 0n
          ? after.canonicalFile
          : `${openedState.dev}:${openedState.ino}`,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function stableEntryState(stats: BigIntStats): StableEntryState {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameStableEntryState(
  left: StableEntryState,
  right: StableEntryState,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameTrustedDirectoryIdentity(
  left: TrustedDirectorySnapshot,
  right: TrustedDirectorySnapshot,
): boolean {
  return (
    left.canonicalAnchor === right.canonicalAnchor &&
    left.canonicalTier === right.canonicalTier &&
    left.canonicalDirectory === right.canonicalDirectory &&
    left.components.length === right.components.length &&
    left.components.every((component, index) => {
      const other = right.components[index];
      return (
        other !== undefined &&
        component.path === other.path &&
        component.canonicalPath === other.canonicalPath &&
        component.state.dev === other.state.dev &&
        component.state.ino === other.state.ino &&
        component.state.mode === other.state.mode
      );
    })
  );
}

function trustedDirectorySignature(
  directory: TrustedDirectorySnapshot,
): string {
  const state = directory.components.at(-1)?.state;
  return state === undefined
    ? "missing-or-untrusted"
    : `${directory.canonicalDirectory}:${stableEntrySignature(state)}`;
}

function stableEntrySignature(state: StableEntryState): string {
  return [
    state.dev,
    state.ino,
    state.mode,
    state.nlink,
    state.size,
    state.mtimeNs,
    state.ctimeNs,
  ].join(":");
}

function isSameOrChildPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function parseMarkdownAgentRole(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
} {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, content: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, content: raw };
  }
  const frontmatterRaw = raw.slice(3, end);
  const contentStart = raw.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : raw.slice(contentStart + 1);
  const parsed = yaml.load(frontmatterRaw);
  return {
    frontmatter: isPlainObject(parsed) ? parsed : {},
    content,
  };
}

function markdownAgentRoleFromFile(
  file: MarkdownAgentRoleFile,
): AgentRole | null {
  const name = nonEmptyString(file.frontmatter.name);
  const description = nonEmptyString(file.frontmatter.description);
  if (!name || !description) return null;

  const tools = parseMarkdownToolList(file.frontmatter.tools);
  const reasoningEffort = asAgentReasoningEffort(
    file.frontmatter.effort ??
      file.frontmatter.reasoning_effort ??
      file.frontmatter.model_reasoning_effort,
  );
  const background =
    file.frontmatter.background === true ||
    file.frontmatter.background === "true";

  return {
    name,
    config: {
      description: description.replace(/\\n/g, "\n"),
      systemPrompt: file.content.trim(),
      ...(tools !== undefined ? { allowlist: tools } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(background ? { background: true } : {}),
    },
  };
}

function parseMarkdownToolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const tools = raw
    .filter((item): item is string => typeof item === "string")
    .flatMap((item) => item.split(/[,\s]+/))
    .map((item) => item.trim())
    .filter(Boolean);
  if (tools.includes("*")) return undefined;
  return tools.length > 0 ? tools : undefined;
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
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

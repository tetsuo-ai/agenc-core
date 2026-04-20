/**
 * Agent roles — built-in + user-configurable.
 *
 * Hand-port of codex `core/src/agent/role.rs` (434 LOC). Roles shape
 * per-subagent configuration (reasoning effort, timeout, tool
 * allowlist) without forcing the user to redefine the spec each
 * spawn.
 *
 * Built-in roles:
 *   - `default` — unrestricted; inherits parent config
 *   - `explorer` — codebase queries; fast reasoning; read-only tool set
 *   - `awaiter` — long-running polling (3600s timeout, low reasoning)
 *
 * User roles register via `registerAgentRole({ name, config })` and
 * override the built-ins.
 *
 * @module
 */

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
  /** Max recursion depth override (capped at MAX_AGENT_DEPTH=4). */
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

// ─────────────────────────────────────────────────────────────────────
// Nickname allocation
// ─────────────────────────────────────────────────────────────────────

const usedNicknames = new Set<string>();
let nicknameResetCount = 0;

/**
 * Allocate a nickname for a fresh subagent. On collision, cycles
 * through the candidate list + appends an ordinal suffix
 * ("scout the 2nd"). Mirrors codex `registry.rs::format_agent_nickname`.
 */
export function allocateNickname(role: AgentRole): string {
  const candidates = role.config.nicknameCandidates ?? [role.name];
  for (const candidate of candidates) {
    const formatted =
      nicknameResetCount === 0
        ? candidate
        : formatNicknameWithSuffix(candidate, nicknameResetCount);
    if (!usedNicknames.has(formatted)) {
      usedNicknames.add(formatted);
      return formatted;
    }
  }
  // All candidates exhausted at this ordinal — advance.
  nicknameResetCount += 1;
  return allocateNickname(role);
}

export function releaseNickname(nickname: string): void {
  usedNicknames.delete(nickname);
}

/** Reset the process-wide nickname pool (tests). */
export function _resetNicknamePoolForTesting(): void {
  usedNicknames.clear();
  nicknameResetCount = 0;
}

function formatNicknameWithSuffix(name: string, resetCount: number): string {
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

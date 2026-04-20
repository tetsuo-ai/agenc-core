/**
 * Agent roles — built-in + user-configurable.
 *
 * Hand-port of codex `core/src/agent/role.rs` (434 LOC). Roles shape
 * per-subagent configuration (reasoning effort, timeout, tool
 * allowlist) without forcing the user to redefine the spec each
 * spawn.
 *
 * Built-in roles:
 *   - `default`  — unrestricted; inherits parent config
 *   - `explorer` — codebase queries; low reasoning; read-only tool set
 *   - `worker`   — execution/production work; medium reasoning;
 *                  inherits parent tool catalog (mirrors codex
 *                  `agent/role.rs:383` `worker` entry)
 *   - `awaiter`  — long-running polling (3600s timeout, low reasoning)
 *
 * Divergences from codex upstream (`codex-rs/core/src/agent/role.rs`):
 *
 *   - AgenC ships `awaiter` active. Upstream codex has the entry
 *     commented out at `role.rs:398-414` ("awaiter is temp removed").
 *     AgenC keeps it because the MCP + long-running tool-poll use
 *     case needs a background polling role (e.g. waiting on a
 *     long-running MCP server health check or external build).
 *   - Nickname allocation cycles candidates in declaration order
 *     rather than codex's `rand::rng()` shuffle. Deterministic
 *     ordering is intentional: it makes spawn tests reproducible
 *     and eliminates flaky allocation-collision tests.
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

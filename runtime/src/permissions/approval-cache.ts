/**
 * ApprovalStore, session approval rules, and canonical shell approval keys.
 *
 * When the user answers an approval prompt with
 * `approved_for_session`, the runtime remembers that decision so the
 * next semantically-equivalent request doesn't re-prompt. For shell
 * runtimes in particular, a single command can be wrapped by different
 * shell binaries (`bash -lc "X"` vs `/bin/bash -lc "X"` vs `bash -c
 * "X"`). The approval key has to collapse those wrapper differences so
 * `approved_for_session` actually sticks.
 *
 * Scope of this file:
 *   - `ApprovalStore<K>` — serializable-key → `ReviewDecision` map,
 *     with a `withCachedApproval` wrapper that encodes multi-key semantics.
 *   - `SessionApprovalCache` — session-destination allow-rule cache for
 *     which tools/patterns were approved in the current session.
 *   - `ShellApprovalKey` + `buildShellApprovalKey` — the shape
 *     shell execution uses as its approval key. Command parsing and
 *     canonicalization live in `shell-command/parser.ts`.
 *
 * @module
 */

import { canonicalizeCommandForApproval } from "../shell-command/parser.js";
import type { ReviewDecision } from "./review-decision.js";
import {
  applyPermissionUpdate,
  parseRuleString,
  serializeRuleValue,
} from "./rules.js";
import type {
  PermissionRuleValue,
  PermissionUpdate,
  ToolPermissionContext,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Serializable key helper — stable JSON for Map lookup.
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert an arbitrary serializable key to a stable string form.
 *
 * We stringify with sorted object keys so `{ cwd, command }` and
 * `{ command, cwd }` hash to the same entry. Arrays stay in their
 * given order (command argv is positional and must not be reordered).
 */
export function canonicalJsonKey(value: unknown): string {
  return JSON.stringify(stableKeyNode(value, new WeakSet<object>()));
}

function stableKeyNode(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "number") return ["number", numberKey(value)];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "undefined") return ["undefined"];
  if (typeof value === "function") return ["function"];
  if (typeof value === "symbol") return ["symbol", value.toString()];
  if (typeof value !== "object") return ["unknown", String(value)];
  if (seen.has(value)) return ["circular"];
  if (value instanceof Date) return ["date", value.toJSON()];

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return ["array", value.map((item) => stableKeyNode(item, seen))];
    }
    const obj = value as Record<string, unknown>;
    return [
      "object",
      Object.keys(obj)
        .sort()
        .map((k) => [k, stableKeyNode(obj[k], seen)]),
    ];
  } finally {
    seen.delete(value);
  }
}

function numberKey(value: number): number | string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return value;
}

// ─────────────────────────────────────────────────────────────────────
// ApprovalStore
// ─────────────────────────────────────────────────────────────────────

export interface WithCachedApprovalOpts<K> {
  readonly keys: readonly K[];
  readonly fetchDecision: () => Promise<ReviewDecision>;
}

/**
 * Session-scoped cache of approval decisions.
 *
 * AgenC behavior:
 *   - Keys are hashed via stable JSON so equivalent objects collide.
 *   - `withCachedApproval` short-circuits when ALL keys are already
 *     `approved_for_session`. (A partial hit — some keys approved but
 *     not all — does NOT short-circuit, matching the rule for
 *     multi-file approvals where every target must be covered.)
 *   - When the user responds `approved_for_session`, every key in the
 *     request is written with that decision so a future subset hit
 *     can short-circuit.
 *   - `clear()` is called on new session / `/clear`.
 */
export class ApprovalStore<K> {
  private readonly map: Map<string, ReviewDecision> = new Map();

  get(key: K): ReviewDecision | undefined {
    return this.map.get(canonicalJsonKey(key));
  }

  set(key: K, decision: ReviewDecision): void {
    this.map.set(canonicalJsonKey(key), decision);
  }

  setMany(keys: readonly K[], decision: ReviewDecision): void {
    for (const key of keys) {
      this.set(key, decision);
    }
  }

  /** Number of cached keys. Handy for tests and `/status`. */
  size(): number {
    return this.map.size;
  }

  /** Session-scoped reset. Fire on new session / `/clear`. */
  clear(): void {
    this.map.clear();
  }

  /**
   * Behaviour:
   *   - Empty `keys` → skip the cache entirely; call `fetchDecision`.
   *   - All keys already `approved_for_session` → return
   *     `approved_for_session` without fetching.
   *   - Otherwise fetch; if the fresh decision is
   *     `approved_for_session`, persist it under every key before
   *     returning.
   */
  async withCachedApproval(
    opts: WithCachedApprovalOpts<K>,
  ): Promise<ReviewDecision> {
    const { keys, fetchDecision } = opts;
    if (keys.length === 0) {
      return await fetchDecision();
    }

    const allAlreadyApproved = keys.every((k) => {
      const cached = this.get(k);
      return cached !== undefined && cached.kind === "approved_for_session";
    });
    if (allAlreadyApproved) {
      return { kind: "approved_for_session" };
    }

    const decision = await fetchDecision();
    if (decision.kind === "approved_for_session") {
      this.setMany(keys, decision);
    }
    return decision;
  }
}

// ─────────────────────────────────────────────────────────────────────
// SessionApprovalCache — session destination allow rules
// ─────────────────────────────────────────────────────────────────────

export interface SessionApprovalCacheSnapshot {
  readonly rules: readonly PermissionRuleValue[];
  readonly ruleStrings: readonly string[];
}

/**
 * Session-scoped cache of tool/pattern allow rules.
 *
 * "Approved for this session" is represented by adding allow rules to the
 * `session` destination. This wrapper keeps that source explicit and
 * deduped so UI, daemon, and tool dispatch code can share one representation.
 */
export class SessionApprovalCache {
  private readonly ruleStrings: Set<string> = new Set();

  constructor(initialRules?: readonly (PermissionRuleValue | string)[]) {
    if (initialRules) {
      for (const rule of initialRules) this.addRule(rule);
    }
  }

  /**
   * Record a whole-tool session approval, e.g. `Read`.
   *
   * Returns a `PermissionUpdate` only when this cache changed.
   */
  approveTool(toolName: string): PermissionUpdate | null {
    return this.approveRule({ toolName });
  }

  /**
   * Record a content-qualified approval, e.g. `Bash(git status)`.
   *
   * Empty pattern content collapses to a whole-tool approval, matching
   * `serializeRuleValue`.
   */
  approvePattern(
    toolName: string,
    ruleContent: string,
  ): PermissionUpdate | null {
    return this.approveRule({ toolName, ruleContent });
  }

  /**
   * Record any allow rule in the session cache.
   *
   * Returns `null` for duplicates so callers can skip unnecessary context
   * updates and persistence work.
   */
  approveRule(rule: PermissionRuleValue | string): PermissionUpdate | null {
    const normalized = normalizeRule(rule);
    if (!this.addRule(normalized)) return null;
    return sessionAllowUpdate([normalized]);
  }

  hasRule(rule: PermissionRuleValue | string): boolean {
    return this.ruleStrings.has(normalizeRuleString(rule));
  }

  hasTool(toolName: string): boolean {
    return this.hasRule({ toolName });
  }

  hasPattern(toolName: string, ruleContent: string): boolean {
    return this.hasRule({ toolName, ruleContent });
  }

  deleteRule(rule: PermissionRuleValue | string): boolean {
    return this.ruleStrings.delete(normalizeRuleString(rule));
  }

  clear(): void {
    this.ruleStrings.clear();
  }

  size(): number {
    return this.ruleStrings.size;
  }

  snapshot(): SessionApprovalCacheSnapshot {
    const ruleStrings = [...this.ruleStrings].sort();
    return Object.freeze({
      ruleStrings: Object.freeze(ruleStrings),
      rules: Object.freeze(ruleStrings.map((rule) => normalizeRule(rule))),
    });
  }

  toPermissionUpdate(): PermissionUpdate | null {
    const { rules } = this.snapshot();
    if (rules.length === 0) return null;
    return sessionAllowUpdate(rules);
  }

  mergeIntoContext(ctx: ToolPermissionContext): ToolPermissionContext {
    return mergeSessionApprovalsIntoContext(ctx, this.snapshot().rules);
  }

  private addRule(rule: PermissionRuleValue | string): boolean {
    const key = normalizeRuleString(rule);
    const sizeBefore = this.ruleStrings.size;
    this.ruleStrings.add(key);
    return this.ruleStrings.size !== sizeBefore;
  }
}

export function createSessionApprovalCacheFromContext(
  ctx: ToolPermissionContext,
): SessionApprovalCache {
  return new SessionApprovalCache(ctx.alwaysAllowRules.session ?? []);
}

export function hasSessionApproval(
  ctx: ToolPermissionContext,
  rule: PermissionRuleValue | string,
): boolean {
  return createSessionApprovalCacheFromContext(ctx).hasRule(rule);
}

export function mergeSessionApprovalsIntoContext(
  ctx: ToolPermissionContext,
  rules: readonly (PermissionRuleValue | string)[],
): ToolPermissionContext {
  const merged = new SessionApprovalCache(ctx.alwaysAllowRules.session ?? []);
  for (const rule of rules) merged.approveRule(rule);
  const { rules: mergedRules } = merged.snapshot();
  if (mergedRules.length === 0) return ctx;
  return applyPermissionUpdate(ctx, {
    type: "replaceRules",
    destination: "session",
    behavior: "allow",
    rules: mergedRules,
  });
}

function sessionAllowUpdate(
  rules: readonly PermissionRuleValue[],
): PermissionUpdate {
  return {
    type: "addRules",
    destination: "session",
    behavior: "allow",
    rules,
  };
}

function normalizeRule(rule: PermissionRuleValue | string): PermissionRuleValue {
  if (typeof rule !== "string") {
    return Object.freeze(
      rule.ruleContent !== undefined && rule.ruleContent.length > 0
        ? { toolName: rule.toolName, ruleContent: rule.ruleContent }
        : { toolName: rule.toolName },
    );
  }
  const parsed = parseRuleString(rule);
  return parsed ?? Object.freeze({ toolName: rule });
}

function normalizeRuleString(rule: PermissionRuleValue | string): string {
  return serializeRuleValue(normalizeRule(rule));
}

// ─────────────────────────────────────────────────────────────────────
// ShellApprovalKey
// ─────────────────────────────────────────────────────────────────────

/**
 * Approval key shape used by the shell runtime. Two requests that
 * produce equal keys reuse a prior `approved_for_session` decision.
 *
 * The `command` field is always the **canonicalized** argv; call
 * `buildShellApprovalKey` to get one and never construct these by
 * hand with a raw argv.
 */
export interface ShellApprovalKey {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly tty?: boolean;
  readonly sandbox_permissions: readonly string[];
  readonly additional_permissions: readonly string[];
}

export interface BuildShellApprovalKeyOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly tty?: boolean;
  readonly sandbox_permissions?: readonly string[];
  readonly additional_permissions?: readonly string[];
}

/**
 * Build a `ShellApprovalKey` with the argv already canonicalized and
 * the permission lists sorted (so `["net","fs"]` and `["fs","net"]`
 * collide in the cache). Sorting is explicit because JS does not normalize
 * array order.
 */
export function buildShellApprovalKey(
  opts: BuildShellApprovalKeyOptions,
): ShellApprovalKey {
  return {
    command: canonicalizeCommandForApproval(opts.command),
    cwd: opts.cwd,
    ...(opts.tty !== undefined ? { tty: opts.tty } : {}),
    sandbox_permissions: [...(opts.sandbox_permissions ?? [])].sort(),
    additional_permissions: [...(opts.additional_permissions ?? [])].sort(),
  };
}

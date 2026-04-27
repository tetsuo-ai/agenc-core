/**
 * ApprovalStore + canonical shell approval keys.
 *
 * Hand-port of AgenC runtime `core/src/tools/sandboxing.rs:40-116`
 * (`ApprovalStore`, `with_cached_approval`) and a subset of AgenC runtime
 * `core/src/command_canonicalization.rs` (T11 Wave 1, Agent C).
 *
 * Purpose
 * ───────
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
 *     with a `withCachedApproval` wrapper that encodes the AgenC runtime
 *     multi-key semantics.
 *   - `canonicalizeCommandForApproval` — subset of AgenC runtime's
 *     canonicalizer: collapses `bash -lc` / `bash -c` / `/bin/bash`
 *     wrappers to a stable argv and trims whitespace around the
 *     script text.
 *   - `ShellApprovalKey` + `buildShellApprovalKey` — the shape
 *     `ShellRuntime` uses as its approval key.
 *
 * @module
 */

import type { ReviewDecision } from "./review-decision.js";

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
  return JSON.stringify(value, stableReplacer);
}

function stableReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────
// ApprovalStore — AgenC runtime `tools/sandboxing.rs:40-62`
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
   * Port of AgenC runtime `with_cached_approval` (tools/sandboxing.rs:70-116).
   *
   * Behaviour:
   *   - Empty `keys` → skip the cache entirely; call `fetchDecision`.
   *     (Matches AgenC runtime `if keys.is_empty()` branch.)
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
// canonicalizeCommandForApproval — subset of AgenC runtime
// `command_canonicalization.rs`.
// ─────────────────────────────────────────────────────────────────────

const BASH_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
]);
const BASH_WRAPPER_FLAGS: ReadonlySet<string> = new Set(["-lc", "-c"]);

/** Canonical marker AgenC runtime uses to tag shell scripts that cannot be
 *  cleanly tokenized (heredocs, pipes, etc.). */
const CANONICAL_BASH_SCRIPT_PREFIX = "__agenc_shell_script__";

/**
 * Collapse argv-invariant differences between equivalent shell
 * wrappers so the approval cache can hit across them.
 *
 * AgenC runtime does full bash tokenization to split `bash -lc "cargo test"`
 * into `["cargo", "test"]`. AgenC Wave 1 handles the common cases:
 *
 *   1. `bash -lc "X"`, `bash -c "X"`, `/bin/bash -lc "X"`,
 *      `/usr/bin/zsh -lc "X"` with a simple whitespace-split
 *      command (no pipes / redirects / heredocs / quotes) → splits
 *      into the plain argv. `"cargo   test  -p core"` → `["cargo",
 *      "test", "-p", "core"]`.
 *   2. More complex scripts → fall back to a canonical script key
 *      `[CANONICAL_BASH_SCRIPT_PREFIX, flag, trimmed_script]`.
 *   3. Non-shell commands (no wrapper match) → return the argv as-is.
 *
 * Unix case matters, so nothing is lower-cased.
 */
export function canonicalizeCommandForApproval(
  command: readonly string[],
): readonly string[] {
  if (command.length < 3) return command.slice();
  const [binary, flag, script, ...rest] = command;
  if (rest.length > 0) return command.slice();
  if (binary === undefined || flag === undefined || script === undefined) {
    return command.slice();
  }

  const binaryName = basenameNoExt(binary);
  if (!BASH_WRAPPER_NAMES.has(binaryName)) return command.slice();
  if (!BASH_WRAPPER_FLAGS.has(flag)) return command.slice();

  const trimmedScript = script.trim();
  if (trimmedScript.length === 0) return command.slice();

  if (isSimplePlainCommand(trimmedScript)) {
    return trimmedScript.split(/\s+/).filter((s) => s.length > 0);
  }

  return [CANONICAL_BASH_SCRIPT_PREFIX, flag, trimmedScript];
}

/**
 * Cheap check: the script is a single command made of whitespace-
 * separated words with no shell metacharacters, quotes, or newlines.
 *
 * If this returns false, we fall back to the opaque script key so we
 * don't accidentally collide semantically different scripts. Being
 * conservative here matters — the approval cache grants
 * session-durable permission.
 */
function isSimplePlainCommand(script: string): boolean {
  if (script.length === 0) return false;
  // Reject any shell metacharacter, newline, or quote. The regex is
  // intentionally strict: anything outside [word, -, _, /, ., space,
  // =, :, ,, @] means a non-trivial shell script and we should not
  // try to tokenize it.
  return /^[\w\-_/.\s=:,@]+$/.test(script);
}

function basenameNoExt(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const name = idx >= 0 ? p.slice(idx + 1) : p;
  // Strip .exe so `powershell.exe` and `bash.exe` collapse to the
  // base name. (AgenC Wave 1 does not port PowerShell, but keeping
  // the strip consistent costs nothing.)
  if (name.toLowerCase().endsWith(".exe")) {
    return name.slice(0, -4);
  }
  return name;
}

// ─────────────────────────────────────────────────────────────────────
// ShellApprovalKey — AgenC runtime `tools/runtimes/shell.rs:131-213`
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
 * collide in the cache). AgenC runtime uses `Hash` + `Eq` derives + a sorted
 * permissions struct to guarantee this — we replicate the sort
 * explicitly since JS doesn't normalize array order.
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

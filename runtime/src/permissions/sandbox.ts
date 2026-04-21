/**
 * SandboxPolicy — AgenC filesystem + network permission surface.
 *
 * Hand-port of codex `protocol/src/protocol.rs:986-1310` (T11 Wave 1,
 * Agent C).
 *
 * AgenC vs codex sandboxing
 * ─────────────────────────
 * Codex enforces sandboxing through OS-level primitives:
 *   - macOS Seatbelt (`sandbox-exec`)
 *   - Linux Landlock + seccomp-bpf
 *   - Windows AppContainer
 *
 * AgenC **does not** use any of those primitives directly. Instead,
 * the runtime relies on:
 *   1. **Worktree isolation** — model-facing work happens under a
 *      checked-out worktree / session workspace rooted at cwd.
 *   2. **Permission evaluator** — every tool call is classified by
 *      the permissions layer (approval-policy + allowlist + denylist)
 *      before dispatch; the executor never invokes a forbidden tool.
 *   3. **cwd jail** — shell/exec runtimes validate that file-writing
 *      arguments resolve under `getWritableRootsWithCwd(policy, cwd)`
 *      before delegating to the system. Paths outside writable roots
 *      raise `SandboxDeniedError` and escalate through the approval
 *      path (see `tools/orchestrator.ts`).
 *
 * This file only carries **policy shape + resolution helpers**. Zero
 * OS calls live here. The runtime is free to layer an external
 * sandbox (`ExternalSandbox`) on top when the operator opts in, but
 * the policy resolution math is identical regardless.
 *
 * Wire format note
 * ────────────────
 * Codex serializes the tag using `kebab-case`: `"danger-full-access"`,
 * `"read-only"`, `"workspace-write"`, `"external-sandbox"`. AgenC keeps
 * the runtime-internal type tags in `snake_case` (`{ kind: "read_only" }`)
 * because the TypeScript switch statements already use that form across
 * the codebase. Wire parsers/serializers live in the config layer and
 * translate between `kebab-case` (user-facing) and `snake_case`
 * (runtime-internal).
 *
 * @module
 */

import path from "node:path";

// ─────────────────────────────────────────────────────────────────────
// Leaf types
// ─────────────────────────────────────────────────────────────────────

/**
 * High-level sandbox mode selector. The full policy shape is
 * `SandboxPolicy`; `SandboxMode` is the 3-variant CLI/config selector.
 *
 * Wire format uses kebab-case (`"read-only"`, `"workspace-write"`,
 * `"danger-full-access"`). Runtime code already operates in snake_case,
 * so the config layer handles the mapping.
 */
export type SandboxMode =
  | "read_only"
  | "workspace_write"
  | "danger_full_access";

/** Port of codex `NetworkAccess` (protocol.rs:898-914). */
export interface NetworkAccess {
  readonly mode: "enabled" | "disabled";
}

export const NETWORK_DISABLED: NetworkAccess = { mode: "disabled" };
export const NETWORK_ENABLED: NetworkAccess = { mode: "enabled" };

/**
 * Port of codex `ReadOnlyAccess` (protocol.rs:925-943). Controls how
 * restricted read access is scoped inside a sandboxed policy.
 */
export type ReadOnlyAccess =
  | { readonly kind: "full_access" }
  | {
      readonly kind: "restricted";
      readonly include_platform_defaults: boolean;
      readonly readable_roots: readonly string[];
    };

export const READ_ONLY_ACCESS_FULL: ReadOnlyAccess = { kind: "full_access" };

/**
 * A writable root with the subpaths inside it that must remain
 * read-only. Port of codex `WritableRoot` (protocol.rs:1059-1083).
 *
 * Typical `read_only_subpaths` examples:
 *   - `<root>/.git/hooks`  — prevents hook injection escalation
 *   - `<root>/.agenc`      — runtime state directory (parity for
 *                             codex `.codex`)
 */
export interface WritableRoot {
  readonly root: string;
  readonly read_only_subpaths: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────
// SandboxPolicy — 4 variants, codex parity.
// ─────────────────────────────────────────────────────────────────────

export type SandboxPolicy =
  | { readonly kind: "danger_full_access" }
  | {
      readonly kind: "read_only";
      readonly access: ReadOnlyAccess;
      readonly network_access: NetworkAccess;
    }
  | {
      readonly kind: "workspace_write";
      readonly writable_roots: readonly WritableRoot[];
      readonly read_only_access: ReadOnlyAccess;
      readonly network_access: NetworkAccess;
      readonly exclude_tmpdir_env_var: boolean;
      readonly exclude_slash_tmp: boolean;
    }
  | {
      readonly kind: "external_sandbox";
      readonly network_access: NetworkAccess;
    };

// ─────────────────────────────────────────────────────────────────────
// Convenience constructors
// ─────────────────────────────────────────────────────────────────────

export function newDangerFullAccessPolicy(): SandboxPolicy {
  return { kind: "danger_full_access" };
}

export function newReadOnlyPolicy(
  options: {
    readonly access?: ReadOnlyAccess;
    readonly network?: NetworkAccess;
  } = {},
): SandboxPolicy {
  return {
    kind: "read_only",
    access: options.access ?? READ_ONLY_ACCESS_FULL,
    network_access: options.network ?? NETWORK_DISABLED,
  };
}

export function newWorkspaceWritePolicy(
  options: {
    readonly writable_roots?: readonly WritableRoot[];
    readonly read_only_access?: ReadOnlyAccess;
    readonly network?: NetworkAccess;
    readonly exclude_tmpdir_env_var?: boolean;
    readonly exclude_slash_tmp?: boolean;
  } = {},
): SandboxPolicy {
  return {
    kind: "workspace_write",
    writable_roots: options.writable_roots ?? [],
    read_only_access: options.read_only_access ?? READ_ONLY_ACCESS_FULL,
    network_access: options.network ?? NETWORK_DISABLED,
    exclude_tmpdir_env_var: options.exclude_tmpdir_env_var ?? false,
    exclude_slash_tmp: options.exclude_slash_tmp ?? false,
  };
}

export function newExternalSandboxPolicy(network?: NetworkAccess): SandboxPolicy {
  return {
    kind: "external_sandbox",
    network_access: network ?? NETWORK_DISABLED,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Query helpers — codex parity
// ─────────────────────────────────────────────────────────────────────

/**
 * Default read-only blacklist subpaths for a writable root. Port of
 * codex `default_read_only_subpaths_for_writable_root`
 * (protocol.rs:1294-1325). Kept conservative at T11 Wave 1 —
 * filesystem inspection (`is_dir`/`is_file`) is deferred to the
 * caller where needed. This function returns the standard "always
 * blacklist inside a writable root" paths.
 */
export function defaultReadOnlySubpathsFor(
  rootPath: string,
): readonly string[] {
  const normalized = normalizePath(rootPath);
  return [
    path.join(normalized, ".git"),
    path.join(normalized, ".agenc"),
    path.join(normalized, ".agents"),
  ];
}

/**
 * Port of codex `SandboxPolicy::get_writable_roots_with_cwd`
 * (protocol.rs:1203-1291).
 *
 * Resolution order:
 *   1. Start from `policy.writable_roots` (when applicable).
 *   2. Always push `cwd`.
 *   3. On POSIX, push `/tmp` unless `exclude_slash_tmp`.
 *   4. Push `$TMPDIR` (when set and non-empty) unless
 *      `exclude_tmpdir_env_var`.
 *   5. Each root's `read_only_subpaths` is the default blacklist.
 */
export function getWritableRootsWithCwd(
  policy: SandboxPolicy,
  cwd: string,
): WritableRoot[] {
  if (policy.kind !== "workspace_write") {
    return [];
  }
  const cwdNorm = normalizePath(cwd);
  const collected: string[] = [];
  const push = (p: string) => {
    const n = normalizePath(p);
    if (!collected.includes(n)) collected.push(n);
  };

  for (const root of policy.writable_roots) push(root.root);
  push(cwdNorm);

  if (isPosix() && !policy.exclude_slash_tmp) {
    push("/tmp");
  }
  if (!policy.exclude_tmpdir_env_var) {
    const tmpdir = process.env["TMPDIR"];
    if (tmpdir && tmpdir.length > 0) {
      push(tmpdir);
    }
  }

  // For each collected root, compute the read-only subpaths. If the
  // caller supplied explicit subpaths for one of the configured roots,
  // honor those; otherwise use the default blacklist.
  return collected.map<WritableRoot>((root) => {
    const configured = policy.writable_roots.find(
      (r) => normalizePath(r.root) === root,
    );
    const subpaths =
      configured && configured.read_only_subpaths.length > 0
        ? configured.read_only_subpaths.map(normalizePath)
        : defaultReadOnlySubpathsFor(root);
    return { root, read_only_subpaths: subpaths };
  });
}

/**
 * Does the policy allow writing to `absPath` given `cwd`?
 *
 * This is a pure policy-math function:
 *   - `danger_full_access` / `external_sandbox` → always writable.
 *   - `read_only`                              → never writable.
 *   - `workspace_write`                        → writable iff the
 *     path resolves under one of the writable roots AND is not under
 *     any `read_only_subpaths` of that root.
 *
 * No filesystem calls. No OS primitives.
 */
export function isPathWritable(
  policy: SandboxPolicy,
  absPath: string,
  cwd: string,
): boolean {
  switch (policy.kind) {
    case "danger_full_access":
    case "external_sandbox":
      return true;
    case "read_only":
      return false;
    case "workspace_write": {
      const target = normalizePath(absPath);
      const roots = getWritableRootsWithCwd(policy, cwd);
      for (const root of roots) {
        if (!isPathUnder(target, root.root)) continue;
        const blocked = root.read_only_subpaths.some((sub) =>
          isPathUnder(target, sub),
        );
        if (!blocked) return true;
      }
      return false;
    }
    default: {
      const _exhaustive: never = policy;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Does the policy permit outbound network access? Port of codex
 * `SandboxPolicy::has_full_network_access` (protocol.rs:1151-1158).
 */
export function sandboxAllowsNetwork(policy: SandboxPolicy): boolean {
  switch (policy.kind) {
    case "danger_full_access":
      return true;
    case "external_sandbox":
    case "read_only":
    case "workspace_write":
      return policy.network_access.mode === "enabled";
    default: {
      const _exhaustive: never = policy;
      void _exhaustive;
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// SandboxDeniedError — thrown when a tool invocation violates policy.
// ─────────────────────────────────────────────────────────────────────

export type SandboxDenialKind = "filesystem" | "network";

export interface SandboxDeniedDetail {
  readonly denial: SandboxDenialKind;
  readonly target: string;
  readonly policy: SandboxPolicy;
}

/**
 * Raised when the permission evaluator determines the requested
 * operation violates the active sandbox policy. The orchestrator
 * catches this (see `tools/orchestrator.ts`) and routes through the
 * approval escalation path.
 */
export class SandboxDeniedError extends Error {
  readonly kind = "sandbox_denied" as const;
  readonly denial: SandboxDenialKind;
  readonly target: string;
  readonly policy: SandboxPolicy;

  constructor(message: string, detail: SandboxDeniedDetail) {
    super(message);
    this.name = "SandboxDeniedError";
    this.denial = detail.denial;
    this.target = detail.target;
    this.policy = detail.policy;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internal path helpers
// ─────────────────────────────────────────────────────────────────────

function isPosix(): boolean {
  return path.sep === "/";
}

function normalizePath(p: string): string {
  if (p.length === 0) return p;
  // Keep absolute path semantics but collapse redundant separators
  // and trim trailing slashes so prefix comparisons are stable.
  const resolved = path.isAbsolute(p) ? path.normalize(p) : path.normalize(p);
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * Is `candidate` the same as `root` or a descendant of it? Uses
 * `path.sep` boundary matching so `/a/b` is NOT treated as under
 * `/a/bc`.
 */
function isPathUnder(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(rootWithSep);
}

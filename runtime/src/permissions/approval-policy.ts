/**
 * ApprovalPolicy — when / whether to ask the user for permission.
 *
 * Hand-port of codex `protocol/src/protocol.rs:826-896` and the
 * decision table at `core/src/tools/sandboxing.rs:185-221` (T11 Wave 1,
 * Agent C).
 *
 * This file is the single canonical source for `ApprovalPolicy`,
 * `GranularApprovalConfig`, `FileSystemSandboxKind`,
 * `ExecApprovalRequirement`, and `defaultExecApprovalRequirement`.
 * `runtime/src/tools/orchestrator.ts` re-exports from here; no other
 * file in the runtime owns its own copy.
 *
 * Wire format note
 * ────────────────
 * Codex serializes the enum as `kebab-case`: `"never"`, `"on-failure"`,
 * `"on-request"`, `"granular"`, `"untrusted"`. AgenC runtime code
 * already operates on the `snake_case` form (`"on_request"`, etc.)
 * across ~12 files; the config layer handles the kebab→snake mapping
 * at parse time. This file uses the runtime-internal form.
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────
// ApprovalPolicy — codex `AskForApproval` (protocol.rs:826-857)
// ─────────────────────────────────────────────────────────────────────

/**
 * When does the runtime ask the user to approve a tool call?
 *
 *   - `untrusted`  — always ask unless the tool is explicitly trusted.
 *   - `on_failure` — (deprecated) ask only after a sandboxed run fails.
 *   - `on_request` — the model decides when to ask. (Default.)
 *   - `granular`   — fine-grained per-subsystem opt-ins
 *     (`GranularApprovalConfig`).
 *   - `never`      — never ask; failures go straight back to the model.
 */
export type ApprovalPolicy =
  | "never"
  | "on_failure"
  | "on_request"
  | "granular"
  | "untrusted";

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "on_request";

/**
 * Port of codex `GranularApprovalConfig` (protocol.rs:859-874).
 * When an entry is `false`, the corresponding approval prompt is
 * auto-rejected instead of shown.
 */
export interface GranularApprovalConfig {
  readonly sandbox_approval: boolean;
  readonly rules: boolean;
  readonly skill_approval: boolean;
  readonly request_permissions: boolean;
  readonly mcp_elicitations: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// FileSystemSandboxKind — codex `FileSystemSandboxKind`
// ─────────────────────────────────────────────────────────────────────

/**
 * Narrow view of `SandboxPolicy.kind` that the approval decision
 * table reads. `full_access` covers `danger_full_access` and any
 * mode whose `ReadOnlyAccess` is unrestricted; `restricted` covers
 * `read_only` / `workspace_write` when access is limited.
 *
 * Codex also carries an `external_sandbox` kind. AgenC preserves that
 * (via `SandboxMode`) but the approval table itself only distinguishes
 * `full_access` vs `restricted`.
 */
export type FileSystemSandboxKind = "full_access" | "restricted";

// ─────────────────────────────────────────────────────────────────────
// Policy resolution — CLI > project trust > config > default.
// ─────────────────────────────────────────────────────────────────────

export type ProjectTrust = "trusted" | "untrusted" | undefined;

export interface ResolveApprovalPolicyOptions {
  readonly configPolicy?: ApprovalPolicy;
  readonly cliOverride?: ApprovalPolicy;
  readonly projectTrust?: ProjectTrust;
}

/**
 * Resolve the effective approval policy.
 *
 * Precedence (matches codex):
 *   1. CLI override wins outright (user typed `--ask-for-approval …`).
 *   2. Project trust file:
 *        - `trusted`   → `on_request`
 *        - `untrusted` → `untrusted`
 *   3. Config file value.
 *   4. `DEFAULT_APPROVAL_POLICY` (`on_request`).
 */
export function resolveApprovalPolicy(
  opts: ResolveApprovalPolicyOptions,
): ApprovalPolicy {
  if (opts.cliOverride !== undefined) {
    return opts.cliOverride;
  }
  if (opts.projectTrust === "trusted") {
    return "on_request";
  }
  if (opts.projectTrust === "untrusted") {
    return "untrusted";
  }
  return opts.configPolicy ?? DEFAULT_APPROVAL_POLICY;
}

// ─────────────────────────────────────────────────────────────────────
// ExecApprovalRequirement — per-tool decision.
// ─────────────────────────────────────────────────────────────────────

/**
 * The resolved decision for a single tool invocation. Port of codex
 * `ExecApprovalRequirement` (tools/sandboxing.rs:141-162).
 */
export type ExecApprovalRequirement =
  | { readonly kind: "skip"; readonly bypassSandbox: boolean }
  | { readonly kind: "forbidden"; readonly reason: string }
  | { readonly kind: "needs_approval"; readonly reason?: string };

/**
 * Port of codex `default_exec_approval_requirement`
 * (tools/sandboxing.rs:185-221).
 *
 * Given the current approval policy + filesystem sandbox kind,
 * decide whether the tool call should skip approval, ask for it,
 * or be forbidden outright.
 *
 *   | policy       | fs kind     | granular.sandbox_approval | decision        |
 *   |--------------|-------------|---------------------------|-----------------|
 *   | never        | any         | —                         | skip            |
 *   | on_failure   | any         | —                         | skip            |
 *   | on_request   | full_access | —                         | skip            |
 *   | on_request   | restricted  | —                         | needs_approval  |
 *   | granular     | full_access | —                         | skip            |
 *   | granular     | restricted  | true                      | needs_approval  |
 *   | granular     | restricted  | false                     | forbidden       |
 *   | untrusted    | any         | —                         | needs_approval  |
 *
 * The `granular` + forbidden branch uses the exact codex message so
 * downstream logs and tests round-trip cleanly.
 */
export function defaultExecApprovalRequirement(
  policy: ApprovalPolicy,
  fsKind: FileSystemSandboxKind,
  granular?: GranularApprovalConfig,
): ExecApprovalRequirement {
  let needsApproval = false;
  switch (policy) {
    case "never":
    case "on_failure":
      needsApproval = false;
      break;
    case "on_request":
    case "granular":
      needsApproval = fsKind === "restricted";
      break;
    case "untrusted":
      needsApproval = true;
      break;
    default: {
      const _exhaustive: never = policy;
      void _exhaustive;
    }
  }

  if (
    needsApproval &&
    policy === "granular" &&
    granular !== undefined &&
    !granular.sandbox_approval
  ) {
    return {
      kind: "forbidden",
      reason: "approval policy disallowed sandbox approval prompt",
    };
  }
  if (needsApproval) {
    return { kind: "needs_approval" };
  }
  return { kind: "skip", bypassSandbox: false };
}

import {
  immutableToolPermissionContext,
  type PermissionAllowDecision,
  type PermissionAskDecision,
  type PermissionDenyDecision,
  type ToolPermissionContext,
} from "./types.js";
import { isRemovedLiveToolName } from "./tool-names.js";

export interface UnattendedPermissionPolicy {
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
  /**
   * Proceed alone on read-only work, refuse the rest outright.
   *
   * Set only for a run with nobody attached to answer an approval, where the
   * default `pause` has no answer and parks the run forever. It never widens
   * anything: it turns pause into allow for the narrow set decided in
   * `read-only-grant.ts`, and into deny for everything else.
   */
  readonly readOnly: boolean;
  /**
   * A routine run in acceptEdits or bypassPermissions: nobody is attached,
   * and the run keeps its mode. What the mode allows proceeds; what would ask
   * a person is refused instead of parking the run (see evaluator.ts,
   * decideWithoutApprover). Present only when set.
   */
  readonly noApprover?: true;
  /**
   * With `noApprover`: the only roots file writes may land in, even under
   * bypassPermissions. The routine's own workspace, never the daemon's.
   */
  readonly workspaceRoots?: readonly string[];
}

export type UnattendedPermissionDecision =
  | { readonly behavior: "allow"; readonly toolName: string }
  | { readonly behavior: "deny"; readonly toolName: string }
  | { readonly behavior: "pause"; readonly toolName: string };

export const DEFAULT_UNATTENDED_ALLOWLIST = Object.freeze([] as const);

// Distinct canonical tools that carry the same execution risk intentionally
// collapse to one unattended-policy bucket. Removed spellings are not accepted
// here; the explicit config migration rewrites them once.
const TOOL_RISK_FAMILIES = Object.freeze({
  exec_command: "system.bash",
  write_stdin: "system.bash",
  kill_process: "system.bash",
  PowerShell: "system.bash",
  Monitor: "system.bash",
  Write: "Edit",
  MultiEdit: "Edit",
  apply_patch: "Edit",
} as const);

function canonicalUnattendedToolName(value: string): string {
  const trimmed = value.trim();
  if (isRemovedLiveToolName(trimmed)) {
    throw new Error(
      `removed unattended tool name '${trimmed}'; use its canonical dispatch name`,
    );
  }
  const family = TOOL_RISK_FAMILIES[
    trimmed as keyof typeof TOOL_RISK_FAMILIES
  ];
  return family ?? trimmed;
}

export function normalizeUnattendedToolList(
  values: readonly string[] | undefined,
  fallback?: readonly string[],
): readonly string[] {
  const raw = values ?? fallback ?? [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of raw) {
    const toolName = canonicalUnattendedToolName(value);
    if (toolName.length === 0 || seen.has(toolName)) continue;
    seen.add(toolName);
    normalized.push(toolName);
  }
  return Object.freeze(normalized);
}

export interface UnattendedPermissionPolicyOptions {
  readonly allowlist?: readonly string[];
  readonly denylist?: readonly string[];
  readonly readOnly?: boolean;
  readonly noApprover?: boolean;
  readonly workspaceRoots?: readonly string[];
}

export function createUnattendedPermissionPolicy(
  opts: UnattendedPermissionPolicyOptions = {},
): UnattendedPermissionPolicy {
  const workspaceRoots = (opts.workspaceRoots ?? []).filter(
    (root) => typeof root === "string" && root.trim().length > 0,
  );
  if (opts.noApprover === true && workspaceRoots.length === 0) {
    // Refuse a policy that would confine writes to nowhere by accident and
    // quietly read as "no confinement" somewhere else.
    throw new Error("an unattended no-approver policy needs the run's workspace root");
  }
  return Object.freeze({
    allowlist: normalizeUnattendedToolList(
      opts.allowlist,
      DEFAULT_UNATTENDED_ALLOWLIST,
    ),
    denylist: normalizeUnattendedToolList(opts.denylist),
    readOnly: opts.readOnly === true,
    // Present only when set, so every other caller stays byte-identical.
    ...(opts.noApprover === true
      ? {
          noApprover: true as const,
          workspaceRoots: Object.freeze([...workspaceRoots]),
        }
      : {}),
  });
}

/**
 * The roots a no-approver routine run may write files in, or undefined when
 * this context carries no such confinement.
 */
export function unattendedWriteRoots(
  context: Pick<ToolPermissionContext, "unattendedPolicy">,
): readonly string[] | undefined {
  const policy = context.unattendedPolicy;
  return policy?.noApprover === true ? (policy.workspaceRoots ?? []) : undefined;
}

export function unattendedPolicyForContext(
  context: ToolPermissionContext,
): UnattendedPermissionPolicy {
  return context.unattendedPolicy ?? createUnattendedPermissionPolicy();
}

export function applyUnattendedPermissionPolicyToContext(
  context: ToolPermissionContext,
  opts: UnattendedPermissionPolicyOptions = {},
): ToolPermissionContext {
  // Preserve modes the user explicitly opted into. The user chose
  // bypassPermissions (--dangerously-bypass-approvals-and-sandbox), plan (--permission-mode plan / EnterPlanMode),
  // or acceptEdits (--permission-mode acceptEdits / approving a plan with
  // auto-accept); the background-agent-runner's unattended-policy install —
  // which runs on every startAgent/restoreAgent that carries an allowlist,
  // a denylist, or the routine read-only grant — MUST NOT override those.
  // A run without any of these keeps its mode: the runner does not call
  // this at all, so a `default` TUI or print-mode session stays `default`.
  //
  // Without this guard, every daemon session with an explicit mode had it
  // silently rewritten to "unattended": with --dangerously-bypass-approvals-and-sandbox the evaluator's unattended
  // branch surfaced "Permission required" overlays (GAP-PE-PREHOOK-BYPASS-LEAK);
  // with plan mode the registry the live ExitPlanMode reads
  // (planning.ts: registry.current().mode) saw "unattended" instead of "plan",
  // so ExitPlanMode failed its mode guard with "You are not in plan mode" and
  // the plan-approval mode choice (acceptEdits/default/keep-planning) never
  // took effect — plan mode was unusable in the daemon TUI. The unattended
  // policy itself (allowlist/denylist) is still recorded for any subset logic
  // that wants to consult it, but the mode stays at the user's explicit choice.
  const preserveMode =
    context.mode === "bypassPermissions" ||
    context.mode === "plan" ||
    context.mode === "acceptEdits";
  return immutableToolPermissionContext({
    ...context,
    mode: preserveMode ? context.mode : "unattended",
    unattendedPolicy: createUnattendedPermissionPolicy(opts),
  });
}

export function resolveUnattendedPermissionDecision(
  context: ToolPermissionContext,
  toolName: string,
): UnattendedPermissionDecision {
  const policy = unattendedPolicyForContext(context);
  const canonical = canonicalUnattendedToolName(toolName);
  if (policy.denylist.includes(canonical)) {
    return { behavior: "deny", toolName: canonical };
  }
  if (policy.allowlist.includes(canonical)) {
    return { behavior: "allow", toolName: canonical };
  }
  return { behavior: "pause", toolName: canonical };
}

export function unattendedAllowDecision(
  toolName: string,
  input: unknown,
  updatedInput?: Record<string, unknown>,
): PermissionAllowDecision {
  const nextInput = updatedInput ?? inputAsRecord(input);
  return {
    behavior: "allow",
    ...(nextInput !== undefined ? { updatedInput: nextInput } : {}),
    decisionReason: {
      type: "other",
      reason: `unattended allowlist: ${toolName}`,
    },
  };
}

export function unattendedDenyDecision(
  toolName: string,
): PermissionDenyDecision {
  return {
    behavior: "deny",
    message: `Permission to use ${toolName} was denied by unattended policy.`,
    decisionReason: {
      type: "other",
      reason: `unattended denylist: ${toolName}`,
    },
  };
}

export function unattendedPauseDecision(
  toolName: string,
  askResult: PermissionAskDecision | null,
): PermissionAskDecision {
  return askResult ?? {
    behavior: "ask",
    message: `Permission required to use ${toolName}`,
    decisionReason: {
      type: "other",
      reason: `unattended pause: ${toolName}`,
    },
  };
}

function inputAsRecord(input: unknown): Record<string, unknown> | undefined {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return undefined;
}

import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  ToolPermissionContext,
} from "./types.js";

export interface UnattendedPermissionPolicy {
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
}

export type UnattendedPermissionDecision =
  | { readonly behavior: "allow"; readonly toolName: string }
  | { readonly behavior: "deny"; readonly toolName: string }
  | { readonly behavior: "pause"; readonly toolName: string };

export const DEFAULT_UNATTENDED_ALLOWLIST = Object.freeze([] as const);

const REMOVED_DAEMON_SEARCH_ALIASES = Object.freeze({
  ["system" + ".grep"]: "Grep",
  ["system" + ".glob"]: "Glob",
} as const);

const TOOL_ALIASES = Object.freeze({
  bash: "system.bash",
  // gaphunt3 #27: collapse the whole shell-exec tool family onto system.bash so
  // an operator denylist of Bash/bash/system.bash also covers exec_command and
  // desktop.bash, which run identical arbitrary shell commands. Without these
  // aliases canonicalUnattendedToolName("exec_command") stayed literal and a
  // "Bash" deny silently left exec_command/desktop.bash un-denied (paused or
  // allowed) in unattended/--autonomous mode.
  exec_command: "system.bash",
  "desktop.bash": "system.bash",
  // TOOL-02 / SEC-04: stdin/kill/shell aliases collapse onto system.bash.
  write_stdin: "system.bash",
  kill_process: "system.bash",
  shell: "system.bash",
  powershell: "system.bash",
  monitor: "system.bash",
  fileedit: "Edit",
  filewrite: "Write",
  // TOOL-05: mutation family collapses onto Edit for unattended denylist.
  multiedit: "Edit",
  apply_patch: "Edit",
  read: "FileRead",
  grep: "Grep",
  glob: "Glob",
  ...REMOVED_DAEMON_SEARCH_ALIASES,
} as const);

function canonicalUnattendedToolName(value: string): string {
  const trimmed = value.trim();
  const alias = TOOL_ALIASES[trimmed.toLowerCase() as keyof typeof TOOL_ALIASES];
  return alias ?? trimmed;
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

export function createUnattendedPermissionPolicy(
  opts: {
    readonly allowlist?: readonly string[];
    readonly denylist?: readonly string[];
  } = {},
): UnattendedPermissionPolicy {
  return Object.freeze({
    allowlist: normalizeUnattendedToolList(
      opts.allowlist,
      DEFAULT_UNATTENDED_ALLOWLIST,
    ),
    denylist: normalizeUnattendedToolList(opts.denylist),
  });
}

export function unattendedPolicyForContext(
  context: ToolPermissionContext,
): UnattendedPermissionPolicy {
  return context.unattendedPolicy ?? createUnattendedPermissionPolicy();
}

export function applyUnattendedPermissionPolicyToContext(
  context: ToolPermissionContext,
  opts: {
    readonly allowlist?: readonly string[];
    readonly denylist?: readonly string[];
  } = {},
): ToolPermissionContext {
  // Preserve modes the user explicitly opted into. The user chose
  // bypassPermissions (--yolo), plan (--permission-mode plan / EnterPlanMode),
  // or acceptEdits (--permission-mode acceptEdits / approving a plan with
  // auto-accept); the background-agent-runner's default unattended-policy
  // install — which runs on every startAgent/restoreAgent because the daemon
  // always forces --autonomous — MUST NOT override those.
  //
  // Without this guard, every daemon session with an explicit mode had it
  // silently rewritten to "unattended": with --yolo the evaluator's unattended
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
  return {
    ...context,
    mode: preserveMode ? context.mode : "unattended",
    unattendedPolicy: createUnattendedPermissionPolicy(opts),
  };
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

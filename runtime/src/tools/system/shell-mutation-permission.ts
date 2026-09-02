import { resolve } from "node:path";
import { resolveHomeContext } from "../../config/home.js";

import {
  readToolRuntimeContext,
  type ToolRuntimeAttemptContext,
} from "../runtimes/context.js";

/**
 * Permission modes in which the session edits workspace files without asking
 * first. A shell removal or move of a workspace file is the same class of
 * mutation, so it needs no separate approval in these modes.
 */
const PROMPT_FREE_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "bypassPermissions",
  "acceptEdits",
  "auto",
]);

/**
 * Approval policies under which the session never asks before running a
 * command; the sandbox is the boundary there, not a prompt.
 */
const PROMPT_FREE_APPROVAL_POLICIES: ReadonlySet<
  ToolRuntimeAttemptContext["approvalPolicy"]
> = new Set(["never", "on_failure"]);

export interface ShellWorkspaceMutationPermission {
  readonly allowWorkspaceDeletions: boolean;
  readonly protectedRoots: readonly string[];
}

type SessionLike = {
  readonly permissionModeRegistry?: { readonly current?: () => unknown };
  readonly services?: {
    readonly permissionModeRegistry?: { readonly current?: () => unknown };
    readonly configStore?: { readonly homeContext?: { readonly path?: unknown } };
  };
};

function sessionOf(
  context: ToolRuntimeAttemptContext | undefined,
): SessionLike | undefined {
  const session = context?.invocation?.session as SessionLike | undefined;
  return typeof session === "object" && session !== null ? session : undefined;
}

function sessionPermissionMode(
  context: ToolRuntimeAttemptContext | undefined,
): string | undefined {
  const session = sessionOf(context);
  const registry =
    session?.permissionModeRegistry ?? session?.services?.permissionModeRegistry;
  if (registry === undefined || typeof registry.current !== "function") {
    return undefined;
  }
  try {
    const mode = (registry.current() as { readonly mode?: unknown } | null)?.mode;
    return typeof mode === "string" ? mode : undefined;
  } catch {
    // The registry fences reads while an external authority publishes a new
    // context; an unreadable mode is treated as one that prompts.
    return undefined;
  }
}

/**
 * Whether the call may remove or move files that already exist in the
 * workspace without a further prompt: the approval resolver accepted this
 * exact call, the session never asks before running commands, or the
 * permission mode lets the session edit without asking.
 */
export function shellWorkspaceDeletionsAllowed(
  context: ToolRuntimeAttemptContext | undefined,
): boolean {
  if (context === undefined) return false;
  if (context.approvalResolved) return true;
  if (PROMPT_FREE_APPROVAL_POLICIES.has(context.approvalPolicy)) return true;
  const mode = sessionPermissionMode(context);
  return mode !== undefined && PROMPT_FREE_PERMISSION_MODES.has(mode);
}

/** The AgenC home directories a shell command may never remove. */
export function shellDeletionProtectedRoots(
  context: ToolRuntimeAttemptContext | undefined,
): readonly string[] {
  const roots = new Set<string>();
  try {
    const homePath = sessionOf(context)?.services?.configStore?.homeContext?.path;
    if (typeof homePath === "string" && homePath.trim().length > 0) {
      roots.add(resolve(homePath.trim()));
    }
  } catch {
    // A store without a resolvable home contributes nothing.
  }
  // Without a session there is still a home to protect, and it is not always
  // the one AGENC_HOME names: when the variable is unset the home is the
  // platform default, which a raw env read leaves unguarded entirely. Resolve
  // it through the canonical authority so this guard protects the same
  // directory the rest of the runtime treats as home, rather than keeping a
  // second interpretation of the variable here.
  try {
    const ambient = resolveHomeContext().path;
    if (typeof ambient === "string" && ambient.trim().length > 0) {
      roots.add(resolve(ambient.trim()));
    }
  } catch {
    // A refused or unresolvable ambient home contributes nothing; the session
    // root above still stands.
  }
  return [...roots];
}

/**
 * Read the shell mutation permission for a tool call from the runtime
 * context the dispatcher attached to its args. Without a context (bare tool
 * use in tests, or a caller outside the dispatcher) removals need approval.
 */
export function shellWorkspaceMutationPermission(
  args: Record<string, unknown>,
): ShellWorkspaceMutationPermission {
  const context = readToolRuntimeContext(args);
  return {
    allowWorkspaceDeletions: shellWorkspaceDeletionsAllowed(context),
    protectedRoots: shellDeletionProtectedRoots(context),
  };
}

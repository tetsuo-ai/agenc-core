/**
 * Multi-agent process ownership for the shared UnifiedExecProcessManager.
 *
 * TOOL-01: processes started by one conversation/agent must not accept
 * write_stdin / kill_process from another owner on the same manager.
 *
 * Owner identity is the runtime-injected `__agencSessionId` (conversation id)
 * stamped by tools/execution.ts when a session is present.
 */

export function processOwnerIdFromToolArgs(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (args === undefined) return undefined;
  const id = (args as { readonly __agencSessionId?: unknown }).__agencSessionId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

/**
 * Access rule:
 * - Unowned entries (no owner stamped at spawn) remain accessible for
 *   backward-compat test harnesses and pre-ownership sessions.
 * - Owned entries require a matching request ownerId.
 */
export function assertProcessOwnerAccess(params: {
  readonly entryOwnerId: string | undefined;
  readonly requestOwnerId: string | undefined;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const entryOwner = params.entryOwnerId?.trim() ?? "";
  if (entryOwner.length === 0) {
    return { ok: true };
  }
  const requestOwner = params.requestOwnerId?.trim() ?? "";
  if (requestOwner.length === 0) {
    return {
      ok: false,
      reason:
        "process is owned by another session; pass the owning session context",
    };
  }
  if (requestOwner !== entryOwner) {
    return {
      ok: false,
      reason: "process is owned by another agent/session",
    };
  }
  return { ok: true };
}

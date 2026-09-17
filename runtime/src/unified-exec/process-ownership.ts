import type { OwnedProcessView } from "./types.js";
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

/**
 * Enumeration rule (#2477), stricter than the per-id access rule above: a
 * session sees and bulk-stops only work stamped with its own owner id. An
 * unowned legacy entry stays addressable by id (backward compat) but is not
 * presented as another session's work, and a session without an owner id
 * sees only unowned entries.
 */
export function isProcessOwnedBy(params: {
  readonly entryOwnerId: string | undefined;
  readonly requestOwnerId: string | undefined;
}): boolean {
  const entryOwner = params.entryOwnerId?.trim() ?? "";
  const requestOwner = params.requestOwnerId?.trim() ?? "";
  return entryOwner === requestOwner;
}

/**
 * A session this conversation still owns work in: running, or signalled to
 * stop but not yet observed to have exited. list_processes and kill_process
 * must agree on this. If a signalled stop is dropped from the inventory
 * before its exit is proven, cleanup is reported as finished while the
 * process is still alive.
 */
export function isLiveOwnedProcess(
  view: Pick<OwnedProcessView, "status">,
): boolean {
  return view.status === "running" || view.status === "stopping";
}

/**
 * Turn an OS-level sandbox refusal into a statement the model can act on.
 *
 * A sandbox denial that happens at syscall time inside a running child never
 * reaches the runtime as a denial: the child simply exits non-zero and its
 * own errno text is the only thing the tool result carries. The model sees
 * `Error: listen EPERM: operation not permitted 0.0.0.0:8080` and nothing
 * that says the sandbox did it, that the command itself is fine, or that
 * retrying is pointless. Live incident (session conv-mtjdmlfc, 2026-09-02):
 * a model retried one denied `npm start` 21 times over 412 seconds, raising
 * the timeout and rewording a justification nobody could answer, because
 * nothing in the transcript told it the retry could not work.
 *
 * This module classifies that one case — a listening socket the sandbox
 * refused — and returns a frozen sentence to append to the tool result. The
 * text is deliberately constant: the repeated-failure guard compares failure
 * signatures, so a notice that embedded a timing or a port would defeat the
 * very guard that catches a model which keeps going anyway.
 *
 * @module
 */

import { isLightPrintRun } from "../../prompts/light-print.js";
import { escalationStaysConfined } from "../../sandbox/escalation/confinement.js";
import { routineRunOptions } from "../../session/runtime-options.js";
import { asRecord } from "../../utils/record.js";

/** The denial classes this module recognizes. */
export type ExecSandboxDenialKind = "network_bind";

/**
 * Signatures of "the OS refused to bind or listen", across the runtimes a
 * coding agent actually starts a server with. Require a bind/listen operation
 * and a permission errno, or Python's server socket construction followed by
 * its permission traceback. A bare EPERM (chmod, kill, write, client socket
 * creation) is a different failure and must not be labelled a server denial.
 */
const BIND_DENIED_SIGNATURES: readonly RegExp[] = [
  // Node: "Error: listen EPERM: operation not permitted 0.0.0.0:8080"
  /\b(?:listen|bind)\s+(?:EPERM|EACCES)\b/u,
  // Go / Rust / Python: "bind: operation not permitted",
  // "listen tcp 0.0.0.0:8080: bind: permission denied"
  /\b(?:bind|binding|listen|listening)\b[^\n]{0,80}?(?:operation not permitted|permission denied)/iu,
  // Reversed order: "... PermissionDenied ... binding 0.0.0.0:3000"
  /(?:operation not permitted|permission denied)[^\n]{0,80}?\b(?:bind|binding|listen|listening)\b/iu,
  // Python http.server can fail at socket creation, before server_bind.
  // Its errno lives below the source/caret lines and the socket.py frame.
  /\bself\.socket = socket\.socket\([^\n]*\n(?:[^\n]*\n){0,5}PermissionError: \[Errno (?:1|13)\] (?:operation not permitted|permission denied)\b/iu,
  // Python's bind traceback also puts the errno on a separate line.
  /\bself\.socket\.bind\([^\n]*\n(?:[ \t]+[~^]+\n)?PermissionError: \[Errno (?:1|13)\] (?:operation not permitted|permission denied)\b/iu,
];

/**
 * Escalation cannot be granted by anyone in this session, so the only honest
 * next step is to hand the command to the user.
 */
export const SANDBOX_BIND_DENIED_NO_ESCALATION =
  "[sandbox] The sandbox blocks local servers. Do not run this command again unchanged. " +
  "Escalation is unavailable; ask the user to enable sandbox.network.allowLocalBinding = true (on Linux, start and test the server in the same command), or run it in their terminal.";

/**
 * A human can still approve, so one escalated retry is the correct move —
 * and exactly one, because a second identical request answers nothing.
 */
export const SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE =
  "[sandbox] The sandbox blocks local servers. Retry this command once with sandbox_permissions=\"require_escalated\" and a justification, or ask the user to enable sandbox.network.allowLocalBinding = true (on Linux, start and test the server in the same command).";

/**
 * The notice for a finished exec, or null when this was not a sandbox
 * denial. Requires that a sandbox was actually applied: without one the
 * same errno means the OS itself refused (a privileged port, a taken
 * address), which is the user's problem, not the sandbox's, and mislabeling
 * it would send the model down the wrong path.
 */
export function execSandboxDenialNotice(params: {
  readonly output: string;
  readonly exitCode: number | null;
  readonly sandboxApplied: boolean;
  readonly escalationAvailable: boolean;
}): { readonly kind: ExecSandboxDenialKind; readonly notice: string } | null {
  if (!params.sandboxApplied) return null;
  // A background server can fail even when its shell exits zero after curl,
  // cleanup or an echo. Diagnose the explicit refusal without rewriting the
  // shell's exit status. Polling a live shell (exitCode null) needs it too.
  if (!BIND_DENIED_SIGNATURES.some((pattern) => pattern.test(params.output))) {
    return null;
  }
  return {
    kind: "network_bind",
    notice: params.escalationAvailable
      ? SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE
      : SANDBOX_BIND_DENIED_NO_ESCALATION,
  };
}

/**
 * Signatures of "the OS refused this write": the sandbox's EPERM on macOS,
 * a read-only mount under bubblewrap.
 */
const WRITE_DENIED_SIGNATURES: readonly RegExp[] = [
  /operation not permitted/iu,
  /read-only file system/iu,
  /\bE(?:PERM|ROFS)\b/u,
];

/**
 * The notice for a worktree child's command that failed on a refused write,
 * or null. Its commands change files only inside the worktree and the temp
 * folder, escalated or not, so the retry the model would try next (with
 * sandbox_permissions) fails the same way. The text depends only on the
 * worktree, so the repeated-failure guard still sees one failure.
 */
export function worktreeWriteDenialNotice(params: {
  readonly output: string;
  readonly exitCode: number | null;
  readonly worktree: string;
}): string | null {
  if (params.exitCode === 0) return null;
  if (!WRITE_DENIED_SIGNATURES.some((pattern) => pattern.test(params.output))) {
    return null;
  }
  return (
    `[sandbox] This agent works in its own git worktree (${params.worktree}). ` +
    "Its commands change files only inside the worktree and in $TMPDIR: the OS " +
    "sandbox refuses every other write, with or without sandbox_permissions, so " +
    "escalating or retrying fails the same way. Work inside the worktree, and " +
    "point a tool that writes elsewhere (a package cache, for example) at $TMPDIR."
  );
}

/**
 * Whether asking to lift the sandbox can still produce an answer for this
 * call. Under the `never` policy nobody is there to answer, except in the
 * bypass sessions whose prompt says a request is granted without asking
 * (prompts/permissions-prompt.ts). Pass the call's sandbox mode and session so
 * the notice and the prompt agree.
 */
export function sandboxEscalationAvailable(
  approvalPolicy: string,
  call?: { readonly sandboxMode?: string; readonly session?: unknown },
): boolean {
  if (approvalPolicy !== "never") return true;
  return call?.sandboxMode === "workspace_write" &&
    bypassGrantsSandboxEscalation(call.session);
}

/**
 * Whether a bypassPermissions session is told that leaving the sandbox is
 * granted without asking. It reads the mode the way the orchestrator does
 * (tools/orchestrator.ts), which grants the request in that mode, and leaves
 * out the sessions where the grant would not help or the prompt says
 * otherwise: a scheduled routine never leaves its sandbox; a worktree or
 * read-only delegation child stays confined (escalationStaysConfined); a
 * Light print run's prompt tells the model not to escalate.
 */
export function bypassGrantsSandboxEscalation(session: unknown): boolean {
  if (routineRunOptions(session) !== undefined) return false;
  if (escalationStaysConfined(session)) return false;
  const record = session as {
    readonly permissionModeRegistry?: { readonly current?: () => unknown };
    readonly services?: {
      readonly runtimeOptions?: Parameters<typeof isLightPrintRun>[0];
      readonly providerEnvironment?: Parameters<typeof isLightPrintRun>[1];
    };
  } | null | undefined;
  if (isLightPrintRun(record?.services?.runtimeOptions, record?.services?.providerEnvironment)) {
    return false;
  }
  return asRecord(record?.permissionModeRegistry?.current?.())?.mode === "bypassPermissions";
}

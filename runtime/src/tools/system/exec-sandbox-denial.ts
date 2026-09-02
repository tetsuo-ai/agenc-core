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

/** The denial classes this module recognizes. */
export type ExecSandboxDenialKind = "network_bind";

/**
 * Signatures of "the OS refused to bind or listen", across the runtimes a
 * coding agent actually starts a server with. Each requires BOTH a bind or
 * listen verb and a permission errno on the same line: a bare EPERM (a
 * chmod, a kill, a write) is a different failure and must not be labelled a
 * network denial.
 */
const BIND_DENIED_SIGNATURES: readonly RegExp[] = [
  // Node: "Error: listen EPERM: operation not permitted 0.0.0.0:8080"
  /\b(?:listen|bind)\s+(?:EPERM|EACCES)\b/u,
  // Go / Rust / Python: "bind: operation not permitted",
  // "listen tcp 0.0.0.0:8080: bind: permission denied"
  /\b(?:bind|binding|listen|listening)\b[^\n]{0,80}?(?:operation not permitted|permission denied)/iu,
  // Reversed order: "... PermissionDenied ... binding 0.0.0.0:3000"
  /(?:operation not permitted|permission denied)[^\n]{0,80}?\b(?:bind|binding|listen|listening)\b/iu,
];

/**
 * Escalation cannot be granted by anyone in this session, so the only honest
 * next step is to hand the command to the user.
 */
export const SANDBOX_BIND_DENIED_NO_ESCALATION =
  "[sandbox] The OS sandbox denied this command permission to bind a " +
  "listening socket. The command and the port are fine; the sandbox blocks " +
  "the bind. Escalation is unavailable in this session: the approval policy " +
  "is never, so nobody is present to approve running outside the sandbox, " +
  "and sandbox_permissions and justification have no effect under it. " +
  "Retrying will fail the same way, with any timeout. Do not run this " +
  "command again. Tell the user the server cannot be started from here and " +
  "give them the exact command to run in their own terminal.";

/**
 * A human can still approve, so one escalated retry is the correct move —
 * and exactly one, because a second identical request answers nothing.
 */
export const SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE =
  "[sandbox] The OS sandbox denied this command permission to bind a " +
  "listening socket. The command and the port are fine; the sandbox blocks " +
  "the bind. Retrying it unchanged will fail the same way, with any " +
  "timeout. Send this exact command once more with sandbox_permissions " +
  'set to "require_escalated" and a one-line justification. Extra network ' +
  "permissions do not help: only running outside the sandbox grants a " +
  "listening socket. If that request is refused, tell the user the server " +
  "cannot be started from here and give them the exact command to run in " +
  "their own terminal.";

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
  if (params.exitCode === 0) return null;
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
 * Approval policies under which asking a human to lift the sandbox can still
 * produce an answer. `never` cannot: the policy states that nobody is there.
 */
export function sandboxEscalationAvailable(approvalPolicy: string): boolean {
  return approvalPolicy !== "never";
}

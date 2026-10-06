/**
 * Whether a session's sandbox escalation would still leave its command
 * confined, so it must not be offered as a way out of the sandbox. A worktree
 * child's escalated command stays inside its worktree, gaining only network
 * (tools/system/exec-command.ts, sandboxedAttempt), and a read-only delegation
 * child refuses `require_escalated` outright
 * (permissions/readonly-inspection.ts). The bypass permission prompt and
 * exec_command's sandbox notices both read this, so they agree.
 *
 * @module
 */

export function escalationStaysConfined(session: unknown): boolean {
  const services = (session as {
    readonly services?: {
      readonly sandboxExecutionBroker?: { readonly worktreeConfinement?: unknown };
      readonly readOnlyDelegation?: unknown;
    };
  } | null | undefined)?.services;
  return services?.sandboxExecutionBroker?.worktreeConfinement !== undefined ||
    services?.readOnlyDelegation !== undefined;
}

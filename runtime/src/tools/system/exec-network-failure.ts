import { effectivePermissionProfile } from "../../sandbox/engine/policy-transforms.js";
import type { UnifiedExecRuntimeSandbox } from "../../unified-exec/types.js";
import type { SandboxEscalationGrant } from "./exec-sandbox-denial.js";

const LOOKUP_FAILURE = /\bEAI_AGAIN\b|\bENOTFOUND\b|\bENETUNREACH\b|could not resolve (?:host|proxy)|temporary failure in name resolution|name or service not known|network is unreachable/iu;
// `curl -s` and `wget -q` print nothing when a lookup or connect fails, so only the exit status tells:
// curl 6 (could not resolve host) and 7 (could not connect), wget 4 (network failure).
const SILENT_CLIENT_EXITS: ReadonlyArray<readonly [RegExp, ReadonlySet<number>]> = [
  [/(?:^|[\s;&|(`])curl(?=\s)/u, new Set([6, 7])],
  [/(?:^|[\s;&|(`])wget(?=\s)/u, new Set([4])],
];

function silentClientNetworkFailure(command: string | undefined, exitCode: number): boolean {
  return command !== undefined &&
    SILENT_CLIENT_EXITS.some(([client, codes]) => codes.has(exitCode) && client.test(command));
}

/** Explain a failed lookup without changing the command, resolver, or package configuration. */
export function execNetworkFailureNotice(params: {
  readonly output: string;
  readonly exitCode: number | null;
  /** The shell command, when known: a silent client's exit status is its only signal. */
  readonly command?: string;
  readonly runtimeSandbox?: UnifiedExecRuntimeSandbox;
  /** How a retry outside the sandbox would be answered (sandboxEscalationGrant). */
  readonly escalation?: SandboxEscalationGrant;
  /** Older callers: a retry outside the sandbox can be granted. */
  readonly escalationAvailable?: boolean;
  /** Older callers: approvals are off (bypass), so the escalated retry runs without asking anyone. */
  readonly escalationWithoutAsking?: boolean;
}): string | null {
  const sandbox = params.runtimeSandbox;
  if (
    params.exitCode === null || params.exitCode === 0 ||
    sandbox === undefined || (sandbox.preference ?? "require") !== "require" ||
    sandbox.network !== undefined || sandbox.enforceManagedNetwork === true ||
    effectivePermissionProfile(sandbox.permissionProfile, sandbox.additionalPermissions).network !== "disabled" ||
    !(LOOKUP_FAILURE.test(params.output) || silentClientNetworkFailure(params.command, params.exitCode))
  ) return null;

  const grant = params.escalation ?? (params.escalationAvailable !== true
    ? "unavailable"
    : params.escalationWithoutAsking === true ? "without_asking" : "with_approval");
  if (grant === "unavailable") {
    return "[sandbox] This command's network access was disabled; " +
      "network approval is unavailable in this session, so use local dependencies or report the blocker.";
  }
  // Models in bypass sessions sometimes declined the retry as "working around your sandbox setting":
  // say that the user turned approvals off, so the retry is theirs to run.
  return grant === "without_asking"
    ? "[sandbox] This command's network access was disabled. Approvals are off in this session, so a retry " +
      "with sandbox_permissions=\"require_escalated\" runs without asking: retry it once."
    : "[sandbox] This command's network access was disabled; retry it once with " +
      "sandbox_permissions=\"require_escalated\" and a short justification.";
}

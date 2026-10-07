import { effectivePermissionProfile } from "../../sandbox/engine/policy-transforms.js";
import type { UnifiedExecRuntimeSandbox } from "../../unified-exec/types.js";

const LOOKUP_FAILURE = /\bEAI_AGAIN\b|\bENETUNREACH\b|could not resolve (?:host|proxy)|temporary failure in name resolution|name or service not known|network is unreachable/iu;

/** Explain a failed lookup without changing the command, resolver, or package configuration. */
export function execNetworkFailureNotice(params: {
  readonly output: string;
  readonly exitCode: number | null;
  readonly runtimeSandbox?: UnifiedExecRuntimeSandbox;
  readonly escalationAvailable: boolean;
}): string | null {
  const sandbox = params.runtimeSandbox;
  if (
    params.exitCode === null || params.exitCode === 0 ||
    sandbox === undefined || (sandbox.preference ?? "require") !== "require" ||
    sandbox.network !== undefined || sandbox.enforceManagedNetwork === true ||
    effectivePermissionProfile(sandbox.permissionProfile, sandbox.additionalPermissions).network !== "disabled" ||
    !LOOKUP_FAILURE.test(params.output)
  ) return null;

  return "[sandbox] This command's network access was disabled; " +
    (params.escalationAvailable
      ? "request network access through the session's approval flow before retrying."
      : "network approval is unavailable in this session, so use local dependencies or report the blocker.");
}

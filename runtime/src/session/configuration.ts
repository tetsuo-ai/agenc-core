import { resolve } from "node:path";

import type { AgenCConfig } from "../config/schema.js";
import { resolveApprovalPolicy } from "../permissions/approval-policy.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import type { SandboxExecutionBrokerAuthority } from "../sandbox/execution-broker.js";
import { permissionProfileForLiveSandboxPolicies } from "../tools/runtimes/sandboxing.js";
import type { SessionConfiguration } from "./turn-context.js";

export type SessionExecutionAuthority = Readonly<
  Pick<
    SessionConfiguration,
    | "approvalPolicy"
    | "sandboxPolicy"
    | "fileSystemSandboxPolicy"
    | "networkSandboxPolicy"
    | "windowsSandboxLevel"
    | "sandboxAllowGpu"
  >
>;

function immutableExecutionAuthority(
  configuration: SessionConfiguration,
): SessionExecutionAuthority {
  return Object.freeze({
    approvalPolicy: Object.freeze({ ...configuration.approvalPolicy }),
    sandboxPolicy: Object.freeze({ ...configuration.sandboxPolicy }),
    fileSystemSandboxPolicy: Object.freeze({
      ...configuration.fileSystemSandboxPolicy,
      allowWrite: Object.freeze([
        ...configuration.fileSystemSandboxPolicy.allowWrite,
      ]),
      denyWrite: Object.freeze([
        ...configuration.fileSystemSandboxPolicy.denyWrite,
      ]),
      allowRead: Object.freeze([
        ...configuration.fileSystemSandboxPolicy.allowRead,
      ]),
      denyRead: Object.freeze([
        ...configuration.fileSystemSandboxPolicy.denyRead,
      ]),
    }),
    networkSandboxPolicy: Object.freeze({
      ...configuration.networkSandboxPolicy,
      allowlist: Object.freeze([
        ...configuration.networkSandboxPolicy.allowlist,
      ]),
      denylist: Object.freeze([
        ...configuration.networkSandboxPolicy.denylist,
      ]),
    }),
    windowsSandboxLevel: configuration.windowsSandboxLevel,
    ...(configuration.sandboxAllowGpu === true
      ? { sandboxAllowGpu: true }
      : {}),
  });
}

/** Capture the configured policy before any permission-mode override. */
export function sessionExecutionAuthorityFromConfiguration(
  configuration: SessionConfiguration,
): SessionExecutionAuthority {
  return immutableExecutionAuthority(configuration);
}

/** True when bypass remains the effective authority while planning. */
export function permissionContextUsesBypassAuthority(
  context: Pick<ToolPermissionContext, "mode" | "prePlanMode">,
): boolean {
  return (
    context.mode === "bypassPermissions" ||
    (context.mode === "plan" && context.prePlanMode === "bypassPermissions")
  );
}

/**
 * Resolve one effective execution authority from the configured baseline and
 * the canonical permission context. Permission bypass suppresses approval
 * prompts but never widens the configured OS sandbox. The immutable combined
 * dangerous authority is supplied separately from captured runtime options.
 */
export function executionAuthorityForPermissionContext(
  configured: SessionExecutionAuthority,
  context: Pick<ToolPermissionContext, "mode" | "prePlanMode">,
  dangerouslyBypassApprovalsAndSandbox = false,
): SessionExecutionAuthority {
  const bypassApprovals = permissionContextUsesBypassAuthority(context);
  if (!bypassApprovals && !dangerouslyBypassApprovalsAndSandbox) {
    return configured;
  }
  return Object.freeze({
    ...configured,
    ...(bypassApprovals
      ? { approvalPolicy: Object.freeze({ value: "never" as const }) }
      : {}),
    ...(dangerouslyBypassApprovalsAndSandbox
      ? {
          sandboxPolicy: Object.freeze({
            value: "danger_full_access" as const,
          }),
          fileSystemSandboxPolicy: Object.freeze({
            allowWrite: Object.freeze([]),
            denyWrite: Object.freeze([]),
            allowRead: Object.freeze([]),
            denyRead: Object.freeze([]),
          }),
        }
      : {}),
  });
}

/** Project the effective execution authority onto live session configuration. */
export function applySessionExecutionAuthority(
  configuration: SessionConfiguration,
  authority: SessionExecutionAuthority,
): SessionConfiguration {
  return {
    ...configuration,
    ...authority,
  };
}

export function sandboxExecutionBrokerAuthorityFromSessionAuthority(
  authority: SessionExecutionAuthority,
  cwd: string,
): SandboxExecutionBrokerAuthority {
  const mode = authority.sandboxPolicy.value;
  const windowsSandboxLevel =
    authority.windowsSandboxLevel === "strict"
      ? "high"
      : authority.windowsSandboxLevel === "permissive"
        ? "low"
        : "disabled";
  return Object.freeze({
    mode,
    permissionProfile: permissionProfileForLiveSandboxPolicies(
      mode,
      cwd,
      authority.fileSystemSandboxPolicy,
      authority.networkSandboxPolicy,
    ),
    windowsSandboxLevel,
    allowGpu: authority.sandboxAllowGpu === true,
  });
}

function approvalPolicyValueFromAgenCConfig(
  raw: AgenCConfig["approval_policy"] | undefined,
): SessionConfiguration["approvalPolicy"]["value"] {
  switch (raw) {
    case "never":
      return "never";
    case "on-failure":
      return "on_failure";
    case "on-request":
      return "on_request";
    case "untrusted":
      return "untrusted";
    default:
      return "on_request";
  }
}

export function sandboxPolicyValueFromAgenCConfig(
  raw: AgenCConfig["sandbox_mode"] | undefined,
): SessionConfiguration["sandboxPolicy"]["value"] {
  switch (raw) {
    case "read-only":
      return "read_only";
    case "danger-full-access":
      return "danger_full_access";
    case "workspace-write":
      return "workspace_write";
    default:
      return "workspace_write";
  }
}

/** Build the immutable configured execution baseline without mode overrides. */
export function sessionExecutionAuthorityFromAgenCConfig(params: {
  readonly config: AgenCConfig;
  readonly workspaceRoot: string;
  readonly projectTrust?: "trusted" | "untrusted";
}): SessionExecutionAuthority {
  return sessionExecutionAuthorityFromConfiguration(
    sessionConfigurationFromAgenCConfig({
      ...params,
      model: "",
    }),
  );
}

/** Build the sole live session-policy projection from a canonical config snapshot. */
export function sessionConfigurationFromAgenCConfig(params: {
  readonly config: AgenCConfig;
  readonly workspaceRoot: string;
  readonly model: string;
  readonly provider?: string;
  readonly projectTrust?: "trusted" | "untrusted";
}): SessionConfiguration {
  const configPolicy = approvalPolicyValueFromAgenCConfig(
    params.config.approval_policy,
  );
  const approval = resolveApprovalPolicy({
    configPolicy,
    projectTrust:
      params.projectTrust === "untrusted" ? "untrusted" : undefined,
  });
  const sandbox = sandboxPolicyValueFromAgenCConfig(
    params.config.sandbox_mode,
  );
  const resolveSandboxPaths = (paths: readonly string[] | undefined) =>
    (paths ?? []).map((path) => resolve(params.workspaceRoot, path));
  const filesystem = params.config.sandbox?.filesystem;
  const extraWritableRoots =
    sandbox === "workspace_write"
      ? resolveSandboxPaths(filesystem?.allowWrite)
      : [];
  const configured: SessionConfiguration = {
    cwd: params.workspaceRoot,
    approvalPolicy: { value: approval },
    sandboxPolicy: { value: sandbox },
    fileSystemSandboxPolicy: {
      allowWrite:
        sandbox === "workspace_write"
          ? [...new Set([params.workspaceRoot, ...extraWritableRoots])]
          : [],
      denyWrite: resolveSandboxPaths(filesystem?.denyWrite),
      allowRead: resolveSandboxPaths(filesystem?.allowRead),
      denyRead: resolveSandboxPaths(filesystem?.denyRead),
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
      enabled:
        params.config.sandbox?.network_access ??
        sandbox === "danger_full_access",
    },
    windowsSandboxLevel: "none",
    ...(params.provider
      ? {
          provider: {
            slug: params.provider,
          } as unknown as SessionConfiguration["provider"],
        }
      : {}),
    collaborationMode: { model: params.model },
    dynamicTools: [],
    sessionSource: "cli_main",
    ...(params.config.approvals_reviewer !== undefined
      ? { approvalsReviewer: params.config.approvals_reviewer }
      : {}),
    ...(params.config.model_verbosity !== undefined
      ? { modelVerbosity: params.config.model_verbosity }
      : {}),
    ...(params.config.personality !== undefined
      ? { personality: params.config.personality }
      : {}),
    ...(params.config.reasoning_summary !== undefined
      ? { modelReasoningSummary: params.config.reasoning_summary }
      : {}),
    ...(params.config.service_tier !== undefined
      ? { serviceTier: params.config.service_tier }
      : {}),
    ...(params.config.sandbox?.allow_gpu === true
      ? { sandboxAllowGpu: true }
      : {}),
  };

  return configured;
}

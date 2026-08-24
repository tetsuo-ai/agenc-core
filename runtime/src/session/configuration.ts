import { resolve } from "node:path";

import type { AgenCConfig } from "../config/schema.js";
import { resolveApprovalPolicy } from "../permissions/approval-policy.js";
import type { SessionConfiguration } from "./turn-context.js";

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

/** Build the sole live session-policy projection from a canonical config snapshot. */
export function sessionConfigurationFromAgenCConfig(params: {
  readonly config: AgenCConfig;
  readonly workspaceRoot: string;
  readonly model: string;
  readonly provider?: string;
  readonly projectTrust?: "trusted" | "untrusted";
  readonly dangerouslyBypassApprovalsAndSandbox?: boolean;
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

  if (params.dangerouslyBypassApprovalsAndSandbox !== true) {
    return configured;
  }
  return {
    ...configured,
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "danger_full_access" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
  };
}

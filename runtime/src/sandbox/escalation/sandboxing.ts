import type {
  ApprovalPolicy,
  ExecApprovalRequirement,
  FileSystemSandboxKind,
  GranularApprovalConfig,
} from "../../permissions/approval-policy.js";
import { defaultExecApprovalRequirement } from "../../permissions/approval-policy.js";
import type { Tool } from "../../tools/types.js";

export type EscalationSandboxMode =
  | "danger_full_access"
  | "read_only"
  | "workspace_write"
  | "external_sandbox";

export interface AdditionalSandboxPermissions {
  readonly network?: {
    readonly enabled?: boolean;
  };
  readonly file_system?: {
    readonly read?: readonly string[];
    readonly write?: readonly string[];
  };
}

export type SandboxPermissionsRequest =
  | { readonly kind: "default" }
  | {
      readonly kind: "require_escalated";
      readonly justification?: string;
      readonly prefixRule?: readonly string[];
    }
  | {
      readonly kind: "with_additional_permissions";
      readonly additionalPermissions: AdditionalSandboxPermissions;
      readonly justification?: string;
    };

export type SandboxPermissionsInput =
  | "default"
  | "require_escalated"
  | "with_additional_permissions"
  | SandboxPermissionsRequest
  | null
  | undefined;

export type SandboxOverride =
  | { readonly kind: "none" }
  | {
      readonly kind: "bypass_sandbox";
      readonly reason: "sandbox_permissions" | "approval_requirement";
    };

interface ToolSandboxCapabilities {
  readonly escalateOnFailure?: boolean | (() => boolean);
  readonly wantsNoSandboxApproval?:
    | boolean
    | ((policy: ApprovalPolicy, granular?: GranularApprovalConfig) => boolean);
}

export function normalizeSandboxPermissionsRequest(
  input: SandboxPermissionsInput,
  additionalPermissions: AdditionalSandboxPermissions | null = null,
): SandboxPermissionsRequest {
  if (input === null || input === undefined || input === "default") {
    return { kind: "default" };
  }
  if (input === "require_escalated") {
    return { kind: "require_escalated" };
  }
  if (input === "with_additional_permissions") {
    return {
      kind: "with_additional_permissions",
      additionalPermissions: additionalPermissions ?? {},
    };
  }
  return input;
}

export function sandboxPermissionsFromArgs(
  args: Record<string, unknown>,
): SandboxPermissionsRequest {
  const raw = args["sandbox_permissions"];
  const additionalPermissions = isAdditionalSandboxPermissions(
    args["additional_permissions"],
  )
    ? args["additional_permissions"]
    : null;
  if (
    raw === "default" ||
    raw === "require_escalated" ||
    raw === "with_additional_permissions"
  ) {
    return normalizeSandboxPermissionsRequest(raw, additionalPermissions);
  }
  return { kind: "default" };
}

export function hasAdditionalSandboxPermissions(
  permissions: AdditionalSandboxPermissions,
): boolean {
  if (permissions.network?.enabled === true) return true;
  const reads = permissions.file_system?.read ?? [];
  if (reads.length > 0) return true;
  const writes = permissions.file_system?.write ?? [];
  return writes.length > 0;
}

export function sandboxPermissionsRequireEscalation(
  request: SandboxPermissionsInput,
): boolean {
  return normalizeSandboxPermissionsRequest(request).kind === "require_escalated";
}

export function approvalSandboxPermissions(
  request: SandboxPermissionsInput,
  additionalPermissionsPreapproved: boolean,
): SandboxPermissionsRequest {
  const normalized = normalizeSandboxPermissionsRequest(request);
  if (
    additionalPermissionsPreapproved &&
    normalized.kind === "with_additional_permissions"
  ) {
    return { kind: "default" };
  }
  return normalized;
}

export function defaultSandboxApprovalRequirement(
  policy: ApprovalPolicy,
  fsKind: FileSystemSandboxKind,
  granular?: GranularApprovalConfig,
): ExecApprovalRequirement {
  return defaultExecApprovalRequirement(policy, fsKind, granular);
}

/**
 * Applies the sandbox bypass only when either the request explicitly asks for
 * escalation or a policy-classified skip already carries a bypass bit.
 */
export function sandboxOverrideForFirstAttempt(
  request: SandboxPermissionsInput,
  requirement: ExecApprovalRequirement,
): SandboxOverride {
  if (sandboxPermissionsRequireEscalation(request)) {
    return { kind: "bypass_sandbox", reason: "sandbox_permissions" };
  }
  if (requirement.kind === "skip" && requirement.bypassSandbox) {
    return { kind: "bypass_sandbox", reason: "approval_requirement" };
  }
  return { kind: "none" };
}

export function selectFirstAttemptSandbox(
  selectedSandbox: EscalationSandboxMode,
  override: SandboxOverride,
): EscalationSandboxMode {
  return override.kind === "bypass_sandbox"
    ? "danger_full_access"
    : selectedSandbox;
}

export function managedNetworkForSandboxPermissions<T>(
  managedNetwork: T | null | undefined,
  request: SandboxPermissionsInput,
): T | null {
  if (sandboxPermissionsRequireEscalation(request)) {
    return null;
  }
  return managedNetwork ?? null;
}

export function toolEscalatesOnFailure(tool: Tool): boolean {
  const value = (tool as Tool & ToolSandboxCapabilities).escalateOnFailure;
  if (value === undefined) return true;
  return typeof value === "function" ? value() : value;
}

export function toolWantsNoSandboxApproval(
  tool: Tool,
  policy: ApprovalPolicy,
  granular?: GranularApprovalConfig,
): boolean {
  const override = (tool as Tool & ToolSandboxCapabilities)
    .wantsNoSandboxApproval;
  if (override !== undefined) {
    return typeof override === "function" ? override(policy, granular) : override;
  }
  switch (policy) {
    case "on_failure":
    case "untrusted":
      return true;
    case "never":
    case "on_request":
      return false;
    case "granular":
      return granular?.sandbox_approval === true;
    default: {
      const _exhaustive: never = policy;
      void _exhaustive;
      return false;
    }
  }
}

function isAdditionalSandboxPermissions(
  value: unknown,
): value is AdditionalSandboxPermissions {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as AdditionalSandboxPermissions;
  if (candidate.network !== undefined) {
    if (typeof candidate.network !== "object" || candidate.network === null) {
      return false;
    }
    const enabled = (candidate.network as { readonly enabled?: unknown })
      .enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return false;
    }
  }
  if (candidate.file_system !== undefined) {
    if (
      typeof candidate.file_system !== "object" ||
      candidate.file_system === null
    ) {
      return false;
    }
    const fs = candidate.file_system as {
      readonly read?: unknown;
      readonly write?: unknown;
    };
    if (fs.read !== undefined && !isStringArray(fs.read)) return false;
    if (fs.write !== undefined && !isStringArray(fs.write)) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

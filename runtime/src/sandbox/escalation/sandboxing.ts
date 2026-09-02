import type {
  ApprovalPolicy,
  ExecApprovalRequirement,
  FileSystemSandboxKind,
  GranularApprovalConfig,
} from "../../permissions/approval-policy.js";
import { defaultExecApprovalRequirement } from "../../permissions/approval-policy.js";
import type { Tool } from "../../tools/types.js";
import type {
  AdditionalPermissionProfile,
  FileSystemSandboxEntry,
} from "../engine/index.js";

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

/** The accepted values of `sandbox_permissions`, for error messages. */
export const SANDBOX_PERMISSIONS_ACCEPTED_VALUES =
  '"default", "require_escalated" or "with_additional_permissions"';

/**
 * Outcome of reading an escalation request off tool arguments. An
 * unrecognized shape is reported, never silently downgraded: the live
 * incident's model sent `sandbox_permissions: {"network":"full"}` — a shape
 * the exec_command schema invites and this parser used to discard — so its
 * twelve escalation requests were neither honored nor refused, and the
 * command re-ran under the same sandbox with no sign the request had been
 * dropped.
 */
export type SandboxPermissionsParse =
  | { readonly kind: "ok"; readonly request: SandboxPermissionsRequest }
  | { readonly kind: "invalid"; readonly reason: string };

export function parseSandboxPermissionsArgs(
  args: Record<string, unknown>,
): SandboxPermissionsParse {
  const raw = args["sandbox_permissions"];
  const rawAdditional = args["additional_permissions"];
  if (
    rawAdditional !== undefined &&
    rawAdditional !== null &&
    !isAdditionalSandboxPermissions(rawAdditional)
  ) {
    return {
      kind: "invalid",
      reason:
        "additional_permissions has an unsupported shape; it must be " +
        '{"network":{"enabled":true}} and/or ' +
        '{"file_system":{"read":[...],"write":[...]}}',
    };
  }
  const additionalPermissions = isAdditionalSandboxPermissions(rawAdditional)
    ? rawAdditional
    : null;
  if (raw === undefined || raw === null) {
    return { kind: "ok", request: { kind: "default" } };
  }
  if (
    raw === "default" ||
    raw === "require_escalated" ||
    raw === "with_additional_permissions"
  ) {
    return {
      kind: "ok",
      request: normalizeSandboxPermissionsRequest(raw, additionalPermissions),
    };
  }
  return {
    kind: "invalid",
    reason:
      `sandbox_permissions must be one of ${SANDBOX_PERMISSIONS_ACCEPTED_VALUES}; ` +
      `received ${JSON.stringify(raw)}`,
  };
}

/**
 * Escalation request for the approval layer. Retains the historical
 * "unknown shape means no request" behavior for callers that have no way to
 * report a malformed argument; callers that can reject the call should use
 * {@link parseSandboxPermissionsArgs} so the model learns its request was
 * not understood.
 */
export function sandboxPermissionsFromArgs(
  args: Record<string, unknown>,
): SandboxPermissionsRequest {
  const parsed = parseSandboxPermissionsArgs(args);
  return parsed.kind === "ok" ? parsed.request : { kind: "default" };
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

export function runtimeAdditionalPermissionsForSandboxRequest(
  request: SandboxPermissionsInput,
): AdditionalPermissionProfile | undefined {
  const normalized = normalizeSandboxPermissionsRequest(request);
  if (normalized.kind !== "with_additional_permissions") return undefined;
  return additionalPermissionProfileFromSandboxPermissions(
    normalized.additionalPermissions,
  );
}

function additionalPermissionProfileFromSandboxPermissions(
  permissions: AdditionalSandboxPermissions,
): AdditionalPermissionProfile | undefined {
  const entries: FileSystemSandboxEntry[] = [];
  for (const target of permissions.file_system?.read ?? []) {
    entries.push({ path: { kind: "path", path: target }, access: "read" });
  }
  for (const target of permissions.file_system?.write ?? []) {
    entries.push({ path: { kind: "path", path: target }, access: "write" });
  }
  const profile: AdditionalPermissionProfile = {
    ...(permissions.network?.enabled === true
      ? { network: { enabled: true } }
      : {}),
    ...(entries.length > 0 ? { fileSystem: { entries } } : {}),
  };
  return profile.network !== undefined || profile.fileSystem !== undefined
    ? profile
    : undefined;
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

/** The only keys `additional_permissions` and its members may carry. */
const ADDITIONAL_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "network",
  "file_system",
]);
const NETWORK_PERMISSION_KEYS: ReadonlySet<string> = new Set(["enabled"]);
const FILE_SYSTEM_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "read",
  "write",
]);

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Unknown keys are refused rather than ignored, so this agrees with the
 * exec_command schema instead of quietly honoring half of a request the
 * schema rejects. Silently dropping part of an escalation request is the
 * defect this file's parser was fixed for.
 */
function isAdditionalSandboxPermissions(
  value: unknown,
): value is AdditionalSandboxPermissions {
  if (typeof value !== "object" || value === null) return false;
  if (!hasOnlyKeys(value, ADDITIONAL_PERMISSION_KEYS)) return false;
  const candidate = value as AdditionalSandboxPermissions;
  if (candidate.network !== undefined) {
    if (typeof candidate.network !== "object" || candidate.network === null) {
      return false;
    }
    if (!hasOnlyKeys(candidate.network, NETWORK_PERMISSION_KEYS)) return false;
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
    if (!hasOnlyKeys(candidate.file_system, FILE_SYSTEM_PERMISSION_KEYS)) {
      return false;
    }
    if (fs.read !== undefined && !isStringArray(fs.read)) return false;
    if (fs.write !== undefined && !isStringArray(fs.write)) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

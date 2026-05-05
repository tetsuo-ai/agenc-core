import {
  hasAdditionalSandboxPermissions,
  type AdditionalSandboxPermissions,
} from "./sandboxing.js";

export function renderRuleRequestPermissionGuidance(): string {
  return [
    "Prefer sandboxed additional permissions before full escalation.",
    "Use sandbox_permissions=\"with_additional_permissions\" for one command that only needs extra network or filesystem access.",
    "Use full escalation only when additional permissions cannot satisfy the command.",
  ].join("\n");
}

export function preferAdditionalPermissions(
  permissions: AdditionalSandboxPermissions,
): boolean {
  return hasAdditionalSandboxPermissions(permissions);
}

export function allowedAdditionalPermissionNames(
  permissions: AdditionalSandboxPermissions,
): readonly string[] {
  const names: string[] = [];
  if (permissions.network?.enabled === true) {
    names.push("network.enabled");
  }
  if ((permissions.file_system?.read ?? []).length > 0) {
    names.push("file_system.read");
  }
  if ((permissions.file_system?.write ?? []).length > 0) {
    names.push("file_system.write");
  }
  return names;
}

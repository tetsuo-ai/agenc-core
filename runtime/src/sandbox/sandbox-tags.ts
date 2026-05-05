/**
 * Sandbox metric and legacy-policy tag derivation for AgenC runtime profiles.
 *
 * Source parity is documented in `parity/C-01f-parity.json`; the executable
 * sandbox command builders remain owned by `runtime/src/sandbox/engine/`.
 */

import {
  externalFileSystemPolicy,
  getPlatformSandbox,
  getWritableRootsWithCwd,
  hasFullDiskWriteAccess,
  permissionProfileFromRuntimePermissions,
  restrictedFileSystemPolicy,
  sandboxTypeMetricTag,
  unrestrictedFileSystemPolicy,
  type NetworkSandboxPolicy,
  type PermissionProfile,
  type WindowsSandboxLevel,
} from "./engine/index.js";
import { shouldRequirePlatformSandbox } from "./engine/policy-transforms.js";
import {
  NETWORK_ENABLED,
  type SandboxPolicy,
} from "../permissions/sandbox.js";

export type SandboxMetricTag =
  | "none"
  | "external"
  | "seatbelt"
  | "seccomp"
  | "windows_sandbox"
  | "windows_elevated";

export type SandboxPolicyTag =
  | "danger-full-access"
  | "external-sandbox"
  | "read-only"
  | "workspace-write";

export type WindowsSandboxTagLevel =
  | WindowsSandboxLevel
  | "restricted-token"
  | "restricted_token"
  | "elevated";

export function sandboxTag(
  policy: SandboxPolicy,
  windowsSandboxLevel: WindowsSandboxTagLevel,
  options: {
    readonly enforceManagedNetwork?: boolean;
    readonly platform?: NodeJS.Platform;
  } = {},
): SandboxMetricTag {
  return permissionProfileSandboxTag(
    permissionProfileFromSandboxPolicy(policy),
    windowsSandboxLevel,
    options.enforceManagedNetwork ?? false,
    { platform: options.platform },
  );
}

export function permissionProfileSandboxTag(
  profile: PermissionProfile,
  windowsSandboxLevel: WindowsSandboxTagLevel,
  enforceManagedNetwork: boolean,
  options: { readonly platform?: NodeJS.Platform } = {},
): SandboxMetricTag {
  if (profile.fileSystem.kind === "external_sandbox") return "external";
  if (
    profile.fileSystem.kind === "unrestricted" &&
    profile.enforcement !== "managed"
  ) {
    return "none";
  }
  if (
    !shouldRequirePlatformSandbox(
      profile.fileSystem,
      profile.network,
      enforceManagedNetwork,
    )
  ) {
    return "none";
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32" && isElevatedWindowsSandbox(windowsSandboxLevel)) {
    return "windows_elevated";
  }
  const platformSandbox = getPlatformSandbox({
    platform,
    windowsSandboxEnabled: windowsSandboxEnabled(windowsSandboxLevel),
  });
  return platformSandbox === null
    ? "none"
    : (sandboxTypeMetricTag(platformSandbox) as SandboxMetricTag);
}

export function permissionProfilePolicyTag(
  profile: PermissionProfile,
  cwd: string,
): SandboxPolicyTag {
  switch (profile.fileSystem.kind) {
    case "unrestricted":
      return "danger-full-access";
    case "external_sandbox":
      return "external-sandbox";
    case "restricted":
      if (hasFullDiskWriteAccess(profile.fileSystem)) {
        return "danger-full-access";
      }
      return getWritableRootsWithCwd(profile.fileSystem, cwd).length === 0
        ? "read-only"
        : "workspace-write";
  }
}

function permissionProfileFromSandboxPolicy(
  policy: SandboxPolicy,
): PermissionProfile {
  switch (policy.kind) {
    case "danger_full_access":
      return permissionProfileFromRuntimePermissions(
        unrestrictedFileSystemPolicy(),
        "enabled",
      );
    case "external_sandbox":
      return permissionProfileFromRuntimePermissions(
        externalFileSystemPolicy(),
        networkFromLegacyPolicy(policy.network_access),
      );
    case "read_only":
      return permissionProfileFromRuntimePermissions(
        restrictedFileSystemPolicy(
          [{ path: { kind: "special", value: { kind: "root" } }, access: "read" }],
          { includePlatformDefaults: true },
        ),
        networkFromLegacyPolicy(policy.network_access),
        "managed",
      );
    case "workspace_write":
      return permissionProfileFromRuntimePermissions(
        restrictedFileSystemPolicy(
          [
            {
              path: { kind: "special", value: { kind: "project_roots" } },
              access: "write",
            },
            ...policy.writable_roots.map((root) => ({
              path: { kind: "path" as const, path: root.root },
              access: "write" as const,
            })),
          ],
          { includePlatformDefaults: true },
        ),
        networkFromLegacyPolicy(policy.network_access),
        "managed",
      );
  }
}

function networkFromLegacyPolicy(access: {
  readonly mode: "enabled" | "disabled";
}): NetworkSandboxPolicy {
  return access.mode === NETWORK_ENABLED.mode ? "enabled" : "disabled";
}

function windowsSandboxEnabled(level: WindowsSandboxTagLevel): boolean {
  return level !== "disabled";
}

function isElevatedWindowsSandbox(level: WindowsSandboxTagLevel): boolean {
  return level === "elevated" || level === "high";
}

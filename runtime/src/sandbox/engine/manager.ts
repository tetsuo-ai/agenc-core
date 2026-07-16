/**
 * Sandbox manager command transformation.
 *
 * Platform selection and argv construction for AgenC's sandbox engine data
 * model. The returned request is ready for the platform launcher that later
 * items wire into process execution.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import {
  SandboxTransformError,
  canWritePathWithCwd,
  getPlatformSandbox,
  getWritableRootsWithCwd,
  hasFullDiskWriteAccess,
  networkPolicyEnabled,
  permissionProfileToRuntimePermissions,
  resolvePermissionPath,
  type FileSystemSandboxPolicy,
  type FileSystemSandboxEntry,
  type NetworkSandboxPolicy,
  type PermissionProfile,
  type SandboxExecRequest,
  type SandboxTransformRequest,
  type SandboxType,
  type SandboxablePreference,
  type WindowsSandboxLevel,
} from "./index.js";
import {
  effectivePermissionProfile,
  shouldRequirePlatformSandbox,
} from "./policy-transforms.js";
import {
  allowNetworkForProxy,
  createLinuxSandboxCommandArgsForPermissionProfile,
} from "./landlock.js";
import { createSeatbeltCommandArgs } from "./seatbelt.js";
import { isWsl1 } from "./bwrap.js";
import {
  NETWORK_DISABLED,
  NETWORK_ENABLED,
  newDangerFullAccessPolicy,
  newExternalSandboxPolicy,
  newReadOnlyPolicy,
  newWorkspaceWritePolicy,
  type SandboxPolicy as CompatibilitySandboxPolicy,
} from "../../permissions/sandbox.js";
import { sanitizeSandboxLauncherEnvironment } from "../launcher-environment.js";

export class SandboxManager {
  selectInitial(options: {
    readonly fileSystemPolicy: FileSystemSandboxPolicy;
    readonly networkPolicy: NetworkSandboxPolicy;
    readonly preference: SandboxablePreference;
    readonly windowsSandboxLevel: WindowsSandboxLevel;
    readonly hasManagedNetworkRequirements: boolean;
    readonly platform?: NodeJS.Platform;
  }): SandboxType {
    switch (options.preference) {
      case "forbid":
        return "none";
      case "require":
        return getPlatformSandbox({
          platform: options.platform,
          windowsSandboxEnabled: options.windowsSandboxLevel !== "disabled",
        }) ?? "none";
      case "auto":
        return shouldRequirePlatformSandbox(
          options.fileSystemPolicy,
          options.networkPolicy,
          options.hasManagedNetworkRequirements,
        )
          ? getPlatformSandbox({
              platform: options.platform,
              windowsSandboxEnabled: options.windowsSandboxLevel !== "disabled",
            }) ?? "none"
          : "none";
    }
  }

  transform(request: SandboxTransformRequest): SandboxExecRequest {
    const effectiveProfile = effectivePermissionProfile(
      request.permissions,
      request.command.additionalPermissions,
    );
    const { fileSystem, network } =
      permissionProfileToRuntimePermissions(effectiveProfile);
    const argv = [request.command.program, ...request.command.args];
    const platform = request.platform ?? process.platform;

    let command: readonly string[];
    let arg0: string | undefined;
    switch (request.sandbox) {
      case "none":
        command = argv;
        break;
      case "macos_seatbelt":
        if (platform !== "darwin") {
          throw new SandboxTransformError(
            "seatbelt_unavailable",
            "seatbelt sandbox is only available on macOS",
          );
        }
        command = [
          "/usr/bin/sandbox-exec",
          ...createSeatbeltCommandArgs({
            command: argv,
            fileSystemSandboxPolicy: fileSystem,
            networkSandboxPolicy: network,
            sandboxPolicyCwd: request.sandboxPolicyCwd,
            enforceManagedNetwork: request.enforceManagedNetwork,
            network: request.network,
            extraAllowUnixSockets: [],
            ...(request.allowGpu === true ? { allowGpu: true } : {}),
          }),
        ];
        break;
      case "linux_seccomp": {
        if (!request.agencLinuxSandboxExe) {
          throw new SandboxTransformError(
            "missing_linux_sandbox_executable",
            "missing agenc-linux-sandbox executable path",
          );
        }
        const allowProxyNetwork = allowNetworkForProxy(
          request.enforceManagedNetwork,
        );
        ensureLinuxBubblewrapIsSupported({
          fileSystemPolicy: fileSystem,
          useLegacyLandlock: request.useLegacyLandlock,
          allowProxyNetwork,
          isWsl1:
            platform === "linux" ? request.isWsl1 ?? isWsl1() : false,
        });
        const nodeExecutable = trustedNodeExecutable();
        if (
          canWritePathWithCwd(
            fileSystem,
            nodeExecutable,
            request.sandboxPolicyCwd,
          )
        ) {
          throw new SandboxTransformError(
            "writable_linux_sandbox_launcher",
            "the Node executable used to launch the Linux sandbox is writable by the command permission profile",
          );
        }
        if (
          canWritePathWithCwd(
            fileSystem,
            request.agencLinuxSandboxExe,
            request.sandboxPolicyCwd,
          )
        ) {
          throw new SandboxTransformError(
            "writable_linux_sandbox_helper",
            "the Linux sandbox helper is writable by the command permission profile",
          );
        }
        command = [
          nodeExecutable,
          request.agencLinuxSandboxExe,
          ...createLinuxSandboxCommandArgsForPermissionProfile(
            argv,
            request.command.cwd,
            effectiveProfile,
            request.sandboxPolicyCwd,
            request.useLegacyLandlock,
            allowProxyNetwork,
          ),
        ];
        // A normal argv0 avoids commandExec's PTY argv0 compatibility wrapper,
        // eliminating a second pre-sandbox Node process.
        arg0 = path.basename(nodeExecutable);
        break;
      }
      case "windows_restricted_token":
        throw new SandboxTransformError(
          "windows_restricted_token_unimplemented",
          "windows restricted token sandbox is not implemented; refusing to run unsandboxed",
        );
    }

    return {
      command,
      cwd: request.command.cwd,
      env: request.sandbox === "none"
        ? request.command.env
        : sanitizeSandboxLauncherEnvironment(request.command.env),
      ...(request.network !== undefined ? { network: request.network } : {}),
      sandbox: request.sandbox,
      windowsSandboxLevel: request.windowsSandboxLevel,
      windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
      permissionProfile: effectiveProfile,
      fileSystemSandboxPolicy: fileSystem,
      networkSandboxPolicy: network,
      ...(arg0 !== undefined ? { arg0 } : {}),
    };
  }
}

export function compatibilitySandboxPolicyForPermissionProfile(
  permissions: PermissionProfile,
  fileSystemPolicy: FileSystemSandboxPolicy,
  networkPolicy: NetworkSandboxPolicy,
  cwd: string,
): CompatibilitySandboxPolicy {
  return permissionProfileToCompatibilitySandboxPolicy(permissions, cwd) ??
    compatibilityWorkspaceWritePolicy(fileSystemPolicy, networkPolicy, cwd);
}

function permissionProfileToCompatibilitySandboxPolicy(
  permissions: PermissionProfile,
  cwd: string,
): CompatibilitySandboxPolicy | null {
  const { fileSystem, network } = permissionProfileToRuntimePermissions(permissions);
  const networkAccess = networkPolicyEnabled(network)
    ? NETWORK_ENABLED
    : NETWORK_DISABLED;

  switch (fileSystem.kind) {
    case "external_sandbox":
      return newExternalSandboxPolicy(networkAccess);
    case "unrestricted":
      return networkPolicyEnabled(network)
        ? newDangerFullAccessPolicy()
        : newExternalSandboxPolicy(NETWORK_DISABLED);
    case "restricted":
      break;
  }

  if (hasFullDiskWriteAccess(fileSystem)) {
    return networkPolicyEnabled(network)
      ? newDangerFullAccessPolicy()
      : newExternalSandboxPolicy(NETWORK_DISABLED);
  }

  const hasWriteEntries = fileSystem.entries.some((entry) => entry.access === "write");
  const hasNarrowingEntries = fileSystem.entries.some((entry) => entry.access !== "write");
  if (hasWriteEntries && hasNarrowingEntries) return null;

  const writableProjection = projectRestrictedWrites(fileSystem.entries, cwd);
  if (writableProjection === null) return null;
  if (writableProjection.workspaceRootWritable) {
    return newWorkspaceWritePolicy({
      writable_roots: writableProjection.writableRoots.map((root) => ({
        root,
        read_only_subpaths: [],
      })),
      network: networkAccess,
      exclude_tmpdir_env_var: !writableProjection.tmpdirWritable,
      exclude_slash_tmp: !writableProjection.slashTmpWritable,
    });
  }

  if (
    writableProjection.writableRoots.length > 0 ||
    writableProjection.tmpdirWritable ||
    writableProjection.slashTmpWritable
  ) {
    return null;
  }

  return newReadOnlyPolicy({ network: networkAccess });
}

function projectRestrictedWrites(
  entries: readonly FileSystemSandboxEntry[],
  cwd: string,
): {
  readonly workspaceRootWritable: boolean;
  readonly writableRoots: readonly string[];
  readonly tmpdirWritable: boolean;
  readonly slashTmpWritable: boolean;
} | null {
  let workspaceRootWritable = false;
  let tmpdirWritable = false;
  let slashTmpWritable = false;
  const writableRoots = new Set<string>();
  const normalizedCwd = path.resolve(cwd);

  for (const entry of entries) {
    if (entry.access !== "write") continue;
    if (entry.path.kind === "glob") continue;
    if (entry.path.kind === "special") {
      switch (entry.path.value.kind) {
        case "root":
          return null;
        case "project_roots":
          if (entry.path.value.subpath === undefined) {
            workspaceRootWritable = true;
            continue;
          }
          break;
        case "tmpdir":
          tmpdirWritable = true;
          continue;
        case "slash_tmp":
          slashTmpWritable = true;
          continue;
        case "minimal":
        case "unknown":
          continue;
      }
    }
    const resolved = resolvePermissionPath(entry.path, cwd);
    if (resolved === null) continue;
    if (path.resolve(resolved) === normalizedCwd) {
      workspaceRootWritable = true;
    } else {
      writableRoots.add(resolved);
    }
  }

  return {
    workspaceRootWritable,
    writableRoots: [...writableRoots],
    tmpdirWritable,
    slashTmpWritable,
  };
}

function compatibilityWorkspaceWritePolicy(
  fileSystemPolicy: FileSystemSandboxPolicy,
  networkPolicy: NetworkSandboxPolicy,
  cwd: string,
): CompatibilitySandboxPolicy {
  const writableRoots = getWritableRootsWithCwd(fileSystemPolicy, cwd);
  const tmpdir = process.env["TMPDIR"];
  const tmpdirWritable =
    typeof tmpdir === "string" &&
    tmpdir.length > 0 &&
    path.isAbsolute(tmpdir) &&
    canWritePathWithCwd(fileSystemPolicy, tmpdir, cwd);
  const slashTmpWritable =
    path.sep === "/" && canWritePathWithCwd(fileSystemPolicy, "/tmp", cwd);

  return newWorkspaceWritePolicy({
    writable_roots: writableRoots.map((root) => ({
      root: root.root,
      read_only_subpaths: root.readOnlySubpaths,
    })),
    network: networkPolicyEnabled(networkPolicy)
      ? NETWORK_ENABLED
      : NETWORK_DISABLED,
    exclude_tmpdir_env_var: !tmpdirWritable,
    exclude_slash_tmp: !slashTmpWritable,
  });
}

function ensureLinuxBubblewrapIsSupported(options: {
  readonly fileSystemPolicy: FileSystemSandboxPolicy;
  readonly useLegacyLandlock: boolean;
  readonly allowProxyNetwork: boolean;
  readonly isWsl1: boolean;
}): void {
  const requiresBubblewrap =
    !options.useLegacyLandlock &&
    (!hasFullDiskWriteAccess(options.fileSystemPolicy) ||
      options.allowProxyNetwork);
  if (options.isWsl1 && requiresBubblewrap) {
    throw new SandboxTransformError(
      "wsl1_unsupported_for_bubblewrap",
      "AgenC's Linux sandbox uses bubblewrap, which is not supported on WSL1",
    );
  }
}

function trustedNodeExecutable(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return path.resolve(process.execPath);
  }
}

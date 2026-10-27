import fs from "node:fs";
import path from "node:path";
import { hasFullDiskReadAccess, permissionProfileToRuntimePermissions, restrictedFileSystemPolicy } from "../engine/policy.js";
import { sanitizeSandboxLauncherEnvironment } from "../launcher-environment.js";
import { createBwrapCommandArgs } from "./bwrap.js";
import { bubblewrapCapabilityContext, capabilityDigest } from "./capability-hint.js";
import { parseLinuxSandboxLauncherArgs } from "./cli.js";
import { INHERITED_CWD_FD, SECCOMP_STDIN_FD } from "./config.js";
import { installedRuntimeRoot, launcherReadRoots } from "./direct-bwrap.js";
import { isNativeElfExecutable, resolveSandboxDeviceBinds } from "./direct-bwrap-platform.js";
import { createNetworkSeccompProgram, networkSeccompMode } from "./landlock.js";
import { findSystemBubblewrapInPath, probeBubblewrapCapabilities } from "./launcher.js";
import { SuccessfulProbeCache } from "./probe-cache.js";
import { createProcMountProbeArgs, runProcMountProbe } from "./proc-probe.js";

/**
 * A descriptor-bound read-only search (Grep, Glob, Orient) runs pinned
 * ripgrep through the Node sandbox launcher started by the authenticated
 * directory helper. Per search that launcher starts Node, probes bubblewrap's
 * namespaces, its help text and procfs support, starts bubblewrap, and starts
 * Node again inside it only to exec ripgrep.
 *
 * This plans the same bubblewrap launch in the daemon from the same launcher
 * arguments with the launcher's own policy code: the same filesystem policy,
 * the held directory bound read-only from descriptor 4 at the same sandbox
 * path, the same network seccomp program on descriptor 3, the same namespaces
 * and procfs. The probes run once per bubblewrap, environment, mount table
 * and directory and only successes are kept. Bubblewrap then execs the native
 * ripgrep itself, as the launcher already does for every other native
 * command. The helper starts bubblewrap after proving that the descriptor it
 * passes is still the bound directory. Anything this does not reproduce
 * exactly keeps the launcher.
 */
export interface BoundReadOnlyBwrapLaunch {
  /** Bubblewrap, and the identity the helper checks again before starting it. */
  readonly program: string;
  readonly programIdentity: BoundReadOnlyBwrapProgramIdentity;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The network seccomp program bubblewrap reads from descriptor 3. */
  readonly seccomp: Buffer;
  readonly seccompFd: typeof SECCOMP_STDIN_FD;
  readonly cwdFd: typeof INHERITED_CWD_FD;
  /** A narrow profile's bound directory, which the held descriptor must be. */
  readonly cwdIdentity?: { readonly dev: string; readonly ino: string; readonly mode: string };
}

export interface BoundReadOnlyBwrapProgramIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mode: string;
  readonly mtimeNs: string;
}

export interface PreparedBoundReadOnlyBwrapLaunch {
  readonly launch: BoundReadOnlyBwrapLaunch;
  /** Forget the probe evidence this launch used (a launch that failed to start). */
  readonly invalidate: () => void;
}

const probes = new SuccessfulProbeCache();
let restrictedSeccomp: Buffer | undefined;

function programIdentity(program: string): BoundReadOnlyBwrapProgramIdentity {
  const stat = fs.statSync(program, { bigint: true });
  if (!stat.isFile()) throw new Error("bubblewrap is not a regular file");
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mode: String(stat.mode),
    mtimeNs: String(stat.mtimeNs) };
}

/**
 * Plan a bound ripgrep launch from the launcher command the sandbox broker
 * prepared, or undefined to keep that command. `directory` is the path of the
 * directory the helper holds (the launcher's own cwd).
 */
export function prepareBoundReadOnlyBwrapLaunch(input: {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly directory: string;
  /** Identity of the directory the helper holds. */
  readonly heldIdentity?: { readonly dev: string; readonly ino: string; readonly mode: string };
}): PreparedBoundReadOnlyBwrapLaunch | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const root = installedRuntimeRoot(), helper = input.args[0];
    if (root === undefined || helper === undefined || !path.isAbsolute(helper)) return undefined;
    if (fs.realpathSync(helper) !== fs.realpathSync(path.join(root, "bin/agenc-linux-sandbox")) ||
        fs.realpathSync(input.program) !== fs.realpathSync(process.execPath)) return undefined;
    const options = parseLinuxSandboxLauncherArgs(input.args.slice(1));
    const ripgrep = options.command[0];
    if (!options.inheritedCwd || options.allowNetworkForProxy || options.proxyRouteSpec !== null ||
        options.browserCdpOverStdio || options.applySeccompThenExec || options.capabilityHint !== undefined ||
        ripgrep === undefined || !path.isAbsolute(ripgrep) || !isNativeElfExecutable(ripgrep)) return undefined;
    // The launcher runs with exactly this environment; it must already be the
    // sanitized launcher environment it would compute.
    const env = { ...input.env };
    if (capabilityDigest(env) !== capabilityDigest(sanitizeSandboxLauncherEnvironment(env))) return undefined;
    const permissions = permissionProfileToRuntimePermissions(options.permissionProfile);
    const bound = options.boundReadOnlyCwd;
    // As the launcher: only a narrow bound profile keeps its own policy, and
    // an unbound inherited cwd needs full disk read access.
    if (bound === undefined && !hasFullDiskReadAccess(permissions.fileSystem)) return undefined;
    // The launcher refuses a held directory other than the one its profile
    // was narrowed to; leave that refusal (and its report) to it.
    if (bound !== undefined && (input.heldIdentity === undefined || bound.dev !== input.heldIdentity.dev ||
        bound.ino !== input.heldIdentity.ino || bound.mode !== input.heldIdentity.mode)) return undefined;
    const fileSystem = bound !== undefined ? permissions.fileSystem : restrictedFileSystemPolicy(
      [{ path: { kind: "special", value: { kind: "root" } }, access: "read" }], { includePlatformDefaults: true });
    const seccompMode = networkSeccompMode(permissions.network, false, false, options.allowLocalBinding);
    if (seccompMode !== "restricted") return undefined;
    const program = findSystemBubblewrapInPath(env.PATH, input.directory);
    if (program === null) return undefined;
    const context = bubblewrapCapabilityContext(program, input.directory, env);
    if (context === undefined) return undefined;
    const probeOptions = { launcher: { program, supportsArgv0: false }, fileSystem,
      sandboxPolicyCwd: options.sandboxPolicyCwd, commandCwd: options.commandCwd, inheritedCwdFd: INHERITED_CWD_FD,
      ...(bound === undefined ? {} : { boundReadOnlyCwd: bound }), networkMode: "isolated" as const,
      sessionTempRoot: options.sessionTempRoot };
    const proc = options.mountProc ? createProcMountProbeArgs(probeOptions) : undefined;
    const key = capabilityDigest(["bound-read-only", context, proc === undefined ? null : capabilityDigest(proc.args)]);
    const evidence = probes.get(key, () => {
      const capabilities = probeBubblewrapCapabilities(program, env, input.directory);
      if (capabilities?.supportsBindFd !== true) return undefined;
      if (proc !== undefined) {
        const directory = fs.openSync(input.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try {
          const result = runProcMountProbe({ ...probeOptions, inheritedCwdFd: directory }, proc.args, env);
          if (result.error !== undefined || result.status !== 0) return undefined;
        } finally { fs.closeSync(directory); }
      }
      if (bubblewrapCapabilityContext(program, input.directory, env) !== context) return undefined;
      return { context, procArgs: proc === undefined ? "" : capabilityDigest(proc.args), ...capabilities };
    });
    if (evidence === undefined) return undefined;
    const bwrap = createBwrapCommandArgs(options.command, fileSystem, options.sandboxPolicyCwd, options.commandCwd, {
      mountProc: options.mountProc, networkMode: "isolated", sessionTempRoot: options.sessionTempRoot,
      seccompFd: SECCOMP_STDIN_FD,
      extraReadOnlyBindRoots: launcherReadRoots(process.execPath, path.join(root, "dist/sandbox/linux-launcher/main.js")),
      extraWritableBindRoots: [], extraDeviceBindPaths: resolveSandboxDeviceBinds(env),
      inheritedReadOnlyCwd: true, ...(bound === undefined ? {} : { boundReadOnlyCwd: bound }),
      chdirToCommandCwd: true,
    });
    if (!bwrap.usesBubblewrap || bwrap.protectedCreateTargets.length !== 0) return undefined;
    restrictedSeccomp ??= createNetworkSeccompProgram("restricted");
    return {
      launch: { program, programIdentity: programIdentity(program), args: bwrap.args,
        env: { ...env, AGENC_LINUX_SANDBOX_ACTIVE: "1" }, seccomp: restrictedSeccomp,
        seccompFd: SECCOMP_STDIN_FD, cwdFd: INHERITED_CWD_FD,
        ...(bound === undefined ? {} : { cwdIdentity: { dev: bound.dev, ino: bound.ino, mode: bound.mode } }) },
      invalidate: () => probes.invalidate(key),
    };
  } catch {
    // A miss keeps the launcher and its own probes.
    return undefined;
  }
}

/**
 * Whether a planned launch failed inside bubblewrap before ripgrep ran (a
 * procfs, namespace or mount refusal). Such a search ran nothing, so the
 * caller runs it again through the launcher, which has its own fallbacks.
 */
export function boundReadOnlyBwrapFailedToStart(result: {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}): boolean {
  return result.exitCode !== 0 && result.exitCode !== null && result.stdout.byteLength === 0 &&
    /^bwrap: /mu.test(result.stderr.toString("utf8"));
}

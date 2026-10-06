import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNamespaceInitArtifact } from "./namespace-init-artifact.js";
import { serializeProcessBrokerV3Payload } from "../../utils/process-broker-protocol-v3.js";
import { serializeProcessBrokerV2Payload } from "../../utils/process-broker-protocol-v2.js";
import { permissionProfileToRuntimePermissions } from "../engine/policy.js";
import { sanitizeSandboxLauncherEnvironment } from "../launcher-environment.js";
import { createBwrapCommandArgs } from "./bwrap.js";
import { bubblewrapCapabilityContext } from "./capability-hint.js";
import { parseLinuxSandboxLauncherArgs } from "./cli.js";
import { isNativeElfExecutable, resolveSandboxDeviceBinds } from "./direct-bwrap-platform.js";
import { createNetworkSeccompProgram, networkSeccompMode } from "./landlock.js";
import { preferredBubblewrapLauncher } from "./launcher.js";
import { createProcMountProbeArgs, runProcMountProbe } from "./proc-probe.js";
import { capabilityDigest } from "./capability-hint.js";

import { registerDirectBwrapPlan, type PreparedDirectBwrap } from "../../utils/direct-bwrap-handoff.js";
export { consumeDirectBwrapPlan, type PreparedDirectBwrap } from "../../utils/direct-bwrap-handoff.js";

function fileIdentity(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error("direct sandbox executable is not a file");
  return [fs.realpathSync(file), stat.dev, stat.ino, stat.size, stat.mode,
    stat.uid, stat.gid, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Resolve from this trusted installed module, never the command's cwd/env. */
function installedRuntimeRoot(): string | undefined {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { name?: string };
      if (manifest.name === "@tetsuo-ai/runtime") return directory;
    } catch { /* Continue toward the containing package. */ }
    directory = path.dirname(directory);
  }
  return undefined;
}

function launcherReadRoots(node: string, entry: string): string[] {
  const roots = new Set<string>();
  for (const file of [node, entry]) {
    if (!fs.existsSync(file)) continue;
    const normalized = path.normalize(file), marker = `${path.sep}dist${path.sep}`;
    const index = normalized.lastIndexOf(marker);
    roots.add(index < 0 ? path.dirname(file) : normalized.slice(0, index + marker.length - 1));
  }
  return [...roots];
}

/** Own every preparation failure as well as the successful handoff. The old
 * launcher helper closes an untracked integer in cleanup and cannot transfer
 * ownership; keep its implementation unchanged and use the same private-file
 * construction here with one idempotent owner and no surviving pathname. */
function prepareSeccompSource(sessionTempRoot: string, bytes: Buffer): { fd: number; dispose: () => void } {
  const directory = fs.mkdtempSync(path.join(sessionTempRoot, "agenc-seccomp-"));
  const file = path.join(directory, "network.bpf");
  let owned: number | undefined;
  const dispose = (): void => {
    if (owned === undefined) return;
    const closing = owned;
    owned = undefined;
    fs.closeSync(closing);
  };
  try {
    owned = fs.openSync(file, "wx+", 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(owned, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error("incomplete direct seccomp source write");
      offset += written;
    }
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
    return { fd: owned, dispose };
  } catch (error) {
    try { dispose(); } finally { fs.rmSync(directory, { force: true, recursive: true }); }
    throw error;
  }
}

/** Ordinary pipe-shell invocation only; the caller excludes wrappers,
 * delegated inspection, TTY and detached routes before calling this planner.
 * Any miss is before dispatch and retains the original Node launcher. */
interface DirectBwrapInput {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export function prepareDirectBwrapPlan(input: DirectBwrapInput): PreparedDirectBwrap | undefined {
  return preparePlan(input, false);
}

/** Authenticated namespace-init route with the fixed installed artifact. */
export function prepareDirectBwrapV3Plan(input: DirectBwrapInput): PreparedDirectBwrap | undefined {
  return preparePlan(input, true);
}

function preparePlan(input: DirectBwrapInput, namespaceInit: boolean): PreparedDirectBwrap | undefined {
  if (process.platform !== "linux") return undefined;
  let source: ReturnType<typeof prepareSeccompSource> | undefined;
  try {
    const root = installedRuntimeRoot(), helper = input.args[0];
    if (root === undefined || helper === undefined || !path.isAbsolute(helper)) return undefined;
    const canonicalHelper = path.join(root, "bin/agenc-linux-sandbox");
    if (fs.realpathSync(helper) !== fs.realpathSync(canonicalHelper) ||
        fs.realpathSync(input.program) !== fs.realpathSync(process.execPath)) return undefined;
    const options = parseLinuxSandboxLauncherArgs(input.args.slice(1));
    const shell = options.command[0];
    if (options.inheritedCwd || options.boundReadOnlyCwd !== undefined ||
        options.allowNetworkForProxy || options.proxyRouteSpec !== null ||
        options.browserCdpOverStdio || options.applySeccompThenExec ||
        options.commandCwd !== input.cwd || shell === undefined ||
        !path.isAbsolute(shell) || !isNativeElfExecutable(shell)) return undefined;
    // A separate launcher captures this session env before defaulting NODE_ENV,
    // then restores it. Applying the daemon's global original-env symbol here
    // would incorrectly remove an explicit per-session NODE_ENV=production.
    const env = { ...input.env };
    if (capabilityDigest(env) !== capabilityDigest(sanitizeSandboxLauncherEnvironment(env))) return undefined;
    const identities = [input.program, helper, shell].map(fileIdentity);
    const permissions = permissionProfileToRuntimePermissions(options.permissionProfile);
    const seccompMode = networkSeccompMode(permissions.network, false, false);
    if (seccompMode !== null && seccompMode !== "restricted") return undefined;
    const networkMode = permissions.network === "enabled" ? "full-access" : "isolated";
    const launcher = preferredBubblewrapLauncher({ cwd: input.cwd, env, requireNamespaces: true,
      ...(options.capabilityHint === undefined ? {} : { capabilityHint: options.capabilityHint }) });
    if (launcher === null) return undefined;
    const context = bubblewrapCapabilityContext(launcher.program, input.cwd, env);
    if (context === undefined) return undefined;
    let mountProc = options.mountProc;
    const probeOptions = { launcher, fileSystem: permissions.fileSystem,
      sandboxPolicyCwd: options.sandboxPolicyCwd, commandCwd: options.commandCwd,
      networkMode, sessionTempRoot: options.sessionTempRoot } as const;
    if (mountProc) {
      const probe = createProcMountProbeArgs(probeOptions);
      if (probe.usesBubblewrap && launcher.capabilityHint?.procArgs !== capabilityDigest(probe.args)) {
        const result = runProcMountProbe(probeOptions, probe.args, env);
        mountProc = result.status === 0 || !/can't mount (?:new )?proc(?:fs)?\b/i.test(result.stderr ?? "");
      }
    }
    // All policy, path, device and BPF work is fresh and follows slow probes.
    const bwrap = createBwrapCommandArgs(options.command, permissions.fileSystem,
      options.sandboxPolicyCwd, options.commandCwd, {
        mountProc, networkMode, sessionTempRoot: options.sessionTempRoot,
        ...(seccompMode === null ? {} : { seccompFd: 3 }),
        extraReadOnlyBindRoots: launcherReadRoots(process.execPath, path.join(root, "dist/sandbox/linux-launcher/main.js")),
        extraWritableBindRoots: [], extraDeviceBindPaths: resolveSandboxDeviceBinds(env),
        inheritedReadOnlyCwd: false, chdirToCommandCwd: true,
      });
    if (!bwrap.usesBubblewrap || bwrap.protectedCreateTargets.length !== 0) return undefined;
    const artifact = namespaceInit ? prepareNamespaceInitArtifact(root, bwrap.args) : undefined;
    if (namespaceInit && artifact === undefined) return undefined;
    const isCurrent = (): boolean => {
      try {
        return (artifact === undefined || artifact.isCurrent()) && [input.program, helper, shell].every((file, index) => fileIdentity(file) === identities[index]) &&
          bubblewrapCapabilityContext(launcher.program, input.cwd, env) === context;
      } catch { return false; }
    };
    if (!isCurrent()) return undefined;
    const seccomp = seccompMode === null ? undefined : createNetworkSeccompProgram(seccompMode);
    if (seccomp !== undefined) source = prepareSeccompSource(options.sessionTempRoot, seccomp);
    const serialize = namespaceInit ? serializeProcessBrokerV3Payload : serializeProcessBrokerV2Payload;
    const payload = serialize({ program: launcher.program, args: bwrap.args,
      env: { ...env, AGENC_LINUX_SANDBOX_ACTIVE: "1" }, ownerPid: process.pid,
      ...(seccomp === undefined ? {} : { seccomp }) });
    const ownedSource = source;
    const plan = registerDirectBwrapPlan({ payload,
      ...(artifact === undefined ? {} : { namespaceInitArtifact: artifact.target }), sourceFd: source?.fd, isCurrent,
      dispose: () => ownedSource?.dispose() });
    source = undefined;
    return plan;
  } catch {
    return undefined;
  } finally {
    source?.dispose();
  }
}

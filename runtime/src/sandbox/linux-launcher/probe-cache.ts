import path from "node:path";
import { parseLinuxSandboxLauncherArgs } from "./cli.js";
import { permissionProfileToRuntimePermissions } from "../engine/policy.js";
import { findSystemBubblewrapInPath, probeBubblewrapCapabilities } from "./launcher.js";
import { createProcMountProbeArgs, runProcMountProbe } from "./proc-probe.js";
import { bubblewrapCapabilityContext, capabilityDigest, type BubblewrapCapabilityHint } from "./capability-hint.js";

/** Bounded process-local cache: no disk state, no negative capability results. */
export class SuccessfulProbeCache<T = BubblewrapCapabilityHint> {
  private readonly entries = new Map<string, T>();
  get(key: string, probe: () => T | undefined): T | undefined {
    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    const result = probe();
    if (result !== undefined) this.remember(key, result);
    return result;
  }
  peek(key: string): T | undefined { return this.entries.get(key); }
  remember(key: string, value: T): void {
    if (!this.entries.has(key) && this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, value);
  }
  invalidate(key: string): void { this.entries.delete(key); }
}
const daemonProbes = new SuccessfulProbeCache();
/**
 * The namespace and `--help` probes depend on the bubblewrap executable and the
 * capability context (its identity, the cwd, the sanitized environment, ids,
 * namespaces and mounts), not on a command's mount arguments. Each sandbox
 * policy (the inspection, read-only shell and workspace-write slots, and every
 * policy change) has its own proc-mount probe, but one context runs these two
 * probes once instead of once per policy: each is a synchronous child process
 * on the daemon's event loop, on the path of the command that first needs it.
 */
const daemonCapabilities = new SuccessfulProbeCache<NonNullable<ReturnType<typeof probeBubblewrapCapabilities>>>();
// Evidence for this exact in-process launch only. Serialized hints remain
// advisory and cannot mint this entry; actual confinement is always rebuilt.
const preparedProcProbes = new WeakMap<readonly string[], {
  readonly context: string;
  readonly argsDigest: string;
}>();

export function consumePreparedProcProbe(args: readonly string[], context: string): boolean {
  const evidence = preparedProcProbes.get(args);
  preparedProcProbes.delete(args);
  return evidence !== undefined && evidence.context === context &&
    evidence.argsDigest === capabilityDigest(args);
}

/**
 * Pipe launches only. On failure the caller invalidates, then reports the
 * original result. It MUST NOT retry a command: nonzero can follow an effect.
 */
export function prepareLinuxSandboxProbeHint(
  args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
): { readonly args: readonly string[]; readonly invalidate: () => void } | undefined {
  if (process.platform !== "linux" || path.basename(args[0] ?? "") !== "agenc-linux-sandbox") return undefined;
  try {
    const options = parseLinuxSandboxLauncherArgs(args.slice(1));
    if (options.inheritedCwd || options.allowNetworkForProxy || options.applySeccompThenExec ||
        options.browserCdpOverStdio || !options.mountProc) return undefined;
    const program = findSystemBubblewrapInPath(env.PATH, cwd);
    if (program === null) return undefined;
    const context = bubblewrapCapabilityContext(program, cwd, env);
    if (context === undefined) return undefined;
    const permissions = permissionProfileToRuntimePermissions(options.permissionProfile);
    const probeOptions = {
      launcher: { program, supportsArgv0: false },
      fileSystem: permissions.fileSystem, sandboxPolicyCwd: options.sandboxPolicyCwd,
      commandCwd: options.commandCwd, sessionTempRoot: options.sessionTempRoot,
      networkMode: permissions.network === "enabled" ? "full-access" as const : "isolated" as const,
    };
    // Resolve current paths/mount arguments each time. Never cache a policy plan.
    const proc = createProcMountProbeArgs(probeOptions);
    if (!proc.usesBubblewrap) return undefined;
    const procArgs = capabilityDigest(proc.args);
    const key = capabilityDigest([context, procArgs]);
    const hint = daemonProbes.get(key, () => {
      const known = daemonCapabilities.peek(context);
      const capabilities = known ?? probeBubblewrapCapabilities(program, env, cwd);
      if (capabilities === undefined) return undefined;
      const result = runProcMountProbe(probeOptions, proc.args, env);
      if (result.error !== undefined || result.status !== 0) return undefined;
      // Do not retain a result spanning replacement or namespace/mount change.
      if (bubblewrapCapabilityContext(program, cwd, env) !== context) {
        daemonCapabilities.invalidate(context);
        return undefined;
      }
      // Like the hint itself, only a complete success seeds the cache.
      if (known === undefined) daemonCapabilities.remember(context, capabilities);
      return { context, procArgs, ...capabilities };
    });
    if (hint === undefined) return undefined;
    const hintedArgs = [args[0]!, "--bwrap-capability-hint", JSON.stringify(hint), ...args.slice(1)];
    preparedProcProbes.set(hintedArgs, { context, argsDigest: capabilityDigest(hintedArgs) });
    return { args: hintedArgs, invalidate: () => {
      preparedProcProbes.delete(hintedArgs);
      daemonProbes.invalidate(key);
      // A failed launch re-probes everything it relied on, as before.
      daemonCapabilities.invalidate(context);
    } };
  } catch {
    // Optimization failure is a miss, with the original launcher/probes intact.
    return undefined;
  }
}

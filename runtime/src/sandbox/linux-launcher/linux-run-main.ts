import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBwrapCommandArgs,
  insertInnerCommandArgv0,
  type BwrapNetworkMode,
} from "./bwrap.js";
import {
  parseLinuxSandboxLauncherArgs,
  type LinuxSandboxLauncherOptions,
} from "./cli.js";
import { LINUX_SANDBOX_ARG0, SECCOMP_STDIN_FD } from "./config.js";
import {
  networkSeccompMode,
  type NetworkSeccompMode,
} from "./landlock.js";
import {
  preferredBubblewrapLauncher,
  spawnBubblewrap,
  type BubblewrapLauncher,
} from "./launcher.js";
import {
  activateProxyRoutesInNetns,
  prepareHostProxyRoutes,
} from "./proxy-routing.js";
import {
  type FileSystemSandboxPolicy,
  permissionProfileToRuntimePermissions,
} from "../engine/index.js";

const ACTIVE_INNER_ENV = "AGENC_LINUX_SANDBOX_ACTIVE";

export interface LinuxSandboxRunDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly selfCommand?: readonly string[];
  readonly preferredLauncher?: () => BubblewrapLauncher | null;
  readonly onStderr?: (line: string) => void;
}

export async function runLinuxSandboxMain(
  argv: readonly string[] = process.argv.slice(2),
  deps: LinuxSandboxRunDeps = {},
): Promise<number> {
  try {
    const options = parseLinuxSandboxLauncherArgs(argv);
    return await runLinuxSandboxOptions(options, deps);
  } catch (error) {
    deps.onStderr?.(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function runLinuxSandboxOptions(
  options: LinuxSandboxLauncherOptions,
  deps: LinuxSandboxRunDeps = {},
): Promise<number> {
  if (options.useLegacyLandlock) {
    throw new Error(
      "legacy Landlock mode is unavailable in the TypeScript launcher; use bubblewrap mode",
    );
  }
  if (options.applySeccompThenExec) {
    const env = deps.env ?? process.env;
    if (env[ACTIVE_INNER_ENV] !== "1") {
      throw new Error("inner Linux sandbox stage must run inside bubblewrap");
    }
    const activatedProxy = options.allowNetworkForProxy
      ? await activateProxyRoutesInNetns(requireProxyRouteSpec(options.proxyRouteSpec), env)
      : null;
    try {
      if (activatedProxy !== null) {
        return await runCommandWithInnerSeccomp(options.command, {
          cwd: options.commandCwd,
          env: activatedProxy.env,
          seccompMode: "proxy-routed",
          preferredLauncher: deps.preferredLauncher,
        });
      }
      return execCommand(options.command, {
        cwd: options.commandCwd,
        env,
        argv0: options.command[0] ?? LINUX_SANDBOX_ARG0,
      });
    } finally {
      activatedProxy?.cleanup();
    }
  }

  const env = deps.env ?? process.env;
  const { fileSystem, network } =
    permissionProfileToRuntimePermissions(options.permissionProfile);
  const preparedProxy = options.allowNetworkForProxy
    ? await prepareHostProxyRoutes(env)
    : null;
  const selfCommand = deps.selfCommand ?? defaultSelfCommand();
  const innerCommand = createInnerLauncherCommand(
    options,
    selfCommand,
    preparedProxy?.serializedSpec ?? null,
  );
  const extraBindRoots = [
    ...inferredInnerLauncherBindRoots(selfCommand),
    ...(preparedProxy === null ? [] : [preparedProxy.socketDir]),
  ];
  const proxyRoutedNetwork = options.allowNetworkForProxy;
  const seccompMode = networkSeccompMode(
    network,
    options.allowNetworkForProxy,
    proxyRoutedNetwork,
  );
  const bwrapSeccompMode = options.allowNetworkForProxy ? null : seccompMode;
  const networkMode = bwrapNetworkMode(network, options.allowNetworkForProxy);
  try {
    let bwrapArgs = createBwrapCommandArgs(
      innerCommand,
      fileSystem,
      options.sandboxPolicyCwd,
      options.commandCwd,
      {
        mountProc: options.mountProc,
        networkMode,
        ...(bwrapSeccompMode !== null ? { seccompFd: SECCOMP_STDIN_FD } : {}),
        extraBindRoots,
      },
    );
    if (!bwrapArgs.usesBubblewrap) {
      return execCommand(options.command, {
        cwd: options.commandCwd,
        env,
        argv0: options.command[0] ?? LINUX_SANDBOX_ARG0,
      });
    }
    const launcher = (deps.preferredLauncher ?? preferredBubblewrapLauncher)();
    if (launcher === null) {
      throw new Error(
        "AgenC could not find bubblewrap on PATH; install bubblewrap or configure agenc-linux-sandbox to a valid helper",
      );
    }
    if (
      options.mountProc &&
      !preflightProcMountSupport({
        launcher,
        fileSystem,
        sandboxPolicyCwd: options.sandboxPolicyCwd,
        commandCwd: options.commandCwd,
        networkMode,
      })
    ) {
      bwrapArgs = createBwrapCommandArgs(
        innerCommand,
        fileSystem,
        options.sandboxPolicyCwd,
        options.commandCwd,
        {
          mountProc: false,
          networkMode,
          ...(bwrapSeccompMode !== null ? { seccompFd: SECCOMP_STDIN_FD } : {}),
          extraBindRoots,
        },
      );
    }
    const finalArgs = insertInnerCommandArgv0(
      bwrapArgs.args,
      launcher.supportsArgv0,
      selfCommand[0] ?? process.execPath,
    );
    const protectedMonitor = startProtectedCreateMonitor(
      bwrapArgs.protectedCreateTargets,
    );
    const spawned = spawnBubblewrap(launcher, finalArgs, {
      cwd: options.commandCwd,
      env: { ...env, [ACTIVE_INNER_ENV]: "1" },
      stdio: "inherit",
      ...(bwrapSeccompMode !== null ? { seccompMode: bwrapSeccompMode } : {}),
    });
    let protectedCreateViolation = false;
    try {
      const exitCode = await waitForChildWithSignalRelay(spawned.child);
      protectedCreateViolation = protectedMonitor.stop();
      return protectedCreateViolation && exitCode === 0 ? 1 : exitCode;
    } finally {
      if (!protectedCreateViolation) protectedMonitor.stop();
      spawned.cleanup();
    }
  } finally {
    preparedProxy?.cleanup();
  }
}

function createInnerLauncherCommand(
  options: LinuxSandboxLauncherOptions,
  selfCommand: readonly string[],
  proxyRouteSpec: string | null,
): string[] {
  return [
    ...selfCommand,
    "--apply-seccomp-then-exec",
    "--sandbox-policy-cwd",
    options.sandboxPolicyCwd,
    "--command-cwd",
    options.commandCwd,
    "--permission-profile",
    JSON.stringify(options.permissionProfile),
    ...(options.mountProc ? [] : ["--no-proc"]),
    ...(options.allowNetworkForProxy ? ["--allow-network-for-proxy"] : []),
    ...(proxyRouteSpec === null ? [] : ["--proxy-route-spec", proxyRouteSpec]),
    "--",
    ...options.command,
  ];
}

function defaultSelfCommand(): readonly string[] {
  return [
    process.execPath,
    fileURLToPath(new URL("./main.js", import.meta.url)),
  ];
}

function inferredInnerLauncherBindRoots(selfCommand: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const arg of selfCommand) {
    if (!path.isAbsolute(arg) || !fs.existsSync(arg)) continue;
    const distRoot = runtimeDistRootForPath(arg);
    if (distRoot !== null) {
      roots.add(distRoot);
      continue;
    }
    const stat = fs.statSync(arg);
    roots.add(stat.isDirectory() ? arg : path.dirname(arg));
  }
  return [...roots];
}

function runtimeDistRootForPath(filePath: string): string | null {
  const normalized = path.normalize(filePath);
  const marker = `${path.sep}dist${path.sep}`;
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  return normalized.slice(0, index + marker.length - 1);
}

function requireProxyRouteSpec(value: string | null): string {
  if (value === null || value.trim().length === 0) {
    throw new Error("managed proxy inner stage is missing a proxy route spec");
  }
  return value;
}

function bwrapNetworkMode(
  network: "enabled" | "disabled" | "restricted",
  allowNetworkForProxy: boolean,
): BwrapNetworkMode {
  if (allowNetworkForProxy) return "proxy-only";
  return network === "enabled" ? "full-access" : "isolated";
}

export async function runCommandWithSupervision(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly argv0: string;
  },
): Promise<number> {
  const [program, ...args] = command;
  if (program === undefined) {
    throw new Error("Linux sandbox command is missing");
  }
  const child = spawn(program, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    argv0: options.argv0,
  });
  return await waitForChildWithSignalRelay(child);
}

function execCommand(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly argv0: string;
  },
): never {
  const [rawProgram, ...args] = command;
  if (rawProgram === undefined) {
    throw new Error("Linux sandbox command is missing");
  }
  const execve = (process as NodeJS.Process & {
    readonly execve?: (
      file: string,
      args: readonly string[],
      env: Readonly<Record<string, string>>,
    ) => never;
  }).execve;
  if (typeof execve !== "function") {
    throw new Error("Linux sandbox execve is unavailable on this Node runtime");
  }
  // execve does NOT search PATH — a bare program name (e.g. `rg` from the
  // system-ripgrep resolution) would die here with ENOENT even when the
  // binary is perfectly mounted inside the namespace. Resolve bare names
  // against the command's own PATH (the daemon's sanitized env, which keeps
  // PATH by design) before exec'ing.
  const program = resolveProgramOnPath(rawProgram, options.env);
  process.chdir(options.cwd);
  execve(program, [options.argv0, ...args], stringOnlyEnv(options.env));
  throw new Error("Linux sandbox execve returned unexpectedly");
}

function resolveProgramOnPath(
  program: string,
  env: NodeJS.ProcessEnv,
): string {
  if (program.includes("/")) return program;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, program);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep searching the remaining PATH entries
    }
  }
  // Not found anywhere: hand the original name back so execve's ENOENT
  // reports the program the caller actually asked for.
  return program;
}

async function runCommandWithInnerSeccomp(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly seccompMode: NetworkSeccompMode;
    readonly preferredLauncher?: () => BubblewrapLauncher | null;
  },
): Promise<number> {
  const launcher = (options.preferredLauncher ?? preferredBubblewrapLauncher)();
  if (launcher === null) {
    throw new Error(
      "AgenC could not find bubblewrap on PATH for inner seccomp application",
    );
  }
  const args = insertFinalCommandArgv0([
    "--die-with-parent",
    "--bind",
    "/",
    "/",
    "--seccomp",
    String(SECCOMP_STDIN_FD),
    "--",
    ...command,
  ], launcher.supportsArgv0, command[0] ?? process.execPath);
  const spawned = spawnBubblewrap(launcher, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    seccompMode: options.seccompMode,
  });
  try {
    return await waitForChildWithSignalRelay(spawned.child);
  } finally {
    spawned.cleanup();
  }
}

function insertFinalCommandArgv0(
  bwrapArgs: readonly string[],
  supportsArgv0: boolean,
  argv0: string,
): string[] {
  const args = [...bwrapArgs];
  const separatorIndex = args.indexOf("--");
  if (separatorIndex === -1) {
    throw new Error("bubblewrap argv is missing command separator");
  }
  if (supportsArgv0) {
    args.splice(separatorIndex, 0, "--argv0", argv0);
  }
  return args;
}

function waitForChildWithSignalRelay(child: ChildProcess): Promise<number> {
  const relays = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  const listeners = relays.map((signal) => {
    const listener = () => child.kill(signal);
    process.once(signal, listener);
    return { signal, listener };
  });
  return waitForChild(child).finally(() => {
    for (const { signal, listener } of listeners) {
      process.off(signal, listener);
    }
  });
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      resolve(signalExitCode(signal));
    });
  });
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    case "SIGHUP":
      return 129;
    case "SIGQUIT":
      return 131;
    default:
      return 1;
  }
}

function stringOnlyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function preflightProcMountSupport(options: {
  readonly launcher: BubblewrapLauncher;
  readonly fileSystem: FileSystemSandboxPolicy;
  readonly sandboxPolicyCwd: string;
  readonly commandCwd: string;
  readonly networkMode: BwrapNetworkMode;
}): boolean {
  const args = createBwrapCommandArgs(
    [resolveTrueCommand()],
    options.fileSystem,
    options.sandboxPolicyCwd,
    options.commandCwd,
    {
      mountProc: true,
      networkMode: options.networkMode,
    },
  );
  if (!args.usesBubblewrap) return true;
  const output = spawnSync(options.launcher.program, args.args, {
    cwd: options.commandCwd,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  return output.status === 0 || !isProcMountFailure(output.stderr ?? "");
}

function resolveTrueCommand(): string {
  return "/bin/true";
}

export function isProcMountFailure(stderr: string): boolean {
  // Match only bubblewrap's procfs-mount-specific failure strings. The previous
  // broad `proc|not permitted` substrings false-positived on unrelated stderr,
  // which could let the launcher silently fall back to running without a
  // private procfs while host /proc stayed exposed. Prefer failing closed: only
  // treat a genuine proc-mount error as a recoverable proc-mount failure.
  // bubblewrap reports a procfs mount failure as "Can't mount proc on <dest>"
  // (older builds also emit "Can't mount new procfs").
  return /can't mount (?:new )?proc(?:fs)?\b/i.test(stderr);
}

function startProtectedCreateMonitor(
  targets: readonly string[],
): { readonly stop: () => boolean } {
  if (targets.length === 0) return { stop() { return false; } };
  let violation = false;
  const scan = () => {
    for (const target of targets) {
      if (fs.existsSync(target)) {
        violation = true;
      }
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup for protected metadata created during launch.
      }
    }
  };
  scan();
  const interval = setInterval(scan, 100);
  return {
    stop(): boolean {
      clearInterval(interval);
      scan();
      return violation;
    },
  };
}

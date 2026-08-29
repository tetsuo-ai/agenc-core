import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_BWRAP_PROGRAM,
  FALLBACK_BWRAP_PROGRAM,
  INHERITED_CWD_FD,
  SECCOMP_STDIN_FD,
} from "./config.js";
import {
  openNetworkSeccompProgramFile,
  type NetworkSeccompMode,
  type SeccompProgramFile,
} from "./landlock.js";
import { sanitizeSandboxLauncherEnvironment } from "../launcher-environment.js";

const BUBBLEWRAP_HELP_PROBE_TIMEOUT_MS = 3_000;
const BUBBLEWRAP_HELP_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
const BUBBLEWRAP_NAMESPACE_PROBE_TIMEOUT_MS = 3_000;
const BUBBLEWRAP_NAMESPACE_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export interface BubblewrapLauncher {
  readonly program: string;
  readonly supportsArgv0: boolean;
  readonly supportsBindFd?: boolean;
}

export interface BubblewrapNamespaceProbeResult {
  readonly ok: boolean;
  readonly diagnostic: string;
}

export interface PreferredBubblewrapLauncherOptions {
  readonly searchPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly trustedDirectories?: readonly string[];
  readonly probeArgv0?: (program: string) => boolean;
  /** Require the outer launcher's user/pid/network namespace rung to work. */
  readonly requireNamespaces?: boolean;
}

export interface SpawnBubblewrapOptions extends SpawnOptions {
  readonly seccompMode?: NetworkSeccompMode | null;
  readonly inheritedCwdFd?: number;
  readonly sessionTempRoot: string;
}

export function preferredBubblewrapLauncher(
  options: PreferredBubblewrapLauncherOptions = {},
): BubblewrapLauncher | null {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const program = findSystemBubblewrapInPath(
    options.searchPath ?? env["PATH"],
    cwd,
    options.trustedDirectories,
  );
  if (program === null) return null;
  if (
    options.requireNamespaces === true &&
    !probeSystemBubblewrapNamespaces(program, env, cwd).ok
  ) {
    return null;
  }
  const probe = options.probeArgv0 ?? systemBubblewrapSupportsArgv0;
  return {
    program,
    supportsArgv0: probe(program),
    supportsBindFd: systemBubblewrapSupportsBindFd(program),
  };
}

/**
 * Exercise the namespace set required by the outer sandbox stage. `--help`
 * alone is not sufficient: AppArmor and container policy can allow discovery
 * while denying namespace creation at launch time.
 */
export function probeSystemBubblewrapNamespaces(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): BubblewrapNamespaceProbeResult {
  const result = spawnSync(
    program,
    [
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--ro-bind",
      "/",
      "/",
      "--",
      "/bin/true",
    ],
    {
      cwd,
      env: sanitizeSandboxLauncherEnvironment(env),
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: BUBBLEWRAP_NAMESPACE_PROBE_MAX_OUTPUT_BYTES,
      timeout: BUBBLEWRAP_NAMESPACE_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (result.error === undefined && result.status === 0) {
    return { ok: true, diagnostic: "" };
  }
  return {
    ok: false,
    diagnostic:
      result.error?.message ??
      result.stderr ??
      `exit status ${String(result.status)}`,
  };
}

function systemBubblewrapSupportsArgv0(program: string): boolean {
  return systemBubblewrapHelp(program)?.includes("--argv0") ?? false;
}

export function systemBubblewrapSupportsBindFd(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return systemBubblewrapHelp(program, env)?.includes("--ro-bind-fd") ?? false;
}

function systemBubblewrapHelp(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const output = spawnSync(program, ["--help"], {
    encoding: "utf8",
    env: sanitizeSandboxLauncherEnvironment(env),
    killSignal: "SIGKILL",
    maxBuffer: BUBBLEWRAP_HELP_PROBE_MAX_OUTPUT_BYTES,
    timeout: BUBBLEWRAP_HELP_PROBE_TIMEOUT_MS,
  });
  if (output.error !== undefined || output.status !== 0) return null;
  return `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
}

export function spawnBubblewrap(
  launcher: BubblewrapLauncher,
  args: readonly string[],
  options: SpawnBubblewrapOptions,
): { readonly child: ChildProcess; readonly cleanup: () => void } {
  const {
    inheritedCwdFd,
    seccompMode,
    sessionTempRoot,
    ...spawnOptions
  } = options;
  const seccompFile =
    seccompMode === undefined || seccompMode === null
      ? null
      : openNetworkSeccompProgramFile(seccompMode, sessionTempRoot);
  const stdio = stdioWithBoundaryFds(
    spawnOptions.stdio,
    seccompFile,
    inheritedCwdFd,
  );
  const child = spawn(launcher.program, args, {
    ...spawnOptions,
    stdio,
  });
  return {
    child,
    cleanup() {
      seccompFile?.cleanup();
    },
  };
}

export function findSystemBubblewrapInPath(
  searchPath?: string,
  cwd: string = process.cwd(),
  trustedDirectories: readonly string[] = TRUSTED_BWRAP_DIRECTORIES,
): string | null {
  // A supplied `undefined` is an authoritative missing session PATH (for
  // example, after decoding a daemon protocol tombstone). Only a caller that
  // omits the search-path argument entirely opts into this process's PATH.
  const effectiveSearchPath = arguments.length === 0
    ? process.env["PATH"]
    : searchPath;
  if (!effectiveSearchPath) return null;
  const cwdReal = realpathOrSelf(cwd);
  const trusted = trustedDirectories.map((directory) => realpathOrSelf(directory));
  for (const segment of effectiveSearchPath.split(path.delimiter)) {
    if (!segment) continue;
    for (const program of [DEFAULT_BWRAP_PROGRAM, FALLBACK_BWRAP_PROGRAM]) {
      const candidate = path.join(segment, program);
      if (!isExecutableFile(candidate)) continue;
      const real = realpathOrSelf(candidate);
      if (real === cwdReal || real.startsWith(cwdReal + path.sep)) continue;
      if (!trusted.some((directory) => path.dirname(real) === directory)) continue;
      return real;
    }
  }
  return null;
}

const TRUSTED_BWRAP_DIRECTORIES = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/usr/sbin",
  "/sbin",
];

function stdioWithBoundaryFds(
  stdio: SpawnOptions["stdio"],
  seccompFile: SeccompProgramFile | null,
  inheritedCwdFd: number | undefined,
): SpawnOptions["stdio"] {
  if (seccompFile === null && inheritedCwdFd === undefined) return stdio;
  const base: unknown[] = Array.isArray(stdio)
    ? [...stdio]
    : stdio === undefined || stdio === "inherit"
      ? ["inherit", "inherit", "inherit"]
      : stdio === "pipe"
        ? ["pipe", "pipe", "pipe"]
        : [stdio, stdio, stdio];
  const highestFd = inheritedCwdFd === undefined
    ? SECCOMP_STDIN_FD
    : INHERITED_CWD_FD;
  while (base.length <= highestFd) {
    base.push("ignore");
  }
  if (seccompFile !== null) base[SECCOMP_STDIN_FD] = seccompFile.fd;
  if (inheritedCwdFd !== undefined) {
    base[INHERITED_CWD_FD] = inheritedCwdFd;
  }
  return base as StdioOptions;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function realpathOrSelf(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

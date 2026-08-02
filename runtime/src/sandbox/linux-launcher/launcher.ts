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

export interface BubblewrapLauncher {
  readonly program: string;
  readonly supportsArgv0: boolean;
  readonly supportsBindFd?: boolean;
}

export interface SpawnBubblewrapOptions extends SpawnOptions {
  readonly seccompMode?: NetworkSeccompMode | null;
  readonly inheritedCwdFd?: number;
}

export function preferredBubblewrapLauncher(options: {
  readonly searchPath?: string;
  readonly cwd?: string;
  readonly trustedDirectories?: readonly string[];
  readonly probeArgv0?: (program: string) => boolean;
} = {}): BubblewrapLauncher | null {
  const program = findSystemBubblewrapInPath(
    options.searchPath ?? process.env["PATH"],
    options.cwd ?? process.cwd(),
    options.trustedDirectories,
  );
  if (program === null) return null;
  const probe = options.probeArgv0 ?? systemBubblewrapSupportsArgv0;
  return {
    program,
    supportsArgv0: probe(program),
    supportsBindFd: systemBubblewrapSupportsBindFd(program),
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
  options: SpawnBubblewrapOptions = {},
): { readonly child: ChildProcess; readonly cleanup: () => void } {
  const {
    inheritedCwdFd,
    seccompMode,
    ...spawnOptions
  } = options;
  const seccompFile =
    seccompMode === undefined || seccompMode === null
      ? null
      : openNetworkSeccompProgramFile(seccompMode);
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
  searchPath: string | undefined = process.env["PATH"],
  cwd: string = process.cwd(),
  trustedDirectories: readonly string[] = TRUSTED_BWRAP_DIRECTORIES,
): string | null {
  if (!searchPath) return null;
  const cwdReal = realpathOrSelf(cwd);
  const trusted = trustedDirectories.map((directory) => realpathOrSelf(directory));
  for (const segment of searchPath.split(path.delimiter)) {
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

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
  SECCOMP_STDIN_FD,
} from "./config.js";
import {
  openNetworkSeccompProgramFile,
  type NetworkSeccompMode,
  type SeccompProgramFile,
} from "./landlock.js";

export interface BubblewrapLauncher {
  readonly program: string;
  readonly supportsArgv0: boolean;
}

export interface SpawnBubblewrapOptions extends SpawnOptions {
  readonly seccompMode?: NetworkSeccompMode | null;
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
  };
}

function systemBubblewrapSupportsArgv0(program: string): boolean {
  const output = spawnSync(program, ["--help"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (output.error !== undefined) return false;
  return `${output.stdout ?? ""}\n${output.stderr ?? ""}`.includes("--argv0");
}

export function spawnBubblewrap(
  launcher: BubblewrapLauncher,
  args: readonly string[],
  options: SpawnBubblewrapOptions = {},
): { readonly child: ChildProcess; readonly cleanup: () => void } {
  const seccompFile =
    options.seccompMode === undefined || options.seccompMode === null
      ? null
      : openNetworkSeccompProgramFile(options.seccompMode);
  const stdio = seccompFile === null
    ? options.stdio
    : stdioWithSeccompFd(options.stdio, seccompFile);
  const child = spawn(launcher.program, args, {
    ...options,
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

function stdioWithSeccompFd(
  stdio: SpawnOptions["stdio"],
  seccompFile: SeccompProgramFile,
): StdioOptions {
  const base: unknown[] = Array.isArray(stdio)
    ? [...stdio]
    : stdio === undefined || stdio === "inherit"
      ? ["inherit", "inherit", "inherit"]
      : stdio === "pipe"
        ? ["pipe", "pipe", "pipe"]
        : [stdio, stdio, stdio];
  while (base.length <= SECCOMP_STDIN_FD) {
    base.push("ignore");
  }
  base[SECCOMP_STDIN_FD] = seccompFile.fd;
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

/**
 * Updating a Homebrew or npm install from the TUI: run the package manager
 * with no terminal input (so it can fail but never wait for a password),
 * show its output, and find the command that starts the new version.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { HOMEBREW_UPDATE_COMMAND } from "../utils/nativeInstaller/homebrew.js";

export const NPM_UPDATE_COMMAND = "npm install -g @tetsuo-ai/agenc@latest";

export type PackageManagerKind = "Homebrew" | "npm";

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof nodeSpawn>;

export interface PackageManagerRun {
  readonly ok: boolean;
  readonly code: number | null;
  /** The last lines of combined output, terminal controls removed. */
  readonly tail: readonly string[];
}

export function packageManagerCommand(kind: PackageManagerKind): { readonly file: string; readonly args: string[]; readonly display: string } {
  const display = kind === "Homebrew" ? HOMEBREW_UPDATE_COMMAND : NPM_UPDATE_COMMAND;
  const [file, ...args] = display.split(" ");
  return { file: file!, args, display };
}

const OUTPUT_TAIL_LINES = 8;
const OUTPUT_LINE_MAX = 300;

function cleanLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, OUTPUT_LINE_MAX);
}

/** Run a command to completion, keeping the tail of its output. */
export function runCapturing(
  file: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly onLine?: (line: string) => void;
    readonly spawn?: Spawn;
    readonly timeoutMs?: number;
  } = {},
): Promise<PackageManagerRun & { readonly stdout: string }> {
  return new Promise((resolve) => {
    const tail: string[] = [];
    let stdout = "";
    let pending = "";
    let settled = false;
    const push = (chunk: string): void => {
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const raw of lines) {
        const line = cleanLine(raw).trimEnd();
        if (line.length === 0) continue;
        tail.push(line);
        if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
        options.onLine?.(line);
      }
    };
    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (pending.length > 0) push("\n");
      if (error !== undefined) tail.push(cleanLine(error.message));
      resolve({ ok: error === undefined && code === 0, code, tail, stdout });
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = (options.spawn ?? nodeSpawn)(file, [...args], {
        env: options.env ?? process.env,
        // No terminal input: a password prompt fails instead of waiting.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          child.kill("SIGTERM");
          finish(null, new Error(`${file} did not finish in time`));
        }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk;
      push(chunk);
    });
    child.stderr?.on("data", (chunk: string) => push(chunk));
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

/**
 * The environment for the update. `brew upgrade` normally deletes the old
 * keg right away, and AgenC's formula keeps its whole runtime and private
 * Node there. The TUI and the daemon can keep running that version for a
 * while (an update after this turn, or another client still working), so the
 * old keg stays until Homebrew's next cleanup.
 *
 * npm needs nothing: its global package is only the launcher, and runtimes
 * live in version folders under the AgenC home, pruned only when no process
 * uses them and never the current or previous version.
 */
export function packageManagerEnvironment(kind: PackageManagerKind, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return kind === "Homebrew" ? { ...env, HOMEBREW_NO_INSTALL_CLEANUP: "1" } : env;
}

/** Run `brew upgrade ...` or `npm install -g ...`. */
export function runPackageManagerUpdate(
  kind: PackageManagerKind,
  options: { readonly onLine?: (line: string) => void; readonly spawn?: Spawn; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<PackageManagerRun> {
  const { file, args } = packageManagerCommand(kind);
  return runCapturing(file, args, {
    ...options,
    env: packageManagerEnvironment(kind, options.env ?? process.env),
    timeoutMs: 15 * 60 * 1_000,
  });
}

/** `<prefix>/opt/agenc/bin/agenc` for a runtime inside a Homebrew keg. */
export function homebrewExecTarget(runtimePath: string): string | null {
  let path = runtimePath;
  try {
    path = realpathSync(runtimePath);
  } catch {
    // Use the path as given.
  }
  const match = /^(.*)\/Cellar\/agenc\/[^/]+\//.exec(path);
  return match === null ? null : join(match[1]!, "opt", "agenc", "bin", "agenc");
}

/** `$(npm prefix -g)/bin/agenc`, the global launcher npm just replaced. */
export async function npmExecTarget(spawn?: Spawn): Promise<string | null> {
  const run = await runCapturing("npm", ["prefix", "-g"], { ...(spawn === undefined ? {} : { spawn }), timeoutMs: 30_000 });
  const prefix = run.stdout.trim().split(/\r?\n/).pop()?.trim();
  return run.ok && prefix !== undefined && prefix.startsWith("/") ? join(prefix, "bin", "agenc") : null;
}

/**
 * The version `<command> --version` reports, or null. A new npm launcher
 * fetches and verifies its runtime on first use, so this can take minutes.
 */
export async function readInstalledAgenCVersion(command: string, spawn?: Spawn): Promise<string | null> {
  const run = await runCapturing(command, ["--version"], { ...(spawn === undefined ? {} : { spawn }), timeoutMs: 10 * 60 * 1_000 });
  const match = /^agenc\s+([0-9][0-9A-Za-z.+-]*)\s*$/m.exec(run.stdout);
  return run.ok && match !== null ? match[1]! : null;
}

/** Whether this runtime was started by the npm launcher (its parent). */
export async function startedByNpmLauncher(
  parentPid: number = process.ppid,
  spawn?: Spawn,
): Promise<boolean> {
  if (process.platform === "win32" || parentPid <= 1) return false;
  const run = await runCapturing("ps", ["-o", "args=", "-p", String(parentPid)], {
    ...(spawn === undefined ? {} : { spawn }),
    timeoutMs: 5_000,
  });
  // The launcher titles itself on Linux; on macOS its script path shows.
  return run.ok && /(^|\s)agenc-launcher(\s|$)|\/@tetsuo-ai\/agenc\/(bin\/agenc|src\/launcher\.mjs)/.test(run.stdout);
}

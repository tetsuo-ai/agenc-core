import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const repositoryRoot = join(__dirname, "../../..");

/** `bin/agenc.ts` before its first dynamic import: the code that may set a title. */
export const cliBootstrapSource = readFileSync(join(repositoryRoot, "runtime/src/bin/agenc.ts"), "utf8")
  .replace(/^#!.*\n/, "").split("await import(")[0]!;

/** The launcher bin without its static import and its call into the launcher. */
export const launcherBootstrapSource = readFileSync(join(repositoryRoot, "packages/agenc/bin/agenc"), "utf8")
  .replace(/^#!.*\n/, "").replace(/^import .*;\n/m, "")
  .split("process.exitCode =")[0]!;

/** The owner watchdog script exactly as the supervisor passes it to `node -e`. */
export const watchdogScript = readFileSync(join(repositoryRoot, "runtime/src/utils/supervisedProcess.ts"), "utf8")
  .match(/const POSIX_OWNER_WATCHDOG_SCRIPT = String.raw`([\s\S]*?)`;/)![1]!;

/** The watchdog script up to the point where it needs its encoded config. */
export const watchdogBootstrapSource = watchdogScript.split("const encoded =")[0]!;

const idle = "\nprocess.send('ready');\nsetInterval(() => {}, 1000);\n";

export interface IdleNodeChild {
  readonly pid: number;
  stop(): Promise<void>;
}

/**
 * Run `source` in a Node child, then keep it idle until `stop()`. With `file`
 * the child runs as `node <file>` (how the CLI and the launcher start);
 * without it, as `node -e <source>` (how the owner watchdog starts). The
 * child gets exactly `env`, never the test runner's environment.
 */
export async function startIdleNodeChild(options: {
  readonly source: string;
  readonly env: Readonly<Record<string, string>>;
  readonly file?: string;
}): Promise<IdleNodeChild> {
  const code = `${options.source}${idle}`;
  if (options.file !== undefined) {
    mkdirSync(dirname(options.file), { recursive: true });
    writeFileSync(options.file, code, { mode: 0o600 });
  }
  const child = spawn(process.execPath, options.file === undefined ? ["-e", code] : [options.file], {
    env: { ...options.env },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = once(child, "exit");
  const ready = await Promise.race([
    once(child, "message").then(() => true),
    exited.then(() => false),
  ]);
  if (!ready) throw new Error(`idle child exited before it was ready: ${stderr.slice(0, 2_000)}`);
  return {
    pid: child.pid!,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

export interface ProcessListViews {
  /** `ps -ww -o args=` for the pid. */
  readonly psArgs: string;
  /** `ps -o comm=` for the pid (on macOS, the first string ps reads as argv). */
  readonly psComm: string;
  /** The pid's lines from `pgrep -lf` (and `pgrep -af` on Linux). */
  readonly pgrepLines: readonly string[];
}

function pgrepChildren(flags: readonly string[], pattern: string): string {
  // -P scopes pgrep to this test process's own children, so no other
  // process's command line is ever read into a result or an assertion.
  const result = spawnSync("/usr/bin/pgrep", [...flags, "-P", String(process.pid), pattern], { encoding: "utf8" });
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`pgrep ${flags.join(" ")} failed with status ${String(result.status)}`);
  }
  return result.stdout;
}

/** What the platform's process-list readers print for one child of this test. */
export function processListViews(pid: number): ProcessListViews {
  const ps = (format: string) => execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", format], { encoding: "utf8" }).trim();
  const own = (output: string) => output.split("\n").filter((line) => line.startsWith(`${pid} `));
  return {
    psArgs: ps("args="),
    psComm: ps("comm="),
    pgrepLines: [
      ...own(pgrepChildren(["-lf"], ".")),
      ...(process.platform === "linux" ? own(pgrepChildren(["-af"], ".")) : []),
    ],
  };
}

/** True when `pgrep -f <pattern>` selects the child, as `pkill -f` would. */
export function pgrepSelects(pid: number, pattern: string): boolean {
  return pgrepChildren(["-f"], pattern).split(/\s+/).includes(String(pid));
}

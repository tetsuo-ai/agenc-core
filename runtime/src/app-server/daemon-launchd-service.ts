/**
 * macOS user launchd jobs that run `agenc daemon start --foreground`.
 *
 * The installer loads `dev.agenc.daemon` and `brew services` loads
 * `homebrew.mxcl.agenc`, both with KeepAlive. When either job runs this
 * AgenC home's daemon, a start from the CLI or the TUI must go through the
 * job: a detached daemon would hold the singleton while launchd respawns its
 * own copy, which refuses and exits, every few seconds for as long as the
 * detached daemon lives.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export const AGENC_LAUNCHD_DAEMON_LABELS = [
  "dev.agenc.daemon",
  "homebrew.mxcl.agenc",
] as const;

export interface LaunchdCommandResult {
  readonly status: number | null;
  readonly stdout: string;
}

export interface LaunchdDaemonJobDeps {
  readonly uid: number;
  /** The account's home from the user database; launchd gives jobs this HOME. */
  readonly accountHome: string;
  launchctl(args: readonly string[]): LaunchdCommandResult;
  readText(path: string): string | null;
  sameDirectory(left: string, right: string): boolean;
}

export interface LaunchdDaemonJob {
  readonly label: string;
  /** `gui/<uid>/<label>` */
  readonly target: string;
}

const WRAPPER_READ_LIMIT = 16_384;

/**
 * The AgenC home a job's program serves, or undefined when the program is not
 * an AgenC wrapper this module can read.
 */
export function launchdProgramAgenCHome(
  content: string,
  accountHome: string,
): string | undefined {
  // install.sh and the npm/updater wrappers record their home in this line.
  const marker = /^# AgenC wrapper metadata v1: ([A-Za-z0-9_-]+)$/m.exec(content);
  if (marker !== null) {
    try {
      const value: unknown = JSON.parse(
        Buffer.from(marker[1]!, "base64url").toString("utf8"),
      );
      const home = (value as { agencHome?: unknown } | null)?.agencHome;
      return typeof home === "string" && home.length > 0 ? home : undefined;
    } catch {
      return undefined;
    }
  }
  // Wrappers written before the metadata line pinned the home inline.
  const legacy = /^export AGENC_HOME="\$\{AGENC_HOME:-([^}"\n]+)\}"$/m.exec(content);
  if (legacy !== null) return legacy[1];
  // The Homebrew formula's wrapper follows HOME, which launchd sets to the
  // account home for user agents.
  if (/^\s*export AGENC_HOME="\$\{HOME\}\/\.agenc"$/m.test(content)) {
    return join(accountHome, ".agenc");
  }
  return undefined;
}

/** The loaded user launchd job that runs the daemon for `daemonHome`, if any. */
export function findLaunchdDaemonJob(
  daemonHome: string,
  deps: LaunchdDaemonJobDeps,
): LaunchdDaemonJob | null {
  for (const label of AGENC_LAUNCHD_DAEMON_LABELS) {
    const target = `gui/${deps.uid}/${label}`;
    const printed = deps.launchctl(["print", target]);
    if (printed.status !== 0) continue;
    const program = /^\s*program = (.+)$/m.exec(printed.stdout)?.[1]?.trim();
    if (program === undefined || program.length === 0) continue;
    const content = deps.readText(program);
    if (content === null) continue;
    const served = launchdProgramAgenCHome(content, deps.accountHome);
    if (served !== undefined && deps.sameDirectory(served, daemonHome)) {
      return { label, target };
    }
  }
  return null;
}

/**
 * Ask launchd to run the job now. Returns the pid launchd reports for the new
 * or already-running process, or an error message.
 */
export function kickstartLaunchdDaemonJob(
  job: LaunchdDaemonJob,
  deps: Pick<LaunchdDaemonJobDeps, "launchctl">,
): { readonly pid: number } | { readonly error: string } {
  const result = deps.launchctl(["kickstart", "-p", job.target]);
  const pid = Number.parseInt(result.stdout.trim(), 10);
  if (result.status === 0 && Number.isSafeInteger(pid) && pid > 0) return { pid };
  return {
    error: `launchctl kickstart ${job.target} exited ${String(result.status)}`,
  };
}

function sameDirectory(left: string, right: string): boolean {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function readWrapperText(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > WRAPPER_READ_LIMIT ? text.slice(0, WRAPPER_READ_LIMIT) : text;
  } catch {
    return null;
  }
}

/** Real dependencies; launchctl gets a short timeout so a wedged launchd cannot hang a start. */
export function nodeLaunchdDaemonJobDeps(): LaunchdDaemonJobDeps {
  const account = userInfo();
  return {
    uid: account.uid,
    accountHome: account.homedir,
    launchctl: (args) => {
      const result = spawnSync("/bin/launchctl", [...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
      return { status: result.status, stdout: result.stdout ?? "" };
    },
    readText: readWrapperText,
    sameDirectory,
  };
}

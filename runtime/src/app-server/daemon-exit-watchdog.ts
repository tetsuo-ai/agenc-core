import { spawn } from "node:child_process";

export const DAEMON_EXIT_WATCHDOG_MS = 3_000;

// This helper must remain independent of the daemon's libuv pool and its
// workspace. It captures OS identity while the parent waits for "armed".
// Reparenting is permanent: a reused PID is never this child's parent again.
const WATCHDOG_SCRIPT = String.raw`
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const target = Number(process.argv[1]);
const timeout = Number(process.argv[2]);
function startIdentity() {
  if (process.platform === 'linux') {
    const stat = readFileSync('/proc/' + target + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  }
  return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(target)], {
    cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8', timeout: 1000, maxBuffer: 4096,
  }).trim();
}
try {
  if (process.ppid !== target) process.exit(0);
  const identity = startIdentity();
  if (!identity) process.exit(1);
  const parentCheck = setInterval(() => {
    if (process.ppid !== target) process.exit(0);
  }, 100);
  setTimeout(() => {
    clearInterval(parentCheck);
    try {
      if (process.ppid === target && startIdentity() === identity && process.ppid === target) {
        process.kill(target, 'SIGKILL');
      }
    } catch {}
  }, timeout);
  process.stdout.end('armed\n');
} catch { process.exit(1); }
`;

/**
 * Arm only after durable shutdown cleanup and lifecycle-lock release. Node's
 * process.exit() joins libuv workers, so a blocked native syscall can outlive
 * even the exit event. A detached child supplies the final three-second bound.
 * It needs no daemon files, and cannot authorize a signal from a stale sidecar.
 */
export async function armDaemonExitWatchdog(): Promise<void> {
  const forceSelfExit = () => {
    // A failed spawn must not reintroduce the join hang. This runs only at
    // the process exit boundary, after the caller's durable cleanup.
    process.once("exit", () => process.kill(process.pid, "SIGKILL"));
  };
  // Windows keeps its existing exit: the macOS privacy prompt that motivated
  // this guard does not exist there, and a forced kill would change the exit
  // code of every normal stop.
  if (process.platform === "win32") return;
  try {
    const child = spawn(process.execPath, ["-e", WATCHDOG_SCRIPT, String(process.pid), String(DAEMON_EXIT_WATCHDOG_MS)], {
      cwd: "/", detached: true,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Keep an error listener even if startup times out before spawn reports.
    child.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("daemon exit watchdog did not arm")), 2_000);
      let output = "";
      const onData = (data: Buffer) => {
        output += data.toString();
        if (output === "armed\n") finish();
      };
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error("daemon exit watchdog exited before arming"));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout!.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error !== undefined) {
          child.kill("SIGKILL");
          reject(error);
        } else resolve();
      };
      child.stdout!.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    child.stdout!.destroy();
    child.unref();
  } catch {
    forceSelfExit();
  }
}

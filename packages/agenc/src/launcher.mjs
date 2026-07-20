import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_READY_TIMEOUT_MS = 2000;
const DEFAULT_POLL_MS = 25;
const READY_TIMEOUT_ENV = "AGENC_DAEMON_READY_TIMEOUT_MS";
const AUTOSTART_ENV = "AGENC_DAEMON_AUTOSTART";

const requireFromLauncher = createRequire(import.meta.url);

export function shouldAutostartDaemon(env = process.env) {
  const raw = env[AUTOSTART_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return true;
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function resolveReadyTimeoutMs(env = process.env) {
  const raw = env[READY_TIMEOUT_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed <= 0) {
    throw new Error(`${READY_TIMEOUT_ENV} must be a positive integer`);
  }
  return parsed;
}

export function resolveAgenCHome(env = process.env, userHome = homedir()) {
  const configured = env.AGENC_HOME?.trim();
  return configured && configured.length > 0
    ? configured
    : join(userHome, ".agenc");
}

export function resolveDaemonPidPath(env = process.env, userHome = homedir()) {
  return join(resolveAgenCHome(env, userHome), "daemon.pid");
}

export function resolveDaemonCookiePath(env = process.env, userHome = homedir()) {
  return join(resolveAgenCHome(env, userHome), "daemon.cookie");
}

export async function readDaemonPid(pidPath, readText = readFile) {
  try {
    const raw = (await readText(pidPath, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number.parseInt(raw, 10);
    return pid > 0 ? pid : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function isPidRunning(pid, signalPid = process.kill) {
  try {
    signalPid(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function isDaemonCommand(argv) {
  return argv[0] === "daemon";
}

// Dev path: the `file:`-linked @tetsuo-ai/runtime resolves locally. Returns
// null in a published install where runtime is NOT an npm dependency (it's the
// downloaded GitHub-Releases artifact instead).
export function resolveRuntimeBin(requireFn = requireFromLauncher) {
  try {
    const runtimeEntry = requireFn.resolve("@tetsuo-ai/runtime");
    return resolve(dirname(runtimeEntry), "../bin/agenc");
  } catch (error) {
    if (
      error?.code === "MODULE_NOT_FOUND" ||
      error?.code === "ERR_MODULE_NOT_FOUND"
    ) {
      return null;
    }
    throw error;
  }
}

// Resolve the runtime entry for either mode: prefer the dev file:-link, else
// ensure (download + verify + extract) the published per-platform runtime.
export async function resolveRuntimeBinAsync({
  requireFn = requireFromLauncher,
  ensureFn,
} = {}) {
  const dev = resolveRuntimeBin(requireFn);
  if (dev !== null) return dev;
  const ensureRuntime =
    ensureFn ?? (await import("../lib/runtime-manager.mjs")).ensureRuntime;
  return ensureRuntime();
}

export async function spawnNodeScript(
  scriptPath,
  args,
  {
    env = process.env,
    cwd = process.cwd(),
    stdio = "inherit",
    spawnFn = spawn,
  } = {},
) {
  return new Promise((resolveExit, reject) => {
    const child = spawnFn(process.execPath, [scriptPath, ...args], {
      cwd,
      env,
      stdio,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`agenc runtime exited from signal ${signal}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

export async function spawnDaemon(runtimeBin, options = {}) {
  const exitCode = await spawnNodeScript(runtimeBin, ["daemon", "start"], {
    ...options,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (exitCode !== 0) {
    throw new Error(`AgenC daemon start failed with exit code ${exitCode}`);
  }
}

export async function isDaemonReady(
  {
    env = process.env,
    userHome = homedir(),
    readText = readFile,
    signalPid = process.kill,
  } = {},
) {
  const pidPath = resolveDaemonPidPath(env, userHome);
  const cookiePath = resolveDaemonCookiePath(env, userHome);
  const pid = await readDaemonPid(pidPath, readText);
  if (pid === null || !isPidRunning(pid, signalPid)) return false;
  try {
    return (await readText(cookiePath, "utf8")).trim().length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function waitForDaemonReady(options = {}) {
  const timeoutMs = options.timeoutMs ?? resolveReadyTimeoutMs(options.env);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = Date.now();
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));

  while (Date.now() - startedAt < timeoutMs) {
    if (await isDaemonReady(options)) return true;
    await sleep(pollMs);
  }
  return isDaemonReady(options);
}

export async function ensureDaemonForLaunch({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  runtimeBin = resolveRuntimeBin(),
  userHome = homedir(),
  readText = readFile,
  signalPid = process.kill,
  spawnDaemonFn = spawnDaemon,
  waitForReadyFn = waitForDaemonReady,
} = {}) {
  if (isDaemonCommand(argv)) return { status: "skipped-daemon-command" };
  if (!shouldAutostartDaemon(env)) return { status: "disabled" };

  if (
    await waitForReadyFn({
      env,
      userHome,
      readText,
      signalPid,
      timeoutMs: 1,
      pollMs: 1,
      sleep: async () => {},
    })
  ) {
    return { status: "already-running" };
  }

  await spawnDaemonFn(runtimeBin, { env, cwd });
  const ready = await waitForReadyFn({ env, userHome, readText, signalPid });
  if (!ready) {
    throw new Error("AgenC daemon did not become ready before timeout");
  }
  return { status: "started" };
}

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    cwd = process.cwd(),
    runtimeBin,
    userHome = homedir(),
  } = {},
) {
  // Resolve (and, in a published install, download + verify) the runtime before
  // anything tries to spawn it. Sync default is avoided: it returns null when
  // runtime isn't an npm dep, which is the normal published case.
  let resolvedBin = runtimeBin;
  try {
    resolvedBin ??= await resolveRuntimeBinAsync();
  } catch (error) {
    process.stderr.write(
      `agenc: could not obtain runtime: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
  try {
    await ensureDaemonForLaunch({ argv, env, cwd, runtimeBin: resolvedBin, userHome });
  } catch (error) {
    // The launcher is transport, not policy: a daemon that cannot start must
    // not block daemon-independent commands. `agenc update` is the canonical
    // case — a stale binary whose daemon refuses newer on-disk state made the
    // fixing update itself unreachable (bootstrap deadlock, 2026-07-20). The
    // runtime owns the per-command decision and reports the precise failure,
    // including the daemon child's stderr tail, when a command truly needs
    // the daemon.
    process.stderr.write(
      `agenc: daemon autostart failed: ${
        error instanceof Error ? error.message : String(error)
      }\n` +
        "agenc: continuing without the daemon; commands that require it will report the failure\n",
    );
  }
  return spawnNodeScript(resolvedBin, argv, { env, cwd, stdio: "inherit" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

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

export function resolveRuntimeBin(requireFn = requireFromLauncher) {
  const runtimeEntry = requireFn.resolve("@tetsuo-ai/runtime");
  return resolve(dirname(runtimeEntry), "../bin/agenc");
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
    runtimeBin = resolveRuntimeBin(),
    userHome = homedir(),
  } = {},
) {
  try {
    await ensureDaemonForLaunch({ argv, env, cwd, runtimeBin, userHome });
  } catch (error) {
    process.stderr.write(
      `agenc: daemon autostart failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
  return spawnNodeScript(runtimeBin, argv, { env, cwd, stdio: "inherit" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

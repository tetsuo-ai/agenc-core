import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { resolveAgenCHome } from "../lib/home-authority.mjs";

export { resolveAgenCHome } from "../lib/home-authority.mjs";

const DEFAULT_READY_TIMEOUT_MS = 45_000;
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
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed <= 0 || parsed > 2_147_483_647) {
    throw new Error(`${READY_TIMEOUT_ENV} must be a positive integer`);
  }
  return parsed;
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
    const runtimeRoot = realpathSync(resolve(dirname(runtimeEntry), ".."));
    const repositoryRuntimeRoot = realpathSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime"),
    );
    if (runtimeRoot !== repositoryRuntimeRoot) return null;
    return resolve(dirname(runtimeEntry), "../bin/agenc");
  } catch (error) {
    if (
      error?.code === "MODULE_NOT_FOUND" ||
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      error?.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function hostRuntimeLaunch(runtimeBin) {
  return { runtimeBin, nodeBin: process.execPath };
}

function requireRuntimeLaunch(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.runtimeBin !== "string" ||
    typeof value.nodeBin !== "string" ||
    (
      value.nodeLibraryPath !== undefined &&
      typeof value.nodeLibraryPath !== "string"
    )
  ) {
    throw new Error("agenc: runtime manager returned an invalid launch contract");
  }
  return value;
}

// Resolve every path needed to execute the runtime. Development file: links
// intentionally use the current Node process; published artifacts always
// return their embedded Node (and the Linux compatibility-library directory).
export async function resolveRuntimeLaunchAsync({
  requireFn = requireFromLauncher,
  ensureFn,
} = {}) {
  const dev = resolveRuntimeBin(requireFn);
  if (dev !== null) return hostRuntimeLaunch(dev);
  const ensureRuntimeLaunch =
    ensureFn ?? (await import("../lib/runtime-manager.mjs")).ensureRuntimeLaunch;
  return requireRuntimeLaunch(await ensureRuntimeLaunch());
}

// Retained for callers that only need the script path.
export async function resolveRuntimeBinAsync({
  requireFn = requireFromLauncher,
  ensureFn,
} = {}) {
  const dev = resolveRuntimeBin(requireFn);
  if (dev !== null) return dev;
  const ensureRuntime =
    ensureFn ?? (await import("../lib/runtime-manager.mjs")).ensureRuntime;
  const ensured = await ensureRuntime();
  return typeof ensured === "string"
    ? ensured
    : requireRuntimeLaunch(ensured).runtimeBin;
}

export async function spawnNodeScript(
  scriptPath,
  args,
  {
    env = process.env,
    cwd = process.cwd(),
    stdio = "inherit",
    spawnFn = spawn,
    nodeBin = process.execPath,
    nodeLibraryPath,
    signal,
    registerCleanup,
  } = {},
) {
  const childEnv = { ...env };
  const pathKey =
    Object.keys(childEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const nodeDir = dirname(nodeBin);
  childEnv[pathKey] = childEnv[pathKey]
    ? `${nodeDir}${delimiter}${childEnv[pathKey]}`
    : nodeDir;
  if (nodeLibraryPath !== undefined) {
    // The embedded Linux Node requires the artifact's pinned libatomic. Do not
    // search an operator-controlled ambient library path before that exact
    // directory.
    childEnv.LD_LIBRARY_PATH = nodeLibraryPath;
  }
  signal?.throwIfAborted();
  if (signal !== undefined) {
    const child = spawnFn(nodeBin, [scriptPath, ...args], { cwd, env: childEnv, stdio });
    const result = observeStarter(child, signal);
    registerCleanup?.(result.then(() => {}, (error) => {
      if (error instanceof AggregateError) throw error;
    }));
    return result;
  }
  return new Promise((resolveExit, reject) => {
    const child = spawnFn(nodeBin, [scriptPath, ...args], {
      cwd,
      env: childEnv,
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
  const deadline = options.deadline ?? launchDeadline(timeoutMs, options.signal);
  try {
    for (;;) {
      if (await withinLaunchDeadline(deadline, () => isDaemonReady(options))) return true;
      if (options.probeOnly) return false;
      const pause = Math.min(pollMs, deadline.remaining());
      await withinLaunchDeadline(deadline, () => options.sleep
        ? options.sleep(pause)
        : delay(pause, undefined, { signal: deadline.signal }));
    }
  } catch (error) {
    if (options.deadline === undefined && error === deadline.timeoutError) return false;
    throw error;
  } finally {
    if (options.deadline === undefined) deadline.dispose();
  }
}

export async function ensureDaemonForLaunch({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  runtimeBin = resolveRuntimeBin(),
  runtimeNodeBin = process.execPath,
  runtimeNodeLibraryPath,
  userHome = homedir(),
  readText = readFile,
  signalPid = process.kill,
  spawnDaemonFn = spawnDaemon,
  waitForReadyFn = waitForDaemonReady,
  signal,
} = {}) {
  if (isDaemonCommand(argv)) return { status: "skipped-daemon-command" };
  if (!shouldAutostartDaemon(env)) return { status: "disabled" };

  const deadline = launchDeadline(resolveReadyTimeoutMs(env), signal);
  const cleanups = [];
  const probeOptions = { env, userHome, readText, signalPid, deadline, signal: deadline.signal };
  try {
    if (await withinLaunchDeadline(deadline, () => waitForReadyFn({
      ...probeOptions, timeoutMs: deadline.remaining(), probeOnly: true,
    }))) return { status: "already-running" };

    await withinLaunchDeadline(deadline, () => spawnDaemonFn(runtimeBin, {
      env: { ...env, [READY_TIMEOUT_ENV]: String(deadline.remaining()) },
      cwd,
      nodeBin: runtimeNodeBin,
      nodeLibraryPath: runtimeNodeLibraryPath,
      signal: deadline.signal,
      registerCleanup: (cleanup) => {
        cleanup.catch(() => {});
        cleanups.push(cleanup);
      },
    }));
    const ready = await withinLaunchDeadline(deadline, () => waitForReadyFn({
      ...probeOptions, timeoutMs: deadline.remaining(),
    }));
    if (!ready) throw deadline.timeoutError;
    return { status: "started" };
  } catch (error) {
    deadline.abort(error);
    throw error;
  } finally {
    deadline.dispose();
    await Promise.all(cleanups);
  }
}

function launchDeadline(timeoutMs, externalSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Daemon readiness timeout must be positive and no greater than 2147483647");
  }
  const controller = new AbortController();
  const expires = performance.now() + timeoutMs;
  const timeoutError = new Error(`AgenC daemon did not become ready within ${timeoutMs}ms`);
  const abort = (reason) => controller.abort(reason);
  const forwardAbort = () => abort(externalSignal.reason);
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  if (externalSignal?.aborted) forwardAbort();
  const timer = setTimeout(() => abort(timeoutError), timeoutMs);
  return {
    signal: controller.signal,
    timeoutError,
    abort,
    remaining() {
      if (performance.now() >= expires) abort(timeoutError);
      controller.signal.throwIfAborted();
      return Math.max(1, Math.ceil(expires - performance.now()));
    },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

function withinLaunchDeadline(deadline, operation) {
  return new Promise((resolveResult, reject) => {
    const onAbort = () => reject(deadline.signal.reason);
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      deadline.remaining();
      return operation();
    }).then((value) => {
      deadline.remaining();
      resolveResult(value);
    }).catch(reject).finally(() => deadline.signal.removeEventListener("abort", onAbort));
  });
}

function observeStarter(child, signal) {
  return new Promise((resolveExit, reject) => {
    let finished = false;
    let cancelled = false;
    let reason;
    let killTimer;
    let reapTimer;
    const complete = (code, cleanupFailed = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (cleanupFailed) {
        reject(new AggregateError([reason], "Daemon starter did not close within 1000ms of cancellation", { cause: reason }));
      } else if (cancelled) {
        reject(reason);
      } else {
        resolveExit(code ?? 1);
      }
    };
    const kill = (terminationSignal) => {
      try { child.kill(terminationSignal); } catch { return; }
    };
    const cancel = (error) => {
      if (finished || cancelled) return;
      cancelled = true;
      reason = error;
      killTimer = setTimeout(() => kill("SIGKILL"), 100);
      reapTimer = setTimeout(() => complete(null, true), 1_000);
      kill("SIGTERM");
    };
    const onError = (error) => cancel(error);
    const onAbort = () => cancel(signal.reason);
    const onClose = (code, exitSignal) => {
      if (!cancelled && (signal.aborted || exitSignal)) {
        cancelled = true;
        reason = signal.aborted ? signal.reason : new Error(`agenc runtime exited from signal ${exitSignal}`);
      }
      complete(code);
    };
    child.on("error", onError);
    child.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    cwd = process.cwd(),
    runtimeLaunch,
    runtimeBin,
    runtimeNodeBin = process.execPath,
    runtimeNodeLibraryPath,
    userHome = homedir(),
  } = {},
) {
  // Resolve (and, in a published install, download + verify) the runtime before
  // anything tries to spawn it. Sync default is avoided: it returns null when
  // runtime isn't an npm dep, which is the normal published case.
  let resolvedLaunch = runtimeLaunch ??
    (runtimeBin === undefined
      ? undefined
      : {
          runtimeBin,
          nodeBin: runtimeNodeBin,
          ...(runtimeNodeLibraryPath === undefined
            ? {}
            : { nodeLibraryPath: runtimeNodeLibraryPath }),
        });
  try {
    resolvedLaunch ??= await resolveRuntimeLaunchAsync();
    resolvedLaunch = requireRuntimeLaunch(resolvedLaunch);
  } catch (error) {
    process.stderr.write(
      `agenc: could not obtain runtime: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
  try {
    await ensureDaemonForLaunch({
      argv,
      env,
      cwd,
      runtimeBin: resolvedLaunch.runtimeBin,
      runtimeNodeBin: resolvedLaunch.nodeBin,
      runtimeNodeLibraryPath: resolvedLaunch.nodeLibraryPath,
      userHome,
    });
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
  return spawnNodeScript(resolvedLaunch.runtimeBin, argv, {
    env,
    cwd,
    stdio: "inherit",
    nodeBin: resolvedLaunch.nodeBin,
    nodeLibraryPath: resolvedLaunch.nodeLibraryPath,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

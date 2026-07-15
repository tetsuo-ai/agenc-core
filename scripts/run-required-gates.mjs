#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHermeticRunRoot } from "../runtime/tests/helpers/hermetic-env.mjs";

export const REQUIRED_NODE_VERSION = "v25.9.0";
export const REQUIRED_NPM_VERSION = "11.17.0";

export const REQUIRED_GATES = Object.freeze([
  Object.freeze({
    id: "sdk-build",
    label: "SDK build",
    args: Object.freeze(["run", "build", "--workspace=@tetsuo-ai/agenc-sdk"]),
    timeoutMs: 5 * 60_000,
  }),
  Object.freeze({
    id: "sdk-typecheck",
    label: "SDK typecheck",
    args: Object.freeze(["run", "typecheck", "--workspace=@tetsuo-ai/agenc-sdk"]),
    timeoutMs: 5 * 60_000,
  }),
  Object.freeze({
    id: "runtime-typecheck",
    label: "Runtime typecheck",
    args: Object.freeze(["run", "typecheck"]),
    timeoutMs: 5 * 60_000,
  }),
  Object.freeze({
    id: "stable-tests",
    label: "Hermetic stable Vitest suite",
    args: Object.freeze(["test"]),
    timeoutMs: 20 * 60_000,
  }),
  Object.freeze({
    id: "runtime-build",
    label: "Runtime build and declarations",
    args: Object.freeze(["run", "build"]),
    timeoutMs: 10 * 60_000,
  }),
  Object.freeze({
    id: "agent-surface",
    label: "Agent-surface contract",
    args: Object.freeze(["run", "check:agent-surface-contract"]),
    timeoutMs: 20 * 60_000,
  }),
  Object.freeze({
    id: "sbom",
    label: "Deterministic SPDX SBOM check",
    args: Object.freeze(["run", "check:sbom"]),
    timeoutMs: 5 * 60_000,
  }),
  Object.freeze({
    id: "tui-startup",
    label: "PTY/TUI runtime startup smoke",
    args: Object.freeze([
      "run",
      "check:tui-runtime-startup",
      "--workspace=@tetsuo-ai/runtime",
    ]),
    timeoutMs: 10 * 60_000,
  }),
]);

export const REQUIRED_GATES_REPOSITORY_ROOT = realpathSync(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const repositoryRoot = REQUIRED_GATES_REPOSITORY_ROOT;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const COMMAND_TERMINATION_GRACE_MS = 1_000;
let activeCommand = null;
let interruptedSignal = null;
const signalHandlers = new Map();

function fail(message) {
  console.error(`required-gates: ${message}`);
  process.exitCode = 1;
}

function safeGitEnvironment() {
  const executablePath = process.env.PATH;
  if (!executablePath) throw new Error("required gates need an explicit PATH");
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: "/nonexistent",
    LC_ALL: "C.UTF-8",
    PATH: executablePath,
    TZ: "UTC",
  };
}

function git(args) {
  const result = spawnSync(
    "git",
    ["--no-replace-objects", "-C", repositoryRoot, ...args],
    {
      encoding: "utf8",
      env: safeGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function assertExactSource() {
  const head = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(`Git returned an invalid source commit: ${head}`);
  }
  const expected = process.env.AGENC_REQUIRED_GATES_SHA?.trim();
  if (process.env.GITHUB_ACTIONS === "true" && !expected) {
    throw new Error("AGENC_REQUIRED_GATES_SHA is required in GitHub Actions");
  }
  if (expected !== undefined && expected !== "") {
    if (!/^[0-9a-f]{40}$/.test(expected)) {
      throw new Error(`invalid expected source commit: ${expected}`);
    }
    if (head !== expected) {
      throw new Error(`checked-out source ${head} does not match expected SHA ${expected}`);
    }
  }
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error(`required gates need a clean tracked checkout:\n${status}`);
  }
  return head;
}

function assertToolchain() {
  if (process.platform !== "linux") {
    throw new Error(`required hosted gates need Linux, observed ${process.platform}`);
  }
  if (process.version !== REQUIRED_NODE_VERSION) {
    throw new Error(
      `Node ${REQUIRED_NODE_VERSION} is required, observed ${process.version}`,
    );
  }
  const npm = spawnSync(npmCommand, ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: safeGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (npm.error || npm.status !== 0) {
    throw new Error(`could not inspect npm: ${npm.error?.message ?? npm.stderr.trim()}`);
  }
  if (npm.stdout.trim() !== REQUIRED_NPM_VERSION) {
    throw new Error(
      `npm ${REQUIRED_NPM_VERSION} is required, observed ${npm.stdout.trim()}`,
    );
  }
}

export function createGateEnvironment(privateRoot) {
  const executablePath = process.env.PATH;
  if (!executablePath) throw new Error("required gates need an explicit PATH");
  const home = path.join(privateRoot, "home");
  const agencHome = path.join(privateRoot, "agenc-home");
  const temp = path.join(privateRoot, "tmp");
  const npmCache = path.join(privateRoot, "npm-cache");
  const dockerConfig = path.join(home, ".docker");
  for (const directory of [home, agencHome, temp, npmCache, dockerConfig]) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  return {
    AGENC_AUTH_BACKEND: "local",
    AGENC_CONFIG_DIR: agencHome,
    AGENC_HOME: agencHome,
    CI: "1",
    DOCKER_CONFIG: dockerConfig,
    FORCE_COLOR: "0",
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "agenc-ci",
    NO_COLOR: "1",
    PATH: executablePath,
    PWD: repositoryRoot,
    SHELL: "/bin/sh",
    TEMP: temp,
    TERM: "dumb",
    TMP: temp,
    TMPDIR: temp,
    TZ: "UTC",
    USER: "agenc-ci",
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    npm_config_audit: "false",
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
}

export function createRequiredGatesRoot() {
  return createHermeticRunRoot("agenc-required-gates-");
}

export function terminateCommandTree(child, force) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (!force) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The bounded force phase below owns escalation.
      }
      return;
    }
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const taskkill = systemRoot
      ? path.join(systemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const result = spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return;
  } else {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The close/error handlers own final classification.
  }
}

function processGroupHasLiveMembers(groupId) {
  if (process.platform !== "linux") return processExists(groupId);
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      let stat;
      try {
        stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
      } catch {
        continue;
      }
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) continue;
      const [state, , processGroup] = stat.slice(commandEnd + 2).split(" ");
      if (Number(processGroup) === groupId && state !== "Z") return true;
    }
    return false;
  } catch {
    try {
      process.kill(-groupId, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      if (error?.code === "EPERM") return true;
      throw error;
    }
  }
}

async function waitForCommandTreeExit(child, timeoutMs) {
  if (!child.pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupHasLiveMembers(child.pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupHasLiveMembers(child.pid);
}

async function drainCommandTree(child) {
  if (!child.pid || !processGroupHasLiveMembers(child.pid)) return;
  terminateCommandTree(child, false);
  if (await waitForCommandTreeExit(child, COMMAND_TERMINATION_GRACE_MS)) return;
  terminateCommandTree(child, true);
  if (!(await waitForCommandTreeExit(child, COMMAND_TERMINATION_GRACE_MS))) {
    throw new Error(`gate process group ${child.pid} survived SIGKILL`);
  }
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      interruptedSignal ??= signal;
      activeCommand?.requestTermination();
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  signalHandlers.clear();
}

export function runGate(gate, env) {
  return new Promise((resolve) => {
    const child = spawn(npmCommand, gate.args, {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    let settled = false;
    let timedOut = false;
    let forceTimer;
    const command = {
      child,
      requestTermination: () => {
        if (settled) return;
        terminateCommandTree(child, false);
        forceTimer ??= setTimeout(
          () => terminateCommandTree(child, true),
          COMMAND_TERMINATION_GRACE_MS,
        );
      },
    };
    activeCommand = command;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      let treeError = null;
      try {
        await drainCommandTree(child);
      } catch (error) {
        treeError = error;
      }
      if (activeCommand === command) activeCommand = null;
      resolve({ ...result, timedOut, treeError });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      command.requestTermination();
    }, gate.timeoutMs);
    child.once("error", (error) => {
      void finish({ error, status: null, signal: null });
    });
    child.once("close", (status, signal) => {
      void finish({ error: null, status, signal });
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function readLinuxProcessIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("malformed /proc stat record");
  const fields = stat.slice(commandEnd + 2).split(" ");
  const processGroup = Number(fields[2]);
  const session = Number(fields[3]);
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(processGroup) ||
    !Number.isSafeInteger(session) ||
    !/^\d+$/.test(startTime ?? "")
  ) {
    throw new Error("malformed /proc process identity");
  }
  return { processGroup, session, startTime };
}

function sameLinuxProcessIdentity(pid, expected) {
  try {
    const observed = readLinuxProcessIdentity(pid);
    return (
      observed.processGroup === expected.processGroup &&
      observed.session === expected.session &&
      observed.startTime === expected.startTime
    );
  } catch (error) {
    if (!processExists(pid)) return false;
    throw error;
  }
}

export async function stopOwnedDaemon(env) {
  const receiptPath = path.join(env.AGENC_HOME, "daemon-runtime.json");
  if (!existsSync(receiptPath)) return;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(`could not parse the required-gates daemon receipt: ${error.message}`);
  }
  const pid = receipt?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`required-gates daemon receipt has an invalid PID: ${pid}`);
  }
  if (!processExists(pid)) return;
  if (process.platform !== "linux") {
    throw new Error("owned-daemon cleanup is supported only on the required Linux gate host");
  }

  const procRoot = `/proc/${pid}`;
  let commandLine;
  let daemonEnvironment;
  let cwd;
  let executable;
  let identity;
  try {
    commandLine = readFileSync(path.join(procRoot, "cmdline"), "utf8")
      .split("\0")
      .filter(Boolean);
    daemonEnvironment = readFileSync(path.join(procRoot, "environ"), "utf8")
      .split("\0")
      .filter(Boolean);
    cwd = readlinkSync(path.join(procRoot, "cwd"));
    executable = readlinkSync(path.join(procRoot, "exe"));
    identity = readLinuxProcessIdentity(pid);
  } catch (error) {
    if (!processExists(pid)) return;
    throw new Error(`could not prove ownership of daemon PID ${pid}: ${error.message}`);
  }

  const expectedEntrypoint = path.join(repositoryRoot, "runtime", "dist", "bin", "agenc.js");
  const expectedHome = `AGENC_HOME=${env.AGENC_HOME}`;
  const expectedConfig = `AGENC_CONFIG_DIR=${env.AGENC_CONFIG_DIR}`;
  const entrypointIndex = commandLine.indexOf(expectedEntrypoint);
  const owned =
    entrypointIndex > 0 &&
    commandLine.length === entrypointIndex + 4 &&
    commandLine[entrypointIndex + 1] === "daemon" &&
    commandLine[entrypointIndex + 2] === "start" &&
    commandLine[entrypointIndex + 3] === "--foreground" &&
    daemonEnvironment.includes(expectedHome) &&
    daemonEnvironment.includes(expectedConfig) &&
    executable === realpathSync(process.execPath) &&
    identity.processGroup === pid &&
    identity.session === pid &&
    (cwd === repositoryRoot || cwd.startsWith(`${repositoryRoot}${path.sep}`));
  if (!owned) {
    throw new Error(`refusing to stop unowned daemon PID ${pid}`);
  }

  if (!sameLinuxProcessIdentity(pid, identity)) {
    if (!processExists(pid)) return;
    throw new Error(`daemon PID ${pid} changed identity before cleanup`);
  }
  terminateCommandTree({ pid }, false);
  if (await waitForCommandTreeExit({ pid }, 10_000)) return;
  if (processExists(pid) && !sameLinuxProcessIdentity(pid, identity)) {
    throw new Error(`daemon PID ${pid} changed identity before forced cleanup`);
  }
  terminateCommandTree({ pid }, true);
  if (!(await waitForCommandTreeExit({ pid }, 2_000))) {
    throw new Error(`owned daemon process group ${pid} survived SIGKILL`);
  }
}

export async function runGateSequence(gates, env, runner = runGate) {
  for (const gate of gates) {
    if (interruptedSignal !== null) {
      throw new Error(`interrupted by ${interruptedSignal}`);
    }
    const grouped = process.env.GITHUB_ACTIONS === "true";
    if (grouped) console.log(`::group::${gate.label}`);
    try {
      console.log(`required-gates: running ${gate.id}`);
      const result = await runner(gate, env);
      if (result.treeError) {
        throw new Error(`${gate.id} cleanup failed: ${result.treeError.message}`);
      }
      if (result.error) {
        throw new Error(`${gate.id} could not start: ${result.error.message}`);
      }
      if (result.timedOut) {
        throw new Error(`${gate.id} exceeded ${gate.timeoutMs} ms`);
      }
      if (result.status !== 0) {
        throw new Error(
          `${gate.id} failed with ${result.signal ?? `exit ${result.status}`}`,
        );
      }
    } finally {
      if (grouped) console.log("::endgroup::");
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--list-json") {
    console.log(JSON.stringify(REQUIRED_GATES));
    return;
  }
  if (argv.length !== 0) {
    throw new Error(`unknown option: ${argv[0]}`);
  }

  assertToolchain();
  const sourceCommit = assertExactSource();
  const privateRoot = createRequiredGatesRoot();
  const env = createGateEnvironment(privateRoot);
  let runError = null;
  try {
    console.log(`required-gates: source ${sourceCommit}`);
    await runGateSequence(REQUIRED_GATES, env);
    if (interruptedSignal !== null) {
      throw new Error(`interrupted by ${interruptedSignal}`);
    }
    assertExactSource();
  } catch (error) {
    runError = error;
  }

  let cleanupError = null;
  try {
    await stopOwnedDaemon(env);
    rmSync(privateRoot, { force: true, recursive: true });
  } catch (error) {
    cleanupError = error;
  }

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      `${errorMessage(runError)}; cleanup failed: ${errorMessage(cleanupError)} (state preserved at ${privateRoot})`,
    );
  }
  if (runError) throw runError;
  if (cleanupError) {
    throw new Error(
      `required-gates cleanup failed: ${errorMessage(cleanupError)} (state preserved at ${privateRoot})`,
    );
  }
  console.log(`required-gates: all ${REQUIRED_GATES.length} gates passed`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installSignalHandlers();
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    fail(errorMessage(error));
  } finally {
    const signal = interruptedSignal;
    removeSignalHandlers();
    if (signal !== null) process.kill(process.pid, signal);
  }
}

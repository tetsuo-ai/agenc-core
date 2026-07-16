#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeRequiredGateContract,
  REQUIRED_GATES,
  REQUIRED_GATE_REPOSITORY_ROOT,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
} from "./required-gate-contract.mjs";
import { buildSystemdWorkerCommand } from "./systemd-worker-sandbox.mjs";
import { proveDockerDaemonQuiescence } from "./docker-quiescence.mjs";

export {
  REQUIRED_GATES,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
};

function resolveRepositoryRoot() {
  const configured = process.env.AGENC_REQUIRED_GATES_REPOSITORY_ROOT;
  if (configured === undefined || configured === "") return REQUIRED_GATE_REPOSITORY_ROOT;
  if (!path.isAbsolute(configured) || configured.includes("\0")) {
    throw new Error("required-gates repository root must be an absolute path");
  }
  const resolved = realpathSync(configured);
  if (!lstatSync(resolved).isDirectory()) {
    throw new Error("required-gates repository root must be a directory");
  }
  return resolved;
}

export const REQUIRED_GATES_REPOSITORY_ROOT = resolveRepositoryRoot();
const repositoryRoot = REQUIRED_GATES_REPOSITORY_ROOT;
const trustedPolicyRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const COMMAND_TERMINATION_GRACE_MS = 1_000;
let activeCommand = null;
let interruptedSignal = null;
const signalHandlers = new Map();

export class RequiredGateOutcomeError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequiredGateOutcomeError";
  }
}

function fail(message) {
  console.error(`required-gates: ${message}`);
  process.exitCode = 1;
}

function safeGitEnvironment() {
  const executablePath = process.env.PATH;
  if (!executablePath) throw new Error("required gates need an explicit PATH");
  return {
    AGENC_SKIP_POSTINSTALL: "1",
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

export function assertExactSource(expectedCommit, gitCommand = git) {
  const head = gitCommand(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(`Git returned an invalid source commit: ${head}`);
  }
  const expected = expectedCommit ?? process.env.AGENC_REQUIRED_GATES_SHA?.trim();
  if (expected !== undefined && expected !== "") {
    if (!/^[0-9a-f]{40}$/.test(expected)) {
      throw new Error(`invalid expected source commit: ${expected}`);
    }
    if (head !== expected) {
      throw new Error(`checked-out source ${head} does not match expected SHA ${expected}`);
    }
  }
  const status = gitCommand(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error(`required gates need a clean tracked checkout:\n${status}`);
  }
  return head;
}

function assertToolchain(settings = null) {
  if (process.platform !== "linux") {
    throw new Error(`required gates need Linux, observed ${process.platform}`);
  }
  if (process.version !== REQUIRED_NODE_VERSION) {
    throw new Error(
      `Node ${REQUIRED_NODE_VERSION} is required, observed ${process.version}`,
    );
  }
  const npm = spawnSync(
    settings === null ? npmCommand : settings.nodePath,
    settings === null ? ["--version"] : [settings.npmPath, "--version"],
    {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: safeGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  const temp = path.join(privateRoot, "t");
  const npmCache = path.join(privateRoot, "npm-cache");
  const dockerConfig = path.join(home, ".docker");
  const dockerVisibleRunBase = path.join(privateRoot, "docker-visible");
  for (const directory of [
    home,
    agencHome,
    temp,
    npmCache,
    dockerConfig,
    dockerVisibleRunBase,
  ]) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  return {
    AGENC_AUTH_BACKEND: "local",
    AGENC_CONFIG_DIR: agencHome,
    AGENC_HOME: agencHome,
    AGENC_HERMETIC_RUN_BASE: dockerVisibleRunBase,
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
    npm_config_globalconfig: "/dev/null",
    npm_config_node_options: "",
    npm_config_offline: "true",
    npm_config_script_shell: "/bin/sh",
    npm_config_update_notifier: "false",
    npm_config_userconfig: "/nonexistent/agenc-required-gates-user-npmrc",
  };
}

function requiredDockerHost(value = process.env.AGENC_REQUIRED_GATES_DOCKER_HOST) {
  if (value === undefined || value === "") return undefined;
  if (!/^unix:\/\/\/run\/user\/[1-9][0-9]*\/docker\.sock$/u.test(value)) {
    throw new Error("required gates accept only an explicit rootless Docker user socket");
  }
  return value;
}

export function environmentForGate(baseEnvironment, gate) {
  const environment = { ...baseEnvironment };
  delete environment.DOCKER_HOST;
  if (gate.dockerAccess === true) {
    const dockerHost = requiredDockerHost();
    if (dockerHost !== undefined) environment.DOCKER_HOST = dockerHost;
  }
  return environment;
}

export function createRequiredGatesRoot() {
  const configured = process.env.AGENC_REQUIRED_GATES_RUN_BASE;
  const base = configured === undefined || configured === "" ? "/tmp" : configured;
  if (!path.isAbsolute(base) || base.includes("\0")) {
    throw new Error("required-gates run base must be an absolute path");
  }
  mkdirSync(base, { mode: 0o700, recursive: true });
  const metadata = lstatSync(base);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("required-gates run base must be one real directory");
  }
  return mkdtempSync(path.join(realpathSync(base), "agr-"));
}

const SYSTEMD_WORKER_ENVIRONMENT = Object.freeze([
  "AGENC_REQUIRED_GATES_SYSTEMD_WORKER_UID",
  "AGENC_REQUIRED_GATES_SYSTEMD_WORKER_GID",
  "AGENC_REQUIRED_GATES_NPM_PATH",
  "AGENC_REQUIRED_GATES_PARENT_UNIT",
  "AGENC_REQUIRED_GATES_DOCKER_HOST",
  "AGENC_REQUIRED_GATES_DOCKER_UID",
  "AGENC_REQUIRED_GATES_DOCKER_GID",
  "AGENC_REQUIRED_GATES_WORKER_HOME",
]);

function parsePositiveEnvironmentInteger(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${label} must be a positive decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function assertRootOwnedExecutable(filePath, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = realpathSync(filePath);
  const metadata = lstatSync(resolved);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error(`${label} must be a root-owned executable not writable by group or other`);
  }
  return resolved;
}

function assertRootOwnedRegularFile(filePath, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = realpathSync(filePath);
  const metadata = lstatSync(resolved);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error(`${label} must be a root-owned regular file not writable by group or other`);
  }
  return resolved;
}

export function readSystemdWorkerSettings(environment = process.env) {
  const present = SYSTEMD_WORKER_ENVIRONMENT.filter((name) =>
    environment[name] !== undefined && environment[name] !== ""
  );
  if (present.length === 0) return null;
  if (present.length !== SYSTEMD_WORKER_ENVIRONMENT.length) {
    throw new Error("required-gates systemd worker configuration is incomplete");
  }
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("required-gates systemd worker supervisor must run as root on Linux");
  }
  const parentUnit = environment.AGENC_REQUIRED_GATES_PARENT_UNIT;
  if (!/^agenc-local-gate-dispatcher@(main|pr-[1-9][0-9]{0,9})\.service$/u.test(parentUnit)) {
    throw new Error("required-gates parent dispatcher unit is invalid");
  }
  const uid = parsePositiveEnvironmentInteger(
      environment.AGENC_REQUIRED_GATES_SYSTEMD_WORKER_UID,
      "required-gates worker UID",
    );
  const gid = parsePositiveEnvironmentInteger(
      environment.AGENC_REQUIRED_GATES_SYSTEMD_WORKER_GID,
      "required-gates worker GID",
    );
  const dockerUid = parsePositiveEnvironmentInteger(
    environment.AGENC_REQUIRED_GATES_DOCKER_UID,
    "required-gates Docker UID",
  );
  const dockerGid = parsePositiveEnvironmentInteger(
    environment.AGENC_REQUIRED_GATES_DOCKER_GID,
    "required-gates Docker GID",
  );
  if (uid === dockerUid || gid === dockerGid) {
    throw new Error("required-gates worker and Docker identities must use distinct UIDs and GIDs");
  }
  const workerHome = environment.AGENC_REQUIRED_GATES_WORKER_HOME;
  if (
    typeof workerHome !== "string" ||
    !path.isAbsolute(workerHome) ||
    !/^\/(?:[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*)?$/u.test(workerHome)
  ) {
    throw new Error("required-gates worker home must be a safe absolute path");
  }
  return Object.freeze({
    uid,
    gid,
    dockerUid,
    dockerGid,
    nodePath: assertRootOwnedExecutable(process.execPath, "required-gates Node executable"),
    npmPath: assertRootOwnedExecutable(
      environment.AGENC_REQUIRED_GATES_NPM_PATH,
      "required-gates npm CLI",
    ),
    parentUnit,
    workerHome,
    dockerHost: requiredDockerHost(environment.AGENC_REQUIRED_GATES_DOCKER_HOST),
  });
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function resolveReviewedPath(relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is not a normalized repository-relative path: ${relativePath}`);
  }
  const candidate = path.join(repositoryRoot, ...relativePath.split("/"));
  if (!isWithin(repositoryRoot, candidate)) throw new Error(`${label} escaped the repository`);
  return candidate;
}

function givePrivateTreeToWorker(root, uid, gid) {
  const visit = (candidate) => {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`required-gates private state contains an unsupported entry: ${candidate}`);
    }
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(candidate)) visit(path.join(candidate, entry));
    }
    chownSync(candidate, uid, gid);
    chmodSync(candidate, metadata.isDirectory() ? 0o700 : 0o600);
  };
  visit(root);
}

function resolveArtifactTreeRoot(root) {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) {
    throw new Error(`required-gates artifact contains a symbolic link: ${root}`);
  }
  const resolvedRoot = realpathSync(root);
  if (!isWithin(repositoryRoot, resolvedRoot)) {
    throw new Error(`required-gates artifact escaped the repository: ${root}`);
  }
  return resolvedRoot;
}

export function freezeArtifactTree(root) {
  const resolvedRoot = resolveArtifactTreeRoot(root);
  const visit = (candidate) => {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error(`required-gates artifact contains a symbolic link: ${candidate}`);
    }
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(candidate).sort()) visit(path.join(candidate, entry));
      chownSync(candidate, 0, 0);
      chmodSync(candidate, 0o755);
      return;
    }
    if (!metadata.isFile()) {
      throw new Error(`required-gates artifact contains a special file: ${candidate}`);
    }
    chownSync(candidate, 0, 0);
    chmodSync(candidate, (metadata.mode & 0o111) === 0 ? 0o644 : 0o755);
  };
  visit(resolvedRoot);
}

export function artifactTreeDigest(root) {
  const hash = createHash("sha256");
  const resolvedRoot = resolveArtifactTreeRoot(root);
  const visit = (candidate) => {
    const metadata = lstatSync(candidate);
    const relative = path.relative(resolvedRoot, candidate).split(path.sep).join("/") || ".";
    if (metadata.isSymbolicLink()) {
      throw new Error(`required-gates artifact contains a symbolic link: ${candidate}`);
    }
    if (metadata.isDirectory()) {
      hash.update(`d\0${relative}\0${metadata.mode & 0o777}\0`);
      for (const entry of readdirSync(candidate).sort()) visit(path.join(candidate, entry));
      return;
    }
    if (!metadata.isFile()) throw new Error(`required-gates artifact changed type: ${candidate}`);
    hash.update(`f\0${relative}\0${metadata.mode & 0o777}\0${metadata.size}\0`);
    hash.update(readFileSync(candidate));
    hash.update("\0");
  };
  visit(resolvedRoot);
  return hash.digest("hex");
}

function assertFrozenArtifacts(snapshots) {
  for (const [artifactPath, expected] of snapshots) {
    const observed = artifactTreeDigest(artifactPath);
    if (observed !== expected) {
      throw new Error(`frozen required-gates artifact changed: ${artifactPath}`);
    }
  }
}

function resetMutableDirectory(directory, settings) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(directory);
  if (!isWithin(repositoryRoot, resolved)) {
    throw new Error(`required-gates mutable directory escaped the repository: ${directory}`);
  }
  for (const entry of readdirSync(resolved)) {
    rmSync(path.join(resolved, entry), { recursive: true, force: true });
  }
  chownSync(resolved, settings.uid, settings.gid);
  chmodSync(resolved, 0o700);
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
    const executable = gate.executable === "node" || gate.executable === "trusted-node"
      ? process.execPath
      : npmCommand;
    const child = spawn(executable, gate.args, {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    let settled = false;
    let timedOut = false;
    let forceTimer;
    const commandState = {
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
    activeCommand = commandState;
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
      if (activeCommand === commandState) activeCommand = null;
      resolve({ ...result, timedOut, treeError });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      commandState.requestTermination();
    }, gate.timeoutMs);
    child.once("error", (error) => {
      void finish({ error, status: null, signal: null });
    });
    child.once("close", (status, signal) => {
      void finish({ error: null, status, signal });
    });
  });
}

function parseSystemdProperties(output) {
  const properties = Object.create(null);
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`systemd returned a malformed property: ${line}`);
    const name = line.slice(0, separator);
    if (Object.hasOwn(properties, name)) throw new Error(`systemd repeated property ${name}`);
    properties[name] = line.slice(separator + 1);
  }
  return properties;
}

function inspectSystemdUnit(unitName) {
  const result = spawnSync(
    "/usr/bin/systemctl",
    [
      "show",
      "--no-pager",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=SubState",
      "--property=Result",
      "--property=ExecMainCode",
      "--property=ExecMainStatus",
      "--property=ControlGroup",
      unitName,
    ],
    {
      encoding: "utf8",
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  if (result.status !== 0) {
    if (/not found|could not be found|not loaded/iu.test(result.stderr)) return null;
    throw new Error(`could not inspect ${unitName}: ${result.error?.message ?? result.stderr.trim()}`);
  }
  const properties = parseSystemdProperties(result.stdout);
  return properties.LoadState === "not-found" ? null : properties;
}

function assertSystemdCgroupEmpty(properties, unitName) {
  if (!["inactive", "failed"].includes(properties.ActiveState)) {
    throw new Error(`${unitName} is still ${properties.ActiveState}/${properties.SubState}`);
  }
  const controlGroup = properties.ControlGroup;
  if (controlGroup === "") return;
  if (!/^\/system\.slice\/system-agencgate\.slice\/agenc-local-gate-[a-z0-9-]{1,128}\.service$/u.test(controlGroup)) {
    throw new Error(`${unitName} returned an unsafe cgroup path: ${controlGroup}`);
  }
  const eventsPath = path.join("/sys/fs/cgroup", controlGroup, "cgroup.events");
  if (!existsSync(eventsPath)) return;
  const events = readFileSync(eventsPath, "utf8");
  if (!/^populated 0$/mu.test(events)) {
    throw new Error(`${unitName} still has a populated cgroup`);
  }
}

export function classifySystemdWorkerResult(clientResult, properties) {
  if (clientResult.error) {
    return { error: new Error(`systemd-run could not start: ${clientResult.error.message}`) };
  }
  if (clientResult.status === 0 && clientResult.signal === null) {
    if (
      properties !== null &&
      (properties.Result !== "success" || properties.ExecMainCode !== "1" || properties.ExecMainStatus !== "0")
    ) {
      return { error: new Error("systemd-run reported success with inconsistent unit state") };
    }
    return { error: null, status: 0, signal: null, timedOut: false, treeError: null };
  }
  if (properties === null) {
    return { error: new Error("systemd-run failed without an inspectable transient unit") };
  }
  const mainCode = Number(properties.ExecMainCode);
  const mainStatus = Number(properties.ExecMainStatus);
  if (
    properties.Result === "exit-code" &&
    mainCode === 1 &&
    Number.isSafeInteger(mainStatus) &&
    mainStatus > 0 &&
    mainStatus < 200
  ) {
    return { error: null, status: mainStatus, signal: null, timedOut: false, treeError: null };
  }
  if (properties.Result === "timeout") {
    return { error: null, status: null, signal: "SIGTERM", timedOut: true, treeError: null };
  }
  if (["signal", "core-dump", "oom-kill"].includes(properties.Result)) {
    return {
      error: null,
      status: null,
      signal: properties.Result === "oom-kill" ? "SIGKILL (OOM)" : `signal ${mainStatus}`,
      timedOut: false,
      treeError: null,
    };
  }
  return {
    error: new Error(
      `transient worker failed as infrastructure: result=${properties.Result} code=${properties.ExecMainCode} status=${properties.ExecMainStatus}`,
    ),
  };
}

function resetSystemdUnit(unitName) {
  const result = spawnSync("/usr/bin/systemctl", ["reset-failed", unitName], {
    encoding: "utf8",
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status !== 0 && !/not loaded|not found/iu.test(result.stderr)) {
    throw new Error(`could not release ${unitName}: ${result.error?.message ?? result.stderr.trim()}`);
  }
}

function stopSystemdUnit(unitName) {
  const result = spawnSync("/usr/bin/systemctl", ["stop", unitName], {
    encoding: "utf8",
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45_000,
  });
  if (result.status !== 0 && !/not loaded|not found/iu.test(result.stderr)) {
    throw new Error(`could not stop ${unitName}: ${result.error?.message ?? result.stderr.trim()}`);
  }
}

export function runSystemdGate(gate, env, settings, privateRoot) {
  const command = settings.nodePath;
  let args;
  let gateEnvironment = env;
  if (gate.executable === "trusted-node") {
    const [relativeScript, ...scriptArgs] = gate.args;
    const trustedScript = assertRootOwnedRegularFile(
      path.join(trustedPolicyRoot, ...relativeScript.split("/")),
      `${gate.id} trusted supervisor`,
    );
    args = [trustedScript, ...scriptArgs];
    gateEnvironment = {
      ...env,
      AGENC_TUI_SMOKE_RUNTIME_DIR: path.join(repositoryRoot, "runtime"),
    };
  } else {
    args = gate.executable === "node"
      ? [...gate.args]
      : [settings.npmPath, ...gate.args];
  }
  const writablePaths = gate.writablePaths.map((relativePath) =>
    resolveReviewedPath(relativePath, `${gate.id} writable path`)
  );
  const uid = gate.dockerAccess ? settings.dockerUid : settings.uid;
  const gid = gate.dockerAccess ? settings.dockerGid : settings.gid;
  const invocation = buildSystemdWorkerCommand({
    unitName: `agenc-local-gate-${randomBytes(8).toString("hex")}`,
    parentUnit: settings.parentUnit,
    uid,
    gid,
    cwd: repositoryRoot,
    environment: gateEnvironment,
    command,
    args,
    readWritePaths: [privateRoot, ...writablePaths],
    inaccessiblePaths: [settings.workerHome],
    dockerAccess: gate.dockerAccess,
    ...(gate.dockerAccess
      ? { dockerSocketPath: settings.dockerHost.slice("unix://".length) }
      : {}),
    runtimeMaxSeconds: Math.ceil(gate.timeoutMs / 1000),
  });

  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repositoryRoot,
      detached: true,
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: "inherit",
    });
    let settled = false;
    let forceTimer;
    let stopError = null;
    const commandState = {
      child,
      requestTermination: () => {
        if (settled) return;
        try {
          stopSystemdUnit(invocation.unitName);
        } catch (error) {
          stopError = error;
        }
        terminateCommandTree(child, false);
        forceTimer ??= setTimeout(
          () => terminateCommandTree(child, true),
          COMMAND_TERMINATION_GRACE_MS,
        );
      },
    };
    activeCommand = commandState;
    const timeout = setTimeout(
      commandState.requestTermination,
      gate.timeoutMs + 45_000,
    );
    const finish = (clientResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (activeCommand === commandState) activeCommand = null;
      let properties = null;
      let result;
      try {
        properties = inspectSystemdUnit(invocation.unitName);
        if (properties !== null) assertSystemdCgroupEmpty(properties, invocation.unitName);
        if (stopError !== null) throw stopError;
        result = classifySystemdWorkerResult(clientResult, properties);
      } catch (error) {
        result = { error, status: null, signal: null, timedOut: false, treeError: null };
      }
      try {
        resetSystemdUnit(invocation.unitName);
      } catch (error) {
        result = { error, status: null, signal: null, timedOut: false, treeError: null };
      }
      resolve(result);
    };
    child.once("error", (error) => finish({ error, status: null, signal: null }));
    child.once("close", (status, signal) => finish({ error: null, status, signal }));
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
      assertGateResult(gate, result);
    } finally {
      if (grouped) console.log("::endgroup::");
    }
  }
}

function assertGateResult(gate, result) {
  if (result.treeError) {
    throw new Error(`${gate.id} cleanup failed: ${result.treeError.message}`);
  }
  if (result.error) {
    throw new Error(`${gate.id} could not start: ${result.error.message}`);
  }
  if (result.timedOut) {
    throw new RequiredGateOutcomeError(`${gate.id} exceeded ${gate.timeoutMs} ms`);
  }
  if (result.status !== 0) {
    throw new RequiredGateOutcomeError(
      `${gate.id} failed with ${result.signal ?? `exit ${result.status}`}`,
    );
  }
}

function listDockerContainers(settings, label) {
  const dockerPath = assertRootOwnedExecutable("/usr/bin/docker", "required-gates Docker CLI");
  const result = spawnSync(
    dockerPath,
    ["--host", settings.dockerHost, "ps", "--all", "--quiet", "--no-trunc"],
    {
      encoding: "utf8",
      env: {
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
      },
      uid: settings.dockerUid,
      gid: settings.dockerGid,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label}: could not inspect the dedicated rootless Docker daemon: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  const containers = result.stdout.trim() === ""
    ? []
    : result.stdout.trim().split(/\s+/u);
  if (
    containers.length > 256 ||
    containers.some((id) => !/^[0-9a-f]{64}$/u.test(id)) ||
    new Set(containers).size !== containers.length
  ) {
    throw new Error(`${label}: dedicated rootless Docker daemon returned an unsafe inventory`);
  }
  return containers;
}

async function assertDockerDaemonQuiescent(settings, label) {
  await proveDockerDaemonQuiescence({
    listContainers: () => listDockerContainers(settings, label),
  });
}

async function cleanupDockerDaemon(settings, label) {
  const dockerPath = assertRootOwnedExecutable("/usr/bin/docker", "required-gates Docker CLI");
  const stable = await proveDockerDaemonQuiescence({
    listContainers: () => listDockerContainers(settings, label),
    removeContainers: (containers) => {
      const removed = spawnSync(
        dockerPath,
        ["--host", settings.dockerHost, "rm", "--force", ...containers],
        {
          encoding: "utf8",
          env: { HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
          uid: settings.dockerUid,
          gid: settings.dockerGid,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        },
      );
      if (removed.error || removed.status !== 0) {
        throw new Error(
          `${label}: could not remove retained gate containers: ${removed.error?.message ?? removed.stderr.trim()}`,
        );
      }
    },
  });
  if (stable.recoveredIds.length !== 0) {
    throw new Error(
      `${label}: removed ${stable.recoveredIds.length} container(s) retained or materialized after the gate`,
    );
  }
}

async function runAuthoritativeGateSequence(gates, runRoot, settings) {
  const frozenArtifacts = new Map();
  for (const gate of gates) {
    if (interruptedSignal !== null) throw new Error(`interrupted by ${interruptedSignal}`);
    if (!["npm", "node", "trusted-node"].includes(gate.executable)) {
      throw new Error(`required gate ${gate.id} has an unsupported executable`);
    }
    assertFrozenArtifacts(frozenArtifacts);
    const privateRoot = path.join(runRoot, gate.id);
    mkdirSync(privateRoot, { mode: 0o700 });
    const baseEnvironment = createGateEnvironment(privateRoot);
    const identity = settings === null
      ? null
      : gate.dockerAccess
        ? { uid: settings.dockerUid, gid: settings.dockerGid }
        : { uid: settings.uid, gid: settings.gid };
    if (identity !== null) givePrivateTreeToWorker(privateRoot, identity.uid, identity.gid);
    const environment = environmentForGate(baseEnvironment, gate);
    const mutableDirectories = gate.writablePaths
      .filter((relativePath) => relativePath.endsWith("/.vite-temp"))
      .map((relativePath) => resolveReviewedPath(relativePath, `${gate.id} mutable path`));
    if (settings !== null) {
      for (const directory of mutableDirectories) resetMutableDirectory(directory, identity);
    }

    const grouped = process.env.GITHUB_ACTIONS === "true";
    if (grouped) console.log(`::group::${gate.label}`);
    let result;
    let lifecycleError = null;
    try {
      if (settings !== null && gate.dockerAccess) {
        await assertDockerDaemonQuiescent(settings, `${gate.id} preflight`);
      }
      console.log(`required-gates: running ${gate.id}`);
      result = settings === null
        ? await runGate(gate, environment)
        : await runSystemdGate(gate, environment, settings, privateRoot);
    } catch (error) {
      lifecycleError = error;
    }
    try {
      if (settings !== null && gate.dockerAccess) {
        await cleanupDockerDaemon(settings, `${gate.id} cleanup`);
      }
      await stopOwnedDaemon(environment);
      if (settings !== null) {
        for (const directory of mutableDirectories) resetMutableDirectory(directory, identity);
      }
      rmSync(privateRoot, { recursive: true, force: true });
    } catch (error) {
      lifecycleError = lifecycleError === null
        ? error
        : new AggregateError([lifecycleError, error], `${gate.id} execution and cleanup failed`);
    } finally {
      if (grouped) console.log("::endgroup::");
    }
    if (lifecycleError !== null) throw lifecycleError;
    assertGateResult(gate, result);
    for (const relativePath of gate.freezePaths) {
      const artifactPath = resolveReviewedPath(relativePath, `${gate.id} frozen path`);
      freezeArtifactTree(artifactPath);
      frozenArtifacts.set(artifactPath, artifactTreeDigest(artifactPath));
    }
    assertFrozenArtifacts(frozenArtifacts);
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
  if (argv.length === 1 && argv[0] === "--contract-json") {
    console.log(JSON.stringify(computeRequiredGateContract()));
    return;
  }
  if (argv.length !== 0) {
    throw new Error(`unknown option: ${argv[0]}`);
  }

  const systemdSettings = readSystemdWorkerSettings();
  assertToolchain(systemdSettings);
  const sourceCommit = assertExactSource();
  const runRoot = createRequiredGatesRoot();
  if (systemdSettings !== null) chmodSync(runRoot, 0o711);
  let runError = null;
  try {
    console.log(`required-gates: source ${sourceCommit}`);
    await runAuthoritativeGateSequence(REQUIRED_GATES, runRoot, systemdSettings);
    if (interruptedSignal !== null) {
      throw new Error(`interrupted by ${interruptedSignal}`);
    }
    assertExactSource(sourceCommit);
  } catch (error) {
    runError = error;
  }

  let cleanupError = null;
  try {
    rmSync(runRoot, { force: true, recursive: true });
  } catch (error) {
    cleanupError = error;
  }

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      `${errorMessage(runError)}; cleanup failed: ${errorMessage(cleanupError)} (state preserved at ${runRoot})`,
    );
  }
  if (runError) throw runError;
  if (cleanupError) {
    throw new Error(
      `required-gates cleanup failed: ${errorMessage(cleanupError)} (state preserved at ${runRoot})`,
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
    process.exitCode = error instanceof RequiredGateOutcomeError ? 10 : 20;
  } finally {
    const signal = interruptedSignal;
    removeSignalHandlers();
    if (signal !== null) process.kill(process.pid, signal);
  }
}

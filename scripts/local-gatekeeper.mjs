#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chownSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  lchownSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { availableParallelism, totalmem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  createGateReceipt,
  mintInstallationToken,
  publishGateCheck,
  readMainRef,
  readPullRequest,
} from "./local-gate-github-app.mjs";
import { proveDockerDaemonQuiescence } from "./docker-quiescence.mjs";
import {
  computeRequiredGateContract,
  canonicalJson,
  REQUIRED_DOCKER_IMAGE,
  REQUIRED_GATE_CONTEXT,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
} from "./required-gate-contract.mjs";
import {
  buildSystemdJobMountCommand,
  buildSystemdJobUnmountCommand,
  buildSystemdPublisherCommand,
  buildSystemdWorkerCommand,
  assertCgroupAncestorCapacity,
  assertDockerCgroupPlacement,
  assertCgroupResourceProfile,
  JOB_FILESYSTEM_MAX_BYTES,
  JOB_FILESYSTEM_MAX_INODES,
  LOCAL_GATE_AGGREGATE_CGROUP,
  LOCAL_GATE_AGGREGATE_LIMITS,
  LOCAL_GATE_AGGREGATE_SLICE,
  LOCAL_GATE_COMBINED_LIMITS,
  LOCAL_GATE_DOCKER_LIMITS,
} from "./systemd-worker-sandbox.mjs";

const CONFIG_PATH = "/etc/agenc-local-gatekeeper/config.json";
const TRUSTED_GATEKEEPER_PATH =
  "/opt/agenc-local-gatekeeper/repo/scripts/local-gatekeeper.mjs";
const APP_KEY_CREDENTIAL = "github-app-private-key";
const APP_KEY_CIPHERTEXT = "/etc/credstore.encrypted/agenc-local-gatekeeper-app-key";
const TRUSTED_RUNNER_PATH = fileURLToPath(new URL("./run-required-gates.mjs", import.meta.url));
const TRUSTED_CONTRACT_PATH = fileURLToPath(new URL("./required-gate-contract.mjs", import.meta.url));
const TRUSTED_REPOSITORY_ROOT = path.dirname(path.dirname(TRUSTED_RUNNER_PATH));
const MAX_LOG_BYTES = 128 * 1024 * 1024;
const CHECKOUT_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const GATE_TIMEOUT_MS = 110 * 60_000;
const PROCESS_GRACE_MS = 2_000;
const MAX_RETAINED_LOG_BYTES = 1024 * 1024 * 1024;
const MAX_RETAINED_LOGS = 32;
const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60_000;
const TMPFS_MAGIC = 0x01021994n;
const CGROUP2_SUPER_MAGIC = 0x63677270n;
const DOCKER_DATA_ROOT_MIN_BYTES = 16n * 1024n * 1024n * 1024n;
const DOCKER_DATA_ROOT_MAX_BYTES = 32n * 1024n * 1024n * 1024n;
const DOCKER_DATA_ROOT_MIN_FREE_BYTES = 8n * 1024n * 1024n * 1024n;
const DOCKER_DATA_ROOT_MIN_FREE_INODES = 100_000n;
const DOCKER_CANARY_MEMORY_BYTES = 128n * 1024n * 1024n;
const DOCKER_CANARY_PIDS = 32;
const DOCKER_CANARY_CPU_MAX = "25000 100000";
const LOCAL_GATE_MIN_HOST_MEMORY_BYTES = 48 * 1024 * 1024 * 1024;
const LOCAL_GATE_MIN_HOST_CPUS = 16;

export class GatekeeperFailure extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "GatekeeperFailure";
    this.code = code;
  }
}

export class GateOutcomeFailure extends GatekeeperFailure {
  constructor(code, message, options) {
    super(code, message, options);
    this.name = "GateOutcomeFailure";
    this.contract = options?.contract;
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GatekeeperFailure("CONFIG_INVALID", `${label} must be a positive safe integer`);
  }
  return value;
}

function assertAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    !/^\/(?:[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*)?$/u.test(value)
  ) {
    throw new GatekeeperFailure("CONFIG_INVALID", `${label} must be a safe absolute path`);
  }
  return value;
}

function assertRootTrustedPathChain(resolvedPath, label) {
  let candidate = resolvedPath;
  for (;;) {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new GatekeeperFailure(
        "CONFIG_INVALID",
        `${label} has an ancestor that is not root-owned or is group/world-writable: ${candidate}`,
      );
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

function assertExecutable(value, label) {
  const candidate = realpathSync(assertAbsolutePath(value, label));
  const metadata = lstatSync(candidate);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o111) === 0 ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new GatekeeperFailure(
      "CONFIG_INVALID",
      `${label} must be one root-owned executable not writable by group or other`,
    );
  }
  assertRootTrustedPathChain(candidate, label);
  return candidate;
}

function assertRootOwnedFile(filePath, label) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new GatekeeperFailure("CONFIG_INVALID", `${label} must be one regular file`);
  }
  if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new GatekeeperFailure("CONFIG_INVALID", `${label} must be root-owned and not group/world-writable`);
  }
  assertRootTrustedPathChain(filePath, label);
  return metadata;
}

function assertRootOwnedDirectory(directoryPath, label) {
  const resolved = realpathSync(directoryPath);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new GatekeeperFailure("CONFIG_INVALID", `${label} must be one real directory`);
  }
  assertRootTrustedPathChain(resolved, label);
  return resolved;
}

function assertRootOwnedImmutableTree(rootPath, label) {
  const root = realpathSync(rootPath);
  assertRootOwnedDirectory(root, label);
  const pending = [root];
  let entries = 0;
  while (pending.length !== 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      entries += 1;
      if (entries > 20_000) {
        throw new GatekeeperFailure("CONFIG_INVALID", `${label} exceeds 20,000 entries`);
      }
      const candidate = path.join(directory, name);
      const metadata = lstatSync(candidate);
      if (
        metadata.isSymbolicLink() ||
        metadata.uid !== 0 ||
        (metadata.mode & 0o022) !== 0 ||
        (!metadata.isDirectory() && !metadata.isFile())
      ) {
        throw new GatekeeperFailure(
          "CONFIG_INVALID",
          `${label} contains an unsafe entry: ${candidate}`,
        );
      }
      if (metadata.isDirectory()) pending.push(candidate);
    }
  }
  return root;
}

function assertWorkerDirectory(directoryPath, uid, gid, label) {
  const resolved = realpathSync(directoryPath);
  const metadata = lstatSync(resolved);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new GatekeeperFailure(
      "CONFIG_INVALID",
      `${label} must be a private directory owned by the worker account`,
    );
  }
  assertRootTrustedPathChain(path.dirname(resolved), `${label} parent`);
  return resolved;
}

export function assertDedicatedIdentityRecord({
  uid,
  gid,
  observedUid,
  observedGid,
  supplementaryGids,
}, label = "gate identity") {
  if (
    observedUid !== uid ||
    observedGid !== gid ||
    !Array.isArray(supplementaryGids) ||
    supplementaryGids.length !== 1 ||
    supplementaryGids[0] !== gid
  ) {
    throw new GatekeeperFailure(
      "CONFIG_INVALID",
      `${label} must resolve to its configured UID/GID with no supplementary groups`,
    );
  }
}

function assertDedicatedIdentity(uid, gid, label) {
  const idPath = assertExecutable("/usr/bin/id", "identity inspection executable");
  const inspect = (flag) => {
    const result = spawnSync(idPath, [flag, "--", String(uid)], {
      encoding: "utf8",
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
      throw new GatekeeperFailure(
        "CONFIG_INVALID",
        `${label} could not be resolved through the local account database`,
        { cause: result.error },
      );
    }
    return result.stdout.trim();
  };
  const parseOne = (value, field) => {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      throw new GatekeeperFailure("CONFIG_INVALID", `${label} returned an invalid ${field}`);
    }
    return Number(value);
  };
  const groupOutput = inspect("-G");
  const supplementaryGids = groupOutput === ""
    ? []
    : groupOutput.split(/\s+/u).map((value) => parseOne(value, "group list"));
  assertDedicatedIdentityRecord({
    uid,
    gid,
    observedUid: parseOne(inspect("-u"), "UID"),
    observedGid: parseOne(inspect("-g"), "GID"),
    supplementaryGids: [...new Set(supplementaryGids)],
  }, label);
}

export function loadGatekeeperConfig(configPath = CONFIG_PATH) {
  const resolvedPath = realpathSync(configPath);
  assertRootOwnedFile(resolvedPath, "gatekeeper config");
  const raw = readFileSync(resolvedPath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
    throw new GatekeeperFailure("CONFIG_INVALID", "gatekeeper config exceeds 64 KiB");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new GatekeeperFailure("CONFIG_INVALID", "gatekeeper config is not valid JSON", { cause: error });
  }
  const expectedKeys = [
    "approvedContractSha256",
    "dockerDataDevice",
    "dockerDataRoot",
    "dockerGid",
    "dockerHost",
    "dockerUid",
    "executorId",
    "githubAppId",
    "githubClientId",
    "githubInstallationId",
    "logDirectory",
    "nodePath",
    "npmPath",
    "repository",
    "schemaVersion",
    "stateDirectory",
    "workerGid",
    "workerHome",
    "workerUid",
  ];
  const observedKeys = Object.keys(value ?? {}).sort();
  if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
    throw new GatekeeperFailure("CONFIG_INVALID", "gatekeeper config keys do not match schema v1");
  }
  if (value.schemaVersion !== 1) {
    throw new GatekeeperFailure("CONFIG_INVALID", "gatekeeper config schemaVersion must be 1");
  }
  if (value.repository !== "tetsuo-ai/agenc-core") {
    throw new GatekeeperFailure("CONFIG_INVALID", "gatekeeper repository must be tetsuo-ai/agenc-core");
  }
  if (typeof value.approvedContractSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.approvedContractSha256)) {
    throw new GatekeeperFailure("CONFIG_INVALID", "approved contract digest must be lowercase SHA-256");
  }
  if (typeof value.executorId !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/u.test(value.executorId)) {
    throw new GatekeeperFailure("CONFIG_INVALID", "executorId must be a safe 1-64 character identifier");
  }
  if (
    typeof value.dockerHost !== "string" ||
    !/^unix:\/\/\/run\/user\/[1-9][0-9]*\/docker\.sock$/u.test(value.dockerHost)
  ) {
    throw new GatekeeperFailure("CONFIG_INVALID", "dockerHost must name a rootless Docker user socket");
  }
  if (value.nodePath !== "/opt/agenc-local-gatekeeper/node/bin/node") {
    throw new GatekeeperFailure("CONFIG_INVALID", "nodePath must use the reviewed installed Node path");
  }
  if (value.npmPath !== "/opt/agenc-local-gatekeeper/node/bin/npm") {
    throw new GatekeeperFailure("CONFIG_INVALID", "npmPath must use the reviewed installed npm path");
  }
  if (value.stateDirectory !== "/var/lib/agenc-local-gatekeeper") {
    throw new GatekeeperFailure("CONFIG_INVALID", "stateDirectory must match systemd StateDirectory");
  }
  if (value.logDirectory !== "/var/log/agenc-local-gatekeeper") {
    throw new GatekeeperFailure("CONFIG_INVALID", "logDirectory must match systemd LogsDirectory");
  }
  const workerUid = assertPositiveInteger(value.workerUid, "workerUid");
  const workerGid = assertPositiveInteger(value.workerGid, "workerGid");
  const nodePath = assertExecutable(value.nodePath, "nodePath");
  const nodePrefix = assertRootOwnedDirectory(
    path.dirname(path.dirname(nodePath)),
    "Node toolchain prefix",
  );
  const nodeHeaders = assertRootOwnedImmutableTree(
    path.join(nodePrefix, "include", "node"),
    "Node native header tree",
  );
  assertRootOwnedFile(path.join(nodeHeaders, "node.h"), "Node native API header");
  const nativeBuildTools = Object.freeze({
    cc: assertExecutable("/usr/bin/cc", "native C compiler"),
    cxx: assertExecutable("/usr/bin/c++", "native C++ compiler"),
    make: assertExecutable("/usr/bin/make", "native make executable"),
    python: assertExecutable("/usr/bin/python3", "native Python executable"),
  });
  const config = {
    ...value,
    githubAppId: assertPositiveInteger(value.githubAppId, "githubAppId"),
    githubClientId: (() => {
      if (typeof value.githubClientId !== "string" || !/^[A-Za-z0-9._-]{10,128}$/u.test(value.githubClientId)) {
        throw new GatekeeperFailure("CONFIG_INVALID", "githubClientId must be a safe 10-128 character identifier");
      }
      return value.githubClientId;
    })(),
    githubInstallationId: assertPositiveInteger(value.githubInstallationId, "githubInstallationId"),
    dockerUid: assertPositiveInteger(value.dockerUid, "dockerUid"),
    dockerGid: assertPositiveInteger(value.dockerGid, "dockerGid"),
    dockerDataDevice: (() => {
      const device = assertAbsolutePath(value.dockerDataDevice, "dockerDataDevice");
      if (!/^\/dev\/mapper\/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(device)) {
        throw new GatekeeperFailure(
          "CONFIG_INVALID",
          "dockerDataDevice must be one exact reviewed /dev/mapper mapping",
        );
      }
      return device;
    })(),
    dockerDataRoot: (() => {
      const dataRoot = assertAbsolutePath(value.dockerDataRoot, "dockerDataRoot");
      if (dataRoot !== "/var/lib/agenc-gate-docker") {
        throw new GatekeeperFailure(
          "CONFIG_INVALID",
          "dockerDataRoot must be /var/lib/agenc-gate-docker",
        );
      }
      return dataRoot;
    })(),
    workerUid,
    workerGid,
    nodePath,
    nodePrefix,
    nativeBuildTools,
    npmPath: assertExecutable(value.npmPath, "npmPath"),
    stateDirectory: assertRootOwnedDirectory(
      assertAbsolutePath(value.stateDirectory, "stateDirectory"),
      "stateDirectory",
    ),
    logDirectory: assertRootOwnedDirectory(
      assertAbsolutePath(value.logDirectory, "logDirectory"),
      "logDirectory",
    ),
    workerHome: assertWorkerDirectory(
      assertAbsolutePath(value.workerHome, "workerHome"),
      workerUid,
      workerGid,
      "workerHome",
    ),
  };
  const socketUid = Number(/^unix:\/\/\/run\/user\/([1-9][0-9]*)\/docker\.sock$/u.exec(config.dockerHost)?.[1]);
  config.dockerDataRoot = assertWorkerDirectory(
    config.dockerDataRoot,
    config.dockerUid,
    config.dockerGid,
    "rootless Docker data root",
  );
  if (config.dockerUid === config.workerUid) {
    throw new GatekeeperFailure("CONFIG_INVALID", "dockerUid and workerUid must be distinct");
  }
  if (config.dockerGid === config.workerGid) {
    throw new GatekeeperFailure("CONFIG_INVALID", "dockerGid and workerGid must be distinct");
  }
  if (socketUid !== config.dockerUid) {
    throw new GatekeeperFailure("CONFIG_INVALID", "rootless Docker socket UID must equal dockerUid");
  }
  assertDedicatedIdentity(config.workerUid, config.workerGid, "candidate worker account");
  assertDedicatedIdentity(config.dockerUid, config.dockerGid, "rootless Docker account");
  const nodeVersion = runCaptureSync(config.nodePath, ["--version"], { timeoutMs: 10_000 }).stdout.trim();
  if (nodeVersion !== REQUIRED_NODE_VERSION) {
    throw new GatekeeperFailure(
      "CONFIG_INVALID",
      `nodePath returned ${nodeVersion}; expected ${REQUIRED_NODE_VERSION}`,
    );
  }
  const toolchainEnv = {
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: `${path.dirname(config.nodePath)}:/usr/bin:/bin`,
  };
  const npmVersion = runCaptureSync(config.nodePath, [config.npmPath, "--version"], {
    env: toolchainEnv,
    timeoutMs: 10_000,
  }).stdout.trim();
  if (npmVersion !== REQUIRED_NPM_VERSION) {
    throw new GatekeeperFailure(
      "CONFIG_INVALID",
      `npmPath returned ${npmVersion}; expected ${REQUIRED_NPM_VERSION}`,
    );
  }
  return Object.freeze(config);
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function runCaptureSync(command, args, { cwd, env, timeoutMs = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new GatekeeperFailure(
      "PROCESS_FAILED",
      `${command} inspection failed: ${result.error?.message ?? String(result.stderr).slice(0, 500)}`,
    );
  }
  return { stdout: result.stdout, status: result.status };
}

async function waitForClose(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once("close", (code, signal) => finish({ code, signal }));
    child.once("error", (error) => finish({ error }));
  });
}

function appendBoundedLog(logFd, value) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const metadata = fstatSync(logFd);
  if (
    !metadata.isFile() ||
    metadata.size < 0 ||
    metadata.size > MAX_LOG_BYTES ||
    chunk.length > MAX_LOG_BYTES - metadata.size
  ) {
    throw new GatekeeperFailure("LOG_INVALID", `gate log exceeds ${MAX_LOG_BYTES} bytes`);
  }
  writeSync(logFd, chunk);
}

export async function runLogged(command, args, {
  cwd,
  env,
  uid,
  gid,
  timeoutMs,
  logFd,
  label,
  acceptedExitCodes = [0],
}) {
  appendBoundedLog(logFd, `\n[agenc-local-gatekeeper] ${label}\n`);
  const child = spawn(command, args, {
    cwd,
    env,
    uid,
    gid,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logError = null;
  const appendChildOutput = (chunk) => {
    if (logError !== null) return;
    try {
      appendBoundedLog(logFd, chunk);
    } catch (error) {
      logError = error;
      terminateProcessGroup(child, "SIGKILL");
    }
  };
  child.stdout.on("data", appendChildOutput);
  child.stderr.on("data", appendChildOutput);
  let result = await waitForClose(child, timeoutMs);
  if (result === null) {
    terminateProcessGroup(child, "SIGTERM");
    result = await waitForClose(child, PROCESS_GRACE_MS);
    if (result === null) {
      terminateProcessGroup(child, "SIGKILL");
      result = await waitForClose(child, PROCESS_GRACE_MS);
    }
    throw new GatekeeperFailure("PROCESS_TIMEOUT", `${label} exceeded ${timeoutMs} ms`);
  }
  if (logError !== null) throw logError;
  if (result.error) {
    throw new GatekeeperFailure("PROCESS_START_FAILED", `${label} could not start`, { cause: result.error });
  }
  if (!acceptedExitCodes.includes(result.code)) {
    throw new GatekeeperFailure(
      "PROCESS_FAILED",
      `${label} failed with ${result.signal ?? `exit ${result.code}`}`,
    );
  }
  return result;
}

function runCapture(command, args, { cwd, env, uid, gid, timeoutMs = 30_000 } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(command, args, {
    cwd,
    env,
    uid,
    gid,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GatekeeperFailure("PROCESS_TIMEOUT", `${command} inspection timed out`));
    }, timeoutMs);
    const collect = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (bytes > 1024 * 1024) {
        reject(new GatekeeperFailure("PROCESS_FAILED", `${command} inspection exceeded 1 MiB`));
      } else if (code !== 0) {
        reject(new GatekeeperFailure(
          "PROCESS_FAILED",
          `${command} failed with ${signal ?? `exit ${code}`}: ${stderr.slice(0, 500)}`,
        ));
      } else {
        resolve({ stdout, stderr, status: code });
      }
    });
  });
}

const SEALED_SOURCE_GIT_CONFIG = Object.freeze([
  "--no-replace-objects",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
  "-c",
  "safe.bareRepository=explicit",
]);

function sealedSourceGitArguments(workspace, operation) {
  return [
    ...SEALED_SOURCE_GIT_CONFIG,
    // Reset any multi-valued protected setting, then allow only this canonical
    // checkout for the duration of this one unprivileged Git command.
    "-c",
    "safe.directory=",
    "-c",
    `safe.directory=${workspace}`,
    "-C",
    workspace,
    ...operation,
  ];
}

export async function verifyFinalCandidateSourceInWorker({
  config,
  gitPath,
  workspace,
  expectedSourceSha,
  env,
  runBase,
  logFd,
  parentUnit,
  runWorker = runSystemdWorkerCaptured,
}) {
  if (typeof gitPath !== "string" || !path.isAbsolute(gitPath) || gitPath.includes("\0")) {
    throw new TypeError("trusted final Git path must be absolute");
  }
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || workspace.includes("\0")) {
    throw new TypeError("trusted final workspace must be absolute");
  }
  if (!/^[0-9a-f]{40}$/u.test(expectedSourceSha)) {
    throw new TypeError("trusted final source SHA must be one lowercase commit ID");
  }
  if (typeof runWorker !== "function") {
    throw new TypeError("sealed-source Git worker runner must be a function");
  }
  const canonicalWorkspace = realpathSync(workspace);
  if (canonicalWorkspace !== workspace || canonicalWorkspace.includes("\n")) {
    throw new GatekeeperFailure(
      "SOURCE_INVALID",
      "sealed candidate workspace must use its canonical path",
    );
  }
  const workerOptions = {
    config,
    command: gitPath,
    cwd: canonicalWorkspace,
    env,
    runBase,
    readWritePaths: [],
    timeoutMs: CHECKOUT_TIMEOUT_MS,
    logFd,
    networkAccess: false,
    parentUnit,
  };
  const finalHead = (
    await runWorker({
      ...workerOptions,
      args: sealedSourceGitArguments(
        canonicalWorkspace,
        ["rev-parse", "--verify", "HEAD^{commit}"],
      ),
      label: "verify final checked-out head in confined worker",
    })
  ).stdout.trim();
  const finalStatus = (
    await runWorker({
      ...workerOptions,
      args: sealedSourceGitArguments(
        canonicalWorkspace,
        [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignore-submodules=all",
        ],
      ),
      label: "verify final source cleanliness in confined worker",
    })
  ).stdout.trim();
  if (finalHead !== expectedSourceSha || finalStatus !== "") {
    throw new GatekeeperFailure("SOURCE_CHANGED", "candidate source changed during required gates");
  }
  return Object.freeze({ head: finalHead, status: finalStatus });
}

function workerEnvironment(config, runBase) {
  const privateHome = path.join(runBase, "home");
  const npmCache = path.join(runBase, "npm-cache");
  mkdirSync(privateHome, { recursive: true, mode: 0o700 });
  mkdirSync(npmCache, { recursive: true, mode: 0o700 });
  chownSync(privateHome, config.workerUid, config.workerGid);
  chownSync(npmCache, config.workerUid, config.workerGid);
  return {
    AGENC_SKIP_POSTINSTALL: "1",
    AGENC_REQUIRED_GATES_DOCKER_HOST: config.dockerHost,
    AGENC_REQUIRED_GATES_REPOSITORY_ROOT: "",
    AGENC_REQUIRED_GATES_RUN_BASE: runBase,
    CI: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: privateHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "agenc-gate-worker",
    PATH: [...new Set([path.dirname(config.nodePath), path.dirname(config.npmPath), "/usr/bin", "/bin"])].join(":"),
    SHELL: "/bin/sh",
    TZ: "UTC",
    USER: "agenc-gate-worker",
    XDG_CACHE_HOME: path.join(privateHome, ".cache"),
    XDG_CONFIG_HOME: path.join(privateHome, ".config"),
    XDG_DATA_HOME: path.join(privateHome, ".local", "share"),
    XDG_STATE_HOME: path.join(privateHome, ".local", "state"),
    npm_config_audit: "false",
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_globalconfig: "/dev/null",
    npm_config_node_options: "",
    npm_config_script_shell: "/bin/sh",
    npm_config_update_notifier: "false",
    npm_config_userconfig: "/nonexistent/agenc-required-gates-user-npmrc",
  };
}

export function buildOfflineNativeBuildEnvironment(config, environment) {
  if (
    !config ||
    typeof config !== "object" ||
    typeof config.nodePrefix !== "string" ||
    !path.isAbsolute(config.nodePrefix) ||
    !config.nativeBuildTools ||
    typeof config.nativeBuildTools !== "object"
  ) {
    throw new TypeError("offline native build toolchain is invalid");
  }
  for (const name of ["cc", "cxx", "make", "python"]) {
    if (typeof config.nativeBuildTools[name] !== "string" || !path.isAbsolute(config.nativeBuildTools[name])) {
      throw new TypeError(`offline native build ${name} path is invalid`);
    }
  }
  return Object.freeze({
    ...environment,
    CC: config.nativeBuildTools.cc,
    CXX: config.nativeBuildTools.cxx,
    MAKE: config.nativeBuildTools.make,
    npm_config_build_from_source: "true",
    npm_config_nodedir: config.nodePrefix,
    npm_config_offline: "true",
    npm_config_python: config.nativeBuildTools.python,
  });
}

function readCgroupRecord(cgroupPath, name) {
  const value = readFileSync(path.join("/sys/fs/cgroup", cgroupPath, name), "utf8");
  if (Buffer.byteLength(value, "utf8") > 4096 || value.includes("\0")) {
    throw new GatekeeperFailure("CGROUP_INVALID", `cgroup ${name} record is invalid`);
  }
  return value.trim();
}

function readCgroupResourceRecords(cgroupPath) {
  return Object.fromEntries([
    "cpu.max",
    "memory.high",
    "memory.max",
    "memory.swap.max",
    "memory.zswap.max",
    "pids.max",
    "cgroup.subtree_control",
  ].map((name) => [name, readCgroupRecord(cgroupPath, name)]));
}

function parseSystemdShow(output) {
  const records = Object.create(null);
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0 || Object.hasOwn(records, line.slice(0, separator))) {
      throw new GatekeeperFailure("CGROUP_INVALID", "systemd returned invalid unit metadata");
    }
    records[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return records;
}

function assertAggregateCgroupBoundary(parentUnit) {
  if (statfsSync("/sys/fs/cgroup", { bigint: true }).type !== CGROUP2_SUPER_MAGIC) {
    throw new GatekeeperFailure("CGROUP_INVALID", "local gates require the unified cgroup v2 hierarchy");
  }
  const inspected = runCaptureSync("/usr/bin/systemctl", [
    "show",
    "--no-pager",
    "--property=Slice",
    "--property=ControlGroup",
    parentUnit,
  ], {
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
    timeoutMs: 10_000,
  });
  const records = parseSystemdShow(inspected.stdout);
  const expectedControlGroup = `${LOCAL_GATE_AGGREGATE_CGROUP}/${parentUnit}`;
  if (
    records.Slice !== LOCAL_GATE_AGGREGATE_SLICE ||
    records.ControlGroup !== expectedControlGroup
  ) {
    throw new GatekeeperFailure(
      "CGROUP_INVALID",
      "dispatcher is outside the reviewed aggregate local-gate slice",
    );
  }
  try {
    assertCgroupResourceProfile(
      readCgroupResourceRecords(LOCAL_GATE_AGGREGATE_CGROUP),
      LOCAL_GATE_AGGREGATE_LIMITS,
    );
    assertCgroupAncestorCapacity(
      readCgroupResourceRecords("/system.slice"),
      LOCAL_GATE_AGGREGATE_LIMITS,
    );
    assertCgroupAncestorCapacity(
      readCgroupResourceRecords("/"),
      LOCAL_GATE_COMBINED_LIMITS,
    );
    if (
      totalmem() < LOCAL_GATE_MIN_HOST_MEMORY_BYTES ||
      availableParallelism() < LOCAL_GATE_MIN_HOST_CPUS
    ) {
      throw new Error("dedicated local-gate host has less than 48 GiB RAM or 16 CPUs");
    }
  } catch (error) {
    throw new GatekeeperFailure(
      "CGROUP_INVALID",
      "kernel cgroup records do not match the reviewed aggregate limits",
      { cause: error },
    );
  }
}

function inspectSystemdProperties(args) {
  const systemctl = assertExecutable("/usr/bin/systemctl", "systemd inspection executable");
  return parseSystemdShow(runCaptureSync(systemctl, args, {
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
    timeoutMs: 10_000,
  }).stdout);
}

function assertDockerCgroupBoundary(config) {
  const userSlice = `/user.slice/user-${config.dockerUid}.slice`;
  try {
    assertCgroupResourceProfile(
      readCgroupResourceRecords(userSlice),
      LOCAL_GATE_DOCKER_LIMITS,
    );
    assertCgroupAncestorCapacity(
      readCgroupResourceRecords("/user.slice"),
      LOCAL_GATE_DOCKER_LIMITS,
    );
    assertCgroupAncestorCapacity(
      readCgroupResourceRecords("/"),
      LOCAL_GATE_COMBINED_LIMITS,
    );
    const userManager = inspectSystemdProperties([
      "show",
      "--no-pager",
      "--property=ActiveState",
      "--property=ControlGroup",
      "--property=Delegate",
      "--property=DelegateControllers",
      `user@${config.dockerUid}.service`,
    ]);
    const dockerService = inspectSystemdProperties([
      "--user",
      `--machine=${config.dockerUid}@.host`,
      "show",
      "--no-pager",
      "--property=ActiveState",
      "--property=ControlGroup",
      "--property=MainPID",
      "docker.service",
    ]);
    assertDockerCgroupPlacement({
      dockerUid: config.dockerUid,
      userManager,
      dockerService,
    });
  } catch (error) {
    throw new GatekeeperFailure(
      "CGROUP_INVALID",
      "rootless Docker is outside its reviewed aggregate user-slice limits",
      { cause: error },
    );
  }
}

export function findDockerCanaryCgroupPath(cgroupRoot, dockerUid, containerId) {
  assertAbsolutePath(cgroupRoot, "cgroup root");
  if (!Number.isSafeInteger(dockerUid) || dockerUid <= 0) {
    throw new TypeError("Docker cgroup UID is invalid");
  }
  if (typeof containerId !== "string" || !/^[0-9a-f]{64}$/u.test(containerId)) {
    throw new TypeError("Docker canary container ID is invalid");
  }
  const root = realpathSync(cgroupRoot);
  const userSlice = realpathSync(path.join(root, "user.slice", `user-${dockerUid}.slice`));
  if (userSlice !== path.join(root, "user.slice", `user-${dockerUid}.slice`)) {
    throw new GatekeeperFailure("CGROUP_INVALID", "Docker user slice resolves outside cgroup root");
  }
  const expectedName = `docker-${containerId}.scope`;
  const pending = [{ directory: userSlice, depth: 0 }];
  const matches = [];
  let visited = 0;
  while (pending.length !== 0) {
    const { directory, depth } = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > 50_000) {
        throw new GatekeeperFailure("CGROUP_INVALID", "Docker user slice cgroup inventory is too large");
      }
      if (entry.isSymbolicLink()) {
        throw new GatekeeperFailure("CGROUP_INVALID", "Docker user slice cgroup inventory contains a symlink");
      }
      if (!entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.name === expectedName) matches.push(candidate);
      if (depth < 16) pending.push({ directory: candidate, depth: depth + 1 });
    }
  }
  if (matches.length > 1) {
    throw new GatekeeperFailure("CGROUP_INVALID", "Docker canary has more than one systemd scope");
  }
  return matches[0] ?? null;
}

export function assertDockerCanaryCgroupRecords(records) {
  if (
    !records ||
    typeof records !== "object" ||
    Array.isArray(records) ||
    records["cpu.max"] !== DOCKER_CANARY_CPU_MAX ||
    records["memory.max"] !== String(DOCKER_CANARY_MEMORY_BYTES) ||
    records["memory.swap.max"] !== "0" ||
    records["pids.max"] !== String(DOCKER_CANARY_PIDS)
  ) {
    throw new GatekeeperFailure(
      "CGROUP_INVALID",
      "Docker canary scope does not enforce its reviewed CPU, memory, swap, and PID limits",
    );
  }
  const processes = String(records["cgroup.procs"] ?? "").trim().split(/\s+/u);
  if (
    processes.length === 0 ||
    processes.length > DOCKER_CANARY_PIDS ||
    processes.some((pid) => !/^[1-9][0-9]*$/u.test(pid)) ||
    new Set(processes).size !== processes.length
  ) {
    throw new GatekeeperFailure("CGROUP_INVALID", "Docker canary scope process inventory is invalid");
  }
}

function readDockerCanaryCgroupRecords(scopePath) {
  return Object.fromEntries([
    "cpu.max",
    "memory.max",
    "memory.swap.max",
    "pids.max",
    "cgroup.procs",
  ].map((name) => {
    const value = readFileSync(path.join(scopePath, name), "utf8");
    if (Buffer.byteLength(value, "utf8") > 4096 || value.includes("\0")) {
      throw new GatekeeperFailure("CGROUP_INVALID", `Docker canary ${name} record is invalid`);
    }
    return [name, value.trim()];
  }));
}

async function waitForDockerCanaryScope(config, containerId, expectedPresent) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const scopePath = findDockerCanaryCgroupPath(
      "/sys/fs/cgroup",
      config.dockerUid,
      containerId,
    );
    if ((scopePath !== null) === expectedPresent) return scopePath;
    await delay(50);
  }
  throw new GatekeeperFailure(
    "CGROUP_INVALID",
    `Docker canary systemd scope did not become ${expectedPresent ? "visible" : "absent"}`,
  );
}

async function runSystemdWorkerLogged({
  config,
  command,
  args,
  cwd,
  env,
  runBase,
  readWritePaths,
  timeoutMs,
  logFd,
  label,
  acceptedExitCodes,
  dockerAccess = false,
  networkAccess = false,
  parentUnit,
}) {
  const invocation = buildSystemdWorkerCommand({
    unitName: `agenc-local-gate-worker-${randomBytes(8).toString("hex")}`,
    parentUnit,
    uid: config.workerUid,
    gid: config.workerGid,
    cwd,
    environment: env,
    command,
    args,
    readWritePaths: [runBase, ...readWritePaths],
    inaccessiblePaths: [config.workerHome],
    dockerAccess,
    networkAccess,
    collect: true,
    runtimeMaxSeconds: Math.ceil(timeoutMs / 1000),
  });
  try {
    return await runLogged(invocation.command, invocation.args, {
      cwd: config.stateDirectory,
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
      },
      timeoutMs: timeoutMs + 60_000,
      logFd,
      label,
      acceptedExitCodes,
    });
  } catch (error) {
    const stopped = spawnSync("/usr/bin/systemctl", ["stop", invocation.unitName], {
      encoding: "utf8",
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
    });
    if (stopped.status !== 0 && !/not loaded|not found/iu.test(stopped.stderr)) {
      throw new AggregateError(
        [error, new Error(stopped.stderr.trim())],
        `${label} failed and ${invocation.unitName} could not be stopped`,
      );
    }
    throw error;
  }
}

async function runSystemdWorkerCaptured({
  config,
  command,
  args,
  cwd,
  env,
  runBase,
  readWritePaths,
  timeoutMs,
  logFd,
  label,
  networkAccess = false,
  parentUnit,
}) {
  const invocation = buildSystemdWorkerCommand({
    unitName: `agenc-local-gate-worker-${randomBytes(8).toString("hex")}`,
    parentUnit,
    uid: config.workerUid,
    gid: config.workerGid,
    cwd,
    environment: env,
    command,
    args,
    readWritePaths: [runBase, ...readWritePaths],
    inaccessiblePaths: [config.workerHome],
    networkAccess,
    collect: true,
    runtimeMaxSeconds: Math.ceil(timeoutMs / 1000),
  });
  appendBoundedLog(logFd, `\n[agenc-local-gatekeeper] ${label}\n`);
  try {
    const result = await runCapture(invocation.command, invocation.args, {
      cwd: config.stateDirectory,
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      timeoutMs: timeoutMs + 60_000,
    });
    if (result.stderr !== "") appendBoundedLog(logFd, result.stderr.slice(0, 64 * 1024));
    return result;
  } catch (error) {
    const stopped = spawnSync("/usr/bin/systemctl", ["stop", invocation.unitName], {
      encoding: "utf8",
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
    });
    if (stopped.status !== 0 && !/not loaded|not found/iu.test(stopped.stderr)) {
      throw new AggregateError(
        [error, new Error(stopped.stderr.trim())],
        `${label} failed and ${invocation.unitName} could not be stopped`,
      );
    }
    throw error;
  }
}

function assertTrustedMirror(candidateRoot, trustedPath, relativePath) {
  const candidatePath = path.join(candidateRoot, ...relativePath.split("/"));
  const trusted = readFileSync(trustedPath);
  const candidate = readFileSync(candidatePath);
  if (!trusted.equals(candidate)) {
    throw new GatekeeperFailure(
      "TRUSTED_POLICY_DRIFT",
      `${relativePath} differs from the root-installed gate policy`,
    );
  }
}

const WORKER_WRITABLE_PATHS = Object.freeze([
  "node_modules",
  "packages/agenc/node_modules",
  "packages/agenc-sdk/dist",
  "packages/agenc-sdk/node_modules",
  "runtime/dist",
  "runtime/node_modules",
]);

function prepareAndSealCandidateSource(repositoryRoot, workerUid, workerGid) {
  const writable = new Set(WORKER_WRITABLE_PATHS);
  for (const relativePath of writable) {
    const target = path.join(repositoryRoot, ...relativePath.split("/"));
    mkdirSync(target, { mode: 0o700, recursive: true });
    const resolved = realpathSync(target);
    if (resolved !== target || !resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new GatekeeperFailure("SOURCE_INVALID", `worker scratch path escaped source: ${relativePath}`);
    }
    chownSync(target, workerUid, workerGid);
    chmodSync(target, 0o700);
  }
  const visit = (candidate) => {
    const relativePath = path.relative(repositoryRoot, candidate).split(path.sep).join("/");
    if (writable.has(relativePath)) return;
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink()) {
      lchownSync(candidate, 0, 0);
      return;
    }
    if (metadata.isDirectory()) {
      chownSync(candidate, 0, 0);
      for (const entry of readdirSync(candidate)) visit(path.join(candidate, entry));
      chmodSync(candidate, 0o755);
      return;
    }
    if (!metadata.isFile()) {
      throw new GatekeeperFailure("SOURCE_INVALID", `candidate source contains a special file: ${relativePath}`);
    }
    chownSync(candidate, 0, 0);
    chmodSync(candidate, (metadata.mode & 0o111) === 0 ? 0o644 : 0o755);
  };
  visit(repositoryRoot);
}

function freezeWorkerTree(root, containmentRoot, mutablePaths = new Set()) {
  const visit = (candidate) => {
    if (mutablePaths.has(candidate)) return;
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink()) {
      const target = realpathSync(candidate);
      if (target !== containmentRoot && !target.startsWith(`${containmentRoot}${path.sep}`)) {
        throw new GatekeeperFailure("DEPENDENCY_INVALID", `dependency symlink escaped source: ${candidate}`);
      }
      lchownSync(candidate, 0, 0);
      return;
    }
    if (metadata.isDirectory()) {
      chownSync(candidate, 0, 0);
      chmodSync(candidate, 0o755);
      for (const entry of readdirSync(candidate)) visit(path.join(candidate, entry));
      return;
    }
    if (!metadata.isFile()) {
      throw new GatekeeperFailure("DEPENDENCY_INVALID", `dependency tree contains a special file: ${candidate}`);
    }
    chownSync(candidate, 0, 0);
    chmodSync(candidate, (metadata.mode & 0o111) === 0 ? 0o644 : 0o755);
  };
  visit(root);
}

export function assertCandidateIndexShape(encodedIndex) {
  const writable = new Set(WORKER_WRITABLE_PATHS);
  for (const record of encodedIndex.split("\0")) {
    if (record === "") continue;
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/u.exec(record);
    if (!match) throw new GatekeeperFailure("SOURCE_INVALID", "Git returned a malformed index record");
    const [, mode, , stage, relativePath] = match;
    if ((mode !== "100644" && mode !== "100755") || stage !== "0") {
      throw new GatekeeperFailure(
        "SOURCE_INVALID",
        `candidate index contains unsupported mode ${mode} or stage ${stage}: ${relativePath}`,
      );
    }
    if (
      path.isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new GatekeeperFailure("SOURCE_INVALID", `candidate index path is unsafe: ${relativePath}`);
    }
    for (const scratchPath of writable) {
      if (relativePath === scratchPath || relativePath.startsWith(`${scratchPath}/`)) {
        throw new GatekeeperFailure(
          "SOURCE_INVALID",
          `tracked source collides with worker scratch path: ${relativePath}`,
        );
      }
    }
  }
}

export function assertApprovedDependencySources(lockfile) {
  if (
    lockfile === null ||
    typeof lockfile !== "object" ||
    Array.isArray(lockfile) ||
    lockfile.lockfileVersion !== 3 ||
    lockfile.packages === null ||
    typeof lockfile.packages !== "object" ||
    Array.isArray(lockfile.packages)
  ) {
    throw new GatekeeperFailure("DEPENDENCY_INVALID", "package-lock.json must use npm lockfile v3");
  }
  const workspaceLinks = new Map([
    ["node_modules/@tetsuo-ai/agenc", "packages/agenc"],
    ["node_modules/@tetsuo-ai/agenc-sdk", "packages/agenc-sdk"],
    ["node_modules/@tetsuo-ai/runtime", "runtime"],
  ]);
  const localPackageRecords = new Map([
    ["", "agenc-core"],
    ["packages/agenc", "@tetsuo-ai/agenc"],
    ["packages/agenc-sdk", "@tetsuo-ai/agenc-sdk"],
    ["runtime", "@tetsuo-ai/runtime"],
  ]);
  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new GatekeeperFailure(
        "DEPENDENCY_INVALID",
        `package-lock entry is invalid: ${packagePath}`,
      );
    }
    if (entry.resolved === undefined) {
      if (
        localPackageRecords.get(packagePath) === entry.name &&
        entry.link !== true &&
        entry.integrity === undefined
      ) {
        continue;
      }
      throw new GatekeeperFailure(
        "DEPENDENCY_INVALID",
        `package-lock entry has no pinned source: ${packagePath}`,
      );
    }
    if (typeof entry.resolved !== "string") {
      throw new GatekeeperFailure(
        "DEPENDENCY_INVALID",
        `package-lock resolved source is invalid: ${packagePath}`,
      );
    }
    if (workspaceLinks.get(packagePath) === entry.resolved && entry.link === true) continue;
    let resolved;
    try {
      resolved = new URL(entry.resolved);
    } catch (error) {
      throw new GatekeeperFailure(
        "DEPENDENCY_INVALID",
        `package-lock source is not an approved registry URL: ${packagePath}`,
        { cause: error },
      );
    }
    const encodedIntegrity = typeof entry.integrity === "string" &&
      entry.integrity.startsWith("sha512-")
      ? entry.integrity.slice("sha512-".length)
      : "";
    const decodedIntegrity = Buffer.from(encodedIntegrity, "base64");
    if (
      resolved.protocol !== "https:" ||
      resolved.hostname !== "registry.npmjs.org" ||
      resolved.port !== "" ||
      resolved.username !== "" ||
      resolved.password !== "" ||
      resolved.search !== "" ||
      resolved.hash !== "" ||
      decodedIntegrity.length !== 64 ||
      decodedIntegrity.toString("base64") !== encodedIntegrity
    ) {
      throw new GatekeeperFailure(
        "DEPENDENCY_INVALID",
        `package-lock source is not one SHA-512-pinned npm registry artifact: ${packagePath}`,
      );
    }
  }
}

function dockerEnvironment() {
  return {
    DOCKER_CONFIG: "/nonexistent",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  };
}

export function parseDockerContainerIds(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 1024 * 1024) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker container inventory is invalid");
  }
  const ids = output.trim() === "" ? [] : output.trim().split(/\s+/u);
  if (
    ids.length > 256 ||
    ids.some((value) => !/^[0-9a-f]{64}$/u.test(value)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "Docker returned an unsafe or unexpectedly large container inventory",
    );
  }
  return Object.freeze(ids);
}

export function parseDockerDataRootMountRecord(mountInfo, mountPath) {
  assertAbsolutePath(mountPath, "rootless Docker data root");
  if (typeof mountInfo !== "string" || Buffer.byteLength(mountInfo, "utf8") > 16 * 1024 * 1024) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker mount inventory is invalid");
  }
  let record = null;
  for (const line of mountInfo.split("\n")) {
    if (line === "") continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 4 || fields[4] !== mountPath) continue;
    if (record !== null) {
      throw new GatekeeperFailure(
        "DOCKER_BOUNDARY_INVALID",
        "Docker data root is mounted more than once",
      );
    }
    record = {
      majorMinor: fields[2],
      root: fields[3],
      mountOptions: fields[5].split(",").filter(Boolean),
      optionalFields: fields.slice(6, separator),
      fsType: fields[separator + 1],
      source: fields[separator + 2],
      superOptions: fields[separator + 3].split(",").filter(Boolean),
    };
  }
  if (record === null) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "Docker data root must be an independent mounted filesystem",
    );
  }
  const options = new Set([...record.mountOptions, ...record.superOptions]);
  if (
    !/^(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)$/u.test(record.majorMinor) ||
    record.root !== "/" ||
    record.optionalFields.length !== 0 ||
    !["ext4", "xfs"].includes(record.fsType) ||
    !/^\/dev\/[A-Za-z0-9._+/:=-]+$/u.test(record.source) ||
    !options.has("rw") ||
    !options.has("nodev") ||
    !options.has("nosuid") ||
    options.has("ro") ||
    options.has("noexec")
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "Docker data root must be one rw,nosuid,nodev executable ext4/xfs device mount",
    );
  }
  return Object.freeze({
    majorMinor: record.majorMinor,
    root: record.root,
    mountOptions: Object.freeze([...record.mountOptions].sort()),
    optionalFields: Object.freeze([...record.optionalFields]),
    fsType: record.fsType,
    source: record.source,
    superOptions: Object.freeze([...record.superOptions].sort()),
  });
}

export function parseDockerSystemDf(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 1024 * 1024) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker disk inventory is invalid");
  }
  const expectedTypes = new Map([
    ["Images", "images"],
    ["Containers", "containers"],
    ["Local Volumes", "volumes"],
    ["Build Cache", "buildCache"],
  ]);
  const inventory = Object.create(null);
  for (const line of output.split("\n")) {
    if (line === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker disk inventory is not JSON", {
        cause: error,
      });
    }
    const key = expectedTypes.get(value?.Type);
    if (
      key === undefined ||
      Object.hasOwn(inventory, key) ||
      !/^(?:0|[1-9][0-9]{0,8})$/u.test(value?.TotalCount) ||
      !/^(?:0|[1-9][0-9]{0,8})$/u.test(value?.Active)
    ) {
      throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker disk inventory shape is invalid");
    }
    inventory[key] = Object.freeze({
      total: Number(value.TotalCount),
      active: Number(value.Active),
    });
  }
  if (Object.keys(inventory).length !== expectedTypes.size) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker disk inventory is incomplete");
  }
  return Object.freeze({
    images: inventory.images,
    containers: inventory.containers,
    volumes: inventory.volumes,
    buildCache: inventory.buildCache,
  });
}

export function parseDockerNetworkInventory(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 1024 * 1024) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker network inventory is invalid");
  }
  const records = [];
  for (const line of output.split("\n")) {
    if (line === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker network inventory is not JSON", {
        cause: error,
      });
    }
    if (
      typeof value?.Name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.Name) ||
      typeof value?.ID !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.ID) ||
      typeof value?.Driver !== "string" ||
      !/^[a-z0-9_-]{1,64}$/u.test(value.Driver) ||
      value.Scope !== "local" ||
      value.Internal !== "false"
    ) {
      throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker network record is invalid");
    }
    records.push(Object.freeze({
      name: value.Name,
      id: value.ID,
      driver: value.Driver,
      scope: value.Scope,
      internal: false,
    }));
  }
  if (
    records.length > 256 ||
    new Set(records.map(({ id }) => id)).size !== records.length ||
    new Set(records.map(({ name }) => name)).size !== records.length
  ) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker network inventory is unsafe");
  }
  return Object.freeze(records.sort((left, right) => left.name.localeCompare(right.name)));
}

function parseDockerImageIds(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 1024 * 1024) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker image inventory is invalid");
  }
  const ids = output.trim() === "" ? [] : output.trim().split(/\s+/u);
  if (
    ids.length > 256 ||
    ids.some((id) => !/^sha256:[0-9a-f]{64}$/u.test(id))
  ) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker image inventory is unsafe");
  }
  return Object.freeze([...new Set(ids)].sort());
}

function parseDockerObjectNames(output, label) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 1024 * 1024) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", `${label} inventory is invalid`);
  }
  const names = output.trim() === "" ? [] : output.trim().split(/\s+/u);
  if (
    names.length > 256 ||
    names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", `${label} inventory is unsafe`);
  }
  return Object.freeze([...names].sort());
}

async function runDedicatedDocker(config, dockerPath, args, timeoutMs = 30_000) {
  const setpriv = assertExecutable("/usr/bin/setpriv", "privilege-drop executable");
  return runCapture(
    setpriv,
    [
      `--reuid=${config.dockerUid}`,
      `--regid=${config.dockerGid}`,
      "--clear-groups",
      "--",
      dockerPath,
      "--host",
      config.dockerHost,
      ...args,
    ],
    {
      env: dockerEnvironment(),
      timeoutMs,
    },
  );
}

async function inspectDockerInfo(config, dockerPath) {
  const inspected = await runDedicatedDocker(config, dockerPath, ["info", "--format", "{{json .}}"]);
  try {
    return JSON.parse(inspected.stdout.trim());
  } catch (error) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker returned invalid security options", {
      cause: error,
    });
  }
}

async function listDedicatedDockerContainers(config, dockerPath) {
  const inspected = await runDedicatedDocker(
    config,
    dockerPath,
    ["ps", "--all", "--quiet", "--no-trunc"],
  );
  return parseDockerContainerIds(inspected.stdout);
}

function assertDockerDataRootFilesystem(config, dockerInfo) {
  const metadata = lstatSync(config.dockerDataRoot);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== config.dockerUid ||
    metadata.gid !== config.dockerGid ||
    (metadata.mode & 0o0777) !== 0o700 ||
    realpathSync(config.dockerDataRoot) !== config.dockerDataRoot ||
    dockerInfo?.DockerRootDir !== config.dockerDataRoot ||
    dockerInfo?.Driver !== "overlay2"
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "rootless Docker must use the exact private bounded overlay2 data root",
    );
  }
  const mountRecord = parseDockerDataRootMountRecord(
    readFileSync("/proc/self/mountinfo", "utf8"),
    config.dockerDataRoot,
  );
  const dataRoot = statSync(config.dockerDataRoot, { bigint: true });
  const rootFilesystem = statSync("/", { bigint: true });
  const major = ((dataRoot.dev & 0x00000000000fff00n) >> 8n) |
    ((dataRoot.dev & 0xfffff00000000000n) >> 32n);
  const minor = (dataRoot.dev & 0x00000000000000ffn) |
    ((dataRoot.dev & 0x00000ffffff00000n) >> 12n);
  if (
    mountRecord.source !== config.dockerDataDevice ||
    mountRecord.majorMinor !== `${major}:${minor}` ||
    dataRoot.dev === rootFilesystem.dev
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "rootless Docker data root must be the exact reviewed mapping, separate from /",
    );
  }
  const usage = statfsSync(config.dockerDataRoot, { bigint: true });
  const capacity = usage.bsize * usage.blocks;
  const freeBytes = usage.bsize * usage.bavail;
  if (
    capacity < DOCKER_DATA_ROOT_MIN_BYTES ||
    capacity > DOCKER_DATA_ROOT_MAX_BYTES ||
    freeBytes < DOCKER_DATA_ROOT_MIN_FREE_BYTES ||
    usage.files <= 0n ||
    usage.files > 10_000_000n ||
    usage.ffree < DOCKER_DATA_ROOT_MIN_FREE_INODES
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "rootless Docker data filesystem must be 16-32 GiB with at least 8 GiB and 100,000 inodes free",
    );
  }
}

async function inspectApprovedDockerImage(config, dockerPath) {
  const response = await runDedicatedDocker(
    config,
    dockerPath,
    ["image", "inspect", REQUIRED_DOCKER_IMAGE],
  );
  let images;
  try {
    images = JSON.parse(response.stdout);
  } catch (error) {
    throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "approved Docker image inspect is invalid", {
      cause: error,
    });
  }
  const at = REQUIRED_DOCKER_IMAGE.indexOf("@");
  const expectedTag = REQUIRED_DOCKER_IMAGE.slice(0, at);
  const expectedRepository = expectedTag.slice(0, expectedTag.lastIndexOf(":"));
  const expectedDigest = REQUIRED_DOCKER_IMAGE.slice(at + 1);
  const expectedArchitecture = new Map([
    ["arm64", "arm64"],
    ["x64", "amd64"],
  ]).get(process.arch);
  const image = Array.isArray(images) && images.length === 1 ? images[0] : null;
  if (
    expectedArchitecture === undefined ||
    !/^sha256:[0-9a-f]{64}$/u.test(image?.Id) ||
    !Array.isArray(image?.RepoDigests) ||
    JSON.stringify(image.RepoDigests) !== JSON.stringify([`${expectedRepository}@${expectedDigest}`]) ||
    !Array.isArray(image?.RepoTags) ||
    JSON.stringify(image.RepoTags) !== JSON.stringify([expectedTag]) ||
    image.Os !== "linux" ||
    image.Architecture !== expectedArchitecture
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "dedicated Docker daemon does not contain the exact approved image digest",
    );
  }
  return image.Id;
}

export function assertDockerInfoBaseline(dockerInfo) {
  if (
    !dockerInfo ||
    typeof dockerInfo !== "object" ||
    Array.isArray(dockerInfo) ||
    !Array.isArray(dockerInfo.SecurityOptions) ||
    !dockerInfo.SecurityOptions.includes("name=rootless") ||
    String(dockerInfo.CgroupVersion) !== "2" ||
    dockerInfo.CgroupDriver !== "systemd" ||
    !Number.isSafeInteger(dockerInfo.Containers) ||
    dockerInfo.Containers < 0 ||
    dockerInfo?.Swarm?.LocalNodeState !== "inactive"
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "Docker must be rootless, cgroup-v2/systemd, and outside swarm mode",
    );
  }
}

export function assertDockerPluginInventoryEmpty(output) {
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output, "utf8") > 1024 * 1024 ||
    output.trim() !== ""
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "dedicated rootless Docker must not have managed plugins installed",
    );
  }
}

async function assertNoDockerPlugins(config, dockerPath) {
  const result = await runDedicatedDocker(
    config,
    dockerPath,
    ["plugin", "ls", "--no-trunc", "--format", "{{json .}}"],
  );
  assertDockerPluginInventoryEmpty(result.stdout);
}

async function listDockerDiskInventory(config, dockerPath) {
  const result = await runDedicatedDocker(
    config,
    dockerPath,
    ["system", "df", "--format", "{{json .}}"],
  );
  return parseDockerSystemDf(result.stdout);
}

async function listDockerNetworks(config, dockerPath) {
  const result = await runDedicatedDocker(
    config,
    dockerPath,
    ["network", "ls", "--no-trunc", "--format", "{{json .}}"],
  );
  return parseDockerNetworkInventory(result.stdout);
}

function customDockerNetworks(networks) {
  const defaults = new Map([
    ["bridge", "bridge"],
    ["host", "host"],
    ["none", "null"],
  ]);
  return networks.filter(({ name, driver }) => defaults.get(name) !== driver);
}

function dockerPersistentStateIsClean(disk, networks, imageIds, approvedImageId) {
  const defaults = new Map([
    ["bridge", "bridge"],
    ["host", "host"],
    ["none", "null"],
  ]);
  return (
    disk.images.total === 1 &&
    disk.images.active === 0 &&
    disk.containers.total === 0 &&
    disk.containers.active === 0 &&
    disk.volumes.total === 0 &&
    disk.volumes.active === 0 &&
    disk.buildCache.total === 0 &&
    disk.buildCache.active === 0 &&
    imageIds.length === 1 &&
    imageIds[0] === approvedImageId &&
    networks.length === defaults.size &&
    networks.every(({ name, driver, internal }) => defaults.get(name) === driver && internal === false)
  );
}

async function dockerPersistentResidueFingerprint(config, dockerPath) {
  const approvedImageId = await inspectApprovedDockerImage(config, dockerPath);
  const [dockerInfo, disk, networks, imageResult] = await Promise.all([
    inspectDockerInfo(config, dockerPath),
    listDockerDiskInventory(config, dockerPath),
    listDockerNetworks(config, dockerPath),
    runDedicatedDocker(config, dockerPath, ["image", "ls", "--all", "--quiet", "--no-trunc"]),
    assertNoDockerPlugins(config, dockerPath),
  ]);
  assertDockerInfoBaseline(dockerInfo);
  const imageIds = parseDockerImageIds(imageResult.stdout);
  if (dockerPersistentStateIsClean(disk, networks, imageIds, approvedImageId)) return [];
  return [
    createHash("sha256")
      .update(canonicalJson({ disk, imageIds, networks }))
      .digest("hex"),
  ];
}

async function cleanDockerPersistentResidue(config, dockerPath) {
  const containers = await listDedicatedDockerContainers(config, dockerPath);
  if (containers.length !== 0) {
    await runDedicatedDocker(
      config,
      dockerPath,
      ["container", "rm", "--force", "--volumes", "--", ...containers],
      60_000,
    );
  }
  const volumeResult = await runDedicatedDocker(config, dockerPath, ["volume", "ls", "--quiet"]);
  const volumes = parseDockerObjectNames(volumeResult.stdout, "Docker volume");
  if (volumes.length !== 0) {
    await runDedicatedDocker(
      config,
      dockerPath,
      ["volume", "rm", "--force", "--", ...volumes],
      60_000,
    );
  }
  await runDedicatedDocker(config, dockerPath, ["volume", "prune", "--all", "--force"], 60_000);
  const networks = customDockerNetworks(await listDockerNetworks(config, dockerPath));
  if (networks.length !== 0) {
    await runDedicatedDocker(
      config,
      dockerPath,
      ["network", "rm", "--", ...networks.map(({ name }) => name)],
      60_000,
    );
  }
  await runDedicatedDocker(config, dockerPath, ["network", "prune", "--force"], 60_000);
  const approvedImageId = await inspectApprovedDockerImage(config, dockerPath);
  const imageResult = await runDedicatedDocker(
    config,
    dockerPath,
    ["image", "ls", "--all", "--quiet", "--no-trunc"],
  );
  const foreignImages = parseDockerImageIds(imageResult.stdout).filter((id) => id !== approvedImageId);
  if (foreignImages.length !== 0) {
    await runDedicatedDocker(
      config,
      dockerPath,
      ["image", "rm", "--force", "--", ...foreignImages],
      120_000,
    );
  }
  await runDedicatedDocker(config, dockerPath, ["builder", "prune", "--all", "--force"], 120_000);
}

async function proveDockerPersistentState(config, dockerPath) {
  return proveDockerDaemonQuiescence({
    listContainers: () => dockerPersistentResidueFingerprint(config, dockerPath),
    removeContainers: () => cleanDockerPersistentResidue(config, dockerPath),
  });
}

export function assertDockerCanaryInspectRecord(record, { containerId, name }) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.Id !== containerId ||
    record.Name !== `/${name}` ||
    record?.State?.Running !== true ||
    record?.Config?.Image !== REQUIRED_DOCKER_IMAGE ||
    record?.Config?.User !== "65534:65534" ||
    record?.HostConfig?.ReadonlyRootfs !== true ||
    record?.HostConfig?.NetworkMode !== "none" ||
    record?.HostConfig?.CgroupnsMode !== "private" ||
    record?.HostConfig?.LogConfig?.Type !== "none" ||
    record?.HostConfig?.Memory !== Number(DOCKER_CANARY_MEMORY_BYTES) ||
    record?.HostConfig?.MemorySwap !== Number(DOCKER_CANARY_MEMORY_BYTES) ||
    record?.HostConfig?.NanoCpus !== 250_000_000 ||
    record?.HostConfig?.PidsLimit !== DOCKER_CANARY_PIDS ||
    record?.HostConfig?.RestartPolicy?.Name !== "no" ||
    JSON.stringify(record?.HostConfig?.CapDrop) !== JSON.stringify(["ALL"]) ||
    !Array.isArray(record?.HostConfig?.SecurityOpt) ||
    !record.HostConfig.SecurityOpt.includes("no-new-privileges=true")
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "Docker cgroup canary does not match its reviewed runtime confinement",
    );
  }
}

async function proveDockerCgroupCanary(config, dockerPath) {
  const name = `agenc-gate-cgroup-${randomBytes(8).toString("hex")}`;
  let containerId;
  let primaryError;
  try {
    const started = await runDedicatedDocker(config, dockerPath, [
      "container",
      "run",
      "--detach",
      `--name=${name}`,
      "--pull=never",
      "--network=none",
      "--log-driver=none",
      "--read-only",
      "--user=65534:65534",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges=true",
      `--pids-limit=${DOCKER_CANARY_PIDS}`,
      "--memory=128m",
      "--memory-swap=128m",
      "--cpus=0.25",
      "--cgroupns=private",
      "--restart=no",
      "--stop-timeout=1",
      "--ulimit=nofile=64:64",
      REQUIRED_DOCKER_IMAGE,
      "node",
      "-e",
      "setInterval(() => {}, 1000)",
    ], 30_000);
    const ids = parseDockerContainerIds(started.stdout);
    if (ids.length !== 1) {
      throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker canary returned an invalid ID");
    }
    [containerId] = ids;
    const inspected = await runDedicatedDocker(
      config,
      dockerPath,
      ["container", "inspect", "--", containerId],
    );
    let records;
    try {
      records = JSON.parse(inspected.stdout);
    } catch (error) {
      throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker canary inspect is invalid", {
        cause: error,
      });
    }
    if (!Array.isArray(records) || records.length !== 1) {
      throw new GatekeeperFailure("DOCKER_BOUNDARY_INVALID", "Docker canary inspect is not singular");
    }
    assertDockerCanaryInspectRecord(records[0], { containerId, name });
    const scopePath = await waitForDockerCanaryScope(config, containerId, true);
    assertDockerCanaryCgroupRecords(readDockerCanaryCgroupRecords(scopePath));
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  if (containerId !== undefined) {
    try {
      await runDedicatedDocker(
        config,
        dockerPath,
        ["container", "rm", "--force", "--volumes", "--", containerId],
        30_000,
      );
      await waitForDockerCanaryScope(config, containerId, false);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined || cleanupError !== undefined) {
    throw new GatekeeperFailure(
      cleanupError === undefined ? "DOCKER_BOUNDARY_INVALID" : "DOCKER_CLEANUP_FAILED",
      "Docker cgroup canary failed or could not be removed cleanly",
      {
        cause: primaryError !== undefined && cleanupError !== undefined
          ? new AggregateError([primaryError, cleanupError])
          : (primaryError ?? cleanupError),
      },
    );
  }
}

export function assertRootlessDockerSocketRecord({ isSocket, uid, gid, mode }, config) {
  if (
    isSocket !== true ||
    uid !== config.dockerUid ||
    gid !== config.dockerGid ||
    !Number.isSafeInteger(mode) ||
    (mode & 0o777) !== 0o600
  ) {
    throw new GatekeeperFailure(
      "DOCKER_BOUNDARY_INVALID",
      "rootless Docker socket must be exact 0600 and owned by the dedicated Docker account",
    );
  }
}

async function assertRootlessDocker(config) {
  assertDockerCgroupBoundary(config);
  const socketPath = config.dockerHost.slice("unix://".length);
  const metadata = lstatSync(socketPath);
  assertRootlessDockerSocketRecord({
    isSocket: metadata.isSocket(),
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode,
  }, config);
  const dockerPath = assertExecutable("/usr/bin/docker", "rootless Docker CLI");
  const dockerInfo = await inspectDockerInfo(config, dockerPath);
  assertDockerInfoBaseline(dockerInfo);
  await assertNoDockerPlugins(config, dockerPath);
  assertDockerDataRootFilesystem(config, dockerInfo);
  let persistent;
  try {
    persistent = await proveDockerPersistentState(config, dockerPath);
  } catch (error) {
    throw new GatekeeperFailure(
      "DOCKER_CLEANUP_FAILED",
      "dedicated rootless Docker persistent state did not reach its approved baseline",
      { cause: error },
    );
  }
  await proveDockerCgroupCanary(config, dockerPath);
  let postCanary;
  try {
    postCanary = await proveDockerPersistentState(config, dockerPath);
  } catch (error) {
    throw new GatekeeperFailure(
      "DOCKER_CLEANUP_FAILED",
      "dedicated rootless Docker state changed after its cgroup canary",
      { cause: error },
    );
  }
  const finalInfo = await inspectDockerInfo(config, dockerPath);
  assertDockerInfoBaseline(finalInfo);
  await assertNoDockerPlugins(config, dockerPath);
  if (finalInfo.Containers !== 0) {
    throw new GatekeeperFailure(
      "DOCKER_CLEANUP_FAILED",
      "Docker container count changed after its stable-empty proof",
    );
  }
  if (persistent.recoveredIds.length !== 0 || postCanary.recoveredIds.length !== 0) {
    throw new GatekeeperFailure(
      "DOCKER_RECOVERED",
      "removed stale Docker containers or persistent objects; rerun before issuing an attestation",
    );
  }
}

export function parseJobMountRecord(mountInfo, mountPath) {
  assertAbsolutePath(mountPath, "job filesystem mount path");
  if (typeof mountInfo !== "string" || Buffer.byteLength(mountInfo, "utf8") > 16 * 1024 * 1024) {
    throw new GatekeeperFailure("JOB_FILESYSTEM_INVALID", "mount inventory is invalid");
  }
  let record = null;
  for (const line of mountInfo.split("\n")) {
    if (line === "") continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 4 || fields[4] !== mountPath) continue;
    if (record !== null) {
      throw new GatekeeperFailure("JOB_FILESYSTEM_INVALID", "job filesystem is mounted more than once");
    }
    record = Object.freeze({
      mountOptions: Object.freeze(fields[5].split(",").filter(Boolean).sort()),
      fsType: fields[separator + 1],
      source: fields[separator + 2],
      superOptions: Object.freeze(fields[separator + 3].split(",").filter(Boolean).sort()),
    });
  }
  return record;
}

function readJobMountRecord(mountPath) {
  return parseJobMountRecord(readFileSync("/proc/self/mountinfo", "utf8"), mountPath);
}

export function assertJobFilesystemRootMetadata(
  metadata,
  expectedUid = process.getuid?.() ?? 0,
  expectedGid = process.getgid?.() ?? 0,
) {
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    typeof metadata.isDirectory !== "function" ||
    typeof metadata.isSymbolicLink !== "function" ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== expectedUid ||
    metadata.gid !== expectedGid ||
    (metadata.mode & 0o777) !== 0o711
  ) {
    throw new GatekeeperFailure(
      "JOB_FILESYSTEM_INVALID",
      "job filesystem root must be one root-owned 0711 directory",
    );
  }
}

function assertMountedJobFilesystem(mountPath, source) {
  assertJobFilesystemRootMetadata(lstatSync(mountPath));
  const record = readJobMountRecord(mountPath);
  const options = new Set([...(record?.mountOptions ?? []), ...(record?.superOptions ?? [])]);
  if (
    record === null ||
    record.fsType !== "tmpfs" ||
    record.source !== source ||
    !options.has("rw") ||
    !options.has("nosuid") ||
    !options.has("nodev") ||
    options.has("noexec")
  ) {
    throw new GatekeeperFailure(
      "JOB_FILESYSTEM_INVALID",
      "job filesystem is not the exact executable nosuid/nodev tmpfs requested by the gatekeeper",
    );
  }
  const usage = statfsSync(mountPath, { bigint: true });
  const capacity = usage.bsize * usage.blocks;
  if (
    usage.type !== TMPFS_MAGIC ||
    capacity <= 0n ||
    capacity > BigInt(JOB_FILESYSTEM_MAX_BYTES) ||
    usage.files <= 0n ||
    usage.files > BigInt(JOB_FILESYSTEM_MAX_INODES)
  ) {
    throw new GatekeeperFailure(
      "JOB_FILESYSTEM_INVALID",
      "job filesystem byte or inode quota does not match the reviewed ceiling",
    );
  }
}

function mountJobFilesystem({ jobId, parentUnit, mountPath }) {
  const metadata = lstatSync(mountPath);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== (process.getuid?.() ?? 0) ||
    (metadata.mode & 0o077) !== 0 ||
    readdirSync(mountPath).length !== 0 ||
    readJobMountRecord(mountPath) !== null
  ) {
    throw new GatekeeperFailure(
      "JOB_FILESYSTEM_INVALID",
      "job filesystem mount point must be one empty private root-owned directory",
    );
  }
  const invocation = buildSystemdJobMountCommand({ jobId, parentUnit, mountPath });
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new GatekeeperFailure(
      "JOB_FILESYSTEM_FAILED",
      `could not mount the bounded job filesystem: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  assertMountedJobFilesystem(mountPath, invocation.source);
}

function unmountJobFilesystem(mountPath) {
  if (readJobMountRecord(mountPath) === null) return;
  const invocation = buildSystemdJobUnmountCommand(mountPath);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45_000,
  });
  if (result.error || result.status !== 0) {
    throw new GatekeeperFailure(
      "JOB_FILESYSTEM_FAILED",
      `could not unmount the bounded job filesystem: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  if (readJobMountRecord(mountPath) !== null) {
    throw new GatekeeperFailure("JOB_FILESYSTEM_FAILED", "job filesystem survived unmount");
  }
}

export async function cleanupStaleJobRoots(stateDirectory, {
  unmount = unmountJobFilesystem,
  readMount = readJobMountRecord,
  assertMounted = assertMountedJobFilesystem,
} = {}) {
  const expectedUid = process.getuid?.() ?? 0;
  for (const name of readdirSync(stateDirectory)) {
    if (name === "ready") continue;
    const match = /^(?:main|pr-[1-9][0-9]{0,9})-job-([0-9a-f]{32})$/u.exec(name);
    const candidate = path.join(stateDirectory, name);
    const metadata = lstatSync(candidate);
    const mounted = readMount(candidate);
    if (
      match === null ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== expectedUid ||
      metadata.gid !== (process.getgid?.() ?? 0) ||
      (metadata.mode & 0o777) !== (mounted === null ? 0o700 : 0o711)
    ) {
      throw new GatekeeperFailure("JOB_FILESYSTEM_INVALID", `unsafe entry in gate state directory: ${name}`);
    }
    if (mounted !== null) {
      assertMounted(candidate, `agenc-local-gate-job-${match[1]}`);
    }
    await unmount(candidate);
    if (readMount(candidate) !== null) {
      throw new GatekeeperFailure("JOB_FILESYSTEM_FAILED", `stale job filesystem survived cleanup: ${name}`);
    }
    rmSync(candidate, { recursive: true, force: true });
  }
}

function sha256File(filePath) {
  const metadata = statSync(filePath);
  if (!metadata.isFile() || metadata.size > MAX_LOG_BYTES) {
    throw new GatekeeperFailure("LOG_INVALID", `gate log exceeds ${MAX_LOG_BYTES} bytes`);
  }
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const GATE_LOG_NAME = /^(?:main|pr-[1-9][0-9]{0,9})-[0-9a-f]{40}-([1-9][0-9]{12,14})-[0-9a-f]{32}\.log$/u;

export function pruneGateLogs(logDirectory, nowMs = Date.now()) {
  if (!Number.isFinite(nowMs) || nowMs <= 0) {
    throw new GatekeeperFailure("LOG_INVALID", "log retention clock is invalid");
  }
  const expectedUid = process.getuid?.() ?? 0;
  const entries = [];
  for (const name of readdirSync(logDirectory)) {
    const match = GATE_LOG_NAME.exec(name);
    const candidate = path.join(logDirectory, name);
    const metadata = lstatSync(candidate);
    if (
      match === null ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.uid !== expectedUid ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_LOG_BYTES
    ) {
      throw new GatekeeperFailure("LOG_INVALID", `unsafe entry in gate log directory: ${name}`);
    }
    const timestamp = Number(match[1]);
    if (!Number.isSafeInteger(timestamp) || timestamp > nowMs + 60_000) {
      throw new GatekeeperFailure("LOG_INVALID", `gate log has an invalid timestamp: ${name}`);
    }
    entries.push({ candidate, name, size: metadata.size, timestamp });
  }
  entries.sort((left, right) => right.timestamp - left.timestamp || right.name.localeCompare(left.name));
  let retainedBytes = 0;
  let retainedCount = 0;
  let removed = 0;
  for (const entry of entries) {
    const expired = nowMs - entry.timestamp > MAX_LOG_AGE_MS;
    const countExceeded = retainedCount >= MAX_RETAINED_LOGS - 1;
    const bytesExceeded = retainedBytes + entry.size > MAX_RETAINED_LOG_BYTES - MAX_LOG_BYTES;
    if (expired || countExceeded || bytesExceeded) {
      unlinkSync(entry.candidate);
      removed += 1;
    } else {
      retainedBytes += entry.size;
      retainedCount += 1;
    }
  }
  if (removed !== 0) {
    const directoryFd = openSync(logDirectory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
  return Object.freeze({ retainedBytes, retainedCount, removed });
}

function persistGateLog(sourcePath, targetPath) {
  const digest = sha256File(sourcePath);
  let copied = false;
  try {
    copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL);
    copied = true;
    chmodSync(targetPath, 0o600);
    const metadata = lstatSync(targetPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.uid !== (process.getuid?.() ?? 0) ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_LOG_BYTES ||
      sha256File(targetPath) !== digest
    ) {
      throw new GatekeeperFailure("LOG_INVALID", "persisted gate log failed exact copy verification");
    }
    const logFd = openSync(targetPath, "r");
    try {
      fsyncSync(logFd);
    } finally {
      closeSync(logFd);
    }
    const directoryFd = openSync(path.dirname(targetPath), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (copied) {
      try {
        unlinkSync(targetPath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "gate log copy and rollback failed");
      }
    }
    throw error;
  }
  return digest;
}

function readAppPrivateKey(readFile = readFileSync) {
  const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (
    typeof credentialsDirectory !== "string" ||
    !path.isAbsolute(credentialsDirectory) ||
    credentialsDirectory.includes("\0")
  ) {
    throw new GatekeeperFailure("APP_CREDENTIAL_MISSING", "systemd credential directory is unavailable");
  }
  const credentialPath = path.join(credentialsDirectory, APP_KEY_CREDENTIAL);
  const metadata = lstatSync(credentialPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o077) !== 0 ||
    (metadata.mode & 0o500) !== 0o400
  ) {
    throw new GatekeeperFailure("APP_CREDENTIAL_INVALID", "GitHub App key credential permissions are unsafe");
  }
  const key = readFile(credentialPath, "utf8");
  if (Buffer.byteLength(key, "utf8") > 64 * 1024) {
    throw new GatekeeperFailure("APP_CREDENTIAL_INVALID", "GitHub App key credential exceeds 64 KiB");
  }
  return key;
}

function assertEncryptedAppCredential() {
  const metadata = assertRootOwnedFile(APP_KEY_CIPHERTEXT, "encrypted GitHub App credential");
  if (
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size <= 0 ||
    metadata.size > 256 * 1024
  ) {
    throw new GatekeeperFailure(
      "APP_CREDENTIAL_INVALID",
      "encrypted GitHub App credential must be one nonempty root-owned 0600 file at most 256 KiB",
    );
  }
}

function parsePullRequestNumber(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new GatekeeperFailure("ARGUMENT_INVALID", "pull request number must be a positive decimal integer");
  }
  return Number(value);
}

function parseArguments(argv) {
  const dispatch = argv.length === 2 && argv[0] === "--dispatch";
  const publish = argv.length === 3 && argv[0] === "--publish";
  const retryPublish = argv.length === 2 && argv[0] === "--retry-publish";
  if (!dispatch && !publish && !retryPublish) {
    throw new GatekeeperFailure(
      "ARGUMENT_INVALID",
      "usage: local-gatekeeper --dispatch SUBJECT | --retry-publish SUBJECT | --publish SUBJECT JOB_ID",
    );
  }
  const selection = parseSubjectLabel(argv[1]);
  if (publish && !/^[0-9a-f]{32}$/u.test(argv[2])) {
    throw new GatekeeperFailure("ARGUMENT_INVALID", "publisher job ID must be 32 lowercase hex characters");
  }
  return Object.freeze({
    mode: argv[0].slice(2),
    subjectLabel: argv[1],
    ...(publish ? { jobId: argv[2] } : {}),
    ...selection,
  });
}

function parseSubjectLabel(value) {
  if (value === "main") return Object.freeze({ verifyMain: true });
  const match = /^pr-([1-9][0-9]{0,9})$/u.exec(value);
  if (!match) {
    throw new GatekeeperFailure("ARGUMENT_INVALID", "subject must be main or pr-<number>");
  }
  return Object.freeze({ pullRequestNumber: parsePullRequestNumber(match[1]), verifyMain: false });
}

function subjectSourceSha(subject) {
  return subject.kind === "main" ? subject.sourceSha : subject.headSha;
}

async function readGateSubject({ repository, pullRequestNumber, verifyMain, apiBaseUrl, fetchImpl }) {
  if (verifyMain === true) {
    return readMainRef({ repository, apiBaseUrl, fetchImpl });
  }
  return readPullRequest({
    repository,
    pullRequestNumber,
    apiBaseUrl,
    fetchImpl,
  });
}

async function defaultExecuteCandidate({ config, subject, workspace, runBase, logFd }) {
  const env = workerEnvironment(config, runBase);
  env.AGENC_REQUIRED_GATES_REPOSITORY_ROOT = workspace;
  const git = assertExecutable("/usr/bin/git", "Git executable");
  const subjectLabel = subject.kind === "main" ? "main" : `pr-${subject.number}`;
  const parentUnit = `agenc-local-gate-dispatcher@${subjectLabel}.service`;
  await assertRootlessDocker(config);
  chownSync(workspace, config.workerUid, config.workerGid);
  chmodSync(workspace, 0o700);
  await runSystemdWorkerLogged({
    config,
    command: git,
    args: ["init", "--quiet", workspace],
    cwd: workspace,
    env,
    runBase,
    readWritePaths: [workspace],
    timeoutMs: CHECKOUT_TIMEOUT_MS,
    logFd,
    label: "initialize isolated checkout",
    parentUnit,
  });
  await runSystemdWorkerLogged({
    config,
    command: git,
    args: ["-C", workspace, "remote", "add", "origin", "https://github.com/tetsuo-ai/agenc-core.git"],
    cwd: workspace,
    env,
    runBase,
    readWritePaths: [workspace],
    timeoutMs: CHECKOUT_TIMEOUT_MS,
    logFd,
    label: "bind canonical remote",
    parentUnit,
  });
  const fetchArgs = [
    "-C",
    workspace,
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/agenc-gate/base",
  ];
  if (subject.kind === "pull_request") {
    fetchArgs.push(`+refs/pull/${subject.number}/head:refs/agenc-gate/pr-head`);
  }
  await runSystemdWorkerLogged({
    config,
    command: git,
    args: fetchArgs,
    cwd: workspace,
    env,
    runBase,
    readWritePaths: [workspace],
    timeoutMs: CHECKOUT_TIMEOUT_MS,
    logFd,
    label: "fetch exact remote PR head",
    networkAccess: true,
    parentUnit,
  });
  const checkoutRef = subject.kind === "main" ? "refs/agenc-gate/base" : "refs/agenc-gate/pr-head";
  await runSystemdWorkerLogged({
    config,
    command: git,
    args: ["-C", workspace, "checkout", "--quiet", "--detach", checkoutRef],
    cwd: workspace,
    env,
    runBase,
    readWritePaths: [workspace],
    timeoutMs: CHECKOUT_TIMEOUT_MS,
    logFd,
    label: "checkout exact PR head",
    parentUnit,
  });
  const observedHead = (
    await runSystemdWorkerCaptured({
      config,
      command: git,
      args: ["-C", workspace, "rev-parse", "HEAD"],
      cwd: workspace,
      env,
      runBase,
      readWritePaths: [workspace],
      timeoutMs: CHECKOUT_TIMEOUT_MS,
      logFd,
      label: "read exact checked-out head",
      parentUnit,
    })
  ).stdout.trim();
  const expectedSourceSha = subjectSourceSha(subject);
  if (observedHead !== expectedSourceSha) {
    throw new GatekeeperFailure("SOURCE_MISMATCH", `fetched ${observedHead}; expected ${expectedSourceSha}`);
  }
  const observedBase = (
    await runSystemdWorkerCaptured({
      config,
      command: git,
      args: ["-C", workspace, "rev-parse", "refs/agenc-gate/base"],
      cwd: workspace,
      env,
      runBase,
      readWritePaths: [workspace],
      timeoutMs: CHECKOUT_TIMEOUT_MS,
      logFd,
      label: "read exact fetched main base",
      parentUnit,
    })
  ).stdout.trim();
  const expectedBaseSha = subject.kind === "main" ? subject.sourceSha : subject.baseSha;
  if (observedBase !== expectedBaseSha) {
    throw new GatekeeperFailure("BASE_MISMATCH", `fetched ${observedBase}; expected ${expectedBaseSha}`);
  }
  if (subject.kind === "pull_request") {
    await runSystemdWorkerLogged({
      config,
      command: git,
      args: ["-C", workspace, "merge-base", "--is-ancestor", observedBase, observedHead],
      cwd: workspace,
      env,
      runBase,
      readWritePaths: [workspace],
      timeoutMs: CHECKOUT_TIMEOUT_MS,
      logFd,
      label: "prove PR head contains the current main base",
      parentUnit,
    });
  }
  const encodedIndex = (
    await runSystemdWorkerCaptured({
      config,
      command: git,
      args: ["-C", workspace, "ls-files", "--stage", "-z"],
      cwd: workspace,
      env,
      runBase,
      readWritePaths: [workspace],
      timeoutMs: CHECKOUT_TIMEOUT_MS,
      logFd,
      label: "inventory checked-out index",
      parentUnit,
    })
  ).stdout;
  assertCandidateIndexShape(encodedIndex);
  prepareAndSealCandidateSource(workspace, config.workerUid, config.workerGid);
  const contract = computeRequiredGateContract({ repositoryRoot: workspace });
  if (contract.sha256 !== config.approvedContractSha256) {
    throw new GatekeeperFailure(
      "CONTRACT_NOT_APPROVED",
      `gate contract ${contract.sha256} is not the root-approved ${config.approvedContractSha256}`,
    );
  }
  assertTrustedMirror(workspace, TRUSTED_RUNNER_PATH, "scripts/run-required-gates.mjs");
  assertTrustedMirror(workspace, TRUSTED_CONTRACT_PATH, "scripts/required-gate-contract.mjs");
  assertApprovedDependencySources(
    JSON.parse(readFileSync(path.join(workspace, "package-lock.json"), "utf8")),
  );
  const dependencyWritePaths = [
    path.join(workspace, "node_modules"),
    path.join(workspace, "packages/agenc/node_modules"),
    path.join(workspace, "packages/agenc-sdk/node_modules"),
    path.join(workspace, "runtime/node_modules"),
  ];
  await runSystemdWorkerLogged({
    config,
    command: config.nodePath,
    args: [config.npmPath, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: workspace,
    env,
    runBase,
    readWritePaths: dependencyWritePaths,
    timeoutMs: INSTALL_TIMEOUT_MS,
    logFd,
    label: "install frozen dependency graph without lifecycle scripts",
    networkAccess: true,
    parentUnit,
  });
  await runSystemdWorkerLogged({
    config,
    command: config.nodePath,
    args: [config.npmPath, "rebuild", "better-sqlite3", "esbuild", "node-pty"],
    cwd: workspace,
    env: buildOfflineNativeBuildEnvironment(config, env),
    runBase,
    readWritePaths: dependencyWritePaths,
    timeoutMs: INSTALL_TIMEOUT_MS,
    logFd,
    label: "rebuild the fixed native dependency allowlist",
    parentUnit,
  });
  await runSystemdWorkerLogged({
    config,
    command: config.nodePath,
    args: [
      "-e",
      [
        "const { createRequire } = require('node:module');",
        "const requireFromRuntime = createRequire(process.cwd() + '/runtime/package.json');",
        "const Database = requireFromRuntime('better-sqlite3');",
        "const db = new Database(':memory:');",
        "if (db.prepare('select 42 as value').get().value !== 42) process.exit(31);",
        "db.close();",
        "const esbuild = requireFromRuntime('esbuild');",
        "if (typeof esbuild.transformSync('const value = 1')?.code !== 'string') process.exit(32);",
        "const pty = requireFromRuntime('node-pty');",
        "const child = pty.spawn(process.execPath, ['-e', \"process.stdout.write('pty-ok')\"], {",
        "  cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: process.env.PATH || '' },",
        "});",
        "let output = '';",
        "let exitEvent;",
        "const fail = () => {",
        "  process.stderr.write('node-pty smoke failed: ' + JSON.stringify({ exitCode: exitEvent?.exitCode, signal: exitEvent?.signal, output }) + '\\n');",
        "  process.exit(34);",
        "};",
        "const finish = () => {",
        "  if (exitEvent === undefined || !output.includes('pty-ok')) return;",
        "  clearTimeout(timeout);",
        "  if (exitEvent.exitCode !== 0 || (exitEvent.signal ?? 0) !== 0) fail();",
        "};",
        "const timeout = setTimeout(() => {",
        "  if (exitEvent === undefined) { child.kill(); process.exit(33); }",
        "  fail();",
        "}, 10000);",
        "child.onData((chunk) => { output += chunk; finish(); });",
        "child.onExit((event) => {",
        "  exitEvent = event;",
        "  if (event.exitCode !== 0 || (event.signal ?? 0) !== 0) fail();",
        "  finish();",
        "});",
      ].join(" "),
    ],
    cwd: workspace,
    env: { ...env, npm_config_offline: "true" },
    runBase,
    readWritePaths: dependencyWritePaths,
    timeoutMs: CHECKOUT_TIMEOUT_MS,
    logFd,
    label: "prove offline native dependency load and execution",
    parentUnit,
  });
  const viteTemp = path.join(workspace, "runtime/node_modules/.vite-temp");
  mkdirSync(viteTemp, { recursive: true, mode: 0o700 });
  chownSync(viteTemp, config.workerUid, config.workerGid);
  for (const dependencyRoot of dependencyWritePaths) {
    freezeWorkerTree(dependencyRoot, workspace, new Set([viteTemp]));
  }
  chmodSync(runBase, 0o711);
  const gateResult = await runLogged(config.nodePath, [TRUSTED_RUNNER_PATH], {
    cwd: workspace,
    env: {
      ...env,
      AGENC_REQUIRED_GATES_SHA: expectedSourceSha,
      AGENC_REQUIRED_GATES_SYSTEMD_WORKER_UID: String(config.workerUid),
      AGENC_REQUIRED_GATES_SYSTEMD_WORKER_GID: String(config.workerGid),
      AGENC_REQUIRED_GATES_NPM_PATH: config.npmPath,
      AGENC_REQUIRED_GATES_PARENT_UNIT: parentUnit,
      AGENC_REQUIRED_GATES_DOCKER_UID: String(config.dockerUid),
      AGENC_REQUIRED_GATES_DOCKER_GID: String(config.dockerGid),
      AGENC_REQUIRED_GATES_WORKER_HOME: config.workerHome,
    },
    timeoutMs: GATE_TIMEOUT_MS,
    logFd,
    label: "run complete local required gate",
    acceptedExitCodes: [0, 10],
  });
  const gateFailed = gateResult.code === 10;
  // The checkout and .git are root-owned after sealing. Keep native Git parsing
  // in the confined worker and grant only these commands an exact, canonical
  // safe.directory exception; the source remains read-only and networkless.
  await verifyFinalCandidateSourceInWorker({
    config,
    gitPath: git,
    workspace,
    expectedSourceSha,
    env,
    runBase,
    logFd,
    parentUnit,
  });
  const finalContract = computeRequiredGateContract({ repositoryRoot: workspace });
  if (finalContract.sha256 !== contract.sha256) {
    throw new GatekeeperFailure("CONTRACT_CHANGED", "gate contract changed during required gates");
  }
  if (gateFailed) {
    throw new GateOutcomeFailure(
      "REQUIRED_GATE_FAILED",
      "one or more required local gates failed",
      { contract },
    );
  }
  return contract;
}

const READY_SCHEMA_VERSION = 1;
const READY_MAX_AGE_MS = 6 * 60 * 60_000;

function readyDirectory(config) {
  return path.join(config.stateDirectory, "ready");
}

function readyPath(config, subjectLabel) {
  parseSubjectLabel(subjectLabel);
  return path.join(readyDirectory(config), `${subjectLabel}.json`);
}

function removePreviousReady(config, subjectLabel) {
  const target = readyPath(config, subjectLabel);
  try {
    const metadata = lstatSync(target);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.uid !== (process.getuid?.() ?? 0) ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new GatekeeperFailure("READY_INVALID", "refusing unsafe previous ready handoff");
    }
    unlinkSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function writeReadyEnvelope(config, envelope) {
  const directory = readyDirectory(config);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = readyPath(config, envelope.subjectLabel);
  const temporary = path.join(directory, `.${envelope.subjectLabel}-${envelope.jobId}.tmp`);
  const encoded = canonicalJson(envelope);
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) {
    throw new GatekeeperFailure("READY_INVALID", "ready handoff exceeds 64 KiB");
  }
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeSync(descriptor, encoded);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, target);
  const directoryDescriptor = openSync(directory, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  return target;
}

function validateReadyEnvelope(config, subjectLabel, encoded, now) {
  let envelope;
  try {
    envelope = JSON.parse(encoded);
  } catch (error) {
    throw new GatekeeperFailure("READY_INVALID", "ready handoff is not JSON", { cause: error });
  }
  if (canonicalJson(envelope) !== encoded) {
    throw new GatekeeperFailure("READY_INVALID", "ready handoff is not canonical JSON");
  }
  if (
    JSON.stringify(Object.keys(envelope).sort()) !==
    JSON.stringify(["createdAt", "jobId", "receipt", "schemaVersion", "subjectLabel"])
  ) {
    throw new GatekeeperFailure("READY_INVALID", "ready handoff keys do not match schema v1");
  }
  if (
    envelope.schemaVersion !== READY_SCHEMA_VERSION ||
    envelope.subjectLabel !== subjectLabel ||
    typeof envelope.jobId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(envelope.jobId)
  ) {
    throw new GatekeeperFailure("READY_INVALID", "ready handoff identity is invalid");
  }
  const created = new Date(envelope.createdAt);
  const observedNow = new Date(now);
  if (
    !Number.isFinite(created.getTime()) ||
    !Number.isFinite(observedNow.getTime()) ||
    created.getTime() > observedNow.getTime() + 60_000 ||
    observedNow.getTime() - created.getTime() > READY_MAX_AGE_MS
  ) {
    throw new GatekeeperFailure("READY_EXPIRED", "ready handoff is outside the six-hour freshness bound");
  }
  const receipt = envelope.receipt;
  const normalized = createGateReceipt({
    repository: receipt?.repository,
    subject: receipt?.subject,
    contract: {
      schemaVersion: receipt?.schemaVersion,
      context: receipt?.context,
      sha256: receipt?.contractSha256,
    },
    executorId: receipt?.executorId,
    startedAt: receipt?.startedAt,
    completedAt: receipt?.completedAt,
    result: receipt?.result,
    logSha256: receipt?.logSha256,
    ...(receipt?.failureCode === undefined ? {} : { failureCode: receipt.failureCode }),
  });
  if (
    canonicalJson(normalized) !== canonicalJson(receipt) ||
    normalized.repository !== config.repository ||
    normalized.contractSha256 !== config.approvedContractSha256
  ) {
    throw new GatekeeperFailure("READY_INVALID", "ready receipt does not match the approved local gate");
  }
  const expectedLabel = normalized.subject.kind === "main"
    ? "main"
    : `pr-${normalized.subject.number}`;
  if (expectedLabel !== subjectLabel) {
    throw new GatekeeperFailure("READY_INVALID", "ready receipt subject does not match its handoff path");
  }
  return Object.freeze({ ...envelope, receipt: normalized });
}

function readReadyEnvelope(config, subjectLabel, now = new Date()) {
  const target = readyPath(config, subjectLabel);
  const metadata = lstatSync(target);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== (process.getuid?.() ?? 0) ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > 64 * 1024
  ) {
    throw new GatekeeperFailure("READY_INVALID", "ready handoff metadata is unsafe");
  }
  return validateReadyEnvelope(config, subjectLabel, readFileSync(target, "utf8"), now);
}

export function pruneExpiredReadyEnvelopes(config, now = new Date()) {
  const directory = readyDirectory(config);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  if (entries.length > 10_000) {
    throw new GatekeeperFailure("READY_INVALID", "ready handoff directory is unexpectedly large");
  }
  const removed = [];
  for (const entry of entries) {
    const match = /^(main|pr-[1-9][0-9]{0,9})\.json$/u.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
      throw new GatekeeperFailure("READY_INVALID", `unexpected ready handoff entry: ${entry.name}`);
    }
    try {
      readReadyEnvelope(config, match[1], now);
    } catch (error) {
      if (!(error instanceof GatekeeperFailure) || error.code !== "READY_EXPIRED") throw error;
      unlinkSync(path.join(directory, entry.name));
      removed.push(entry.name);
    }
  }
  return Object.freeze(removed.sort());
}

function sameGateSubject(left, right) {
  return left.kind === right.kind &&
    subjectSourceSha(left) === subjectSourceSha(right) &&
    (
      left.kind === "main" ||
      (left.baseSha === right.baseSha && left.number === right.number)
    );
}

export async function runLocalGateWorker({
  config,
  pullRequestNumber,
  verifyMain = false,
  apiBaseUrl = "https://api.github.com",
  fetchImpl,
  executeCandidate = defaultExecuteCandidate,
  cleanupCandidateUnits,
  verifyDockerBoundary,
  mountCandidateFilesystem,
  unmountCandidateFilesystem,
  now = () => new Date(),
}) {
  if ((pullRequestNumber === undefined) === (verifyMain !== true)) {
    throw new GatekeeperFailure("ARGUMENT_INVALID", "select exactly one PR or main gate subject");
  }
  if (typeof cleanupCandidateUnits !== "function") {
    throw new GatekeeperFailure(
      "ARGUMENT_INVALID",
      "candidate transient-unit cleanup callback is required",
    );
  }
  if (typeof verifyDockerBoundary !== "function") {
    throw new GatekeeperFailure(
      "ARGUMENT_INVALID",
      "post-candidate Docker quiescence callback is required",
    );
  }
  if (typeof mountCandidateFilesystem !== "function" || typeof unmountCandidateFilesystem !== "function") {
    throw new GatekeeperFailure(
      "ARGUMENT_INVALID",
      "bounded candidate filesystem mount and unmount callbacks are required",
    );
  }
  const initialSubject = await readGateSubject({
    repository: config.repository,
    pullRequestNumber,
    verifyMain,
    apiBaseUrl,
    fetchImpl,
  });
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(config.logDirectory, { recursive: true, mode: 0o700 });
  pruneGateLogs(config.logDirectory);
  const subjectLabel = initialSubject.kind === "main" ? "main" : `pr-${initialSubject.number}`;
  removePreviousReady(config, subjectLabel);
  const sourceSha = subjectSourceSha(initialSubject);
  const filesystemJobId = randomBytes(16).toString("hex");
  const jobRoot = path.join(config.stateDirectory, `${subjectLabel}-job-${filesystemJobId}`);
  mkdirSync(jobRoot, { mode: 0o700 });
  const parentUnit = `agenc-local-gate-dispatcher@${subjectLabel}.service`;
  try {
    await mountCandidateFilesystem({
      jobId: filesystemJobId,
      parentUnit,
      mountPath: jobRoot,
    });
  } catch (error) {
    try {
      await unmountCandidateFilesystem(jobRoot);
      rmSync(jobRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `bounded job filesystem setup and cleanup failed: ${jobRoot}`,
      );
    }
    throw error;
  }
  const workspace = path.join(jobRoot, "source");
  const runBase = path.join(jobRoot, "runs");
  const logTimestamp = Date.now();
  const logPath = path.join(
    config.logDirectory,
    `${subjectLabel}-${sourceSha}-${logTimestamp}-${filesystemJobId}.log`,
  );
  const workingLogPath = path.join(jobRoot, "gate.log");
  let logFd;
  try {
    mkdirSync(workspace, { mode: 0o755 });
    mkdirSync(runBase, { mode: 0o700 });
    chownSync(runBase, config.workerUid, config.workerGid);
    chmodSync(runBase, 0o711);
    logFd = openSync(
      workingLogPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_APPEND |
        (constants.O_CLOEXEC ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    try {
      await unmountCandidateFilesystem(jobRoot);
      rmSync(jobRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `bounded job filesystem initialization and cleanup failed: ${jobRoot}`,
      );
    }
    throw error;
  }
  const startedAt = now();
  let contract;
  let result = "success";
  let failureCode;
  let outcomeError;
  let infrastructureError;
  try {
    contract = await executeCandidate({
      config,
      subject: initialSubject,
      pullRequest: initialSubject.kind === "pull_request" ? initialSubject : undefined,
      workspace,
      runBase,
      logFd,
    });
  } catch (error) {
    if (error instanceof GateOutcomeFailure) {
      result = "failure";
      failureCode = error.code;
      outcomeError = error;
      try {
        contract = error.contract ?? computeRequiredGateContract({ repositoryRoot: workspace });
      } catch (contractError) {
        infrastructureError = contractError;
      }
    } else {
      infrastructureError = error;
    }
  } finally {
    const cleanupErrors = [];
    try {
      await cleanupCandidateUnits();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await verifyDockerBoundary(config);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length !== 0) {
      const executionError = infrastructureError ?? outcomeError;
      infrastructureError = executionError === undefined && cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(
            [...(executionError === undefined ? [] : [executionError]), ...cleanupErrors],
            "candidate execution or post-run isolation cleanup failed",
          );
      outcomeError = undefined;
    }
    closeSync(logFd);
  }
  let logSha256;
  try {
    logSha256 = persistGateLog(workingLogPath, logPath);
  } catch (logError) {
    infrastructureError = infrastructureError === undefined
      ? logError
      : new AggregateError(
          [infrastructureError, logError],
          "candidate execution and bounded log persistence both failed",
        );
    outcomeError = undefined;
  }
  try {
    await unmountCandidateFilesystem(jobRoot);
    rmSync(jobRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    infrastructureError = infrastructureError === undefined
      ? cleanupError
      : new AggregateError(
          [infrastructureError, cleanupError],
          `local gate infrastructure and bounded filesystem cleanup failed: ${jobRoot}`,
        );
    outcomeError = undefined;
  }
  if (infrastructureError) {
    throw infrastructureError;
  }
  let receipt;
  try {
    const completedAt = now();
    const currentSubject = await readGateSubject({
      repository: config.repository,
      pullRequestNumber,
      verifyMain,
      apiBaseUrl,
      fetchImpl,
    });
    if (!sameGateSubject(currentSubject, initialSubject)) {
      throw new GatekeeperFailure("SOURCE_MOVED", "gate subject moved during local gates");
    }
    receipt = createGateReceipt({
      repository: config.repository,
      subject: initialSubject,
      contract,
      executorId: config.executorId,
      startedAt,
      completedAt,
      result,
      logSha256,
      failureCode,
    });
  } catch (error) {
    throw error;
  }
  // Candidate files are gone before the App key or installation token enters
  // any publisher service. A cleanup failure produces no ready handoff.
  const envelope = Object.freeze({
    schemaVersion: READY_SCHEMA_VERSION,
    jobId: randomBytes(16).toString("hex"),
    subjectLabel,
    createdAt: now().toISOString(),
    receipt,
  });
  const handoffPath = writeReadyEnvelope(config, envelope);
  return Object.freeze({ envelope, handoffPath, logPath, outcomeError });
}

export async function runLocalGatePublisher({
  config,
  subjectLabel,
  jobId,
  apiBaseUrl = "https://api.github.com",
  fetchImpl,
  readPrivateKey = readAppPrivateKey,
  now = () => new Date(),
}) {
  const selection = parseSubjectLabel(subjectLabel);
  const publicationNow = now();
  const envelope = readReadyEnvelope(config, subjectLabel, publicationNow);
  if (typeof jobId !== "string" || envelope.jobId !== jobId) {
    throw new GatekeeperFailure("READY_INVALID", "publisher job ID does not match the ready handoff");
  }
  const currentSubject = await readGateSubject({
    repository: config.repository,
    ...selection,
    apiBaseUrl,
    fetchImpl,
  });
  const receiptSubject = envelope.receipt.subject.kind === "main"
    ? envelope.receipt.subject
    : {
        kind: "pull_request",
        number: envelope.receipt.subject.number,
        headSha: envelope.receipt.subject.sourceSha,
        baseSha: envelope.receipt.subject.baseSha,
      };
  if (!sameGateSubject(currentSubject, receiptSubject)) {
    throw new GatekeeperFailure("SOURCE_MOVED", "gate subject moved before App publication");
  }
  const privateKeyPem = readPrivateKey();
  const installation = await mintInstallationToken({
    clientId: config.githubClientId,
    appId: config.githubAppId,
    installationId: config.githubInstallationId,
    privateKeyPem,
    apiBaseUrl,
    fetchImpl,
    now: publicationNow.getTime(),
  });
  const check = await publishGateCheck({
    repository: config.repository,
    appId: config.githubAppId,
    installationToken: installation.token,
    receipt: envelope.receipt,
    apiBaseUrl,
    fetchImpl,
  });
  return Object.freeze({
    envelope,
    check,
    gateFailed: envelope.receipt.result === "failure",
  });
}

function assertInstalledPolicy(config) {
  const installed = computeRequiredGateContract();
  if (installed.sha256 !== config.approvedContractSha256) {
    throw new GatekeeperFailure(
      "INSTALLED_POLICY_DRIFT",
      `installed gate policy ${installed.sha256} is not approved ${config.approvedContractSha256}`,
    );
  }
}

function assertInstalledDeploymentFile(templateRelativePath, installedPath) {
  const templatePath = path.join(
    TRUSTED_REPOSITORY_ROOT,
    ...templateRelativePath.split("/"),
  );
  assertRootOwnedFile(templatePath, `${templateRelativePath} trusted template`);
  const resolvedInstalled = realpathSync(installedPath);
  assertRootOwnedFile(resolvedInstalled, `${installedPath} installed policy`);
  if (!readFileSync(templatePath).equals(readFileSync(resolvedInstalled))) {
    throw new GatekeeperFailure(
      "INSTALLED_POLICY_DRIFT",
      `${installedPath} differs from ${templateRelativePath}`,
    );
  }
}

export function assertLoadedSystemdUnitRecord(records, {
  label,
  fragmentPath,
  dropInPaths,
}) {
  if (
    !records ||
    typeof records !== "object" ||
    Array.isArray(records) ||
    typeof label !== "string" ||
    records.LoadState !== "loaded" ||
    records.NeedDaemonReload !== "no" ||
    records.FragmentPath !== fragmentPath ||
    records.DropInPaths !== dropInPaths.join(" ") ||
    JSON.stringify(Object.keys(records).sort()) !==
      JSON.stringify(["DropInPaths", "FragmentPath", "LoadState", "NeedDaemonReload"])
  ) {
    throw new GatekeeperFailure(
      "INSTALLED_POLICY_DRIFT",
      `${label} is stale, missing, or has unreviewed fragments/drop-ins`,
    );
  }
}

function assertInstalledDeploymentFiles(config) {
  for (const [template, installed] of [
    [
      "packaging/systemd/agenc-local-gate-dispatcher@.service",
      "/etc/systemd/system/agenc-local-gate-dispatcher@.service",
    ],
    [
      "packaging/systemd/system-agencgate.slice",
      "/etc/systemd/system/system-agencgate.slice",
    ],
    [
      "packaging/systemd/agenc-local-gate-publish@.service",
      "/etc/systemd/system/agenc-local-gate-publish@.service",
    ],
    [
      "packaging/systemd/agenc-local-gate-docker-user.slice.conf",
      `/etc/systemd/system/user-${config.dockerUid}.slice.d/50-agenc-local-gate.conf`,
    ],
    [
      "packaging/systemd/agenc-local-gate-docker.service",
      "/etc/systemd/user/docker.service",
    ],
    [
      "packaging/systemd/agenc-local-gate-docker.service.conf",
      "/etc/systemd/user/docker.service.d/50-agenc-local-gate.conf",
    ],
  ]) {
    assertInstalledDeploymentFile(template, installed);
  }
}

function assertInstalledDeploymentLive(config, subjectLabel) {
  const dispatcherFragment = "/etc/systemd/system/agenc-local-gate-dispatcher@.service";
  const publisherFragment = "/etc/systemd/system/agenc-local-gate-publish@.service";
  const aggregateFragment = "/etc/systemd/system/system-agencgate.slice";
  const dockerFragment = "/etc/systemd/user/docker.service";
  const dockerDropIn = "/etc/systemd/user/docker.service.d/50-agenc-local-gate.conf";
  const userSliceVendorDropIn = "/usr/lib/systemd/system/user-.slice.d/10-defaults.conf";
  const userSliceDropIn =
    `/etc/systemd/system/user-${config.dockerUid}.slice.d/50-agenc-local-gate.conf`;
  assertRootOwnedFile(userSliceVendorDropIn, "systemd vendor user-slice defaults");
  const systemUnit = (unit) => inspectSystemdProperties([
    "show",
    "--no-pager",
    "--property=LoadState",
    "--property=NeedDaemonReload",
    "--property=FragmentPath",
    "--property=DropInPaths",
    unit,
  ]);
  assertLoadedSystemdUnitRecord(
    systemUnit(`agenc-local-gate-dispatcher@${subjectLabel}.service`),
    { label: "local-gate dispatcher", fragmentPath: dispatcherFragment, dropInPaths: [] },
  );
  assertLoadedSystemdUnitRecord(
    systemUnit(`agenc-local-gate-publish@${subjectLabel}.service`),
    { label: "local-gate publication retry", fragmentPath: publisherFragment, dropInPaths: [] },
  );
  assertLoadedSystemdUnitRecord(
    systemUnit(LOCAL_GATE_AGGREGATE_SLICE),
    { label: "local-gate aggregate slice", fragmentPath: aggregateFragment, dropInPaths: [] },
  );
  assertLoadedSystemdUnitRecord(
    systemUnit(`user-${config.dockerUid}.slice`),
    {
      label: "dedicated Docker user slice",
      fragmentPath: "",
      dropInPaths: [userSliceVendorDropIn, userSliceDropIn],
    },
  );
  assertLoadedSystemdUnitRecord(
    inspectSystemdProperties([
      "--user",
      `--machine=${config.dockerUid}@.host`,
      "show",
      "--no-pager",
      "--property=LoadState",
      "--property=NeedDaemonReload",
      "--property=FragmentPath",
      "--property=DropInPaths",
      "docker.service",
    ]),
    {
      label: "dedicated rootless Docker service",
      fragmentPath: dockerFragment,
      dropInPaths: [dockerDropIn],
    },
  );
}

const TRANSIENT_GATE_UNIT =
  /^agenc-local-gate-(?:[0-9a-f]{16}|worker-[0-9a-f]{16}|publisher-[0-9a-f]{32}|context-seed-credential-[0-9a-f]{32})\.service$/u;
const STATIC_COORDINATOR_UNIT =
  /^(?:agenc-local-gate-(?:dispatcher|publish)@(main|pr-[1-9][0-9]{0,9})|agenc-local-gate-context-seed@(seed|recover))\.service$/u;

export function parseTransientGateUnitInventory(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 1024 * 1024) {
    throw new GatekeeperFailure("SYSTEMD_INSPECTION_FAILED", "transient gate unit inventory is invalid");
  }
  const children = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [unitName] = trimmed.split(/\s+/u);
    if (STATIC_COORDINATOR_UNIT.test(unitName)) continue;
    if (!TRANSIENT_GATE_UNIT.test(unitName)) {
      throw new GatekeeperFailure(
        "SYSTEMD_INSPECTION_FAILED",
        `unexpected unit in the local-gate namespace: ${unitName}`,
      );
    }
    children.push(unitName);
  }
  return Object.freeze([...new Set(children)].sort());
}

function inspectTransientGateUnits() {
  const result = spawnSync(
    "/usr/bin/systemctl",
    [
      "list-units",
      "--all",
      "--full",
      "--plain",
      "--no-legend",
      "--no-pager",
      "agenc-local-gate-*.service",
    ],
    {
      encoding: "utf8",
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new GatekeeperFailure(
      "SYSTEMD_INSPECTION_FAILED",
      `could not inspect transient gate units: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return parseTransientGateUnitInventory(result.stdout);
}

function stopTransientGateUnit(unitName) {
  if (!TRANSIENT_GATE_UNIT.test(unitName)) {
    throw new GatekeeperFailure("SYSTEMD_INSPECTION_FAILED", `refusing unsafe unit name: ${unitName}`);
  }
  for (const [verb, accepted] of [
    ["stop", /not loaded|not found/iu],
    ["reset-failed", /not loaded|not found|has not failed/iu],
  ]) {
    const result = spawnSync("/usr/bin/systemctl", [verb, unitName], {
      encoding: "utf8",
      env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: verb === "stop" ? 45_000 : 10_000,
    });
    if (result.error || (result.status !== 0 && !accepted.test(result.stderr))) {
      throw new GatekeeperFailure(
        "SYSTEMD_CLEANUP_FAILED",
        `could not ${verb} ${unitName}: ${result.error?.message ?? result.stderr.trim()}`,
      );
    }
  }
}

function cleanupTransientGateUnits() {
  for (const unitName of inspectTransientGateUnits()) stopTransientGateUnit(unitName);
  const survivors = inspectTransientGateUnits();
  if (survivors.length !== 0) {
    throw new GatekeeperFailure(
      "SYSTEMD_NOT_QUIESCENT",
      `transient gate units survived cleanup: ${survivors.join(", ")}`,
    );
  }
}

function startPublisherService(config, subjectLabel, jobId, parentUnit) {
  assertEncryptedAppCredential();
  const invocation = buildSystemdPublisherCommand({
    jobId,
    subjectLabel,
    parentUnit,
    nodePath: config.nodePath,
    scriptPath: fileURLToPath(import.meta.url),
    credentialPath: APP_KEY_CIPHERTEXT,
    cwd: config.stateDirectory,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    stdio: "inherit",
    timeout: 6 * 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new GatekeeperFailure(
      "PUBLISHER_FAILED",
      `${invocation.unitName} failed with ${result.error?.message ?? `exit ${result.status}`}`,
    );
  }
}

async function main(argv) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new GatekeeperFailure("HOST_INVALID", "local gatekeeper must run as root on Linux");
  }
  if (realpathSync(fileURLToPath(import.meta.url)) !== TRUSTED_GATEKEEPER_PATH) {
    throw new GatekeeperFailure(
      "HOST_INVALID",
      "local gatekeeper must run from the reviewed root-installed mirror",
    );
  }
  const { mode, subjectLabel, jobId, pullRequestNumber, verifyMain } = parseArguments(argv);
  const config = loadGatekeeperConfig();
  assertInstalledPolicy(config);
  assertInstalledDeploymentFiles(config);
  if (mode !== "publish") assertInstalledDeploymentLive(config, subjectLabel);
  pruneExpiredReadyEnvelopes(config);
  if (mode === "dispatch") {
    const parentUnit = `agenc-local-gate-dispatcher@${subjectLabel}.service`;
    assertAggregateCgroupBoundary(parentUnit);
    cleanupTransientGateUnits();
    await cleanupStaleJobRoots(config.stateDirectory);
    const result = await runLocalGateWorker({
      config,
      pullRequestNumber,
      verifyMain,
      cleanupCandidateUnits: cleanupTransientGateUnits,
      verifyDockerBoundary: assertRootlessDocker,
      mountCandidateFilesystem: mountJobFilesystem,
      unmountCandidateFilesystem: unmountJobFilesystem,
    });
    cleanupTransientGateUnits();
    startPublisherService(config, subjectLabel, result.envelope.jobId, parentUnit);
    cleanupTransientGateUnits();
    process.stdout.write(
      `local-gatekeeper: dispatched ${result.envelope.receipt.subject.sourceSha} as ${result.envelope.jobId}\n`,
    );
    if (result.outcomeError) throw result.outcomeError;
    return;
  }
  if (mode === "retry-publish") {
    const parentUnit = `agenc-local-gate-publish@${subjectLabel}.service`;
    assertAggregateCgroupBoundary(parentUnit);
    cleanupTransientGateUnits();
    const envelope = readReadyEnvelope(config, subjectLabel);
    startPublisherService(config, subjectLabel, envelope.jobId, parentUnit);
    cleanupTransientGateUnits();
    process.stdout.write(
      `local-gatekeeper: retried publication for ${envelope.receipt.subject.sourceSha}\n`,
    );
    return;
  }
  const result = await runLocalGatePublisher({ config, subjectLabel, jobId });
  process.stdout.write(
    `local-gatekeeper: published ${result.envelope.receipt.subject.sourceSha} as check ${result.check.id}\n`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof GatekeeperFailure ? error.code : "UNEXPECTED";
    process.stderr.write(`local-gatekeeper: ${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

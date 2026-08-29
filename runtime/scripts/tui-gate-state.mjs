import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const OWNER_FILENAME = ".agenc-tui-gate-owner.json";
const OWNER_KIND = "agenc-tui-gate-state-v1";
const TRUST_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const DAEMON_START_TIMEOUT_MS = 60_000;
const DAEMON_STOP_TIMEOUT_MS = 20_000;
const DAEMON_FORCE_KILL_GRACE_MS = 2_000;
const DAEMON_POLL_MS = 100;
const MAX_DAEMON_OUTPUT_BYTES = 64 * 1024;
const SHORT_ROOT_PREFIX = "agt-";
const WINDOWS_ROOT_REMOVE_MAX_RETRIES = 10;
const WINDOWS_ROOT_REMOVE_RETRY_DELAY_MS = 50;
const PROJECT_FIXTURE_FILES = Object.freeze({
  "README.md": "# AgenC TUI gate fixture\n",
  "package.json": '{"private":true}\n',
});
const DEFAULT_CONFIG = [
  "config_version = 2",
  "",
  "[buffer.prediction]",
  'enabled = "off"',
  "",
].join("\n");

const PASSTHROUGH_ENV_KEYS = Object.freeze([
  "CI",
  "COLORTERM",
  "ComSpec",
  "COMSPEC",
  "EDITOR",
  "FORCE_COLOR",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "SYSTEMROOT",
  "TERM",
  "TUI_E2E_DEBUG",
  "USER",
  "VISUAL",
  "windir",
  "WINDIR",
]);

const ISOLATION_ENV_KEYS = Object.freeze([
  "HOME",
  "USERPROFILE",
  "AGENC_HOME",
  "AGENC_CONFIG_DIR",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "AGENC_AUTH_BACKEND",
  "AGENC_DAEMON_WEBSOCKET_HOST",
  "AGENC_DAEMON_WEBSOCKET_PORT",
  "AGENC_DISABLE_NONESSENTIAL_TRAFFIC",
  "AGENC_ONBOARDING",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
  "LANG",
  "LC_ALL",
  "NODE_OPTIONS",
  "TERM",
  "TZ",
]);
const ISOLATION_ENV_KEY_NAMES = new Set(
  ISOLATION_ENV_KEYS.map((key) => key.toLowerCase()),
);

const ACTIVE_STATES_BY_HOME = new Map();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function tuiGateRootRemoveOptions(platform = process.platform) {
  if (platform !== "win32") return { recursive: true };
  // ConPTY/process exit can precede release of the final directory handle.
  // Bound fs.rm's native EBUSY retry path without weakening absence proof.
  return {
    recursive: true,
    maxRetries: WINDOWS_ROOT_REMOVE_MAX_RETRIES,
    retryDelay: WINDOWS_ROOT_REMOVE_RETRY_DELAY_MS,
  };
}

function systemEnvironment(baseEnv) {
  return Object.fromEntries(
    PASSTHROUGH_ENV_KEYS.flatMap((key) =>
      baseEnv[key] === undefined ? [] : [[key, baseEnv[key]]],
    ),
  );
}

function isolationEnvironment(home) {
  const resolvedHome = path.resolve(home);
  const agencHome = path.join(resolvedHome, ".agenc");
  const privateTemp = path.join(resolvedHome, "tmp");
  return {
    HOME: resolvedHome,
    USERPROFILE: resolvedHome,
    AGENC_HOME: agencHome,
    APPDATA: path.join(resolvedHome, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(resolvedHome, "AppData", "Local"),
    ProgramData: path.join(resolvedHome, "ProgramData"),
    XDG_CACHE_HOME: path.join(resolvedHome, ".cache"),
    XDG_CONFIG_HOME: path.join(resolvedHome, ".config"),
    XDG_DATA_HOME: path.join(resolvedHome, ".local", "share"),
    XDG_STATE_HOME: path.join(resolvedHome, ".local", "state"),
    TEMP: privateTemp,
    TMP: privateTemp,
    TMPDIR: privateTemp,
    AGENC_AUTH_BACKEND: "local",
    AGENC_DAEMON_WEBSOCKET_HOST: "127.0.0.1",
    AGENC_DAEMON_WEBSOCKET_PORT: "0",
    AGENC_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    AGENC_ONBOARDING: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    NODE_OPTIONS: "",
    TERM: "xterm-256color",
    TZ: "UTC",
  };
}

/**
 * Build a private TUI-gate environment.
 *
 * `baseEnv` contributes only ordinary process-launch essentials. Provider
 * credentials, endpoints, and scenario knobs must be passed explicitly via
 * `injectedEnv`; this keeps startup smoke from inheriting operator secrets.
 * Isolation keys always win over both inputs.
 */
export function tuiGateEnvironment(
  home,
  baseEnv = process.env,
  injectedEnv = {},
) {
  const permittedInjectedEnv = Object.fromEntries(
    Object.entries(injectedEnv).filter(
      ([key]) => !ISOLATION_ENV_KEY_NAMES.has(key.toLowerCase()),
    ),
  );
  const environment = {
    ...systemEnvironment(baseEnv),
    ...permittedInjectedEnv,
    ...isolationEnvironment(home),
  };
  delete environment.AGENC_CONFIG_DIR;
  return environment;
}

async function makePrivateDirectories(env) {
  const directories = new Set([
    env.HOME,
    env.AGENC_HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.ProgramData,
    env.XDG_CACHE_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.TMPDIR,
  ]);
  await Promise.all(
    [...directories].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );
}

async function createShortGateRoot() {
  const parents =
    process.platform === "win32" ? [tmpdir()] : ["/tmp", tmpdir()];
  const failures = [];
  for (const parent of new Set(parents)) {
    try {
      return await mkdtemp(path.join(parent, SHORT_ROOT_PREFIX));
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    "could not create a private TUI gate root",
  );
}

function assertShortSocketPath(agencHome) {
  if (process.platform === "win32") return;
  const socketPath = path.join(agencHome, "daemon.sock");
  if (Buffer.byteLength(socketPath) >= 96) {
    throw new Error(`private TUI gate socket path is too long: ${socketPath}`);
  }
}

export async function createTuiGateState({
  baseEnv = process.env,
  injectedEnv = {},
  prefix = "agenc-tui-gate-",
} = {}) {
  const createdRoot = await createShortGateRoot();
  const ownerId = randomUUID();
  try {
    await chmod(createdRoot, 0o700);
    const root = await realpath(createdRoot);
    const env = tuiGateEnvironment(root, baseEnv, injectedEnv);
    assertShortSocketPath(env.AGENC_HOME);
    await makePrivateDirectories(env);
    await writeFile(
      path.join(root, OWNER_FILENAME),
      `${JSON.stringify({
        kind: OWNER_KIND,
        ownerId,
        root,
        label: prefix,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const state = {
      root,
      canonicalRoot: root,
      home: root,
      agencHome: env.AGENC_HOME,
      env,
      baseEnv: systemEnvironment(baseEnv),
      injectedEnv: { ...injectedEnv },
      ownerId,
      daemonPids: new Set(),
      daemonProcesses: new Map(),
      pendingDaemonStarts: new Set(),
      cleanupPromise: null,
      closing: false,
      cleaned: false,
    };
    ACTIVE_STATES_BY_HOME.set(state.home, state);
    return state;
  } catch (error) {
    await rm(createdRoot, { recursive: true, force: true });
    throw error;
  }
}

export function environmentForTuiGateState(state, overrides = {}) {
  if (state.cleaned || state.closing) {
    throw new Error(`TUI gate state is shutting down: ${state.root}`);
  }
  return tuiGateEnvironment(state.home, state.baseEnv, {
    ...state.injectedEnv,
    ...overrides,
  });
}

export function createTuiGateProject(state, { dirty = false } = {}) {
  if (state.cleaned || state.closing) {
    throw new Error(`TUI gate state is shutting down: ${state.root}`);
  }
  if (realpathSync(state.root) !== state.canonicalRoot) {
    throw new Error(`TUI gate root identity changed: ${state.root}`);
  }

  const project = path.join(state.root, "project");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const canonicalProject = realpathSync(project);
  if (!isWithin(state.canonicalRoot, canonicalProject)) {
    throw new Error(`TUI gate project escaped its root: ${project}`);
  }
  for (const [filename, contents] of Object.entries(PROJECT_FIXTURE_FILES)) {
    writeFileSync(path.join(project, filename), contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  const trackedFiles = Object.keys(PROJECT_FIXTURE_FILES);
  if (dirty) {
    writeFileSync(path.join(project, "diff-fixture.txt"), "baseline\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    trackedFiles.push("diff-fixture.txt");
  }

  const gitEnv = {
    ...state.env,
    GIT_AUTHOR_EMAIL: "tui-gate@agenc.invalid",
    GIT_AUTHOR_NAME: "AgenC TUI Gate",
    GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
    GIT_COMMITTER_EMAIL: "tui-gate@agenc.invalid",
    GIT_COMMITTER_NAME: "AgenC TUI Gate",
    GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const args of [
    ["init", "--quiet", "--initial-branch=main"],
    ["add", ...trackedFiles],
    ["commit", "--quiet", "-m", "test: initialize TUI gate fixture"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: project,
      encoding: "utf8",
      env: gitEnv,
      timeout: 10_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `failed to initialize private TUI gate git fixture: ${
          result.stderr || result.stdout
        }`,
      );
    }
  }

  if (dirty) {
    writeFileSync(
      path.join(project, "diff-fixture.txt"),
      "baseline\nprivate TUI gate change\n",
      "utf8",
    );
    writeFileSync(
      path.join(project, "untracked-fixture.txt"),
      "private TUI gate untracked file\n",
      "utf8",
    );
  }
  return project;
}

async function canonicalProjectPaths(projectPaths) {
  const canonical = new Set();
  for (const projectPath of projectPaths) {
    const resolved = path.resolve(projectPath);
    canonical.add(resolved);
    try {
      canonical.add(await realpath(resolved));
    } catch {
      // A caller can trust a path before creating it. The absolute form is
      // still deterministic and will be replaced on the next trust write.
    }
  }
  return [...canonical].sort((left, right) => left.localeCompare(right));
}

export async function writeTuiGateTrust(env, projectPaths) {
  const trustFile = path.join(env.AGENC_HOME, "trusted-projects.json");
  await mkdir(path.dirname(trustFile), { recursive: true, mode: 0o700 });
  const paths = await canonicalProjectPaths(projectPaths);
  await writeFile(
    trustFile,
    `${JSON.stringify(
      {
        version: 1,
        trustedProjects: paths.map((projectPath) => ({
          path: projectPath,
          trustedAt: TRUST_TIMESTAMP,
        })),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return trustFile;
}

/**
 * Seed ordinary TUI gates with deterministic, disclosure-safe editor state.
 *
 * The dedicated first-use consent scenario deliberately skips this helper.
 * Exclusive creation catches lifecycle regressions where another setup step
 * writes config before the runner has established its baseline.
 */
export async function writeTuiGateDefaultConfig(state) {
  await assertOwnedState(state);
  const configPath = path.join(state.agencHome, "config.toml");
  await writeFile(configPath, DEFAULT_CONFIG, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await assertOrdinaryPath(configPath, "file");
  return configPath;
}

function daemonCommand(binAgenc, args, env, timeout) {
  return spawnSync(process.execPath, [binAgenc, "daemon", ...args], {
    encoding: "utf8",
    env,
    timeout,
  });
}

async function readDaemonPid(agencHome) {
  try {
    const raw = (
      await readFile(path.join(agencHome, "daemon.pid"), "utf8")
    ).trim();
    return /^\d+$/u.test(raw) ? Number.parseInt(raw, 10) : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function assertOrdinaryPath(candidate, type) {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) {
    throw new Error(`refusing symlinked TUI gate ${type}: ${candidate}`);
  }
  if (type === "directory" && !metadata.isDirectory()) {
    throw new Error(`TUI gate path is not a directory: ${candidate}`);
  }
  if (type === "file" && !metadata.isFile()) {
    throw new Error(`TUI gate path is not a regular file: ${candidate}`);
  }
}

async function assertOwnedState(state) {
  if (state.cleaned) {
    throw new Error(`TUI gate state is already cleaned: ${state.root}`);
  }
  await assertOrdinaryPath(state.root, "directory");
  const canonicalRoot = await realpath(state.root);
  if (canonicalRoot !== state.canonicalRoot) {
    throw new Error(`TUI gate root identity changed: ${state.root}`);
  }

  const expectedAgencHome = path.join(state.root, ".agenc");
  if (
    state.home !== state.root ||
    state.agencHome !== expectedAgencHome ||
    state.env.HOME !== state.root ||
    state.env.AGENC_HOME !== expectedAgencHome
  ) {
    throw new Error(`TUI gate state paths changed: ${state.root}`);
  }
  await assertOrdinaryPath(expectedAgencHome, "directory");
  const canonicalAgencHome = await realpath(expectedAgencHome);
  if (!isWithin(canonicalRoot, canonicalAgencHome)) {
    throw new Error(`TUI gate home escaped its root: ${expectedAgencHome}`);
  }

  const ownerPath = path.join(state.root, OWNER_FILENAME);
  await assertOrdinaryPath(ownerPath, "file");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  if (
    owner?.kind !== OWNER_KIND ||
    owner?.ownerId !== state.ownerId ||
    owner?.root !== state.root
  ) {
    throw new Error(`refusing to clean unowned TUI gate root: ${state.root}`);
  }

  for (const filename of ["daemon.pid", "daemon.sock"]) {
    const candidate = path.join(expectedAgencHome, filename);
    if (!(await pathExists(candidate))) continue;
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error(`refusing symlinked TUI gate daemon path: ${candidate}`);
    }
    if (filename === "daemon.pid" && !metadata.isFile()) {
      throw new Error(
        `TUI gate daemon pid is not a regular file: ${candidate}`,
      );
    }
  }
}

export async function configureTuiGateSandbox(state, binAgenc, sandboxMode) {
  if (sandboxMode === undefined) return;
  if (sandboxMode !== "danger-full-access") {
    throw new Error(`unsupported TUI gate sandbox mode: ${sandboxMode}`);
  }
  await assertOwnedState(state);
  const result = spawnSync(
    process.execPath,
    [binAgenc, "config", "set", "sandbox_mode", sandboxMode],
    { encoding: "utf8", env: state.env, timeout: 10_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `failed to configure TUI gate sandbox mode: ${result.stderr || result.stdout}`,
    );
  }
}

function appendBoundedOutput(record, chunk, key) {
  if (record[key].length >= MAX_DAEMON_OUTPUT_BYTES) return;
  record[key] = `${record[key]}${chunk.toString()}`.slice(
    -MAX_DAEMON_OUTPUT_BYTES,
  );
}

function spawnForegroundDaemon(state, binAgenc) {
  const child = spawn(
    process.execPath,
    [binAgenc, "daemon", "start", "--foreground"],
    {
      env: state.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const record = {
    child,
    pid: child.pid,
    stdout: "",
    stderr: "",
    exit: null,
    exitPromise: null,
  };
  record.exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      record.exit = { code, signal };
      resolve(record.exit);
    });
    child.once("error", (error) => {
      if (record.exit === null) {
        record.exit = { code: null, signal: null, error };
        resolve(record.exit);
      }
    });
  });
  child.stdout?.on("data", (chunk) =>
    appendBoundedOutput(record, chunk, "stdout"),
  );
  child.stderr?.on("data", (chunk) =>
    appendBoundedOutput(record, chunk, "stderr"),
  );
  state.daemonPids.add(child.pid);
  state.daemonProcesses.set(child.pid, record);
  return record;
}

async function waitForDaemonReady(state, binAgenc, record) {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (state.closing) {
      throw new Error("private TUI gate daemon start interrupted by cleanup");
    }
    if (record.exit !== null) {
      throw new Error(
        [
          `private TUI gate daemon exited before readiness (pid ${record.pid})`,
          `exit: ${record.exit.signal ?? record.exit.code ?? record.exit.error ?? "unknown"}`,
          `stdout: ${record.stdout}`,
          `stderr: ${record.stderr}`,
        ].join("\n"),
      );
    }
    const pid = await readDaemonPid(state.agencHome);
    if (pid === record.pid) {
      const status = daemonCommand(binAgenc, ["status"], state.env, 5_000);
      lastStatus = status;
      if (
        status.status === 0 &&
        new RegExp(`\\bAgenC daemon running \\(pid ${record.pid}\\)`, "u").test(
          status.stdout,
        )
      ) {
        return;
      }
    }
    await sleep(DAEMON_POLL_MS);
  }
  throw new Error(
    [
      `private TUI gate daemon readiness timed out (pid ${record.pid})`,
      `status error: ${lastStatus?.error?.message ?? "none"}`,
      `status exit: ${lastStatus?.signal ?? lastStatus?.status ?? "not run"}`,
      `status stdout: ${lastStatus?.stdout ?? ""}`,
      `status stderr: ${lastStatus?.stderr ?? ""}`,
      `stdout: ${record.stdout}`,
      `stderr: ${record.stderr}`,
    ].join("\n"),
  );
}

async function performStartTuiGateDaemon(state, binAgenc) {
  await assertOwnedState(state);
  if (state.closing) {
    throw new Error("private TUI gate daemon start interrupted by cleanup");
  }
  const liveRecords = [...state.daemonProcesses.values()].filter(
    (record) => record.exit === null && isPidAlive(record.pid),
  );
  if (liveRecords.length > 0) return liveRecords[0].pid;

  const record = spawnForegroundDaemon(state, binAgenc);
  try {
    await waitForDaemonReady(state, binAgenc, record);
    if (state.closing) {
      throw new Error("private TUI gate daemon start interrupted by cleanup");
    }
    await assertOwnedState(state);
    const currentPid = await readDaemonPid(state.agencHome);
    if (currentPid !== record.pid) {
      throw new Error("private TUI gate daemon pid changed during readiness");
    }
    return record.pid;
  } catch (error) {
    await terminateDaemonRecord(record).catch(() => {});
    throw error;
  }
}

export function startTuiGateDaemon(state, binAgenc) {
  if (state.cleaned || state.closing) {
    return Promise.reject(
      new Error(`TUI gate state is shutting down: ${state.root}`),
    );
  }
  const operation = performStartTuiGateDaemon(state, binAgenc);
  state.pendingDaemonStarts.add(operation);
  operation.then(
    () => state.pendingDaemonStarts.delete(operation),
    () => state.pendingDaemonStarts.delete(operation),
  );
  return operation;
}

async function waitForRecordExit(record, timeoutMs) {
  if (record.exit !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(record.exit !== null), timeoutMs);
    record.exitPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateDaemonRecord(record, { force = false } = {}) {
  if (record.exit !== null) return;
  if (!force) {
    try {
      record.child.kill("SIGTERM");
    } catch {
      // The retained ChildProcess exit observation remains authoritative.
    }
    if (await waitForRecordExit(record, DAEMON_STOP_TIMEOUT_MS)) return;
  }
  try {
    record.child.kill("SIGKILL");
  } catch {
    // The retained ChildProcess exit observation remains authoritative.
  }
  if (await waitForRecordExit(record, DAEMON_FORCE_KILL_GRACE_MS)) return;
  throw new Error(
    `private TUI gate daemon survived SIGKILL (pid ${record.pid})`,
  );
}

async function terminateOwnedDaemons(state, options = {}) {
  const results = await Promise.allSettled(
    [...state.daemonProcesses.values()].map((record) =>
      terminateDaemonRecord(record, options),
    ),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "private TUI gate daemon cleanup failed",
    );
  }
  const livePids = [...state.daemonPids].filter((pid) => {
    const record = state.daemonProcesses.get(pid);
    return record !== undefined && record.exit === null && isPidAlive(pid);
  });
  if (livePids.length > 0) {
    throw new Error(
      `private TUI gate daemon cleanup was not proven: ${livePids.join(", ")}`,
    );
  }
}

export async function stopTuiGateDaemon(state) {
  if (!state || state.cleaned) return;
  const rootPresent = await pathExists(state.root);
  let ownershipError = null;
  if (rootPresent) {
    try {
      await assertOwnedState(state);
    } catch (error) {
      ownershipError = error;
    }
  }
  await terminateOwnedDaemons(state, {
    force: !rootPresent || ownershipError !== null,
  });
  if (!rootPresent) {
    throw new Error(
      `private TUI gate root disappeared while stopping its daemon: ${state.root}`,
    );
  }
  if (ownershipError !== null) throw ownershipError;
  await assertOwnedState(state);
  const currentPid = await readDaemonPid(state.agencHome);
  if (
    currentPid !== null &&
    isPidAlive(currentPid) &&
    !state.daemonProcesses.has(currentPid)
  ) {
    throw new Error(
      `refusing to signal unowned pid from private TUI gate state: ${currentPid}`,
    );
  }
  const deadline = Date.now() + DAEMON_FORCE_KILL_GRACE_MS;
  const socketPath = path.join(state.agencHome, "daemon.sock");
  while (
    ((await pathExists(socketPath)) ||
      (await readDaemonPid(state.agencHome)) !== null) &&
    Date.now() < deadline
  ) {
    await sleep(DAEMON_POLL_MS);
  }
  if (
    (await pathExists(socketPath)) ||
    (await readDaemonPid(state.agencHome)) !== null
  ) {
    throw new Error("private TUI gate daemon state survived process cleanup");
  }
}

async function performTeardown(state) {
  const rootPresent = await pathExists(state.root);
  let ownershipError = null;
  if (rootPresent) {
    try {
      await assertOwnedState(state);
    } catch (error) {
      ownershipError = error;
    }
  }
  let daemonError = null;
  try {
    // If candidate code deleted or redirected private state, skip graceful
    // daemon cleanup: retained-child SIGKILL prevents the daemon itself from
    // following poisoned paths while shutting down.
    await terminateOwnedDaemons(state, {
      force: !rootPresent || ownershipError !== null,
    });
  } catch (error) {
    daemonError = error;
  }
  if (daemonError !== null) throw daemonError;

  if (!rootPresent) {
    state.cleaned = true;
    ACTIVE_STATES_BY_HOME.delete(state.home);
    throw new Error(
      `private TUI gate root disappeared before cleanup: ${state.root}`,
    );
  }

  if (ownershipError !== null) throw ownershipError;
  await assertOwnedState(state);
  const currentPid = await readDaemonPid(state.agencHome);
  if (
    currentPid !== null &&
    isPidAlive(currentPid) &&
    !state.daemonProcesses.has(currentPid)
  ) {
    throw new Error(
      `refusing to signal unowned pid from private TUI gate state: ${currentPid}`,
    );
  }

  const socketPath = path.join(state.agencHome, "daemon.sock");
  const socketDeadline = Date.now() + DAEMON_FORCE_KILL_GRACE_MS;
  while ((await pathExists(socketPath)) && Date.now() < socketDeadline) {
    await sleep(DAEMON_POLL_MS);
  }
  if (await pathExists(socketPath)) {
    throw new Error(
      `private TUI gate socket survived daemon cleanup: ${socketPath}`,
    );
  }

  await assertOwnedState(state);
  await rm(state.root, tuiGateRootRemoveOptions());
  if (await pathExists(state.root)) {
    throw new Error(`private TUI gate root survived cleanup: ${state.root}`);
  }
  state.cleaned = true;
  ACTIVE_STATES_BY_HOME.delete(state.home);
}

async function settlePendingDaemonStarts(state) {
  while (state.pendingDaemonStarts.size > 0) {
    await Promise.allSettled([...state.pendingDaemonStarts]);
  }
}

export function teardownTuiGateState(state, _binAgenc) {
  if (!state || state.cleaned) return Promise.resolve();
  if (state.cleanupPromise === null) {
    state.closing = true;
    state.cleanupPromise = (async () => {
      await settlePendingDaemonStarts(state);
      await performTeardown(state);
    })();
  }
  return state.cleanupPromise;
}

async function loadOwnedTuiGateState(home, baseEnv) {
  const root = path.resolve(home);
  const owner = JSON.parse(
    await readFile(path.join(root, OWNER_FILENAME), "utf8"),
  );
  if (owner?.kind !== OWNER_KIND || owner?.root !== root || !owner?.ownerId) {
    throw new Error(
      `temporary TUI gate home is not owned by this gate: ${root}`,
    );
  }
  const env = tuiGateEnvironment(root, baseEnv);
  return {
    root,
    canonicalRoot: await realpath(root),
    home: root,
    agencHome: env.AGENC_HOME,
    env,
    baseEnv: systemEnvironment(baseEnv),
    injectedEnv: {},
    ownerId: owner.ownerId,
    daemonPids: new Set(),
    daemonProcesses: new Map(),
    pendingDaemonStarts: new Set(),
    cleanupPromise: null,
    closing: false,
    cleaned: false,
  };
}

export async function teardownTuiGateHome(
  home,
  binAgenc,
  baseEnv = process.env,
) {
  if (!home) return;
  const resolvedHome = path.resolve(home);
  const activeState = ACTIVE_STATES_BY_HOME.get(resolvedHome);
  if (activeState !== undefined) {
    await teardownTuiGateState(activeState, binAgenc);
    return;
  }
  if (!(await pathExists(resolvedHome))) {
    throw new Error(
      `temporary TUI gate home disappeared before cleanup: ${resolvedHome}`,
    );
  }
  const state = await loadOwnedTuiGateState(resolvedHome, baseEnv);
  await teardownTuiGateState(state, binAgenc);
}

export function installTuiGateSignalHandlers(cleanup) {
  let handling = false;
  const handlers = new Map();
  for (const [signal, exitCode] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const handler = () => {
      if (handling) return;
      handling = true;
      Promise.resolve()
        .then(() => cleanup(signal))
        .catch((error) => {
          process.stderr.write(
            `TUI gate signal cleanup failed: ${
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error)
            }\n`,
          );
        })
        .finally(() => {
          process.exit(exitCode);
        });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

export const TUI_GATE_ISOLATION_ENV_KEYS = ISOLATION_ENV_KEYS;
export const TUI_GATE_TRUST_TIMESTAMP = TRUST_TIMESTAMP;

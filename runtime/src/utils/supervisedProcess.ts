import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export type SupervisedProcessStopReason =
  | "timeout"
  | "aborted"
  | "output_limit"
  | "consumer_limit"
  | "spawn_error"
  | "residual_process";

export interface SupervisedProcessCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly argv0?: string;
}

export interface SupervisedProcessControl {
  stop(reason?: "consumer_limit"): void;
}

export interface SupervisedProcessOptions {
  /** Optional caller-supplied deadline. Omitted means unbounded. */
  readonly timeoutMs?: number;
  readonly maxOutputBytes: number;
  /**
   * Retain stdout in the result and charge it to `maxOutputBytes`.
   *
   * Set to false only for a streaming consumer which supplies `onStdout` and
   * enforces its own record, decoded-byte, and aggregate-work ceilings. Stderr
   * remains retained and charged to `maxOutputBytes`.
   */
  readonly captureStdout?: boolean;
  /** Optional bounded source bytes for native helpers that read stdin. */
  readonly stdin?: string | Buffer;
  readonly signal?: AbortSignal;
  readonly terminateGraceMs?: number;
  readonly settleBackstopMs?: number;
  readonly onStdout?: (
    chunk: Buffer,
    control: SupervisedProcessControl,
  ) => void;
  readonly onStderr?: (
    chunk: Buffer,
    control: SupervisedProcessControl,
  ) => void;
}

export interface SupervisedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stopReason?: SupervisedProcessStopReason;
  readonly forced: boolean;
  readonly backstopExpired: boolean;
  readonly error?: Error;
}

const DEFAULT_TERMINATE_GRACE_MS = 500;
const DEFAULT_SETTLE_BACKSTOP_MS = 1_000;
const PROCESS_TREE_POLL_INTERVAL_MS = 20;
const PROCESS_TABLE_TIMEOUT_MS = 2_000;
const MAX_PROCESS_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_TABLE_RECORDS = 32_768;
const MAX_OWNED_PROCESS_IDENTITIES = 4_096;
const LINUX_SUBREAPER_BROKER_NAME = "agenc-process-broker";
const WINDOWS_JOB_BROKER_NAME = "agenc-process-job-broker.exe";
const WINDOWS_COMMAND_LINE_QUOTE_CODE_UNIT = 0x22;
const WINDOWS_COMMAND_LINE_SPACE_CODE_UNIT = 0x20;
const WINDOWS_COMMAND_LINE_TAB_CODE_UNIT = 0x09;
const WINDOWS_COMMAND_LINE_BACKSLASH_CODE_UNIT = 0x5c;

const LINUX_CGROUP_OWNER_WATCHDOG_SCRIPT = String.raw`
set -u
declare -A agenc_cgroups=()
agenc_stopping=0

agenc_cleanup() {
  if [[ "$agenc_stopping" == "1" ]]; then
    return
  fi
  agenc_stopping=1
  trap - HUP INT TERM

  # Kill every registered boundary first so cleanup latency is bounded by the
  # slowest cgroup rather than the sum of every cgroup's exit latency.
  for agenc_path in "${"$"}{agenc_cgroups[@]}"; do
    printf '1\n' > "$agenc_path/cgroup.kill" 2>/dev/null || true
  done

  for _agenc_attempt in {1..100}; do
    agenc_remaining=0
    for agenc_path in "${"$"}{agenc_cgroups[@]}"; do
      if [[ ! -e "$agenc_path/cgroup.events" ]]; then
        continue
      fi
      agenc_events=$(<"$agenc_path/cgroup.events") || true
      if [[ "$agenc_events" == *"populated 0"* ]]; then
        rmdir "$agenc_path" 2>/dev/null || true
      else
        agenc_remaining=1
      fi
    done
    if [[ "$agenc_remaining" == "0" ]]; then
      break
    fi
    sleep 0.01
  done
}

trap 'agenc_cleanup; exit 0' HUP INT TERM

# stdin is an ownership lease. The Node owner keeps its write end open and
# registers cgroups over this same pipe. SIGKILL/crash closes the pipe in the
# kernel, causing EOF and fail-closed cleanup without a polling process.
while IFS=' ' read -r agenc_operation agenc_id agenc_path; do
  case "$agenc_operation" in
    ADD)
      agenc_cgroups["$agenc_id"]="$agenc_path"
      printf 'READY %s\n' "$agenc_id"
      ;;
    REMOVE)
      unset 'agenc_cgroups['"$agenc_id"']'
      ;;
  esac
done

agenc_cleanup
`;

const POSIX_OWNER_WATCHDOG_SCRIPT = String.raw`
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

process.title = 'agenc-process-owner-watchdog';
const encoded = process.env.AGENC_PROCESS_WATCHDOG_CONFIG;
delete process.env.AGENC_PROCESS_WATCHDOG_CONFIG;
if (!encoded) process.exit(125);
const config = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
if (!Number.isSafeInteger(config.rootPid) || config.rootPid <= 1) process.exit(125);
const tracked = new Map();
let stopping = false;
let timer;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function snapshot() {
  const result = spawnSync(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,state=,lstart='],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 2000 }
  );
  if (result.error || result.signal || result.status !== 0) return null;
  const records = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(ppid)) continue;
    records.set(pid, {
      pid,
      ppid,
      state: match[3],
      identity: pid + ':' + match[4],
    });
  }
  return records;
}

function extendTracked() {
  if (config.cgroupPath) return;
  const records = snapshot();
  if (!records) return;
  const root = records.get(config.rootPid);
  if (root && tracked.size === 0) tracked.set(root.identity, root);
  const liveKnown = new Set();
  for (const record of records.values()) {
    if (tracked.has(record.identity)) liveKnown.add(record.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records.values()) {
      if (!liveKnown.has(record.ppid) || tracked.has(record.identity)) continue;
      tracked.set(record.identity, record);
      liveKnown.add(record.pid);
      changed = true;
    }
  }
}

function killTracked() {
  if (config.cgroupPath) {
    try {
      fs.writeFileSync(config.cgroupPath + '/cgroup.kill', '1\n');
    } catch {}
    return;
  }
  extendTracked();
  const records = snapshot();
  for (const record of [...tracked.values()].reverse()) {
    if (record.pid <= 1) continue;
    const current = records && records.get(record.pid);
    if (!current || current.identity !== record.identity) continue;
    try { process.kill(-record.pid, 'SIGKILL'); } catch {}
    try { process.kill(record.pid, 'SIGKILL'); } catch {}
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  killTracked();
  if (config.cgroupPath) {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try {
        const events = fs.readFileSync(
          config.cgroupPath + '/cgroup.events',
          'utf8'
        );
        if (/(?:^|\n)populated 0(?:\n|$)/.test(events)) {
          try { fs.rmdirSync(config.cgroupPath); } catch {}
          break;
        }
      } catch {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
extendTracked();
try {
  fs.writeSync(3, 'ready\n');
  fs.closeSync(3);
} catch {
  stop();
}
timer = setInterval(() => {
  extendTracked();
  if (
    process.ppid !== config.ownerPid ||
    !alive(config.ownerPid) ||
    !alive(config.rootPid)
  ) stop();
}, 25);
`;

const POSIX_PROCESS_GATE_SCRIPT = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function fail(message, exitCode = 125) {
  try {
    process.stderr.write('agenc-process-gate: ' + message + '\n');
  } finally {
    process.exit(exitCode);
  }
}

let config;
try {
  const encoded = fs.readFileSync(3, 'utf8');
  fs.closeSync(3);
  config = JSON.parse(encoded);
} catch {
  fail('invalid containment handoff');
}

if (
  !config ||
  typeof config.program !== 'string' ||
  typeof config.argv0 !== 'string' ||
  !Array.isArray(config.args) ||
  !config.args.every((argument) => typeof argument === 'string') ||
  !Array.isArray(config.environment)
) {
  fail('invalid containment configuration');
}

const environment = Object.create(null);
for (const entry of config.environment) {
  if (
    !Array.isArray(entry) ||
    entry.length !== 2 ||
    typeof entry[0] !== 'string' ||
    typeof entry[1] !== 'string'
  ) {
    fail('invalid containment environment');
  }
  environment[entry[0]] = entry[1];
}

function resolveProgram(program) {
  if (program.includes('/')) return program;
  const searchPath = Object.prototype.hasOwnProperty.call(environment, 'PATH')
    ? environment.PATH
    : '/usr/bin:/bin';
  for (const entry of searchPath.split(':')) {
    const candidate = path.resolve(entry === '' ? '.' : entry, program);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

const executable = resolveProgram(config.program);
if (executable === null) {
  fail('executable not found: ' + config.program, 127);
}
if (typeof process.execve !== 'function') {
  fail('runtime does not support process.execve');
}
process.execve(
  executable,
  [config.argv0, ...config.args],
  environment
);
fail('process.execve returned unexpectedly');
`;

type ProcessTreeChild = Pick<
  ChildProcess,
  "pid" | "kill" | "exitCode" | "signalCode"
>;

type NativeProcessRecord = {
  readonly pid: number;
  readonly ppid: number;
  readonly state: string | null;
  readonly startToken: string;
};

type OwnedProcessBoundary = {
  readonly rootPid: number;
  readonly identities: Map<string, NativeProcessRecord>;
  current: Map<number, NativeProcessRecord>;
  snapshotComplete: boolean;
  overflowed: boolean;
};

type NativeProcessSnapshot = {
  readonly records: Map<number, NativeProcessRecord>;
  readonly complete: boolean;
};

const ownedProcessBoundaries = new WeakMap<object, OwnedProcessBoundary>();

type LinuxCgroupBoundary = {
  readonly path: string;
  released: boolean;
};

const linuxCgroupBoundaries = new WeakMap<object, LinuxCgroupBoundary>();
const windowsJobBoundaries = new WeakSet<object>();
const posixOwnerWatchdogs = new WeakMap<object, ChildProcess>();

type LinuxSubreaperControlSignal = "SIGTERM" | "SIGUSR2";

type LinuxSubreaperBoundary = {
  readonly status: Readable;
  readonly nativeKill: (signal?: NodeJS.Signals | number) => boolean;
  processClosed: boolean;
  statusClosed: boolean;
  closed: boolean;
  ready: boolean;
  residual: boolean;
  verified: boolean;
  pendingSignal?: LinuxSubreaperControlSignal;
  protocolError?: Error;
};

const linuxSubreaperBoundaries = new WeakMap<object, LinuxSubreaperBoundary>();
let compiledLinuxSubreaperBroker: string | undefined;
let compiledLinuxSubreaperBrokerRoot: string | undefined;
let compiledWindowsJobBroker: string | undefined;
let compiledWindowsJobBrokerRoot: string | undefined;

type LinuxCgroupWatchdogPendingRegistration = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly gate: Writable;
  readonly gatePayload: string;
  readonly timer: NodeJS.Timeout;
};

type LinuxCgroupWatchdogState = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<string, LinuxCgroupWatchdogPendingRegistration>;
  readonly active: Map<string, ChildProcessWithoutNullStreams>;
  stdoutBuffer: string;
  failed: boolean;
};

type LinuxCgroupWatchdogRegistration = {
  readonly state: LinuxCgroupWatchdogState;
  readonly id: string;
};

let linuxCgroupOwnerWatchdog: LinuxCgroupWatchdogState | null = null;
let linuxCgroupWatchdogRegistrationSequence = 0;
const linuxCgroupWatchdogRegistrations = new WeakMap<
  object,
  LinuxCgroupWatchdogRegistration
>();

export interface ContainedProcessSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv0?: string;
  /** Select the deterministic Linux subreaper boundary even when cgroup v2 is available. */
  readonly linuxContainment?: "auto" | "subreaper";
}

export interface TerminateProcessTreeOptions {
  readonly terminateGraceMs?: number;
  readonly killGraceMs?: number;
  readonly label?: string;
}

function serializePosixProcessGatePayload(
  program: string,
  args: readonly string[],
  options: ContainedProcessSpawnOptions,
): string {
  const environment: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(options.env)) {
    if (value !== undefined) environment.push([name, String(value)]);
  }
  return JSON.stringify({
    program,
    argv0: options.argv0 ?? program,
    args,
    environment,
  });
}

function trustedPosixBootstrapEnvironment(
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    ...extra,
  };
}

/**
 * Spawn a process behind the strongest process-lifetime boundary available.
 *
 * Linux uses a private cgroup-v2 leaf or native subreaper, and Windows uses a
 * Job Object, so those platforms retain recursive kernel ownership. On
 * Darwin, cleanup covers the detached process group plus PID/start identities
 * observed while descendants remain connected through the PPID tree; a
 * complete fork/setsid/reparent chain between snapshots is not observable.
 */
export function spawnContainedProcess(
  program: string,
  args: readonly string[],
  options: ContainedProcessSpawnOptions,
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawnWindowsJobContainedProcess(program, args, options);
  }
  const cgroupPath =
    process.platform === "linux" && options.linuxContainment !== "subreaper"
      ? createPrivateLinuxCgroup()
      : null;
  if (process.platform === "linux" && cgroupPath === null) {
    return spawnLinuxSubreaperContainedProcess(program, args, options);
  }

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const gatePayload = serializePosixProcessGatePayload(
      program,
      args,
      options,
    );
    child = spawn(process.execPath, ["-e", POSIX_PROCESS_GATE_SCRIPT], {
      cwd: options.cwd,
      env: trustedPosixBootstrapEnvironment(),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    if (child.pid === undefined || child.pid <= 0) {
      throw new Error("contained process did not publish a pid");
    }
    if (cgroupPath !== null) {
      writeFileSync(join(cgroupPath, "cgroup.procs"), `${child.pid}\n`);
      linuxCgroupBoundaries.set(child, {
        path: cgroupPath,
        released: false,
      });
    }
    const gate = child.stdio[3];
    if (
      gate === undefined ||
      gate === null ||
      typeof gate === "number" ||
      !("end" in gate)
    ) {
      throw new Error("contained process gate FD is unavailable");
    }
    // Killing the contained process while the one-shot gate is closing may
    // surface ECONNRESET on this private stream. It is not a user-visible I/O
    // failure and must not become an unhandled process-level exception.
    gate.on("error", () => {});
    launchPosixOwnerWatchdog(child, gate, gatePayload, options.cwd, cgroupPath);
    return child;
  } catch (error) {
    if (child !== undefined) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The gated wrapper never reached the target process.
      }
    }
    if (cgroupPath !== null) removeEmptyLinuxCgroup(cgroupPath);
    throw error;
  }
}

/**
 * Linux fallback for hosts which do not delegate a writable cgroup-v2 leaf.
 *
 * A polling process table cannot observe a child which forks, calls setsid(2),
 * and exits between samples. The native broker instead becomes a kernel
 * subreaper before it starts the command. Orphaned descendants are therefore
 * reparented to that unique broker and cannot escape its forced cleanup.
 */
function spawnLinuxSubreaperContainedProcess(
  program: string,
  args: readonly string[],
  options: ContainedProcessSpawnOptions,
): ChildProcessWithoutNullStreams {
  const brokerPath = resolveLinuxSubreaperBroker();
  const child = spawn(
    brokerPath,
    [program, options.argv0 ?? program, ...args],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  if (child.pid === undefined || child.pid <= 1) {
    safeKill(child, "SIGKILL");
    throw new Error(
      "Linux process containment broker did not publish a safe pid",
    );
  }
  const status = child.stdio[3];
  if (
    status === undefined ||
    status === null ||
    typeof status === "number" ||
    !("readable" in status)
  ) {
    safeKill(child, "SIGKILL");
    throw new Error(
      "Linux process containment broker status FD is unavailable",
    );
  }
  const readableStatus = status as Readable;
  const nativeKill = child.kill.bind(child);
  const boundary: LinuxSubreaperBoundary = {
    status: readableStatus,
    nativeKill,
    processClosed: false,
    statusClosed: false,
    closed: false,
    ready: false,
    residual: false,
    verified: false,
  };
  linuxSubreaperBoundaries.set(child, boundary);
  child.kill = ((signal?: NodeJS.Signals | number): boolean => {
    const translated = normalizeLinuxSubreaperControlSignal(signal);
    if (translated === 0) {
      return nativeKill(0);
    }
    if (
      !boundary.ready &&
      !boundary.processClosed &&
      linuxSubreaperControlSignalPriority(translated) > 0
    ) {
      const pendingPriority =
        boundary.pendingSignal === undefined
          ? 0
          : linuxSubreaperControlSignalPriority(boundary.pendingSignal);
      if (
        boundary.pendingSignal === undefined ||
        linuxSubreaperControlSignalPriority(translated) > pendingPriority
      ) {
        boundary.pendingSignal = translated;
      }
      return true;
    }
    return nativeKill(translated);
  }) as ChildProcessWithoutNullStreams["kill"];
  readableStatus.on("data", (chunk: Buffer) => {
    consumeLinuxSubreaperStatus(boundary, chunk);
  });
  readableStatus.once("error", (error) => {
    boundary.protocolError ??= toError(error);
    consumeBufferedLinuxSubreaperStatus(boundary);
    settleLinuxSubreaperStatus(boundary);
  });
  readableStatus.once("end", () => {
    consumeBufferedLinuxSubreaperStatus(boundary);
    settleLinuxSubreaperStatus(boundary);
  });
  readableStatus.once("close", () => {
    consumeBufferedLinuxSubreaperStatus(boundary);
    settleLinuxSubreaperStatus(boundary);
  });
  child.once("close", () => {
    boundary.processClosed = true;
    boundary.closed = boundary.statusClosed;
  });
  return child;
}

function consumeLinuxSubreaperStatus(
  boundary: LinuxSubreaperBoundary,
  chunk: Buffer,
): void {
  for (const byte of chunk) {
    if (byte === 0x53) {
      if (boundary.ready || boundary.residual || boundary.verified) {
        boundary.protocolError ??= new Error(
          "Linux process containment broker emitted invalid readiness status",
        );
      }
      boundary.ready = true;
      const pendingSignal = boundary.pendingSignal;
      boundary.pendingSignal = undefined;
      if (pendingSignal !== undefined) {
        boundary.nativeKill(pendingSignal);
      }
    } else if (byte === 0x52) {
      if (!boundary.ready) {
        boundary.protocolError ??= new Error(
          "Linux process containment broker emitted residual status before readiness",
        );
      }
      if (boundary.residual || boundary.verified) {
        boundary.protocolError ??= new Error(
          "Linux process containment broker emitted duplicate residual status",
        );
      }
      boundary.residual = true;
    } else if (byte === 0x43) {
      if (!boundary.ready) {
        boundary.protocolError ??= new Error(
          "Linux process containment broker emitted completion status before readiness",
        );
      }
      if (boundary.verified) {
        boundary.protocolError ??= new Error(
          "Linux process containment broker emitted duplicate completion status",
        );
      }
      boundary.verified = true;
    } else {
      boundary.protocolError ??= new Error(
        `Linux process containment broker emitted invalid status byte ${byte}`,
      );
    }
  }
}

function consumeBufferedLinuxSubreaperStatus(
  boundary: LinuxSubreaperBoundary,
): void {
  for (;;) {
    const value: unknown = boundary.status.read();
    if (value === null) return;
    consumeLinuxSubreaperStatus(
      boundary,
      Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array),
    );
  }
}

function linuxSubreaperControlSignalPriority(
  signal: LinuxSubreaperControlSignal,
): number {
  return signal === "SIGUSR2" ? 2 : 1;
}

function normalizeLinuxSubreaperControlSignal(
  signal: NodeJS.Signals | number | undefined,
): LinuxSubreaperControlSignal | 0 {
  if (signal === 0) return 0;
  if (
    signal === undefined ||
    signal === "SIGTERM" ||
    signal === "SIGINT" ||
    signal === 15 ||
    signal === 2
  ) {
    return "SIGTERM";
  }
  if (
    signal === "SIGKILL" ||
    signal === "SIGHUP" ||
    signal === "SIGUSR2" ||
    signal === 9 ||
    signal === 1 ||
    signal === 12
  ) {
    return "SIGUSR2";
  }
  throw new Error(
    "Linux contained-process handles accept only signal 0, " +
      "SIGTERM/SIGINT, or SIGKILL/SIGHUP/SIGUSR2",
  );
}

function settleLinuxSubreaperStatus(boundary: LinuxSubreaperBoundary): void {
  if (boundary.statusClosed) return;
  boundary.statusClosed = true;
  if (!boundary.ready) {
    boundary.protocolError ??= new Error(
      "Linux process containment broker exited before readiness",
    );
  }
  if (!boundary.verified) {
    boundary.protocolError ??= new Error(
      "Linux process containment broker exited without cleanup proof",
    );
  }
  boundary.closed = boundary.processClosed;
}

function resolveLinuxSubreaperBroker(): string {
  if (compiledLinuxSubreaperBroker !== undefined) {
    return compiledLinuxSubreaperBroker;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const bundled = join(moduleDirectory, LINUX_SUBREAPER_BROKER_NAME);
  if (isTrustedLinuxSubreaperBroker(bundled)) {
    compiledLinuxSubreaperBroker = bundled;
    return bundled;
  }

  const sourceCandidates = [
    resolve(moduleDirectory, "../../native/agenc-process-broker.c"),
    resolve(moduleDirectory, "../native/agenc-process-broker.c"),
  ];
  const sourcePath = sourceCandidates.find((candidate) => {
    try {
      return lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (sourcePath === undefined) {
    throw new Error(
      "Linux process containment requires the bundled subreaper broker",
    );
  }
  const compiler = ["/usr/bin/cc", "/bin/cc"].find((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (compiler === undefined) {
    throw new Error(
      "Linux process containment requires a writable cgroup-v2 leaf or " +
        "the bundled subreaper broker; no trusted development compiler was found",
    );
  }

  const buildRoot = mkdtempSync(join(tmpdir(), "agenc-process-broker-"));
  chmodSync(buildRoot, 0o700);
  const outputPath = join(buildRoot, LINUX_SUBREAPER_BROKER_NAME);
  try {
    execFileSync(
      compiler,
      [
        "-O2",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-D_FORTIFY_SOURCE=2",
        "-fstack-protector-strong",
        "-Wl,-z,relro,-z,now",
        "-o",
        outputPath,
        sourcePath,
      ],
      {
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
        stdio: "pipe",
      },
    );
    chmodSync(outputPath, 0o700);
    if (!isTrustedLinuxSubreaperBroker(outputPath)) {
      throw new Error("compiled broker failed executable integrity checks");
    }
  } catch (error) {
    rmSync(buildRoot, { force: true, recursive: true });
    throw new Error(
      `Linux process containment broker build failed: ${toError(error).message}`,
      { cause: error },
    );
  }
  compiledLinuxSubreaperBroker = outputPath;
  compiledLinuxSubreaperBrokerRoot = buildRoot;
  process.once("exit", cleanupCompiledLinuxSubreaperBroker);
  return outputPath;
}

function isTrustedLinuxSubreaperBroker(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
    if ((metadata.mode & 0o022) !== 0) return false;
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      if (metadata.uid !== uid && metadata.uid !== 0) return false;
    }
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function cleanupCompiledLinuxSubreaperBroker(): void {
  if (compiledLinuxSubreaperBrokerRoot === undefined) return;
  rmSync(compiledLinuxSubreaperBrokerRoot, {
    force: true,
    recursive: true,
  });
  compiledLinuxSubreaperBroker = undefined;
  compiledLinuxSubreaperBrokerRoot = undefined;
}

function launchPosixOwnerWatchdog(
  child: ChildProcessWithoutNullStreams,
  gate: Writable,
  gatePayload: string,
  cwd: string,
  cgroupPath: string | null,
): void {
  if (cgroupPath !== null && process.platform === "linux") {
    launchLinuxCgroupOwnerWatchdog(child, gate, gatePayload, cgroupPath);
    return;
  }
  const rootPid = child.pid;
  if (rootPid === undefined || rootPid <= 1) {
    throw new Error("contained process watchdog requires a root pid");
  }
  const config = Buffer.from(
    JSON.stringify({
      ownerPid: process.pid,
      rootPid,
      ...(cgroupPath === null ? {} : { cgroupPath }),
    }),
    "utf8",
  ).toString("base64");
  const watchdog = spawn(
    process.execPath,
    ["-e", POSIX_OWNER_WATCHDOG_SCRIPT],
    {
      cwd,
      env: trustedPosixBootstrapEnvironment({
        AGENC_PROCESS_WATCHDOG_CONFIG: config,
      }),
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      detached: true,
      windowsHide: true,
    },
  );
  posixOwnerWatchdogs.set(child, watchdog);
  const readiness = watchdog.stdio[3];
  if (
    readiness === undefined ||
    readiness === null ||
    typeof readiness === "number" ||
    !("once" in readiness)
  ) {
    safeKill(watchdog, "SIGKILL");
    throw new Error("contained process watchdog readiness FD is unavailable");
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(startupTimer);
    readiness.removeAllListeners();
    watchdog.unref();
    gate.end(gatePayload);
  };
  const fail = (): void => {
    if (released) return;
    released = true;
    clearTimeout(startupTimer);
    readiness.removeAllListeners();
    safeKill(child, "SIGKILL");
    gate.destroy();
  };
  const startupTimer = setTimeout(fail, 2_000);
  startupTimer.unref?.();
  readiness.once("data", release);
  readiness.once("error", fail);
  watchdog.once("error", fail);
  watchdog.once("exit", () => {
    if (!released) fail();
  });
}

/**
 * Register a Linux cgroup with one lightweight watchdog per owner process.
 *
 * The registration pipe is both the command channel and the ownership lease:
 * an owner crash closes it in the kernel, at which point the detached Bash
 * process kills every still-registered cgroup. Unlike the fallback POSIX
 * watchdog, it does not need a Node runtime or a continuously spawned `ps`
 * poller for each supervised command.
 */
function launchLinuxCgroupOwnerWatchdog(
  child: ChildProcessWithoutNullStreams,
  gate: Writable,
  gatePayload: string,
  cgroupPath: string,
): void {
  const state = getLinuxCgroupOwnerWatchdog();
  const id = `${process.pid}-${++linuxCgroupWatchdogRegistrationSequence}`;
  const timer = setTimeout(() => {
    failLinuxCgroupWatchdogRegistration(
      state,
      id,
      new Error(
        `contained process watchdog registration timed out for ${cgroupPath}`,
      ),
    );
  }, 2_000);
  timer.unref?.();
  state.pending.set(id, { child, gate, gatePayload, timer });
  linuxCgroupWatchdogRegistrations.set(child, { state, id });

  state.child.stdin.write(`ADD ${id} ${cgroupPath}\n`, (error) => {
    if (error) failLinuxCgroupWatchdogRegistration(state, id, error);
  });
}

function getLinuxCgroupOwnerWatchdog(): LinuxCgroupWatchdogState {
  if (
    linuxCgroupOwnerWatchdog !== null &&
    !linuxCgroupOwnerWatchdog.failed &&
    linuxCgroupOwnerWatchdog.child.exitCode === null &&
    linuxCgroupOwnerWatchdog.child.signalCode === null
  ) {
    return linuxCgroupOwnerWatchdog;
  }

  const child = spawn(
    "/bin/bash",
    ["-c", LINUX_CGROUP_OWNER_WATCHDOG_SCRIPT, "agenc-cgroup-owner-watchdog"],
    {
      cwd: "/",
      // This is a trusted ownership boundary, not part of the supervised
      // command. Do not let command-provided BASH_ENV/SHELLOPTS hooks alter it.
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    },
  );
  const state: LinuxCgroupWatchdogState = {
    child,
    pending: new Map(),
    active: new Map(),
    stdoutBuffer: "",
    failed: false,
  };
  linuxCgroupOwnerWatchdog = state;
  child.unref();
  unrefProcessPipe(child.stdin);
  unrefProcessPipe(child.stdout);
  unrefProcessPipe(child.stderr);
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    handleLinuxCgroupWatchdogOutput(state, chunk);
  });
  child.stdin.on("error", (error) => {
    failLinuxCgroupOwnerWatchdog(state, error);
  });
  child.once("error", (error) => {
    failLinuxCgroupOwnerWatchdog(state, error);
  });
  child.once("exit", (code, signal) => {
    failLinuxCgroupOwnerWatchdog(
      state,
      new Error(
        "contained process watchdog exited unexpectedly" +
          (code === null
            ? ` (signal ${signal ?? "unknown"})`
            : ` (exit ${code})`),
      ),
    );
  });
  return state;
}

function handleLinuxCgroupWatchdogOutput(
  state: LinuxCgroupWatchdogState,
  chunk: string,
): void {
  if (state.failed) return;
  state.stdoutBuffer += chunk;
  while (true) {
    const newline = state.stdoutBuffer.indexOf("\n");
    if (newline < 0) return;
    const line = state.stdoutBuffer.slice(0, newline).trim();
    state.stdoutBuffer = state.stdoutBuffer.slice(newline + 1);
    const match = /^READY ([1-9]\d*-[1-9]\d*)$/u.exec(line);
    if (match === null) {
      failLinuxCgroupOwnerWatchdog(
        state,
        new Error(
          `contained process watchdog emitted invalid response: ${line}`,
        ),
      );
      return;
    }
    const id = match[1]!;
    const pending = state.pending.get(id);
    if (pending === undefined) continue;
    state.pending.delete(id);
    clearTimeout(pending.timer);
    state.active.set(id, pending.child);
    pending.gate.end(pending.gatePayload);
  }
}

function failLinuxCgroupWatchdogRegistration(
  state: LinuxCgroupWatchdogState,
  id: string,
  _error: unknown,
): void {
  const pending = state.pending.get(id);
  if (pending === undefined) return;
  state.pending.delete(id);
  clearTimeout(pending.timer);
  linuxCgroupWatchdogRegistrations.delete(pending.child);
  const boundary = linuxCgroupBoundaries.get(pending.child);
  if (boundary !== undefined) signalLinuxCgroup(boundary, "SIGKILL");
  safeKill(pending.child, "SIGKILL");
  pending.gate.destroy();
  if (!state.failed) {
    state.child.stdin.write(`REMOVE ${id}\n`, () => {});
  }
}

function failLinuxCgroupOwnerWatchdog(
  state: LinuxCgroupWatchdogState,
  _error: unknown,
): void {
  if (state.failed) return;
  state.failed = true;
  if (linuxCgroupOwnerWatchdog === state) {
    linuxCgroupOwnerWatchdog = null;
  }
  for (const id of [...state.pending.keys()]) {
    failLinuxCgroupWatchdogRegistration(state, id, _error);
  }
  for (const [id, child] of state.active) {
    linuxCgroupWatchdogRegistrations.delete(child);
    const boundary = linuxCgroupBoundaries.get(child);
    if (boundary !== undefined) signalLinuxCgroup(boundary, "SIGKILL");
    safeKill(child, "SIGKILL");
    state.active.delete(id);
  }
}

function unregisterLinuxCgroupOwnerWatchdog(child: object): void {
  const registration = linuxCgroupWatchdogRegistrations.get(child);
  if (registration === undefined) return;
  linuxCgroupWatchdogRegistrations.delete(child);
  const { state, id } = registration;
  const pending = state.pending.get(id);
  if (pending !== undefined) {
    state.pending.delete(id);
    clearTimeout(pending.timer);
    pending.gate.destroy();
  }
  state.active.delete(id);
  if (!state.failed) {
    state.child.stdin.write(`REMOVE ${id}\n`, () => {});
  }
}

function unrefProcessPipe(pipe: object): void {
  const candidate = pipe as { readonly unref?: () => void };
  candidate.unref?.();
}

function resolveWindowsJobBroker(): string {
  if (compiledWindowsJobBroker !== undefined) {
    if (isTrustedWindowsJobBroker(compiledWindowsJobBroker)) {
      return compiledWindowsJobBroker;
    }
    cleanupCompiledWindowsJobBroker();
  }

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const bundledCandidates = [
    join(moduleDirectory, WINDOWS_JOB_BROKER_NAME),
    resolve(moduleDirectory, "..", WINDOWS_JOB_BROKER_NAME),
    // Vitest imports this source module directly after the hosted lane builds
    // production dist. Exercise that exact precompiled helper instead of the
    // source-only compiler fallback.
    resolve(moduleDirectory, "../../dist", WINDOWS_JOB_BROKER_NAME),
  ];
  const bundled = bundledCandidates.find(isTrustedWindowsJobBroker);
  if (bundled !== undefined) {
    compiledWindowsJobBroker = bundled;
    return bundled;
  }

  const sourceCandidates = [
    resolve(moduleDirectory, "../../native/agenc-process-job-broker.cs"),
    resolve(moduleDirectory, "../native/agenc-process-job-broker.cs"),
  ];
  const sourcePath = sourceCandidates.find(isTrustedRegularFile);
  if (sourcePath === undefined) {
    throw new Error(
      "Windows process containment requires the bundled Job Object broker",
    );
  }
  const compilers = trustedWindowsCSharpCompilerCandidates();
  if (compilers.length === 0) {
    throw new Error(
      "Windows process containment requires the bundled Job Object broker; " +
        "no trusted development C# compiler was found",
    );
  }

  const buildRoot = mkdtempSync(join(tmpdir(), "agenc-process-job-broker-"));
  chmodSync(buildRoot, 0o700);
  const outputPath = join(buildRoot, WINDOWS_JOB_BROKER_NAME);
  const sourceRoot = resolve(dirname(sourcePath), "..");
  const errors: string[] = [];
  try {
    for (const compiler of compilers) {
      const compilerProfiles = [
        ["/deterministic+", `/pathmap:${sourceRoot}=.`],
        [],
      ] as const;
      for (const profile of compilerProfiles) {
        try {
          execFileSync(
            compiler,
            [
              "/nologo",
              "/target:exe",
              "/optimize+",
              "/checked+",
              ...profile,
              `/out:${outputPath}`,
              sourcePath,
            ],
            {
              cwd: sourceRoot,
              env: {
                ...process.env,
                DOTNET_CLI_TELEMETRY_OPTOUT: "1",
                DOTNET_NOLOGO: "1",
              },
              stdio: "pipe",
              windowsHide: true,
            },
          );
          chmodSync(outputPath, 0o500);
          if (!isTrustedWindowsJobBroker(outputPath)) {
            throw new Error(
              "compiled broker failed executable integrity checks",
            );
          }
          compiledWindowsJobBroker = outputPath;
          compiledWindowsJobBrokerRoot = buildRoot;
          process.once("exit", cleanupCompiledWindowsJobBroker);
          return outputPath;
        } catch (error) {
          rmSync(outputPath, { force: true });
          errors.push(`${compiler}: ${toError(error).message}`);
        }
      }
    }
  } catch (error) {
    rmSync(buildRoot, { force: true, recursive: true });
    throw error;
  }
  rmSync(buildRoot, { force: true, recursive: true });
  throw new Error(
    `Windows process containment broker build failed:\n${errors.join("\n")}`,
  );
}

function trustedWindowsCSharpCompilerCandidates(): string[] {
  const candidates: string[] = [];
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const programFiles = process.env.ProgramFiles;
  const visualStudioRoots = [programFilesX86, programFiles].filter(
    (value): value is string => Boolean(value),
  );
  if (programFilesX86) {
    const vswhere = resolve(
      programFilesX86,
      "Microsoft Visual Studio/Installer/vswhere.exe",
    );
    if (isTrustedWindowsTool(vswhere, visualStudioRoots)) {
      try {
        const output = execFileSync(
          vswhere,
          [
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.Component.MSBuild",
            "-find",
            "MSBuild\\**\\Bin\\Roslyn\\csc.exe",
          ],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
          },
        );
        for (const line of output.split(/\r?\n/u)) {
          const candidate = line.trim();
          if (candidate && isTrustedWindowsTool(candidate, visualStudioRoots)) {
            candidates.push(candidate);
          }
        }
      } catch {
        // The fixed .NET Framework compiler candidates remain available.
      }
    }
  }

  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot) {
    for (const relativePath of [
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      "Microsoft.NET/Framework/v4.0.30319/csc.exe",
    ]) {
      const candidate = resolve(systemRoot, relativePath);
      if (isTrustedWindowsTool(candidate, [systemRoot])) {
        candidates.push(candidate);
      }
    }
  }
  return [...new Set(candidates)];
}

function isTrustedWindowsTool(
  path: string,
  trustedRoots: readonly string[],
): boolean {
  if (!isRegularNonSymlinkFile(path)) return false;
  const resolvedPath = resolve(path);
  return trustedRoots.some((root) => {
    const rel = relative(resolve(root), resolvedPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function isRegularNonSymlinkFile(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function isTrustedRegularFile(path: string): boolean {
  if (!isRegularNonSymlinkFile(path)) return false;
  try {
    const metadata = lstatSync(path);
    return process.platform === "win32" || (metadata.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function isTrustedWindowsJobBroker(path: string): boolean {
  if (!isTrustedRegularFile(path)) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function cleanupCompiledWindowsJobBroker(): void {
  const buildRoot = compiledWindowsJobBrokerRoot;
  compiledWindowsJobBroker = undefined;
  compiledWindowsJobBrokerRoot = undefined;
  if (buildRoot === undefined) return;
  rmSync(buildRoot, {
    force: true,
    recursive: true,
  });
}

function spawnWindowsJobContainedProcess(
  program: string,
  args: readonly string[],
  options: ContainedProcessSpawnOptions,
): ChildProcessWithoutNullStreams {
  const broker = resolveWindowsJobBroker();
  const commandLine = [options.argv0 ?? program, ...args]
    .map(quoteWindowsCommandLineArgument)
    .join(" ");
  const env = {
    ...options.env,
    AGENC_PROCESS_JOB_PROGRAM: Buffer.from(program, "utf8").toString("base64"),
    AGENC_PROCESS_JOB_COMMAND_LINE: Buffer.from(commandLine, "utf8").toString(
      "base64",
    ),
    AGENC_PROCESS_JOB_OWNER_PID: String(process.pid),
  };
  const child = spawn(broker, [], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  windowsJobBoundaries.add(child);
  return child;
}

/** Quote one argument exactly as libuv does before `CreateProcessW`. */
export function quoteWindowsCommandLineArgument(value: string): string {
  let needsQuotes = value.length === 0;
  for (let index = 0; index < value.length && !needsQuotes; index += 1) {
    const codeUnit = value.charCodeAt(index);
    needsQuotes =
      codeUnit === WINDOWS_COMMAND_LINE_SPACE_CODE_UNIT ||
      codeUnit === WINDOWS_COMMAND_LINE_TAB_CODE_UNIT ||
      codeUnit === WINDOWS_COMMAND_LINE_QUOTE_CODE_UNIT;
  }
  if (!needsQuotes) return value;

  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character.charCodeAt(0) === WINDOWS_COMMAND_LINE_BACKSLASH_CODE_UNIT) {
      backslashes += 1;
      continue;
    }
    if (character.charCodeAt(0) === WINDOWS_COMMAND_LINE_QUOTE_CODE_UNIT) {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    backslashes = 0;
    quoted += character;
  }
  quoted += "\\".repeat(backslashes * 2);
  return `${quoted}"`;
}

/** Count the exact UTF-16 command line, including separators and final NUL. */
export function windowsCommandLineUtf16CodeUnits(
  executable: string,
  args: readonly string[],
): number {
  return (
    [executable, ...args].map(quoteWindowsCommandLineArgument).join(" ")
      .length + 1
  );
}

/** Run a native helper with bounded output and process-tree cleanup. */
export function runSupervisedProcess(
  command: SupervisedProcessCommand,
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  validateLimits(options);
  if (options.signal?.aborted === true) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stopReason: "aborted",
      forced: false,
      backstopExpired: false,
    });
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnContainedProcess(command.program, command.args, {
        cwd: command.cwd,
        env: command.env,
        ...(command.argv0 !== undefined ? { argv0: command.argv0 } : {}),
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stopReason: "spawn_error",
        forced: false,
        backstopExpired: false,
        error: toError(error),
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stopReason: SupervisedProcessStopReason | undefined;
    let forced = false;
    let settled = false;
    let closed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let processError: Error | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let backstopTimer: ReturnType<typeof setTimeout> | undefined;
    let treeExitTimer: ReturnType<typeof setInterval> | undefined;

    const control: SupervisedProcessControl = {
      stop: () => requestStop("consumer_limit"),
    };

    const append = (
      target: Buffer[],
      chunk: Buffer,
      callback: SupervisedProcessOptions["onStdout"],
      capture: boolean,
    ): void => {
      if (settled || processError !== undefined) {
        return;
      }
      if (!capture) {
        if (stopReason !== undefined) return;
        try {
          callback?.(chunk, control);
        } catch (error) {
          processError ??= toError(error);
          requestStop("consumer_limit");
        }
        return;
      }
      const remaining = options.maxOutputBytes - outputBytes;
      const accepted =
        remaining > 0
          ? chunk.subarray(0, Math.min(chunk.byteLength, remaining))
          : Buffer.alloc(0);
      if (accepted.byteLength > 0) {
        target.push(accepted);
        outputBytes += accepted.byteLength;
        if (stopReason === undefined) {
          try {
            callback?.(accepted, control);
          } catch (error) {
            processError ??= toError(error);
            requestStop("consumer_limit");
          }
        }
      }
      if (accepted.byteLength < chunk.byteLength) requestStop("output_limit");
    };

    const finish = (backstopExpired: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (backstopTimer !== undefined) clearTimeout(backstopTimer);
      if (treeExitTimer !== undefined) clearInterval(treeExitTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      const brokerBoundary = linuxSubreaperBoundaries.get(child);
      if (brokerBoundary?.protocolError !== undefined) {
        processError ??= brokerBoundary.protocolError;
      }
      void releaseLinuxCgroupBoundary(child)
        .catch((error) => {
          processError ??= toError(error);
        })
        .then(() => {
          resolve({
            exitCode,
            signal: exitSignal,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            ...(stopReason !== undefined ? { stopReason } : {}),
            forced,
            backstopExpired,
            ...(processError !== undefined ? { error: processError } : {}),
          });
        });
    };

    const maybeFinish = (): void => {
      if (!closed) return;
      if (stopReason !== undefined && isProcessTreeAlive(child)) return;
      finish(false);
    };

    function requestStop(reason: SupervisedProcessStopReason): void {
      stopReason ??= reason;
      // Unblock a pending stdin write before waiting on process-tree cleanup.
      // This is idempotent for the common no-input path, whose stdin was
      // already ended immediately after spawn.
      child.stdin.destroy();
      signalProcessTree(child, "SIGTERM");
      treeExitTimer ??= setInterval(
        () => maybeFinish(),
        PROCESS_TREE_POLL_INTERVAL_MS,
      );
      treeExitTimer.unref?.();
      if (forceTimer !== undefined) return;
      forceTimer = setTimeout(() => {
        if (!isProcessTreeAlive(child)) {
          maybeFinish();
          return;
        }
        forced = true;
        signalProcessTree(child, "SIGKILL");
        maybeFinish();
        backstopTimer = setTimeout(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          finish(true);
        }, options.settleBackstopMs ?? DEFAULT_SETTLE_BACKSTOP_MS);
        backstopTimer.unref?.();
      }, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);
      forceTimer.unref?.();
    }

    const onAbort = (): void => requestStop("aborted");
    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(
        () => requestStop("timeout"),
        options.timeoutMs,
      );
      timeoutTimer.unref?.();
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort may race the pre-spawn check and listener installation.
    if (options.signal?.aborted === true) onAbort();

    child.stdout.on("data", (chunk: Buffer) =>
      append(stdout, chunk, options.onStdout, options.captureStdout !== false),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      append(stderr, chunk, options.onStderr, true),
    );
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Search helpers such as `rg -l -` may deliberately stop reading once
      // they have a conclusive answer. Their early close can race a final
      // stdin write and surface EPIPE even though the process result is valid.
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
        return;
      }
      processError ??= error;
      requestStop("spawn_error");
    });
    child.stdin.end(options.stdin);
    child.once("error", (error) => {
      processError ??= error;
      requestStop("spawn_error");
      closed = true;
      maybeFinish();
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      closed = true;
      if (stopReason === undefined) {
        if (linuxSubreaperBoundaries.get(child)?.residual === true) {
          stopReason = "residual_process";
        } else if (isProcessTreeAlive(child)) {
          requestStop("residual_process");
        }
      }
      maybeFinish();
    });
  });
}

function validateLimits(options: SupervisedProcessOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error("supervised process timeoutMs must be finite and positive");
  }
  if (!Number.isFinite(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    throw new Error(
      "supervised process maxOutputBytes must be finite and positive",
    );
  }
  if (options.captureStdout === false && options.onStdout === undefined) {
    throw new Error(
      "supervised process captureStdout=false requires an onStdout consumer",
    );
  }
}

export function isProcessTreeAlive(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
): boolean {
  // PID 1 is never a valid child-process ownership root. On POSIX,
  // `kill(-1, signal)` broadcasts to every process the caller may signal, and
  // walking `/proc/1` adopts the whole container/host namespace. Apply the
  // guard before every native ownership boundary so corrupt handles remain
  // direct-child-only on every platform.
  if (child.pid !== undefined && child.pid <= 1) {
    return child.exitCode === null && child.signalCode === null;
  }
  if (linuxSubreaperBoundaries.has(child)) {
    return linuxSubreaperBoundaries.get(child)!.closed === false;
  }
  if (windowsJobBoundaries.has(child)) {
    return child.exitCode === null && child.signalCode === null;
  }
  const cgroupBoundary = linuxCgroupBoundaries.get(child);
  if (cgroupBoundary !== undefined) {
    const populated = linuxCgroupIsPopulated(cgroupBoundary.path);
    if (populated !== null) return populated;
    return true;
  }
  if (child.pid === undefined || process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  if (!linuxCgroupBoundaries.has(child)) {
    captureProcessTreeDescendants(child);
  }
  const ownedDescendantAlive = ownedBoundaryHasLiveMember(child);
  if (process.platform === "linux") {
    const procState = linuxProcessGroupHasLiveMember(child.pid);
    if (procState === true) return true;
    // ChildProcess state can briefly lead /proc during process reaping. Treat
    // a leader which Node still reports as live as live, too, so teardown
    // fails closed instead of accepting a transiently empty process group.
    if (procState === false) {
      return (
        ownedDescendantAlive ||
        (child.exitCode === null && child.signalCode === null)
      );
    }
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return ownedDescendantAlive;
  }
}

/**
 * Capture the currently observable native parent/child boundary before its
 * leader exits. Retained start identities prevent recycled PIDs from being
 * adopted by a later cleanup pass. Repeated calls extend the observed set
 * while PPID links remain visible; they cannot reconstruct a Darwin
 * fork/setsid/reparent chain completed entirely between snapshots.
 */
export function captureProcessTreeDescendants(
  child: Pick<ChildProcess, "pid">,
): void {
  const rootPid = child.pid;
  if (
    rootPid === undefined ||
    rootPid <= 1 ||
    process.platform === "win32" ||
    linuxSubreaperBoundaries.has(child)
  ) {
    return;
  }

  const snapshot = readNativeProcessSnapshot();
  let boundary = ownedProcessBoundaries.get(child);
  if (snapshot === undefined) {
    boundary ??= {
      rootPid,
      identities: new Map(),
      current: new Map(),
      snapshotComplete: false,
      overflowed: false,
    };
    boundary.current = new Map();
    boundary.snapshotComplete = false;
    ownedProcessBoundaries.set(child, boundary);
    return;
  }

  if (boundary === undefined) {
    const root = snapshot.records.get(rootPid);
    if (root === undefined && snapshot.complete) return;
    boundary = {
      rootPid,
      identities: new Map(),
      current: new Map(),
      snapshotComplete: snapshot.complete,
      overflowed: false,
    };
    ownedProcessBoundaries.set(child, boundary);
  } else if (!snapshot.complete) {
    boundary.snapshotComplete = false;
  }
  extendOwnedProcessBoundary(boundary, snapshot);
}

/**
 * Stop a session-long platform process scope and verify the cleanup guarantee
 * that platform supports. Linux cgroups/subreapers and Windows Job Objects
 * cover recursive descendants. Darwin covers the original process group and
 * descendants whose PID/start identities were observed before reparenting.
 */
export async function terminateProcessTreeAndWait(
  child: ProcessTreeChild,
  options: TerminateProcessTreeOptions = {},
): Promise<void> {
  // Never pass an invalid synthetic root to taskkill, a Job Object, a cgroup,
  // process-table discovery, or POSIX negative-PID signalling.
  if (child.pid !== undefined && child.pid <= 1) {
    if (!isProcessTreeAlive(child)) return;
    safeKill(child, "SIGTERM");
    if (
      await waitForProcessTreeExit(
        child,
        options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      )
    ) {
      return;
    }
    safeKill(child, "SIGKILL");
    if (
      await waitForProcessTreeExit(
        child,
        options.killGraceMs ?? DEFAULT_SETTLE_BACKSTOP_MS,
      )
    ) {
      return;
    }
    throw new Error(
      `${options.label ?? "process"} invalid process root survived forced shutdown`,
    );
  }
  if (windowsJobBoundaries.has(child)) {
    if (!isProcessTreeAlive(child)) return;
    safeKill(child, "SIGTERM");
    if (
      await waitForProcessTreeExit(
        child,
        options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      )
    ) {
      return;
    }
    safeKill(child, "SIGKILL");
    if (
      await waitForProcessTreeExit(
        child,
        options.killGraceMs ?? DEFAULT_SETTLE_BACKSTOP_MS,
      )
    ) {
      return;
    }
    throw new Error(
      `${options.label ?? "process"} Windows Job Object broker survived forced shutdown`,
    );
  }
  // A Windows ChildProcess only reports the leader's state. Once that leader
  // exits, Node has no API with which to enumerate (or prove the absence of)
  // descendants. `taskkill /T` is therefore the ownership boundary: await its
  // result even when `exitCode` already says the leader is gone, and never
  // infer tree cleanup from the leader alone.
  if (process.platform === "win32" && child.pid !== undefined) {
    await terminateWindowsProcessTree(child.pid, options);
    return;
  }
  if (!linuxCgroupBoundaries.has(child)) {
    captureProcessTreeDescendants(child);
  }
  if (!isProcessTreeAlive(child)) {
    assertObservedBoundarySnapshotUsable(child, options.label ?? "process");
    await releaseLinuxCgroupBoundary(child);
    return;
  }
  signalProcessTree(child, "SIGTERM");
  if (
    await waitForProcessTreeExit(
      child,
      options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    )
  ) {
    assertObservedBoundarySnapshotUsable(child, options.label ?? "process");
    await releaseLinuxCgroupBoundary(child);
    return;
  }
  signalProcessTree(child, "SIGKILL");
  if (
    await waitForProcessTreeExit(
      child,
      options.killGraceMs ?? DEFAULT_SETTLE_BACKSTOP_MS,
    )
  ) {
    assertObservedBoundarySnapshotUsable(child, options.label ?? "process");
    await releaseLinuxCgroupBoundary(child);
    return;
  }
  const survivors = liveOwnedBoundaryPids(child)
    .filter((pid) => pid !== child.pid)
    .slice(0, 8);
  throw new Error(
    `${options.label ?? "process"} tree survived forced shutdown` +
      (child.pid === undefined ? "" : ` (pid ${child.pid})`) +
      (survivors.length === 0
        ? ""
        : `; live descendants: ${survivors.join(", ")}`),
  );
}

async function terminateWindowsProcessTree(
  pid: number,
  options: TerminateProcessTreeOptions,
): Promise<void> {
  const taskkill = windowsTaskkillPath();
  const label = options.label ?? "process";
  if (taskkill === undefined) {
    throw new Error(
      `${label} tree cleanup cannot be verified: taskkill.exe is unavailable (pid ${pid})`,
    );
  }

  let gracefulError: Error;
  try {
    await runWindowsTaskkill(
      taskkill,
      pid,
      false,
      options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    );
    return;
  } catch (error) {
    gracefulError = toError(error);
  }

  try {
    await runWindowsTaskkill(
      taskkill,
      pid,
      true,
      options.killGraceMs ?? DEFAULT_SETTLE_BACKSTOP_MS,
    );
  } catch (error) {
    throw new AggregateError(
      [gracefulError, toError(error)],
      `${label} tree cleanup could not be verified by taskkill /T (pid ${pid})`,
    );
  }
}

function runWindowsTaskkill(
  taskkill: string,
  pid: number,
  force: boolean,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.reject(
      new Error("Windows process tree timeout must be finite and non-negative"),
    );
  }

  return new Promise<void>((resolve, reject) => {
    let killer: ChildProcess;
    try {
      killer = spawn(
        taskkill,
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
    } catch (error) {
      reject(toError(error));
      return;
    }

    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.removeAllListeners();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      safeKill(killer, "SIGKILL");
      settle(
        new Error(
          `taskkill ${force ? "/T /F" : "/T"} timed out for pid ${pid}`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    killer.once("error", (error) => settle(error));
    killer.once("close", (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      settle(
        new Error(
          `taskkill ${force ? "/T /F" : "/T"} failed for pid ${pid}` +
            (code === null
              ? ` (signal ${signal ?? "unknown"})`
              : ` (exit ${code})`),
        ),
      );
    });
  });
}

function createPrivateLinuxCgroup(): string | null {
  let currentPath: string | undefined;
  try {
    const membership = readFileSync("/proc/self/cgroup", "utf8")
      .split(/\r?\n/u)
      .find((line) => line.startsWith("0::"));
    if (membership === undefined) return null;
    const relativeMembership = membership.slice(3);
    if (
      !relativeMembership.startsWith("/") ||
      relativeMembership.includes("\0")
    ) {
      return null;
    }
    const cgroupRoot = resolve("/sys/fs/cgroup");
    const current = resolve(cgroupRoot, `.${relativeMembership}`);
    if (current !== cgroupRoot && !current.startsWith(`${cgroupRoot}/`)) {
      return null;
    }
    currentPath = join(
      current,
      `agenc-process-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(currentPath, { mode: 0o700 });
    if (
      !existsSync(join(currentPath, "cgroup.procs")) ||
      !existsSync(join(currentPath, "cgroup.events")) ||
      !existsSync(join(currentPath, "cgroup.kill"))
    ) {
      removeEmptyLinuxCgroup(currentPath);
      return null;
    }
    return currentPath;
  } catch {
    if (currentPath !== undefined) removeEmptyLinuxCgroup(currentPath);
    return null;
  }
}

function linuxCgroupIsPopulated(path: string): boolean | null {
  try {
    const events = readFileSync(join(path, "cgroup.events"), "utf8");
    const match = /(?:^|\n)populated ([01])(?:\n|$)/u.exec(events);
    return match === null ? null : match[1] === "1";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return null;
  }
}

function signalLinuxCgroup(
  boundary: LinuxCgroupBoundary,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (signal === "SIGKILL") {
    try {
      writeFileSync(join(boundary.path, "cgroup.kill"), "1\n");
    } catch {
      // Teardown remains fail-closed: the populated record is checked before
      // this boundary is released.
    }
    return;
  }
  let pids: number[];
  try {
    pids = readFileSync(join(boundary.path, "cgroup.procs"), "utf8")
      .split(/\s+/u)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter(
        (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid,
      );
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // The kernel cgroup membership check decides whether teardown is done.
    }
  }
}

async function releaseLinuxCgroupBoundary(child: object): Promise<void> {
  const boundary = linuxCgroupBoundaries.get(child);
  if (boundary === undefined || boundary.released) return;
  const populated = linuxCgroupIsPopulated(boundary.path);
  if (populated !== false) {
    throw new Error(
      `process containment cleanup cannot be verified for cgroup ${boundary.path}`,
    );
  }
  const deadline = Date.now() + DEFAULT_SETTLE_BACKSTOP_MS;
  do {
    if (removeEmptyLinuxCgroup(boundary.path)) {
      boundary.released = true;
      linuxCgroupBoundaries.delete(child);
      unregisterLinuxCgroupOwnerWatchdog(child);
      return;
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, PROCESS_TREE_POLL_INTERVAL_MS);
    });
  } while (
    Date.now() < deadline &&
    linuxCgroupIsPopulated(boundary.path) === false
  );
  throw new Error(
    `process containment cleanup could not remove empty cgroup ${boundary.path}`,
  );
}

function removeEmptyLinuxCgroup(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch {
    if (!existsSync(path)) return true;
    // A populated cgroup is intentionally retained rather than recursively
    // deleting an ownership record that still contains live processes.
    return false;
  }
}

function readNativeProcessSnapshot(): NativeProcessSnapshot | undefined {
  return process.platform === "linux"
    ? readLinuxProcessSnapshot()
    : readPsProcessSnapshot();
}

function readLinuxProcessSnapshot(): NativeProcessSnapshot | undefined {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }

  const records = new Map<number, NativeProcessRecord>();
  let complete = true;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    if (records.size >= MAX_PROCESS_TABLE_RECORDS) {
      complete = false;
      break;
    }

    let stat: string;
    try {
      stat = readFileSync(join("/proc", entry, "stat"), "utf8");
    } catch (error) {
      if (!isMissingProcessError(error)) complete = false;
      continue;
    }
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) {
      complete = false;
      continue;
    }
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const pid = Number.parseInt(entry, 10);
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    const state = fields[0];
    const startTime = fields[19];
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      state === undefined ||
      startTime === undefined
    ) {
      complete = false;
      continue;
    }
    records.set(pid, {
      pid,
      ppid,
      state,
      startToken: `linux:${startTime}`,
    });
  }
  return { records, complete };
}

function readPsProcessSnapshot(): NativeProcessSnapshot | undefined {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,state=,lstart="], {
    encoding: "utf8",
    maxBuffer: MAX_PROCESS_TABLE_BYTES,
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== "string"
  ) {
    return undefined;
  }

  const records = new Map<number, NativeProcessRecord>();
  let complete = true;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    if (records.size >= MAX_PROCESS_TABLE_RECORDS) {
      complete = false;
      break;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match === null) {
      complete = false;
      continue;
    }
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0
    ) {
      complete = false;
      continue;
    }
    records.set(pid, {
      pid,
      ppid,
      state: match[3]!,
      startToken: `ps:${match[4]!}`,
    });
  }
  return { records, complete };
}

function extendOwnedProcessBoundary(
  boundary: OwnedProcessBoundary,
  snapshot: NativeProcessSnapshot,
): void {
  const root = snapshot.records.get(boundary.rootPid);
  if (boundary.identities.size === 0 && root !== undefined) {
    boundary.identities.set(nativeProcessIdentity(root), root);
  }

  const current = new Map<number, NativeProcessRecord>();
  for (const record of snapshot.records.values()) {
    if (boundary.identities.has(nativeProcessIdentity(record))) {
      current.set(record.pid, record);
    }
  }

  const childrenByParent = new Map<number, NativeProcessRecord[]>();
  for (const record of snapshot.records.values()) {
    const siblings = childrenByParent.get(record.ppid);
    if (siblings === undefined) childrenByParent.set(record.ppid, [record]);
    else siblings.push(record);
  }

  const queue = [...current.keys()];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    if (visited.has(parentPid)) continue;
    visited.add(parentPid);
    for (const record of childrenByParent.get(parentPid) ?? []) {
      const identity = nativeProcessIdentity(record);
      if (!boundary.identities.has(identity)) {
        if (boundary.identities.size >= MAX_OWNED_PROCESS_IDENTITIES) {
          boundary.overflowed = true;
          continue;
        }
        boundary.identities.set(identity, record);
      }
      current.set(record.pid, record);
      queue.push(record.pid);
    }
  }
  boundary.current = current;
}

function nativeProcessIdentity(record: NativeProcessRecord): string {
  return `${record.pid}:${record.startToken}`;
}

function ownedBoundaryHasLiveMember(child: object): boolean {
  return liveOwnedBoundaryPids(child).length > 0;
}

function liveOwnedBoundaryPids(child: object): number[] {
  const boundary = ownedProcessBoundaries.get(child);
  if (boundary === undefined) return [];
  return [...boundary.current.values()]
    .filter(isLiveNativeProcess)
    .map((record) => record.pid);
}

function isLiveNativeProcess(record: NativeProcessRecord): boolean {
  return (
    record.state === null ||
    (!record.state.startsWith("Z") && !record.state.startsWith("X"))
  );
}

function assertObservedBoundarySnapshotUsable(
  child: object,
  label: string,
): void {
  const brokerBoundary = linuxSubreaperBoundaries.get(child);
  if (brokerBoundary?.protocolError !== undefined) {
    throw new Error(
      `${label} Linux subreaper cleanup could not be verified: ` +
        brokerBoundary.protocolError.message,
      { cause: brokerBoundary.protocolError },
    );
  }
  if (
    brokerBoundary !== undefined &&
    (!brokerBoundary.closed ||
      !brokerBoundary.ready ||
      !brokerBoundary.verified)
  ) {
    throw new Error(
      `${label} Linux subreaper cleanup could not be verified: ` +
        "cleanup proof is incomplete",
    );
  }
  const boundary = ownedProcessBoundaries.get(child);
  if (boundary === undefined) return;
  if (boundary.overflowed) {
    throw new Error(
      `${label} observed-descendant cleanup scope exceeded ` +
        `${MAX_OWNED_PROCESS_IDENTITIES} processes (pid ${boundary.rootPid})`,
    );
  }
  if (!boundary.snapshotComplete) {
    throw new Error(
      `${label} observed-descendant cleanup could not verify its process-table ` +
        `snapshot (pid ${boundary.rootPid})`,
    );
  }
}

function isMissingProcessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

export async function waitForProcessTreeExit(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(
      "process tree wait timeoutMs must be finite and non-negative",
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeAlive(child)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remaining));
    });
  }
  return true;
}

/** `kill(-pgid, 0)` counts zombies; they cannot execute and need no signal. */
function linuxProcessGroupHasLiveMember(pgid: number): boolean | undefined {
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = readFileSync(join("/proc", entry, "stat"), "utf8");
      } catch {
        continue;
      }
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) continue;
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      const state = fields[0];
      const processGroup = Number.parseInt(fields[2] ?? "", 10);
      if (processGroup === pgid && state !== "Z" && state !== "X") return true;
    }
    return false;
  } catch {
    return undefined;
  }
}

export function signalProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (child.pid !== undefined && child.pid <= 1) {
    safeKill(child, signal);
    return;
  }
  if (linuxSubreaperBoundaries.has(child)) {
    safeKill(child, signal === "SIGKILL" ? "SIGUSR2" : signal);
    return;
  }
  if (windowsJobBoundaries.has(child)) {
    safeKill(child, signal);
    return;
  }
  const cgroupBoundary = linuxCgroupBoundaries.get(child);
  if (cgroupBoundary !== undefined) {
    signalLinuxCgroup(cgroupBoundary, signal);
    return;
  }
  if (child.pid === undefined) {
    safeKill(child, signal);
    return;
  }
  if (process.platform !== "win32") {
    captureProcessTreeDescendants(child);
    signalOwnedDescendants(child, signal);
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      safeKill(child, signal);
      return;
    }
  }
  const taskkill = windowsTaskkillPath();
  if (taskkill === undefined) {
    safeKill(child, signal);
    return;
  }
  const killer = spawn(
    taskkill,
    ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
    { stdio: "ignore", windowsHide: true },
  );
  let handled = false;
  const fallback = (): void => {
    if (handled) return;
    handled = true;
    safeKill(child, signal);
  };
  killer.once("error", fallback);
  killer.once("close", (code) => {
    if (code !== 0) fallback();
  });
}

function signalOwnedDescendants(
  child: Pick<ChildProcess, "pid">,
  signal: "SIGTERM" | "SIGKILL",
): void {
  const boundary = ownedProcessBoundaries.get(child);
  if (boundary === undefined) return;
  for (const record of boundary.current.values()) {
    if (
      record.pid === boundary.rootPid ||
      record.pid === process.pid ||
      record.pid <= 1 ||
      !isLiveNativeProcess(record)
    ) {
      continue;
    }
    try {
      process.kill(record.pid, signal);
    } catch {
      // The identity was verified in the immediately preceding process-table
      // snapshot and then exited before it could receive the signal.
    }
  }
}

function windowsTaskkillPath(): string | undefined {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot === undefined) return undefined;
  const taskkill = join(systemRoot, "System32", "taskkill.exe");
  return existsSync(taskkill) ? taskkill : undefined;
}

function safeKill(
  child: Pick<ChildProcessWithoutNullStreams, "kill">,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    // The process has already exited.
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

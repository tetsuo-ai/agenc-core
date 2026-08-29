import { execFile } from "node:child_process";
import { open, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { resolveHomeContext } from "../config/home.js";
import {
  BoundedRegularFileError,
  readBoundedRegularFile,
} from "../utils/bounded-regular-file.js";
import { readTrustedWindowsProcessCreationTime } from "../utils/windows-process-identity.js";
import type { DaemonInstanceIdentity } from "./protocol/index.js";

/**
 * A daemon instance is bound to both a cryptographic launch nonce and the
 * operating system's stable identity for the process that owns that nonce.
 * The build fields make the same tuple sufficient for build-skew decisions.
 */
export type AgenCDaemonInstanceIdentity = DaemonInstanceIdentity;

export interface AgenCDaemonProcessIdentity {
  readonly pid: number;
  readonly processStart: string;
}

export interface AgenCDaemonProcessInspectionHost {
  readonly entrypointPath: string;
  readonly pid: number;
  readonly platform?: NodeJS.Platform;
  isPidRunning(pid: number): boolean;
  readonly readProcessIdentity?: (
    pid: number,
  ) => Promise<string | null> | string | null;
}

export interface LinuxAgenCDaemonProcessScanLimits {
  /** Maximum numeric /proc process entries considered in one discovery. */
  readonly maxProcessEntries?: number;
  /** Maximum logical /proc/manifest identity reads in one discovery. */
  readonly maxIoOperations?: number;
  /** Wall-clock budget for the complete discovery pass. */
  readonly maxElapsedMs?: number;
  /** Deterministic contract-test clock. */
  readonly now?: () => number;
  /** @internal Deterministic streaming-directory contract-test seam. */
  readonly openProcDirectory?: OpenLinuxProcDirectory;
  /** @internal Deterministic process-cwd contract-test seam. */
  readonly readProcessCwdPath?: (procDir: string) => Promise<string>;
}

export class AgenCDaemonProcessScanIncompleteError extends Error {
  constructor(reason: string) {
    super(
      `AgenC daemon process discovery scan incomplete (${reason}); ` +
        "refusing daemon lifecycle mutation",
    );
    this.name = "AgenCDaemonProcessScanIncompleteError";
  }
}

const DEFAULT_LINUX_DAEMON_SCAN_MAX_PROCESS_ENTRIES = 8_192;
const DEFAULT_LINUX_DAEMON_SCAN_MAX_IO_OPERATIONS = 32_768;
const DEFAULT_LINUX_DAEMON_SCAN_MAX_ELAPSED_MS = 2_000;
export const AGENC_LINUX_PROC_IDENTITY_MAX_BYTES = 256 * 1_024;
export const AGENC_DAEMON_PACKAGE_MANIFEST_MAX_BYTES = 64 * 1_024;

interface LinuxProcIdentityFileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

interface LinuxProcDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
}

interface LinuxProcDirectory {
  read(): Promise<LinuxProcDirectoryEntry | null>;
  close(): Promise<void>;
}

type OpenLinuxProcDirectory = (path: "/proc") => Promise<LinuxProcDirectory>;

type OpenLinuxProcIdentityFile = (
  path: string,
) => Promise<LinuxProcIdentityFileHandle>;

interface LinuxAgenCDaemonProcessScanTracker {
  readonly startedAt: number;
  readonly maxProcessEntries: number;
  readonly maxIoOperations: number;
  readonly maxElapsedMs: number;
  readonly now: () => number;
  readonly readProcessCwdPath?: (procDir: string) => Promise<string>;
  processEntries: number;
  ioOperations: number;
}

interface LinuxDaemonHomeIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface LinuxProcessCwdIdentity extends LinuxDaemonHomeIdentity {
  readonly path: string;
}

type DarwinProcessIdentityQuery = (
  executable: "/bin/ps",
  args: readonly string[],
  options: {
    readonly cwd: "/";
    readonly encoding: "utf8";
    readonly env: NodeJS.ProcessEnv;
    readonly maxBuffer: number;
    readonly timeout: number;
  },
) => Promise<string>;

export function isAgenCDaemonInstanceIdentity(
  value: unknown,
): value is AgenCDaemonInstanceIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const identity = value as Partial<AgenCDaemonInstanceIdentity>;
  return (
    Number.isSafeInteger(identity.pid) &&
    (identity.pid ?? 0) > 1 &&
    isNonEmptyIdentityField(identity.instanceId) &&
    isNonEmptyIdentityField(identity.processStart) &&
    isNonEmptyIdentityField(identity.runtimeVersion) &&
    isNonEmptyIdentityField(identity.commit) &&
    isNonEmptyIdentityField(identity.buildTime)
  );
}

export function sameAgenCDaemonInstanceIdentity(
  left: AgenCDaemonInstanceIdentity,
  right: AgenCDaemonInstanceIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.instanceId === right.instanceId &&
    left.processStart === right.processStart &&
    left.runtimeVersion === right.runtimeVersion &&
    left.commit === right.commit &&
    left.buildTime === right.buildTime
  );
}

/**
 * Read a PID-reuse-resistant process token on every supported daemon host.
 * Linux combines the boot id with `/proc/<pid>/stat` starttime so a sidecar
 * surviving a reboot cannot accidentally bind a same-numbered process.
 * Darwin pins `/bin/ps` to a deterministic locale; Windows uses an
 * identity-proved system PowerShell executable and direct .NET creation time.
 */
export async function readAgenCDaemonProcessStart(
  pid: number,
  override?: (pid: number) => Promise<string | null> | string | null,
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (override !== undefined) {
    const observed = await Promise.resolve(override(pid));
    return isNonEmptyIdentityField(observed) ? observed : null;
  }
  if (process.platform === "linux") return readLinuxProcessStart(pid);
  if (process.platform === "darwin") return readAgenCDarwinProcessStart(pid);
  if (process.platform === "win32") {
    const creationTime = await readTrustedWindowsProcessCreationTime(pid);
    return creationTime === null ? null : `win32:${creationTime}`;
  }
  return null;
}

async function readLinuxProcessStart(pid: number): Promise<string | null> {
  try {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      throw new Error("malformed /proc stat record");
    }
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u);
    const startTime = fields[19];
    const bootToken = bootId.trim();
    if (
      startTime === undefined ||
      !/^\d+$/u.test(startTime) ||
      !isNonEmptyIdentityField(bootToken)
    ) {
      throw new Error("malformed Linux process identity");
    }
    return `linux:${bootToken}:${startTime}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw error;
  }
}

/** @internal Exported for locale/cwd hardening contract tests. */
export async function readAgenCDarwinProcessStart(
  pid: number,
  query: DarwinProcessIdentityQuery = executeDarwinProcessIdentityQuery,
): Promise<string | null> {
  try {
    const output = await query(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        cwd: "/",
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        maxBuffer: 4_096,
        timeout: 5_000,
      },
    );
    const processStart = output.trim();
    return processStart.length === 0
      ? null
      : `darwin-lstart-seconds:${processStart}`;
  } catch {
    // Missing PIDs and an unavailable native query are indistinguishable to
    // callers; both fail closed and authorize neither adoption nor signals.
    return null;
  }
}

function executeDarwinProcessIdentityQuery(
  executable: "/bin/ps",
  args: readonly string[],
  options: Parameters<DarwinProcessIdentityQuery>[2],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function isNonEmptyIdentityField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024;
}

export async function findLinuxAgenCDaemonProcesses(
  host: AgenCDaemonProcessInspectionHost,
  daemonHome: string,
  entrypointMatch: "exact" | "any-install" = "exact",
  limits: LinuxAgenCDaemonProcessScanLimits = {},
): Promise<readonly AgenCDaemonProcessIdentity[]> {
  if ((host.platform ?? process.platform) !== "linux") return [];
  if (entrypointMatch === "exact" && host.entrypointPath.length === 0) {
    return [];
  }
  const tracker = createLinuxAgenCDaemonProcessScanTracker(limits);
  assertLinuxAgenCDaemonScanWithinBudget(tracker);
  const identities: AgenCDaemonProcessIdentity[] = [];
  const openDirectory = limits.openProcDirectory ?? openLinuxProcDirectory;
  consumeLinuxAgenCDaemonScanIo(tracker);
  const directory = await openDirectory("/proc");
  let primaryError: unknown;
  try {
    while (true) {
      assertLinuxAgenCDaemonScanWithinBudget(tracker);
      const entry = await directory.read();
      if (entry === null) break;
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      tracker.processEntries += 1;
      assertLinuxAgenCDaemonScanWithinBudget(tracker);
      const candidatePid = Number.parseInt(entry.name, 10);
      if (
        !Number.isSafeInteger(candidatePid) ||
        candidatePid <= 1 ||
        candidatePid === host.pid ||
        !host.isPidRunning(candidatePid)
      ) {
        continue;
      }
      const identity = await inspectLinuxAgenCDaemonProcessWithTracker(
        candidatePid,
        host,
        daemonHome,
        entrypointMatch,
        tracker,
      );
      if (identity !== null) identities.push(identity);
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown;
  try {
    await directory.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined) {
    if (closeError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "Linux process discovery and directory cleanup both failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (closeError !== undefined) throw closeError;
  assertLinuxAgenCDaemonScanWithinBudget(tracker);
  return identities;
}

async function openLinuxProcDirectory(
  path: "/proc",
): Promise<LinuxProcDirectory> {
  return opendir(path);
}

export async function inspectLinuxAgenCDaemonProcess(
  pid: number,
  host: AgenCDaemonProcessInspectionHost,
  daemonHome: string,
  entrypointMatch: "exact" | "any-install",
): Promise<AgenCDaemonProcessIdentity | null> {
  return inspectLinuxAgenCDaemonProcessWithTracker(
    pid,
    host,
    daemonHome,
    entrypointMatch,
  );
}

async function inspectLinuxAgenCDaemonProcessWithTracker(
  pid: number,
  host: AgenCDaemonProcessInspectionHost,
  daemonHome: string,
  entrypointMatch: "exact" | "any-install",
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<AgenCDaemonProcessIdentity | null> {
  if ((host.platform ?? process.platform) !== "linux") return null;
  const procDir = join("/proc", String(pid));
  try {
    // The start token is the outer generation fence. Reading argv or cwd
    // before it permits PID reuse to splice metadata from two processes into
    // one apparently valid proof.
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const initialProcessStart = await readAgenCDaemonProcessStart(
      pid,
      host.readProcessIdentity,
    );
    if (initialProcessStart === null) return null;
    const argv = await readProcList(join(procDir, "cmdline"), scanTracker);
    const expectedEntrypoint =
      host.entrypointPath.length > 0 ? resolve(host.entrypointPath) : null;
    const expectedEntrypointBasename =
      expectedEntrypoint === null ? null : basename(expectedEntrypoint);
    // An unrelated process may legitimately hide its cwd from this user. A
    // basename plus exact daemon invocation tail is only a cheap necessary
    // condition: it authorizes no action, but lets us avoid cwd and canonical
    // entrypoint I/O when no argv token could represent a foreground daemon.
    // Candidate-shaped argv still receives the complete fail-closed proof.
    if (
      !argv.some((value, index) => {
        const candidateBasename = basename(resolve("/", value));
        return (
          ((expectedEntrypointBasename !== null &&
            candidateBasename === expectedEntrypointBasename) ||
            (entrypointMatch === "any-install" &&
              candidateBasename === "agenc")) &&
          argv[index + 1] === "daemon" &&
          argv[index + 2] === "start" &&
          argv[index + 3] === "--foreground"
        );
      })
    ) {
      return null;
    }
    const cwdBefore = await readLinuxProcessCwdIdentity(procDir, scanTracker);

    let entrypointIndex = -1;
    for (let index = 0; index < argv.length; index += 1) {
      const value = argv[index];
      if (value === undefined) continue;
      const candidateEntrypoint = isAbsolute(value)
        ? resolve(value)
        : resolve(cwdBefore.path, value);
      if (
        expectedEntrypoint !== null &&
        candidateEntrypoint === expectedEntrypoint
      ) {
        entrypointIndex = index;
        break;
      }
      if (
        entrypointMatch === "any-install" &&
        (await isCanonicalAgenCDaemonEntrypointPathWithTracker(
          candidateEntrypoint,
          scanTracker,
        ))
      ) {
        entrypointIndex = index;
        break;
      }
    }
    if (entrypointIndex === -1) return null;
    const tail = argv.slice(entrypointIndex + 1);
    if (
      tail[0] !== "daemon" ||
      tail[1] !== "start" ||
      tail[2] !== "--foreground"
    ) {
      return null;
    }

    const environment = await readProcEnv(
      join(procDir, "environ"),
      scanTracker,
    );
    if (environment.AGENC_HOME === undefined && environment.HOME === undefined) {
      return null;
    }
    const candidateHome = resolveHomeContext(environment, {
      ...(environment.HOME !== undefined
        ? { platformHome: environment.HOME }
        : {}),
    }).path;
    const targetHomeBefore = await readLinuxDaemonHomeIdentity(
      resolve(daemonHome),
      scanTracker,
    );
    const candidateHomeBefore = await readLinuxDaemonHomeIdentity(
      candidateHome,
      scanTracker,
    );
    if (!sameLinuxDaemonHomeIdentity(targetHomeBefore, candidateHomeBefore)) {
      return null;
    }

    const cwdAfter = await readLinuxProcessCwdIdentity(procDir, scanTracker);
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const confirmedProcessStart = await readAgenCDaemonProcessStart(
      pid,
      host.readProcessIdentity,
    );
    if (
      confirmedProcessStart === null ||
      confirmedProcessStart !== initialProcessStart
    ) {
      return null;
    }
    const targetHomeAfter = await readLinuxDaemonHomeIdentity(
      resolve(daemonHome),
      scanTracker,
    );
    const candidateHomeAfter = await readLinuxDaemonHomeIdentity(
      candidateHome,
      scanTracker,
    );
    if (
      !sameLinuxProcessCwdIdentity(cwdBefore, cwdAfter) ||
      !sameLinuxDaemonHomeIdentity(targetHomeBefore, targetHomeAfter) ||
      !sameLinuxDaemonHomeIdentity(candidateHomeBefore, candidateHomeAfter) ||
      !sameLinuxDaemonHomeIdentity(targetHomeAfter, candidateHomeAfter)
    ) {
      throw new AgenCDaemonProcessScanIncompleteError(
        "process cwd or daemon home identity changed during inspection",
      );
    }
    return { pid, processStart: confirmedProcessStart };
  } catch (error) {
    if (isLinuxProcessDisappearanceError(error)) return null;
    if (containsAgenCDaemonProcessScanIncompleteError(error)) throw error;
    throw new AgenCDaemonProcessScanIncompleteError(
      `process ${pid} identity could not be proved`,
    );
  }
}

async function readLinuxProcessCwdIdentity(
  procDir: string,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<LinuxProcessCwdIdentity> {
  consumeLinuxAgenCDaemonScanIo(scanTracker);
  const path =
    scanTracker?.readProcessCwdPath === undefined
      ? await realpath(join(procDir, "cwd"))
      : await scanTracker.readProcessCwdPath(procDir);
  consumeLinuxAgenCDaemonScanIo(scanTracker);
  const metadata = await stat(path, { bigint: true });
  if (!metadata.isDirectory()) {
    throw new AgenCDaemonProcessScanIncompleteError(
      "process cwd is not a directory",
    );
  }
  return { path, device: metadata.dev, inode: metadata.ino };
}

function sameLinuxProcessCwdIdentity(
  left: LinuxProcessCwdIdentity,
  right: LinuxProcessCwdIdentity,
): boolean {
  return left.path === right.path && sameLinuxDaemonHomeIdentity(left, right);
}

async function readLinuxDaemonHomeIdentity(
  path: string,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<LinuxDaemonHomeIdentity> {
  try {
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const canonicalPath = await realpath(path);
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const metadata = await stat(canonicalPath, { bigint: true });
    if (!metadata.isDirectory()) {
      throw new Error("daemon home is not a directory");
    }
    return {
      device: metadata.dev,
      inode: metadata.ino,
    };
  } catch (error) {
    if (error instanceof AgenCDaemonProcessScanIncompleteError) throw error;
    throw new AgenCDaemonProcessScanIncompleteError(
      `daemon home identity unavailable for ${path}`,
    );
  }
}

function sameLinuxDaemonHomeIdentity(
  left: LinuxDaemonHomeIdentity,
  right: LinuxDaemonHomeIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/** @internal Exported for the legacy cross-install ownership contract test. */
export async function isCanonicalAgenCDaemonEntrypointPath(
  value: string,
): Promise<boolean> {
  return isCanonicalAgenCDaemonEntrypointPathWithTracker(value);
}

async function isCanonicalAgenCDaemonEntrypointPathWithTracker(
  value: string,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<boolean> {
  // Cheaply reject almost every argv token before realpath or package.json
  // I/O. Only the shipped <package>/bin/agenc layout reaches those reads.
  if (
    !isAbsolute(value) ||
    basename(value) !== "agenc" ||
    basename(dirname(value)) !== "bin"
  ) {
    return false;
  }
  try {
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const entrypoint = await realpath(value);
    if (
      basename(entrypoint) !== "agenc" ||
      basename(dirname(entrypoint)) !== "bin"
    ) {
      return false;
    }
    const packageRoot = dirname(dirname(entrypoint));
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const manifestText = await readBoundedRegularFile(
      join(packageRoot, "package.json"),
      AGENC_DAEMON_PACKAGE_MANIFEST_MAX_BYTES,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText) as unknown;
    } catch {
      return false;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    const manifest = parsed as {
      readonly name?: unknown;
      readonly bin?: unknown;
    };
    if (
      manifest.name !== "@tetsuo-ai/runtime" ||
      typeof manifest.bin !== "object" ||
      manifest.bin === null ||
      Array.isArray(manifest.bin)
    ) {
      return false;
    }
    if ((manifest.bin as Record<string, unknown>).agenc !== "bin/agenc") {
      return false;
    }
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    return (await realpath(value)) === entrypoint;
  } catch (error) {
    if (error instanceof AgenCDaemonProcessScanIncompleteError) throw error;
    if (scanTracker !== undefined || error instanceof BoundedRegularFileError) {
      throw new AgenCDaemonProcessScanIncompleteError(
        `canonical daemon entrypoint identity unavailable for ${value}`,
      );
    }
    return false;
  }
}

async function readProcList(
  path: string,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<readonly string[]> {
  try {
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    return (await readBoundedLinuxProcIdentityFile(path))
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    if (containsAgenCDaemonProcessScanIncompleteError(error)) throw error;
    if (isLinuxProcessDisappearanceError(error)) throw error;
    throw new AgenCDaemonProcessScanIncompleteError(
      `process identity file unavailable for ${path}`,
    );
  }
}

/** @internal Fixed-memory procfs reader used by discovery contract tests. */
export async function readBoundedLinuxProcIdentityFile(
  path: string,
  openFile: OpenLinuxProcIdentityFile = (target) => open(target, "r"),
): Promise<string> {
  const handle = await openFile(path);
  const buffer = Buffer.allocUnsafe(AGENC_LINUX_PROC_IDENTITY_MAX_BYTES + 1);
  let length = 0;
  let value: string | undefined;
  let primaryError: unknown;
  try {
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (
        !Number.isSafeInteger(result.bytesRead) ||
        result.bytesRead < 0 ||
        result.bytesRead > buffer.length - length
      ) {
        throw new Error(
          "Linux process identity read returned an invalid length",
        );
      }
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > AGENC_LINUX_PROC_IDENTITY_MAX_BYTES) {
      throw new AgenCDaemonProcessScanIncompleteError(
        `process identity file exceeds ${AGENC_LINUX_PROC_IDENTITY_MAX_BYTES} bytes`,
      );
    }
    value = buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined) {
    if (closeError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "Linux process identity read and descriptor cleanup both failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (closeError !== undefined) throw closeError;
  return value ?? "";
}

function containsAgenCDaemonProcessScanIncompleteError(
  error: unknown,
): boolean {
  return (
    error instanceof AgenCDaemonProcessScanIncompleteError ||
    (error instanceof AggregateError &&
      error.errors.some(containsAgenCDaemonProcessScanIncompleteError))
  );
}

function isLinuxProcessDisappearanceError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every(isLinuxProcessDisappearanceError)
    );
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH" || code === "ENOTDIR";
}

async function readProcEnv(
  path: string,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const entry of await readProcList(path, scanTracker)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function createLinuxAgenCDaemonProcessScanTracker(
  limits: LinuxAgenCDaemonProcessScanLimits,
): LinuxAgenCDaemonProcessScanTracker {
  const now = limits.now ?? Date.now;
  return {
    startedAt: now(),
    maxProcessEntries: normalizeScanLimit(
      limits.maxProcessEntries,
      DEFAULT_LINUX_DAEMON_SCAN_MAX_PROCESS_ENTRIES,
    ),
    maxIoOperations: normalizeScanLimit(
      limits.maxIoOperations,
      DEFAULT_LINUX_DAEMON_SCAN_MAX_IO_OPERATIONS,
    ),
    maxElapsedMs: normalizeScanLimit(
      limits.maxElapsedMs,
      DEFAULT_LINUX_DAEMON_SCAN_MAX_ELAPSED_MS,
    ),
    now,
    readProcessCwdPath: limits.readProcessCwdPath,
    processEntries: 0,
    ioOperations: 0,
  };
}

function normalizeScanLimit(
  value: number | undefined,
  fallback: number,
): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 0
    ? fallback
    : value;
}

function consumeLinuxAgenCDaemonScanIo(
  tracker: LinuxAgenCDaemonProcessScanTracker | undefined,
): void {
  if (tracker === undefined) return;
  tracker.ioOperations += 1;
  assertLinuxAgenCDaemonScanWithinBudget(tracker);
}

function assertLinuxAgenCDaemonScanWithinBudget(
  tracker: LinuxAgenCDaemonProcessScanTracker,
): void {
  if (tracker.processEntries > tracker.maxProcessEntries) {
    throw new AgenCDaemonProcessScanIncompleteError(
      `more than ${tracker.maxProcessEntries} process entries`,
    );
  }
  if (tracker.ioOperations > tracker.maxIoOperations) {
    throw new AgenCDaemonProcessScanIncompleteError(
      `more than ${tracker.maxIoOperations} identity I/O operations`,
    );
  }
  if (tracker.now() - tracker.startedAt > tracker.maxElapsedMs) {
    throw new AgenCDaemonProcessScanIncompleteError(
      `longer than ${tracker.maxElapsedMs}ms`,
    );
  }
}

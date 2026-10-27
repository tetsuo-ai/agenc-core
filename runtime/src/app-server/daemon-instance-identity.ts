import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, opendir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveProcessHomePathInput } from "../config/home.js";
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
  /**
   * Maximum /proc listings in one discovery. Listing starts over only when a
   * process is reaped while its directory entry is being listed.
   */
  readonly maxDirectoryPasses?: number;
  /** Deterministic contract-test clock. */
  readonly now?: () => number;
  /** @internal Deterministic streaming-directory contract-test seam. */
  readonly openProcDirectory?: OpenLinuxProcDirectory;
  /** @internal Deterministic process-cwd contract-test seam. */
  readonly readProcessCwdPath?: (procDir: string) => Promise<string>;
  /** @internal Deterministic candidate filesystem-root contract-test seam. */
  readonly readProcessRootPath?: (procDir: string) => Promise<string>;
  /**
   * @internal Deterministic contract-test hook that runs as part of every read
   * of a candidate's own /proc/<pid> entry; an error it throws is that read's
   * error.
   */
  readonly beforeProcessRead?: (
    pid: number,
    entry: LinuxAgenCDaemonProcessEntry,
  ) => Promise<void> | void;
}

/** A candidate's own /proc/<pid> entry read during discovery. */
export type LinuxAgenCDaemonProcessEntry =
  | "cmdline"
  | "exe"
  | "environ"
  | "root"
  | "cwd"
  | "stat";

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
const DEFAULT_LINUX_DAEMON_SCAN_MAX_DIRECTORY_PASSES = 8;
/** PF_EXITING in a /proc/<pid>/stat flags field: the task is in do_exit. */
const LINUX_TASK_FLAG_EXITING = 0x4n;
/** Bounded wait for an exiting candidate to settle as reaped or zombie. */
const LINUX_EXITING_TASK_SETTLE_POLLS = 40;
const LINUX_EXITING_TASK_SETTLE_POLL_MS = 5;
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
  readonly maxDirectoryPasses: number;
  readonly now: () => number;
  readonly readProcessCwdPath?: (procDir: string) => Promise<string>;
  /** @internal Deterministic candidate filesystem-root contract-test seam. */
  readonly readProcessRootPath?: (procDir: string) => Promise<string>;
  readonly beforeProcessRead?: LinuxAgenCDaemonProcessScanLimits["beforeProcessRead"];
  processEntries: number;
  ioOperations: number;
  directoryPasses: number;
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
  const listedPids = new Set<number>();
  const openDirectory = limits.openProcDirectory ?? openLinuxProcDirectory;
  while (true) {
    tracker.directoryPasses += 1;
    const vanishedPid = await scanLinuxProcDirectoryPass(
      openDirectory,
      host,
      daemonHome,
      entrypointMatch,
      tracker,
      listedPids,
      identities,
    );
    if (vanishedPid === null) break;
    if (tracker.directoryPasses >= tracker.maxDirectoryPasses) {
      throw new AgenCDaemonProcessScanIncompleteError(
        `process ${vanishedPid} was reaped while /proc was listed and ` +
          `${tracker.directoryPasses} listings did not complete`,
      );
    }
  }
  assertLinuxAgenCDaemonScanWithinBudget(tracker);
  return identities;
}

/**
 * List /proc once and inspect every numeric entry that no earlier listing of
 * this discovery returned. Returns the PID of an entry that vanished while it
 * was being listed, or null when the listing completed.
 *
 * procfs reports d_type DT_UNKNOWN for a process that is reaped between being
 * found and being listed. Node's Dir then lstat()s `/proc/<pid>`, which fails
 * with ENOENT, and discards the rest of its buffered read batch. That process
 * is gone, but the discarded entries may belong to live processes, so the
 * caller lists again; a later listing returns each process alive throughout
 * the discovery, so none of them is skipped and none is inspected twice.
 */
async function scanLinuxProcDirectoryPass(
  openDirectory: OpenLinuxProcDirectory,
  host: AgenCDaemonProcessInspectionHost,
  daemonHome: string,
  entrypointMatch: "exact" | "any-install",
  tracker: LinuxAgenCDaemonProcessScanTracker,
  listedPids: Set<number>,
  identities: AgenCDaemonProcessIdentity[],
): Promise<number | null> {
  consumeLinuxAgenCDaemonScanIo(tracker);
  const directory = await openDirectory("/proc");
  let vanishedPid: number | null = null;
  let primaryError: unknown;
  try {
    while (true) {
      assertLinuxAgenCDaemonScanWithinBudget(tracker);
      let entry: LinuxProcDirectoryEntry | null;
      try {
        entry = await directory.read();
      } catch (error) {
        vanishedPid = reapedLinuxProcDirectoryEntryPid(error);
        if (vanishedPid === null) throw error;
        break;
      }
      if (entry === null) break;
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      const candidatePid = Number.parseInt(entry.name, 10);
      if (listedPids.has(candidatePid)) continue;
      listedPids.add(candidatePid);
      tracker.processEntries += 1;
      assertLinuxAgenCDaemonScanWithinBudget(tracker);
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
  return vanishedPid;
}

/**
 * The PID of a `/proc/<pid>` entry whose type lookup failed because the
 * process no longer exists, or null for every other directory read error.
 */
function reapedLinuxProcDirectoryEntryPid(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, syscall, path } = error as NodeJS.ErrnoException;
  if (
    (code !== "ENOENT" && code !== "ESRCH") ||
    syscall !== "lstat" ||
    typeof path !== "string"
  ) {
    return null;
  }
  const match = /^\/proc\/([1-9]\d*)$/u.exec(path);
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
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
  let initialProcessStart: string | null = null;
  try {
    // The start token is the outer generation fence. Reading argv or cwd
    // before it permits PID reuse to splice metadata from two processes into
    // one apparently valid proof.
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    initialProcessStart = await readAgenCDaemonProcessStart(
      pid,
      host.readProcessIdentity,
    );
    if (initialProcessStart === null) return null;
    const argv = await readProcList(pid, "cmdline", scanTracker);
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
    // Container clients advertise a forwarded command in argv but do not
    // execute the daemon script. Exclude only the actual protected system
    // client executable, not a process merely using its name in argv.
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const executable = await readLinuxProcessEntry(
      pid,
      "exe",
      scanTracker,
      () => stat(join(procDir, "exe"), { bigint: true }),
    );
    for (const client of ["/usr/bin/docker", "/usr/bin/podman"]) {
      consumeLinuxAgenCDaemonScanIo(scanTracker);
      try {
        const clientIdentity = await stat(client, { bigint: true });
        if (clientIdentity.uid === 0n && (clientIdentity.mode & 0o022n) === 0n &&
            executable.dev === clientIdentity.dev && executable.ino === clientIdentity.ino) {
          return null;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    // Compare home directory identities before reading another install's
    // entrypoint. A process serving a different device/inode cannot own this
    // home. Same-home and unknown candidates retain the full identity checks.
    const environment = await readProcEnv(pid, scanTracker);
    const candidateHome = resolveProcessHomePathInput(environment);
    const candidateRoot = scanTracker?.readProcessRootPath === undefined
      ? join(procDir, "root")
      : await scanTracker.readProcessRootPath(procDir);
    // Only the default root is the candidate's own /proc/<pid> entry.
    const candidateRootOwner = scanTracker?.readProcessRootPath === undefined
      ? pid
      : undefined;
    const targetHomeBefore = candidateHome === null
      ? null
      : await readLinuxDaemonHomeIdentity(resolve(daemonHome), scanTracker);
    const candidateHomeBefore = candidateHome === null
      ? null
      : await readLinuxDaemonHomeInProcessRoot(candidateRoot, candidateHome, scanTracker, candidateRootOwner);
    if (targetHomeBefore !== null && candidateHomeBefore !== null &&
      !sameLinuxDaemonHomeIdentity(targetHomeBefore, candidateHomeBefore)) {
      // A root or home replacement must not splice a foreign-home observation
      // into another process generation, including the early exclusion path.
      consumeLinuxAgenCDaemonScanIo(scanTracker);
      const confirmedProcessStart = await readAgenCDaemonProcessStart(pid, host.readProcessIdentity);
      if (confirmedProcessStart === null || confirmedProcessStart !== initialProcessStart) return null;
      const targetHomeAfter = await readLinuxDaemonHomeIdentity(resolve(daemonHome), scanTracker);
      const candidateHomeAfter = await readLinuxDaemonHomeInProcessRoot(candidateRoot, candidateHome!, scanTracker, candidateRootOwner);
      if (!sameLinuxDaemonHomeIdentity(targetHomeBefore, targetHomeAfter) ||
          !sameLinuxDaemonHomeIdentity(candidateHomeBefore, candidateHomeAfter)) {
        throw new AgenCDaemonProcessScanIncompleteError("daemon home changed during inspection");
      }
      return null;
    }
    const cwdBefore = await readLinuxProcessCwdIdentity(pid, procDir, scanTracker);

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


    // No home coordinates cannot prove a foreign owner. Keep the entrypoint
    // check above even in that case, then retain the original no-home result.
    if (candidateHome === null || targetHomeBefore === null || candidateHomeBefore === null) {
      return null;
    }
    const cwdAfter = await readLinuxProcessCwdIdentity(pid, procDir, scanTracker);
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
    const candidateHomeAfter = await readLinuxDaemonHomeInProcessRoot(
      candidateRoot, candidateHome, scanTracker, candidateRootOwner,
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
  } catch (caught) {
    let error = caught;
    if (caught instanceof LinuxProcessEntryMissingError) {
      // One of the candidate's own /proc/<pid> entries is missing. That alone
      // does not prove the process ended: a live process can hide its cwd,
      // root or executable from this namespace. Skip it only once the
      // inspected generation is shown to have ended; otherwise fail closed
      // exactly as that read's error would.
      if (await proveLinuxProcessDisappearance(pid, () =>
        hasLinuxProcessGenerationEnded(pid, initialProcessStart, host, scanTracker))) {
        return null;
      }
      error = caught.unavailable;
    } else if (isLinuxProcessDisappearanceError(caught)) {
      // A cwd or entrypoint can be missing only in the scanner's namespace
      // while the candidate is still alive. A missing pathname is not proof
      // of process disappearance; confirm that through the process token.
      if (await proveLinuxProcessDisappearance(pid, async () => {
        consumeLinuxAgenCDaemonScanIo(scanTracker);
        return await readAgenCDaemonProcessStart(pid, host.readProcessIdentity) === null;
      })) {
        return null;
      }
    }
    if (containsAgenCDaemonProcessScanIncompleteError(error)) {
      throw new AgenCDaemonProcessScanIncompleteError(
        `process ${pid}: ${error instanceof Error ? error.message : "identity unavailable"}; ` +
        "stop that process in its namespace or make its daemon home readable before retrying",
      );
    }
    throw new AgenCDaemonProcessScanIncompleteError(
      `process ${pid} identity could not be proved; ` +
      "stop that process in its namespace or make its daemon home readable before retrying",
    );
  }
}

/** A candidate's own /proc/<pid> entry was missing when it was read. */
class LinuxProcessEntryMissingError extends Error {
  constructor(
    readonly pid: number,
    readonly entry: LinuxAgenCDaemonProcessEntry,
    /** What fails the inspection closed if the process is still running. */
    readonly unavailable: unknown,
  ) {
    super(`/proc/${pid}/${entry} is missing`);
    this.name = "LinuxProcessEntryMissingError";
  }
}

/**
 * Read one of a candidate's own /proc/<pid> entries. A missing entry is
 * reported as LinuxProcessEntryMissingError for the caller to confirm;
 * `unavailable` maps every read error to the error that fails it closed.
 */
async function readLinuxProcessEntry<T>(
  pid: number,
  entry: LinuxAgenCDaemonProcessEntry,
  scanTracker: LinuxAgenCDaemonProcessScanTracker | undefined,
  read: () => Promise<T>,
  unavailable: (error: unknown) => unknown = (error) => error,
): Promise<T> {
  try {
    await scanTracker?.beforeProcessRead?.(pid, entry);
    return await read();
  } catch (error) {
    if (isLinuxProcessEntryMissingError(error, entry)) {
      throw new LinuxProcessEntryMissingError(pid, entry, unavailable(error));
    }
    throw unavailable(error);
  }
}

function isLinuxProcessEntryMissingError(
  error: unknown,
  entry: LinuxAgenCDaemonProcessEntry,
): boolean {
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every((inner) => isLinuxProcessEntryMissingError(inner, entry))
    );
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // procfs makes /proc/<pid>/environ root-owned once the task has released
  // its memory, so an exiting process reports EACCES there, not ENOENT.
  return (
    code === "ENOENT" ||
    code === "ESRCH" ||
    (entry === "environ" && code === "EACCES")
  );
}

async function proveLinuxProcessDisappearance(
  pid: number,
  prove: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await prove();
  } catch (identityError) {
    throw new AgenCDaemonProcessScanIncompleteError(
      `process ${pid} disappearance could not be proved: ` +
      `${identityError instanceof Error ? identityError.message : "identity unavailable"}; ` +
      "stop that process in its namespace or make its daemon home readable before retrying",
    );
  }
}

/**
 * Decide, after one of its own /proc entries went missing, whether the
 * inspected process generation has ended: the PID is gone, the PID now has
 * another start token, or the task exited and only waits to be reaped. Such a
 * task has already released its memory, files, root and cwd, so it cannot be
 * a running daemon. A task that is still running returns false and the
 * inspection fails closed; one caught inside exit gets a short bounded wait.
 */
async function hasLinuxProcessGenerationEnded(
  pid: number,
  initialProcessStart: string | null,
  host: AgenCDaemonProcessInspectionHost,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<boolean> {
  for (let poll = 0; ; poll += 1) {
    if (!host.isPidRunning(pid)) return true;
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const processStart = await readAgenCDaemonProcessStart(
      pid,
      host.readProcessIdentity,
    );
    if (processStart === null) return true;
    if (initialProcessStart !== null && processStart !== initialProcessStart) {
      return true;
    }
    const state = await readLinuxTaskExitState(pid, scanTracker);
    if (state === "gone" || state === "exited") return true;
    if (state === "running" || poll >= LINUX_EXITING_TASK_SETTLE_POLLS) {
      return false;
    }
    await delay(LINUX_EXITING_TASK_SETTLE_POLL_MS);
  }
}

/**
 * Classify a task from /proc/<pid>/stat: "exited" is a zombie with no thread
 * left, "exiting" is inside do_exit (or a zombie group leader whose other
 * threads have not finished), and "running" is everything else.
 */
async function readLinuxTaskExitState(
  pid: number,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<"gone" | "exited" | "exiting" | "running"> {
  consumeLinuxAgenCDaemonScanIo(scanTracker);
  let record: string;
  try {
    await scanTracker?.beforeProcessRead?.(pid, "stat");
    record = await readFile(join("/proc", String(pid), "stat"), "utf8");
  } catch (error) {
    if (isLinuxProcessEntryMissingError(error, "stat")) return "gone";
    throw error;
  }
  const commandEnd = record.lastIndexOf(")");
  const fields = commandEnd < 0
    ? []
    : record.slice(commandEnd + 2).trim().split(/\s+/u);
  const state = fields[0];
  const flags = fields[6];
  const threads = fields[17];
  if (
    state === undefined ||
    flags === undefined ||
    threads === undefined ||
    !/^\d+$/u.test(flags) ||
    !/^\d+$/u.test(threads)
  ) {
    throw new Error("malformed /proc stat record");
  }
  if (state === "Z" || state === "X") {
    return BigInt(threads) <= 1n ? "exited" : "exiting";
  }
  return (BigInt(flags) & LINUX_TASK_FLAG_EXITING) === 0n ? "running" : "exiting";
}

async function readLinuxProcessCwdIdentity(
  pid: number,
  procDir: string,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<LinuxProcessCwdIdentity> {
  consumeLinuxAgenCDaemonScanIo(scanTracker);
  const path = await readLinuxProcessEntry(pid, "cwd", scanTracker, () =>
    scanTracker?.readProcessCwdPath === undefined
      ? realpath(join(procDir, "cwd"))
      : scanTracker.readProcessCwdPath(procDir));
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

/**
 * Resolve home symlinks in the candidate's root, not the scanner's root.
 * Each directory is pinned by an fd; O_NOFOLLOW prevents a replaced component
 * from redirecting a lookup into the host filesystem. Absolute symlinks restart
 * at the pinned candidate root. No metadata here authorizes adoption/signals.
 * `rootOwnerPid` is set when `processRoot` is that process's own
 * /proc/<pid>/root entry, so a missing root can be checked for process exit.
 */
async function readLinuxDaemonHomeInProcessRoot(
  processRoot: string,
  homePath: string,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
  rootOwnerPid?: number,
): Promise<LinuxDaemonHomeIdentity> {
  if (!isAbsolute(homePath)) {
    throw new AgenCDaemonProcessScanIncompleteError("candidate daemon home is not absolute");
  }
  consumeLinuxAgenCDaemonScanIo(scanTracker);
  const openRoot = () => open(processRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  const rootUnreadable = () =>
    new AgenCDaemonProcessScanIncompleteError("candidate filesystem root is unreadable");
  const root = rootOwnerPid === undefined
    ? await openRoot().catch(() => {
      throw rootUnreadable();
    })
    : await readLinuxProcessEntry(rootOwnerPid, "root", scanTracker, openRoot, rootUnreadable);
  let current = root;
  let components = homePath.normalize("NFC").split("/").filter(Boolean);
  let walked: string[] = [];
  let symlinks = 0;
  try {
    while (components.length > 0) {
      const component = components.shift()!;
      if (component === ".") continue;
      if (component === "..") {
        walked.pop();
        components = [...walked, ...components];
        if (current !== root) await current.close();
        current = root;
        walked = [];
        continue;
      }
      const path = `/proc/self/fd/${current.fd}/${component}`;
      consumeLinuxAgenCDaemonScanIo(scanTracker);
      if (rootOwnerPid !== undefined) {
        await scanTracker?.beforeProcessRead?.(rootOwnerPid, "root");
      }
      let next;
      try {
        next = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ELOOP" && code !== "ENOTDIR") throw error;
        consumeLinuxAgenCDaemonScanIo(scanTracker);
        const link = await readlink(path);
        if (++symlinks > 40) throw new Error("candidate daemon home has too many symlinks");
        components = [...(isAbsolute(link) ? [] : walked), ...link.split("/"), ...components].filter(Boolean);
        if (current !== root) await current.close();
        current = root;
        walked = [];
        continue;
      }
      const previous = current;
      current = next;
      if (previous !== root) await previous.close();
      walked.push(component);
    }
    consumeLinuxAgenCDaemonScanIo(scanTracker);
    const metadata = await current.stat({ bigint: true });
    return { device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if (error instanceof AgenCDaemonProcessScanIncompleteError) throw error;
    const unreadable = new AgenCDaemonProcessScanIncompleteError("candidate daemon home identity is unreadable in its filesystem root");
    // The pinned root survives the candidate's exit, but a mount namespace
    // torn down with it can drop mounts below that root.
    if (rootOwnerPid !== undefined && isLinuxProcessEntryMissingError(error, "root")) {
      throw new LinuxProcessEntryMissingError(rootOwnerPid, "root", unreadable);
    }
    throw unreadable;
  } finally {
    try {
      if (current !== root) await current.close();
    } finally {
      await root.close();
    }
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
  pid: number,
  entry: "cmdline" | "environ",
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<readonly string[]> {
  const path = join("/proc", String(pid), entry);
  consumeLinuxAgenCDaemonScanIo(scanTracker);
  const content = await readLinuxProcessEntry(
    pid,
    entry,
    scanTracker,
    () => readBoundedLinuxProcIdentityFile(path),
    (error) =>
      containsAgenCDaemonProcessScanIncompleteError(error) ||
      isLinuxProcessDisappearanceError(error)
        ? error
        : new AgenCDaemonProcessScanIncompleteError(
          `process identity file unavailable for ${path}`,
        ),
  );
  return content.split("\0").filter(Boolean);
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
  pid: number,
  scanTracker?: LinuxAgenCDaemonProcessScanTracker,
): Promise<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const entry of await readProcList(pid, "environ", scanTracker)) {
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
    maxDirectoryPasses: Math.max(
      1,
      normalizeScanLimit(
        limits.maxDirectoryPasses,
        DEFAULT_LINUX_DAEMON_SCAN_MAX_DIRECTORY_PASSES,
      ),
    ),
    now,
    readProcessCwdPath: limits.readProcessCwdPath,
    readProcessRootPath: limits.readProcessRootPath,
    beforeProcessRead: limits.beforeProcessRead,
    processEntries: 0,
    ioOperations: 0,
    directoryPasses: 0,
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

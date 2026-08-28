import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  type Stats,
  type BigIntStats,
  unwatchFile as nodeUnwatchFile,
  unlinkSync,
  watchFile as nodeWatchFile,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { runWithConfigAuthorityLockSync } from "./authority-lock.js";
import { cloneRecord, isPlainRecord, type JsonRecord } from "./json.js";
import {
  createCanonicalStateDocument,
  getGlobalRuntimeState,
  readCanonicalState,
  readCanonicalStateSnapshotSync,
  readCanonicalStateSync,
  StateRepositoryError,
  withGlobalRuntimeState,
  writeCanonicalStateAtomicSync,
  type CanonicalStateDocument,
  type CanonicalStateFileSnapshot,
  type CanonicalStateWriteOutcome,
} from "./state.js";
import type { HomeContext } from "./home.js";
import { registerCleanup } from "../utils/cleanupRegistry.js";
import { logForDebugging } from "../utils/debug.js";

export type ProjectRuntimeState = {
  lastAPIDuration?: number;
  lastAPIDurationWithoutRetries?: number;
  lastToolDuration?: number;
  lastCost?: number;
  lastDuration?: number;
  lastLinesAdded?: number;
  lastLinesRemoved?: number;
  lastTotalInputTokens?: number;
  lastTotalOutputTokens?: number;
  lastTotalCacheCreationInputTokens?: number;
  lastTotalCacheReadInputTokens?: number;
  lastTotalWebSearchRequests?: number;
  lastFpsAverage?: number;
  lastFpsLow1Pct?: number;
  lastSessionId?: string;
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      webSearchRequests: number;
      costUSD: number;
    }
  >;
  lastSessionMetrics?: Record<string, number>;
  exampleFiles?: string[];
  exampleFilesGeneratedAt?: number;
  activeWorktreeSession?: {
    originalCwd: string;
    worktreePath: string;
    worktreeName: string;
    originalBranch?: string;
    sessionId: string;
    hookBased?: boolean;
  };
};

export type InstallMethod = "local" | "native" | "global" | "unknown";

/**
 * Mutable state is limited to observations, acknowledgements, and bounded
 * caches. Operator preferences are resolved from config.toml and credentials
 * live in native secure storage.
 */
export type GlobalRuntimeState = {
  projects?: Record<string, ProjectRuntimeState>;
  installMethod?: InstallMethod;
  userID?: string;
  hasAcknowledgedCostThreshold?: boolean;
  hasUsedBackslashReturn?: boolean;
  hasSeenTasksHint?: boolean;
  hasUsedStash?: boolean;
  appleTerminalBackupPath?: string;
  appleTerminalSetupInProgress?: boolean;
  shiftEnterKeyBindingInstalled?: boolean;
  optionAsMetaKeyInstalled?: boolean;
  hasIdeOnboardingBeenShown?: Record<string, boolean>;
  iterm2It2SetupComplete?: boolean;
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>;
  permissions?: {
    bypassPermissionsAcceptedByCwd?: Record<
      string,
      {
        version: 1;
        canonicalCwd: string;
        dev: string;
        ino: string;
      }
    >;
  };
};

function freezeRuntimeStateValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) freezeRuntimeStateValue(item);
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) freezeRuntimeStateValue(item);
    return Object.freeze(value);
  }
  return value;
}

function immutableGlobalState(
  state: Readonly<GlobalRuntimeState>,
): GlobalRuntimeState {
  return freezeRuntimeStateValue(
    cloneRecord(state as Readonly<Record<string, unknown>>),
  ) as GlobalRuntimeState;
}

function immutableProjectState(
  state: Readonly<ProjectRuntimeState>,
): ProjectRuntimeState {
  return freezeRuntimeStateValue(
    cloneRecord(state as Readonly<Record<string, unknown>>),
  ) as ProjectRuntimeState;
}

export const DEFAULT_GLOBAL_RUNTIME_STATE: GlobalRuntimeState =
  immutableGlobalState({});
const DEFAULT_PROJECT_RUNTIME_STATE: ProjectRuntimeState = Object.freeze({});
const STATE_FRESHNESS_POLL_MS = 1_000;
const STATE_BACKUP_INTERVAL_MS = 60_000;
const STATE_BACKUP_RETENTION = 5;
const STATE_BACKUP_DIRECTORY_MODE = 0o700;
const STATE_BACKUP_FILE_MODE = 0o600;

class RuntimeStateBackupSecurityError extends Error {
  readonly name = "RuntimeStateBackupSecurityError";
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.path = path;
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(info: BigIntStats): boolean {
  return process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    info.uid === BigInt(process.getuid());
}

function hasOwnerOnlyMode(info: BigIntStats, mode: number): boolean {
  return process.platform === "win32" ||
    (info.mode & 0o777n) === BigInt(mode);
}

function backupDirectoryError(path: string, detail: string): never {
  throw new RuntimeStateBackupSecurityError(`${detail}: ${path}`, path);
}

function assertBackupDirectorySecurity(path: string, info: BigIntStats): void {
  if (!ownedByCurrentUser(info)) {
    backupDirectoryError(
      path,
      "runtime-state backup directory must be owned by the current user",
    );
  }
  if (!hasOwnerOnlyMode(info, STATE_BACKUP_DIRECTORY_MODE)) {
    backupDirectoryError(
      path,
      "runtime-state backup directory must have owner-only permissions",
    );
  }
}

function assertBackupFileSecurity(path: string, info: BigIntStats): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    !ownedByCurrentUser(info) ||
    !hasOwnerOnlyMode(info, STATE_BACKUP_FILE_MODE)
  ) {
    backupDirectoryError(
      path,
      "runtime-state backup destination must be one owner-only regular file",
    );
  }
}

function attachBackupCleanupErrors(
  primary: unknown,
  cleanupErrors: readonly Error[],
): void {
  if (cleanupErrors.length === 0) return;
  try {
    if (
      primary !== null &&
      (typeof primary === "object" || typeof primary === "function") &&
      Object.isExtensible(primary)
    ) {
      Object.defineProperty(primary, "cleanupErrors", {
        configurable: true,
        value: Object.freeze([...cleanupErrors]),
      });
    }
  } catch {
    // The exact primary backup/security failure remains authoritative.
  }
}

function asBackupError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

interface SecuredBackupDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly descriptor?: number;
}

function assertBackupDirectoryIdentity(
  directory: SecuredBackupDirectory,
): BigIntStats {
  let current: BigIntStats;
  try {
    current = lstatSync(directory.path, { bigint: true });
  } catch {
    backupDirectoryError(
      directory.path,
      "runtime-state backup directory became unavailable",
    );
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameFileIdentity(directory.identity, current)
  ) {
    backupDirectoryError(
      directory.path,
      "runtime-state backup directory changed identity",
    );
  }
  assertBackupDirectorySecurity(directory.path, current);
  if (directory.descriptor !== undefined) {
    const opened = fstatSync(directory.descriptor, { bigint: true });
    if (!opened.isDirectory() || !sameFileIdentity(current, opened)) {
      backupDirectoryError(
        directory.path,
        "runtime-state backup directory no longer matches its open descriptor",
      );
    }
    assertBackupDirectorySecurity(directory.path, opened);
  }
  return current;
}

function secureBackupDirectory(path: string): SecuredBackupDirectory {
  try {
    mkdirSync(path, { mode: STATE_BACKUP_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    backupDirectoryError(
      path,
      "runtime-state backup path must be a real directory",
    );
  }
  if (!ownedByCurrentUser(before)) {
    backupDirectoryError(
      path,
      "runtime-state backup directory must be owned by the current user",
    );
  }

  let descriptor: number | undefined;
  if (process.platform === "win32") {
    chmodSync(path, STATE_BACKUP_DIRECTORY_MODE);
  } else {
    const flags = fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0);
    try {
      descriptor = openSync(path, flags);
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || !sameFileIdentity(before, opened)) {
        backupDirectoryError(
          path,
          "runtime-state backup directory changed while it was opened",
        );
      }
      fchmodSync(descriptor, STATE_BACKUP_DIRECTORY_MODE);
    } catch (error) {
      const cleanupErrors: Error[] = [];
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch (closeError) {
          cleanupErrors.push(asBackupError(closeError));
        }
        descriptor = undefined;
      }
      attachBackupCleanupErrors(error, cleanupErrors);
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        const securityError = new RuntimeStateBackupSecurityError(
          `runtime-state backup path must not be a symbolic link: ${path}`,
          path,
        );
        attachBackupCleanupErrors(securityError, cleanupErrors);
        throw securityError;
      }
      throw error;
    }
  }

  const secured = Object.freeze({
    path,
    identity: Object.freeze({ dev: before.dev, ino: before.ino }),
    ...(descriptor !== undefined ? { descriptor } : {}),
  });
  try {
    assertBackupDirectoryIdentity(secured);
    return secured;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        attachBackupCleanupErrors(error, [asBackupError(closeError)]);
      }
    }
    throw error;
  }
}

function closeBackupDirectory(directory: SecuredBackupDirectory): void {
  if (directory.descriptor === undefined) return;
  closeSync(directory.descriptor);
}

function backupTimestamp(fileBase: string, entry: string): number | null {
  const prefix = `${fileBase}.backup.`;
  if (!entry.startsWith(prefix)) return null;
  const value = entry.slice(prefix.length);
  return /^\d+$/u.test(value) ? Number(value) : null;
}

interface StateBackupEntry {
  readonly name: string;
  readonly timestamp: number;
  readonly identity: FileIdentity;
}

function readExactBackupBytes(
  descriptor: number,
  expected: Buffer,
  path: string,
): void {
  const actual = Buffer.alloc(expected.length);
  let offset = 0;
  while (offset < actual.length) {
    const count = readSync(
      descriptor,
      actual,
      offset,
      actual.length - offset,
      offset,
    );
    if (count === 0) {
      backupDirectoryError(path, "runtime-state backup verification was truncated");
    }
    offset += count;
  }
  if (!actual.equals(expected)) {
    backupDirectoryError(path, "runtime-state backup bytes changed while staged");
  }
}

function removeBackupArtifactIfIdentity(
  path: string,
  identity: FileIdentity,
  expectedLinks: bigint,
): void {
  let current: BigIntStats;
  try {
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== expectedLinks ||
    !sameFileIdentity(current, identity) ||
    !ownedByCurrentUser(current) ||
    !hasOwnerOnlyMode(current, STATE_BACKUP_FILE_MODE)
  ) {
    backupDirectoryError(
      path,
      "runtime-state backup cleanup preserved a changed artifact",
    );
  }
  unlinkSync(path);
}

function verifiedBackupEntries(
  directory: SecuredBackupDirectory,
  fileBase: string,
): readonly StateBackupEntry[] {
  assertBackupDirectoryIdentity(directory);
  const entries: StateBackupEntry[] = [];
  for (const entry of readdirSync(directory.path, { withFileTypes: true })) {
    const timestamp = backupTimestamp(fileBase, entry.name);
    if (timestamp === null || !Number.isSafeInteger(timestamp)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const path = join(directory.path, entry.name);
    const info = lstatSync(path, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      !ownedByCurrentUser(info) ||
      !hasOwnerOnlyMode(info, STATE_BACKUP_FILE_MODE)
    ) {
      continue;
    }
    entries.push(Object.freeze({
      name: entry.name,
      timestamp,
      identity: Object.freeze({ dev: info.dev, ino: info.ino }),
    }));
  }
  assertBackupDirectoryIdentity(directory);
  return Object.freeze(
    entries.sort((left, right) =>
      right.timestamp - left.timestamp ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    ),
  );
}

function createStateBackup(
  directory: SecuredBackupDirectory,
  backupPath: string,
  snapshot: CanonicalStateFileSnapshot,
): void {
  const stagePath = `${backupPath}.stage-${process.pid}-${randomUUID()}`;
  const sourceBytes = Buffer.from(snapshot.bytes);
  let descriptor: number | undefined;
  let identity: FileIdentity | undefined;
  let linked = false;
  try {
    assertBackupDirectoryIdentity(directory);
    descriptor = openSync(
      stagePath,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      STATE_BACKUP_FILE_MODE,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    identity = Object.freeze({ dev: opened.dev, ino: opened.ino });
    if (!ownedByCurrentUser(opened)) {
      backupDirectoryError(
        stagePath,
        "runtime-state backup stage must be owned by the current user",
      );
    }
    if (process.platform !== "win32") {
      fchmodSync(descriptor, STATE_BACKUP_FILE_MODE);
    }
    const secured = fstatSync(descriptor, { bigint: true });
    assertBackupFileSecurity(stagePath, secured);
    if (!sameFileIdentity(opened, secured)) {
      backupDirectoryError(
        stagePath,
        "runtime-state backup stage changed while permissions were set",
      );
    }
    writeFileSync(descriptor, sourceBytes);
    fsyncSync(descriptor);
    const written = fstatSync(descriptor, { bigint: true });
    assertBackupFileSecurity(stagePath, written);
    if (
      !sameFileIdentity(identity, written) ||
      written.size !== BigInt(sourceBytes.length)
    ) {
      backupDirectoryError(
        stagePath,
        "runtime-state backup stage changed while it was written",
      );
    }
    readExactBackupBytes(descriptor, sourceBytes, stagePath);
    try {
      closeSync(descriptor);
    } finally {
      descriptor = undefined;
    }

    assertBackupDirectoryIdentity(directory);
    try {
      linkSync(stagePath, backupPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        backupDirectoryError(
          backupPath,
          "runtime-state backup destination already exists",
        );
      }
      throw error;
    }
    const stagedAfterLink = lstatSync(stagePath, { bigint: true });
    const publishedLink = lstatSync(backupPath, { bigint: true });
    if (
      identity === undefined ||
      !sameFileIdentity(identity, stagedAfterLink) ||
      !sameFileIdentity(identity, publishedLink) ||
      stagedAfterLink.nlink !== 2n ||
      publishedLink.nlink !== 2n ||
      !stagedAfterLink.isFile() ||
      !publishedLink.isFile() ||
      !ownedByCurrentUser(stagedAfterLink) ||
      !ownedByCurrentUser(publishedLink) ||
      !hasOwnerOnlyMode(stagedAfterLink, STATE_BACKUP_FILE_MODE) ||
      !hasOwnerOnlyMode(publishedLink, STATE_BACKUP_FILE_MODE)
    ) {
      backupDirectoryError(
        backupPath,
        "runtime-state backup publication changed its staged identity",
      );
    }
    removeBackupArtifactIfIdentity(stagePath, identity, 2n);
    linked = false;
    const published = lstatSync(backupPath, { bigint: true });
    if (!sameFileIdentity(identity, published)) {
      backupDirectoryError(
        backupPath,
        "runtime-state backup destination changed after publication",
      );
    }
    assertBackupFileSecurity(backupPath, published);
    assertBackupDirectoryIdentity(directory);
  } catch (error) {
    const cleanupErrors: Error[] = [];
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        cleanupErrors.push(asBackupError(closeError));
      }
      descriptor = undefined;
    }
    if (identity !== undefined) {
      if (linked) {
        try {
          removeBackupArtifactIfIdentity(backupPath, identity, 2n);
          linked = false;
        } catch (cleanupError) {
          cleanupErrors.push(asBackupError(cleanupError));
        }
      }
      try {
        removeBackupArtifactIfIdentity(
          stagePath,
          identity,
          linked ? 2n : 1n,
        );
      } catch (cleanupError) {
        cleanupErrors.push(asBackupError(cleanupError));
      }
    }
    attachBackupCleanupErrors(error, cleanupErrors);
    throw error;
  }
}

type WatchFile = (
  path: string,
  options: { readonly interval: number; readonly persistent: boolean },
  listener: (current: Stats, previous: Stats) => void,
) => void;
type UnwatchFile = (path: string) => void;

export interface RuntimeStateRepositoryOptions {
  /** Tests default to isolated in-memory state; disk tests opt in explicitly. */
  readonly storage?: "disk" | "memory";
  readonly watchFile?: WatchFile;
  readonly unwatchFile?: UnwatchFile;
  readonly freshnessPollMs?: number;
}

interface StateCache {
  readonly loaded: boolean;
  readonly config: GlobalRuntimeState | null;
  readonly error?: Error;
}

function globalStateFromDocument(
  document: CanonicalStateDocument | null,
  path: string,
): GlobalRuntimeState {
  const state = document
    ? (getGlobalRuntimeState(document, path) as GlobalRuntimeState)
    : {};
  return immutableGlobalState(state);
}

function serializableGlobalState(
  state: GlobalRuntimeState,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined),
  );
}

function removeProjectHistory(
  projects: Record<string, ProjectRuntimeState> | undefined,
): Record<string, ProjectRuntimeState> | undefined {
  if (!projects) return projects;
  let changed = false;
  const cleaned: Record<string, ProjectRuntimeState> = {};
  for (const [path, project] of Object.entries(projects)) {
    const input = project as ProjectRuntimeState & { history?: unknown };
    if (input.history === undefined) {
      cleaned[path] = project;
      continue;
    }
    changed = true;
    const { history: _history, ...withoutHistory } = input;
    cleaned[path] = withoutHistory;
  }
  return changed ? cleaned : projects;
}

function reportCommittedStateWriteOutcome(
  path: string,
  outcome: CanonicalStateWriteOutcome,
): void {
  if (
    outcome.directoryDurability === "confirmed" &&
    outcome.postCommitErrors.length === 0
  ) {
    return;
  }
  try {
    const details = outcome.postCommitErrors
      .map((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        return code === undefined ? error.message : `${code}: ${error.message}`;
      })
      .join("; ");
    logForDebugging(
      `Runtime state committed at ${path}, but directory durability is ${outcome.directoryDurability}${details.length > 0 ? ` (${details})` : ""}`,
      { level: "warn" },
    );
  } catch {
    // Diagnostic reporting must not turn an already committed write into a
    // caller-visible persistence failure.
  }
}

function reportAuthorityReleaseErrors(
  path: string,
  errors: readonly Error[],
): void {
  if (errors.length === 0) return;
  try {
    const details = errors
      .map((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        return code === undefined ? error.message : `${code}: ${error.message}`;
      })
      .join("; ");
    logForDebugging(
      `Runtime state operation completed at ${path}, but its authority lock release failed (${details})`,
      { level: "warn" },
    );
  } catch {
    // Diagnostics cannot change an already completed authority operation.
  }
}

interface RuntimeStateSaveOutcome {
  readonly writeOutcome: CanonicalStateWriteOutcome | null;
  readonly postOperationReleaseErrors: readonly Error[];
}

/**
 * Mutable state authority for exactly one immutable AgenC home.
 *
 * Every cache, watcher generation, in-memory test fixture, backup path, and
 * lock target belongs to this instance. The repository never consults
 * process.env and therefore cannot switch homes after construction.
 */
export class RuntimeStateRepository {
  readonly homeContext: HomeContext;

  readonly #storage: "disk" | "memory";
  readonly #watchFile: WatchFile;
  readonly #unwatchFile: UnwatchFile;
  readonly #freshnessPollMs: number;
  #cache: StateCache = { loaded: false, config: null };
  #memoryState: GlobalRuntimeState = immutableGlobalState({});
  #watcherStarted = false;
  #closed = false;
  #refreshGeneration = 0;

  constructor(
    homeContext: HomeContext,
    options: RuntimeStateRepositoryOptions = {},
  ) {
    this.homeContext = Object.freeze({ ...homeContext });
    this.#storage = options.storage ??
      (process.env.NODE_ENV === "test" ? "memory" : "disk");
    this.#watchFile = options.watchFile ?? nodeWatchFile;
    this.#unwatchFile = options.unwatchFile ?? nodeUnwatchFile;
    this.#freshnessPollMs = options.freshnessPollMs ?? STATE_FRESHNESS_POLL_MS;
  }

  get statePath(): string {
    return this.homeContext.statePath;
  }

  get(): GlobalRuntimeState {
    if (this.#storage === "memory") return this.#memoryState;
    if (this.#cache.error) throw this.#cache.error;
    if (this.#cache.loaded && this.#cache.config !== null) {
      return this.#cache.config;
    }
    const state = globalStateFromDocument(this.#readDocumentSync(), this.statePath);
    this.#cache = { loaded: true, config: state };
    this.#startFreshnessWatcher();
    return state;
  }

  getNamespace(namespace: string): Readonly<JsonRecord> {
    const value = (this.get() as unknown as JsonRecord)[namespace];
    if (value === undefined) return Object.freeze({});
    if (!isPlainRecord(value)) {
      throw new StateRepositoryError(
        `state.global.${namespace} must be an object`,
        this.statePath,
      );
    }
    return freezeRuntimeStateValue(cloneRecord(value)) as Readonly<JsonRecord>;
  }

  update(
    updater: (current: GlobalRuntimeState) => GlobalRuntimeState,
  ): void {
    if (this.#storage === "memory") {
      const next = updater(this.#memoryState);
      if (next === this.#memoryState) return;
      this.#memoryState = this.#validatedState({
        ...next,
        projects: removeProjectHistory(next.projects),
      });
      return;
    }

    let written: GlobalRuntimeState | null = null;
    let saveOutcome: RuntimeStateSaveOutcome | null = null;
    try {
      saveOutcome = this.#saveWithLock((current) => {
        const next = updater(current);
        if (next === current) return current;
        written = this.#validatedState({
          ...next,
          projects: removeProjectHistory(next.projects),
        });
        return written;
      });
      if (saveOutcome.writeOutcome !== null && written !== null) {
        this.#refreshGeneration += 1;
        this.#cache = { loaded: true, config: written };
      }
    } catch (error) {
      try {
        logForDebugging(`Failed to save runtime state with lock: ${error}`, {
          level: "error",
        });
      } catch {
        // Preserve the exact authority-operation failure.
      }
      throw error;
    }
    if (saveOutcome !== null) {
      if (saveOutcome.writeOutcome !== null) {
        reportCommittedStateWriteOutcome(
          this.statePath,
          saveOutcome.writeOutcome,
        );
      }
      reportAuthorityReleaseErrors(
        this.statePath,
        saveOutcome.postOperationReleaseErrors,
      );
    }
  }

  updateNamespace(
    namespace: string,
    updater: (current: Readonly<JsonRecord>) => JsonRecord,
  ): void {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(namespace)) {
      throw new StateRepositoryError(
        `invalid runtime-state namespace: ${namespace}`,
        this.statePath,
      );
    }
    this.update((current) => {
      const existing = (current as unknown as JsonRecord)[namespace];
      if (existing !== undefined && !isPlainRecord(existing)) {
        throw new StateRepositoryError(
          `state.global.${namespace} must be an object`,
          this.statePath,
        );
      }
      const next = updater(
        freezeRuntimeStateValue(existing ? cloneRecord(existing) : {}) as
          Readonly<JsonRecord>,
      );
      if (!isPlainRecord(next)) {
        throw new StateRepositoryError(
          `runtime-state namespace updater must return an object: ${namespace}`,
          this.statePath,
        );
      }
      return { ...current, [namespace]: cloneRecord(next) };
    });
  }

  getProject(projectPath: string): ProjectRuntimeState {
    return immutableProjectState(
      this.get().projects?.[projectPath] ?? DEFAULT_PROJECT_RUNTIME_STATE,
    );
  }

  updateProject(
    projectPath: string,
    updater: (current: ProjectRuntimeState) => ProjectRuntimeState,
  ): void {
    this.update((current) => {
      const existing = current.projects?.[projectPath] ??
        DEFAULT_PROJECT_RUNTIME_STATE;
      const next = updater(existing);
      if (next === existing) return current;
      return {
        ...current,
        projects: { ...current.projects, [projectPath]: next },
      };
    });
  }

  /** Clear this authority's cache only; the next read is synchronous/fail-closed. */
  invalidate(): void {
    if (this.#storage === "memory") return;
    this.#refreshGeneration += 1;
    this.#cache = { loaded: false, config: null };
  }

  /** Explicit reload used by config/state change fan-out and isolation tests. */
  reload(): GlobalRuntimeState {
    if (this.#storage === "memory") return this.#memoryState;
    this.invalidate();
    return this.get();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#refreshGeneration += 1;
    if (this.#watcherStarted) {
      this.#unwatchFile(this.statePath);
      this.#watcherStarted = false;
    }
  }

  /** Instance-local test fixture; it cannot alter another home. */
  setForTesting(state: GlobalRuntimeState): void {
    if (this.#storage !== "memory") {
      throw new Error("setForTesting is available only on an in-memory state repository");
    }
    this.#memoryState = this.#validatedState(state);
  }

  #validatedState(state: GlobalRuntimeState): GlobalRuntimeState {
    const document = withGlobalRuntimeState(
      createCanonicalStateDocument(),
      serializableGlobalState(state),
    );
    return globalStateFromDocument(document, this.statePath);
  }

  #readDocumentSync(): CanonicalStateDocument | null {
    return readCanonicalStateSync(this.statePath);
  }

  #readSnapshotSync(): CanonicalStateFileSnapshot | null {
    return readCanonicalStateSnapshotSync(this.statePath);
  }

  #startFreshnessWatcher(): void {
    if (this.#watcherStarted || this.#closed || this.#storage === "memory") return;
    this.#watcherStarted = true;
    this.#watchFile(
      this.statePath,
      { interval: this.#freshnessPollMs, persistent: false },
      () => this.#refreshAfterWatchEvent(),
    );
    registerCleanup(async () => this.close());
  }

  #refreshAfterWatchEvent(): void {
    const generation = ++this.#refreshGeneration;
    void readCanonicalState(this.statePath)
      .then((document) => {
        if (this.#closed || generation !== this.#refreshGeneration) return;
        this.#cache = {
          loaded: true,
          config: globalStateFromDocument(document, this.statePath),
        };
      })
      .catch((error: unknown) => {
        if (this.#closed || generation !== this.#refreshGeneration) return;
        this.#cache = {
          loaded: true,
          config: null,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      });
  }

  #saveWithLock(
    merge: (current: GlobalRuntimeState) => GlobalRuntimeState,
  ): RuntimeStateSaveOutcome {
    const file = this.statePath;
    const startedAt = Date.now();
    const lockOutcome = runWithConfigAuthorityLockSync(file, () => {
      if (Date.now() - startedAt > 100) {
        logForDebugging(
          "Runtime state lock acquisition took longer than expected - another AgenC instance may be running",
        );
      }

      const currentSnapshot = this.#readSnapshotSync();
      const currentDocument = currentSnapshot?.document ?? null;
      const current = globalStateFromDocument(currentDocument, file);
      const merged = merge(current);
      if (merged === current) return null;

      this.#backupExistingState(currentSnapshot);
      const document = withGlobalRuntimeState(
        currentDocument ?? createCanonicalStateDocument(),
        serializableGlobalState(merged),
      );
      return writeCanonicalStateAtomicSync(file, document, {
        expected: currentSnapshot,
      });
    });
    if (lockOutcome.status === "failed") throw lockOutcome.error;
    return Object.freeze({
      writeOutcome: lockOutcome.value,
      postOperationReleaseErrors: lockOutcome.postOperationReleaseErrors,
    });
  }

  #backupExistingState(snapshot: CanonicalStateFileSnapshot | null): void {
    if (snapshot === null) return;
    let directory: SecuredBackupDirectory | undefined;
    let primaryFailure: unknown;
    try {
      const fileBase = basename(this.statePath);
      directory = secureBackupDirectory(
        join(this.homeContext.path, "backups"),
      );
      const existing = verifiedBackupEntries(directory, fileBase);
      const now = Date.now();
      const shouldCreate = existing[0] === undefined ||
        now - existing[0].timestamp >= STATE_BACKUP_INTERVAL_MS;
      let forCleanup = existing;
      if (shouldCreate) {
        assertBackupDirectoryIdentity(directory);
        const backupPath = join(
          directory.path,
          `${fileBase}.backup.${now}`,
        );
        createStateBackup(directory, backupPath, snapshot);
        forCleanup = verifiedBackupEntries(directory, fileBase);
      }

      for (const oldBackup of forCleanup.slice(STATE_BACKUP_RETENTION)) {
        assertBackupDirectoryIdentity(directory);
        const oldPath = join(directory.path, oldBackup.name);
        const cleanupPath = `${oldPath}.cleanup-${process.pid}-${randomUUID()}`;
        try {
          const current = lstatSync(oldPath, { bigint: true });
          if (
            current.isSymbolicLink() ||
            !current.isFile() ||
            current.nlink !== 1n ||
            !sameFileIdentity(oldBackup.identity, current) ||
            !ownedByCurrentUser(current) ||
            !hasOwnerOnlyMode(current, STATE_BACKUP_FILE_MODE)
          ) {
            continue;
          }
          renameSync(oldPath, cleanupPath);
          const quarantined = lstatSync(cleanupPath, { bigint: true });
          if (
            quarantined.isSymbolicLink() ||
            !quarantined.isFile() ||
            quarantined.nlink !== 1n ||
            !sameFileIdentity(oldBackup.identity, quarantined) ||
            !ownedByCurrentUser(quarantined) ||
            !hasOwnerOnlyMode(quarantined, STATE_BACKUP_FILE_MODE)
          ) {
            continue;
          }
          removeBackupArtifactIfIdentity(
            cleanupPath,
            oldBackup.identity,
            1n,
          );
          assertBackupDirectoryIdentity(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          // Cleanup is best-effort after type and directory verification.
        }
      }
      if (directory.descriptor !== undefined) {
        try {
          fsyncSync(directory.descriptor);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code !== "EINVAL" &&
            code !== "ENOSYS" &&
            code !== "ENOTSUP" &&
            code !== "EOPNOTSUPP"
          ) {
            throw error;
          }
        }
      }
    } catch (error) {
      primaryFailure = error;
      try {
        logForDebugging(`Failed to backup runtime state: ${error}`, {
          level: "error",
        });
      } catch {
        // Diagnostic reporting cannot replace the exact backup failure.
      }
      throw error;
    } finally {
      if (directory !== undefined) {
        try {
          closeBackupDirectory(directory);
        } catch (closeError) {
          if (primaryFailure !== undefined) {
            attachBackupCleanupErrors(primaryFailure, [asBackupError(closeError)]);
          } else {
            try {
              logForDebugging(
                `Runtime-state backup completed, but closing its secured directory failed: ${closeError}`,
                { level: "warn" },
              );
            } catch {
              // Post-backup diagnostics cannot reject a completed backup.
            }
          }
        }
      }
    }
  }
}

import {
  type Stats,
  unwatchFile as nodeUnwatchFile,
  watchFile as nodeWatchFile,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { cloneRecord, isPlainRecord, type JsonRecord } from "./json.js";
import {
  createCanonicalStateDocument,
  getGlobalRuntimeState,
  parseCanonicalStateDocument,
  StateRepositoryError,
  withGlobalRuntimeState,
  writeCanonicalStateAtomicSync,
  type CanonicalStateDocument,
} from "./state.js";
import type { HomeContext } from "./home.js";
import { registerCleanup } from "../utils/cleanupRegistry.js";
import { logForDebugging } from "../utils/debug.js";
import { getErrnoCode } from "../utils/errors.js";
import { getFsImplementation } from "../utils/fsOperations.js";
import * as lockfile from "../utils/lockfile.js";

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
  penguinModeOrgEnabled?: boolean;
  cachedExtraUsageDisabledReason?: string | null;
  settings?: {
    fastModePerSessionOptIn?: boolean;
    bypassPermissionsModeAcceptedIn?: string[];
  };
};

export const DEFAULT_GLOBAL_RUNTIME_STATE: GlobalRuntimeState = Object.freeze({});
const DEFAULT_PROJECT_RUNTIME_STATE: ProjectRuntimeState = Object.freeze({});
const STATE_FRESHNESS_POLL_MS = 1_000;

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
  return document
    ? (getGlobalRuntimeState(document, path) as GlobalRuntimeState)
    : {};
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
  #memoryState: GlobalRuntimeState = {};
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
    return Object.freeze(cloneRecord(value));
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
    try {
      const didWrite = this.#saveWithLock((current) => {
        const next = updater(current);
        if (next === current) return current;
        written = this.#validatedState({
          ...next,
          projects: removeProjectHistory(next.projects),
        });
        return written;
      });
      if (didWrite && written !== null) {
        this.#refreshGeneration += 1;
        this.#cache = { loaded: true, config: written };
      }
    } catch (error) {
      logForDebugging(`Failed to save runtime state with lock: ${error}`, {
        level: "error",
      });
      throw error;
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
        Object.freeze(existing ? cloneRecord(existing) : {}),
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
    return this.get().projects?.[projectPath] ?? DEFAULT_PROJECT_RUNTIME_STATE;
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
    try {
      const content = getFsImplementation().readFileSync(this.statePath, {
        encoding: "utf-8",
      });
      return parseCanonicalStateDocument(content, this.statePath);
    } catch (error) {
      if (getErrnoCode(error) === "ENOENT") return null;
      throw error;
    }
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
    void getFsImplementation()
      .readFile(this.statePath, { encoding: "utf-8" })
      .then((content) => {
        if (this.#closed || generation !== this.#refreshGeneration) return;
        const document = parseCanonicalStateDocument(content, this.statePath);
        this.#cache = {
          loaded: true,
          config: globalStateFromDocument(document, this.statePath),
        };
      })
      .catch((error: unknown) => {
        if (this.#closed || generation !== this.#refreshGeneration) return;
        if (getErrnoCode(error) === "ENOENT") {
          this.#cache = { loaded: true, config: {} };
          return;
        }
        this.#cache = {
          loaded: true,
          config: null,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      });
  }

  #saveWithLock(
    merge: (current: GlobalRuntimeState) => GlobalRuntimeState,
  ): boolean {
    const file = this.statePath;
    const fs = getFsImplementation();
    fs.mkdirSync(dirname(file));

    let release: (() => void) | undefined;
    try {
      const startedAt = Date.now();
      release = lockfile.lockSync(file, {
        lockfilePath: `${file}.lock`,
        onCompromised: (error) => {
          logForDebugging(`Runtime state lock compromised: ${error}`, {
            level: "error",
          });
        },
      });
      if (Date.now() - startedAt > 100) {
        logForDebugging(
          "Runtime state lock acquisition took longer than expected - another AgenC instance may be running",
        );
      }

      const currentDocument = this.#readDocumentSync();
      const current = globalStateFromDocument(currentDocument, file);
      const merged = merge(current);
      if (merged === current) return false;

      this.#backupExistingState(file);
      const document = withGlobalRuntimeState(
        currentDocument ?? createCanonicalStateDocument(),
        serializableGlobalState(merged),
      );
      writeCanonicalStateAtomicSync(file, document);
      return true;
    } finally {
      release?.();
    }
  }

  #backupExistingState(file: string): void {
    const fs = getFsImplementation();
    try {
      const fileBase = basename(file);
      const backupDir = join(this.homeContext.path, "backups");
      try {
        fs.mkdirSync(backupDir);
      } catch (error) {
        if (getErrnoCode(error) !== "EEXIST") throw error;
      }

      const existing = fs
        .readdirStringSync(backupDir)
        .filter((entry) => entry.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse();
      const timestamp = existing[0]
        ? Number(existing[0].split(".backup.").pop())
        : 0;
      const shouldCreate = Number.isNaN(timestamp) ||
        Date.now() - timestamp >= 60_000;
      if (shouldCreate) {
        fs.copyFileSync(file, join(backupDir, `${fileBase}.backup.${Date.now()}`));
      }

      const forCleanup = shouldCreate
        ? fs
          .readdirStringSync(backupDir)
          .filter((entry) => entry.startsWith(`${fileBase}.backup.`))
          .sort()
          .reverse()
        : existing;
      for (const oldBackup of forCleanup.slice(5)) {
        try {
          fs.unlinkSync(join(backupDir, oldBackup));
        } catch {
          // A backup cleanup failure must not prevent the canonical write.
        }
      }
    } catch (error) {
      if (getErrnoCode(error) !== "ENOENT") {
        logForDebugging(`Failed to backup runtime state: ${error}`, {
          level: "error",
        });
      }
    }
  }
}

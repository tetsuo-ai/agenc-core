/** Persistent, cancellation-safe fuzzy-file search for the daemon protocol. */

import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, posix, relative } from "node:path";
import {
  BoundedFuzzyMatcher,
  FuzzyMatchWorkBudget,
  FuzzyBoundaryError,
  MAX_FUZZY_CANDIDATES,
  MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES,
  comparePortablePaths,
  estimateFuzzyCandidateRetainedBytes,
  fuzzyPathRankScore,
  isFuzzyQueryExtension,
  prepareFuzzyCandidate,
  validateFuzzyCandidate,
  validateFuzzyQuery,
} from "../search/fuzzy-match.js";
import {
  canonicalizeFuzzyIndexRoot,
  discoverFuzzyFiles,
  FUZZY_INDEX_IDLE_TTL_MS as PERSISTENT_FUZZY_INDEX_IDLE_TTL_MS,
  FUZZY_FILE_INDEX_SCHEMA_VERSION,
  FuzzyIndexBoundaryError,
  FuzzyIndexBuildCancelledError,
  FuzzyIndexSourceChangedError,
  openPersistentFuzzyFileIndex,
  type FuzzyFileDiscovery,
  type FuzzyFileDiscoveryResult,
  type FuzzyIndexedEntry,
  type FuzzyIndexSnapshot,
  type PersistentFuzzyFileIndex,
} from "./fuzzy-file-index.js";
import type {
  FuzzyFileIndexFreshness,
  FuzzyFileIndexRootFreshness,
  FuzzyFileMatcherMetadata,
  FuzzyFileSearchParams,
  FuzzyFileSearchResponse,
  FuzzyFileSearchResult,
} from "./protocol/index.js";

export const DEFAULT_FUZZY_RESULTS = 50;
export const MAX_FUZZY_RESULTS = 1_000;
export const MAX_FUZZY_QUERY_CODEPOINTS = 256;
export const MAX_FUZZY_RAW_ROOTS = 64;
export const MAX_FUZZY_FILE_ROOTS = 32;
export const MAX_FUZZY_FILE_ROOT_UTF8_BYTES = 16_384;
export const MAX_FUZZY_FILE_ROOTS_UTF8_BYTES = 262_144;
export const MAX_FUZZY_FILE_ACTIVE_ROOT_STATES = 64;
export const MAX_FUZZY_WATCHERS = 64;
export const MAX_FUZZY_CACHE_BYTES = 536_870_912;
export const FUZZY_INDEX_IDLE_TTL_MS = PERSISTENT_FUZZY_INDEX_IDLE_TTL_MS;
export const MAX_FUZZY_QUERY_MATRIX_CELLS = 16_777_216;
export const MAX_FUZZY_QUERY_CODEPOINT_VISITS = 100_000_000;
export const MAX_FUZZY_QUERY_MS = 500;
export const MAX_FUZZY_CONCURRENT_BUILDS = 2;
export const MAX_FUZZY_BUILD_QUEUE = 64;
export const FUZZY_WATCH_DEBOUNCE_MS = 100;
export const MIN_FUZZY_AUDIT_INTERVAL_MS = 60_000;
export const MAX_FUZZY_AUDIT_BACKOFF_MS = 3_600_000;

const MATCH_YIELD_INTERVAL = 1_024;
const FUZZY_AUDIT_BUILD_DURATION_MULTIPLIER = 10;
const FUZZY_QUERY_CACHE_REFERENCE_BYTES = 16;
const FUZZY_SNAPSHOT_RETAINED_OVERHEAD_BYTES = 256;
const FUZZY_ENTRY_RETAINED_OVERHEAD_BYTES = 128;
const FUZZY_BUFFER_RETAINED_OVERHEAD_BYTES = 96;
const FUZZY_ARRAY_REFERENCE_BYTES = 8;
const WATCHER_STATUS_ACTIVE = "active";
const WATCHER_STATUS_UNSUPPORTED = "unsupported";
const WATCHER_STATUS_FAILED = "failed";
const WATCHER_STATUS_NOT_STARTED = "not_started";
const STALE_REASON_RESTART_GAP = "restart_gap";
const STALE_REASON_WATCHER_EVENT = "watcher_event";
const STALE_REASON_WATCHER_UNAVAILABLE = "watcher_unavailable";
const STALE_REASON_BUILD_RACE = "changed_during_build";
const DEGRADED_REASON_EMPTY_DIRECTORIES = "empty_directories_unavailable";
const MAX_SOURCE_CONVERGENCE_ATTEMPTS = 3;

type FuzzyWatcherStatus = FuzzyFileIndexRootFreshness["watcherStatus"];

interface ResolvedSearchRoot {
  readonly displayRoot: string;
  readonly canonicalRoot: string;
  readonly order: number;
}

interface RankedEntry {
  readonly entry: FuzzyIndexedEntry;
  readonly root: ResolvedSearchRoot;
  readonly score: number;
  readonly rankScore: number;
}

interface SearchCandidate {
  readonly root: ResolvedSearchRoot;
  readonly entry: FuzzyIndexedEntry;
}

interface QueryCandidateCache {
  readonly generationKey: string;
  readonly query: string;
  readonly candidates: readonly SearchCandidate[];
}

interface RootRuntimeState {
  readonly canonicalRoot: string;
  snapshot: FuzzyIndexSnapshot | null;
  watcher: FSWatcher | null;
  watcherStatus: FuzzyWatcherStatus;
  changeEpoch: number;
  stale: boolean;
  degraded: boolean;
  staleReason: string | null;
  activeBuilds: number;
  activeSearches: number;
  build: RootBuild | null;
  lastAccessMs: number;
  cacheBytes: number;
  watchDebounceTimer: ReturnType<typeof setTimeout> | null;
  lastAuditAtMs: number | null;
  nextAuditAtMs: number;
  auditBackoffMs: number;
}

interface RootBuild {
  readonly controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  settled: boolean;
}

interface QueuedBuild {
  readonly signal: AbortSignal;
  readonly run: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

export interface AgenCFuzzyFileSearch {
  search(
    params: FuzzyFileSearchParams,
    options?: AgenCFuzzyFileSearchSearchOptions,
  ): Promise<FuzzyFileSearchResponse>;
  close?(): void | Promise<void>;
}

export type AgenCFuzzyFileSearchRunner = (
  params: FuzzyFileSearchParams,
  signal: AbortSignal,
) => Promise<readonly FuzzyFileSearchResult[]>;

export interface AgenCFuzzyFileSearchServiceOptions {
  readonly runSearch?: AgenCFuzzyFileSearchRunner;
  readonly index?: PersistentFuzzyFileIndex;
  readonly discover?: FuzzyFileDiscovery;
  readonly now?: () => number;
  readonly watchRoot?: FuzzyRootWatcher;
  readonly maximumRootStates?: number;
  readonly maximumCacheBytes?: number;
  readonly idleTtlMs?: number;
}

export interface AgenCFuzzyFileSearchSearchOptions {
  readonly cancellationScope?: string;
  readonly signal?: AbortSignal;
  /** Trusted authority supplied by the dispatcher, never copied from params. */
  readonly allowedRoots?: readonly string[];
}

export type FuzzyRootWatcher = (
  canonicalRoot: string,
  onChange: () => void,
  onError: () => void,
) => FSWatcher | null;

export class AgenCFuzzyFileSearchService implements AgenCFuzzyFileSearch {
  readonly #pendingByToken = new Map<string, AbortController>();
  readonly #runSearch: AgenCFuzzyFileSearchRunner | null;
  #index: PersistentFuzzyFileIndex | null;
  readonly #ownsIndex: boolean;
  readonly #discover: FuzzyFileDiscovery;
  readonly #now: () => number;
  readonly #watchRoot: FuzzyRootWatcher;
  readonly #rootStates = new Map<string, RootRuntimeState>();
  readonly #maximumRootStates: number;
  readonly #maximumCacheBytes: number;
  readonly #idleTtlMs: number;
  readonly #activeControllers = new Set<AbortController>();
  readonly #activeSettlements = new Set<Promise<void>>();
  readonly #activeBuildSettlements = new Set<Promise<void>>();
  readonly #buildControllers = new Set<AbortController>();
  readonly #buildQueue: QueuedBuild[] = [];
  #queryCandidateCache: QueryCandidateCache | null = null;
  #activeBuildCount = 0;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: AgenCFuzzyFileSearchServiceOptions = {}) {
    this.#runSearch = options.runSearch ?? null;
    this.#index = options.index ?? null;
    this.#ownsIndex = this.#runSearch === null && options.index === undefined;
    this.#discover = options.discover ?? discoverFuzzyFiles;
    this.#now = options.now ?? Date.now;
    this.#watchRoot = options.watchRoot ?? watchFuzzyRoot;
    this.#maximumRootStates = validateMaximumRootStates(
      options.maximumRootStates ?? MAX_FUZZY_FILE_ACTIVE_ROOT_STATES,
    );
    this.#maximumCacheBytes = validatePositiveBoundedOption(
      "maximumCacheBytes",
      options.maximumCacheBytes ?? MAX_FUZZY_CACHE_BYTES,
      MAX_FUZZY_CACHE_BYTES,
    );
    this.#idleTtlMs = validatePositiveBoundedOption(
      "idleTtlMs",
      options.idleTtlMs ?? FUZZY_INDEX_IDLE_TTL_MS,
      FUZZY_INDEX_IDLE_TTL_MS,
    );
  }

  async search(
    params: FuzzyFileSearchParams,
    options: AgenCFuzzyFileSearchSearchOptions = {},
  ): Promise<FuzzyFileSearchResponse> {
    if (this.#closed) throw new Error("fuzzy-file search service is closed");
    validateSearchParamsBeforeIo(params);
    const cancellationToken = normalizedToken(params.cancellationToken);
    const cancellationKey =
      cancellationToken === null
        ? null
        : `${normalizedToken(options.cancellationScope) ?? "default"}\0${cancellationToken}`;
    const controller = new AbortController();
    let settleRequest = (): void => {};
    const settlement = new Promise<void>((resolve) => {
      settleRequest = resolve;
    });
    this.#activeControllers.add(controller);
    this.#activeSettlements.add(settlement);
    const parentSignal = options.signal;
    const forwardParentAbort = (): void => {
      controller.abort(parentSignal?.reason ?? "request.cancel");
    };
    if (parentSignal?.aborted === true) forwardParentAbort();
    else
      parentSignal?.addEventListener("abort", forwardParentAbort, {
        once: true,
      });
    if (cancellationKey !== null) {
      this.#pendingByToken.get(cancellationKey)?.abort();
      this.#pendingByToken.set(cancellationKey, controller);
    }

    try {
      if (params.query.length === 0 || params.roots.length === 0) {
        return { files: [] };
      }
      if (this.#runSearch !== null) {
        await resolveSearchRoots(
          params.roots,
          options.allowedRoots ?? params.roots,
        );
        return { files: await this.#runSearch(params, controller.signal) };
      }
      try {
        return await this.#searchPersistent(
          params,
          controller.signal,
          options.allowedRoots,
        );
      } catch (error) {
        if (error instanceof FuzzyIndexBoundaryError) {
          throw new FuzzyFileSearchBoundaryError(
            "TRAVERSAL_LIMIT",
            error.message,
          );
        }
        throw error;
      }
    } finally {
      if (
        cancellationKey !== null &&
        this.#pendingByToken.get(cancellationKey) === controller
      ) {
        this.#pendingByToken.delete(cancellationKey);
      }
      parentSignal?.removeEventListener("abort", forwardParentAbort);
      this.#activeControllers.delete(controller);
      this.#activeSettlements.delete(settlement);
      settleRequest();
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    for (const controller of this.#activeControllers) {
      controller.abort("fuzzy-file search service closed");
    }
    for (const controller of this.#buildControllers) {
      controller.abort("fuzzy-file search service closed");
    }
    const activeSettlements = [
      ...this.#activeSettlements,
      ...this.#activeBuildSettlements,
    ];
    if (activeSettlements.length === 0) {
      this.#finishClose();
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }
    this.#closePromise = Promise.allSettled(activeSettlements).then(() => {
      this.#finishClose();
    });
    return this.#closePromise;
  }

  #finishClose(): void {
    for (const state of this.#rootStates.values())
      this.#disposeRootState(state);
    this.#rootStates.clear();
    this.#queryCandidateCache = null;
    this.#pendingByToken.clear();
    if (this.#ownsIndex) this.#index?.close();
  }

  async #searchPersistent(
    params: FuzzyFileSearchParams,
    signal: AbortSignal,
    allowedRoots: readonly string[] | undefined,
  ): Promise<FuzzyFileSearchResponse> {
    const roots = await resolveSearchRoots(
      params.roots,
      allowedRoots ?? params.roots,
    );
    const snapshots = new Map<string, FuzzyIndexSnapshot>();
    const pinnedStates = new Map<string, RootRuntimeState>();
    try {
      for (const root of roots) {
        if (signal.aborted) return { files: [] };
        const state = this.#stateForRoot(root.canonicalRoot);
        state.activeSearches += 1;
        pinnedStates.set(root.canonicalRoot, state);
        const shouldAudit =
          state.snapshot !== null && this.#now() >= state.nextAuditAtMs;
        const shouldRefresh =
          params.refresh === true ||
          state.snapshot === null ||
          shouldAudit ||
          (state.activeBuilds === 0 &&
            state.watchDebounceTimer === null &&
            isRefreshableStaleReason(state.staleReason));
        if (shouldRefresh) {
          try {
            await this.#refreshRoot(state, signal);
          } catch (error) {
            if (
              signal.aborted ||
              error instanceof FuzzyIndexBuildCancelledError
            ) {
              return { files: [] };
            }
            if (state.snapshot === null) throw error;
            state.stale = true;
            state.degraded = true;
            state.staleReason = errorMessage(error);
            state.auditBackoffMs = Math.min(
              MAX_FUZZY_AUDIT_BACKOFF_MS,
              state.auditBackoffMs * 2,
            );
            state.nextAuditAtMs = this.#now() + state.auditBackoffMs;
          }
        }
        if (state.snapshot !== null) {
          snapshots.set(root.canonicalRoot, state.snapshot);
        }
      }
      if (signal.aborted) return { files: [] };
      const collection = collectRootEntries(roots, snapshots);
      const generationKey = fuzzyQueryGenerationKey(roots, snapshots);
      const reusableCache = this.#queryCandidateCache;
      const rankingCandidates =
        reusableCache !== null &&
        reusableCache.generationKey === generationKey &&
        isFuzzyQueryExtension(reusableCache.query, params.query, "insensitive")
          ? reusableCache.candidates
          : collection.candidates;
      const ranking = await rankSearchEntries(
        params.query,
        rankingCandidates,
        signal,
        params.limit ?? DEFAULT_FUZZY_RESULTS,
        collection.candidates.length,
      );
      if (signal.aborted) return { files: [] };
      const queryCacheBytes =
        ranking.matchedCandidates.length * FUZZY_QUERY_CACHE_REFERENCE_BYTES;
      if (
        !ranking.matcher.resourceLimited &&
        ranking.matcher.evaluatedCandidates === rankingCandidates.length &&
        cachedRootBytes(this.#rootStates) + queryCacheBytes <=
          this.#maximumCacheBytes
      ) {
        this.#queryCandidateCache = {
          generationKey,
          query: params.query,
          candidates: ranking.matchedCandidates,
        };
      } else {
        this.#queryCandidateCache = null;
      }
      const rootFreshness = roots.map((root) =>
        this.#freshnessForRoot(root, pinnedStates.get(root.canonicalRoot)),
      );
      const freshness: FuzzyFileIndexFreshness = {
        schemaVersion: FUZZY_FILE_INDEX_SCHEMA_VERSION,
        stale: rootFreshness.some((root) => root.stale),
        degraded: rootFreshness.some((root) => root.degraded),
        truncated:
          collection.truncated ||
          ranking.matcher.resourceLimited ||
          rootFreshness.some((root) => root.truncated),
        roots: rootFreshness,
      };
      return {
        files: ranking.files,
        freshness,
        matcher: ranking.matcher,
      };
    } finally {
      for (const state of pinnedStates.values()) state.activeSearches -= 1;
    }
  }

  #stateForRoot(canonicalRoot: string): RootRuntimeState {
    const accessedAtMs = this.#now();
    this.#evictExpiredRootStates(accessedAtMs);
    const existing = this.#rootStates.get(canonicalRoot);
    if (existing !== undefined) {
      existing.lastAccessMs = accessedAtMs;
      this.#rootStates.delete(canonicalRoot);
      this.#rootStates.set(canonicalRoot, existing);
      return existing;
    }
    this.#queryCandidateCache = null;
    this.#evictRootStateForAdmission();
    const snapshot = this.#persistentIndex().readCurrent(canonicalRoot);
    const state: RootRuntimeState = {
      canonicalRoot,
      snapshot,
      watcher: null,
      watcherStatus: WATCHER_STATUS_NOT_STARTED,
      changeEpoch: 0,
      stale: snapshot !== null,
      degraded: snapshot !== null,
      staleReason: snapshot === null ? null : STALE_REASON_RESTART_GAP,
      activeBuilds: 0,
      activeSearches: 0,
      build: null,
      lastAccessMs: accessedAtMs,
      cacheBytes: snapshot === null ? 0 : estimateSnapshotCacheBytes(snapshot),
      watchDebounceTimer: null,
      lastAuditAtMs: snapshot?.builtAtMs ?? null,
      nextAuditAtMs:
        snapshot === null
          ? Number.POSITIVE_INFINITY
          : accessedAtMs + MIN_FUZZY_AUDIT_INTERVAL_MS,
      auditBackoffMs: MIN_FUZZY_AUDIT_INTERVAL_MS,
    };
    state.watcher = this.#watchRoot(
      canonicalRoot,
      () => {
        state.changeEpoch += 1;
        state.stale = true;
        state.staleReason = STALE_REASON_WATCHER_EVENT;
        this.#scheduleWatcherRefresh(state);
      },
      () => {
        this.#clearWatcherDebounce(state);
        state.watcherStatus = WATCHER_STATUS_FAILED;
        state.stale = true;
        state.degraded = true;
        state.staleReason = STALE_REASON_WATCHER_UNAVAILABLE;
      },
    );
    if (state.watcher !== null) {
      state.watcherStatus = WATCHER_STATUS_ACTIVE;
    } else {
      state.watcherStatus = WATCHER_STATUS_UNSUPPORTED;
      state.degraded = true;
      if (state.snapshot !== null) {
        state.stale = true;
        state.staleReason = STALE_REASON_WATCHER_UNAVAILABLE;
      }
    }
    this.#rootStates.set(canonicalRoot, state);
    try {
      this.#makeCacheRoom(state.cacheBytes, state);
    } catch (error) {
      this.#disposeRootState(state);
      this.#rootStates.delete(canonicalRoot);
      throw error;
    }
    return state;
  }

  #scheduleWatcherRefresh(state: RootRuntimeState): void {
    if (
      this.#closed ||
      state.watcherStatus !== WATCHER_STATUS_ACTIVE ||
      state.watchDebounceTimer !== null
    ) {
      return;
    }
    state.watchDebounceTimer = setTimeout(() => {
      state.watchDebounceTimer = null;
      if (this.#closed || this.#rootStates.get(state.canonicalRoot) !== state) {
        return;
      }
      const signal = new AbortController().signal;
      void this.#refreshRoot(state, signal).catch((error: unknown) => {
        if (this.#closed || error instanceof FuzzyIndexBuildCancelledError) {
          return;
        }
        state.stale = true;
        state.degraded = true;
        state.staleReason = errorMessage(error);
        state.auditBackoffMs = Math.min(
          MAX_FUZZY_AUDIT_BACKOFF_MS,
          state.auditBackoffMs * 2,
        );
        state.nextAuditAtMs = this.#now() + state.auditBackoffMs;
      });
    }, FUZZY_WATCH_DEBOUNCE_MS);
    state.watchDebounceTimer.unref?.();
  }

  #clearWatcherDebounce(state: RootRuntimeState): void {
    if (state.watchDebounceTimer === null) return;
    clearTimeout(state.watchDebounceTimer);
    state.watchDebounceTimer = null;
  }

  #disposeRootState(state: RootRuntimeState): void {
    this.#queryCandidateCache = null;
    this.#clearWatcherDebounce(state);
    state.watcher?.close();
  }

  #evictExpiredRootStates(nowMs: number): void {
    for (const [canonicalRoot, state] of this.#rootStates) {
      if (
        state.activeSearches > 0 ||
        state.activeBuilds > 0 ||
        nowMs - state.lastAccessMs < this.#idleTtlMs
      ) {
        continue;
      }
      this.#disposeRootState(state);
      this.#rootStates.delete(canonicalRoot);
    }
  }

  #makeCacheRoom(
    incomingBytes: number,
    protectedState: RootRuntimeState,
  ): void {
    let projectedBytes =
      cachedRootBytes(this.#rootStates) -
      protectedState.cacheBytes +
      incomingBytes;
    if (projectedBytes <= this.#maximumCacheBytes) return;
    for (const [canonicalRoot, state] of this.#rootStates) {
      if (
        state === protectedState ||
        state.activeSearches > 0 ||
        state.activeBuilds > 0
      ) {
        continue;
      }
      this.#disposeRootState(state);
      this.#rootStates.delete(canonicalRoot);
      projectedBytes -= state.cacheBytes;
      if (projectedBytes <= this.#maximumCacheBytes) return;
    }
    throw new FuzzyFileSearchBoundaryError(
      "CACHE_LIMIT",
      `fuzzy-file cache requires ${projectedBytes} bytes; maximum is ${this.#maximumCacheBytes}`,
    );
  }

  #evictRootStateForAdmission(): void {
    if (this.#rootStates.size < this.#maximumRootStates) return;
    for (const [canonicalRoot, state] of this.#rootStates) {
      if (state.activeSearches > 0 || state.activeBuilds > 0) continue;
      this.#disposeRootState(state);
      this.#rootStates.delete(canonicalRoot);
      return;
    }
    throw new Error(
      `fuzzy-file active root-state limit of ${this.#maximumRootStates} is exhausted`,
    );
  }

  async #refreshRoot(
    state: RootRuntimeState,
    signal: AbortSignal,
  ): Promise<void> {
    this.#clearWatcherDebounce(state);
    let build = state.build;
    if (build === null) {
      const controller = new AbortController();
      build = {
        controller,
        promise: Promise.resolve(),
        waiters: 0,
        settled: false,
      };
      state.build = build;
      state.activeBuilds = 1;
      this.#buildControllers.add(controller);
      const ownedBuild = build;
      build.promise = this.#scheduleBuild(
        () => this.#runRefreshRoot(state, controller.signal),
        controller.signal,
      ).finally(() => {
        ownedBuild.settled = true;
        this.#activeBuildSettlements.delete(ownedBuild.promise);
        this.#buildControllers.delete(controller);
        if (state.build === ownedBuild) {
          state.build = null;
          state.activeBuilds = 0;
        }
      });
      this.#activeBuildSettlements.add(build.promise);
    }
    build.waiters += 1;
    try {
      await waitForBuildOrAbort(build.promise, signal);
    } finally {
      build.waiters -= 1;
      if (build.waiters === 0 && !build.settled) {
        build.controller.abort("fuzzy-file build has no waiting request");
      }
    }
  }

  async #runRefreshRoot(
    state: RootRuntimeState,
    signal: AbortSignal,
  ): Promise<void> {
    const buildStartedAtMs = this.#now();
    for (
      let attempt = 0;
      attempt < MAX_SOURCE_CONVERGENCE_ATTEMPTS;
      attempt += 1
    ) {
      const epochAtStart = state.changeEpoch;
      const discovery = await this.#discover(state.canonicalRoot, signal);
      if (signal.aborted) throw new FuzzyIndexBuildCancelledError();
      if (state.changeEpoch !== epochAtStart) continue;
      this.#makeCacheRoom(estimateDiscoveryCacheBytes(discovery), state);
      let snapshot: FuzzyIndexSnapshot | null;
      try {
        snapshot = await this.#persistentIndex().publish(
          state.canonicalRoot,
          discovery,
          signal,
          {
            sourceBoundary: `${state.watcherStatus}:${epochAtStart}`,
            isSourceBoundaryCurrent: () => state.changeEpoch === epochAtStart,
          },
        );
      } catch (error) {
        if (error instanceof FuzzyIndexSourceChangedError) continue;
        throw error;
      }
      if (snapshot === null) {
        throw new Error("fuzzy-file generation was not published");
      }
      const snapshotBytes = estimateSnapshotCacheBytes(snapshot);
      this.#queryCandidateCache = null;
      this.#makeCacheRoom(snapshotBytes, state);
      state.snapshot = snapshot;
      state.cacheBytes = snapshotBytes;
      const watcherDegraded = state.watcherStatus !== WATCHER_STATUS_ACTIVE;
      const directoryDegraded = snapshot.directoryCoverage !== "complete";
      state.stale = watcherDegraded;
      state.degraded = watcherDegraded || directoryDegraded;
      state.staleReason = watcherDegraded
        ? STALE_REASON_WATCHER_UNAVAILABLE
        : directoryDegraded
          ? DEGRADED_REASON_EMPTY_DIRECTORIES
          : null;
      state.lastAuditAtMs = this.#now();
      state.auditBackoffMs = MIN_FUZZY_AUDIT_INTERVAL_MS;
      const buildDurationMs = Math.max(0, this.#now() - buildStartedAtMs);
      state.nextAuditAtMs =
        this.#now() +
        Math.max(
          MIN_FUZZY_AUDIT_INTERVAL_MS,
          buildDurationMs * FUZZY_AUDIT_BUILD_DURATION_MULTIPLIER,
        );
      return;
    }
    state.stale = true;
    state.staleReason = STALE_REASON_BUILD_RACE;
    state.auditBackoffMs = Math.min(
      MAX_FUZZY_AUDIT_BACKOFF_MS,
      state.auditBackoffMs * 2,
    );
    state.nextAuditAtMs = this.#now() + state.auditBackoffMs;
    throw new FuzzyIndexSourceChangedError();
  }

  #scheduleBuild(run: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (this.#activeBuildCount < MAX_FUZZY_CONCURRENT_BUILDS) {
      return this.#runScheduledBuild(run);
    }
    if (this.#buildQueue.length >= MAX_FUZZY_BUILD_QUEUE) {
      return Promise.reject(
        new FuzzyFileSearchBoundaryError(
          "BUILD_QUEUE_LIMIT",
          `fuzzy-file build queue reached ${MAX_FUZZY_BUILD_QUEUE}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      let queued: QueuedBuild;
      const cancelQueued = (): void => {
        const index = this.#buildQueue.indexOf(queued);
        if (index >= 0) this.#buildQueue.splice(index, 1);
        reject(new FuzzyIndexBuildCancelledError());
      };
      queued = {
        signal,
        run,
        resolve,
        reject,
        removeAbortListener: () =>
          signal.removeEventListener("abort", cancelQueued),
      };
      if (signal.aborted) {
        cancelQueued();
        return;
      }
      signal.addEventListener("abort", cancelQueued, { once: true });
      this.#buildQueue.push(queued);
    });
  }

  async #runScheduledBuild(run: () => Promise<void>): Promise<void> {
    this.#activeBuildCount += 1;
    try {
      await run();
    } finally {
      this.#activeBuildCount -= 1;
      this.#drainBuildQueue();
    }
  }

  #drainBuildQueue(): void {
    while (
      this.#activeBuildCount < MAX_FUZZY_CONCURRENT_BUILDS &&
      this.#buildQueue.length > 0
    ) {
      const queued = this.#buildQueue.shift()!;
      queued.removeAbortListener();
      if (queued.signal.aborted) {
        queued.reject(new FuzzyIndexBuildCancelledError());
        continue;
      }
      void this.#runScheduledBuild(queued.run).then(
        queued.resolve,
        queued.reject,
      );
    }
  }

  #persistentIndex(): PersistentFuzzyFileIndex {
    if (this.#runSearch !== null) {
      throw new Error(
        "custom fuzzy-file runners do not own a persistent index",
      );
    }
    this.#index ??= openPersistentFuzzyFileIndex();
    return this.#index;
  }

  #freshnessForRoot(
    root: ResolvedSearchRoot,
    state: RootRuntimeState | undefined,
  ): FuzzyFileIndexRootFreshness {
    const snapshot = state?.snapshot ?? null;
    return {
      root: root.displayRoot,
      canonicalRoot: root.canonicalRoot,
      generationId: snapshot?.generationId ?? null,
      builtAt:
        snapshot === null ? null : new Date(snapshot.builtAtMs).toISOString(),
      ageMs:
        snapshot === null
          ? null
          : Math.max(0, this.#now() - snapshot.builtAtMs),
      watcherStatus: state?.watcherStatus ?? WATCHER_STATUS_NOT_STARTED,
      directoryCoverage: snapshot?.directoryCoverage ?? "complete",
      lastAuditAt:
        state?.lastAuditAtMs === null || state?.lastAuditAtMs === undefined
          ? null
          : new Date(state.lastAuditAtMs).toISOString(),
      building: (state?.activeBuilds ?? 0) > 0,
      stale: state?.stale ?? true,
      degraded: state?.degraded ?? true,
      truncated: snapshot?.truncated ?? false,
      reason: state?.staleReason ?? null,
    };
  }
}

/**
 * Single-use compatibility helper. It always performs a current pinned-rg
 * discovery; the daemon service above owns persistence across requests.
 */
export async function runFuzzyFileSearch(
  params: FuzzyFileSearchParams,
  signal: AbortSignal = new AbortController().signal,
): Promise<readonly FuzzyFileSearchResult[]> {
  validateSearchParamsBeforeIo(params);
  if (params.query.length === 0 || params.roots.length === 0) return [];
  const roots = await resolveSearchRoots(params.roots, params.roots);
  const snapshots = new Map<string, FuzzyIndexSnapshot>();
  let syntheticGeneration = 0;
  for (const root of roots) {
    if (signal.aborted) return [];
    const discovery = await discoverFuzzyFiles(root.canonicalRoot, signal);
    if (discovery.truncated) {
      throw new FuzzyFileSearchBoundaryError(
        "TRAVERSAL_LIMIT",
        "fuzzy-file discovery reached a bound; refusing to search a prefix",
      );
    }
    syntheticGeneration += 1;
    snapshots.set(root.canonicalRoot, {
      rootKey: root.canonicalRoot,
      canonicalRoot: root.canonicalRoot,
      generationId: syntheticGeneration,
      builtAtMs: Date.now(),
      entryCount: discovery.entries.length,
      pathBytes: discovery.entries.reduce(
        (total, entry) => total + entry.pathBytes.byteLength,
        0,
      ),
      digest: "single-use",
      truncated: discovery.truncated,
      directoryCoverage: discovery.directoryCoverage ?? "complete",
      entries: discovery.entries,
    });
  }
  const collection = collectRootEntries(roots, snapshots);
  const ranking = await rankSearchEntries(
    params.query,
    collection.candidates,
    signal,
    params.limit ?? DEFAULT_FUZZY_RESULTS,
  );
  return ranking.files;
}

async function resolveSearchRoots(
  roots: readonly string[],
  allowedRoots: readonly string[],
): Promise<readonly ResolvedSearchRoot[]> {
  const canonicalAllowedRoots = await Promise.all(
    allowedRoots.map(canonicalizeFuzzyIndexRoot),
  );
  const byCanonical = new Map<string, ResolvedSearchRoot>();
  let canonicalRootBytes = 0;
  for (const [rootOrder, root] of roots.entries()) {
    const canonicalRoot = await canonicalizeFuzzyIndexRoot(root);
    if (
      !canonicalAllowedRoots.some((allowedRoot) =>
        isWithinAllowedRoot(allowedRoot, canonicalRoot),
      )
    ) {
      throw new FuzzyFileSearchBoundaryError(
        "UNAUTHORIZED_ROOT",
        `fuzzy-file root is outside the trusted workspace capability: ${root}`,
      );
    }
    if (!byCanonical.has(canonicalRoot)) {
      const rootBytes = Buffer.byteLength(canonicalRoot, "utf8");
      if (rootBytes > MAX_FUZZY_FILE_ROOT_UTF8_BYTES) {
        throw new FuzzyFileSearchBoundaryError(
          "ROOT_PATH_LIMIT",
          `canonical fuzzy-file root is ${rootBytes} UTF-8 bytes; maximum is ${MAX_FUZZY_FILE_ROOT_UTF8_BYTES}`,
        );
      }
      canonicalRootBytes += rootBytes;
      if (canonicalRootBytes > MAX_FUZZY_FILE_ROOTS_UTF8_BYTES) {
        throw new FuzzyFileSearchBoundaryError(
          "ROOT_BYTES_LIMIT",
          `canonical fuzzy-file roots exceed ${MAX_FUZZY_FILE_ROOTS_UTF8_BYTES} UTF-8 bytes`,
        );
      }
      if (byCanonical.size >= MAX_FUZZY_FILE_ROOTS) {
        throw new FuzzyFileSearchBoundaryError(
          "ROOT_COUNT_LIMIT",
          `canonical fuzzy-file roots exceed ${MAX_FUZZY_FILE_ROOTS}`,
        );
      }
      byCanonical.set(canonicalRoot, {
        displayRoot: root,
        canonicalRoot,
        order: rootOrder,
      });
    }
  }
  return [...byCanonical.values()].sort((left, right) => {
    const depth =
      pathDepth(right.canonicalRoot) - pathDepth(left.canonicalRoot);
    return depth !== 0
      ? depth
      : comparePortablePaths(left.canonicalRoot, right.canonicalRoot);
  });
}

function collectRootEntries(
  roots: readonly ResolvedSearchRoot[],
  snapshots: ReadonlyMap<string, FuzzyIndexSnapshot>,
): {
  readonly candidates: readonly SearchCandidate[];
  readonly truncated: boolean;
} {
  const candidates: SearchCandidate[] = [];
  const seenAbsoluteBytes = new Set<string>();
  let candidateBytes = 0;
  let truncated = false;
  rootLoop: for (const root of roots) {
    const snapshot = snapshots.get(root.canonicalRoot);
    if (snapshot === undefined) continue;
    for (const entry of snapshot.entries) {
      const absoluteKey = fuzzyAbsolutePathKey(
        root.canonicalRoot,
        entry.pathBytes,
      );
      if (seenAbsoluteBytes.has(absoluteKey)) continue;
      const nextBytes = Buffer.byteLength(entry.relativePath, "utf8");
      if (
        candidates.length >= MAX_FUZZY_CANDIDATES ||
        candidateBytes + nextBytes > MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES
      ) {
        truncated = true;
        break rootLoop;
      }
      seenAbsoluteBytes.add(absoluteKey);
      candidateBytes += nextBytes;
      candidates.push({ root, entry });
    }
  }
  return { candidates, truncated };
}

function fuzzyQueryGenerationKey(
  roots: readonly ResolvedSearchRoot[],
  snapshots: ReadonlyMap<string, FuzzyIndexSnapshot>,
): string {
  return JSON.stringify(
    roots.map((root) => {
      const snapshot = snapshots.get(root.canonicalRoot);
      return [
        root.displayRoot,
        root.canonicalRoot,
        root.order,
        snapshot?.rootKey ?? null,
        snapshot?.generationId ?? null,
      ];
    }),
  );
}

export function fuzzyAbsolutePathKey(
  canonicalRoot: string,
  relativePathBytes: Buffer,
  platform: NodeJS.Platform = process.platform,
): string {
  const portableRoot =
    platform === "win32" ? canonicalRoot.replace(/\\/gu, "/") : canonicalRoot;
  const separator = portableRoot.endsWith("/") ? "" : "/";
  return Buffer.concat([
    Buffer.from(portableRoot, "utf8"),
    Buffer.from(separator, "utf8"),
    relativePathBytes,
  ]).toString("hex");
}

async function rankSearchEntries(
  query: string,
  candidates: readonly SearchCandidate[],
  signal: AbortSignal,
  limit: number,
  totalCandidateCount: number = candidates.length,
): Promise<{
  readonly files: readonly FuzzyFileSearchResult[];
  readonly matcher: FuzzyMatcherMetadata;
  readonly matchedCandidates: readonly SearchCandidate[];
}> {
  const matcher = new BoundedFuzzyMatcher(query, { caseMode: "insensitive" });
  const workBudget = new FuzzyMatchWorkBudget({
    maximumMatrixCells: MAX_FUZZY_QUERY_MATRIX_CELLS,
    maximumCodePointVisits: MAX_FUZZY_QUERY_CODEPOINT_VISITS,
  });
  const top: RankedEntry[] = [];
  const matchedCandidates: SearchCandidate[] = [];
  const startedAt = performance.now();
  let evaluatedCandidates = 0;
  let resourceLimited = false;
  for (const [index, candidate] of candidates.entries()) {
    if (signal.aborted) {
      return {
        files: [],
        matcher: matcherMetadata(matcher, false, 0, totalCandidateCount),
        matchedCandidates: [],
      };
    }
    if (index > 0 && index % MATCH_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
      if (signal.aborted) {
        return {
          files: [],
          matcher: matcherMetadata(matcher, false, 0, totalCandidateCount),
          matchedCandidates: [],
        };
      }
    }
    const searchCandidate =
      candidate.entry.searchCandidate ??
      prepareFuzzyCandidate(candidate.entry.relativePath);
    if (performance.now() - startedAt > MAX_FUZZY_QUERY_MS) {
      resourceLimited = true;
      break;
    }
    const match = matcher.match(searchCandidate, {
      includeIndices: false,
      lengthBonus: false,
      matchBasename: true,
      workBudget,
    });
    if (workBudget.exhausted) {
      resourceLimited = true;
      break;
    }
    evaluatedCandidates += 1;
    if (match === null) continue;
    matchedCandidates.push(candidate);
    retainRankedEntry(
      top,
      {
        entry: candidate.entry,
        root: candidate.root,
        score: match.score,
        rankScore: fuzzyPathRankScore(
          candidate.entry.relativePath,
          match.score,
        ),
      },
      limit,
    );
  }
  if (signal.aborted) {
    return {
      files: [],
      matcher: matcherMetadata(matcher, false, 0, totalCandidateCount),
      matchedCandidates: [],
    };
  }
  const files: FuzzyFileSearchResult[] = [];
  for (const ranked of top.sort(compareRankedEntries)) {
    if (performance.now() - startedAt > MAX_FUZZY_QUERY_MS) {
      resourceLimited = true;
      break;
    }
    const searchCandidate =
      ranked.entry.searchCandidate ??
      prepareFuzzyCandidate(ranked.entry.relativePath);
    const match = matcher.match(searchCandidate, {
      includeIndices: true,
      lengthBonus: false,
      matchBasename: true,
      workBudget,
    });
    if (workBudget.exhausted) {
      resourceLimited = true;
      break;
    }
    if (match === null || match.score !== ranked.score) {
      resourceLimited = true;
      break;
    }
    files.push({
      root: ranked.root.displayRoot,
      path: ranked.entry.relativePath,
      match_type: ranked.entry.matchType,
      file_name:
        posix.basename(ranked.entry.relativePath) || ranked.entry.relativePath,
      score: ranked.score,
      indices: match.indices,
    });
  }
  return {
    files,
    matcher: matcherMetadata(
      matcher,
      resourceLimited,
      evaluatedCandidates,
      totalCandidateCount,
    ),
    matchedCandidates: Object.freeze(matchedCandidates),
  };
}

type FuzzyMatcherMetadata = FuzzyFileMatcherMetadata;

function matcherMetadata(
  matcher: BoundedFuzzyMatcher,
  resourceLimited: boolean,
  evaluatedCandidates: number,
  totalCandidates: number,
): FuzzyMatcherMetadata {
  return {
    quality: matcher.usedDegradedFallback ? "degraded" : "optimal",
    resourceLimited,
    evaluatedCandidates,
    totalCandidates,
  };
}

export type FuzzyFileSearchBoundaryReason =
  | "QUERY_LIMIT"
  | "QUERY_ENCODING"
  | "RAW_ROOT_COUNT_LIMIT"
  | "UNAUTHORIZED_ROOT"
  | "ROOT_PATH_LIMIT"
  | "ROOT_BYTES_LIMIT"
  | "ROOT_COUNT_LIMIT"
  | "RESULT_LIMIT"
  | "REFRESH_FLAG"
  | "CACHE_LIMIT"
  | "TRAVERSAL_LIMIT"
  | "BUILD_QUEUE_LIMIT";

export class FuzzyFileSearchBoundaryError extends Error {
  constructor(
    readonly reason: FuzzyFileSearchBoundaryReason,
    message: string,
  ) {
    super(message);
    this.name = "FuzzyFileSearchBoundaryError";
  }
}

function validateSearchParamsBeforeIo(params: FuzzyFileSearchParams): void {
  try {
    if (params.query.length > 0) validateFuzzyQuery(params.query);
  } catch (error) {
    if (error instanceof FuzzyBoundaryError) {
      throw new FuzzyFileSearchBoundaryError("QUERY_ENCODING", error.message);
    }
    throw error;
  }
  const queryCodePoints = Array.from(params.query).length;
  if (queryCodePoints > MAX_FUZZY_QUERY_CODEPOINTS) {
    throw new FuzzyFileSearchBoundaryError(
      "QUERY_LIMIT",
      `fuzzy-file query has ${queryCodePoints} code points; maximum is ${MAX_FUZZY_QUERY_CODEPOINTS}`,
    );
  }
  if (params.roots.length > MAX_FUZZY_RAW_ROOTS) {
    throw new FuzzyFileSearchBoundaryError(
      "RAW_ROOT_COUNT_LIMIT",
      `fuzzy-file request has ${params.roots.length} raw roots; maximum is ${MAX_FUZZY_RAW_ROOTS}`,
    );
  }
  let rootBytes = 0;
  for (const root of params.roots) {
    if (root.trim().length === 0) {
      throw new FuzzyFileSearchBoundaryError(
        "ROOT_PATH_LIMIT",
        "fuzzy-file roots must not be empty",
      );
    }
    let bytes: number;
    try {
      bytes = validateFuzzyCandidate(root);
    } catch (error) {
      if (error instanceof FuzzyBoundaryError) {
        throw new FuzzyFileSearchBoundaryError(
          "ROOT_PATH_LIMIT",
          error.message,
        );
      }
      throw error;
    }
    if (bytes > MAX_FUZZY_FILE_ROOT_UTF8_BYTES) {
      throw new FuzzyFileSearchBoundaryError(
        "ROOT_PATH_LIMIT",
        `fuzzy-file root is ${bytes} UTF-8 bytes; maximum is ${MAX_FUZZY_FILE_ROOT_UTF8_BYTES}`,
      );
    }
    rootBytes += bytes;
    if (rootBytes > MAX_FUZZY_FILE_ROOTS_UTF8_BYTES) {
      throw new FuzzyFileSearchBoundaryError(
        "ROOT_BYTES_LIMIT",
        `raw fuzzy-file roots exceed ${MAX_FUZZY_FILE_ROOTS_UTF8_BYTES} UTF-8 bytes`,
      );
    }
  }
  if (params.refresh !== undefined && typeof params.refresh !== "boolean") {
    throw new FuzzyFileSearchBoundaryError(
      "REFRESH_FLAG",
      "fuzzy-file refresh must be a boolean",
    );
  }
  const limit = params.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_FUZZY_RESULTS)
  ) {
    throw new FuzzyFileSearchBoundaryError(
      "RESULT_LIMIT",
      `fuzzy-file limit must be a safe integer from 1 to ${MAX_FUZZY_RESULTS}`,
    );
  }
}

function isWithinAllowedRoot(
  allowedRoot: string,
  candidateRoot: string,
): boolean {
  const child = relative(allowedRoot, candidateRoot);
  return (
    child.length === 0 ||
    (child !== ".." &&
      !child.startsWith("../") &&
      !child.startsWith("..\\") &&
      !isAbsolute(child))
  );
}

function waitForBuildOrAbort(
  build: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new FuzzyIndexBuildCancelledError());
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(new FuzzyIndexBuildCancelledError());
    signal.addEventListener("abort", abort, { once: true });
    void build.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function retainRankedEntry(
  top: RankedEntry[],
  candidate: RankedEntry,
  limit: number,
): void {
  if (top.length < limit) {
    top.push(candidate);
    bubbleWorstUp(top, top.length - 1);
    return;
  }
  if (compareRankedEntries(candidate, top[0]!) >= 0) return;
  top[0] = candidate;
  bubbleWorstDown(top, 0);
}

function bubbleWorstUp(heap: RankedEntry[], start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareRankedEntries(heap[index]!, heap[parent]!) <= 0) return;
    [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
    index = parent;
  }
}

function bubbleWorstDown(heap: RankedEntry[], start: number): void {
  let index = start;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (
      left < heap.length &&
      compareRankedEntries(heap[left]!, heap[worst]!) > 0
    ) {
      worst = left;
    }
    if (
      right < heap.length &&
      compareRankedEntries(heap[right]!, heap[worst]!) > 0
    ) {
      worst = right;
    }
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
    index = worst;
  }
}

function compareRankedEntries(left: RankedEntry, right: RankedEntry): number {
  const rankScore = right.rankScore - left.rankScore;
  if (rankScore !== 0) return rankScore;
  const score = right.score - left.score;
  if (score !== 0) return score;
  const path = comparePortablePaths(
    left.entry.relativePath,
    right.entry.relativePath,
  );
  if (path !== 0) return path;
  const rootOrder = left.root.order - right.root.order;
  if (rootOrder !== 0) return rootOrder;
  return Buffer.compare(left.entry.pathBytes, right.entry.pathBytes);
}

function watchFuzzyRoot(
  canonicalRoot: string,
  onChange: () => void,
  onError: () => void,
): FSWatcher | null {
  try {
    const watcher = watch(
      canonicalRoot,
      { recursive: true, persistent: false },
      onChange,
    );
    watcher.on("error", onError);
    return watcher;
  } catch {
    return null;
  }
}

function pathDepth(value: string): number {
  return value.replace(/\\/gu, "/").split("/").filter(Boolean).length;
}

function normalizedToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRefreshableStaleReason(reason: string | null): boolean {
  return (
    reason === STALE_REASON_WATCHER_EVENT || reason === STALE_REASON_BUILD_RACE
  );
}

function validateMaximumRootStates(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_FUZZY_FILE_ACTIVE_ROOT_STATES
  ) {
    throw new RangeError(
      `maximumRootStates must be a safe integer in [1, ${MAX_FUZZY_FILE_ACTIVE_ROOT_STATES}]`,
    );
  }
  return value;
}

function validatePositiveBoundedOption(
  name: string,
  value: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a safe integer in [1, ${maximum}]`);
  }
  return value;
}

function cachedRootBytes(
  states: ReadonlyMap<string, RootRuntimeState>,
): number {
  let bytes = 0;
  for (const state of states.values()) bytes += state.cacheBytes;
  return bytes;
}

function estimateSnapshotCacheBytes(snapshot: FuzzyIndexSnapshot): number {
  let bytes = FUZZY_SNAPSHOT_RETAINED_OVERHEAD_BYTES;
  for (const entry of snapshot.entries) {
    const candidate =
      entry.searchCandidate ?? prepareFuzzyCandidate(entry.relativePath);
    bytes +=
      entry.pathBytes.byteLength +
      FUZZY_BUFFER_RETAINED_OVERHEAD_BYTES +
      FUZZY_ENTRY_RETAINED_OVERHEAD_BYTES +
      FUZZY_ARRAY_REFERENCE_BYTES +
      estimateFuzzyCandidateRetainedBytes(candidate);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_FUZZY_CACHE_BYTES) {
      return MAX_FUZZY_CACHE_BYTES + 1;
    }
  }
  return bytes;
}

function estimateDiscoveryCacheBytes(
  discovery: FuzzyFileDiscoveryResult,
): number {
  let bytes = FUZZY_SNAPSHOT_RETAINED_OVERHEAD_BYTES;
  for (const entry of discovery.entries) {
    bytes +=
      entry.pathBytes.byteLength +
      FUZZY_BUFFER_RETAINED_OVERHEAD_BYTES +
      FUZZY_ENTRY_RETAINED_OVERHEAD_BYTES +
      FUZZY_ARRAY_REFERENCE_BYTES +
      estimateFuzzyCandidateRetainedBytes(entry.relativePath);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_FUZZY_CACHE_BYTES) {
      return MAX_FUZZY_CACHE_BYTES + 1;
    }
  }
  return bytes;
}

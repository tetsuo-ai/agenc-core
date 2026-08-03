import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { CsvAgentJobsRepository } from "../state/csv-agent-jobs.js";
import {
  openStateDatabasePaths,
  resolveStateDatabasePaths,
  type StateDatabasePaths,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";

export interface CsvAgentJobsRepositoryAccessOptions {
  readonly signal?: AbortSignal;
}

export interface CsvAgentJobsRepositoryProvider {
  withRepository<Result>(
    cwd: string,
    operation: (
      repository: CsvAgentJobsRepository,
      signal: AbortSignal,
    ) => Result | Promise<Result>,
    options?: CsvAgentJobsRepositoryAccessOptions,
  ): Promise<Result>;
}

export interface CsvAgentJobsRepositoryAuthorityOptions {
  readonly agencHome?: string;
  readonly canonicalizeWorkspace?: (cwd: string) => Promise<string>;
  readonly resolvePaths?: (cwd: string) => StateDatabasePaths;
  readonly openDriver?: (paths: StateDatabasePaths) => StateSqliteDriver;
  readonly openRepository?: (
    driver: StateSqliteDriver,
    options: { readonly signal: AbortSignal },
  ) => Promise<CsvAgentJobsRepository>;
}

interface RepositoryEntry {
  readonly key: string;
  readonly controller: AbortController;
  readonly opening: Promise<CsvAgentJobsRepository>;
  readonly openingWaiters: RepositoryWaiter[];
  readonly activeLeases: Set<Promise<unknown>>;
  driver: StateSqliteDriver | undefined;
  repository: CsvAgentJobsRepository | undefined;
  state: "opening" | "ready" | "failed" | "closing" | "closed" | "close_failed";
  driverCloseAttempted: boolean;
  driverCloseError: unknown | undefined;
}

interface RepositoryWaiter {
  readonly operation: (
    repository: CsvAgentJobsRepository,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

const AUTHORITY_CLOSED_MESSAGE =
  "CSV agent jobs repository authority is closed";
const OPEN_ABANDONED_MESSAGE = "CSV agent jobs repository open was abandoned";

/**
 * Process-level ownership boundary for CSV repositories and their SQLite
 * drivers. All aliases of one existing workspace converge on the canonical
 * state database path, and repository references never escape the callback.
 */
export class CsvAgentJobsRepositoryAuthority implements CsvAgentJobsRepositoryProvider {
  readonly #agencHome: string | undefined;
  readonly #canonicalizeWorkspace: (cwd: string) => Promise<string>;
  readonly #resolvePaths: (cwd: string) => StateDatabasePaths;
  readonly #openDriver: (paths: StateDatabasePaths) => StateSqliteDriver;
  readonly #openRepository: NonNullable<
    CsvAgentJobsRepositoryAuthorityOptions["openRepository"]
  >;
  readonly #entries = new Map<string, RepositoryEntry>();
  #closed = false;
  #closeTask: Promise<void> | undefined;

  constructor(options: CsvAgentJobsRepositoryAuthorityOptions = {}) {
    this.#agencHome = options.agencHome;
    this.#canonicalizeWorkspace =
      options.canonicalizeWorkspace ?? canonicalExistingWorkspace;
    this.#resolvePaths =
      options.resolvePaths ??
      ((cwd) =>
        resolveStateDatabasePaths({
          cwd,
          ...(this.#agencHome !== undefined
            ? { agencHome: this.#agencHome }
            : {}),
        }));
    this.#openDriver = options.openDriver ?? openStateDatabasePaths;
    this.#openRepository = options.openRepository ?? openCsvAgentJobsRepository;
  }

  async withRepository<Result>(
    cwd: string,
    operation: (
      repository: CsvAgentJobsRepository,
      signal: AbortSignal,
    ) => Result | Promise<Result>,
    options: CsvAgentJobsRepositoryAccessOptions = {},
  ): Promise<Result> {
    this.#assertAcceptingWork();
    options.signal?.throwIfAborted();

    const canonicalWorkspace = await this.#canonicalizeWorkspace(cwd);
    this.#assertAcceptingWork();
    options.signal?.throwIfAborted();

    const paths = this.#resolvePaths(canonicalWorkspace);
    const key = resolve(paths.stateDbPath);
    while (true) {
      this.#assertAcceptingWork();
      options.signal?.throwIfAborted();
      const entry = this.#entryFor(key, paths);
      if (entry.state === "closing") {
        await waitForSettlementOrAbort(entry.opening, options.signal);
        continue;
      }
      return this.#enqueue(entry, operation, options.signal);
    }
  }

  #enqueue<Result>(
    entry: RepositoryEntry,
    operation: (
      repository: CsvAgentJobsRepository,
      signal: AbortSignal,
    ) => Result | Promise<Result>,
    signal: AbortSignal | undefined,
  ): Promise<Result> {
    return new Promise<Result>((resolvePromise, rejectPromise) => {
      const waiter: RepositoryWaiter = {
        operation,
        signal,
        resolve: (result) => resolvePromise(result as Result),
        reject: rejectPromise,
        onAbort: undefined,
        settled: false,
      };
      if (signal !== undefined) {
        waiter.onAbort = () => this.#abortOpeningWaiter(entry, waiter);
        signal.addEventListener("abort", waiter.onAbort, {
          once: true,
        });
      }
      if (!this.#entryCanAcceptWaiter(entry)) {
        this.#settleWaiter(
          waiter,
          "reject",
          this.#closed
            ? new Error(AUTHORITY_CLOSED_MESSAGE)
            : new Error(OPEN_ABANDONED_MESSAGE),
        );
        return;
      }
      entry.openingWaiters.push(waiter);
      if (!this.#entryCanAcceptWaiter(entry)) {
        this.#rejectOpeningWaiter(
          entry,
          waiter,
          this.#closed
            ? new Error(AUTHORITY_CLOSED_MESSAGE)
            : new Error(OPEN_ABANDONED_MESSAGE),
        );
        return;
      }
      if (signal?.aborted === true) {
        this.#abortOpeningWaiter(entry, waiter);
        return;
      }
      this.#startReadyLeases(entry);
    });
  }

  close(): Promise<void> {
    if (this.#closeTask !== undefined) return this.#closeTask;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const task = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveClose = resolvePromise;
      rejectClose = rejectPromise;
    });
    this.#closeTask = task;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    for (const entry of entries) {
      if (entry.state !== "closed") entry.state = "closing";
      entry.controller.abort(new Error(AUTHORITY_CLOSED_MESSAGE));
      for (const waiter of entry.openingWaiters.splice(0)) {
        this.#settleWaiter(
          waiter,
          "reject",
          new Error(AUTHORITY_CLOSED_MESSAGE),
        );
      }
    }

    void Promise.resolve()
      .then(async () => {
        await Promise.allSettled(entries.map((entry) => entry.opening));
        await Promise.allSettled(
          entries.flatMap((entry) => [...entry.activeLeases]),
        );
        const closeResults = await Promise.allSettled(
          entries.map(async (entry) => this.#closeDriver(entry)),
        );
        this.#entries.clear();
        const closeFailures = closeResults.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (closeFailures.length > 0) {
          throw new AggregateError(
            closeFailures,
            "one or more CSV agent jobs database drivers failed to close",
          );
        }
      })
      .then(resolveClose, rejectClose);
    return task;
  }

  #assertAcceptingWork(): void {
    if (this.#closed) throw new Error(AUTHORITY_CLOSED_MESSAGE);
  }

  #entryFor(key: string, paths: StateDatabasePaths): RepositoryEntry {
    const existing = this.#entries.get(key);
    if (existing?.state === "close_failed") {
      throw existing.driverCloseError;
    }
    if (
      existing === undefined ||
      existing.state === "failed" ||
      existing.state === "closed"
    ) {
      return this.#createEntry(key, paths);
    }
    return existing;
  }

  #createEntry(key: string, paths: StateDatabasePaths): RepositoryEntry {
    let entry: RepositoryEntry;
    const opening = Promise.resolve().then(() => this.#openEntry(entry, paths));
    entry = {
      key,
      controller: new AbortController(),
      opening,
      driver: undefined,
      repository: undefined,
      state: "opening",
      openingWaiters: [],
      activeLeases: new Set(),
      driverCloseAttempted: false,
      driverCloseError: undefined,
    };
    this.#entries.set(key, entry);
    void entry.opening.catch(() => undefined);
    return entry;
  }

  async #openEntry(
    entry: RepositoryEntry,
    paths: StateDatabasePaths,
  ): Promise<CsvAgentJobsRepository> {
    try {
      entry.controller.signal.throwIfAborted();
      const driver = this.#openDriver(paths);
      entry.driver = driver;
      const repository = await this.#openRepository(driver, {
        signal: entry.controller.signal,
      });
      entry.controller.signal.throwIfAborted();
      if (this.#closed || this.#entries.get(entry.key) !== entry) {
        throw new Error(OPEN_ABANDONED_MESSAGE);
      }
      entry.repository = repository;
      entry.state = "ready";
      this.#startReadyLeases(entry);
      return repository;
    } catch (error) {
      entry.state = this.#closed ? "closing" : "failed";
      for (const waiter of entry.openingWaiters.splice(0)) {
        this.#settleWaiter(waiter, "reject", error);
      }
      try {
        this.#closeDriver(entry);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "CSV agent jobs repository open failed and its driver did not close",
          { cause: error },
        );
      }
      if (this.#entries.get(entry.key) === entry) {
        this.#entries.delete(entry.key);
      }
      throw error;
    }
  }

  #abandonOpeningEntry(entry: RepositoryEntry): void {
    entry.state = "closing";
    entry.controller.abort(new Error(OPEN_ABANDONED_MESSAGE));
  }

  #abandonIfUnused(entry: RepositoryEntry): void {
    if (
      entry.state === "opening" &&
      entry.openingWaiters.length === 0 &&
      entry.activeLeases.size === 0
    ) {
      this.#abandonOpeningEntry(entry);
    }
  }

  #entryCanAcceptWaiter(entry: RepositoryEntry): boolean {
    return (
      !this.#closed &&
      this.#entries.get(entry.key) === entry &&
      (entry.state === "opening" || entry.state === "ready")
    );
  }

  #rejectOpeningWaiter(
    entry: RepositoryEntry,
    waiter: RepositoryWaiter,
    error: unknown,
  ): void {
    const index = entry.openingWaiters.indexOf(waiter);
    if (index >= 0) entry.openingWaiters.splice(index, 1);
    this.#settleWaiter(waiter, "reject", error);
    this.#abandonIfUnused(entry);
  }

  #abortOpeningWaiter(entry: RepositoryEntry, waiter: RepositoryWaiter): void {
    if (waiter.settled) return;
    const index = entry.openingWaiters.indexOf(waiter);
    if (index < 0) return;
    this.#rejectOpeningWaiter(entry, waiter, waiter.signal?.reason);
  }

  #startReadyLeases(entry: RepositoryEntry): void {
    while (entry.state === "ready" && entry.repository !== undefined) {
      const waiter = entry.openingWaiters.shift();
      if (waiter === undefined) return;
      this.#startLease(entry, waiter);
    }
  }

  #startLease(entry: RepositoryEntry, waiter: RepositoryWaiter): void {
    if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.onAbort = undefined;
    }
    if (waiter.signal?.aborted === true) {
      this.#settleWaiter(waiter, "reject", waiter.signal.reason);
      return;
    }

    const operationSignal =
      waiter.signal === undefined
        ? entry.controller.signal
        : AbortSignal.any([entry.controller.signal, waiter.signal]);
    const task = Promise.resolve()
      .then(() => {
        operationSignal.throwIfAborted();
        return waiter.operation(entry.repository!, operationSignal);
      })
      .then(
        (result) => this.#settleWaiter(waiter, "resolve", result),
        (error) => this.#settleWaiter(waiter, "reject", error),
      )
      .finally(() => {
        entry.activeLeases.delete(task);
      });
    entry.activeLeases.add(task);
  }

  #settleWaiter(
    waiter: RepositoryWaiter,
    outcome: "resolve" | "reject",
    value: unknown,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.onAbort = undefined;
    }
    if (outcome === "resolve") waiter.resolve(value);
    else waiter.reject(value);
  }

  #closeDriver(entry: RepositoryEntry): void {
    if (entry.driverCloseAttempted) {
      if (entry.driverCloseError !== undefined) throw entry.driverCloseError;
      return;
    }
    entry.driverCloseAttempted = true;
    try {
      entry.driver?.close();
      entry.state = "closed";
    } catch (error) {
      entry.driverCloseError = error;
      entry.state = "close_failed";
      throw error;
    }
  }
}

async function canonicalExistingWorkspace(cwd: string): Promise<string> {
  return realpath(resolve(cwd));
}

async function waitForSettlementOrAbort(
  task: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await task.catch(() => undefined);
    return;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([task.catch(() => undefined), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function openCsvAgentJobsRepository(
  driver: StateSqliteDriver,
  options: { readonly signal: AbortSignal },
): Promise<CsvAgentJobsRepository> {
  return CsvAgentJobsRepository.open(driver, options);
}

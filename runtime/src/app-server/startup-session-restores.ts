/**
 * Background restore of the sessions a daemon had open at its last shutdown.
 *
 * The daemon listens once its databases and admission state are recovered,
 * and rebuilds those sessions afterwards, a few at a time. Before the socket
 * listens, every one of them is registered here by its run id (which is also
 * its agent id and its durable session id) and by the daemon session it was
 * attached to. A request that names one of those ids waits until that
 * session's restore settles, published or published without a live runtime,
 * and then runs exactly as it would once startup had finished. A request that
 * waits moves a restore that has not started to the front of the queue, so it
 * waits for about one restore plus the ones already in flight, not for the
 * whole queue.
 */

export interface StartupSessionRestoreTarget {
  /** The run id, which is also the agent id and the durable session id. */
  readonly runId: string;
  /** The daemon session the run was attached to, when it had one. */
  readonly sessionId?: string;
}

export type StartupSessionRestoreOutcome =
  /** Published with a live runtime. */
  | "published"
  /** Published without a runtime: it could not be rebuilt. */
  | "unavailable"
  /** Not published: publishing it failed, and what it had published was rolled back. */
  | "failed"
  /** Not published: the daemon began shutting down before it finished. */
  | "abandoned";

export interface StartupSessionRestoreContext {
  /** Aborted when shutdown stops waiting for this restore. */
  readonly signal: AbortSignal;
  /**
   * Claim the right to publish. Returns false once shutdown has given up on
   * this restore; the caller must then roll back what it rebuilt instead.
   */
  beginPublication(): boolean;
}

export type StartupSessionRestoreTask<Target> = (
  target: Target,
  context: StartupSessionRestoreContext,
) => Promise<"published" | "unavailable">;

export interface StartupSessionRestoreSettlement<Target> {
  readonly target: Target;
  /** 1-based position in recovery order. */
  readonly order: number;
  readonly total: number;
  readonly outcome: StartupSessionRestoreOutcome;
  /** Time from the start of its restore to its settlement; 0 if it never started. */
  readonly durationMs: number;
  /** A request moved it ahead of the queue. */
  readonly requested: boolean;
  readonly error?: unknown;
}

export interface StartupSessionRestoreSummary {
  readonly total: number;
  readonly published: number;
  readonly unavailable: number;
  readonly failed: number;
  readonly abandoned: number;
  /** From `start()` to the last settlement. */
  readonly elapsedMs: number;
}

/** What the daemon dispatcher needs: wait for the restores a request names. */
export interface AgenCDaemonStartupRestoreGate {
  /**
   * A promise that settles once every pending restore the request names has
   * settled, or undefined when it names none. Rejects when the daemon shuts
   * down before one of them was restored, or when `signal` aborts.
   */
  waitForRequest(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<void> | undefined;
}

/**
 * A request waited for a session the daemon stopped restoring because it is
 * shutting down. The message matches the answer a request gets when it
 * arrives during shutdown.
 */
export class StartupSessionRestoreAbandonedError extends Error {
  constructor() {
    super("AgenC daemon is shutting down");
    this.name = "StartupSessionRestoreAbandonedError";
  }
}

/**
 * Requests that never wait for a restore: connection and daemon control,
 * health, and the two listings. `session.list` reads the thread store on disk
 * and `agent.list` returns what is published, as they always did.
 */
const METHODS_THAT_NEVER_WAIT: ReadonlySet<string> = new Set([
  "initialize",
  "request.cancel",
  "health.ping",
  "health.ready",
  "health.stats",
  "daemon.reload",
  "daemon.shutdown",
  "session.list",
  "agent.list",
]);

/**
 * A request names a pending session when any string in its params equals one
 * of the registered ids, wherever it sits: `sessionId`, `agentId`, `runId`,
 * `threadId`, `resumeSessionId`, a routine's `permissionAuthority.sessionId`,
 * a remote pairing's `sessionIds`, or a field added later. Ids are exact
 * strings, so a match is that session. The walk is bounded because params can
 * carry large prompts and audio.
 */
const MAX_PARAM_DEPTH = 4;
const MAX_PARAM_VALUES = 1_024;

type EntryPhase = "queued" | "restoring" | "publishing" | "settled";

interface Entry<Target> {
  readonly target: Target;
  readonly order: number;
  readonly ids: readonly string[];
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  phase: EntryPhase;
  requested: boolean;
  givenUp: boolean;
  startedAt?: number;
  outcome?: StartupSessionRestoreOutcome;
}

export interface StartupSessionRestoresOptions<Target> {
  readonly targets: readonly Target[];
  /** How many restores run at the same time. */
  readonly concurrency: number;
  readonly task: StartupSessionRestoreTask<Target>;
  /** Called once per target when it settles. Must not throw; errors are ignored. */
  readonly onSettled?: (settled: StartupSessionRestoreSettlement<Target>) => void;
  readonly now?: () => number;
}

export class StartupSessionRestores<Target extends StartupSessionRestoreTarget>
  implements AgenCDaemonStartupRestoreGate
{
  readonly #entries: readonly Entry<Target>[];
  /** Unsettled entries by every id they are known by. */
  readonly #pending = new Map<string, Set<Entry<Target>>>();
  readonly #requested: Entry<Target>[] = [];
  #nextInOrder = 0;
  readonly #concurrency: number;
  readonly #task: StartupSessionRestoreTask<Target>;
  readonly #onSettled:
    | ((settled: StartupSessionRestoreSettlement<Target>) => void)
    | undefined;
  readonly #now: () => number;
  #maxIdLength = 0;
  #running = 0;
  #unsettled: number;
  #started = false;
  #stopped = false;
  #startedAt: number | undefined;
  readonly #counts = { published: 0, unavailable: 0, failed: 0, abandoned: 0 };
  readonly #settled: Promise<StartupSessionRestoreSummary>;
  #resolveSettled!: (summary: StartupSessionRestoreSummary) => void;

  constructor(options: StartupSessionRestoresOptions<Target>) {
    this.#concurrency = Math.max(1, Math.floor(options.concurrency));
    this.#task = options.task;
    this.#onSettled = options.onSettled;
    this.#now = options.now ?? Date.now;
    this.#settled = new Promise((resolve) => {
      this.#resolveSettled = resolve;
    });
    this.#entries = options.targets.map((target, index) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const ids = [
        ...new Set(
          [target.runId, target.sessionId].filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        ),
      ];
      const entry: Entry<Target> = {
        target,
        order: index + 1,
        ids,
        controller: new AbortController(),
        done,
        resolveDone,
        phase: "queued",
        requested: false,
        givenUp: false,
      };
      for (const id of ids) {
        let named = this.#pending.get(id);
        if (named === undefined) {
          named = new Set();
          this.#pending.set(id, named);
        }
        named.add(entry);
        this.#maxIdLength = Math.max(this.#maxIdLength, id.length);
      }
      return entry;
    });
    this.#unsettled = this.#entries.length;
  }

  get total(): number {
    return this.#entries.length;
  }

  /** Restores that have not settled yet, including the ones not started. */
  get unsettled(): number {
    return this.#unsettled;
  }

  /** Resolves once every restore has settled, abandoned ones included. */
  get settled(): Promise<StartupSessionRestoreSummary> {
    return this.#settled;
  }

  /** Start restoring. Only the first call has an effect. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#startedAt = this.#now();
    if (this.#unsettled === 0) {
      this.#resolveSettled(this.#summary());
      return;
    }
    this.#pump();
  }

  waitForRequest(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<void> | undefined {
    if (this.#pending.size === 0 || METHODS_THAT_NEVER_WAIT.has(method)) {
      return undefined;
    }
    const entries = this.#entriesNamedBy(params);
    return entries.size === 0 ? undefined : this.#waitFor(entries, signal);
  }

  /** Like {@link waitForRequest}, for callers that already hold the ids. */
  waitFor(
    ids: Iterable<string>,
    signal?: AbortSignal,
  ): Promise<void> | undefined {
    if (this.#pending.size === 0) return undefined;
    const entries = new Set<Entry<Target>>();
    for (const id of ids) {
      for (const entry of this.#pending.get(id) ?? []) entries.add(entry);
    }
    return entries.size === 0 ? undefined : this.#waitFor(entries, signal);
  }

  /**
   * Start no further restores, because the daemon is shutting down. The ones
   * that never started settle as abandoned. Every waiter, including the ones
   * waiting for a restore still running, is released with the shutdown error.
   */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const entry of this.#entries) {
      if (entry.phase === "queued") this.#settle(entry, "abandoned");
    }
    if (!this.#started && this.#unsettled === 0) {
      this.#resolveSettled(this.#summary());
    }
  }

  /**
   * Shut down. Restores already running keep going and publish for up to
   * `graceMs`, so the daemon's shutdown can still suspend them like every
   * other idle session. After that they are aborted and given `abortGraceMs`
   * more. A restore still running then is given up: it settles as abandoned,
   * can no longer claim publication, and is returned.
   */
  async shutdown(options: {
    readonly graceMs: number;
    readonly abortGraceMs: number;
  }): Promise<readonly Target[]> {
    this.stop();
    const inFlight = (): Entry<Target>[] =>
      this.#entries.filter((entry) => entry.phase !== "settled");
    if (inFlight().length === 0) return [];
    await settledWithin(inFlight(), options.graceMs);
    if (inFlight().length === 0) return [];
    for (const entry of inFlight()) {
      entry.controller.abort(new StartupSessionRestoreAbandonedError());
    }
    await settledWithin(inFlight(), options.abortGraceMs);
    const givenUp = inFlight();
    for (const entry of givenUp) {
      entry.givenUp = true;
      this.#settle(entry, "abandoned");
    }
    return givenUp.map((entry) => entry.target);
  }

  #entriesNamedBy(params: unknown): Set<Entry<Target>> {
    const entries = new Set<Entry<Target>>();
    const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
      { value: params, depth: 0 },
    ];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_PARAM_VALUES) {
      const { value, depth } = stack.pop()!;
      visited += 1;
      if (typeof value === "string") {
        if (value.length > 0 && value.length <= this.#maxIdLength) {
          for (const entry of this.#pending.get(value) ?? []) {
            entries.add(entry);
          }
        }
        continue;
      }
      if (value === null || typeof value !== "object" || depth >= MAX_PARAM_DEPTH) {
        continue;
      }
      const children = Array.isArray(value) ? value : Object.values(value);
      for (const child of children) {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
    return entries;
  }

  #waitFor(
    entries: ReadonlySet<Entry<Target>>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const entry of entries) {
      if (entry.phase === "queued" && !entry.requested) {
        entry.requested = true;
        this.#requested.push(entry);
      }
    }
    this.#pump();
    const all = Promise.all([...entries].map((entry) => entry.done));
    return abortable(all, signal).then(() => {
      // Once the daemon stops restoring, it is shutting down: a waiter gets
      // the answer a new request would get, even if its session was restored.
      if (this.#stopped) throw new StartupSessionRestoreAbandonedError();
    });
  }

  #next(): Entry<Target> | undefined {
    while (this.#requested.length > 0) {
      const entry = this.#requested.shift()!;
      if (entry.phase === "queued") return entry;
    }
    while (this.#nextInOrder < this.#entries.length) {
      const entry = this.#entries[this.#nextInOrder]!;
      this.#nextInOrder += 1;
      if (entry.phase === "queued") return entry;
    }
    return undefined;
  }

  #pump(): void {
    if (!this.#started || this.#stopped) return;
    while (this.#running < this.#concurrency) {
      const entry = this.#next();
      if (entry === undefined) return;
      this.#run(entry);
    }
  }

  #run(entry: Entry<Target>): void {
    entry.phase = "restoring";
    entry.startedAt = this.#now();
    this.#running += 1;
    const context: StartupSessionRestoreContext = {
      signal: entry.controller.signal,
      beginPublication: () => {
        if (entry.givenUp || entry.phase !== "restoring") return false;
        entry.phase = "publishing";
        return true;
      },
    };
    void (async () => {
      let outcome: StartupSessionRestoreOutcome;
      let error: unknown;
      try {
        outcome = await this.#task(entry.target, context);
      } catch (caught) {
        error = caught;
        outcome =
          caught instanceof StartupSessionRestoreAbandonedError
            ? "abandoned"
            : "failed";
      }
      this.#running -= 1;
      this.#settle(entry, outcome, error);
      this.#pump();
    })();
  }

  #settle(
    entry: Entry<Target>,
    outcome: StartupSessionRestoreOutcome,
    error?: unknown,
  ): void {
    if (entry.phase === "settled") return;
    entry.phase = "settled";
    entry.outcome = outcome;
    for (const id of entry.ids) {
      const named = this.#pending.get(id);
      named?.delete(entry);
      if (named?.size === 0) this.#pending.delete(id);
    }
    this.#counts[outcome] += 1;
    this.#unsettled -= 1;
    try {
      this.#onSettled?.({
        target: entry.target,
        order: entry.order,
        total: this.#entries.length,
        outcome,
        durationMs:
          entry.startedAt === undefined ? 0 : this.#now() - entry.startedAt,
        requested: entry.requested,
        ...(error !== undefined ? { error } : {}),
      });
    } catch {
      // A reporting failure must not keep the session's waiters waiting.
    }
    entry.resolveDone();
    if (this.#unsettled === 0 && (this.#started || this.#stopped)) {
      this.#resolveSettled(this.#summary());
    }
  }

  #summary(): StartupSessionRestoreSummary {
    return {
      total: this.#entries.length,
      ...this.#counts,
      elapsedMs:
        this.#startedAt === undefined ? 0 : this.#now() - this.#startedAt,
    };
  }
}

async function settledWithin<Target>(
  entries: readonly Entry<Target>[],
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(entries.map((entry) => entry.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("request cancelled", "AbortError");
}

/**
 * What a turn must finish before its first tool call runs, so that the
 * model request does not wait for it.
 *
 * Two things change nothing in the workspace yet must come before anything
 * that can: the turn's own workspace snapshot (`turnChanges`, read to report
 * what the turn changed) and a client's restore point (AgenC Desktop records
 * the chat's folder before each turn). The model takes hundreds of
 * milliseconds to produce a tool call, so both usually finish first; the
 * barrier makes that a guarantee instead of a race.
 *
 * - A turn opens the barrier at its start and adds that work to it.
 * - Every tool dispatch of the session waits for it (`waitForToolBarrier`);
 *   once settled it costs nothing.
 * - A client hold (`message.send` `holdToolsUntilReleased`) is keyed by the
 *   turn's message id and released by `session.releaseTools`, in either
 *   order, or after `TOOL_HOLD_TIMEOUT_MS`, after which the turn goes ahead
 *   as a turn whose restore point came too late always did (`ToolHolds`).
 *
 * @module
 */

/** A hold nobody releases stops holding after this long. */
export const TOOL_HOLD_TIMEOUT_MS = 30_000;
/** How long a message counts as released, for a hold asked for again or still to come. */
const RELEASED_TTL_MS = 120_000;
/** Bounds the releases kept for holds still to come. */
const MAX_RELEASED = 256;

interface Hold {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

/**
 * Client holds, by message id. Daemon-wide: a turn the daemon resumed into a
 * new runtime, or a release sent under another id of the same chat, still
 * meets its hold. A message once released (or timed out) stays released, so a
 * hold asked for again (a UserPromptSubmit hook waited first, then the turn) or
 * still to come (the release came first) does not wait.
 */
export class ToolHolds {
  readonly #holds = new Map<string, Hold>();
  readonly #released = new Map<string, number>();
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(options: { readonly timeoutMs?: number; readonly now?: () => number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? TOOL_HOLD_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The hold for this message; the same promise while it is pending, a settled one once released. */
  hold(messageId: string): Promise<void> {
    const existing = this.#holds.get(messageId);
    if (existing !== undefined) return existing.promise;
    this.#prune();
    if (this.#released.has(messageId)) return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const timer = setTimeout(() => release(), this.#timeoutMs);
    timer.unref?.();
    const release = (): void => {
      clearTimeout(timer);
      if (this.#holds.get(messageId)?.promise === promise) this.#holds.delete(messageId);
      this.#markReleased(messageId);
      resolve();
    };
    this.#holds.set(messageId, { promise, release });
    return promise;
  }

  /** Releases the hold of this message, now or for when it comes. True when a hold was waiting. */
  release(messageId: string): boolean {
    const hold = this.#holds.get(messageId);
    if (hold !== undefined) { hold.release(); return true; }
    this.#markReleased(messageId);
    return false;
  }

  #markReleased(messageId: string): void {
    this.#prune();
    this.#released.delete(messageId);
    if (this.#released.size >= MAX_RELEASED) {
      const oldest = this.#released.keys().next().value;
      if (oldest !== undefined) this.#released.delete(oldest);
    }
    this.#released.set(messageId, this.#now() + RELEASED_TTL_MS);
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, expiresAt] of this.#released) if (expiresAt <= now) this.#released.delete(id);
  }
}

/** The daemon's client holds (`message.send` `holdToolsUntilReleased`, `session.releaseTools`). */
export const clientToolHolds = new ToolHolds();

const barrierBySession = new WeakMap<object, ToolBarrier>();

/** One turn's barrier: the work its first tool call waits for. */
export class ToolBarrier {
  readonly #work: Promise<unknown>[] = [];
  #settled: Promise<void> | null = Promise.resolve();

  add(work: Promise<unknown>): void {
    this.#work.push(work.catch(() => undefined));
    this.#settled = null;
  }

  /** Resolves once all work added so far settled; rejects with the signal's reason if it aborts first. */
  wait(signal?: AbortSignal): Promise<void> {
    if (this.#settled === null) this.#settled = Promise.all(this.#work).then(() => undefined);
    const settled = this.#settled;
    if (signal === undefined) return settled;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      settled.then(() => { signal.removeEventListener("abort", abort); resolve(); });
    });
  }
}

/** Opens the barrier of a turn that starts now; `end` closes it when the turn is over. */
export function beginToolBarrier(session: object): { readonly barrier: ToolBarrier; end(): void } {
  const barrier = new ToolBarrier();
  barrierBySession.set(session, barrier);
  return {
    barrier,
    end() { if (barrierBySession.get(session) === barrier) barrierBySession.delete(session); },
  };
}

/** Waits for the current turn's barrier of this session, if there is one. */
export function waitForToolBarrier(session: object | undefined, signal?: AbortSignal): Promise<void> {
  const barrier = session === undefined ? undefined : barrierBySession.get(session);
  return barrier === undefined ? Promise.resolve() : barrier.wait(signal);
}

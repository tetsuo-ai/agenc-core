/**
 * AsyncRwLock — multi-reader / single-writer lock around a value.
 *
 * Translation of Rust `Arc<RwLock<T>>` per `docs/plan/translation-conventions.md`.
 * Multiple `withRead` callers run concurrently. `withWrite` blocks until
 * all current readers complete, then runs exclusively. New readers
 * arriving while a writer is queued yield to the writer to prevent
 * writer-starvation.
 *
 * Used by the four-class concurrency contract (T7): SharedRead tools
 * acquire read locks; Exclusive tools acquire write locks. See I-61
 * for SharedServer per-id semaphore variant.
 *
 * Cancellation (abort-aware acquire): `withWrite`/`withRead` accept an
 * optional AbortSignal. A waiter aborted before it acquires is removed
 * from the FIFO queue ATOMICALLY w.r.t. handoff and the writer-turn is
 * forwarded to the next live waiter, so no turn is ever lost and the
 * writer chain is never wedged. The writer side is an EXPLICIT
 * `writeWaiters` FIFO (a promise chain cannot drop a mid-chain waiter);
 * readers keep the gated-promise model but gain an abort path on the
 * pending read gate. The grant decision (`pumpWrite`) and the cancel
 * decision (`cancelWriteWaiter`) both read-then-write `waiter.state`
 * with NO `await` between, so exactly one wins per waiter — the loser is
 * inert. A grant() (= resolve()) is IRREVOCABLE, so a waiter observed in
 * the `granted` state is NEVER force-rejected here: it already won its
 * turn and must take it and release normally. The only state that
 * removes a waiter from the queue is `queued`.
 *
 * @module
 */

interface WriteWaiter {
  state: "queued" | "granted" | "cancelled";
  /** Resolve when this waiter owns the write turn. */
  grant: () => void;
  /** Reject the still-pending turn (only valid while state === "queued"). */
  reject: (err: unknown) => void;
}

export class AsyncRwLock<T> {
  private value: T;
  private readers = 0;
  /** True while a writer holds the exclusive turn. */
  private writeHeld = false;
  /** Explicit FIFO of queued writers (identity-carrying records). */
  private writeWaiters: WriteWaiter[] = [];
  /**
   * Readers yield to a queued/holding writer via this gate
   * (writer-starvation prevention). Resolved when no writer is holding
   * or queued.
   */
  private pendingReadGate: Promise<void> = Promise.resolve();
  private resolveReadGate: (() => void) | null = null;

  constructor(initial: T) {
    this.value = initial;
  }

  /**
   * Run `fn` with shared read access. Concurrent `withRead` callers run
   * in parallel. If a writer is queued (`withWrite` already called and
   * waiting for readers to drain), new readers wait for the writer to
   * complete first — this prevents writer-starvation under heavy read
   * load.
   *
   * If `signal` aborts while gated behind a writer, the call rejects
   * WITHOUT touching `readers` (nothing was acquired, so there is
   * nothing to forward).
   */
  async withRead<R>(
    fn: (value: T) => Promise<R> | R,
    signal?: AbortSignal,
  ): Promise<R> {
    if (signal?.aborted) throw abortError(signal);
    // Race the read-gate against abort. Aborting here only skips entry; it
    // touches NO shared counter, so there is nothing to forward.
    await raceGate(this.pendingReadGate, signal);
    this.readers++;
    try {
      return await fn(this.value);
    } finally {
      // Underflow tripwire — readers must never go negative.
      if (this.readers <= 0) {
        throw new Error("AsyncRwLock readers underflow");
      }
      this.readers--;
    }
  }

  /**
   * Run `fn` with exclusive write access. Queues behind any in-flight
   * writer, then waits for all current readers to drain, then runs
   * exclusively. Subsequent reads + writes wait for this to complete.
   *
   * If `signal` aborts while QUEUED, the waiter is removed from the FIFO
   * atomically and the call rejects. If the abort lands after the waiter
   * was already granted the turn, the granted turn is honored: `runHeld`
   * rechecks the signal and throws (handing the turn off) rather than
   * running `fn`.
   */
  async withWrite<R>(
    fn: (value: T) => Promise<R> | R,
    signal?: AbortSignal,
  ): Promise<R> {
    if (signal?.aborted) throw abortError(signal);

    // Fast path: nobody holds or is queued → take the turn immediately.
    if (!this.writeHeld && this.writeWaiters.length === 0) {
      this.beginWrite();
      return this.runHeld(fn, signal);
    }

    // Slow path: enqueue an identity-carrying waiter.
    const waiter: WriteWaiter = {
      state: "queued",
      grant: () => {},
      reject: () => {},
    };
    const turn = new Promise<void>((resolve, reject) => {
      waiter.grant = () => resolve();
      waiter.reject = reject;
    });
    this.writeWaiters.push(waiter);
    this.refreshReadGate(); // a writer is now queued → close the read gate

    const onAbort = (): void => {
      this.cancelWriteWaiter(waiter, abortError(signal!));
    };
    if (signal) {
      // Re-check after enqueue: the abort may have fired between the
      // top-of-method guard and here.
      if (signal.aborted) {
        this.cancelWriteWaiter(waiter, abortError(signal));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      await turn; // resolves on grant, rejects on queued-cancel
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    // We own the turn. Drain pre-existing readers, run, then hand off.
    return this.runHeld(fn, signal);
  }

  // ── internal: turn lifecycle ────────────────────────────────────────────

  private beginWrite(): void {
    this.writeHeld = true;
    this.refreshReadGate(); // writer holding → readers gated
  }

  private async runHeld<R>(
    fn: (value: T) => Promise<R> | R,
    signal?: AbortSignal,
  ): Promise<R> {
    // A granted-then-cancelled writer reaches here with an aborted signal
    // (grant() is irrevocable, so it kept its turn). Throw BEFORE draining
    // readers or running fn, then hand off the turn in the finally — this
    // is exactly equivalent to an instantaneously-held-then-released turn,
    // so the next live writer is forwarded and the read gate reopens.
    try {
      if (signal?.aborted) throw abortError(signal);
      // Yield once so readers that ALREADY cleared the (then-open) read gate
      // in the SAME synchronous batch — i.e. between their `await raceGate`
      // and their `readers++` — get to register before we drain. The legacy
      // promise-chain writer obtained this yield implicitly via `await
      // previous`; the explicit-queue fast path needs it explicitly to keep
      // "a concurrently-submitted reader starts before the writer" ordering.
      await new Promise((r) => setImmediate(r));
      if (signal?.aborted) throw abortError(signal);
      // Drain readers that started before we acquired the turn.
      while (this.readers > 0) {
        await new Promise((r) => setImmediate(r));
      }
      return await fn(this.value);
    } finally {
      this.handoffWrite();
    }
  }

  // Single synchronous critical section: pick the next LIVE waiter or release.
  private handoffWrite(): void {
    this.writeHeld = false;
    this.pumpWrite();
  }

  // Forward-on-collision: skip cancelled waiters, grant exactly one live one.
  private pumpWrite(): void {
    while (this.writeWaiters.length > 0) {
      const next = this.writeWaiters.shift()!;
      if (next.state !== "queued") continue; // cancelled mid-flight → skip
      next.state = "granted"; // SYNC claim — cancel path now no-ops
      this.writeHeld = true;
      next.grant();
      return;
    }
    // No live writer queued → open the read gate.
    this.refreshReadGate();
  }

  /**
   * Cancel a writer. ONLY a still-`queued` waiter is removed from the
   * queue here. A `granted` waiter already won its turn (grant() =
   * resolve() is irrevocable, so reject() would be a no-op and the caller
   * WOULD still take the turn). Force-forwarding in that case would
   * double-grant — so the granted case is a NO-OP `return`: the waiter
   * keeps the turn, `runHeld` rechecks the signal and throws, then hands
   * off normally. `acquired`/writeHeld accounting stays exact.
   */
  private cancelWriteWaiter(waiter: WriteWaiter, err: unknown): void {
    if (waiter.state !== "queued") return; // granted or already-cancelled → inert
    waiter.state = "cancelled";
    waiter.reject(err);
    // Eager identity splice keeps writeQueueDepth honest (pumpWrite would
    // also skip it lazily).
    const i = this.writeWaiters.indexOf(waiter);
    if (i >= 0) this.writeWaiters.splice(i, 1);
    // It never held the turn, so nothing to forward; but if the queue is
    // now empty and no writer holds, the read gate may reopen.
    if (!this.writeHeld && this.writeWaiters.length === 0) {
      this.refreshReadGate();
    }
  }

  // ── internal: reader gate ───────────────────────────────────────────────

  private refreshReadGate(): void {
    const writerActive = this.writeHeld || this.writeWaiters.length > 0;
    if (writerActive && this.resolveReadGate === null) {
      this.pendingReadGate = new Promise<void>((r) => {
        this.resolveReadGate = r;
      });
    } else if (!writerActive && this.resolveReadGate !== null) {
      const r = this.resolveReadGate;
      this.resolveReadGate = null;
      this.pendingReadGate = Promise.resolve();
      r();
    }
  }

  get activeReaders(): number {
    return this.readers;
  }

  get writeQueueDepth(): number {
    return this.writeWaiters.filter((w) => w.state === "queued").length;
  }

  get writeHeldNow(): boolean {
    return this.writeHeld;
  }
}

// ── shared helpers ──────────────────────────────────────────────────────

function abortError(signal: AbortSignal): unknown {
  // Preserve the abort REASON so terminalToolCauseFromAbortReason still maps
  // a drain abort → "timeout" downstream.
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function raceGate(
  gate: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return gate;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

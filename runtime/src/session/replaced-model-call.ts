/**
 * A model call that is already on the wire when a new task replaces its turn
 * (`Session.spawnTask` aborts the running task with reason `replaced`).
 *
 * Cutting such a call loses its usage: the provider has the request and bills
 * it, but the admission ledger can only hold the call as `held_unknown`
 * (`cancelled_after_dispatch:replaced`), and the session's cost stays unknown
 * from then on. A revived session that finishes a stopped turn by itself meets
 * this whenever a new prompt arrives while that continuation's model call is
 * out.
 *
 * So the replacement waits for that call instead. The turn's call signal holds
 * a `replaced` abort while the call is on the wire, the call settles through
 * the ledger as any finished call does, and the turn then stops on the abort
 * before it uses the answer. The replacing task starts only once the held call
 * has settled (`Session.handleTaskAbort`), so the two never overlap.
 *
 * Only the session's own replacement holds a call: `handleTaskAbort` arms the
 * session's `ReplacedModelCalls` around its abort. A `replaced` reason that
 * reaches another session (a sub-agent's turn copies its parent's reason) is
 * not armed there and cuts at once, as nothing would wait for it.
 *
 * Everything else still cuts the call at once: a replacement before the call
 * went out or after it came back, every other abort reason, the ledger's own
 * cancellations (they abort the lease, not this signal) and the hold's bound.
 * A stop that arrives during a hold (an interrupt, a shutdown, a provider
 * switch) cuts the held calls too (`ReplacedModelCalls.cutAll`).
 */

/** The longest a replacement waits for a call on the wire before cutting it. */
export const REPLACED_MODEL_CALL_SETTLE_MS = 30_000;

interface HeldCall {
  readonly cut: (reason: unknown) => void;
}

/** One session's held calls of replaced turns. */
export class ReplacedModelCalls {
  #armed = 0;
  readonly #held = new Map<Promise<void>, HeldCall>();

  /** `sessionSignal`: the session's own lifetime signal; when it aborts (shutdown, a terminal stop) every hold is cut. */
  constructor(sessionSignal?: AbortSignal) {
    sessionSignal?.addEventListener("abort", () => this.cutAll(sessionSignal.reason), { once: true });
  }

  /** Runs `abort` so that the turns it replaces may hold a call on the wire. */
  armWhile(abort: () => void): void {
    this.#armed += 1;
    try {
      abort();
    } finally {
      this.#armed -= 1;
    }
  }

  get size(): number {
    return this.#held.size;
  }

  /**
   * Holds one call, when an armed replacement is aborting its turn right now.
   * `cut` ends the call at once with a reason. Returns undefined otherwise.
   */
  register(cut: (reason: unknown) => void): { readonly end: () => void } | undefined {
    if (this.#armed === 0) return undefined;
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    this.#held.set(settled, { cut });
    return {
      end: () => {
        if (!this.#held.delete(settled)) return;
        resolve();
      },
    };
  }

  /** Any other stop of the session: cut every held call now. */
  cutAll(reason: unknown): void {
    for (const call of [...this.#held.values()]) call.cut(reason);
  }

  /**
   * Waits until every held call has settled, at most `boundMs`. Each hold ends
   * by itself within `REPLACED_MODEL_CALL_SETTLE_MS`; the bound is a second
   * fence so a replacement can never wait for good.
   */
  async wait(boundMs: number = REPLACED_MODEL_CALL_SETTLE_MS + 1_000): Promise<void> {
    if (this.#held.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.#held.keys()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, boundMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export interface ReplacedModelCallHold {
  /** Follows the turn's signal, except for an armed `replaced` abort while the call is on the wire. */
  readonly signal: AbortSignal;
  /** Runs the provider request; the call counts as on the wire while it runs. */
  onWire<T>(send: () => Promise<T>): Promise<T>;
  /** The admitted call has settled (or failed): end any hold and stop following. */
  release(): void;
}

/**
 * The signal for one admitted model call of a turn whose own signal is
 * `source`, in the session whose replacements `calls` tracks. Without
 * `calls` nothing is held.
 */
export function holdReplacementWhileOnWire(
  source: AbortSignal,
  calls: ReplacedModelCalls | undefined,
  holdMs: number = REPLACED_MODEL_CALL_SETTLE_MS,
): ReplacedModelCallHold {
  const controller = new AbortController();
  let onWire = false;
  let released = false;
  let held: { readonly end: () => void; readonly timer: ReturnType<typeof setTimeout> } | undefined;

  const stop = (reason: unknown = source.reason): void => {
    source.removeEventListener("abort", onAbort);
    if (held !== undefined) {
      clearTimeout(held.timer);
      held.end();
      held = undefined;
    }
    if (source.aborted && !controller.signal.aborted) controller.abort(reason);
  };

  function onAbort(): void {
    const registration = source.reason === "replaced" && onWire && !released
      ? calls?.register((reason) => stop(reason))
      : undefined;
    if (registration === undefined) {
      stop();
      return;
    }
    const timer = setTimeout(() => stop(), holdMs);
    timer.unref?.();
    held = { end: registration.end, timer };
  }

  if (source.aborted) onAbort();
  else source.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    async onWire<T>(send: () => Promise<T>): Promise<T> {
      onWire = true;
      try {
        return await send();
      } catch (error) {
        // A failed request has nothing to settle, and no retry may go out
        // after the replacement: stop holding now.
        onWire = false;
        if (held !== undefined) stop();
        throw error;
      } finally {
        onWire = false;
      }
    },
    release(): void {
      released = true;
      stop();
    },
  };
}

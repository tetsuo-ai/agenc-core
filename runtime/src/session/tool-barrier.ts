/**
 * What a turn must finish before its first tool call runs, so that the
 * model request does not wait for it.
 *
 * The turn's own workspace snapshot (`turnChanges`, read to report what the
 * turn changed) changes nothing in the workspace, yet must come before
 * anything that can. The model takes hundreds of milliseconds to produce a
 * tool call, so the snapshot usually finishes first; the barrier makes that a
 * guarantee instead of a race.
 *
 * - A turn opens the barrier at its start and adds that work to it.
 * - Every tool dispatch of the session waits for it (`waitForToolBarrier`);
 *   once settled it costs nothing.
 *
 * @module
 */

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

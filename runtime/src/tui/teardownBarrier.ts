export type TuiTeardownTask = () => Promise<void>;

/**
 * Per-TUI awaitable cleanup boundary.
 *
 * React effect cleanup cannot itself be awaited. Owners register idempotent
 * teardown tasks here; bootTUI drains them after Ink unmounts and before its
 * caller is allowed to close the daemon transport. A single shared drain also
 * lets stdin-loss wait for the same work before process.exit.
 */
export class TuiTeardownBarrier {
  readonly #tasks = new Set<TuiTeardownTask>();
  #drainPromise: Promise<void> | null = null;

  register(task: TuiTeardownTask): () => void {
    if (this.#drainPromise !== null) {
      throw new Error("TUI teardown has already started");
    }
    this.#tasks.add(task);
    return () => {
      this.#tasks.delete(task);
    };
  }

  drain(): Promise<void> {
    if (this.#drainPromise === null) {
      this.#drainPromise = this.#drain();
    }
    return this.#drainPromise;
  }

  async #drain(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#tasks].map((task) => task()),
    );
    this.#tasks.clear();
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length === 1) throw failures[0]!.reason;
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "multiple TUI teardown tasks failed",
      );
    }
  }
}

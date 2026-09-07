export const DAEMON_AGENT_STOP_TIMEOUT_MS = 30_000;
export const DAEMON_AGENT_CREATE_TIMEOUT_MS = 120_000;
export const DAEMON_AGENT_HARD_STOP_TIMEOUT_MS = 5_000;

export class DaemonOperationTimeoutError extends Error {
  override readonly name = "DaemonOperationTimeoutError";
  readonly code = "DAEMON_OPERATION_TIMEOUT";

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} exceeded ${timeoutMs}ms`);
  }
}

/** One deadline and cancellation signal for all stages of an operation. */
export class DaemonOperationScope {
  readonly #controller = new AbortController();
  readonly #aborted: Promise<never>;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #parent: AbortSignal | undefined;
  readonly #onParentAbort: () => void;

  constructor(operation: string, timeoutMs: number, parent?: AbortSignal) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647
    ) {
      throw new RangeError(
        "daemon operation timeout must be a positive timer interval",
      );
    }
    this.#parent = parent;
    this.#aborted = new Promise<never>((_, reject) => {
      this.signal.addEventListener("abort", () => reject(this.signal.reason), {
        once: true,
      });
    });
    // Cancellation may arrive between waits or before the first stage starts.
    void this.#aborted.catch(() => undefined);
    this.#timer = setTimeout(() => {
      this.abort(new DaemonOperationTimeoutError(operation, timeoutMs));
    }, timeoutMs);
    this.#timer.unref?.();
    this.#onParentAbort = () => this.abort(parent?.reason);
    if (parent?.aborted) this.#onParentAbort();
    else parent?.addEventListener("abort", this.#onParentAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(
    reason: unknown = new DOMException(
      "daemon operation cancelled",
      "AbortError",
    ),
  ): void {
    this.#controller.abort(reason);
  }

  async wait<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.signal.throwIfAborted();
    return Promise.race([
      Promise.resolve().then(() => {
        this.signal.throwIfAborted();
        return operation();
      }),
      this.#aborted,
    ]);
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#parent?.removeEventListener("abort", this.#onParentAbort);
  }
}

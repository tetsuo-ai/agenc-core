import { performance } from "node:perf_hooks";

export class StartupDeadline {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal = this.#controller.signal;
  readonly #expiresAt: number;
  readonly #timeoutError: Error;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort: () => void;
  readonly #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(timeoutMs: number, message: string, externalSignal?: AbortSignal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new RangeError("readyTimeoutMs must be positive and no greater than 2147483647");
    }
    this.#expiresAt = performance.now() + timeoutMs;
    this.#timeoutError = new Error(message);
    this.#externalSignal = externalSignal;
    this.#onExternalAbort = () => this.#controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", this.#onExternalAbort, { once: true });
    if (externalSignal?.aborted) this.#onExternalAbort();
    if (!this.signal.aborted) {
      this.#timer = setTimeout(() => this.#controller.abort(this.#timeoutError), timeoutMs);
    }
  }

  assertActive(): void {
    if (!this.signal.aborted && performance.now() >= this.#expiresAt) {
      this.#controller.abort(this.#timeoutError);
    }
    this.signal.throwIfAborted();
  }

  remainingMs(): number {
    this.assertActive();
    return Math.max(1, Math.ceil(this.#expiresAt - performance.now()));
  }

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: { value: Result } | { error: unknown }): void => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", onAbort);
        if ("error" in result) {
          reject(result.error);
          return;
        }
        try {
          this.assertActive();
          resolve(result.value);
        } catch (error) {
          reject(error);
        }
      };
      const onAbort = (): void => finish({ error: this.signal.reason });
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) {
        onAbort();
        return;
      }
      Promise.resolve().then(() => {
        this.assertActive();
        return operation();
      }).then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    });
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#externalSignal?.removeEventListener("abort", this.#onExternalAbort);
  }
}

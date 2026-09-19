import { LLMProviderError } from "../../errors.js";

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000;
/**
 * Number of consecutive probe failures the sidecar tolerates before
 * aborting the in-flight operation. The previous value (effectively 1)
 * killed the user's stream on a single transient blip — a brief
 * restart of the local server, or a probe timing out behind a busy
 * server. With the default 2 the operator gets ≥{intervalMs} grace,
 * so a brief lmstudio restart between turns no longer kills an
 * in-flight completion.
 */
const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 2;

function buildLocalProviderDownError(
  providerLabel: string,
): LLMProviderError {
  return new LLMProviderError(
    providerLabel.toLowerCase(),
    `local provider lost connection - restart ${providerLabel} and retry.`,
  );
}

function isConnectionRefusedError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === "ECONNREFUSED") return true;
  const message = String((error as { message?: unknown })?.message ?? "");
  return /ECONNREFUSED|connection refused/i.test(message);
}

function throwCallerCancellation(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "This operation was aborted",
    "AbortError",
  );
}

export async function runLocalProviderHealthSidecar<T>(params: {
  readonly providerLabel: string;
  readonly operation: (signal: AbortSignal) => Promise<T>;
  readonly healthCheck: () => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  /**
   * Override the consecutive-failure threshold. Pass 1 to restore
   * the prior "abort on first failure" semantics (rarely useful;
   * available for tests).
   */
  readonly consecutiveFailureThreshold?: number;
}): Promise<T> {
  const controller = new AbortController();
  const intervalMs = params.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  const failureThreshold = Math.max(
    1,
    params.consecutiveFailureThreshold ?? DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
  );
  let sidecarError: Error | undefined;
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const abortFromUpstream = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(params.signal?.reason);
    }
  };
  // Attach first so a concurrent abort is observed, then honor a signal
  // that was already aborted. AbortSignal does not replay an earlier
  // abort event to a later listener.
  params.signal?.addEventListener("abort", abortFromUpstream, { once: true });
  if (params.signal?.aborted) {
    abortFromUpstream();
  }

  const throwIfCancelledBeforeOperation = (): void => {
    if (controller.signal.aborted) {
      throwCallerCancellation(controller.signal);
    }
  };

  try {
    // Pre-aborted and setup-race cancels must not start the health
    // timer or provider work.
    throwIfCancelledBeforeOperation();

    // Increment the consecutive-failure counter; abort only after the
    // threshold is reached. A successful probe resets the counter so
    // intermittent failures don't accumulate indefinitely.
    const recordFailure = (): void => {
      if (sidecarError) return;
      consecutiveFailures += 1;
      if (consecutiveFailures < failureThreshold) return;
      sidecarError = buildLocalProviderDownError(params.providerLabel);
      if (!controller.signal.aborted) {
        controller.abort(sidecarError);
      }
    };

    timer = setInterval(() => {
      void params.healthCheck()
        .then((healthy) => {
          if (sidecarError) return;
          if (healthy) {
            consecutiveFailures = 0;
            return;
          }
          recordFailure();
        })
        .catch((error) => {
          if (sidecarError) return;
          if (!isConnectionRefusedError(error)) return;
          recordFailure();
        });
    }, intervalMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    const operation = params.operation;
    throwIfCancelledBeforeOperation();
    const result = await operation(controller.signal);
    if (sidecarError) throw sidecarError;
    return result;
  } catch (error) {
    if (sidecarError) throw sidecarError;
    throw error;
  } finally {
    if (timer !== undefined) {
      clearInterval(timer);
    }
    params.signal?.removeEventListener("abort", abortFromUpstream);
  }
}

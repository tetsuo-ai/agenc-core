/**
 * Timeout helper for LLM provider calls.
 *
 * @module
 */

function createAbortTimeoutError(
  providerName: string,
  timeoutMs: number,
): Error {
  const err = new Error(`${providerName} request aborted after ${timeoutMs}ms`);
  (err as any).name = "AbortError";
  (err as any).code = "ABORT_ERR";
  return err;
}

// gaphunt3 #42: an external-signal abort (user interrupt / caller cancel) is
// not a provider timeout. Reject with an error derived from the signal's own
// abort reason so the real cause is preserved in logs/telemetry and is not
// relabeled as a (retryable) LLMTimeoutError by mapLLMError (which keys off the
// AbortError name / ABORT_ERR code). Downstream abort handling already relies on
// the AbortSignal's own `aborted` flag, not on this error's name/code, so the
// non-AbortError shape here is safe.
function createExternalAbortError(
  providerName: string,
  externalSignal: AbortSignal,
): Error {
  const reason = (externalSignal as { reason?: unknown }).reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new Error(reason);
  }
  return new Error(`${providerName} request aborted by external signal`);
}

/**
 * Execute an async provider call with an explicit AbortController timeout.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  providerName: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  if ((!timeoutMs || timeoutMs <= 0) && !externalSignal) {
    const controller = new AbortController();
    return fn(controller.signal);
  }
  if (externalSignal?.aborted) {
    throw createExternalAbortError(providerName, externalSignal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let terminalError: Error | undefined;

  const abortPhysicalCall = (error: Error, reason: unknown): void => {
    if (terminalError !== undefined) return;
    terminalError = error;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!controller.signal.aborted) controller.abort(reason);
  };

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      const error = createAbortTimeoutError(providerName, timeoutMs);
      abortPhysicalCall(error, error);
    }, timeoutMs);
  }

  if (externalSignal) {
    abortHandler = () => {
      // gaphunt3 #42: preserve the external signal's real abort reason
      // instead of fabricating a "<provider> request aborted after 0ms"
      // timeout error.
      abortPhysicalCall(
        createExternalAbortError(providerName, externalSignal),
        externalSignal.reason,
      );
    };
    externalSignal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    // Signal timeout/cancellation to the provider immediately, but keep the
    // logical call pending until its physical promise settles. The enclosing
    // execution-admission lease must retain capacity while an abort-ignoring
    // provider request is still live.
    try {
      const result = await fn(controller.signal);
      if (terminalError !== undefined) throw terminalError;
      return result;
    } catch (error) {
      if (terminalError !== undefined) throw terminalError;
      throw error;
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal && abortHandler) {
      externalSignal.removeEventListener("abort", abortHandler);
    }
  }
}

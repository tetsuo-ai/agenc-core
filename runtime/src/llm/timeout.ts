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

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const guardPromises: Promise<never>[] = [];

  if (timeoutMs && timeoutMs > 0) {
    guardPromises.push(new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(createAbortTimeoutError(providerName, timeoutMs));
      }, timeoutMs);
    }));
  }

  if (externalSignal) {
    guardPromises.push(new Promise<never>((_, reject) => {
      abortHandler = () => {
        controller.abort();
        // gaphunt3 #42: preserve the external signal's real abort reason
        // instead of fabricating a "<provider> request aborted after 0ms"
        // timeout error.
        reject(createExternalAbortError(providerName, externalSignal));
      };
      if (externalSignal.aborted) {
        abortHandler();
        return;
      }
      externalSignal.addEventListener("abort", abortHandler, { once: true });
    }));
  }

  try {
    return await Promise.race([fn(controller.signal), ...guardPromises]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal && abortHandler) {
      externalSignal.removeEventListener("abort", abortHandler);
    }
  }
}

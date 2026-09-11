export interface AgenCTransportCloseOptions {
  /** Bound handler draining after the listener and its peers have closed. */
  readonly drainTimeoutMs?: number;
}

export async function drainAgenCTransportRequests(
  pending: readonly Promise<void>[],
  options: AgenCTransportCloseOptions,
): Promise<void> {
  const timeoutMs = options.drainTimeoutMs;
  if (timeoutMs === undefined) {
    await Promise.allSettled(pending);
    return;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("daemon transport drain timeout must be a positive integer");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `daemon transport request drain exceeded ${timeoutMs} ms`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

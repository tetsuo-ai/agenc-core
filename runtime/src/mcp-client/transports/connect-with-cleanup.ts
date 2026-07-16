/**
 * Minimal client shape shared by the MCP transport factories.
 *
 * Keeping the timeout race here makes one lifecycle rule explicit: a failed
 * factory never settles until the client has finished closing its transport.
 */
export interface MCPConnectClient<TTransport> {
  connect(transport: TTransport): Promise<void>;
  close(): Promise<void>;
}

export interface MCPConnectOptions {
  readonly description: string;
  readonly timeoutMs: number;
}

interface ObservedCloseLifecycle {
  connectionSucceeded(): void;
}

/**
 * The MCP SDK starts cleanup with `void this.close()` when initialization
 * rejects. Wrap the method before connect so that SDK-initiated cleanup and
 * factory-initiated cleanup share one observed promise. Retain that promise
 * for a failed connection even after it settles: otherwise a fast rejection
 * could be cleared before the factory gets a chance to await it.
 *
 * Once connection succeeds, only concurrent close calls are deduplicated and
 * the wrapper resets after settlement. This preserves normal close/reconnect
 * behavior for clients returned to callers.
 */
function observeClientClose<TTransport>(
  client: MCPConnectClient<TTransport>,
): ObservedCloseLifecycle {
  const originalClose = client.close.bind(client);
  let connectionPending = true;
  let closeSettled = false;
  let closePromise: Promise<void> | undefined;

  client.close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;

    try {
      closePromise = Promise.resolve(originalClose());
    } catch (error) {
      closePromise = Promise.reject(error);
    }
    const observedPromise = closePromise;

    // Observe the exact promise returned to both the SDK and awaited callers.
    // The observer prevents a fire-and-forget SDK invocation from becoming an
    // unhandled rejection; awaiting observedPromise still receives the error.
    void observedPromise.catch(() => undefined);
    void observedPromise.then(
      () => settleClose(observedPromise),
      () => settleClose(observedPromise),
    );
    return observedPromise;
  };

  const settleClose = (settledPromise: Promise<void>): void => {
    if (closePromise !== settledPromise) return;
    closeSettled = true;
    if (!connectionPending) closePromise = undefined;
  };

  return {
    connectionSucceeded(): void {
      connectionPending = false;
      if (closeSettled) closePromise = undefined;
    },
  };
}

/**
 * Connect a client within the configured deadline and close it on every
 * failure path. When cleanup also fails, retain both errors and use the
 * connection failure as the causal error.
 */
export async function connectMCPClientWithCleanup<TTransport>(
  client: MCPConnectClient<TTransport>,
  transport: TTransport,
  options: MCPConnectOptions,
): Promise<void> {
  const closeLifecycle = observeClientClose(client);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connectPromise = Promise.resolve().then(() =>
    client.connect(transport),
  );
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${options.description} timed out after ${options.timeoutMs}ms`,
        ),
      );
    }, options.timeoutMs);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
    closeLifecycle.connectionSucceeded();
  } catch (connectError) {
    clearTimeout(timer);
    try {
      await client.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [connectError, cleanupError],
        `${options.description} failed and transport cleanup also failed`,
        { cause: connectError },
      );
    }
    throw connectError;
  } finally {
    clearTimeout(timer);
  }
}

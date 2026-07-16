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

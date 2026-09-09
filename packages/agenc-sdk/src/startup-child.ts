export interface StartupChild {
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
  readonly stderr?: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
}

export function waitForStartupChild(
  child: StartupChild,
  signal: AbortSignal,
  onData: (chunk: Buffer | string) => void,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopping = false;
    let failure: unknown;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null, cleanupFailed = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(escalation);
      clearTimeout(cleanupTimeout);
      signal.removeEventListener("abort", onAbort);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      child.stderr?.removeListener("data", onData);
      if (cleanupFailed) {
        reject(new AggregateError([failure], "Daemon starter did not close within 1000ms of cancellation", { cause: failure }));
      } else if (stopping) {
        reject(failure);
      } else {
        resolve(code);
      }
    };
    const terminate = (terminationSignal: NodeJS.Signals): void => {
      try {
        child.kill(terminationSignal);
      } catch {
        return;
      }
    };
    const stop = (reason: unknown): void => {
      if (settled || stopping) return;
      stopping = true;
      failure = reason;
      escalation = setTimeout(() => terminate("SIGKILL"), 100);
      cleanupTimeout = setTimeout(() => finish(null, true), 1_000);
      terminate("SIGTERM");
    };
    const onAbort = (): void => stop(signal.reason);
    const onError = (error: Error): void => stop(error);
    const onClose = (code: number | null): void => {
      if (signal.aborted && !stopping) {
        stopping = true;
        failure = signal.reason;
      }
      finish(code);
    };
    child.once("close", onClose);
    child.on("error", onError);
    child.stderr?.on("data", onData);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

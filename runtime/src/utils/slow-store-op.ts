/**
 * Timing guard for synchronous store operations that run on the event loop
 * serving the daemon's RPC. Sessions execute in-process, so a slow snapshot
 * write, rollout flush, canonical scan, prune or archive stalls every client;
 * until now none of them left a trace anywhere. Anything slower than the
 * threshold is reported through the configured reporter as a
 * `slow_store_op` warning carrying the label and duration. The default
 * reporter writes one console.warn line, which the detached daemon routes into
 * its rotating daemon.log sink.
 */
export const SLOW_STORE_OP_THRESHOLD_MS = 50;

export interface SlowStoreOpWarning {
  readonly cause: "slow_store_op";
  readonly label: string;
  readonly ms: number;
}

export type SlowStoreOpReporter = (warning: SlowStoreOpWarning) => void;

const defaultReporter: SlowStoreOpReporter = (warning) => {
  // eslint-disable-next-line no-console
  console.warn(
    `agenc: slow_store_op ${JSON.stringify({ label: warning.label, ms: warning.ms })}`,
  );
};

let reporter: SlowStoreOpReporter = defaultReporter;

/** Replace the process-wide reporter; `undefined` restores the default. */
export function setSlowStoreOpReporter(
  next: SlowStoreOpReporter | undefined,
): void {
  reporter = next ?? defaultReporter;
}

/**
 * Run `fn`, returning its result (or rethrowing its error), and report when it
 * took longer than `thresholdMs`. Reporting never masks the operation: a
 * throwing reporter is swallowed.
 */
export function timed<T>(
  label: string,
  fn: () => T,
  report: SlowStoreOpReporter = reporter,
  thresholdMs: number = SLOW_STORE_OP_THRESHOLD_MS,
): T {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - startedAt;
    if (ms > thresholdMs) {
      try {
        report({ cause: "slow_store_op", label, ms: Math.round(ms) });
      } catch {
        // A failing reporter must not turn a slow store op into a failed one.
      }
    }
  }
}

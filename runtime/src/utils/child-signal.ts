import type { ChildProcess } from "node:child_process";

/**
 * A pid a signal may be sent to: a safe integer above 1. kill(2) reads 0 as
 * the caller's own process group, -1 as every process the caller may
 * signal, and 1 is init. A child whose spawn failed has no pid at all.
 */
export function isSignalablePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
}

/** The error spawn's own `signal` option reports when it stops a child. */
export function childProcessAbortError(reason?: unknown): Error {
  return Object.assign(
    new Error(
      "The operation was aborted",
      reason === undefined ? undefined : { cause: reason },
    ),
    { name: "AbortError", code: "ABORT_ERR" },
  );
}

/**
 * Stop `child` when `signal` aborts, as spawn's own `signal` option does:
 * send SIGTERM, then report an AbortError on the child's `error` event.
 *
 * Unlike Node's handler, it never signals a child without a pid of its own.
 * A spawn that failed keeps an open handle with no pid until Node reports
 * the failure on the next tick; a kill() in that window is kill(0), which
 * signals the caller's whole process group. Such a child is left to that
 * pending report.
 *
 * Callers check `signal.aborted` before spawning, so nothing starts for an
 * abort that already happened. The listener goes away when the child exits
 * or fails; the returned function removes it earlier.
 */
export function stopChildOnAbort(
  child: ChildProcess,
  signal: AbortSignal | undefined,
): () => void {
  if (signal === undefined) return () => {};
  let listening = true;
  const dispose = (): void => {
    if (!listening) return;
    listening = false;
    signal.removeEventListener("abort", onAbort);
    child.removeListener("exit", dispose);
    child.removeListener("error", dispose);
  };
  function onAbort(): void {
    dispose();
    if (!isSignalablePid(child.pid)) return;
    try {
      if (child.kill()) {
        child.emit("error", childProcessAbortError(signal?.reason));
      }
    } catch (error) {
      child.emit("error", error);
    }
  }
  child.once("exit", dispose);
  child.once("error", dispose);
  if (signal.aborted) {
    // Callers check before spawning; this only covers an abort that landed
    // between that check and this call. Node defers it the same way.
    process.nextTick(onAbort);
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return dispose;
}

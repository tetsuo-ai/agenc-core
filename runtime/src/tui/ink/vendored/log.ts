/**
 * Vendored minimal error-log shim. Upstream logError writes to disk and a
 * configurable sink; the Ink core only needs a best-effort stderr report
 * that never throws.
 */

export function logError(error: unknown): void {
  try {
    if (error instanceof Error) {
      process.stderr.write(`[ink] ${error.stack ?? error.message}\n`)
      return
    }
    process.stderr.write(`[ink] ${String(error)}\n`)
  } catch {
    // Never throw from the error reporter.
  }
}

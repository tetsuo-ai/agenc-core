/**
 * Per-dir logger surface for `runtime/src/mcp-client/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/logger.ts` API the
 * mcp-client modules use (`Logger`, `silentLogger`). Carved as a local
 * `_deps/` to cut the gut→AgenC crossing without losing behavior.
 */

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

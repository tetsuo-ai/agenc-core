/**
 * Minimal logger adapter for the TUI tree.
 *
 * Only the silent logger is reached from the AgenC TUI today; keeping the
 * adapter explicit avoids importing the runtime logger into the vendored Ink
 * subtree.
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

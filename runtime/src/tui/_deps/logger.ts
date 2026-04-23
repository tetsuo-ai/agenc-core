/**
 * Local stub for openclaude `utils/logger.ts`.
 *
 * Only the silent logger is reached for from the gut TUI tree, so this
 * shim provides just that minimal surface.
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

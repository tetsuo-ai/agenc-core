/**
 * Logger utility for @tetsuo-ai/runtime.
 *
 * Minimal replacement for the SDK logger that used to be imported from
 * `@tetsuo-ai/sdk`. The lean runtime has no SDK dependency.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function createLogger(
  minLevel: LogLevel = "info",
  prefix = "[AgenC]",
): Logger {
  const threshold = LEVEL_RANK[minLevel] ?? LEVEL_RANK.info;
  const stamp = () => new Date().toISOString();
  const emit = (
    level: LogLevel,
    tag: string,
    message: string,
    args: unknown[],
  ) => {
    if (LEVEL_RANK[level] < threshold) return;
    const line = `${stamp()} ${tag.padEnd(5)} ${prefix} ${message}`;
    if (level === "error" || level === "warn") {
      console.error(line, ...args);
    } else {
      console.log(line, ...args);
    }
  };
  return {
    debug: (message, ...args) => emit("debug", "DEBUG", message, args),
    info: (message, ...args) => emit("info", "INFO", message, args),
    warn: (message, ...args) => emit("warn", "WARN", message, args),
    error: (message, ...args) => emit("error", "ERROR", message, args),
  };
}

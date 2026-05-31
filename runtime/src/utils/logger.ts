/**
 * Logger utility for @tetsuo-ai/runtime.
 *
 * Minimal replacement for the SDK logger that used to be imported from
 * `@tetsuo-ai/sdk`. The lean runtime has no SDK dependency.
 */

import {
  closeSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";

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

/**
 * Default per-file byte cap for {@link createSizeCappedFileLogSink}. Once the
 * active log file exceeds this size it is rotated to `<path>.1` (overwriting
 * any prior rotation) and a fresh file is started, so on-disk usage is bounded
 * to roughly `2 * maxBytes`.
 */
export const DEFAULT_LOG_SINK_MAX_BYTES = 16 * 1024 * 1024;

export interface SizeCappedFileLogSinkOptions {
  /** Absolute path of the active log file. */
  readonly path: string;
  /** Byte cap before rotation. Defaults to {@link DEFAULT_LOG_SINK_MAX_BYTES}. */
  readonly maxBytes?: number;
}

export interface SizeCappedFileLogSink {
  /** Append a chunk, rotating first if the file would exceed the cap. */
  write(chunk: string | Uint8Array): void;
  /** Close the underlying file descriptor. */
  close(): void;
  /** Bytes written to the current (post-rotation) file. */
  readonly currentBytes: number;
}

/**
 * A minimal append-only file sink that bounds disk growth via single-backup
 * rotation. This exists so the long-lived daemon can capture its own
 * stdout/stderr without the historical failure mode where `daemon.log` grew to
 * gigabytes with no rotation. Kept synchronous and dependency-free so it can be
 * installed before any async startup work and survive abrupt termination.
 */
export function createSizeCappedFileLogSink(
  options: SizeCappedFileLogSinkOptions,
): SizeCappedFileLogSink {
  const maxBytes =
    options.maxBytes !== undefined && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_LOG_SINK_MAX_BYTES;
  const { path } = options;
  const rotatedPath = `${path}.1`;

  // Resume from the existing file's size so repeated short-lived starts do not
  // forget how close we already are to the cap.
  let fd = openSync(path, "a");
  let currentBytes = 0;
  try {
    currentBytes = statSync(path).size;
  } catch {
    currentBytes = 0;
  }

  const rotate = (): void => {
    try {
      closeSync(fd);
    } catch {
      // best effort; reopen below regardless
    }
    try {
      renameSync(path, rotatedPath);
    } catch {
      // If rotation fails (e.g. cross-device), fall back to truncating by
      // reopening with "w" so growth is still bounded.
      fd = openSync(path, "w");
      currentBytes = 0;
      return;
    }
    fd = openSync(path, "a");
    currentBytes = 0;
  };

  return {
    write(chunk: string | Uint8Array): void {
      const buffer =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (buffer.length === 0) return;
      if (currentBytes + buffer.length > maxBytes && currentBytes > 0) {
        rotate();
      }
      try {
        writeSync(fd, buffer);
        currentBytes += buffer.length;
      } catch {
        // Never let logging crash the daemon.
      }
    },
    close(): void {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    },
    get currentBytes(): number {
      return currentBytes;
    },
  };
}

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

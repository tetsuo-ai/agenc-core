import { format } from "node:util";

import { logForDebugging } from "./vendored/debug.js";
import { logError } from "./vendored/log.js";

const CONSOLE_STDOUT_METHODS = [
  "log",
  "info",
  "debug",
  "dir",
  "dirxml",
  "count",
  "countReset",
  "group",
  "groupCollapsed",
  "groupEnd",
  "table",
  "time",
  "timeEnd",
  "timeLog",
] as const;

const CONSOLE_STDERR_METHODS = ["warn", "error", "trace"] as const;

export function patchConsoleForInk(): () => void {
  const con = console;
  const originals: Partial<Record<keyof Console, Console[keyof Console]>> = {};
  const toDebug = (...args: unknown[]) =>
    logForDebugging(`console.log: ${format(...args)}`);
  const toError = (...args: unknown[]) =>
    logError(new Error(`console.error: ${format(...args)}`));
  for (const method of CONSOLE_STDOUT_METHODS) {
    originals[method] = con[method];
    con[method] = toDebug;
  }
  for (const method of CONSOLE_STDERR_METHODS) {
    originals[method] = con[method];
    con[method] = toError;
  }
  originals.assert = con.assert;
  con.assert = (condition: unknown, ...args: unknown[]) => {
    if (!condition) toError(...args);
  };
  return () => Object.assign(con, originals);
}

export function patchStderrForInk(options: {
  readonly isAltScreenActive: () => boolean;
  readonly isUnmounted: () => boolean;
  readonly isPaused: () => boolean;
  readonly markContaminated: () => void;
  readonly scheduleRender: () => void;
}): () => void {
  const stderr = process.stderr;
  const originalWrite = stderr.write;
  let reentered = false;
  const intercept = (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    if (reentered) {
      const encoding =
        typeof encodingOrCb === "string" ? encodingOrCb : undefined;
      return originalWrite.call(
        stderr,
        chunk,
        encoding,
        callback as ((err?: Error | null | undefined) => void) | undefined,
      );
    }
    reentered = true;
    try {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf8");
      logForDebugging(`[stderr] ${text}`, {
        level: "warn",
      });
      if (
        options.isAltScreenActive() &&
        !options.isUnmounted() &&
        !options.isPaused()
      ) {
        options.markContaminated();
        options.scheduleRender();
      }
    } finally {
      reentered = false;
      callback?.();
    }
    return true;
  };
  stderr.write = intercept;
  return () => {
    if (stderr.write === intercept) {
      stderr.write = originalWrite;
    }
  };
}

/**
 * Early input capture for AgenC's Ink TUI.
 *
 * This mirrors OpenClaude's startup behavior: if the operator launches
 * `agenc` and starts typing before React/Ink has mounted, those bytes are
 * buffered and later used as the initial composer draft instead of being
 * lost. It is deliberately disabled for print / non-TTY paths because raw
 * mode would otherwise steal normal shell signal handling.
 */

import { lastGrapheme } from "./intl.js";

let earlyInputBuffer = "";
let isCapturing = false;
let readableHandler: (() => void) | null = null;
let ownsRawMode = false;

type RawModeStdin = typeof process.stdin & {
  setRawMode?: (enabled: boolean) => void;
};

function shouldCapture(): boolean {
  if (!process.stdin.isTTY) return false;
  if (isCapturing) return false;
  if (process.env.AGENC_DISABLE_EARLY_INPUT === "1") return false;
  if (process.argv.includes("-p") || process.argv.includes("--print")) {
    return false;
  }
  return true;
}

export function startCapturingEarlyInput(): void {
  if (!shouldCapture()) return;

  const stdin = process.stdin as RawModeStdin;
  if (typeof stdin.setRawMode !== "function") return;

  isCapturing = true;
  earlyInputBuffer = "";

  try {
    process.stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    ownsRawMode = true;
    process.stdin.ref();

    readableHandler = () => {
      let chunk = process.stdin.read();
      while (chunk !== null) {
        if (typeof chunk === "string") {
          processChunk(chunk);
        }
        chunk = process.stdin.read();
      }
    };

    process.stdin.on("readable", readableHandler);
  } catch {
    isCapturing = false;
    ownsRawMode = false;
    readableHandler = null;
  }
}

function processChunk(input: string): void {
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    const code = char.charCodeAt(0);

    if (code === 3) {
      stopCapturingEarlyInput();
      process.exit(130);
      return;
    }

    if (code === 4) {
      stopCapturingEarlyInput();
      return;
    }

    if (code === 127 || code === 8) {
      if (earlyInputBuffer.length > 0) {
        const last = lastGrapheme(earlyInputBuffer);
        earlyInputBuffer = earlyInputBuffer.slice(0, -(last.length || 1));
      }
      index += 1;
      continue;
    }

    if (code === 27) {
      index += 1;
      while (
        index < input.length &&
        !(input.charCodeAt(index) >= 64 && input.charCodeAt(index) <= 126)
      ) {
        index += 1;
      }
      if (index < input.length) index += 1;
      continue;
    }

    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      index += 1;
      continue;
    }

    earlyInputBuffer += code === 13 ? "\n" : char;
    index += 1;
  }
}

export interface StopEarlyInputOptions {
  readonly restoreRawMode?: boolean;
}

export function stopCapturingEarlyInput(
  options: StopEarlyInputOptions = {},
): void {
  if (!isCapturing && !ownsRawMode) return;
  isCapturing = false;

  if (readableHandler) {
    process.stdin.removeListener("readable", readableHandler);
    readableHandler = null;
  }

  if (options.restoreRawMode === true && ownsRawMode) {
    try {
      (process.stdin as RawModeStdin).setRawMode?.(false);
    } catch {
      // Best effort: the TUI bootstrap also claims/restores raw mode.
    }
    ownsRawMode = false;
  }
}

export function consumeEarlyInput(options: StopEarlyInputOptions = {}): string {
  stopCapturingEarlyInput(options);
  const input = earlyInputBuffer.trim();
  earlyInputBuffer = "";
  return input;
}

export function hasEarlyInput(): boolean {
  return earlyInputBuffer.trim().length > 0;
}

export function seedEarlyInput(text: string): void {
  earlyInputBuffer = text;
}

export function isCapturingEarlyInput(): boolean {
  return isCapturing;
}

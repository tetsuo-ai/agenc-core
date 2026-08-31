/**
 * Shared plumbing for the desktop-facing headless CLIs (openai-login,
 * grok-login, openai-models): one IO contract, one browser opener, and
 * one emit/fail pair so every command speaks the same NDJSON dialect.
 */

import { spawn } from "node:child_process";

export interface HeadlessCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

/** Open a URL without holding the CLI's lifetime hostage to the browser. */
export function openUrlDetached(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // The URL is printed either way; a missing opener is not fatal.
  });
  child.unref();
}

export interface HeadlessEmitters {
  /** One record (JSON mode) or one plain line to stdout. */
  readonly emit: (payload: Record<string, unknown>, plain: string) => void;
  /** Failure verdict: JSON record on stdout, or plain stderr. Returns 1. */
  readonly fail: (error: string, code?: string) => number;
}

export function createHeadlessEmitters(
  json: boolean,
  io: HeadlessCliIo,
  failPrefix: string,
): HeadlessEmitters {
  return {
    emit: (payload, plain) => {
      io.stdout.write(json ? `${JSON.stringify(payload)}\n` : `${plain}\n`);
    },
    fail: (error, code) => {
      if (json) {
        io.stdout.write(
          `${JSON.stringify({ ok: false, error, ...(code !== undefined ? { code } : {}) })}\n`,
        );
      } else {
        io.stderr.write(`${failPrefix}: ${error}\n`);
      }
      return 1;
    },
  };
}


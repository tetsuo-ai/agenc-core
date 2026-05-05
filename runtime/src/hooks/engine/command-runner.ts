/**
 * Subprocess execution for configured command hooks.
 *
 * Ports the Rust engine command-runner behavior listed in `PARITY.md`
 * onto Node child processes.
 */

import { spawn } from "node:child_process";

import type { CommandRunResult } from "./types.js";

export interface RunHookCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shellPath: string;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export async function runHookCommand(
  opts: RunHookCommandOptions,
): Promise<CommandRunResult> {
  const started = Date.now();
  if (opts.signal?.aborted === true) {
    return {
      status: "skipped",
      stdout: "",
      stderr: "",
      durationMs: Date.now() - started,
      error: "hook aborted",
    };
  }
  return new Promise((resolve) => {
    const child = spawn(opts.shellPath, ["-c", opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let abortListener: (() => void) | null = null;
    let terminationResult:
      | Omit<CommandRunResult, "durationMs" | "stdout" | "stderr">
      | null = null;
    let killEscalation: NodeJS.Timeout | null = null;
    const finish = (
      result: Omit<CommandRunResult, "durationMs" | "stdout" | "stderr">,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killEscalation !== null) clearTimeout(killEscalation);
      if (abortListener !== null && opts.signal !== undefined) {
        opts.signal.removeEventListener("abort", abortListener);
        abortListener = null;
      }
      resolve({
        ...result,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    };
    const requestTermination = (
      result: Omit<CommandRunResult, "durationMs" | "stdout" | "stderr">,
    ) => {
      if (settled || terminationResult !== null) return;
      terminationResult = result;
      signalChild(child.pid, "SIGTERM");
      killEscalation = setTimeout(() => {
        signalChild(child.pid, "SIGKILL");
      }, 250);
    };
    const timeout = setTimeout(() => {
      requestTermination({
        status: "timeout",
        error: `hook timed out after ${Math.max(1, Math.ceil(opts.timeoutMs / 1000))}s`,
      });
    }, opts.timeoutMs);
    if (opts.signal !== undefined) {
      abortListener = () => {
        requestTermination({ status: "skipped", error: "hook aborted" });
      };
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      finish({
        status: "non_blocking_error",
        error: err.message,
      });
    });
    child.on("close", (code) => {
      if (terminationResult !== null) {
        finish(terminationResult);
        return;
      }
      if (code === 0) {
        finish({ status: "success", exitCode: 0 });
        return;
      }
      if (code === 2) {
        finish({ status: "blocking", exitCode: 2 });
        return;
      }
      finish({
        status: "non_blocking_error",
        ...(code !== null ? { exitCode: code } : {}),
      });
    });
    child.stdin.on("error", () => {
      // Hooks may exit before reading stdin. The process exit status remains
      // the authoritative result.
    });
    child.stdin.end(opts.stdin);
  });
}

function signalChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Best effort; close/error events remain authoritative.
    }
  }
}

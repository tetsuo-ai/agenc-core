/**
 * Subprocess execution for configured command hooks.
 *
 * Runs configured hook commands through Node child processes.
 */

import { spawn } from "node:child_process";
import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../../sandbox/execution-broker.js";

import type { CommandRunResult } from "./types.js";

const MAX_HOOK_OUTPUT_CHARS = 1_048_576;

export interface RunHookCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shellPath: string;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
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
  const env = stringOnlyEnv(opts.env);
  if (opts.sandboxExecutionBroker === undefined) {
    throw missingSandboxExecutionBoundary("hook");
  }
  const command = opts.sandboxExecutionBroker.prepareSpawn("hook", {
    program: opts.shellPath,
    args: ["-c", opts.command],
    cwd: opts.cwd,
    env,
  });
  return new Promise((resolve) => {
    const child = spawn(command.program, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...(command.argv0 !== undefined ? { argv0: command.argv0 } : {}),
    });
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
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
        ...(result.error !== undefined
          ? { error: result.error }
          : outputTruncated
            ? { error: `hook output truncated at ${MAX_HOOK_OUTPUT_CHARS} characters per stream` }
            : {}),
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
      const appended = appendBoundedOutput(stdout, String(chunk));
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendBoundedOutput(stderr, String(chunk));
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
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

function stringOnlyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function appendBoundedOutput(
  current: string,
  chunk: string,
): { readonly value: string; readonly truncated: boolean } {
  if (current.length >= MAX_HOOK_OUTPUT_CHARS) {
    return { value: current, truncated: chunk.length > 0 };
  }
  const remaining = MAX_HOOK_OUTPUT_CHARS - current.length;
  if (chunk.length <= remaining) {
    return { value: current + chunk, truncated: false };
  }
  return {
    value: current + chunk.slice(0, remaining),
    truncated: true,
  };
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

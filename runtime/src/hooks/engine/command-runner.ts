/**
 * Subprocess execution for configured command hooks.
 *
 * Runs configured hook commands through Node child processes.
 */

import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../../sandbox/execution-broker.js";
import { runSupervisedProcess } from "../../utils/supervisedProcess.js";
import {
  commandShellArgs,
  wrapCommandForShell,
} from "../../utils/shell/commandExecution.js";

import type { CommandRunResult } from "./types.js";

const MAX_HOOK_OUTPUT_CHARS = 1_048_576;

export interface RunHookCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shellPath: string;
  readonly commandWrapperArgv?: readonly string[];
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
  const command = wrapCommandForShell(
    opts.shellPath,
    opts.commandWrapperArgv,
    opts.command,
  );
  const preparedSpawn = opts.sandboxExecutionBroker.prepareSpawn("hook", {
    program: opts.shellPath,
    args: commandShellArgs(opts.shellPath, command),
    cwd: opts.cwd,
    env,
  });
  const result = await runSupervisedProcess(preparedSpawn, {
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: MAX_HOOK_OUTPUT_CHARS * 2,
    stdin: opts.stdin,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const boundedStdout = appendBoundedOutput("", result.stdout.toString("utf8"));
  const boundedStderr = appendBoundedOutput("", result.stderr.toString("utf8"));
  const outputTruncated = boundedStdout.truncated || boundedStderr.truncated;
  const common = {
    stdout: boundedStdout.value,
    stderr: boundedStderr.value,
    durationMs: Date.now() - started,
  };
  if (result.stopReason === "timeout") {
    return {
      ...common,
      status: "timeout",
      error: `hook timed out after ${Math.max(1, Math.ceil(opts.timeoutMs / 1000))}s`,
    };
  }
  if (result.stopReason === "aborted") {
    return { ...common, status: "skipped", error: "hook aborted" };
  }
  if (result.exitCode === 0 && result.stopReason === undefined) {
    return {
      ...common,
      status: "success",
      exitCode: 0,
      ...(outputTruncated
        ? { error: `hook output truncated at ${MAX_HOOK_OUTPUT_CHARS} characters per stream` }
        : {}),
    };
  }
  if (result.exitCode === 2 && result.stopReason === undefined) {
    return { ...common, status: "blocking", exitCode: 2 };
  }
  return {
    ...common,
    status: "non_blocking_error",
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    ...(result.error !== undefined ? { error: result.error.message } : {}),
  };
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

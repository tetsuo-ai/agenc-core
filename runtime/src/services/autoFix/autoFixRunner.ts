/**
 * Runs sandbox-bounded auto-fix checks in lint-then-test order, with capped
 * output and command-tree termination on timeout or abort.
 */

import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../../sandbox/execution-broker.js";
import { scrubEnvForChildProcess } from "../../unified-exec/scrub-env.js";
import { runSupervisedProcess } from "../../utils/supervisedProcess.js";
import {
  commandShellArgs,
  wrapCommandForShell,
} from "../../utils/shell/commandExecution.js";

export interface AutoFixCheckOptions {
  readonly lint?: string;
  readonly test?: string;
  readonly timeout: number;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly shellPath?: string;
  readonly commandWrapperArgv?: readonly string[];
  readonly signal?: AbortSignal;
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
}

export interface AutoFixResult {
  readonly hasErrors: boolean;
  readonly lintOutput?: string;
  readonly lintExitCode?: number;
  readonly testOutput?: string;
  readonly testExitCode?: number;
  readonly timedOut?: boolean;
  readonly errorSummary?: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

const OUTPUT_LIMIT_BYTES = 10_000;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8ToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let usedBytes = 0;
  let output = "";
  for (const char of value) {
    const charBytes = byteLength(char);
    if (usedBytes + charBytes > maxBytes) break;
    output += char;
    usedBytes += charBytes;
  }
  return output;
}

function cappedCombinedOutput(stdout: string, stderr: string): string {
  return truncateUtf8ToBytes(`${stdout}\n${stderr}`.trim(), OUTPUT_LIMIT_BYTES);
}

async function runCommand(
  command: string,
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv | undefined,
  shellPath: string | undefined,
  commandWrapperArgv: readonly string[] | undefined,
  sandboxExecutionBroker: SandboxExecutionBrokerLike | undefined,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (sandboxExecutionBroker === undefined) {
    throw missingSandboxExecutionBoundary("hook");
  }
  const shellProgram =
    shellPath ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  const finalCommand = wrapCommandForShell(
    shellProgram,
    commandWrapperArgv,
    command,
  );
  const shellArgs = commandShellArgs(shellProgram, finalCommand);
  const preparedSpawn = sandboxExecutionBroker.prepareSpawn("hook", {
    program: shellProgram,
    args: shellArgs,
    cwd,
    env: scrubEnvForChildProcess(env ?? process.env),
  });
  const result = await runSupervisedProcess(preparedSpawn, {
    timeoutMs: timeout,
    maxOutputBytes: OUTPUT_LIMIT_BYTES * 2,
    ...(signal !== undefined ? { signal } : {}),
  });
  const aborted = result.stopReason === "aborted";
  return {
    stdout: truncateUtf8ToBytes(result.stdout.toString("utf8"), OUTPUT_LIMIT_BYTES),
    stderr: truncateUtf8ToBytes(
      result.stderr.byteLength > 0
        ? result.stderr.toString("utf8")
        : aborted
          ? "Aborted"
          : result.error?.message ?? "",
      OUTPUT_LIMIT_BYTES,
    ),
    exitCode:
      result.stopReason === undefined ? (result.exitCode ?? 1) : 1,
    timedOut: result.stopReason === "timeout",
  };
}

function buildErrorSummary(result: AutoFixResult): string | undefined {
  if (!result.hasErrors) return undefined;
  const parts: string[] = [];

  if (result.timedOut) {
    parts.push("Command timed out.");
  }
  if (result.lintExitCode !== undefined && result.lintExitCode !== 0) {
    parts.push(
      `Lint errors (exit code ${result.lintExitCode}):\n${result.lintOutput ?? ""}`,
    );
  }
  if (result.testExitCode !== undefined && result.testExitCode !== 0) {
    parts.push(
      `Test failures (exit code ${result.testExitCode}):\n${result.testOutput ?? ""}`,
    );
  }

  return parts.join("\n\n");
}

export async function runAutoFixCheck(
  options: AutoFixCheckOptions,
): Promise<AutoFixResult> {
  const {
    lint,
    test,
    timeout,
    cwd,
    env,
    shellPath,
    commandWrapperArgv,
    signal,
    sandboxExecutionBroker,
  } = options;

  if (!lint && !test) {
    return { hasErrors: false };
  }
  if (signal?.aborted) {
    return { hasErrors: false };
  }

  const result: {
    hasErrors: boolean;
    lintOutput?: string;
    lintExitCode?: number;
    testOutput?: string;
    testExitCode?: number;
    timedOut?: boolean;
    errorSummary?: string;
  } = { hasErrors: false };

  if (lint) {
    const lintResult = await runCommand(
      lint,
      cwd,
      timeout,
      env,
      shellPath,
      commandWrapperArgv,
      sandboxExecutionBroker,
      signal,
    );
    result.lintOutput = cappedCombinedOutput(lintResult.stdout, lintResult.stderr);
    result.lintExitCode = lintResult.exitCode;

    if (lintResult.timedOut) {
      result.hasErrors = true;
      result.timedOut = true;
      result.errorSummary = buildErrorSummary(result);
      return result;
    }
    if (lintResult.exitCode !== 0) {
      result.hasErrors = true;
      result.errorSummary = buildErrorSummary(result);
      return result;
    }
  }

  if (test) {
    const testResult = await runCommand(
      test,
      cwd,
      timeout,
      env,
      shellPath,
      commandWrapperArgv,
      sandboxExecutionBroker,
      signal,
    );
    result.testOutput = cappedCombinedOutput(testResult.stdout, testResult.stderr);
    result.testExitCode = testResult.exitCode;

    if (testResult.timedOut) {
      result.hasErrors = true;
      result.timedOut = true;
    } else if (testResult.exitCode !== 0) {
      result.hasErrors = true;
    }
  }

  result.errorSummary = buildErrorSummary(result);
  return result;
}

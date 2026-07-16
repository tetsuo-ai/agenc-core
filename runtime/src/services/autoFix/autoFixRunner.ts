/**
 * Ports the donor auto-fix command runner onto AgenC process
 * primitives.
 *
 * Why this lives here / shape difference from upstream:
 *   - The control flow is intentionally kept close to the donor
 *     service: lint runs first, test runs only after lint succeeds,
 *     command output is capped, and timeout/abort both terminate the
 *     spawned command tree.
 *
 * Cross-cuts deliberately NOT carried:
 *   - None. This file is the process runner for the live service.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../../sandbox/execution-broker.js";
import { scrubEnvForChildProcess } from "../../unified-exec/scrub-env.js";

export interface AutoFixCheckOptions {
  readonly lint?: string;
  readonly test?: string;
  readonly timeout: number;
  readonly cwd: string;
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
const FORCE_KILL_GRACE_MS = 250;

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

function appendCapped(current: string, next: string): string {
  const remainingBytes = OUTPUT_LIMIT_BYTES - byteLength(current);
  if (remainingBytes <= 0) return current;
  return current + truncateUtf8ToBytes(next, remainingBytes);
}

async function runCommand(
  command: string,
  cwd: string,
  timeout: number,
  sandboxExecutionBroker: SandboxExecutionBrokerLike | undefined,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (sandboxExecutionBroker === undefined) {
    throw missingSandboxExecutionBoundary("hook");
  }
  const isWindows = process.platform === "win32";
  const shellProgram = isWindows
    ? process.env.ComSpec ?? "cmd.exe"
    : process.env.SHELL ?? "/bin/sh";
  const shellArgs = isWindows
    ? ["/d", "/s", "/c", command]
    : ["-c", command];
  const spawnCommand = sandboxExecutionBroker.prepareSpawn("hook", {
    program: shellProgram,
    args: shellArgs,
    cwd,
    env: scrubEnvForChildProcess(process.env),
  });
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "Aborted", exitCode: 1, timedOut: false });
      return;
    }

    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    // Per-stream decoders buffer partial multibyte UTF-8 sequences across chunk
    // boundaries — decoding each raw Buffer chunk independently would emit
    // U+FFFD for a character split across two chunks, garbling lint/test output
    // that is later shown to the model.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const proc = spawn(spawnCommand.program, [...spawnCommand.args], {
      cwd: spawnCommand.cwd,
      env: spawnCommand.env,
      argv0: spawnCommand.argv0,
      windowsHide: true,
      detached: !isWindows,
    });

    const clearForceTimer = (): void => {
      if (forceTimer === undefined) return;
      clearTimeout(forceTimer);
      forceTimer = undefined;
    };

    const settle = (
      result: CommandResult,
      opts: { readonly keepForceKill?: boolean } = {},
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (opts.keepForceKill !== true) clearForceTimer();
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const killTree = (killSignal: NodeJS.Signals): void => {
      try {
        if (isWindows && proc.pid) {
          const killer = spawn(
            "taskkill",
            ["/pid", String(proc.pid), "/T", "/F"],
            {
              windowsHide: true,
              stdio: "ignore",
            },
          );
          killer.unref();
          return;
        }
        if (proc.pid) {
          process.kill(-proc.pid, killSignal);
          return;
        }
        proc.kill(killSignal);
      } catch {
        try {
          proc.kill(killSignal);
        } catch {
          // Process already exited.
        }
      }
    };

    const forceKillSoon = (): void => {
      if (forceTimer !== undefined) return;
      forceTimer = setTimeout(() => {
        forceTimer = undefined;
        killTree("SIGKILL");
      }, FORCE_KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      killTree("SIGTERM");
      forceKillSoon();
      settle({
        stdout,
        stderr: stderr || "Aborted",
        exitCode: 1,
        timedOut: false,
      }, { keepForceKill: true });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (data: Buffer) => {
      stdout = appendCapped(stdout, outDecoder.write(data));
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr = appendCapped(stderr, errDecoder.write(data));
    });

    timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      forceKillSoon();
      settle({
        stdout,
        stderr,
        exitCode: 1,
        timedOut: true,
      }, { keepForceKill: true });
    }, timeout);

    proc.on("close", (code) => {
      clearForceTimer();
      // Flush any final complete character buffered in the decoder.
      const tailOut = outDecoder.end();
      if (tailOut) stdout = appendCapped(stdout, tailOut);
      const tailErr = errDecoder.end();
      if (tailErr) stderr = appendCapped(stderr, tailErr);
      settle({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
      });
    });

    proc.on("error", () => {
      settle({
        stdout,
        stderr: stderr || "Command failed to start",
        exitCode: 1,
        timedOut: false,
      });
    });
  });
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

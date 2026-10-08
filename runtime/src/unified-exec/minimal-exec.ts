/** Unsafe foreground-only floor probe: no process supervision, logs or accounting. */
import { spawn } from "node:child_process";
import { commandShellArgs } from "../utils/shell/commandExecution.js";
import type { ExecCommandRequest, ExecCommandToolOutput } from "./types.js";

export async function minimalExec(
  request: ExecCommandRequest,
  cwd: string,
  shell: string,
  env: Record<string, string>,
): Promise<ExecCommandToolOutput> {
  request.__abortSignal?.throwIfAborted();
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(request.shell ?? shell,
      commandShellArgs(request.shell ?? shell, request.cmd, request.login === true), {
        cwd: request.workdir ?? cwd, env, stdio: ["ignore", "pipe", "pipe"],
        ...(request.__abortSignal ? { signal: request.__abortSignal } : {}),
        ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
      });
    let stdout = "", stderr = "", output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; output += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; output += chunk; });
    child.once("error", reject);
    child.once("close", exitCode => {
      const durationMs = performance.now() - start;
      resolve({ output, stdout, stderr, exitCode, exit_code: exitCode, durationMs,
        wall_time_seconds: durationMs / 1000, timedOut: child.killed && !request.__abortSignal?.aborted,
        truncated: false, original_token_count: 0 });
    });
  });
}

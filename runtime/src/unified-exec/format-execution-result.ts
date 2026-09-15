import type { ExecCommandToolOutput } from "./types.js";
import { approximateTokenCount, maxCharsForTokens, truncateHeadTail } from "./head-tail-buffer.js";

export function createUnifiedExecResult(params: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly processId?: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly maxOutputTokens?: number;
  readonly residualProcessesTerminated?: boolean;
  readonly detached?: {
    readonly pid?: number;
    readonly logPath: string;
  };
}): ExecCommandToolOutput {
  const maxChars = maxCharsForTokens(params.maxOutputTokens);
  const stdout = truncateHeadTail(params.stdout, maxChars);
  const stderr = truncateHeadTail(params.stderr, maxChars);
  const output = [stdout.text, stderr.text]
    .filter((part) => part.length > 0)
    .join("");
  const originalText = `${params.stdout}${params.stderr}`;
  return {
    output,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: params.exitCode,
    exit_code: params.exitCode,
    ...(params.processId !== undefined
      ? { process_id: params.processId, session_id: params.processId }
      : {}),
    durationMs: params.durationMs,
    wall_time_seconds: params.durationMs / 1000,
    timedOut: params.timedOut,
    truncated: stdout.truncated || stderr.truncated,
    original_token_count: approximateTokenCount(originalText),
    ...(params.residualProcessesTerminated === true
      ? { residual_processes_terminated: true }
      : {}),
    ...(params.detached !== undefined
      ? {
          detached: true,
          log_path: params.detached.logPath,
          ...(params.detached.pid !== undefined ? { pid: params.detached.pid } : {}),
        }
      : {}),
  };
}

import type { ExecCommandToolOutput } from "../../unified-exec/index.js";

export function formatUnifiedExecToolContent(
  output: ExecCommandToolOutput,
): string {
  const sections: string[] = [];
  sections.push(`Wall time: ${output.wall_time_seconds.toFixed(4)} seconds`);

  if (output.exitCode !== null) {
    sections.push(`Process exited with code ${output.exitCode}`);
  }

  const sessionId = output.process_id ?? output.session_id;
  if (sessionId !== undefined) {
    sections.push(`Process running with session ID ${sessionId}`);
  }

  sections.push(`Original token count: ${output.original_token_count}`);
  sections.push("Output:");
  sections.push(output.output);
  return sections.join("\n");
}

export function unifiedExecCodeModeResult(
  output: ExecCommandToolOutput,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    wall_time_seconds: output.wall_time_seconds,
    original_token_count: output.original_token_count,
    output: output.output,
  };

  if (output.exitCode !== null) {
    result.exit_code = output.exitCode;
  }

  const sessionId = output.process_id ?? output.session_id;
  if (sessionId !== undefined) {
    result.session_id = sessionId;
  }

  return result;
}

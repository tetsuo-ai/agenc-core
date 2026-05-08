import type { ExecCommandToolOutput } from "../../unified-exec/types.js";

export function formatUnifiedExecToolContent(
  output: ExecCommandToolOutput,
): string {
  // Output FIRST, metadata after. The previous order put a multi-line
  // "Wall time: ... / Process exited with code 0 / Original token count: N
  // / Output:" header BEFORE the actual stdout. Grok (and likely other
  // models) interpreted that prefix as an incomplete/stalled tool result
  // and re-emitted the same tool call repeatedly instead of using the
  // output it already had — see rollout sequence with three identical
  // exec_command calls each returning the same ls listing.
  //
  // Putting the output first lets the model anchor on the real result
  // immediately. The metadata footer stays for log/debug value but no
  // longer leads.
  const sections: string[] = [];
  sections.push(output.output);

  const footerLines: string[] = [];
  if (output.exitCode !== null) {
    footerLines.push(`exit_code=${output.exitCode}`);
  }
  footerLines.push(`wall_time=${output.wall_time_seconds.toFixed(4)}s`);
  footerLines.push(`tokens=${output.original_token_count}`);
  const sessionId = output.process_id ?? output.session_id;
  if (sessionId !== undefined) {
    footerLines.push(`session_id=${sessionId}`);
  }
  // Compact one-line footer separated from output by a blank line so the
  // model sees the two sections distinctly.
  sections.push("");
  sections.push(`[exec ${footerLines.join(" ")}]`);
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

import type { CompletedToolResultRecord } from "../session/turn-state.js";
import type { Tool } from "../tools/types.js";

/**
 * Before a verification request, arbitrary commands invalidate earlier checks.
 * Once the runtime asks for verification, independent command results can
 * accumulate from the captured frontier, as in the normal completion gate.
 * Commands are not proof of an unchanged filesystem: an arbitrary script can
 * mutate it. This is the normal gate's existing limitation, not a read-only
 * classification inferred from shell words, result text or model metadata.
 * Canonical writes and unknown tools still advance the frontier.
 *
 * A completed command can verify its own final state. File writes themselves
 * are not verification. A running command keeps every observation provisional
 * until its terminal poll, even if a read happened after its launch.
 */
export function lightCompletionEvidence(
  results: readonly CompletedToolResultRecord[],
  tools: readonly Pick<Tool, "name" | "metadata">[],
  verificationStart?: number,
): { readonly freshFrom: number; readonly isSuccessful: (result: CompletedToolResultRecord) => boolean } {
  const canonical = new Map(tools.map((tool) => [tool.name, tool]));
  const successful = new Set<CompletedToolResultRecord>();
  const running = new Set<number>();
  let untrackedRunning = false;
  let freshFrom = verificationStart === undefined ? 0
    : Math.max(0, Math.min(results.length, verificationStart));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    const tool = canonical.get(result.toolName);
    const builtin = tool?.metadata?.source === "builtin";
    const shell = builtin && (tool.name === "exec_command" ||
      tool.name === "write_stdin" || tool.name === "system.bash");
    const readOnly = builtin && tool.metadata?.mutating === false;
    // TodoWrite updates only the task list. Do not generalize this exemption
    // to virtualNoFsWrites: spawn/wait tools can supervise child file writes.
    const bookkeeping = builtin && tool.name === "TodoWrite" &&
      tool.metadata?.virtualNoFsWrites === true;
    const exitCode = result.metadata?.exitCode;
    const passed = !result.isError && (exitCode === undefined || exitCode === 0);
    if (shell) {
      const sessionId = result.metadata?.sessionId;
      if (exitCode === null && !result.isError) {
        if (typeof sessionId === "number") running.add(sessionId);
        else untrackedRunning = true;
      } else if ((typeof exitCode === "number" || exitCode === null) &&
          typeof sessionId === "number") {
        running.delete(sessionId);
      }
      // A terminal shell observation, unlike a write acknowledgement, can
      // itself be the relevant check. Never infer success from output words.
      const terminalSuccess = passed && exitCode === 0;
      if (verificationStart === undefined) freshFrom = terminalSuccess ? index : index + 1;
      if (terminalSuccess) successful.add(result);
    } else if (readOnly) {
      if (passed) successful.add(result);
    } else if (!bookkeeping) {
      freshFrom = Math.max(freshFrom, index + 1);
    }
  }
  if (running.size > 0 || untrackedRunning) freshFrom = results.length;
  const fresh = new Set(results.slice(freshFrom).filter((result) => successful.has(result)));
  return { freshFrom, isSuccessful: (result) => fresh.has(result) };
}

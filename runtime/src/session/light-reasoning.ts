import type { ReasoningEffort } from "./turn-context.js";
import type { CompletedToolResultRecord } from "./turn-state.js";
import type { LLMMessage } from "../llm/types.js";

/** Recovery effort belongs to the latest tool batch, not the rest of a turn. */
export function lastToolBatchResults(
  messages: ReadonlyArray<LLMMessage>,
  results: ReadonlyArray<CompletedToolResultRecord>,
): ReadonlyArray<CompletedToolResultRecord> {
  const assistant = messages.findLast(message => message.role === "assistant");
  const ids = new Set(assistant?.toolCalls?.map(call => call.id) ?? []);
  return results.filter(result => ids.has(result.callId));
}

/** Only completed validation failures justify spending more reasoning. */
function failedCheck(result: CompletedToolResultRecord): boolean {
  if (!result.isError || !["exec_command", "system.bash", "write_stdin"].includes(result.toolName)) return false;
  const exit = result.metadata?.exitCode;
  if (typeof exit !== "number" || exit <= 0) return false;
  let args: { cmd?: unknown; command?: unknown };
  try { args = JSON.parse(result.arguments) as typeof args; } catch { return false; }
  const command = args.cmd ?? args.command;
  if (typeof command !== "string") return false;
  // A failed search, missing executable or permission refusal is not a check.
  if (exit === 126 || exit === 127 || /(?:ModuleNotFoundError|No module named|command not found)/.test(result.content)) return false;
  return /(?:^|[;&|\n]\s*|\s)(?:pytest|vitest|jest|tsc|cargo\s+(?:test|check)|go\s+test|python\d?\s+-m\s+(?:pytest|unittest|py_compile|compileall)|(?:sh|bash|dash)\s+-n|node\s+--check|git\s+diff\s+--check|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|lint|build)(?:[:\w-]*))(?=\s|$)/.test(command)
    || /(?:^|\s)python\d?(?=\s)/.test(command)
      && /(?:AssertionError|SyntaxError|IndentationError):/.test(result.content);
}

/** The policy changes a request option, never the cached prompt or history. */
export function lightReasoningEffort(
  enabled: boolean,
  requested: ReasoningEffort | undefined,
  supported: ReadonlyArray<ReasoningEffort> | undefined,
  results: ReadonlyArray<CompletedToolResultRecord>,
): ReasoningEffort | undefined {
  if (!enabled || requested !== "low" || !supported?.includes("medium")) return undefined;
  return results.some(failedCheck) ? "medium" : "low";
}

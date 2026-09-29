import type { ReasoningEffort } from "./turn-context.js";
import type { CompletedToolResultRecord } from "./turn-state.js";

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
  if (exit === 126 || exit === 127) return false;
  return /(?:^|[;&|\n]\s*|\s)(?:pytest|vitest|jest|tsc|cargo\s+(?:test|check)|go\s+test|python\d?\s+-m\s+(?:pytest|unittest)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|lint|build)(?:[:\w-]*))(?=\s|$)/.test(command);
}

/** The policy changes a request option, never the cached prompt or history. */
export function lightReasoningEffort(
  enabled: boolean,
  requested: ReasoningEffort | undefined,
  supported: ReadonlyArray<ReasoningEffort> | undefined,
  results: ReadonlyArray<CompletedToolResultRecord>,
): ReasoningEffort | undefined {
  if (!enabled || requested === "none" || !supported?.includes("low")) return undefined;
  if (!results.some(failedCheck)) return "low";
  return supported.includes("high") ? "high" : supported.includes("medium") ? "medium" : "low";
}

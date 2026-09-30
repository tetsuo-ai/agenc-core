import type { LLMChatOptions } from "../llm/types.js";
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  SYSTEM_PROMPT_VOLATILE_BOUNDARY,
} from "./system-prompt-boundary.js";

/** Only user-facing prose changes; execution and required reporting do not. */
export function getResponseDetailSection(level: LLMChatOptions["modelVerbosity"] | null): string | null {
  if (level == null) return null;
  const amount = level === "low"
    ? "Keep user-facing progress and final explanations brief."
    : level === "medium"
      ? "Give a balanced amount of explanation in user-facing progress and final messages."
      : "Give more explanation and useful context in user-facing progress and final messages.";
  return `# Response Detail\n${amount} Always report required checks and test results, errors, blockers, and approval requests.`;
}

/** Add a fallback to the volatile tail for routes selected after prompt assembly. */
export function withResponseDetailSystemPrompt(
  prompt: string | undefined,
  level: LLMChatOptions["modelVerbosity"] | null,
): string | undefined {
  const section = getResponseDetailSection(level);
  if (section === null) return prompt;
  if (prompt?.includes("# Response Detail\n")) return prompt;
  const base = prompt?.trim() ?? "";
  const outputStyle = base.indexOf("# Output Style:");
  if (outputStyle !== -1 && base.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) {
    const afterStyle = base.slice(outputStyle);
    const nextSection = /\n\n(?=# |<!-- volatile-boundary -->)/u.exec(afterStyle);
    const insertion = nextSection === null ? base.length : outputStyle + nextSection.index;
    return `${base.slice(0, insertion)}\n\n${section}${base.slice(insertion)}`;
  }
  if (base.includes(SYSTEM_PROMPT_VOLATILE_BOUNDARY)) return `${base}\n\n${section}`;
  if (base.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) return `${base}\n\n${section}`;
  return base.length > 0
    ? `${base}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${section}`
    : `${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${section}`;
}

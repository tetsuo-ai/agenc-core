// Cherry-picked from openclaude src/components/PromptInput/inputModes.ts.
// Only the helpers consumed by the wholesale-ported search hooks are
// reproduced here (getModeFromInput) plus the HistoryMode alias.

import type { PromptInputMode } from "../../types/textInputTypes.js";

export type HistoryMode = PromptInputMode;

export function getModeFromInput(input: string): HistoryMode {
  if (input.startsWith("!")) {
    return "bash";
  }
  return "prompt";
}

export function getValueFromInput(input: string): string {
  const mode = getModeFromInput(input);
  if (mode === "prompt") {
    return input;
  }
  return input.slice(1);
}

export function isInputModeCharacter(input: string): boolean {
  return input === "!" || input === "/";
}

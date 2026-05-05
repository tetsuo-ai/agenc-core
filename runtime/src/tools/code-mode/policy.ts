import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from "./types.js";

const CODE_MODE_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.searchTools",
]);

export function isCodeModeNestedToolName(toolName: string): boolean {
  return (
    toolName !== CODE_MODE_EXEC_TOOL_NAME &&
    toolName !== CODE_MODE_WAIT_TOOL_NAME &&
    !CODE_MODE_CONTROL_TOOL_NAMES.has(toolName)
  );
}

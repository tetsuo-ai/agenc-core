import type { ToolResult } from "./types.js";

export function plainTextErrorToolResult(message: string): ToolResult {
  return { content: message, isError: true };
}

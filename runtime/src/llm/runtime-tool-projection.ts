import type { LLMTool } from "./types.js";

export type RuntimeTool = LLMTool & {
  readonly name: string;
  readonly description: string;
  readonly inputJSONSchema: Record<string, unknown>;
  readonly isMcp: boolean;
  readonly maxResultSizeChars: number;
};

export function toRuntimeTools(
  tools: readonly LLMTool[],
  maxResultSizeChars: number,
): RuntimeTool[] {
  return tools.map((tool) => {
    const name = tool.function.name;
    return {
      ...tool,
      name,
      description: tool.function.description,
      inputJSONSchema: tool.function.parameters,
      isMcp: name.startsWith("mcp__"),
      maxResultSizeChars,
    };
  });
}

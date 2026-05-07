import type { Tool } from "../types.js";
import type { CodingToolConfig } from "./coding-common.js";
import { createGitAndRepoTools } from "./git-tools.js";
import { createSymbolTools } from "./symbol-tools.js";
import { createToolSearchTool } from "./tool-search.js";

export { SESSION_ADVERTISED_TOOL_NAMES_ARG } from "./coding-common.js";
export type { CodingToolConfig } from "./coding-common.js";

export function createCodingTools(config: CodingToolConfig): readonly Tool[] {
  const tools: Tool[] = [];
  if (config.codeIntelligenceTools === true) {
    tools.push(...createGitAndRepoTools(config), ...createSymbolTools(config));
  }
  tools.push(createToolSearchTool(config));
  return tools;
}

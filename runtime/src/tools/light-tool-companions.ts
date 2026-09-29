import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { Tool } from "./types.js";

/** A live canonical shell session makes its continuation tool useful immediately. */
export function loadLightToolCompanions(input: {
  readonly lightMode: boolean;
  readonly tool: Tool | undefined;
  readonly result: ToolDispatchResult;
  readonly registry: ToolRegistry;
}): void {
  const { tool, result, registry } = input;
  if (!input.lightMode || tool?.name !== "exec_command" ||
      tool.metadata?.source !== "builtin" || result.isError === true ||
      result.metadata?.exitCode !== null) return;
  const sessionId = result.metadata.sessionId;
  if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId) || sessionId <= 0) return;
  const companion = registry.tools.find(candidate => candidate.name === "write_stdin");
  if (companion?.metadata?.source !== "builtin" ||
      registry.getUnavailableToolNames?.().has(companion.name)) return;
  registry.discoverToolNames?.([companion.name]);
}

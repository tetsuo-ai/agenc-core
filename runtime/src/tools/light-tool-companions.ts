import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { Tool } from "./types.js";

/** Load an execution companion from a canonical result, without a discovery turn. */
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
  // Child registries expose only their eligible implementations here, and own
  // their discovery set. Never reach through to the parent's registry or add
  // an unavailable/disabled tool. Discovery cannot grant execution permission.
  const companion = registry.tools.find((candidate) => candidate.name === "write_stdin");
  if (companion?.metadata?.source !== "builtin" ||
      registry.getUnavailableToolNames?.().has(companion.name)) return;
  registry.discoverToolNames?.([companion.name]);
}

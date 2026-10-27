import type { Tool } from "./types.js";

// Authority belongs to a reviewed implementation, never a model argument,
// name, MCP readOnlyHint, recoveryCategory, or user-supplied tool metadata.
const implementations = new WeakSet<Tool["execute"]>();

/** Only built-in implementations that cannot mutate external state opt in. */
export function sideEffectFreeTool<T extends Tool>(tool: T): T {
  implementations.add(tool.execute);
  return tool;
}

export function toolIsSideEffectFree(tool: Tool): boolean {
  return implementations.has(tool.execute) && tool.metadata?.source === "builtin" &&
    tool.metadata.mutating === false && tool.isReadOnly === true &&
    tool.recoveryCategory === "idempotent" && tool.requiresUserInteraction?.() !== true;
}

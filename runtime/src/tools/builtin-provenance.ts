import type { Tool } from "./types.js";

const builtinImplementations = new WeakMap<object, string>();

export function registerBuiltinTool<ToolType extends Tool>(tool: ToolType): ToolType {
  builtinImplementations.set(tool.execute, tool.name);
  return tool;
}

export function hasTrustedBuiltinImplementation(tool: { readonly name: string; readonly execute?: unknown }): boolean {
  return typeof tool.execute === "function" && builtinImplementations.get(tool.execute) === tool.name;
}

export function inheritBuiltinToolProvenance(original: Tool, wrapped: Tool): Tool {
  return hasTrustedBuiltinImplementation(original) ? registerBuiltinTool(wrapped) : wrapped;
}

import type { Tool } from "../types.js";
import { resolveRuntimePathTarget } from "./paths.js";

const UNIFIED_EXEC_RUNTIME_TOOL_NAMES = new Set([
  "exec_command",
  "system.bash",
]);

export interface UnifiedExecRuntimeCommand {
  readonly command: string | undefined;
  readonly cwd: string;
}

export function isUnifiedExecRuntimeTool(tool: Tool | string): boolean {
  const name = typeof tool === "string" ? tool : tool.name;
  return UNIFIED_EXEC_RUNTIME_TOOL_NAMES.has(name);
}

export function unifiedExecRuntimeCommand(
  args: Record<string, unknown>,
  cwd: string,
): UnifiedExecRuntimeCommand {
  return {
    command: shellCommand(args),
    cwd: shellWorkingDirectory(args, cwd),
  };
}

function shellCommand(args: Record<string, unknown>): string | undefined {
  return typeof args["cmd"] === "string"
    ? args["cmd"]
    : typeof args["command"] === "string"
      ? args["command"]
      : typeof args["chars"] === "string"
        ? args["chars"]
        : undefined;
}

function shellWorkingDirectory(
  args: Record<string, unknown>,
  cwd: string,
): string {
  return typeof args["workdir"] === "string"
    ? resolveRuntimePathTarget(args["workdir"], cwd)
    : typeof args["cwd"] === "string"
      ? resolveRuntimePathTarget(args["cwd"], cwd)
      : cwd;
}

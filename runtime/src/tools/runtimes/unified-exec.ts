import type { Tool } from "../types.js";
import { resolveRuntimePathTarget } from "./paths.js";

/**
 * Tools that run a model-written shell command through unified exec. The
 * runtime sandbox analyses their command (write targets, read targets,
 * read-only inspection) and defers an indeterminate command only to the
 * platform sandbox. `Monitor` runs its `command` exactly like exec_command
 * runs `cmd` (tools/system/monitor.ts: unified exec, platform sandbox from
 * the same runtime context); without its name here a Monitor call had no
 * analysable write target and was refused before it could start.
 */
const UNIFIED_EXEC_RUNTIME_TOOL_NAMES = new Set([
  "exec_command",
  "system.bash",
  "Monitor",
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
  toolName?: string,
): UnifiedExecRuntimeCommand {
  if (toolName === "Monitor") {
    // Monitor executes only `command`, in the workspace it was built for: it
    // has no working-directory argument and ignores any other key. Read the
    // same, so a stray `cmd` or `workdir` cannot change what is analysed.
    return {
      command: typeof args["command"] === "string" ? args["command"] : undefined,
      cwd,
    };
  }
  return {
    command: shellCommand(args),
    cwd: shellWorkingDirectory(args, cwd),
  };
}

/**
 * The arguments the read-only inspection sees for a unified-exec tool: the
 * tool's own spelling of the command it will run. Monitor contributes its
 * command alone, so an argument it never executes cannot steer inspection.
 */
export function unifiedExecInspectionArgs(
  toolName: string,
  args: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  if (toolName === "Monitor") return { command };
  return { ...args, ...(toolName === "exec_command" ? { cmd: command } : { command }) };
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

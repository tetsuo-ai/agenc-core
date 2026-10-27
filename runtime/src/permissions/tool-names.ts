/** Tool spellings removed from live dispatch and hooks. */
const REMOVED_LIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "WebFetch",
  "Brief",
  "Read",
  "FileReadTool",
  "FileEdit",
  "FileEditTool",
  "FileWrite",
  "FileWriteTool",
  "system.grep",
  "system.glob",
  "Bash",
  "bash",
  "desktop.bash",
  "shell",
  "Task",
  "KillShell",
  "AgentOutputTool",
  "BashOutputTool",
]);

export function isRemovedLiveToolName(name: string): boolean {
  return REMOVED_LIVE_TOOL_NAMES.has(name);
}

/** Retain legacy Bash restrictions without reviving dispatch or old grants. */
export function permissionRuleToolName(name: string, behavior: string): string {
  return name === "Bash" && (behavior === "deny" || behavior === "ask")
    ? "exec_command"
    : name;
}

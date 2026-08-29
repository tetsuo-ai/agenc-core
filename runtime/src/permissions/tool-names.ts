/** Tool spellings removed from live dispatch, hooks, and permission rules. */
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

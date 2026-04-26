/**
 * System tools for @tetsuo-ai/runtime — lean coding CLI surface.
 *
 * Post-gut: only the coding-profile tools survive. pdf/office/sqlite/
 * calendar/browser/process/server/sandbox/remote-job/remote-session/
 * research/task-tracker families were removed.
 *
 * @module
 */

export {
  createHttpTools,
  isDomainAllowed,
  type HttpToolConfig,
  type HttpResponse,
} from "./http.js";

export {
  createFilesystemTools,
  isPathAllowed,
  recordSessionRead,
  hasSessionRead,
  resolveSessionId,
  safePath,
  type FilesystemToolConfig,
} from "./filesystem.js";

export {
  createCodingTools,
  SESSION_ADVERTISED_TOOL_NAMES_ARG,
  type CodingToolConfig,
} from "./coding.js";

export {
  createPlanningTools,
  type PlanningToolOptions,
  type WorkflowToolController,
} from "./planning.js";

export {
  createBashTool,
  isCommandAllowed,
  validateShellCommand,
} from "./bash.js";

export {
  createExecCommandTool,
  type ExecCommandToolConfig,
} from "./exec-command.js";

export {
  createWriteStdinTool,
  type WriteStdinToolConfig,
} from "./write-stdin.js";

export { createSleepTool } from "./sleep.js";

export {
  createMonitorTool,
  type MonitorToolConfig,
} from "./monitor.js";

export {
  createEnterWorktreeTool,
  createExitWorktreeTool,
  type WorktreeToolConfig,
} from "./worktree.js";

// Openclaude-derived file/search tools (lifted into AgenC; free to modify).
// These are the canonical first-class file/search surface.
export {
  createFileReadTool,
  FILE_READ_TOOL_NAME,
  type FileReadToolConfig,
} from "./file-read.js";

export {
  createFileEditTool,
  FILE_EDIT_TOOL_NAME,
  type FileEditToolConfig,
} from "./file-edit.js";

export {
  createFileWriteTool,
  FILE_WRITE_TOOL_NAME,
  type FileWriteToolConfig,
} from "./file-write.js";

export {
  createGlobTool,
  GLOB_TOOL_NAME,
  type GlobToolConfig,
} from "./glob.js";

export {
  createGrepTool,
  GREP_TOOL_NAME,
  type GrepToolConfig,
} from "./grep.js";

export {
  type BashToolConfig,
  type BashToolInput,
  type BashExecutionResult,
  type DangerousShellPattern,
  DEFAULT_DENY_LIST,
  DEFAULT_DENY_PREFIXES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DANGEROUS_SHELL_PATTERNS,
} from "./types.js";

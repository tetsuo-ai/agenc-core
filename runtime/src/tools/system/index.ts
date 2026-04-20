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
  createBashTool,
  isCommandAllowed,
  validateShellCommand,
} from "./bash.js";

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

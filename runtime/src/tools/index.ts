/**
 * Tool system for @tetsuo-ai/runtime.
 *
 * Post-gut: the `agenc.*` protocol tools and `skill-adapter` were
 * deleted. Only the core tool abstractions + system tools (bash,
 * filesystem, http, coding) survive here.
 *
 * @module
 */

export {
  type Tool,
  type ToolCatalogEntry,
  type ToolMetadata,
  type ToolSource,
  type ToolResult,
  type ToolContext,
  type ToolRegistryConfig,
  type JSONSchema,
  bigintReplacer,
  safeStringify,
} from "./types.js";

export {
  ToolNotFoundError,
  ToolAlreadyRegisteredError,
  ToolExecutionError,
} from "./errors.js";

export { ToolRegistry } from "./registry.js";

export {
  createHttpTools,
  isDomainAllowed,
  type HttpToolConfig,
  type HttpResponse,
  createFilesystemTools,
  createCodingTools,
  isPathAllowed,
  safePath,
  type FilesystemToolConfig,
  type CodingToolConfig,
  createBashTool,
  isCommandAllowed,
  validateShellCommand,
  type BashToolConfig,
  type BashToolInput,
  type BashExecutionResult,
  type DangerousShellPattern,
  DEFAULT_DENY_LIST,
  DEFAULT_DENY_PREFIXES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DANGEROUS_SHELL_PATTERNS,
} from "./system/index.js";

/**
 * `Grep` — AgenC-owned ripgrep wrapper.
 *
 * Description text and input schema track the donor Grep contract for
 * AgenC's first-class search surface.
 *
 * - Invokes the lockfile-pinned ripgrep binary as a subprocess.
 * - Three output modes: `content`, `files_with_matches` (default), `count`.
 * - Honors AgenC's `safePath` + `resolveToolAllowedPaths` for the optional
 *   `path` arg so search is bounded to the workspace allowlist.
 * - Fails closed when that packaged executable is unavailable. Model input
 *   never reaches a synchronous JavaScript content regular expression.
 *
 * @module
 */

import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { performance } from "node:perf_hooks";

import ignore from "ignore";

import { scrubEnvForChildProcess } from "../../unified-exec/scrub-env.js";
import {
  beginWorkspaceReadToolOperation,
  captureWorkspaceAuthoritativeDirtySnapshots,
  endWorkspaceToolOperation,
  workspaceAuthoritativeDirtySnapshots,
  type WorkspaceAuthoritativeDirtySnapshot,
  type WorkspaceToolOperationToken,
} from "../../workspace/mutation-coordinator.js";
import {
  runSupervisedProcess,
  type SupervisedProcessStopReason,
} from "../../utils/supervisedProcess.js";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { plainTextErrorToolResult as errorResult } from "../results.js";
import {
  applyRuntimeSandboxToSpawn,
  type SandboxSpawnCommand,
} from "./apply-runtime-sandbox.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";
import { selectPinnedRipgrepPath } from "./pinned-ripgrep.js";
import {
  materializeRipgrepIgnoreFiles,
  readVerifiedRipgrepIgnoreFile,
  type MaterializedRipgrepIgnoreFiles,
  type RipgrepIgnoreFileSnapshot,
} from "./ripgrep-ignore-snapshot.js";
import {
  assertGrepArgumentEncoding,
  assertGrepArgvWithinLimits,
  createRipgrepWireParser,
  createRipgrepWireValidator,
  decodeRipgrepPathBytes,
  GrepBoundaryError,
  MAX_GREP_CONTEXT_LINES,
  MAX_GREP_DECODED_BYTES,
  MAX_GREP_DIAGNOSTIC_BYTES,
  MAX_GREP_GLOBS,
  MAX_GREP_GLOB_UTF8_BYTES,
  MAX_GREP_HEAD_LIMIT,
  MAX_GREP_OFFSET,
  MAX_GREP_PATTERN_UTF8_BYTES,
  MAX_GREP_RAW_GLOB_UTF8_BYTES,
  MAX_GREP_RAW_PATH_UTF8_BYTES,
  MAX_GREP_RECORD_BYTES,
  MAX_GREP_RENDERED_BYTES,
  MAX_GREP_RESULTS,
  MAX_GREP_TYPE_UTF8_BYTES,
  MAX_GREP_WALL_MS,
  renderRipgrepContentBytes,
  renderRipgrepPathBytes,
  type GrepBoundaryReason,
  type RipgrepContentRecord,
  type RipgrepCountRecord,
  type RipgrepOutputRecord,
  type RipgrepWireParser,
} from "./ripgrep-protocol.js";
import {
  bindWorkspaceDirectoryReadCapability,
  bindWorkspaceFileReadCapability,
  type WorkspaceBoundReadCapability,
  type WorkspaceBoundReadIdentity,
} from "../../workspace/file-mutation-transaction.js";

export const GREP_TOOL_NAME = "Grep";

const BASH_TOOL_NAME = "Bash";
const AGENT_TOOL_NAME = "spawn_agent";

const VCS_DIRECTORIES_TO_EXCLUDE = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
] as const;

/**
 * Generated/build/vendored/ledger directories excluded from a Grep walk BY
 * DEFAULT, on top of `.gitignore` (which ripgrep already honors). Searching
 * these surfaces noise and can be pathological on a large repo (e.g. a multi-GB
 * `.localnet/` validator log). `includeIgnored: true` restores `--no-ignore`
 * and drops these excludes for a power-user search of build output.
 */
const DEFAULT_GENERATED_DIRECTORIES_TO_EXCLUDE = [
  "node_modules",
  "target",
  "dist",
  "build",
  ".localnet",
] as const;

const DEFAULT_HEAD_LIMIT = 250;
const RIPGREP_PROBE_TIMEOUT_MS = 5_000;
const MAX_RENDERED_CONTENT_LINE_CHARS = 500;
const BYTE_CARRIAGE_RETURN = 0x0d;
const BYTE_LINE_FEED = 0x0a;
const SEARCH_IGNORE_FILES = [".gitignore", ".ignore", ".rgignore"] as const;
const MAX_SEARCH_IGNORE_FILE_BYTES = 1_048_576;
const MAX_SEARCH_IGNORE_TOTAL_BYTES = 4_194_304;
const MAX_SEARCH_IGNORE_DIRECTORIES = 256;
const RIPGREP_PROBE_MAX_OUTPUT_BYTES = 262_144;
const MAX_PROTECTED_RIPGREP_CONCURRENCY = 8;
const CANDIDATE_SPOOL_READ_BYTES = 65_536;
const MAX_GREP_PATH_ORACLE_ENTRIES = MAX_GREP_RESULTS;
const MAX_GREP_PATH_ORACLE_UTF8_BYTES = MAX_GREP_DECODED_BYTES;
const WINDOWS_RESERVED_PATH_SEGMENT =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const WINDOWS_INVALID_PATH_SEGMENT = /[<>:"|?*\u0000-\u001f]/u;
const RIPGREP_WIRE_MAX_OUTPUT_BYTES =
  MAX_GREP_DECODED_BYTES * 2 + MAX_GREP_DIAGNOSTIC_BYTES;
const PINNED_RIPGREP_UNAVAILABLE_MESSAGE =
  "Grep error [PINNED_RIPGREP_UNAVAILABLE]: AgenC's pinned ripgrep executable is missing or not executable. Run `agenc doctor`, then reinstall the same AgenC version; a PATH-resolved `rg` and JavaScript fallback are never used.";

interface GrepOperationDeadline {
  readonly expiresAt: number;
}

function createGrepOperationDeadline(): GrepOperationDeadline {
  return { expiresAt: performance.now() + MAX_GREP_WALL_MS };
}

function remainingGrepOperationMs(deadline: GrepOperationDeadline): number {
  return Math.max(0, Math.ceil(deadline.expiresAt - performance.now()));
}

function operationTimedOutResult(): LimitedRipgrepResult {
  return {
    ...emptyLimitedRipgrepResult(),
    stopReason: "timeout",
  };
}

/** Verbatim adaptation of the donor Grep prompt. */
const GREP_DESCRIPTION = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
  - Requires AgenC's packaged, lockfile-pinned ripgrep executable. If it is unavailable, run \`agenc doctor\` and reinstall the same AgenC version; Grep never falls back to JavaScript regex search or a PATH-resolved \`rg\`.
`;

type OutputMode = "content" | "files_with_matches" | "count";

interface GrepInput extends ToolExecutionInjectedArgs {
  readonly pattern?: unknown;
  readonly path?: unknown;
  readonly cwd?: unknown;
  readonly glob?: unknown;
  readonly type?: unknown;
  readonly output_mode?: unknown;
  readonly "-B"?: unknown;
  readonly "-A"?: unknown;
  readonly "-C"?: unknown;
  readonly context?: unknown;
  readonly "-n"?: unknown;
  readonly "-i"?: unknown;
  readonly head_limit?: unknown;
  readonly offset?: unknown;
  readonly multiline?: unknown;
  readonly includeIgnored?: unknown;
}

export interface GrepToolConfig {
  /** Allowed path prefixes (mirrors `FilesystemToolConfig.allowedPaths`). */
  readonly allowedPaths: readonly string[];
  /** Deterministic test seam for a revision change immediately before return. */
  readonly beforeAuthoritativeSnapshotValidation?: () => void | Promise<void>;
  /** Deterministic test seam immediately after the final path check. */
  readonly __testAfterFinalPathCheck?: () => void | Promise<void>;
  /** Deterministic observer for protected ripgrep scheduling tests. */
  readonly __testProtectedTaskObserver?: (event: {
    readonly phase: "start" | "finish";
    readonly source: "disk" | "snapshot";
    readonly index: number;
  }) => void;
  /** Test-only aggregate ceilings for multi-source protected searches. */
  readonly __testOperationBudgetLimits?: Partial<GrepOperationBudgetLimits>;
  /** Deterministic test seam after root ignore bytes have been snapshotted. */
  readonly __testAfterRootIgnoreSnapshot?: () => void | Promise<void>;
}

function textResult(content: string): ToolResult {
  return { content };
}

function editorCoherenceError(error?: unknown): ToolResult {
  const detail =
    error === undefined
      ? "an Editor buffer changed while the search was running"
      : error instanceof Error
        ? error.message
        : String(error);
  return errorResult(
    `Grep error: authoritative Editor workspace contents are unavailable: ${detail}. Retry after Editor synchronization settles.`,
  );
}

interface NormalizedGrepInput {
  readonly pattern: string;
  readonly explicitPath?: string;
  readonly outputMode: OutputMode;
  readonly caseInsensitive: boolean;
  readonly showLineNumbers: boolean;
  readonly multiline: boolean;
  readonly includeIgnored: boolean;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly contextBoth?: number;
  readonly type?: string;
  readonly rawGlob?: string;
  readonly globs: readonly string[];
  readonly headLimit: number;
  readonly offset: number;
}

function optionalString(
  value: unknown,
  label: string,
): string | undefined | { readonly error: string } {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return { error: `${label} must be a string` };
  if (value.length === 0) return undefined;
  try {
    assertGrepArgumentEncoding(value, label);
  } catch (error) {
    return { error: formatBoundaryError(error) };
  }
  return value;
}

function normalizedBoolean(
  value: unknown,
  label: string,
  defaultValue: boolean,
): boolean | { readonly error: string } {
  if (value === undefined || value === null) return defaultValue;
  return typeof value === "boolean"
    ? value
    : { error: `${label} must be a boolean` };
}

function boundedInteger(
  value: unknown,
  label: string,
  maximum: number,
  defaultValue?: number,
): number | undefined | { readonly error: string } {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return { error: `${label} must be a non-negative safe integer` };
  }
  if ((value as number) > maximum) {
    return { error: `${label} exceeds the maximum ${maximum}` };
  }
  return value as number;
}

function normalizeOutputMode(value: unknown): OutputMode | { error: string } {
  if (value === undefined || value === null) return "files_with_matches";
  if (typeof value !== "string") {
    return { error: "output_mode must be a string" };
  }
  const trimmed = value.trim();
  if (
    trimmed === "content" ||
    trimmed === "files_with_matches" ||
    trimmed === "count"
  ) {
    return trimmed;
  }
  return {
    error:
      "output_mode must be one of 'content', 'files_with_matches', or 'count'",
  };
}

function normalizeGrepInput(
  args: GrepInput,
): NormalizedGrepInput | { readonly error: string } {
  if (typeof args.pattern !== "string" || args.pattern.length === 0) {
    return { error: "pattern must be a non-empty string" };
  }
  try {
    assertGrepArgumentEncoding(args.pattern, "pattern");
  } catch (error) {
    return { error: formatBoundaryError(error) };
  }
  const patternBytes = Buffer.byteLength(args.pattern, "utf8");
  if (patternBytes > MAX_GREP_PATTERN_UTF8_BYTES) {
    return {
      error: `pattern is ${patternBytes} UTF-8 bytes; maximum is ${MAX_GREP_PATTERN_UTF8_BYTES}`,
    };
  }

  const outputMode = normalizeOutputMode(args.output_mode);
  if (typeof outputMode !== "string") return outputMode;
  const path = optionalString(args.path, "path");
  if (typeof path === "object") return path;
  const cwd = optionalString(args.cwd, "cwd");
  if (typeof cwd === "object") return cwd;
  const explicitPath = path ?? cwd;
  if (explicitPath !== undefined) {
    const pathBytes = Buffer.byteLength(explicitPath, "utf8");
    if (pathBytes > MAX_GREP_RAW_PATH_UTF8_BYTES) {
      return {
        error: `path is ${pathBytes} UTF-8 bytes; maximum is ${MAX_GREP_RAW_PATH_UTF8_BYTES}`,
      };
    }
  }

  const rawGlob = optionalString(args.glob, "glob");
  if (typeof rawGlob === "object") return rawGlob;
  if (rawGlob !== undefined) {
    const rawGlobBytes = Buffer.byteLength(rawGlob, "utf8");
    if (rawGlobBytes > MAX_GREP_RAW_GLOB_UTF8_BYTES) {
      return {
        error: `glob is ${rawGlobBytes} UTF-8 bytes; maximum is ${MAX_GREP_RAW_GLOB_UTF8_BYTES}`,
      };
    }
  }
  const globs = rawGlob === undefined ? [] : splitGlobs(rawGlob);
  if (globs.length > MAX_GREP_GLOBS) {
    return { error: `glob expands to more than ${MAX_GREP_GLOBS} entries` };
  }
  for (const [index, glob] of globs.entries()) {
    const globBytes = Buffer.byteLength(glob, "utf8");
    if (globBytes > MAX_GREP_GLOB_UTF8_BYTES) {
      return {
        error: `glob entry ${index + 1} is ${globBytes} UTF-8 bytes; maximum is ${MAX_GREP_GLOB_UTF8_BYTES}`,
      };
    }
  }

  const type = optionalString(args.type, "type");
  if (typeof type === "object") return type;
  if (type !== undefined) {
    const typeBytes = Buffer.byteLength(type, "utf8");
    if (typeBytes > MAX_GREP_TYPE_UTF8_BYTES) {
      return {
        error: `type is ${typeBytes} UTF-8 bytes; maximum is ${MAX_GREP_TYPE_UTF8_BYTES}`,
      };
    }
  }

  const contextBefore = boundedInteger(
    args["-B"],
    "-B",
    MAX_GREP_CONTEXT_LINES,
  );
  if (typeof contextBefore === "object") return contextBefore;
  const contextAfter = boundedInteger(args["-A"], "-A", MAX_GREP_CONTEXT_LINES);
  if (typeof contextAfter === "object") return contextAfter;
  const explicitContext = boundedInteger(
    args["-C"],
    "-C",
    MAX_GREP_CONTEXT_LINES,
  );
  if (typeof explicitContext === "object") return explicitContext;
  const aliasContext = boundedInteger(
    args.context,
    "context",
    MAX_GREP_CONTEXT_LINES,
  );
  if (typeof aliasContext === "object") return aliasContext;

  const headLimit = boundedInteger(
    args.head_limit,
    "head_limit",
    MAX_GREP_HEAD_LIMIT,
    DEFAULT_HEAD_LIMIT,
  );
  if (typeof headLimit !== "number")
    return headLimit ?? { error: "invalid head_limit" };
  const offset = boundedInteger(args.offset, "offset", MAX_GREP_OFFSET, 0);
  if (typeof offset !== "number") return offset ?? { error: "invalid offset" };

  const caseInsensitive = normalizedBoolean(args["-i"], "-i", false);
  if (typeof caseInsensitive === "object") return caseInsensitive;
  const showLineNumbers = normalizedBoolean(args["-n"], "-n", true);
  if (typeof showLineNumbers === "object") return showLineNumbers;
  const multiline = normalizedBoolean(args.multiline, "multiline", false);
  if (typeof multiline === "object") return multiline;
  const includeIgnored = normalizedBoolean(
    args.includeIgnored,
    "includeIgnored",
    false,
  );
  if (typeof includeIgnored === "object") return includeIgnored;

  return {
    pattern: args.pattern,
    ...(explicitPath !== undefined ? { explicitPath } : {}),
    outputMode,
    caseInsensitive,
    showLineNumbers,
    multiline,
    includeIgnored,
    ...(contextBefore !== undefined ? { contextBefore } : {}),
    ...(contextAfter !== undefined ? { contextAfter } : {}),
    ...((explicitContext ?? aliasContext) !== undefined
      ? { contextBoth: explicitContext ?? aliasContext }
      : {}),
    ...(type !== undefined ? { type } : {}),
    ...(rawGlob !== undefined ? { rawGlob } : {}),
    globs,
    headLimit,
    offset,
  };
}

function formatBoundaryError(error: unknown): string {
  return error instanceof GrepBoundaryError
    ? `[${error.reason}] ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

function helperBoundaryError(
  error: Error | undefined,
): GrepBoundaryError | undefined {
  const match = /^\[([A-Z_]+)\]\s+(.+)$/su.exec(error?.message ?? "");
  if (match === null) return undefined;
  const reason = match[1];
  switch (reason) {
    case "MALFORMED_JSON":
    case "INVALID_JSON_RECORD":
    case "INVALID_JSON_RECORD_ORDER":
    case "INVALID_WIRE_TEXT":
    case "INVALID_WIRE_BASE64":
    case "RECORD_LIMIT":
    case "MISSING_NUL":
    case "UNTERMINATED_RECORD":
    case "INVALID_COUNT":
    case "COUNT_OVERFLOW":
      return new GrepBoundaryError(
        reason satisfies GrepBoundaryReason,
        match[2] as string,
      );
    default:
      return undefined;
  }
}

let ripgrepAvailability: boolean | undefined;

function isExecutableUnavailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (/executable not found or not executable:/u.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

const BOUND_RIPGREP_COMMAND_CWD = ".";

function prepareBoundRipgrepCommand(params: {
  readonly toolArgs: Record<string, unknown>;
  readonly fallbackCwd: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}): SandboxSpawnCommand {
  const command = applyRuntimeSandboxToSpawn({
    toolArgs: params.toolArgs,
    fallbackCwd: params.fallbackCwd,
    program: params.program,
    args: params.args,
    // The helper interprets "." through its already-open directory handle.
    // An absolute transformed cwd would reintroduce a live-path race.
    cwd: BOUND_RIPGREP_COMMAND_CWD,
    cwdBinding: "inherited_readonly",
    env: params.env,
  });
  if (command.cwd !== BOUND_RIPGREP_COMMAND_CWD) {
    throw new Error(
      "sandbox transform changed descriptor-bound ripgrep cwd; refusing to leave the authenticated capability root",
    );
  }
  assertGrepArgumentEncoding(command.program, "ripgrep executable");
  assertGrepArgvWithinLimits(command.argv0 ?? command.program, command.args);
  return command;
}

/** Probe `rg` once per process and cache the result. */
async function isRipgrepAvailable(
  cwd: string,
  toolArgs: Record<string, unknown>,
  signal?: AbortSignal,
  readCapability?: WorkspaceBoundReadCapability,
  deadline?: GrepOperationDeadline,
): Promise<boolean> {
  const ripgrepPath = selectPinnedRipgrepPath();
  if (ripgrepPath === undefined) return false;
  if (readCapability !== undefined) {
    const probeArgs = ["--no-config", "--no-follow", "--version"];
    const command = prepareBoundRipgrepCommand({
      toolArgs,
      fallbackCwd: cwd,
      program: ripgrepPath,
      args: probeArgs,
      env: scrubEnvForChildProcess(process.env),
    });
    if (ripgrepAvailability === false) return false;
    try {
      const remaining =
        deadline === undefined
          ? RIPGREP_PROBE_TIMEOUT_MS
          : Math.min(
              RIPGREP_PROBE_TIMEOUT_MS,
              remainingGrepOperationMs(deadline),
            );
      if (remaining < 1) return false;
      const result = await readCapability.runRipgrep({
        program: command.program,
        args: command.args,
        env: command.env,
        ...(command.argv0 !== undefined ? { argv0: command.argv0 } : {}),
        timeoutMs: remaining,
        maxOutputBytes: RIPGREP_PROBE_MAX_OUTPUT_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      });
      return (
        result.exitCode === 0 &&
        result.stopReason === undefined &&
        result.spawnError === undefined
      );
    } catch {
      return false;
    }
  }
  if (ripgrepAvailability === false) return false;
  // Authenticate and prepare the probe before consulting the process-wide
  // availability cache. A cached host result must never let a later restricted
  // session skip its own required sandbox boundary.
  let command: SandboxSpawnCommand;
  try {
    command = applyRuntimeSandboxToSpawn({
      toolArgs,
      fallbackCwd: cwd,
      program: ripgrepPath,
      args: ["--no-config", "--version"],
      cwd,
      env: scrubEnvForChildProcess(process.env),
    });
  } catch (error) {
    if (isExecutableUnavailable(error)) {
      if (signal?.aborted !== true) ripgrepAvailability = false;
      return false;
    }
    throw error;
  }
  if (ripgrepAvailability !== undefined) return ripgrepAvailability;
  const available = await probeRipgrepCommand(command, signal, deadline);
  if (signal?.aborted !== true) ripgrepAvailability = available;
  return available;
}

async function probeRipgrepCommand(
  command: SandboxSpawnCommand,
  signal?: AbortSignal,
  deadline?: GrepOperationDeadline,
): Promise<boolean> {
  const remaining =
    deadline === undefined
      ? RIPGREP_PROBE_TIMEOUT_MS
      : Math.min(RIPGREP_PROBE_TIMEOUT_MS, remainingGrepOperationMs(deadline));
  if (remaining < 1) return false;
  const result = await runSupervisedProcess(command, {
    timeoutMs: remaining,
    maxOutputBytes: RIPGREP_PROBE_MAX_OUTPUT_BYTES,
    signal,
  });
  return (
    result.exitCode === 0 &&
    result.stopReason === undefined &&
    result.error === undefined
  );
}

/**
 * Test hook — reset the cached `rg` probe between unit tests.
 * Not exported via index.ts; only the test file imports it.
 */
export function __resetRipgrepProbeForTests(): void {
  ripgrepAvailability = undefined;
}

/**
 * Test hook for simulating packaged-ripgrep availability without mutating PATH.
 * Not exported via index.ts; only the test file imports it.
 */
export function __setRipgrepAvailabilityForTests(
  available: boolean | undefined,
): void {
  ripgrepAvailability = available;
}

function splitGlobs(rawGlob: string): string[] {
  // Mirror AgenC (GrepTool.ts:392-409): split on whitespace, then on
  // commas where the segment doesn't include `{}` brace expansions.
  const out: string[] = [];
  for (const piece of rawGlob.split(/\s+/)) {
    if (!piece) continue;
    if (piece.includes("{") && piece.includes("}")) {
      out.push(piece);
    } else {
      for (const sub of piece.split(",")) {
        if (sub) out.push(sub);
      }
    }
  }
  return out;
}

function toRelativeIfInside(absPath: string, root: string): string {
  if (!isAbsolute(absPath) && !isWindowsAbsolutePath(absPath)) return absPath;
  if (isWindowsAbsolutePath(absPath) || isWindowsAbsolutePath(root)) {
    const rel = win32.relative(root, absPath);
    if (!rel || isRelativePathOutside(rel, win32.sep, win32.isAbsolute)) {
      return absPath;
    }
    return rel;
  }
  const rel = relative(root, absPath);
  if (!rel || isRelativePathOutside(rel, sep, isAbsolute)) return absPath;
  return rel;
}

function isRelativePathOutside(
  relativePath: string,
  pathSeparator: string,
  absolute: (path: string) => boolean,
): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${pathSeparator}`) ||
    absolute(relativePath)
  );
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  if (isWindowsAbsolutePath(candidate) || isWindowsAbsolutePath(root)) {
    const rel = win32.relative(root, candidate);
    return (
      rel === "" || !isRelativePathOutside(rel, win32.sep, win32.isAbsolute)
    );
  }
  const rel = relative(root, candidate);
  return rel === "" || !isRelativePathOutside(rel, sep, isAbsolute);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function emptyResultForMode(outputMode: OutputMode): ToolResult {
  return textResult(
    outputMode === "files_with_matches"
      ? "No files found."
      : "No matches found.",
  );
}

interface ResolvedTarget {
  readonly absolute: string;
  readonly searchRoot: string;
  readonly displayRoot: string;
  readonly displayPath: string;
  readonly isDirectory: boolean;
  readonly existsOnDisk: boolean;
  readonly allowedPaths: readonly string[];
  readonly admittedIdentity?: WorkspaceBoundReadIdentity;
  readonly displayRootIdentity: WorkspaceBoundReadIdentity;
  readonly respectVcsIgnores: boolean;
}

function bigintStatIdentity(value: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
}): WorkspaceBoundReadIdentity {
  return {
    dev: value.dev.toString(10),
    ino: value.ino.toString(10),
    mode: value.mode.toString(10),
  };
}

async function closestAllowedDisplayRoot(
  targetPath: string,
  allowedPaths: readonly string[],
): Promise<string | undefined> {
  let best: string | undefined;
  for (const allowedPath of allowedPaths) {
    const safeAllowed = await safePath(allowedPath, [allowedPath]);
    if (!safeAllowed.safe) continue;
    const allowedStat = await stat(safeAllowed.resolved).catch(() => undefined);
    const root = allowedStat?.isDirectory()
      ? safeAllowed.resolved
      : dirname(safeAllowed.resolved);
    if (!isPathInsideRoot(targetPath, root)) continue;
    if (best === undefined || root.length > best.length) {
      best = root;
    }
  }
  return best;
}

async function resolveSearchPath(params: {
  readonly args: Record<string, unknown>;
  readonly config: GrepToolConfig;
  readonly explicitPath?: string;
}): Promise<ResolvedTarget | { error: string }> {
  // SECURITY: `params.config.allowedPaths` is the TRUSTED closure scope.
  // `resolveToolAllowedPaths` only folds in runtime-injected
  // `__agencSessionAllowedRoots` (e.g. the worktree path); model-supplied
  // `__agenc*` keys are stripped at the dispatch boundary (router.ts)
  // before reaching this tool. The candidate search path is re-validated
  // against this set via `safePath` below, so a model cannot grep outside
  // trusted roots.
  const allowedPaths = resolveToolAllowedPaths(
    params.config.allowedPaths,
    params.args,
  );
  if (allowedPaths.length === 0) {
    return { error: "No allowed paths configured" };
  }
  const candidate =
    params.explicitPath ?? (allowedPaths[0] as string | undefined);
  if (!candidate) {
    return { error: "No search path resolved" };
  }
  // A relative `path` must be resolved against an allowed root, NOT
  // `process.cwd()` (the runtime dir). Resolving against cwd would push the
  // candidate outside `allowedPaths` and `safePath` would reject it. We make
  // it absolute against each allowed root and pick the first that exists and
  // re-validates safely. `safePath` below still confines the result to the
  // allowed set, so this does not widen access. Single-root is production.
  const isCandidateAbsolute =
    isAbsolute(candidate) || isWindowsAbsolutePath(candidate);
  const candidates = isCandidateAbsolute
    ? [candidate]
    : allowedPaths.map((root) => join(root, candidate));

  let safe: Awaited<ReturnType<typeof safePath>> | undefined;
  let targetIsDirectory: boolean | undefined;
  let targetExistsOnDisk = false;
  let admittedIdentity: WorkspaceBoundReadIdentity | undefined;
  let lastDenied: string | undefined;
  for (const rawCandidate of candidates) {
    const candidateSafe = await safePath(rawCandidate, allowedPaths);
    if (!candidateSafe.safe) {
      lastDenied = candidateSafe.reason;
      continue;
    }
    const candidateStat = await stat(candidateSafe.resolved, {
      bigint: true,
    }).catch(() => undefined);
    if (!candidateStat) {
      try {
        const exactEditorSnapshot = workspaceAuthoritativeDirtySnapshots(
          candidateSafe.resolved,
        ).some(
          (snapshot) =>
            normalizedResultPath(snapshot.path, candidateSafe.resolved) ===
            normalizedResultPath(
              candidateSafe.resolved,
              candidateSafe.resolved,
            ),
        );
        if (!exactEditorSnapshot) continue;
      } catch (error) {
        return {
          error:
            "Authoritative Editor workspace contents are unavailable: " +
            `${error instanceof Error ? error.message : String(error)}`,
        };
      }
      safe = candidateSafe;
      targetIsDirectory = false;
      targetExistsOnDisk = false;
      break;
    }
    safe = candidateSafe;
    targetIsDirectory = candidateStat.isDirectory();
    targetExistsOnDisk = true;
    admittedIdentity = bigintStatIdentity(candidateStat);
    break;
  }
  if (!safe) {
    if (lastDenied !== undefined) {
      return { error: `Access denied: ${lastDenied}` };
    }
    return { error: `Path does not exist: ${candidate}` };
  }
  if (targetIsDirectory === undefined) {
    return { error: `Path does not exist: ${candidate}` };
  }
  const isDirectory = targetIsDirectory;
  const displayRoot =
    (await closestAllowedDisplayRoot(safe.resolved, allowedPaths)) ??
    (isDirectory ? safe.resolved : dirname(safe.resolved));
  const displayRootStat = await stat(displayRoot, { bigint: true }).catch(
    () => undefined,
  );
  if (displayRootStat === undefined || !displayRootStat.isDirectory()) {
    return { error: `Path does not exist: ${displayRoot}` };
  }
  return {
    absolute: safe.resolved,
    searchRoot: isDirectory ? safe.resolved : dirname(safe.resolved),
    displayRoot,
    displayPath: candidate,
    isDirectory,
    existsOnDisk: targetExistsOnDisk,
    allowedPaths,
    ...(admittedIdentity !== undefined ? { admittedIdentity } : {}),
    displayRootIdentity: bigintStatIdentity(displayRootStat),
    // Parent/global/info-exclude sources are disabled in the rg argv. Keep
    // in-root .gitignore semantics even when a linked worktree uses a .git
    // file whose administrative metadata lives elsewhere.
    respectVcsIgnores: true,
  };
}

function displayRootForTarget(target: ResolvedTarget): string {
  return target.displayRoot;
}

function ripgrepCwdForTarget(target: ResolvedTarget): string {
  // A named dirty buffer may point into a directory tree that has not been
  // created on disk yet. stdin-backed rg still needs one existing cwd; the
  // validated allowed display root is safe and always exists.
  return target.displayRoot;
}

function ripgrepSearchPathForTarget(target: ResolvedTarget): string {
  const relativePath = relative(target.displayRoot, target.absolute);
  return relativePath.length === 0 ? "." : relativePath;
}

async function bindTargetReadCapability(
  target: ResolvedTarget,
): Promise<WorkspaceBoundReadCapability> {
  if (target.existsOnDisk && !target.isDirectory) {
    return bindWorkspaceFileReadCapability(target.absolute, {
      ...(target.admittedIdentity !== undefined
        ? { expectedIdentity: target.admittedIdentity }
        : {}),
    });
  }
  const directoryPath = target.isDirectory
    ? target.absolute
    : target.displayRoot;
  const expectedIdentity = target.isDirectory
    ? target.admittedIdentity
    : target.displayRootIdentity;
  return bindWorkspaceDirectoryReadCapability(directoryPath, {
    ...(expectedIdentity !== undefined ? { expectedIdentity } : {}),
  });
}

async function additionalReadCapabilities(
  target: ResolvedTarget,
  primaryCapability: WorkspaceBoundReadCapability,
  count: number,
): Promise<readonly WorkspaceBoundReadCapability[]> {
  if (count <= 0) return [];
  const directoryPath = primaryCapability.rootPath;
  const expectedIdentity =
    resolve(directoryPath) === resolve(target.displayRoot)
      ? target.displayRootIdentity
      : target.isDirectory &&
          resolve(directoryPath) === resolve(target.absolute)
        ? target.admittedIdentity
        : undefined;
  const attempts = await Promise.allSettled(
    Array.from({ length: count }, () =>
      bindWorkspaceDirectoryReadCapability(directoryPath, {
        ...(expectedIdentity !== undefined ? { expectedIdentity } : {}),
      }),
    ),
  );
  const capabilities = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : [],
  );
  if (capabilities.length === count) return capabilities;
  await Promise.all(capabilities.map((capability) => capability.dispose()));
  return [];
}

async function mapProtectedRipgrepTasks<T, R>(params: {
  readonly items: readonly T[];
  readonly primaryCapability: WorkspaceBoundReadCapability;
  readonly target: ResolvedTarget;
  readonly source: "disk" | "snapshot";
  readonly observer?: GrepToolConfig["__testProtectedTaskObserver"];
  readonly signal?: AbortSignal;
  readonly deadline?: GrepOperationDeadline;
  readonly shouldStop?: (result: R) => boolean;
  readonly task: (
    item: T,
    capability: WorkspaceBoundReadCapability,
    index: number,
  ) => Promise<R>;
}): Promise<readonly R[]> {
  if (params.items.length === 0) return [];
  const concurrency = Math.min(
    MAX_PROTECTED_RIPGREP_CONCURRENCY,
    params.items.length,
  );
  const additional = await additionalReadCapabilities(
    params.target,
    params.primaryCapability,
    concurrency - 1,
  );
  const capabilities = [params.primaryCapability, ...additional];
  const results = new Array<R>(params.items.length);
  let nextIndex = 0;
  let terminal = false;
  try {
    await Promise.all(
      capabilities.map(async (capability) => {
        for (;;) {
          if (
            terminal ||
            params.signal?.aborted === true ||
            (params.deadline !== undefined &&
              remainingGrepOperationMs(params.deadline) < 1)
          ) {
            terminal = true;
            return;
          }
          const index = nextIndex;
          nextIndex += 1;
          if (index >= params.items.length) return;
          params.observer?.({
            phase: "start",
            source: params.source,
            index,
          });
          try {
            const result = await params.task(
              params.items[index] as T,
              capability,
              index,
            );
            results[index] = result;
            if (params.shouldStop?.(result) === true) terminal = true;
          } finally {
            params.observer?.({
              phase: "finish",
              source: params.source,
              index,
            });
          }
        }
      }),
    );
    return results;
  } finally {
    await Promise.all(additional.map((capability) => capability.dispose()));
  }
}

// ────────────────────────────────────────────────────────────────────────
// Ripgrep path
// ────────────────────────────────────────────────────────────────────────

interface RipgrepOptions {
  readonly pattern: string;
  readonly absolutePath: string;
  readonly outputMode: OutputMode;
  readonly caseInsensitive: boolean;
  readonly showLineNumbers: boolean;
  readonly multiline: boolean;
  readonly includeIgnored: boolean;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly contextBoth?: number;
  readonly type?: string;
  readonly globs: readonly string[];
  readonly respectVcsIgnores?: boolean;
  readonly rootIgnoreFiles?: readonly string[];
}

function buildRipgrepArgs(opts: RipgrepOptions): string[] {
  const args: string[] = [
    "--hidden",
    "--no-require-git",
    "--no-ignore-parent",
    "--no-ignore-global",
    "--no-ignore-exclude",
  ];
  if (!opts.includeIgnored) {
    for (const ignoreFile of opts.rootIgnoreFiles ?? []) {
      args.push("--ignore-file", ignoreFile);
    }
  }
  if (opts.respectVcsIgnores === false) args.push("--no-ignore-vcs");
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`);
  }
  if (opts.includeIgnored) {
    // Opt-in power-user walk: surface gitignored + build output (e.g. grepping
    // inside `target/`/`dist/`). `--no-ignore` plus dropping the generated-dir
    // excludes restores the unfiltered search.
    args.push("--no-ignore");
  } else {
    // Default walk: layer generated/build/vendored/ledger excludes on top of
    // ripgrep's `.gitignore` handling so even un-gitignored copies are skipped.
    for (const dir of DEFAULT_GENERATED_DIRECTORIES_TO_EXCLUDE) {
      args.push("--glob", `!${dir}`);
    }
  }
  args.push("--max-columns", "500", "--max-columns-preview");

  if (opts.multiline) {
    args.push("-U", "--multiline-dotall");
  }
  if (opts.caseInsensitive) {
    args.push("-i");
  }
  if (opts.outputMode === "files_with_matches") {
    args.push("-0", "-l", "--sortr", "modified");
  } else if (opts.outputMode === "count") {
    args.push("-0", "-c", "--with-filename", "--sort", "path");
  } else {
    // JSON is ripgrep's only structured content/context protocol. It carries
    // path bytes, line numbers and submatch byte offsets independently of the
    // human renderer's delimiter choices.
    args.push("--json");
    if (opts.contextBoth !== undefined) {
      args.push("-C", String(opts.contextBoth));
    } else {
      if (opts.contextBefore !== undefined) {
        args.push("-B", String(opts.contextBefore));
      }
      if (opts.contextAfter !== undefined) {
        args.push("-A", String(opts.contextAfter));
      }
    }
  }

  args.push("-e", opts.pattern);

  if (opts.type) {
    args.push("--type", opts.type);
  }
  for (const glob of opts.globs) {
    args.push("--glob", glob);
  }

  args.push("--", opts.absolutePath);
  return args;
}

function applyTruncation<T>(
  items: readonly T[],
  headLimit: number,
  offset = 0,
): { items: readonly T[]; truncated: boolean } {
  if (headLimit === 0) {
    return { items: items.slice(offset), truncated: false };
  }
  const remaining = Math.max(0, items.length - offset);
  return {
    items: items.slice(offset, offset + headLimit),
    truncated: remaining > headLimit,
  };
}

function formatTruncationNote(headLimit: number, offset = 0): string {
  const offsetText = offset > 0 ? ` after offset ${offset}` : "";
  return `(results truncated at ${headLimit}${offsetText}; refine query)`;
}

function formatOffsetNote(offset: number): string {
  return `(offset ${offset})`;
}

function collectionLineLimit(headLimit: number, offset: number): number {
  return offset + headLimit + 1;
}

function createCollectionWireParser(
  outputMode: OutputMode,
  maximumLines: number | undefined,
  budget?: GrepOperationBudget,
): RipgrepWireParser {
  const requestedMaximum = maximumLines ?? MAX_GREP_RESULTS;
  const maximumResults =
    budget === undefined
      ? requestedMaximum
      : Math.min(requestedMaximum, budget.remainingRecords);
  return createRipgrepWireParser(outputMode, {
    // A bounded page retains one complete record past the public result
    // window solely as a truncation witness. It is never returned.
    maxResults: maximumResults,
    maxContextRecords: maximumResults,
    maxDecodedBytes: budget?.remainingDecodedBytes ?? MAX_GREP_DECODED_BYTES,
  });
}

interface CollectionParserState {
  inspectedRecords: number;
  renderedLines: number;
}

class BoundedWireRecord {
  readonly #parts: Buffer[] = [];
  #bytes = 0;

  append(part: Buffer): void {
    if (part.byteLength === 0) return;
    this.#bytes += part.byteLength;
    if (this.#bytes > MAX_GREP_RECORD_BYTES) {
      throw new GrepBoundaryError(
        "RECORD_LIMIT",
        `ripgrep record exceeds ${MAX_GREP_RECORD_BYTES} bytes`,
      );
    }
    this.#parts.push(part);
  }

  take(): Buffer {
    const record = Buffer.concat(this.#parts, this.#bytes);
    this.#parts.length = 0;
    this.#bytes = 0;
    return record;
  }

  get byteLength(): number {
    return this.#bytes;
  }
}

async function readNulDelimitedCandidateSpool(params: {
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly deadline?: GrepOperationDeadline;
  readonly visit: (path: Buffer, index: number) => boolean | Promise<boolean>;
}): Promise<{
  readonly processedRecords: number;
  readonly maximumBufferedRecordBytes: number;
}> {
  const handle = await open(params.path, "r");
  const buffer = Buffer.alloc(CANDIDATE_SPOOL_READ_BYTES);
  const record = new BoundedWireRecord();
  let processedRecords = 0;
  let maximumBufferedRecordBytes = 0;
  let position = 0;
  try {
    for (;;) {
      if (params.signal?.aborted) {
        return { processedRecords, maximumBufferedRecordBytes };
      }
      if (
        params.deadline !== undefined &&
        remainingGrepOperationMs(params.deadline) < 1
      ) {
        return { processedRecords, maximumBufferedRecordBytes };
      }
      const read = await handle.read(buffer, 0, buffer.byteLength, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
      let start = 0;
      for (;;) {
        const delimiter = buffer.indexOf(0, start);
        if (delimiter < 0 || delimiter >= read.bytesRead) {
          record.append(buffer.subarray(start, read.bytesRead));
          maximumBufferedRecordBytes = Math.max(
            maximumBufferedRecordBytes,
            record.byteLength,
          );
          break;
        }
        record.append(buffer.subarray(start, delimiter));
        maximumBufferedRecordBytes = Math.max(
          maximumBufferedRecordBytes,
          record.byteLength,
        );
        const candidate = record.take();
        if (candidate.byteLength === 0) {
          throw new GrepBoundaryError(
            "INVALID_WIRE_TEXT",
            "ripgrep emitted an empty candidate path",
          );
        }
        const visitResult = params.visit(candidate, processedRecords);
        const keepReading =
          typeof visitResult === "boolean" ? visitResult : await visitResult;
        processedRecords += 1;
        if (!keepReading) {
          return { processedRecords, maximumBufferedRecordBytes };
        }
        start = delimiter + 1;
      }
    }
    if (record.byteLength > 0) {
      throw new GrepBoundaryError(
        "UNTERMINATED_RECORD",
        "ripgrep candidate spool ended with an unterminated path",
      );
    }
    return { processedRecords, maximumBufferedRecordBytes };
  } finally {
    await handle.close();
  }
}

interface RipgrepWireWindow {
  readonly processedLines: number;
  readonly retainedLines: number;
  readonly reached: boolean;
  push(chunk: Buffer): readonly Buffer[];
  finish(options?: { readonly allowPartial?: boolean }): readonly Buffer[];
}

function lineSliceOffset(content: Buffer, lines: number): number {
  if (lines <= 0) return 0;
  let remaining = lines;
  for (let index = 0; index < content.byteLength; index += 1) {
    if (content[index] !== BYTE_LINE_FEED) continue;
    remaining -= 1;
    if (remaining === 0) return index + 1;
  }
  return content.byteLength;
}

function decodeJsonWindowLines(value: unknown): {
  readonly bytes: Buffer;
  readonly encoding: "text" | "bytes";
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GrepBoundaryError(
      "INVALID_JSON_RECORD",
      "ripgrep JSON lines are not an object",
    );
  }
  const lines = value as Record<string, unknown>;
  if (typeof lines.text === "string" && lines.bytes === undefined) {
    return { bytes: Buffer.from(lines.text, "utf8"), encoding: "text" };
  }
  if (typeof lines.bytes === "string" && lines.text === undefined) {
    const bytes = Buffer.from(lines.bytes, "base64");
    if (bytes.toString("base64") !== lines.bytes) {
      throw new GrepBoundaryError(
        "INVALID_WIRE_BASE64",
        "ripgrep JSON lines contain non-canonical base64",
      );
    }
    return { bytes, encoding: "bytes" };
  }
  throw new GrepBoundaryError(
    "INVALID_JSON_RECORD",
    "ripgrep JSON lines must contain exactly one of text or bytes",
  );
}

class StreamingRipgrepWireWindow implements RipgrepWireWindow {
  readonly #record = new BoundedWireRecord();
  readonly #validator: RipgrepWireParser;
  readonly #outputMode: OutputMode;
  readonly #skipLines: number;
  readonly #maximumLines: number | undefined;
  #countState: "path" | "count" = "path";
  #countPath: Buffer | undefined;
  #pendingBegin: Buffer | undefined;
  #capturingJsonFile = false;
  #processedLines = 0;
  #retainedLines = 0;
  #reached = false;

  constructor(
    outputMode: OutputMode,
    skipLines: number,
    maximumLines: number | undefined,
  ) {
    this.#outputMode = outputMode;
    this.#skipLines = skipLines;
    this.#maximumLines = maximumLines;
    this.#validator = createRipgrepWireValidator(outputMode, {
      maxRecordBytes: MAX_GREP_RECORD_BYTES,
    });
  }

  get processedLines(): number {
    return this.#processedLines;
  }

  get retainedLines(): number {
    return this.#retainedLines;
  }

  get reached(): boolean {
    return this.#reached;
  }

  push(chunk: Buffer): readonly Buffer[] {
    // The pagination window may omit records before the offset or after its
    // truncation witness. Validate the complete consumed chunk first so those
    // omitted records cannot hide malformed wire data or JSON ordering.
    this.#validator.push(chunk);
    if (this.#reached) return [];
    if (this.#outputMode === "files_with_matches") {
      return this.#pushFiles(chunk);
    }
    if (this.#outputMode === "count") return this.#pushCount(chunk);
    return this.#pushJson(chunk);
  }

  finish(options?: { readonly allowPartial?: boolean }): readonly Buffer[] {
    this.#validator.finish(options);
    if (options?.allowPartial === true || this.#reached) return [];
    if (this.#record.byteLength > 0 || this.#countState !== "path") {
      throw new GrepBoundaryError(
        "UNTERMINATED_RECORD",
        "ripgrep output ended with an unterminated record",
      );
    }
    return [];
  }

  #takeLineWindow(lineCount: number): { skip: number; take: number } {
    const skip = Math.min(
      lineCount,
      Math.max(0, this.#skipLines - this.#processedLines),
    );
    const available = lineCount - skip;
    if (
      this.#maximumLines === undefined &&
      available > MAX_GREP_RESULTS - this.#retainedLines
    ) {
      throw new GrepBoundaryError(
        "RESULT_LIMIT",
        `ripgrep rendered lines exceed ${MAX_GREP_RESULTS}`,
      );
    }
    const take =
      this.#maximumLines === undefined
        ? available
        : Math.min(
            available,
            Math.max(0, this.#maximumLines - this.#retainedLines),
          );
    this.#processedLines += lineCount;
    this.#retainedLines += take;
    if (
      this.#maximumLines !== undefined &&
      this.#retainedLines >= this.#maximumLines
    ) {
      this.#reached = true;
    }
    return { skip, take };
  }

  #pushFiles(chunk: Buffer): readonly Buffer[] {
    const output: Buffer[] = [];
    let start = 0;
    while (!this.#reached) {
      const delimiter = chunk.indexOf(0, start);
      if (delimiter < 0) {
        this.#record.append(chunk.subarray(start));
        break;
      }
      this.#record.append(chunk.subarray(start, delimiter));
      const path = this.#record.take();
      if (path.byteLength === 0) {
        throw new GrepBoundaryError(
          "INVALID_WIRE_TEXT",
          "ripgrep emitted an empty path",
        );
      }
      if (this.#takeLineWindow(1).take === 1) {
        output.push(path, Buffer.from([0]));
      }
      start = delimiter + 1;
    }
    return output;
  }

  #pushCount(chunk: Buffer): readonly Buffer[] {
    const output: Buffer[] = [];
    let start = 0;
    while (!this.#reached && start < chunk.byteLength) {
      const delimiterByte = this.#countState === "path" ? 0 : BYTE_LINE_FEED;
      const delimiter = chunk.indexOf(delimiterByte, start);
      if (delimiter < 0) {
        this.#record.append(chunk.subarray(start));
        break;
      }
      this.#record.append(chunk.subarray(start, delimiter));
      if (this.#countState === "path") {
        this.#countPath = this.#record.take();
        if (this.#countPath.byteLength === 0) {
          throw new GrepBoundaryError(
            "INVALID_WIRE_TEXT",
            "ripgrep emitted an empty count path",
          );
        }
        this.#countState = "count";
      } else {
        const count = this.#record.take();
        if (this.#takeLineWindow(1).take === 1) {
          output.push(
            this.#countPath!,
            Buffer.from([0]),
            count,
            Buffer.from([BYTE_LINE_FEED]),
          );
        }
        this.#countPath = undefined;
        this.#countState = "path";
      }
      start = delimiter + 1;
    }
    return output;
  }

  #pushJson(chunk: Buffer): readonly Buffer[] {
    const output: Buffer[] = [];
    let start = 0;
    while (!this.#reached) {
      const delimiter = chunk.indexOf(BYTE_LINE_FEED, start);
      if (delimiter < 0) {
        this.#record.append(chunk.subarray(start));
        break;
      }
      this.#record.append(chunk.subarray(start, delimiter));
      output.push(...this.#consumeJsonRecord(this.#record.take()));
      start = delimiter + 1;
    }
    return output;
  }

  #consumeJsonRecord(record: Buffer): readonly Buffer[] {
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(record),
      );
    } catch (error) {
      throw new GrepBoundaryError(
        "MALFORMED_JSON",
        `ripgrep emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new GrepBoundaryError(
        "INVALID_JSON_RECORD",
        "ripgrep JSON record is not an object",
      );
    }
    const json = value as Record<string, unknown>;
    const data = json.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new GrepBoundaryError(
        "INVALID_JSON_RECORD",
        "ripgrep JSON record data is not an object",
      );
    }
    const typedData = data as Record<string, unknown>;
    if (json.type === "begin") {
      this.#pendingBegin = record;
      this.#capturingJsonFile = false;
      return [];
    }
    if (json.type === "match" || json.type === "context") {
      const lines = decodeJsonWindowLines(typedData.lines);
      const lineCount = contentRecordLineCount(lines.bytes);
      const window = this.#takeLineWindow(lineCount);
      if (window.take === 0) return [];
      if (window.skip === 0 && window.take === lineCount) {
        const output: Buffer[] = [];
        if (!this.#capturingJsonFile && this.#pendingBegin !== undefined) {
          output.push(this.#pendingBegin, Buffer.from([BYTE_LINE_FEED]));
        }
        this.#capturingJsonFile = true;
        output.push(record, Buffer.from([BYTE_LINE_FEED]));
        return output;
      }
      const sliceStart = lineSliceOffset(lines.bytes, window.skip);
      const sliceEnd =
        sliceStart +
        lineSliceOffset(lines.bytes.subarray(sliceStart), window.take);
      const sliced = lines.bytes.subarray(sliceStart, sliceEnd);
      typedData.lines =
        lines.encoding === "text"
          ? { text: sliced.toString("utf8") }
          : { bytes: sliced.toString("base64") };
      if (typeof typedData.line_number === "number") {
        typedData.line_number += window.skip;
      }
      if (typeof typedData.absolute_offset === "number") {
        typedData.absolute_offset += sliceStart;
      }
      typedData.submatches = [];
      const output: Buffer[] = [];
      if (!this.#capturingJsonFile && this.#pendingBegin !== undefined) {
        output.push(this.#pendingBegin, Buffer.from([BYTE_LINE_FEED]));
      }
      this.#capturingJsonFile = true;
      output.push(
        Buffer.from(JSON.stringify(json), "utf8"),
        Buffer.from([BYTE_LINE_FEED]),
      );
      return output;
    }
    if (json.type === "end") {
      const output = this.#capturingJsonFile
        ? [record, Buffer.from([BYTE_LINE_FEED])]
        : [];
      this.#pendingBegin = undefined;
      this.#capturingJsonFile = false;
      return output;
    }
    if (json.type === "summary") {
      return [record, Buffer.from([BYTE_LINE_FEED])];
    }
    throw new GrepBoundaryError(
      "INVALID_JSON_RECORD",
      `ripgrep emitted unsupported JSON record type '${String(json.type)}'`,
    );
  }
}

/**
 * Feed only complete protocol records through the public page boundary. This
 * prevents a single large stdout chunk from pushing several records past the
 * internal truncation witness before the caller can stop the child.
 */
function pushRipgrepChunkWithinLineLimit(
  parser: RipgrepWireParser,
  outputMode: OutputMode,
  chunk: Buffer,
  maximumLines: number,
  state: CollectionParserState,
): boolean {
  const delimiter = outputMode === "files_with_matches" ? 0x00 : 0x0a;
  let start = 0;
  for (;;) {
    const delimiterIndex = chunk.indexOf(delimiter, start);
    if (delimiterIndex < 0) {
      parser.push(chunk.subarray(start));
      return false;
    }
    parser.push(chunk.subarray(start, delimiterIndex + 1));
    while (state.inspectedRecords < parser.records.length) {
      state.renderedLines += ripgrepRecordLineCount(
        parser.records[state.inspectedRecords] as RipgrepOutputRecord,
      );
      state.inspectedRecords += 1;
    }
    if (state.renderedLines >= maximumLines) return true;
    start = delimiterIndex + 1;
  }
}

function contentRecordLineCount(lines: Buffer): number {
  let contentEnd = lines.byteLength;
  if (contentEnd > 0 && lines[contentEnd - 1] === BYTE_LINE_FEED) {
    contentEnd -= 1;
    if (contentEnd > 0 && lines[contentEnd - 1] === BYTE_CARRIAGE_RETURN) {
      contentEnd -= 1;
    }
  }
  let lineCount = 1;
  for (let index = 0; index < contentEnd; index += 1) {
    if (lines[index] === BYTE_LINE_FEED) lineCount += 1;
  }
  return lineCount;
}

function ripgrepRecordLineCount(record: RipgrepOutputRecord): number {
  return record.kind === "content" ? contentRecordLineCount(record.lines) : 1;
}

function truncateRenderedContentLine(line: string): string {
  if (line.length <= MAX_RENDERED_CONTENT_LINE_CHARS) return line;
  return `${line.slice(0, MAX_RENDERED_CONTENT_LINE_CHARS)}... (line truncated at ${MAX_RENDERED_CONTENT_LINE_CHARS} chars)`;
}

// AgenC returns plain ToolResult.content instead of the donor's structured
// renderer. These text strings are intentional and pinned by focused tests.
function formatFilesWithMatchesResult(
  items: readonly string[],
  truncated: boolean,
  headLimit: number,
  offset = 0,
): ToolResult {
  if (items.length === 0) {
    const empty = emptyResultForMode("files_with_matches").content;
    return textResult(
      offset > 0 ? `${empty} ${formatOffsetNote(offset)}` : empty,
    );
  }
  const count = items.length;
  const pagination = truncated
    ? formatTruncationNote(headLimit, offset)
    : offset > 0
      ? formatOffsetNote(offset)
      : "";
  const summary = `Found ${count} ${count === 1 ? "file" : "files"}${
    pagination ? ` ${pagination}` : ""
  }`;
  return textResult(`${summary}\n${items.join("\n")}`);
}

function formatCountSummary(
  records: readonly RipgrepCountRecord[],
  truncated: boolean,
  headLimit: number,
  offset = 0,
): string {
  let totalMatches = 0;
  for (const record of records) {
    totalMatches += record.count;
  }
  const fileCount = records.length;
  if (truncated) {
    return `Showing ${totalMatches} ${
      totalMatches === 1 ? "occurrence" : "occurrences"
    } across ${fileCount} ${fileCount === 1 ? "file" : "files"} in returned results. ${formatTruncationNote(headLimit, offset)}`;
  }
  const offsetText = offset > 0 ? ` ${formatOffsetNote(offset)}` : "";
  return `Found ${totalMatches} total ${
    totalMatches === 1 ? "occurrence" : "occurrences"
  } across ${fileCount} ${fileCount === 1 ? "file" : "files"}${offsetText}.`;
}

function pathBytesRelativeToDisplayRoot(
  path: Buffer,
  displayRoot: string,
): Buffer {
  const decoded = decodeRipgrepPathBytes(path);
  if (decoded !== undefined) {
    const relativePath = toRelativeIfInside(decoded, displayRoot);
    const withoutCurrentDirectory =
      relativePath.startsWith(`.${sep}`) || relativePath.startsWith("./")
        ? relativePath.slice(2)
        : relativePath;
    return Buffer.from(withoutCurrentDirectory, "utf8");
  }
  if (process.platform === "win32") return path;
  if (path.byteLength >= 2 && path[0] === 0x2e && path[1] === 0x2f) {
    return path.subarray(2);
  }
  const root = Buffer.from(displayRoot, "utf8");
  if (
    path.byteLength <= root.byteLength ||
    !path.subarray(0, root.byteLength).equals(root)
  ) {
    return path;
  }
  const separator = path[root.byteLength];
  return separator === 0x2f ? path.subarray(root.byteLength + 1) : path;
}

function renderResultPath(path: Buffer, displayRoot: string): string {
  return renderRipgrepPathBytes(
    pathBytesRelativeToDisplayRoot(path, displayRoot),
  );
}

function* renderContentRecordLines(
  record: RipgrepContentRecord,
  displayRoot: string,
  showLineNumbers: boolean,
): Generator<string> {
  const separator = record.recordType === "match" ? ":" : "-";
  const path = renderResultPath(record.path, displayRoot);
  const contentLines = renderRipgrepContentBytes(record.lines)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  for (const [index, line] of contentLines.entries()) {
    const lineNumber =
      showLineNumbers && record.lineNumber !== null
        ? `${record.lineNumber + index}${separator}`
        : "";
    yield truncateRenderedContentLine(
      `${path}${separator}${lineNumber}${line}`,
    );
  }
}

class BoundedRenderedLineCollector {
  readonly #lines: string[] = [];
  #bytes = 0;

  constructor(readonly maximumBytes = MAX_GREP_RENDERED_BYTES) {}

  push(line: string): void {
    const separatorBytes = this.#lines.length === 0 ? 0 : 1;
    const nextBytes =
      this.#bytes + separatorBytes + Buffer.byteLength(line, "utf8");
    if (nextBytes > this.maximumBytes) {
      throw new GrepBoundaryError(
        "RENDERED_OUTPUT_LIMIT",
        `rendered ripgrep output exceeds ${this.maximumBytes} bytes`,
      );
    }
    this.#lines.push(line);
    this.#bytes = nextBytes;
  }

  get lines(): readonly string[] {
    return this.#lines;
  }
}

function renderContentRecordsWithinBudget(params: {
  readonly records: readonly RipgrepContentRecord[];
  readonly displayRoot: string;
  readonly showLineNumbers: boolean;
  readonly headLimit: number;
  readonly maximumBytes?: number;
}): { readonly items: readonly string[]; readonly truncated: boolean } {
  const output = new BoundedRenderedLineCollector(params.maximumBytes);
  let renderedLines = 0;
  for (const record of params.records) {
    for (const line of renderContentRecordLines(
      record,
      params.displayRoot,
      params.showLineNumbers,
    )) {
      renderedLines += 1;
      if (params.headLimit === 0 && renderedLines > MAX_GREP_RESULTS) {
        throw new GrepBoundaryError(
          "RESULT_LIMIT",
          `rendered ripgrep lines exceed ${MAX_GREP_RESULTS}`,
        );
      }
      if (params.headLimit > 0 && renderedLines > params.headLimit) {
        return { items: output.lines, truncated: true };
      }
      output.push(line);
    }
  }
  return { items: output.lines, truncated: false };
}

function assertRenderedOutputWithinLimit(content: string): void {
  const renderedBytes = Buffer.byteLength(content, "utf8");
  if (renderedBytes > MAX_GREP_RENDERED_BYTES) {
    throw new GrepBoundaryError(
      "RENDERED_OUTPUT_LIMIT",
      `rendered ripgrep output is ${renderedBytes} bytes; maximum is ${MAX_GREP_RENDERED_BYTES}`,
    );
  }
}

function emptyRipgrepResultForMode(
  outputMode: OutputMode,
  headLimit: number,
  offset: number,
): ToolResult {
  if (outputMode === "count") {
    return textResult(
      `No matches found.\n${formatCountSummary([], false, headLimit, offset)}`,
    );
  }
  const empty = emptyResultForMode(outputMode).content;
  return textResult(
    offset > 0 ? `${empty} ${formatOffsetNote(offset)}` : empty,
  );
}

interface LimitedRipgrepResult {
  readonly records: readonly RipgrepOutputRecord[];
  readonly decodedBytes: number;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killedAfterLimit: boolean;
  readonly aborted: boolean;
  readonly stopReason?: SupervisedProcessStopReason;
  readonly spawnError?: Error;
  readonly protocolError?: GrepBoundaryError;
  readonly processedLines: number;
}

const MAX_GREP_OPERATION_WORK_UNITS = MAX_GREP_OFFSET + MAX_GREP_RESULTS;

export interface GrepOperationBudgetLimits {
  readonly maxRecords: number;
  readonly maxDecodedBytes: number;
  readonly maxWorkUnits: number;
}

class GrepOperationBudget {
  #records = 0;
  #decodedBytes = 0;
  #workUnits = 0;

  constructor(
    readonly limits: GrepOperationBudgetLimits = {
      maxRecords: MAX_GREP_RESULTS,
      maxDecodedBytes: MAX_GREP_DECODED_BYTES,
      maxWorkUnits: MAX_GREP_OPERATION_WORK_UNITS,
    },
  ) {}

  get remainingRecords(): number {
    return Math.max(0, this.limits.maxRecords - this.#records);
  }

  get remainingDecodedBytes(): number {
    return Math.max(0, this.limits.maxDecodedBytes - this.#decodedBytes);
  }

  get remainingWorkUnits(): number {
    return Math.max(0, this.limits.maxWorkUnits - this.#workUnits);
  }

  consumeResult(result: {
    readonly records: number;
    readonly decodedBytes: number;
    readonly workUnits: number;
  }): void {
    const nextRecords = this.#records + result.records;
    const nextDecodedBytes = this.#decodedBytes + result.decodedBytes;
    const nextWorkUnits = this.#workUnits + result.workUnits;
    if (nextRecords > this.limits.maxRecords) {
      throw new GrepBoundaryError(
        "RESULT_LIMIT",
        `protected ripgrep aggregate records exceed ${this.limits.maxRecords}`,
      );
    }
    if (nextDecodedBytes > this.limits.maxDecodedBytes) {
      throw new GrepBoundaryError(
        "DECODED_OUTPUT_LIMIT",
        `protected ripgrep aggregate decoded output exceeds ${this.limits.maxDecodedBytes} bytes`,
      );
    }
    if (nextWorkUnits > this.limits.maxWorkUnits) {
      throw new GrepBoundaryError(
        "RESULT_LIMIT",
        `protected ripgrep aggregate work exceeds ${this.limits.maxWorkUnits} units`,
      );
    }
    this.#records = nextRecords;
    this.#decodedBytes = nextDecodedBytes;
    this.#workUnits = nextWorkUnits;
  }

  consumeWork(workUnits: number): void {
    this.consumeResult({ records: 0, decodedBytes: 0, workUnits });
  }
}

function parseCompletedRipgrepOutput(
  parser: RipgrepWireParser,
  output: Buffer,
  exitCode: number | null,
  stopReason?: SupervisedProcessStopReason,
  allowPartial = false,
): GrepBoundaryError | undefined {
  try {
    if (output.byteLength > 0) parser.push(output);
    if (allowPartial) {
      parser.finish({ allowPartial: true });
    } else if ((exitCode === 0 || exitCode === 1) && stopReason === undefined) {
      parser.finish();
    }
    return undefined;
  } catch (error) {
    return error instanceof GrepBoundaryError
      ? error
      : new GrepBoundaryError(
          "INVALID_WIRE_TEXT",
          error instanceof Error ? error.message : String(error),
        );
  }
}

function diagnosticLimitError(byteLength: number): GrepBoundaryError {
  return new GrepBoundaryError(
    "DIAGNOSTIC_LIMIT",
    `ripgrep diagnostics are ${byteLength} bytes; maximum is ${MAX_GREP_DIAGNOSTIC_BYTES}`,
  );
}

function decodeBoundedDiagnostics(stderr: Buffer): string {
  return stderr
    .subarray(0, Math.min(stderr.byteLength, MAX_GREP_DIAGNOSTIC_BYTES))
    .toString("utf8");
}

async function runRipgrepCollectRecords(params: {
  readonly outputMode: OutputMode;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly toolArgs: Record<string, unknown>;
  readonly maximumLines?: number;
  readonly skipLines?: number;
  readonly excludedPaths?: readonly string[];
  readonly stdin?: string | Buffer;
  readonly relativeInputFile?: string;
  readonly readCapability?: WorkspaceBoundReadCapability;
  readonly signal?: AbortSignal;
  readonly deadline?: GrepOperationDeadline;
  readonly operationBudget?: GrepOperationBudget;
}): Promise<LimitedRipgrepResult> {
  const timeoutMs =
    params.deadline === undefined
      ? MAX_GREP_WALL_MS
      : remainingGrepOperationMs(params.deadline);
  if (timeoutMs < 1) return operationTimedOutResult();
  const ripgrepPath = selectPinnedRipgrepPath();
  if (ripgrepPath === undefined) return pinnedRipgrepUnavailableResult();
  const processArgs = ["--no-config", "--no-follow", ...params.args];
  try {
    assertGrepArgvWithinLimits(ripgrepPath, processArgs);
  } catch (error) {
    return {
      records: [],
      decodedBytes: 0,
      stderr: "",
      exitCode: 127,
      signal: null,
      killedAfterLimit: false,
      aborted: params.signal?.aborted === true,
      processedLines: 0,
      protocolError:
        error instanceof GrepBoundaryError
          ? error
          : new GrepBoundaryError("ARGV_UTF8_LIMIT", String(error)),
    };
  }

  if (params.readCapability !== undefined) {
    const command = prepareBoundRipgrepCommand({
      toolArgs: params.toolArgs,
      fallbackCwd: params.cwd,
      program: ripgrepPath,
      args: processArgs,
      env: scrubEnvForChildProcess(process.env),
    });
    try {
      const skipLines = params.skipLines ?? 0;
      const helperMaximumLines = params.maximumLines ?? MAX_GREP_RESULTS + 1;
      const result = await params.readCapability.runRipgrep({
        program: command.program,
        args: command.args,
        env: command.env,
        ...(command.argv0 !== undefined ? { argv0: command.argv0 } : {}),
        timeoutMs,
        maxOutputBytes: RIPGREP_WIRE_MAX_OUTPUT_BYTES,
        ...(helperMaximumLines !== undefined
          ? {
              structuredLineLimit: {
                outputMode: params.outputMode,
                maximumLines: helperMaximumLines,
                maximumRecordBytes: MAX_GREP_RECORD_BYTES,
                maximumWorkUnits:
                  params.operationBudget?.remainingWorkUnits ??
                  MAX_GREP_OPERATION_WORK_UNITS,
                ...(skipLines > 0 ? { skipLines } : {}),
                ...(params.excludedPaths !== undefined
                  ? { excludedPaths: params.excludedPaths }
                  : {}),
              },
            }
          : {}),
        ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
        ...(params.relativeInputFile !== undefined
          ? { relativeInputFile: params.relativeInputFile }
          : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });
      const parser = createCollectionWireParser(
        params.outputMode,
        helperMaximumLines,
        params.operationBudget,
      );
      const window = new StreamingRipgrepWireWindow(
        params.outputMode,
        0,
        helperMaximumLines,
      );
      const diagnosticsError =
        result.stderr.byteLength > MAX_GREP_DIAGNOSTIC_BYTES
          ? diagnosticLimitError(result.stderr.byteLength)
          : undefined;
      const helperProtocolError = helperBoundaryError(result.spawnError);
      let protocolError = helperProtocolError ?? diagnosticsError;
      if (protocolError === undefined) {
        try {
          for (const part of window.push(result.stdout)) parser.push(part);
          for (const part of window.finish({
            allowPartial:
              result.killedAfterLimit ||
              window.reached ||
              result.stopReason !== undefined ||
              (result.exitCode !== 0 && result.exitCode !== 1),
          })) {
            parser.push(part);
          }
          protocolError = parseCompletedRipgrepOutput(
            parser,
            Buffer.alloc(0),
            result.exitCode,
            result.stopReason,
            result.killedAfterLimit || window.reached,
          );
        } catch (error) {
          protocolError =
            error instanceof GrepBoundaryError
              ? error
              : new GrepBoundaryError("INVALID_WIRE_TEXT", String(error));
        }
      }
      if (protocolError === undefined && params.operationBudget !== undefined) {
        try {
          const workUnits = Math.max(
            result.workUnits,
            result.processedLines,
            totalRecordLines(parser.records),
          );
          params.operationBudget.consumeResult({
            records: parser.records.length,
            decodedBytes: parser.decodedBytes,
            workUnits,
          });
        } catch (error) {
          protocolError =
            error instanceof GrepBoundaryError
              ? error
              : new GrepBoundaryError("RESULT_LIMIT", String(error));
        }
      }
      return {
        records: parser.records,
        decodedBytes: parser.decodedBytes,
        stderr: decodeBoundedDiagnostics(result.stderr),
        exitCode: result.exitCode,
        signal: result.signal,
        killedAfterLimit: result.killedAfterLimit || window.reached,
        aborted: result.aborted,
        processedLines: result.processedLines,
        ...(result.stopReason !== undefined
          ? { stopReason: result.stopReason }
          : {}),
        ...(result.spawnError !== undefined && helperProtocolError === undefined
          ? { spawnError: result.spawnError }
          : {}),
        ...(protocolError !== undefined ? { protocolError } : {}),
      };
    } catch (error) {
      return {
        records: [],
        decodedBytes: 0,
        stderr: "",
        exitCode: 127,
        signal: null,
        killedAfterLimit: false,
        aborted: params.signal?.aborted === true,
        processedLines: 0,
        spawnError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
  const { cwd, signal } = params;
  const command = applyRuntimeSandboxToSpawn({
    toolArgs: params.toolArgs,
    fallbackCwd: cwd,
    program: ripgrepPath,
    // RIPGREP_CONFIG_PATH may contain --pre=COMMAND. Never let ambient
    // operator configuration turn an audited read into arbitrary process
    // execution.
    args: processArgs,
    cwd,
    env: scrubEnvForChildProcess(process.env),
  });
  const parser = createCollectionWireParser(
    params.outputMode,
    params.maximumLines,
    params.operationBudget,
  );
  const window = new StreamingRipgrepWireWindow(
    params.outputMode,
    params.skipLines ?? 0,
    params.maximumLines,
  );
  let diagnosticBytes = 0;
  let killedAfterLimit = false;

  const result = await runSupervisedProcess(command, {
    timeoutMs,
    maxOutputBytes: RIPGREP_WIRE_MAX_OUTPUT_BYTES,
    captureStdout: false,
    ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
    signal,
    onStdout: (chunk, control) => {
      for (const part of window.push(chunk)) parser.push(part);
      const reached = window.reached;
      if (!killedAfterLimit && reached) {
        parser.finish({ allowPartial: true });
        killedAfterLimit = true;
        control.stop();
      }
    },
    onStderr: (chunk) => {
      diagnosticBytes += chunk.byteLength;
      if (diagnosticBytes > MAX_GREP_DIAGNOSTIC_BYTES) {
        throw diagnosticLimitError(diagnosticBytes);
      }
    },
  });

  const aborted = signal?.aborted === true || result.stopReason === "aborted";
  const intentionalLimitStop =
    killedAfterLimit && result.stopReason === "consumer_limit";
  let protocolError =
    result.error instanceof GrepBoundaryError ? result.error : undefined;
  if (
    protocolError === undefined &&
    !aborted &&
    result.stopReason !== "output_limit"
  ) {
    try {
      for (const part of window.finish({
        allowPartial:
          intentionalLimitStop ||
          result.stopReason !== undefined ||
          (result.exitCode !== 0 && result.exitCode !== 1),
      })) {
        parser.push(part);
      }
      if (intentionalLimitStop) {
        parser.finish({ allowPartial: true });
      } else if (
        (result.exitCode === 0 || result.exitCode === 1) &&
        result.stopReason === undefined
      ) {
        parser.finish();
      }
    } catch (error) {
      protocolError =
        error instanceof GrepBoundaryError
          ? error
          : new GrepBoundaryError("INVALID_WIRE_TEXT", String(error));
    }
  }

  if (protocolError === undefined && params.operationBudget !== undefined) {
    try {
      params.operationBudget.consumeResult({
        records: parser.records.length,
        decodedBytes: parser.decodedBytes,
        workUnits: window.processedLines,
      });
    } catch (error) {
      protocolError =
        error instanceof GrepBoundaryError
          ? error
          : new GrepBoundaryError("RESULT_LIMIT", String(error));
    }
  }

  return {
    records: parser.records,
    decodedBytes: parser.decodedBytes,
    stderr: decodeBoundedDiagnostics(result.stderr),
    exitCode:
      result.error !== undefined && result.exitCode === null
        ? 127
        : result.exitCode,
    signal: result.signal,
    killedAfterLimit,
    aborted,
    processedLines: window.processedLines,
    ...(result.stopReason !== undefined && !intentionalLimitStop
      ? { stopReason: result.stopReason }
      : {}),
    ...(result.error !== undefined &&
    !(result.error instanceof GrepBoundaryError)
      ? { spawnError: result.error }
      : {}),
    ...(protocolError !== undefined ? { protocolError } : {}),
  };
}

function normalizedResultPath(path: string, searchRoot: string): string {
  if (isWindowsAbsolutePath(path) || isWindowsAbsolutePath(searchRoot)) {
    return win32
      .normalize(
        isWindowsAbsolutePath(path) ? path : win32.resolve(searchRoot, path),
      )
      .toLowerCase();
  }
  // POSIX path spelling is identity. Existing APFS aliases are already
  // coalesced by the coordinator/filesystem canonicalization boundary.
  return resolve(isAbsolute(path) ? path : join(searchRoot, path));
}

function normalizedRelativeResultPath(path: string): string {
  const normalized = (
    process.platform === "win32" ? path.replace(/\\/gu, "/") : path
  ).replace(/^\.\/+/u, "");
  return normalized;
}

function filesystemObjectKey(value: {
  readonly dev: bigint;
  readonly ino: bigint;
}): string {
  return `${value.dev.toString(10)}:${value.ino.toString(10)}`;
}

function normalizedResultPathBytes(path: Buffer, searchRoot: string): string {
  const decoded = decodeRipgrepPathBytes(path);
  return decoded === undefined
    ? `raw-bytes:${path.toString("hex")}`
    : normalizedResultPath(decoded, searchRoot);
}

function filterDirtyDiskRecords(
  records: readonly RipgrepOutputRecord[],
  target: ResolvedTarget,
  snapshots: readonly WorkspaceAuthoritativeDirtySnapshot[],
): RipgrepOutputRecord[] {
  const dirtyPaths = new Set(
    snapshots.map((snapshot) =>
      normalizedResultPath(snapshot.path, target.displayRoot),
    ),
  );
  return records.filter(
    (record) =>
      !dirtyPaths.has(
        normalizedResultPathBytes(record.path, target.displayRoot),
      ),
  );
}

export function searchPathUsesDefaultExcludedDirectory(
  relativePath: string,
  includeIgnored: boolean,
): boolean {
  const segments = (
    process.platform === "win32"
      ? relativePath.replace(/\\/gu, "/")
      : relativePath
  ).split("/");
  if (
    segments.some((segment) =>
      (VCS_DIRECTORIES_TO_EXCLUDE as readonly string[]).includes(segment),
    )
  ) {
    return true;
  }
  return (
    !includeIgnored &&
    segments.some((segment) =>
      (DEFAULT_GENERATED_DIRECTORIES_TO_EXCLUDE as readonly string[]).includes(
        segment,
      ),
    )
  );
}

async function pinnedSnapshotPathEligibility(params: {
  readonly relativePaths: readonly string[];
  readonly globs: readonly string[];
  readonly type?: string;
  readonly signal?: AbortSignal;
  readonly deadline?: GrepOperationDeadline;
  /** Test-only scheduling seam; production callers leave this undefined. */
  readonly afterPlaceholder?: (index: number) => void | Promise<void>;
  /** Test-only cleanup seam; production callers leave this undefined. */
  readonly onTemporaryRoot?: (path: string) => void;
}): Promise<ReadonlySet<string> | { readonly error: string }> {
  const ripgrepPath = selectPinnedRipgrepPath();
  if (ripgrepPath === undefined) {
    return { error: PINNED_RIPGREP_UNAVAILABLE_MESSAGE };
  }
  if (params.relativePaths.length > MAX_GREP_PATH_ORACLE_ENTRIES) {
    return {
      error: `Grep error: dirty path oracle exceeds ${MAX_GREP_PATH_ORACLE_ENTRIES} entries`,
    };
  }
  const normalizedPaths = params.relativePaths.map(
    normalizedRelativeResultPath,
  );
  const collisionKeys = new Set<string>();
  let totalPathBytes = 0;
  for (const path of normalizedPaths) {
    totalPathBytes += Buffer.byteLength(path, "utf8");
    if (totalPathBytes > MAX_GREP_PATH_ORACLE_UTF8_BYTES) {
      return {
        error: `Grep error: dirty path oracle paths exceed ${MAX_GREP_PATH_ORACLE_UTF8_BYTES} UTF-8 bytes`,
      };
    }
    const segments = path.split("/");
    if (
      path.length === 0 ||
      path === ".." ||
      path.startsWith("../") ||
      isAbsolute(path) ||
      isWindowsAbsolutePath(path) ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\0") ||
          (process.platform === "win32" &&
            (WINDOWS_INVALID_PATH_SEGMENT.test(segment) ||
              WINDOWS_RESERVED_PATH_SEGMENT.test(segment) ||
              segment.endsWith(".") ||
              segment.endsWith(" "))),
      )
    ) {
      return {
        error:
          "Grep error: dirty snapshot path is not a portable relative path",
      };
    }
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (collisionKeys.has(key)) {
      return { error: "Grep error: dirty snapshot paths are not unique" };
    }
    collisionKeys.add(key);
  }
  for (const key of collisionKeys) {
    let separatorIndex = key.indexOf("/");
    while (separatorIndex >= 0) {
      if (collisionKeys.has(key.slice(0, separatorIndex))) {
        return {
          error:
            "Grep error: dirty snapshot paths contain a file/directory prefix collision",
        };
      }
      separatorIndex = key.indexOf("/", separatorIndex + 1);
    }
  }
  const args = [
    "--no-config",
    "--no-follow",
    "--files",
    "-0",
    "--hidden",
    "--no-ignore",
    "--sort",
    "path",
  ];
  if (params.type !== undefined) args.push("--type", params.type);
  for (const glob of params.globs) args.push("--glob", glob);
  args.push("--", ".");
  try {
    assertGrepArgvWithinLimits(ripgrepPath, args);
  } catch (error) {
    return { error: `Grep error: ${formatBoundaryError(error)}` };
  }
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agenc-grep-path-oracle-"),
  );
  params.onTemporaryRoot?.(temporaryRoot);
  try {
    const originalPathByObject = new Map<string, string | null>();
    for (const [index, relativePath] of normalizedPaths.entries()) {
      if (params.signal?.aborted) return { error: "Search aborted" };
      if (
        params.deadline !== undefined &&
        remainingGrepOperationMs(params.deadline) < 1
      ) {
        return { error: "Grep error: ripgrep timed out." };
      }
      const placeholder = join(temporaryRoot, ...relativePath.split("/"));
      await mkdir(dirname(placeholder), { recursive: true, mode: 0o700 });
      await writeFile(placeholder, Buffer.alloc(0), {
        flag: "wx",
        mode: 0o600,
      });
      const identity = filesystemObjectKey(
        await stat(placeholder, { bigint: true }),
      );
      originalPathByObject.set(
        identity,
        originalPathByObject.has(identity) ? null : relativePath,
      );
      await params.afterPlaceholder?.(index);
    }
    const timeoutMs =
      params.deadline === undefined
        ? MAX_GREP_WALL_MS
        : remainingGrepOperationMs(params.deadline);
    if (timeoutMs < 1) return { error: "Grep error: ripgrep timed out." };
    const result = await runSupervisedProcess(
      {
        program: ripgrepPath,
        args,
        cwd: temporaryRoot,
        env: scrubEnvForChildProcess(process.env),
      },
      {
        timeoutMs,
        maxOutputBytes: RIPGREP_WIRE_MAX_OUTPUT_BYTES,
        signal: params.signal,
      },
    );
    if (params.signal?.aborted || result.stopReason === "aborted") {
      return { error: "Search aborted" };
    }
    if (
      result.error !== undefined ||
      result.stopReason !== undefined ||
      (result.exitCode !== 0 && result.exitCode !== 1)
    ) {
      const detail =
        result.error?.message ??
        (result.stderr.toString("utf8").trim() || "ripgrep failed");
      return { error: `Grep error: ${detail}` };
    }
    const parser = createRipgrepWireParser("files_with_matches", {
      maxResults: normalizedPaths.length,
      maxContextRecords: 0,
    });
    try {
      if (result.stdout.byteLength > 0) parser.push(result.stdout);
      parser.finish();
    } catch (error) {
      return {
        error: `Grep error: ${formatBoundaryError(error)}`,
      };
    }
    const selected = new Set<string>();
    for (const record of parser.records) {
      const decoded = decodeRipgrepPathBytes(record.path);
      if (decoded === undefined) {
        return { error: "Grep error: path oracle emitted invalid UTF-8" };
      }
      const emittedPath = normalizedRelativeResultPath(decoded);
      const emittedIdentity = await stat(
        join(temporaryRoot, ...emittedPath.split("/")),
        { bigint: true },
      ).catch(() => undefined);
      const originalPath =
        emittedIdentity === undefined
          ? undefined
          : originalPathByObject.get(filesystemObjectKey(emittedIdentity));
      selected.add(originalPath ?? emittedPath);
    }
    return selected;
  } catch (error) {
    return {
      error: `Grep error: dirty path oracle failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function eligibleAuthoritativeSnapshots(params: {
  readonly snapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly opts: RipgrepOptions;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
  readonly ignoreReadCapability?: WorkspaceBoundReadCapability;
  readonly deadline?: GrepOperationDeadline;
}): Promise<
  readonly WorkspaceAuthoritativeDirtySnapshot[] | { readonly error: string }
> {
  const relativePaths = params.snapshots.map((snapshot) =>
    toRelativeIfInside(snapshot.path, params.target.searchRoot),
  );
  const selectedPaths =
    params.opts.globs.length === 0 && params.opts.type === undefined
      ? new Set(relativePaths.map(normalizedRelativeResultPath))
      : await pinnedSnapshotPathEligibility({
          relativePaths,
          globs: params.opts.globs,
          ...(params.opts.type !== undefined ? { type: params.opts.type } : {}),
          signal: params.signal,
          ...(params.deadline !== undefined
            ? { deadline: params.deadline }
            : {}),
        });
  if ("error" in selectedPaths) return selectedPaths;
  const isIgnored = params.opts.includeIgnored
    ? async (): Promise<boolean> => false
    : await createSearchIgnoreMatcher(params.target.displayRoot, {
        ...(params.ignoreReadCapability !== undefined
          ? { readCapability: params.ignoreReadCapability }
          : {}),
        ...(params.deadline !== undefined ? { deadline: params.deadline } : {}),
        respectVcsIgnores: params.target.respectVcsIgnores,
      });

  const eligible: WorkspaceAuthoritativeDirtySnapshot[] = [];
  for (const snapshot of params.snapshots) {
    if (
      params.deadline !== undefined &&
      remainingGrepOperationMs(params.deadline) < 1
    ) {
      return { error: "Grep error: ripgrep timed out." };
    }
    if (params.signal?.aborted) return { error: "Search aborted" };
    const relativePath = toRelativeIfInside(
      snapshot.path,
      params.target.searchRoot,
    );
    if (
      searchPathUsesDefaultExcludedDirectory(
        relativePath,
        params.opts.includeIgnored,
      ) ||
      !selectedPaths.has(normalizedRelativeResultPath(relativePath))
    ) {
      continue;
    }
    try {
      if (await isIgnored(snapshot.path)) continue;
    } catch (error) {
      return {
        error: `Grep error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    eligible.push(snapshot);
  }
  return eligible;
}

function attributeStdinResultRecord(
  record: RipgrepOutputRecord,
  snapshotPath: string,
): RipgrepOutputRecord | null {
  const decodedPath = decodeRipgrepPathBytes(record.path);
  if (decodedPath !== "<stdin>") return null;
  return { ...record, path: Buffer.from(snapshotPath, "utf8") };
}

async function collectAuthoritativeSnapshotRecords(params: {
  readonly snapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly opts: RipgrepOptions;
  readonly maximumLines?: number;
  readonly skipLines?: number;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
  readonly ignoreReadCapability?: WorkspaceBoundReadCapability;
  readonly deadline?: GrepOperationDeadline;
  readonly observer?: GrepToolConfig["__testProtectedTaskObserver"];
  readonly operationBudget: GrepOperationBudget;
}): Promise<
  | {
      readonly records: readonly RipgrepOutputRecord[];
      readonly truncated: boolean;
      readonly processedLines: number;
    }
  | { readonly error: string }
> {
  const eligible = await eligibleAuthoritativeSnapshots(params);
  if ("error" in eligible) return eligible;
  const maximumLines = params.maximumLines;
  const searchSnapshot = (
    snapshot: WorkspaceAuthoritativeDirtySnapshot,
    skipLines: number,
    retainedLineLimit: number | undefined,
    readCapability?: WorkspaceBoundReadCapability,
  ): Promise<LimitedRipgrepResult> =>
    runRipgrepCollectRecords({
      outputMode: params.opts.outputMode,
      args: buildRipgrepArgs({
        ...params.opts,
        absolutePath: "-",
        type: undefined,
        globs: [],
      }),
      cwd: ripgrepCwdForTarget(params.target),
      toolArgs: params.toolArgs,
      ...(retainedLineLimit !== undefined
        ? { maximumLines: retainedLineLimit }
        : {}),
      ...(skipLines > 0 ? { skipLines } : {}),
      stdin: snapshot.content,
      signal: params.signal,
      ...(readCapability !== undefined ? { readCapability } : {}),
      ...(params.deadline !== undefined ? { deadline: params.deadline } : {}),
      operationBudget: params.operationBudget,
    });
  const records: RipgrepOutputRecord[] = [];
  let collectedLines = 0;
  let processedLines = 0;
  let remainingSkip = params.skipLines ?? 0;
  let truncated = false;

  for (const [index, snapshot] of eligible.entries()) {
    if (params.signal?.aborted) return { error: "Search aborted" };
    if (maximumLines !== undefined && collectedLines >= maximumLines) {
      truncated = true;
      break;
    }
    const remainingLines =
      maximumLines === undefined ? undefined : maximumLines - collectedLines;
    params.observer?.({ phase: "start", source: "snapshot", index });
    let result: LimitedRipgrepResult;
    try {
      result = await searchSnapshot(
        snapshot,
        remainingSkip,
        remainingLines,
        params.readCapability,
      );
    } finally {
      params.observer?.({ phase: "finish", source: "snapshot", index });
    }
    if (params.signal?.aborted || result.aborted) {
      return { error: "Search aborted" };
    }
    if (result.spawnError !== undefined) {
      return { error: `Grep error: ${result.spawnError.message}` };
    }
    if (result.protocolError !== undefined) {
      return {
        error: `Grep error: ${formatBoundaryError(result.protocolError)}`,
      };
    }
    if (result.stopReason === "timeout") {
      return { error: "Grep error: ripgrep timed out." };
    }
    if (result.stopReason === "output_limit") {
      return {
        error: "Grep error: ripgrep exceeded the output safety limit.",
      };
    }
    if (
      result.exitCode !== 0 &&
      result.exitCode !== 1 &&
      !result.killedAfterLimit
    ) {
      const detail = result.stderr.trim() || "ripgrep failed";
      return { error: `Grep error: ${detail}` };
    }
    processedLines += result.processedLines;
    remainingSkip = Math.max(0, remainingSkip - result.processedLines);
    for (const record of result.records) {
      const attributed = attributeStdinResultRecord(record, snapshot.path);
      if (attributed !== null) {
        records.push(attributed);
        collectedLines += ripgrepRecordLineCount(attributed);
      }
    }
    if (
      result.killedAfterLimit ||
      (maximumLines !== undefined && collectedLines >= maximumLines)
    ) {
      truncated = true;
      break;
    }
  }
  return { records, truncated, processedLines };
}

function totalRecordLines(records: readonly RipgrepOutputRecord[]): number {
  let total = 0;
  for (const record of records) total += ripgrepRecordLineCount(record);
  return total;
}

function appendRecordsWithinLineLimit(
  first: readonly RipgrepOutputRecord[],
  second: readonly RipgrepOutputRecord[],
  maximumLines: number | undefined,
): {
  readonly records: readonly RipgrepOutputRecord[];
  readonly truncated: boolean;
} {
  if (maximumLines === undefined) {
    return { records: [...first, ...second], truncated: false };
  }
  const records: RipgrepOutputRecord[] = [];
  let renderedLines = 0;
  for (const source of [first, second]) {
    for (const record of source) {
      if (renderedLines >= maximumLines) {
        return { records, truncated: true };
      }
      records.push(record);
      renderedLines += ripgrepRecordLineCount(record);
    }
  }
  return { records, truncated: false };
}

function compareResultPaths(
  left: RipgrepOutputRecord,
  right: RipgrepOutputRecord,
  searchRoot: string,
): number {
  return Buffer.compare(
    Buffer.from(normalizedResultPathBytes(left.path, searchRoot), "utf8"),
    Buffer.from(normalizedResultPathBytes(right.path, searchRoot), "utf8"),
  );
}

function mergeCountRecordsByPath(params: {
  readonly authoritative: readonly RipgrepOutputRecord[];
  readonly disk: readonly RipgrepOutputRecord[];
  readonly searchRoot: string;
  readonly maximumLines?: number;
}): {
  readonly records: readonly RipgrepCountRecord[];
  readonly truncated: boolean;
} {
  const authoritative = params.authoritative
    .filter((record): record is RipgrepCountRecord => record.kind === "count")
    .toSorted((left, right) =>
      compareResultPaths(left, right, params.searchRoot),
    );
  const disk = params.disk.filter(
    (record): record is RipgrepCountRecord => record.kind === "count",
  );
  const records: RipgrepCountRecord[] = [];
  let authoritativeIndex = 0;
  let diskIndex = 0;
  while (authoritativeIndex < authoritative.length || diskIndex < disk.length) {
    if (
      params.maximumLines !== undefined &&
      records.length >= params.maximumLines
    ) {
      return { records, truncated: true };
    }
    const authoritativeRecord = authoritative[authoritativeIndex];
    const diskRecord = disk[diskIndex];
    if (authoritativeRecord === undefined) {
      records.push(diskRecord!);
      diskIndex += 1;
      continue;
    }
    if (diskRecord === undefined) {
      records.push(authoritativeRecord);
      authoritativeIndex += 1;
      continue;
    }
    const comparison = compareResultPaths(
      authoritativeRecord,
      diskRecord,
      params.searchRoot,
    );
    if (comparison <= 0) {
      records.push(authoritativeRecord);
      authoritativeIndex += 1;
      if (comparison === 0) diskIndex += 1;
    } else {
      records.push(diskRecord);
      diskIndex += 1;
    }
  }
  return { records, truncated: false };
}

async function runRipgrepGrep(params: {
  readonly opts: RipgrepOptions;
  readonly headLimit: number;
  readonly offset: number;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly authoritativeSnapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly requiresStrictCandidateReads: boolean;
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
  readonly discoveryReadCapability?: WorkspaceBoundReadCapability;
  readonly ignoreReadCapability?: WorkspaceBoundReadCapability;
  readonly deadline: GrepOperationDeadline;
  readonly observer?: GrepToolConfig["__testProtectedTaskObserver"];
  readonly operationBudgetLimits?: Partial<GrepOperationBudgetLimits>;
}): Promise<ToolResult> {
  const { opts, headLimit, offset, target, authoritativeSnapshots, signal } =
    params;
  const pageLines = headLimit === 0 ? undefined : headLimit + 1;
  const countMode = opts.outputMode === "count";
  const operationBudget = new GrepOperationBudget({
    maxRecords:
      params.operationBudgetLimits?.maxRecords ??
      (pageLines === undefined ? MAX_GREP_RESULTS : MAX_GREP_RESULTS + 1),
    maxDecodedBytes:
      params.operationBudgetLimits?.maxDecodedBytes ?? MAX_GREP_DECODED_BYTES,
    maxWorkUnits:
      params.operationBudgetLimits?.maxWorkUnits ??
      MAX_GREP_OPERATION_WORK_UNITS,
  });
  let authoritativeRecords: readonly RipgrepOutputRecord[] = [];
  let authoritativeTruncated = false;
  let authoritativeProcessedLines = 0;
  if (authoritativeSnapshots.length > 0) {
    const authoritative = await collectAuthoritativeSnapshotRecords({
      snapshots: authoritativeSnapshots,
      opts,
      ...(!countMode && pageLines !== undefined
        ? { maximumLines: pageLines }
        : {}),
      ...(!countMode && offset > 0 ? { skipLines: offset } : {}),
      target,
      toolArgs: params.toolArgs,
      signal,
      deadline: params.deadline,
      ...(params.observer !== undefined ? { observer: params.observer } : {}),
      operationBudget,
      ...(params.readCapability !== undefined
        ? { readCapability: params.readCapability }
        : {}),
      ...(params.ignoreReadCapability !== undefined
        ? { ignoreReadCapability: params.ignoreReadCapability }
        : {}),
    });
    if ("error" in authoritative) {
      return errorResult(authoritative.error);
    }
    authoritativeRecords = authoritative.records;
    authoritativeTruncated = authoritative.truncated;
    authoritativeProcessedLines = authoritative.processedLines;
  }
  const authoritativeLineCount = totalRecordLines(authoritativeRecords);
  const authoritativeCount = countMode ? authoritativeRecords.length : 0;
  const sourceSkipLines = countMode
    ? Math.max(0, offset - authoritativeCount)
    : Math.max(0, offset - authoritativeProcessedLines);
  const diskMaximumLines =
    pageLines === undefined
      ? undefined
      : countMode
        ? pageLines + authoritativeCount
        : Math.max(0, pageLines - authoritativeLineCount);
  const result: LimitedRipgrepResult =
    diskMaximumLines === 0
      ? emptyLimitedRipgrepResult()
      : params.readCapability === undefined
        ? target.existsOnDisk
          ? await runRipgrepCollectRecords({
              outputMode: opts.outputMode,
              args: buildRipgrepArgs(opts),
              cwd: ripgrepCwdForTarget(target),
              toolArgs: params.toolArgs,
              ...(diskMaximumLines !== undefined
                ? { maximumLines: diskMaximumLines }
                : {}),
              ...(sourceSkipLines > 0 ? { skipLines: sourceSkipLines } : {}),
              signal,
              deadline: params.deadline,
            })
          : emptyLimitedRipgrepResult()
        : !params.requiresStrictCandidateReads
          ? target.existsOnDisk
            ? await runRipgrepCollectRecords({
                outputMode: opts.outputMode,
                args: buildRipgrepArgs(opts),
                cwd: ripgrepCwdForTarget(target),
                toolArgs: params.toolArgs,
                ...(diskMaximumLines !== undefined
                  ? { maximumLines: diskMaximumLines }
                  : {}),
                ...(sourceSkipLines > 0 ? { skipLines: sourceSkipLines } : {}),
                signal,
                readCapability: params.readCapability,
                deadline: params.deadline,
                operationBudget,
              })
            : emptyLimitedRipgrepResult()
          : await collectDescriptorBoundDiskRecords({
              opts,
              ...(diskMaximumLines !== undefined
                ? { maximumLines: diskMaximumLines }
                : {}),
              ...(sourceSkipLines > 0 ? { skipLines: sourceSkipLines } : {}),
              target,
              toolArgs: params.toolArgs,
              authoritativeSnapshots,
              signal,
              readCapability: params.readCapability,
              ...(params.discoveryReadCapability !== undefined
                ? { discoveryReadCapability: params.discoveryReadCapability }
                : {}),
              deadline: params.deadline,
              ...(params.observer !== undefined
                ? { observer: params.observer }
                : {}),
              operationBudget,
            });
  if (signal?.aborted || result.aborted) {
    return errorResult("Search aborted");
  }
  if (result.spawnError) {
    return errorResult(`Grep error: ${result.spawnError.message}`);
  }
  if (result.protocolError !== undefined) {
    return errorResult(
      `Grep error: ${formatBoundaryError(result.protocolError)}`,
    );
  }
  if (result.stopReason === "timeout") {
    return errorResult(
      `Grep error [WALL_TIMEOUT]: pinned ripgrep exceeded ${MAX_GREP_WALL_MS}ms.`,
    );
  }
  if (result.stopReason === "output_limit") {
    return errorResult(
      `Grep error [WIRE_OUTPUT_LIMIT]: pinned ripgrep exceeded the bounded wire-output limit.`,
    );
  }
  if (
    result.exitCode === 1 &&
    result.records.length === 0 &&
    authoritativeSnapshots.length === 0
  ) {
    // Ripgrep convention: exit 1 = "no matches".
    return emptyRipgrepResultForMode(opts.outputMode, headLimit, offset);
  }
  if (
    result.exitCode !== 0 &&
    !result.killedAfterLimit &&
    !(result.exitCode === 1 && authoritativeSnapshots.length > 0)
  ) {
    const detail = result.stderr.trim() || "ripgrep failed";
    return errorResult(`Grep error: ${detail}`);
  }

  const diskRecords = filterDirtyDiskRecords(
    result.records,
    target,
    authoritativeSnapshots,
  );
  const merged =
    opts.outputMode === "count"
      ? mergeCountRecordsByPath({
          authoritative: authoritativeRecords,
          disk: diskRecords,
          searchRoot: target.displayRoot,
          ...(pageLines !== undefined
            ? {
                maximumLines: pageLines + Math.min(offset, authoritativeCount),
              }
            : {}),
        })
      : appendRecordsWithinLineLimit(
          authoritativeRecords,
          diskRecords,
          pageLines,
        );
  const rawRecords = merged.records;
  const mergeTruncated = merged.truncated;

  if (rawRecords.length === 0) {
    return emptyRipgrepResultForMode(opts.outputMode, headLimit, offset);
  }

  const displayRoot = displayRootForTarget(target);
  const retainedOffset = countMode ? offset - sourceSkipLines : 0;

  try {
    if (
      headLimit === 0 &&
      opts.outputMode !== "content" &&
      rawRecords.length > MAX_GREP_RESULTS
    ) {
      throw new GrepBoundaryError(
        "RESULT_LIMIT",
        `ripgrep results exceed ${MAX_GREP_RESULTS}`,
      );
    }
    if (opts.outputMode === "files_with_matches") {
      const selected = applyTruncation(rawRecords, headLimit, retainedOffset);
      const rendered = new BoundedRenderedLineCollector();
      for (const record of selected.items) {
        rendered.push(renderResultPath(record.path, displayRoot));
      }
      const formatted = formatFilesWithMatchesResult(
        rendered.lines,
        selected.truncated ||
          result.killedAfterLimit ||
          authoritativeTruncated ||
          mergeTruncated,
        headLimit,
        offset,
      );
      assertRenderedOutputWithinLimit(formatted.content);
      return formatted;
    }

    if (opts.outputMode === "count") {
      const counts = rawRecords.filter(
        (record): record is RipgrepCountRecord => record.kind === "count",
      );
      const selected = applyTruncation(counts, headLimit, retainedOffset);
      const rendered = new BoundedRenderedLineCollector();
      for (const record of selected.items) {
        rendered.push(
          `${renderResultPath(record.path, displayRoot)}:${record.count}`,
        );
      }
      const body = rendered.lines.join("\n");
      const summary = formatCountSummary(
        selected.items,
        selected.truncated ||
          result.killedAfterLimit ||
          authoritativeTruncated ||
          mergeTruncated,
        headLimit,
        offset,
      );
      const content = body.length > 0 ? `${body}\n\n${summary}` : summary;
      assertRenderedOutputWithinLimit(content);
      return textResult(content);
    }

    const content = renderContentRecordsWithinBudget({
      records: rawRecords.filter(
        (record): record is RipgrepContentRecord => record.kind === "content",
      ),
      displayRoot,
      showLineNumbers: opts.showLineNumbers,
      headLimit,
    });
    const body = content.items.join("\n");
    const pagination =
      content.truncated ||
      result.killedAfterLimit ||
      authoritativeTruncated ||
      mergeTruncated
        ? formatTruncationNote(headLimit, offset)
        : offset > 0
          ? formatOffsetNote(offset)
          : "";
    const rendered = pagination ? `${body}\n${pagination}` : body;
    assertRenderedOutputWithinLimit(rendered);
    return textResult(rendered);
  } catch (error) {
    if (error instanceof GrepBoundaryError) {
      return errorResult(`Grep error: ${formatBoundaryError(error)}`);
    }
    throw error;
  }
}

function emptyLimitedRipgrepResult(): LimitedRipgrepResult {
  return {
    records: [],
    decodedBytes: 0,
    stderr: "",
    exitCode: 1,
    signal: null,
    killedAfterLimit: false,
    aborted: false,
    processedLines: 0,
  };
}

function pinnedRipgrepUnavailableResult(): LimitedRipgrepResult {
  return {
    ...emptyLimitedRipgrepResult(),
    exitCode: 127,
    spawnError: new Error(PINNED_RIPGREP_UNAVAILABLE_MESSAGE),
  };
}

function descriptorRelativePath(
  candidatePath: string,
  capabilityRoot: string,
): string | undefined {
  const rel = relative(capabilityRoot, candidatePath);
  if (
    rel.length === 0 ||
    isAbsolute(rel) ||
    isWindowsAbsolutePath(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.split(sep).some((segment) => segment.length === 0 || segment === ".")
  ) {
    return undefined;
  }
  return rel;
}

function ripgrepFailure(
  result: LimitedRipgrepResult,
): LimitedRipgrepResult | undefined {
  if (
    result.aborted ||
    result.spawnError !== undefined ||
    result.protocolError !== undefined ||
    result.stopReason !== undefined ||
    (result.exitCode !== 0 && result.exitCode !== 1 && !result.killedAfterLimit)
  ) {
    return result;
  }
  return undefined;
}

async function collectDescriptorBoundContentFromSpool(params: {
  readonly opts: RipgrepOptions;
  readonly maximumLines?: number;
  readonly skipLines?: number;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly authoritativeSnapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly signal?: AbortSignal;
  readonly readCapability: WorkspaceBoundReadCapability;
  readonly discoveryReadCapability?: WorkspaceBoundReadCapability;
  readonly deadline?: GrepOperationDeadline;
  readonly observer?: GrepToolConfig["__testProtectedTaskObserver"];
  readonly operationBudget: GrepOperationBudget;
}): Promise<LimitedRipgrepResult> {
  const ripgrepPath = selectPinnedRipgrepPath();
  if (ripgrepPath === undefined) return pinnedRipgrepUnavailableResult();
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "agenc-grep-candidate-spool-"),
  );
  const spoolPath = join(temporaryRoot, "candidates.bin");
  const discoveryReadCapability =
    params.discoveryReadCapability ?? params.readCapability;
  try {
    const processArgs = [
      "--no-config",
      "--no-follow",
      ...buildRipgrepArgs({
        ...params.opts,
        outputMode: "files_with_matches",
        contextBefore: undefined,
        contextAfter: undefined,
        contextBoth: undefined,
      }),
    ];
    try {
      assertGrepArgvWithinLimits(ripgrepPath, processArgs);
    } catch (error) {
      return {
        ...emptyLimitedRipgrepResult(),
        exitCode: 127,
        protocolError:
          error instanceof GrepBoundaryError
            ? error
            : new GrepBoundaryError("ARGV_UTF8_LIMIT", String(error)),
      };
    }
    const timeoutMs =
      params.deadline === undefined
        ? MAX_GREP_WALL_MS
        : remainingGrepOperationMs(params.deadline);
    if (timeoutMs < 1) return operationTimedOutResult();
    const discovery = await discoveryReadCapability.runRipgrep({
      program: ripgrepPath,
      args: processArgs,
      env: scrubEnvForChildProcess(process.env),
      timeoutMs,
      maxOutputBytes: MAX_GREP_DIAGNOSTIC_BYTES,
      stdoutSpoolPath: spoolPath,
      maxSpoolBytes: MAX_GREP_DECODED_BYTES,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
    if (params.signal?.aborted || discovery.aborted) {
      return {
        ...emptyLimitedRipgrepResult(),
        aborted: true,
        stopReason: "aborted",
      };
    }
    if (discovery.spawnError !== undefined) {
      return {
        ...emptyLimitedRipgrepResult(),
        exitCode: 127,
        spawnError: discovery.spawnError,
      };
    }
    if (discovery.stopReason !== undefined) {
      return {
        ...emptyLimitedRipgrepResult(),
        exitCode: discovery.exitCode,
        stopReason: discovery.stopReason,
      };
    }
    if (discovery.exitCode !== 0 && discovery.exitCode !== 1) {
      return {
        ...emptyLimitedRipgrepResult(),
        exitCode: discovery.exitCode,
        spawnError: new Error(
          discovery.stderr.toString("utf8").trim() || "ripgrep failed",
        ),
      };
    }

    const dirtyDiskPaths = new Set(
      params.authoritativeSnapshots.map((snapshot) =>
        normalizedResultPath(snapshot.path, params.target.displayRoot),
      ),
    );
    const records: RipgrepOutputRecord[] = [];
    let decodedBytes = 0;
    let collectedLines = 0;
    let processedLines = 0;
    let remainingSkip = params.skipLines ?? 0;
    let killedAfterLimit = false;
    let terminalResult: LimitedRipgrepResult | undefined;
    await readNulDelimitedCandidateSpool({
      path: spoolPath,
      signal: params.signal,
      ...(params.deadline !== undefined ? { deadline: params.deadline } : {}),
      visit: async (path, index) => {
        try {
          params.operationBudget.consumeWork(1);
        } catch (error) {
          terminalResult = {
            ...emptyLimitedRipgrepResult(),
            exitCode: 127,
            protocolError:
              error instanceof GrepBoundaryError
                ? error
                : new GrepBoundaryError("RESULT_LIMIT", String(error)),
          };
          return false;
        }
        const decoded = decodeRipgrepPathBytes(path);
        if (decoded === undefined) {
          terminalResult = {
            ...emptyLimitedRipgrepResult(),
            exitCode: 127,
            protocolError: new GrepBoundaryError(
              "INVALID_WIRE_TEXT",
              "descriptor-bound discovery cannot reopen a non-UTF-8 path",
            ),
          };
          return false;
        }
        const candidatePath = normalizedResultPath(
          decoded,
          discoveryReadCapability.rootPath,
        );
        if (!isPathInsideRoot(candidatePath, params.target.absolute)) {
          terminalResult = {
            ...emptyLimitedRipgrepResult(),
            exitCode: 127,
            protocolError: new GrepBoundaryError(
              "INVALID_WIRE_TEXT",
              "descriptor-bound discovery returned a candidate outside the requested search root",
            ),
          };
          return false;
        }
        if (dirtyDiskPaths.has(candidatePath)) return true;
        const relativeInputFile = descriptorRelativePath(
          candidatePath,
          params.readCapability.rootPath,
        );
        if (relativeInputFile === undefined) {
          terminalResult = {
            ...emptyLimitedRipgrepResult(),
            exitCode: 127,
            spawnError: new Error(
              "descriptor-bound ripgrep returned a candidate outside its authenticated root",
            ),
          };
          return false;
        }
        const remainingLines =
          params.maximumLines === undefined
            ? undefined
            : params.maximumLines - collectedLines;
        params.observer?.({ phase: "start", source: "disk", index });
        let verified: LimitedRipgrepResult;
        try {
          verified = await runRipgrepCollectRecords({
            outputMode: "content",
            args: buildRipgrepArgs({
              ...params.opts,
              absolutePath: "-",
              type: undefined,
              globs: [],
            }),
            cwd: params.readCapability.rootPath,
            toolArgs: params.toolArgs,
            ...(remainingLines !== undefined
              ? { maximumLines: remainingLines }
              : {}),
            ...(remainingSkip > 0 ? { skipLines: remainingSkip } : {}),
            relativeInputFile,
            signal: params.signal,
            readCapability: params.readCapability,
            ...(params.deadline !== undefined
              ? { deadline: params.deadline }
              : {}),
            operationBudget: params.operationBudget,
          });
        } finally {
          params.observer?.({ phase: "finish", source: "disk", index });
        }
        const failure = ripgrepFailure(verified);
        if (failure !== undefined) {
          terminalResult = failure;
          return false;
        }
        decodedBytes += verified.decodedBytes;
        processedLines += verified.processedLines;
        remainingSkip = Math.max(0, remainingSkip - verified.processedLines);
        for (const record of verified.records) {
          const attributed = attributeStdinResultRecord(record, candidatePath);
          if (attributed === null) continue;
          records.push(attributed);
          collectedLines += ripgrepRecordLineCount(attributed);
        }
        if (
          verified.killedAfterLimit ||
          (params.maximumLines !== undefined &&
            collectedLines >= params.maximumLines)
        ) {
          killedAfterLimit = true;
          return false;
        }
        return params.signal?.aborted !== true;
      },
    });
    if (terminalResult !== undefined) return terminalResult;
    if (params.signal?.aborted) {
      return {
        ...emptyLimitedRipgrepResult(),
        aborted: true,
        stopReason: "aborted",
      };
    }
    if (
      params.deadline !== undefined &&
      remainingGrepOperationMs(params.deadline) < 1
    ) {
      return operationTimedOutResult();
    }
    return {
      records,
      decodedBytes,
      stderr: "",
      exitCode: records.length > 0 ? 0 : 1,
      signal: null,
      killedAfterLimit,
      aborted: false,
      processedLines,
    };
  } catch (error) {
    return {
      ...emptyLimitedRipgrepResult(),
      exitCode: 127,
      protocolError:
        error instanceof GrepBoundaryError
          ? error
          : new GrepBoundaryError(
              "INVALID_WIRE_TEXT",
              error instanceof Error ? error.message : String(error),
            ),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Protected Editor searches deliberately separate discovery from rendering.
 *
 * The discovery process runs only against literal `.` under the authenticated
 * helper cwd. Its output is treated as untrusted candidate metadata: every
 * candidate is reopened by a one-shot descriptor worker that traverses one
 * parent basename at a time, proves before/opened/after leaf identity (and adds
 * O_NOFOLLOW when available), then wires that fd to a second ripgrep invocation
 * via stdin. Only the second invocation's bytes can reach the tool result.
 */
async function collectDescriptorBoundDiskRecords(params: {
  readonly opts: RipgrepOptions;
  readonly maximumLines?: number;
  readonly skipLines?: number;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly authoritativeSnapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly signal?: AbortSignal;
  readonly readCapability: WorkspaceBoundReadCapability;
  readonly discoveryReadCapability?: WorkspaceBoundReadCapability;
  readonly deadline?: GrepOperationDeadline;
  readonly observer?: GrepToolConfig["__testProtectedTaskObserver"];
  readonly operationBudget: GrepOperationBudget;
}): Promise<LimitedRipgrepResult> {
  if (!params.target.existsOnDisk) return emptyLimitedRipgrepResult();

  if (params.target.isDirectory && params.opts.outputMode === "content") {
    return collectDescriptorBoundContentFromSpool(params);
  }

  const maximumLines = params.maximumLines;
  const discoveryReadCapability =
    params.discoveryReadCapability ?? params.readCapability;
  const dirtyDiskPaths = new Set(
    params.authoritativeSnapshots.map((snapshot) =>
      normalizedResultPath(snapshot.path, params.target.searchRoot),
    ),
  );
  let candidatePaths: string[];
  let discoveryTruncated = false;
  let discoveryProcessedLines = 0;
  if (params.target.isDirectory) {
    const discoveryOutputMode: OutputMode =
      params.opts.outputMode === "count" ? "count" : "files_with_matches";
    const excludedPaths = params.authoritativeSnapshots
      .map((snapshot) =>
        relative(discoveryReadCapability.rootPath, snapshot.path),
      )
      .filter(
        (path) =>
          path.length > 0 &&
          !isAbsolute(path) &&
          !isWindowsAbsolutePath(path) &&
          path !== ".." &&
          !path.startsWith(`..${sep}`),
      )
      .map((path) =>
        process.platform === "win32" ? path.replace(/\\/gu, "/") : path,
      );
    const contentMode = params.opts.outputMode === "content";
    const requestedSkip = params.skipLines ?? 0;
    const discoveryMaximumLines = contentMode
      ? requestedSkip + (maximumLines ?? MAX_GREP_RESULTS)
      : maximumLines;
    const discovery = await runRipgrepCollectRecords({
      outputMode: discoveryOutputMode,
      args: buildRipgrepArgs({
        ...params.opts,
        absolutePath: params.opts.absolutePath,
        outputMode: discoveryOutputMode,
        contextBefore: undefined,
        contextAfter: undefined,
        contextBoth: undefined,
      }),
      cwd: discoveryReadCapability.rootPath,
      toolArgs: params.toolArgs,
      ...(discoveryMaximumLines !== undefined && discoveryMaximumLines > 0
        ? { maximumLines: discoveryMaximumLines }
        : {}),
      ...(!contentMode && requestedSkip > 0
        ? { skipLines: params.skipLines }
        : {}),
      ...(excludedPaths.length > 0 ? { excludedPaths } : {}),
      signal: params.signal,
      readCapability: discoveryReadCapability,
      ...(params.deadline !== undefined ? { deadline: params.deadline } : {}),
    });
    const discoveryFailure = ripgrepFailure(discovery);
    if (discoveryFailure !== undefined) return discoveryFailure;
    discoveryTruncated = discovery.killedAfterLimit;
    discoveryProcessedLines = discovery.processedLines;
    const seen = new Set<string>();
    candidatePaths = [];
    for (const record of discovery.records) {
      const decoded = decodeRipgrepPathBytes(record.path);
      if (decoded === undefined) {
        return {
          ...emptyLimitedRipgrepResult(),
          exitCode: 127,
          protocolError: new GrepBoundaryError(
            "INVALID_WIRE_TEXT",
            "descriptor-bound discovery cannot reopen a non-UTF-8 path",
          ),
        };
      }
      const candidate = normalizedResultPath(
        decoded,
        discoveryReadCapability.rootPath,
      );
      if (!isPathInsideRoot(candidate, params.target.absolute)) {
        return {
          ...emptyLimitedRipgrepResult(),
          exitCode: 127,
          protocolError: new GrepBoundaryError(
            "INVALID_WIRE_TEXT",
            "descriptor-bound discovery returned a candidate outside the requested search root",
          ),
        };
      }
      if (dirtyDiskPaths.has(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      candidatePaths.push(candidate);
    }
    try {
      params.operationBudget.consumeWork(candidatePaths.length);
    } catch (error) {
      return {
        ...emptyLimitedRipgrepResult(),
        exitCode: 127,
        protocolError:
          error instanceof GrepBoundaryError
            ? error
            : new GrepBoundaryError("RESULT_LIMIT", String(error)),
      };
    }
  } else {
    candidatePaths = [
      normalizedResultPath(params.target.absolute, params.target.searchRoot),
    ];
  }

  const verifyCandidate = async (
    candidatePath: string,
    capability: WorkspaceBoundReadCapability,
    skipLines: number,
    retainedLineLimit: number | undefined,
  ): Promise<LimitedRipgrepResult> => {
    const relativeInputFile = descriptorRelativePath(
      candidatePath,
      capability.rootPath,
    );
    if (relativeInputFile === undefined) {
      return {
        ...emptyLimitedRipgrepResult(),
        exitCode: 127,
        spawnError: new Error(
          "descriptor-bound ripgrep returned a candidate outside its authenticated root",
        ),
      };
    }
    return runRipgrepCollectRecords({
      outputMode: params.opts.outputMode,
      args: buildRipgrepArgs({
        ...params.opts,
        absolutePath: "-",
        type: undefined,
        globs: [],
      }),
      cwd: capability.rootPath,
      toolArgs: params.toolArgs,
      ...(retainedLineLimit !== undefined
        ? { maximumLines: retainedLineLimit }
        : {}),
      ...(skipLines > 0 ? { skipLines } : {}),
      relativeInputFile,
      signal: params.signal,
      readCapability: capability,
      ...(params.deadline !== undefined ? { deadline: params.deadline } : {}),
      operationBudget: params.operationBudget,
    });
  };

  const records: RipgrepOutputRecord[] = [];
  let decodedBytes = 0;
  let collectedLines = 0;
  let processedLines = 0;
  let killedAfterLimit = discoveryTruncated;
  let remainingSkip = params.skipLines ?? 0;
  const verifiedResults =
    params.opts.outputMode === "content"
      ? undefined
      : await mapProtectedRipgrepTasks({
          items: candidatePaths,
          primaryCapability: params.readCapability,
          target: params.target,
          source: "disk",
          ...(params.observer !== undefined
            ? { observer: params.observer }
            : {}),
          signal: params.signal,
          ...(params.deadline !== undefined
            ? { deadline: params.deadline }
            : {}),
          task: (candidatePath, capability) =>
            verifyCandidate(candidatePath, capability, 0, maximumLines),
          shouldStop: (result) => ripgrepFailure(result) !== undefined,
        });
  if (
    params.deadline !== undefined &&
    remainingGrepOperationMs(params.deadline) < 1
  ) {
    return operationTimedOutResult();
  }
  for (const [index, candidatePath] of candidatePaths.entries()) {
    if (params.signal?.aborted) {
      return {
        ...emptyLimitedRipgrepResult(),
        aborted: true,
        stopReason: "aborted",
      };
    }
    if (maximumLines !== undefined && collectedLines >= maximumLines) {
      killedAfterLimit = true;
      break;
    }
    let verified: LimitedRipgrepResult;
    if (verifiedResults === undefined) {
      const remainingLines =
        maximumLines === undefined ? undefined : maximumLines - collectedLines;
      params.observer?.({ phase: "start", source: "disk", index });
      try {
        verified = await verifyCandidate(
          candidatePath,
          params.readCapability,
          remainingSkip,
          remainingLines,
        );
      } finally {
        params.observer?.({ phase: "finish", source: "disk", index });
      }
    } else {
      verified = verifiedResults[index] as LimitedRipgrepResult;
    }
    const verifiedFailure = ripgrepFailure(verified);
    if (verifiedFailure !== undefined) return verifiedFailure;
    decodedBytes += verified.decodedBytes;
    processedLines += verified.processedLines;
    remainingSkip = Math.max(0, remainingSkip - verified.processedLines);
    for (const record of verified.records) {
      const attributed = attributeStdinResultRecord(record, candidatePath);
      if (attributed !== null) {
        records.push(attributed);
        collectedLines += ripgrepRecordLineCount(attributed);
      }
    }
    if (
      verified.killedAfterLimit ||
      (maximumLines !== undefined && collectedLines >= maximumLines)
    ) {
      killedAfterLimit = true;
      break;
    }
  }
  return {
    records,
    decodedBytes,
    stderr: "",
    exitCode: records.length > 0 ? 0 : 1,
    signal: null,
    killedAfterLimit,
    aborted: false,
    processedLines:
      params.opts.outputMode === "content"
        ? processedLines
        : discoveryProcessedLines,
  };
}

async function discoverSearchRootIgnoreFiles(params: {
  readonly target: ResolvedTarget;
  readonly readCapability?: WorkspaceBoundReadCapability;
  readonly deadline: GrepOperationDeadline;
}): Promise<readonly RipgrepIgnoreFileSnapshot[]> {
  if (resolve(params.target.absolute) === resolve(params.target.displayRoot)) {
    return [];
  }
  const snapshots: RipgrepIgnoreFileSnapshot[] = [];
  for (const fileName of SEARCH_IGNORE_FILES) {
    if (remainingGrepOperationMs(params.deadline) < 1) {
      throw new Error("ripgrep timed out while loading search ignore files");
    }
    if (params.readCapability !== undefined) {
      const file = await params.readCapability.readRelativeFileIfExists(
        fileName,
        MAX_SEARCH_IGNORE_FILE_BYTES,
      );
      if (file !== undefined) {
        snapshots.push({ sourceName: fileName, content: file.content });
      }
      continue;
    }
    const candidate = join(params.target.displayRoot, fileName);
    const content = await readVerifiedRipgrepIgnoreFile({
      path: candidate,
      allowedRoot: params.target.displayRoot,
      maximumBytes: MAX_SEARCH_IGNORE_FILE_BYTES,
    });
    if (content !== undefined) {
      snapshots.push({ sourceName: fileName, content });
    }
  }
  return snapshots;
}

export async function createSearchIgnoreMatcher(
  displayRoot: string,
  options: {
    readonly readCapability?: WorkspaceBoundReadCapability;
    readonly deadline?: GrepOperationDeadline;
    readonly respectVcsIgnores?: boolean;
  } = {},
): Promise<(path: string) => Promise<boolean>> {
  const cache = new Map<string, ReturnType<typeof ignore> | undefined>();
  let totalBytes = 0;

  async function readPublicIgnoreFile(
    path: string,
  ): Promise<Buffer | undefined> {
    const handle = await open(path, "r").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (handle === undefined) return undefined;
    try {
      const buffer = Buffer.alloc(MAX_SEARCH_IGNORE_FILE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_SEARCH_IGNORE_FILE_BYTES) {
        throw new Error(`search ignore file exceeds its byte limit: ${path}`);
      }
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async function readIgnoreFile(path: string): Promise<string | undefined> {
    if (
      options.deadline !== undefined &&
      remainingGrepOperationMs(options.deadline) < 1
    ) {
      throw new Error("ripgrep timed out while loading search ignore files");
    }
    let content: Buffer | undefined;
    if (options.readCapability === undefined) {
      content = await readPublicIgnoreFile(path);
    } else {
      const relativePath = descriptorRelativePath(
        path,
        options.readCapability.rootPath,
      );
      if (relativePath === undefined) {
        throw new Error(
          "search ignore file is outside the authenticated read root",
        );
      }
      const read = await options.readCapability.readRelativeFileIfExists(
        relativePath,
        MAX_SEARCH_IGNORE_FILE_BYTES,
      );
      content = read?.content;
    }
    if (content === undefined) return undefined;
    totalBytes += content.byteLength;
    if (totalBytes > MAX_SEARCH_IGNORE_TOTAL_BYTES) {
      throw new Error("search ignore files exceed their aggregate byte limit");
    }
    if (content.includes(0)) {
      throw new Error(`search ignore file contains NUL: ${path}`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error(`search ignore file is not valid UTF-8: ${path}`);
    }
  }

  async function matcherForDirectory(
    directory: string,
  ): Promise<ReturnType<typeof ignore> | undefined> {
    if (cache.has(directory)) return cache.get(directory);
    const matcher = ignore();
    let loaded = false;
    for (const fileName of SEARCH_IGNORE_FILES) {
      if (fileName === ".gitignore" && options.respectVcsIgnores === false) {
        continue;
      }
      const content = await readIgnoreFile(join(directory, fileName));
      if (content === undefined) continue;
      matcher.add(content);
      loaded = true;
    }
    const result = loaded ? matcher : undefined;
    cache.set(directory, result);
    return result;
  }

  return async (path) => {
    const directories: string[] = [];
    let current = dirname(path);
    while (isPathInsideRoot(current, displayRoot)) {
      directories.push(current);
      if (current === displayRoot) break;
      current = dirname(current);
    }
    directories.reverse();
    if (directories.length > MAX_SEARCH_IGNORE_DIRECTORIES) {
      throw new Error("search ignore traversal exceeds its directory limit");
    }
    let ignored = false;
    for (const [index, directory] of directories.entries()) {
      const matcher = await matcherForDirectory(directory);
      if (matcher === undefined) continue;
      for (const descendantDirectory of directories.slice(index + 1)) {
        const relativeDirectory = toRelativeIfInside(
          descendantDirectory,
          directory,
        );
        const ignoreRelativeDirectory =
          process.platform === "win32"
            ? relativeDirectory.replace(/\\/gu, "/")
            : relativeDirectory;
        if (matcher.test(`${ignoreRelativeDirectory}/`).ignored) {
          // Git and ripgrep prune an excluded directory and therefore never
          // load ignore files below it. A nested negation cannot resurrect a
          // file unless the parent directory itself was made traversable.
          return true;
        }
      }
      const relativePath = toRelativeIfInside(path, directory);
      const rel =
        process.platform === "win32"
          ? relativePath.replace(/\\/gu, "/")
          : relativePath;
      const result = matcher.test(rel);
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return ignored;
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tool factory
// ────────────────────────────────────────────────────────────────────────

export function createGrepTool(config?: GrepToolConfig): Tool {
  // Default to process.cwd() when caller doesn't pass an allowlist (mirrors
  // the AgenC default of `getCwd()`). Production wiring always passes
  // an allowlist via the runtime; this default keeps the factory ergonomic
  // for one-off harness use.
  const allowedPaths =
    config?.allowedPaths && config.allowedPaths.length > 0
      ? config.allowedPaths
      : [process.cwd()];
  const beforeAuthoritativeSnapshotValidation =
    config?.beforeAuthoritativeSnapshotValidation;
  const afterFinalPathCheck = config?.__testAfterFinalPathCheck;
  const protectedTaskObserver = config?.__testProtectedTaskObserver;
  const operationBudgetLimits = config?.__testOperationBudgetLimits;
  const afterRootIgnoreSnapshot = config?.__testAfterRootIgnoreSnapshot;

  return {
    name: GREP_TOOL_NAME,
    description: GREP_DESCRIPTION,
    metadata: {
      family: "search",
      source: "builtin",
      keywords: ["grep", "search", "ripgrep", "rg", "find", "regex"],
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
    },
    isReadOnly: true,
    recoveryCategory: "idempotent",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          minLength: 1,
          maxLength: MAX_GREP_PATTERN_UTF8_BYTES,
          "x-agenc-maxUtf8Bytes": MAX_GREP_PATTERN_UTF8_BYTES,
          description:
            "The regular expression pattern to search for in file contents",
        },
        path: {
          type: "string",
          maxLength: MAX_GREP_RAW_PATH_UTF8_BYTES,
          "x-agenc-maxUtf8Bytes": MAX_GREP_RAW_PATH_UTF8_BYTES,
          description:
            "File or directory to search in (rg PATH). Defaults to current working directory.",
        },
        glob: {
          type: "string",
          maxLength: MAX_GREP_RAW_GLOB_UTF8_BYTES,
          "x-agenc-maxUtf8Bytes": MAX_GREP_RAW_GLOB_UTF8_BYTES,
          "x-agenc-maxEntries": MAX_GREP_GLOBS,
          "x-agenc-maxEntryUtf8Bytes": MAX_GREP_GLOB_UTF8_BYTES,
          description:
            'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths, "count" shows match counts. Defaults to "files_with_matches".',
        },
        "-B": {
          type: "integer",
          minimum: 0,
          maximum: MAX_GREP_CONTEXT_LINES,
          description:
            'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
        },
        "-A": {
          type: "integer",
          minimum: 0,
          maximum: MAX_GREP_CONTEXT_LINES,
          description:
            'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
        },
        "-C": {
          type: "integer",
          minimum: 0,
          maximum: MAX_GREP_CONTEXT_LINES,
          description:
            'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
        },
        context: {
          type: "integer",
          minimum: 0,
          maximum: MAX_GREP_CONTEXT_LINES,
          description:
            'Alias for "-C": number of lines to show before and after each match. Requires output_mode: "content", ignored otherwise.',
        },
        "-n": {
          type: "boolean",
          description:
            'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
        },
        "-i": {
          type: "boolean",
          description: "Case insensitive search (rg -i)",
        },
        type: {
          type: "string",
          maxLength: MAX_GREP_TYPE_UTF8_BYTES,
          "x-agenc-maxUtf8Bytes": MAX_GREP_TYPE_UTF8_BYTES,
          description:
            "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
        },
        head_limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_GREP_HEAD_LIMIT,
          description:
            'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes. Defaults to 250. Pass 0 for unpaginated output up to the hard search safety ceilings.',
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: MAX_GREP_OFFSET,
          description:
            'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Defaults to 0.',
        },
        multiline: {
          type: "boolean",
          description:
            "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
        },
        includeIgnored: {
          type: "boolean",
          description:
            "Search gitignored and build/vendored output too (node_modules, target, dist, build, .localnet). Defaults to false: the search respects .gitignore and skips generated/build dirs.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as GrepInput;
      const normalized = normalizeGrepInput(args);
      if ("error" in normalized) return errorResult(normalized.error);
      const ripgrepPath = selectPinnedRipgrepPath();
      if (ripgrepPath === undefined) {
        return errorResult(PINNED_RIPGREP_UNAVAILABLE_MESSAGE);
      }
      const prospectiveOptions: RipgrepOptions = {
        pattern: normalized.pattern,
        absolutePath: normalized.explicitPath ?? ".",
        outputMode: normalized.outputMode,
        caseInsensitive: normalized.caseInsensitive,
        showLineNumbers: normalized.showLineNumbers,
        multiline: normalized.multiline,
        includeIgnored: normalized.includeIgnored,
        contextBefore: normalized.contextBefore,
        contextAfter: normalized.contextAfter,
        contextBoth: normalized.contextBoth,
        type: normalized.type,
        globs: normalized.globs,
        respectVcsIgnores: true,
      };
      try {
        assertGrepArgvWithinLimits(ripgrepPath, [
          "--no-config",
          "--no-follow",
          ...buildRipgrepArgs(prospectiveOptions),
        ]);
      } catch (error) {
        return errorResult(`Grep error: ${formatBoundaryError(error)}`);
      }

      const target = await resolveSearchPath({
        args: rawArgs,
        config: { allowedPaths },
        explicitPath: normalized.explicitPath,
      });
      if ("error" in target) {
        return errorResult(target.error);
      }
      let readCapability: WorkspaceBoundReadCapability | undefined;
      let toolOperation: WorkspaceToolOperationToken | undefined;
      let requiresStrictCandidateReads = false;
      try {
        const operation = beginWorkspaceReadToolOperation(
          target.displayRoot,
          GREP_TOOL_NAME,
        );
        toolOperation = operation.token;
        requiresStrictCandidateReads = operation.requiresStrictCandidateReads;
        readCapability = requiresStrictCandidateReads
          ? await bindTargetReadCapability(target)
          : await bindWorkspaceDirectoryReadCapability(target.displayRoot, {
              expectedIdentity: target.displayRootIdentity,
            });
      } catch (error) {
        if (toolOperation !== undefined) {
          endWorkspaceToolOperation(toolOperation);
        }
        return editorCoherenceError(error);
      }
      let ownedIgnoreReadCapability: WorkspaceBoundReadCapability | undefined;
      let materializedIgnoreFiles: MaterializedRipgrepIgnoreFiles | undefined;

      try {
        let ignoreReadCapability = readCapability;
        if (
          readCapability !== undefined &&
          resolve(readCapability.rootPath) !== resolve(target.displayRoot)
        ) {
          try {
            ownedIgnoreReadCapability =
              await bindWorkspaceDirectoryReadCapability(target.displayRoot, {
                expectedIdentity: target.displayRootIdentity,
              });
            ignoreReadCapability = ownedIgnoreReadCapability;
          } catch (error) {
            return editorCoherenceError(error);
          }
        }
        let authoritativeCapture: ReturnType<
          typeof captureWorkspaceAuthoritativeDirtySnapshots
        >;
        try {
          authoritativeCapture = captureWorkspaceAuthoritativeDirtySnapshots(
            target.absolute,
            { includeDescendants: target.isDirectory },
          );
        } catch (error) {
          return editorCoherenceError(error);
        }
        const authoritativeSnapshots = authoritativeCapture.snapshots;
        await afterFinalPathCheck?.();
        const finalizeAuthoritativeResult = async (
          result: ToolResult,
        ): Promise<ToolResult> => {
          await beforeAuthoritativeSnapshotValidation?.();
          try {
            return authoritativeCapture.isCurrent()
              ? result
              : editorCoherenceError();
          } catch (error) {
            return editorCoherenceError(error);
          }
        };

        const signal = args.__abortSignal;
        const deadline = createGrepOperationDeadline();
        let rootIgnoreSnapshots: readonly RipgrepIgnoreFileSnapshot[];
        try {
          rootIgnoreSnapshots = normalized.includeIgnored
            ? []
            : await discoverSearchRootIgnoreFiles({
                target,
                ...(ignoreReadCapability !== undefined
                  ? { readCapability: ignoreReadCapability }
                  : {}),
                deadline,
              });
        } catch (error) {
          return finalizeAuthoritativeResult(editorCoherenceError(error));
        }
        await afterRootIgnoreSnapshot?.();
        try {
          materializedIgnoreFiles =
            await materializeRipgrepIgnoreFiles(rootIgnoreSnapshots);
        } catch (error) {
          return finalizeAuthoritativeResult(editorCoherenceError(error));
        }
        const ripgrepOptions: RipgrepOptions = {
          ...prospectiveOptions,
          absolutePath: ripgrepSearchPathForTarget(target),
          respectVcsIgnores: target.respectVcsIgnores,
          rootIgnoreFiles: materializedIgnoreFiles.paths,
        };
        try {
          assertGrepArgvWithinLimits(ripgrepPath, [
            "--no-config",
            "--no-follow",
            ...buildRipgrepArgs(ripgrepOptions),
          ]);
        } catch (error) {
          return finalizeAuthoritativeResult(
            errorResult(`Grep error: ${formatBoundaryError(error)}`),
          );
        }

        const cwdForProbe = ripgrepCwdForTarget(target) || process.cwd();
        const ripgrepReady = await isRipgrepAvailable(
          cwdForProbe,
          rawArgs,
          signal,
          readCapability,
          deadline,
        );

        if (signal?.aborted) {
          return finalizeAuthoritativeResult(errorResult("Search aborted"));
        }

        if (remainingGrepOperationMs(deadline) < 1) {
          return finalizeAuthoritativeResult(
            errorResult(
              `Grep error [WALL_TIMEOUT]: pinned ripgrep exceeded ${MAX_GREP_WALL_MS}ms.`,
            ),
          );
        }

        if (!ripgrepReady) {
          return finalizeAuthoritativeResult(
            errorResult(PINNED_RIPGREP_UNAVAILABLE_MESSAGE),
          );
        }

        const discoveryReadCapability =
          readCapability !== undefined && target.isDirectory
            ? ignoreReadCapability
            : readCapability;
        return finalizeAuthoritativeResult(
          await runRipgrepGrep({
            opts: ripgrepOptions,
            headLimit: normalized.headLimit,
            offset: normalized.offset,
            target,
            toolArgs: rawArgs,
            authoritativeSnapshots,
            requiresStrictCandidateReads,
            signal,
            deadline,
            ...(protectedTaskObserver !== undefined
              ? { observer: protectedTaskObserver }
              : {}),
            ...(operationBudgetLimits !== undefined
              ? { operationBudgetLimits }
              : {}),
            ...(readCapability !== undefined ? { readCapability } : {}),
            ...(discoveryReadCapability !== undefined
              ? { discoveryReadCapability }
              : {}),
            ...(ignoreReadCapability !== undefined
              ? { ignoreReadCapability }
              : {}),
          }),
        );
      } finally {
        try {
          try {
            await materializedIgnoreFiles?.dispose();
          } finally {
            try {
              await ownedIgnoreReadCapability?.dispose();
            } finally {
              await readCapability?.dispose();
            }
          }
        } finally {
          if (toolOperation !== undefined) {
            endWorkspaceToolOperation(toolOperation);
          }
        }
      }
    },
  };
}

// Re-export internal symbols used solely by the test file. Kept at the
// bottom so the public surface above is easy to scan.
export const __INTERNAL = {
  splitGlobs,
  buildRipgrepArgs,
  collectionLineLimit,
  createCollectionWireParser,
  StreamingRipgrepWireWindow,
  pushRipgrepChunkWithinLineLimit,
  renderContentRecordsWithinBudget,
  pinnedSnapshotPathEligibility,
  readNulDelimitedCandidateSpool,
  toRelativeIfInside: (p: string, root: string): string =>
    toRelativeIfInside(p, root),
  sep,
};

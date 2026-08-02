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

import { readFile, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import ignore from "ignore";

import { scrubEnvForChildProcess } from "../../unified-exec/scrub-env.js";
import {
  workspaceAuthoritativeDirtySnapshots,
  workspaceAuthoritativeDirtySnapshotsEqual,
  workspaceHasProtectedEditorPaths,
  type WorkspaceAuthoritativeDirtySnapshot,
} from "../../workspace/mutation-coordinator.js";
import {
  runSupervisedProcess,
  type SupervisedProcessStopReason,
} from "../../utils/supervisedProcess.js";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { plainTextErrorToolResult as errorResult } from "../results.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import {
  applyRuntimeSandboxToSpawn,
  type SandboxSpawnCommand,
} from "./apply-runtime-sandbox.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";
import { PINNED_RIPGREP_PATH } from "./pinned-ripgrep.js";
import {
  assertGrepArgumentEncoding,
  assertGrepArgvWithinLimits,
  createRipgrepWireParser,
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
  MAX_GREP_TYPE_UTF8_BYTES,
  MAX_GREP_WALL_MS,
  renderRipgrepContentBytes,
  renderRipgrepPathBytes,
  type RipgrepContentRecord,
  type RipgrepCountRecord,
  type RipgrepOutputRecord,
  type RipgrepWireParser,
} from "./ripgrep-protocol.js";
import {
  bindWorkspaceDirectoryReadCapability,
  bindWorkspaceFileReadCapability,
  type WorkspaceBoundReadCapability,
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
const RIPGREP_PROBE_MAX_OUTPUT_BYTES = 262_144;
const RIPGREP_WIRE_MAX_OUTPUT_BYTES =
  MAX_GREP_DECODED_BYTES * 2 + MAX_GREP_DIAGNOSTIC_BYTES;

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

/** Probe `rg` once per process and cache the result. */
async function isRipgrepAvailable(
  cwd: string,
  toolArgs: Record<string, unknown>,
  signal?: AbortSignal,
  readCapability?: WorkspaceBoundReadCapability,
): Promise<boolean> {
  if (readCapability !== undefined) {
    try {
      const result = await readCapability.runRipgrep({
        program: PINNED_RIPGREP_PATH,
        args: ["--no-config", "--no-follow", "--version"],
        env: scrubEnvForChildProcess(process.env),
        timeoutMs: RIPGREP_PROBE_TIMEOUT_MS,
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
  // Authenticate and prepare the probe before consulting the process-wide
  // availability cache. A cached host result must never let a later restricted
  // session skip its own required sandbox boundary.
  let command: SandboxSpawnCommand;
  try {
    command = applyRuntimeSandboxToSpawn({
      toolArgs,
      fallbackCwd: cwd,
      program: PINNED_RIPGREP_PATH,
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
  const available = await probeRipgrepCommand(command, signal);
  if (signal?.aborted !== true) ripgrepAvailability = available;
  return available;
}

async function probeRipgrepCommand(
  command: SandboxSpawnCommand,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runSupervisedProcess(command, {
    timeoutMs: RIPGREP_PROBE_TIMEOUT_MS,
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
    if (!rel || rel.startsWith("..") || win32.isAbsolute(rel)) return absPath;
    return rel;
  }
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return absPath;
  return rel;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  if (isWindowsAbsolutePath(candidate) || isWindowsAbsolutePath(root)) {
    const rel = win32.relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !win32.isAbsolute(rel));
  }
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
  let lastDenied: string | undefined;
  for (const rawCandidate of candidates) {
    const candidateSafe = await safePath(rawCandidate, allowedPaths);
    if (!candidateSafe.safe) {
      lastDenied = candidateSafe.reason;
      continue;
    }
    const candidateStat = await stat(candidateSafe.resolved).catch(
      () => undefined,
    );
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
  return {
    absolute: safe.resolved,
    searchRoot: isDirectory ? safe.resolved : dirname(safe.resolved),
    displayRoot,
    displayPath: candidate,
    isDirectory,
    existsOnDisk: targetExistsOnDisk,
    allowedPaths,
  };
}

function displayRootForTarget(target: ResolvedTarget): string {
  return target.displayRoot;
}

function ripgrepCwdForTarget(target: ResolvedTarget): string {
  // A named dirty buffer may point into a directory tree that has not been
  // created on disk yet. stdin-backed rg still needs one existing cwd; the
  // validated allowed display root is safe and always exists.
  return target.existsOnDisk ? target.searchRoot : target.displayRoot;
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
}

function buildRipgrepArgs(opts: RipgrepOptions): string[] {
  const args: string[] = ["--hidden", "--no-require-git"];
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
    return Buffer.from(toRelativeIfInside(decoded, displayRoot), "utf8");
  }
  if (process.platform === "win32") return path;
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

function renderContentRecord(
  record: RipgrepContentRecord,
  displayRoot: string,
  showLineNumbers: boolean,
): readonly string[] {
  const separator = record.recordType === "match" ? ":" : "-";
  const path = renderResultPath(record.path, displayRoot);
  const contentLines = renderRipgrepContentBytes(record.lines)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return contentLines.map((line, index) => {
    const lineNumber =
      showLineNumbers && record.lineNumber !== null
        ? `${record.lineNumber + index}${separator}`
        : "";
    return `${path}${separator}${lineNumber}${line}`;
  });
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
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killedAfterLimit: boolean;
  readonly aborted: boolean;
  readonly stopReason?: SupervisedProcessStopReason;
  readonly spawnError?: Error;
  readonly protocolError?: GrepBoundaryError;
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
  readonly stdin?: string | Buffer;
  readonly relativeInputFile?: string;
  readonly readCapability?: WorkspaceBoundReadCapability;
  readonly signal?: AbortSignal;
}): Promise<LimitedRipgrepResult> {
  const processArgs = ["--no-config", "--no-follow", ...params.args];
  try {
    assertGrepArgvWithinLimits(PINNED_RIPGREP_PATH, processArgs);
  } catch (error) {
    return {
      records: [],
      stderr: "",
      exitCode: 127,
      signal: null,
      killedAfterLimit: false,
      aborted: params.signal?.aborted === true,
      protocolError:
        error instanceof GrepBoundaryError
          ? error
          : new GrepBoundaryError("ARGV_UTF8_LIMIT", String(error)),
    };
  }

  if (params.readCapability !== undefined) {
    try {
      const result = await params.readCapability.runRipgrep({
        program: PINNED_RIPGREP_PATH,
        args: processArgs,
        env: scrubEnvForChildProcess(process.env),
        timeoutMs: MAX_GREP_WALL_MS,
        maxOutputBytes: RIPGREP_WIRE_MAX_OUTPUT_BYTES,
        ...(params.maximumLines !== undefined
          ? {
              structuredLineLimit: {
                outputMode: params.outputMode,
                maximumLines: params.maximumLines,
              },
            }
          : {}),
        ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
        ...(params.relativeInputFile !== undefined
          ? { relativeInputFile: params.relativeInputFile }
          : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });
      const parser = createRipgrepWireParser(params.outputMode);
      const diagnosticsError =
        result.stderr.byteLength > MAX_GREP_DIAGNOSTIC_BYTES
          ? diagnosticLimitError(result.stderr.byteLength)
          : undefined;
      const protocolError =
        diagnosticsError ??
        parseCompletedRipgrepOutput(
          parser,
          result.stdout,
          result.exitCode,
          result.stopReason,
          result.killedAfterLimit,
        );
      return {
        records: parser.records,
        stderr: decodeBoundedDiagnostics(result.stderr),
        exitCode: result.exitCode,
        signal: result.signal,
        killedAfterLimit: result.killedAfterLimit,
        aborted: result.aborted,
        ...(result.stopReason !== undefined
          ? { stopReason: result.stopReason }
          : {}),
        ...(result.spawnError !== undefined
          ? { spawnError: result.spawnError }
          : {}),
        ...(protocolError !== undefined ? { protocolError } : {}),
      };
    } catch (error) {
      return {
        records: [],
        stderr: "",
        exitCode: 127,
        signal: null,
        killedAfterLimit: false,
        aborted: params.signal?.aborted === true,
        spawnError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
  const { cwd, signal } = params;
  const command = applyRuntimeSandboxToSpawn({
    toolArgs: params.toolArgs,
    fallbackCwd: cwd,
    program: PINNED_RIPGREP_PATH,
    // RIPGREP_CONFIG_PATH may contain --pre=COMMAND. Never let ambient
    // operator configuration turn an audited read into arbitrary process
    // execution.
    args: processArgs,
    cwd,
    env: scrubEnvForChildProcess(process.env),
  });
  const parser = createRipgrepWireParser(params.outputMode);
  let diagnosticBytes = 0;
  let inspectedRecords = 0;
  let renderedLines = 0;
  let killedAfterLimit = false;

  const reachedCollectionLimit = (): boolean => {
    while (inspectedRecords < parser.records.length) {
      renderedLines += ripgrepRecordLineCount(
        parser.records[inspectedRecords] as RipgrepOutputRecord,
      );
      inspectedRecords += 1;
    }
    return (
      params.maximumLines !== undefined && renderedLines >= params.maximumLines
    );
  };

  const result = await runSupervisedProcess(command, {
    timeoutMs: MAX_GREP_WALL_MS,
    maxOutputBytes: RIPGREP_WIRE_MAX_OUTPUT_BYTES,
    ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
    signal,
    onStdout: (chunk, control) => {
      parser.push(chunk);
      if (!killedAfterLimit && reachedCollectionLimit()) {
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

  return {
    records: parser.records,
    stderr: decodeBoundedDiagnostics(result.stderr),
    exitCode:
      result.error !== undefined && result.exitCode === null
        ? 127
        : result.exitCode,
    signal: result.signal,
    killedAfterLimit,
    aborted,
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
  return resolve(isAbsolute(path) ? path : join(searchRoot, path)).normalize(
    "NFC",
  );
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
      normalizedResultPath(snapshot.path, target.searchRoot),
    ),
  );
  return records.filter(
    (record) =>
      !dirtyPaths.has(
        normalizedResultPathBytes(record.path, target.searchRoot),
      ),
  );
}

export function searchPathUsesDefaultExcludedDirectory(
  relativePath: string,
  includeIgnored: boolean,
): boolean {
  const segments = relativePath.replace(/\\/gu, "/").split("/");
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

function pathMatchesConfiguredGlobs(
  relativePath: string,
  globs: readonly string[],
): boolean {
  // This matcher applies only to named authoritative Editor overlays that do
  // not exist on disk and therefore cannot be enumerated by ripgrep. Disk
  // discovery and every content match remain wholly owned by ripgrep.
  const isNegated = (glob: string): boolean =>
    glob.startsWith("!") && !glob.startsWith("\\!");
  const positive = globs.filter((glob) => !isNegated(glob));
  const negative = globs
    .filter((glob) => isNegated(glob) && glob.length > 1)
    .map((glob) => glob.slice(1));
  if (positive.length > 0 && !compileGlobMatcher(positive)(relativePath)) {
    return false;
  }
  return negative.length === 0 || !compileGlobMatcher(negative)(relativePath);
}

async function runRipgrepTypeList(params: {
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
}): Promise<readonly string[] | { readonly error: string }> {
  const args = ["--no-config", "--no-follow", "--type-list"];
  try {
    assertGrepArgvWithinLimits(PINNED_RIPGREP_PATH, args);
  } catch (error) {
    return { error: `Grep error: ${formatBoundaryError(error)}` };
  }

  let stdout: Buffer;
  let stderr: Buffer;
  let exitCode: number | null;
  let stopReason: SupervisedProcessStopReason | undefined;
  let processError: Error | undefined;
  if (params.readCapability !== undefined) {
    try {
      const result = await params.readCapability.runRipgrep({
        program: PINNED_RIPGREP_PATH,
        args,
        env: scrubEnvForChildProcess(process.env),
        timeoutMs: MAX_GREP_WALL_MS,
        maxOutputBytes: RIPGREP_PROBE_MAX_OUTPUT_BYTES,
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      stopReason = result.stopReason;
      processError = result.spawnError;
    } catch (error) {
      return {
        error: `Grep error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    const command = applyRuntimeSandboxToSpawn({
      toolArgs: params.toolArgs,
      fallbackCwd: ripgrepCwdForTarget(params.target),
      program: PINNED_RIPGREP_PATH,
      args,
      cwd: ripgrepCwdForTarget(params.target),
      env: scrubEnvForChildProcess(process.env),
    });
    const result = await runSupervisedProcess(command, {
      timeoutMs: MAX_GREP_WALL_MS,
      maxOutputBytes: RIPGREP_PROBE_MAX_OUTPUT_BYTES,
      signal: params.signal,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    stopReason = result.stopReason;
    processError = result.error;
  }

  if (params.signal?.aborted || stopReason === "aborted") {
    return { error: "Search aborted" };
  }
  if (
    processError !== undefined ||
    stopReason !== undefined ||
    exitCode !== 0
  ) {
    const detail =
      processError?.message ??
      (stderr.toString("utf8").trim() || "ripgrep failed");
    return { error: `Grep error: ${detail}` };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return { error: "Grep error: ripgrep emitted invalid UTF-8 type metadata" };
  }
  if (decoded.length > 0 && !decoded.endsWith("\n")) {
    return { error: "Grep error: ripgrep emitted an unterminated type list" };
  }
  return decoded.split("\n").filter((line) => line.length > 0);
}

async function ripgrepTypeGlobs(params: {
  readonly type: string;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
}): Promise<readonly string[] | { readonly error: string }> {
  const lines = await runRipgrepTypeList(params);
  if ("error" in lines) return lines;
  const prefix = `${params.type}:`;
  const definition = lines.find((line) => line.startsWith(prefix));
  if (definition === undefined) {
    return {
      error: `Grep error: unrecognized file type '${params.type}'`,
    };
  }
  return definition
    .slice(prefix.length)
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
}

async function eligibleAuthoritativeSnapshots(params: {
  readonly snapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly opts: RipgrepOptions;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
}): Promise<
  readonly WorkspaceAuthoritativeDirtySnapshot[] | { readonly error: string }
> {
  const typeGlobs =
    params.opts.type === undefined
      ? undefined
      : await ripgrepTypeGlobs({
          type: params.opts.type,
          target: params.target,
          toolArgs: params.toolArgs,
          signal: params.signal,
          ...(params.readCapability !== undefined
            ? { readCapability: params.readCapability }
            : {}),
        });
  if (typeGlobs !== undefined && "error" in typeGlobs) return typeGlobs;
  const isIgnored = params.opts.includeIgnored
    ? async (): Promise<boolean> => false
    : await createSearchIgnoreMatcher(params.target.displayRoot);

  const eligible: WorkspaceAuthoritativeDirtySnapshot[] = [];
  for (const snapshot of params.snapshots) {
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
      !pathMatchesConfiguredGlobs(relativePath, params.opts.globs) ||
      (typeGlobs !== undefined &&
        !compileGlobMatcher(typeGlobs)(relativePath)) ||
      (await isIgnored(snapshot.path))
    ) {
      continue;
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
  readonly headLimit: number;
  readonly offset: number;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
}): Promise<
  | {
      readonly records: readonly RipgrepOutputRecord[];
      readonly truncated: boolean;
    }
  | { readonly error: string }
> {
  const eligible = await eligibleAuthoritativeSnapshots(params);
  if ("error" in eligible) return eligible;
  const maximumLines =
    params.headLimit === 0
      ? undefined
      : collectionLineLimit(params.headLimit, params.offset);
  const records: RipgrepOutputRecord[] = [];
  let collectedLines = 0;
  let truncated = false;

  for (const snapshot of eligible) {
    if (params.signal?.aborted) return { error: "Search aborted" };
    const remaining =
      maximumLines === undefined ? undefined : maximumLines - collectedLines;
    if (remaining !== undefined && remaining <= 0) {
      truncated = true;
      break;
    }
    const args = buildRipgrepArgs({
      ...params.opts,
      absolutePath: "-",
      type: undefined,
      globs: [],
    });
    const result = await runRipgrepCollectRecords({
      outputMode: params.opts.outputMode,
      args,
      cwd: ripgrepCwdForTarget(params.target),
      toolArgs: params.toolArgs,
      ...(remaining !== undefined ? { maximumLines: remaining } : {}),
      stdin: snapshot.content,
      signal: params.signal,
      ...(params.readCapability !== undefined
        ? { readCapability: params.readCapability }
        : {}),
    });
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
    for (const record of result.records) {
      const attributed = attributeStdinResultRecord(record, snapshot.path);
      if (attributed !== null) {
        records.push(attributed);
        collectedLines += ripgrepRecordLineCount(attributed);
      }
    }
    if (remaining !== undefined && collectedLines >= maximumLines!) {
      truncated = true;
      break;
    }
  }
  return { records, truncated };
}

async function runRipgrepGrep(params: {
  readonly opts: RipgrepOptions;
  readonly headLimit: number;
  readonly offset: number;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly authoritativeSnapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
}): Promise<ToolResult> {
  const { opts, headLimit, offset, target, authoritativeSnapshots, signal } =
    params;
  const result: LimitedRipgrepResult =
    params.readCapability === undefined
      ? target.existsOnDisk
        ? await runRipgrepCollectRecords({
            outputMode: opts.outputMode,
            args: buildRipgrepArgs(opts),
            cwd: target.searchRoot,
            toolArgs: params.toolArgs,
            ...(headLimit === 0 || authoritativeSnapshots.length > 0
              ? {}
              : { maximumLines: collectionLineLimit(headLimit, offset) }),
            signal,
          })
        : emptyLimitedRipgrepResult()
      : await collectDescriptorBoundDiskRecords({
          opts,
          headLimit,
          offset,
          target,
          toolArgs: params.toolArgs,
          authoritativeSnapshots,
          signal,
          readCapability: params.readCapability,
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

  let rawRecords = [...result.records];
  let authoritativeTruncated = false;
  if (authoritativeSnapshots.length > 0) {
    const authoritative = await collectAuthoritativeSnapshotRecords({
      snapshots: authoritativeSnapshots,
      opts,
      headLimit,
      offset,
      target,
      toolArgs: params.toolArgs,
      signal,
      ...(params.readCapability !== undefined
        ? { readCapability: params.readCapability }
        : {}),
    });
    if ("error" in authoritative) {
      return errorResult(authoritative.error);
    }
    rawRecords = [
      ...authoritative.records,
      ...filterDirtyDiskRecords(rawRecords, target, authoritativeSnapshots),
    ];
    authoritativeTruncated = authoritative.truncated;
  }

  if (rawRecords.length === 0) {
    return emptyRipgrepResultForMode(opts.outputMode, headLimit, offset);
  }

  const displayRoot = displayRootForTarget(target);

  if (opts.outputMode === "files_with_matches") {
    const relative = rawRecords.map((record) =>
      renderResultPath(record.path, displayRoot),
    );
    const { items, truncated } = applyTruncation(relative, headLimit, offset);
    return formatFilesWithMatchesResult(
      items,
      truncated || result.killedAfterLimit || authoritativeTruncated,
      headLimit,
      offset,
    );
  }

  if (opts.outputMode === "count") {
    const counts = rawRecords.filter(
      (record): record is RipgrepCountRecord => record.kind === "count",
    );
    const { items, truncated } = applyTruncation(counts, headLimit, offset);
    const body = items
      .map(
        (record) =>
          `${renderResultPath(record.path, displayRoot)}:${record.count}`,
      )
      .join("\n");
    const summary = formatCountSummary(
      items,
      truncated || result.killedAfterLimit || authoritativeTruncated,
      headLimit,
      offset,
    );
    return textResult(body.length > 0 ? `${body}\n\n${summary}` : summary);
  }

  const rewritten = rawRecords
    .filter(
      (record): record is RipgrepContentRecord => record.kind === "content",
    )
    .flatMap((record) =>
      renderContentRecord(record, displayRoot, opts.showLineNumbers),
    );
  const { items, truncated } = applyTruncation(rewritten, headLimit, offset);
  const body = items.map(truncateRenderedContentLine).join("\n");
  const pagination =
    truncated || result.killedAfterLimit || authoritativeTruncated
      ? formatTruncationNote(headLimit, offset)
      : offset > 0
        ? formatOffsetNote(offset)
        : "";
  return textResult(pagination ? `${body}\n${pagination}` : body);
}

function emptyLimitedRipgrepResult(): LimitedRipgrepResult {
  return {
    records: [],
    stderr: "",
    exitCode: 1,
    signal: null,
    killedAfterLimit: false,
    aborted: false,
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
  readonly headLimit: number;
  readonly offset: number;
  readonly target: ResolvedTarget;
  readonly toolArgs: Record<string, unknown>;
  readonly authoritativeSnapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly signal?: AbortSignal;
  readonly readCapability: WorkspaceBoundReadCapability;
}): Promise<LimitedRipgrepResult> {
  if (!params.target.existsOnDisk) return emptyLimitedRipgrepResult();

  let candidatePaths: string[];
  let discoveryTruncated = false;
  if (params.target.isDirectory) {
    const discovery = await runRipgrepCollectRecords({
      outputMode: "files_with_matches",
      args: buildRipgrepArgs({
        ...params.opts,
        absolutePath: ".",
        outputMode: "files_with_matches",
        contextBefore: undefined,
        contextAfter: undefined,
        contextBoth: undefined,
      }),
      cwd: params.readCapability.rootPath,
      toolArgs: params.toolArgs,
      signal: params.signal,
      readCapability: params.readCapability,
    });
    const discoveryFailure = ripgrepFailure(discovery);
    if (discoveryFailure !== undefined) return discoveryFailure;
    discoveryTruncated = discovery.killedAfterLimit;
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
      const candidate = normalizedResultPath(decoded, params.target.searchRoot);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      candidatePaths.push(candidate);
    }
  } else {
    candidatePaths = [
      normalizedResultPath(params.target.absolute, params.target.searchRoot),
    ];
  }

  const records: RipgrepOutputRecord[] = [];
  let collectedLines = 0;
  let killedAfterLimit = discoveryTruncated;
  const maximumLines =
    params.headLimit === 0 || params.authoritativeSnapshots.length > 0
      ? undefined
      : collectionLineLimit(params.headLimit, params.offset);
  for (const candidatePath of candidatePaths) {
    if (params.signal?.aborted) {
      return {
        ...emptyLimitedRipgrepResult(),
        aborted: true,
        stopReason: "aborted",
      };
    }
    const relativeInputFile = descriptorRelativePath(
      candidatePath,
      params.readCapability.rootPath,
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
    const remaining =
      maximumLines === undefined ? undefined : maximumLines - collectedLines;
    if (remaining !== undefined && remaining <= 0) {
      killedAfterLimit = true;
      break;
    }
    const verified = await runRipgrepCollectRecords({
      outputMode: params.opts.outputMode,
      args: buildRipgrepArgs({
        ...params.opts,
        absolutePath: "-",
        type: undefined,
        globs: [],
      }),
      cwd: params.readCapability.rootPath,
      toolArgs: params.toolArgs,
      ...(remaining !== undefined ? { maximumLines: remaining } : {}),
      relativeInputFile,
      signal: params.signal,
      readCapability: params.readCapability,
    });
    const verifiedFailure = ripgrepFailure(verified);
    if (verifiedFailure !== undefined) return verifiedFailure;
    for (const record of verified.records) {
      const attributed = attributeStdinResultRecord(record, candidatePath);
      if (attributed !== null) {
        records.push(attributed);
        collectedLines += ripgrepRecordLineCount(attributed);
      }
    }
    if (remaining !== undefined && collectedLines >= maximumLines!) {
      killedAfterLimit = true;
      break;
    }
  }
  return {
    records,
    stderr: "",
    exitCode: records.length > 0 ? 0 : 1,
    signal: null,
    killedAfterLimit,
    aborted: false,
  };
}

function compileGlobMatcher(
  globs: readonly string[],
): (path: string) => boolean {
  if (globs.length === 0) return () => true;
  // Lightweight glob → regex (`**`, `*`, `?`, and `{a,b}` brace alternatives).
  const matchers = globs.map((glob) => globToRegExp(glob));
  return (path) => {
    const normalized = path.replace(/\\/g, "/");
    const slashIdx = normalized.lastIndexOf("/");
    const base =
      slashIdx === -1 ? normalized : normalized.substring(slashIdx + 1);
    const candidates = [normalized, base];
    return matchers.some((re) => candidates.some((c) => re.test(c)));
  };
}

function globToRegExp(glob: string): RegExp {
  // Normalize separators to `/`, preserving ripgrep's escaped literal `!` at
  // the start of a positive glob.
  const literalLeadingBang = glob.startsWith("\\!");
  const cleaned = literalLeadingBang
    ? `!${glob.slice(2).replace(/\\/g, "/")}`
    : glob.replace(/\\/g, "/");
  return new RegExp(`^${globPatternToRegexSource(cleaned)}$`);
}

function globPatternToRegexSource(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const close = findBraceEnd(pattern, i);
      if (close !== -1) {
        const alternatives = splitBraceAlternatives(
          pattern.substring(i + 1, close),
        );
        if (alternatives.length > 1) {
          re += `(?:${alternatives
            .map((part) => globPatternToRegexSource(part))
            .join("|")})`;
          i = close;
          continue;
        }
      }
      re += "\\{";
    } else if (".+^$|()[]{}\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return re;
}

function findBraceEnd(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitBraceAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      parts.push(body.substring(start, i));
      start = i + 1;
    }
  }
  parts.push(body.substring(start));
  return parts;
}

export async function createSearchIgnoreMatcher(
  displayRoot: string,
): Promise<(path: string) => Promise<boolean>> {
  const cache = new Map<string, ReturnType<typeof ignore> | undefined>();

  async function matcherForDirectory(
    directory: string,
  ): Promise<ReturnType<typeof ignore> | undefined> {
    if (cache.has(directory)) return cache.get(directory);
    const matcher = ignore();
    let loaded = false;
    for (const fileName of SEARCH_IGNORE_FILES) {
      const content = await readFile(join(directory, fileName), "utf8").catch(
        () => undefined,
      );
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
    let ignored = false;
    for (const directory of directories) {
      const matcher = await matcherForDirectory(directory);
      if (matcher === undefined) continue;
      const rel = toRelativeIfInside(path, directory).replace(/\\/g, "/");
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
            'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes. Defaults to 250. Pass 0 for unlimited output.',
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
      };
      try {
        assertGrepArgvWithinLimits(PINNED_RIPGREP_PATH, [
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
      const trustedEditorInteraction =
        readToolRuntimeContext(rawArgs)?.invocation.turn.editorInteraction !==
        undefined;
      let requiresDescriptorBoundRead = trustedEditorInteraction;
      try {
        requiresDescriptorBoundRead ||= workspaceHasProtectedEditorPaths(
          target.absolute,
        );
      } catch (error) {
        return editorCoherenceError(error);
      }
      let readCapability: WorkspaceBoundReadCapability | undefined;
      if (requiresDescriptorBoundRead) {
        try {
          readCapability =
            target.existsOnDisk && !target.isDirectory
              ? await bindWorkspaceFileReadCapability(target.absolute)
              : await bindWorkspaceDirectoryReadCapability(
                  target.isDirectory ? target.absolute : target.displayRoot,
                );
        } catch (error) {
          return editorCoherenceError(error);
        }
      }

      try {
        await afterFinalPathCheck?.();
        let authoritativeSnapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
        try {
          authoritativeSnapshots = workspaceAuthoritativeDirtySnapshots(
            target.absolute,
          );
        } catch (error) {
          return editorCoherenceError(error);
        }
        const finalizeAuthoritativeResult = async (
          result: ToolResult,
        ): Promise<ToolResult> => {
          await beforeAuthoritativeSnapshotValidation?.();
          try {
            const current = workspaceAuthoritativeDirtySnapshots(
              target.absolute,
            );
            return workspaceAuthoritativeDirtySnapshotsEqual(
              authoritativeSnapshots,
              current,
            )
              ? result
              : editorCoherenceError();
          } catch (error) {
            return editorCoherenceError(error);
          }
        };

        const ripgrepOptions: RipgrepOptions = {
          ...prospectiveOptions,
          absolutePath: target.absolute,
        };
        try {
          assertGrepArgvWithinLimits(PINNED_RIPGREP_PATH, [
            "--no-config",
            "--no-follow",
            ...buildRipgrepArgs(ripgrepOptions),
          ]);
        } catch (error) {
          return finalizeAuthoritativeResult(
            errorResult(`Grep error: ${formatBoundaryError(error)}`),
          );
        }

        const signal = args.__abortSignal;
        const cwdForProbe = ripgrepCwdForTarget(target) || process.cwd();
        const ripgrepReady = await isRipgrepAvailable(
          cwdForProbe,
          rawArgs,
          signal,
          readCapability,
        );

        if (signal?.aborted) {
          return finalizeAuthoritativeResult(errorResult("Search aborted"));
        }

        if (!ripgrepReady) {
          return finalizeAuthoritativeResult(
            errorResult(
              "Grep error [PINNED_RIPGREP_UNAVAILABLE]: AgenC's pinned ripgrep executable is missing or not executable. Run `agenc doctor`, then reinstall the same AgenC version; a PATH-resolved `rg` and JavaScript fallback are never used.",
            ),
          );
        }

        return finalizeAuthoritativeResult(
          await runRipgrepGrep({
            opts: ripgrepOptions,
            headLimit: normalized.headLimit,
            offset: normalized.offset,
            target,
            toolArgs: rawArgs,
            authoritativeSnapshots,
            signal,
            ...(readCapability !== undefined ? { readCapability } : {}),
          }),
        );
      } finally {
        await readCapability?.dispose();
      }
    },
  };
}

// Re-export internal symbols used solely by the test file. Kept at the
// bottom so the public surface above is easy to scan.
export const __INTERNAL = {
  splitGlobs,
  buildRipgrepArgs,
  compileGlobMatcher,
  globToRegExp,
  toRelativeIfInside: (p: string, root: string): string =>
    toRelativeIfInside(p, root),
  sep,
};

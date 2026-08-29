/**
 * `Glob` — AgenC-owned file-pattern search tool.
 *
 * Ports the donor `GlobTool` behavior onto AgenC's tool interface:
 *   - model-facing bare tool name `Glob`
 *   - `rg --files --glob <pattern>` as the primary file-listing engine
 *   - sorted, capped file-path output with donor-compatible empty and
 *     truncation text
 *
 * Shape differences from the donor runtime:
 *   - AgenC returns plain `ToolResult.content` instead of a structured
 *     tool-result block.
 *   - Paths are relativized to the nearest allowed workspace root so nested
 *     directory searches keep enough context for the model.
 *
 * Cross-cuts deliberately not carried:
 *   - full permission-dialog plumbing; AgenC enforces allowed roots through
 *     `safePath()` before and after the file-listing call.
 */

import { promises as fs } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import {
  resolveToolAllowedPaths,
  safePath,
  type FilesystemToolConfig,
} from "./filesystem.js";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { scrubEnvForChildProcess } from "../../unified-exec/scrub-env.js";
import {
  runSupervisedProcess,
  type SupervisedProcessStopReason,
} from "../../utils/supervisedProcess.js";
import {
  applyReadOnlyRuntimeSandboxToSpawn,
  type SandboxSpawnCommand,
} from "./apply-runtime-sandbox.js";
import {
  isSandboxPreparedSpawn,
  type SandboxPreparedSpawn,
} from "../../sandbox/execution-broker.js";
import { selectPinnedRipgrepPath } from "./pinned-ripgrep.js";
import {
  materializeRipgrepIgnoreFiles,
  readVerifiedRipgrepIgnoreFile,
  type RipgrepIgnoreFileSnapshot,
} from "./ripgrep-ignore-snapshot.js";
import {
  assertGrepArgumentEncoding,
  assertGrepArgvWithinLimits,
  createRipgrepWireParser,
  decodeRipgrepPathBytes,
  GrepBoundaryError,
  MAX_GREP_DECODED_BYTES,
  MAX_GREP_GLOB_UTF8_BYTES,
  MAX_GREP_RAW_PATH_UTF8_BYTES,
  MAX_GREP_RECORD_BYTES,
  MAX_GREP_RESULTS,
  renderRipgrepPathBytes,
  type RipgrepWireParser,
} from "./ripgrep-protocol.js";
import {
  beginWorkspaceReadToolOperation,
  endWorkspaceToolOperation,
  type WorkspaceToolOperationToken,
} from "../../workspace/mutation-coordinator.js";
import {
  bindWorkspaceDirectoryReadCapability,
  type WorkspaceBoundReadCapability,
  type WorkspaceBoundReadIdentity,
} from "../../workspace/file-mutation-transaction.js";

export const GLOB_TOOL_NAME = "Glob";

const DEFAULT_MAX_RESULTS = 100;
const MAX_RIPGREP_STDERR_CHARS = 128 * 1024;
const RIPGREP_FILES_TIMEOUT_MS = 120_000;
const RIPGREP_FILES_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RIPGREP_FILE_TYPE_NAME = "agencglob";
const MAX_ROOT_IGNORE_FILE_BYTES = 1 * 1024 * 1024;
const ROOT_IGNORE_FILES = [".gitignore", ".ignore", ".rgignore"] as const;
const BYTE_DOT = 0x2e;
const BYTE_SLASH = 0x2f;
const BYTE_COLON = 0x3a;
const BYTE_BACKSLASH = 0x5c;
const TRUNCATION_NOTE =
  "(Results are truncated. Consider using a more specific path or pattern.)";
const PINNED_RIPGREP_UNAVAILABLE_MESSAGE =
  "Glob error [PINNED_RIPGREP_UNAVAILABLE]: AgenC's packaged ripgrep executable is unavailable. Run `agenc doctor`, then reinstall the same AgenC version.";

/**
 * Generated/build/vendored/ledger directories that are excluded from a Glob
 * walk BY DEFAULT. A repo's real source surface is tiny next to these; walking
 * them surfaces nothing useful for "what does this repo do" and can be
 * pathological (e.g. a 26 GB `.localnet/` validator log under agenc-protocol).
 *
 * This explicit exclude set is the load-bearing protection: ripgrep's
 * `--glob <pattern>` whitelist (the user's search pattern) OVERRIDES
 * `.gitignore`, so dropping `--no-ignore` alone would not reliably skip
 * gitignored artifacts. The negative `!<glob>` excludes below DO win over the
 * positive pattern, so they deterministically skip these dirs. Set
 * `includeIgnored: true` to opt back into the legacy `--no-ignore` walk that
 * surfaces build output, `.git`, and gitignored files.
 */
export const DEFAULT_GLOB_EXCLUDE_GLOBS: ReadonlyArray<string> = Object.freeze([
  "**/node_modules/**",
  "**/target/**",
  "**/dist/**",
  "**/build/**",
  "**/.localnet/**",
  "**/.git/**",
  "**/*.lock",
]);

const GLOB_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- By default skips generated/build/vendored dirs (node_modules, target, dist, build, .localnet, .git, lockfiles); pass includeIgnored: true to search those too
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the spawn_agent tool instead`;

interface GlobToolInput extends ToolExecutionInjectedArgs {
  readonly pattern?: unknown;
  readonly path?: unknown;
  readonly cwd?: unknown;
  readonly includeIgnored?: unknown;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export interface GlobToolConfig {
  /** Allowed path prefixes — required, mirrors {@link FilesystemToolConfig}. */
  readonly allowedPaths: readonly string[];
  /** Override the hard result cap (default {@link DEFAULT_MAX_RESULTS}). */
  readonly maxResults?: number;
  /** Test override for the subprocess path. Production uses packaged `rg`. */
  readonly ripgrepCommand?: string;
  /** Deterministic test seam immediately after the final path check. */
  readonly __testAfterFinalPathCheck?: () => void | Promise<void>;
  /** Deterministic test seam after admission but before capability binding. */
  readonly __testBeforeReadCapabilityBind?: () => void | Promise<void>;
  /** Deterministic test seam after root ignore bytes have been snapshotted. */
  readonly __testAfterRootIgnoreSnapshot?: () => void | Promise<void>;
}

interface ResolvedGlobTarget {
  readonly searchRoot: string;
  readonly searchRootIdentity: WorkspaceBoundReadIdentity;
  readonly displayRoot: string;
  readonly displayRootIdentity: WorkspaceBoundReadIdentity;
  readonly pattern: string;
  readonly allowedPaths: readonly string[];
}

export interface LimitedRipgrepResult {
  readonly pathRecords: readonly Buffer[];
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly aborted: boolean;
  readonly killedAfterLimit: boolean;
  readonly stopReason?: SupervisedProcessStopReason;
  readonly spawnError?: Error;
}

export function formatRipgrepFilesError(error: unknown): string {
  if (error instanceof GrepBoundaryError) {
    return `[${error.reason}] ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function textResult(
  content: string,
  metadata?: Record<string, unknown>,
): ToolResult {
  return metadata === undefined ? { content } : { content, metadata };
}

function errorResult(content: string): ToolResult {
  return { content, isError: true };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
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

function resolveAgainstFirstAllowed(
  path: string,
  allowedPaths: readonly string[],
): string {
  if (isAbsolute(path) || isWindowsAbsolutePath(path)) return path;
  return resolve(allowedPaths[0] ?? process.cwd(), path);
}

async function closestAllowedDisplayRoot(
  targetPath: string,
  allowedPaths: readonly string[],
): Promise<string | undefined> {
  let best: string | undefined;
  for (const allowedPath of allowedPaths) {
    const safeAllowed = await safePath(allowedPath, [allowedPath]);
    if (!safeAllowed.safe) continue;
    const allowedStat = await fs
      .stat(safeAllowed.resolved)
      .catch(() => undefined);
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

function extractGlobBaseDirectory(pattern: string): {
  readonly baseDir: string;
  readonly relativePattern: string;
} {
  const useWindowsSeparators =
    process.platform === "win32" || isWindowsAbsolutePath(pattern);
  const match = pattern.match(/[*?[{]/);
  if (!match || match.index === undefined) {
    return {
      baseDir: useWindowsSeparators ? win32.dirname(pattern) : dirname(pattern),
      relativePattern: useWindowsSeparators
        ? win32.basename(pattern)
        : basename(pattern),
    };
  }
  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = useWindowsSeparators
    ? Math.max(staticPrefix.lastIndexOf("/"), staticPrefix.lastIndexOf("\\"))
    : staticPrefix.lastIndexOf("/");
  if (lastSepIndex === -1) {
    return { baseDir: "", relativePattern: pattern };
  }
  let baseDir = staticPrefix.slice(0, lastSepIndex);
  if (baseDir === "" && lastSepIndex === 0) baseDir = "/";
  if (/^[A-Za-z]:$/.test(baseDir)) {
    baseDir = `${baseDir}${useWindowsSeparators ? "\\" : sep}`;
  }
  return {
    baseDir,
    relativePattern: pattern.slice(lastSepIndex + 1),
  };
}

async function resolveGlobTarget(params: {
  readonly args: Record<string, unknown>;
  readonly allowedPaths: readonly string[];
  readonly pattern: string;
}): Promise<ResolvedGlobTarget | { error: string }> {
  // SECURITY: `params.allowedPaths` is the TRUSTED closure scope. The
  // only roots `resolveToolAllowedPaths` folds in from `params.args` are
  // runtime-injected `__agencSessionAllowedRoots` (e.g. the worktree
  // path) — model-supplied `__agenc*` keys are stripped at the dispatch
  // boundary (router.ts) before they ever reach here. The requested
  // search root (`path`/`cwd`, below) is always re-validated against
  // this set via `safePath`, so a model cannot search outside trusted
  // roots.
  const effectiveAllowed = resolveToolAllowedPaths(
    params.allowedPaths,
    params.args,
  );
  if (effectiveAllowed.length === 0) {
    return { error: "No allowed paths configured for Glob" };
  }

  let requestedRoot =
    asNonEmptyString(params.args.path) ?? asNonEmptyString(params.args.cwd);
  let pattern = params.pattern;

  if (isAbsolute(pattern) || isWindowsAbsolutePath(pattern)) {
    const extracted = extractGlobBaseDirectory(pattern);
    if (extracted.baseDir.length > 0) {
      requestedRoot = extracted.baseDir;
      pattern = extracted.relativePattern;
    }
  }

  const rootCandidate = resolveAgainstFirstAllowed(
    requestedRoot ?? effectiveAllowed[0] ?? process.cwd(),
    effectiveAllowed,
  );
  const rootCheck = await safePath(rootCandidate, effectiveAllowed);
  if (!rootCheck.safe) {
    return {
      error: `Access denied: ${rootCheck.reason ?? "search path is outside allowed directories"}`,
    };
  }

  const rootStat = await fs
    .stat(rootCheck.resolved, { bigint: true })
    .catch(() => undefined);
  if (!rootStat) {
    return {
      error: `Directory does not exist: ${requestedRoot ?? rootCandidate}`,
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      error: `Path is not a directory: ${requestedRoot ?? rootCandidate}`,
    };
  }

  const displayRoot =
    (await closestAllowedDisplayRoot(rootCheck.resolved, effectiveAllowed)) ??
    rootCheck.resolved;
  const displayRootStat = await fs
    .stat(displayRoot, { bigint: true })
    .catch(() => undefined);
  if (displayRootStat === undefined || !displayRootStat.isDirectory()) {
    return { error: `Directory does not exist: ${displayRoot}` };
  }
  return {
    searchRoot: rootCheck.resolved,
    searchRootIdentity: bigintStatIdentity(rootStat),
    displayRoot,
    displayRootIdentity: bigintStatIdentity(displayRootStat),
    pattern,
    allowedPaths: effectiveAllowed,
  };
}

function appendBoundedText(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_RIPGREP_STDERR_CHARS
    ? next.slice(0, MAX_RIPGREP_STDERR_CHARS)
    : next;
}

function isExecutableUnavailable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      return true;
    }
    if (/executable not found or not executable:/u.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export interface RunRipgrepFilesParams {
  readonly command: string;
  readonly pattern: string;
  readonly cwd: string;
  /** Literal search target relative to the authenticated cwd. */
  readonly searchPath?: string;
  readonly toolArgs: Record<string, unknown>;
  readonly limit: number;
  readonly includeIgnored: boolean;
  readonly rootIgnoreFiles?: readonly RipgrepIgnoreFileSnapshot[];
  readonly signal?: AbortSignal;
  readonly readCapability?: WorkspaceBoundReadCapability;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

type RunRipgrepFilesWithIgnorePathsParams = Omit<
  RunRipgrepFilesParams,
  "rootIgnoreFiles"
> & {
  readonly rootIgnoreFilePaths: readonly string[];
};

interface BuildRipgrepFilesArgsParams {
  readonly pattern: string;
  readonly searchPath?: string;
  readonly includeIgnored: boolean;
  readonly rootIgnoreFilePaths: readonly string[];
}

function buildRipgrepFilesArgs(params: BuildRipgrepFilesArgsParams): string[] {
  const args = [
    // Ignore RIPGREP_CONFIG_PATH: a config can inject --pre=COMMAND and turn
    // an audited workspace read into arbitrary process execution.
    "--no-config",
    "--no-follow",
    "--files",
    "-0",
    "--no-ignore-parent",
    "--no-ignore-global",
    "--no-ignore-exclude",
    "--type-add",
    `${RIPGREP_FILE_TYPE_NAME}:${params.pattern}`,
    "--type",
    RIPGREP_FILE_TYPE_NAME,
    "--sortr",
    "modified",
    "--hidden",
  ];
  if (!params.includeIgnored) {
    for (const ignoreFile of params.rootIgnoreFilePaths) {
      args.push("--ignore-file", ignoreFile);
    }
  }
  if (params.includeIgnored) {
    args.push("--no-ignore");
  } else {
    for (const exclude of DEFAULT_GLOB_EXCLUDE_GLOBS) {
      args.push("--glob", `!${exclude}`);
    }
  }
  args.push("--", params.searchPath ?? ".");
  return args;
}

function assertRipgrepFilesArgvWithinLimits(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  assertGrepArgvWithinLimits(command, args, platform);
}

const BOUND_RIPGREP_COMMAND_CWD = ".";

function prepareBoundRipgrepFilesCommand(params: {
  readonly toolArgs: Record<string, unknown>;
  readonly fallbackCwd: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}): SandboxSpawnCommand | SandboxPreparedSpawn {
  const command = applyReadOnlyRuntimeSandboxToSpawn({
    toolArgs: params.toolArgs,
    fallbackCwd: params.fallbackCwd,
    program: params.program,
    args: params.args,
    // The helper resolves "." through its held directory descriptor. Keep the
    // transformed command off live absolute pathnames.
    cwd: BOUND_RIPGREP_COMMAND_CWD,
    cwdBinding: "inherited_readonly",
    env: params.env,
  });
  return command;
}

async function withBoundRipgrepFilesCommand<T>(
  command: SandboxSpawnCommand | SandboxPreparedSpawn,
  operation: (
    command: SandboxSpawnCommand,
    lifecycleSignal?: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  const run = (
    resolved: SandboxSpawnCommand,
    lifecycleSignal?: AbortSignal,
  ): Promise<T> => {
    if (resolved.cwd !== BOUND_RIPGREP_COMMAND_CWD) {
      throw new Error(
        "sandbox transform changed descriptor-bound ripgrep cwd; refusing to leave the authenticated capability root",
      );
    }
    assertGrepArgumentEncoding(resolved.program, "ripgrep executable");
    assertRipgrepFilesArgvWithinLimits(
      resolved.argv0 ?? resolved.program,
      resolved.args,
    );
    return operation(resolved, lifecycleSignal);
  };
  return isSandboxPreparedSpawn(command)
    ? command.run((resolved, lifecycleSignal) =>
        run(resolved, lifecycleSignal),
      )
    : run(command);
}

export async function runRipgrepFiles(
  params: RunRipgrepFilesParams,
): Promise<LimitedRipgrepResult> {
  const materialized = await materializeRipgrepIgnoreFiles(
    params.rootIgnoreFiles ?? [],
  );
  try {
    return await runRipgrepFilesWithIgnorePaths({
      ...params,
      rootIgnoreFilePaths: materialized.paths,
    });
  } finally {
    await materialized.dispose();
  }
}

async function runRipgrepFilesWithIgnorePaths(
  params: RunRipgrepFilesWithIgnorePathsParams,
): Promise<LimitedRipgrepResult> {
  const timeoutMs = params.timeoutMs ?? RIPGREP_FILES_TIMEOUT_MS;
  const maxOutputBytes =
    params.maxOutputBytes ?? RIPGREP_FILES_MAX_OUTPUT_BYTES;
  const args = buildRipgrepFilesArgs(params);
  try {
    assertRipgrepFilesArgvWithinLimits(params.command, args);
  } catch (error) {
    return {
      pathRecords: [],
      stderr: "",
      exitCode: null,
      aborted: params.signal?.aborted === true,
      killedAfterLimit: false,
      spawnError: error instanceof Error ? error : new Error(String(error)),
    };
  }
  if (params.readCapability !== undefined) {
    let command: SandboxSpawnCommand | SandboxPreparedSpawn;
    try {
      command = prepareBoundRipgrepFilesCommand({
        toolArgs: params.toolArgs,
        fallbackCwd: params.cwd,
        program: params.command,
        args,
        env: scrubEnvForChildProcess(process.env),
      });
    } catch (error) {
      if (!isExecutableUnavailable(error)) throw error;
      return {
        pathRecords: [],
        stderr: "",
        exitCode: null,
        aborted: params.signal?.aborted === true,
        killedAfterLimit: false,
        spawnError: error instanceof Error ? error : new Error(String(error)),
      };
    }
    const result = await withBoundRipgrepFilesCommand(
      command,
      (resolved, lifecycleSignal) =>
        params.readCapability!.runRipgrep({
          program: resolved.program,
          args: resolved.args,
          env: resolved.env,
          ...(resolved.argv0 !== undefined ? { argv0: resolved.argv0 } : {}),
          timeoutMs,
          maxOutputBytes,
          structuredLineLimit: {
            outputMode: "files_with_matches",
            maximumLines: params.limit,
            maximumRecordBytes: MAX_GREP_RECORD_BYTES,
            // The helper validates every record already delivered in a pipe
            // chunk, including records after the retained page witness. Keep
            // that bounded independently from the caller's page size so
            // normal chunking cannot turn clean truncation into a result
            // limit error.
            maximumWorkUnits: MAX_GREP_RESULTS,
          },
          ...(params.signal !== undefined || lifecycleSignal !== undefined
            ? {
                signal:
                  params.signal !== undefined &&
                  lifecycleSignal !== undefined
                    ? AbortSignal.any([params.signal, lifecycleSignal])
                    : (params.signal ?? lifecycleSignal),
              }
            : {}),
        }),
    );
    const parser = createRipgrepWireParser("files_with_matches", {
      maxRecordBytes: MAX_GREP_RECORD_BYTES,
      maxDecodedBytes: MAX_GREP_DECODED_BYTES,
      maxResults: params.limit,
    });
    let protocolError: Error | undefined;
    try {
      parser.push(result.stdout);
      parser.finish({ allowPartial: result.killedAfterLimit });
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error(String(error));
    }
    return {
      pathRecords: parser.records
        .filter((record) => record.kind === "file")
        .map((record) => record.path),
      stderr: appendBoundedText("", result.stderr.toString("utf8")),
      exitCode: result.exitCode,
      aborted: result.aborted,
      killedAfterLimit: result.killedAfterLimit,
      ...(result.stopReason !== undefined
        ? { stopReason: result.stopReason }
        : {}),
      ...(result.spawnError !== undefined
        ? { spawnError: result.spawnError }
        : protocolError !== undefined
          ? { spawnError: protocolError }
          : {}),
    };
  }
  let command: SandboxSpawnCommand | SandboxPreparedSpawn;
  try {
    command = applyReadOnlyRuntimeSandboxToSpawn({
      toolArgs: params.toolArgs,
      fallbackCwd: params.cwd,
      program: params.command,
      args,
      cwd: params.cwd,
      env: scrubEnvForChildProcess(process.env),
    });
  } catch (error) {
    if (!isExecutableUnavailable(error)) throw error;
    return {
      pathRecords: [],
      stderr: "",
      exitCode: null,
      aborted: params.signal?.aborted === true,
      killedAfterLimit: false,
      spawnError: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const parser: RipgrepWireParser = createRipgrepWireParser(
    "files_with_matches",
    {
      maxRecordBytes: MAX_GREP_RECORD_BYTES,
      maxDecodedBytes: MAX_GREP_DECODED_BYTES,
      maxResults: MAX_GREP_RESULTS,
    },
  );
  let killedAfterLimit = false;
  let protocolError: Error | undefined;

  const result = await runSupervisedProcess(command, {
    timeoutMs,
    maxOutputBytes,
    signal: params.signal,
    captureStdout: false,
    onStdout: (chunk, control) => {
      if (killedAfterLimit || protocolError !== undefined) return;
      try {
        parser.push(chunk);
        if (parser.records.length >= params.limit) {
          killedAfterLimit = true;
          control.stop("consumer_limit");
        }
      } catch (error) {
        protocolError =
          error instanceof Error ? error : new Error(String(error));
        control.stop("consumer_limit");
      }
    },
  });

  const aborted =
    params.signal?.aborted === true || result.stopReason === "aborted";
  if (protocolError === undefined) {
    try {
      parser.finish({
        allowPartial:
          killedAfterLimit || aborted || result.stopReason !== undefined,
      });
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error(String(error));
    }
  }

  return {
    pathRecords: parser.records
      .filter((record) => record.kind === "file")
      .slice(0, params.limit)
      .map((record) => record.path),
    stderr: appendBoundedText("", result.stderr.toString("utf8")),
    exitCode: result.exitCode,
    aborted,
    killedAfterLimit,
    ...(result.stopReason !== undefined
      ? { stopReason: result.stopReason }
      : {}),
    ...(result.error !== undefined
      ? { spawnError: result.error }
      : protocolError !== undefined
        ? { spawnError: protocolError }
        : {}),
  };
}

function normalizeRelativeRipgrepPathBytes(path: Buffer): Buffer {
  let start = 0;
  if (
    path.length >= 2 &&
    path[0] === BYTE_DOT &&
    (path[1] === BYTE_SLASH ||
      (process.platform === "win32" && path[1] === BYTE_BACKSLASH))
  ) {
    start = 2;
  }
  const normalized = Buffer.from(path.subarray(start));
  if (process.platform === "win32") {
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] === BYTE_BACKSLASH) {
        normalized[index] = BYTE_SLASH;
      }
    }
  }
  return normalized;
}

function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function isSafeRelativeRipgrepPathBytes(path: Buffer): boolean {
  if (path.length === 0 || path[0] === BYTE_SLASH) return false;
  if (
    process.platform === "win32" &&
    (path[0] === BYTE_BACKSLASH ||
      (path.length >= 3 &&
        isAsciiLetter(path[0] as number) &&
        path[1] === BYTE_COLON &&
        path[2] === BYTE_SLASH))
  ) {
    return false;
  }
  let segmentStart = 0;
  for (let index = 0; index <= path.length; index += 1) {
    const atSeparator =
      index === path.length ||
      path[index] === BYTE_SLASH ||
      (process.platform === "win32" && path[index] === BYTE_BACKSLASH);
    if (!atSeparator) continue;
    const segmentLength = index - segmentStart;
    if (
      segmentLength === 0 ||
      (segmentLength === 1 && path[segmentStart] === BYTE_DOT) ||
      (segmentLength === 2 &&
        path[segmentStart] === BYTE_DOT &&
        path[segmentStart + 1] === BYTE_DOT)
    ) {
      return false;
    }
    segmentStart = index + 1;
  }
  return true;
}

async function normalizeAndFilterMatches(params: {
  readonly matches: readonly Buffer[];
  readonly target: ResolvedGlobTarget;
  readonly readCapability?: WorkspaceBoundReadCapability;
}): Promise<readonly string[]> {
  const safeMatches: string[] = [];
  for (const match of params.matches) {
    const normalizedBytes = normalizeRelativeRipgrepPathBytes(match);
    if (!isSafeRelativeRipgrepPathBytes(normalizedBytes)) continue;
    const decoded = decodeRipgrepPathBytes(normalizedBytes);
    if (params.readCapability !== undefined) {
      if (decoded === undefined) continue;
      const absolute = resolve(params.target.displayRoot, decoded);
      const relativeToSearchRoot = relative(params.target.searchRoot, absolute);
      if (
        relativeToSearchRoot.length === 0 ||
        relativeToSearchRoot === ".." ||
        relativeToSearchRoot.startsWith(`..${sep}`) ||
        isAbsolute(relativeToSearchRoot)
      ) {
        continue;
      }
      try {
        await params.readCapability.validateRelativeFile(relativeToSearchRoot);
      } catch {
        continue;
      }
      safeMatches.push(renderRipgrepPathBytes(normalizedBytes));
      continue;
    }
    if (decoded === undefined) {
      safeMatches.push(renderRipgrepPathBytes(normalizedBytes));
      continue;
    }
    const absolute = resolve(params.target.displayRoot, decoded);
    const check = await safePath(absolute, params.target.allowedPaths);
    if (!check.safe) continue;
    const st = await fs.stat(check.resolved).catch(() => undefined);
    if (!st || st.isDirectory()) continue;
    safeMatches.push(renderRipgrepPathBytes(normalizedBytes));
  }
  return safeMatches;
}

export async function discoverRipgrepRootIgnoreFiles(params: {
  readonly searchRoot: string;
  readonly displayRoot: string;
  readonly readCapability?: WorkspaceBoundReadCapability;
}): Promise<readonly RipgrepIgnoreFileSnapshot[]> {
  if (resolve(params.searchRoot) === resolve(params.displayRoot)) {
    return [];
  }
  const snapshots: RipgrepIgnoreFileSnapshot[] = [];
  for (const fileName of ROOT_IGNORE_FILES) {
    if (params.readCapability !== undefined) {
      const file = await params.readCapability.readRelativeFileIfExists(
        fileName,
        MAX_ROOT_IGNORE_FILE_BYTES,
      );
      if (file !== undefined) {
        snapshots.push({ sourceName: fileName, content: file.content });
      }
      continue;
    }
    const candidate = join(params.displayRoot, fileName);
    const content = await readVerifiedRipgrepIgnoreFile({
      path: candidate,
      allowedRoot: params.displayRoot,
      maximumBytes: MAX_ROOT_IGNORE_FILE_BYTES,
    });
    if (content !== undefined) {
      snapshots.push({ sourceName: fileName, content });
    }
  }
  return snapshots;
}

export function createGlobTool(
  config: GlobToolConfig | Pick<FilesystemToolConfig, "allowedPaths">,
): Tool {
  const allowedPaths = config.allowedPaths;
  const limit =
    "maxResults" in config && typeof config.maxResults === "number"
      ? Math.max(1, Math.floor(config.maxResults))
      : DEFAULT_MAX_RESULTS;
  const ripgrepCommand =
    "ripgrepCommand" in config && typeof config.ripgrepCommand === "string"
      ? config.ripgrepCommand
      : selectPinnedRipgrepPath();
  const afterFinalPathCheck =
    "__testAfterFinalPathCheck" in config
      ? config.__testAfterFinalPathCheck
      : undefined;
  const beforeReadCapabilityBind =
    "__testBeforeReadCapabilityBind" in config
      ? config.__testBeforeReadCapabilityBind
      : undefined;
  const afterRootIgnoreSnapshot =
    "__testAfterRootIgnoreSnapshot" in config
      ? config.__testAfterRootIgnoreSnapshot
      : undefined;

  return {
    name: GLOB_TOOL_NAME,
    description: GLOB_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["glob", "find", "files", "pattern", "wildcard"],
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
    },
    isReadOnly: true,
    recoveryCategory: "idempotent",
    requiresApproval: false,
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match files against.",
        },
        path: {
          type: "string",
          description:
            "Optional. Directory to search in. Defaults to the workspace root.",
        },
        includeIgnored: {
          type: "boolean",
          description:
            "Optional. When true, search gitignored and build/vendored output too (node_modules, target, dist, build, .localnet, lockfiles). Defaults to false: the walk respects .gitignore and skips generated/build dirs so it never enumerates large artifacts.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as GlobToolInput;
      const pattern = asNonEmptyString(args.pattern);
      if (pattern === undefined) {
        return errorResult("pattern must be a non-empty string");
      }
      try {
        assertGrepArgumentEncoding(pattern, "Glob pattern");
        const patternBytes = Buffer.byteLength(pattern, "utf8");
        if (patternBytes > MAX_GREP_GLOB_UTF8_BYTES) {
          return errorResult(
            `Glob error: pattern is ${patternBytes} UTF-8 bytes; maximum is ${MAX_GREP_GLOB_UTF8_BYTES}`,
          );
        }
        for (const [label, value] of [
          ["path", args.path],
          ["cwd", args.cwd],
        ] as const) {
          if (typeof value !== "string") continue;
          assertGrepArgumentEncoding(value, `Glob ${label}`);
          const pathBytes = Buffer.byteLength(value, "utf8");
          if (pathBytes > MAX_GREP_RAW_PATH_UTF8_BYTES) {
            return errorResult(
              `Glob error: ${label} is ${pathBytes} UTF-8 bytes; maximum is ${MAX_GREP_RAW_PATH_UTF8_BYTES}`,
            );
          }
        }
      } catch (error) {
        return errorResult(`Glob error: ${formatRipgrepFilesError(error)}`);
      }
      if (ripgrepCommand === undefined) {
        return errorResult(PINNED_RIPGREP_UNAVAILABLE_MESSAGE);
      }

      const target = await resolveGlobTarget({
        args: rawArgs,
        allowedPaths,
        pattern,
      });
      if ("error" in target) {
        return errorResult(target.error);
      }
      let readCapability: WorkspaceBoundReadCapability | undefined;
      let enumerationCapability: WorkspaceBoundReadCapability | undefined;
      let toolOperation: WorkspaceToolOperationToken | undefined;
      const bindReadCapabilities = async (): Promise<void> => {
        await beforeReadCapabilityBind?.();
        readCapability = await bindWorkspaceDirectoryReadCapability(
          target.searchRoot,
          { expectedIdentity: target.searchRootIdentity },
        );
        enumerationCapability =
          resolve(target.searchRoot) === resolve(target.displayRoot)
            ? readCapability
            : await bindWorkspaceDirectoryReadCapability(target.displayRoot, {
                expectedIdentity: target.displayRootIdentity,
              });
      };
      try {
        toolOperation = beginWorkspaceReadToolOperation(
          target.displayRoot,
          GLOB_TOOL_NAME,
        ).token;
        await bindReadCapabilities();
      } catch (error) {
        await enumerationCapability?.dispose().catch(() => {});
        if (enumerationCapability !== readCapability) {
          await readCapability?.dispose().catch(() => {});
        }
        if (toolOperation !== undefined) {
          endWorkspaceToolOperation(toolOperation);
        }
        return errorResult(
          `Glob error: authoritative Editor workspace files cannot be read safely: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      try {
        await afterFinalPathCheck?.();
        const startedAt = Date.now();
        const effectiveLimit = limit + 1;
        const signal = args.__abortSignal;
        const includeIgnored = asBoolean(args.includeIgnored) ?? false;
        const rootIgnoreFiles = includeIgnored
          ? []
          : await discoverRipgrepRootIgnoreFiles({
              searchRoot: target.searchRoot,
              displayRoot: target.displayRoot,
              ...(enumerationCapability !== undefined
                ? { readCapability: enumerationCapability }
                : {}),
            });
        await afterRootIgnoreSnapshot?.();
        let rawMatches: readonly Buffer[];
        let truncated = false;
        const rg = await runRipgrepFiles({
          command: ripgrepCommand,
          pattern: target.pattern,
          cwd: target.displayRoot,
          searchPath: relative(target.displayRoot, target.searchRoot) || ".",
          toolArgs: rawArgs,
          limit: effectiveLimit,
          includeIgnored,
          rootIgnoreFiles,
          signal,
          ...(enumerationCapability !== undefined
            ? { readCapability: enumerationCapability }
            : {}),
        });
        if (signal?.aborted || rg.aborted) {
          return errorResult("Glob aborted");
        }
        if (rg.stopReason === "timeout") {
          return errorResult("Glob error: ripgrep timed out.");
        }
        if (rg.stopReason === "output_limit") {
          return errorResult(
            "Glob error: ripgrep exceeded the output safety limit.",
          );
        }
        if (rg.spawnError) {
          return errorResult(
            isExecutableUnavailable(rg.spawnError)
              ? PINNED_RIPGREP_UNAVAILABLE_MESSAGE
              : `Glob error: ${formatRipgrepFilesError(rg.spawnError)}`,
          );
        } else if (rg.exitCode !== 0 && rg.pathRecords.length === 0) {
          const detail = rg.stderr.trim();
          if (detail.length > 0) {
            return errorResult(`Glob error: ${detail}`);
          }
          rawMatches = [];
        } else if (rg.exitCode !== 0 && !rg.killedAfterLimit) {
          const detail = rg.stderr.trim() || "ripgrep failed";
          return errorResult(`Glob error: ${detail}`);
        } else {
          rawMatches = rg.pathRecords;
          truncated = rg.killedAfterLimit || rg.pathRecords.length > limit;
        }

        const normalized = await normalizeAndFilterMatches({
          matches: rawMatches,
          target,
          ...(readCapability !== undefined ? { readCapability } : {}),
        });
        const kept = normalized.slice(0, limit);
        const elapsedMs = Date.now() - startedAt;
        const metadata = {
          pattern,
          searchRoot: target.searchRoot,
          numFiles: kept.length,
          durationMs: elapsedMs,
          truncated: truncated || normalized.length > limit,
        };

        if (kept.length === 0) {
          return textResult("No files found", metadata);
        }

        const lines = [...kept];
        if (metadata.truncated) {
          lines.push(TRUNCATION_NOTE);
        }
        return textResult(lines.join("\n"), metadata);
      } finally {
        try {
          try {
            await enumerationCapability?.dispose();
          } finally {
            if (enumerationCapability !== readCapability) {
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

export const __INTERNAL = {
  extractGlobBaseDirectory,
  toRelativeIfInside,
  DEFAULT_GLOB_EXCLUDE_GLOBS,
  buildRipgrepFilesArgs,
  assertRipgrepFilesArgvWithinLimits,
};

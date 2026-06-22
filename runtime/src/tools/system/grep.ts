/**
 * `Grep` — AgenC-owned ripgrep wrapper.
 *
 * Description text and input schema track the donor Grep contract for
 * AgenC's first-class search surface.
 *
 * - Invokes `rg` as a subprocess for performance.
 * - Three output modes: `content`, `files_with_matches` (default), `count`.
 * - Honors AgenC's `safePath` + `resolveToolAllowedPaths` for the optional
 *   `path` arg so search is bounded to the workspace allowlist.
 * - Falls back to a pure-JS regex search when `rg` is unavailable. The
 *   fallback supports `pattern`, `path`, `-i`, `glob`, `head_limit`, and
 *   `output_mode=content|files_with_matches`. `-B`/`-A`/`-C`/`type`/
 *   `multiline` and `output_mode=count` return a clear error in fallback.
 *
 * @module
 */

import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep, win32 } from "node:path";

import ignore from "ignore";

import { runCommand } from "../../utils/process.js";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { plainTextErrorToolResult as errorResult } from "../results.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";

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

const DEFAULT_HEAD_LIMIT = 250;
const MAX_RIPGREP_STDERR_CHARS = 128 * 1024;
const MAX_FALLBACK_FILES = 5_000;
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RENDERED_CONTENT_LINE_CHARS = 500;
// gaphunt3 #26/#30: the pure-JS fallback runs a model-controlled, backtracking
// V8 RegExp per line. Without bounds, a catastrophic pattern (e.g. `(a+)+$`)
// over a long line backtracks exponentially and pins the single-threaded
// event loop, and abort is only polled between files. Clamp each line to a few
// KB before the regex test (ripgrep's primary path is linear and immune), and
// enforce a wall-clock deadline checked between lines so an expensive scan
// aborts instead of hanging for the full tool timeout.
const MAX_FALLBACK_LINE_CHARS = 4_096;
const FALLBACK_SCAN_BUDGET_MS = 2_000;
const RIPGREP_MATCH_SEPARATOR = "\u001f";
const RIPGREP_CONTEXT_SEPARATOR = "\u001e";
const FALLBACK_IGNORE_FILES = [".gitignore", ".ignore", ".rgignore"] as const;

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
  - Fallback mode: If ripgrep is unavailable, search is limited to ${MAX_FALLBACK_FILES} matching candidate files under ${MAX_FALLBACK_FILE_BYTES} bytes each and reports a safety note when capped.
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
}

export interface GrepToolConfig {
  /** Allowed path prefixes (mirrors `FilesystemToolConfig.allowedPaths`). */
  readonly allowedPaths: readonly string[];
}

function textResult(content: string): ToolResult {
  return { content };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < 0) return undefined;
  return n;
}

function normalizeHeadLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_HEAD_LIMIT;
  return asNonNegativeInteger(value) ?? DEFAULT_HEAD_LIMIT;
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

let ripgrepAvailability: boolean | undefined;

/** Probe `rg` once per process and cache the result. */
async function isRipgrepAvailable(cwd: string): Promise<boolean> {
  if (ripgrepAvailability !== undefined) return ripgrepAvailability;
  try {
    const result = await runCommand("rg", ["--version"], {
      cwd,
      maxBuffer: 64 * 1024,
    });
    ripgrepAvailability = result.exitCode === 0;
  } catch {
    ripgrepAvailability = false;
  }
  return ripgrepAvailability;
}

/**
 * Test hook — reset the cached `rg` probe between unit tests.
 * Not exported via index.ts; only the test file imports it.
 */
export function __resetRipgrepProbeForTests(): void {
  ripgrepAvailability = undefined;
}

/**
 * Test hook for forcing the pure-JS fallback path without mutating PATH.
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

function splitRipgrepPathLine(
  line: string,
  displayRoot: string,
): { filePart: string; rest: string } | undefined {
  for (const separator of [
    RIPGREP_MATCH_SEPARATOR,
    RIPGREP_CONTEXT_SEPARATOR,
  ] as const) {
    const idx = line.indexOf(separator);
    if (idx <= 0) continue;
    const filePart = line.substring(0, idx);
    if (!isAbsolute(filePart) && !isWindowsAbsolutePath(filePart)) continue;
    if (!isPathInsideRoot(filePart, displayRoot)) continue;
    const renderedSeparator =
      separator === RIPGREP_MATCH_SEPARATOR ? ":" : "-";
    return {
      filePart,
      rest: `${renderedSeparator}${line
        .substring(idx + separator.length)
        .split(separator)
        .join(renderedSeparator)}`,
    };
  }
  return undefined;
}

function rewriteRipgrepContentLine(line: string, displayRoot: string): string {
  const split = splitRipgrepPathLine(line, displayRoot);
  if (split === undefined) return line;
  if (!isAbsolute(split.filePart) && !isWindowsAbsolutePath(split.filePart)) {
    return line;
  }
  return `${toRelativeIfInside(split.filePart, displayRoot)}${split.rest}`;
}

function emptyResultForMode(outputMode: OutputMode): ToolResult {
  return textResult(
    outputMode === "files_with_matches" ? "No files found." : "No matches found.",
  );
}

interface ResolvedTarget {
  readonly absolute: string;
  readonly searchRoot: string;
  readonly displayRoot: string;
  readonly displayPath: string;
  readonly isDirectory: boolean;
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
  let targetStat: Awaited<ReturnType<typeof stat>> | undefined;
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
    if (!candidateStat) continue;
    safe = candidateSafe;
    targetStat = candidateStat;
    break;
  }
  if (!safe) {
    if (lastDenied !== undefined) {
      return { error: `Access denied: ${lastDenied}` };
    }
    return { error: `Path does not exist: ${candidate}` };
  }
  if (!targetStat) {
    return { error: `Path does not exist: ${candidate}` };
  }
  const isDirectory = targetStat.isDirectory();
  const displayRoot =
    (await closestAllowedDisplayRoot(safe.resolved, allowedPaths)) ??
    (isDirectory ? safe.resolved : dirname(safe.resolved));
  return {
    absolute: safe.resolved,
    searchRoot: isDirectory ? safe.resolved : dirname(safe.resolved),
    displayRoot,
    displayPath: candidate,
    isDirectory,
    allowedPaths,
  };
}

function displayRootForTarget(target: ResolvedTarget): string {
  return target.displayRoot;
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
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly contextBoth?: number;
  readonly type?: string;
  readonly globs: readonly string[];
}

function buildRipgrepArgs(opts: RipgrepOptions): string[] {
  const args: string[] = ["--hidden"];
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`);
  }
  args.push("--max-columns", "500", "--max-columns-preview");

  if (opts.multiline) {
    args.push("-U", "--multiline-dotall");
  }
  if (opts.caseInsensitive) {
    args.push("-i");
  }
  if (opts.outputMode === "files_with_matches") {
    args.push("-l", "--sortr", "modified");
  } else if (opts.outputMode === "count") {
    args.push("-c", "--with-filename", "--sort", "path");
  } else {
    // content mode
    args.push(
      "--with-filename",
      "--field-match-separator",
      RIPGREP_MATCH_SEPARATOR,
      "--field-context-separator",
      RIPGREP_CONTEXT_SEPARATOR,
    );
    if (opts.showLineNumbers) args.push("-n");
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

  if (opts.pattern.startsWith("-")) {
    args.push("-e", opts.pattern);
  } else {
    args.push(opts.pattern);
  }

  if (opts.type) {
    args.push("--type", opts.type);
  }
  for (const glob of opts.globs) {
    args.push("--glob", glob);
  }

  args.push(opts.absolutePath);
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

function formatFallbackSafetyNote(): string {
  return "(fallback scan stopped at safety limit; refine query)";
}

function formatFallbackAbortedNote(): string {
  return "(fallback scan aborted: pattern too expensive; install ripgrep or refine query)";
}

// gaphunt3 #26/#30: bound the model-controlled regex by testing only a clamped
// prefix of each line. A short, bounded input defuses catastrophic
// backtracking (`(a+)+$` etc.) regardless of how long the underlying line is.
function fallbackLineMatches(re: RegExp, line: string): boolean {
  const probe =
    line.length > MAX_FALLBACK_LINE_CHARS
      ? line.slice(0, MAX_FALLBACK_LINE_CHARS)
      : line;
  // Re-create regex per test to avoid lastIndex carry-over.
  return new RegExp(re.source, re.flags).test(probe);
}

function collectionLineLimit(headLimit: number, offset: number): number {
  return offset + headLimit + 1;
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
    return textResult(offset > 0 ? `${empty} ${formatOffsetNote(offset)}` : empty);
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
  lines: readonly string[],
  truncated: boolean,
  headLimit: number,
  offset = 0,
): string {
  let totalMatches = 0;
  let fileCount = 0;
  for (const line of lines) {
    const idx = line.lastIndexOf(":");
    if (idx <= 0) continue;
    const count = Number.parseInt(line.substring(idx + 1), 10);
    if (!Number.isNaN(count)) {
      totalMatches += count;
      fileCount += 1;
    }
  }
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
  return textResult(offset > 0 ? `${empty} ${formatOffsetNote(offset)}` : empty);
}

interface LimitedRipgrepResult {
  readonly lines: readonly string[];
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killedAfterLimit: boolean;
  readonly aborted: boolean;
  readonly spawnError?: Error;
}

function appendBoundedText(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length > maxChars ? next.slice(0, maxChars) : next;
}

function runRipgrepCollectLines(params: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly lineLimit?: number;
  readonly signal?: AbortSignal;
}): Promise<LimitedRipgrepResult> {
  const { args, cwd, signal } = params;
  const lineLimit =
    params.lineLimit === undefined
      ? undefined
      : Math.max(1, Math.floor(params.lineLimit));

  return new Promise((resolve) => {
    const child = spawn("rg", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let carry = "";
    let stderr = "";
    let killedAfterLimit = false;
    let aborted = signal?.aborted === true;
    let settled = false;

    const finish = (
      exitCode: number | null,
      signalName: NodeJS.Signals | null,
      spawnError?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve({
        lines,
        stderr,
        exitCode,
        signal: signalName,
        killedAfterLimit,
        aborted,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    const stopAfterLimit = (): void => {
      if (killedAfterLimit || child.killed) return;
      killedAfterLimit = true;
      child.kill("SIGTERM");
    };

    const pushLine = (line: string): void => {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (normalized.length === 0) return;
      if (lineLimit === undefined || lines.length < lineLimit) {
        lines.push(normalized);
      }
      if (lineLimit !== undefined && lines.length >= lineLimit) {
        stopAfterLimit();
      }
    };

    const onAbort = (): void => {
      aborted = true;
      if (!child.killed) child.kill("SIGTERM");
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (killedAfterLimit || aborted) return;
      carry += chunk;
      while (!killedAfterLimit && !aborted) {
        const idx = carry.indexOf("\n");
        if (idx === -1) break;
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        pushLine(line);
      }
      if (killedAfterLimit || aborted) {
        carry = "";
      }
    });

    child.stdout.on("end", () => {
      if (!killedAfterLimit && !aborted && carry.length > 0) {
        pushLine(carry);
      }
      carry = "";
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBoundedText(stderr, chunk, MAX_RIPGREP_STDERR_CHARS);
    });

    child.on("error", (err: Error) => {
      finish(127, null, err);
    });

    child.on("close", (code, signalName) => {
      finish(code, signalName);
    });

    if (aborted) {
      onAbort();
    } else if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function runRipgrepGrep(params: {
  readonly opts: RipgrepOptions;
  readonly headLimit: number;
  readonly offset: number;
  readonly target: ResolvedTarget;
  readonly signal?: AbortSignal;
}): Promise<ToolResult> {
  const { opts, headLimit, offset, target, signal } = params;
  const args = buildRipgrepArgs(opts);
  const result = await runRipgrepCollectLines({
    args,
    cwd: target.searchRoot,
    ...(headLimit === 0
      ? {}
      : { lineLimit: collectionLineLimit(headLimit, offset) }),
    signal,
  });
  if (signal?.aborted || result.aborted) {
    return errorResult("Search aborted");
  }
  if (result.spawnError) {
    return errorResult(`Grep error: ${result.spawnError.message}`);
  }
  if (result.exitCode === 1 && result.lines.length === 0) {
    // Ripgrep convention: exit 1 = "no matches".
    return emptyRipgrepResultForMode(opts.outputMode, headLimit, offset);
  }
  const stoppedAfterCollectingEnough =
    result.killedAfterLimit && result.lines.length > 0;
  if (result.exitCode !== 0 && !stoppedAfterCollectingEnough) {
    const detail = result.stderr.trim() || "ripgrep failed";
    return errorResult(`Grep error: ${detail}`);
  }

  const rawLines = result.lines.filter((line) => line.length > 0);

  if (rawLines.length === 0) {
    return emptyRipgrepResultForMode(opts.outputMode, headLimit, offset);
  }

  const displayRoot = displayRootForTarget(target);

  if (opts.outputMode === "files_with_matches") {
    const relative = rawLines.map((p) => toRelativeIfInside(p, displayRoot));
    const { items, truncated } = applyTruncation(
      relative,
      headLimit,
      offset,
    );
    return formatFilesWithMatchesResult(items, truncated, headLimit, offset);
  }

  if (opts.outputMode === "count") {
    // Convert /abs/path:N → relpath:N
    const counts = rawLines.map((line) => {
      const idx = line.lastIndexOf(":");
      if (idx <= 0) return line;
      const filePart = line.substring(0, idx);
      const countPart = line.substring(idx);
      return `${toRelativeIfInside(filePart, displayRoot)}${countPart}`;
    });
    const { items, truncated } = applyTruncation(counts, headLimit, offset);
    const body = items.join("\n");
    const summary = formatCountSummary(
      items as readonly string[],
      truncated || result.killedAfterLimit,
      headLimit,
      offset,
    );
    return textResult(body.length > 0 ? `${body}\n\n${summary}` : summary);
  }

  // content mode: rewrite leading absolute path to relative for token savings.
  const rewritten = rawLines.map((line) =>
    rewriteRipgrepContentLine(line, displayRoot),
  );
  const { items, truncated } = applyTruncation(rewritten, headLimit, offset);
  const body = items.map(truncateRenderedContentLine).join("\n");
  const pagination = truncated || result.killedAfterLimit
    ? formatTruncationNote(headLimit, offset)
    : offset > 0
      ? formatOffsetNote(offset)
      : "";
  return textResult(pagination ? `${body}\n${pagination}` : body);
}

// ────────────────────────────────────────────────────────────────────────
// Pure-JS fallback
// ────────────────────────────────────────────────────────────────────────

function compileFallbackPattern(
  pattern: string,
  caseInsensitive: boolean,
): RegExp | { error: string } {
  try {
    return new RegExp(pattern, caseInsensitive ? "i" : "");
  } catch (err) {
    return {
      error: `invalid regex pattern: ${(err as Error).message}`,
    };
  }
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
    const base = slashIdx === -1 ? normalized : normalized.substring(slashIdx + 1);
    const candidates = [normalized, base];
    return matchers.some((re) => candidates.some((c) => re.test(c)));
  };
}

function globToRegExp(glob: string): RegExp {
  // Normalize separators to `/` for matching.
  const cleaned = glob.replace(/\\/g, "/");
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
      re += ".";
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

async function compileFallbackIgnoreMatcher(
  displayRoot: string,
): Promise<(path: string) => Promise<boolean>> {
  const cache = new Map<string, ReturnType<typeof ignore> | undefined>();

  async function matcherForDirectory(
    directory: string,
  ): Promise<ReturnType<typeof ignore> | undefined> {
    if (cache.has(directory)) return cache.get(directory);
    const matcher = ignore();
    let loaded = false;
    for (const fileName of FALLBACK_IGNORE_FILES) {
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

function formatFallbackContentLine(params: {
  readonly rel: string;
  readonly lineNumber: number;
  readonly line: string;
  readonly showLineNumbers: boolean;
}): string {
  const { rel, lineNumber, line, showLineNumbers } = params;
  return showLineNumbers ? `${rel}:${lineNumber}:${line}` : `${rel}:${line}`;
}

async function* walkFiles(
  root: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (abortSignal?.aborted) return;
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = (await readdir(current, { withFileTypes: true })) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (abortSignal?.aborted) return;
      const name = String(entry.name);
      if ((VCS_DIRECTORIES_TO_EXCLUDE as readonly string[]).includes(name)) {
        continue;
      }
      const full = join(current, name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        yield full;
      }
    }
  }
}

async function* iterTargetFiles(
  target: ResolvedTarget,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  if (target.isDirectory) {
    yield* walkFiles(target.absolute, abortSignal);
    return;
  }
  if (!abortSignal?.aborted) {
    yield target.absolute;
  }
}

async function runFallbackGrep(params: {
  readonly pattern: string;
  readonly target: ResolvedTarget;
  readonly outputMode: OutputMode;
  readonly caseInsensitive: boolean;
  readonly showLineNumbers: boolean;
  readonly globs: readonly string[];
  readonly headLimit: number;
  readonly offset: number;
  readonly signal?: AbortSignal;
}): Promise<ToolResult> {
  const {
    pattern,
    target,
    outputMode,
    caseInsensitive,
    showLineNumbers,
    globs,
    headLimit,
    offset,
    signal,
  } = params;
  if (outputMode === "count") {
    return errorResult(
      "Grep error: ripgrep ('rg') is not available; output_mode='count' requires ripgrep",
    );
  }
  const re = compileFallbackPattern(pattern, caseInsensitive);
  if ("error" in re) {
    return errorResult(`Grep error: ${re.error}`);
  }
  const matchesGlob = compileGlobMatcher(globs);

  const fileMatches: Array<{
    readonly rel: string;
    readonly mtimeMs: number;
  }> = [];
  const contentLines: string[] = [];
  let truncated = false;
  let fallbackSafetyCapped = false;
  let visitedFiles = 0;
  const displayRoot = displayRootForTarget(target);
  const isIgnored = await compileFallbackIgnoreMatcher(displayRoot);
  const fallbackCollectionLimit =
    headLimit === 0 ? 0 : collectionLineLimit(headLimit, offset);
  // gaphunt3 #26/#30: wall-clock deadline so an expensive scan (clamping
  // alone cannot defeat every adversarial pattern) terminates promptly
  // instead of hanging for the full tool timeout; checked between lines.
  const scanDeadline = Date.now() + FALLBACK_SCAN_BUDGET_MS;
  let fallbackScanAborted = false;

  for await (const filePath of iterTargetFiles(target, signal)) {
    if (signal?.aborted) {
      return errorResult("Search aborted");
    }
    const rel = toRelativeIfInside(filePath, displayRoot);
    if (await isIgnored(filePath)) continue;
    if (!matchesGlob(rel)) continue;
    const safe = await safePath(filePath, target.allowedPaths);
    if (!safe.safe) continue;
    let st;
    try {
      st = await stat(safe.resolved);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    visitedFiles += 1;
    if (visitedFiles > MAX_FALLBACK_FILES) {
      fallbackSafetyCapped = true;
      break;
    }
    if (st.size > MAX_FALLBACK_FILE_BYTES) {
      fallbackSafetyCapped = true;
      continue;
    }
    let text: string;
    try {
      text = await readFile(safe.resolved, "utf8");
    } catch {
      continue;
    }
    if (outputMode === "files_with_matches") {
      // gaphunt3 #26/#30: scan line-by-line with a clamped match probe and
      // poll abort/deadline between lines so a ReDoS pattern cannot wedge the
      // event loop mid-file and abort is honored without waiting for EOF.
      const fileLines = text.split(/\r?\n/);
      let matched = false;
      for (const fileLine of fileLines) {
        if (signal?.aborted) {
          return errorResult("Search aborted");
        }
        if (Date.now() >= scanDeadline) {
          fallbackScanAborted = true;
          break;
        }
        if (fallbackLineMatches(re, fileLine)) {
          matched = true;
          break;
        }
      }
      if (matched) {
        fileMatches.push({ rel, mtimeMs: st.mtimeMs ?? 0 });
        if (
          fallbackCollectionLimit !== 0 &&
          fileMatches.length > fallbackCollectionLimit
        ) {
          truncated = true;
          fileMatches.sort((a, b) => {
            const byTime = b.mtimeMs - a.mtimeMs;
            return byTime === 0 ? a.rel.localeCompare(b.rel) : byTime;
          });
          fileMatches.length = fallbackCollectionLimit;
        }
      }
      // Reset regex state when using global flag would be needed; not used here.
      if (fallbackScanAborted) break;
      continue;
    }

    // content mode
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      // gaphunt3 #26/#30: poll abort/deadline between lines so an in-flight
      // ReDoS scan can be cancelled and a runaway pattern terminates promptly.
      if (signal?.aborted) {
        return errorResult("Search aborted");
      }
      if (Date.now() >= scanDeadline) {
        fallbackScanAborted = true;
        break;
      }
      // gaphunt3 #26/#30: match against a clamped line probe (re-created per
      // test to avoid lastIndex carry-over) to bound backtracking cost.
      if (fallbackLineMatches(re, line)) {
        contentLines.push(
          formatFallbackContentLine({
            rel,
            lineNumber: i + 1,
            line,
            showLineNumbers,
          }),
        );
        if (
          fallbackCollectionLimit !== 0 &&
          contentLines.length > fallbackCollectionLimit
        ) {
          truncated = true;
          contentLines.length = fallbackCollectionLimit;
          break;
        }
      }
    }
    if (truncated || fallbackScanAborted) break;
  }

  if (outputMode === "files_with_matches") {
    const sorted = [...fileMatches]
      .sort((a, b) => {
        const byTime = b.mtimeMs - a.mtimeMs;
        return byTime === 0 ? a.rel.localeCompare(b.rel) : byTime;
      })
      .map((entry) => entry.rel);
    const limited = applyTruncation(sorted, headLimit, offset);
    const result = formatFilesWithMatchesResult(
      limited.items,
      truncated || limited.truncated,
      headLimit,
      offset,
    );
    // gaphunt3 #26/#30: surface when the scan was cut short by the deadline.
    const notes = [
      fallbackScanAborted ? formatFallbackAbortedNote() : undefined,
      fallbackSafetyCapped ? formatFallbackSafetyNote() : undefined,
    ].filter((note): note is string => note !== undefined);
    return notes.length > 0
      ? textResult([result.content, ...notes].join("\n"))
      : result;
  }

  const limitedContent = applyTruncation(contentLines, headLimit, offset);
  // gaphunt3 #26/#30: notes appended after the body when the scan was cut
  // short, so the model learns the result may be incomplete.
  const fallbackNotes = [
    fallbackScanAborted ? formatFallbackAbortedNote() : undefined,
    fallbackSafetyCapped ? formatFallbackSafetyNote() : undefined,
  ].filter((note): note is string => note !== undefined);

  if (limitedContent.items.length === 0) {
    const empty = offset > 0
      ? `No matches found. ${formatOffsetNote(offset)}`
      : "No matches found.";
    return textResult([empty, ...fallbackNotes].join("\n"));
  }
  const body = limitedContent.items.map(truncateRenderedContentLine).join("\n");
  const pagination = truncated || limitedContent.truncated
    ? formatTruncationNote(headLimit, offset)
    : offset > 0
      ? formatOffsetNote(offset)
      : "";
  const rendered = pagination
    ? `${body}\n${pagination}`
    : body;
  return textResult([rendered, ...fallbackNotes].join("\n"));
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

  return {
    name: GREP_TOOL_NAME,
    description: GREP_DESCRIPTION,
    metadata: {
      family: "search",
      source: "builtin",
      keywords: [
        "grep",
        "search",
        "ripgrep",
        "rg",
        "find",
        "regex",
      ],
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
          description:
            "The regular expression pattern to search for in file contents",
        },
        path: {
          type: "string",
          description:
            "File or directory to search in (rg PATH). Defaults to current working directory.",
        },
        glob: {
          type: "string",
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
          type: "number",
          description:
            'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
        },
        "-A": {
          type: "number",
          description:
            'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
        },
        "-C": {
          type: "number",
          description:
            'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
        },
        context: {
          type: "number",
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
          description:
            "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
        },
        head_limit: {
          type: "number",
          description:
            'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes. Defaults to 250. Pass 0 for unlimited output.',
        },
        offset: {
          type: "number",
          description:
            'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Defaults to 0.',
        },
        multiline: {
          type: "boolean",
          description:
            "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as GrepInput;
      const pattern = asString(args.pattern);
      if (!pattern) return errorResult("pattern must be a non-empty string");

      const outputModeResolved = normalizeOutputMode(args.output_mode);
      if (typeof outputModeResolved !== "string") {
        return errorResult(outputModeResolved.error);
      }
      const outputMode: OutputMode = outputModeResolved;

      const explicitPath = asString(args.path) ?? asString(args.cwd);
      const target = await resolveSearchPath({
        args: rawArgs,
        config: { allowedPaths },
        explicitPath,
      });
      if ("error" in target) {
        return errorResult(target.error);
      }

      const caseInsensitive = asBoolean(args["-i"]) ?? false;
      const showLineNumbers = asBoolean(args["-n"]) ?? true;
      const multiline = asBoolean(args.multiline) ?? false;
      const contextBefore = asNonNegativeInteger(args["-B"]);
      const contextAfter = asNonNegativeInteger(args["-A"]);
      const contextBoth =
        asNonNegativeInteger(args["-C"]) ??
        asNonNegativeInteger(args.context);
      const type = asString(args.type);
      const headLimit = normalizeHeadLimit(args.head_limit);
      const offset = asNonNegativeInteger(args.offset) ?? 0;
      const rawGlob = asString(args.glob);
      const globs = rawGlob ? splitGlobs(rawGlob) : [];

      const signal = args.__abortSignal;
      const cwdForProbe = target.searchRoot || process.cwd();
      const ripgrepReady = await isRipgrepAvailable(cwdForProbe);

      if (!ripgrepReady) {
        // Fallback path — narrow capability subset.
        const unsupported: string[] = [];
        if (contextBefore !== undefined) unsupported.push("-B");
        if (contextAfter !== undefined) unsupported.push("-A");
        if (contextBoth !== undefined) unsupported.push("-C");
        if (type !== undefined) unsupported.push("type");
        if (multiline) unsupported.push("multiline");
        if (outputMode === "count") unsupported.push("output_mode=count");
        if (unsupported.length > 0) {
          return errorResult(
            `Grep error: ripgrep ('rg') is not available; the following options are not supported by the fallback search: ${unsupported.join(", ")}`,
          );
        }
        return runFallbackGrep({
          pattern,
          target,
          outputMode,
          caseInsensitive,
          showLineNumbers,
          globs,
          headLimit,
          offset,
          signal,
        });
      }

      return runRipgrepGrep({
        opts: {
          pattern,
          absolutePath: target.absolute,
          outputMode,
          caseInsensitive,
          showLineNumbers,
          multiline,
          contextBefore,
          contextAfter,
          contextBoth,
          type,
          globs,
        },
        headLimit,
        offset,
        target,
        signal,
      });
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
  rewriteRipgrepContentLine,
  toRelativeIfInside: (p: string, root: string): string =>
    toRelativeIfInside(p, root),
  sep,
};

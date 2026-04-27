/**
 * `Grep` — port of openclaude `GrepTool`.
 *
 * Mature ripgrep wrapper lifted from openclaude
 * (`src/tools/GrepTool/GrepTool.ts` + `prompt.ts`). Description text and
 * input schema mirror the upstream contract field-by-field so a model
 * trained on openclaude's Grep prompt behaves identically here.
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

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { runCommand } from "../../utils/process.js";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";

export const GREP_TOOL_NAME = "Grep";

const BASH_TOOL_NAME = "Bash";
const AGENT_TOOL_NAME = "Agent";

/** Verbatim adaptation of openclaude `GrepTool/prompt.ts:7-17`. */
const GREP_DESCRIPTION = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`;

const VCS_DIRECTORIES_TO_EXCLUDE = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
] as const;

const DEFAULT_HEAD_LIMIT = 100;
const MAX_RIPGREP_BUFFER = 12 * 1024 * 1024;
const MAX_FALLBACK_FILES = 5_000;
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;

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
  readonly "-n"?: unknown;
  readonly "-i"?: unknown;
  readonly head_limit?: unknown;
  readonly multiline?: unknown;
}

export interface GrepToolConfig {
  /** Allowed path prefixes (mirrors `FilesystemToolConfig.allowedPaths`). */
  readonly allowedPaths: readonly string[];
}

function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
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

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n <= 0) return undefined;
  return n;
}

function normalizeOutputMode(value: unknown): OutputMode | { error: string } {
  if (value === undefined || value === null) return "content";
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

function splitGlobs(rawGlob: string): string[] {
  // Mirror openclaude (GrepTool.ts:392-409): split on whitespace, then on
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
  if (!isAbsolute(absPath)) return absPath;
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return absPath;
  return rel;
}

interface ResolvedTarget {
  readonly absolute: string;
  readonly searchRoot: string;
  readonly displayPath: string;
  readonly isDirectory: boolean;
}

async function resolveSearchPath(params: {
  readonly args: Record<string, unknown>;
  readonly config: GrepToolConfig;
  readonly explicitPath?: string;
}): Promise<ResolvedTarget | { error: string }> {
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
  const safe = await safePath(candidate, allowedPaths);
  if (!safe.safe) {
    return { error: `Access denied: ${safe.reason}` };
  }
  const targetStat = await stat(safe.resolved).catch(() => undefined);
  if (!targetStat) {
    return { error: `Path does not exist: ${candidate}` };
  }
  const isDirectory = targetStat.isDirectory();
  return {
    absolute: safe.resolved,
    searchRoot: isDirectory ? safe.resolved : dirname(safe.resolved),
    displayPath: candidate,
    isDirectory,
  };
}

function displayRootForTarget(target: ResolvedTarget): string {
  return target.isDirectory ? target.absolute : target.searchRoot;
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
  args.push("--max-columns", "500");

  if (opts.multiline) {
    args.push("-U", "--multiline-dotall");
  }
  if (opts.caseInsensitive) {
    args.push("-i");
  }
  if (opts.outputMode === "files_with_matches") {
    args.push("-l");
  } else if (opts.outputMode === "count") {
    args.push("-c");
  } else {
    // content mode
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
): { items: readonly T[]; truncated: boolean } {
  if (items.length > headLimit) {
    return { items: items.slice(0, headLimit), truncated: true };
  }
  return { items, truncated: false };
}

function formatTruncationNote(headLimit: number): string {
  return `(results truncated at ${headLimit}; refine query)`;
}

async function runRipgrepGrep(params: {
  readonly opts: RipgrepOptions;
  readonly headLimit: number;
  readonly target: ResolvedTarget;
  readonly signal?: AbortSignal;
}): Promise<ToolResult> {
  const { opts, headLimit, target, signal } = params;
  const args = buildRipgrepArgs(opts);
  const result = await runCommand("rg", args, {
    cwd: target.searchRoot,
    maxBuffer: MAX_RIPGREP_BUFFER,
  });
  if (signal?.aborted) {
    return errorResult("Search aborted");
  }
  if (result.exitCode === 1) {
    // Ripgrep convention: exit 1 = "no matches".
    return textResult("No matches found.");
  }
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "ripgrep failed";
    return errorResult(`Grep error: ${detail}`);
  }

  const rawLines = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) {
    return textResult("No matches found.");
  }

  const displayRoot = displayRootForTarget(target);

  if (opts.outputMode === "files_with_matches") {
    const relative = rawLines.map((p) => toRelativeIfInside(p, displayRoot));
    const { items, truncated } = applyTruncation(relative, headLimit);
    const body = items.join("\n");
    return textResult(
      truncated ? `${body}\n${formatTruncationNote(headLimit)}` : body,
    );
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
    const { items, truncated } = applyTruncation(counts, headLimit);
    const body = items.join("\n");
    return textResult(
      truncated ? `${body}\n${formatTruncationNote(headLimit)}` : body,
    );
  }

  // content mode: rewrite leading absolute path to relative for token savings.
  const rewritten = rawLines.map((line) => {
    const idx = line.indexOf(":");
    if (idx <= 0) return line;
    const filePart = line.substring(0, idx);
    const rest = line.substring(idx);
    if (!isAbsolute(filePart)) return line;
    return `${toRelativeIfInside(filePart, displayRoot)}${rest}`;
  });
  const { items, truncated } = applyTruncation(rewritten, headLimit);
  const body = items.join("\n");
  return textResult(
    truncated ? `${body}\n${formatTruncationNote(headLimit)}` : body,
  );
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
  // Lightweight glob → regex (`**` → match any, `*` → no slash, `?` → one char).
  const matchers = globs.map((glob) => globToRegExp(glob));
  return (path) => {
    const candidates = [path, basename(path)];
    return matchers.some((re) => candidates.some((c) => re.test(c)));
  };
}

function globToRegExp(glob: string): RegExp {
  // Normalize separators to `/` for matching.
  const cleaned = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i] ?? "";
    if (ch === "*") {
      if (cleaned[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (cleaned[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += ".";
    } else if (".+^$|()[]{}\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

async function* walkFiles(
  root: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const stack: string[] = [root];
  let visited = 0;
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
        visited += 1;
        if (visited > MAX_FALLBACK_FILES) return;
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
  readonly globs: readonly string[];
  readonly headLimit: number;
  readonly signal?: AbortSignal;
}): Promise<ToolResult> {
  const { pattern, target, outputMode, caseInsensitive, globs, headLimit, signal } =
    params;
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

  const fileMatches: string[] = [];
  const contentLines: string[] = [];
  let truncated = false;
  const displayRoot = displayRootForTarget(target);

  for await (const filePath of iterTargetFiles(target, signal)) {
    if (signal?.aborted) {
      return errorResult("Search aborted");
    }
    const rel = toRelativeIfInside(filePath, displayRoot);
    if (!matchesGlob(rel)) continue;
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FALLBACK_FILE_BYTES) continue;
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    if (outputMode === "files_with_matches") {
      if (re.test(text)) {
        fileMatches.push(rel);
        if (fileMatches.length > headLimit) {
          truncated = true;
          fileMatches.length = headLimit;
          break;
        }
      }
      // Reset regex state when using global flag would be needed; not used here.
      continue;
    }

    // content mode
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      // Re-create regex per test to avoid lastIndex carry-over (no `g` flag, but be safe).
      if (new RegExp(re.source, re.flags).test(line)) {
        contentLines.push(`${rel}:${i + 1}:${line}`);
        if (contentLines.length > headLimit) {
          truncated = true;
          contentLines.length = headLimit;
          break;
        }
      }
    }
    if (truncated) break;
  }

  if (outputMode === "files_with_matches") {
    if (fileMatches.length === 0) {
      return textResult("No matches found.");
    }
    const sorted = [...fileMatches].sort();
    const body = sorted.join("\n");
    return textResult(
      truncated ? `${body}\n${formatTruncationNote(headLimit)}` : body,
    );
  }

  if (contentLines.length === 0) {
    return textResult("No matches found.");
  }
  const body = contentLines.join("\n");
  return textResult(
    truncated ? `${body}\n${formatTruncationNote(headLimit)}` : body,
  );
}

// ────────────────────────────────────────────────────────────────────────
// Tool factory
// ────────────────────────────────────────────────────────────────────────

export function createGrepTool(config?: GrepToolConfig): Tool {
  // Default to process.cwd() when caller doesn't pass an allowlist (mirrors
  // the openclaude default of `getCwd()`). Production wiring always passes
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
            'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths, "count" shows match counts. Defaults to "content".',
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
            'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes. Defaults to 100.',
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
      const contextBoth = asNonNegativeInteger(args["-C"]);
      const type = asString(args.type);
      const headLimit =
        asPositiveInteger(args.head_limit) ?? DEFAULT_HEAD_LIMIT;
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
          globs,
          headLimit,
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
        target,
        signal,
      });
    },
  };
}

export default createGrepTool;

// Re-export internal symbols used solely by the test file. Kept at the
// bottom so the public surface above is easy to scan.
export const __INTERNAL = {
  splitGlobs,
  buildRipgrepArgs,
  globToRegExp,
  toRelativeIfInside: (p: string, root: string): string =>
    toRelativeIfInside(p, root),
  sep,
};

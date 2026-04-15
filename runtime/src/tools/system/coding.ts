import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";

import type { Tool, ToolCatalogEntry, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import {
  hasSessionRead,
  recordSessionRead,
  resolveSessionId,
  resolveToolAllowedPaths,
  safePath,
} from "./filesystem.js";
import {
  CodeIntelManager,
  collectWorkspaceLanguages,
  toRelativeWorkspacePath,
} from "./code-intel.js";
import { matchGlob } from "../../policy/glob.js";
import { silentLogger, type Logger } from "../../utils/logger.js";
import { runCommand } from "../../utils/process.js";

export const SESSION_ADVERTISED_TOOL_NAMES_ARG = "__agencAdvertisedToolNames";

export interface CodingToolConfig {
  readonly allowedPaths: readonly string[];
  readonly persistenceRootDir: string;
  readonly logger?: Logger;
  readonly getToolCatalog?: () => readonly ToolCatalogEntry[];
}

const MAX_RESULTS = 200;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_DIFF_BYTES = 256_000;
const TEXT_FILE_SIZE_LIMIT = 512_000;
const MAX_RIPGREP_BUFFER = 12 * 1024 * 1024;
const RIPGREP_REQUIRED_ERROR =
  "ripgrep (rg) is required for coding search tools but is not available on PATH";
const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".hg", ".jj", ".svn"] as const;
const MANIFEST_NAMES = [
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Makefile",
  "README.md",
] as const;

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function okResult(data: unknown): ToolResult {
  return { content: safeStringify(data) };
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function normalizeNonNegativeInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function toOptionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function resolveSearchGlobPatterns(args: Record<string, unknown>): readonly string[] | undefined {
  const patterns = [
    ...(
      typeof args.glob === "string"
        ? [args.glob]
        : Array.isArray(args.glob)
          ? args.glob.filter((entry): entry is string => typeof entry === "string")
          : []
    ),
    ...(toOptionalStringArray(args.filePatterns) ?? []),
  ]
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index);
  return patterns.length > 0 ? patterns : undefined;
}

async function resolveWorkspacePath(params: {
  readonly config: CodingToolConfig;
  readonly args: Record<string, unknown>;
  readonly pathArgKeys?: readonly string[];
}): Promise<string | { error: string }> {
  const rawPath = params.pathArgKeys
    ?.map((key) => toOptionalString(params.args[key]))
    .find((value): value is string => typeof value === "string") ??
    toOptionalString(params.args.cwd);

  if (!rawPath) {
    return { error: "path is required when no default working directory is available" };
  }
  const allowedPaths = resolveToolAllowedPaths(params.config.allowedPaths, params.args);
  const safe = await safePath(rawPath, allowedPaths);
  if (!safe.safe) {
    return { error: safe.reason ?? "Path is outside allowed directories" };
  }
  return safe.resolved;
}

interface ResolvedSearchTarget {
  readonly searchPath: string;
  readonly searchRoot: string;
  readonly targetArg: string;
  readonly isDirectory: boolean;
}

async function resolveSearchTarget(params: {
  readonly config: CodingToolConfig;
  readonly args: Record<string, unknown>;
  readonly pathArgKeys?: readonly string[];
}): Promise<ResolvedSearchTarget | { error: string }> {
  const workspacePath = await resolveWorkspacePath(params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const target = await stat(workspacePath).catch(() => undefined);
  if (!target) {
    return { error: `Path does not exist: ${workspacePath}` };
  }
  if (target.isDirectory()) {
    return {
      searchPath: workspacePath,
      searchRoot: workspacePath,
      targetArg: ".",
      isDirectory: true,
    };
  }
  return {
    searchPath: workspacePath,
    searchRoot: dirname(workspacePath),
    targetArg: basename(workspacePath),
    isDirectory: false,
  };
}

async function resolveRepoRoot(params: {
  readonly config: CodingToolConfig;
  readonly args: Record<string, unknown>;
  readonly pathArgKeys?: readonly string[];
}): Promise<string | { error: string }> {
  const workspacePath = await resolveWorkspacePath(params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const target = await stat(workspacePath).catch(() => undefined);
  const cwd = target?.isDirectory() ? workspacePath : dirname(workspacePath);
  const result = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    cwd,
  });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    return { error: `No git repository found for ${cwd}` };
  }
  return resolvePath(result.stdout.trim());
}

async function listRepoFiles(repoRoot: string): Promise<readonly string[]> {
  const gitFiles = await runCommand(
    "git",
    ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot },
  );
  if (gitFiles.exitCode === 0) {
    return gitFiles.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => resolvePath(repoRoot, entry));
  }

  const files: string[] = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

let ripgrepAvailability: boolean | undefined;

async function ensureRipgrepAvailable(cwd: string): Promise<string | undefined> {
  if (ripgrepAvailability === true) return undefined;
  if (ripgrepAvailability === false) return RIPGREP_REQUIRED_ERROR;
  const result = await runCommand("rg", ["--version"], {
    cwd,
    maxBuffer: 64 * 1024,
  });
  if (result.exitCode === 0) {
    ripgrepAvailability = true;
    return undefined;
  }
  ripgrepAvailability = false;
  return RIPGREP_REQUIRED_ERROR;
}

function appendRipgrepPathFilters(
  args: string[],
  options: {
    readonly globPatterns?: readonly string[];
    readonly type?: string;
  },
): void {
  for (const directory of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${directory}`);
    args.push("--glob", `!${directory}/**`);
  }
  for (const pattern of options.globPatterns ?? []) {
    args.push("--glob", pattern);
  }
  if (options.type) {
    args.push("--type", options.type);
  }
}

function describeRipgrepFailure(
  result: Awaited<ReturnType<typeof runCommand>>,
  fallback: string,
): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

async function listSearchTargetFiles(params: {
  readonly target: ResolvedSearchTarget;
  readonly globPatterns?: readonly string[];
}): Promise<
  | {
      readonly searchPath: string;
      readonly searchRoot: string;
      readonly matches: readonly string[];
    }
  | { error: string }
> {
  const missingRipgrep = await ensureRipgrepAvailable(params.target.searchRoot);
  if (missingRipgrep) {
    return { error: missingRipgrep };
  }
  if (!params.target.isDirectory) {
    const relativePath = basename(params.target.searchPath);
    const matchesGlob =
      !params.globPatterns ||
      params.globPatterns.some((pattern) =>
        matchGlob(pattern, relativePath) || matchGlob(pattern, basename(relativePath))
      );
    return {
      searchPath: params.target.searchPath,
      searchRoot: params.target.searchRoot,
      matches: matchesGlob ? [relativePath] : [],
    };
  }
  const rgArgs = ["--files", "--hidden"];
  appendRipgrepPathFilters(rgArgs, { globPatterns: params.globPatterns });
  rgArgs.push(params.target.targetArg);
  const result = await runCommand("rg", rgArgs, {
    cwd: params.target.searchRoot,
    maxBuffer: MAX_RIPGREP_BUFFER,
  });
  if (result.exitCode !== 0) {
    return {
      error: describeRipgrepFailure(result, "ripgrep file listing failed"),
    };
  }
  const matches = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/^\.\//, ""))
    .filter((entry) => entry.length > 0);
  return {
    searchPath: params.target.searchPath,
    searchRoot: params.target.searchRoot,
    matches,
  };
}

function passesFileFilters(filePath: string, params: {
  readonly repoRoot: string;
  readonly globPatterns?: readonly string[];
  readonly query?: string;
  readonly regex?: RegExp;
}): boolean {
  const relativePath = toRelativeWorkspacePath(params.repoRoot, filePath);
  if (params.globPatterns && params.globPatterns.length > 0) {
    const matched = params.globPatterns.some((pattern) =>
      matchGlob(pattern, relativePath) ||
      matchGlob(pattern, basename(relativePath))
    );
    if (!matched) return false;
  }
  if (params.query) {
    const lower = params.query.toLowerCase();
    if (
      !basename(relativePath).toLowerCase().includes(lower) &&
      !relativePath.toLowerCase().includes(lower)
    ) {
      return false;
    }
  }
  if (params.regex && !params.regex.test(relativePath)) {
    params.regex.lastIndex = 0;
    return false;
  }
  if (params.regex) {
    params.regex.lastIndex = 0;
  }
  return true;
}

async function readTextFile(path: string): Promise<string | undefined> {
  const fileStat = await stat(path).catch(() => undefined);
  if (!fileStat?.isFile() || fileStat.size > TEXT_FILE_SIZE_LIMIT) {
    return undefined;
  }
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (!text || text.includes("\0")) {
    return undefined;
  }
  return text;
}

function collectMatchSnippets(params: {
  readonly lines: readonly string[];
  readonly matchLineIndex: number;
  readonly before: number;
  readonly after: number;
}): string[] {
  const start = Math.max(0, params.matchLineIndex - params.before);
  const end = Math.min(params.lines.length - 1, params.matchLineIndex + params.after);
  const snippets: string[] = [];
  for (let index = start; index <= end; index += 1) {
    snippets.push(params.lines[index] ?? "");
  }
  return snippets;
}

async function collectFileContextSnippet(params: {
  readonly searchRoot: string;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly contextLines: number;
  readonly cache: Map<string, readonly string[]>;
}): Promise<readonly string[]> {
  if (params.contextLines === 0) {
    const cached = params.cache.get(params.relativePath);
    if (cached) {
      return [cached[Math.max(0, params.lineNumber - 1)] ?? ""];
    }
  }
  let lines = params.cache.get(params.relativePath);
  if (!lines) {
    const text = await readTextFile(resolvePath(params.searchRoot, params.relativePath));
    lines = text ? text.split(/\r?\n/) : [];
    params.cache.set(params.relativePath, lines);
  }
  if (lines.length === 0) return [];
  return collectMatchSnippets({
    lines,
    matchLineIndex: Math.max(0, params.lineNumber - 1),
    before: params.contextLines,
    after: params.contextLines,
  });
}

function parseStatusPorcelain(stdout: string): {
  readonly branch?: string;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly detached: boolean;
  readonly changed: readonly {
    path: string;
    x: string;
    y: string;
  }[];
} {
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const changed: {
    path: string;
    x: string;
    y: string;
  }[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const branchLine = line.slice(3).trim();
      const [headPart, trackingPart] = branchLine.split("...");
      if (headPart === "HEAD (no branch)" || headPart === "HEAD") {
        detached = true;
      } else {
        branch = headPart;
      }
      if (trackingPart) {
        const trackingMatch = /([^[]+)(?: \[(ahead (\d+))?(?:, )?(behind (\d+))?\])?/.exec(
          trackingPart,
        );
        if (trackingMatch) {
          upstream = trackingMatch[1]?.trim() || undefined;
          ahead = Number(trackingMatch[3] ?? 0);
          behind = Number(trackingMatch[5] ?? 0);
        }
      }
      continue;
    }
    const prefix = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    changed.push({ path, x: prefix[0] ?? " ", y: prefix[1] ?? " " });
  }

  return { branch, upstream, ahead, behind, detached, changed };
}

function summarizeChanges(changed: readonly {
  path: string;
  x: string;
  y: string;
}[]): Record<string, readonly string[]> {
  const staged = changed.filter((entry) => entry.x !== " ").map((entry) => entry.path);
  const unstaged = changed.filter((entry) => entry.y !== " ").map((entry) => entry.path);
  const untracked = changed
    .filter((entry) => entry.x === "?" || entry.y === "?")
    .map((entry) => entry.path);
  const conflicted = changed
    .filter((entry) => "AUUDDC".includes(entry.x) || "AUUDDC".includes(entry.y))
    .map((entry) => entry.path);
  return {
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

interface ParsedFilePatch {
  readonly oldPath: string;
  readonly newPath: string;
  readonly hunks: readonly ParsedHunk[];
  readonly createsFile: boolean;
  readonly deletesFile: boolean;
}

interface ParsedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly string[];
}

function parseUnifiedDiff(diffText: string): ParsedFilePatch[] {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const patches: ParsedFilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("--- ")) {
      index += 1;
      continue;
    }
    const oldPathRaw = line.slice(4).trim();
    const nextLine = lines[index + 1] ?? "";
    if (!nextLine.startsWith("+++ ")) {
      throw new Error("Invalid unified diff: missing +++ header");
    }
    const newPathRaw = nextLine.slice(4).trim();
    index += 2;
    const hunks: ParsedHunk[] = [];
    while (index < lines.length) {
      const hunkHeader = lines[index] ?? "";
      if (hunkHeader.startsWith("--- ")) {
        break;
      }
      if (!hunkHeader.startsWith("@@ ")) {
        index += 1;
        continue;
      }
      const match =
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);
      if (!match) {
        throw new Error(`Invalid unified diff hunk header: ${hunkHeader}`);
      }
      index += 1;
      const hunkLines: string[] = [];
      while (index < lines.length) {
        const hunkLine = lines[index] ?? "";
        if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("--- ")) {
          break;
        }
        if (hunkLine.startsWith("\\ No newline at end of file")) {
          index += 1;
          continue;
        }
        hunkLines.push(hunkLine);
        index += 1;
      }
      hunks.push({
        oldStart: Number(match[1] ?? 0),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3] ?? 0),
        newCount: Number(match[4] ?? 1),
        lines: hunkLines,
      });
    }
    patches.push({
      oldPath: stripDiffPath(oldPathRaw),
      newPath: stripDiffPath(newPathRaw),
      hunks,
      createsFile: oldPathRaw === "/dev/null",
      deletesFile: newPathRaw === "/dev/null",
    });
  }
  return patches;
}

function stripDiffPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return trimmed;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function applyParsedPatchToLines(params: {
  readonly originalLines: readonly string[];
  readonly patch: ParsedFilePatch;
}): string[] {
  const next: string[] = [];
  let cursor = 0;
  for (const hunk of params.patch.hunks) {
    const targetIndex = Math.max(0, hunk.oldStart - 1);
    while (cursor < targetIndex && cursor < params.originalLines.length) {
      next.push(params.originalLines[cursor] ?? "");
      cursor += 1;
    }
    for (const line of hunk.lines) {
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === " ") {
        const existing = params.originalLines[cursor] ?? "";
        if (existing !== content) {
          throw new Error(`Patch context mismatch near line ${cursor + 1}`);
        }
        next.push(existing);
        cursor += 1;
        continue;
      }
      if (prefix === "-") {
        const existing = params.originalLines[cursor] ?? "";
        if (existing !== content) {
          throw new Error(`Patch removal mismatch near line ${cursor + 1}`);
        }
        cursor += 1;
        continue;
      }
      if (prefix === "+") {
        next.push(content);
      }
    }
  }
  while (cursor < params.originalLines.length) {
    next.push(params.originalLines[cursor] ?? "");
    cursor += 1;
  }
  return next;
}

async function resolvePatchTargetPath(params: {
  readonly patchPath: string;
  readonly repoRoot: string;
  readonly allowedPaths: readonly string[];
}): Promise<string> {
  const absolutePath = resolvePath(params.repoRoot, params.patchPath);
  const safe = await safePath(absolutePath, params.allowedPaths);
  if (!safe.safe) {
    throw new Error(safe.reason ?? `Path ${params.patchPath} is outside allowed directories`);
  }
  return safe.resolved;
}

function scoreCatalogEntry(entry: ToolCatalogEntry, query?: string): number {
  if (!query) return 10;
  const lowered = query.toLowerCase();
  if (entry.name.toLowerCase() === lowered) return 0;
  if (entry.name.toLowerCase().startsWith(lowered)) return 1;
  if (entry.description.toLowerCase().includes(lowered)) return 2;
  if (entry.metadata.keywords?.some((keyword) => keyword.toLowerCase().includes(lowered))) {
    return 3;
  }
  return 4;
}

export function createCodingTools(config: CodingToolConfig): readonly Tool[] {
  const logger = config.logger ?? silentLogger;
  const codeIntel = new CodeIntelManager({
    persistenceRootDir: config.persistenceRootDir,
    logger,
  });

  const metadata = (
    name: string,
    mutating = false,
    preferredProfiles: readonly string[] = ["coding", "validation", "documentation"],
  ): Tool["metadata"] => ({
    family: "coding",
    source: "builtin",
    preferredProfiles,
    mutating,
    keywords: name.split("."),
    hiddenByDefault: false,
  });

  const grepTool: Tool = {
    name: "system.grep",
    description:
      "Search path-scoped files for content matches using ripgrep behind a native structured grep surface. Prefer this over raw shell grep/rg for coding workflows.",
    metadata: metadata("system.grep"),
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "File or directory to search. Defaults to the working directory." },
        caseSensitive: { type: "boolean" },
        regex: { type: "boolean", description: "Treat pattern as a regex. Defaults to false." },
        glob: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        filePatterns: { type: "array", items: { type: "string" } },
        type: { type: "string", description: "Optional ripgrep file type filter (for example ts, js, py)." },
        contextLines: { type: "integer", minimum: 0, maximum: 10 },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
        headLimit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
        offset: { type: "integer", minimum: 0, maximum: 10_000 },
        outputMode: { type: "string", description: "Optional additive output mode: matches (default), content, or count." },
        multiline: { type: "boolean", description: "Enable multiline ripgrep mode. Supported only when outputMode is content." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args) {
      const pattern = toOptionalString(args.pattern);
      if (!pattern) return errorResult("pattern must be a non-empty string");
      const target = await resolveSearchTarget({
        config,
        args,
        pathArgKeys: ["path"],
      });
      if ("error" in target) {
        return errorResult(target.error);
      }
      const missingRipgrep = await ensureRipgrepAvailable(target.searchRoot);
      if (missingRipgrep) return errorResult(missingRipgrep);
      const outputMode = toOptionalString(args.outputMode) ?? "matches";
      if (!["matches", "content", "count"].includes(outputMode)) {
        return errorResult("outputMode must be one of matches, content, or count");
      }
      if (args.multiline === true && outputMode !== "content") {
        return errorResult("multiline is only supported when outputMode is content");
      }
      const contextLines = normalizeNonNegativeInteger(
        args.contextLines,
        DEFAULT_CONTEXT_LINES,
        10,
      );
      const globPatterns = resolveSearchGlobPatterns(args);
      const type = toOptionalString(args.type);
      const headLimit = normalizePositiveInteger(
        args.headLimit ?? args.maxResults,
        normalizePositiveInteger(args.maxResults, 50, MAX_RESULTS),
        MAX_RESULTS,
      );
      const offset = normalizeNonNegativeInteger(args.offset, 0, 10_000);
      const baseArgs = ["--hidden", "--max-columns", "500"];
      appendRipgrepPathFilters(baseArgs, { globPatterns, type });
      if (args.caseSensitive !== true) {
        baseArgs.push("-i");
      }
      if (args.multiline === true) {
        baseArgs.push("-U", "--multiline-dotall");
      }
      if (args.regex !== true) {
        baseArgs.push("-F");
      }
      const patternArgs = pattern.startsWith("-") ? ["-e", pattern] : [pattern];

      if (outputMode === "content") {
        const rgArgs = [...baseArgs, "-n"];
        if (contextLines > 0) {
          rgArgs.push("-C", String(contextLines));
        }
        rgArgs.push(...patternArgs, target.targetArg);
        const result = await runCommand("rg", rgArgs, {
          cwd: target.searchRoot,
          maxBuffer: MAX_RIPGREP_BUFFER,
        });
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return errorResult(describeRipgrepFailure(result, "ripgrep search failed"));
        }
        const lines = result.stdout
          .replace(/\s+$/, "")
          .split(/\r?\n/)
          .filter((line) => line.length > 0);
        const pagedLines = lines.slice(offset, offset + headLimit);
        return okResult({
          repoRoot: target.searchRoot,
          searchRoot: target.searchRoot,
          searchPath: target.searchPath,
          pattern,
          regex: args.regex === true,
          caseSensitive: args.caseSensitive === true,
          outputMode,
          multiline: args.multiline === true,
          appliedLimit: headLimit,
          appliedOffset: offset,
          truncated: lines.length > offset + pagedLines.length,
          content: pagedLines.join("\n"),
        });
      }

      const rgArgs = [
        ...baseArgs,
        "--json",
        "--line-number",
        "--column",
        ...patternArgs,
        target.targetArg,
      ];
      const result = await runCommand("rg", rgArgs, {
        cwd: target.searchRoot,
        maxBuffer: MAX_RIPGREP_BUFFER,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return errorResult(describeRipgrepFailure(result, "ripgrep search failed"));
      }
      const snippetCache = new Map<string, readonly string[]>();
      const matches: {
        filePath: string;
        line: number;
        column: number;
        matchText: string;
        snippet: readonly string[];
      }[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type !== "match") continue;
        const data =
          typeof event.data === "object" && event.data !== null
            ? (event.data as Record<string, unknown>)
            : undefined;
        const pathData =
          typeof data?.path === "object" && data.path !== null
            ? (data.path as Record<string, unknown>)
            : undefined;
        const relativePath =
          typeof pathData?.text === "string"
            ? pathData.text.replace(/^\.\//, "")
            : typeof pathData?.bytes === "string"
              ? Buffer.from(pathData.bytes, "base64").toString("utf8").replace(/^\.\//, "")
              : undefined;
        const lineNumber =
          typeof data?.line_number === "number" ? data.line_number : undefined;
        const submatches = Array.isArray(data?.submatches)
          ? data.submatches.filter(
              (entry): entry is Record<string, unknown> =>
                typeof entry === "object" && entry !== null,
            )
          : [];
        if (!relativePath || !lineNumber || submatches.length === 0) {
          continue;
        }
        const snippet = await collectFileContextSnippet({
          searchRoot: target.searchRoot,
          relativePath,
          lineNumber,
          contextLines,
          cache: snippetCache,
        });
        for (const submatch of submatches) {
          const column =
            typeof submatch.start === "number" ? submatch.start + 1 : 1;
          const matchText =
            typeof submatch.match === "object" &&
            submatch.match !== null &&
            typeof (submatch.match as { text?: unknown }).text === "string"
              ? (submatch.match as { text: string }).text
              : "";
          matches.push({
            filePath: relativePath,
            line: lineNumber,
            column,
            matchText,
            snippet,
          });
        }
      }
      const pagedMatches = matches.slice(offset, offset + headLimit);
      if (outputMode === "count") {
        const fileCount = new Set(matches.map((match) => match.filePath)).size;
        return okResult({
          repoRoot: target.searchRoot,
          searchRoot: target.searchRoot,
          searchPath: target.searchPath,
          pattern,
          regex: args.regex === true,
          caseSensitive: args.caseSensitive === true,
          outputMode,
          appliedLimit: headLimit,
          appliedOffset: offset,
          numFiles: fileCount,
          numMatches: matches.length,
          truncated: matches.length > offset + pagedMatches.length,
          content: `Found ${matches.length} ${matches.length === 1 ? "match" : "matches"} across ${fileCount} ${fileCount === 1 ? "file" : "files"}.`,
        });
      }
      return okResult({
        repoRoot: target.searchRoot,
        searchRoot: target.searchRoot,
        searchPath: target.searchPath,
        pattern,
        regex: args.regex === true,
        caseSensitive: args.caseSensitive === true,
        appliedLimit: headLimit,
        appliedOffset: offset,
        truncated: matches.length > offset + pagedMatches.length,
        matches: pagedMatches,
      });
    },
  };

  const globTool: Tool = {
    name: "system.glob",
    description:
      "Match path-scoped files by glob pattern using ripgrep's file listing surface.",
    metadata: metadata("system.glob"),
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args) {
      const pattern = toOptionalString(args.pattern);
      if (!pattern) return errorResult("pattern must be a non-empty string");
      const target = await resolveSearchTarget({ config, args, pathArgKeys: ["path"] });
      if ("error" in target) return errorResult(target.error);
      const listed = await listSearchTargetFiles({
        target,
        globPatterns: [pattern],
      });
      if ("error" in listed) return errorResult(listed.error);
      return okResult({
        repoRoot: listed.searchRoot,
        searchRoot: listed.searchRoot,
        searchPath: listed.searchPath,
        pattern,
        matches: listed.matches.slice(
          0,
          normalizePositiveInteger(args.maxResults, 100, MAX_RESULTS),
        ),
      });
    },
  };

  const searchFilesTool: Tool = {
    name: "system.searchFiles",
    description:
      "Search path-scoped files by basename or relative path. Prefer this over raw shell find/fd for coding discovery.",
    metadata: metadata("system.searchFiles"),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        regex: { type: "boolean" },
        path: { type: "string" },
        glob: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        filePatterns: { type: "array", items: { type: "string" } },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args) {
      const query = toOptionalString(args.query);
      if (!query) return errorResult("query must be a non-empty string");
      const target = await resolveSearchTarget({ config, args, pathArgKeys: ["path"] });
      if ("error" in target) return errorResult(target.error);
      let regex: RegExp | undefined;
      if (args.regex === true) {
        try {
          regex = new RegExp(query, "i");
        } catch (error) {
          return errorResult(
            `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const listed = await listSearchTargetFiles({
        target,
        globPatterns: resolveSearchGlobPatterns(args),
      });
      if ("error" in listed) return errorResult(listed.error);
      const matched = listed.matches
        .filter((filePath) =>
          passesFileFilters(resolvePath(listed.searchRoot, filePath), {
            repoRoot: listed.searchRoot,
            query: args.regex === true ? undefined : query,
            regex,
          })
        )
        .slice(0, normalizePositiveInteger(args.maxResults, 100, MAX_RESULTS));
      return okResult({
        repoRoot: listed.searchRoot,
        searchRoot: listed.searchRoot,
        searchPath: listed.searchPath,
        query,
        regex: args.regex === true,
        matches: matched,
      });
    },
  };

  const repoInventoryTool: Tool = {
    name: "system.repoInventory",
    description:
      "Return a repo-local coding inventory: repo root, branch, current worktree, top-level directories, manifests, file counts, and detected languages.",
    metadata: metadata("system.repoInventory"),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const files = await listRepoFiles(repoRoot);
      const status = await runCommand(
        "git",
        ["-C", repoRoot, "status", "--porcelain", "--branch"],
        { cwd: repoRoot },
      );
      const branchInfo = parseStatusPorcelain(status.stdout);
      const languages = await collectWorkspaceLanguages(repoRoot);
      const topLevelDirectories = [...new Set(
        files
          .map((filePath) => relative(repoRoot, filePath).split(/[\\/]/)[0] ?? "")
          .filter((segment) => segment.length > 0 && !segment.includes(".")),
      )].slice(0, 50);
      const manifests = (
        await Promise.all(
          MANIFEST_NAMES.map(async (name) => {
            const manifestPath = resolvePath(repoRoot, name);
            const manifestStat = await stat(manifestPath).catch(() => undefined);
            return manifestStat?.isFile() ? name : null;
          }),
        )
      ).filter(
        (entry): entry is (typeof MANIFEST_NAMES)[number] => entry !== null,
      );
      const worktrees = await runCommand(
        "git",
        ["-C", repoRoot, "worktree", "list", "--porcelain"],
        { cwd: repoRoot },
      );
      return okResult({
        repoRoot,
        branch: branchInfo.branch ?? null,
        upstream: branchInfo.upstream ?? null,
        ahead: branchInfo.ahead ?? 0,
        behind: branchInfo.behind ?? 0,
        detached: branchInfo.detached,
        fileCount: files.length,
        topLevelDirectories,
        manifests,
        languages,
        worktrees: worktrees.stdout
          .split(/\n\n+/)
          .map((block) => block.trim())
          .filter((block) => block.length > 0)
          .map((block) => {
            const lines = block.split(/\r?\n/);
            const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? "";
            const branch = lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null;
            const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? null;
            const bare = lines.includes("bare");
            const detached = lines.includes("detached");
            return { worktree, branch, head, bare, detached };
          }),
      });
    },
  };

  const gitStatusTool: Tool = {
    name: "system.gitStatus",
    description: "Return structured git status for the current repo or worktree.",
    metadata: metadata("system.gitStatus"),
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const result = await runCommand(
        "git",
        ["-C", repoRoot, "status", "--porcelain", "--branch"],
        { cwd: repoRoot },
      );
      if (result.exitCode !== 0) {
        return errorResult(result.stderr.trim() || result.stdout.trim() || "git status failed");
      }
      const parsed = parseStatusPorcelain(result.stdout);
      return okResult({
        repoRoot,
        ...parsed,
        summary: summarizeChanges(parsed.changed),
      });
    },
  };

  const gitDiffTool: Tool = {
    name: "system.gitDiff",
    description: "Return a structured git diff for the current repo/worktree, staged changes, or specific revisions.",
    metadata: metadata("system.gitDiff"),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        staged: { type: "boolean" },
        fromRef: { type: "string" },
        toRef: { type: "string" },
        filePaths: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const command = ["-C", repoRoot, "diff", "--no-ext-diff", "--binary"];
      if (args.staged === true) command.push("--cached");
      const fromRef = toOptionalString(args.fromRef);
      const toRef = toOptionalString(args.toRef);
      if (fromRef && toRef) {
        command.push(fromRef, toRef);
      } else if (fromRef) {
        command.push(fromRef);
      }
      const filePaths = toOptionalStringArray(args.filePaths);
      if (filePaths && filePaths.length > 0) {
        command.push("--", ...filePaths);
      }
      const result = await runCommand("git", command, { cwd: repoRoot, maxBuffer: MAX_DIFF_BYTES });
      if (result.exitCode !== 0) {
        return errorResult(result.stderr.trim() || result.stdout.trim() || "git diff failed");
      }
      return okResult({
        repoRoot,
        staged: args.staged === true,
        fromRef: fromRef ?? null,
        toRef: toRef ?? null,
        truncated: Buffer.byteLength(result.stdout, "utf8") >= MAX_DIFF_BYTES,
        diff: result.stdout,
      });
    },
  };

  const gitShowTool: Tool = {
    name: "system.gitShow",
    description: "Show a commit, object, or path revision from git with optional patch content.",
    metadata: metadata("system.gitShow"),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        ref: { type: "string" },
        noPatch: { type: "boolean" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    async execute(args) {
      const ref = toOptionalString(args.ref);
      if (!ref) return errorResult("ref must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const result = await runCommand(
        "git",
        ["-C", repoRoot, "show", ...(args.noPatch === true ? ["--stat", "--summary"] : []), ref],
        { cwd: repoRoot, maxBuffer: MAX_DIFF_BYTES },
      );
      if (result.exitCode !== 0) {
        return errorResult(result.stderr.trim() || result.stdout.trim() || "git show failed");
      }
      return okResult({
        repoRoot,
        ref,
        output: result.stdout,
      });
    },
  };

  const gitBranchInfoTool: Tool = {
    name: "system.gitBranchInfo",
    description: "Return current branch, upstream, ahead/behind, HEAD, and worktree context.",
    metadata: metadata("system.gitBranchInfo"),
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const head = await runCommand("git", ["-C", repoRoot, "rev-parse", "HEAD"], { cwd: repoRoot });
      const status = await runCommand(
        "git",
        ["-C", repoRoot, "status", "--porcelain", "--branch"],
        { cwd: repoRoot },
      );
      const parsed = parseStatusPorcelain(status.stdout);
      return okResult({
        repoRoot,
        head: head.stdout.trim() || null,
        branch: parsed.branch ?? null,
        upstream: parsed.upstream ?? null,
        ahead: parsed.ahead ?? 0,
        behind: parsed.behind ?? 0,
        detached: parsed.detached,
      });
    },
  };

  const gitChangeSummaryTool: Tool = {
    name: "system.gitChangeSummary",
    description: "Return a cheap structured summary of staged, unstaged, untracked, and conflicted files.",
    metadata: metadata("system.gitChangeSummary"),
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const status = await runCommand(
        "git",
        ["-C", repoRoot, "status", "--porcelain", "--branch"],
        { cwd: repoRoot },
      );
      if (status.exitCode !== 0) {
        return errorResult(status.stderr.trim() || status.stdout.trim() || "git status failed");
      }
      const parsed = parseStatusPorcelain(status.stdout);
      return okResult({
        repoRoot,
        summary: summarizeChanges(parsed.changed),
        totalChanged: parsed.changed.length,
      });
    },
  };

  const gitWorktreeListTool: Tool = {
    name: "system.gitWorktreeList",
    description: "List git worktrees for the current repository.",
    metadata: metadata("system.gitWorktreeList"),
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const result = await runCommand(
        "git",
        ["-C", repoRoot, "worktree", "list", "--porcelain"],
        { cwd: repoRoot },
      );
      if (result.exitCode !== 0) {
        return errorResult(result.stderr.trim() || result.stdout.trim() || "git worktree list failed");
      }
      const worktrees = result.stdout
        .split(/\n\n+/)
        .map((block) => block.trim())
        .filter((block) => block.length > 0)
        .map((block) => {
          const lines = block.split(/\r?\n/);
          return {
            path: lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? "",
            branch: lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null,
            head: lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? null,
            detached: lines.includes("detached"),
            bare: lines.includes("bare"),
          };
        });
      return okResult({ repoRoot, worktrees });
    },
  };

  const gitWorktreeCreateTool: Tool = {
    name: "system.gitWorktreeCreate",
    description: "Create a git worktree from the current repository.",
    metadata: metadata("system.gitWorktreeCreate", true, ["coding", "operator"]),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo root or any path inside the repo." },
        worktreePath: { type: "string", description: "Target path for the new worktree." },
        branch: { type: "string" },
        ref: { type: "string" },
        detached: { type: "boolean" },
      },
      required: ["worktreePath"],
      additionalProperties: false,
    },
    async execute(args) {
      const worktreePath = toOptionalString(args.worktreePath);
      if (!worktreePath) return errorResult("worktreePath must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const allowedPaths = resolveToolAllowedPaths(config.allowedPaths, args);
      const safeWorktreePath = await safePath(worktreePath, allowedPaths);
      if (!safeWorktreePath.safe) {
        return errorResult(safeWorktreePath.reason ?? "worktreePath is outside allowed directories");
      }
      const command = ["-C", repoRoot, "worktree", "add"];
      if (args.detached === true) command.push("--detach");
      const branch = toOptionalString(args.branch);
      const ref = toOptionalString(args.ref);
      if (branch) {
        command.push("-b", branch);
      }
      command.push(safeWorktreePath.resolved);
      if (ref) {
        command.push(ref);
      }
      const result = await runCommand("git", command, { cwd: repoRoot });
      if (result.exitCode !== 0) {
        return errorResult(
          result.stderr.trim() || result.stdout.trim() || "git worktree add failed",
        );
      }
      return okResult({
        repoRoot,
        worktreePath: safeWorktreePath.resolved,
        branch: branch ?? null,
        ref: ref ?? null,
        detached: args.detached === true,
        output: result.stdout.trim(),
      });
    },
  };

  const gitWorktreeRemoveTool: Tool = {
    name: "system.gitWorktreeRemove",
    description: "Remove a git worktree. Dirty worktrees are blocked unless force=true.",
    metadata: metadata("system.gitWorktreeRemove", true, ["coding", "operator"]),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo root or any path inside the repo." },
        worktreePath: { type: "string" },
        force: { type: "boolean" },
      },
      required: ["worktreePath"],
      additionalProperties: false,
    },
    async execute(args) {
      const worktreePath = toOptionalString(args.worktreePath);
      if (!worktreePath) return errorResult("worktreePath must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const allowedPaths = resolveToolAllowedPaths(config.allowedPaths, args);
      const safeWorktreePath = await safePath(worktreePath, allowedPaths);
      if (!safeWorktreePath.safe) {
        return errorResult(safeWorktreePath.reason ?? "worktreePath is outside allowed directories");
      }
      const status = await runCommand(
        "git",
        ["-C", safeWorktreePath.resolved, "status", "--porcelain", "--untracked-files=normal"],
        { cwd: safeWorktreePath.resolved },
      );
      const dirty = status.exitCode === 0 && status.stdout.trim().length > 0;
      if (dirty && args.force !== true) {
        return errorResult(
          `Worktree ${safeWorktreePath.resolved} has uncommitted changes; re-run with force=true to remove it.`,
        );
      }
      const result = await runCommand(
        "git",
        [
          "-C",
          repoRoot,
          "worktree",
          "remove",
          ...(args.force === true ? ["--force"] : []),
          safeWorktreePath.resolved,
        ],
        { cwd: repoRoot },
      );
      if (result.exitCode !== 0) {
        return errorResult(
          result.stderr.trim() || result.stdout.trim() || "git worktree remove failed",
        );
      }
      return okResult({
        repoRoot,
        worktreePath: safeWorktreePath.resolved,
        dirty,
        removed: true,
      });
    },
  };

  const gitWorktreeStatusTool: Tool = {
    name: "system.gitWorktreeStatus",
    description: "Return branch, HEAD, and cleanliness for a worktree path.",
    metadata: metadata("system.gitWorktreeStatus"),
    inputSchema: {
      type: "object",
      properties: {
        worktreePath: { type: "string" },
      },
      required: ["worktreePath"],
      additionalProperties: false,
    },
    async execute(args) {
      const worktreePath = toOptionalString(args.worktreePath);
      if (!worktreePath) return errorResult("worktreePath must be a non-empty string");
      const allowedPaths = resolveToolAllowedPaths(config.allowedPaths, args);
      const safeWorktreePath = await safePath(worktreePath, allowedPaths);
      if (!safeWorktreePath.safe) {
        return errorResult(safeWorktreePath.reason ?? "worktreePath is outside allowed directories");
      }
      const branch = await runCommand(
        "git",
        ["-C", safeWorktreePath.resolved, "rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: safeWorktreePath.resolved },
      );
      const head = await runCommand(
        "git",
        ["-C", safeWorktreePath.resolved, "rev-parse", "HEAD"],
        { cwd: safeWorktreePath.resolved },
      );
      const status = await runCommand(
        "git",
        ["-C", safeWorktreePath.resolved, "status", "--porcelain", "--untracked-files=normal"],
        { cwd: safeWorktreePath.resolved },
      );
      return okResult({
        worktreePath: safeWorktreePath.resolved,
        branch: branch.stdout.trim() || null,
        head: head.stdout.trim() || null,
        dirty: status.stdout.trim().length > 0,
        statusLines: status.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      });
    },
  };

  const readFileRangeTool: Tool = {
    name: "system.readFileRange",
    description:
      "Read a bounded line range from a text file and record the file as read for later safe mutations.",
    metadata: metadata("system.readFileRange"),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      const path = toOptionalString(args.path);
      if (!path) return errorResult("path must be a non-empty string");
      const allowedPaths = resolveToolAllowedPaths(config.allowedPaths, args);
      const safe = await safePath(path, allowedPaths);
      if (!safe.safe) return errorResult(safe.reason ?? "Path is outside allowed directories");
      const text = await readTextFile(safe.resolved);
      if (text === undefined) {
        return errorResult(`Unable to read text file: ${path}`);
      }
      const lines = text.split(/\r?\n/);
      const startLine = normalizePositiveInteger(args.startLine, 1, lines.length || 1);
      const endLine = Math.max(
        startLine,
        normalizePositiveInteger(args.endLine, startLine + 50, lines.length || startLine),
      );
      const selected = lines.slice(startLine - 1, endLine);
      recordSessionRead(resolveSessionId(args), safe.resolved, {
        content: selected.join("\n"),
        viewKind: "partial",
      });
      return okResult({
        path: safe.resolved,
        startLine,
        endLine,
        lines: selected.map((text, index) => ({
          line: startLine + index,
          text,
        })),
      });
    },
  };

  const applyPatchTool: Tool = {
    name: "system.applyPatch",
    description:
      "Apply a unified diff patch to repo-local files using the runtime's read-before-write and allowed-path safety rules.",
    metadata: metadata("system.applyPatch", true),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo root or path inside the repo." },
        patch: { type: "string" },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    async execute(args) {
      const patch = toOptionalString(args.patch);
      if (!patch) return errorResult("patch must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const allowedPaths = resolveToolAllowedPaths(config.allowedPaths, args);
      const sessionId = resolveSessionId(args);
      const patches = parseUnifiedDiff(patch);
      if (patches.length === 0) {
        return errorResult("Patch does not contain any file hunks");
      }

      const changedFiles: string[] = [];
      for (const filePatch of patches) {
        const targetPath = filePatch.deletesFile ? filePatch.oldPath : filePatch.newPath;
        if (!targetPath || targetPath === "/dev/null") {
          return errorResult("Patch must target a repo-local file path");
        }
        const resolvedTarget = await resolvePatchTargetPath({
          patchPath: targetPath,
          repoRoot,
          allowedPaths,
        }).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
        if (typeof resolvedTarget !== "string") {
          return errorResult(resolvedTarget.error);
        }

        const existingStat = await stat(resolvedTarget).catch(() => undefined);
        if (existingStat && !hasSessionRead(sessionId, resolvedTarget)) {
          return errorResult(
            `Call system.readFile on "${targetPath}" before system.applyPatch.`,
          );
        }

        const originalText = existingStat
          ? await readFile(resolvedTarget, "utf8").catch(() => "")
          : "";
        const originalLines = originalText.length > 0 ? originalText.split(/\r?\n/) : [];

        if (filePatch.deletesFile) {
          if (!existingStat) {
            return errorResult(`Cannot delete missing file ${targetPath}`);
          }
          await rm(resolvedTarget, { force: false });
          changedFiles.push(targetPath);
          continue;
        }

        const nextLines = applyParsedPatchToLines({
          originalLines,
          patch: filePatch,
        });
        const nextText = nextLines.join("\n");
        await writeFile(resolvedTarget, nextText, "utf8");
        recordSessionRead(sessionId, resolvedTarget);
        changedFiles.push(targetPath);
      }

      return okResult({
        repoRoot,
        changedFiles,
        fileCount: changedFiles.length,
      });
    },
  };

  const symbolSearchTool: Tool = {
    name: "system.symbolSearch",
    description: "Search semantic repo symbols from the native code-intel index.",
    metadata: metadata("system.symbolSearch"),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        language: { type: "string" },
        kind: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const symbols = await codeIntel.searchSymbols({
        workspaceRoot: repoRoot,
        query: toOptionalString(args.query),
        language: toOptionalString(args.language),
        kind: toOptionalString(args.kind),
        maxResults: normalizePositiveInteger(args.maxResults, 50, MAX_RESULTS),
      });
      return okResult({
        repoRoot,
        symbols: symbols.map((symbol) => ({
          ...symbol,
          filePath: toRelativeWorkspacePath(repoRoot, symbol.filePath),
        })),
      });
    },
  };

  const symbolDefinitionTool: Tool = {
    name: "system.symbolDefinition",
    description: "Return the best matching symbol definition from the native code-intel index.",
    metadata: metadata("system.symbolDefinition"),
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        path: { type: "string" },
        filePath: { type: "string" },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    async execute(args) {
      const symbol = toOptionalString(args.symbol);
      if (!symbol) return errorResult("symbol must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path", "filePath"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const definition = await codeIntel.getDefinition({
        workspaceRoot: repoRoot,
        symbolName: symbol,
        ...(toOptionalString(args.filePath)
          ? { filePath: resolvePath(repoRoot, toOptionalString(args.filePath)!) }
          : {}),
      });
      if (!definition) {
        return errorResult(`No definition found for symbol "${symbol}"`);
      }
      return okResult({
        repoRoot,
        definition: {
          ...definition,
          filePath: toRelativeWorkspacePath(repoRoot, definition.filePath),
        },
      });
    },
  };

  const symbolReferencesTool: Tool = {
    name: "system.symbolReferences",
    description: "Return repo-local references for a symbol from the native code-intel index.",
    metadata: metadata("system.symbolReferences"),
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        path: { type: "string" },
        filePath: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    async execute(args) {
      const symbol = toOptionalString(args.symbol);
      if (!symbol) return errorResult("symbol must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path", "filePath"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const refs = await codeIntel.getReferences({
        workspaceRoot: repoRoot,
        symbolName: symbol,
        ...(toOptionalString(args.filePath)
          ? { filePath: resolvePath(repoRoot, toOptionalString(args.filePath)!) }
          : {}),
        maxResults: normalizePositiveInteger(args.maxResults, 100, 500),
      });
      return okResult({
        repoRoot,
        symbol,
        references: refs.map((entry) => ({
          ...entry,
          filePath: toRelativeWorkspacePath(repoRoot, entry.filePath),
        })),
      });
    },
  };

  const searchToolsTool: Tool = {
    name: "system.searchTools",
    description:
      "Search the runtime tool catalog by name, family, source, keyword, or preferred profile. Use this to discover non-default tools during mixed-mode turns.",
    metadata: {
      family: "coding",
      source: "builtin",
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: false,
      keywords: ["tools", "catalog", "discovery"],
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        family: { type: "string" },
        source: { type: "string" },
        profile: { type: "string" },
        includeHidden: { type: "boolean" },
        advertisedOnly: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const catalog = config.getToolCatalog?.() ?? [];
      const query = toOptionalString(args.query);
      const family = toOptionalString(args.family);
      const source = toOptionalString(args.source);
      const profile = toOptionalString(args.profile);
      const advertisedToolNames = Array.isArray(args[SESSION_ADVERTISED_TOOL_NAMES_ARG])
        ? new Set(
            (args[SESSION_ADVERTISED_TOOL_NAMES_ARG] as unknown[])
              .filter((value): value is string => typeof value === "string"),
          )
        : undefined;
      const results = catalog
        .filter((entry) => {
          if (args.includeHidden !== true && entry.metadata.hiddenByDefault) return false;
          if (args.advertisedOnly === true && advertisedToolNames && !advertisedToolNames.has(entry.name)) {
            return false;
          }
          if (family && entry.metadata.family !== family) return false;
          if (source && entry.metadata.source !== source) return false;
          if (
            profile &&
            entry.metadata.preferredProfiles &&
            !entry.metadata.preferredProfiles.includes(profile)
          ) {
            return false;
          }
          if (!query) return true;
          const lowered = query.toLowerCase();
          return (
            entry.name.toLowerCase().includes(lowered) ||
            entry.description.toLowerCase().includes(lowered) ||
            entry.metadata.keywords?.some((keyword) =>
              keyword.toLowerCase().includes(lowered)
            ) === true
          );
        })
        .sort((left, right) => {
          const leftScore = scoreCatalogEntry(left, query);
          const rightScore = scoreCatalogEntry(right, query);
          if (leftScore !== rightScore) return leftScore - rightScore;
          return left.name.localeCompare(right.name);
        })
        .slice(0, normalizePositiveInteger(args.maxResults, 50, MAX_RESULTS));

      return okResult({
        totalCatalogSize: catalog.length,
        results: results.map((entry) => ({
          name: entry.name,
          description: entry.description,
          metadata: entry.metadata,
          advertised: advertisedToolNames?.has(entry.name) ?? false,
        })),
      });
    },
  };

  return [
    grepTool,
    globTool,
    searchFilesTool,
    repoInventoryTool,
    gitStatusTool,
    gitDiffTool,
    gitShowTool,
    gitBranchInfoTool,
    gitChangeSummaryTool,
    gitWorktreeListTool,
    gitWorktreeCreateTool,
    gitWorktreeRemoveTool,
    gitWorktreeStatusTool,
    readFileRangeTool,
    applyPatchTool,
    symbolSearchTool,
    symbolDefinitionTool,
    symbolReferencesTool,
    searchToolsTool,
  ];
}

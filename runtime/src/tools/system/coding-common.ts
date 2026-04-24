import { readFile, readdir, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  resolve as resolvePath,
} from "node:path";

import type { Logger } from "../../utils/logger.js";
import { runCommand } from "../../utils/process.js";
import type { Tool, ToolCatalogEntry, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import {
  resolveToolAllowedPaths,
  safePath,
} from "./filesystem.js";

export const SESSION_ADVERTISED_TOOL_NAMES_ARG = "__agencAdvertisedToolNames";

export interface CodingToolConfig {
  readonly allowedPaths: readonly string[];
  readonly persistenceRootDir: string;
  readonly logger?: Logger;
  readonly getToolCatalog?: () => readonly ToolCatalogEntry[];
  readonly onDiscoverTools?: (toolNames: readonly string[]) => void;
  /**
   * Enable heavier AgenC-owned structured tools:
   * system.repoInventory, system.git*, system.symbol*.
   */
  readonly codeIntelligenceTools?: boolean;
}

export const MAX_RESULTS = 200;
export const DEFAULT_CONTEXT_LINES = 2;
export const MAX_DIFF_BYTES = 256_000;
export const TEXT_FILE_SIZE_LIMIT = 512_000;
export const MAX_RIPGREP_BUFFER = 12 * 1024 * 1024;
export const RIPGREP_REQUIRED_ERROR =
  "ripgrep (rg) is required for coding search tools but is not available on PATH";

export const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".hg", ".jj", ".svn"] as const;
export const MANIFEST_NAMES = [
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Makefile",
  "README.md",
] as const;

const GLOB_DOUBLESTAR = "__AGENC_DOUBLESTAR__";

export function matchGlob(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/\*\*/g, GLOB_DOUBLESTAR)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split(GLOB_DOUBLESTAR)
    .join(".*");
  return new RegExp("^" + escaped + "$").test(path);
}

export function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

export function okResult(data: unknown): ToolResult {
  return { content: safeStringify(data) };
}

export function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export function normalizeNonNegativeInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(max, Math.floor(value)));
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function toOptionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

export function resolveSearchGlobPatterns(
  args: Record<string, unknown>,
): readonly string[] | undefined {
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

export async function resolveWorkspacePath(params: {
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

export interface ResolvedSearchTarget {
  readonly searchPath: string;
  readonly searchRoot: string;
  readonly targetArg: string;
  readonly isDirectory: boolean;
}

export async function resolveSearchTarget(params: {
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

export async function resolveRepoRoot(params: {
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

export async function listRepoFiles(repoRoot: string): Promise<readonly string[]> {
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

export async function ensureRipgrepAvailable(cwd: string): Promise<string | undefined> {
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

export function appendRipgrepPathFilters(
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

export function describeRipgrepFailure(
  result: Awaited<ReturnType<typeof runCommand>>,
  fallback: string,
): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

export async function listSearchTargetFiles(params: {
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

export async function readTextFile(path: string): Promise<string | undefined> {
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

export function parseStatusPorcelain(stdout: string): {
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

export function summarizeChanges(changed: readonly {
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

export function codingToolMetadata(
  name: string,
  mutating = false,
  preferredProfiles: readonly string[] = ["coding", "validation", "documentation"],
  opts: {
    readonly family?: string;
    readonly deferred?: boolean;
    readonly keywords?: readonly string[];
  } = {},
): Tool["metadata"] {
  return {
    family: opts.family ?? "coding",
    source: "builtin",
    preferredProfiles,
    mutating,
    keywords: [
      ...name.split(".").filter((part) => part.length > 0),
      ...(opts.keywords ?? []),
    ],
    hiddenByDefault: false,
    ...(opts.deferred === true ? { deferred: true } : {}),
  };
}

export function relativeWorkspacePath(workspaceRoot: string, filePath: string): string {
  return relative(resolvePath(workspaceRoot), resolvePath(filePath)) || basename(filePath);
}

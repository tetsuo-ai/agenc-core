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

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import {
  dirname,
  isAbsolute,
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

export const GLOB_TOOL_NAME = "Glob";

const DEFAULT_MAX_RESULTS = 100;
const MAX_RIPGREP_STDERR_CHARS = 128 * 1024;
const TRUNCATION_NOTE =
  "(Results are truncated. Consider using a more specific path or pattern.)";

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

/**
 * Platform-specific hint telling the user how to install ripgrep. No binary is
 * bundled, so when `rg` is missing from PATH the only fix is a system install;
 * surface the exact command instead of a bare "requires ripgrep" message.
 */
function ripgrepInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "win32":
      return "Install ripgrep and confirm `rg --version` works: `winget install BurntSushi.ripgrep.MSVC` or `choco install ripgrep`.";
    case "darwin":
      return "Install ripgrep and confirm `rg --version` works: `brew install ripgrep`.";
    default:
      return "Install ripgrep and confirm `rg --version` works: use your distro package manager, e.g. `apt install ripgrep`.";
  }
}

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
  /** Test override for forcing the fallback path. Production uses `rg`. */
  readonly ripgrepCommand?: string;
}

interface ResolvedGlobTarget {
  readonly searchRoot: string;
  readonly displayRoot: string;
  readonly pattern: string;
  readonly allowedPaths: readonly string[];
}

interface LimitedRipgrepResult {
  readonly lines: readonly string[];
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly aborted: boolean;
  readonly killedAfterLimit: boolean;
  readonly spawnError?: Error;
}

function textResult(content: string, metadata?: Record<string, unknown>): ToolResult {
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

function resolveAgainstFirstAllowed(path: string, allowedPaths: readonly string[]): string {
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
    const allowedStat = await fs.stat(safeAllowed.resolved).catch(() => undefined);
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
  const match = pattern.match(/[*?[{]/);
  if (!match || match.index === undefined) {
    return { baseDir: dirname(pattern), relativePattern: pattern.split(/[\\/]/).pop() ?? pattern };
  }
  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf("/"),
    staticPrefix.lastIndexOf(sep),
    staticPrefix.lastIndexOf("\\"),
  );
  if (lastSepIndex === -1) {
    return { baseDir: "", relativePattern: pattern };
  }
  let baseDir = staticPrefix.slice(0, lastSepIndex);
  if (baseDir === "" && lastSepIndex === 0) baseDir = "/";
  if (/^[A-Za-z]:$/.test(baseDir)) baseDir = `${baseDir}${sep}`;
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
  const effectiveAllowed = resolveToolAllowedPaths(params.allowedPaths, params.args);
  if (effectiveAllowed.length === 0) {
    return { error: "No allowed paths configured for Glob" };
  }

  let requestedRoot = asNonEmptyString(params.args.path) ?? asNonEmptyString(params.args.cwd);
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

  const rootStat = await fs.stat(rootCheck.resolved).catch(() => undefined);
  if (!rootStat) {
    return { error: `Directory does not exist: ${requestedRoot ?? rootCandidate}` };
  }
  if (!rootStat.isDirectory()) {
    return { error: `Path is not a directory: ${requestedRoot ?? rootCandidate}` };
  }

  const displayRoot =
    (await closestAllowedDisplayRoot(rootCheck.resolved, effectiveAllowed)) ??
    rootCheck.resolved;
  return {
    searchRoot: rootCheck.resolved,
    displayRoot,
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

function runRipgrepFiles(params: {
  readonly command: string;
  readonly pattern: string;
  readonly cwd: string;
  readonly limit: number;
  readonly includeIgnored: boolean;
  readonly signal?: AbortSignal;
}): Promise<LimitedRipgrepResult> {
  const args = [
    "--files",
    "--glob",
    params.pattern,
    "--sortr",
    "modified",
    // `--hidden` keeps dotfile parity (e.g. `.gitignore`, `.github/`) which is
    // routinely useful to find; the gating of build/vendored output is done by
    // RESPECTING `.gitignore` (ripgrep default) plus the explicit default
    // excludes below — NOT by hiding dotfiles.
    "--hidden",
  ];
  if (params.includeIgnored) {
    // Opt-in legacy walk: surface gitignored + build output (e.g. searching
    // inside `target/`/`dist/` deliberately). `--no-ignore` restores the prior
    // default and the default excludes are skipped.
    args.push("--no-ignore");
  } else {
    // Default walk: layer the built-in generated/build/vendored/ledger excludes
    // on top of ripgrep's ignore handling. These negative globs win over the
    // user's positive search pattern, so the dirs are skipped deterministically
    // even when un-gitignored or when the pattern would otherwise whitelist
    // them.
    for (const exclude of DEFAULT_GLOB_EXCLUDE_GLOBS) {
      args.push("--glob", `!${exclude}`);
    }
  }
  return new Promise((resolveResult) => {
    const lines: string[] = [];
    let pending = "";
    let stderr = "";
    let killedAfterLimit = false;
    let settled = false;
    let child;
    try {
      child = spawn(params.command, args, {
        cwd: params.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolveResult({
        lines,
        stderr,
        exitCode: null,
        aborted: false,
        killedAfterLimit,
        spawnError: err as Error,
      });
      return;
    }

    const finish = (result: LimitedRipgrepResult): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    const abort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore process teardown races.
      }
    };
    params.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const parts = pending.split(/\n/);
      pending = parts.pop() ?? "";
      for (const part of parts) {
        const normalized = part.endsWith("\r") ? part.slice(0, -1) : part;
        if (normalized.length === 0) continue;
        lines.push(normalized);
        if (lines.length > params.limit) {
          killedAfterLimit = true;
          abort();
          break;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBoundedText(stderr, chunk);
    });
    child.on("error", (err: Error) => {
      finish({
        lines,
        stderr,
        exitCode: null,
        aborted: params.signal?.aborted === true,
        killedAfterLimit,
        spawnError: err,
      });
    });
    child.on("close", (code: number | null) => {
      params.signal?.removeEventListener("abort", abort);
      if (pending.length > 0 && !killedAfterLimit) {
        const normalized = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
        if (normalized.length > 0) lines.push(normalized);
      }
      finish({
        lines,
        stderr,
        exitCode: code,
        aborted: params.signal?.aborted === true,
        killedAfterLimit,
      });
    });
  });
}

async function normalizeAndFilterMatches(params: {
  readonly matches: readonly string[];
  readonly target: ResolvedGlobTarget;
}): Promise<readonly string[]> {
  const safeMatches: string[] = [];
  for (const match of params.matches) {
    const absolute = isAbsolute(match) ? match : resolve(params.target.searchRoot, match);
    const check = await safePath(absolute, params.target.allowedPaths);
    if (!check.safe) continue;
    const st = await fs.stat(check.resolved).catch(() => undefined);
    if (!st || st.isDirectory()) continue;
    safeMatches.push(toRelativeIfInside(check.resolved, params.target.displayRoot));
  }
  return safeMatches;
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
      : "rg";

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

      const target = await resolveGlobTarget({
        args: rawArgs,
        allowedPaths,
        pattern,
      });
      if ("error" in target) {
        return errorResult(target.error);
      }

      const startedAt = Date.now();
      const effectiveLimit = limit + 1;
      const signal = args.__abortSignal;
      const includeIgnored = asBoolean(args.includeIgnored) ?? false;
      let rawMatches: readonly string[];
      let truncated = false;
      const rg = await runRipgrepFiles({
        command: ripgrepCommand,
        pattern: target.pattern,
        cwd: target.searchRoot,
        limit: effectiveLimit,
        includeIgnored,
        signal,
      });
      if (signal?.aborted || rg.aborted) {
        return errorResult("Glob aborted");
      }
      if (rg.spawnError) {
        return errorResult(
          `Glob requires ripgrep (${ripgrepCommand}) to list files with hidden and ignored-file parity. ${ripgrepInstallHint()}`,
        );
      } else if (rg.exitCode !== 0 && rg.lines.length === 0) {
        const detail = rg.stderr.trim();
        if (detail.length > 0) {
          return errorResult(`Glob error: ${detail}`);
        }
        rawMatches = [];
      } else if (rg.exitCode !== 0 && !rg.killedAfterLimit) {
        const detail = rg.stderr.trim() || "ripgrep failed";
        return errorResult(`Glob error: ${detail}`);
      } else {
        rawMatches = rg.lines;
        truncated = rg.killedAfterLimit || rg.lines.length > limit;
      }

      const normalized = await normalizeAndFilterMatches({
        matches: rawMatches,
        target,
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
    },
  };
}

export const __INTERNAL = {
  extractGlobBaseDirectory,
  toRelativeIfInside,
  ripgrepInstallHint,
  DEFAULT_GLOB_EXCLUDE_GLOBS,
};

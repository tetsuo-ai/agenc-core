/**
 * `Glob` — port of openclaude `GlobTool` as a first-class AgenC tool.
 *
 * The model-facing description is byte-identical to AgenC's at
 * `src/tools/GlobTool/prompt.ts`. AgenC's implementation
 * (`src/tools/GlobTool/GlobTool.ts`) routes through a ripgrep-backed
 * `glob()` helper; AgenC's existing `system.glob` already covers the
 * ripgrep path. This tool intentionally uses Node's built-in
 * `fs.promises.glob` (Node 22+) so the lifted surface stays free of new
 * dependencies and matches the bare AgenC name (`Glob`) the model
 * has been trained to call.
 *
 * Output is plain text (codex runtime envelope), one path per line, sorted
 * newest-first by mtime, capped at `MAX_RESULTS=100` with a truncation
 * note. Every emitted path is verified via `safePath()` against the
 * configured allowedPaths so a clever pattern can't escape the
 * workspace.
 *
 * @module
 */

import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  resolveToolAllowedPaths,
  safePath,
  type FilesystemToolConfig,
} from "./filesystem.js";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";

/** Hard cap matches AgenC's `globLimits.maxResults` default. */
const MAX_RESULTS = 100;

export const GLOB_TOOL_NAME = "Glob";

/**
 * Verbatim port of openclaude `DESCRIPTION`
 * (src/tools/GlobTool/prompt.ts:3-7).
 */
const GLOB_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the spawn_agent tool instead`;

interface GlobToolInput extends ToolExecutionInjectedArgs {
  readonly pattern?: unknown;
  readonly path?: unknown;
  readonly cwd?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

interface FsLikeGlob {
  glob?: (
    pattern: string,
    options?: { cwd?: string },
  ) => AsyncIterable<string>;
}

function getFsGlob(): FsLikeGlob["glob"] {
  return (fs as unknown as FsLikeGlob).glob;
}

export interface GlobToolConfig {
  /** Allowed path prefixes — required, mirrors {@link FilesystemToolConfig}. */
  readonly allowedPaths: readonly string[];
  /** Override the hard result cap (default {@link MAX_RESULTS}). */
  readonly maxResults?: number;
}

/**
 * Build the `Glob` tool. `config.allowedPaths` is required so an
 * untrusted pattern can never list paths outside the workspace.
 */
export function createGlobTool(
  config: GlobToolConfig | Pick<FilesystemToolConfig, "allowedPaths">,
): Tool {
  const allowedPaths = config.allowedPaths;
  const limit =
    "maxResults" in config && typeof config.maxResults === "number"
      ? Math.max(1, Math.floor(config.maxResults))
      : MAX_RESULTS;

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
    requiresApproval: false,
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern (e.g. '**/*.ts', 'src/**/test_*.py').",
        },
        path: {
          type: "string",
          description:
            "Optional. Directory to search from. Defaults to the workspace root.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as GlobToolInput;
      const pattern = asNonEmptyString(args.pattern);
      if (pattern === undefined) {
        return {
          content: "pattern must be a non-empty string",
          isError: true,
        };
      }

      const effectiveAllowed = resolveToolAllowedPaths(allowedPaths, rawArgs);
      if (effectiveAllowed.length === 0) {
        return {
          content: "No allowed paths configured for Glob",
          isError: true,
        };
      }

      // Resolve the search root: explicit `path`/`cwd`, else first
      // allowed root (matches the contract spec mapping for
      // AgenC's `getCwd()`).
      const requestedRoot =
        asNonEmptyString(args.path) ?? asNonEmptyString(args.cwd);
      const searchRootRaw = requestedRoot ?? effectiveAllowed[0];
      const rootCheck = await safePath(searchRootRaw, effectiveAllowed);
      if (!rootCheck.safe) {
        return {
          content: `Access denied: ${rootCheck.reason ?? "search path is outside allowed directories"}`,
          isError: true,
        };
      }
      const searchRoot = rootCheck.resolved;

      // Reject absolute patterns that reach outside the allowed roots
      // before we even call fs.glob — defence in depth.
      if (isAbsolute(pattern)) {
        return {
          content:
            "pattern must be relative; pass an absolute root via the `path` argument and a relative glob via `pattern`",
          isError: true,
        };
      }

      const globImpl = getFsGlob();
      if (typeof globImpl !== "function") {
        return {
          content:
            "Glob requires Node.js 22+ (fs.promises.glob is unavailable in this runtime)",
          isError: true,
        };
      }

      const startedAt = Date.now();
      const signal = args.__abortSignal;

      const collected: string[] = [];
      try {
        for await (const match of globImpl(pattern, { cwd: searchRoot })) {
          if (signal?.aborted) {
            return {
              content: "Glob aborted",
              isError: true,
            };
          }
          collected.push(
            isAbsolute(match) ? match : resolve(searchRoot, match),
          );
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        return {
          content: code ? `${code}: glob failed` : "glob failed",
          isError: true,
        };
      }

      // Filter to entries that are inside the allowed roots, then stat
      // each survivor for its mtime so we can sort newest-first.
      type Entry = { path: string; mtimeMs: number };
      const safeEntries: Entry[] = [];
      for (const candidate of collected) {
        const check = await safePath(candidate, effectiveAllowed);
        if (!check.safe) continue;
        let mtimeMs = 0;
        try {
          const stats = await fs.stat(check.resolved);
          // Skip directories — Glob's AgenC semantic is "files".
          if (stats.isDirectory()) continue;
          mtimeMs = stats.mtimeMs;
        } catch {
          // Inaccessible/transient — drop the entry rather than fail.
          continue;
        }
        safeEntries.push({ path: check.resolved, mtimeMs });
      }

      safeEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const truncated = safeEntries.length > limit;
      const kept = safeEntries.slice(0, limit);
      const elapsedMs = Date.now() - startedAt;

      if (kept.length === 0) {
        return {
          content: "No files matched the pattern.",
          metadata: {
            pattern,
            searchRoot,
            numFiles: 0,
            durationMs: elapsedMs,
            truncated: false,
          },
        };
      }

      const lines: string[] = [
        `Found ${kept.length} ${kept.length === 1 ? "file" : "files"} (${elapsedMs} ms)`,
        ...kept.map((entry) => entry.path),
      ];
      if (truncated) {
        lines.push(
          `(results truncated at ${limit}; refine pattern to see more)`,
        );
      }

      return {
        content: lines.join("\n"),
        metadata: {
          pattern,
          searchRoot,
          numFiles: kept.length,
          durationMs: elapsedMs,
          truncated,
        },
      };
    },
  };
}

export default createGlobTool;

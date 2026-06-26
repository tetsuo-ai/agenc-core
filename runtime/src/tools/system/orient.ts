/**
 * `Orient` — ephemeral on-demand repository orientation map.
 *
 * Given a natural-language query ("where is the retry logic", "what handles
 * settlement"), Orient builds a token-bounded structural map of the workspace's
 * source files *on the fly*, ranks the files by relevance, and returns only the
 * top-ranked files + a compact symbol map — then discards the map. There is no
 * persistent index to maintain.
 *
 * This is the read-side complement to Glob/Grep: instead of a literal pattern,
 * the model asks "where should I look for X" and gets a localized shortlist. It
 * reads many files internally but returns a *small* result, so it localizes
 * without flooding context (the same flood-avoidance reason subagents exist).
 *
 * Ranking = lexical (BM25) + a structural symbol-definition index + a small
 * 1-hop ego boost — validated against SWE-bench Lite (n=300): +8.3pp
 * file-localization recall@5 over a BM25 baseline, CV-confirmed. See
 * `context/orientation-map.ts` and the orientation-map reproduction harness.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

import { buildOrientationMap } from "../../context/orientation-map.js";
import type { Tool, ToolResult } from "../types.js";
import {
  resolveToolAllowedPaths,
  safePath,
  type FilesystemToolConfig,
} from "./filesystem.js";
import { runRipgrepFiles } from "./glob.js";
import { readFileInRange } from "../../utils/readFileInRange.js";

export const ORIENT_TOOL_NAME = "Orient";

const ORIENT_DESCRIPTION =
  "Locate the most relevant source files for a natural-language query by " +
  "building an ephemeral structural map of the repository (symbols + " +
  "references + lexical match). Use it to orient before reading — ask 'where " +
  "is X handled' and get a ranked shortlist of files plus their key symbols, " +
  "instead of bulk-reading or guessing. Read-only; respects .gitignore and " +
  "skips generated/build/vendored dirs.";

/** Source extensions the map understands (def/ref extraction is language-aware). */
const SOURCE_GLOB =
  "*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,rb,php,c,cc,cpp,cxx,h,hpp,cs,kt,kts,swift,scala,m,mm}";
const DEFAULT_MAX_FILES = 2000;
const HARD_MAX_FILES = 4000;
const MAX_BYTES_PER_FILE = 64 * 1024;
const MAX_RANKED = 20;
const MAP_TOKEN_BUDGET = 1000;

interface OrientToolInput {
  readonly query?: unknown;
  readonly path?: unknown;
  readonly maxFiles?: unknown;
  readonly __abortSignal?: AbortSignal;
}

function textResult(
  content: string,
  metadata?: Record<string, unknown>,
): ToolResult {
  return metadata ? { content, metadata } : { content };
}

function errorResult(content: string): ToolResult {
  return { content, isError: true };
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function clampMaxFiles(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(HARD_MAX_FILES, Math.max(1, Math.floor(v)));
  }
  return DEFAULT_MAX_FILES;
}

export interface OrientToolConfig {
  readonly allowedPaths: readonly string[];
  /** Test override for the ripgrep binary. Production uses `rg`. */
  readonly ripgrepCommand?: string;
}

export function createOrientTool(
  config: OrientToolConfig | Pick<FilesystemToolConfig, "allowedPaths">,
): Tool {
  const allowedPaths = config.allowedPaths;
  const ripgrepCommand =
    "ripgrepCommand" in config && typeof config.ripgrepCommand === "string"
      ? config.ripgrepCommand
      : "rg";

  return {
    name: ORIENT_TOOL_NAME,
    description: ORIENT_DESCRIPTION,
    metadata: {
      family: "search",
      source: "builtin",
      keywords: ["orient", "map", "localize", "where", "repo", "structure", "navigate"],
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
        query: {
          type: "string",
          description:
            "What you are trying to locate, in natural language (e.g. 'where is the retry/backoff logic', 'what handles task settlement'). Mention specific symbol or file names in backticks when known.",
        },
        path: {
          type: "string",
          description:
            "Optional. Subdirectory to scope the map to. Defaults to the workspace root.",
        },
        maxFiles: {
          type: "number",
          description: `Optional. Cap on source files scanned (default ${DEFAULT_MAX_FILES}, max ${HARD_MAX_FILES}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as OrientToolInput;
      const query = asNonEmptyString(args.query);
      if (query === undefined) {
        return errorResult("query must be a non-empty string");
      }
      const signal = args.__abortSignal;
      const effectiveAllowed = resolveToolAllowedPaths(allowedPaths, rawArgs);
      const root = effectiveAllowed[0];
      if (root === undefined) {
        return errorResult("Orient has no allowed workspace root configured");
      }

      // Resolve the (optional) scoped directory and enforce containment.
      let baseDir = root;
      const rawPath = asNonEmptyString(args.path);
      if (rawPath !== undefined) {
        const candidate = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
        const checked = await safePath(candidate, effectiveAllowed);
        if (!checked.safe) {
          return errorResult(
            `path is outside the allowed workspace: ${checked.reason ?? "denied"}`,
          );
        }
        baseDir = checked.resolved;
      }

      const cap = clampMaxFiles(args.maxFiles);
      const listed = await runRipgrepFiles({
        command: ripgrepCommand,
        pattern: SOURCE_GLOB,
        cwd: baseDir,
        limit: cap,
        includeIgnored: false,
        signal,
      });
      if (signal?.aborted || listed.aborted) {
        return errorResult("Orient aborted");
      }
      if (listed.spawnError) {
        return errorResult(
          `Orient could not enumerate files (is ripgrep installed?): ${listed.spawnError.message}`,
        );
      }
      const relPaths = listed.lines.slice(0, cap);
      if (relPaths.length === 0) {
        return textResult(
          "No source files found to orient over (after ignoring generated/build/vendored dirs).",
        );
      }

      const files = new Map<string, string>();
      for (const rel of relPaths) {
        if (signal?.aborted) return errorResult("Orient aborted");
        const abs = resolve(baseDir, rel);
        try {
          const res = await readFileInRange(
            abs,
            0,
            undefined,
            MAX_BYTES_PER_FILE,
            signal,
            { truncateOnByteLimit: true },
          );
          files.set(rel, res.content);
        } catch {
          // unreadable/binary/vanished file — skip, it just won't be ranked.
        }
      }
      if (files.size === 0) {
        return textResult("No readable source files found to orient over.");
      }

      const map = buildOrientationMap(files, query);
      const top = map.ranked.slice(0, MAX_RANKED);
      const rendered = map.render(MAP_TOKEN_BUDGET);

      const scopeNote =
        baseDir === root ? "" : ` under ${relative(root, baseDir) || "."}${sep}`;
      const cappedNote = listed.killedAfterLimit ? ` (capped at ${cap})` : "";
      const header =
        `Orientation map for: ${query}\n` +
        `Scanned ${files.size} source file(s)${scopeNote}${cappedNote}. ` +
        `Most relevant first — read these, don't bulk-scan:\n\n`;
      const body = top.map((p, i) => `${i + 1}. ${p}`).join("\n");
      const mapSection = rendered
        ? `\n\nKey symbols by file:\n${rendered}`
        : "";

      return textResult(header + body + mapSection, {
        fileCount: files.size,
        topFiles: top,
      });
    },
  };
}

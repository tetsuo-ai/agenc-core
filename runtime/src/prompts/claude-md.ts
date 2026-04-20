/**
 * Tiered AGENTS.md / CLAUDE.md loader with `@include` directive support.
 *
 * Ports the AgenC subset of openclaude `utils/claudemd.ts` (~400 LOC of
 * ~1500): the 4-tier precedence (Managed → User → Project → Local), the
 * `@include` expansion with circular-reference detection, and the I-75
 * path-boundary check. Skips growthbook/analytics, .claude/rules globs,
 * worktree dedup, memdir TeamMem — those live in later Groups.
 *
 * Tier sources:
 *   1. **Managed** — system override. `$AGENC_MANAGED_INSTRUCTIONS` if set,
 *      else `/etc/agenc/AGENTS.md`.
 *   2. **User** — per-user global. `~/.agenc/AGENTS.md` (plus
 *      `~/.claude/CLAUDE.md` for Claude-Code compat fallback).
 *   3. **Project** — the ancestor-walk result from
 *      {@link loadProjectInstructions}.
 *   4. **Local** — per-checkout gitignored. `<projectRoot>/AGENTS.local.md`.
 *
 * `@include` directive (I-75):
 *   - Syntax: `@include <relative-path>` on its own line.
 *   - Resolved relative to the including file's directory.
 *   - Target must stay inside the tier's base directory. Paths escaping
 *     via `..` or absolute escapes are rejected with a warning.
 *   - Circular chains are detected and the re-entry is skipped.
 *   - Max nesting depth: 10. Max total expansion: 5 MiB.
 *   - Expanded inline with a `<!-- @include <path> -->` comment marker.
 *
 * @module
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { normalizeExternalText, readTextFile } from "../utils/file-read.js";
import {
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  loadProjectInstructions,
  type ProjectInstructions,
  type ProjectInstructionsConfig,
} from "./project-instructions.js";

/** Default max nesting depth for `@include` expansion. */
export const DEFAULT_INCLUDE_MAX_DEPTH = 10;
/** Default total expansion budget (5 MiB) to guard against fork bombs. */
export const DEFAULT_INCLUDE_MAX_BYTES = 5 * 1024 * 1024;

/** Filename convention for per-user global instructions. */
export const USER_INSTRUCTION_FILENAME = "AGENTS.md";
/** Filename convention for per-checkout local instructions. */
export const LOCAL_INSTRUCTION_FILENAME = "AGENTS.local.md";
/** Default system-wide managed instructions path. */
export const DEFAULT_MANAGED_INSTRUCTION_PATH = "/etc/agenc/AGENTS.md";

export type InstructionTier = "managed" | "user" | "project" | "local";

/**
 * A loaded tier entry. `content` is post-@include-expansion; `rawContent`
 * is the original file before expansion (useful for caching/diagnostics).
 */
export interface TierEntry {
  readonly tier: InstructionTier;
  readonly path: string;
  readonly content: string;
  readonly rawContent: string;
  readonly dropped: DroppedInclude[];
}

export interface TieredInstructions {
  readonly managed: TierEntry | null;
  readonly user: TierEntry | null;
  readonly project: TierEntry | null;
  readonly local: TierEntry | null;
}

export interface LoadTieredInstructionsOptions extends ProjectInstructionsConfig {
  /** Current working directory for project/local tier discovery. */
  readonly cwd: string;
  /** Override `HOME` for testing. Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /**
   * Override the managed instructions path for testing. Defaults to
   * `$AGENC_MANAGED_INSTRUCTIONS` env var or
   * {@link DEFAULT_MANAGED_INSTRUCTION_PATH}.
   */
  readonly managedPath?: string;
  /** Max `@include` nesting depth. Default 10. */
  readonly includeMaxDepth?: number;
  /** Max total `@include` expansion bytes. Default 5 MiB. */
  readonly includeMaxBytes?: number;
}

/** Metadata about a rejected/skipped `@include` target. */
export interface DroppedInclude {
  readonly requestedPath: string;
  readonly reason:
    | "path_escape"
    | "circular"
    | "max_depth"
    | "max_bytes"
    | "not_found"
    | "read_error";
  readonly includingFile: string;
}

export interface ResolveIncludesOptions {
  /** Directory the content originated from (for relative resolution). */
  readonly baseDir: string;
  /**
   * Outermost boundary for I-75 path checks. All resolved `@include`
   * targets must stay inside this directory.
   */
  readonly projectRoot: string;
  /** Max nesting depth (default 10). */
  readonly maxDepth?: number;
  /** Max total expansion size in bytes (default 5 MiB). */
  readonly maxBytes?: number;
}

export interface ResolvedContent {
  readonly text: string;
  readonly included: string[];
  readonly dropped: DroppedInclude[];
}

/** Regex for `@include <path>` directives at line start. */
const INCLUDE_LINE_RE = /^[ \t]*@include[ \t]+(.+?)[ \t]*$/gm;

async function tryReadText(path: string): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * I-75 boundary check. Returns true when `candidate` is inside
 * `boundary` (or equal to it). Uses resolved absolute paths and
 * `path.relative` to detect escapes (including via `..` or absolute
 * overrides).
 */
export function isPathWithin(candidate: string, boundary: string): boolean {
  const absBoundary = resolve(boundary);
  const absCandidate = resolve(candidate);
  if (absCandidate === absBoundary) return true;
  const rel = relative(absBoundary, absCandidate);
  if (rel === "" ) return true;
  // Any `..` component or an absolute rel path means candidate escapes.
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Expand `@include <path>` directives in `content` recursively.
 *
 * - Relative paths resolved against the including file's directory.
 * - Targets must stay within `projectRoot` (I-75). Escapes rejected.
 * - Circular chains detected via the active include-stack.
 * - Hard caps: `maxDepth` nested levels, `maxBytes` total expansion.
 * - Missing/unreadable targets dropped with a warning record.
 */
export async function resolveIncludes(
  content: string,
  opts: ResolveIncludesOptions,
): Promise<ResolvedContent> {
  const maxDepth = opts.maxDepth ?? DEFAULT_INCLUDE_MAX_DEPTH;
  const maxBytes = opts.maxBytes ?? DEFAULT_INCLUDE_MAX_BYTES;
  const included: string[] = [];
  const dropped: DroppedInclude[] = [];
  // Byte ledger shared across recursion.
  const state = { totalBytes: Buffer.byteLength(content, "utf8") };

  const text = await expandText({
    text: content,
    baseDir: opts.baseDir,
    projectRoot: resolve(opts.projectRoot),
    includingFile: opts.baseDir,
    stack: [],
    depth: 0,
    maxDepth,
    maxBytes,
    included,
    dropped,
    state,
  });

  return { text, included, dropped };
}

interface ExpandCtx {
  text: string;
  baseDir: string;
  projectRoot: string;
  /** Absolute path of the currently-including file (or baseDir root). */
  includingFile: string;
  /** Absolute paths of ancestors in the include chain (for cycle check). */
  stack: readonly string[];
  depth: number;
  maxDepth: number;
  maxBytes: number;
  included: string[];
  dropped: DroppedInclude[];
  state: { totalBytes: number };
}

async function expandText(ctx: ExpandCtx): Promise<string> {
  const matches: Array<{ start: number; end: number; raw: string; target: string }> = [];
  INCLUDE_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_LINE_RE.exec(ctx.text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      target: m[1]!.trim(),
    });
  }
  if (matches.length === 0) return ctx.text;

  let out = "";
  let cursor = 0;
  for (const match of matches) {
    out += ctx.text.slice(cursor, match.start);
    cursor = match.end;

    const resolved = resolve(ctx.baseDir, match.target);
    const marker = `<!-- @include ${match.target} -->`;

    // I-75 boundary check.
    if (!isPathWithin(resolved, ctx.projectRoot)) {
      ctx.dropped.push({
        requestedPath: match.target,
        reason: "path_escape",
        includingFile: ctx.includingFile,
      });
      out += marker;
      continue;
    }

    // Cycle detection: resolved path already on the active stack.
    if (ctx.stack.includes(resolved)) {
      ctx.dropped.push({
        requestedPath: match.target,
        reason: "circular",
        includingFile: ctx.includingFile,
      });
      out += marker;
      continue;
    }

    // Depth guard.
    if (ctx.depth + 1 > ctx.maxDepth) {
      ctx.dropped.push({
        requestedPath: match.target,
        reason: "max_depth",
        includingFile: ctx.includingFile,
      });
      out += marker;
      continue;
    }

    // Existence + read.
    if (!(await pathExists(resolved))) {
      ctx.dropped.push({
        requestedPath: match.target,
        reason: "not_found",
        includingFile: ctx.includingFile,
      });
      out += marker;
      continue;
    }
    let raw: string;
    try {
      raw = await readTextFile(resolved);
    } catch {
      ctx.dropped.push({
        requestedPath: match.target,
        reason: "read_error",
        includingFile: ctx.includingFile,
      });
      out += marker;
      continue;
    }

    // Byte-budget guard before recursion.
    const addBytes = Buffer.byteLength(raw, "utf8");
    if (ctx.state.totalBytes + addBytes > ctx.maxBytes) {
      ctx.dropped.push({
        requestedPath: match.target,
        reason: "max_bytes",
        includingFile: ctx.includingFile,
      });
      out += marker;
      continue;
    }
    ctx.state.totalBytes += addBytes;

    ctx.included.push(resolved);
    const nested = await expandText({
      text: raw,
      baseDir: pathDir(resolved),
      projectRoot: ctx.projectRoot,
      includingFile: resolved,
      stack: [...ctx.stack, resolved],
      depth: ctx.depth + 1,
      maxDepth: ctx.maxDepth,
      maxBytes: ctx.maxBytes,
      included: ctx.included,
      dropped: ctx.dropped,
      state: ctx.state,
    });
    out += `${marker}\n${nested}`;
  }
  out += ctx.text.slice(cursor);
  return out;
}

/**
 * Keep the path-dir helper local; avoids importing the whole path module
 * repeatedly and clarifies intent in `expandText`.
 */
function pathDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx < 0 ? "." : p.slice(0, idx);
}

/**
 * Read a single file, run `@include` expansion on its contents, and
 * wrap the result in a {@link TierEntry}. Returns null when the path
 * is missing or empty.
 */
async function loadTier(
  tier: InstructionTier,
  filePath: string,
  boundary: string,
  includeMaxDepth: number,
  includeMaxBytes: number,
): Promise<TierEntry | null> {
  const raw = await tryReadText(filePath);
  if (raw === null || raw.trim().length === 0) return null;

  const resolved = await resolveIncludes(raw, {
    baseDir: pathDir(filePath),
    projectRoot: boundary,
    maxDepth: includeMaxDepth,
    maxBytes: includeMaxBytes,
  });

  return {
    tier,
    path: filePath,
    content: resolved.text,
    rawContent: raw,
    dropped: resolved.dropped,
  };
}

/**
 * Load all four tiers for a given working directory.
 *
 * Missing tiers come back as `null` — callers filter/concat via
 * {@link assembleTieredInstructions}.
 */
export async function loadTieredInstructions(
  opts: LoadTieredInstructionsOptions,
): Promise<TieredInstructions> {
  const includeMaxDepth = opts.includeMaxDepth ?? DEFAULT_INCLUDE_MAX_DEPTH;
  const includeMaxBytes = opts.includeMaxBytes ?? DEFAULT_INCLUDE_MAX_BYTES;
  const home = opts.homeDir ?? homedir();
  const managedPath =
    opts.managedPath ??
    process.env.AGENC_MANAGED_INSTRUCTIONS ??
    DEFAULT_MANAGED_INSTRUCTION_PATH;

  // Managed tier — boundary is the managed file's directory.
  const managed = await loadTier(
    "managed",
    managedPath,
    pathDir(managedPath),
    includeMaxDepth,
    includeMaxBytes,
  );

  // User tier — boundary is `~/.agenc`. Prefer `AGENTS.md`; fall back to
  // the Claude-Code convention `~/.claude/CLAUDE.md` if the first is
  // absent (keeps a soft upgrade path for users bringing Claude memory).
  const agencHome = join(home, ".agenc");
  const userPrimary = join(agencHome, USER_INSTRUCTION_FILENAME);
  let user: TierEntry | null = null;
  if (await pathExists(userPrimary)) {
    user = await loadTier("user", userPrimary, agencHome, includeMaxDepth, includeMaxBytes);
  } else {
    const claudeCompat = join(home, ".claude", "CLAUDE.md");
    if (await pathExists(claudeCompat)) {
      user = await loadTier(
        "user",
        claudeCompat,
        join(home, ".claude"),
        includeMaxDepth,
        includeMaxBytes,
      );
    }
  }

  // Project tier — ancestor-walk via project-instructions loader.
  const project: ProjectInstructions | null = await loadProjectInstructions({
    cwd: opts.cwd,
    projectRootMarkers:
      opts.projectRootMarkers && opts.projectRootMarkers.length > 0
        ? opts.projectRootMarkers
        : DEFAULT_PROJECT_ROOT_MARKERS,
    projectDocMaxBytes: opts.projectDocMaxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES,
  });
  let projectTier: TierEntry | null = null;
  if (project) {
    // Project file content already passed readTextFile, but we still
    // need @include expansion against the project root boundary.
    const resolved = await resolveIncludes(project.content, {
      baseDir: pathDir(project.path),
      projectRoot: project.rootDir,
      maxDepth: includeMaxDepth,
      maxBytes: includeMaxBytes,
    });
    projectTier = {
      tier: "project",
      path: project.path,
      content: resolved.text,
      rawContent: project.content,
      dropped: resolved.dropped,
    };
  }

  // Local tier — `<projectRoot>/AGENTS.local.md` if a project root was
  // found, otherwise `<cwd>/AGENTS.local.md` (lets a standalone checkout
  // still carry a local override without a root marker).
  const localBase = project?.rootDir ?? opts.cwd;
  const localPath = join(localBase, LOCAL_INSTRUCTION_FILENAME);
  const local = await loadTier(
    "local",
    localPath,
    localBase,
    includeMaxDepth,
    includeMaxBytes,
  );

  return { managed, user, project: projectTier, local };
}

/**
 * Assemble loaded tiers into one instruction block. Tiers are
 * concatenated with a clear header; missing tiers are skipped silently.
 */
export function assembleTieredInstructions(tiers: TieredInstructions): string {
  const order: InstructionTier[] = ["managed", "user", "project", "local"];
  const parts: string[] = [];
  for (const tier of order) {
    const entry = tiers[tier];
    if (!entry) continue;
    const header = `--- ${tier} (${entry.path}) ---`;
    // Normalize in case assembly happens on in-memory strings that
    // skipped `readTextFile` (unlikely, but cheap insurance per I-80/81).
    parts.push(`${header}\n\n${normalizeExternalText(entry.content).trim()}`);
  }
  return parts.join("\n\n");
}

// Re-exports for convenience — keeps downstream imports single-file.
export { loadProjectInstructions } from "./project-instructions.js";
export type { ProjectInstructions } from "./project-instructions.js";

/** Consumed by tests and downstream inspection — lets callers know how
 *  many bytes are still unread in case they want to alert on the cap. */
export async function rawReadForTests(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

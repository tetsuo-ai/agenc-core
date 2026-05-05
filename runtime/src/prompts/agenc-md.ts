/**
 * Tiered AGENC.md instruction loader with `@include` directive support.
 *
 * Owns the 4-tier precedence (Managed → User → Project → Local), the
 * `@include` expansion with circular-reference detection, and the I-75
 * path-boundary check for AgenC instruction files.
 *
 * Tier sources:
 *   1. **Managed** — system override. `$AGENC_MANAGED_INSTRUCTIONS` if set,
 *      else `/etc/agenc/AGENC.md`.
 *   2. **User** — per-user global. `~/.agenc/AGENC.md`.
 *   3. **Project** — the ancestor-walk result from
 *      {@link loadProjectInstructions}.
 *   4. **Local** — per-checkout gitignored. `<projectRoot>/AGENC.local.md`.
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
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { normalizeExternalText, readTextFile } from "./_deps/file-read.js";
import {
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  loadProjectInstructionChain,
  type ProjectInstructionChainEntry,
  type ProjectInstructionsConfig,
} from "./project-instructions.js";
import { DEFAULT_MANAGED_RULES_DIR, discoverInstructionRules, formatRulesBlock, projectRulesDir, userRulesDir } from "./rules/discovery.js";

/** Default max nesting depth for `@include` expansion. */
export const DEFAULT_INCLUDE_MAX_DEPTH = 10;
/** Default total expansion budget (5 MiB) to guard against fork bombs. */
export const DEFAULT_INCLUDE_MAX_BYTES = 5 * 1024 * 1024;

/** Filename convention for per-user global instructions. */
export const USER_INSTRUCTION_FILENAME = "AGENC.md";
/** Filename convention for per-checkout local instructions. */
export const LOCAL_INSTRUCTION_FILENAME = "AGENC.local.md";
/** Default system-wide managed instructions path. */
export const DEFAULT_MANAGED_INSTRUCTION_PATH = "/etc/agenc/AGENC.md";

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
    | "read_error"
    | "not_regular_file"
    | "invalid_path";
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
 * I-75 boundary check (lexical). Returns true when `candidate` is inside
 * `boundary` (or equal to it). Uses resolved absolute paths and
 * `path.relative` to detect escapes (including via `..` or absolute
 * overrides).
 *
 * NOTE: lexical-only — does not follow symlinks. Production expansion
 * routes through {@link isPathWithinReal} which resolves symlinks via
 * `fs.realpath` to close the symlink-escape attack. Kept exported for
 * callers that want pure-lexical reasoning on paths that may not exist.
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
 * I-75 boundary check (realpath-aware, async). Canonicalizes both
 * `candidate` and `boundary` via `fs.realpath` before comparing. This
 * closes the symlink-escape attack where an in-tree symlink points to
 * a file outside the project root (e.g. `<repo>/bad -> /etc/passwd`):
 * the lexical {@link isPathWithin} would pass, but the realpath version
 * rejects.
 *
 * Fails closed (returns `false`) when either side's `realpath` fails —
 * e.g. the candidate does not exist yet, or a broken symlink. Missing
 * targets are surfaced separately through the `not_found` drop reason
 * after this check, so a false here is safe.
 */
export async function isPathWithinReal(
  candidate: string,
  boundary: string,
): Promise<boolean> {
  let realBoundary: string;
  let realCandidate: string;
  try {
    realBoundary = await realpath(resolve(boundary));
  } catch {
    return false;
  }
  try {
    realCandidate = await realpath(resolve(candidate));
  } catch {
    return false;
  }
  if (realCandidate === realBoundary) return true;
  const rel = relative(realBoundary, realCandidate);
  if (rel === "") return true;
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

    const drop = (
      reason: DroppedInclude["reason"],
      extra?: string,
    ): string => {
      ctx.dropped.push({
        requestedPath: match.target,
        reason,
        includingFile: ctx.includingFile,
      });
      // Every reason carries a human-readable rejection marker with the
      // reason (and optional extra context such as cycle entry, depth
      // limit, or byte cap) so the downstream prompt makes the drop
      // visible instead of failing silently.
      return extra !== undefined
        ? `<!-- @include ${match.target} (rejected: ${reason}; ${extra}) -->`
        : `<!-- @include ${match.target} (rejected: ${reason}) -->`;
    };

    // Null-byte / control-char guard. POSIX `open(2)` treats `\0` as the
    // path terminator and would silently truncate; reject up front so an
    // attacker can't smuggle `foo\0.md` past later checks.
    if (match.target.includes("\0")) {
      out += drop("invalid_path");
      continue;
    }

    const resolved = resolve(ctx.baseDir, match.target);

    // I-75 boundary check (realpath-aware). Closes the symlink-escape
    // attack where `<repo>/bad -> /etc/passwd` would pass lexical checks.
    // Also rejects broken symlinks via the fail-closed realpath variant.
    const within = await isPathWithinReal(resolved, ctx.projectRoot);
    if (!within) {
      // Distinguish "exists, escapes boundary" (path_escape) from "does
      // not exist at all" (not_found) so callers get an honest signal.
      // `isPathWithinReal` fails closed on missing paths too, so probe
      // separately here.
      if (!(await pathExists(resolved))) {
        out += drop("not_found");
      } else {
        out += drop("path_escape");
      }
      continue;
    }

    // Cycle detection: resolved path already on the active stack.
    if (ctx.stack.includes(resolved)) {
      out += drop(
        "circular",
        `cycle via ${ctx.stack.length > 0 ? ctx.stack.join(" -> ") : "self"}`,
      );
      continue;
    }

    // Depth guard.
    if (ctx.depth + 1 > ctx.maxDepth) {
      out += drop("max_depth", `depth=${ctx.depth + 1} > max=${ctx.maxDepth}`);
      continue;
    }

    // Regular-file gate. Must follow the realpath boundary check so we
    // stat the canonical target. Rejects FIFOs, sockets, block/char
    // devices (reading would block or leak `/dev/*`), symlinks to such
    // nodes, and directories.
    let targetStat;
    try {
      targetStat = await stat(resolved);
    } catch {
      out += drop("not_found");
      continue;
    }
    if (!targetStat.isFile()) {
      out += drop("not_regular_file");
      continue;
    }

    let raw: string;
    try {
      raw = await readTextFile(resolved);
    } catch {
      out += drop("read_error");
      continue;
    }

    // Byte-budget guard before recursion.
    const addBytes = Buffer.byteLength(raw, "utf8");
    if (ctx.state.totalBytes + addBytes > ctx.maxBytes) {
      out += drop(
        "max_bytes",
        `would add ${addBytes}B; cap=${ctx.maxBytes}B; used=${ctx.state.totalBytes}B`,
      );
      continue;
    }
    ctx.state.totalBytes += addBytes;

    ctx.included.push(resolved);
    const okMarker = `<!-- @include ${match.target} -->`;
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
    out += `${okMarker}\n${nested}`;
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

function formatProjectTierChainEntry(
  entry: Pick<ProjectInstructionChainEntry, "path">,
  content: string,
): string {
  return `--- project-doc (${entry.path}) ---\n\n${normalizeExternalText(content).trim()}`;
}

async function appendUnconditionalRules(
  content: string,
  rulesDir: string,
  type: "Managed" | "User" | "Project" | "Local",
  boundaryDir?: string,
): Promise<string> {
  const rules = await discoverInstructionRules({
    rulesDir,
    type,
    ...(boundaryDir !== undefined ? { boundaryDir } : {}),
    includeUnconditional: true,
    includeConditional: false,
  });
  const block = formatRulesBlock(rules);
  if (block.length === 0) return content;
  return content.length === 0 ? block : `${content}\n\n${block}`;
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
  const managedBase = await loadTier(
    "managed",
    managedPath,
    pathDir(managedPath),
    includeMaxDepth,
    includeMaxBytes,
  );
  let managed = managedBase;
  const managedRuleContent = await appendUnconditionalRules(
    managedBase?.content ?? "",
    DEFAULT_MANAGED_RULES_DIR,
    "Managed",
  );
  if (managedRuleContent.length > 0) {
    managed =
      managedBase === null
        ? {
            tier: "managed",
            path: DEFAULT_MANAGED_RULES_DIR,
            content: managedRuleContent,
            rawContent: managedRuleContent,
            dropped: [],
          }
        : { ...managedBase, content: managedRuleContent };
  }

  // User tier — boundary is `~/.agenc`.
  const agencHome = join(home, ".agenc");
  const userPrimary = join(agencHome, USER_INSTRUCTION_FILENAME);
  let user: TierEntry | null = null;
  if (await pathExists(userPrimary)) {
    user = await loadTier("user", userPrimary, agencHome, includeMaxDepth, includeMaxBytes);
  }
  const userRuleContent = await appendUnconditionalRules(
    user?.content ?? "",
    userRulesDir(home),
    "User",
    agencHome,
  );
  if (userRuleContent.length > 0) {
    user =
      user === null
        ? {
            tier: "user",
            path: userRulesDir(home),
            content: userRuleContent,
            rawContent: userRuleContent,
            dropped: [],
          }
        : { ...user, content: userRuleContent };
  }

  // Project tier — ancestor-walk via project-instructions loader.
  const projectChain = await loadProjectInstructionChain({
    cwd: opts.cwd,
    projectRootMarkers:
      opts.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS,
    projectDocMaxBytes: opts.projectDocMaxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES,
  });
  let projectTier: TierEntry | null = null;
  if (projectChain.length > 0) {
    const parts: string[] = [];
    const rawParts: string[] = [];
    const dropped: DroppedInclude[] = [];

    for (const entry of projectChain) {
      const resolved = await resolveIncludes(entry.content, {
        baseDir: pathDir(entry.path),
        projectRoot: entry.rootDir,
        maxDepth: includeMaxDepth,
        maxBytes: includeMaxBytes,
      });
      dropped.push(...resolved.dropped);
      const withRules = await appendUnconditionalRules(
        resolved.text,
        projectRulesDir(pathDir(entry.path)),
        "Project",
        pathDir(entry.path),
      );
      if (projectChain.length === 1) {
        parts.push(withRules);
        rawParts.push(entry.content);
      } else {
        parts.push(formatProjectTierChainEntry(entry, withRules));
        rawParts.push(formatProjectTierChainEntry(entry, entry.content));
      }
    }

    const nearestEntry = projectChain[projectChain.length - 1]!;
    projectTier = {
      tier: "project",
      path: nearestEntry.path,
      content: parts.join("\n\n"),
      rawContent: rawParts.join("\n\n"),
      dropped,
    };
  }

  // Local tier — `<projectRoot>/AGENC.local.md` if a project root was
  // found, otherwise `<cwd>/AGENC.local.md`.
  const projectRootDir = projectChain[0]?.rootDir;
  const localBase = projectRootDir ?? opts.cwd;
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

function formatDroppedInclude(drop: DroppedInclude): string {
  return [
    "AGENC.md include dropped:",
    drop.requestedPath,
    `(${drop.reason}`,
    `from ${drop.includingFile})`,
  ].join(" ");
}

/**
 * Convert rejected `@include` records into user-facing startup/status notices.
 *
 * The loader already preserves rejected include metadata per tier so callers
 * do not need to scrape the assembled prompt's HTML comments. The TUI uses
 * these notices to mirror AgenC's memory/config status surface while
 * keeping AgenC's AGENC.md terminology.
 */
export function formatTieredInstructionWarnings(
  tiers: TieredInstructions,
): readonly string[] {
  const order: InstructionTier[] = ["managed", "user", "project", "local"];
  const warnings: string[] = [];
  for (const tier of order) {
    const entry = tiers[tier];
    if (!entry) continue;
    for (const drop of entry.dropped) {
      warnings.push(formatDroppedInclude(drop));
    }
  }
  return warnings;
}

// Re-exports for convenience — keeps downstream imports single-file.
export { loadProjectInstructions } from "./project-instructions.js";
export type { ProjectInstructions } from "./project-instructions.js";

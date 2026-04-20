/**
 * Project instructions loader — ancestor-walk AGENTS.md discovery with
 * configurable project-root markers and a byte-budget cap.
 *
 * Ports openclaude `utils/projectInstructions.ts` (primary/fallback filename
 * helpers, ancestor walk) and the codex `agents_md.rs` behavior (configurable
 * `project_root_markers`, `project_doc_max_bytes` budget, `AGENTS.override.md`
 * preference over `AGENTS.md`).
 *
 * Returns the **single** closest project-root AGENTS.md (plus its override
 * twin if present). Tiered discovery of multiple intermediate AGENTS.md files
 * is layered on top by `claude-md.ts`'s project tier.
 *
 * @module
 */
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readTextFile } from "../utils/file-read.js";

/**
 * Primary filename scanned for project instructions (OpenAI/Codex
 * convention + Claude Code convention).
 */
export const PRIMARY_PROJECT_INSTRUCTION_FILE = "AGENTS.md";

/**
 * Preferred per-checkout override. Not committed; shadows AGENTS.md in
 * the same directory when present.
 */
export const OVERRIDE_PROJECT_INSTRUCTION_FILE = "AGENTS.override.md";

/**
 * Legacy fallback filename retained for Claude Code compatibility.
 */
export const FALLBACK_PROJECT_INSTRUCTION_FILE = "CLAUDE.md";

/**
 * Default project-root markers used when config does not specify any.
 * Matches codex `default_project_root_markers` plus Node and Python
 * ecosystem signposts that are universal in AgenC workspaces.
 */
export const DEFAULT_PROJECT_ROOT_MARKERS: readonly string[] = [
  ".git",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  ".hg",
];

/**
 * Default byte budget for a single project-instructions file (2 MiB).
 * Content beyond the cap is truncated with an I-15-style marker.
 */
export const DEFAULT_PROJECT_DOC_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Local runtime config for project-instruction discovery.
 *
 * TODO(T10-D config/schema): replace with `AgenCConfig.projectRootMarkers`
 * + `AgenCConfig.projectDocMaxBytes` once `runtime/src/config/schema.ts`
 * lands (Group D). Until then, this interface defines the surface this
 * module consumes.
 */
export interface ProjectInstructionsConfig {
  /**
   * Ordered list of filenames/directories that mark a project root for
   * ancestor-walk termination. Defaults to {@link
   * DEFAULT_PROJECT_ROOT_MARKERS} when empty or undefined.
   */
  readonly projectRootMarkers?: readonly string[];
  /**
   * Byte cap for the loaded instruction file; content over this size is
   * truncated with an I-15 truncation marker. Defaults to {@link
   * DEFAULT_PROJECT_DOC_MAX_BYTES}. Zero disables discovery entirely.
   */
  readonly projectDocMaxBytes?: number;
}

export interface LoadProjectInstructionsOptions extends ProjectInstructionsConfig {
  /** Starting directory for the ancestor walk. */
  readonly cwd: string;
}

export interface ProjectInstructions {
  /** Absolute path to the file that was loaded. */
  readonly path: string;
  /** File contents after BOM strip + CRLF→LF normalization. */
  readonly content: string;
  /** True when truncation occurred at {@link projectDocMaxBytes}. */
  readonly truncated: boolean;
  /** Marker filename (or directory) that identified the project root. */
  readonly rootMarkerFound: string;
  /** Directory where the root marker was located. */
  readonly rootDir: string;
}

/**
 * I-15-style truncation marker appended when a file exceeds the budget.
 */
const TRUNCATION_MARKER =
  "\n\n<!-- [truncated by project_doc_max_bytes] -->\n";

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the directory where the first configured marker exists when
 * walking from `cwd` upward. Returns `null` if no marker is found before
 * reaching the filesystem root.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[] = DEFAULT_PROJECT_ROOT_MARKERS,
): Promise<{ rootDir: string; marker: string } | null> {
  if (markers.length === 0) {
    return null;
  }

  let currentDir = cwd;
  while (true) {
    for (const marker of markers) {
      if (await pathExists(join(currentDir, marker))) {
        return { rootDir: currentDir, marker };
      }
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) {
      return null;
    }
    currentDir = parent;
  }
}

/**
 * Resolve the preferred instruction file in a directory. Order:
 *   1. `AGENTS.override.md`
 *   2. `AGENTS.md`
 *   3. `CLAUDE.md` (legacy)
 * Returns `null` if none exist.
 */
export async function resolveInstructionFile(dir: string): Promise<string | null> {
  const candidates = [
    OVERRIDE_PROJECT_INSTRUCTION_FILE,
    PRIMARY_PROJECT_INSTRUCTION_FILE,
    FALLBACK_PROJECT_INSTRUCTION_FILE,
  ];
  for (const name of candidates) {
    const full = join(dir, name);
    if (await pathExists(full)) {
      return full;
    }
  }
  return null;
}

/**
 * Walk upward from `cwd`, find the nearest project root marker, read the
 * AGENTS.md/AGENTS.override.md/CLAUDE.md file in that directory, and
 * return its normalized contents. Applies the byte budget (truncating
 * with an I-15 marker) and respects zero-budget disable.
 */
export async function loadProjectInstructions(
  opts: LoadProjectInstructionsOptions,
): Promise<ProjectInstructions | null> {
  const markers =
    opts.projectRootMarkers && opts.projectRootMarkers.length > 0
      ? opts.projectRootMarkers
      : DEFAULT_PROJECT_ROOT_MARKERS;
  const maxBytes =
    typeof opts.projectDocMaxBytes === "number"
      ? opts.projectDocMaxBytes
      : DEFAULT_PROJECT_DOC_MAX_BYTES;

  if (maxBytes === 0) {
    return null;
  }

  const root = await findProjectRoot(opts.cwd, markers);
  if (!root) {
    return null;
  }

  const filePath = await resolveInstructionFile(root.rootDir);
  if (!filePath) {
    return null;
  }

  let content: string;
  try {
    content = await readTextFile(filePath);
  } catch {
    return null;
  }

  let truncated = false;
  // Use UTF-8 byte length — matches codex Rust behavior and catches
  // multibyte characters that would blow past the budget.
  const byteLen = Buffer.byteLength(content, "utf8");
  if (byteLen > maxBytes) {
    // Truncate in characters but safely — Buffer byte-slice can split
    // surrogate pairs; re-encode/decode instead.
    const buf = Buffer.from(content, "utf8");
    content = buf.subarray(0, maxBytes).toString("utf8") + TRUNCATION_MARKER;
    truncated = true;
  }

  return {
    path: filePath,
    content,
    truncated,
    rootMarkerFound: root.marker,
    rootDir: root.rootDir,
  };
}

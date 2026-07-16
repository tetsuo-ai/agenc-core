/**
 * Project instructions loader — ancestor-walk AGENC.md discovery with
 * configurable project-root markers and a byte-budget cap.
 *
 * Ports the ancestor-walk behavior from upstream runtimes while keeping
 * AgenC's product-specific instruction filenames.
 *
 * Returns the **single** closest applicable AGENC.md (or same-directory
 * override) between the current working directory and the discovered project
 * root. Tiered discovery of multiple intermediate instruction files is
 * layered on top by `agenc-md.ts`'s project tier.
 *
 * @module
 */
import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  type InstructionFileIdentity,
  readInstructionFileSnapshot,
} from "./secure-instruction-file.js";
import {
  AGENTS_PROJECT_INSTRUCTION_FILE,
  CLAUDE_PROJECT_INSTRUCTION_FILE,
  getProjectInstructionFilePaths,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
} from "../utils/projectInstructions.js";

export {
  AGENTS_PROJECT_INSTRUCTION_FILE,
  CLAUDE_PROJECT_INSTRUCTION_FILE,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
};

/**
 * Preferred per-checkout override. Not committed; shadows AGENC.md in
 * the same directory when present.
 */
const OVERRIDE_PROJECT_INSTRUCTION_FILE = "AGENC.override.md";
const DOT_AGENC_PROJECT_INSTRUCTION_FILE = join(".agenc", "AGENC.md");
const MAX_SECURE_PROJECT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Default project-root markers used when config does not specify any.
 * Uses common project-root markers plus Node and Python ecosystem signposts
 * that are universal in AgenC workspaces.
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

function projectDocumentByteLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PROJECT_DOC_MAX_BYTES;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > MAX_SECURE_PROJECT_FILE_BYTES
  ) {
    throw new RangeError(
      `projectDocMaxBytes must be a safe integer between 0 and ${MAX_SECURE_PROJECT_FILE_BYTES}`,
    );
  }
  return limit;
}

/**
 * Local runtime config for project-instruction discovery.
 *
 * Follow-up(T10-D config/schema): replace with `AgenCConfig.projectRootMarkers`
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
  /** Canonical path bound to the opened descriptor (approval/cache provenance). */
  readonly canonicalPath: string;
  /** File contents after BOM strip + CRLF→LF normalization. */
  readonly content: string;
  /** Digest of the exact descriptor-bound bytes captured from disk. */
  readonly sha256: string;
  /** Identity captured from the same open descriptor as the returned bytes. */
  readonly identity: InstructionFileIdentity;
  /** True when truncation occurred at {@link projectDocMaxBytes}. */
  readonly truncated: boolean;
  /**
   * Marker filename (or directory) that identified the project root.
   * Falls back to `"<cwd>"` when no marker was found and discovery is
   * scoped to the working directory only.
   */
  readonly rootMarkerFound: string;
  /** Directory where the root marker was located. */
  readonly rootDir: string;
}

/**
 * Root→cwd project-doc chain entry. Same payload shape as the singular
 * loader so downstream callers can reuse the same truncation metadata.
 */
export type ProjectInstructionChainEntry = ProjectInstructions;

/**
 * I-15-style truncation marker appended when a file exceeds the budget.
 */
const TRUNCATION_MARKER =
  "\n\n<!-- [truncated by project_doc_max_bytes] -->\n";

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
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
 *   1. `AGENC.override.md`
 *   2. `AGENC.md`
 *   3. `AGENTS.md`
 * Returns `null` if no usable regular text file exists.
 */
export async function resolveInstructionFile(dir: string): Promise<string | null> {
  return (await readInstructionCandidate(dir))?.path ?? null;
}

async function readInstructionCandidate(
  dir: string,
  boundaryRoot: string = dir,
  workspaceRoot: string = boundaryRoot,
): Promise<{
  path: string;
  content: string;
  sha256: string;
  identity: InstructionFileIdentity;
  canonicalPath: string;
} | null> {
  for (const full of [
    join(dir, OVERRIDE_PROJECT_INSTRUCTION_FILE),
    ...getProjectInstructionFilePaths(dir),
  ]) {
    const read = await readInstructionFileSnapshot({
      requestedPath: full,
      boundaryRoot,
      workspaceRoot,
      sourceClass: "project",
      maximumBytes: MAX_SECURE_PROJECT_FILE_BYTES,
    });
    if (read.ok) {
      return {
        path: full,
        content: read.snapshot.text,
        sha256: read.snapshot.sha256,
        identity: read.snapshot.identity,
        canonicalPath: read.snapshot.canonicalPath,
      };
    }
  }
  return null;
}

async function readInstructionCandidates(
  dir: string,
  boundaryRoot: string,
  workspaceRoot: string,
): Promise<readonly {
  path: string;
  content: string;
  sha256: string;
  identity: InstructionFileIdentity;
  canonicalPath: string;
}[]> {
  const primary = await readInstructionCandidate(dir, boundaryRoot, workspaceRoot);
  const dotAgenCPath = join(dir, DOT_AGENC_PROJECT_INSTRUCTION_FILE);
  const dotAgenC = await readInstructionFileSnapshot({
    requestedPath: dotAgenCPath,
    boundaryRoot,
    workspaceRoot,
    sourceClass: "project",
    maximumBytes: MAX_SECURE_PROJECT_FILE_BYTES,
  });
  return [
    ...(primary !== null ? [primary] : []),
    ...(dotAgenC.ok
      ? [{
          path: dotAgenCPath,
          content: dotAgenC.snapshot.text,
          sha256: dotAgenC.snapshot.sha256,
          identity: dotAgenC.snapshot.identity,
          canonicalPath: dotAgenC.snapshot.canonicalPath,
        }]
      : []),
  ];
}

async function findClosestProjectInstruction(
  cwd: string,
  rootDir: string,
): Promise<{
  path: string;
  content: string;
  sha256: string;
  identity: InstructionFileIdentity;
  canonicalPath: string;
} | null> {
  let currentDir = resolve(cwd);
  const boundaryDir = resolve(rootDir);

  while (true) {
    const candidate = await readInstructionCandidate(
      currentDir,
      boundaryDir,
      boundaryDir,
    );
    if (candidate) {
      return candidate;
    }

    if (currentDir === boundaryDir) {
      return null;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) {
      return null;
    }
    currentDir = parent;
  }
}

/**
 * Walk upward from `cwd` to the nearest project root marker, read the closest
 * usable AGENC.md/AGENC.override.md file, and return its normalized contents.
 * Applies the byte budget (truncating with an I-15 marker) and respects
 * zero-budget disable.
 */
export async function loadProjectInstructions(
  opts: LoadProjectInstructionsOptions,
): Promise<ProjectInstructions | null> {
  const markers =
    opts.projectRootMarkers !== undefined
      ? opts.projectRootMarkers
      : DEFAULT_PROJECT_ROOT_MARKERS;
  const maxBytes = projectDocumentByteLimit(opts.projectDocMaxBytes);

  if (maxBytes === 0) {
    return null;
  }

  const root = await findProjectRoot(opts.cwd, markers);
  const effectiveRoot = root ?? {
    rootDir: resolve(opts.cwd),
    marker: "<cwd>",
  };
  const candidate = await findClosestProjectInstruction(
    opts.cwd,
    effectiveRoot.rootDir,
  );
  if (!candidate) {
    return null;
  }
  const truncated = truncateContentToBytes(candidate.content, maxBytes);
  return {
    path: candidate.path,
    canonicalPath: candidate.canonicalPath,
    content: truncated.content,
    sha256: candidate.sha256,
    identity: candidate.identity,
    truncated: truncated.truncated,
    rootMarkerFound: effectiveRoot.marker,
    rootDir: resolve(effectiveRoot.rootDir),
  };
}

function truncateContentToBytes(
  content: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { content: "", truncated: true };
  }
  const byteLen = Buffer.byteLength(content, "utf8");
  if (byteLen <= maxBytes) {
    return { content, truncated: false };
  }
  return {
    content: truncateUtf8AtCodePointBoundary(content, maxBytes) + TRUNCATION_MARKER,
    truncated: true,
  };
}

function truncateUtf8AtCodePointBoundary(content: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }
  return content.slice(0, end);
}

export function projectInstructionDirectories(
  rootDir: string,
  cwd: string,
): string[] {
  const absRoot = resolve(rootDir);
  const absCwd = resolve(cwd);
  const rel = relative(absRoot, absCwd);
  if (
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    return [absRoot];
  }
  if (rel === "") {
    return [absRoot];
  }
  const dirs: string[] = [];
  let current = absCwd;
  while (true) {
    dirs.push(current);
    if (current === absRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs.reverse();
}

/**
 * Walk from the discovered project root to `cwd` inclusive, collecting
 * every directory-level instruction file in root→cwd order. Each
 * directory contributes at most one file according to
 * {@link resolveInstructionFile}'s precedence.
 *
 * The byte budget applies to the concatenated chain. When the budget is
 * exhausted the final included entry is truncated and the walk stops.
 */
export async function loadProjectInstructionChain(
  opts: LoadProjectInstructionsOptions,
): Promise<readonly ProjectInstructionChainEntry[]> {
  const markers =
    opts.projectRootMarkers !== undefined
      ? opts.projectRootMarkers
      : DEFAULT_PROJECT_ROOT_MARKERS;
  const maxBytes = projectDocumentByteLimit(opts.projectDocMaxBytes);

  if (maxBytes === 0) {
    return [];
  }

  const root = await findProjectRoot(opts.cwd, markers);
  const effectiveRoot = root ?? {
    rootDir: resolve(opts.cwd),
    marker: "<cwd>",
  };
  const chain: ProjectInstructionChainEntry[] = [];
  let remainingBytes = maxBytes;

  for (const dir of projectInstructionDirectories(effectiveRoot.rootDir, opts.cwd)) {
    const loadedEntries = await readInstructionCandidates(
      dir,
      effectiveRoot.rootDir,
      effectiveRoot.rootDir,
    );
    for (const loaded of loadedEntries) {
      const truncated = truncateContentToBytes(loaded.content, remainingBytes);
      chain.push({
        path: loaded.path,
        canonicalPath: loaded.canonicalPath,
        content: truncated.content,
        sha256: loaded.sha256,
        identity: loaded.identity,
        truncated: truncated.truncated,
        rootMarkerFound: effectiveRoot.marker,
        rootDir: effectiveRoot.rootDir,
      });

      remainingBytes -= Math.min(
        remainingBytes,
        Buffer.byteLength(loaded.content, "utf8"),
      );
      if (truncated.truncated || remainingBytes <= 0) {
        return chain;
      }
    }
  }

  return chain;
}

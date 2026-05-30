/**
 * Ports the donor apply-patch runtime onto AgenC filesystem tools.
 *
 * Shape differences from upstream:
 *   - Filesystem calls use Node fs/promises and AgenC path allowlists.
 *   - Permission and session-read integration is exposed through the
 *     tool wrapper; this module owns the primitive patch application.
 *
 * Cross-cuts deliberately NOT carried:
 *   - OS sandbox execution is not duplicated here; callers pass the same
 *     allowed roots used by AgenC's file tools.
 */

import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  resolve,
} from "node:path";
import { structuredPatch } from "diff";

import {
  dropSessionReadSnapshot,
  recordSessionRead,
  safePathAllowingSessionPlanFile,
  type SessionReadViewKind,
} from "../system/filesystem.js";
import { buildFileMutationMetadata } from "../result-metadata.js";
import { parsePatch } from "./parser.js";
import { seekSequence } from "./seek-sequence.js";
import {
  ApplyPatchRuntimeError,
  type AffectedPaths,
  type AppliedPatch,
  type ApplyPatchArgs,
  type ApplyPatchFileUpdate,
  type ApplyPatchHunk,
  type UpdateFileChunk,
} from "./types.js";

export interface ApplyPatchRuntimeOptions {
  readonly cwd: string;
  readonly allowedPaths: readonly string[];
  readonly rawArgs?: Record<string, unknown>;
  readonly sessionId?: string;
}

export interface ApplyPatchResult {
  readonly affected: AffectedPaths;
  readonly summary: string;
  readonly metadata: Record<string, unknown>;
}

interface Replacement {
  readonly startIndex: number;
  readonly oldLength: number;
  readonly newLines: readonly string[];
}

interface MutationMetadataEntry {
  readonly filePath: string;
  readonly operation: "create" | "write" | "edit";
  readonly metadata: Record<string, unknown>;
}

function hunkAffectedPath(hunk: ApplyPatchHunk): string {
  return hunk.kind === "update" && hunk.movePath !== null
    ? hunk.movePath
    : hunk.path;
}

function resolvePatchPath(cwd: string, path: string): string {
  return (isAbsolute(path) ? path : resolve(cwd, path)).normalize("NFC");
}

async function resolveSafePath(
  path: string,
  opts: ApplyPatchRuntimeOptions,
): Promise<string> {
  const absoluteInput = resolvePatchPath(opts.cwd, path);
  const safe = await safePathAllowingSessionPlanFile(
    absoluteInput,
    opts.allowedPaths,
    opts.rawArgs ?? {},
  );
  if (!safe.safe) {
    throw new ApplyPatchRuntimeError(
      `path is outside allowed directories: ${path}` +
        (safe.reason ? ` (${safe.reason})` : ""),
    );
  }
  return safe.resolved;
}

function splitSourceLines(contents: string): string[] {
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function computeReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
): readonly Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    let anchorIndex: number | null = null;
    if (chunk.changeContext !== null) {
      const idx = seekSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (idx === null) {
        throw new ApplyPatchRuntimeError(
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        );
      }
      lineIndex = idx + 1;
      anchorIndex = idx + 1; // insert immediately after the matched context line
    }

    if (chunk.oldLines.length === 0) {
      // A pure insertion (`@@ <context>` with only `+` lines) must land right
      // after its located anchor, not at EOF. Only fall back to end-of-file
      // when the chunk had no context anchor at all.
      const insertionIdx =
        anchorIndex !== null
          ? anchorIndex
          : originalLines.at(-1) === ""
            ? originalLines.length - 1
            : originalLines.length;
      replacements.push({
        startIndex: insertionIdx,
        oldLength: 0,
        newLines: chunk.newLines,
      });
      // Keep subsequent chunks ordered past this insertion point.
      lineIndex = insertionIdx;
      continue;
    }

    let pattern = [...chunk.oldLines];
    let newSlice = [...chunk.newLines];
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.isEndOfFile,
    );

    if (found === null && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.at(-1) === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.isEndOfFile,
      );
    }

    if (found === null) {
      throw new ApplyPatchRuntimeError(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push({
      startIndex: found,
      oldLength: pattern.length,
      newLines: newSlice,
    });
    lineIndex = found + pattern.length;
  }

  return [...replacements].sort((left, right) =>
    left.startIndex - right.startIndex,
  );
}

function applyReplacements(
  lines: readonly string[],
  replacements: readonly Replacement[],
): readonly string[] {
  const next = [...lines];
  for (const replacement of [...replacements].reverse()) {
    next.splice(
      replacement.startIndex,
      replacement.oldLength,
      ...replacement.newLines,
    );
  }
  return next;
}

async function deriveNewContentsFromChunks(
  pathAbs: string,
  chunks: readonly UpdateFileChunk[],
): Promise<AppliedPatch> {
  let originalContents: string;
  try {
    originalContents = await readFile(pathAbs, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ApplyPatchRuntimeError(
      code
        ? `${code}: Failed to read file to update ${pathAbs}`
        : `Failed to read file to update ${pathAbs}`,
    );
  }

  const originalLines = splitSourceLines(originalContents);
  const replacements = computeReplacements(originalLines, pathAbs, chunks);
  const newLines = [...applyReplacements(originalLines, replacements)];
  if (newLines.at(-1) !== "") newLines.push("");
  return {
    originalContents,
    newContents: newLines.join("\n"),
  };
}

function formatHunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function unifiedPatchBody(
  path: string,
  beforeText: string,
  afterText: string,
  context: number,
): string {
  const patch = structuredPatch(
    path,
    path,
    beforeText,
    afterText,
    undefined,
    undefined,
    { context, timeout: 1_000 },
  );
  return (patch?.hunks ?? [])
    .map((hunk) => {
      const header =
        `@@ -${formatHunkRange(hunk.oldStart, hunk.oldLines)} ` +
        `+${formatHunkRange(hunk.newStart, hunk.newLines)} @@`;
      return `${header}\n${hunk.lines.join("\n")}\n`;
    })
    .join("");
}

export async function unifiedDiffFromChunks(
  pathAbs: string,
  chunks: readonly UpdateFileChunk[],
  context = 1,
): Promise<ApplyPatchFileUpdate> {
  const applied = await deriveNewContentsFromChunks(pathAbs, chunks);
  return {
    unifiedDiff: unifiedPatchBody(
      pathAbs,
      applied.originalContents,
      applied.newContents,
      context,
    ),
    content: applied.newContents,
  };
}

function buildSnapshot(content: string, mtimeMs: number): {
  readonly content: string;
  readonly rawContent: string;
  readonly timestamp: number;
  readonly viewKind: SessionReadViewKind;
} {
  return {
    content,
    rawContent: content,
    timestamp: Number.isFinite(mtimeMs) ? mtimeMs : Date.now(),
    viewKind: "full",
  };
}

async function recordPostWriteRead(
  sessionId: string | undefined,
  absolutePath: string,
  content: string,
): Promise<void> {
  if (sessionId === undefined) return;
  let mtimeMs = Date.now();
  try {
    const post = await stat(absolutePath);
    if (Number.isFinite(post.mtimeMs)) mtimeMs = post.mtimeMs;
  } catch {
    // Best effort only; the file write already succeeded.
  }
  recordSessionRead(sessionId, absolutePath, buildSnapshot(content, mtimeMs));
}

async function writeFileCreatingParents(
  pathAbs: string,
  contents: string,
): Promise<void> {
  try {
    await writeFile(pathAbs, contents, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ApplyPatchRuntimeError(
        `Failed to write file ${pathAbs}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      await mkdir(dirname(pathAbs), { recursive: true });
      await writeFile(pathAbs, contents, "utf8");
    } catch (innerError) {
      throw new ApplyPatchRuntimeError(
        `Failed to write file ${pathAbs}: ${
          innerError instanceof Error ? innerError.message : String(innerError)
        }`,
      );
    }
  }
}

async function removeFile(pathAbs: string): Promise<void> {
  try {
    const metadata = await stat(pathAbs);
    if (metadata.isDirectory()) {
      throw new ApplyPatchRuntimeError(
        `Failed to delete file ${pathAbs}: path is a directory`,
      );
    }
    await rm(pathAbs, { force: false, recursive: false });
  } catch (error) {
    if (error instanceof ApplyPatchRuntimeError) throw error;
    throw new ApplyPatchRuntimeError(
      `Failed to delete file ${pathAbs}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function printSummary(affected: AffectedPaths): string {
  const lines = ["Success. Updated the following files:"];
  for (const path of affected.added) lines.push(`A ${path}`);
  for (const path of affected.modified) lines.push(`M ${path}`);
  for (const path of affected.deleted) lines.push(`D ${path}`);
  return `${lines.join("\n")}\n`;
}

async function applyHunksToFiles(
  hunks: readonly ApplyPatchHunk[],
  opts: ApplyPatchRuntimeOptions,
): Promise<{
  readonly affected: AffectedPaths;
  readonly mutationMetadata: readonly MutationMetadataEntry[];
}> {
  if (hunks.length === 0) {
    throw new ApplyPatchRuntimeError("No files were modified.");
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const mutationMetadata: MutationMetadataEntry[] = [];

  for (const hunk of hunks) {
    const affectedPath = hunkAffectedPath(hunk);
    const pathAbs = await resolveSafePath(hunk.path, opts);
    if (hunk.kind === "add") {
      await writeFileCreatingParents(pathAbs, hunk.contents);
      await recordPostWriteRead(opts.sessionId, pathAbs, hunk.contents);
      added.push(affectedPath);
      mutationMetadata.push({
        filePath: affectedPath,
        operation: "create",
        metadata: buildFileMutationMetadata({
          filePath: affectedPath,
          operation: "create",
          beforeText: "",
          afterText: hunk.contents,
        }),
      });
      continue;
    }

    if (hunk.kind === "delete") {
      let originalContents = "";
      try {
        originalContents = await readFile(pathAbs, "utf8");
      } catch {
        originalContents = "";
      }
      await removeFile(pathAbs);
      if (opts.sessionId !== undefined) {
        dropSessionReadSnapshot(opts.sessionId, pathAbs);
      }
      deleted.push(affectedPath);
      mutationMetadata.push({
        filePath: affectedPath,
        operation: "edit",
        metadata: buildFileMutationMetadata({
          filePath: affectedPath,
          operation: "edit",
          beforeText: originalContents,
          afterText: "",
        }),
      });
      continue;
    }

    const applied = await deriveNewContentsFromChunks(pathAbs, hunk.chunks);
    const writePathAbs =
      hunk.movePath === null
        ? pathAbs
        : await resolveSafePath(hunk.movePath, opts);
    await writeFileCreatingParents(writePathAbs, applied.newContents);
    await recordPostWriteRead(opts.sessionId, writePathAbs, applied.newContents);
    if (hunk.movePath !== null) {
      await removeFile(pathAbs);
      if (opts.sessionId !== undefined) {
        dropSessionReadSnapshot(opts.sessionId, pathAbs);
      }
    }
    modified.push(affectedPath);
    mutationMetadata.push({
      filePath: affectedPath,
      operation: "edit",
      metadata: buildFileMutationMetadata({
        filePath: affectedPath,
        operation: "edit",
        beforeText: applied.originalContents,
        afterText: applied.newContents,
      }),
    });
  }

  return {
    affected: { added, modified, deleted },
    mutationMetadata,
  };
}

async function applyParsedPatch(
  parsed: ApplyPatchArgs,
  opts: ApplyPatchRuntimeOptions,
): Promise<ApplyPatchResult> {
  const { affected, mutationMetadata } = await applyHunksToFiles(
    parsed.hunks,
    opts,
  );
  return {
    affected,
    summary: printSummary(affected),
    metadata: {
      affectedPaths: affected,
      fileMutations: mutationMetadata,
    },
  };
}

export async function applyPatchText(
  patch: string,
  opts: ApplyPatchRuntimeOptions,
): Promise<ApplyPatchResult> {
  return applyParsedPatch(parsePatch(patch), opts);
}

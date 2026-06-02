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
  getSessionReadSnapshot,
  recordSessionRead,
  safePathAllowingSessionPlanFile,
  type SessionReadSnapshot,
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

// Verbatim parity with the Edit/MultiEdit read-before-write gate
// (system/file-edit.ts). The apply_patch update path enforces the same
// invariants so the model cannot bypass them by routing an edit through
// a patch: an existing file must have been read this session (a full OR
// partial offset/limit read authorizes it; only an absent read or a
// synthetic partial view is rejected), and it must not have drifted on
// disk since that read.
const READ_BEFORE_WRITE_ERROR =
  "File has not been read yet. Read it first before writing to it.";

const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

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

async function readFileToUpdate(pathAbs: string): Promise<string> {
  try {
    return await readFile(pathAbs, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ApplyPatchRuntimeError(
      code
        ? `${code}: Failed to read file to update ${pathAbs}`
        : `Failed to read file to update ${pathAbs}`,
    );
  }
}

async function deriveNewContentsFromChunks(
  pathAbs: string,
  chunks: readonly UpdateFileChunk[],
  preReadContents?: string,
): Promise<AppliedPatch> {
  const originalContents =
    preReadContents ?? (await readFileToUpdate(pathAbs));

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

/**
 * Read-before-write authorization predicate. ANY real read of the path —
 * full OR partial offset/limit window — authorizes the patch; the gate
 * only exists to force the model to observe real bytes first. Reject only
 * an absent snapshot or a SYNTHETIC partial view (`isPartialView === true`)
 * that never reflected disk bytes the model chose to read. Mirrors the
 * Edit gate predicate; the mtime-drift check below still rejects
 * independently.
 */
function isAuthorizingSessionRead(
  snapshot: SessionReadSnapshot | undefined,
): boolean {
  return snapshot !== undefined && snapshot.isPartialView !== true;
}

function comparableSessionContent(
  snapshot: SessionReadSnapshot | undefined,
): string | undefined {
  const content =
    typeof snapshot?.rawContent === "string"
      ? snapshot.rawContent
      : snapshot?.content;
  return typeof content === "string"
    ? content.replaceAll("\r\n", "\n")
    : undefined;
}

/**
 * Read-before-write / mtime-drift gate for the apply_patch update path,
 * mirroring the Edit/MultiEdit enforcement in system/file-edit.ts.
 *
 * Only runs when a session id is present (the production tool surface
 * injects one). The existing file MUST have been read in this session —
 * a full OR partial offset/limit read authorizes the patch; only an
 * absent read or a synthetic partial view is rejected with the same
 * verbatim error Edit uses. If the on-disk mtime advanced past the
 * recorded read
 * — and the content actually differs (Windows cloud-sync benign-touch
 * guard) — the patch is rejected so the model is forced to re-read.
 */
async function assertReadBeforeWriteGate(
  sessionId: string | undefined,
  pathAbs: string,
  currentContents: string,
): Promise<void> {
  if (sessionId === undefined) return;

  const recordedSnapshot = getSessionReadSnapshot(sessionId, pathAbs);
  if (!isAuthorizingSessionRead(recordedSnapshot)) {
    throw new ApplyPatchRuntimeError(READ_BEFORE_WRITE_ERROR);
  }

  const recordedTs = recordedSnapshot?.timestamp;
  if (typeof recordedTs !== "number" || !Number.isFinite(recordedTs)) return;

  let currentMtimeMs: number | undefined;
  try {
    const current = await stat(pathAbs);
    if (Number.isFinite(current.mtimeMs)) currentMtimeMs = current.mtimeMs;
  } catch {
    // Best effort: a failed stat leaves the drift check inconclusive,
    // matching Edit's fall-through behavior when the re-stat fails.
    return;
  }

  if (currentMtimeMs === undefined || currentMtimeMs <= recordedTs) return;

  const recordedContent = comparableSessionContent(recordedSnapshot);
  const normalizedCurrent = currentContents.replaceAll("\r\n", "\n");
  const isFullContentMatch =
    recordedSnapshot?.viewKind === "full" &&
    recordedContent === normalizedCurrent;
  if (!isFullContentMatch) {
    throw new ApplyPatchRuntimeError(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
  }
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
      // gaphunt3 #40: delete is a mutation and must honor the same
      // read-before-write / mtime-drift gate as the update path, so the
      // model cannot blind-delete an in-allowlist file it never observed
      // this session.
      await assertReadBeforeWriteGate(opts.sessionId, pathAbs, originalContents);
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

    const currentContents = await readFileToUpdate(pathAbs);
    await assertReadBeforeWriteGate(opts.sessionId, pathAbs, currentContents);
    const applied = await deriveNewContentsFromChunks(
      pathAbs,
      hunk.chunks,
      currentContents,
    );
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

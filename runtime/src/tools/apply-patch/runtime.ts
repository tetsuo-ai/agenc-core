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

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
import {
  beginWorkspaceMutation,
  cancelWorkspaceMutation,
  commitWorkspaceMutation,
  completeWorkspaceTopologyMutation,
  prepareWorkspaceMutation,
  reconcileUnknownMutation,
  releaseWorkspaceTopologyMutation,
  reserveWorkspaceTopologyMutation,
  workspaceAuthoritativeRead,
  workspaceMutationAdmissionToolResult,
  workspaceMutationBlockedToolResult,
  WorkspaceMutationRejectedError,
  type WorkspaceTopologyMutationReservation,
} from "../../workspace/mutation-coordinator.js";
import {
  captureWorkspaceFilePathTransactionGuard,
  WorkspaceFileMutationPreEffectConflictError,
  type WorkspaceFilePathExpectedState,
  type WorkspaceFilePathTransactionGuard,
} from "../../workspace/file-mutation-transaction.js";

type ApplyPatchObservedPathState =
  | { readonly kind: "content"; readonly content: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

interface ApplyPatchRollbackHookInput {
  readonly path: string;
  readonly backup: {
    readonly existed: boolean;
    readonly content: string;
  };
  readonly restore: () => Promise<void>;
}

export interface ApplyPatchRuntimeOptions {
  readonly cwd: string;
  readonly allowedPaths: readonly string[];
  readonly rawArgs?: Record<string, unknown>;
  readonly sessionId?: string;
  /**
   * Deterministic fault-injection seam for rollback transaction tests.
   * Production callers leave this unset.
   */
  readonly __testRestoreBackup?: (
    input: ApplyPatchRollbackHookInput,
  ) => Promise<void>;
  /**
   * Deterministic race seam after every target has an exact backup/path proof,
   * but before the first target syscall can run.
   */
  readonly __testAfterBackupsCaptured?: (input: {
    readonly paths: readonly string[];
  }) => Promise<void>;
  /**
   * Deterministic race seam after the path's final pathname assertion and
   * directory binding, immediately before the descriptor-bound effect.
   */
  readonly __testAfterPreWriteCheck?: (input: {
    readonly path: string;
    readonly kind: PlannedDiskOp["kind"];
  }) => Promise<void>;
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

// A single disk mutation the commit phase will perform. The planning phase
// produces these without touching disk, so all validation/computation that can
// throw happens before the first byte is written.
type PlannedDiskOp =
  | {
      readonly kind: "write";
      readonly path: string;
      readonly content: string;
      readonly beforeExisted: boolean;
      readonly beforeContent: string;
      readonly recordRead: boolean;
    }
  | {
      readonly kind: "remove";
      readonly path: string;
      readonly beforeExisted: boolean;
      readonly beforeContent: string;
      readonly dropRead: boolean;
    };

// Pre-commit snapshot of a touched path, used to roll back an in-progress
// commit. `existed:false` means the path was absent (rollback = delete).
interface FileBackup {
  readonly existed: boolean;
  readonly content: string;
  readonly contentBytes: Buffer;
  readonly guard: WorkspaceFilePathTransactionGuard;
}

interface BackupRestoreResult {
  readonly path: string;
  readonly restored: boolean;
  readonly observed: ApplyPatchObservedPathState;
  readonly restoreError?: unknown;
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

  return [...replacements].sort(
    (left, right) => left.startIndex - right.startIndex,
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
  const originalContents = preReadContents ?? (await readFileToUpdate(pathAbs));

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

function buildSnapshot(
  content: string,
  mtimeMs: number,
): {
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

/**
 * Snapshot a path's pre-commit state so the commit phase can roll back. A
 * missing file (ENOENT) records `existed:false` (rollback = delete). Any other
 * read failure (EACCES, EISDIR, …) means we cannot guarantee a safe revert, so
 * we fail CLOSED here — before any byte is written — rather than risk an
 * unrecoverable partial apply.
 */
async function captureBackup(pathAbs: string): Promise<FileBackup> {
  try {
    const guard = await captureWorkspaceFilePathTransactionGuard(pathAbs);
    return {
      existed: guard.targetExisted,
      content: guard.backupContent?.toString("utf8") ?? "",
      contentBytes: guard.backupContent ?? Buffer.alloc(0),
      guard,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ApplyPatchRuntimeError(
      `Cannot snapshot ${pathAbs} for rollback safety; refusing to apply patch (${
        code ?? (error instanceof Error ? error.message : String(error))
      })`,
    );
  }
}

async function observePathState(
  backup: FileBackup,
): Promise<ApplyPatchObservedPathState> {
  const observed = await backup.guard.observeState();
  return observed.kind === "content"
    ? { kind: "content", content: observed.content.toString("utf8") }
    : observed;
}

function observedStateMatchesBackup(
  observed: ApplyPatchObservedPathState,
  backup: FileBackup,
): boolean {
  return backup.existed
    ? observed.kind === "content" && observed.content === backup.content
    : observed.kind === "missing";
}

function backupExpectedState(
  backup: FileBackup,
): WorkspaceFilePathExpectedState {
  return backup.existed
    ? { kind: "content", content: backup.contentBytes }
    : { kind: "missing" };
}

function operationExpectedState(
  operation: PlannedDiskOp,
): WorkspaceFilePathExpectedState {
  return operation.kind === "write"
    ? { kind: "content", content: Buffer.from(operation.content, "utf8") }
    : { kind: "missing" };
}

async function restoreOneBackup(
  pathAbs: string,
  backup: FileBackup,
  rollbackCandidates: readonly WorkspaceFilePathExpectedState[],
): Promise<void> {
  const backupState = backupExpectedState(backup);
  try {
    await backup.guard.assertState(backupState);
    return;
  } catch {
    // A restore is only allowed from an exact state produced (or potentially
    // produced) by this transaction. Never write through an unproved alias or
    // over bytes published by another actor.
  }

  let currentState: WorkspaceFilePathExpectedState | undefined;
  for (const candidate of rollbackCandidates) {
    try {
      await backup.guard.assertState(candidate);
      currentState = candidate;
      break;
    } catch {
      // Try the next exact transaction-owned state.
    }
  }
  if (currentState === undefined) {
    throw new ApplyPatchRuntimeError(
      `Refusing unsafe rollback for ${pathAbs}: its parent identity, existence, or exact bytes no longer match this apply_patch transaction`,
    );
  }

  if (backup.existed) {
    await backup.guard.writeBoundContent(currentState, backup.contentBytes);
  } else {
    await backup.guard.removeBoundEntry(currentState);
  }
  await backup.guard.assertState(backupState);
}

/**
 * Attempt and then verify every target that may have reached the filesystem.
 *
 * A successful restore syscall is not sufficient proof: a short write,
 * replacement race, or unusual filesystem can still leave different bytes.
 * Conversely, a restore syscall can throw after completing its effect. The
 * observed final path state is therefore the authority for reconciliation.
 */
async function restoreAndVerifyBackups(
  backups: ReadonlyMap<string, FileBackup>,
  touchedPaths: ReadonlySet<string>,
  rollbackCandidates: ReadonlyMap<
    string,
    readonly WorkspaceFilePathExpectedState[]
  >,
  restoreHook: ApplyPatchRuntimeOptions["__testRestoreBackup"],
): Promise<readonly BackupRestoreResult[]> {
  const results: BackupRestoreResult[] = [];
  for (const pathAbs of touchedPaths) {
    const backup = backups.get(pathAbs);
    if (backup === undefined) {
      results.push({
        path: pathAbs,
        restored: false,
        observed: { kind: "unreadable" },
        restoreError: new Error(
          "the path was touched before its rollback snapshot was available",
        ),
      });
      continue;
    }
    let restoreError: unknown;
    try {
      const restore = () =>
        restoreOneBackup(
          pathAbs,
          backup,
          rollbackCandidates.get(pathAbs) ?? [],
        );
      if (restoreHook === undefined) {
        await restore();
      } else {
        await restoreHook({ path: pathAbs, backup, restore });
      }
    } catch (error) {
      restoreError = error;
    }
    const observed = await observePathState(backup);
    let restored = false;
    try {
      await backup.guard.assertState(backupExpectedState(backup));
      restored = observedStateMatchesBackup(observed, backup);
    } catch {
      restored = false;
    }
    results.push({
      path: pathAbs,
      restored,
      observed,
      ...(!restored && restoreError !== undefined ? { restoreError } : {}),
    });
  }
  return results;
}

function rollbackObservationLabel(
  observed: ApplyPatchObservedPathState,
): string {
  switch (observed.kind) {
    case "content":
      return "present with unverified content";
    case "missing":
      return "missing";
    case "unreadable":
      return "unreadable";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Apply a parsed patch atomically. Historically this looped over hunks doing
 * per-hunk disk I/O, so a failure on hunk N (bad context, allowlist, or the
 * read-before-write gate) left hunks 1..N-1 already mutated on disk with no
 * rollback — and the model, seeing only the error, would retry and double-apply
 * pure insertions. This is now a transaction:
 *
 *   PHASE 1 (plan): resolve paths, run the read-before-write / mtime gate, and
 *     compute every file's final content entirely in memory. Nothing touches
 *     disk, so any validation failure aborts with the working tree untouched.
 *   PHASE 2 (commit): snapshot every path the commit will touch, then perform
 *     the writes/removes. If a step fails, revert all touched paths to their
 *     snapshots so the patch is all-or-nothing.
 *   PHASE 3 (bookkeeping): only after every disk op succeeds, update advisory
 *     session-read state — so a rollback never has to unwind it.
 */
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
  const plannedOps: PlannedDiskOp[] = [];

  // Virtual overlay of the planned filesystem state, so a later hunk that
  // touches a path an earlier hunk already wrote/deleted plans against that
  // pending result instead of stale disk bytes — preserving the original
  // sequential semantics without mutating disk during planning.
  const overlay = new Map<
    string,
    { readonly deleted: boolean; readonly content: string }
  >();
  const planRead = async (pathAbs: string): Promise<string> => {
    const pending = overlay.get(pathAbs);
    if (pending !== undefined) {
      if (pending.deleted) {
        throw new ApplyPatchRuntimeError(
          `Failed to read file to update ${pathAbs}`,
        );
      }
      return pending.content;
    }
    const editorRead = workspaceAuthoritativeRead(pathAbs);
    return editorRead?.content ?? readFileToUpdate(pathAbs);
  };
  const planReadStateIfPresent = async (
    pathAbs: string,
  ): Promise<{ readonly existed: boolean; readonly content: string }> => {
    const pending = overlay.get(pathAbs);
    if (pending !== undefined) {
      return pending.deleted
        ? { existed: false, content: "" }
        : { existed: true, content: pending.content };
    }
    const editorRead = workspaceAuthoritativeRead(pathAbs);
    if (editorRead !== null) {
      return { existed: true, content: editorRead.content };
    }
    try {
      return { existed: true, content: await readFile(pathAbs, "utf8") };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { existed: false, content: "" };
      }
      throw new ApplyPatchRuntimeError(
        code
          ? `${code}: Failed to read file to update ${pathAbs}`
          : `Failed to read file to update ${pathAbs}`,
      );
    }
  };

  // PHASE 1 — plan + validate entirely in memory.
  for (const hunk of hunks) {
    const affectedPath = hunkAffectedPath(hunk);
    const pathAbs = await resolveSafePath(hunk.path, opts);

    if (hunk.kind === "add") {
      const before = await planReadStateIfPresent(pathAbs);
      plannedOps.push({
        kind: "write",
        path: pathAbs,
        content: hunk.contents,
        beforeExisted: before.existed,
        beforeContent: before.content,
        recordRead: true,
      });
      overlay.set(pathAbs, { deleted: false, content: hunk.contents });
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
      const original = await planReadStateIfPresent(pathAbs);
      const originalContents = original.content;
      // gaphunt3 #40: delete is a mutation and must honor the same
      // read-before-write / mtime-drift gate as the update path, so the
      // model cannot blind-delete an in-allowlist file it never observed
      // this session.
      await assertReadBeforeWriteGate(
        opts.sessionId,
        pathAbs,
        originalContents,
      );
      plannedOps.push({
        kind: "remove",
        path: pathAbs,
        beforeExisted: original.existed,
        beforeContent: originalContents,
        dropRead: true,
      });
      overlay.set(pathAbs, { deleted: true, content: "" });
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

    const currentContents = await planRead(pathAbs);
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
    const destinationBefore =
      writePathAbs === pathAbs
        ? { existed: true, content: currentContents }
        : await planReadStateIfPresent(writePathAbs);
    plannedOps.push({
      kind: "write",
      path: writePathAbs,
      content: applied.newContents,
      beforeExisted: destinationBefore.existed,
      beforeContent: destinationBefore.content,
      recordRead: true,
    });
    overlay.set(writePathAbs, { deleted: false, content: applied.newContents });
    // Only remove the source on a real move; a "move" whose destination
    // normalizes back to the source must keep the rewritten file.
    if (hunk.movePath !== null && writePathAbs !== pathAbs) {
      plannedOps.push({
        kind: "remove",
        path: pathAbs,
        beforeExisted: true,
        beforeContent: currentContents,
        dropRead: true,
      });
      overlay.set(pathAbs, { deleted: true, content: "" });
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

  // PHASE 2 — reserve every path through the workspace coherence boundary
  // before touching disk. A dirty live editor buffer becomes a shadow
  // proposal; a stale buffer blocks the whole multi-file transaction.
  //
  // A proposal is intentionally single-path. Multi-path patches therefore
  // take one topology fence first: if any target is loaded in Editor, the
  // whole patch is rejected before a source-only delete or destination-only
  // write can escape as a misleading partial proposal.
  let batchTopology: WorkspaceTopologyMutationReservation | null = null;
  let batchTopologySettled = false;
  const releaseBatchTopology = async (): Promise<void> => {
    if (batchTopology === null || batchTopologySettled) return;
    batchTopologySettled = true;
    await releaseWorkspaceTopologyMutation(batchTopology);
  };
  const completeBatchTopology = async (
    status: "applied" | "unknown_outcome",
  ): Promise<void> => {
    if (batchTopology === null || batchTopologySettled) return;
    batchTopologySettled = true;
    await completeWorkspaceTopologyMutation(batchTopology, status);
  };
  const requiresTopologyFence =
    plannedOps.length > 1 ||
    plannedOps.some((operation) => operation.kind === "remove");
  if (requiresTopologyFence) {
    const uniqueTargets = [
      ...new Set(plannedOps.map((operation) => operation.path)),
    ].map((path) => ({ path }));
    try {
      batchTopology = await reserveWorkspaceTopologyMutation(
        uniqueTargets,
        "apply_patch",
      );
    } catch (error) {
      throw new WorkspaceMutationRejectedError(
        workspaceMutationBlockedToolResult(
          `apply_patch was not started because its ${
            plannedOps.length > 1 ? "multi-path" : "delete"
          } transaction ` +
            `crosses an active Editor revision: ${
              error instanceof Error ? error.message : String(error)
            }`,
        ),
      );
    }
  }
  const admissions: Array<
    Awaited<ReturnType<typeof prepareWorkspaceMutation>>
  > = [];
  const toolCallId =
    typeof opts.rawArgs?.__callId === "string"
      ? opts.rawArgs.__callId
      : undefined;
  try {
    for (const op of plannedOps) {
      const admission = await prepareWorkspaceMutation(
        {
          path: op.path,
          source: "apply_patch",
          beforeText: op.beforeContent,
          afterText: op.kind === "write" ? op.content : "",
          ...(opts.sessionId !== undefined
            ? { sessionId: opts.sessionId }
            : {}),
          ...(toolCallId !== undefined ? { toolCallId } : {}),
        },
        {
          ...(batchTopology !== null
            ? { topologyReservation: batchTopology }
            : {}),
        },
      );
      const rejection = workspaceMutationAdmissionToolResult(admission);
      if (rejection !== null) {
        throw new WorkspaceMutationRejectedError(rejection);
      }
      admissions.push(admission);
    }
  } catch (error) {
    for (const prior of admissions) cancelWorkspaceMutation(prior);
    await releaseBatchTopology();
    throw error;
  }
  try {
    for (const admission of admissions) beginWorkspaceMutation(admission);
  } catch (error) {
    for (const admission of admissions) cancelWorkspaceMutation(admission);
    await releaseBatchTopology();
    throw error;
  }

  // Snapshot every touched path, then commit with rollback.
  const backups = new Map<string, FileBackup>();
  const touchedPaths = new Set<string>();
  const completedPathStates = new Map<string, WorkspaceFilePathExpectedState>();
  const rollbackCandidates = new Map<
    string,
    WorkspaceFilePathExpectedState[]
  >();
  const pathEffectCounts = new Map<string, number>();
  try {
    try {
      for (const op of plannedOps) {
        if (!backups.has(op.path)) {
          const backup = await captureBackup(op.path);
          if (
            backup.existed !== op.beforeExisted ||
            (backup.existed &&
              !backup.contentBytes.equals(
                Buffer.from(op.beforeContent, "utf8"),
              ))
          ) {
            throw new ApplyPatchRuntimeError(
              `Cannot snapshot ${op.path} for rollback safety; its existence or exact bytes changed after apply_patch planning`,
            );
          }
          backups.set(op.path, backup);
        }
      }
      await opts.__testAfterBackupsCaptured?.({
        paths: [...backups.keys()],
      });
      for (const op of plannedOps) {
        const backup = backups.get(op.path);
        if (backup === undefined) {
          throw new ApplyPatchRuntimeError(
            `Missing rollback snapshot for ${op.path}`,
          );
        }
        const completedState = completedPathStates.get(op.path);
        if (completedState === undefined) {
          await backup.guard.assertOriginalState();
        } else {
          await backup.guard.assertState(completedState);
        }
        const beforeState = completedState ?? backupExpectedState(backup);
        await backup.guard.prepareBoundMutation(
          beforeState,
          op.kind === "write" ? "write" : "remove",
        );
        await opts.__testAfterPreWriteCheck?.({
          path: op.path,
          kind: op.kind,
        });
        const afterState = operationExpectedState(op);

        // Mark the path before invoking the syscall: a rejected or interrupted
        // write can still have produced a partial filesystem effect.
        const priorEffectCount = pathEffectCounts.get(op.path) ?? 0;
        let effectStarted = false;
        const markEffectStarted = (): void => {
          if (effectStarted) return;
          effectStarted = true;
          touchedPaths.add(op.path);
          pathEffectCounts.set(op.path, priorEffectCount + 1);
          const candidates = rollbackCandidates.get(op.path) ?? [];
          candidates.push(afterState);
          rollbackCandidates.set(op.path, candidates);
        };
        try {
          if (op.kind === "write") {
            await backup.guard.writeBoundContent(
              beforeState,
              Buffer.from(op.content, "utf8"),
              markEffectStarted,
            );
          } else {
            await backup.guard.removeBoundEntry(beforeState, markEffectStarted);
          }
        } catch (error) {
          if (
            error instanceof WorkspaceFileMutationPreEffectConflictError &&
            priorEffectCount === 0 &&
            effectStarted
          ) {
            // O_EXCL/EEXIST proves this operation had no effect. If this path had
            // no earlier batch operation either, rollback must not delete the
            // concurrently published target.
            touchedPaths.delete(op.path);
            pathEffectCounts.delete(op.path);
          }
          throw error;
        }
        await backup.guard.assertState(afterState);
        completedPathStates.set(op.path, afterState);
      }
    } catch (error) {
      if (touchedPaths.size === 0) {
        for (const admission of admissions) {
          cancelWorkspaceMutation(admission);
        }
        await releaseBatchTopology();
        throw new ApplyPatchRuntimeError(
          `apply_patch stopped before writing any target path. ${errorMessage(
            error,
          )}`,
        );
      }
      const restoreResults = await restoreAndVerifyBackups(
        backups,
        touchedPaths,
        rollbackCandidates,
        opts.__testRestoreBackup,
      );
      const restoreByPath = new Map(
        restoreResults.map((result) => [result.path, result] as const),
      );
      const reconciliationFailures: Array<{
        readonly path: string;
        readonly error: unknown;
      }> = [];
      const uncoordinatedUnknownPaths = new Set<string>();

      // Every reservation must reach a terminal state even if an earlier
      // rollback audit fails. Duplicate-path operations have distinct tokens,
      // so reconcile each admission rather than only each unique path.
      for (let index = 0; index < plannedOps.length; index += 1) {
        const op = plannedOps[index]!;
        const admission = admissions[index]!;
        const restoreResult = restoreByPath.get(op.path);
        if (restoreResult === undefined || restoreResult.restored) {
          cancelWorkspaceMutation(admission);
          continue;
        }
        if (admission.decision !== "allow") {
          cancelWorkspaceMutation(admission);
          uncoordinatedUnknownPaths.add(op.path);
          continue;
        }
        try {
          await reconcileUnknownMutation(
            admission.token,
            restoreResult.observed,
            {
              ...(opts.sessionId !== undefined
                ? { sessionId: opts.sessionId }
                : {}),
              ...(toolCallId !== undefined ? { toolCallId } : {}),
            },
          );
        } catch (reconciliationError) {
          reconciliationFailures.push({
            path: op.path,
            error: reconciliationError,
          });
        }
      }

      const unverified = restoreResults.filter((result) => !result.restored);
      if (unverified.length === 0) {
        await releaseBatchTopology();
        throw new ApplyPatchRuntimeError(
          `apply_patch failed while writing and was rolled back; every touched ` +
            `file target was verified restored to its captured contents and ` +
            `existence. ${errorMessage(error)}`,
        );
      }

      const unverifiedDetails = unverified
        .map((result) => {
          const restoreFailure =
            result.restoreError === undefined
              ? ""
              : `; restore failed: ${errorMessage(result.restoreError)}`;
          return `${result.path} (${rollbackObservationLabel(
            result.observed,
          )}${restoreFailure})`;
        })
        .join("; ");
      const reconciliationDetail =
        reconciliationFailures.length === 0
          ? "Every coordinated path was durably marked unknown_outcome."
          : `Unknown-outcome reconciliation also failed for ${
              reconciliationFailures.length
            } admission(s): ${reconciliationFailures
              .map(
                (failure) => `${failure.path}: ${errorMessage(failure.error)}`,
              )
              .join("; ")}.`;
      const uncoordinatedDetail =
        uncoordinatedUnknownPaths.size === 0
          ? ""
          : ` No workspace coordinator was active for: ${[
              ...uncoordinatedUnknownPaths,
            ].join(", ")}.`;
      let topologyDetail = "";
      try {
        await completeBatchTopology("unknown_outcome");
      } catch (topologyError) {
        topologyDetail =
          ` The multi-path fence could not persist its unknown outcome: ` +
          `${errorMessage(topologyError)}.`;
      }
      throw new ApplyPatchRuntimeError(
        `apply_patch failed while writing and rollback was incomplete. ` +
          `${unverified.length} path(s) could not be verified restored and ` +
          `must be re-read before another mutation: ${unverifiedDetails}. ` +
          `${reconciliationDetail}${uncoordinatedDetail}${topologyDetail} Original write ` +
          `failure: ${errorMessage(error)}`,
      );
    }

    const auditFailures: Array<{
      readonly path: string;
      readonly error: unknown;
    }> = [];
    for (let index = 0; index < plannedOps.length; index += 1) {
      const op = plannedOps[index]!;
      const admission = admissions[index]!;
      try {
        await commitWorkspaceMutation(
          admission,
          op.kind === "write" ? op.content : "",
          {
            ...(opts.sessionId !== undefined
              ? { sessionId: opts.sessionId }
              : {}),
            ...(toolCallId !== undefined ? { toolCallId } : {}),
          },
        );
      } catch (error) {
        auditFailures.push({ path: op.path, error });
      } finally {
        // A successful commit consumes the token; cancellation is idempotent.
        // On a failed commit this guarantees no later editor sync is blocked,
        // while the loop continues to reconcile every file already changed.
        cancelWorkspaceMutation(admission);
      }
    }
    try {
      await completeBatchTopology(
        auditFailures.length === 0 ? "applied" : "unknown_outcome",
      );
    } catch (error) {
      auditFailures.push({
        path: opts.cwd,
        error: new Error(
          `multi-path workspace fence audit failed: ${errorMessage(error)}`,
        ),
      });
    }
    if (auditFailures.length > 0) {
      const details = auditFailures
        .map(
          ({ path, error }) =>
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("; ");
      throw new ApplyPatchRuntimeError(
        `apply_patch changed files on disk, but ${auditFailures.length} workspace audit outcome(s) are unknown. Re-read every affected file before another mutation. ${details}`,
      );
    }

    // PHASE 3 — every disk op succeeded; update advisory session-read state.
    for (const op of plannedOps) {
      if (op.kind === "write") {
        if (op.recordRead) {
          await recordPostWriteRead(opts.sessionId, op.path, op.content);
        }
      } else if (op.dropRead && opts.sessionId !== undefined) {
        dropSessionReadSnapshot(opts.sessionId, op.path);
      }
    }

    return {
      affected: { added, modified, deleted },
      mutationMetadata,
    };
  } finally {
    await Promise.all(
      [...backups.values()].map((backup) => backup.guard.dispose()),
    );
  }
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

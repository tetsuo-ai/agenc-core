/**
 * Anchor-file lifecycle for background runs.
 *
 * Anchor files are user-referenced files (resolved from `@mention`) that the
 * supervisor pins on the run so they remain available to every cycle's actor
 * prompt, independent of rolling-history compaction. Oversized files are kept
 * as a truncated preview inline plus a full copy on disk at
 * `~/.agenc/anchors/<sessionId>/<sha>.txt` that the actor can re-read with
 * `system.readFile` if the full content is needed.
 *
 * The module is side-effect-free on its own types; callers own the mutation
 * of `run.anchorFiles` and the disk writes.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AnchorFileRegistration } from "./at-mention-attachments.js";
import type { AnchorFileSnapshot } from "./background-run-supervisor-types.js";

export const ANCHOR_FILE_MAX_ENTRIES = 3;
export const ANCHOR_FILE_MAX_CHARS_PER_ENTRY = 32_000;
export const ANCHOR_FILE_TOTAL_BUDGET_CHARS = 96_000;
export const ANCHOR_FILE_PREVIEW_HEAD_CHARS = 16_000;
export const ANCHOR_FILE_PREVIEW_TAIL_CHARS = 8_000;

function anchorsRoot(): string {
  return join(homedir(), ".agenc", "anchors");
}

function anchorDirFor(sessionId: string): string {
  return join(anchorsRoot(), sessionId);
}

function anchorDiskPathFor(sessionId: string, sha: string): string {
  return join(anchorDirFor(sessionId), `${sha}.txt`);
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Truncates oversized anchor content to a head+tail preview with a stub. */
function truncateForPrompt(content: string): {
  readonly preview: string;
  readonly truncated: boolean;
} {
  if (content.length <= ANCHOR_FILE_MAX_CHARS_PER_ENTRY) {
    return { preview: content, truncated: false };
  }
  const head = content.slice(0, ANCHOR_FILE_PREVIEW_HEAD_CHARS);
  const tail = content.slice(-ANCHOR_FILE_PREVIEW_TAIL_CHARS);
  const marker =
    `\n\n[... ${content.length - head.length - tail.length} chars omitted; full content stashed on disk — ` +
    `re-read with system.readFile if you need it ...]\n\n`;
  return { preview: head + marker + tail, truncated: true };
}

async function ensureAnchorDiskStash(params: {
  readonly sessionId: string;
  readonly sha: string;
  readonly content: string;
}): Promise<string> {
  const dir = anchorDirFor(params.sessionId);
  const diskPath = anchorDiskPathFor(params.sessionId, params.sha);
  await mkdir(dir, { recursive: true });
  await writeFile(diskPath, params.content, "utf8");
  return diskPath;
}

async function buildSnapshotFromRegistration(params: {
  readonly sessionId: string;
  readonly registration: AnchorFileRegistration;
  readonly now: number;
}): Promise<AnchorFileSnapshot> {
  const { registration } = params;
  const { preview, truncated } = truncateForPrompt(registration.content);
  let diskPath: string | undefined;
  if (truncated) {
    diskPath = await ensureAnchorDiskStash({
      sessionId: params.sessionId,
      sha: registration.sha256,
      content: registration.content,
    });
  }
  return {
    path: registration.path,
    mtimeMs: registration.mtimeMs,
    sizeBytes: registration.sizeBytes,
    sha256: registration.sha256,
    source: registration.source,
    content: preview,
    truncated,
    snapshotTakenAt: params.now,
    ...(diskPath !== undefined ? { diskPath } : {}),
    ...(registration.lineStart !== undefined ? { lineStart: registration.lineStart } : {}),
    ...(registration.lineEnd !== undefined ? { lineEnd: registration.lineEnd } : {}),
  };
}

/**
 * Merge new anchor registrations into an existing anchor array.
 *
 * - Idempotent by canonical path: re-registration replaces in place.
 * - Enforces `ANCHOR_FILE_MAX_ENTRIES` by evicting the oldest `snapshotTakenAt`.
 * - Writes oversized content to disk and retains a preview inline.
 */
export async function mergeAnchorRegistrations(params: {
  readonly sessionId: string;
  readonly existing: readonly AnchorFileSnapshot[];
  readonly registrations: readonly AnchorFileRegistration[];
  readonly now?: number;
}): Promise<AnchorFileSnapshot[]> {
  const now = params.now ?? Date.now();
  const byPath = new Map<string, AnchorFileSnapshot>();
  for (const entry of params.existing) {
    byPath.set(entry.path, entry);
  }
  for (const registration of params.registrations) {
    const snapshot = await buildSnapshotFromRegistration({
      sessionId: params.sessionId,
      registration,
      now,
    });
    byPath.set(snapshot.path, snapshot);
  }
  const sorted = [...byPath.values()].sort(
    (left, right) => right.snapshotTakenAt - left.snapshotTakenAt,
  );
  return sorted.slice(0, ANCHOR_FILE_MAX_ENTRIES);
}

/**
 * Refresh each anchor's content if its on-disk mtime has advanced since the
 * last snapshot. Missing files preserve the prior snapshot with an annotation
 * in `content`. Caller should replace `run.anchorFiles` with the returned
 * array before actor invocation.
 */
export async function refreshAnchorFiles(params: {
  readonly sessionId: string;
  readonly anchors: readonly AnchorFileSnapshot[];
  readonly now?: number;
}): Promise<AnchorFileSnapshot[]> {
  const now = params.now ?? Date.now();
  const results: AnchorFileSnapshot[] = [];
  for (const anchor of params.anchors) {
    let stats;
    try {
      stats = await stat(anchor.path);
    } catch {
      results.push({
        ...anchor,
        content: `${anchor.content}\n\n[anchor file not accessible at ${anchor.path} as of ${new Date(now).toISOString()}]`,
        truncated: anchor.truncated,
        snapshotTakenAt: now,
      });
      continue;
    }
    if (!stats.isFile()) {
      results.push(anchor);
      continue;
    }
    if (stats.mtimeMs === anchor.mtimeMs) {
      results.push(anchor);
      continue;
    }
    let fresh: string;
    try {
      fresh = await readFile(anchor.path, "utf8");
    } catch {
      results.push(anchor);
      continue;
    }
    const sha = sha256Hex(fresh);
    const { preview, truncated } = truncateForPrompt(fresh);
    let diskPath: string | undefined;
    if (truncated) {
      diskPath = await ensureAnchorDiskStash({
        sessionId: params.sessionId,
        sha,
        content: fresh,
      });
    }
    results.push({
      path: anchor.path,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      sha256: sha,
      source: anchor.source,
      content: preview,
      truncated,
      snapshotTakenAt: now,
      ...(diskPath !== undefined ? { diskPath } : {}),
      ...(anchor.lineStart !== undefined ? { lineStart: anchor.lineStart } : {}),
      ...(anchor.lineEnd !== undefined ? { lineEnd: anchor.lineEnd } : {}),
    });
  }
  return results;
}

/** Total character footprint of the anchor section for the prompt. */
export function measureAnchorFootprint(
  anchors: readonly AnchorFileSnapshot[],
): number {
  let total = 0;
  for (const anchor of anchors) {
    total += anchor.content.length;
  }
  return total;
}

/**
 * Format the anchor-files section for injection into the actor prompt.
 * Returns an empty string when there are no anchors.
 *
 * The section deliberately ends with a short directive pointing to
 * `system.readFile` so the model knows where to go for full content when an
 * anchor is truncated.
 */
export function formatAnchorFilesSection(
  anchors: readonly AnchorFileSnapshot[],
): string {
  if (anchors.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "Anchor files (user-referenced; content refreshed each cycle):",
  );
  lines.push("");
  for (const anchor of anchors) {
    const headerRange =
      anchor.lineStart !== undefined
        ? ` lines ${anchor.lineStart}${
            anchor.lineEnd !== undefined && anchor.lineEnd !== anchor.lineStart
              ? `-${anchor.lineEnd}`
              : ""
          }`
        : "";
    lines.push(`=== ${anchor.path}${headerRange} ===`);
    lines.push(
      `sha256: ${anchor.sha256.slice(0, 8)}  mtime: ${new Date(anchor.mtimeMs).toISOString()}  bytes: ${anchor.sizeBytes}`,
    );
    lines.push("");
    lines.push(anchor.content);
    lines.push("");
  }
  const anyTruncated = anchors.some((anchor) => anchor.truncated);
  if (anyTruncated) {
    lines.push(
      "Some anchor contents above are previews only. Full copies are stashed on disk; use system.readFile with the original path to retrieve the unabridged content.",
    );
    lines.push("");
  }
  return lines.join("\n");
}

export const __testing__ = {
  truncateForPrompt,
  sha256Hex,
  anchorDirFor,
  ANCHOR_FILE_TOTAL_BUDGET_CHARS,
};

// Suppress "declared but not used" if a consumer imports without touching
// the internals export.
void ANCHOR_FILE_TOTAL_BUDGET_CHARS;

/**
 * Filesystem tools for @tetsuo-ai/runtime
 *
 * Provides filesystem utility tools for listing and managing
 * files on the host system. All operations are gated by configurable
 * path allowlists with path traversal prevention and size limits.
 *
 * Tools:
 * - system.listDir — list directory entries
 * - system.stat — file/directory metadata
 * - system.mkdir — create directories
 * - system.delete — delete file/directory (requires opt-in)
 * - system.move — rename/move file or directory
 *
 * File content tools are intentionally not registered here. AgenC's
 * canonical file-content surface is the first-class AgenC-owned
 * `FileRead`, `Edit`, and `Write` tools in sibling modules.
 *
 * @module
 */

import {
  createHash,
} from "node:crypto";
import {
  opendir,
  stat,
  lstat,
  mkdir,
  rm,
  rename,
  realpath,
} from "node:fs/promises";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { nonEmptyString } from "../../utils/stringUtils.js";
// Inline lean replacement (gateway/host-workspace.js was deleted).
function resolveSessionWorkspaceRoot(entry?: string): string {
  if (typeof entry === "string" && entry.length > 0) return entry;
  return process.env.AGENC_WORKSPACE ?? process.cwd();
}
import {
  isSessionPlanFile,
  type PlanFileContext,
} from "../../planning/plan-files.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  SESSION_ID_SIG_ARG,
  signAllowedRoots,
  signSessionId,
  verifyAllowedRoots,
  verifySessionId,
  withSignedAllowedRoots,
  withSignedSessionId,
} from "../../agents/_deps/filesystem-args.js";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

// Re-export the HMAC-signed trusted-roots and session-id channel
// constants/helpers so existing importers of `filesystem.ts` keep a
// single source.
export {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  SESSION_ID_SIG_ARG,
  signAllowedRoots,
  signSessionId,
  verifyAllowedRoots,
  verifySessionId,
  withSignedAllowedRoots,
  withSignedSessionId,
};

const MAX_LIST_ENTRIES = 10_000;
const MAX_PATH_LENGTH = 4096;
export const SESSION_AGENC_HOME_ARG = "__agencHome";
export type SessionReadViewKind =
  | "full"
  | "partial"
  | "legacy_unknown";

/**
 * Per-session arg name carrying the session identifier into file-content
 * tool calls. The gateway's `applySessionId` injector adds this to
 * `FileRead`, `Write`, and `Edit` args before invoking the tool, and
 * `stripInternalToolArgs` removes it before any user-visible serialization.
 *
 * The constant is named to mirror {@link SESSION_ALLOWED_ROOTS_ARG} so
 * the convention for "internal arg with double-underscore prefix" stays
 * uniform across the filesystem tool surface.
 */
export const SESSION_ID_ARG = "__agencSessionId";

/**
 * Per-session readFileState map. Tracks which files have been read in
 * each session so that `Write` and `Edit` can enforce a Read-before-Write
 * rule.
 *
 * The rationale is documented in detail in PR #314: forcing the model
 * to call `FileRead` before any modification is the highest-
 * leverage structural defense against the JSON-escape bug Grok exhibits
 * when re-writing C source files via `Write`. The model
 * gets the LITERAL pre-edit bytes (with any visible `\"` mistakes)
 * back into its context BEFORE generating the next write, so escape
 * mismatches become self-correcting instead of accumulating across
 * blind rewrites.
 *
 * Implementation notes:
 *   - Module-level Map keyed by sessionId (string)
 *   - Value is a Set<string> of canonical (post-`canonicalize()`)
 *     paths the model has read in this session
 *   - Reads of non-existent paths are NOT recorded (the path may not
 *     have a canonical form yet)
 *   - `Write` and `Edit` consult this map only
 *     when the target path EXISTS — creating a new file does not
 *     require a prior read (ENOENT escape hatch)
 *   - The latest snapshots are also mirrored into a bounded local
 *     history cache under a temp-root outside the tracked workspace
 *     tree so recent source-of-truth content is available for
 *     inspection without polluting repo files.
 *   - The set lives for the lifetime of the daemon process; explicit
 *     cleanup is handled by `clearSessionReadState(sessionId)` when
 *     a session ends, called from the gateway's session lifecycle
 *
 * This map is intentionally NOT exposed via tool args. Mutation
 * happens via the helpers below; tools never see the underlying Set.
 */
export interface SessionReadSnapshot {
  readonly content?: string | null;
  readonly timestamp?: number;
  readonly viewKind?: SessionReadViewKind;
  /**
   * True only for processed/auto-injected content whose displayed bytes
   * should not authorize a later write. Normal user-initiated `FileRead`
   * calls, including offset/limit reads, leave this false/undefined.
   */
  readonly isPartialView?: boolean;
  /**
   * For partial reads (`viewKind === "partial"`), the exact line offset
   * the model passed. Stored so a subsequent read with the identical
   * `(offset, limit)` and unchanged mtime can serve from the cache stub
   * via range-aware FILE_UNCHANGED dedup.
   */
  readonly readOffset?: number;
  /** For partial reads, the exact line limit the model passed. */
  readonly readLimit?: number;
  /**
   * Raw disk bytes captured at read time, independent of any line-prefix
   * formatting applied to `content`. Populated only on full reads (no
   * offset/limit) so that downstream consumers can compute exact diffs
   * when the file is later mutated.
   *
   * Used by the per-turn changed-files attachment producer
   * (`runtime/src/prompts/attachments/changed-files.ts`) to detect
   * mid-session edits and emit `edited_text_file` snippets.
   *
   * Mirrors the source-file state cache's raw-content semantics: AgenC's
   * `FileStateCache` always stores raw bytes (`fileStateCache.ts:4-15`).
   * AgenC's `content` field carries the formatted display content; this
   * additional field carries the pre-format raw bytes.
   */
  readonly rawContent?: string;
}

export interface SessionReadSeedEntry {
  readonly path: string;
  readonly content?: string | null;
  readonly timestamp?: number;
  readonly viewKind?: SessionReadViewKind;
  readonly isPartialView?: boolean;
  readonly readOffset?: number;
  readonly readLimit?: number;
  /** See `SessionReadSnapshot.rawContent`. */
  readonly rawContent?: string;
}

const sessionReadState = new Map<string, Map<string, SessionReadSnapshot>>();

/**
 * Workspace-scoped mirror of the per-session read state, keyed by
 * `workspaceRoot -> canonicalPath -> snapshot`.
 *
 * RATIONALE (cross-agent read-before-write): the per-session map above is
 * keyed by the `__agencSessionId` arg, but two dispatch paths inject
 * DIFFERENT ids for the same logical conversation — the canonical tool
 * surface injects the main-process session id, while spawned subagents
 * inject their own agent/conversation id (run-agent.ts
 * `injectChildToolArgs`). A FULL `FileRead` recorded under one id was
 * therefore invisible to an `Edit`/`Write` gate checking under the other,
 * surfacing as a spurious READ_BEFORE_WRITE_ERROR immediately after a
 * successful read.
 *
 * This mirror lets the gate fall back to "has ANY agent in this same
 * workspace performed a full read of this exact canonical path?". It does
 * NOT weaken the gate to "no read needed": a full read must still exist
 * somewhere, and only full (non-partial) snapshots are mirrored, so
 * partial offset/limit reads never authorize an edit via the fallback.
 */
const workspaceReadState = new Map<string, Map<string, SessionReadSnapshot>>();

const LOCAL_FILE_HISTORY_MAX_ENTRIES = 8;

// OOM fix: `sessionReadState` / `workspaceReadState` retain the full file
// `content` + `rawContent` (KB–MB each) for every unique path read in a
// session. In a long-lived `agenc --yolo` run touching thousands of files this
// grew without bound. The read-before-write GATE only needs the tiny presence +
// view-kind metadata, and the per-turn changed-files producer only needs
// `rawContent` for recently-read files — so cap the retained large-field bytes
// and strip `content`/`rawContent` from the OLDEST entries (keeping their gate
// metadata in memory) once the budget is exceeded. The full content remains
// reloadable from the persisted per-file local history or a fresh disk read.
const DEFAULT_MAX_SESSION_READ_CONTENT_BYTES = 25 * 1024 * 1024;

function sessionReadContentBudget(): number {
  const raw = Number(process.env.AGENC_MAX_SESSION_READ_CONTENT_BYTES);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_MAX_SESSION_READ_CONTENT_BYTES;
}

function sessionReadContentBytes(snapshot: SessionReadSnapshot): number {
  return (
    (typeof snapshot.content === "string" ? snapshot.content.length : 0) +
    (typeof snapshot.rawContent === "string" ? snapshot.rawContent.length : 0)
  );
}

function stripSessionReadLargeFields(
  snapshot: SessionReadSnapshot,
): SessionReadSnapshot {
  if (snapshot.content === undefined && snapshot.rawContent === undefined) {
    return snapshot;
  }
  const { content: _content, rawContent: _rawContent, ...metadata } = snapshot;
  return metadata;
}

/**
 * Bound the retained large-field bytes of an in-memory read map by stripping
 * `content`/`rawContent` from the oldest entries (Map iteration is insertion
 * order, so the front is oldest) while preserving each entry's gate metadata.
 * Stripping is non-destructive to the read-before-write gate (which only reads
 * presence + `isPartialView`) and only degrades the optional changed-files diff
 * / range-dedup for the evicted (older) paths.
 */
function boundSessionReadContent(
  fileMap: Map<string, SessionReadSnapshot>,
): void {
  const budget = sessionReadContentBudget();
  let total = 0;
  for (const snapshot of fileMap.values()) {
    total += sessionReadContentBytes(snapshot);
  }
  if (total <= budget) return;
  for (const [path, snapshot] of fileMap) {
    if (total <= budget) break;
    const bytes = sessionReadContentBytes(snapshot);
    if (bytes === 0) continue;
    fileMap.set(path, stripSessionReadLargeFields(snapshot));
    total -= bytes;
  }
}

/**
 * Resolve the workspace root used to key {@link workspaceReadState}. This
 * is the process-global session workspace root (env `AGENC_WORKSPACE`,
 * falling back to `process.cwd()`), which is shared by the canonical tool
 * surface and all subagents running inside the same daemon process — the
 * correct scope for the cross-agent fallback.
 */
function resolveWorkspaceReadScopeRoot(): string {
  try {
    return resolve(resolveSessionWorkspaceRoot()).normalize("NFC");
  } catch {
    return resolveSessionWorkspaceRoot();
  }
}

/**
 * Mirror a recorded read into the workspace-scoped index. Any REAL read
 * (full or partial offset/limit window) is mirrored so the cross-agent
 * fallback authorizes an edit whenever the path was actually read by some
 * agent. Only SYNTHETIC partial views (`isPartialView === true`), which
 * never reflected disk bytes the model chose to read, are excluded — this
 * matches the read-before-write predicate in {@link hasSessionRead}.
 */
function mirrorWorkspaceRead(
  canonicalPath: string,
  snapshot: SessionReadSnapshot,
): void {
  if (snapshot.isPartialView === true) {
    return;
  }
  const workspaceRoot = resolveWorkspaceReadScopeRoot();
  let fileMap = workspaceReadState.get(workspaceRoot);
  if (!fileMap) {
    fileMap = new Map();
    workspaceReadState.set(workspaceRoot, fileMap);
  }
  fileMap.set(canonicalPath, snapshot);
  boundSessionReadContent(fileMap);
}

/**
 * Look up a real read of `canonicalPath` recorded by ANY agent within the
 * current workspace root. A full OR partial offset/limit read authorizes
 * the cross-agent edit fallback; only synthetic partial views
 * (`isPartialView === true`) and an absent read return undefined, matching
 * the {@link hasSessionRead} predicate.
 */
function getWorkspaceReadSnapshot(
  canonicalPath: string,
): SessionReadSnapshot | undefined {
  if (!canonicalPath || canonicalPath.trim().length === 0) return undefined;
  const snapshot = workspaceReadState
    .get(resolveWorkspaceReadScopeRoot())
    ?.get(canonicalPath);
  if (!snapshot) return undefined;
  if (snapshot.isPartialView === true) {
    return undefined;
  }
  return snapshot;
}

function resolveLocalFileHistoryRoot(): string {
  const configuredRoot = process.env.AGENC_FILESYSTEM_HISTORY_ROOT?.trim();
  return configuredRoot && configuredRoot.length > 0
    ? configuredRoot
    : join(tmpdir(), "agenc", "filesystem-history");
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveLocalHistorySessionDir(sessionId: string): string {
  return join(resolveLocalFileHistoryRoot(), hashString(sessionId));
}

function resolveLocalHistoryFilePath(
  sessionId: string,
  canonicalPath: string,
): string {
  return join(resolveLocalHistorySessionDir(sessionId), `${hashString(canonicalPath)}.json`);
}

function persistLocalFileHistorySnapshot(
  sessionId: string | undefined,
  canonicalPath: string,
  snapshot: SessionReadSnapshot,
): void {
  if (!sessionId || sessionId.trim().length === 0) return;
  try {
    const historyFile = resolveLocalHistoryFilePath(sessionId, canonicalPath);
    mkdirSync(dirname(historyFile), { recursive: true });

    let entries: Array<SessionReadSnapshot & { readonly recordedAt: number }> = [];
    try {
      const raw = readFileSync(historyFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        entries = parsed.filter(
          (entry): entry is SessionReadSnapshot & { readonly recordedAt: number } => {
            if (typeof entry !== "object" || entry === null) return false;
            if (
              typeof (entry as { recordedAt?: unknown }).recordedAt !== "number"
            ) {
              return false;
            }
            const content = (entry as { content?: unknown }).content;
            return typeof content === "string" || content === null;
          },
        );
      }
    } catch {
      // Best effort only. Missing or corrupt local history should not block writes.
    }

    entries.push({
      content: snapshot.content ?? null,
      timestamp: snapshot.timestamp,
      viewKind: snapshot.viewKind ?? "legacy_unknown",
      ...(snapshot.isPartialView === true ? { isPartialView: true } : {}),
      recordedAt: Date.now(),
    });
    if (entries.length > LOCAL_FILE_HISTORY_MAX_ENTRIES) {
      entries = entries.slice(-LOCAL_FILE_HISTORY_MAX_ENTRIES);
    }
    writeFileSync(historyFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  } catch {
    // Best effort only. Local history is an ergonomics aid, not part of the tool contract.
  }
}

function loadPersistedSessionReadSnapshot(
  sessionId: string,
  canonicalPath: string,
): SessionReadSnapshot | undefined {
  try {
    const historyFile = resolveLocalHistoryFilePath(sessionId, canonicalPath);
    const raw = readFileSync(historyFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return undefined;
    }

    for (let index = parsed.length - 1; index >= 0; index--) {
      const entry = parsed[index];
      if (typeof entry !== "object" || entry === null) continue;
      const content = (entry as { content?: unknown }).content;
      const viewKind = (entry as { viewKind?: unknown }).viewKind;
      const isPartialView =
        (entry as { isPartialView?: unknown }).isPartialView === true;
      const timestampValue = (entry as { timestamp?: unknown }).timestamp;
      const recordedAtValue = (entry as { recordedAt?: unknown }).recordedAt;
      const timestamp =
        typeof timestampValue === "number" && Number.isFinite(timestampValue)
          ? timestampValue
          : typeof recordedAtValue === "number" && Number.isFinite(recordedAtValue)
            ? recordedAtValue
            : undefined;
      if (typeof content === "string") {
        return {
          ...(timestamp === undefined ? { content } : { content, timestamp }),
          viewKind:
            viewKind === "full" ||
            viewKind === "partial" ||
            viewKind === "legacy_unknown"
              ? viewKind
              : "legacy_unknown",
          ...(isPartialView ? { isPartialView: true } : {}),
        };
      }
      if (content === null) {
        return {
          ...(timestamp === undefined
            ? { content: null }
            : { content: null, timestamp }),
          viewKind:
            viewKind === "full" ||
            viewKind === "partial" ||
            viewKind === "legacy_unknown"
              ? viewKind
              : "legacy_unknown",
          ...(isPartialView ? { isPartialView: true } : {}),
        };
      }
    }
  } catch {
    // Best effort only. Missing or corrupt local history should not block rehydration.
  }
  return undefined;
}

function rehydrateSessionReadSnapshot(
  sessionId: string | undefined,
  canonicalPath: string,
): SessionReadSnapshot | undefined {
  if (!sessionId || sessionId.trim().length === 0) {
    // Even without a session id, a full read recorded by ANY agent in
    // this workspace satisfies the read-before-write gate (cross-agent
    // fallback). Partial reads are excluded by getWorkspaceReadSnapshot.
    return getWorkspaceReadSnapshot(canonicalPath);
  }

  const existingSnapshot = sessionReadState.get(sessionId)?.get(canonicalPath);
  if (existingSnapshot) {
    return existingSnapshot;
  }

  const persistedSnapshot = loadPersistedSessionReadSnapshot(sessionId, canonicalPath);
  if (!persistedSnapshot) {
    // No agent-scoped snapshot for this (sessionId, path). Fall back to a
    // workspace-scoped full read recorded by a sibling agent under a
    // different `__agencSessionId` for the SAME canonical path. This is
    // what makes a `FileRead` issued via one dispatch path (e.g. the
    // canonical surface) authorize an `Edit` checked under another (e.g.
    // a spawned subagent's conversation id). The gate stays closed when
    // nobody has read the path: getWorkspaceReadSnapshot returns
    // undefined in that case.
    return getWorkspaceReadSnapshot(canonicalPath);
  }

  let fileMap = sessionReadState.get(sessionId);
  if (!fileMap) {
    fileMap = new Map();
    sessionReadState.set(sessionId, fileMap);
  }
  fileMap.set(canonicalPath, persistedSnapshot);
  boundSessionReadContent(fileMap);
  return persistedSnapshot;
}

export function recordSessionRead(
  sessionId: string | undefined,
  canonicalPath: string,
  snapshot?: SessionReadSnapshot,
): void {
  if (!sessionId || sessionId.trim().length === 0) return;
  if (!canonicalPath || canonicalPath.trim().length === 0) return;
  let fileMap = sessionReadState.get(sessionId);
  if (!fileMap) {
    fileMap = new Map();
    sessionReadState.set(sessionId, fileMap);
  }
  const previous = fileMap.get(canonicalPath);
  const nextSnapshot = snapshot
    ? {
        ...(previous ?? {}),
        ...snapshot,
      }
    : { viewKind: "full" as SessionReadViewKind };
  if (nextSnapshot.viewKind === undefined) {
    nextSnapshot.viewKind =
      snapshot?.viewKind ?? "full";
  }
  fileMap.set(canonicalPath, nextSnapshot);
  boundSessionReadContent(fileMap);
  mirrorWorkspaceRead(canonicalPath, nextSnapshot);
  persistLocalFileHistorySnapshot(sessionId, canonicalPath, nextSnapshot);
}

export function seedSessionReadState(
  sessionId: string | undefined,
  entries: readonly SessionReadSeedEntry[],
): void {
  if (!sessionId || sessionId.trim().length === 0) return;
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.trim().length === 0) {
      continue;
    }
    recordSessionRead(sessionId, entry.path, {
      ...(entry.content === undefined ? {} : { content: entry.content }),
      ...(typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
        ? { timestamp: entry.timestamp }
        : {}),
      viewKind: entry.viewKind ?? "legacy_unknown",
      ...(entry.isPartialView === true ? { isPartialView: true } : {}),
      ...(typeof entry.readOffset === "number" && Number.isFinite(entry.readOffset)
        ? { readOffset: entry.readOffset }
        : {}),
      ...(typeof entry.readLimit === "number" && Number.isFinite(entry.readLimit)
        ? { readLimit: entry.readLimit }
        : {}),
      ...(entry.rawContent === undefined ? {} : { rawContent: entry.rawContent }),
    });
  }
}

export function hasSessionRead(
  sessionId: string | undefined,
  canonicalPath: string,
): boolean {
  const snapshot = rehydrateSessionReadSnapshot(sessionId, canonicalPath);
  return snapshot !== undefined && snapshot.isPartialView !== true;
}

export function getSessionReadSnapshot(
  sessionId: string | undefined,
  canonicalPath: string,
): SessionReadSnapshot | undefined {
  return rehydrateSessionReadSnapshot(sessionId, canonicalPath);
}

/**
 * Iterate all in-memory session-read snapshots for the given session.
 *
 * Used by the per-turn changed-files attachment producer
 * (`runtime/src/prompts/attachments/changed-files.ts`) to walk every
 * file the model has read this session and emit diff snippets for any
 * that have been mutated since the last read.
 *
 * Iterates only the in-memory `sessionReadState` map; persisted local
 * history snapshots are intentionally not enumerated — they are loaded
 * lazily on demand via {@link getSessionReadSnapshot}. The producer
 * iterates the live read set, which is the AgenC
 * `cacheKeys(toolUseContext.readFileState)` parity surface.
 */
export function forEachSessionRead(
  sessionId: string | undefined,
  fn: (canonicalPath: string, snapshot: SessionReadSnapshot) => void,
): void {
  if (!sessionId || sessionId.trim().length === 0) return;
  const fileMap = sessionReadState.get(sessionId);
  if (!fileMap) return;
  for (const [path, snapshot] of fileMap) {
    fn(path, snapshot);
  }
}

/** Drop a single file's recorded snapshot. Used on ENOENT eviction. */
export function dropSessionReadSnapshot(
  sessionId: string | undefined,
  canonicalPath: string,
): void {
  if (!sessionId || sessionId.trim().length === 0) return;
  const fileMap = sessionReadState.get(sessionId);
  if (!fileMap) return;
  fileMap.delete(canonicalPath);
}

/**
 * Clear all recorded reads for a session. Called from the gateway when
 * a session is closed so the map does not grow without bound on
 * long-running daemons.
 */
export function clearSessionReadState(sessionId: string): void {
  sessionReadState.delete(sessionId);
  try {
    rmSync(resolveLocalHistorySessionDir(sessionId), {
      recursive: true,
      force: true,
    });
  } catch {
    // Best effort cleanup.
  }
}

/**
 * Clear only the in-memory read cache for a session. The persisted local
 * history snapshot remains available for transcript/compaction rehydration.
 */
export function clearSessionReadCache(sessionId: string): void {
  sessionReadState.delete(sessionId);
}

export interface SessionReadSnapshotExport {
  readonly path: string;
  readonly content: string;
  readonly timestamp: number;
  readonly viewKind?: SessionReadViewKind;
  readonly isPartialView?: boolean;
}

/**
 * Return the top-N most-recently-read file snapshots for a session,
 * truncated to fit a total character budget with a per-file cap.
 * Entries without content (unknown timestamp or null content) are
 * skipped. The caller typically uses this right before
 * `clearSessionReadCache` during compaction, then re-injects the
 * returned content back into the prompt as anchor messages — matching
 * the reference runtime's compact-and-re-attach pattern.
 */
export function snapshotTopRecentReads(params: {
  readonly sessionId: string;
  readonly maxFiles: number;
  readonly perFileBudgetChars: number;
  readonly totalBudgetChars: number;
}): readonly SessionReadSnapshotExport[] {
  const { sessionId, maxFiles, perFileBudgetChars, totalBudgetChars } = params;
  if (maxFiles <= 0 || perFileBudgetChars <= 0 || totalBudgetChars <= 0) {
    return [];
  }
  const fileMap = sessionReadState.get(sessionId);
  if (!fileMap || fileMap.size === 0) {
    return [];
  }
  const entries: SessionReadSnapshotExport[] = [];
  for (const [path, snapshot] of fileMap) {
    if (
      typeof snapshot.content !== "string" ||
      snapshot.content.length === 0 ||
      typeof snapshot.timestamp !== "number" ||
      !Number.isFinite(snapshot.timestamp)
    ) {
      continue;
    }
    entries.push({
      path,
      content: snapshot.content,
      timestamp: snapshot.timestamp,
      ...(snapshot.viewKind ? { viewKind: snapshot.viewKind } : {}),
      ...(snapshot.isPartialView === true ? { isPartialView: true } : {}),
    });
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  const kept: SessionReadSnapshotExport[] = [];
  let usedChars = 0;
  for (const entry of entries) {
    if (kept.length >= maxFiles) break;
    const slice = entry.content.length > perFileBudgetChars
      ? entry.content.slice(0, perFileBudgetChars)
      : entry.content;
    if (usedChars + slice.length > totalBudgetChars) {
      continue;
    }
    kept.push({ ...entry, content: slice });
    usedChars += slice.length;
  }
  return kept;
}

/**
 * Resolve the session ID from tool args (injected by the gateway via
 * `applySessionId`). Returns `undefined` when no session ID is present
 * — that signals "tool was called outside a chat session" (e.g. eval
 * harness, direct unit test) and mutation guards fail closed unless the
 * caller has seeded a session id into the tool args.
 */
export function resolveSessionId(args: Record<string, unknown>): string | undefined {
  return nonEmptyString(args[SESSION_ID_ARG]);
}

/**
 * Filesystem tool configuration.
 *
 * **Security note:** This sandbox is path-based and does NOT protect against:
 * - TOCTOU races from concurrent filesystem access on the same host
 * - Hard-link escapes (in-sandbox hard link to out-of-sandbox inode)
 * For adversarial environments, use OS-level sandboxing (chroot, namespaces).
 *
 */
export interface FilesystemToolConfig {
  /** Allowed path prefixes (required — no default to force explicit opt-in). */
  readonly allowedPaths: readonly string[];
  /** Whether delete operations are allowed (default: false). */
  readonly allowDelete?: boolean;
}

/** Return a JSON error ToolResult without throwing. */
function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

/** Format error for fallback catch without leaking resolved internal paths. */
function safeError(err: unknown, operation: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code ? `${code}: ${operation} failed` : `${operation} failed`;
}

/** Check if any path segment is exactly `..` or contains URL-encoded separators/nulls. */
function hasTraversalSegment(rawPath: string): boolean {
  // Defence-in-depth: reject URL-encoded path separators and null bytes
  if (/%2f/i.test(rawPath) || /%5c/i.test(rawPath) || /%00/i.test(rawPath)) {
    return true;
  }
  return rawPath.split(/[/\\]+/).some((seg) => seg === "..");
}

function expandHomeDirectory(rawPath: string): string {
  if (rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home || home.trim().length === 0) return rawPath;
    if (rawPath === "~") return home;
    return resolve(home, rawPath.slice(2));
  }
  return rawPath;
}

/**
 * Resolve a path to its canonical form, following symlinks.
 * For non-existent targets (write/mkdir destinations), walks up ancestors
 * until it finds one that exists, canonicalizes it, then recomposes
 * the remaining segments.
 */
export async function canonicalizePath(targetPath: string): Promise<string> {
  return canonicalize(targetPath);
}

async function canonicalize(targetPath: string): Promise<string> {
  const abs = resolve(targetPath);
  try {
    return await realpath(abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw e;
    // Walk up ancestors until we find one that exists
    const segments: string[] = [];
    let current = abs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      segments.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        // Reached filesystem root — nothing resolved, return as-is
        return abs;
      }
      current = parent;
      try {
        const parentReal = await realpath(current);
        return resolve(parentReal, ...segments);
      } catch (parentErr) {
        const pe = parentErr as NodeJS.ErrnoException;
        if (pe.code !== "ENOENT") throw pe;
        // Keep walking up
      }
    }
  }
}


/**
 * Resolve a path and check for traversal attacks.
 *
 * Defence-in-depth:
 * 1. Reject null bytes
 * 2. Reject raw `..` segments before resolution (segment-aware)
 * 3. Canonicalize via realpath to follow symlinks
 * 4. Verify canonical path is within an allowed prefix
 */
export async function safePath(
  targetPath: string,
  allowedPaths: readonly string[],
): Promise<{ safe: boolean; resolved: string; reason?: string }> {
  try {
    if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
      return {
        safe: false,
        resolved: "",
        reason: "Path must be a non-empty string",
      };
    }

    // Reject null bytes (resolve() throws on these — catch proactively)
    if (targetPath.includes("\0")) {
      return { safe: false, resolved: "", reason: "Path contains null byte" };
    }

    const normalizedTarget = expandHomeDirectory(targetPath);

    // Defence-in-depth: reject explicit traversal segments before resolution
    if (hasTraversalSegment(normalizedTarget)) {
      return { safe: false, resolved: "", reason: "Path traversal detected" };
    }

    // Reject excessively long paths (OS-level PATH_MAX)
    if (resolve(normalizedTarget).length > MAX_PATH_LENGTH) {
      return {
        safe: false,
        resolved: "",
        reason: "Path exceeds maximum length",
      };
    }

    // Canonicalize target (follows symlinks, normalize Unicode for macOS HFS+/APFS)
    const canonical = (await canonicalize(normalizedTarget)).normalize("NFC");

    // Verify canonical path is within an allowed prefix
    if (allowedPaths.length === 0) {
      return {
        safe: false,
        resolved: "",
        reason: "No allowed paths configured",
      };
    }
    const normalizedAllowed = await Promise.all(
      allowedPaths.map(async (p) =>
        (await canonicalize(expandHomeDirectory(p))).normalize("NFC"),
      ),
    );
    const inside = normalizedAllowed.some(
      (prefix) =>
        canonical === prefix ||
        canonical.startsWith(prefix + "/") ||
        canonical.startsWith(prefix + "\\"),
    );
    if (!inside) {
      return {
        safe: false,
        resolved: "",
        reason: "Path is outside allowed directories",
      };
    }

    return { safe: true, resolved: canonical };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      safe: false,
      resolved: "",
      reason: code ? `Invalid path (${code})` : "Invalid path",
    };
  }
}

/**
 * Check if a path is within allowed directories.
 * Convenience wrapper around {@link safePath}.
 */
export async function isPathAllowed(
  targetPath: string,
  allowedPaths: readonly string[],
): Promise<boolean> {
  return (await safePath(targetPath, allowedPaths)).safe;
}

/**
 * Fold runtime-injected extra workspace roots into the trusted base
 * {@link allowedPaths}.
 *
 * SECURITY INVARIANT (sink-side HMAC enforcement): widening filesystem
 * confinement via `args[SESSION_ALLOWED_ROOTS_ARG]` requires a VALID
 * per-process HMAC signature in `args[SESSION_ALLOWED_ROOTS_SIG_ARG]`.
 * The sink no longer trusts the bare key: it folds in roots ONLY via
 * {@link verifyAllowedRoots}, which recomputes the signature with the
 * module-private process secret the model never sees and drops anything
 * that doesn't verify. Runtime writers produce the signature through
 * {@link withSignedAllowedRoots}; the model cannot forge it. The
 * model-arg boundary strips at the tool-dispatch boundary
 * (`router.ts` / `run-agent.ts:injectChildToolArgs`) remain as
 * defense-in-depth, but enforcement now lives HERE — a future ingress
 * that forgets to strip cannot reintroduce the sandbox escape, because
 * an unsigned/forged root is ignored at this sink.
 */
export function resolveToolAllowedPaths(
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): readonly string[] {
  const verifiedRoots = verifyAllowedRoots(
    args[SESSION_ALLOWED_ROOTS_ARG],
    args[SESSION_ALLOWED_ROOTS_SIG_ARG],
  );
  if (verifiedRoots.length === 0) {
    return allowedPaths;
  }
  const normalizedExtraRoots = verifiedRoots
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    )
    .map((entry) => resolveSessionWorkspaceRoot(entry))
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => resolve(entry).normalize("NFC"));
  if (normalizedExtraRoots.length === 0) {
    return allowedPaths;
  }
  return Array.from(new Set([...allowedPaths, ...normalizedExtraRoots]));
}

/** Validate and resolve a path argument from tool input. */
/**
 * Build the optional plan-file context from injected tool args. Returns
 * null when the dispatcher didn't plumb `__agencSessionId` (e.g.,
 * headless tests, embedded contexts), in which case the plan-file
 * carve-out below is a no-op.
 */
function planFileContextFromArgs(
  args: Record<string, unknown> | undefined,
): PlanFileContext | null {
  if (!args) return null;
  // SECURITY: honor the session id (which unlocks the plan-file carve-out
  // OUTSIDE the workspace allowlist) ONLY when it carries a valid
  // per-process HMAC signature. An unsigned/forged id verifies as absent,
  // so a model cannot forge a write target. Mirrors the sink in
  // `coding-common.ts:planFileContextFromArgs`.
  const verified = verifySessionId(
    args[SESSION_ID_ARG],
    args[SESSION_ID_SIG_ARG],
  );
  const sessionId =
    typeof verified === "string" && verified.trim().length > 0
      ? verified
      : null;
  if (sessionId === null) return null;
  const ctx: PlanFileContext = { sessionId };
  const injectedAgencHome = args[SESSION_AGENC_HOME_ARG];
  if (
    typeof injectedAgencHome === "string" &&
    injectedAgencHome.trim().length > 0
  ) {
    return { ...ctx, agencHome: injectedAgencHome };
  }
  if (
    typeof process.env.AGENC_HOME === "string" &&
    process.env.AGENC_HOME.length > 0
  ) {
    return { ...ctx, agencHome: process.env.AGENC_HOME };
  }
  return ctx;
}

export async function safePathAllowingSessionPlanFile(
  targetPath: string,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<{ safe: boolean; resolved: string; reason?: string }> {
  const result = await safePath(targetPath, resolveToolAllowedPaths(allowedPaths, args));
  if (result.safe) return result;

  const planCtx = planFileContextFromArgs(args);
  if (planCtx !== null && !hasUnsafeShape(targetPath)) {
    try {
      const canonical = (await canonicalize(targetPath)).normalize("NFC");
      if (isSessionPlanFile(canonical, planCtx)) {
        return { safe: true, resolved: canonical };
      }
    } catch {
      // canonicalize threw — fall through to the original rejection.
    }
  }
  return result;
}

async function validatePath(
  input: unknown,
  allowedPaths: readonly string[],
  paramName = "path",
  args?: Record<string, unknown>,
): Promise<[string | null, ToolResult | null]> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return [null, errorResult(`${paramName} must be a non-empty string`)];
  }
  const result = await safePath(
    input,
    args ? resolveToolAllowedPaths(allowedPaths, args) : allowedPaths,
  );
  if (result.safe) return [result.resolved, null];

  // Plan-file allowlist (AgenC behavior, filesystem.ts:1488-1506).
  // When the rejection is for a path outside the workspace allowlist
  // and the target is the active session's plan file, allow it. Same
  // shape as AgenC's `checkEditableInternalPath`: mode-agnostic,
  // bypasses workspace allowlist, retains all other safety checks
  // (null bytes, traversal, length — those rejected upstream of here).
  const planCtx = planFileContextFromArgs(args);
  if (planCtx !== null && !hasUnsafeShape(input)) {
    try {
      const canonical = (await canonicalize(input)).normalize("NFC");
      if (isSessionPlanFile(canonical, planCtx)) {
        return [canonical, null];
      }
    } catch {
      // canonicalize threw — fall through to the original rejection.
    }
  }
  return [null, errorResult(`Access denied: ${result.reason}`)];
}

/**
 * Cheap pre-canonicalize sanity check that mirrors the early
 * `safePath` rejections (null bytes, traversal segments, length cap)
 * so we don't relax those defences under the plan-file carve-out.
 */
function hasUnsafeShape(rawPath: string): boolean {
  if (rawPath.includes("\0")) return true;
  if (hasTraversalSegment(rawPath)) return true;
  if (resolve(rawPath).length > MAX_PATH_LENGTH) return true;
  return false;
}

// ============================================================================
// Tool Factories
// ============================================================================
function createListDirTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.listDir",
    description:
      "List directory contents. Returns entry names, types (file/dir), and sizes. Gated by path allowlist.",
    metadata: { mutating: false },
    isReadOnly: true,
    requiresApproval: false,
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative directory path",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(
          args.path,
          allowedPaths,
          "path",
          args,
        );
        if (pathErr) return pathErr;

        const dir = await opendir(resolved!);
        const entries: { name: string; type: string; size: number }[] = [];
        let truncated = false;
        try {
          for await (const d of dir) {
            if (entries.length >= MAX_LIST_ENTRIES) {
              truncated = true;
              break;
            }
            const entryPath = resolve(resolved!, d.name);
            let size = 0;
            if (d.isFile()) {
              try {
                const s = await lstat(entryPath);
                size = s.size;
              } catch {
                // lstat may fail for race conditions; skip size
              }
            }
            const type = d.isDirectory()
              ? "dir"
              : d.isFile()
                ? "file"
                : d.isSymbolicLink()
                  ? "symlink"
                  : "other";
            entries.push({ name: d.name, type, size });
          }
        } finally {
          try {
            await dir.close();
          } catch (error) {
            const code =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof (error as { code?: unknown }).code === "string"
                ? (error as { code: string }).code
                : "";
            if (code !== "ERR_DIR_CLOSED") {
              // Best-effort close; list result is already computed.
              // Keep unexpected close failures visible for diagnosing leaks.
              console.warn(`[system.listDir] ${safeError(error, "close")}`);
            }
          }
        }
        return {
          content: safeStringify({
            path: args.path,
            entries,
            ...(truncated ? { truncated: true } : {}),
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`Directory not found: ${args.path}`);
        if (msg.includes("ENOTDIR"))
          return errorResult(`Not a directory: ${args.path}`);
        return errorResult(safeError(err, "list"));
      }
    },
  };
}

function createStatTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.stat",
    description:
      "Get file or directory metadata including size, timestamps, and type. Gated by path allowlist.",
    metadata: { mutating: false },
    isReadOnly: true,
    requiresApproval: false,
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to stat",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(
          args.path,
          allowedPaths,
          "path",
          args,
        );
        if (pathErr) return pathErr;

        const s = await stat(resolved!);
        return {
          content: safeStringify({
            path: args.path,
            size: s.size,
            modified: s.mtime.toISOString(),
            created: s.birthtime.toISOString(),
            isDirectory: s.isDirectory(),
            isFile: s.isFile(),
            permissions: `0${(s.mode & 0o777).toString(8)}`,
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`Path not found: ${args.path}`);
        return errorResult(safeError(err, "stat"));
      }
    },
  };
}

function createMkdirTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.mkdir",
    description:
      "Create a directory. Creates parent directories as needed. Gated by path allowlist.",
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative directory path to create",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(
          args.path,
          allowedPaths,
          "path",
          args,
        );
        if (pathErr) return pathErr;

        await mkdir(resolved!, { recursive: true });
        return {
          content: safeStringify({ path: args.path, created: true }),
        };
      } catch (err) {
        return errorResult(safeError(err, "mkdir"));
      }
    },
  };
}

function createDeleteTool(
  allowedPaths: readonly string[],
  allowDelete: boolean,
): Tool {
  return {
    name: "system.delete",
    description:
      "Delete a file or directory. Requires explicit opt-in via allowDelete config. Gated by path allowlist.",
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to delete",
        },
        recursive: {
          type: "boolean",
          description: "Required to delete directories. Defaults to false.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        // Validate path first — don't leak path validity via allowDelete check order
        const [resolved, pathErr] = await validatePath(
          args.path,
          allowedPaths,
          "path",
          args,
        );
        if (pathErr) return pathErr;

        if (!allowDelete) {
          return errorResult(
            "Delete operations are disabled. Set allowDelete: true in config.",
          );
        }

        // Prevent deletion of sandbox root directories
        for (const allowed of resolveToolAllowedPaths(allowedPaths, args)) {
          let canonicalAllowed: string;
          try {
            canonicalAllowed = (await realpath(allowed)).normalize("NFC");
          } catch {
            canonicalAllowed = allowed.normalize("NFC");
          }
          if (resolved === canonicalAllowed) {
            return errorResult("Cannot delete sandbox root directory");
          }
        }

        // Check if target is a directory — require explicit recursive opt-in
        const targetStat = await stat(resolved!);
        if (targetStat.isDirectory() && args.recursive !== true) {
          return errorResult("Cannot delete directory without recursive: true");
        }

        await rm(resolved!, { recursive: args.recursive === true });
        return {
          content: safeStringify({ path: args.path, deleted: true }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`Path not found: ${args.path}`);
        return errorResult(safeError(err, "delete"));
      }
    },
  };
}

function createMoveTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.move",
    description:
      "Move or rename a file or directory. Both source and destination must be within allowed paths.",
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source path",
        },
        destination: {
          type: "string",
          description: "Destination path",
        },
      },
      required: ["source", "destination"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [src, srcErr] = await validatePath(
          args.source,
          allowedPaths,
          "source",
          args,
        );
        if (srcErr) return srcErr;

        const [dst, dstErr] = await validatePath(
          args.destination,
          allowedPaths,
          "destination",
          args,
        );
        if (dstErr) return dstErr;

        await mkdir(dirname(dst!), { recursive: true });
        await rename(src!, dst!);
        return {
          content: safeStringify({
            source: args.source,
            destination: args.destination,
            moved: true,
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`Source not found: ${args.source}`);
        return errorResult(safeError(err, "move"));
      }
    },
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create filesystem utility tools.
 *
 * @param config - Filesystem tool configuration with allowed paths and limits
 * @returns Array of Tool instances
 *
 * @example
 * ```typescript
 * const tools = createFilesystemTools({
 *   allowedPaths: ['~/.agenc/workspace/'],
 *   allowDelete: false,
 * });
 * registry.registerAll(tools);
 * ```
 */
export function createFilesystemTools(config: FilesystemToolConfig): Tool[] {
  // ── Config validation (Finding 1 + 2) ──────────────────────────────────
  if (!Array.isArray(config.allowedPaths) || config.allowedPaths.length === 0) {
    throw new TypeError("allowedPaths must be a non-empty array of strings");
  }
  for (const p of config.allowedPaths) {
    if (typeof p !== "string" || p.trim().length === 0) {
      throw new TypeError(
        `Each allowedPaths entry must be a non-empty string, got: ${typeof p}`,
      );
    }
  }
  const allowedPaths = config.allowedPaths.map((p) =>
    resolve(p).normalize("NFC"),
  );

  const allowDelete = config.allowDelete ?? false;
  if (allowDelete !== true && allowDelete !== false) {
    throw new TypeError(
      `allowDelete must be a boolean, got: ${typeof allowDelete}`,
    );
  }

  return [
    createListDirTool(allowedPaths),
    createStatTool(allowedPaths),
    createMkdirTool(allowedPaths),
    createDeleteTool(allowedPaths, allowDelete),
    createMoveTool(allowedPaths),
  ];
}

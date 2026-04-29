/**
 * Filesystem tools for @tetsuo-ai/runtime
 *
 * Provides 9 tools for reading, writing, editing, listing, and managing
 * files on the host system. All operations are gated by configurable
 * path allowlists with path traversal prevention and size limits.
 *
 * Tools:
 * - system.readFile — read file contents (text or base64)
 * - system.writeFile — write/overwrite a full file (creates parent dirs)
 * - system.appendFile — append to file
 * - system.editFile — string-replace edit on an existing file
 *                     (old_string/new_string semantics; preferred over
 *                      writeFile for incremental edits to avoid
 *                      JSON-escape bugs in nested string literals)
 * - system.listDir — list directory entries
 * - system.stat — file/directory metadata
 * - system.mkdir — create directories
 * - system.delete — delete file/directory (requires opt-in)
 * - system.move — rename/move file or directory
 *
 * Read-before-Write rule:
 * `system.writeFile` and `system.editFile` enforce that the model has
 * called `system.readFile` on the target path in the current session
 * before any modification. This forces the model to have the LITERAL
 * pre-edit bytes in its context before generating the next write,
 * which is the highest-leverage structural defense against the Grok
 * JSON-escape bug. The rule is skipped for non-existent files
 * (creating new files does not require a prior read) and can be
 * rehydrated from the persisted local history cache after compaction
 * or restart.
 *
 * @module
 */

import {
  createHash,
} from "node:crypto";
import {
  readFile,
  writeFile,
  appendFile,
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
import { resolveSessionWorkspaceRoot } from "../../gateway/host-workspace.js";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { normalizeOverescapedToolText } from "../../utils/overescaped-text.js";

const DEFAULT_MAX_READ_BYTES = 10_485_760; // 10 MB
const DEFAULT_MAX_WRITE_BYTES = 10_485_760; // 10 MB
const MAX_LIST_ENTRIES = 10_000;
const MAX_PATH_LENGTH = 4096;
export const SESSION_ALLOWED_ROOTS_ARG = "__agencSessionAllowedRoots";
export type SessionReadViewKind =
  | "full"
  | "partial"
  | "legacy_unknown";

/**
 * Per-session arg name carrying the session identifier into filesystem
 * tool calls. The gateway's `applySessionId` injector adds this to
 * `system.readFile`, `system.writeFile`, `system.appendFile`, and
 * `system.editFile` args before invoking the tool, and
 * `stripInternalToolArgs` removes it before any user-visible
 * serialization.
 *
 * The constant is named to mirror {@link SESSION_ALLOWED_ROOTS_ARG} so
 * the convention for "internal arg with double-underscore prefix" stays
 * uniform across the filesystem tool surface.
 */
export const SESSION_ID_ARG = "__agencSessionId";

/**
 * Per-session readFileState map. Tracks which files have been read in
 * each session so that `system.writeFile` and `system.editFile` can
 * enforce a Read-before-Write rule.
 *
 * The rationale is documented in detail in PR #314: forcing the model
 * to call `system.readFile` before any modification is the highest-
 * leverage structural defense against the JSON-escape bug Grok exhibits
 * when re-writing C source files via `system.writeFile`. The model
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
 *   - `system.writeFile` and `system.editFile` consult this map only
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
interface SessionReadSnapshot {
  readonly content?: string | null;
  readonly timestamp?: number;
  readonly viewKind?: SessionReadViewKind;
  /**
   * For partial reads (`viewKind === "partial"`), the exact line offset
   * the model passed. Stored so a subsequent read with the identical
   * `(offset, limit)` and unchanged mtime can serve from the cache stub
   * via range-aware FILE_UNCHANGED dedup.
   */
  readonly readOffset?: number;
  /** For partial reads, the exact line limit the model passed. */
  readonly readLimit?: number;
}

export interface SessionReadSeedEntry {
  readonly path: string;
  readonly content?: string | null;
  readonly timestamp?: number;
  readonly viewKind?: SessionReadViewKind;
}

const sessionReadState = new Map<string, Map<string, SessionReadSnapshot>>();
const LOCAL_FILE_HISTORY_MAX_ENTRIES = 8;

/**
 * Stub returned by system.readFile on a cache hit: the session has
 * already read this path and the file's mtime is unchanged since that
 * prior read. Aligns the tool with the upstream reference runtime,
 * which short-circuits unchanged re-reads to save cache_creation
 * tokens and discourage the model from re-crawling the same files.
 *
 * The stub is a plain string — callers just read the single line and
 * move on. When the model legitimately needs fresh bytes (e.g. after
 * an external process modified the file), the mtime will differ and
 * the short-circuit skips itself; the normal read path runs.
 */
export const FILE_UNCHANGED_STUB =
  "File unchanged since previous read in this session. No need to re-read; use the prior content already in context.";

/**
 * Per-session, per-path counter of how many times we've returned the
 * `FILE_UNCHANGED_STUB` short-circuit instead of full content. The
 * stub assumes the model still has the prior content in its
 * conversation context, but after compaction or aggressive history
 * rotation that's no longer true — and the model loops, re-reading
 * the same path forever expecting fresh bytes. After
 * `FILE_UNCHANGED_STUB_MAX_REPEATS` consecutive stubs for the same
 * (session, path), we abandon the optimization for this path and
 * return the full content again, breaking the loop.
 */
const sessionPathStubCounts: Map<string, Map<string, number>> = new Map();
const FILE_UNCHANGED_STUB_MAX_REPEATS = 2;

function bumpStubCount(sessionId: string, path: string): number {
  let inner = sessionPathStubCounts.get(sessionId);
  if (!inner) {
    inner = new Map();
    sessionPathStubCounts.set(sessionId, inner);
  }
  const next = (inner.get(path) ?? 0) + 1;
  inner.set(path, next);
  return next;
}

function clearStubCount(sessionId: string, path: string): void {
  sessionPathStubCounts.get(sessionId)?.delete(path);
}

export function clearSessionStubCounts(sessionId: string): void {
  sessionPathStubCounts.delete(sessionId);
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
    return undefined;
  }

  const existingSnapshot = sessionReadState.get(sessionId)?.get(canonicalPath);
  if (existingSnapshot) {
    return existingSnapshot;
  }

  const persistedSnapshot = loadPersistedSessionReadSnapshot(sessionId, canonicalPath);
  if (!persistedSnapshot) {
    return undefined;
  }

  let fileMap = sessionReadState.get(sessionId);
  if (!fileMap) {
    fileMap = new Map();
    sessionReadState.set(sessionId, fileMap);
  }
  fileMap.set(canonicalPath, persistedSnapshot);
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
    });
  }
}

function isFullSessionRead(snapshot: SessionReadSnapshot | undefined): boolean {
  return snapshot?.viewKind === "full";
}

export function hasSessionRead(
  sessionId: string | undefined,
  canonicalPath: string,
): boolean {
  return isFullSessionRead(
    rehydrateSessionReadSnapshot(sessionId, canonicalPath),
  );
}

export function getSessionReadSnapshot(
  sessionId: string | undefined,
  canonicalPath: string,
): SessionReadSnapshot | undefined {
  return rehydrateSessionReadSnapshot(sessionId, canonicalPath);
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
  const value = args[SESSION_ID_ARG];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

/**
 * Filesystem tool configuration.
 *
 * **Security note:** This sandbox is path-based and does NOT protect against:
 * - TOCTOU races from concurrent filesystem access on the same host
 * - Hard-link escapes (in-sandbox hard link to out-of-sandbox inode)
 * For adversarial environments, use OS-level sandboxing (chroot, namespaces).
 *
 * **Memory note:** `readFile` loads the entire file into memory. With the
 * default 10 MB limit, peak memory per read can reach ~40 MB (buffer +
 * string encoding + JSON serialization). Adjust limits accordingly.
 */
export interface FilesystemToolConfig {
  /** Allowed path prefixes (required — no default to force explicit opt-in). */
  readonly allowedPaths: readonly string[];
  /** Max file size for reads in bytes (default: 10 MB). Peak memory ~4x this value. */
  readonly maxReadBytes?: number;
  /** Max file size for writes in bytes (default: 10 MB). */
  readonly maxWriteBytes?: number;
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

export function resolveToolAllowedPaths(
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): readonly string[] {
  const rawExtraRoots = args[SESSION_ALLOWED_ROOTS_ARG];
  if (!Array.isArray(rawExtraRoots) || rawExtraRoots.length === 0) {
    return allowedPaths;
  }
  const normalizedExtraRoots = rawExtraRoots
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
  if (!result.safe) {
    return [null, errorResult(`Access denied: ${result.reason}`)];
  }
  return [result.resolved, null];
}

const VALID_ENCODINGS = new Set(["utf-8", "base64"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

const EDITFILE_DESANITIZATIONS: Readonly<Record<string, string>> = {
  "<fnr>": "<function_results>",
  "<n>": "<name>",
  "</n>": "</name>",
  "<o>": "<output>",
  "</o>": "</output>",
  "<e>": "<error>",
  "</e>": "</error>",
  "<s>": "<system>",
  "</s>": "</system>",
  "<r>": "<result>",
  "</r>": "</result>",
  "< META_START >": "<META_START>",
  "< META_END >": "<META_END>",
  "< EOT >": "<EOT>",
  "< META >": "<META>",
  "< SOS >": "<SOS>",
  "\n\nH:": "\n\nHuman:",
  "\n\nA:": "\n\nAssistant:",
};

function normalizeQuotes(content: string): string {
  return content
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

function stripTrailingWhitespace(content: string): string {
  const parts = content.split(/(\r\n|\n|\r)/);
  let result = "";
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined) continue;
    result += index % 2 === 0 ? part.replace(/\s+$/, "") : part;
  }
  return result;
}

function desanitizeMatchString(matchString: string): {
  result: string;
  appliedReplacements: Array<{ from: string; to: string }>;
} {
  let result = matchString;
  const appliedReplacements: Array<{ from: string; to: string }> = [];
  for (const [from, to] of Object.entries(EDITFILE_DESANITIZATIONS)) {
    const before = result;
    result = result.replaceAll(from, to);
    if (before !== result) {
      appliedReplacements.push({ from, to });
    }
  }
  return { result, appliedReplacements };
}

function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) {
    return searchString;
  }
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex < 0) {
    return null;
  }
  return fileContent.substring(searchIndex, searchIndex + searchString.length);
}

function isOpeningQuoteContext(chars: readonly string[], index: number): boolean {
  if (index === 0) return true;
  const previous = chars[index - 1];
  return (
    previous === " " ||
    previous === "\t" ||
    previous === "\n" ||
    previous === "\r" ||
    previous === "(" ||
    previous === "[" ||
    previous === "{" ||
    previous === "\u2014" ||
    previous === "\u2013"
  );
}

function applyCurlyDoubleQuotes(content: string): string {
  const chars = [...content];
  const result: string[] = [];
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] === '"') {
      result.push(
        isOpeningQuoteContext(chars, index)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      );
    } else {
      result.push(chars[index]!);
    }
  }
  return result.join("");
}

function applyCurlySingleQuotes(content: string): string {
  const chars = [...content];
  const result: string[] = [];
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] === "'") {
      const previous = index > 0 ? chars[index - 1] : undefined;
      const next = index < chars.length - 1 ? chars[index + 1] : undefined;
      const previousIsLetter =
        previous !== undefined && /\p{L}/u.test(previous);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (previousIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(
          isOpeningQuoteContext(chars, index)
            ? LEFT_SINGLE_CURLY_QUOTE
            : RIGHT_SINGLE_CURLY_QUOTE,
        );
      }
    } else {
      result.push(chars[index]!);
    }
  }
  return result.join("");
}

function preserveQuoteStyle(
  originalOldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (originalOldString === actualOldString) {
    return newString;
  }
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);
  let result = newString;
  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result);
  }
  return result;
}

function shouldStripTrailingWhitespaceForEdit(pathValue: string): boolean {
  return !/\.(md|mdx)$/i.test(pathValue);
}

function normalizeEditStrings(
  filePath: string,
  existingContent: string,
  oldString: string,
  newString: string,
): {
  actualOldString: string | null;
  actualNewString: string;
} {
  const normalizedNewString = shouldStripTrailingWhitespaceForEdit(filePath)
    ? stripTrailingWhitespace(newString)
    : newString;
  const normalizedEscapedNewString =
    normalizeOverescapedToolText(normalizedNewString);

  const directActualOldString = findActualString(existingContent, oldString);
  if (directActualOldString !== null) {
    return {
      actualOldString: directActualOldString,
      actualNewString: preserveQuoteStyle(
        oldString,
        directActualOldString,
        normalizedEscapedNewString,
      ),
    };
  }

  const normalizedOldString = normalizeOverescapedToolText(oldString);
  if (normalizedOldString !== oldString) {
    const normalizedActualOldString = findActualString(
      existingContent,
      normalizedOldString,
    );
    if (normalizedActualOldString !== null) {
      return {
        actualOldString: normalizedActualOldString,
        actualNewString: preserveQuoteStyle(
          normalizedOldString,
          normalizedActualOldString,
          normalizedEscapedNewString,
        ),
      };
    }
  }

  const { result: desanitizedOldString, appliedReplacements } =
    desanitizeMatchString(oldString);
  if (desanitizedOldString !== oldString) {
    let desanitizedNewString = normalizedEscapedNewString;
    for (const replacement of appliedReplacements) {
      desanitizedNewString = desanitizedNewString.replaceAll(
        replacement.from,
        replacement.to,
      );
    }
    const desanitizedActualOldString = findActualString(
      existingContent,
      desanitizedOldString,
    );
    if (desanitizedActualOldString !== null) {
      return {
        actualOldString: desanitizedActualOldString,
        actualNewString: preserveQuoteStyle(
          desanitizedOldString,
          desanitizedActualOldString,
          desanitizedNewString,
        ),
      };
    }
  }

  if (normalizedOldString !== oldString) {
    const {
      result: desanitizedNormalizedOldString,
      appliedReplacements,
    } = desanitizeMatchString(normalizedOldString);
    if (desanitizedNormalizedOldString !== normalizedOldString) {
      let desanitizedNewString = normalizedEscapedNewString;
      for (const replacement of appliedReplacements) {
        desanitizedNewString = desanitizedNewString.replaceAll(
          replacement.from,
          replacement.to,
        );
      }
      const desanitizedActualOldString = findActualString(
        existingContent,
        desanitizedNormalizedOldString,
      );
      if (desanitizedActualOldString !== null) {
        return {
          actualOldString: desanitizedActualOldString,
          actualNewString: preserveQuoteStyle(
            desanitizedNormalizedOldString,
            desanitizedActualOldString,
            desanitizedNewString,
          ),
        };
      }
    }
  }

  return {
    actualOldString: null,
    actualNewString: normalizedEscapedNewString,
  };
}

function getFileTimestampMs(fileStats: { mtimeMs?: number }): number | undefined {
  return typeof fileStats.mtimeMs === "number" && Number.isFinite(fileStats.mtimeMs)
    ? fileStats.mtimeMs
    : undefined;
}

async function readFreshTextSnapshot(
  path: string,
  viewKind: SessionReadViewKind,
): Promise<SessionReadSnapshot> {
  const [buffer, fileStats] = await Promise.all([
    readFile(path),
    stat(path),
  ]);
  return {
    content: isBinaryContent(buffer) ? null : buffer.toString("utf-8"),
    timestamp: getFileTimestampMs(fileStats) ?? Date.now(),
    viewKind,
  };
}

function requiresFullReadSnapshot(
  snapshot: SessionReadSnapshot | undefined,
): boolean {
  return snapshot?.viewKind !== "full";
}

function hasFileChangedSinceSnapshot(params: {
  readonly snapshot: SessionReadSnapshot | undefined;
  readonly currentContent: string;
}): boolean {
  if (params.snapshot?.content == null) {
    return false;
  }
  if (params.snapshot.viewKind === "partial") {
    // Partial reads captured only a line window. Treat the file as
    // drifted when the exact window the model saw is no longer a
    // verbatim substring of the current content — that signals an
    // external mutation overlapped the viewed region.
    return !params.currentContent.includes(params.snapshot.content);
  }
  return params.currentContent !== params.snapshot.content;
}

/** Detect if file content is likely binary (contains null bytes). */
function isBinaryContent(buffer: Buffer): boolean {
  for (let i = 0; i < Math.min(buffer.length, 8192); i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function normalizeIntegerArg(
  value: unknown,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

function resolveReadWindow(args: Record<string, unknown>): {
  readonly startLine?: number;
  readonly limit?: number;
} {
  const explicitOffset = normalizeIntegerArg(args.offset);
  const explicitLimit = normalizeIntegerArg(args.limit);
  const compatStartLine = normalizeIntegerArg(args.startLine);
  const compatEndLine = normalizeIntegerArg(args.endLine);

  if (
    explicitOffset === undefined &&
    explicitLimit === undefined &&
    compatStartLine === undefined &&
    compatEndLine === undefined
  ) {
    return {};
  }

  const startLine =
    explicitOffset !== undefined
      ? Math.max(1, explicitOffset)
      : Math.max(1, compatStartLine ?? 1);
  const limit =
    explicitLimit !== undefined
      ? Math.max(1, explicitLimit)
      : compatEndLine !== undefined
        ? Math.max(1, compatEndLine - startLine + 1)
        : undefined;

  return {
    startLine,
    ...(limit === undefined ? {} : { limit }),
  };
}

function sliceTextByLines(params: {
  readonly text: string;
  readonly startLine: number;
  readonly limit?: number;
}): {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly lineCount: number;
  readonly viewKind: SessionReadViewKind;
} {
  const lines = params.text.split(/\r?\n/);
  const totalLines = lines.length;
  const boundedStartLine = Math.max(1, params.startLine);
  const boundedEndLine =
    params.limit === undefined
      ? totalLines
      : Math.min(totalLines, boundedStartLine + params.limit - 1);
  const selected =
    totalLines === 0 || boundedStartLine > totalLines
      ? []
      : lines.slice(boundedStartLine - 1, boundedEndLine);
  return {
    content: selected.join("\n"),
    startLine: boundedStartLine,
    endLine: Math.max(boundedStartLine, boundedEndLine),
    totalLines,
    lineCount: selected.length,
    viewKind:
      boundedStartLine === 1 && selected.length === totalLines
        ? "full"
        : "partial",
  };
}

// ============================================================================
// Tool Factories
// ============================================================================

function createReadFileTool(
  allowedPaths: readonly string[],
  maxReadBytes: number,
): Tool {
  return {
    name: "system.readFile",
    description:
      "Read a file from the filesystem. Returns text content (UTF-8) by default, or base64 for binary files. " +
      "For text files, optional line-window reads are supported via offset/limit. Gated by path allowlist and size limits.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to read",
        },
        encoding: {
          type: "string",
          enum: ["utf-8", "base64"],
          description:
            "Output encoding (default: auto-detect — utf-8 for text, base64 for binary)",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description:
            "Optional 1-indexed starting line for text reads. Use with limit to target a portion of a file.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "Optional number of lines to return for text reads.",
        },
        startLine: {
          type: "integer",
          minimum: 1,
          description:
            "Compatibility alias for offset on text reads.",
        },
        endLine: {
          type: "integer",
          minimum: 1,
          description:
            "Compatibility alias for the inclusive end line on text reads.",
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

        if (
          args.encoding !== undefined &&
          !VALID_ENCODINGS.has(args.encoding as string)
        ) {
          return errorResult(
            `Invalid encoding: ${args.encoding}. Must be utf-8 or base64.`,
          );
        }

        const fileStats = await stat(resolved!);
        if (!fileStats.isFile()) {
          return errorResult("Path is not a regular file");
        }
        if (fileStats.size > maxReadBytes) {
          return errorResult(
            `File size ${fileStats.size} bytes exceeds limit of ${maxReadBytes} bytes`,
          );
        }

        // Cache-hit short-circuit: if this session already read this
        // path and the file's mtime is unchanged, return the
        // FILE_UNCHANGED_STUB instead of re-reading. Range-aware
        // dedup: full reads dedup against a prior full read; partial
        // reads dedup only when the exact `(offset, limit)` matches
        // the prior partial read for the same path. A different slice
        // always falls through.
        const cacheHitSessionId = resolveSessionId(args);
        const requestedReadWindow = resolveReadWindow(args);
        const requestedIsFull =
          requestedReadWindow.startLine === undefined &&
          requestedReadWindow.limit === undefined;
        if (cacheHitSessionId) {
          const priorSnapshot = getSessionReadSnapshot(
            cacheHitSessionId,
            resolved!,
          );
          const priorTimestamp = priorSnapshot?.timestamp;
          const currentTimestamp = getFileTimestampMs(fileStats);
          const mtimeMatches =
            priorSnapshot !== undefined &&
            typeof priorTimestamp === "number" &&
            typeof currentTimestamp === "number" &&
            priorTimestamp === currentTimestamp;
          const priorIsFull =
            priorSnapshot?.viewKind === "full" &&
            priorSnapshot.readOffset === undefined &&
            priorSnapshot.readLimit === undefined;
          const partialRangeMatches =
            priorSnapshot?.viewKind === "partial" &&
            !requestedIsFull &&
            priorSnapshot.readOffset === requestedReadWindow.startLine &&
            priorSnapshot.readLimit === requestedReadWindow.limit;
          const cacheEligible =
            mtimeMatches &&
            ((requestedIsFull && priorIsFull) || partialRangeMatches);
          if (cacheEligible) {
            // The stub assumes the model still has the prior content in
            // context. After compaction or aggressive history rotation
            // that breaks; the model then loops, re-reading the same
            // path expecting fresh bytes. Cap the optimization at
            // `FILE_UNCHANGED_STUB_MAX_REPEATS` consecutive stubs per
            // (session, path) and fall through to the full read on
            // repeat misses. Observed in production: lexer.c stubbed
            // 57 times in a single turn before this guard.
            const stubCount = bumpStubCount(cacheHitSessionId, resolved!);
            if (stubCount <= FILE_UNCHANGED_STUB_MAX_REPEATS) {
              return { content: FILE_UNCHANGED_STUB };
            }
            // Reset the counter so we don't keep tripping the bypass
            // forever; subsequent reads will re-stub if the model
            // actually has the content.
            clearStubCount(cacheHitSessionId, resolved!);
          }
        }

        const buffer = await readFile(resolved!);
        // Post-read size guard (mitigates TOCTOU between stat and readFile)
        if (buffer.length > maxReadBytes) {
          return errorResult(
            `File size ${buffer.length} bytes exceeds limit of ${maxReadBytes} bytes`,
          );
        }
        const readWindow = resolveReadWindow(args);
        const forceEncoding = args.encoding as string | undefined;
        const binary =
          forceEncoding === "base64" ||
          (!forceEncoding && isBinaryContent(buffer));

        if (binary && readWindow.startLine !== undefined) {
          return errorResult(
            "Line-based reads are only supported for UTF-8 text files. Omit offset/limit for binary reads.",
          );
        }

        if (!binary && readWindow.startLine !== undefined) {
          const text = buffer.toString("utf-8");
          const sliced = sliceTextByLines({
            text,
            startLine: readWindow.startLine,
            ...(readWindow.limit === undefined
              ? {}
              : { limit: readWindow.limit }),
          });
          recordSessionRead(resolveSessionId(args), resolved!, {
            content: sliced.content,
            timestamp: getFileTimestampMs(fileStats),
            viewKind: sliced.viewKind,
            ...(readWindow.startLine !== undefined
              ? { readOffset: readWindow.startLine }
              : {}),
            ...(readWindow.limit !== undefined
              ? { readLimit: readWindow.limit }
              : {}),
          });
          return {
            content: safeStringify({
              path: args.path,
              size: buffer.length,
              encoding: "utf-8",
              content: sliced.content,
              startLine: sliced.startLine,
              endLine: sliced.endLine,
              totalLines: sliced.totalLines,
              lineCount: sliced.lineCount,
            }),
          };
        }

        const textContent = binary ? undefined : buffer.toString("utf-8");
        const fullTextMetadata =
          textContent === undefined
            ? undefined
            : sliceTextByLines({
                text: textContent,
                startLine: 1,
              });

        // Record the read in the per-session readFileState so
        // subsequent system.writeFile / system.editFile calls on this
        // path satisfy the Read-before-Write rule. See PR #314 and
        // the SESSION_ID_ARG comment for the rationale.
        recordSessionRead(resolveSessionId(args), resolved!, {
          content: binary ? null : textContent ?? "",
          timestamp: getFileTimestampMs(fileStats),
          viewKind: "full",
        });

        return {
          content: safeStringify({
            path: args.path,
            size: buffer.length,
            encoding: binary ? "base64" : "utf-8",
            content: binary
              ? buffer.toString("base64")
              : textContent ?? "",
            ...(fullTextMetadata
              ? {
                  startLine: 1,
                  endLine: fullTextMetadata.endLine,
                  totalLines: fullTextMetadata.totalLines,
                  lineCount: fullTextMetadata.lineCount,
                }
              : {}),
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`File not found: ${args.path}`);
        if (msg.includes("EACCES"))
          return errorResult(`Permission denied: ${args.path}`);
        return errorResult(safeError(err, "read"));
      }
    },
  };
}

function createWriteFileTool(
  allowedPaths: readonly string[],
  maxWriteBytes: number,
): Tool {
  return {
    name: "system.writeFile",
    description:
      "Write content to a file. Creates parent directories if needed. Gated by path allowlist and size limits. " +
      "If the file already exists, you MUST call system.readFile on it first in this session — the runtime will " +
      "reject the write otherwise. For modifying existing files, prefer system.editFile (string-replace) over " +
      "system.writeFile (full rewrite); editFile only sends the diff and is much less prone to JSON-escape bugs " +
      "in nested string literals like #include directives or shell single-quotes.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to write",
        },
        content: {
          type: "string",
          description: "Text content to write",
        },
        encoding: {
          type: "string",
          enum: ["utf-8", "base64"],
          description:
            "Input encoding (default: utf-8). Use base64 for binary data.",
        },
      },
      required: ["path", "content"],
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

        if (typeof args.content !== "string") {
          return errorResult("content must be a string");
        }

        // Read-before-Write enforcement. If the target path EXISTS and the
        // model has not called system.readFile on it in the current session,
        // reject the write with a structured error that names the rule.
        // Non-existent paths are allowed through unconditionally so
        // brand-new file creation continues to work without a prior read.
        const sessionId = resolveSessionId(args);
        let targetExists = false;
        try {
          const existingStat = await stat(resolved!);
          targetExists = existingStat.isFile();
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") throw err;
          // ENOENT — file does not exist yet, this is a creation, no
          // prior read required.
        }
        const readSnapshot = getSessionReadSnapshot(sessionId, resolved!);
        if (targetExists && requiresFullReadSnapshot(readSnapshot)) {
          return errorResult(
            `File must be fully read before writing to it. ` +
              `Call system.readFile on "${args.path}" before calling system.writeFile, ` +
              `OR prefer system.editFile (str_replace semantics) for incremental edits.`,
          );
        }

        if (
          targetExists &&
          readSnapshot?.content !== undefined &&
          readSnapshot.viewKind === "full"
        ) {
          const existingBuffer = await readFile(resolved!);
          const existingContent = existingBuffer.toString("utf-8");
          if (
            hasFileChangedSinceSnapshot({
              snapshot: readSnapshot,
              currentContent: existingContent,
            })
          ) {
            return errorResult(
              `File has been modified since it was last read. Read "${args.path}" again before writing to it.`,
            );
          }
        }

        const encoding = (args.encoding as string) || "utf-8";
        if (!VALID_ENCODINGS.has(encoding)) {
          return errorResult(
            `Invalid encoding: ${encoding}. Must be utf-8 or base64.`,
          );
        }

        if (encoding === "base64") {
          // Pre-check encoded string length before regex/decode to prevent memory exhaustion
          const maxBase64Length = Math.ceil(maxWriteBytes / 3) * 4 + 4;
          if (args.content.length > maxBase64Length) {
            return errorResult(
              `Base64 content too large (decoded would exceed ${maxWriteBytes} bytes)`,
            );
          }
          if (args.content.length % 4 !== 0 || !BASE64_RE.test(args.content)) {
            return errorResult("Invalid base64 content");
          }
        }
        // Undo Grok double-escaping before encoding to bytes. Only
        // applies to text mode — base64 content is passed through raw.
        const sanitizedContent =
          encoding === "base64"
            ? args.content
            : normalizeOverescapedToolText(args.content);
        const data =
          encoding === "base64"
            ? Buffer.from(sanitizedContent, "base64")
            : Buffer.from(sanitizedContent, "utf-8");

        if (data.length > maxWriteBytes) {
          return errorResult(
            `Content size ${data.length} bytes exceeds limit of ${maxWriteBytes} bytes`,
          );
        }

        await mkdir(dirname(resolved!), { recursive: true });
        await writeFile(resolved!, data);

        // Successful write counts as the "current state" the model has
        // seen — record the path so subsequent edits to the same file
        // in the same session don't require a redundant readFile.
        const refreshedSnapshot = await readFreshTextSnapshot(resolved!, "full");
        recordSessionRead(sessionId, resolved!, refreshedSnapshot);

        return {
          content: safeStringify({
            path: args.path,
            bytesWritten: data.length,
          }),
        };
      } catch (err) {
        return errorResult(safeError(err, "write"));
      }
    },
  };
}

function createAppendFileTool(
  allowedPaths: readonly string[],
  maxWriteBytes: number,
): Tool {
  return {
    name: "system.appendFile",
    description:
      "Append content to an existing file. Creates the file if it does not exist. Gated by path allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to append to",
        },
        content: {
          type: "string",
          description: "Text content to append",
        },
      },
      required: ["path", "content"],
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

        if (typeof args.content !== "string") {
          return errorResult("content must be a string");
        }

        const sanitizedContent = normalizeOverescapedToolText(args.content);
        const data = Buffer.from(sanitizedContent, "utf-8");
        if (data.length > maxWriteBytes) {
          return errorResult(
            `Content size ${data.length} bytes exceeds limit of ${maxWriteBytes} bytes`,
          );
        }

        const sessionId = resolveSessionId(args);

        // Check total resulting file size to prevent disk exhaustion via repeated appends
        try {
          const existing = await stat(resolved!);
          if (existing.size + data.length > maxWriteBytes) {
            return errorResult(
              `Resulting file size ${existing.size + data.length} bytes exceeds limit of ${maxWriteBytes} bytes`,
            );
          }

          const readSnapshot = getSessionReadSnapshot(sessionId, resolved!);
          if (requiresFullReadSnapshot(readSnapshot)) {
            return errorResult(
              `File must be fully read before appending to it. ` +
                `Call system.readFile on "${args.path}" before calling system.appendFile.`,
            );
          }

          if (
            readSnapshot?.content !== undefined &&
            readSnapshot.viewKind === "full"
          ) {
            const existingBuffer = await readFile(resolved!);
            const existingContent = existingBuffer.toString("utf-8");
            if (
              hasFileChangedSinceSnapshot({
                snapshot: readSnapshot,
                currentContent: existingContent,
              })
            ) {
              return errorResult(
                `File has been modified since it was last read. Read "${args.path}" again before appending to it.`,
              );
            }
          }
        } catch {
          // File doesn't exist yet — just the append size matters (checked above)
        }

        // Create parent directories if needed (consistent with writeFile)
        await mkdir(dirname(resolved!), { recursive: true });
        await appendFile(resolved!, data);
        const refreshedSnapshot = await readFreshTextSnapshot(resolved!, "full");
        recordSessionRead(sessionId, resolved!, refreshedSnapshot);
        return {
          content: safeStringify({
            path: args.path,
            bytesAppended: data.length,
          }),
        };
      } catch (err) {
        return errorResult(safeError(err, "append"));
      }
    },
  };
}

/**
 * `system.editFile` — string-replacement edit tool.
 *
 * Takes `{path, old_string, new_string, replace_all?}` and performs an
 * exact string replacement on the file at `path`. The model uses this
 * tool for incremental edits instead of `system.writeFile` (full file
 * replacement). The architectural reason is in the `system.writeFile`
 * description: rewriting a 200-line C source file via a JSON tool
 * call exposes hundreds of nested-quote escape opportunities, every
 * single one of which the Grok adapter has been observed to mangle
 * (see report.txt §writeFile-escape-bug for the live trace evidence).
 * Edits scoped to ~50 chars of `old_string` + `new_string` shrink the
 * escape surface ~100x and make every observed live-trace failure
 * disappear.
 *
 * Semantics:
 *   - The file MUST exist. Creating new files is `system.writeFile`'s
 *     job. `system.editFile` returns an error if the path does not
 *     resolve to a regular file.
 *   - The file MUST have been read in this session via
 *     `system.readFile` (or written via `system.writeFile` /
 *     `system.editFile` which auto-record the new content as "read").
 *     Either a full read or a line-windowed partial read (via
 *     `offset`/`limit`) is accepted — the tool's own `old_string`
 *     existence and uniqueness checks are what keep replacements
 *     safe, not the width of the prior read. `system.writeFile`
 *     still requires a full snapshot because it overwrites the
 *     whole file.
 *   - `old_string` MUST appear EXACTLY ONCE in the file unless
 *     `replace_all === true`. If zero matches: returns an error
 *     pointing the model at the actual file content. If multiple
 *     matches and `replace_all` is false: returns an error telling the
 *     model to either narrow `old_string` with more context or pass
 *     `replace_all: true`.
 *   - `old_string === new_string` is rejected (no-op edits are a sign
 *     of a confused model and waste a turn).
 *
 * The successful result records the post-edit content as "read" so
 * subsequent edits in the same session can chain without a redundant
 * `readFile` call.
 */
function createEditFileTool(
  allowedPaths: readonly string[],
  maxWriteBytes: number,
  maxReadBytes: number,
): Tool {
  return {
    name: "system.editFile",
    description:
      "Perform an exact string replacement in an existing file. Prefer this over system.writeFile for ALL " +
      "modifications to existing files — it only sends the diff (old_string → new_string), so it does not " +
      "expose the model to JSON-escape mistakes in nested string literals like #include directives, shell " +
      "single-quotes, or printf format strings. The file must exist and must have been read in this session " +
      "(via system.readFile, or implicitly via a prior system.writeFile / system.editFile in the same session). " +
      "A line-windowed read (with offset/limit) is accepted — a full read is not required for editFile. " +
      "old_string must match exactly once unless replace_all is true. If old_string is not unique, narrow it " +
      "with more surrounding context or pass replace_all: true. Use the smallest old_string that is clearly " +
      "unique — usually 2-4 adjacent lines are enough. Preserve the exact indentation and whitespace from the " +
      "file bytes you read. If you are renaming or replacing repeated text across the file, use replace_all: true " +
      "instead of issuing a sequence of overlapping single-match edits.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to edit",
        },
        old_string: {
          type: "string",
          description:
            "The exact text to replace. Must appear in the file. Use enough surrounding context to be unique unless replace_all is true.",
        },
        new_string: {
          type: "string",
          description:
            "The replacement text. Must differ from old_string (no-op edits are rejected).",
        },
        replace_all: {
          type: "boolean",
          description:
            "If true, replace every occurrence of old_string. If false (default), exactly one occurrence is required.",
        },
      },
      required: ["path", "old_string", "new_string"],
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

        if (typeof args.old_string !== "string") {
          return errorResult("old_string must be a string");
        }
        if (typeof args.new_string !== "string") {
          return errorResult("new_string must be a string");
        }
        if (args.old_string.length === 0) {
          return errorResult(
            "old_string must be a non-empty string. To create a new file or write a full file, use system.writeFile.",
          );
        }
        if (args.old_string === args.new_string) {
          return errorResult(
            "old_string and new_string are identical — no-op edits are rejected. " +
              "If you intended to replace a different region, narrow old_string to the actual target.",
          );
        }
        const replaceAll = args.replace_all === true;

        // The target file MUST exist. Creating new files is system.writeFile's
        // job; this tool only modifies existing files.
        let fileStats;
        try {
          fileStats = await stat(resolved!);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            return errorResult(
              `File not found: ${args.path}. system.editFile only modifies existing files. ` +
                `Use system.writeFile to create new files.`,
            );
          }
          throw err;
        }
        if (!fileStats.isFile()) {
          return errorResult(`Path is not a regular file: ${args.path}`);
        }
        if (fileStats.size > maxReadBytes) {
          return errorResult(
            `File size ${fileStats.size} bytes exceeds limit of ${maxReadBytes} bytes`,
          );
        }

        // Read-before-Edit enforcement. The model must have called
        // system.readFile on this path in the current session, but
        // either a full or a partial read (offset/limit line window)
        // suffices: system.editFile is surgical — old_string must
        // match verbatim against the file's current bytes, and the
        // uniqueness check below prevents collateral replacements.
        // Partial reads give the model enough context to identify
        // the region it is editing without forcing an unnecessary
        // full re-read of large source files. system.writeFile still
        // requires a full snapshot because it overwrites the entire
        // file.
        const sessionId = resolveSessionId(args);
        const readSnapshot = getSessionReadSnapshot(sessionId, resolved!);
        if (readSnapshot === undefined) {
          return errorResult(
            `File has not been read in this session. ` +
              `Call system.readFile on "${args.path}" before calling system.editFile. ` +
              `A line-windowed read (via offset/limit) is sufficient — the Read-before-Edit rule ` +
              `only requires that you have seen the current contents before generating the edit.`,
          );
        }

        const existingBuffer = await readFile(resolved!);
        if (existingBuffer.length > maxReadBytes) {
          return errorResult(
            `File size ${existingBuffer.length} bytes exceeds limit of ${maxReadBytes} bytes`,
          );
        }
        if (isBinaryContent(existingBuffer)) {
          return errorResult(
            `File appears to be binary: ${args.path}. system.editFile only operates on text files.`,
          );
        }
        const existingContent = existingBuffer.toString("utf-8");
        if (hasFileChangedSinceSnapshot({ snapshot: readSnapshot, currentContent: existingContent })) {
          return errorResult(
            `File has been modified since it was last read. Read "${args.path}" again before editing it.`,
          );
        }

        const requestedPath = args.path as string;
        const { actualOldString, actualNewString } = normalizeEditStrings(
          requestedPath,
          existingContent,
          args.old_string,
          args.new_string,
        );

        // Find occurrences of old_string in the existing content after
        // Text normalization pass (quote reconciliation, desanitization,
        // and replacement whitespace cleanup). Matching remains literal
        // and deterministic; normalization only widens common
        // representational drift before the safety checks below.
        let occurrences = 0;
        let searchFrom = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const index =
            actualOldString === null
              ? -1
              : existingContent.indexOf(actualOldString, searchFrom);
          if (index < 0) break;
          occurrences++;
          searchFrom = index + (actualOldString?.length ?? 0);
          if (!replaceAll && occurrences > 1) break; // early-out for the unique-match check
        }
        if (occurrences === 0) {
          return errorResult(
            `old_string not found in ${args.path}. The exact text you provided does not appear ` +
              `anywhere in the file after quote/desanitization normalization. Re-read the file ` +
              `with system.readFile to see the current contents, then construct old_string from ` +
              `the actual bytes you see.`,
          );
        }
        if (!replaceAll && occurrences > 1) {
          return errorResult(
            `old_string is not unique in ${args.path} (found multiple matches). ` +
              `Either narrow old_string by adding more surrounding context until it matches exactly ` +
              `one location, or pass replace_all: true to replace every occurrence.`,
          );
        }

        // Undo Grok double-escaping on new_string before substitution.
        // old_string is NOT sanitized — it matches against the file's
        // ACTUAL bytes which are authoritative.
        const sanitizedNewString = normalizeOverescapedToolText(actualNewString);

        // Compute the new content. For the unique-match case use a
        // single replace; for replace_all walk the string to avoid
        // String.prototype.replaceAll edge cases on older runtimes.
        const newContent = replaceAll
          ? existingContent.split(actualOldString!).join(sanitizedNewString)
          : existingContent.replace(actualOldString!, sanitizedNewString);

        const newBuffer = Buffer.from(newContent, "utf-8");
        if (newBuffer.length > maxWriteBytes) {
          return errorResult(
            `Resulting file size ${newBuffer.length} bytes exceeds limit of ${maxWriteBytes} bytes`,
          );
        }

        await writeFile(resolved!, newBuffer);

        // Record the post-edit content as "read" so the next edit in
        // this session does not require a redundant readFile.
        const refreshedSnapshot = await readFreshTextSnapshot(resolved!, "full");
        recordSessionRead(sessionId, resolved!, refreshedSnapshot);

        return {
          content: safeStringify({
            path: args.path,
            replacements: occurrences,
            replaceAll,
            bytesWritten: newBuffer.length,
            previousSize: existingBuffer.length,
          }),
        };
      } catch (err) {
        return errorResult(safeError(err, "edit"));
      }
    },
  };
}

function createListDirTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.listDir",
    description:
      "List directory contents. Returns entry names, types (file/dir), and sizes. Gated by path allowlist.",
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
 * Create all filesystem tools (9 tools).
 *
 * @param config - Filesystem tool configuration with allowed paths and limits
 * @returns Array of Tool instances
 *
 * @example
 * ```typescript
 * const tools = createFilesystemTools({
 *   allowedPaths: ['~/.agenc/workspace/'],
 *   maxReadBytes: 5_000_000,
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

  const maxReadBytes = config.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  if (!Number.isFinite(maxReadBytes) || maxReadBytes <= 0) {
    throw new TypeError(
      `maxReadBytes must be a positive finite number, got: ${maxReadBytes}`,
    );
  }
  const maxWriteBytes = config.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  if (!Number.isFinite(maxWriteBytes) || maxWriteBytes <= 0) {
    throw new TypeError(
      `maxWriteBytes must be a positive finite number, got: ${maxWriteBytes}`,
    );
  }
  const allowDelete = config.allowDelete ?? false;
  if (allowDelete !== true && allowDelete !== false) {
    throw new TypeError(
      `allowDelete must be a boolean, got: ${typeof allowDelete}`,
    );
  }

  return [
    createReadFileTool(allowedPaths, maxReadBytes),
    createWriteFileTool(allowedPaths, maxWriteBytes),
    createAppendFileTool(allowedPaths, maxWriteBytes),
    createEditFileTool(allowedPaths, maxWriteBytes, maxReadBytes),
    createListDirTool(allowedPaths),
    createStatTool(allowedPaths),
    createMkdirTool(allowedPaths),
    createDeleteTool(allowedPaths, allowDelete),
    createMoveTool(allowedPaths),
  ];
}

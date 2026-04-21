/**
 * Wave 3-C: drag-drop path extractor.
 *
 * Parses pasted or bracketed-paste input that originated from a
 * drag-drop gesture and returns the filesystem path candidates it
 * contains. This is deliberately **syntactic only**: no existence or
 * permission check is performed here. That keeps the helper usable
 * from TUI code without pulling a filesystem dependency into the
 * composer and lets higher layers decide what to do with missing or
 * unreadable paths (attach, warn, ignore).
 *
 * Supported source shapes:
 *   - `file:///absolute/path` URLs, produced by most GNOME/KDE/Nautilus
 *     drags and by GTK's "text/uri-list" payload.
 *   - POSIX absolute paths (`/Users/...`, `/home/...`, `/tmp/...`).
 *   - Windows drive-letter paths (`C:\foo\bar`, `C:/foo/bar`).
 *   - Quoted paths wrapped in single or double quotes; Finder drags on
 *     macOS often deliver `"$HOME/file name.txt"` when the path
 *     contains whitespace.
 *
 * Output contract:
 *   - Returns a de-duplicated array that preserves first-seen order
 *     based on each candidate's original offset in the input.
 *   - Bare tokens that do not match one of the path shapes are
 *     discarded — a word like "hello" is not silently promoted to a
 *     path candidate.
 *   - URL-encoded sequences in `file://` inputs are decoded so the
 *     caller receives a plain filesystem path.
 */

/** Absolute POSIX path: starts with `/`, at least one non-whitespace
 * character after. Used only for the bare-path scan on the residual
 * string (i.e. after quoted and `file://` spans have been blanked out),
 * so we don't need to worry about matching inside those shapes. */
const POSIX_ABS_RE = /\/[^\s"'<>|?*]+/g;

/** Windows drive-letter path: `C:\foo`, `D:/bar`, etc. */
const WIN_ABS_RE = /[A-Za-z]:[\\/][^\s"'<>|?*]+/g;

/** `file://[host]/path` URL. We accept empty host (`file:///`) and also
 * tolerate a legacy single-slash form some DEs still emit. */
const FILE_URL_RE = /file:\/\/\/?[^\s"'<>]+/g;

/** Double-quoted or single-quoted spans. */
const QUOTED_RE = /"([^"]+)"|'([^']+)'/g;

/**
 * Strip a `file://` URL wrapper and percent-decode the remaining path.
 * Returns the raw input unchanged if decoding fails so the caller can
 * still decide whether to keep it as a literal string.
 */
function normalizeFileUrl(raw: string): string {
  // Strip the `file://` scheme plus an optional authority, but preserve
  // the leading `/` of the path component:
  //   `file:///foo`      → `/foo`         (empty authority)
  //   `file://host/foo`  → `/foo`         (drop authority, keep path)
  //   `file:/foo`        → `/foo`         (legacy single-slash form)
  // The pattern `file:\/\/[^\/]*` deliberately excludes the path's
  // leading slash from the match so it survives the replace.
  const stripped =
    raw.startsWith("file://")
      ? raw.replace(/^file:\/\/[^/]*/, "")
      : raw.replace(/^file:/, "");
  const path = stripped.length === 0 ? "/" : stripped;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Heuristic: true if `s` looks like a filesystem path we want to
 * surface. Accepts POSIX absolute, Windows absolute, and `~`-prefixed
 * home references. Relative paths are rejected deliberately because a
 * bare token like `foo/bar` is usually prose, not a drop target.
 */
function looksLikePath(s: string): boolean {
  if (s.length === 0) return false;
  if (s.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (s.startsWith("~/") || s === "~") return true;
  return false;
}

interface Hit {
  offset: number;
  value: string;
}

/**
 * Extract all path candidates from a single raw input string. Returns
 * a de-duplicated array preserving first-seen order based on the
 * candidate's original offset in `raw`.
 */
export function extractDroppedPaths(raw: string): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];

  const hits: Hit[] = [];

  // Track spans we have already claimed so a path emitted by an earlier
  // shape (quoted, file://) is not re-emitted by the bare POSIX scan.
  // We also use a residual string (same length as `raw`, with consumed
  // regions replaced by spaces) for the bare-path regexes.
  let residual = raw;
  const blankOut = (start: number, end: number): void => {
    residual =
      residual.slice(0, start) +
      " ".repeat(end - start) +
      residual.slice(end);
  };

  // Quoted spans first — they can contain spaces that would otherwise
  // split inside the bare-path scan.
  for (const match of Array.from(raw.matchAll(QUOTED_RE))) {
    const captured = match[1] ?? match[2];
    if (captured === undefined || match.index === undefined) continue;
    if (looksLikePath(captured)) {
      hits.push({ offset: match.index, value: captured });
    }
    blankOut(match.index, match.index + match[0].length);
  }

  // `file://` URLs next, so their inner path is not double-counted by
  // the POSIX scan.
  for (const match of Array.from(residual.matchAll(FILE_URL_RE))) {
    if (match.index === undefined) continue;
    const normalized = normalizeFileUrl(match[0]);
    if (looksLikePath(normalized)) {
      hits.push({ offset: match.index, value: normalized });
    }
    blankOut(match.index, match.index + match[0].length);
  }

  // POSIX absolute paths on the residual.
  for (const match of Array.from(residual.matchAll(POSIX_ABS_RE))) {
    if (match.index === undefined) continue;
    if (looksLikePath(match[0])) {
      hits.push({ offset: match.index, value: match[0] });
    }
  }

  // Windows absolute paths on the residual.
  for (const match of Array.from(residual.matchAll(WIN_ABS_RE))) {
    if (match.index === undefined) continue;
    if (looksLikePath(match[0])) {
      hits.push({ offset: match.index, value: match[0] });
    }
  }

  // Sort by original offset so the final array mirrors input order
  // regardless of the scan sequence above.
  hits.sort((a, b) => a.offset - b.offset);

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const { value } of hits) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { listResumableSessions } from "../commands/resume.js";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  findProjectRootSync,
  getAgencHomeDir,
  listResumableSessions as listProjectRollouts,
} from "../session/session-store.js";
import { sanitizePath } from "../utils/sessionStoragePortable.js";

export type ResumeSessionResolution =
  | { readonly kind: "ok"; readonly sessionId: string }
  | { readonly kind: "none" }
  | { readonly kind: "not_found"; readonly input: string }
  | {
      readonly kind: "ambiguous";
      readonly input: string;
      readonly matches: readonly string[];
    };

/**
 * Two project-slug schemes coexist under `~/.agenc/projects/`:
 *
 *  1. Current (canonical): `slugifyCwd(cwd)` from `session-store.ts` -
 *     `home-tetsuo-...-<8charHash>`. New sessions land here.
 *  2. Legacy: `sanitizePath(cwd)` from `sessionStoragePortable.ts` -
 *     `-home-tetsuo-...` (leading dash, no hash unless the slug exceeds
 *     200 chars). Older sessions and tools using the portable sanitizer
 *     write here.
 *
 * `agenc -c` and `agenc --resume <id>` must accept session ids from
 * either layout, since the `/resume` picker surfaces both. Future cleanup
 * can converge on the hashed slug as the single canonical form; this
 * resolver is the migration seam.
 */

function projectSessions(cwd: string): readonly string[] {
  const seen = new Set<string>();
  const sessionIds: string[] = [];
  for (const entry of listResumableSessions(cwd, {
    maxFiles: 10_000,
    limit: 10_000,
  })) {
    if (seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    sessionIds.push(entry.sessionId);
  }
  return sessionIds;
}

/** Walk `<projectDir>/sessions/<id>/rollout-*.jsonl` directly. */
function sessionIdsUnderProjectDir(projectDir: string): readonly string[] {
  try {
    return listProjectRollouts(projectDir).map((entry) => entry.sessionId);
  } catch {
    return [];
  }
}

/**
 * Produce the legacy slug path for `cwd` (sanitizePath form).
 *
 * Resolves the project root the same way the canonical path does
 * (ancestor walk to a root marker) so two checkouts under the same git
 * root agree on the legacy slug too.
 */
function legacyProjectDirFor(cwd: string): string {
  const root = findProjectRootSync(cwd, DEFAULT_SESSION_ROOT_MARKERS);
  const slugInput = root ? root.rootDir : cwd;
  return join(getAgencHomeDir(), "projects", sanitizePath(slugInput));
}

/**
 * Project session ids from BOTH the current-scheme and legacy-scheme
 * project directories. Dedups while preserving the newest-first order
 * from the current scheme, then appends any legacy-only ids.
 */
function projectSessionsCrossSlug(cwd: string): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const id of projectSessions(cwd)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const legacyDir = legacyProjectDirFor(cwd);
  for (const id of sessionIdsUnderProjectDir(legacyDir)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/**
 * Conv-id shape: `conv-` followed by 6+ alphanumerics. Only conv-prefixed
 * ids are unique enough to safely match across projects without colliding
 * with raw UUIDs that might appear under multiple project slugs.
 */
function isLikelyConvId(id: string): boolean {
  return /^conv-[A-Za-z0-9]{6,}$/.test(id);
}

/**
 * Search every `~/.agenc/projects/*` for `<projectDir>/sessions/<id>/`.
 * Used as a last resort when neither the canonical nor legacy local
 * project dir contains the id - a conv-id alone identifies a session
 * uniquely regardless of which project slug holds it.
 */
function findConvIdGlobally(id: string): string | undefined {
  const projectsDir = join(getAgencHomeDir(), "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = join(projectsDir, entry, "sessions", id);
    try {
      if (statSync(candidate).isDirectory()) return id;
    } catch {
      // Missing or unreadable - keep scanning.
    }
  }
  return undefined;
}

export function resolveLatestSessionId(cwd: string): ResumeSessionResolution {
  const latest = projectSessionsCrossSlug(cwd)[0];
  return latest ? { kind: "ok", sessionId: latest } : { kind: "none" };
}

export function resolveResumeSessionId(
  cwd: string,
  input: string,
): ResumeSessionResolution {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { kind: "not_found", input };
  }

  const sessionIds = projectSessionsCrossSlug(cwd);

  const exact = sessionIds.find((sessionId) => sessionId === trimmed);
  if (exact !== undefined) {
    return { kind: "ok", sessionId: exact };
  }

  const prefixMatches = sessionIds.filter((sessionId) =>
    sessionId.startsWith(trimmed),
  );
  if (prefixMatches.length === 1) {
    return { kind: "ok", sessionId: prefixMatches[0]! };
  }
  if (prefixMatches.length > 1) {
    return {
      kind: "ambiguous",
      input: trimmed,
      matches: prefixMatches.slice(0, 8),
    };
  }

  // Conv-id fallback: the id alone is unique across projects, so accept
  // a hit from any project slug as a valid resume target.
  if (isLikelyConvId(trimmed)) {
    const found = findConvIdGlobally(trimmed);
    if (found !== undefined) {
      return { kind: "ok", sessionId: found };
    }
  }

  return { kind: "not_found", input: trimmed };
}

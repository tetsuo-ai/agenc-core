/**
 * `/resume` — list resumable sessions from `~/.agenc/projects/<slug>/sessions/`.
 *
 * Walks every `rollout-*.jsonl` file under the per-project slug
 * directory, sorts by mtime (newest first), and returns up to 20 with
 * the session id + first-user-message preview. Full session hydration
 * is handled by the CLI `--resume <sessionId>` entry path; this command
 * is the in-session discovery surface.
 *
 * Flags:
 *   --last            Return only the newest session
 *   <uuid>            Filter to the session with that id
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  getProjectDir,
} from "../session/session-store.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

const MAX_SCAN_FILES = 10_000;
const DEFAULT_LIST_LIMIT = 20;

export interface RolloutEntry {
  readonly filePath: string;
  readonly sessionId: string;
  readonly mtimeMs: number;
  readonly firstUserPreview: string;
}

/**
 * Extract the session id from a rollout filename shaped like
 * `rollout-<iso>-<sessionId>.jsonl`.
 *
 * The ISO portion is produced by `buildRolloutFilename` as
 * `new Date(...).toISOString().replace(/[:.]/g, "-")`, e.g.
 * `2026-04-10T10-00-00-000Z`. We match that ISO block, strip it, and
 * treat whatever remains as the session id. Returns null on mismatch.
 */
export function sessionIdFromFilename(name: string): string | null {
  if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) return null;
  const body = name.slice("rollout-".length, -".jsonl".length);
  const m = body.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/,
  );
  if (m) return m[2]!;
  // Fallback for non-standard layouts: pick the trailing alnum segment
  // that is not purely numeric (avoids returning a millisecond segment).
  const parts = body.split("-");
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i]!;
    if (/^[A-Za-z0-9]{8,}$/.test(seg) && !/^\d+$/.test(seg)) return seg;
  }
  return parts[parts.length - 1] ?? null;
}

/** Read the first user-role message text from a rollout JSONL file.
 *  Kept bounded — only scans the first 64 lines. */
export function readFirstUserPreview(path: string): string {
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    const limit = Math.min(lines.length, 64);
    for (let i = 0; i < limit; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const previewFromItem = extractUserText(parsed);
      if (previewFromItem) return truncate(previewFromItem, 80);
    }
  } catch {
    /* unreadable — caller falls back to "" */
  }
  return "";
}

function extractUserText(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  // Try common shapes.
  if (typeof rec["content"] === "string" && rec["role"] === "user") {
    return rec["content"];
  }
  const payload = rec["payload"];
  if (payload && typeof payload === "object") {
    return extractUserText(payload);
  }
  // Codex rollout sometimes wraps ResponseItem; look for text fields.
  const text = rec["text"];
  if (typeof text === "string" && rec["role"] === "user") return text;
  return null;
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

/** Walk the sessions directory for this cwd. */
export function listResumableSessions(
  cwd: string,
  opts: { maxFiles?: number; limit?: number } = {},
): RolloutEntry[] {
  const maxFiles = opts.maxFiles ?? MAX_SCAN_FILES;
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const projectDir = getProjectDir(cwd);
  const sessionsRoot = join(projectDir, "sessions");
  const entries: RolloutEntry[] = [];
  let scanned = 0;

  let sessionDirs: string[] = [];
  try {
    sessionDirs = readdirSync(sessionsRoot);
  } catch {
    return [];
  }

  for (const dirName of sessionDirs) {
    if (scanned >= maxFiles) break;
    const dir = join(sessionsRoot, dirName);
    let inner: string[];
    try {
      inner = readdirSync(dir);
    } catch {
      continue;
    }
    for (const fname of inner) {
      if (scanned >= maxFiles) break;
      if (!fname.startsWith("rollout-") || !fname.endsWith(".jsonl")) continue;
      scanned++;
      const full = join(dir, fname);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const sessionId = sessionIdFromFilename(fname) ?? dirName;
      entries.push({
        filePath: full,
        sessionId,
        mtimeMs,
        firstUserPreview: "",
      });
    }
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = entries.slice(0, limit);
  // Populate previews lazily only for the top slice to keep the listing cheap.
  for (const e of top) {
    (e as { firstUserPreview: string }).firstUserPreview =
      readFirstUserPreview(e.filePath);
  }
  return top;
}

function formatEntries(entries: ReadonlyArray<RolloutEntry>): string {
  if (entries.length === 0) {
    return "No resumable sessions found for this project.";
  }
  const lines = ["Recent sessions (newest first):"];
  for (const e of entries) {
    const ts = new Date(e.mtimeMs).toISOString();
    const preview = e.firstUserPreview || "(no preview)";
    lines.push(`  ${ts}  ${e.sessionId}  — ${preview}`);
    lines.push(`    ${basename(e.filePath)}`);
  }
  lines.push("");
  lines.push(
    "Resume with: agenc --resume <sessionId>",
  );
  return lines.join("\n");
}

/**
 * Parse the args string. Supported forms:
 *   --last          → newest single entry
 *   <uuid-like>     → filter to that session id
 *   (empty)         → full list (up to 20)
 */
export function parseResumeArgs(argsRaw: string): {
  last: boolean;
  sessionId?: string;
} {
  const parts = argsRaw.trim().split(/\s+/).filter(Boolean);
  let last = false;
  let sessionId: string | undefined;
  for (const p of parts) {
    if (p === "--last") last = true;
    else if (/^[A-Za-z0-9][A-Za-z0-9-]{3,}$/.test(p) && !sessionId) sessionId = p;
  }
  const out: { last: boolean; sessionId?: string } = { last };
  if (sessionId !== undefined) out.sessionId = sessionId;
  return out;
}

export async function runResume(
  cwd: string,
  argsRaw: string,
): Promise<SlashCommandResult> {
  const parsed = parseResumeArgs(argsRaw);
  const all = listResumableSessions(cwd);

  if (parsed.sessionId) {
    const match = all.find((e) => e.sessionId === parsed.sessionId);
    if (!match) {
      return {
        kind: "text",
        text: `No session matching id '${parsed.sessionId}' found.`,
      };
    }
    return { kind: "text", text: formatEntries([match]) };
  }
  if (parsed.last) {
    return { kind: "text", text: formatEntries(all.slice(0, 1)) };
  }
  return { kind: "text", text: formatEntries(all) };
}

export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "List resumable sessions for this project",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => runResume(ctx.cwd, ctx.argsRaw)),
};

export default resumeCommand;

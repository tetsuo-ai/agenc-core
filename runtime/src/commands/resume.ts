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

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { FileThreadStore } from "../thread-store/store.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import { openResumeMenu } from "./resume-menu.js";

const MAX_SCAN_FILES = 2_000;
const DEFAULT_LIST_LIMIT = 20;
/** Preview reads are bounded: at most this many bytes / parsed lines. */
const PREVIEW_MAX_BYTES = 256 * 1024;
const PREVIEW_MAX_LINES = 64;

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

/**
 * Read the first user-role message text from a rollout JSONL file.
 * Bounded in BYTES as well as lines: rollout transcripts run to tens of MB,
 * and this used to `readFileSync` the whole file per picker row — the
 * dominant cost of the /resume freeze (bug-audit-2026-07-11.md #1). Now
 * streams at most PREVIEW_MAX_BYTES / PREVIEW_MAX_LINES.
 */
export function readFirstUserPreview(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let carry = "";
    let bytesConsumed = 0;
    let linesSeen = 0;
    while (bytesConsumed < PREVIEW_MAX_BYTES && linesSeen < PREVIEW_MAX_LINES) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytesConsumed += bytesRead;
      carry += buffer.toString("utf8", 0, bytesRead);
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (linesSeen >= PREVIEW_MAX_LINES) break;
        linesSeen += 1;
        const preview = previewFromLine(line);
        if (preview !== null) return preview;
      }
    }
    if (linesSeen < PREVIEW_MAX_LINES) {
      const preview = previewFromLine(carry);
      if (preview !== null) return preview;
    }
  } catch {
    /* unreadable — caller falls back to "" */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return "";
}

function previewFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const previewFromItem = extractUserText(parsed);
  return previewFromItem ? truncate(previewFromItem, 80) : null;
}

function extractUserText(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  if (rec["type"] === "user_message") {
    const payload = rec["payload"];
    if (payload && typeof payload === "object") {
      const message = (payload as Record<string, unknown>)["message"];
      if (typeof message === "string") return message;
    }
    const message = rec["message"];
    if (typeof message === "string") return message;
  }
  // Try common shapes.
  if (typeof rec["content"] === "string" && rec["role"] === "user") {
    return rec["content"];
  }
  const payload = rec["payload"];
  if (payload && typeof payload === "object") {
    return extractUserText(payload);
  }
  const msg = rec["msg"];
  if (msg && typeof msg === "object") {
    return extractUserText(msg);
  }
  // agenc runtime rollout sometimes wraps ResponseItem; look for text fields.
  const text = rec["text"];
  if (typeof text === "string" && rec["role"] === "user") return text;
  return null;
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

/** Read resumable sessions through the project thread store. */
export function listResumableSessions(
  cwd: string,
  opts: { maxFiles?: number; limit?: number } = {},
): RolloutEntry[] {
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const maxFiles = opts.maxFiles ?? MAX_SCAN_FILES;
  const store = new FileThreadStore({ cwd });
  const entries: RolloutEntry[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  try {
    while (entries.length < limit && scanned < maxFiles) {
      const page = store.listThreads({
        pageSize: Math.min(500, maxFiles - scanned),
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (page.items.length === 0) break;
      scanned += page.items.length;
      for (const thread of page.items) {
        if (entries.length >= limit) break;
        if (thread.rolloutPath === undefined) continue;
        let mtimeMs = Date.parse(thread.updatedAt);
        try {
          mtimeMs = statSync(thread.rolloutPath).mtimeMs;
        } catch {
          if (!Number.isFinite(mtimeMs)) continue;
        }
        // Preview comes from a bounded streaming read of the rollout head.
        // Never load the thread history here: `readThread({includeHistory})`
        // parses the ENTIRE transcript per row and re-reads the registry per
        // call — the /resume freeze (bug-audit-2026-07-11.md #1).
        const firstUserPreview = readFirstUserPreview(thread.rolloutPath);
        // Skip rollouts that never recorded a user message — those
        // sessions were opened and closed before the user typed
        // anything. They're not useful to resume to (there's no
        // content), and listing them as "(no preview)" entries makes
        // the picker noisier without adding signal.
        if (firstUserPreview === "") continue;
        entries.push({
          filePath: thread.rolloutPath,
          sessionId: thread.threadId,
          mtimeMs,
          firstUserPreview,
        });
      }
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
  } finally {
    store.close();
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, limit);
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

async function runResumeCommand(
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const parsed = parseResumeArgs(ctx.argsRaw);
  const all = listResumableSessions(ctx.cwd);

  if (!parsed.sessionId && !parsed.last && openResumeMenu(ctx, all)) {
    return { kind: "skip" };
  }
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
  aliases: ["sessions"],
  description: "List resumable sessions for this project",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => runResumeCommand(ctx)),
};

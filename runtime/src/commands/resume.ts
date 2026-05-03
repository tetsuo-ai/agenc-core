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

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { RolloutItem } from "../session/rollout-item.js";
import { FileThreadStore } from "../thread-store/index.js";
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
        const read = store.readThread({
          threadId: thread.threadId,
          includeArchived: false,
          includeHistory: true,
        });
        entries.push({
          filePath: thread.rolloutPath,
          sessionId: thread.threadId,
          mtimeMs,
          firstUserPreview:
            previewFromHistory(read.history?.items ?? []) ||
            readFirstUserPreview(thread.rolloutPath),
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

function previewFromHistory(items: ReadonlyArray<RolloutItem>): string {
  for (const item of items) {
    const preview = extractUserText(item);
    if (preview) return truncate(preview, 80);
  }
  return "";
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

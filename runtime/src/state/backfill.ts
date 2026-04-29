import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  parseRolloutLine,
  type RolloutItem,
} from "../session/rollout-item.js";
import { StateThreadRepository } from "./threads.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export interface BackfillProjectRolloutsOptions {
  readonly projectDir: string;
  readonly driver: StateSqliteDriver;
}

export interface BackfillResult {
  readonly filesScanned: number;
  readonly filesIndexed: number;
  readonly itemsIndexed: number;
}

export function backfillProjectRollouts(
  options: BackfillProjectRolloutsOptions,
): BackfillResult {
  const threads = new StateThreadRepository(options.driver);
  let filesScanned = 0;
  let filesIndexed = 0;
  let itemsIndexed = 0;
  for (const rolloutPath of listRolloutFiles(options.projectDir)) {
    filesScanned += 1;
    const result = backfillRolloutFile({
      rolloutPath,
      threads,
    });
    filesIndexed += 1;
    itemsIndexed += result.itemsIndexed;
  }
  return { filesScanned, filesIndexed, itemsIndexed };
}

export function backfillRolloutFile(options: {
  readonly rolloutPath: string;
  readonly threads: StateThreadRepository;
}): { readonly itemsIndexed: number } {
  const raw = readFileSync(options.rolloutPath, "utf8");
  const stat = statSync(options.rolloutPath);
  const threadId = threadIdFromRolloutPath(options.rolloutPath);
  const items: Array<{
    lineNumber: number;
    byteOffset: number;
    itemIndex: number;
    itemType: string;
    eventVersion?: number;
    eventId?: string;
    eventSeq?: number;
    payloadJson: string;
    lineHash: string;
  }> = [];
  let byteOffset = 0;
  let itemIndex = 0;
  let firstMeta: Extract<RolloutItem, { type: "session_meta" }> | undefined;
  let latestMeta: Extract<RolloutItem, { type: "session_meta" }> | undefined;
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (line.trim().length === 0) {
      byteOffset += lineBytes;
      continue;
    }
    const parsed = parseRolloutLine(line);
    if (parsed !== null) {
      if (parsed.type === "session_meta") {
        firstMeta ??= parsed;
        latestMeta = parsed;
      }
      items.push({
        lineNumber: i + 1,
        byteOffset,
        itemIndex,
        itemType: parsed.type,
        eventVersion: parsed.eventVersion,
        eventId:
          parsed.type === "event_msg" ? parsed.payload.id : undefined,
        eventSeq:
          parsed.type === "event_msg" ? parsed.payload.seq : undefined,
        payloadJson: JSON.stringify(parsed.payload),
        lineHash: createHash("sha256").update(line).digest("hex"),
      });
      itemIndex += 1;
    }
    byteOffset += lineBytes;
  }
  const now = new Date(stat.mtimeMs).toISOString();
  options.threads.upsertThread({
    threadId,
    createdAt: firstMeta?.payload.timestamp ?? now,
    updatedAt: latestMeta?.payload.timestamp ?? now,
    cwd: latestMeta?.payload.cwd ?? firstMeta?.payload.cwd,
    source: latestMeta?.payload.source ?? firstMeta?.payload.source,
    memoryMode: normalizeMemoryMode(latestMeta?.payload.memoryMode),
    rolloutPath: options.rolloutPath,
  });
  options.threads.replaceRolloutItems({
    threadId,
    sourcePath: options.rolloutPath,
    items,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256: createHash("sha256").update(raw).digest("hex"),
    lineCount: lines.length,
  });
  return { itemsIndexed: items.length };
}

function listRolloutFiles(projectDir: string): string[] {
  const roots = [join(projectDir, "sessions"), join(projectDir, "archived_sessions")];
  const result: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    collectRolloutFiles(root, result);
  }
  return result.sort();
}

function collectRolloutFiles(dir: string, result: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectRolloutFiles(full, result);
    } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
      result.push(full);
    }
  }
}

function threadIdFromRolloutPath(path: string): string {
  const name = basename(path);
  const body = name.slice("rollout-".length, -".jsonl".length);
  const match = body.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/,
  );
  return match?.[2] ?? basename(join(path, ".."));
}

function normalizeMemoryMode(value: unknown): "enabled" | "disabled" | undefined {
  return value === "enabled" || value === "disabled" ? value : undefined;
}

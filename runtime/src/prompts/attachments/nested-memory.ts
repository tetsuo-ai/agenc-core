/**
 * Nested-memory attachment producer.
 *
 * Hand-port of openclaude `getNestedMemoryAttachmentsForFile()`
 * (`src/utils/attachments.ts:1793-1863`), adapted to AgenC's instruction
 * filenames. Walks the directory hierarchy between `cwd` and each
 * file path mentioned in the latest user input, collecting
 * `AGENC.md` + `AGENC.local.md` files (the "Project" + "Local" tiers
 * from `agenc-md.ts`) along the way.
 *
 * AgenC does not currently ship the openclaude conditional/unconditional
 * `.claude/rules/*.md` system, so the four-phase walk collapses to:
 *
 *   - Phase 1 (Managed/User conditional rules): not implemented — AgenC
 *     does not yet expose conditional Managed/User instructions. The
 *     ambient `loadTieredInstructions()` already injects the
 *     unconditional Managed/User tiers into the system prompt.
 *   - Phase 2 (compute nestedDirs + cwdLevelDirs): implemented.
 *   - Phase 3 (per-nested-dir AGENC.md): implemented for AGENC.md and
 *     AGENC.local.md; the rules subsystem is omitted.
 *   - Phase 4 (cwd-level conditional rules): not implemented — same
 *     reason as phase 1.
 *
 * Trigger source: openclaude uses an explicit
 * `nestedMemoryAttachmentTriggers` set populated by `FileRead`. AgenC
 * does not have that trigger set, so the producer falls back to the
 * `@<path>` mentions in `opts.userInput`. When userInput has no
 * file mentions, the producer returns [].
 *
 * Dedup: emitted memory paths are recorded in `recordSessionRead` so
 * subsequent turns or producers do not re-inject the same file.
 *
 * @module
 */

import { readFile, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
} from "node:path";

import {
  hasSessionRead,
  recordSessionRead,
} from "../../tools/system/filesystem.js";
import { scanMentions } from "../file-mentions.js";
import {
  LOCAL_INSTRUCTION_FILENAME,
  USER_INSTRUCTION_FILENAME,
} from "../agenc-md.js";
import type { NestedMemoryAttachment } from "./types.js";
import type {
  AttachmentProducer,
  GetAttachmentsOptions,
} from "./orchestrator.js";

interface MemoryFileLoad {
  readonly path: string;
  readonly memoryType: NestedMemoryAttachment["memoryType"];
  readonly content: string;
  readonly mtimeMs: number;
}

/**
 * Pull the canonical session id off the opaque session-key object.
 * Production sessions expose `conversationId`; test fixtures sometimes
 * use `{ sessionId }` directly — accept both.
 */
function readSessionId(opts: GetAttachmentsOptions): string | undefined {
  const key = opts.sessionKey as {
    conversationId?: unknown;
    sessionId?: unknown;
  };
  if (
    typeof key.conversationId === "string" &&
    key.conversationId.length > 0
  ) {
    return key.conversationId;
  }
  if (typeof key.sessionId === "string" && key.sessionId.length > 0) {
    return key.sessionId;
  }
  return undefined;
}

/**
 * Mirror openclaude `getDirectoriesToProcess` (`attachments.ts:1657`).
 * Returns the chain of directories from `originalCwd` down to the file's
 * parent (`nestedDirs`, ordered cwd→target) and the chain of ancestors
 * from the filesystem root up to `originalCwd` (`cwdLevelDirs`, ordered
 * root→cwd).
 */
export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  const targetDir = dirname(resolve(targetPath));
  const nestedDirs: string[] = [];
  let currentDir = targetDir;
  while (
    currentDir !== originalCwd &&
    currentDir !== parsePath(currentDir).root
  ) {
    if (isAncestor(originalCwd, currentDir)) {
      nestedDirs.push(currentDir);
    }
    currentDir = dirname(currentDir);
  }
  nestedDirs.reverse();

  const cwdLevelDirs: string[] = [];
  currentDir = originalCwd;
  while (currentDir !== parsePath(currentDir).root) {
    cwdLevelDirs.push(currentDir);
    currentDir = dirname(currentDir);
  }
  cwdLevelDirs.reverse();

  return { nestedDirs, cwdLevelDirs };
}

function isAncestor(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

async function tryLoadFile(
  path: string,
  memoryType: NestedMemoryAttachment["memoryType"],
): Promise<MemoryFileLoad | null> {
  let raw: string;
  let st;
  try {
    raw = await readFile(path, "utf8");
    st = await stat(path);
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  return {
    path,
    memoryType,
    content: raw,
    mtimeMs: st.mtimeMs,
  };
}

/**
 * Collect the AGENC.md (+ AGENC.local.md) files for one walked
 * directory. Mirrors openclaude `getMemoryFilesForNestedDirectory`
 * (`claudemd.ts:1269`) restricted to the Project/Local tier files
 * AgenC actually ships.
 */
async function collectMemoryFilesForDirectory(
  dir: string,
): Promise<MemoryFileLoad[]> {
  const out: MemoryFileLoad[] = [];
  const projectFile = await tryLoadFile(
    join(dir, USER_INSTRUCTION_FILENAME),
    "Project",
  );
  if (projectFile !== null) out.push(projectFile);
  const localFile = await tryLoadFile(
    join(dir, LOCAL_INSTRUCTION_FILENAME),
    "Local",
  );
  if (localFile !== null) out.push(localFile);
  return out;
}

/**
 * Convert one collected memory file to the `nested_memory` attachment
 * shape, filtering out files already surfaced this session.
 */
function memoryToAttachment(
  load: MemoryFileLoad,
  cwd: string,
  sessionId: string | undefined,
): NestedMemoryAttachment | null {
  if (hasSessionRead(sessionId, load.path)) return null;
  recordSessionRead(sessionId, load.path, {
    rawContent: load.content,
    timestamp: load.mtimeMs,
    viewKind: "full",
  });
  const displayPath = load.path.startsWith(`${cwd}/`)
    ? relative(cwd, load.path)
    : load.path;
  return {
    kind: "nested_memory",
    path: load.path,
    displayPath,
    memoryType: load.memoryType,
    content: load.content,
    mtimeMs: load.mtimeMs,
  };
}

/**
 * Extract candidate file paths the user mentioned this turn. Falls back
 * to the AgenC-shared `scanMentions` parser, then keeps only entries
 * that resolve cleanly against `cwd`.
 */
function extractMentionedPaths(
  userInput: string,
  cwd: string,
): string[] {
  const mentions = scanMentions(userInput, cwd);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    if (!m.validation.ok) continue;
    if (seen.has(m.validation.resolved)) continue;
    seen.add(m.validation.resolved);
    out.push(m.validation.resolved);
  }
  return out;
}

export const nestedMemoryProducer: AttachmentProducer = async (opts) => {
  if (opts.userInput === null || opts.userInput.length === 0) return [];
  const mentioned = extractMentionedPaths(opts.userInput, opts.cwd);
  if (mentioned.length === 0) return [];

  const sessionId = readSessionId(opts);
  const out: NestedMemoryAttachment[] = [];
  const processedDirs = new Set<string>();

  for (const filePath of mentioned) {
    if (opts.signal.aborted) break;
    const { nestedDirs } = getDirectoriesToProcess(filePath, opts.cwd);
    // Walk the cwd → target chain. Skip dirs we already hit for an
    // earlier mention.
    for (const dir of nestedDirs) {
      if (processedDirs.has(dir)) continue;
      processedDirs.add(dir);
      const loads = await collectMemoryFilesForDirectory(dir);
      for (const load of loads) {
        const attachment = memoryToAttachment(load, opts.cwd, sessionId);
        if (attachment !== null) out.push(attachment);
      }
    }
  }
  return out;
};

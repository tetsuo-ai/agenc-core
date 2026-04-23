/**
 * Session-memory surface compact uses. The gut runtime does not own
 * openclaude's auto-extracted session-memory file. These resolvers
 * point at the standard gut memory location and report empty content
 * by default; setters/waiters are no-ops.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TRUNCATE_THRESHOLD_CHARS = 32_000;

function memoryDir(): string {
  return (
    process.env.AGENC_MEMORY_DIR ??
    join(
      process.env.AGENC_HOME ??
        join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agenc"),
      "memory",
    )
  );
}

export function getSessionMemoryPath(): string {
  return join(memoryDir(), "MEMORY.md");
}

export async function getSessionMemoryContent(): Promise<string | null> {
  const path = getSessionMemoryPath();
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  return !content || content.trim().length === 0;
}

export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string;
  wasTruncated: boolean;
} {
  if (content.length <= TRUNCATE_THRESHOLD_CHARS) {
    return { truncatedContent: content, wasTruncated: false };
  }
  return {
    truncatedContent: `${content.slice(0, TRUNCATE_THRESHOLD_CHARS)}\n[... truncated ${
      content.length - TRUNCATE_THRESHOLD_CHARS
    } chars ...]`,
    wasTruncated: true,
  };
}

let lastSummarizedMessageId: string | undefined;

export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId;
}

export function setLastSummarizedMessageId(id: string | undefined): void {
  lastSummarizedMessageId = id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function waitForSessionMemoryExtraction(): Promise<any> {
  return [];
}

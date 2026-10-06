import { createHash } from "node:crypto";

export function normalizePromptCacheKey(key: string): string {
  // Preserve existing cache routing unless the key exceeds the wire limit.
  return key.length <= 64
    ? key
    : createHash("sha256").update(key).digest("hex");
}

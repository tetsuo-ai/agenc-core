import { createHash } from "node:crypto";
import type { RelevantMemoriesAttachment } from "./types.js";

/** Identity of the rendered memory version, excluding runtime citation metadata. */
export function relevantMemoryFingerprint(
  memory: RelevantMemoriesAttachment["memories"][number],
): string {
  return createHash("sha256").update(JSON.stringify([
    memory.path,
    memory.header ?? null,
    memory.content,
    memory.limit ?? null,
  ])).digest("hex");
}

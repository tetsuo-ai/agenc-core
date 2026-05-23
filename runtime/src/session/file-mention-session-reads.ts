import type { Attachment } from "../prompts/attachments/types.js";
import type { FileMentionAttachment } from "../prompts/file-mentions.js";
import {
  canonicalizePath,
  seedSessionReadState,
  type SessionReadSeedEntry,
} from "../tools/system/filesystem.js";

export async function seedFileMentionSessionReads(
  sessionId: string | undefined,
  files: readonly FileMentionAttachment[],
): Promise<void> {
  if (!sessionId || sessionId.trim().length === 0 || files.length === 0) {
    return;
  }

  const entries: SessionReadSeedEntry[] = [];
  for (const file of files) {
    if (file.truncated) continue;
    const canonicalPath =
      typeof file.canonicalResolved === "string" &&
      file.canonicalResolved.length > 0
        ? file.canonicalResolved
        : await canonicalizePath(file.resolved);
    entries.push({
      path: canonicalPath,
      content: file.content,
      rawContent: file.rawContent,
      timestamp:
        typeof file.mtimeMs === "number" && Number.isFinite(file.mtimeMs)
          ? file.mtimeMs
          : Date.now(),
      viewKind: "full",
    });
  }

  if (entries.length > 0) {
    seedSessionReadState(sessionId, entries);
  }
}

export async function seedFileMentionAttachmentSessionReads(
  sessionId: string | undefined,
  attachments: readonly Attachment[],
): Promise<void> {
  const files = attachments
    .filter((attachment) => attachment.kind === "file_mention")
    .flatMap((attachment) => attachment.files);
  await seedFileMentionSessionReads(sessionId, files);
}

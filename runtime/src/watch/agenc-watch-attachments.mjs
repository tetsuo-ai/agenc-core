import path from "node:path";

export const DEFAULT_WATCH_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const EXTENSION_TO_MIME = Object.freeze({
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".text": "text/plain",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
});

function sanitizeAttachmentText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function compactAttachmentPath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function formatAttachmentBytes(sizeBytes) {
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size < 0) {
    return "size unknown";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function attachmentTypeFromMime(mimeType) {
  const normalized = sanitizeAttachmentText(mimeType, "application/octet-stream").toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  return "file";
}

export function detectWatchAttachmentMimeType(filePath) {
  const extension = path.extname(String(filePath ?? "")).toLowerCase();
  return EXTENSION_TO_MIME[extension] ?? "application/octet-stream";
}

export function formatQueuedWatchAttachment(attachment, { index = null } = {}) {
  if (!attachment || typeof attachment !== "object") {
    return "";
  }
  const prefix = Number.isFinite(Number(index)) ? `${Number(index)}. ` : "- ";
  const id = sanitizeAttachmentText(attachment.id);
  const filename = sanitizeAttachmentText(attachment.filename, "attachment");
  const mimeType = sanitizeAttachmentText(attachment.mimeType, "application/octet-stream");
  const displayPath = sanitizeAttachmentText(
    attachment.displayPath ?? attachment.path,
    filename,
  );
  const sizeLabel = formatAttachmentBytes(attachment.sizeBytes);
  return `${prefix}${filename} [${id || "pending"}]  ${mimeType}  ${sizeLabel}  ${displayPath}`;
}

export function formatQueuedWatchAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "No attachments queued.";
  }
  return attachments
    .map((attachment, index) =>
      formatQueuedWatchAttachment(attachment, { index: index + 1 }))
    .join("\n");
}

export function createQueuedWatchAttachment({
  fs,
  pathModule = path,
  inputPath,
  projectRoot = process.cwd(),
  id,
  maxBytes = DEFAULT_WATCH_ATTACHMENT_MAX_BYTES,
} = {}) {
  const rawPath = sanitizeAttachmentText(inputPath);
  if (!rawPath) {
    throw new Error("Usage: /attach <path>");
  }
  const resolvedPath = pathModule.resolve(projectRoot, rawPath);
  let realPath;
  try {
    realPath =
      typeof fs.realpathSync?.native === "function"
        ? fs.realpathSync.native(resolvedPath)
        : fs.realpathSync(resolvedPath);
  } catch {
    realPath = resolvedPath;
  }
  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not attach ${rawPath}: ${detail}`);
  }
  if (typeof stat?.isFile === "function" && stat.isFile() !== true) {
    throw new Error(`Could not attach ${rawPath}: not a regular file`);
  }
  const sizeBytes = Number.isFinite(Number(stat?.size)) ? Number(stat.size) : 0;
  if (sizeBytes > maxBytes) {
    throw new Error(
      `Could not attach ${rawPath}: file exceeds ${formatAttachmentBytes(maxBytes)}`,
    );
  }
  const relativePath = pathModule.relative(projectRoot, realPath);
  const displayPath =
    relativePath && !relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath)
      ? compactAttachmentPath(relativePath)
      : compactAttachmentPath(realPath);
  const mimeType = detectWatchAttachmentMimeType(realPath);
  return {
    id: sanitizeAttachmentText(id, null),
    path: realPath,
    displayPath,
    filename: pathModule.basename(realPath),
    mimeType,
    type: attachmentTypeFromMime(mimeType),
    sizeBytes,
  };
}

export function resolveQueuedWatchAttachmentPayloads(
  attachments = [],
  {
    fs,
    maxBytes = DEFAULT_WATCH_ATTACHMENT_MAX_BYTES,
  } = {},
) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }
  return attachments.map((attachment) => {
    const sourcePath = sanitizeAttachmentText(attachment?.path);
    if (!sourcePath) {
      throw new Error("Attachment is missing a source path");
    }
    let buffer;
    try {
      buffer = fs.readFileSync(sourcePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read attachment ${sourcePath}: ${detail}`);
    }
    const sizeBytes = Number.isFinite(Number(attachment?.sizeBytes))
      ? Number(attachment.sizeBytes)
      : buffer.byteLength;
    if (sizeBytes > maxBytes || buffer.byteLength > maxBytes) {
      throw new Error(
        `Could not attach ${sanitizeAttachmentText(attachment?.filename, sourcePath)}: file exceeds ${formatAttachmentBytes(maxBytes)}`,
      );
    }
    const mimeType = sanitizeAttachmentText(
      attachment?.mimeType,
      "application/octet-stream",
    );
    return {
      type: sanitizeAttachmentText(attachment?.type, attachmentTypeFromMime(mimeType)),
      mimeType,
      filename: sanitizeAttachmentText(
        attachment?.filename,
        path.basename(sourcePath),
      ),
      sizeBytes,
      data: buffer.toString("base64"),
    };
  });
}

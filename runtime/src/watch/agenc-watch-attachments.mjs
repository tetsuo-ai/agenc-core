import path from "node:path";

export const DEFAULT_WATCH_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_WATCH_ATTACHMENT_WAIT_FOR_FILE_MS = 1500;
export const DEFAULT_WATCH_ATTACHMENT_WAIT_INTERVAL_MS = 50;

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

const WATCH_ATTACHMENT_TRAILING_STATUS_SUFFIXES = Object.freeze([
  "read",
]);

function sanitizeAttachmentText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function sanitizeAttachmentPathInput(value) {
  return String(value ?? "").trim();
}

function compactAttachmentPath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function stripWatchAttachmentTrailingStatusSuffix(value, { pathModule = path } = {}) {
  const normalizedValue = sanitizeAttachmentPathInput(value);
  if (!normalizedValue) {
    return "";
  }

  const compactPath = compactAttachmentPath(normalizedValue);
  const looksLikeLocalPath =
    compactPath.startsWith("./") ||
    compactPath.startsWith("../") ||
    compactPath.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(normalizedValue) ||
    pathModule.isAbsolute(normalizedValue);
  if (!looksLikeLocalPath) {
    return normalizedValue;
  }

  for (const suffix of WATCH_ATTACHMENT_TRAILING_STATUS_SUFFIXES) {
    const marker = ` ${suffix}`;
    if (!normalizedValue.endsWith(marker)) {
      continue;
    }

    const candidatePath = normalizedValue.slice(0, -marker.length).trimEnd();
    const basename = pathModule.basename(candidatePath);
    const extension = pathModule.extname(basename);
    const looksLikeNamedFile = extension.length > 1 && basename.length > extension.length;
    const looksLikeMacScreenshotPromisePath =
      compactAttachmentPath(candidatePath).includes("/NSIRD_screencaptureui_") &&
      /^Screenshot(?:\s|$)/.test(basename);

    if (looksLikeNamedFile || looksLikeMacScreenshotPromisePath) {
      return candidatePath;
    }
  }

  return normalizedValue;
}

function isMissingAttachmentError(error) {
  const code = error && typeof error === "object" ? error.code : null;
  return code === "ENOENT" || code === "ENOTDIR";
}

const WATCH_ATTACHMENT_SLEEP_VIEW =
  typeof SharedArrayBuffer === "function"
    ? new Int32Array(new SharedArrayBuffer(4))
    : null;

function sleepWatchAttachment(ms) {
  const durationMs = Number(ms);
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    WATCH_ATTACHMENT_SLEEP_VIEW === null ||
    typeof Atomics?.wait !== "function"
  ) {
    return;
  }
  Atomics.wait(WATCH_ATTACHMENT_SLEEP_VIEW, 0, 0, durationMs);
}

function resolveWatchAttachmentDisplayPath(pathModule, projectRoot, resolvedPath) {
  const relativePath = pathModule.relative(projectRoot, resolvedPath);
  return relativePath && !relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath)
    ? compactAttachmentPath(relativePath)
    : compactAttachmentPath(resolvedPath);
}

function isLikelyWatchAttachmentInputPath(inputPath, { pathModule = path } = {}) {
  const normalizedPath = normalizeWatchAttachmentInputPath(inputPath);
  if (!normalizedPath) {
    return false;
  }
  const compactPath = compactAttachmentPath(normalizedPath);
  if (
    compactPath.startsWith("./") ||
    compactPath.startsWith("../") ||
    compactPath.startsWith("~/")
  ) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(normalizedPath)) {
    return compactPath.includes("/");
  }
  return pathModule.isAbsolute(normalizedPath) && compactPath.slice(1).includes("/");
}

function statWatchAttachmentPath(fs, sourcePath) {
  let realPath;
  try {
    realPath =
      typeof fs.realpathSync?.native === "function"
        ? fs.realpathSync.native(sourcePath)
        : fs.realpathSync(sourcePath);
  } catch {
    realPath = sourcePath;
  }
  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch (error) {
    return {
      realPath,
      stat: null,
      error,
    };
  }
  if (typeof stat?.isFile === "function" && stat.isFile() !== true) {
    return {
      realPath,
      stat: null,
      error: new Error(`Could not attach ${sourcePath}: not a regular file`),
    };
  }
  return {
    realPath,
    stat,
    error: null,
  };
}

function waitForWatchAttachmentPath(
  fs,
  sourcePath,
  {
    waitForFileMs = DEFAULT_WATCH_ATTACHMENT_WAIT_FOR_FILE_MS,
    waitForFileIntervalMs = DEFAULT_WATCH_ATTACHMENT_WAIT_INTERVAL_MS,
  } = {},
) {
  const timeoutMs = Math.max(0, Number(waitForFileMs) || 0);
  const intervalMs = Math.max(1, Number(waitForFileIntervalMs) || 1);
  const deadline = Date.now() + timeoutMs;
  let lastAttempt = statWatchAttachmentPath(fs, sourcePath);
  while (lastAttempt.stat === null && isMissingAttachmentError(lastAttempt.error) && Date.now() < deadline) {
    sleepWatchAttachment(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    lastAttempt = statWatchAttachmentPath(fs, sourcePath);
  }
  return lastAttempt;
}

export function normalizeWatchAttachmentInputPath(inputPath) {
  let rawPath = sanitizeAttachmentPathInput(inputPath);
  if (!rawPath) {
    return "";
  }

  if (
    (rawPath.startsWith('"') && rawPath.endsWith('"')) ||
    (rawPath.startsWith("'") && rawPath.endsWith("'"))
  ) {
    rawPath = rawPath.slice(1, -1);
  }

  if (rawPath.startsWith("file://")) {
    try {
      rawPath = decodeURI(new URL(rawPath).pathname);
    } catch {
      // Keep the original string if it is not a valid file URL.
    }
  }

  let normalized = "";
  for (let index = 0; index < rawPath.length; index += 1) {
    if (rawPath[index] === "\\" && index + 1 < rawPath.length) {
      normalized += rawPath[index + 1];
      index += 1;
      continue;
    }
    normalized += rawPath[index];
  }

  return stripWatchAttachmentTrailingStatusSuffix(normalized.trim());
}

export function resolveWatchAttachmentInputPath({
  fs,
  pathModule = path,
  inputPath,
  projectRoot = process.cwd(),
} = {}) {
  const normalizedPath = normalizeWatchAttachmentInputPath(inputPath);
  if (!normalizedPath) {
    return null;
  }

  const resolvedPath = pathModule.resolve(projectRoot, normalizedPath);
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
  } catch {
    return isLikelyWatchAttachmentInputPath(normalizedPath, { pathModule })
      ? normalizedPath
      : null;
  }
  if (typeof stat?.isFile === "function" && stat.isFile() !== true) {
    return null;
  }

  return normalizedPath;
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
  allowMissing = false,
} = {}) {
  const rawPath = normalizeWatchAttachmentInputPath(inputPath);
  if (!rawPath) {
    throw new Error("Usage: /attach <path>");
  }
  const resolvedPath = pathModule.resolve(projectRoot, rawPath);
  const attachmentPathState = statWatchAttachmentPath(fs, resolvedPath);
  if (attachmentPathState.stat === null) {
    if (allowMissing !== true || isLikelyWatchAttachmentInputPath(rawPath, { pathModule }) !== true) {
      const detail =
        attachmentPathState.error instanceof Error
          ? attachmentPathState.error.message
          : String(attachmentPathState.error);
      throw new Error(`Could not attach ${rawPath}: ${detail}`);
    }
  }
  const sizeBytes = Number.isFinite(Number(attachmentPathState.stat?.size))
    ? Number(attachmentPathState.stat.size)
    : null;
  if (sizeBytes !== null && sizeBytes > maxBytes) {
    throw new Error(`Could not attach ${rawPath}: file exceeds ${formatAttachmentBytes(maxBytes)}`);
  }
  const displayPath = resolveWatchAttachmentDisplayPath(pathModule, projectRoot, resolvedPath);
  const effectivePath = attachmentPathState.stat ? attachmentPathState.realPath : resolvedPath;
  const mimeType = detectWatchAttachmentMimeType(effectivePath);
  return {
    id: sanitizeAttachmentText(id, null),
    path: effectivePath,
    displayPath,
    filename: pathModule.basename(resolvedPath),
    mimeType,
    type: attachmentTypeFromMime(mimeType),
    sizeBytes,
    missing: attachmentPathState.stat === null,
  };
}

export function resolveQueuedWatchAttachmentPayloads(
  attachments = [],
  {
    fs,
    maxBytes = DEFAULT_WATCH_ATTACHMENT_MAX_BYTES,
    waitForFileMs = DEFAULT_WATCH_ATTACHMENT_WAIT_FOR_FILE_MS,
    waitForFileIntervalMs = DEFAULT_WATCH_ATTACHMENT_WAIT_INTERVAL_MS,
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
    let effectivePath = sourcePath;
    let effectiveStat = null;
    if (attachment?.missing === true) {
      const waited = waitForWatchAttachmentPath(fs, sourcePath, {
        waitForFileMs,
        waitForFileIntervalMs,
      });
      if (waited.stat === null) {
        const detail =
          waited.error instanceof Error ? waited.error.message : String(waited.error);
        throw new Error(`Could not read attachment ${sourcePath}: ${detail}`);
      }
      effectivePath = waited.realPath;
      effectiveStat = waited.stat;
    }
    let buffer;
    try {
      buffer = fs.readFileSync(effectivePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read attachment ${effectivePath}: ${detail}`);
    }
    const sizeBytes =
      Number.isFinite(Number(attachment?.sizeBytes)) && Number(attachment.sizeBytes) >= 0
      ? Number(attachment.sizeBytes)
      : Number.isFinite(Number(effectiveStat?.size))
        ? Number(effectiveStat.size)
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

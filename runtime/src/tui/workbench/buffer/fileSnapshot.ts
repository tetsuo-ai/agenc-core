import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { getCwd } from "../../../utils/cwd.js";
import { isRelativePathOutsideBase } from "../../pathDisplay.js";

export type BufferFileEncoding = "utf8" | "utf16le";
export type BufferLineEndings = "LF" | "CRLF";

export const BUFFER_MAX_FILE_BYTES = 5 * 1024 * 1024;

export type BufferFileSnapshot = {
  readonly filePath: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly encoding: BufferFileEncoding;
  readonly lineEndings: BufferLineEndings;
};

export class BufferFileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
    readonly maxSize: number,
  ) {
    super(`${path} is ${size} bytes, which exceeds the editable buffer limit of ${maxSize} bytes.`);
    this.name = "BufferFileTooLargeError";
  }
}

export class BufferBinaryFileError extends Error {
  constructor(readonly path: string) {
    super(`${path} appears to be binary and cannot be edited in BUFFER.`);
    this.name = "BufferBinaryFileError";
  }
}

export class BufferSaveConflictError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed on disk after the buffer was opened. Revert or reopen before saving.`);
    this.name = "BufferSaveConflictError";
  }
}

export class BufferUnsafePathError extends Error {
  constructor(readonly path: string) {
    super(`${path} is outside the current AgenC workspace and cannot be opened in BUFFER.`);
    this.name = "BufferUnsafePathError";
  }
}

export function resolveBufferFilePath(filePath: string, basePath = getCwd()): string {
  const absoluteBasePath = realpathOrResolved(basePath);
  const absolutePath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(absoluteBasePath, filePath);
  assertPathInsideBase(absolutePath, absoluteBasePath, filePath);
  const realAbsolutePath = realpathIfExists(absolutePath);
  if (realAbsolutePath) assertPathInsideBase(realAbsolutePath, absoluteBasePath, filePath);
  return absolutePath;
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function realpathIfExists(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertPathInsideBase(path: string, basePath: string, displayPath: string): void {
  const relativePath = relative(basePath, path);
  if (isRelativePathOutsideBase(relativePath)) {
    throw new BufferUnsafePathError(displayPath);
  }
}

function detectEncoding(buffer: Buffer): BufferFileEncoding {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? "utf16le"
    : "utf8";
}

function detectLineEndings(content: string): BufferLineEndings {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== "\n") continue;
    if (i > 0 && content[i - 1] === "\r") crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? "CRLF" : "LF";
}

function decodeText(buffer: Buffer, encoding: BufferFileEncoding): string {
  const decoded = buffer.toString(encoding);
  return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function assertEditableBytes(path: string, buffer: Buffer, encoding: BufferFileEncoding): void {
  if (encoding === "utf16le") return;
  if (buffer.includes(0)) throw new BufferBinaryFileError(path);
}

function encodeText(content: string, snapshot: BufferFileSnapshot): string {
  const withLineEndings =
    snapshot.lineEndings === "CRLF"
      ? content.replaceAll("\r\n", "\n").split("\n").join("\r\n")
      : content;
  return snapshot.encoding === "utf16le" ? `\ufeff${withLineEndings}` : withLineEndings;
}

export async function readBufferFileSnapshot(
  filePath: string,
  options: { readonly maxBytes?: number; readonly displayPath?: string } = {},
): Promise<BufferFileSnapshot> {
  const absolutePath = resolveBufferFilePath(filePath);
  return readAbsoluteBufferFileSnapshot(absolutePath, options.displayPath ?? filePath, options.maxBytes);
}

async function readAbsoluteBufferFileSnapshot(
  absolutePath: string,
  displayPath: string,
  maxBytes = BUFFER_MAX_FILE_BYTES,
): Promise<BufferFileSnapshot> {
  const stats = await stat(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a regular file: ${displayPath}`);
  }
  if (stats.size > maxBytes) {
    throw new BufferFileTooLargeError(displayPath, stats.size, maxBytes);
  }

  const buffer = await readFile(absolutePath);
  const encoding = detectEncoding(buffer);
  assertEditableBytes(displayPath, buffer, encoding);
  const rawText = decodeText(buffer, encoding);
  return {
    filePath: displayPath,
    absolutePath,
    content: normalizeText(rawText),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    encoding,
    lineEndings: detectLineEndings(rawText),
  };
}

async function readCurrentContent(snapshot: BufferFileSnapshot): Promise<string> {
  const buffer = await readFile(snapshot.absolutePath);
  const encoding = detectEncoding(buffer);
  assertEditableBytes(snapshot.filePath, buffer, encoding);
  return normalizeText(decodeText(buffer, encoding));
}

export async function saveBufferFileSnapshot(
  snapshot: BufferFileSnapshot,
  content: string,
  options: { readonly force?: boolean } = {},
): Promise<BufferFileSnapshot> {
  const force = options.force === true;
  const currentStats = await stat(snapshot.absolutePath).catch((error) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" && force) return;
    if (code === "ENOENT") throw new BufferSaveConflictError(snapshot.filePath);
    throw error;
  });

  if (!force) {
    if (currentStats && currentStats.mtimeMs !== snapshot.mtimeMs) {
      throw new BufferSaveConflictError(snapshot.filePath);
    }
    const currentContent = await readCurrentContent(snapshot);
    if (currentContent !== snapshot.content && currentContent !== content) {
      throw new BufferSaveConflictError(snapshot.filePath);
    }
  }

  await mkdir(dirname(snapshot.absolutePath), { recursive: true });
  await writeFile(snapshot.absolutePath, encodeText(content, snapshot), snapshot.encoding);
  return readAbsoluteBufferFileSnapshot(snapshot.absolutePath, snapshot.filePath);
}

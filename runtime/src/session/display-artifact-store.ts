import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, lstatSync, rmSync, unlinkSync, linkSync, renameSync, readSync, fstatSync, constants } from "node:fs";
import { join } from "node:path";
import { DISPLAY_BINARY_LIMIT, DISPLAY_FILE_LIMIT, DISPLAY_JSON_LIMIT, peekDisplayArtifactBytes, releaseDisplayArtifactBytes, type DisplayAttachment } from "../mcp-client/display-attachments.js";

const ARTIFACT_DIRECTORY = "display-artifacts";
const ID = /^[a-f0-9]{64}$/u;
export const DISPLAY_ARTIFACT_CHUNK_BYTES = 512 * 1024;

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    try { fsyncSync(fd); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) throw error;
    }
  } finally { closeSync(fd); }
}

/** Session scoped, immutable, content addressed bytes. The caller supplies a
 * session directory from the durable session store, never from MCP or RPC. */
export function persistDisplayAttachments(sessionDir: string, pending: readonly DisplayAttachment[]): DisplayAttachment[] {
  const persisted = pending.map(item => {
    const limit = item.kind === "file" ? DISPLAY_FILE_LIMIT : item.kind === "image" ? DISPLAY_BINARY_LIMIT : DISPLAY_JSON_LIMIT;
    if (item.size > limit) throw new Error("display artifact exceeds size limit");
    const bytes = peekDisplayArtifactBytes(item);
    if (!bytes) throw new Error("display artifact bytes unavailable");
    const id = createHash("sha256").update(bytes).digest("hex");
    if (id !== item.digest || bytes.length !== item.size) throw new Error("display artifact digest mismatch");
    persistDisplayArtifactBytes(sessionDir, bytes);
    return item;
  });
  for (const item of pending) releaseDisplayArtifactBytes(item);
  return persisted;
}

/** Publish transcript text through the same durable content-addressed store. */
export function persistDisplayArtifactBytes(sessionDir: string, bytes: Buffer): string {
  if (bytes.length > DISPLAY_FILE_LIMIT) throw new Error("display artifact exceeds size limit");
  const id = createHash("sha256").update(bytes).digest("hex");
  const root = join(sessionDir, ARTIFACT_DIRECTORY);
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(root).isDirectory()) throw new Error("display artifact directory is not a directory");
  // A prior creation may have failed its parent fsync while leaving root in
  // place. Re-establish this proof before every successful publication.
  fsyncDirectory(sessionDir);
  const path = join(root, id);
  const temporary = join(root, `.pending-${randomUUID()}`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // An older interrupted direct write may have left this digest path
      // empty or partial. Replace it with a complete fsynced file.
      const existing = readFileSync(path);
      if (createHash("sha256").update(existing).digest("hex") !== id) {
        renameSync(temporary, path);
      }
    }
    fsyncDirectory(root);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed or never created */ }
  }
  return id;
}

export function readDisplayArtifactChunk(sessionDir: string, id: string, offset: number, length = DISPLAY_ARTIFACT_CHUNK_BYTES): { readonly data: Buffer; readonly size: number; readonly nextOffset: number | null } {
  if (!ID.test(id)) throw new Error("invalid display artifact id");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > DISPLAY_ARTIFACT_CHUNK_BYTES) throw new Error("invalid display artifact range");
  const root = join(sessionDir, ARTIFACT_DIRECTORY);
  if (!lstatSync(root).isDirectory()) throw new Error("invalid display artifact directory");
  const path = join(root, id);
  if (!lstatSync(path).isFile()) throw new Error("invalid display artifact file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("invalid display artifact file");
    const size = Number(before.size);
    if (size > DISPLAY_FILE_LIMIT || offset > size) throw new Error("display artifact exceeds size limit or invalid offset");
    // Verify the content address with bounded reads from this descriptor.
    // Each RPC is independent, so a client may start at any valid offset.
    const hash = createHash("sha256");
    const verifyBuffer = Buffer.allocUnsafe(DISPLAY_ARTIFACT_CHUNK_BYTES);
    for (let position = 0; position < size;) {
      const count = readSync(fd, verifyBuffer, 0, Math.min(verifyBuffer.length, size - position), position);
      if (count === 0) throw new Error("display artifact changed during read");
      hash.update(verifyBuffer.subarray(0, count));
      position += count;
    }
    if (hash.digest("hex") !== id) throw new Error("display artifact digest mismatch");
    const data = Buffer.alloc(Math.min(length, size - offset));
    let read = 0;
    while (read < data.length) {
      const count = readSync(fd, data, read, data.length - read, offset + read);
      if (count === 0) throw new Error("display artifact changed during read");
      read += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error("display artifact changed during read");
    return { data, size, nextOffset: offset + read < size ? offset + read : null };
  } finally { closeSync(fd); }
}

export function readDisplayArtifact(sessionDir: string, id: string): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = readDisplayArtifactChunk(sessionDir, id, offset);
    chunks.push(chunk.data);
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== id) throw new Error("display artifact digest mismatch");
  return bytes;
}

export function removeDisplayArtifacts(sessionDir: string): void {
  rmSync(join(sessionDir, ARTIFACT_DIRECTORY), { recursive: true, force: true });
}

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, lstatSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DISPLAY_BINARY_LIMIT, DISPLAY_FILE_LIMIT, DISPLAY_JSON_LIMIT, takeDisplayArtifactBytes, type DisplayAttachment } from "../mcp-client/display-attachments.js";

const ARTIFACT_DIRECTORY = "display-artifacts";
const ID = /^[a-f0-9]{64}$/u;

function fsyncDirectoryBestEffort(path: string): void {
  try {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* directory fsync is unavailable on some filesystems */ }
}

/** Session scoped, immutable, content addressed bytes. The caller supplies a
 * session directory from the durable session store, never from MCP or RPC. */
export function persistDisplayAttachments(sessionDir: string, pending: readonly DisplayAttachment[]): DisplayAttachment[] {
  const root = join(sessionDir, ARTIFACT_DIRECTORY);
  const rootExisted = existsSync(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory()) throw new Error("display artifact directory is not a directory");
  if (!rootExisted) fsyncDirectoryBestEffort(sessionDir);
  return pending.map(item => {
    const limit = item.kind === "file" ? DISPLAY_FILE_LIMIT : item.kind === "image" ? DISPLAY_BINARY_LIMIT : DISPLAY_JSON_LIMIT;
    if (item.size > limit) throw new Error("display artifact exceeds size limit");
    const bytes = takeDisplayArtifactBytes(item);
    if (!bytes) throw new Error("display artifact bytes unavailable");
    const id = createHash("sha256").update(bytes).digest("hex");
    if (id !== item.digest || bytes.length !== item.size) throw new Error("display artifact digest mismatch");
    const path = join(root, id);
    let created = false;
    let opened = false;
    try {
      const fd = openSync(path, "wx", 0o600);
      opened = true;
      try { writeFileSync(fd, bytes); fsyncSync(fd); created = true; }
      finally { closeSync(fd); }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (opened) try { unlinkSync(path); } catch { /* preserve primary error */ }
        throw error;
      }
      const existing = readFileSync(path);
      if (createHash("sha256").update(existing).digest("hex") !== id) throw new Error("display artifact collision");
    }
    if (created) fsyncDirectoryBestEffort(root);
    return item;
  });
}

export function readDisplayArtifact(sessionDir: string, id: string): Buffer {
  if (!ID.test(id)) throw new Error("invalid display artifact id");
  const root = join(sessionDir, ARTIFACT_DIRECTORY);
  if (!lstatSync(root).isDirectory()) throw new Error("invalid display artifact directory");
  const path = join(root, id);
  if (!lstatSync(path).isFile()) throw new Error("invalid display artifact file");
  if (lstatSync(path).size > DISPLAY_FILE_LIMIT) throw new Error("display artifact exceeds size limit");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== id) throw new Error("display artifact digest mismatch");
  return bytes;
}

export function removeDisplayArtifacts(sessionDir: string): void {
  rmSync(join(sessionDir, ARTIFACT_DIRECTORY), { recursive: true, force: true });
}

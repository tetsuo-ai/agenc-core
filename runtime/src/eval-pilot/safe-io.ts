import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { EVALUATION_PILOT_MAXIMUM_ARTIFACT_BYTES } from "./types.js";
import { EvaluationPilotValidationError } from "./validation.js";

export interface StableDirectory {
  readonly path: string;
  readonly canonicalPath: string;
  readonly stat: BigIntStats;
}

function assertNoDuplicateObjectKeys(text: string, file: string): void {
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const scanString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new EvaluationPilotValidationError([`${file} contains an unterminated JSON string`]);
  };
  const scanValue = (): void => {
    skipWhitespace();
    if (text[offset] === "{") {
      offset += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        skipWhitespace();
        const key = scanString();
        if (keys.has(key)) {
          throw new EvaluationPilotValidationError([
            `${file} contains duplicate JSON object key ${JSON.stringify(key)}`,
          ]);
        }
        keys.add(key);
        skipWhitespace();
        offset += 1;
        scanValue();
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        offset += 1;
      }
      return;
    }
    if (text[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        scanValue();
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        offset += 1;
      }
      return;
    }
    if (text[offset] === '"') {
      scanString();
      return;
    }
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset] ?? "")) offset += 1;
  };
  scanValue();
}

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

export async function openStableDirectory(directory: string, label: string): Promise<StableDirectory> {
  const resolved = path.resolve(directory);
  const before = await lstat(resolved, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new EvaluationPilotValidationError([`${label} must be a real non-symlink directory`]);
  }
  const canonicalPath = await realpath(resolved);
  const after = await lstat(resolved, { bigint: true });
  if (!after.isDirectory() || !sameObject(before, after)) {
    throw new EvaluationPilotValidationError([`${label} changed while resolving`]);
  }
  return { path: resolved, canonicalPath, stat: after };
}

export async function assertStableDirectory(directory: StableDirectory, label: string): Promise<void> {
  const current = await lstat(directory.path, { bigint: true });
  if (current.isSymbolicLink() || !current.isDirectory() || !sameObject(directory.stat, current)) {
    throw new EvaluationPilotValidationError([`${label} changed while loading the pilot`]);
  }
  const canonical = await realpath(directory.path);
  if (canonical !== directory.canonicalPath) {
    throw new EvaluationPilotValidationError([`${label} resolved to a different directory`]);
  }
}

export async function readBoundedRegularFile(
  file: string,
  maximumBytes: number,
  expectedRoot?: string,
): Promise<Uint8Array> {
  const resolved = path.resolve(file);
  const pathBefore = await lstat(resolved, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new EvaluationPilotValidationError([`${resolved} must be a regular non-symlink file`]);
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(resolved, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      !sameObject(before, pathBefore) ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new EvaluationPilotValidationError([
        `${resolved} exceeds ${maximumBytes} bytes, is not regular, or changed before open`,
      ]);
    }
    if (expectedRoot) {
      const openedPath = process.platform === "linux"
        ? await realpath(`/proc/self/fd/${handle.fd}`)
        : await realpath(resolved);
      const openedPathStat = await lstat(openedPath, { bigint: true });
      if (!isWithinRoot(expectedRoot, openedPath)) {
        throw new EvaluationPilotValidationError([`${resolved} opened outside the CAS root`]);
      }
      if (!openedPathStat.isFile() || !sameObject(openedPathStat, before)) {
        throw new EvaluationPilotValidationError([
          `${resolved} opened-object identity differs from its contained path`,
        ]);
      }
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let byteLength = 0;
    while (byteLength < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        byteLength,
        buffer.byteLength - byteLength,
        byteLength,
      );
      if (bytesRead === 0) break;
      byteLength += bytesRead;
    }
    if (byteLength > maximumBytes) {
      throw new EvaluationPilotValidationError([`${resolved} exceeds ${maximumBytes} bytes`]);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(resolved, { bigint: true });
    if (
      !sameObject(before, after) ||
      !sameObject(before, pathAfter) ||
      byteLength !== Number(before.size)
    ) {
      throw new EvaluationPilotValidationError([`${resolved} changed while it was being read`]);
    }
    return buffer.subarray(0, byteLength);
  } finally {
    await handle.close();
  }
}

export function decodeStrictJson(bytes: Uint8Array, file: string): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    assertNoDuplicateObjectKeys(text, file);
    return value;
  } catch (error) {
    if (error instanceof EvaluationPilotValidationError) throw error;
    throw new EvaluationPilotValidationError([
      `${file} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

export function artifactPath(casShaRoot: string, digest: string): string {
  const hex = digest.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/u.test(hex)) {
    throw new EvaluationPilotValidationError([`invalid CAS SHA-256 digest ${digest}`]);
  }
  const candidate = path.resolve(casShaRoot, hex);
  if (!isWithinRoot(casShaRoot, candidate)) {
    throw new EvaluationPilotValidationError([`${digest} escapes the CAS root`]);
  }
  return candidate;
}

export async function loadArtifact(
  casShaRoot: string,
  artifact: { readonly digest: string; readonly sizeBytes: number },
): Promise<Uint8Array> {
  const file = artifactPath(casShaRoot, artifact.digest);
  const bytes = await readBoundedRegularFile(
    file,
    Math.min(artifact.sizeBytes, EVALUATION_PILOT_MAXIMUM_ARTIFACT_BYTES),
    casShaRoot,
  );
  if (bytes.byteLength !== artifact.sizeBytes) {
    throw new EvaluationPilotValidationError([
      `${file} has ${bytes.byteLength} bytes; expected ${artifact.sizeBytes}`,
    ]);
  }
  const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actualDigest !== artifact.digest) {
    throw new EvaluationPilotValidationError([`${file} content digest mismatch`]);
  }
  return bytes;
}

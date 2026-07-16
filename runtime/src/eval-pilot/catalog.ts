import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import type { SuiteManifestDocument } from "../eval-contract/index.js";
import {
  EVALUATION_PILOT_MAXIMUM_ARTIFACT_BYTES,
  EVALUATION_PILOT_MAXIMUM_DOCUMENT_BYTES,
  type ValidatedEvaluationPilotCatalog,
} from "./types.js";
import {
  EvaluationPilotValidationError,
  getEvaluationPilotRequiredArtifacts,
  validateEvaluationPilotCurationDocument,
  validateEvaluationPilotEvidenceDocuments,
  type EvaluationPilotEvidenceDocuments,
} from "./validation.js";

export interface LoadEvaluationPilotCatalogOptions {
  /** Existing, independently loaded evaluation suite manifest to bind. */
  readonly suiteManifest: SuiteManifestDocument;
  /** Root containing the fixed `cas/sha256/<hex>` layout. */
  readonly casRoot: string;
}

interface StableDirectory {
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

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

async function openStableDirectory(directory: string, label: string): Promise<StableDirectory> {
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

async function assertStableDirectory(directory: StableDirectory, label: string): Promise<void> {
  const current = await lstat(directory.path, { bigint: true });
  if (current.isSymbolicLink() || !current.isDirectory() || !sameObject(directory.stat, current)) {
    throw new EvaluationPilotValidationError([`${label} changed while loading the pilot`]);
  }
  const canonical = await realpath(directory.path);
  if (canonical !== directory.canonicalPath) {
    throw new EvaluationPilotValidationError([`${label} resolved to a different directory`]);
  }
}

async function readBoundedRegularFile(
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

function decodeStrictJson(bytes: Uint8Array, file: string): unknown {
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

function artifactPath(casShaRoot: string, digest: string): string {
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

async function loadArtifact(
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

export async function loadAndValidateEvaluationPilotCatalog(
  curationFile: string,
  options: LoadEvaluationPilotCatalogOptions,
): Promise<ValidatedEvaluationPilotCatalog> {
  const curationPath = path.resolve(curationFile);
  const curationBytes = await readBoundedRegularFile(
    curationPath,
    EVALUATION_PILOT_MAXIMUM_DOCUMENT_BYTES,
  );
  const curationValue = decodeStrictJson(curationBytes, curationPath);
  const document = validateEvaluationPilotCurationDocument(
    curationValue,
    options.suiteManifest,
  );

  const casRoot = await openStableDirectory(options.casRoot, "CAS root");
  const casDirectory = await openStableDirectory(path.join(casRoot.canonicalPath, "cas"), "CAS directory");
  const shaDirectory = await openStableDirectory(
    path.join(casDirectory.canonicalPath, "sha256"),
    "CAS SHA-256 directory",
  );
  if (!isWithinRoot(casRoot.canonicalPath, casDirectory.canonicalPath) ||
      !isWithinRoot(casDirectory.canonicalPath, shaDirectory.canonicalPath)) {
    throw new EvaluationPilotValidationError(["CAS layout resolves outside its declared root"]);
  }

  const parsedArtifacts = new Map<string, unknown>();
  const loadedArtifacts = new Map<string, Uint8Array>();
  for (const { role, taskId, artifact } of getEvaluationPilotRequiredArtifacts(
    document,
    options.suiteManifest,
  )) {
    const bytes = loadedArtifacts.get(artifact.digest) ??
      await loadArtifact(shaDirectory.canonicalPath, artifact);
    if (bytes.byteLength !== artifact.sizeBytes) {
      throw new EvaluationPilotValidationError([
        `${artifact.digest} has ${bytes.byteLength} bytes; expected ${artifact.sizeBytes}`,
      ]);
    }
    loadedArtifacts.set(artifact.digest, bytes);
    if (artifact.mediaType === "application/json") {
      parsedArtifacts.set(
        artifact.digest,
        decodeStrictJson(bytes, `${taskId ?? "dataset"}.${role}:${artifact.digest}`),
      );
    }
  }
  await assertStableDirectory(shaDirectory, "CAS SHA-256 directory");
  await assertStableDirectory(casDirectory, "CAS directory");
  await assertStableDirectory(casRoot, "CAS root");

  const taskEvidence = new Map<
    string,
    {
      readonly sourceRow: unknown;
      readonly upstreamTriplePreflight: unknown;
      readonly independentSolveReview: unknown;
      readonly negativePatchReview: unknown;
      readonly stressorEvidence: unknown;
    }
  >();
  for (const task of document.tasks) {
    taskEvidence.set(task.taskId, {
      sourceRow: parsedArtifacts.get(task.source.row.digest),
      upstreamTriplePreflight: parsedArtifacts.get(task.qa.upstreamTriplePreflight.digest),
      independentSolveReview: parsedArtifacts.get(task.qa.independentSolveReview.digest),
      negativePatchReview: parsedArtifacts.get(task.qa.negativePatchReview.digest),
      stressorEvidence: parsedArtifacts.get(task.qa.stressorEvidence.digest),
    });
  }
  const evidence: EvaluationPilotEvidenceDocuments = {
    licenseEvidence: parsedArtifacts.get(document.sourceDataset.license.evidence.digest),
    taskEvidence,
  };
  return validateEvaluationPilotEvidenceDocuments(document, options.suiteManifest, evidence);
}

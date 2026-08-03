/** Capability-scoped, bounded, atomic CSV output publication. */

import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import {
  link,
  lstat,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  CSV_MAX_OUTPUT_BYTES,
  CSV_OUTPUT_CONTRACT_VERSION,
} from "../../contracts/csv-job-contract.js";
import { escapeCsvCell } from "./csv-reader.js";

const CSV_OUTPUT_CAPABILITY_SECRET = Symbol("csv-output-root-capability");
const CSV_OUTPUT_DIRECTORY = ".agenc-csv-job-output";
const CSV_OUTPUT_TEMP_ATTEMPTS = 16;
const CSV_OUTPUT_RECOVERY_PAGE_FILES = 100;
const CSV_OUTPUT_RECOVERY_READ_BYTES = 64 * 1_024;
const CSV_OUTPUT_RECOVERY_DIAGNOSTIC_BYTES = 1_024;

export type CsvOutputMode = "replace_existing_regular" | "create_new";

export interface CsvOutputArtifact {
  readonly contractVersion: typeof CSV_OUTPUT_CONTRACT_VERSION;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CsvOutputIntentStore {
  beginCsvOutputIntent(input: {
    readonly jobId: string;
    readonly rootPath: string;
    readonly targetPath: string;
    readonly temporaryPath: string;
    readonly temporaryDev: string;
    readonly temporaryIno: string;
    readonly reservedBytes: number;
  }): string;
  markCsvOutputIntentFlushed(intentId: string): void;
  markCsvOutputIntentPublished(intentId: string): void;
  completeCsvOutputIntent(intentId: string, artifact: CsvOutputArtifact): void;
  abandonCsvOutputIntent(intentId: string, retainForRecovery: boolean): void;
  claimCsvOutputRecoveryIntents(input: {
    readonly rootPath: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly intents: ReadonlyArray<CsvOutputRecoveryIntent>;
    readonly hasMore: boolean;
  }>;
  finishCsvOutputIntentRecovery(input: {
    readonly intentId: string;
    readonly ownerGeneration: string;
    readonly artifact?: CsvOutputArtifact;
  }): void;
  deferCsvOutputIntentRecovery(input: {
    readonly intentId: string;
    readonly ownerGeneration: string;
    readonly reason: string;
  }): void;
}

export interface CsvOutputRecoveryIntent {
  readonly intentId: string;
  readonly ownerGeneration: string;
  readonly priorState: "writing" | "flushed" | "published" | "abandoned";
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly temporaryDev: string;
  readonly temporaryIno: string;
}

/**
 * Authority to publish beneath one already-resolved writable root. A path
 * string alone is data; it becomes usable only together with this capability.
 */
export class CsvOutputRootCapability {
  constructor(
    secret: symbol,
    readonly canonicalRoot: string,
    private readonly rootIdentity: FileIdentity,
  ) {
    if (secret !== CSV_OUTPUT_CAPABILITY_SECRET) {
      throw new Error(
        "CsvOutputRootCapability cannot be constructed externally",
      );
    }
  }

  assertRootIdentity(): void {
    const current = lstatSync(this.canonicalRoot, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameIdentity(current, this.rootIdentity)
    ) {
      throw new Error("CSV output root identity changed");
    }
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface TargetFileIdentity extends FileIdentity {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface WriteCsvOutputOptions {
  readonly capability: CsvOutputRootCapability;
  readonly jobId: string;
  readonly requestedPath?: string;
  readonly mode?: CsvOutputMode;
  readonly headers: ReadonlyArray<string>;
  readonly rows: Iterable<ReadonlyArray<string>>;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
  readonly intentStore?: CsvOutputIntentStore;
}

export function createCsvOutputRootCapability(
  writableRoot: string,
): CsvOutputRootCapability {
  const canonicalRoot = realpathSync(writableRoot);
  const root = lstatSync(canonicalRoot, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("CSV output capability root must be a real directory");
  }
  return new CsvOutputRootCapability(
    CSV_OUTPUT_CAPABILITY_SECRET,
    canonicalRoot,
    identityOf(root),
  );
}

export function resolveCsvOutputPath(
  capability: CsvOutputRootCapability,
  jobId: string,
  requestedPath?: string,
): string {
  return resolveOutputTarget({
    capability,
    jobId,
    ...(requestedPath !== undefined ? { requestedPath } : {}),
    headers: [],
    rows: [],
  });
}

export async function writeCsvOutput(
  options: WriteCsvOutputOptions,
): Promise<CsvOutputArtifact> {
  options.signal?.throwIfAborted();
  if (options.jobId.length === 0) throw new Error("CSV output jobId is empty");
  if (options.headers.length === 0)
    throw new Error("CSV output header is empty");
  const maxBytes = options.maxBytes ?? CSV_MAX_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > CSV_MAX_OUTPUT_BYTES
  ) {
    throw new Error(
      `CSV output maxBytes must be between 1 and ${CSV_MAX_OUTPUT_BYTES}`,
    );
  }

  if (options.intentStore !== undefined) {
    await recoverCsvOutputIntents(options.capability, options.intentStore, {
      signal: options.signal,
    });
  }

  const target = resolveOutputTarget(options);
  const parentPath = dirname(target);
  options.capability.assertRootIdentity();
  assertSafeDirectoryChain(options.capability.canonicalRoot, parentPath);
  const mode = options.mode ?? "replace_existing_regular";
  const originalTarget = await inspectTarget(target, mode);
  const parentPathBefore = await lstat(parentPath, { bigint: true });
  if (parentPathBefore.isSymbolicLink() || !parentPathBefore.isDirectory()) {
    throw new Error("CSV output parent is not a real directory");
  }
  const parentHandle = await open(
    parentPath,
    fsConstants.O_RDONLY | noFollowFlag() | directoryOnlyFlag(),
  );
  const parentBefore = await parentHandle.stat({ bigint: true });
  if (
    !parentBefore.isDirectory() ||
    !sameIdentity(parentBefore, parentPathBefore)
  ) {
    await parentHandle.close();
    throw new Error("CSV output parent identity changed while opening");
  }

  let temporary:
    { readonly path: string; readonly handle: FileHandle } | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let publicationMayExist = false;
  let intentId: string | undefined;
  let intentCompleted = false;
  try {
    temporary = await createTemporaryOutput(parentPath, options.jobId);
    await temporary.handle.chmod(0o600);
    const initialTemporaryStats = await temporary.handle.stat({ bigint: true });
    if (!initialTemporaryStats.isFile() || initialTemporaryStats.nlink !== 1n) {
      throw new Error("CSV output temporary is not a private regular file");
    }
    temporaryIdentity = identityOf(initialTemporaryStats);
    await assertPathIdentity(parentPath, parentBefore, "CSV output parent");
    const temporaryPathStats = await lstat(temporary.path, { bigint: true });
    if (
      temporaryPathStats.isSymbolicLink() ||
      !temporaryPathStats.isFile() ||
      temporaryPathStats.nlink !== 1n ||
      !sameIdentity(temporaryPathStats, temporaryIdentity)
    ) {
      throw new Error(
        "CSV output temporary path identity changed after creation",
      );
    }
    intentId = options.intentStore?.beginCsvOutputIntent({
      jobId: options.jobId,
      rootPath: options.capability.canonicalRoot,
      targetPath: target,
      temporaryPath: temporary.path,
      temporaryDev: temporaryIdentity.dev.toString(),
      temporaryIno: temporaryIdentity.ino.toString(),
      reservedBytes: maxBytes,
    });
    const digest = createHash("sha256");
    let bytes = 0;
    const writeFragment = async (text: string): Promise<void> => {
      options.signal?.throwIfAborted();
      const encoded = Buffer.from(text, "utf8");
      if (bytes + encoded.byteLength > maxBytes) {
        throw new Error(
          `CSV output exceeds ${maxBytes} UTF-8 bytes before publication`,
        );
      }
      await writeAll(temporary!.handle, encoded);
      digest.update(encoded);
      bytes += encoded.byteLength;
    };
    await writeRecord(options.headers, writeFragment);
    for (const row of options.rows) {
      options.signal?.throwIfAborted();
      if (row.length !== options.headers.length) {
        throw new Error(
          `CSV output row has ${row.length} fields; expected ${options.headers.length}`,
        );
      }
      await writeRecord(row, writeFragment);
    }
    await temporary.handle.sync();
    if (intentId !== undefined) {
      options.intentStore!.markCsvOutputIntentFlushed(intentId);
    }
    const tempStats = await temporary.handle.stat({ bigint: true });
    if (!tempStats.isFile() || tempStats.nlink !== 1n) {
      throw new Error("CSV output temporary is not a private regular file");
    }
    if (!sameIdentity(tempStats, temporaryIdentity)) {
      throw new Error("CSV output temporary identity changed while writing");
    }
    await temporary.handle.close();

    options.capability.assertRootIdentity();
    assertSafeDirectoryChain(options.capability.canonicalRoot, parentPath);
    const parentAtPublish = await parentHandle.stat({ bigint: true });
    if (!sameIdentity(parentAtPublish, identityOf(parentBefore))) {
      throw new Error("CSV output parent identity changed before publication");
    }
    await assertPathIdentity(parentPath, parentBefore, "CSV output parent");
    await assertTargetUnchanged(target, mode, originalTarget);
    if (mode === "create_new") {
      await link(temporary.path, target);
      publicationMayExist = true;
      await unlink(temporary.path);
    } else {
      await rename(temporary.path, target);
      publicationMayExist = true;
    }
    await assertPathIdentity(parentPath, parentBefore, "CSV output parent");
    if (intentId !== undefined) {
      options.intentStore!.markCsvOutputIntentPublished(intentId);
    }

    const finalHandle = await open(
      target,
      fsConstants.O_RDONLY | noFollowFlag(),
    );
    try {
      const finalStats = await finalHandle.stat({ bigint: true });
      if (
        !finalStats.isFile() ||
        finalStats.nlink !== 1n ||
        !sameIdentity(finalStats, temporaryIdentity)
      ) {
        throw new Error("CSV output final identity verification failed");
      }
      await finalHandle.sync();
    } finally {
      await finalHandle.close();
    }
    await parentHandle.sync();
    const artifact: CsvOutputArtifact = Object.freeze({
      contractVersion: CSV_OUTPUT_CONTRACT_VERSION,
      path: target,
      bytes,
      sha256: digest.digest("hex"),
    });
    if (intentId !== undefined) {
      options.intentStore!.completeCsvOutputIntent(intentId, artifact);
      intentCompleted = true;
    }
    return artifact;
  } finally {
    await parentHandle.close().catch(() => {});
    if (!publicationMayExist && temporary !== undefined) {
      await temporary.handle.close().catch(() => {});
      let removed = false;
      await unlinkExactTemporary(temporary.path, temporaryIdentity)
        .then(() => {
          removed = true;
        })
        .catch(() => {});
      if (intentId !== undefined && !intentCompleted) {
        options.intentStore?.abandonCsvOutputIntent(intentId, !removed);
      }
    } else if (intentId !== undefined && !intentCompleted) {
      options.intentStore?.abandonCsvOutputIntent(intentId, true);
    }
  }
}

/**
 * Reconcile only repository-recorded temporaries whose exact writer has been
 * proven dead and fenced by the intent store. No directory is scanned and no
 * path is removed unless its recorded device/inode identity still matches.
 */
export async function recoverCsvOutputIntents(
  capability: CsvOutputRootCapability,
  intentStore: CsvOutputIntentStore,
  options: { readonly signal?: AbortSignal } = {},
): Promise<{ readonly recovered: number; readonly deferred: number }> {
  capability.assertRootIdentity();
  let recovered = 0;
  let deferred = 0;
  let hasMore: boolean;
  do {
    options.signal?.throwIfAborted();
    const page = await intentStore.claimCsvOutputRecoveryIntents({
      rootPath: capability.canonicalRoot,
      limit: CSV_OUTPUT_RECOVERY_PAGE_FILES,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    hasMore = page.hasMore;
    for (const intent of page.intents) {
      options.signal?.throwIfAborted();
      try {
        const expected = parseRecordedIdentity(intent);
        assertRecoveryPaths(capability, intent);
        const temporary = await lstatIfPresent(intent.temporaryPath);
        options.signal?.throwIfAborted();
        const target = await lstatIfPresent(intent.targetPath);
        options.signal?.throwIfAborted();

        if (temporary !== undefined) {
          if (
            temporary.isSymbolicLink() ||
            !temporary.isFile() ||
            !sameIdentity(temporary, expected)
          ) {
            throw new Error("recorded CSV temporary identity changed");
          }
          if (target !== undefined && sameIdentity(target, expected)) {
            if (
              target.isSymbolicLink() ||
              !target.isFile() ||
              temporary.nlink !== 2n ||
              target.nlink !== 2n
            ) {
              throw new Error("published CSV recovery link state is invalid");
            }
            await unlinkExactTemporary(intent.temporaryPath, expected, 2n);
            options.signal?.throwIfAborted();
            await syncDirectory(dirname(intent.targetPath));
            options.signal?.throwIfAborted();
            const artifact = await inspectRecoveredArtifact(
              intent.targetPath,
              expected,
            );
            options.signal?.throwIfAborted();
            intentStore.finishCsvOutputIntentRecovery({
              intentId: intent.intentId,
              ownerGeneration: intent.ownerGeneration,
              artifact,
            });
          } else {
            if (intent.priorState === "published") {
              throw new Error(
                "published CSV target changed while its recorded temporary remained",
              );
            }
            if (temporary.nlink !== 1n) {
              throw new Error(
                "recorded CSV temporary has unexpected hard links",
              );
            }
            await unlinkExactTemporary(intent.temporaryPath, expected);
            options.signal?.throwIfAborted();
            await syncDirectory(dirname(intent.temporaryPath));
            options.signal?.throwIfAborted();
            intentStore.finishCsvOutputIntentRecovery({
              intentId: intent.intentId,
              ownerGeneration: intent.ownerGeneration,
            });
          }
        } else if (target !== undefined && sameIdentity(target, expected)) {
          const artifact = await inspectRecoveredArtifact(
            intent.targetPath,
            expected,
          );
          options.signal?.throwIfAborted();
          intentStore.finishCsvOutputIntentRecovery({
            intentId: intent.intentId,
            ownerGeneration: intent.ownerGeneration,
            artifact,
          });
        } else {
          throw new Error(
            `recorded ${intent.priorState} CSV output inode disappeared or changed before recovery`,
          );
        }
        recovered += 1;
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw options.signal.reason ?? error;
        }
        intentStore.deferCsvOutputIntentRecovery({
          intentId: intent.intentId,
          ownerGeneration: intent.ownerGeneration,
          reason: boundedRecoveryDiagnostic(error),
        });
        deferred += 1;
      }
      options.signal?.throwIfAborted();
    }
    if (hasMore) await yieldOutputRecoverySlice(options.signal);
  } while (hasMore);
  options.signal?.throwIfAborted();
  return { recovered, deferred };
}

async function yieldOutputRecoverySlice(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearImmediate(handle);
      reject(signal?.reason ?? new Error("CSV output recovery aborted"));
    };
    const handle = setImmediate(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRecordedIdentity(intent: CsvOutputRecoveryIntent): FileIdentity {
  try {
    const dev = BigInt(intent.temporaryDev);
    const ino = BigInt(intent.temporaryIno);
    if (dev < 0n || ino <= 0n) throw new Error("invalid identity");
    return { dev, ino };
  } catch {
    throw new Error("recorded CSV temporary identity is invalid");
  }
}

function assertRecoveryPaths(
  capability: CsvOutputRootCapability,
  intent: CsvOutputRecoveryIntent,
): void {
  const target = resolve(intent.targetPath);
  const temporary = resolve(intent.temporaryPath);
  if (target !== intent.targetPath || temporary !== intent.temporaryPath) {
    throw new Error("recorded CSV output paths are not canonical");
  }
  assertBeneathRoot(capability.canonicalRoot, target);
  assertBeneathRoot(capability.canonicalRoot, temporary);
  if (dirname(target) !== dirname(temporary)) {
    throw new Error("recorded CSV temporary is not beside its target");
  }
  if (!basename(temporary).endsWith(".agenc-csv.tmp")) {
    throw new Error("recorded CSV temporary name is invalid");
  }
  capability.assertRootIdentity();
  assertSafeDirectoryChain(capability.canonicalRoot, dirname(target));
}

async function lstatIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("CSV output parent is not a real directory");
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | noFollowFlag() | directoryOnlyFlag(),
  );
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory() || !sameIdentity(stats, before)) {
      throw new Error("CSV output parent identity changed while opening");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectRecoveredArtifact(
  targetPath: string,
  expected: FileIdentity,
): Promise<CsvOutputArtifact> {
  const handle = await open(targetPath, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameIdentity(before, expected) ||
      before.size > BigInt(CSV_MAX_OUTPUT_BYTES)
    ) {
      throw new Error("recovered CSV output identity or size is invalid");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CSV_OUTPUT_RECOVERY_READ_BYTES);
    let offset = 0;
    while (offset < Number(before.size)) {
      const length = Math.min(buffer.byteLength, Number(before.size) - offset);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead <= 0) {
        throw new Error("recovered CSV output read made no progress");
      }
      digest.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(targetPath, { bigint: true });
    if (
      !sameIdentity(after, before) ||
      !sameIdentity(current, before) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      current.nlink !== 1n
    ) {
      throw new Error("recovered CSV output changed during verification");
    }
    return Object.freeze({
      contractVersion: CSV_OUTPUT_CONTRACT_VERSION,
      path: targetPath,
      bytes: Number(before.size),
      sha256: digest.digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

function boundedRecoveryDiagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= CSV_OUTPUT_RECOVERY_DIAGNOSTIC_BYTES) return text;
  let end = CSV_OUTPUT_RECOVERY_DIAGNOSTIC_BYTES;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function resolveOutputTarget(options: WriteCsvOutputOptions): string {
  options.capability.assertRootIdentity();
  const root = options.capability.canonicalRoot;
  if (options.requestedPath === undefined) {
    const outputDirectory = join(root, CSV_OUTPUT_DIRECTORY);
    ensureOwnedOutputDirectory(outputDirectory);
    return join(outputDirectory, `${safeJobFilename(options.jobId)}.csv`);
  }
  if (options.requestedPath.length === 0) {
    throw new Error("CSV output path must be non-empty");
  }
  const target = isAbsolute(options.requestedPath)
    ? resolve(options.requestedPath)
    : resolve(root, options.requestedPath);
  assertBeneathRoot(root, target);
  if (basename(target) === "." || basename(target) === sep) {
    throw new Error("CSV output path must name a file");
  }
  return target;
}

function ensureOwnedOutputDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("AgenC CSV output directory is not a real directory");
  }
}

function assertBeneathRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("CSV output path is outside the authorized output root");
  }
}

function assertSafeDirectoryChain(root: string, parent: string): void {
  assertBeneathRoot(root, join(parent, "output.csv"));
  const rel = relative(root, parent);
  let current = root;
  for (const part of rel.split(sep).filter((entry) => entry.length > 0)) {
    current = join(current, part);
    const stats = lstatSync(current, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `CSV output parent component is not a real directory: ${current}`,
      );
    }
  }
}

async function inspectTarget(
  target: string,
  mode: CsvOutputMode,
): Promise<TargetFileIdentity | undefined> {
  try {
    const stats = await lstat(target, { bigint: true });
    if (mode === "create_new") {
      throw new Error("CSV output target already exists in create_new mode");
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1n) {
      throw new Error(
        "CSV output target must be an existing single-link regular file or absent",
      );
    }
    return targetIdentityOf(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertTargetUnchanged(
  target: string,
  mode: CsvOutputMode,
  original: TargetFileIdentity | undefined,
): Promise<void> {
  const current = await inspectTarget(target, mode);
  if (original === undefined && current === undefined) return;
  if (
    mode === "replace_existing_regular" &&
    original !== undefined &&
    current !== undefined &&
    sameTargetIdentity(current, original)
  ) {
    return;
  }
  throw new Error("CSV output target identity changed before publication");
}

async function createTemporaryOutput(
  parent: string,
  jobId: string,
): Promise<{ readonly path: string; readonly handle: FileHandle }> {
  const safeJobId = safeJobFilename(jobId);
  for (let attempt = 0; attempt < CSV_OUTPUT_TEMP_ATTEMPTS; attempt += 1) {
    const path = join(parent, `.${safeJobId}.${randomUUID()}.agenc-csv.tmp`);
    try {
      const handle = await open(
        path,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          noFollowFlag(),
        0o600,
      );
      return { path, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("unable to allocate a private CSV output temporary");
}

async function writeRecord(
  values: ReadonlyArray<string>,
  write: (text: string) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) await write(",");
    await write(escapeCsvCell(values[index]!));
  }
  await write("\n");
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (written.bytesWritten <= 0) {
      throw new Error("CSV output write made no progress");
    }
    offset += written.bytesWritten;
  }
}

async function unlinkExactTemporary(
  path: string,
  expected: FileIdentity | undefined,
  expectedLinkCount = 1n,
): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== expectedLinkCount ||
    (expected !== undefined && !sameIdentity(current, expected))
  ) {
    throw new Error("refusing to unlink a changed CSV output temporary");
  }
  await unlink(path);
}

function safeJobFilename(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96);
  return safe.length === 0 ? "csv-job" : safe;
}

function identityOf(stats: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function targetIdentityOf(
  stats: Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">,
): TargetFileIdentity {
  return {
    ...identityOf(stats),
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(
  left: Pick<BigIntStats, "dev" | "ino"> | FileIdentity,
  right: Pick<BigIntStats, "dev" | "ino"> | FileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameTargetIdentity(
  left: TargetFileIdentity,
  right: TargetFileIdentity,
): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
}

function directoryOnlyFlag(): number {
  return typeof fsConstants.O_DIRECTORY === "number"
    ? fsConstants.O_DIRECTORY
    : 0;
}

async function assertPathIdentity(
  path: string,
  expected: FileIdentity,
  label: string,
): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameIdentity(current, expected)
  ) {
    throw new Error(`${label} path identity changed`);
  }
}

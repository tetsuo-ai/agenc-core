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
  readdir,
  rename,
  rmdir,
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
import {
  assertDarwinCsvMutationBoundary,
  assertWindowsCsvMutationBoundary,
  csvOutputWriterAnchorPaths,
  establishCsvOutputWriterAnchorsSync,
  initializeDarwinCsvPrivatePath,
  type CsvOutputWriterAnchorPaths,
} from "./csv-output-writer-anchor.js";
import { assertWindowsPrivatePathSecurity } from "../workflow-private-path.js";

const CSV_OUTPUT_CAPABILITY_SECRET = Symbol("csv-output-root-capability");
const CSV_OUTPUT_DIRECTORY = ".agenc-csv-job-output";
const CSV_OUTPUT_TEMP_ATTEMPTS = 16;
const CSV_OUTPUT_RECOVERY_PAGE_FILES = 100;
const CSV_OUTPUT_ORPHAN_RECONCILIATION_PAGE_FILES = 100;
const CSV_OUTPUT_RECOVERY_READ_BYTES = 64 * 1_024;
const CSV_OUTPUT_RECOVERY_DIAGNOSTIC_BYTES = 1_024;

let beforeExactUnlinkCaptureForTesting:
  ((path: string) => Promise<void> | void) | undefined;

/** Test seam for exercising a leaf replacement at the exact cleanup fence. */
export function __setCsvOutputBeforeExactUnlinkCaptureForTesting(
  hook: ((path: string) => Promise<void> | void) | undefined,
): void {
  beforeExactUnlinkCaptureForTesting = hook;
}

let afterExactUnlinkCaptureForTesting:
  ((path: string) => Promise<void> | void) | undefined;

/** Test seam for proving a captured cleanup survives process interruption. */
export function __setCsvOutputAfterExactUnlinkCaptureForTesting(
  hook: ((path: string) => Promise<void> | void) | undefined,
): void {
  afterExactUnlinkCaptureForTesting = hook;
}

let missingBirthGenerationForTesting = false;

/** Test seam for filesystems whose stat data has no creation generation. */
export function __setCsvOutputMissingBirthGenerationForTesting(
  missing: boolean,
): void {
  missingBirthGenerationForTesting = missing;
}

let beforePublicationForTesting:
  | ((temporaryPath: string, targetPath: string) => Promise<void> | void)
  | undefined;

/** Test seam for replacing the public temporary at publication time. */
export function __setCsvOutputBeforePublicationForTesting(
  hook:
    | ((temporaryPath: string, targetPath: string) => Promise<void> | void)
    | undefined,
): void {
  beforePublicationForTesting = hook;
}

let afterWriterAnchorsReleasedForTesting:
  ((directoryPath: string) => Promise<void> | void) | undefined;

/** Test seam for interruption after the durable proof has been removed. */
export function __setCsvOutputAfterWriterAnchorsReleasedForTesting(
  hook: ((directoryPath: string) => Promise<void> | void) | undefined,
): void {
  afterWriterAnchorsReleasedForTesting = hook;
}

let afterRecoveryReadChunkForTesting: (() => void) | undefined;

/** Test seam for cancellation between bounded recovered-artifact reads. */
export function __setCsvOutputAfterRecoveryReadChunkForTesting(
  hook: (() => void) | undefined,
): void {
  afterRecoveryReadChunkForTesting = hook;
}

let afterTargetCaptureForTesting:
  ((candidatePath: string) => void | Promise<void>) | undefined;

/** Test seam for interruption after the original target is durably captured. */
export function __setCsvOutputAfterTargetCaptureForTesting(
  hook: ((candidatePath: string) => void | Promise<void>) | undefined,
): void {
  afterTargetCaptureForTesting = hook;
}

let afterTargetPublicationLinkForTesting:
  ((targetPath: string) => void | Promise<void>) | undefined;

/** Test seam for interruption after the writer wins the no-clobber link. */
export function __setCsvOutputAfterTargetPublicationLinkForTesting(
  hook: ((targetPath: string) => void | Promise<void>) | undefined,
): void {
  afterTargetPublicationLinkForTesting = hook;
}

let afterTargetRestoreLinkForTesting:
  ((targetPath: string) => void | Promise<void>) | undefined;

/** Test seam for interruption midway through an idempotent target rollback. */
export function __setCsvOutputAfterTargetRestoreLinkForTesting(
  hook: ((targetPath: string) => void | Promise<void>) | undefined,
): void {
  afterTargetRestoreLinkForTesting = hook;
}

let afterTargetAnchorEstablishedForTesting:
  ((anchorPath: string) => void | Promise<void>) | undefined;

/** Test seam for interruption before the target proof reaches the DB. */
export function __setCsvOutputAfterTargetAnchorEstablishedForTesting(
  hook: ((anchorPath: string) => void | Promise<void>) | undefined,
): void {
  afterTargetAnchorEstablishedForTesting = hook;
}

export type CsvOutputMode = "replace_existing_regular" | "create_new";

export interface CsvOutputArtifact {
  readonly contractVersion: typeof CSV_OUTPUT_CONTRACT_VERSION;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CsvOutputIntentStore {
  reserveCsvOutputIntent(input: {
    readonly jobId: string;
    readonly rootPath: string;
    readonly targetPath: string;
    readonly temporaryPath: string;
    readonly reservedBytes: number;
    readonly targetOriginalPresent?: boolean;
  }): string;
  attachCsvOutputIntentWriter(
    intentId: string,
    input: {
      readonly temporaryDev: string;
      readonly temporaryIno: string;
      readonly temporaryBirthtimeNs: string;
    },
  ): void;
  markCsvOutputIntentAnchorsReady(
    intentId: string,
    targetOriginal?: {
      readonly dev: string;
      readonly ino: string;
      readonly size: string;
      readonly mtimeNs: string;
      readonly ctimeNs: string;
      readonly sha256: string;
    },
  ): void;
  markCsvOutputIntentReplacing(intentId: string): void;
  markCsvOutputIntentTargetReleasing(intentId: string): void;
  markCsvOutputIntentAnchorReleasing(intentId: string): void;
  markCsvOutputIntentRecoveryAnchorReleasing(input: {
    readonly intentId: string;
    readonly ownerGeneration: string;
  }): void;
  markCsvOutputIntentRecoveryTargetReleasing(input: {
    readonly intentId: string;
    readonly ownerGeneration: string;
  }): void;
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
  retireCsvOutputIntentRecovery(input: {
    readonly intentId: string;
    readonly ownerGeneration: string;
    readonly reason: string;
    readonly writerArtifactDisposition?: "verified_absent";
    readonly terminalKind?:
      | "orphaned_unverifiable_writer_identity"
      | "orphaned_target_replacement_conflict";
  }): void;
  listCsvOutputOrphanReservations?(input: {
    readonly rootPath: string;
    readonly limit: number;
  }):
    | ReadonlyArray<CsvOutputOrphanReservation>
    | Promise<ReadonlyArray<CsvOutputOrphanReservation>>;
  releaseCsvOutputOrphanReservation?(input: {
    readonly intentId: string;
    readonly rootPath: string;
  }): void;
}

export interface CsvOutputOrphanReservation {
  readonly intentId: string;
}

export interface CsvOutputRecoveryIntent {
  readonly intentId: string;
  readonly ownerGeneration: string;
  readonly priorState: "writing" | "flushed" | "published" | "abandoned";
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly temporaryDev: string | null;
  readonly temporaryIno: string | null;
  readonly temporaryBirthtimeNs: string | null;
  readonly writerAnchorState: "legacy" | "pending" | "ready" | "releasing";
  readonly targetAnchorState?:
    "legacy" | "absent" | "pending" | "ready" | "replacing" | "releasing";
  readonly targetOriginalDev?: string | null;
  readonly targetOriginalIno?: string | null;
  readonly targetOriginalSize?: string | null;
  readonly targetOriginalMtimeNs?: string | null;
  readonly targetOriginalCtimeNs?: string | null;
  readonly targetOriginalSha256?: string | null;
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
    /** Absolute spelling bound by the caller before realpath canonicalization. */
    readonly requestedRoot: string = canonicalRoot,
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

interface WriterFileIdentity extends FileIdentity {
  /** Optional filesystem diagnostic; durable hardlinks prove the generation. */
  readonly birthtimeNs: bigint;
}

interface TargetFileIdentity extends FileIdentity {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface TargetFileSnapshot extends TargetFileIdentity {
  readonly sha256: string;
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
  const requestedRoot = resolve(writableRoot);
  const canonicalRoot = realpathSync(requestedRoot);
  const root = lstatSync(canonicalRoot, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("CSV output capability root must be a real directory");
  }
  return new CsvOutputRootCapability(
    CSV_OUTPUT_CAPABILITY_SECRET,
    canonicalRoot,
    identityOf(root),
    requestedRoot,
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
  assertDarwinCsvMutationBoundary(parentPath);
  assertWindowsCsvMutationBoundary(parentPath);
  const mode = options.mode ?? "replace_existing_regular";
  const originalTarget = await inspectTarget(target, mode);
  if (originalTarget !== undefined && options.intentStore === undefined) {
    throw new Error(
      "replacing an existing CSV output requires a durable output intent store",
    );
  }
  const parentPathBefore = await lstat(parentPath, { bigint: true });
  if (parentPathBefore.isSymbolicLink() || !parentPathBefore.isDirectory()) {
    throw new Error("CSV output parent is not a real directory");
  }
  const parentHandle = await open(
    parentPath,
    directoryOpenFlag() | noFollowFlag() | directoryOnlyFlag(),
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
  let temporaryIdentity: WriterFileIdentity | undefined;
  let publicationMayExist = false;
  let intentId: string | undefined;
  let intentCompleted = false;
  let writerAnchors: CsvOutputWriterAnchorPaths | undefined;
  let anchorsReleased = false;
  let originalTargetHandle: FileHandle | undefined;
  let anchoredTargetIdentity: TargetFileSnapshot | undefined;
  let targetReplacementStarted = false;
  let retainTargetEvidence = false;
  try {
    if (originalTarget !== undefined) {
      originalTargetHandle = await openPinnedTarget(target, originalTarget);
    }
    if (options.intentStore === undefined) {
      temporary = await createTemporaryOutput(parentPath, options.jobId);
    } else {
      const tracked = await createTrackedTemporaryOutput({
        parentPath,
        jobId: options.jobId,
        rootPath: options.capability.canonicalRoot,
        targetPath: target,
        reservedBytes: maxBytes,
        targetOriginalPresent: originalTarget !== undefined,
        intentStore: options.intentStore,
      });
      temporary = tracked.temporary;
      intentId = tracked.intentId;
    }
    await temporary.handle.chmod(0o600);
    const initialTemporaryStats = await temporary.handle.stat({ bigint: true });
    if (!initialTemporaryStats.isFile() || initialTemporaryStats.nlink !== 1n) {
      throw new Error("CSV output temporary is not a private regular file");
    }
    temporaryIdentity = writerIdentityOf(initialTemporaryStats);
    if (missingBirthGenerationForTesting) {
      temporaryIdentity = { ...temporaryIdentity, birthtimeNs: 0n };
    }
    assertValidWriterIdentity(temporaryIdentity);
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
    // Make the writer pathname durable before attaching its identity to the
    // already-reserved intent. The repository then establishes and fsyncs
    // private hardlinks while this writer FD still pins the inode.
    await parentHandle.sync();
    // Stateless callers have no recovery row by definition. Their capture is
    // still deterministic from the already-unique temporary path, rather than
    // introducing an additional untracked random name.
    const anchorIntentId = intentId ?? "ephemeral";
    writerAnchors = csvOutputWriterAnchorPaths(
      temporary.path,
      anchorIntentId,
      temporaryIdentity,
    );
    if (intentId === undefined) {
      establishCsvOutputWriterAnchorsSync(
        writerAnchors,
        temporary.path,
        temporaryIdentity,
      );
    } else {
      options.intentStore!.attachCsvOutputIntentWriter(intentId, {
        temporaryDev: temporaryIdentity.dev.toString(),
        temporaryIno: temporaryIdentity.ino.toString(),
        temporaryBirthtimeNs: temporaryIdentity.birthtimeNs.toString(),
      });
    }
    if (originalTargetHandle !== undefined) {
      try {
        anchoredTargetIdentity = await establishTargetAnchor(
          target,
          originalTargetHandle,
          writerAnchors,
          originalTarget!,
        );
        await afterTargetAnchorEstablishedForTesting?.(
          writerAnchors.targetAnchorPath,
        );
      } catch (error) {
        retainTargetEvidence = true;
        throw error;
      }
    }
    if (intentId !== undefined) {
      options.intentStore!.markCsvOutputIntentAnchorsReady(
        intentId,
        anchoredTargetIdentity === undefined
          ? undefined
          : persistedTargetIdentity(anchoredTargetIdentity),
      );
    }
    await assertWriterAnchorSet(
      writerAnchors,
      temporaryIdentity,
      temporary.path,
    );
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
    if (!tempStats.isFile() || tempStats.nlink !== 3n) {
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
    if (anchoredTargetIdentity !== undefined) {
      await assertAnchoredTargetUnchanged(
        target,
        writerAnchors,
        anchoredTargetIdentity,
      );
    } else {
      await assertTargetUnchanged(target, mode, originalTarget);
    }
    await assertWriterAnchorSet(
      writerAnchors,
      temporaryIdentity,
      temporary.path,
    );
    await beforePublicationForTesting?.(temporary.path, target);
    // This is the final cancellation fence. Once a target pathname is
    // captured or linked, complete the durable commit/rollback protocol.
    options.signal?.throwIfAborted();
    if (mode === "create_new" || anchoredTargetIdentity === undefined) {
      await link(writerAnchors.authorityPath, target);
      publicationMayExist = true;
      await cleanupPublishedTemporary(
        temporary.path,
        temporaryIdentity,
        4n,
        3n,
        writerAnchors,
        target,
      );
    } else {
      if (intentId !== undefined) {
        options.intentStore!.markCsvOutputIntentReplacing(intentId);
      }
      targetReplacementStarted = true;
      await rename(target, writerAnchors.targetCandidatePath);
      await syncDirectory(writerAnchors.directoryPath);
      await parentHandle.sync();
      const captured = await lstat(writerAnchors.targetCandidatePath, {
        bigint: true,
      });
      if (
        !(await isExactAnchoredTargetCandidate(
          captured,
          anchoredTargetIdentity,
          writerAnchors,
        ))
      ) {
        retainTargetEvidence = true;
        await restoreCapturedTarget(target, writerAnchors, captured);
        throw new CsvTargetReplacementDetectedError(
          "CSV output target identity changed at publication",
        );
      }
      await afterTargetCaptureForTesting?.(writerAnchors.targetCandidatePath);
      // Linking to an absent pathname is the no-clobber commit point. A racer
      // that fills the target wins and is retained; it is never overwritten.
      try {
        await link(writerAnchors.authorityPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          retainTargetEvidence = true;
          throw new CsvTargetReplacementDetectedError(
            "CSV output target was concurrently recreated at publication",
          );
        }
        throw error;
      }
      publicationMayExist = true;
      await parentHandle.sync();
      await afterTargetPublicationLinkForTesting?.(target);
      await cleanupPublishedTemporary(
        temporary.path,
        temporaryIdentity,
        4n,
        3n,
        writerAnchors,
        target,
      );
    }
    await assertPathIdentity(parentPath, parentBefore, "CSV output parent");
    await parentHandle.sync();
    if (intentId !== undefined) {
      options.intentStore!.markCsvOutputIntentPublished(intentId);
    }
    if (anchoredTargetIdentity !== undefined) {
      if (intentId !== undefined) {
        options.intentStore!.markCsvOutputIntentTargetReleasing(intentId);
      }
      await releaseCapturedTarget(
        target,
        writerAnchors,
        anchoredTargetIdentity,
      );
      targetReplacementStarted = false;
    }

    const finalHandle = await open(
      target,
      fsConstants.O_RDONLY | noFollowFlag(),
    );
    try {
      const finalStats = await finalHandle.stat({ bigint: true });
      if (
        !finalStats.isFile() ||
        finalStats.nlink !== 3n ||
        !sameIdentity(finalStats, temporaryIdentity)
      ) {
        throw new Error("CSV output final identity verification failed");
      }
      if (intentId !== undefined) {
        options.intentStore!.markCsvOutputIntentAnchorReleasing(intentId);
      }
      await releaseWriterAnchors(writerAnchors, temporaryIdentity, 1n);
      anchorsReleased = true;
      const currentTarget = await lstat(target, { bigint: true });
      const pinnedTarget = await finalHandle.stat({ bigint: true });
      if (
        currentTarget.isSymbolicLink() ||
        !currentTarget.isFile() ||
        currentTarget.nlink !== 1n ||
        !sameIdentity(currentTarget, pinnedTarget) ||
        !sameIdentity(pinnedTarget, temporaryIdentity)
      ) {
        throw new Error("CSV output target changed while releasing its anchor");
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
      await finalHandle.close();
    }
  } finally {
    await originalTargetHandle?.close().catch(() => {});
    await parentHandle.close().catch(() => {});
    if (!publicationMayExist && temporary !== undefined) {
      await temporary.handle.close().catch(() => {});
      let removed = false;
      if (
        anchoredTargetIdentity !== undefined &&
        !targetReplacementStarted &&
        writerAnchors !== undefined
      ) {
        try {
          await releaseUncommittedTargetAnchor(
            target,
            writerAnchors,
            anchoredTargetIdentity,
          );
        } catch {
          retainTargetEvidence = true;
        }
      }
      if (targetReplacementStarted && !retainTargetEvidence) {
        // The replace commit may be between its deterministic capture and
        // no-clobber link. Leave both durable authorities for recovery.
        writerAnchors = undefined;
      }
      if (
        temporaryIdentity !== undefined &&
        writerAnchors !== undefined &&
        !anchorsReleased
      ) {
        if (intentId !== undefined) {
          try {
            options.intentStore?.markCsvOutputIntentAnchorReleasing(intentId);
          } catch {
            // A recovery owner must retain the still-pinned writer instead of
            // letting filesystem cleanup outrun the durable phase fence.
            writerAnchors = undefined;
          }
        }
      }
      if (temporaryIdentity !== undefined && writerAnchors !== undefined) {
        await unlinkExactTemporary(
          temporary.path,
          temporaryIdentity,
          3n,
          writerAnchors,
        )
          .then(async () => {
            await releaseWriterAnchors(writerAnchors!, temporaryIdentity!, 0n);
            anchorsReleased = true;
            removed = true;
          })
          .catch(() => {});
      }
      if (intentId !== undefined && !intentCompleted) {
        options.intentStore?.abandonCsvOutputIntent(
          intentId,
          retainTargetEvidence || targetReplacementStarted || !removed,
        );
      }
    } else if (intentId !== undefined && !intentCompleted) {
      options.intentStore?.abandonCsvOutputIntent(intentId, true);
    }
  }
}

/**
 * Reconcile only repository-recorded temporaries whose exact writer has been
 * proven dead and fenced by the intent store. No directory is scanned and no
 * path is removed unless a durable private hardlink pins and proves the
 * recorded writer inode. Birth time is diagnostic only because its precision
 * and semantics vary by filesystem.
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
    let unfinished: CsvOutputRecoveryIntent[] = [];
    try {
      options.signal?.throwIfAborted();
      const page = await intentStore.claimCsvOutputRecoveryIntents({
        rootPath: capability.canonicalRoot,
        limit: CSV_OUTPUT_RECOVERY_PAGE_FILES,
        signal: options.signal,
      });
      unfinished = [...page.intents];
      options.signal?.throwIfAborted();
      hasMore = page.hasMore;
      for (const intent of page.intents) {
        options.signal?.throwIfAborted();
        try {
          let expected: WriterFileIdentity;
          try {
            expected = parseRecordedIdentity(intent);
          } catch {
            // A legacy NULL or corrupt identity cannot derive or validate the
            // durable anchor. Retain terminal evidence and move the active
            // reservation into bounded orphan accounting exactly once without
            // touching either filesystem path.
            intentStore.retireCsvOutputIntentRecovery({
              intentId: intent.intentId,
              ownerGeneration: intent.ownerGeneration,
              reason:
                "CSV output durable writer anchor proof is unavailable for a legacy identity; filesystem paths retained",
            });
            recovered += 1;
            unfinished = unfinished.filter(
              (candidate) => candidate.intentId !== intent.intentId,
            );
            continue;
          }
          try {
            parseRecordedTargetIdentity(intent);
          } catch {
            intentStore.retireCsvOutputIntentRecovery({
              intentId: intent.intentId,
              ownerGeneration: intent.ownerGeneration,
              reason:
                "CSV output original target proof is incomplete; filesystem paths retained",
              terminalKind: "orphaned_target_replacement_conflict",
            });
            recovered += 1;
            unfinished = unfinished.filter(
              (candidate) => candidate.intentId !== intent.intentId,
            );
            continue;
          }
          assertRecoveryPaths(capability, intent);
          const anchors = csvOutputWriterAnchorPaths(
            intent.temporaryPath,
            intent.intentId,
            expected,
          );
          await recoverAnchoredCsvOutputIntent({
            intent,
            intentStore,
            expected,
            anchors,
            signal: options.signal,
          });
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
        unfinished = unfinished.filter(
          (candidate) => candidate.intentId !== intent.intentId,
        );
        options.signal?.throwIfAborted();
      }
    } catch (error) {
      if (options.signal?.aborted !== true) throw error;
      deferAbortedCsvOutputRecoveryClaims(intentStore, unfinished);
      throw options.signal.reason ?? error;
    }
    if (hasMore) await yieldOutputRecoverySlice(options.signal);
  } while (hasMore);
  await reconcileCsvOutputOrphanReservations(capability, intentStore);
  options.signal?.throwIfAborted();
  return { recovered, deferred };
}

async function reconcileCsvOutputOrphanReservations(
  capability: CsvOutputRootCapability,
  intentStore: CsvOutputIntentStore,
): Promise<void> {
  if (
    intentStore.listCsvOutputOrphanReservations === undefined ||
    intentStore.releaseCsvOutputOrphanReservation === undefined
  ) {
    return;
  }
  const orphans = await intentStore.listCsvOutputOrphanReservations({
    rootPath: capability.canonicalRoot,
    limit: CSV_OUTPUT_ORPHAN_RECONCILIATION_PAGE_FILES,
  });
  for (const orphan of orphans) {
    try {
      intentStore.releaseCsvOutputOrphanReservation({
        intentId: orphan.intentId,
        rootPath: capability.canonicalRoot,
      });
    } catch {
      // Reconciliation is non-destructive. cleanup_eligible is the durable
      // result of a fenced link-set proof that released the final known writer
      // link; consulting path identities again would reintroduce inode ABA.
    }
  }
}

function deferAbortedCsvOutputRecoveryClaims(
  intentStore: CsvOutputIntentStore,
  intents: ReadonlyArray<CsvOutputRecoveryIntent>,
): void {
  for (const intent of intents) {
    try {
      intentStore.deferCsvOutputIntentRecovery({
        intentId: intent.intentId,
        ownerGeneration: intent.ownerGeneration,
        reason: "CSV output recovery aborted before completion",
      });
    } catch {
      // Preserve the caller's abort reason. A completed or independently
      // fenced row no longer owns this generation; a live claim is released
      // by the successful generation-qualified defer above.
    }
  }
}

async function recoverAnchoredCsvOutputIntent(input: {
  readonly intent: CsvOutputRecoveryIntent;
  readonly intentStore: CsvOutputIntentStore;
  readonly expected: WriterFileIdentity;
  readonly anchors: CsvOutputWriterAnchorPaths;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { intent, intentStore, expected, anchors, signal } = input;
  const directory = await lstatIfPresent(anchors.directoryPath);
  if (directory === undefined) {
    if (intent.writerAnchorState === "ready") {
      throw new Error(
        "CSV output writer anchor disappeared from its durable ready phase",
      );
    }
    intentStore.retireCsvOutputIntentRecovery({
      intentId: intent.intentId,
      ownerGeneration: intent.ownerGeneration,
      reason: `CSV output writer anchor is absent in ${intent.writerAnchorState} phase; filesystem paths retained`,
    });
    return;
  }
  await assertPrivateCaptureDirectory(anchors.directoryPath, directory);
  await assertWriterAnchorDirectoryEntries(anchors, true);
  const references = await writerAnchorReferences(anchors);
  if (references.length === 0) {
    if (intent.writerAnchorState === "ready") {
      throw new Error(
        "CSV output writer anchor was exhausted before its releasing phase",
      );
    }
    if ((await readdir(anchors.directoryPath)).length === 0) {
      await rmdir(anchors.directoryPath);
      await syncDirectory(dirname(anchors.directoryPath));
    }
    intentStore.retireCsvOutputIntentRecovery({
      intentId: intent.intentId,
      ownerGeneration: intent.ownerGeneration,
      reason: `CSV output writer anchor is exhausted in ${intent.writerAnchorState} phase; filesystem paths retained`,
      ...(intent.targetAnchorState !== undefined &&
      !["legacy", "absent", "releasing"].includes(intent.targetAnchorState)
        ? { terminalKind: "orphaned_target_replacement_conflict" as const }
        : {}),
    });
    return;
  }
  await assertWriterAnchorProof(anchors, expected, true);
  signal?.throwIfAborted();

  const targetResolution = await reconcileRecoveredTargetReplacement({
    intent,
    intentStore,
    anchors,
    expectedWriter: expected,
  });
  const targetConflictReason = targetResolution.conflictReason;
  signal?.throwIfAborted();

  const candidate = await lstatIfPresent(anchors.candidatePath);
  if (
    candidate !== undefined &&
    (candidate.isSymbolicLink() ||
      !candidate.isFile() ||
      !sameIdentity(candidate, expected))
  ) {
    await restoreCapturedReplacement(intent.temporaryPath, anchors, candidate);
    throw new Error("recorded CSV cleanup capture identity changed");
  }
  const temporary = await lstatIfPresent(intent.temporaryPath);
  signal?.throwIfAborted();
  const target = await lstatIfPresent(intent.targetPath);
  signal?.throwIfAborted();

  const candidateIsWriter = candidate !== undefined;
  const temporaryIsWriter =
    temporary !== undefined &&
    !temporary.isSymbolicLink() &&
    temporary.isFile() &&
    sameIdentity(temporary, expected);
  const targetIsWriter =
    target !== undefined &&
    !target.isSymbolicLink() &&
    target.isFile() &&
    sameIdentity(target, expected);
  if (candidateIsWriter && temporaryIsWriter) {
    throw new Error("CSV output writer exists at two temporary paths");
  }

  const expectedLinks = BigInt(
    references.length +
      Number(candidateIsWriter) +
      Number(temporaryIsWriter) +
      Number(targetIsWriter),
  );
  for (const stats of [
    ...references.map((reference) => reference.stats),
    ...(candidateIsWriter ? [candidate!] : []),
    ...(temporaryIsWriter ? [temporary!] : []),
    ...(targetIsWriter ? [target!] : []),
  ]) {
    if (stats.nlink !== expectedLinks) {
      throw new Error("CSV output writer has unknown hard links");
    }
  }

  if (candidateIsWriter) {
    const current = await lstat(anchors.candidatePath, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== expectedLinks ||
      !sameIdentity(current, expected)
    ) {
      throw new Error("CSV output captured writer changed before cleanup");
    }
    await unlink(anchors.candidatePath);
    await syncDirectory(anchors.directoryPath);
    await syncDirectory(dirname(intent.temporaryPath));
  } else if (temporaryIsWriter) {
    try {
      await unlinkExactTemporary(
        intent.temporaryPath,
        expected,
        expectedLinks,
        anchors,
      );
    } catch (error) {
      if (!(error instanceof CsvTemporaryReplacementDetectedError)) throw error;
      markRecoveryAnchorReleasing(intentStore, intent);
      await releaseWriterAnchors(anchors, expected, targetIsWriter ? 1n : 0n);
      intentStore.retireCsvOutputIntentRecovery({
        intentId: intent.intentId,
        ownerGeneration: intent.ownerGeneration,
        reason:
          targetConflictReason ??
          "CSV output temporary was replaced at its cleanup fence; replacement restored and paths retained",
        ...(targetConflictReason !== undefined
          ? { terminalKind: "orphaned_target_replacement_conflict" as const }
          : {}),
        ...(!targetIsWriter
          ? { writerArtifactDisposition: "verified_absent" as const }
          : {}),
      });
      return;
    }
  }
  signal?.throwIfAborted();

  const unrelatedTemporary = temporary !== undefined && !temporaryIsWriter;
  if (
    targetIsWriter &&
    !unrelatedTemporary &&
    targetConflictReason === undefined
  ) {
    await finishRecoveredAnchoredArtifact({
      targetPath: intent.targetPath,
      expected,
      anchors,
      intent,
      intentStore,
      signal,
    });
    return;
  }

  markRecoveryAnchorReleasing(intentStore, intent);
  await releaseWriterAnchors(anchors, expected, targetIsWriter ? 1n : 0n);
  signal?.throwIfAborted();
  const terminalReason =
    targetConflictReason ??
    (unrelatedTemporary ||
    (target !== undefined && !targetResolution.originalRestored) ||
    intent.priorState === "published"
      ? "CSV output path changed after its durable writer was safely released; filesystem paths retained"
      : undefined);
  if (terminalReason !== undefined) {
    intentStore.retireCsvOutputIntentRecovery({
      intentId: intent.intentId,
      ownerGeneration: intent.ownerGeneration,
      reason: terminalReason,
      ...(targetConflictReason !== undefined
        ? { terminalKind: "orphaned_target_replacement_conflict" as const }
        : {}),
      ...(!targetIsWriter
        ? { writerArtifactDisposition: "verified_absent" as const }
        : {}),
    });
  } else {
    intentStore.finishCsvOutputIntentRecovery({
      intentId: intent.intentId,
      ownerGeneration: intent.ownerGeneration,
    });
  }
}

function markRecoveryAnchorReleasing(
  intentStore: CsvOutputIntentStore,
  intent: CsvOutputRecoveryIntent,
): void {
  intentStore.markCsvOutputIntentRecoveryAnchorReleasing({
    intentId: intent.intentId,
    ownerGeneration: intent.ownerGeneration,
  });
}

function parseRecordedTargetIdentity(
  intent: CsvOutputRecoveryIntent,
): TargetFileSnapshot | undefined {
  const state = intent.targetAnchorState ?? "legacy";
  if (state === "legacy" || state === "absent") return undefined;
  try {
    const values = [
      intent.targetOriginalDev,
      intent.targetOriginalIno,
      intent.targetOriginalSize,
      intent.targetOriginalMtimeNs,
      intent.targetOriginalCtimeNs,
      intent.targetOriginalSha256,
    ];
    if (values.some((value) => value === null || value === undefined)) {
      throw new Error("missing target identity");
    }
    const [devText, inoText, sizeText, mtimeText, ctimeText, sha256] =
      values as [string, string, string, string, string, string];
    const identity: TargetFileSnapshot = {
      dev: BigInt(devText),
      ino: BigInt(inoText),
      size: BigInt(sizeText),
      mtimeNs: BigInt(mtimeText),
      ctimeNs: BigInt(ctimeText),
      sha256,
    };
    if (
      identity.dev < 0n ||
      identity.ino <= 0n ||
      identity.size < 0n ||
      !/^[a-f0-9]{64}$/u.test(identity.sha256) ||
      [
        identity.dev,
        identity.ino,
        identity.size,
        identity.mtimeNs,
        identity.ctimeNs,
      ]
        .map(String)
        .some((value, index) => value !== values[index])
    ) {
      throw new Error("non-canonical target identity");
    }
    return identity;
  } catch {
    throw new Error("recorded CSV original target identity is invalid");
  }
}

async function reconcileRecoveredTargetReplacement(input: {
  readonly intent: CsvOutputRecoveryIntent;
  readonly intentStore: CsvOutputIntentStore;
  readonly anchors: CsvOutputWriterAnchorPaths;
  readonly expectedWriter: WriterFileIdentity;
}): Promise<{
  readonly conflictReason?: string;
  readonly originalRestored?: boolean;
}> {
  const state = input.intent.targetAnchorState ?? "legacy";
  const expectedTarget = parseRecordedTargetIdentity(input.intent);
  if (expectedTarget === undefined) return {};

  const anchor = await lstatIfPresent(input.anchors.targetAnchorPath);
  const candidate = await lstatIfPresent(input.anchors.targetCandidatePath);
  const target = await lstatIfPresent(input.intent.targetPath);
  const targetIsWriter =
    target !== undefined &&
    !target.isSymbolicLink() &&
    target.isFile() &&
    sameIdentity(target, input.expectedWriter);
  const targetIsOriginal =
    target !== undefined &&
    !target.isSymbolicLink() &&
    target.isFile() &&
    sameIdentity(target, expectedTarget);
  const anchorIsOriginal =
    anchor !== undefined &&
    !anchor.isSymbolicLink() &&
    anchor.isFile() &&
    sameTargetContentIdentity(targetIdentityOf(anchor), expectedTarget);
  const candidateIsOriginal =
    candidate !== undefined &&
    anchorIsOriginal &&
    (await isExactAnchoredTargetCandidate(
      candidate,
      expectedTarget,
      input.anchors,
      targetIsOriginal ? 3n : 2n,
    ));

  if (!anchorIsOriginal && state !== "releasing") {
    return {
      conflictReason:
        "CSV output original target anchor proof is unavailable; target paths retained",
    };
  }

  const markReleasing = (): void => {
    if (state !== "releasing") {
      input.intentStore.markCsvOutputIntentRecoveryTargetReleasing({
        intentId: input.intent.intentId,
        ownerGeneration: input.intent.ownerGeneration,
      });
    }
  };

  if (state === "pending" || state === "ready") {
    if (!targetIsOriginal || candidate !== undefined) {
      return {
        conflictReason:
          "CSV output original target changed before replacement; original evidence retained",
      };
    }
    markReleasing();
    await releaseUncommittedTargetAnchor(
      input.intent.targetPath,
      input.anchors,
      expectedTarget,
    );
    return { originalRestored: true };
  }

  if (state === "replacing") {
    if (candidate !== undefined && !candidateIsOriginal) {
      if (target === undefined) {
        await restoreCapturedTarget(
          input.intent.targetPath,
          input.anchors,
          candidate,
        );
      }
      return {
        conflictReason:
          "CSV output target was replaced at its capture fence; concurrent and original evidence retained",
      };
    }
    if (candidateIsOriginal && target === undefined) {
      await restoreCapturedTarget(
        input.intent.targetPath,
        input.anchors,
        candidate!,
      );
      markReleasing();
      await releaseUncommittedTargetAnchor(
        input.intent.targetPath,
        input.anchors,
        expectedTarget,
      );
      return { originalRestored: true };
    }
    if (candidateIsOriginal && targetIsOriginal) {
      const restored = await lstat(input.intent.targetPath, { bigint: true });
      if (
        restored.nlink !== 3n ||
        candidate!.nlink !== 3n ||
        !sameIdentity(restored, candidate!)
      ) {
        return {
          conflictReason:
            "CSV output original target rollback link state is invalid; evidence retained",
        };
      }
      await unlink(input.anchors.targetCandidatePath);
      await syncDirectory(input.anchors.directoryPath);
      await syncDirectory(dirname(input.intent.targetPath));
      markReleasing();
      await releaseUncommittedTargetAnchor(
        input.intent.targetPath,
        input.anchors,
        expectedTarget,
      );
      return { originalRestored: true };
    }
    if (candidateIsOriginal && targetIsWriter) {
      markReleasing();
      await releaseCapturedTarget(
        input.intent.targetPath,
        input.anchors,
        expectedTarget,
      );
      return {};
    }
    if (candidate === undefined && targetIsOriginal) {
      markReleasing();
      await releaseUncommittedTargetAnchor(
        input.intent.targetPath,
        input.anchors,
        expectedTarget,
      );
      return { originalRestored: true };
    }
    if (candidate === undefined && targetIsWriter && anchorIsOriginal) {
      markReleasing();
      await releaseRemainingTargetAnchor(input.anchors, expectedTarget);
      return {};
    }
    return {
      conflictReason:
        "CSV output target was concurrently filled during replacement; concurrent and original evidence retained",
    };
  }

  if (state === "releasing") {
    // This monotonic phase fences both rollback and committed publication.
    // The public target identity determines which cleanup must resume.
    if (targetIsOriginal && candidate === undefined) {
      if (anchorIsOriginal) {
        await releaseUncommittedTargetAnchor(
          input.intent.targetPath,
          input.anchors,
          expectedTarget,
        );
      } else if (anchor !== undefined) {
        return {
          conflictReason:
            "CSV output original target evidence changed while rollback was releasing; paths retained",
        };
      }
      return { originalRestored: true };
    }
    if (!targetIsWriter) {
      return {
        conflictReason:
          "CSV output published target changed while original evidence was releasing; paths retained",
      };
    }
    if (candidateIsOriginal) {
      await releaseCapturedTarget(
        input.intent.targetPath,
        input.anchors,
        expectedTarget,
      );
    } else if (candidate === undefined && anchorIsOriginal) {
      await releaseRemainingTargetAnchor(input.anchors, expectedTarget);
    } else if (candidate !== undefined || anchor !== undefined) {
      return {
        conflictReason:
          "CSV output original target evidence changed while releasing; paths retained",
      };
    }
  }
  return {};
}

async function releaseRemainingTargetAnchor(
  anchors: CsvOutputWriterAnchorPaths,
  expected: TargetFileSnapshot,
): Promise<void> {
  const anchor = await lstat(anchors.targetAnchorPath, { bigint: true });
  if (
    anchor.isSymbolicLink() ||
    !anchor.isFile() ||
    anchor.nlink !== 1n ||
    !sameTargetContentIdentity(targetIdentityOf(anchor), expected)
  ) {
    throw new Error("CSV output remaining target anchor is invalid");
  }
  await unlink(anchors.targetAnchorPath);
  await syncDirectory(anchors.directoryPath);
  await syncDirectory(dirname(anchors.directoryPath));
}

async function finishRecoveredAnchoredArtifact(input: {
  readonly targetPath: string;
  readonly expected: WriterFileIdentity;
  readonly anchors: CsvOutputWriterAnchorPaths;
  readonly intent: CsvOutputRecoveryIntent;
  readonly intentStore: CsvOutputIntentStore;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const handle = await open(
    input.targetPath,
    fsConstants.O_RDONLY | noFollowFlag(),
  );
  try {
    const artifact = await inspectRecoveredArtifactHandle(
      handle,
      input.targetPath,
      input.expected,
      input.signal,
    );
    input.signal?.throwIfAborted();
    markRecoveryAnchorReleasing(input.intentStore, input.intent);
    await releaseWriterAnchors(input.anchors, input.expected, 1n);
    input.signal?.throwIfAborted();
    const pinned = await handle.stat({ bigint: true });
    const current = await lstat(input.targetPath, { bigint: true });
    if (
      !pinned.isFile() ||
      pinned.nlink !== 1n ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameIdentity(pinned, input.expected) ||
      !sameIdentity(current, pinned)
    ) {
      throw new Error(
        "recovered CSV target changed while releasing its anchor",
      );
    }
    input.intentStore.finishCsvOutputIntentRecovery({
      intentId: input.intent.intentId,
      ownerGeneration: input.intent.ownerGeneration,
      artifact,
    });
  } finally {
    await handle.close();
  }
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

function parseRecordedIdentity(
  intent: CsvOutputRecoveryIntent,
): WriterFileIdentity {
  try {
    if (
      intent.temporaryDev === null ||
      intent.temporaryIno === null ||
      intent.temporaryBirthtimeNs === null
    ) {
      throw new Error("missing legacy writer identity");
    }
    const dev = BigInt(intent.temporaryDev);
    const ino = BigInt(intent.temporaryIno);
    const birthtimeNs = BigInt(intent.temporaryBirthtimeNs);
    const identity = { dev, ino, birthtimeNs };
    assertValidWriterIdentity(identity);
    if (
      dev.toString() !== intent.temporaryDev ||
      ino.toString() !== intent.temporaryIno ||
      birthtimeNs.toString() !== intent.temporaryBirthtimeNs
    ) {
      throw new Error("non-canonical writer identity");
    }
    return identity;
  } catch {
    throw new Error("recorded CSV temporary writer identity is invalid");
  }
}

function assertRecoveryPaths(
  capability: CsvOutputRootCapability,
  intent: Pick<CsvOutputRecoveryIntent, "targetPath" | "temporaryPath">,
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
  const parentPath = dirname(target);
  assertSafeDirectoryChain(capability.canonicalRoot, parentPath);
  assertDarwinCsvMutationBoundary(parentPath);
  assertWindowsCsvMutationBoundary(parentPath);
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
    directoryOpenFlag() | noFollowFlag() | directoryOnlyFlag(),
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

async function inspectRecoveredArtifactHandle(
  handle: FileHandle,
  targetPath: string,
  expected: WriterFileIdentity,
  signal?: AbortSignal,
): Promise<CsvOutputArtifact> {
  const before = await handle.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.nlink < 2n ||
    !sameIdentity(before, expected) ||
    before.size > BigInt(CSV_MAX_OUTPUT_BYTES)
  ) {
    throw new Error("recovered CSV output identity or size is invalid");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CSV_OUTPUT_RECOVERY_READ_BYTES);
  let offset = 0;
  while (offset < Number(before.size)) {
    signal?.throwIfAborted();
    const length = Math.min(buffer.byteLength, Number(before.size) - offset);
    const read = await handle.read(buffer, 0, length, offset);
    if (read.bytesRead <= 0) {
      throw new Error("recovered CSV output read made no progress");
    }
    digest.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
    afterRecoveryReadChunkForTesting?.();
  }
  signal?.throwIfAborted();
  const after = await handle.stat({ bigint: true });
  const current = await lstat(targetPath, { bigint: true });
  if (
    !sameIdentity(after, before) ||
    !sameIdentity(current, expected) ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    current.nlink !== before.nlink
  ) {
    throw new Error("recovered CSV output changed during verification");
  }
  return Object.freeze({
    contractVersion: CSV_OUTPUT_CONTRACT_VERSION,
    path: targetPath,
    bytes: Number(before.size),
    sha256: digest.digest("hex"),
  });
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
    ? resolveAbsoluteOutputTarget(options.capability, options.requestedPath)
    : resolve(root, options.requestedPath);
  assertBeneathRoot(root, target);
  if (basename(target) === "." || basename(target) === sep) {
    throw new Error("CSV output path must name a file");
  }
  return target;
}

function resolveAbsoluteOutputTarget(
  capability: CsvOutputRootCapability,
  requestedPath: string,
): string {
  const candidate = resolve(requestedPath);
  if (isBeneathRoot(capability.canonicalRoot, candidate)) return candidate;

  // macOS commonly exposes a temporary directory through a lexical alias
  // such as /var/... whose real path is /private/var/.... Translate only the
  // capability root spelling itself; later components remain lexical so the
  // directory-chain check still rejects symlinks beneath the authorized root.
  assertBeneathRoot(capability.requestedRoot, candidate);
  return resolve(
    capability.canonicalRoot,
    relative(capability.requestedRoot, candidate),
  );
}

function ensureOwnedOutputDirectory(path: string): void {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("AgenC CSV output directory is not a real directory");
  }
  if (created) initializeDarwinCsvPrivatePath(path);
  assertWindowsPrivatePathSecurity(path, "directory", created);
  const currentUid = process.getuid?.();
  if (
    process.platform !== "win32" &&
    ((stats.mode & 0o077n) !== 0n ||
      (currentUid !== undefined && stats.uid !== BigInt(currentUid)))
  ) {
    throw new Error("AgenC CSV output directory is not private and owned");
  }
}

function assertBeneathRoot(root: string, candidate: string): void {
  if (!isBeneathRoot(root, candidate)) {
    throw new Error("CSV output path is outside the authorized output root");
  }
}

function isBeneathRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !(
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  );
}

function assertSafeDirectoryChain(root: string, parent: string): void {
  assertBeneathRoot(root, join(parent, "output.csv"));
  const rel = relative(root, parent);
  let current = root;
  assertSafeSharedDirectory(current, lstatSync(current, { bigint: true }));
  for (const part of rel.split(sep).filter((entry) => entry.length > 0)) {
    current = join(current, part);
    const stats = lstatSync(current, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `CSV output parent component is not a real directory: ${current}`,
      );
    }
    assertSafeSharedDirectory(current, stats);
  }
}

function assertSafeSharedDirectory(path: string, stats: BigIntStats): void {
  // Windows relies on the directory ACL already embodied by the capability.
  // On POSIX, sticky semantics protect an entry only from users other than
  // the entry owner, directory owner, and root. A foreign directory owner can
  // still rename our capture entry, so only the current UID or root is trusted.
  assertSafeSharedDirectoryOwnership(path, stats, {
    platform: process.platform,
    currentUid: process.getuid?.(),
  });
}

function assertSafeSharedDirectoryOwnership(
  path: string,
  stats: Pick<BigIntStats, "mode" | "uid">,
  environment: {
    readonly platform: NodeJS.Platform;
    readonly currentUid: number | undefined;
  },
): void {
  const writableByOtherUsers = (stats.mode & 0o022n) !== 0n;
  const trustedStickyOwner =
    stats.uid === 0n ||
    (environment.currentUid !== undefined &&
      stats.uid === BigInt(environment.currentUid));
  if (
    environment.platform !== "win32" &&
    writableByOtherUsers &&
    ((stats.mode & 0o1000n) === 0n || !trustedStickyOwner)
  ) {
    throw new Error(`CSV output parent is insecurely writable: ${path}`);
  }
}

/** Revert-sensitive stat seam for POSIX sticky-directory owner policy. */
export function __assertCsvOutputSafeSharedDirectoryForTesting(input: {
  readonly mode: bigint;
  readonly ownerUid: bigint;
  readonly currentUid: number | undefined;
  readonly platform?: NodeJS.Platform;
}): void {
  assertSafeSharedDirectoryOwnership(
    "<test-directory>",
    { mode: input.mode, uid: input.ownerUid },
    {
      platform: input.platform ?? "linux",
      currentUid: input.currentUid,
    },
  );
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

async function openPinnedTarget(
  targetPath: string,
  expected: TargetFileIdentity,
): Promise<FileHandle> {
  const handle = await open(targetPath, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const pinned = await handle.stat({ bigint: true });
    const current = await lstat(targetPath, { bigint: true });
    if (
      !pinned.isFile() ||
      pinned.nlink !== 1n ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameTargetIdentity(targetIdentityOf(pinned), expected) ||
      !sameIdentity(current, pinned)
    ) {
      throw new Error("CSV output target identity changed while pinning");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function establishTargetAnchor(
  targetPath: string,
  targetHandle: FileHandle,
  anchors: CsvOutputWriterAnchorPaths,
  original: TargetFileIdentity,
): Promise<TargetFileSnapshot> {
  await assertPrivateCaptureDirectory(anchors.directoryPath);
  if (
    (await lstatIfPresent(anchors.targetAnchorPath)) !== undefined ||
    (await lstatIfPresent(anchors.targetCandidatePath)) !== undefined
  ) {
    throw new Error("CSV output target anchor is already occupied");
  }
  await link(targetPath, anchors.targetAnchorPath);
  const pinned = await targetHandle.stat({ bigint: true });
  const current = await lstat(targetPath, { bigint: true });
  const anchor = await lstat(anchors.targetAnchorPath, { bigint: true });
  if (
    !pinned.isFile() ||
    pinned.nlink !== 2n ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 2n ||
    anchor.isSymbolicLink() ||
    !anchor.isFile() ||
    anchor.nlink !== 2n ||
    !sameIdentity(pinned, original) ||
    pinned.size !== original.size ||
    pinned.mtimeNs !== original.mtimeNs ||
    !sameIdentity(current, pinned) ||
    !sameIdentity(anchor, pinned)
  ) {
    throw new Error("CSV output target changed while anchoring");
  }
  if (pinned.size > BigInt(CSV_MAX_OUTPUT_BYTES)) {
    throw new Error("existing CSV output target exceeds the recoverable bound");
  }
  const sha256 = await sha256FileHandle(targetHandle, Number(pinned.size));
  const afterHash = await targetHandle.stat({ bigint: true });
  if (
    !sameTargetIdentity(targetIdentityOf(afterHash), targetIdentityOf(pinned))
  ) {
    throw new Error("CSV output target changed while hashing its anchor");
  }
  await syncDirectory(anchors.directoryPath);
  await syncDirectory(dirname(targetPath));
  return { ...targetIdentityOf(pinned), sha256 };
}

function persistedTargetIdentity(identity: TargetFileSnapshot): {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly sha256: string;
} {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
    sha256: identity.sha256,
  };
}

async function assertAnchoredTargetUnchanged(
  targetPath: string,
  anchors: CsvOutputWriterAnchorPaths,
  expected: TargetFileIdentity,
): Promise<void> {
  const current = await lstat(targetPath, { bigint: true });
  const anchor = await lstat(anchors.targetAnchorPath, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 2n ||
    anchor.isSymbolicLink() ||
    !anchor.isFile() ||
    anchor.nlink !== 2n ||
    !sameTargetIdentity(targetIdentityOf(current), expected) ||
    !sameTargetIdentity(targetIdentityOf(anchor), expected) ||
    !sameIdentity(current, anchor)
  ) {
    throw new Error("CSV output target identity changed before publication");
  }
}

async function isExactAnchoredTargetCandidate(
  candidate: BigIntStats,
  expected: TargetFileSnapshot,
  anchors: CsvOutputWriterAnchorPaths,
  expectedLinks = 2n,
): Promise<boolean> {
  if (
    candidate.isSymbolicLink() ||
    !candidate.isFile() ||
    candidate.nlink !== expectedLinks ||
    !sameTargetContentIdentity(targetIdentityOf(candidate), expected)
  ) {
    return false;
  }
  const handle = await open(
    anchors.targetCandidatePath,
    fsConstants.O_RDONLY | noFollowFlag(),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(before, candidate) || before.size !== candidate.size) {
      return false;
    }
    const sha256 = await sha256FileHandle(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    const current = await lstat(anchors.targetCandidatePath, { bigint: true });
    const anchor = await lstat(anchors.targetAnchorPath, { bigint: true });
    return (
      sha256 === expected.sha256 &&
      sameTargetIdentity(targetIdentityOf(after), targetIdentityOf(before)) &&
      sameIdentity(current, after) &&
      !anchor.isSymbolicLink() &&
      anchor.isFile() &&
      anchor.nlink === expectedLinks &&
      sameIdentity(anchor, after) &&
      anchor.ctimeNs === after.ctimeNs
    );
  } finally {
    await handle.close();
  }
}

class CsvTargetReplacementDetectedError extends Error {}

async function restoreCapturedTarget(
  targetPath: string,
  anchors: CsvOutputWriterAnchorPaths,
  candidate: BigIntStats,
): Promise<void> {
  if (candidate.isSymbolicLink() || !candidate.isFile()) {
    throw new Error("changed CSV target capture cannot be restored safely");
  }
  const current = await lstatIfPresent(targetPath);
  if (current === undefined) {
    await link(anchors.targetCandidatePath, targetPath);
    await syncDirectory(dirname(targetPath));
    await afterTargetRestoreLinkForTesting?.(targetPath);
  } else if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(current, candidate)
  ) {
    throw new Error("changed CSV target capture cannot be restored safely");
  }
  const restored = await lstat(targetPath, { bigint: true });
  const captured = await lstat(anchors.targetCandidatePath, { bigint: true });
  if (
    !sameIdentity(restored, candidate) ||
    !sameIdentity(captured, candidate) ||
    restored.nlink < 2n ||
    captured.nlink < 2n
  ) {
    throw new Error("changed CSV target capture restoration is invalid");
  }
  await unlink(anchors.targetCandidatePath);
  await syncDirectory(anchors.directoryPath);
  await syncDirectory(dirname(targetPath));
}

async function releaseCapturedTarget(
  targetPath: string,
  anchors: CsvOutputWriterAnchorPaths,
  expected: TargetFileSnapshot,
): Promise<void> {
  const candidate = await lstat(anchors.targetCandidatePath, { bigint: true });
  if (!(await isExactAnchoredTargetCandidate(candidate, expected, anchors))) {
    throw new Error("CSV output captured target identity changed");
  }
  await unlink(anchors.targetCandidatePath);
  const anchor = await lstat(anchors.targetAnchorPath, { bigint: true });
  if (
    anchor.isSymbolicLink() ||
    !anchor.isFile() ||
    anchor.nlink !== 1n ||
    !sameTargetContentIdentity(targetIdentityOf(anchor), expected)
  ) {
    throw new Error("CSV output target anchor changed while releasing");
  }
  await unlink(anchors.targetAnchorPath);
  await syncDirectory(anchors.directoryPath);
  await syncDirectory(dirname(targetPath));
}

async function releaseUncommittedTargetAnchor(
  targetPath: string,
  anchors: CsvOutputWriterAnchorPaths,
  expected: TargetFileIdentity,
): Promise<void> {
  const target = await lstat(targetPath, { bigint: true });
  const anchor = await lstat(anchors.targetAnchorPath, { bigint: true });
  if (
    target.isSymbolicLink() ||
    !target.isFile() ||
    target.nlink !== 2n ||
    anchor.isSymbolicLink() ||
    !anchor.isFile() ||
    anchor.nlink !== 2n ||
    !sameIdentity(target, expected) ||
    !sameIdentity(anchor, expected) ||
    !sameIdentity(target, anchor)
  ) {
    throw new Error("CSV output original target evidence must be retained");
  }
  await unlink(anchors.targetAnchorPath);
  await syncDirectory(anchors.directoryPath);
  await syncDirectory(dirname(targetPath));
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
      try {
        initializeDarwinCsvPrivatePath(path);
        assertWindowsPrivatePathSecurity(path, "file", true);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
      return { path, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("unable to allocate a private CSV output temporary");
}

async function createTrackedTemporaryOutput(input: {
  readonly parentPath: string;
  readonly jobId: string;
  readonly rootPath: string;
  readonly targetPath: string;
  readonly reservedBytes: number;
  readonly targetOriginalPresent: boolean;
  readonly intentStore: CsvOutputIntentStore;
}): Promise<{
  readonly temporary: { readonly path: string; readonly handle: FileHandle };
  readonly intentId: string;
}> {
  const safeJobId = safeJobFilename(input.jobId);
  for (let attempt = 0; attempt < CSV_OUTPUT_TEMP_ATTEMPTS; attempt += 1) {
    const path = join(
      input.parentPath,
      `.${safeJobId}.${randomUUID()}.agenc-csv.tmp`,
    );
    const intentId = input.intentStore.reserveCsvOutputIntent({
      jobId: input.jobId,
      rootPath: input.rootPath,
      targetPath: input.targetPath,
      temporaryPath: path,
      reservedBytes: input.reservedBytes,
      targetOriginalPresent: input.targetOriginalPresent,
    });
    try {
      const handle = await open(
        path,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          noFollowFlag(),
        0o600,
      );
      try {
        initializeDarwinCsvPrivatePath(path);
        assertWindowsPrivatePathSecurity(path, "file", true);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
      return { temporary: { path, handle }, intentId };
    } catch (error) {
      // O_EXCL did not return a handle, so this reservation owns no directory
      // entry and can release quota without authorizing any filesystem unlink.
      input.intentStore.abandonCsvOutputIntent(intentId, false);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
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

async function sha256FileHandle(
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CSV_OUTPUT_RECOVERY_READ_BYTES);
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const length = Math.min(buffer.byteLength, size - offset);
    const read = await handle.read(buffer, 0, length, offset);
    if (read.bytesRead <= 0) {
      throw new Error("CSV output target hash read made no progress");
    }
    digest.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  signal?.throwIfAborted();
  return digest.digest("hex");
}

async function cleanupPublishedTemporary(
  temporaryPath: string,
  expected: WriterFileIdentity,
  expectedLinksWithTemporary: bigint,
  expectedLinksWithoutTemporary: bigint,
  anchors: CsvOutputWriterAnchorPaths,
  targetPath: string,
): Promise<void> {
  const temporary = await lstatIfPresent(temporaryPath);
  if (
    temporary !== undefined &&
    !temporary.isSymbolicLink() &&
    temporary.isFile() &&
    sameIdentity(temporary, expected)
  ) {
    await unlinkExactTemporary(
      temporaryPath,
      expected,
      expectedLinksWithTemporary,
      anchors,
    );
    return;
  }

  // Publication came from the private authority link, so a swapped public
  // temporary is unrelated and must remain untouched. The lower link count
  // proves the writer's former public name is already gone.
  await assertWriterAnchorProof(anchors, expected, false);
  const target = await lstat(targetPath, { bigint: true });
  const references = await writerAnchorReferences(anchors);
  if (
    target.isSymbolicLink() ||
    !target.isFile() ||
    target.nlink !== expectedLinksWithoutTemporary ||
    !sameIdentity(target, expected) ||
    references.some(
      (reference) => reference.stats.nlink !== expectedLinksWithoutTemporary,
    )
  ) {
    throw new Error("CSV output writer link state changed after publication");
  }
}

class CsvTemporaryReplacementDetectedError extends Error {}

async function unlinkExactTemporary(
  path: string,
  expected: WriterFileIdentity,
  expectedLinkCount: bigint,
  anchors: CsvOutputWriterAnchorPaths,
): Promise<void> {
  assertValidWriterIdentity(expected);
  await assertPrivateCaptureDirectory(anchors.directoryPath);
  await assertWriterAnchorProof(anchors, expected, false);
  if ((await lstatIfPresent(anchors.candidatePath)) !== undefined) {
    throw new Error("CSV output writer capture is already occupied");
  }
  const current = await lstat(path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== expectedLinkCount ||
    !sameIdentity(current, expected)
  ) {
    throw new Error("refusing to unlink a changed CSV output temporary");
  }
  await beforeExactUnlinkCaptureForTesting?.(path);
  await rename(path, anchors.candidatePath);
  await afterExactUnlinkCaptureForTesting?.(anchors.candidatePath);
  const candidate = await lstat(anchors.candidatePath, { bigint: true });
  if (
    candidate.isSymbolicLink() ||
    !candidate.isFile() ||
    candidate.nlink !== expectedLinkCount ||
    !sameIdentity(candidate, expected)
  ) {
    await restoreCapturedReplacement(path, anchors, candidate);
    throw new CsvTemporaryReplacementDetectedError(
      "refusing to unlink a changed CSV output temporary",
    );
  }
  await assertWriterAnchorProof(anchors, expected, true);
  await unlink(anchors.candidatePath);
  await syncDirectory(anchors.directoryPath);
  await syncDirectory(dirname(path));
}

async function assertPrivateCaptureDirectory(
  path: string,
  observed?: BigIntStats,
): Promise<void> {
  assertWindowsPrivatePathSecurity(path, "directory", false);
  const stats = observed ?? (await lstat(path, { bigint: true }));
  const currentUid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (process.platform !== "win32" && (stats.mode & 0o077n) !== 0n) ||
    (currentUid !== undefined && stats.uid !== BigInt(currentUid))
  ) {
    throw new Error("CSV output cleanup capture is not a private directory");
  }
}

async function restoreCapturedReplacement(
  temporaryPath: string,
  anchors: CsvOutputWriterAnchorPaths,
  candidate: BigIntStats,
): Promise<void> {
  if (candidate.isSymbolicLink() || !candidate.isFile()) {
    throw new Error("changed CSV output capture cannot be restored safely");
  }
  await assertWriterAnchorDirectoryEntries(anchors, true);
  const current = await lstatIfPresent(temporaryPath);
  if (current === undefined) {
    await link(anchors.candidatePath, temporaryPath);
  } else if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(current, candidate)
  ) {
    throw new Error("changed CSV output capture cannot be restored safely");
  }
  const restored = await lstat(temporaryPath, { bigint: true });
  const captured = await lstat(anchors.candidatePath, { bigint: true });
  if (
    !sameIdentity(restored, candidate) ||
    !sameIdentity(captured, candidate) ||
    restored.nlink < 2n ||
    captured.nlink < 2n
  ) {
    throw new Error("changed CSV output capture restoration is invalid");
  }
  await unlink(anchors.candidatePath);
  await syncDirectory(anchors.directoryPath);
  await syncDirectory(dirname(temporaryPath));
}

async function assertWriterAnchorSet(
  anchors: CsvOutputWriterAnchorPaths,
  expected: WriterFileIdentity,
  temporaryPath: string,
): Promise<void> {
  await assertPrivateCaptureDirectory(anchors.directoryPath);
  await assertWriterAnchorDirectoryEntries(anchors, false);
  const temporary = await lstat(temporaryPath, { bigint: true });
  const anchor = await lstat(anchors.anchorPath, { bigint: true });
  const authority = await lstat(anchors.authorityPath, { bigint: true });
  if (
    temporary.isSymbolicLink() ||
    !temporary.isFile() ||
    anchor.isSymbolicLink() ||
    !anchor.isFile() ||
    authority.isSymbolicLink() ||
    !authority.isFile() ||
    temporary.nlink !== 3n ||
    anchor.nlink !== 3n ||
    authority.nlink !== 3n ||
    !sameIdentity(temporary, expected) ||
    !sameIdentity(anchor, expected) ||
    !sameIdentity(authority, expected)
  ) {
    throw new Error("CSV output durable writer anchor is invalid");
  }
}

async function assertWriterAnchorProof(
  anchors: CsvOutputWriterAnchorPaths,
  expected: WriterFileIdentity,
  allowCandidate: boolean,
): Promise<void> {
  await assertWriterAnchorDirectoryEntries(anchors, allowCandidate);
  const references = await writerAnchorReferences(anchors);
  if (references.length === 0) {
    throw new Error("CSV output durable writer anchor is missing");
  }
  for (const reference of references) {
    if (
      reference.stats.isSymbolicLink() ||
      !reference.stats.isFile() ||
      !sameIdentity(reference.stats, expected)
    ) {
      throw new Error("CSV output durable writer anchor identity changed");
    }
  }
}

async function assertWriterAnchorDirectoryEntries(
  anchors: CsvOutputWriterAnchorPaths,
  allowCandidate: boolean,
): Promise<void> {
  const allowed = new Set([
    "anchor",
    "authority",
    "target-anchor",
    "target-candidate",
    ...(allowCandidate ? ["candidate"] : []),
  ]);
  const entries = await readdir(anchors.directoryPath);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error("CSV output writer anchor contains unknown entries");
  }
}

async function writerAnchorReferences(
  anchors: CsvOutputWriterAnchorPaths,
): Promise<
  ReadonlyArray<{ readonly path: string; readonly stats: BigIntStats }>
> {
  const references: Array<{
    readonly path: string;
    readonly stats: BigIntStats;
  }> = [];
  for (const path of [anchors.anchorPath, anchors.authorityPath]) {
    const stats = await lstatIfPresent(path);
    if (stats !== undefined) references.push({ path, stats });
  }
  return references;
}

async function releaseWriterAnchors(
  anchors: CsvOutputWriterAnchorPaths,
  expected: WriterFileIdentity,
  expectedExternalLinks: bigint,
): Promise<void> {
  await assertPrivateCaptureDirectory(anchors.directoryPath);
  await assertWriterAnchorProof(anchors, expected, false);
  const references = await writerAnchorReferences(anchors);
  const expectedLinks = BigInt(references.length) + expectedExternalLinks;
  const proof = await open(
    references[0]!.path,
    fsConstants.O_RDONLY | noFollowFlag(),
  );
  try {
    const pinned = await proof.stat({ bigint: true });
    if (
      !pinned.isFile() ||
      pinned.nlink !== expectedLinks ||
      !sameIdentity(pinned, expected) ||
      references.some(
        (reference) =>
          reference.stats.nlink !== expectedLinks ||
          !sameIdentity(reference.stats, pinned),
      )
    ) {
      throw new Error("CSV output writer anchor link state is invalid");
    }
    if (
      references.some((reference) => reference.path === anchors.authorityPath)
    ) {
      await unlink(anchors.authorityPath);
    }
    if (references.some((reference) => reference.path === anchors.anchorPath)) {
      await unlink(anchors.anchorPath);
    }
    await syncDirectory(anchors.directoryPath);
    if ((await readdir(anchors.directoryPath)).length === 0) {
      await rmdir(anchors.directoryPath);
      await syncDirectory(dirname(anchors.directoryPath));
    }
  } finally {
    await proof.close();
  }
  await afterWriterAnchorsReleasedForTesting?.(anchors.directoryPath);
}

function safeJobFilename(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96);
  return safe.length === 0 ? "csv-job" : safe;
}

function identityOf(stats: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function writerIdentityOf(
  stats: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): WriterFileIdentity {
  return {
    ...identityOf(stats),
    birthtimeNs: stats.birthtimeNs,
  };
}

function assertValidWriterIdentity(identity: WriterFileIdentity): void {
  if (identity.dev < 0n || identity.ino <= 0n || identity.birthtimeNs < 0n) {
    throw new Error("CSV output writer identity is invalid");
  }
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

function sameTargetContentIdentity(
  left: TargetFileIdentity,
  right: TargetFileIdentity,
): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
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

function directoryOpenFlag(): number {
  // libuv opens directories with FILE_FLAG_BACKUP_SEMANTICS on Windows, but
  // FlushFileBuffers (Node's fsync implementation there) requires write
  // access. POSIX directories must remain read-only because O_RDWR is rejected.
  return process.platform === "win32"
    ? fsConstants.O_RDWR
    : fsConstants.O_RDONLY;
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

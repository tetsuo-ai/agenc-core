import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  canonicalizeJson,
  digestDomainSeparated,
  sha256Digest,
} from "./canonical-json.js";
import {
  computeEvidenceEventDigest,
  computeEvidenceSealStatementDigest,
  validateEvalContractDocument,
} from "./validation.js";
import {
  EVAL_CONTRACT_VERSION,
  type EvidenceAnchorReceipt,
  type EvidenceEventDocument,
  type EvidenceLedgerSeal,
  type EvidenceLedgerSealDocument,
  type EvidenceLedgerSealStatement,
  type Sha256Digest,
} from "./types.js";
import {
  acquireLocalSqliteLock,
  assertLocalPrivateDirectory,
} from "../utils/sqlite-lock.js";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SEAL_FILE_PATTERN = /^sha256-[0-9a-f]{64}\.json$/u;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const DEFAULT_EVIDENCE_LIMITS = Object.freeze({
  maximumEventBytes: 1024 * 1024,
  maximumPayloadBytes: 16 * 1024 * 1024,
  maximumLedgerBytes: 64 * 1024 * 1024,
  maximumEvents: 100_000,
});

export interface EvidenceLimits {
  readonly maximumEventBytes: number;
  readonly maximumPayloadBytes: number;
  readonly maximumLedgerBytes: number;
  readonly maximumEvents: number;
}

export type EvidenceArtifactKind =
  | "directory"
  | "metadata"
  | "ledger"
  | "payload"
  | "freeze"
  | "seal"
  | "lock";

export interface PlatformProtectionVerifier {
  readonly verifierDigest: Sha256Digest;
  verify(path: string, kind: EvidenceArtifactKind): boolean | Promise<boolean>;
}

export interface EvidenceLedgerAccess {
  readonly root: string;
  readonly limits?: Partial<EvidenceLimits>;
  readonly lockTimeoutMs?: number;
  /** Required on macOS/Windows to verify read ACLs and reparse-point policy. */
  readonly platformProtection?: PlatformProtectionVerifier;
  /** Fault hook used by deterministic durability tests; it cannot skip real syncs. */
  readonly durabilityHooks?: {
    beforeFileSync?(path: string, kind: Exclude<EvidenceArtifactKind, "directory">): void | Promise<void>;
    beforeDirectorySync?(path: string): void | Promise<void>;
  };
}

export interface EvidenceLedgerContext {
  readonly runId: string;
  readonly contractDigest: Sha256Digest;
  readonly taskId: string;
  readonly systemId: string;
}

export interface EvidenceEventBody extends EvidenceLedgerContext {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly producer: EvidenceEventDocument["producer"];
  readonly type: EvidenceEventDocument["type"];
  readonly mediaType: string;
  readonly redactionPolicyDigest: Sha256Digest;
}

export interface AppendEvidenceEventOptions extends EvidenceLedgerAccess {
  readonly event: EvidenceEventBody;
  /** Already-redacted, unaggregated restricted evidence. */
  readonly payloadBytes: Uint8Array;
}

export interface AppendEvidenceEventResult {
  readonly status: "appended" | "already_present";
  readonly event: EvidenceEventDocument;
}

export interface EvidenceLedgerPaths {
  readonly root: string;
  readonly metadata: string;
  readonly ledger: string;
  readonly lock: string;
  readonly freeze: string;
  readonly payloads: string;
  readonly seals: string;
}

export interface IntegrityOnlyEvidenceInspection extends EvidenceLedgerContext {
  readonly trust: "integrity_only_unanchored";
  readonly platformProtectionVerifierDigest: Sha256Digest | null;
  readonly ledgerDigest: Sha256Digest;
  readonly ledgerByteLength: number;
  readonly genesisEventDigest: Sha256Digest | null;
  readonly headEventDigest: Sha256Digest | null;
  readonly eventCount: number;
  readonly terminal: boolean;
  readonly events: readonly EvidenceEventDocument[];
}

export interface EvidenceAnchorProvider {
  readonly anchorPolicyDigest: Sha256Digest;
  readonly verifierDigest: Sha256Digest;
  anchor(
    statementBytes: Uint8Array,
    statementDigest: Sha256Digest,
  ): Promise<EvidenceAnchorReceipt>;
  verify(
    statementBytes: Uint8Array,
    receipt: EvidenceAnchorReceipt,
  ): boolean | Promise<boolean>;
}

export interface SealEvidenceLedgerOptions extends EvidenceLedgerAccess {
  readonly context: EvidenceLedgerContext;
  readonly sealedAt: string;
  readonly anchorProvider: EvidenceAnchorProvider;
}

export interface EvidenceAnchorVerifier {
  readonly anchorPolicyDigest: Sha256Digest;
  readonly verifierDigest: Sha256Digest;
  verify(
    statementBytes: Uint8Array,
    receipt: EvidenceAnchorReceipt,
  ): boolean | Promise<boolean>;
}

export interface VerifyEvidenceLedgerOptions extends EvidenceLedgerAccess {
  readonly runId: string;
  /** Must come from outside the evidence root. Local discovery is forbidden. */
  readonly expectedSealDigest: Sha256Digest;
  readonly anchorVerifier: EvidenceAnchorVerifier;
}

export interface VerifiedEvidenceLedger {
  readonly trust: "externally_anchored";
  readonly inspection: IntegrityOnlyEvidenceInspection;
  readonly seal: EvidenceLedgerSeal;
  readonly anchorVerifierDigest: Sha256Digest;
  readonly platformProtectionVerifierDigest: Sha256Digest | null;
}

const externallyVerifiedEvidence = new WeakSet<object>();

function deepFreezeVerifiedEvidence<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeVerifiedEvidence(nested);
  }
  return Object.freeze(value);
}

/** Runtime authenticity check used before evidence may enter score derivation. */
export function isExternallyVerifiedEvidenceLedger(
  value: unknown,
): value is VerifiedEvidenceLedger {
  return typeof value === "object" && value !== null && externallyVerifiedEvidence.has(value);
}

export type EvidenceLedgerErrorCode =
  | "EVIDENCE_ALREADY_EXISTS"
  | "EVIDENCE_CONFLICT"
  | "EVIDENCE_CORRUPT"
  | "EVIDENCE_LIMIT"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_PERMISSION"
  | "EVIDENCE_SEALED"
  | "EVIDENCE_UNANCHORED";

export class EvidenceLedgerError extends Error {
  readonly code: EvidenceLedgerErrorCode;

  constructor(code: EvidenceLedgerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvidenceLedgerError";
    this.code = code;
  }
}

interface EvidenceByteWriter {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesWritten: number }>;
}

/** Handles short writes; zero progress fails instead of spinning forever. */
export async function writeAllEvidenceBytes(
  writer: EvidenceByteWriter,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await writer.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
      throw new EvidenceLedgerError(
        "EVIDENCE_CORRUPT",
        "evidence write made no safe forward progress",
      );
    }
    offset += bytesWritten;
  }
}

function limitsFor(options: EvidenceLedgerAccess): EvidenceLimits {
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new EvidenceLedgerError("EVIDENCE_LIMIT", `${name} must be a positive safe integer`);
    }
  }
  if (
    limits.maximumEventBytes > limits.maximumLedgerBytes ||
    limits.maximumPayloadBytes > limits.maximumLedgerBytes
  ) {
    throw new EvidenceLedgerError(
      "EVIDENCE_LIMIT",
      "event and payload limits must not exceed the ledger limit",
    );
  }
  return limits;
}

function assertIdentifier(value: string, label: string): void {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new EvidenceLedgerError("EVIDENCE_CONFLICT", `${label} is not a contract identifier`);
  }
}

function runKey(runId: string): string {
  assertIdentifier(runId, "runId");
  return digestDomainSeparated("agenc.eval.run-path.v1", runId).slice("sha256:".length);
}

function pathsFor(root: string, runId: string): EvidenceLedgerPaths {
  const key = runKey(runId);
  const prefix = `run-${key}`;
  return {
    root,
    metadata: path.join(root, `${prefix}.metadata.json`),
    ledger: path.join(root, `${prefix}.events.ndjson`),
    lock: path.join(root, `${prefix}.lock.sqlite`),
    freeze: path.join(root, `${prefix}.freeze.json`),
    payloads: path.join(root, `${prefix}.payloads`),
    seals: path.join(root, `${prefix}.seals`),
  };
}

interface EvidenceLedgerMetadata {
  readonly kind: "agenc.eval.evidence-ledger-metadata";
  readonly contractVersion: typeof EVAL_CONTRACT_VERSION;
  readonly runId: string;
  readonly platformProtectionVerifierDigest: Sha256Digest | null;
}

function metadataFor(
  access: EvidenceLedgerAccess,
  runId: string,
): EvidenceLedgerMetadata {
  const verifierDigest = access.platformProtection?.verifierDigest ?? null;
  if (verifierDigest !== null && !DIGEST_PATTERN.test(verifierDigest)) {
    throw new EvidenceLedgerError(
      "EVIDENCE_PERMISSION",
      "platform protection verifier digest is not a SHA-256 digest",
    );
  }
  return {
    kind: "agenc.eval.evidence-ledger-metadata",
    contractVersion: EVAL_CONTRACT_VERSION,
    runId,
    platformProtectionVerifierDigest: verifierDigest,
  };
}

function metadataBytes(metadata: EvidenceLedgerMetadata): Buffer {
  return Buffer.from(`${canonicalizeJson(metadata)}\n`, "utf8");
}

async function verifyPlatformProtection(
  options: EvidenceLedgerAccess,
  artifactPath: string,
  kind: EvidenceArtifactKind,
): Promise<void> {
  const requiresExternalAclCheck = process.platform === "darwin" || process.platform === "win32";
  if (requiresExternalAclCheck && !options.platformProtection) {
    throw new EvidenceLedgerError(
      "EVIDENCE_PERMISSION",
      `a pinned platform protection verifier is required for ${process.platform}`,
    );
  }
  if (options.platformProtection && !DIGEST_PATTERN.test(options.platformProtection.verifierDigest)) {
    throw new EvidenceLedgerError(
      "EVIDENCE_PERMISSION",
      "platform protection verifier digest is not a SHA-256 digest",
    );
  }
  if (options.platformProtection && !(await options.platformProtection.verify(artifactPath, kind))) {
    throw new EvidenceLedgerError(
      "EVIDENCE_PERMISSION",
      `${kind} failed the pinned platform protection verifier`,
    );
  }
}

async function assertPrivateDirectory(
  directory: string,
  options: EvidenceLedgerAccess,
): Promise<void> {
  const leaf = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    throw new EvidenceLedgerError("EVIDENCE_NOT_FOUND", `missing evidence directory ${directory}`, {
      cause: error,
    });
  });
  if (!leaf.isDirectory() || leaf.isSymbolicLink()) {
    throw new EvidenceLedgerError("EVIDENCE_PERMISSION", `${directory} is not a real directory`);
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && leaf.uid !== process.getuid()) {
      throw new EvidenceLedgerError("EVIDENCE_PERMISSION", `${directory} has the wrong owner`);
    }
    if ((leaf.mode & 0o777) !== 0o700) {
      throw new EvidenceLedgerError("EVIDENCE_PERMISSION", `${directory} must have mode 0700`);
    }
  }
  await verifyPlatformProtection(options, directory, "directory");
}

async function canonicalEvidenceRoot(options: EvidenceLedgerAccess): Promise<string> {
  await assertLocalPrivateDirectory(options.root, { label: "evaluation evidence root" });
  const canonical = await realpath(options.root);
  await assertPrivateDirectory(canonical, options);
  return canonical;
}

async function assertPrivateFile(
  filePath: string,
  handle: FileHandle,
  options: EvidenceLedgerAccess,
  kind: Exclude<EvidenceArtifactKind, "directory">,
): Promise<BigIntStats> {
  const [leaf, opened] = await Promise.all([
    lstat(filePath, { bigint: true }),
    handle.stat({ bigint: true }),
  ]);
  if (
    leaf.isSymbolicLink() ||
    !leaf.isFile() ||
    !opened.isFile() ||
    leaf.dev !== opened.dev ||
    leaf.ino !== opened.ino ||
    opened.nlink !== 1n
  ) {
    throw new EvidenceLedgerError(
      "EVIDENCE_PERMISSION",
      `${kind} path and opened descriptor are not the same single-link regular file`,
    );
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid())) {
      throw new EvidenceLedgerError("EVIDENCE_PERMISSION", `${kind} has the wrong owner`);
    }
    if ((opened.mode & 0o777n) !== 0o600n) {
      throw new EvidenceLedgerError("EVIDENCE_PERMISSION", `${kind} must have mode 0600`);
    }
  }
  await verifyPlatformProtection(options, filePath, kind);
  return opened;
}

async function syncDirectory(
  directory: string,
  access?: EvidenceLedgerAccess,
): Promise<void> {
  if (process.platform === "win32") return;
  await access?.durabilityHooks?.beforeDirectorySync?.(directory);
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createPrivateDirectory(
  directory: string,
  options: EvidenceLedgerAccess,
): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  await assertPrivateDirectory(directory, options);
}

async function createPrivateFile(
  filePath: string,
  bytes: Uint8Array,
  options: EvidenceLedgerAccess,
  kind: Exclude<EvidenceArtifactKind, "directory">,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    await assertPrivateFile(filePath, handle, options, kind);
    await writeAllEvidenceBytes(handle, bytes);
    await options.durabilityHooks?.beforeFileSync?.(filePath, kind);
    await handle.sync();
    await assertPrivateFile(filePath, handle, options, kind);
  } finally {
    await handle.close();
  }
}

async function resyncExactPrivateFile(
  filePath: string,
  expectedBytes: Uint8Array,
  options: EvidenceLedgerAccess,
  kind: Exclude<EvidenceArtifactKind, "directory">,
  parentDirectory: string,
): Promise<Buffer> {
  const handle = await open(filePath, openExistingFlags(false));
  try {
    await assertPrivateFile(filePath, handle, options, kind);
    const bytes = await handle.readFile();
    if (!bytes.equals(Buffer.from(expectedBytes))) {
      throw new EvidenceLedgerError("EVIDENCE_CONFLICT", `${kind} retry bytes differ`);
    }
    await options.durabilityHooks?.beforeFileSync?.(filePath, kind);
    await handle.sync();
    await assertPrivateFile(filePath, handle, options, kind);
    await syncDirectory(parentDirectory, options);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function withLedgerLock<T>(
  access: EvidenceLedgerAccess,
  runId: string,
  action: (paths: EvidenceLedgerPaths) => Promise<T>,
): Promise<T> {
  const root = await canonicalEvidenceRoot(access);
  const paths = pathsFor(root, runId);
  const release = await acquireLocalSqliteLock(paths.lock, {
    label: `evaluation evidence ${runId}`,
    timeoutMs: access.lockTimeoutMs ?? 10_000,
  });
  try {
    const lockHandle = await open(paths.lock, fsConstants.O_RDONLY);
    try {
      await assertPrivateFile(paths.lock, lockHandle, access, "lock");
    } finally {
      await lockHandle.close();
    }
    return await action(paths);
  } finally {
    release();
  }
}

export async function initializeEvidenceLedger(
  access: EvidenceLedgerAccess,
  runId: string,
): Promise<EvidenceLedgerPaths> {
  limitsFor(access);
  return withLedgerLock(access, runId, async (paths) => {
    if (await exists(paths.freeze)) {
      throw new EvidenceLedgerError(
        "EVIDENCE_ALREADY_EXISTS",
        `evidence ledger is already frozen for ${runId}`,
      );
    }
    for (const directory of [paths.payloads, paths.seals]) {
      try {
        await createPrivateDirectory(directory, access);
        await syncDirectory(paths.root, access);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await assertPrivateDirectory(directory, access);
      }
    }
    if ((await readdir(paths.payloads)).length > 0 || (await readdir(paths.seals)).length > 0) {
      throw new EvidenceLedgerError(
        "EVIDENCE_ALREADY_EXISTS",
        `evidence initialization found non-empty run artifacts for ${runId}`,
      );
    }
    const expectedMetadata = metadataBytes(metadataFor(access, runId));
    if (await exists(paths.metadata)) {
      await resyncExactPrivateFile(
        paths.metadata,
        expectedMetadata,
        access,
        "metadata",
        paths.root,
      );
    } else {
      await createPrivateFile(paths.metadata, expectedMetadata, access, "metadata");
      await syncDirectory(paths.root, access);
    }
    if (await exists(paths.ledger)) {
      const bytes = await readPrivateFile(paths.ledger, access, "ledger", 1);
      if (bytes.byteLength > 0) {
        throw new EvidenceLedgerError(
          "EVIDENCE_ALREADY_EXISTS",
          `evidence ledger already contains events for ${runId}`,
        );
      }
      await resyncExactPrivateFile(paths.ledger, bytes, access, "ledger", paths.root);
    } else {
      await createPrivateFile(paths.ledger, new Uint8Array(), access, "ledger");
    }
    await syncDirectory(paths.root, access);
    return paths;
  });
}

function openExistingFlags(readOnly: boolean): number {
  let flags = readOnly ? fsConstants.O_RDONLY : fsConstants.O_RDWR | fsConstants.O_APPEND;
  if (process.platform !== "win32") flags |= fsConstants.O_NOFOLLOW;
  return flags;
}

function corrupt(message: string, cause?: unknown): EvidenceLedgerError {
  return new EvidenceLedgerError("EVIDENCE_CORRUPT", message, { cause });
}

function decodeCanonicalLines(bytes: Buffer, limits: EvidenceLimits): EvidenceEventDocument[] {
  if (bytes.byteLength === 0) return [];
  if (bytes.subarray(0, 3).equals(UTF8_BOM)) throw corrupt("evidence ledger has a UTF-8 BOM");
  if (bytes.at(-1) !== 0x0a) throw corrupt("evidence ledger has a torn tail or missing final LF");
  if (bytes.includes(0x0d)) throw corrupt("evidence ledger contains CR/CRLF bytes");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw corrupt("evidence ledger is not valid UTF-8", error);
  }
  const lines = text.split("\n");
  lines.pop();
  if (lines.length > limits.maximumEvents) throw corrupt("evidence event count exceeds its limit");
  const events: EvidenceEventDocument[] = [];
  const eventIds = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) throw corrupt(`evidence line ${index} is empty`);
    if (Buffer.byteLength(line, "utf8") + 1 > limits.maximumEventBytes) {
      throw corrupt(`evidence line ${index} exceeds its byte limit`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw corrupt(`evidence line ${index} is not JSON`, error);
    }
    let canonical: string;
    try {
      canonical = canonicalizeJson(parsed);
    } catch (error) {
      throw corrupt(`evidence line ${index} is not canonicalizable I-JSON`, error);
    }
    if (canonical !== line) {
      throw corrupt(`evidence line ${index} is not exact canonical JSON`);
    }
    let event: EvidenceEventDocument;
    try {
      event = validateEvalContractDocument(parsed) as EvidenceEventDocument;
    } catch (error) {
      throw corrupt(`evidence line ${index} violates the evaluation contract`, error);
    }
    if (event.sequence !== index) throw corrupt(`evidence line ${index} has a sequence gap`);
    if (eventIds.has(event.eventId)) throw corrupt(`duplicate evidence eventId ${event.eventId}`);
    eventIds.add(event.eventId);
    if (index === 0) {
      if (event.type !== "run.started" || event.previousEventDigest !== null) {
        throw corrupt("the genesis event must be run.started with no previous digest");
      }
    } else {
      const previous = events[index - 1];
      if (event.previousEventDigest !== previous.eventDigest) {
        throw corrupt(`evidence line ${index} does not link to the preceding event`);
      }
      if (Date.parse(event.occurredAt) < Date.parse(previous.occurredAt)) {
        throw corrupt(`evidence line ${index} moves occurredAt backwards`);
      }
      const genesis = events[0];
      if (
        event.runId !== genesis.runId ||
        event.contractDigest !== genesis.contractDigest ||
        event.taskId !== genesis.taskId ||
        event.systemId !== genesis.systemId
      ) {
        throw corrupt(`evidence line ${index} changes immutable run identity`);
      }
      if (previous.type === "run.finished") {
        throw corrupt("evidence appears after the terminal run.finished event");
      }
    }
    events.push(event);
  }
  return events;
}

async function readLedger(
  paths: EvidenceLedgerPaths,
  access: EvidenceLedgerAccess,
): Promise<{
  readonly bytes: Buffer;
  readonly events: readonly EvidenceEventDocument[];
  readonly identity: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint };
}> {
  const limits = limitsFor(access);
  const handle = await open(paths.ledger, openExistingFlags(true)).catch((error: NodeJS.ErrnoException) => {
    throw new EvidenceLedgerError("EVIDENCE_NOT_FOUND", "evidence ledger does not exist", {
      cause: error,
    });
  });
  try {
    const before = await assertPrivateFile(paths.ledger, handle, access, "ledger");
    if (before.size > BigInt(limits.maximumLedgerBytes)) {
      throw new EvidenceLedgerError("EVIDENCE_LIMIT", "evidence ledger exceeds its byte limit");
    }
    const bytes = await handle.readFile();
    const after = await assertPrivateFile(paths.ledger, handle, access, "ledger");
    if (after.size !== BigInt(bytes.byteLength) || before.size !== after.size) {
      throw corrupt("evidence ledger changed during a locked read");
    }
    return {
      bytes,
      events: decodeCanonicalLines(bytes, limits),
      identity: { dev: after.dev, ino: after.ino, size: after.size },
    };
  } finally {
    await handle.close();
  }
}

async function readPrivateFile(
  filePath: string,
  access: EvidenceLedgerAccess,
  kind: Exclude<EvidenceArtifactKind, "directory">,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(filePath, openExistingFlags(true));
  try {
    const before = await assertPrivateFile(filePath, handle, access, kind);
    if (before.size > BigInt(maximumBytes)) {
      throw new EvidenceLedgerError("EVIDENCE_LIMIT", `${kind} exceeds its byte limit`);
    }
    const bytes = await handle.readFile();
    const after = await assertPrivateFile(filePath, handle, access, kind);
    if (before.size !== after.size || after.size !== BigInt(bytes.byteLength)) {
      throw corrupt(`${kind} changed during a locked read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertMetadataBinding(
  paths: EvidenceLedgerPaths,
  access: EvidenceLedgerAccess,
  runId: string,
): Promise<EvidenceLedgerMetadata> {
  const bytes = await readPrivateFile(paths.metadata, access, "metadata", 16 * 1024).catch(
    (error) => {
      throw new EvidenceLedgerError(
        "EVIDENCE_PERMISSION",
        "evidence ledger is missing its immutable platform-verifier metadata",
        { cause: error },
      );
    },
  );
  const metadata = parseCanonicalObject<EvidenceLedgerMetadata>(bytes, "evidence metadata");
  const expected = metadataFor(access, runId);
  if (canonicalizeJson(metadata) !== canonicalizeJson(expected)) {
    throw new EvidenceLedgerError(
      "EVIDENCE_PERMISSION",
      "evidence operation used a different platform protection verifier",
    );
  }
  return metadata;
}

function payloadPath(paths: EvidenceLedgerPaths, digest: Sha256Digest): string {
  return path.join(paths.payloads, `sha256-${digest.slice("sha256:".length)}.bin`);
}

async function verifyPayload(
  paths: EvidenceLedgerPaths,
  access: EvidenceLedgerAccess,
  event: EvidenceEventDocument,
): Promise<void> {
  const bytes = await readPrivateFile(
    payloadPath(paths, event.payload.digest),
    access,
    "payload",
    limitsFor(access).maximumPayloadBytes,
  ).catch((error) => {
    throw corrupt(`payload for event ${event.eventId} is missing or unreadable`, error);
  });
  if (bytes.byteLength !== event.payload.sizeBytes || sha256Digest(bytes) !== event.payload.digest) {
    throw corrupt(`payload for event ${event.eventId} does not match its content address`);
  }
}

function inspectionFrom(
  bytes: Buffer,
  events: readonly EvidenceEventDocument[],
  expectedRunId: string,
  platformProtectionVerifierDigest: Sha256Digest | null,
): IntegrityOnlyEvidenceInspection {
  const genesis = events[0];
  if (genesis && genesis.runId !== expectedRunId) {
    throw corrupt("ledger runId does not match its digest-derived path");
  }
  return {
    trust: "integrity_only_unanchored",
    runId: expectedRunId,
    platformProtectionVerifierDigest,
    contractDigest: genesis?.contractDigest ?? `sha256:${"0".repeat(64)}`,
    taskId: genesis?.taskId ?? "empty",
    systemId: genesis?.systemId ?? "empty",
    ledgerDigest: sha256Digest(bytes),
    ledgerByteLength: bytes.byteLength,
    genesisEventDigest: genesis?.eventDigest ?? null,
    headEventDigest: events.at(-1)?.eventDigest ?? null,
    eventCount: events.length,
    terminal: events.at(-1)?.type === "run.finished",
    events,
  };
}

async function inspectLocked(
  paths: EvidenceLedgerPaths,
  access: EvidenceLedgerAccess,
  runId: string,
): Promise<IntegrityOnlyEvidenceInspection> {
  const metadata = await assertMetadataBinding(paths, access, runId);
  await assertPrivateDirectory(paths.payloads, access);
  await assertPrivateDirectory(paths.seals, access);
  const { bytes, events } = await readLedger(paths, access);
  for (const event of events) await verifyPayload(paths, access, event);
  return inspectionFrom(bytes, events, runId, metadata.platformProtectionVerifierDigest);
}

export async function inspectEvidenceLedger(
  access: EvidenceLedgerAccess,
  runId: string,
): Promise<IntegrityOnlyEvidenceInspection> {
  return withLedgerLock(access, runId, (paths) => inspectLocked(paths, access, runId));
}

function eventIdentityProjection(event: EvidenceEventDocument): unknown {
  const { sequence: _sequence, previousEventDigest: _previous, eventDigest: _digest, ...identity } = event;
  return identity;
}

async function persistPayload(
  paths: EvidenceLedgerPaths,
  access: EvidenceLedgerAccess,
  bytes: Uint8Array,
  digest: Sha256Digest,
): Promise<void> {
  const filePath = payloadPath(paths, digest);
  try {
    await createPrivateFile(filePath, bytes, access, "payload");
    await syncDirectory(paths.payloads, access);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await resyncExactPrivateFile(
      filePath,
      bytes,
      access,
      "payload",
      paths.payloads,
    );
  }
}

export async function appendEvidenceEvent(
  options: AppendEvidenceEventOptions,
): Promise<AppendEvidenceEventResult> {
  const limits = limitsFor(options);
  if (options.payloadBytes.byteLength > limits.maximumPayloadBytes) {
    throw new EvidenceLedgerError("EVIDENCE_LIMIT", "evidence payload exceeds its byte limit");
  }
  assertIdentifier(options.event.eventId, "eventId");
  const payloadDigest = sha256Digest(options.payloadBytes);
  const payload = {
    digest: payloadDigest,
    sizeBytes: options.payloadBytes.byteLength,
    mediaType: options.event.mediaType,
    uri: `cas://sha256/${payloadDigest.slice("sha256:".length)}`,
    sensitivity: "restricted" as const,
    redactionPolicyDigest: options.event.redactionPolicyDigest,
  };
  return withLedgerLock(options, options.event.runId, async (paths) => {
    await assertMetadataBinding(paths, options, options.event.runId);
    await assertPrivateDirectory(paths.payloads, options);
    await assertPrivateDirectory(paths.seals, options);
    if (await exists(paths.freeze)) {
      throw new EvidenceLedgerError("EVIDENCE_SEALED", "evidence ledger is durably frozen");
    }
    const sealEntries = await readdir(paths.seals);
    if (sealEntries.length > 0) {
      throw new EvidenceLedgerError("EVIDENCE_SEALED", "evidence ledger already has a seal");
    }
    const current = await readLedger(paths, options);
    const events = current.events;
    const duplicate = events.find((event) => event.eventId === options.event.eventId);
    const candidateBase = {
      kind: "agenc.eval.evidence-event" as const,
      contractVersion: EVAL_CONTRACT_VERSION,
      runId: options.event.runId,
      eventId: options.event.eventId,
      contractDigest: options.event.contractDigest,
      taskId: options.event.taskId,
      systemId: options.event.systemId,
      occurredAt: options.event.occurredAt,
      producer: options.event.producer,
      type: options.event.type,
      payload,
    };
    if (duplicate) {
      if (canonicalizeJson(eventIdentityProjection(duplicate)) !== canonicalizeJson(candidateBase)) {
        throw new EvidenceLedgerError(
          "EVIDENCE_CONFLICT",
          `eventId ${options.event.eventId} was already used for different evidence`,
        );
      }
      await resyncExactPrivateFile(
        paths.ledger,
        current.bytes,
        options,
        "ledger",
        paths.root,
      );
      return { status: "already_present" as const, event: duplicate };
    }
    if (events.length >= limits.maximumEvents) {
      throw new EvidenceLedgerError(
        "EVIDENCE_LIMIT",
        "evidence event count would exceed its limit",
      );
    }
    const genesis = events[0];
    if (genesis && (
      genesis.runId !== options.event.runId ||
      genesis.contractDigest !== options.event.contractDigest ||
      genesis.taskId !== options.event.taskId ||
      genesis.systemId !== options.event.systemId
    )) {
      throw new EvidenceLedgerError("EVIDENCE_CONFLICT", "event changes immutable run identity");
    }
    if (!genesis && options.event.type !== "run.started") {
      throw new EvidenceLedgerError("EVIDENCE_CONFLICT", "first evidence event must be run.started");
    }
    if (genesis && options.event.type === "run.started") {
      throw new EvidenceLedgerError("EVIDENCE_CONFLICT", "run.started may appear only once");
    }
    if (events.at(-1)?.type === "run.finished") {
      throw new EvidenceLedgerError("EVIDENCE_SEALED", "nothing may follow run.finished");
    }
    if (
      events.length > 0 &&
      Date.parse(options.event.occurredAt) < Date.parse(events.at(-1)?.occurredAt ?? "")
    ) {
      throw new EvidenceLedgerError(
        "EVIDENCE_CONFLICT",
        "evidence occurredAt must be nondecreasing",
      );
    }
    const unsigned: Omit<EvidenceEventDocument, "eventDigest"> = {
      ...candidateBase,
      sequence: events.length,
      previousEventDigest: events.at(-1)?.eventDigest ?? null,
    };
    const event: EvidenceEventDocument = {
      ...unsigned,
      eventDigest: computeEvidenceEventDigest(unsigned as EvidenceEventDocument),
    };
    validateEvalContractDocument(event);
    const line = Buffer.from(`${canonicalizeJson(event)}\n`, "utf8");
    if (line.byteLength > limits.maximumEventBytes) {
      throw new EvidenceLedgerError("EVIDENCE_LIMIT", "canonical evidence event exceeds its limit");
    }
    if (current.bytes.byteLength + line.byteLength > limits.maximumLedgerBytes) {
      throw new EvidenceLedgerError("EVIDENCE_LIMIT", "evidence ledger would exceed its limit");
    }
    await persistPayload(paths, options, options.payloadBytes, payloadDigest);
    const handle = await open(paths.ledger, openExistingFlags(false));
    try {
      const opened = await assertPrivateFile(paths.ledger, handle, options, "ledger");
      if (
        opened.dev !== current.identity.dev ||
        opened.ino !== current.identity.ino ||
        opened.size !== current.identity.size
      ) {
        throw corrupt("evidence ledger was replaced between verification and append");
      }
      await writeAllEvidenceBytes(handle, line);
      await options.durabilityHooks?.beforeFileSync?.(paths.ledger, "ledger");
      await handle.sync();
      await assertPrivateFile(paths.ledger, handle, options, "ledger");
    } finally {
      await handle.close();
    }
    return { status: "appended", event };
  });
}

function statementFromInspection(
  inspection: IntegrityOnlyEvidenceInspection,
  sealedAt: string,
): EvidenceLedgerSealStatement {
  if (
    !inspection.terminal ||
    !inspection.genesisEventDigest ||
    !inspection.headEventDigest ||
    inspection.eventCount === 0 ||
    inspection.ledgerByteLength === 0
  ) {
    throw new EvidenceLedgerError(
      "EVIDENCE_CONFLICT",
      "only a non-empty ledger ending in run.finished can be sealed",
    );
  }
  const sealedTimestamp = Date.parse(sealedAt);
  const terminalTimestamp = Date.parse(inspection.events.at(-1)?.occurredAt ?? "");
  if (!Number.isFinite(sealedTimestamp) || sealedTimestamp < terminalTimestamp) {
    throw new EvidenceLedgerError(
      "EVIDENCE_CONFLICT",
      "evidence seal timestamp must not predate the terminal event",
    );
  }
  return {
    runId: inspection.runId,
    contractDigest: inspection.contractDigest,
    taskId: inspection.taskId,
    systemId: inspection.systemId,
    ledgerDigest: inspection.ledgerDigest,
    ledgerByteLength: inspection.ledgerByteLength,
    genesisEventDigest: inspection.genesisEventDigest,
    headEventDigest: inspection.headEventDigest,
    eventCount: inspection.eventCount,
    platformProtectionVerifierDigest: inspection.platformProtectionVerifierDigest,
    sealedAt,
  };
}

function parseCanonicalObject<T>(bytes: Buffer, label: string): T {
  if (bytes.at(-1) !== 0x0a || bytes.includes(0x0d) || bytes.subarray(0, 3).equals(UTF8_BOM)) {
    throw corrupt(`${label} is not canonical LF-terminated JSON`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1));
  } catch (error) {
    throw corrupt(`${label} is not valid UTF-8`, error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw corrupt(`${label} is not JSON`, error);
  }
  if (canonicalizeJson(value) !== text) throw corrupt(`${label} is not exact canonical JSON`);
  return value as T;
}

function sameStatement(left: EvidenceLedgerSealStatement, right: EvidenceLedgerSealStatement): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function sameFrozenLedgerFacts(
  left: EvidenceLedgerSealStatement,
  right: EvidenceLedgerSealStatement,
): boolean {
  const { sealedAt: _leftSealedAt, ...leftFacts } = left;
  const { sealedAt: _rightSealedAt, ...rightFacts } = right;
  return canonicalizeJson(leftFacts) === canonicalizeJson(rightFacts);
}

async function freezeStatement(
  paths: EvidenceLedgerPaths,
  access: EvidenceLedgerAccess,
  proposed: EvidenceLedgerSealStatement,
): Promise<EvidenceLedgerSealStatement> {
  const bytes = Buffer.from(`${canonicalizeJson(proposed)}\n`, "utf8");
  try {
    await createPrivateFile(paths.freeze, bytes, access, "freeze");
    await syncDirectory(paths.root, access);
    return proposed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingBytes = await readPrivateFile(paths.freeze, access, "freeze", 128 * 1024);
    const existing = parseCanonicalObject<EvidenceLedgerSealStatement>(existingBytes, "freeze marker");
    if (!sameFrozenLedgerFacts(existing, proposed)) {
      throw new EvidenceLedgerError(
        "EVIDENCE_CONFLICT",
        "existing freeze marker describes a different ledger prefix",
      );
    }
    await resyncExactPrivateFile(
      paths.freeze,
      existingBytes,
      access,
      "freeze",
      paths.root,
    );
    return existing;
  }
}

function sealPath(paths: EvidenceLedgerPaths, digest: Sha256Digest): string {
  return path.join(paths.seals, `sha256-${digest.slice("sha256:".length)}.json`);
}

async function recoverStoredSeal(
  paths: EvidenceLedgerPaths,
  access: EvidenceLedgerAccess,
  statement: EvidenceLedgerSealStatement,
  verifier: EvidenceAnchorVerifier,
): Promise<EvidenceLedgerSeal | null> {
  const entries = await readdir(paths.seals);
  if (entries.some((entry) => !SEAL_FILE_PATTERN.test(entry))) {
    throw corrupt("seal directory contains an unexpected entry");
  }
  if (entries.length === 0) return null;
  if (entries.length !== 1) throw corrupt("seal directory contains multiple receipts");
  const entry = entries[0];
  const sealDigest = `sha256:${entry.slice("sha256-".length, -".json".length)}` as Sha256Digest;
  const target = path.join(paths.seals, entry);
  const bytes = await readPrivateFile(target, access, "seal", 256 * 1024);
  if (sha256Digest(bytes) !== sealDigest) {
    throw corrupt("stored seal filename does not match its exact bytes");
  }
  const document = parseCanonicalObject<EvidenceLedgerSealDocument>(bytes, "evidence seal");
  validateEvalContractDocument(document);
  if (!sameStatement(document.statement, statement)) {
    throw corrupt("stored seal describes a different frozen statement");
  }
  if (document.receipt.anchorPolicyDigest !== verifier.anchorPolicyDigest) {
    throw new EvidenceLedgerError("EVIDENCE_UNANCHORED", "stored seal used an unpinned anchor policy");
  }
  const statementBytes = Buffer.from(canonicalizeJson(statement), "utf8");
  if (!(await verifier.verify(statementBytes, document.receipt))) {
    throw new EvidenceLedgerError("EVIDENCE_UNANCHORED", "stored seal failed pinned verification");
  }
  await resyncExactPrivateFile(target, bytes, access, "seal", paths.seals);
  return { ...document, sealDigest };
}

export async function sealEvidenceLedger(
  options: SealEvidenceLedgerOptions,
): Promise<EvidenceLedgerSeal> {
  const prepared = await withLedgerLock(options, options.context.runId, async (paths) => {
    const inspection = await inspectLocked(paths, options, options.context.runId);
    for (const key of ["contractDigest", "taskId", "systemId"] as const) {
      if (inspection[key] !== options.context[key]) {
        throw new EvidenceLedgerError("EVIDENCE_CONFLICT", `seal context ${key} does not match ledger`);
      }
    }
    const statement = await freezeStatement(
      paths,
      options,
      statementFromInspection(inspection, options.sealedAt),
    );
    return {
      statement,
      recovered: await recoverStoredSeal(
        paths,
        options,
        statement,
        options.anchorProvider,
      ),
    };
  });
  if (prepared.recovered) return prepared.recovered;
  const { statement } = prepared;
  const statementBytes = Buffer.from(canonicalizeJson(statement), "utf8");
  const statementDigest = computeEvidenceSealStatementDigest(statement);
  const receipt = await options.anchorProvider.anchor(statementBytes, statementDigest);
  if (
    receipt.statementDigest !== statementDigest ||
    receipt.anchorPolicyDigest !== options.anchorProvider.anchorPolicyDigest
  ) {
    throw new EvidenceLedgerError(
      "EVIDENCE_UNANCHORED",
      "anchor receipt does not match the frozen statement and pinned policy",
    );
  }
  if (!(await options.anchorProvider.verify(statementBytes, receipt))) {
    throw new EvidenceLedgerError("EVIDENCE_UNANCHORED", "anchor receipt verification failed");
  }
  const document: EvidenceLedgerSealDocument = {
    kind: "agenc.eval.evidence-seal",
    contractVersion: EVAL_CONTRACT_VERSION,
    statement,
    receipt,
  };
  validateEvalContractDocument(document);
  const sealBytes = Buffer.from(`${canonicalizeJson(document)}\n`, "utf8");
  const sealDigest = sha256Digest(sealBytes);
  return withLedgerLock(options, options.context.runId, async (paths) => {
    const frozenBytes = await readPrivateFile(paths.freeze, options, "freeze", 128 * 1024);
    const frozen = parseCanonicalObject<EvidenceLedgerSealStatement>(frozenBytes, "freeze marker");
    if (!sameStatement(frozen, statement)) throw corrupt("freeze marker changed after anchoring");
    const inspection = await inspectLocked(paths, options, options.context.runId);
    if (!sameStatement(statementFromInspection(inspection, statement.sealedAt), statement)) {
      throw corrupt("ledger changed after it was frozen");
    }
    const recovered = await recoverStoredSeal(
      paths,
      options,
      statement,
      options.anchorProvider,
    );
    if (recovered) return recovered;
    const target = sealPath(paths, sealDigest);
    try {
      await createPrivateFile(target, sealBytes, options, "seal");
      await syncDirectory(paths.seals, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await resyncExactPrivateFile(target, sealBytes, options, "seal", paths.seals);
    }
    return { ...document, sealDigest };
  });
}

function assertSealMatchesInspection(
  seal: EvidenceLedgerSealDocument,
  inspection: IntegrityOnlyEvidenceInspection,
): void {
  const statement = statementFromInspection(inspection, seal.statement.sealedAt);
  if (!sameStatement(statement, seal.statement)) {
    throw corrupt("externally anchored seal does not match the exact ledger bytes");
  }
}

export async function verifyEvidenceLedger(
  options: VerifyEvidenceLedgerOptions,
): Promise<VerifiedEvidenceLedger> {
  if (!DIGEST_PATTERN.test(options.expectedSealDigest)) {
    throw new EvidenceLedgerError("EVIDENCE_UNANCHORED", "expectedSealDigest is not sha256");
  }
  return withLedgerLock(options, options.runId, async (paths) => {
    const inspection = await inspectLocked(paths, options, options.runId);
    const filePath = sealPath(paths, options.expectedSealDigest);
    const bytes = await readPrivateFile(filePath, options, "seal", 256 * 1024).catch((error) => {
      throw new EvidenceLedgerError(
        "EVIDENCE_UNANCHORED",
        "externally expected seal is absent from the evidence store",
        { cause: error },
      );
    });
    if (sha256Digest(bytes) !== options.expectedSealDigest) {
      throw new EvidenceLedgerError("EVIDENCE_UNANCHORED", "seal bytes do not match external anchor");
    }
    const document = parseCanonicalObject<EvidenceLedgerSealDocument>(bytes, "evidence seal");
    validateEvalContractDocument(document);
    assertSealMatchesInspection(document, inspection);
    if (document.receipt.anchorPolicyDigest !== options.anchorVerifier.anchorPolicyDigest) {
      throw new EvidenceLedgerError("EVIDENCE_UNANCHORED", "seal used an unpinned anchor policy");
    }
    const statementBytes = Buffer.from(canonicalizeJson(document.statement), "utf8");
    if (!(await options.anchorVerifier.verify(statementBytes, document.receipt))) {
      throw new EvidenceLedgerError("EVIDENCE_UNANCHORED", "pinned anchor verification failed");
    }
    const verified = deepFreezeVerifiedEvidence<VerifiedEvidenceLedger>({
      trust: "externally_anchored",
      inspection,
      seal: { ...document, sealDigest: options.expectedSealDigest },
      anchorVerifierDigest: options.anchorVerifier.verifierDigest,
      platformProtectionVerifierDigest: document.statement.platformProtectionVerifierDigest,
    });
    externallyVerifiedEvidence.add(verified);
    return verified;
  });
}

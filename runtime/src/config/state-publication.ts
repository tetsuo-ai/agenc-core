import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, readdirSync, readSync, unlinkSync, writeFileSync, type BigIntStats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { duplicateJsonObjectPaths, isPlainRecord } from "./json.js";
import type { CanonicalStateFileSnapshot } from "./state.js";

interface FileProof {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly mode: string;
  readonly uid: string;
  readonly digest: string;
}

interface PublicationJournal {
  readonly version: 1;
  readonly transactionId: string;
  readonly previous: FileProof | null;
  readonly replacement: FileProof;
}

interface Artifact {
  readonly file: string;
  readonly bytes: Buffer;
  readonly stat: BigIntStats;
}

export interface StatePublicationIO {
  readonly parse: (text: string, file: string) => unknown;
  readonly synchronize: () => void;
}

function recoveryError(file: string, detail: string): Error {
  return new Error(`State publication recovery required for ${file}: ${detail}; preserve the transaction artifacts`);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function proof(snapshot: CanonicalStateFileSnapshot): FileProof {
  const { dev, ino, size, mtimeNs, mode, uid } = snapshot.version;
  return {
    dev: String(dev), ino: String(ino), size: String(size), mtimeNs: String(mtimeNs),
    mode: String(mode), uid: String(uid), digest: digest(snapshot.bytes),
  };
}

function regular(file: string, stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== 1n && stat.nlink !== 2n)) {
    throw recoveryError(file, "artifact is not a regular file with an expected link count");
  }
  if (process.platform !== "win32" && (
    (stat.mode & 0o777n) !== 0o600n ||
    (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()))
  )) throw recoveryError(file, "artifact ownership or mode is invalid");
}

function assertUnchangedArtifact(file: string, before: BigIntStats, observed: BigIntStats): void {
  if (
    observed.dev !== before.dev || observed.ino !== before.ino ||
    observed.size !== before.size || observed.mtimeNs !== before.mtimeNs ||
    observed.ctimeNs !== before.ctimeNs || observed.nlink !== before.nlink ||
    observed.mode !== before.mode || observed.uid !== before.uid
  ) throw recoveryError(file, "artifact changed while being read");
}

function readArtifactBytes(descriptor: number, maximumBytes?: number): Buffer {
  if (maximumBytes === undefined) return readFileSync(descriptor);
  const bytes = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return bytes.subarray(0, offset);
}

function withArtifactDescriptor<Result>(descriptor: number, operation: () => Result): Result {
  let outcome: { readonly succeeded: true; readonly value: Result } | { readonly succeeded: false; readonly error: unknown };
  try {
    outcome = { succeeded: true, value: operation() };
  } catch (error) {
    outcome = { succeeded: false, error };
  }
  try {
    closeSync(descriptor);
  } catch (closeError) {
    if (outcome.succeeded) throw closeError;
    try {
      if (outcome.error instanceof Error && Object.isExtensible(outcome.error)) {
        Object.defineProperty(outcome.error, "cleanupErrors", { configurable: true, value: Object.freeze([closeError]) });
      }
    } catch {}
  }
  if (!outcome.succeeded) throw outcome.error;
  return outcome.value;
}

function readArtifact(file: string, maximumBytes?: number): Artifact | null {
  let before: BigIntStats;
  try { before = lstatSync(file, { bigint: true }); }
  catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  regular(file, before);
  if (maximumBytes !== undefined && before.size > BigInt(maximumBytes)) {
    throw recoveryError(file, "journal exceeds its size limit");
  }
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  return withArtifactDescriptor(descriptor, () => {
    const opened = fstatSync(descriptor, { bigint: true });
    assertUnchangedArtifact(file, before, opened);
    const bytes = readArtifactBytes(descriptor, maximumBytes);
    const after = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(file, { bigint: true });
    regular(file, named);
    for (const observed of [opened, after, named]) {
      assertUnchangedArtifact(file, before, observed);
    }
    if (BigInt(bytes.length) !== before.size) throw recoveryError(file, "artifact size changed");
    return { file, bytes, stat: after };
  });
}

function matches(artifact: Artifact, expected: FileProof): boolean {
  const observed = artifact.stat;
  return String(observed.dev) === expected.dev && String(observed.ino) === expected.ino &&
    String(observed.size) === expected.size && String(observed.mtimeNs) === expected.mtimeNs &&
    String(observed.mode) === expected.mode && String(observed.uid) === expected.uid &&
    digest(artifact.bytes) === expected.digest;
}

function assertProof(value: unknown, file: string): asserts value is FileProof {
  const fields = ["dev", "ino", "size", "mtimeNs", "mode", "uid", "digest"];
  if (!isPlainRecord(value) || Object.keys(value).length !== fields.length ||
    fields.some((field) => typeof value[field] !== "string")) {
    throw recoveryError(file, "journal file proof is invalid");
  }
  if (!fields.slice(0, -1).every((field) => /^\d+$/u.test(value[field] as string)) ||
    !/^[a-f0-9]{64}$/u.test(value.digest as string)) {
    throw recoveryError(file, "journal file proof is malformed");
  }
}

function parseJournal(artifact: Artifact, transactionId: string): PublicationJournal {
  if (artifact.stat.nlink !== 1n) throw recoveryError(artifact.file, "journal must have one link");
  const text = artifact.bytes.toString("utf8");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw recoveryError(artifact.file, "journal JSON is invalid"); }
  if (!isPlainRecord(value) || Object.keys(value).length !== 4 ||
    value.version !== 1 || value.transactionId !== transactionId || duplicateJsonObjectPaths(text).length !== 0) {
    throw recoveryError(artifact.file, "journal envelope is invalid");
  }
  assertProof(value.replacement, artifact.file);
  if (value.previous !== null) assertProof(value.previous, artifact.file);
  return value as unknown as PublicationJournal;
}

function paths(file: string, transactionId: string): { temporary: string; quarantine: string; journal: string } {
  return {
    temporary: `${file}.tmp-${transactionId}`,
    quarantine: `${file}.quarantine-${transactionId}`,
    journal: `${file}.transaction-${transactionId}.json`,
  };
}

export function writeStatePublicationJournalSync(
  file: string, transactionId: string, previous: CanonicalStateFileSnapshot | null,
  replacement: CanonicalStateFileSnapshot,
): void {
  const journal: PublicationJournal = {
    version: 1, transactionId, previous: previous === null ? null : proof(previous), replacement: proof(replacement),
  };
  const journalPath = paths(file, transactionId).journal;
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`);
  writeFileSync(journalPath, bytes, { flag: "wx", mode: 0o600, flush: true });
  const observed = readArtifact(journalPath, 32_768);
  if (!observed?.bytes.equals(bytes)) throw recoveryError(journalPath, "prepared journal changed");
  parseJournal(observed, transactionId);
}

function readProvenState(file: string, expected: FileProof | null, io: StatePublicationIO): Artifact | null {
  const artifact = readArtifact(file);
  if (artifact === null) return null;
  if (expected === null || !matches(artifact, expected)) throw recoveryError(file, "artifact does not match its journal proof");
  io.parse(artifact.bytes.toString("utf8"), file);
  return artifact;
}

function removeProvenState(artifact: Artifact, expected: FileProof, io: StatePublicationIO): void {
  const current = readProvenState(artifact.file, expected, io);
  if (current === null || current.stat.nlink !== artifact.stat.nlink) {
    throw recoveryError(artifact.file, "artifact changed before cleanup");
  }
  unlinkSync(artifact.file);
  io.synchronize();
}

function assertLinks(artifact: Artifact | null, paired: boolean): void {
  if (artifact !== null && artifact.stat.nlink !== (paired ? 2n : 1n)) {
    throw recoveryError(artifact.file, "artifact has an unexpected link relationship");
  }
}

function publicationArtifacts(file: string): string[] {
  const base = basename(file);
  try {
    return readdirSync(dirname(file)).filter((entry) =>
      [".tmp-", ".quarantine-", ".transaction-"].some((suffix) => entry.startsWith(`${base}${suffix}`)),
    );
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

function loadTransaction(file: string): {
  readonly staged: ReturnType<typeof paths>;
  readonly journalArtifact: Artifact;
  readonly journal: PublicationJournal;
} | null {
  const entries = publicationArtifacts(file);
  if (entries.length === 0) return null;
  const journalEntries = entries.filter((entry) => entry.startsWith(`${basename(file)}.transaction-`));
  if (journalEntries.length !== 1) throw recoveryError(file, `ambiguous artifacts ${entries.map((entry) => join(dirname(file), entry)).join(", ")}`);
  const journalPath = join(dirname(file), journalEntries[0]!);
  const transactionId = journalEntries[0]!.slice(`${basename(file)}.transaction-`.length, -5);
  if (!/^\d+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(transactionId)) {
    throw recoveryError(journalPath, "transaction ID is invalid");
  }
  const staged = paths(file, transactionId);
  if (entries.some((entry) => !Object.values(staged).some((candidate) => basename(candidate) === entry))) {
    throw recoveryError(file, `unmatched artifacts ${entries.join(", ")}`);
  }
  const journalArtifact = readArtifact(journalPath, 32_768);
  if (journalArtifact === null) throw recoveryError(journalPath, "journal disappeared");
  const journal = parseJournal(journalArtifact, transactionId);
  return { staged, journalArtifact, journal };
}

function selectCanonicalState(file: string, canonical: Artifact | null, quarantine: Artifact | null, journal: PublicationJournal): FileProof {
  if (canonical === null) {
    if (journal.previous === null || quarantine === null) throw recoveryError(file, "missing prior committed state");
    return journal.previous;
  }
  if (matches(canonical, journal.replacement)) return journal.replacement;
  if (journal.previous !== null && matches(canonical, journal.previous)) return journal.previous;
  throw recoveryError(file, "canonical state does not match the transaction");
}

export function reconcileStatePublicationSync(file: string, io: StatePublicationIO): void {
  const transaction = loadTransaction(file);
  if (transaction === null) return;
  const { staged, journalArtifact, journal } = transaction;
  const journalPath = staged.journal;
  const temporary = readProvenState(staged.temporary, journal.replacement, io);
  let quarantine = readProvenState(staged.quarantine, journal.previous, io);
  let canonical = readArtifact(file);
  const selected = selectCanonicalState(file, canonical, quarantine, journal);
  const replacementSelected = selected === journal.replacement;
  assertLinks(canonical, replacementSelected ? temporary !== null : quarantine !== null);
  assertLinks(temporary, replacementSelected && canonical !== null);
  assertLinks(quarantine, !replacementSelected && canonical !== null);
  if (canonical === null) {
    linkSync(staged.quarantine, file);
    io.synchronize();
    canonical = readProvenState(file, selected, io);
    quarantine = readProvenState(staged.quarantine, selected, io);
    if (canonical === null || quarantine === null) throw recoveryError(file, "restored state disappeared");
    assertLinks(canonical, true);
    assertLinks(quarantine, true);
  }
  io.parse(canonical.bytes.toString("utf8"), file);
  io.synchronize();
  if (temporary !== null) removeProvenState(temporary, journal.replacement, io);
  if (quarantine !== null) removeProvenState(quarantine, journal.previous!, io);
  const verified = readProvenState(file, selected, io);
  if (verified === null) throw recoveryError(file, "canonical state disappeared during cleanup");
  assertLinks(verified, false);
  const currentJournal = readArtifact(journalPath, 32_768);
  if (currentJournal === null || currentJournal.stat.dev !== journalArtifact.stat.dev ||
    currentJournal.stat.ino !== journalArtifact.stat.ino || !currentJournal.bytes.equals(journalArtifact.bytes)) {
    throw recoveryError(journalPath, "journal changed before cleanup");
  }
  unlinkSync(journalPath);
  io.synchronize();
}

export function syncStatePublicationDirectorySync(file: string): void {
  const descriptor = openSync(dirname(file), "r");
  withArtifactDescriptor(descriptor, () => fsyncSync(descriptor));
}

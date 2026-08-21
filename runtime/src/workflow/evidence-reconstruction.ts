/**
 * M5 Phase 6 — evidence-only reconstruction of a verified change.
 *
 * `reconstructVerifiedChange(bundleDir)` takes ONLY an exported bundle
 * directory — the run's evidence-ledger root (hash-chained ledger, CAS
 * payloads, seal receipt, local anchor secret) plus the persisted
 * `verified-change-record.json` — and mechanically re-derives what
 * happened. No daemon, no SQLite, no rollout files, no trust in prose:
 *
 *   1. re-validate the record (`validateVerifiedChangeRecord`, including
 *      the canonical document digest and spec-digest binding),
 *   2. verify the sealed hash chain (`verifyEvidenceLedger`, pinned by the
 *      seal digest the record carries and the bundle's local anchor
 *      material),
 *   3. cross-check the record's ledger head against the verified
 *      inspection,
 *   4. recompute EVERY artifact digest from the exact CAS bytes and check
 *      each pointer is present in the hash-chained event set,
 *   5. re-derive the review blockers from the `independent_review`
 *      artifact bytes and cross-check the recorded verification commands
 *      against a `test_result` artifact.
 *
 * Every failure throws {@link EvidenceReconstructionError} loudly — a
 * tampered byte anywhere (ledger, seal, CAS payload, record) can never
 * produce a summary.
 */

import { readdir } from "node:fs/promises";
import * as path from "node:path";

import {
  canonicalizeJson,
  sha256Digest,
} from "../eval-contract/canonical-json.js";
import {
  DEFAULT_EVIDENCE_LIMITS,
  verifyEvidenceLedger,
} from "../eval-contract/evidence-ledger.js";
import type { Sha256Digest } from "../eval-contract/types.js";
import type {
  RunArtifactPointer,
  RunTerminalStatus,
  WorkflowStopReason,
} from "../contracts/run-contracts.js";
import {
  validateVerifiedChangeRecord,
  type VerifiedChangeCommandRecord,
  type VerifiedChangeRecord,
} from "./evidence-record.js";
import { extractBlockers } from "./independent-review.js";
import type { ReviewOutput } from "../session/review.js";
import {
  readWorkflowLocalAnchorSecret,
  workflowLocalAnchorVerifier,
} from "./local-anchor.js";
import { workflowArtifactEventId } from "./artifact-evidence.js";
import { readBoundedRegularFileBytes } from "../utils/bounded-regular-file.js";

export const VERIFIED_CHANGE_RECORD_FILENAME = "verified-change-record.json";
const VERIFIED_CHANGE_RECORD_MAXIMUM_BYTES = 16 * 1024 * 1024;
const VERIFIED_CHANGE_RECONSTRUCTION_MAXIMUM_BYTES = 64 * 1024 * 1024;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export type EvidenceReconstructionFailure =
  | "record_missing"
  | "record_invalid"
  | "seal_unpinned"
  | "anchor_material_missing"
  | "ledger_verification_failed"
  | "ledger_mismatch"
  | "artifact_limit"
  | "artifact_missing"
  | "artifact_digest_mismatch"
  | "artifact_unchained"
  | "review_artifact_invalid"
  | "test_result_mismatch";

export class EvidenceReconstructionError extends Error {
  readonly failure: EvidenceReconstructionFailure;

  constructor(failure: EvidenceReconstructionFailure, message: string) {
    super(`evidence reconstruction failed (${failure}): ${message}`);
    this.name = "EvidenceReconstructionError";
    this.failure = failure;
  }
}

export interface ReconstructedArtifact {
  readonly stepId: string;
  readonly role: RunArtifactPointer["role"];
  readonly digest: Sha256Digest;
  readonly bytes: number;
  readonly storagePath: string;
  readonly mediaType: string;
  /** Defensive copy of the exact sealed CAS payload. */
  readonly payloadBytes: Uint8Array;
}

export interface ReconstructedVerifiedChange {
  /** Exact canonical LF-terminated persisted record bytes. */
  readonly recordBytes: Uint8Array;
  readonly runId: string;
  readonly specDigest: Sha256Digest;
  readonly goal: string;
  readonly baseCommit: string;
  readonly headCommit: string | null;
  readonly terminal: {
    readonly status: RunTerminalStatus;
    readonly stopReason: WorkflowStopReason | null;
    readonly finalMessage: string | null;
  };
  readonly verificationCommands: readonly VerifiedChangeCommandRecord[];
  readonly review: {
    readonly reviewerModel: string;
    readonly overallCorrectness: string;
    readonly overallConfidenceScore: number;
    readonly blockerCount: number;
    readonly findingCount: number;
  } | null;
  /** Re-derived from the independent_review artifact bytes, not the record. */
  readonly reviewBlockers: readonly string[];
  readonly unresolvedRisks: readonly string[];
  readonly ledger: {
    readonly eventCount: number;
    readonly headEventDigest: Sha256Digest;
    readonly sealDigest: Sha256Digest;
    readonly sealedAt: string;
    readonly ledgerDigest: Sha256Digest;
    readonly ledgerByteLength: number;
    readonly payloadBytes: number;
  };
  /** Every pointer digest re-computed from the exact CAS bytes. */
  readonly artifacts: readonly ReconstructedArtifact[];
}

export interface EvidenceReconstructionOptions {
  /** Record plus all hash-chained payload bytes; never above 64 MiB. */
  readonly maximumBytes?: number;
}

/** Read one content-addressed payload from the bundle's CAS directories. */
export async function readBundleArtifact(
  bundleDir: string,
  digest: string,
  maximumBytes: number = DEFAULT_EVIDENCE_LIMITS.maximumPayloadBytes,
): Promise<Uint8Array> {
  const hex = digest.startsWith("sha256:")
    ? digest.slice("sha256:".length)
    : digest;
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new EvidenceReconstructionError(
      "artifact_digest_mismatch",
      `invalid CAS digest ${digest}`,
    );
  }
  let entries: readonly string[];
  try {
    entries = (await readdir(bundleDir)).sort();
  } catch (error) {
    throw new EvidenceReconstructionError(
      "artifact_missing",
      `bundle directory is unreadable: ${String(error)}`,
    );
  }
  for (const entry of entries) {
    if (!entry.endsWith(".payloads")) continue;
    try {
      return await readBoundedRegularFileBytes(
        path.join(bundleDir, entry, `sha256-${hex}.bin`),
        maximumBytes,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The bundle may contain more than one evidence-ledger payload root.
        continue;
      }
      throw new EvidenceReconstructionError(
        "artifact_digest_mismatch",
        `CAS payload sha256:${hex} is unsafe or unreadable: ${String(error)}`,
      );
    }
  }
  throw new EvidenceReconstructionError(
    "artifact_missing",
    `no CAS payload for sha256:${hex} in ${bundleDir}`,
  );
}

function uniqueArtifactPointers(
  record: VerifiedChangeRecord,
): readonly RunArtifactPointer[] {
  const pointers = new Map<string, RunArtifactPointer>();
  const add = (pointer: RunArtifactPointer): void => {
    const key = `${pointer.step.stepId}:${pointer.role}:${pointer.digest}`;
    const existing = pointers.get(key);
    if (
      existing !== undefined &&
      canonicalizeJson(existing) !== canonicalizeJson(pointer)
    ) {
      throw new EvidenceReconstructionError(
        "record_invalid",
        `artifact identity ${pointer.step.stepId}/${pointer.role}/${pointer.digest} has conflicting pointers`,
      );
    }
    if (existing === undefined) pointers.set(key, pointer);
  };
  for (const step of record.steps) {
    for (const pointer of step.artifacts) add(pointer);
  }
  if (record.review !== null) add(record.review.artifact);
  return [...pointers.values()];
}

function parseJsonBytes(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new EvidenceReconstructionError(
      "review_artifact_invalid",
      `${what} is not valid JSON: ${String(error)}`,
    );
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

/**
 * Reconstruct a verified change from an exported bundle directory alone.
 * See the module doc for the exact mechanical checks.
 */
export async function reconstructVerifiedChange(
  bundleDir: string,
  options: EvidenceReconstructionOptions = {},
): Promise<ReconstructedVerifiedChange> {
  const maximumBytes =
    options.maximumBytes ?? VERIFIED_CHANGE_RECONSTRUCTION_MAXIMUM_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > VERIFIED_CHANGE_RECONSTRUCTION_MAXIMUM_BYTES
  ) {
    throw new EvidenceReconstructionError(
      "artifact_limit",
      `maximumBytes must be within 1..${VERIFIED_CHANGE_RECONSTRUCTION_MAXIMUM_BYTES}`,
    );
  }
  // 1. The record — the only non-ledger file the reconstruction trusts as
  // an INPUT, and only after it survives full mechanical re-validation.
  let recordBytes: Uint8Array;
  try {
    recordBytes = await readBoundedRegularFileBytes(
      path.join(bundleDir, VERIFIED_CHANGE_RECORD_FILENAME),
      VERIFIED_CHANGE_RECORD_MAXIMUM_BYTES,
    );
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new EvidenceReconstructionError(
      missing ? "record_missing" : "record_invalid",
      missing
        ? `${VERIFIED_CHANGE_RECORD_FILENAME} is absent from ${bundleDir}: ${String(error)}`
        : `${VERIFIED_CHANGE_RECORD_FILENAME} is unsafe or unreadable: ${String(error)}`,
    );
  }
  if (recordBytes.byteLength > maximumBytes) {
    throw new EvidenceReconstructionError(
      "artifact_limit",
      "verified-change record exceeds the configured export byte ceiling",
    );
  }
  if (
    recordBytes.at(-1) !== 0x0a ||
    recordBytes.includes(0x0d) ||
    (recordBytes.at(0) === 0xef &&
      recordBytes.at(1) === 0xbb &&
      recordBytes.at(2) === 0xbf)
  ) {
    throw new EvidenceReconstructionError(
      "record_invalid",
      "record must be canonical UTF-8 JSON with one LF terminator",
    );
  }
  let recordText: string;
  try {
    recordText = new TextDecoder("utf-8", { fatal: true }).decode(
      recordBytes.subarray(0, -1),
    );
  } catch (error) {
    throw new EvidenceReconstructionError(
      "record_invalid",
      `record is not valid UTF-8: ${String(error)}`,
    );
  }
  let record: VerifiedChangeRecord;
  try {
    record = JSON.parse(recordText) as VerifiedChangeRecord;
  } catch (error) {
    throw new EvidenceReconstructionError(
      "record_invalid",
      `record is not valid JSON: ${String(error)}`,
    );
  }
  if (canonicalizeJson(record) !== recordText) {
    throw new EvidenceReconstructionError(
      "record_invalid",
      "record bytes are not exact canonical JSON",
    );
  }
  const validation = validateVerifiedChangeRecord(record);
  if (!validation.valid) {
    throw new EvidenceReconstructionError(
      "record_invalid",
      validation.errors.join("; "),
    );
  }
  const pointers = uniqueArtifactPointers(record);
  let selectedPayloadBytes = 0;
  for (const pointer of pointers) {
    if (pointer.bytes > DEFAULT_EVIDENCE_LIMITS.maximumPayloadBytes) {
      throw new EvidenceReconstructionError(
        "artifact_limit",
        `artifact ${pointer.step.stepId}/${pointer.role} exceeds the ledger payload limit`,
      );
    }
    selectedPayloadBytes += pointer.bytes;
    if (
      !Number.isSafeInteger(selectedPayloadBytes) ||
      recordBytes.byteLength + selectedPayloadBytes > maximumBytes
    ) {
      throw new EvidenceReconstructionError(
        "artifact_limit",
        "verified-change record and selected artifacts exceed the configured export byte ceiling",
      );
    }
  }

  // 2. The sealed hash chain, pinned by the record's seal digest and the
  // bundle's local anchor material. No local seal discovery.
  const sealDigest = record.evidenceLedger.sealDigest;
  if (sealDigest === undefined) {
    throw new EvidenceReconstructionError(
      "seal_unpinned",
      "the record does not pin an evidenceLedger.sealDigest",
    );
  }
  const secret = await readWorkflowLocalAnchorSecret(bundleDir);
  if (secret === undefined) {
    throw new EvidenceReconstructionError(
      "anchor_material_missing",
      "no local-anchor-secret in the bundle (or its parent directory); the seal signature cannot be verified",
    );
  }
  let verified;
  try {
    verified = await verifyEvidenceLedger({
      root: bundleDir,
      runId: record.runId,
      expectedSealDigest: sealDigest,
      anchorVerifier: workflowLocalAnchorVerifier(secret),
    });
  } catch (error) {
    throw new EvidenceReconstructionError(
      "ledger_verification_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  const inspection = verified.inspection;
  const ledgerPayloadBytes = inspection.events.reduce(
    (total, event) => total + event.payload.sizeBytes,
    0,
  );
  if (
    !Number.isSafeInteger(ledgerPayloadBytes) ||
    recordBytes.byteLength + ledgerPayloadBytes > maximumBytes
  ) {
    throw new EvidenceReconstructionError(
      "artifact_limit",
      "verified-change record and sealed evidence payloads exceed the configured export byte ceiling",
    );
  }

  // 3. The record's ledger head must be the verified ledger's head.
  if (
    inspection.eventCount !== record.evidenceLedger.eventCount ||
    inspection.headEventDigest !== record.evidenceLedger.headEventDigest ||
    !inspection.terminal
  ) {
    throw new EvidenceReconstructionError(
      "ledger_mismatch",
      `record ledger head (${record.evidenceLedger.eventCount} events, ` +
        `${record.evidenceLedger.headEventDigest}) does not match the ` +
        `verified ledger (${inspection.eventCount} events, ` +
        `${inspection.headEventDigest ?? "no head"}, terminal=${inspection.terminal})`,
    );
  }

  // 4. Every artifact: exact CAS bytes → recomputed digest → chained event.
  const artifacts: ReconstructedArtifact[] = [];
  const bytesByDigest = new Map<string, Uint8Array>();
  for (const pointer of pointers) {
    const eventId = workflowArtifactEventId({
      stepId: pointer.step.stepId,
      role: pointer.role,
      digest: pointer.digest,
    });
    const event = inspection.events.find(
      (candidate) => candidate.eventId === eventId,
    );
    if (
      event === undefined ||
      event.type !== "artifact.recorded" ||
      event.payload.digest !== pointer.digest ||
      event.payload.sizeBytes !== pointer.bytes ||
      event.payload.uri !== pointer.storagePath
    ) {
      throw new EvidenceReconstructionError(
        "artifact_unchained",
        `artifact ${pointer.step.stepId}/${pointer.role} (${pointer.digest}) is not bound to its exact hash-chained event`,
      );
    }
    const bytes = await readBundleArtifact(
      bundleDir,
      pointer.digest,
      Math.max(1, pointer.bytes),
    );
    const recomputed = sha256Digest(bytes);
    if (recomputed !== pointer.digest || bytes.byteLength !== pointer.bytes) {
      throw new EvidenceReconstructionError(
        "artifact_digest_mismatch",
        `artifact ${pointer.step.stepId}/${pointer.role}: recorded ` +
          `${pointer.digest} (${pointer.bytes} bytes) but CAS bytes are ` +
          `${recomputed} (${bytes.byteLength} bytes)`,
      );
    }
    bytesByDigest.set(pointer.digest, bytes);
    artifacts.push({
      stepId: pointer.step.stepId,
      role: pointer.role,
      digest: pointer.digest,
      bytes: pointer.bytes,
      storagePath: pointer.storagePath,
      mediaType: event.payload.mediaType,
      payloadBytes: new Uint8Array(bytes),
    });
  }

  // 5a. Re-derive review blockers from the independent_review bytes.
  let reviewBlockers: readonly string[] = [];
  if (record.review !== null) {
    const reviewBytes = bytesByDigest.get(record.review.artifact.digest);
    if (reviewBytes === undefined) {
      throw new EvidenceReconstructionError(
        "review_artifact_invalid",
        "the review artifact bytes were not reconstructed",
      );
    }
    const parsed = parseJsonBytes(reviewBytes, "independent_review artifact");
    const review = (parsed as { review?: ReviewOutput }).review;
    if (
      review === undefined ||
      !Array.isArray(review.findings) ||
      typeof review.overallCorrectness !== "string"
    ) {
      throw new EvidenceReconstructionError(
        "review_artifact_invalid",
        "independent_review artifact does not contain a ReviewOutput",
      );
    }
    reviewBlockers = extractBlockers(review);
    if (reviewBlockers.length !== record.review.blockerCount) {
      throw new EvidenceReconstructionError(
        "review_artifact_invalid",
        `record claims ${record.review.blockerCount} blocker(s) but the ` +
          `review artifact re-derives ${reviewBlockers.length}`,
      );
    }
  }

  // 5b. The recorded verification commands must match a test_result
  // artifact byte-for-byte (canonical JSON equality).
  const testResults = artifacts.filter(
    (artifact) => artifact.role === "test_result",
  );
  if (record.verificationCommands.length > 0) {
    const expected = stable({ commands: record.verificationCommands });
    const matched = testResults.some((artifact) => {
      const bytes = bytesByDigest.get(artifact.digest);
      if (bytes === undefined) return false;
      try {
        return stable(parseJsonBytes(bytes, "test_result artifact")) === expected;
      } catch {
        return false;
      }
    });
    if (!matched) {
      throw new EvidenceReconstructionError(
        "test_result_mismatch",
        "no test_result artifact reproduces the record's verification command set",
      );
    }
  }

  return {
    recordBytes: new Uint8Array(recordBytes),
    runId: record.runId,
    specDigest: record.specDigest,
    goal: record.spec.goal,
    baseCommit: record.baseCommit,
    headCommit: record.headCommit,
    terminal: {
      status: record.terminal.status,
      stopReason: record.terminal.stopReason,
      finalMessage: record.terminal.finalMessage,
    },
    verificationCommands: record.verificationCommands,
    review:
      record.review === null
        ? null
        : {
            reviewerModel: record.review.reviewerModel,
            overallCorrectness: record.review.overallCorrectness,
            overallConfidenceScore: record.review.overallConfidenceScore,
            blockerCount: record.review.blockerCount,
            findingCount: record.review.findingCount,
          },
    reviewBlockers,
    unresolvedRisks: record.unresolvedRisks,
    ledger: {
      eventCount: inspection.eventCount,
      headEventDigest: record.evidenceLedger.headEventDigest,
      sealDigest,
      sealedAt: verified.seal.statement.sealedAt,
      ledgerDigest: inspection.ledgerDigest,
      ledgerByteLength: inspection.ledgerByteLength,
      payloadBytes: ledgerPayloadBytes,
    },
    artifacts,
  };
}

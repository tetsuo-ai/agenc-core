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

import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { sha256Digest } from "../eval-contract/canonical-json.js";
import { verifyEvidenceLedger } from "../eval-contract/evidence-ledger.js";
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

export const VERIFIED_CHANGE_RECORD_FILENAME = "verified-change-record.json";

export type EvidenceReconstructionFailure =
  | "record_missing"
  | "record_invalid"
  | "seal_unpinned"
  | "anchor_material_missing"
  | "ledger_verification_failed"
  | "ledger_mismatch"
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
}

export interface ReconstructedVerifiedChange {
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
  };
  /** Every pointer digest re-computed from the exact CAS bytes. */
  readonly artifacts: readonly ReconstructedArtifact[];
}

/** Read one content-addressed payload from the bundle's CAS directories. */
export async function readBundleArtifact(
  bundleDir: string,
  digest: string,
): Promise<Uint8Array> {
  const hex = digest.startsWith("sha256:")
    ? digest.slice("sha256:".length)
    : digest;
  let entries: readonly string[];
  try {
    entries = await readdir(bundleDir);
  } catch (error) {
    throw new EvidenceReconstructionError(
      "artifact_missing",
      `bundle directory is unreadable: ${String(error)}`,
    );
  }
  for (const entry of entries) {
    if (!entry.endsWith(".payloads")) continue;
    try {
      return await readFile(path.join(bundleDir, entry, `sha256-${hex}.bin`));
    } catch {
      // try the next payloads directory
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
    pointers.set(
      `${pointer.step.stepId}:${pointer.role}:${pointer.digest}`,
      pointer,
    );
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
): Promise<ReconstructedVerifiedChange> {
  // 1. The record — the only non-ledger file the reconstruction trusts as
  // an INPUT, and only after it survives full mechanical re-validation.
  let recordBytes: Uint8Array;
  try {
    recordBytes = await readFile(
      path.join(bundleDir, VERIFIED_CHANGE_RECORD_FILENAME),
    );
  } catch (error) {
    throw new EvidenceReconstructionError(
      "record_missing",
      `${VERIFIED_CHANGE_RECORD_FILENAME} is absent from ${bundleDir}: ${String(error)}`,
    );
  }
  let record: VerifiedChangeRecord;
  try {
    record = JSON.parse(
      new TextDecoder().decode(recordBytes),
    ) as VerifiedChangeRecord;
  } catch (error) {
    throw new EvidenceReconstructionError(
      "record_invalid",
      `record is not valid JSON: ${String(error)}`,
    );
  }
  const validation = validateVerifiedChangeRecord(record);
  if (!validation.valid) {
    throw new EvidenceReconstructionError(
      "record_invalid",
      validation.errors.join("; "),
    );
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
  const chainedPayloadDigests = new Set(
    inspection.events.map((event) => event.payload.digest),
  );
  const pointers = uniqueArtifactPointers(record);
  const artifacts: ReconstructedArtifact[] = [];
  const bytesByDigest = new Map<string, Uint8Array>();
  for (const pointer of pointers) {
    if (!chainedPayloadDigests.has(pointer.digest)) {
      throw new EvidenceReconstructionError(
        "artifact_unchained",
        `artifact ${pointer.step.stepId}/${pointer.role} (${pointer.digest}) is not present in the hash-chained event set`,
      );
    }
    const bytes = await readBundleArtifact(bundleDir, pointer.digest);
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
    },
    artifacts,
  };
}

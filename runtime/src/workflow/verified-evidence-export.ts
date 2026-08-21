/**
 * Strict, restart-safe export of one sealed verified-change run.
 *
 * This module returns bytes only after evidence-only reconstruction has
 * verified the external seal, complete hash chain, exact CAS payloads, final
 * record, singleton artifacts, command streams, usage, and review binding.
 */

import { canonicalizeJson, sha256Digest } from "../eval-contract/canonical-json.js";
import type { RunArtifactPointer } from "../contracts/run-contracts.js";
import {
  COMPLETED_REQUIRED_ARTIFACT_ROLES,
  type VerifiedChangeRecord,
} from "./evidence-record.js";
import {
  EvidenceReconstructionError,
  reconstructVerifiedChange,
  type ReconstructedArtifact,
} from "./evidence-reconstruction.js";
import { WORKFLOW_ARTIFACT_MEDIA_TYPES } from "./artifact-evidence.js";

export const VERIFIED_EVIDENCE_EXPORT_SCHEMA_VERSION =
  "agenc.core.verified-export.v1" as const;
const VERIFIED_EVIDENCE_ENVELOPE_SCHEMA_VERSION =
  "agenc.core.verified-evidence-envelope.v1" as const;
export const VERIFIED_EVIDENCE_EXPORT_MANIFEST_FILENAME =
  "verified-export-manifest.json" as const;
const DEFAULT_VERIFIED_EVIDENCE_EXPORT_MAXIMUM_BYTES =
  64 * 1024 * 1024;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OUTPUT_ROLES = new Set<RunArtifactPointer["role"]>([
  "verification_stdout",
  "verification_stderr",
]);

export type VerifiedEvidenceExportFailure =
  | "EXPORT_UNAVAILABLE"
  | "EXPORT_CORRUPT"
  | "EXPORT_MISMATCH"
  | "EXPORT_LIMIT";

export class VerifiedEvidenceExportError extends Error {
  constructor(
    readonly code: VerifiedEvidenceExportFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`verified evidence export failed (${code}): ${message}`, options);
    this.name = "VerifiedEvidenceExportError";
  }
}

export interface ExportVerifiedRunConstraints {
  readonly coreRunId: string;
  readonly expectedSpecDigest?: string;
  readonly expectedRecordDigest?: string;
  readonly expectedEvidenceDigest?: string;
  readonly maximumBytes?: number;
}

export interface ExportedVerifiedArtifact {
  readonly pointer: RunArtifactPointer;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ExportedVerificationOutput {
  readonly checkId: string;
  readonly commandDigest: `sha256:${string}`;
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
}

export interface ExportVerifiedRunResult {
  readonly schemaVersion: typeof VERIFIED_EVIDENCE_EXPORT_SCHEMA_VERSION;
  readonly recordBytes: Uint8Array;
  readonly evidenceEnvelopeBytes: Uint8Array;
  /** Non-stream record artifacts; exact streams are returned below. */
  readonly artifacts: readonly ExportedVerifiedArtifact[];
  readonly verificationOutputs: readonly ExportedVerificationOutput[];
  readonly exportRootDigest: `sha256:${string}`;
}

export interface VerifiedEvidenceExportManifest {
  readonly schemaVersion: "agenc.core.verified-export-manifest.v1";
  readonly runId: string;
  readonly specDigest: string;
  readonly recordDigest: string;
  readonly exportRootDigest: string;
}

function fail(
  code: VerifiedEvidenceExportFailure,
  message: string,
  cause?: unknown,
): never {
  throw new VerifiedEvidenceExportError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function requireExport(
  condition: unknown,
  message: string,
  code: VerifiedEvidenceExportFailure = "EXPORT_CORRUPT",
): asserts condition {
  if (!condition) fail(code, message);
}

function parseRecord(bytes: Uint8Array): VerifiedChangeRecord {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)),
    ) as VerifiedChangeRecord;
  } catch (error) {
    return fail("EXPORT_CORRUPT", "verified-change record is unreadable", error);
  }
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return fail("EXPORT_CORRUPT", `${label} is not UTF-8 JSON`, error);
  }
  requireExport(
    canonicalizeJson(value) === text,
    `${label} is not exact canonical JSON`,
  );
  return value;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function pointerKey(pointer: RunArtifactPointer): string {
  return canonicalizeJson(pointer);
}

function reconstructionKey(artifact: ReconstructedArtifact): string {
  return `${artifact.stepId}\0${artifact.role}\0${artifact.digest}`;
}

function recordArtifactPointers(
  record: VerifiedChangeRecord,
): readonly RunArtifactPointer[] {
  const pointers: RunArtifactPointer[] = [];
  const keys = new Set<string>();
  for (const step of record.steps) {
    for (const pointer of step.artifacts) {
      const key = pointerKey(pointer);
      requireExport(!keys.has(key), `record duplicated artifact pointer ${key}`);
      keys.add(key);
      pointers.push(pointer);
    }
  }
  return pointers;
}

function commandStepId(index: number, attempt: number): string {
  const suffix = attempt === 1 ? "" : `#${attempt}`;
  return `workflow.verify.cmd.${index}${suffix}`;
}

function artifactByRole(
  artifacts: readonly ExportedVerifiedArtifact[],
  role: string,
): ExportedVerifiedArtifact {
  const matches = artifacts.filter((artifact) => artifact.pointer.role === role);
  requireExport(
    matches.length === 1,
    `verified export requires exactly one ${role} artifact; found ${matches.length}`,
  );
  return matches[0]!;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  requireExport(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function validateSingletonDocuments(
  record: VerifiedChangeRecord,
  artifacts: readonly ExportedVerifiedArtifact[],
): void {
  const baseState = parseCanonicalJson(
    artifactByRole(artifacts, "base_state").bytes,
    "base_state artifact",
  );
  requireExport(
    sameCanonical(baseState, {
      schemaVersion: "agenc.workflow.base-state.v1",
      runId: record.runId,
      specDigest: record.specDigest,
      baseCommit: record.spec.baseCommit,
      baseDirty: record.spec.baseDirty,
    }),
    "base_state artifact does not reproduce the frozen base",
  );

  const testResult = parseCanonicalJson(
    artifactByRole(artifacts, "test_result").bytes,
    "test_result artifact",
  );
  requireExport(
    sameCanonical(testResult, { commands: record.verificationCommands }),
    "test_result artifact does not reproduce final commands",
  );

  const costUsage = parseCanonicalJson(
    artifactByRole(artifacts, "cost_usage").bytes,
    "cost_usage artifact",
  );
  requireExport(
    sameCanonical(costUsage, {
      schemaVersion: "agenc.workflow.cost-usage.v1",
      runId: record.runId,
      usage: record.usage,
    }),
    "cost_usage artifact does not reproduce final conserved usage",
  );

  const riskRegister = parseCanonicalJson(
    artifactByRole(artifacts, "risk_register").bytes,
    "risk_register artifact",
  );
  requireExport(
    sameCanonical(riskRegister, {
      schemaVersion: "agenc.workflow.risk-register.v1",
      runId: record.runId,
      risks: record.unresolvedRisks,
    }),
    "risk_register artifact does not reproduce final risks",
  );

  const effectLog = asObject(
    parseCanonicalJson(
      artifactByRole(artifacts, "effect_log").bytes,
      "effect_log artifact",
    ),
    "effect_log artifact",
  );
  requireExport(
    effectLog.schemaVersion === "agenc.workflow.effect-log.v1" &&
      effectLog.runId === record.runId &&
      effectLog.through === "workflow.finalize.intent" &&
      Array.isArray(effectLog.effects),
    "effect_log artifact changed its run or durable boundary",
  );

  const reviewArtifact = artifactByRole(artifacts, "independent_review");
  requireExport(record.review !== null, "completed record has no review block");
  requireExport(
    pointerKey(record.review!.artifact) === pointerKey(reviewArtifact.pointer),
    "review block does not bind the exported independent_review pointer",
  );
  const reviewDocument = asObject(
    parseCanonicalJson(reviewArtifact.bytes, "independent_review artifact"),
    "independent_review artifact",
  );
  const review = asObject(reviewDocument.review, "independent review output");
  const findings = review.findings;
  requireExport(Array.isArray(findings), "independent review findings are absent");
  requireExport(
    reviewDocument.reviewerModel === record.review!.reviewerModel &&
      review.overallCorrectness === record.review!.overallCorrectness &&
      review.overallConfidenceScore === record.review!.overallConfidenceScore &&
      findings.length === record.review!.findingCount,
    "independent review bytes do not reproduce the final reviewer identity/verdict",
  );
}

/** Build and verify the complete export from a local dedicated run ledger. */
export async function exportVerifiedRunFromBundle(
  bundleDir: string,
  constraints: ExportVerifiedRunConstraints,
): Promise<ExportVerifiedRunResult> {
  requireExport(
    constraints.coreRunId.length > 0,
    "coreRunId is required",
    "EXPORT_MISMATCH",
  );
  for (const [name, digest] of [
    ["expectedSpecDigest", constraints.expectedSpecDigest],
    ["expectedRecordDigest", constraints.expectedRecordDigest],
    ["expectedEvidenceDigest", constraints.expectedEvidenceDigest],
  ] as const) {
    requireExport(
      digest === undefined || DIGEST_PATTERN.test(digest),
      `${name} is not a lowercase SHA-256 digest`,
      "EXPORT_MISMATCH",
    );
  }
  const maximumBytes =
    constraints.maximumBytes ?? DEFAULT_VERIFIED_EVIDENCE_EXPORT_MAXIMUM_BYTES;
  requireExport(
    Number.isSafeInteger(maximumBytes) &&
      maximumBytes >= 1 &&
      maximumBytes <= DEFAULT_VERIFIED_EVIDENCE_EXPORT_MAXIMUM_BYTES,
    `maximumBytes must be within 1..${DEFAULT_VERIFIED_EVIDENCE_EXPORT_MAXIMUM_BYTES}`,
    "EXPORT_LIMIT",
  );

  let reconstructed;
  try {
    reconstructed = await reconstructVerifiedChange(bundleDir, {
      maximumBytes,
    });
  } catch (error) {
    if (error instanceof EvidenceReconstructionError) {
      const unavailable = new Set([
        "record_missing",
        "anchor_material_missing",
        "artifact_missing",
      ]).has(error.failure);
      return fail(
        error.failure === "artifact_limit"
          ? "EXPORT_LIMIT"
          : unavailable
            ? "EXPORT_UNAVAILABLE"
            : "EXPORT_CORRUPT",
        error.message,
        error,
      );
    }
    return fail("EXPORT_CORRUPT", "evidence reconstruction failed", error);
  }
  const record = parseRecord(reconstructed.recordBytes);
  requireExport(
    reconstructed.runId === constraints.coreRunId &&
      record.runId === constraints.coreRunId,
    "run identity differs from coreRunId",
    "EXPORT_MISMATCH",
  );
  requireExport(
    record.terminal.status === "completed" &&
      record.evidenceLedger.sealed === true &&
      reconstructed.ledger.eventCount === record.evidenceLedger.eventCount,
    "run is not a complete sealed verified change",
  );
  requireExport(
    constraints.expectedSpecDigest === undefined ||
      constraints.expectedSpecDigest === record.specDigest,
    "frozen spec digest does not match the caller constraint",
    "EXPORT_MISMATCH",
  );
  requireExport(
    constraints.expectedRecordDigest === undefined ||
      constraints.expectedRecordDigest === record.documentDigest,
    "record digest does not match the caller constraint",
    "EXPORT_MISMATCH",
  );
  requireExport(
    reconstructed.ledger.payloadBytes + reconstructed.recordBytes.byteLength <=
      maximumBytes,
    "sealed record and evidence payloads exceed the configured byte ceiling",
    "EXPORT_LIMIT",
  );

  const pointers = recordArtifactPointers(record);
  for (const role of COMPLETED_REQUIRED_ARTIFACT_ROLES) {
    requireExport(
      pointers.filter((pointer) => pointer.role === role).length === 1,
      `record requires exactly one final ${role} pointer`,
    );
  }
  const reconstructedByKey = new Map(
    reconstructed.artifacts.map((artifact) => [reconstructionKey(artifact), artifact]),
  );
  requireExport(
    reconstructedByKey.size === reconstructed.artifacts.length,
    "reconstruction duplicated an artifact identity",
  );
  const allArtifacts: ExportedVerifiedArtifact[] = pointers.map((pointer) => {
    const artifact = reconstructedByKey.get(
      `${pointer.step.stepId}\0${pointer.role}\0${pointer.digest}`,
    );
    requireExport(
      artifact !== undefined,
      `record artifact ${pointer.step.stepId}/${pointer.role} was not reconstructed`,
    );
    const expectedMediaType = WORKFLOW_ARTIFACT_MEDIA_TYPES[
      pointer.role as keyof typeof WORKFLOW_ARTIFACT_MEDIA_TYPES
    ];
    requireExport(
      expectedMediaType === undefined || artifact.mediaType === expectedMediaType,
      `artifact ${pointer.step.stepId}/${pointer.role} has unexpected media type ${artifact.mediaType}`,
    );
    return {
      pointer,
      mediaType: artifact.mediaType,
      bytes: new Uint8Array(artifact.payloadBytes),
    };
  });

  validateSingletonDocuments(record, allArtifacts);

  const finalVerificationAttempt = Math.max(
    1,
    ...record.steps
      .filter((step) => step.stage === "workflow.verify")
      .map((step) => step.attempt),
  );
  requireExport(
    record.spec.requiredVerification.length ===
      record.verificationCommands.length,
    "frozen check set and final command records have different lengths",
  );
  const checkIds = new Set<string>();
  const verificationOutputs: ExportedVerificationOutput[] = [];
  const outputEnvelope: unknown[] = [];
  for (const [index, command] of record.verificationCommands.entries()) {
    const frozen = record.spec.requiredVerification[index]!;
    requireExport(
      CHECK_ID_PATTERN.test(frozen.id) && !checkIds.has(frozen.id),
      `verification check ${index + 1} has no unique stable id`,
    );
    checkIds.add(frozen.id);
    requireExport(
      frozen.label === command.label && frozen.script === command.script,
      `verification check ${frozen.id} changed its frozen command identity`,
    );
    requireExport(
      command.exitCode === 0 && !command.timedOut && !command.truncated,
      `verification check ${frozen.id} is not a complete pass`,
    );
    const stepId = commandStepId(index + 1, finalVerificationAttempt);
    const step = record.steps.find((candidate) => candidate.stepId === stepId);
    requireExport(
      step !== undefined && step.status === "committed",
      `verification check ${frozen.id} has no committed final step`,
    );
    const stdout = step!.artifacts.filter(
      (pointer) => pointer.role === "verification_stdout",
    );
    const stderr = step!.artifacts.filter(
      (pointer) => pointer.role === "verification_stderr",
    );
    requireExport(
      stdout.length === 1 && stderr.length === 1,
      `verification check ${frozen.id} requires one stdout and one stderr pointer`,
    );
    const stdoutArtifact = allArtifacts.find(
      (artifact) => pointerKey(artifact.pointer) === pointerKey(stdout[0]!),
    );
    const stderrArtifact = allArtifacts.find(
      (artifact) => pointerKey(artifact.pointer) === pointerKey(stderr[0]!),
    );
    requireExport(
      stdoutArtifact !== undefined && stderrArtifact !== undefined,
      `verification check ${frozen.id} stream bytes were not reconstructed`,
    );
    requireExport(
      stdoutArtifact!.pointer.digest === command.stdoutDigest &&
        stderrArtifact!.pointer.digest === command.stderrDigest,
      `verification check ${frozen.id} stream digests differ from test_result`,
    );
    const commandDigest = sha256Digest(
      canonicalizeJson({ id: frozen.id, label: frozen.label, script: frozen.script }),
    );
    verificationOutputs.push({
      checkId: frozen.id,
      commandDigest,
      stdoutBytes: new Uint8Array(stdoutArtifact!.bytes),
      stderrBytes: new Uint8Array(stderrArtifact!.bytes),
    });
    outputEnvelope.push({
      checkId: frozen.id,
      commandDigest,
      stepId,
      stdout: {
        pointer: stdoutArtifact!.pointer,
        mediaType: stdoutArtifact!.mediaType,
      },
      stderr: {
        pointer: stderrArtifact!.pointer,
        mediaType: stderrArtifact!.mediaType,
      },
    });
  }

  const artifacts = allArtifacts.filter(
    (artifact) => !OUTPUT_ROLES.has(artifact.pointer.role),
  );
  const envelope = {
    schemaVersion: VERIFIED_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
    runId: record.runId,
    specDigest: record.specDigest,
    recordDigest: record.documentDigest,
    terminal: record.terminal,
    ledger: {
      sealDigest: reconstructed.ledger.sealDigest,
      sealedAt: reconstructed.ledger.sealedAt,
      eventCount: reconstructed.ledger.eventCount,
      headEventDigest: reconstructed.ledger.headEventDigest,
      ledgerDigest: reconstructed.ledger.ledgerDigest,
      ledgerByteLength: reconstructed.ledger.ledgerByteLength,
    },
    artifacts: artifacts.map((artifact) => ({
      pointer: artifact.pointer,
      mediaType: artifact.mediaType,
    })),
    verificationOutputs: outputEnvelope,
  };
  const evidenceEnvelopeBytes = new TextEncoder().encode(
    canonicalizeJson(envelope),
  );
  requireExport(
    reconstructed.ledger.payloadBytes +
      reconstructed.recordBytes.byteLength +
      evidenceEnvelopeBytes.byteLength <=
      maximumBytes,
    "complete verified export exceeds the configured byte ceiling",
    "EXPORT_LIMIT",
  );
  const exportRootDigest = sha256Digest(evidenceEnvelopeBytes);
  requireExport(
    constraints.expectedEvidenceDigest === undefined ||
      constraints.expectedEvidenceDigest === exportRootDigest,
    "export root digest does not match the caller constraint",
    "EXPORT_MISMATCH",
  );
  return {
    schemaVersion: VERIFIED_EVIDENCE_EXPORT_SCHEMA_VERSION,
    recordBytes: new Uint8Array(reconstructed.recordBytes),
    evidenceEnvelopeBytes,
    artifacts,
    verificationOutputs,
    exportRootDigest,
  };
}

export function verifiedEvidenceExportManifest(
  exported: ExportVerifiedRunResult,
): VerifiedEvidenceExportManifest {
  const record = parseRecord(exported.recordBytes);
  return {
    schemaVersion: "agenc.core.verified-export-manifest.v1",
    runId: record.runId,
    specDigest: record.specDigest,
    recordDigest: record.documentDigest,
    exportRootDigest: exported.exportRootDigest,
  };
}

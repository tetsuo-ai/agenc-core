/**
 * The M5 verified-change evidence record — document kind
 * `agenc.run.verified-change-record.v1`.
 *
 * A NEW document kind on the eval-contract machinery (canonical JSON,
 * sha256 document digests, content-addressed artifact pointers, and the
 * kind-agnostic evidence ledger). It deliberately does NOT overload the
 * frozen eval `run-record` kind: that document is suite/task-coupled and
 * schema-frozen; the verified-change record describes one workflow run.
 *
 * Discipline (copied from the trust-conformance runner): a record is
 * validated mechanically BEFORE it is emitted or a run may claim
 * `completed` — never emit unvalidated evidence.
 */

import {
  canonicalizeJson,
  computeDocumentDigest,
  sha256Digest,
} from "../eval-contract/canonical-json.js";
import type { Sha256Digest } from "../eval-contract/types.js";
import type {
  RunArtifactPointer,
  RunTerminalStatus,
  RunUsageTotals,
  WorkflowSpec,
  WorkflowStepId,
  WorkflowStepStatus,
  WorkflowStopReason,
} from "../contracts/run-contracts.js";
import {
  RUN_TERMINAL_STATUSES,
  WORKFLOW_STEP_IDS,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_STOP_REASONS,
} from "../contracts/run-contracts.js";

export const VERIFIED_CHANGE_RECORD_KIND =
  "agenc.run.verified-change-record.v1" as const;

/** Artifact roles the record REQUIRES for a `completed` terminal status. */
export const COMPLETED_REQUIRED_ARTIFACT_ROLES = [
  "patch",
  "changed_files",
  "test_result",
  "independent_review",
] as const;

export interface VerifiedChangeStepRecord {
  readonly stepId: string;
  /** The base pipeline stage this step belongs to (attempt/fan-out aware). */
  readonly stage: WorkflowStepId;
  readonly status: WorkflowStepStatus;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Machine verdict where the stage has one (verify/review). */
  readonly verdict?: string;
  readonly artifacts: readonly RunArtifactPointer[];
}

export interface VerifiedChangeCommandRecord {
  readonly label: string;
  readonly script: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly stdoutDigest: Sha256Digest;
  readonly stderrDigest: Sha256Digest;
}

export interface VerifiedChangeReviewRecord {
  readonly reviewerModel: string;
  readonly overallCorrectness: string;
  readonly overallConfidenceScore: number;
  readonly blockerCount: number;
  readonly findingCount: number;
  readonly artifact: RunArtifactPointer;
}

export interface VerifiedChangeRecord {
  readonly kind: typeof VERIFIED_CHANGE_RECORD_KIND;
  readonly recordVersion: 1;
  readonly runId: string;
  /** Canonical digest of the frozen WorkflowSpec (the intake intent digest). */
  readonly specDigest: Sha256Digest;
  readonly spec: WorkflowSpec;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly terminal: {
    readonly status: RunTerminalStatus;
    readonly stopReason: WorkflowStopReason | null;
    readonly finalMessage: string | null;
  };
  readonly usage: RunUsageTotals | null;
  readonly baseCommit: string;
  readonly headCommit: string | null;
  readonly steps: readonly VerifiedChangeStepRecord[];
  readonly verificationCommands: readonly VerifiedChangeCommandRecord[];
  readonly review: VerifiedChangeReviewRecord | null;
  /** Honest unresolved risks; empty ONLY when genuinely none remain. */
  readonly unresolvedRisks: readonly string[];
  readonly evidenceLedger: {
    readonly eventCount: number;
    readonly headEventDigest: Sha256Digest;
    readonly sealed: boolean;
    /**
     * The ledger seal's own digest (sha256 of the exact seal-document
     * bytes). Required for `completed` records: it is the external pin an
     * offline reconstruction hands to `verifyEvidenceLedger`, making the
     * exported bundle self-verifiable without local seal discovery.
     */
    readonly sealDigest?: Sha256Digest;
  };
  readonly documentDigest: Sha256Digest;
}

export interface VerifiedChangeRecordValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function computeSpecDigest(spec: WorkflowSpec): Sha256Digest {
  return sha256Digest(canonicalizeJson(spec));
}

export function assembleVerifiedChangeRecord(
  input: Omit<VerifiedChangeRecord, "kind" | "recordVersion" | "documentDigest">,
): VerifiedChangeRecord {
  const withoutDigest = {
    kind: VERIFIED_CHANGE_RECORD_KIND,
    recordVersion: 1 as const,
    ...input,
  };
  const documentDigest = computeDocumentDigest(withoutDigest);
  const record: VerifiedChangeRecord = { ...withoutDigest, documentDigest };
  const validation = validateVerifiedChangeRecord(record);
  if (!validation.valid) {
    throw new Error(
      `verified-change record failed self-validation: ${validation.errors.join("; ")}`,
    );
  }
  return record;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CAS_PATH_PATTERN = /^cas:\/\/sha256\/[0-9a-f]{64}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validateVerifiedChangeRecord(
  value: unknown,
): VerifiedChangeRecordValidation {
  const errors: string[] = [];
  const record = value as VerifiedChangeRecord;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { valid: false, errors: ["record must be an object"] };
  }
  if (record.kind !== VERIFIED_CHANGE_RECORD_KIND) {
    errors.push(`kind must be ${VERIFIED_CHANGE_RECORD_KIND}`);
  }
  if (record.recordVersion !== 1) errors.push("recordVersion must be 1");
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    errors.push("runId must be a non-empty string");
  }
  if (!SHA256_PATTERN.test(String(record.specDigest))) {
    errors.push("specDigest must be sha256:<64 hex>");
  }
  if (record.spec === null || typeof record.spec !== "object") {
    errors.push("spec must be the frozen WorkflowSpec object");
  } else if (computeSpecDigest(record.spec) !== record.specDigest) {
    errors.push("specDigest does not match the canonical spec digest");
  }
  for (const [field, timestamp] of [
    ["startedAt", record.startedAt],
    ["finishedAt", record.finishedAt],
  ] as const) {
    if (!RFC3339_PATTERN.test(String(timestamp))) {
      errors.push(`${field} must be an RFC 3339 timestamp`);
    }
  }
  const terminal = record.terminal;
  if (terminal === null || typeof terminal !== "object") {
    errors.push("terminal must be an object");
  } else {
    if (!(RUN_TERMINAL_STATUSES as readonly string[]).includes(terminal.status)) {
      errors.push("terminal.status must be a frozen run terminal status");
    }
    if (
      terminal.stopReason !== null &&
      !(WORKFLOW_STOP_REASONS as readonly string[]).includes(terminal.stopReason)
    ) {
      errors.push("terminal.stopReason must be a frozen workflow stop reason");
    }
    if (terminal.status !== "completed" && terminal.stopReason === null) {
      errors.push("non-completed terminal status requires a stopReason");
    }
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  } else {
    for (const step of record.steps) {
      if (!(WORKFLOW_STEP_IDS as readonly string[]).includes(step.stage)) {
        errors.push(`step ${step.stepId}: unknown stage ${String(step.stage)}`);
      }
      if (!(WORKFLOW_STEP_STATUSES as readonly string[]).includes(step.status)) {
        errors.push(`step ${step.stepId}: unknown status ${String(step.status)}`);
      }
      for (const artifact of step.artifacts ?? []) {
        if (!SHA256_PATTERN.test(String(artifact.digest))) {
          errors.push(`step ${step.stepId}: artifact digest must be sha256:<64 hex>`);
        }
        if (!CAS_PATH_PATTERN.test(String(artifact.storagePath))) {
          errors.push(
            `step ${step.stepId}: artifact storagePath must be cas://sha256/<hex>`,
          );
        }
        if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
          errors.push(`step ${step.stepId}: artifact bytes must be a non-negative integer`);
        }
      }
    }
  }
  if (record.terminal?.status === "completed") {
    const roles = new Set(
      (record.steps ?? []).flatMap((step) =>
        (step.artifacts ?? []).map((artifact) => artifact.role),
      ),
    );
    for (const required of COMPLETED_REQUIRED_ARTIFACT_ROLES) {
      if (!roles.has(required)) {
        errors.push(`completed record is missing required artifact role: ${required}`);
      }
    }
    if (record.review === null) {
      errors.push("completed record requires the independent review block");
    } else if (record.review.blockerCount !== 0) {
      errors.push("completed record cannot carry unresolved review blockers");
    }
    for (const command of record.verificationCommands ?? []) {
      if (command.exitCode !== 0 || command.timedOut) {
        errors.push(
          `completed record has a failing verification command: ${command.label}`,
        );
      }
    }
    if (record.headCommit === null) {
      errors.push("completed record requires headCommit");
    }
  }
  if (!Array.isArray(record.unresolvedRisks)) {
    errors.push("unresolvedRisks must be an array (empty only when none remain)");
  }
  const ledger = record.evidenceLedger;
  if (ledger === null || typeof ledger !== "object") {
    errors.push("evidenceLedger must be an object");
  } else {
    if (!Number.isSafeInteger(ledger.eventCount) || ledger.eventCount < 1) {
      errors.push("evidenceLedger.eventCount must be a positive integer");
    }
    if (!SHA256_PATTERN.test(String(ledger.headEventDigest))) {
      errors.push("evidenceLedger.headEventDigest must be sha256:<64 hex>");
    }
    if (
      ledger.sealDigest !== undefined &&
      !SHA256_PATTERN.test(String(ledger.sealDigest))
    ) {
      errors.push("evidenceLedger.sealDigest must be sha256:<64 hex>");
    }
    if (record.terminal?.status === "completed" && ledger.sealed !== true) {
      errors.push("completed record requires a sealed evidence ledger");
    }
    if (
      record.terminal?.status === "completed" &&
      ledger.sealDigest === undefined
    ) {
      errors.push("completed record requires evidenceLedger.sealDigest");
    }
  }
  if (typeof record.documentDigest === "string") {
    const { documentDigest: _digest, ...body } = record;
    if (computeDocumentDigest(body) !== record.documentDigest) {
      errors.push("documentDigest does not match the canonical record body");
    }
  } else {
    errors.push("documentDigest must be present");
  }
  return { valid: errors.length === 0, errors };
}

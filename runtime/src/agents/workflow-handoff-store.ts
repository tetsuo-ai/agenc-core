/** Crash-safe, quota-governed storage for workflow handoff bytes. */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, join, resolve, win32 } from "node:path";
import { TextDecoder } from "node:util";

import { commitArtifactAtomically } from "../durability/atomic-artifact.js";
import type { StateSqliteDriver } from "../state/sqlite-driver.js";
import {
  MAX_WORKFLOW_ARTIFACT_BYTES,
  MAX_WORKFLOW_ARTIFACT_BYTES_GLOBAL,
  MAX_WORKFLOW_ARTIFACT_BYTES_PER_RUN,
  MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH,
  MAX_WORKFLOW_ARTIFACT_IDEMPOTENCY_KEY_UTF8_BYTES,
  MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
  MAX_WORKFLOW_ARTIFACTS_GLOBAL,
  MAX_WORKFLOW_ARTIFACTS_PER_RUN,
  MAX_WORKFLOW_STEP_PREVIEW_BYTES,
  MAX_WORKFLOW_STEP_RESULT_TOKENS,
  WORKFLOW_ARTIFACT_INTENT_RECOVERY_GRACE_MS,
  WORKFLOW_ARTIFACT_RETENTION_MS,
  WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION,
  WORKFLOW_HANDOFF_ARTIFACT_KIND,
  WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH,
  WORKFLOW_HANDOFF_ENCODING,
  WORKFLOW_HANDOFF_MEDIA_TYPE,
  validateWorkflowHandoffArtifactValue,
  type WorkflowHandoffArtifact,
  type WorkflowHandoffOwner,
} from "./workflow-handoff-schema.js";

const ARTIFACT_ID_DIGEST_DOMAIN = "agenc.workflow-handoff.artifact-id.v2\0";
const ARTIFACT_CONTENT_DIGEST_DOMAIN = "";
const ARTIFACT_FILE_SUFFIX = ".handoff";
const ARTIFACT_FILE_MODE = 0o600;
const ARTIFACT_ROOT_MODE = 0o700;
const SHA256_PREFIX = "sha256:";
const MAX_REFERENCE_FIELD_UTF8_BYTES = 1_024;
const WINDOWS_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;
const WINDOWS_SECURITY_TIMEOUT_MS = 30_000;
const WINDOWS_SECURITY_MAX_OUTPUT_BYTES = 1_048_576;
const WINDOWS_HANDOFF_SECURITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($env:AGENC_HANDOFF_SECURITY_PATH)
$role = $env:AGENC_HANDOFF_SECURITY_ROLE
$initialize = $env:AGENC_HANDOFF_SECURITY_INITIALIZE -eq '1'
if (@('directory', 'file') -notcontains $role) { throw 'invalid role' }
if ($target.StartsWith('\\') -or $target.StartsWith('\\?\') -or $target.StartsWith('\\.\')) {
  throw 'network and device paths are unsupported'
}
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'reparse points are unsupported'
}
$drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($target))
if ($drive.DriveFormat -ne 'NTFS') { throw 'NTFS is required' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($initialize) {
  if ($role -eq 'directory') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
$verified = Get-Acl -LiteralPath $target
if (-not $verified.AreAccessRulesProtected) { throw 'inherited ACL is unsupported' }
if ($verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
  throw 'path owner is not the current user'
}
$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$hasFullControl = $false
foreach ($rule in $rules) {
  if ($rule.IsInherited) { throw 'inherited ACE is unsupported' }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
    throw 'deny ACE is unsupported'
  }
  if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'foreign ACE is unsupported' }
  if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) {
    $hasFullControl = $true
  }
}
if (-not $hasFullControl) { throw 'current-user full-control ACE is missing' }
[Console]::Out.Write('OK')
`;
const WINDOWS_HANDOFF_SECURITY_SCRIPT_BASE64 = Buffer.from(
  WINDOWS_HANDOFF_SECURITY_SCRIPT,
  "utf16le",
).toString("base64");

export type WorkflowHandoffStatus =
  | "intent"
  | "committed"
  | "deleting"
  | "conflict";

interface WorkflowHandoffRow {
  readonly artifact_id: string;
  readonly format_version: number;
  readonly kind: string;
  readonly compatibility_epoch: string;
  readonly idempotency_key: string;
  readonly run_id: string;
  readonly workflow_id: string;
  readonly producer_step_id: string;
  readonly digest: string;
  readonly byte_length: number;
  readonly token_count: number;
  readonly storage_ref: string;
  readonly status: WorkflowHandoffStatus;
  readonly preview: string;
  readonly preview_truncated: 0 | 1;
  readonly created_at_ms: number;
  readonly committed_at_ms: number | null;
  readonly commit_sequence: number | null;
  readonly last_access_at_ms: number;
  readonly unreferenced_at_ms: number | null;
}

interface QuotaRow {
  readonly artifact_count: number;
  readonly artifact_bytes: number;
}

interface CursorRow {
  readonly sort_ms: number;
  readonly artifact_id: string;
}

export interface WorkflowHandoffStoreOptions {
  readonly driver: StateSqliteDriver;
  readonly trustedRoot: string;
  readonly now?: () => number;
  readonly retentionMs?: number;
  readonly intentRecoveryGraceMs?: number;
  readonly hooks?: WorkflowHandoffStoreHooks;
}

export interface WorkflowHandoffStoreHooks {
  readonly afterIntentReserved?: (artifactId: string) => void | Promise<void>;
  readonly afterArtifactInstalled?: (artifactId: string) => void | Promise<void>;
  readonly afterCleanupReserved?: (
    artifactIds: readonly string[],
  ) => void | Promise<void>;
  readonly afterCleanupFileRemoved?: (
    artifactId: string,
  ) => void | Promise<void>;
}

export interface PublishWorkflowHandoffOptions {
  readonly owner: WorkflowHandoffOwner;
  readonly idempotencyKey: string;
  readonly bytes: Uint8Array;
  readonly tokenCount: number;
}

export interface ReadWorkflowHandoffOptions {
  readonly expectedOwner?: WorkflowHandoffOwner;
}

export interface ReadWorkflowHandoffResult {
  readonly artifact: WorkflowHandoffArtifact;
  readonly bytes: Uint8Array;
}

export interface WorkflowHandoffRecoveryResult {
  readonly inspected: number;
  readonly committed: number;
  readonly removedMissing: number;
  readonly conflicts: number;
  readonly truncated: boolean;
}

export interface WorkflowHandoffCleanupResult {
  readonly inspected: number;
  readonly removed: number;
  readonly missing: number;
  readonly conflicts: number;
  readonly truncated: boolean;
}

export interface WorkflowHandoffOperatorEntry {
  readonly artifact_id: string;
  readonly format_version: number;
  readonly kind: string;
  readonly compatibility_epoch: string;
  readonly owner: WorkflowHandoffOwner;
  readonly digest: string;
  readonly byte_length: number;
  readonly token_count: number;
  readonly storage_ref: string;
  readonly status: WorkflowHandoffStatus;
  readonly created_at_ms: number;
  readonly committed_at_ms: number | null;
  readonly commit_sequence: number | null;
  readonly last_access_at_ms: number;
  readonly unreferenced_at_ms: number | null;
  readonly reference_count: number;
}

export interface WorkflowHandoffOperatorPage {
  readonly entries: readonly WorkflowHandoffOperatorEntry[];
  readonly next_artifact_id?: string;
}

export class WorkflowHandoffStoreError extends Error {
  constructor(
    readonly code:
      | "WORKFLOW_HANDOFF_INVALID"
      | "WORKFLOW_HANDOFF_QUOTA"
      | "WORKFLOW_HANDOFF_CONFLICT"
      | "WORKFLOW_HANDOFF_NOT_COMMITTED"
      | "WORKFLOW_HANDOFF_NOT_FOUND"
      | "WORKFLOW_HANDOFF_CORRUPT"
      | "WORKFLOW_HANDOFF_OWNER_MISMATCH"
      | "WORKFLOW_HANDOFF_UNSAFE_ROOT"
      | "WORKFLOW_HANDOFF_SAFE_IO_UNSUPPORTED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowHandoffStoreError";
  }
}

/**
 * A store instance owns one already-migrated state database and one private
 * artifact root. Startup callers should run {@link recoverIntents} before
 * allowing a scheduler to publish or consume handoffs.
 */
export class WorkflowHandoffArtifactStore {
  readonly #driver: StateSqliteDriver;
  readonly #trustedRoot: string;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #intentRecoveryGraceMs: number;
  readonly #hooks: WorkflowHandoffStoreHooks;

  constructor(options: WorkflowHandoffStoreOptions) {
    this.#driver = options.driver;
    this.#trustedRoot = initializeTrustedRoot(options.trustedRoot);
    this.#now = options.now ?? Date.now;
    this.#retentionMs = positiveSafeInteger(
      options.retentionMs,
      WORKFLOW_ARTIFACT_RETENTION_MS,
      "workflow handoff retention",
    );
    this.#intentRecoveryGraceMs = nonNegativeSafeInteger(
      options.intentRecoveryGraceMs,
      WORKFLOW_ARTIFACT_INTENT_RECOVERY_GRACE_MS,
      "workflow handoff intent recovery grace",
    );
    this.#hooks = options.hooks ?? Object.freeze({});
  }

  get trustedRoot(): string {
    return this.#trustedRoot;
  }

  async publish(
    options: PublishWorkflowHandoffOptions,
  ): Promise<WorkflowHandoffArtifact> {
    const now = currentTime(this.#now);
    const owner = validateOwner(options.owner);
    const idempotencyKey = validateBoundedString(
      options.idempotencyKey,
      "idempotency key",
      MAX_WORKFLOW_ARTIFACT_IDEMPOTENCY_KEY_UTF8_BYTES,
    );
    if (
      !Number.isSafeInteger(options.tokenCount) ||
      options.tokenCount < 0 ||
      options.tokenCount > MAX_WORKFLOW_STEP_RESULT_TOKENS
    ) {
      throw storeError(
        "WORKFLOW_HANDOFF_INVALID",
        `workflow handoff token count must be between 0 and ${MAX_WORKFLOW_STEP_RESULT_TOKENS}`,
      );
    }
    const bytes = Buffer.from(options.bytes);
    if (bytes.byteLength > MAX_WORKFLOW_ARTIFACT_BYTES) {
      throw storeError(
        "WORKFLOW_HANDOFF_QUOTA",
        `workflow handoff exceeds ${MAX_WORKFLOW_ARTIFACT_BYTES} bytes`,
      );
    }
    const text = decodeUtf8(bytes, "workflow handoff bytes");
    const digest = contentDigest(bytes);
    const artifactId = artifactIdFor(owner, idempotencyKey);
    const preview = boundedUtf8Prefix(text, MAX_WORKFLOW_STEP_PREVIEW_BYTES);
    const previewTruncated = Buffer.byteLength(preview, "utf8") < bytes.byteLength;
    const desired = Object.freeze({
      artifactId,
      owner,
      idempotencyKey,
      digest,
      byteLength: bytes.byteLength,
      tokenCount: options.tokenCount,
      storageRef: storageReference(artifactId),
      preview,
      previewTruncated,
      now,
    });

    const reserved = this.#reserveIntent(desired);
    if (reserved.status === "committed") {
      await this.#assertCommittedFile(reserved);
      return metadataFromRow(reserved);
    }
    if (reserved.status !== "intent") {
      throw storeError(
        "WORKFLOW_HANDOFF_CONFLICT",
        `workflow handoff ${artifactId} is ${reserved.status} and cannot be published`,
      );
    }

    await this.#hooks.afterIntentReserved?.(artifactId);

    if (process.platform === "win32") {
      await commitWindowsArtifactAtomically(
        this.#artifactPath(artifactId),
        this.#trustedRoot,
        bytes,
      );
    } else {
      await commitArtifactAtomically(this.#artifactPath(artifactId), bytes, {
        trustedRoot: this.#trustedRoot,
        mode: ARTIFACT_FILE_MODE,
      });
    }
    await this.#hooks.afterArtifactInstalled?.(artifactId);
    return metadataFromRow(
      this.#commitIntent(artifactId, currentTime(this.#now)),
    );
  }

  async read(
    artifactIdOrReference: string,
    options: ReadWorkflowHandoffOptions = {},
  ): Promise<ReadWorkflowHandoffResult> {
    const artifactId = parseArtifactIdentity(artifactIdOrReference);
    const row = this.#row(artifactId);
    if (row === undefined) {
      throw storeError(
        "WORKFLOW_HANDOFF_NOT_FOUND",
        `workflow handoff ${artifactId} does not exist`,
      );
    }
    if (row.status !== "committed") {
      throw storeError(
        "WORKFLOW_HANDOFF_NOT_COMMITTED",
        `workflow handoff ${artifactId} is not committed`,
      );
    }
    if (
      options.expectedOwner !== undefined &&
      !sameOwner(rowOwner(row), validateOwner(options.expectedOwner))
    ) {
      throw storeError(
        "WORKFLOW_HANDOFF_OWNER_MISMATCH",
        `workflow handoff ${artifactId} does not belong to the expected owner`,
      );
    }
    const bytes = await this.#readVerifiedBytes(row);
    const now = currentTime(this.#now);
    this.#driver
      .prepareState<[number, string]>(
        `UPDATE workflow_handoff_artifacts
         SET last_access_at_ms = MAX(last_access_at_ms, ?)
         WHERE artifact_id = ? AND status = 'committed'`,
      )
      .run(now, artifactId);
    return Object.freeze({
      artifact: metadataFromRow(row),
      bytes: Uint8Array.from(bytes),
    });
  }

  retain(
    artifactIdOrReference: string,
    referenceId: string,
    consumerRunId: string,
  ): void {
    const artifactId = parseArtifactIdentity(artifactIdOrReference);
    const reference = validateBoundedString(
      referenceId,
      "workflow handoff reference ID",
      MAX_REFERENCE_FIELD_UTF8_BYTES,
    );
    const consumer = validateBoundedString(
      consumerRunId,
      "workflow handoff consumer run ID",
      MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
    );
    const now = currentTime(this.#now);
    this.#driver.transactionImmediate(() => {
      const row = this.#row(artifactId);
      if (row === undefined) {
        throw storeError(
          "WORKFLOW_HANDOFF_NOT_FOUND",
          `workflow handoff ${artifactId} does not exist`,
        );
      }
      if (row.status !== "committed") {
        throw storeError(
          "WORKFLOW_HANDOFF_NOT_COMMITTED",
          `workflow handoff ${artifactId} is not retainable`,
        );
      }
      const existing = this.#driver
        .prepareState<
          [string, string],
          { readonly consumer_run_id: string }
        >(
          `SELECT consumer_run_id
           FROM workflow_handoff_references
           WHERE artifact_id = ? AND reference_id = ?`,
        )
        .get(artifactId, reference);
      if (existing !== undefined && existing.consumer_run_id !== consumer) {
        throw storeError(
          "WORKFLOW_HANDOFF_CONFLICT",
          `workflow handoff reference ${reference} already has another owner`,
        );
      }
      this.#driver
        .prepareState<[string, string, string, number]>(
          `INSERT OR IGNORE INTO workflow_handoff_references (
             artifact_id, reference_id, consumer_run_id, created_at_ms
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(artifactId, reference, consumer, now);
      this.#driver
        .prepareState<[number, string]>(
          `UPDATE workflow_handoff_artifacts
           SET unreferenced_at_ms = NULL,
               last_access_at_ms = MAX(last_access_at_ms, ?)
           WHERE artifact_id = ?`,
        )
        .run(now, artifactId);
    });
  }

  release(
    artifactIdOrReference: string,
    referenceId: string,
    consumerRunId: string,
  ): boolean {
    const artifactId = parseArtifactIdentity(artifactIdOrReference);
    const reference = validateBoundedString(
      referenceId,
      "workflow handoff reference ID",
      MAX_REFERENCE_FIELD_UTF8_BYTES,
    );
    const consumer = validateBoundedString(
      consumerRunId,
      "workflow handoff consumer run ID",
      MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
    );
    const now = currentTime(this.#now);
    return this.#driver.transactionImmediate(() => {
      const existing = this.#driver
        .prepareState<
          [string, string],
          { readonly consumer_run_id: string }
        >(
          `SELECT consumer_run_id
           FROM workflow_handoff_references
           WHERE artifact_id = ? AND reference_id = ?`,
        )
        .get(artifactId, reference);
      if (existing === undefined) return false;
      if (existing.consumer_run_id !== consumer) {
        throw storeError(
          "WORKFLOW_HANDOFF_OWNER_MISMATCH",
          `workflow handoff reference ${reference} does not belong to consumer ${consumer}`,
        );
      }
      const removed = this.#driver
        .prepareState<[string, string, string]>(
          `DELETE FROM workflow_handoff_references
           WHERE artifact_id = ? AND reference_id = ? AND consumer_run_id = ?`,
        )
        .run(artifactId, reference, consumer).changes;
      if (removed !== 1) {
        throw storeError(
          "WORKFLOW_HANDOFF_CONFLICT",
          `workflow handoff reference ${reference} changed during release`,
        );
      }
      const remaining = this.#driver
        .prepareState<[string], { readonly count: number }>(
          `SELECT COUNT(*) AS count
           FROM workflow_handoff_references
           WHERE artifact_id = ?`,
        )
        .get(artifactId)?.count ?? 0;
      if (remaining === 0) {
        this.#driver
          .prepareState<[number, string]>(
            `UPDATE workflow_handoff_artifacts
             SET unreferenced_at_ms = MAX(created_at_ms, last_access_at_ms, ?)
             WHERE artifact_id = ? AND status = 'committed'`,
          )
          .run(now, artifactId);
      }
      return true;
    });
  }

  /** Content-free metadata for operator inspection and cleanup previews. */
  inspectForOperator(
    artifactIdOrReference: string,
  ): WorkflowHandoffOperatorEntry {
    const artifactId = parseArtifactIdentity(artifactIdOrReference);
    const row = this.#row(artifactId);
    if (row === undefined) {
      throw storeError(
        "WORKFLOW_HANDOFF_NOT_FOUND",
        `workflow handoff ${artifactId} does not exist`,
      );
    }
    return operatorEntry(row, this.#referenceCount(artifactId));
  }

  /** Stable artifact-id keyset page; output bytes and previews are never read. */
  listForOperator(
    maximumRecords = MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH,
    afterArtifactId?: string,
  ): WorkflowHandoffOperatorPage {
    const limit = cleanupBatchSize(maximumRecords);
    const after =
      afterArtifactId === undefined ? "" : parseArtifactIdentity(afterArtifactId);
    const rows = this.#driver
      .prepareState<
        [string, number],
        WorkflowHandoffRow & { readonly reference_count: number }
      >(
        `SELECT artifact.*,
                (SELECT COUNT(*) FROM workflow_handoff_references AS reference
                 WHERE reference.artifact_id = artifact.artifact_id) AS reference_count
         FROM workflow_handoff_artifacts AS artifact
         WHERE artifact.artifact_id > ?
         ORDER BY artifact.artifact_id
         LIMIT ?`,
      )
      .all(after, limit + 1);
    const entries = rows
      .slice(0, limit)
      .map((row) => operatorEntry(row, row.reference_count));
    return Object.freeze({
      entries: Object.freeze(entries),
      ...(rows.length > limit
        ? { next_artifact_id: entries.at(-1)!.artifact_id }
        : {}),
    });
  }

  async recoverIntents(
    maximumRecords = MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH,
  ): Promise<WorkflowHandoffRecoveryResult> {
    const limit = cleanupBatchSize(maximumRecords);
    const now = currentTime(this.#now);
    const cutoff = Math.max(0, now - this.#intentRecoveryGraceMs);
    const cursor = this.#cursor("intent_recovery");
    const rows = this.#driver
      .prepareState<
        [number, number, number, string, number],
        WorkflowHandoffRow
      >(
        `SELECT *
         FROM workflow_handoff_artifacts
         WHERE status = 'intent'
           AND created_at_ms <= ?
           AND (created_at_ms > ? OR (created_at_ms = ? AND artifact_id > ?))
         ORDER BY created_at_ms, artifact_id
         LIMIT ?`,
      )
      // The duplicated cutoff parameter below is replaced with cursor values;
      // a five-parameter tuple is clearer than interpolating trusted numbers.
      .all(
        cutoff,
        cursor?.sort_ms ?? 0,
        cursor?.sort_ms ?? 0,
        cursor?.artifact_id ?? "",
        limit,
      ) as readonly WorkflowHandoffRow[];
    let committed = 0;
    let removedMissing = 0;
    let conflicts = 0;
    for (const row of rows) {
      const observation = await this.#inspectExpectedFile(row);
      if (observation === "match") {
        this.#commitIntent(row.artifact_id, now);
        committed += 1;
      } else if (observation === "missing") {
        this.#driver.transactionImmediate(() => {
          this.#driver
            .prepareState<[string]>(
              `DELETE FROM workflow_handoff_artifacts
               WHERE artifact_id = ? AND status = 'intent'`,
            )
            .run(row.artifact_id);
        });
        removedMissing += 1;
      } else {
        this.#markConflict(row.artifact_id, "intent");
        conflicts += 1;
      }
      this.#setCursor(
        "intent_recovery",
        row.created_at_ms,
        row.artifact_id,
        now,
      );
    }
    if (rows.length < limit) this.#clearCursor("intent_recovery");
    return Object.freeze({
      inspected: rows.length,
      committed,
      removedMissing,
      conflicts,
      truncated: rows.length === limit,
    });
  }

  async cleanupExpired(
    maximumRecords = MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH,
  ): Promise<WorkflowHandoffCleanupResult> {
    const limit = cleanupBatchSize(maximumRecords);
    const now = currentTime(this.#now);
    const cutoff = Math.max(0, now - this.#retentionMs);
    const cursor = this.#cursor("retention_cleanup");
    // A prior process may have crashed after reserving deletion. Those rows
    // are always completed before new work, independent of cursor position.
    const deleting = this.#driver
      .prepareState<[number], WorkflowHandoffRow>(
        `SELECT *
         FROM workflow_handoff_artifacts
         WHERE status = 'deleting'
         ORDER BY last_access_at_ms, artifact_id
         LIMIT ?`,
      )
      .all(limit);
    const rows = this.#driver.transactionImmediate(() => {
      if (deleting.length > 0) return deleting;
      const candidates = this.#driver
        .prepareState<
          [number, number, number, string, number],
          WorkflowHandoffRow
        >(
          `SELECT artifact.*
           FROM workflow_handoff_artifacts AS artifact
           WHERE artifact.status = 'committed'
             AND artifact.unreferenced_at_ms IS NOT NULL
             AND artifact.unreferenced_at_ms <= ?
             AND NOT EXISTS (
               SELECT 1 FROM workflow_handoff_references AS reference
               WHERE reference.artifact_id = artifact.artifact_id
             )
             AND (
               artifact.last_access_at_ms > ?
               OR (artifact.last_access_at_ms = ? AND artifact.artifact_id > ?)
             )
           ORDER BY artifact.last_access_at_ms, artifact.artifact_id
           LIMIT ?`,
        )
        .all(
          cutoff,
          cursor?.sort_ms ?? 0,
          cursor?.sort_ms ?? 0,
          cursor?.artifact_id ?? "",
          limit,
        ) as readonly WorkflowHandoffRow[];
      const mark = this.#driver.prepareState<[string]>(
        `UPDATE workflow_handoff_artifacts
         SET status = 'deleting'
         WHERE artifact_id = ?
           AND status = 'committed'
           AND NOT EXISTS (
             SELECT 1 FROM workflow_handoff_references
             WHERE artifact_id = workflow_handoff_artifacts.artifact_id
           )`,
      );
      for (const candidate of candidates) {
        if (mark.run(candidate.artifact_id).changes !== 1) {
          throw storeError(
            "WORKFLOW_HANDOFF_CONFLICT",
            `workflow handoff ${candidate.artifact_id} changed during cleanup reservation`,
          );
        }
      }
      return candidates.map((candidate) => ({
        ...candidate,
        status: "deleting" as const,
      }));
    });

    await this.#hooks.afterCleanupReserved?.(
      Object.freeze(rows.map((row) => row.artifact_id)),
    );

    let removed = 0;
    let missing = 0;
    let conflicts = 0;
    for (const row of rows) {
      const outcome = await this.#removeExpectedFile(row);
      if (outcome === "conflict") {
        this.#markConflict(row.artifact_id, "deleting");
        conflicts += 1;
        this.#setCursor(
          "retention_cleanup",
          row.last_access_at_ms,
          row.artifact_id,
          now,
        );
      } else {
        await this.#hooks.afterCleanupFileRemoved?.(row.artifact_id);
        this.#driver.transactionImmediate(() => {
          this.#driver
            .prepareState<[string]>(
              `DELETE FROM workflow_handoff_artifacts
               WHERE artifact_id = ? AND status = 'deleting'`,
            )
            .run(row.artifact_id);
          this.#setCursor(
            "retention_cleanup",
            row.last_access_at_ms,
            row.artifact_id,
            now,
          );
        });
        if (outcome === "removed") removed += 1;
        else missing += 1;
      }
    }
    if (rows.length < limit) this.#clearCursor("retention_cleanup");
    return Object.freeze({
      inspected: rows.length,
      removed,
      missing,
      conflicts,
      truncated: rows.length === limit,
    });
  }

  #reserveIntent(desired: {
    readonly artifactId: string;
    readonly owner: WorkflowHandoffOwner;
    readonly idempotencyKey: string;
    readonly digest: string;
    readonly byteLength: number;
    readonly tokenCount: number;
    readonly storageRef: string;
    readonly preview: string;
    readonly previewTruncated: boolean;
    readonly now: number;
  }): WorkflowHandoffRow {
    return this.#driver.transactionImmediate(() => {
      const existing = this.#driver
        .prepareState<
          [string, string],
          WorkflowHandoffRow
        >(
          `SELECT * FROM workflow_handoff_artifacts
           WHERE run_id = ? AND idempotency_key = ?`,
        )
        .get(desired.owner.run_id, desired.idempotencyKey);
      if (existing !== undefined) {
        assertSameIntent(existing, desired);
        return existing;
      }
      const runQuota = this.#runQuota(desired.owner.run_id);
      const globalQuota = this.#globalQuota();
      assertQuotaAvailable(
        runQuota,
        desired.byteLength,
        MAX_WORKFLOW_ARTIFACTS_PER_RUN,
        MAX_WORKFLOW_ARTIFACT_BYTES_PER_RUN,
        "workflow run",
      );
      assertQuotaAvailable(
        globalQuota,
        desired.byteLength,
        MAX_WORKFLOW_ARTIFACTS_GLOBAL,
        MAX_WORKFLOW_ARTIFACT_BYTES_GLOBAL,
        "workflow artifact store",
      );
      this.#driver
        .prepareState<
          [
            string,
            number,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            number,
            string,
            string,
            string,
            number,
            number,
            number,
            number,
          ]
        >(
          `INSERT INTO workflow_handoff_artifacts (
             artifact_id, format_version, kind, compatibility_epoch,
             idempotency_key, run_id, workflow_id, producer_step_id, digest,
             byte_length, token_count, storage_ref, status, preview,
             preview_truncated, created_at_ms, last_access_at_ms,
             unreferenced_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          desired.artifactId,
          WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION,
          WORKFLOW_HANDOFF_ARTIFACT_KIND,
          WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH,
          desired.idempotencyKey,
          desired.owner.run_id,
          desired.owner.workflow_id,
          desired.owner.producer_step_id,
          desired.digest,
          desired.byteLength,
          desired.tokenCount,
          desired.storageRef,
          "intent",
          desired.preview,
          desired.previewTruncated ? 1 : 0,
          desired.now,
          desired.now,
          desired.now,
        );
      const inserted = this.#row(desired.artifactId);
      if (inserted === undefined) {
        throw storeError(
          "WORKFLOW_HANDOFF_CONFLICT",
          "workflow handoff intent was not durably reserved",
        );
      }
      return inserted;
    });
  }

  #runQuota(runId: string): QuotaRow {
    return (
      this.#driver
        .prepareState<[string], QuotaRow>(
          `SELECT artifact_count, artifact_bytes
           FROM workflow_handoff_quota_runs WHERE run_id = ?`,
        )
        .get(runId) ?? { artifact_count: 0, artifact_bytes: 0 }
    );
  }

  #globalQuota(): QuotaRow {
    const quota = this.#driver
      .prepareState<[], QuotaRow>(
        `SELECT artifact_count, artifact_bytes
         FROM workflow_handoff_quota_global WHERE singleton = 1`,
      )
      .get();
    if (quota === undefined) {
      throw storeError(
        "WORKFLOW_HANDOFF_CORRUPT",
        "workflow handoff global quota ledger is missing",
      );
    }
    return quota;
  }

  #commitIntent(artifactId: string, now: number): WorkflowHandoffRow {
    return this.#driver.transactionImmediate(() => {
      const row = this.#row(artifactId);
      if (row === undefined) {
        throw storeError(
          "WORKFLOW_HANDOFF_NOT_FOUND",
          `workflow handoff intent ${artifactId} does not exist`,
        );
      }
      if (row.status === "committed") return row;
      if (row.status !== "intent") {
        throw storeError(
          "WORKFLOW_HANDOFF_CONFLICT",
          `workflow handoff ${artifactId} cannot commit from ${row.status}`,
        );
      }
      const sequence = this.#driver
        .prepareState<[], { readonly next_commit_sequence: number }>(
          `SELECT next_commit_sequence
           FROM workflow_handoff_sequence WHERE singleton = 1`,
        )
        .get()?.next_commit_sequence;
      if (!Number.isSafeInteger(sequence) || sequence === undefined || sequence < 1) {
        throw storeError(
          "WORKFLOW_HANDOFF_CORRUPT",
          "workflow handoff commit sequence is invalid",
        );
      }
      this.#driver
        .prepareState<[]>(
          `UPDATE workflow_handoff_sequence
           SET next_commit_sequence = next_commit_sequence + 1
           WHERE singleton = 1`,
        )
        .run();
      const committedAt = Math.max(
        row.created_at_ms,
        row.last_access_at_ms,
        now,
      );
      const updated = this.#driver
        .prepareState<[number, number, number, number, string]>(
          `UPDATE workflow_handoff_artifacts
           SET status = 'committed', committed_at_ms = ?, commit_sequence = ?,
               last_access_at_ms = MAX(last_access_at_ms, ?),
               unreferenced_at_ms = ?
           WHERE artifact_id = ? AND status = 'intent'`,
        )
        .run(committedAt, sequence, committedAt, committedAt, artifactId);
      if (updated.changes !== 1) {
        throw storeError(
          "WORKFLOW_HANDOFF_CONFLICT",
          `workflow handoff ${artifactId} changed during commit`,
        );
      }
      return this.#row(artifactId)!;
    });
  }

  #row(artifactId: string): WorkflowHandoffRow | undefined {
    return this.#driver
      .prepareState<[string], WorkflowHandoffRow>(
        `SELECT * FROM workflow_handoff_artifacts WHERE artifact_id = ?`,
      )
      .get(artifactId);
  }

  #referenceCount(artifactId: string): number {
    return this.#driver
      .prepareState<[string], { readonly count: number }>(
        `SELECT COUNT(*) AS count
         FROM workflow_handoff_references WHERE artifact_id = ?`,
      )
      .get(artifactId)?.count ?? 0;
  }

  #artifactPath(artifactId: string): string {
    return join(this.#trustedRoot, `${artifactId}${ARTIFACT_FILE_SUFFIX}`);
  }

  async #assertCommittedFile(row: WorkflowHandoffRow): Promise<void> {
    const observation = await this.#inspectExpectedFile(row);
    if (observation !== "match") {
      throw storeError(
        "WORKFLOW_HANDOFF_CORRUPT",
        `committed workflow handoff ${row.artifact_id} is ${observation}`,
      );
    }
  }

  async #readVerifiedBytes(row: WorkflowHandoffRow): Promise<Buffer> {
    const inspected = await this.#readCandidate(row);
    if (inspected.observation !== "match" || inspected.bytes === undefined) {
      throw storeError(
        "WORKFLOW_HANDOFF_CORRUPT",
        `workflow handoff ${row.artifact_id} failed digest-bound read (${inspected.observation})`,
      );
    }
    return inspected.bytes;
  }

  async #inspectExpectedFile(
    row: WorkflowHandoffRow,
  ): Promise<"missing" | "match" | "conflict"> {
    return (await this.#readCandidate(row)).observation;
  }

  async #readCandidate(row: WorkflowHandoffRow): Promise<{
    readonly observation: "missing" | "match" | "conflict";
    readonly bytes?: Buffer;
  }> {
    return this.#withPinnedRoot(async (operationRoot) => {
      const path = join(operationRoot, artifactFilename(row.artifact_id));
      let pathBefore: BigIntStats;
      try {
        pathBefore = await lstat(path, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { observation: "missing" as const };
        }
        throw error;
      }
      if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
        return { observation: "conflict" as const };
      }
      if (process.platform === "win32") {
        try {
          assertWindowsPrivatePath(path, "file", false);
        } catch {
          return { observation: "conflict" as const };
        }
      }
      let handle: FileHandle;
      try {
        handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { observation: "missing" as const };
        }
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
          return { observation: "conflict" as const };
        }
        throw error;
      }
      try {
        const before = await handle.stat({ bigint: true });
        if (
          !before.isFile() ||
          !sameSnapshot(pathBefore, before) ||
          before.nlink !== 1n ||
          before.size !== BigInt(row.byte_length) ||
          !privateFileMode(before)
        ) {
          return { observation: "conflict" as const };
        }
        const bytes = Buffer.allocUnsafe(row.byte_length);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const read = await handle.read(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset,
          );
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        const [after, currentPath] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(path, { bigint: true }).catch(() => undefined),
        ]);
        if (
          offset !== bytes.byteLength ||
          currentPath === undefined ||
          currentPath.isSymbolicLink() ||
          !sameSnapshot(before, after) ||
          !sameSnapshot(before, currentPath)
        ) {
          return { observation: "conflict" as const };
        }
        if (contentDigest(bytes) !== row.digest) {
          return { observation: "conflict" as const };
        }
        return { observation: "match" as const, bytes };
      } finally {
        await handle.close();
      }
    });
  }

  async #removeExpectedFile(
    row: WorkflowHandoffRow,
  ): Promise<"removed" | "missing" | "conflict"> {
    return this.#withPinnedRoot(async (operationRoot, rootHandle) => {
      const path = join(operationRoot, artifactFilename(row.artifact_id));
      let pathBefore: BigIntStats;
      try {
        pathBefore = await lstat(path, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
      }
      if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return "conflict";
      if (process.platform === "win32") {
        try {
          assertWindowsPrivatePath(path, "file", false);
        } catch {
          return "conflict";
        }
      }
      let handle: FileHandle;
      try {
        handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        if ((error as NodeJS.ErrnoException).code === "ELOOP") return "conflict";
        throw error;
      }
      try {
        const before = await handle.stat({ bigint: true });
        if (
          !before.isFile() ||
          !sameSnapshot(pathBefore, before) ||
          before.nlink !== 1n ||
          before.size !== BigInt(row.byte_length) ||
          !privateFileMode(before)
        ) {
          return "conflict";
        }
        const bytes = await handle.readFile();
        const currentPath = await lstat(path, { bigint: true }).catch(
          () => undefined,
        );
        if (
          currentPath === undefined ||
          currentPath.isSymbolicLink() ||
          !sameSnapshot(before, currentPath) ||
          bytes.byteLength !== row.byte_length ||
          contentDigest(bytes) !== row.digest
        ) {
          return "conflict";
        }
        await unlink(path);
        await rootHandle?.sync().catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") {
            throw error;
          }
        });
        return "removed";
      } finally {
        await handle.close();
      }
    });
  }

  async #withPinnedRoot<T>(
    operation: (
      operationRoot: string,
      rootHandle: FileHandle | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    const lexical = await lstat(this.#trustedRoot, { bigint: true });
    if (!safePrivateDirectory(lexical)) {
      throw storeError(
        "WORKFLOW_HANDOFF_UNSAFE_ROOT",
        `workflow handoff root is not a private real directory: ${this.#trustedRoot}`,
      );
    }
    const canonical = await realpath(this.#trustedRoot);
    if (process.platform === "win32") {
      assertWindowsPrivatePath(canonical, "directory", false);
      const result = await operation(canonical, undefined);
      const [afterPath, afterCanonical] = await Promise.all([
        lstat(this.#trustedRoot, { bigint: true }),
        realpath(this.#trustedRoot),
      ]);
      assertWindowsPrivatePath(afterCanonical, "directory", false);
      if (
        afterCanonical !== canonical ||
        !sameIdentity(lexical, afterPath) ||
        !safePrivateDirectory(afterPath)
      ) {
        throw storeError(
          "WORKFLOW_HANDOFF_UNSAFE_ROOT",
          "workflow handoff Windows root changed during I/O",
        );
      }
      return result;
    }
    const rootHandle = await open(this.#trustedRoot, directoryOpenFlags());
    try {
      const opened = await rootHandle.stat({ bigint: true });
      if (!safePrivateDirectory(opened) || !sameIdentity(lexical, opened)) {
        throw storeError(
          "WORKFLOW_HANDOFF_UNSAFE_ROOT",
          "workflow handoff root changed while opening",
        );
      }
      const operationRoot = await descriptorOperationRoot(rootHandle, canonical);
      if (operationRoot === undefined) {
        throw storeError(
          "WORKFLOW_HANDOFF_SAFE_IO_UNSUPPORTED",
          `descriptor-confined workflow handoff I/O is unsupported on ${process.platform}`,
        );
      }
      const result = await operation(operationRoot, rootHandle);
      const [afterPath, afterCanonical, afterHandle] = await Promise.all([
        lstat(this.#trustedRoot, { bigint: true }),
        realpath(this.#trustedRoot),
        rootHandle.stat({ bigint: true }),
      ]);
      if (
        afterCanonical !== canonical ||
        !sameIdentity(lexical, afterPath) ||
        !sameIdentity(lexical, afterHandle) ||
        !safePrivateDirectory(afterPath) ||
        !safePrivateDirectory(afterHandle)
      ) {
        throw storeError(
          "WORKFLOW_HANDOFF_UNSAFE_ROOT",
          "workflow handoff root changed during I/O",
        );
      }
      return result;
    } finally {
      await rootHandle.close();
    }
  }

  #markConflict(
    artifactId: string,
    expectedStatus: "intent" | "deleting",
  ): void {
    this.#driver
      .prepareState<[string, string]>(
        `UPDATE workflow_handoff_artifacts
         SET status = 'conflict'
         WHERE artifact_id = ? AND status = ?`,
      )
      .run(artifactId, expectedStatus);
  }

  #cursor(name: "intent_recovery" | "retention_cleanup"): CursorRow | undefined {
    return this.#driver
      .prepareState<[string], CursorRow>(
        `SELECT sort_ms, artifact_id
         FROM workflow_handoff_cursors WHERE cursor_name = ?`,
      )
      .get(name);
  }

  #setCursor(
    name: "intent_recovery" | "retention_cleanup",
    sortMs: number,
    artifactId: string,
    now: number,
  ): void {
    this.#driver
      .prepareState<[string, number, string, number]>(
        `INSERT INTO workflow_handoff_cursors (
           cursor_name, sort_ms, artifact_id, updated_at_ms
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(cursor_name) DO UPDATE SET
           sort_ms = excluded.sort_ms,
           artifact_id = excluded.artifact_id,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(name, sortMs, artifactId, now);
  }

  #clearCursor(name: "intent_recovery" | "retention_cleanup"): void {
    this.#driver
      .prepareState<[string]>(
        `DELETE FROM workflow_handoff_cursors WHERE cursor_name = ?`,
      )
      .run(name);
  }
}

function initializeTrustedRoot(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw storeError(
      "WORKFLOW_HANDOFF_UNSAFE_ROOT",
      "workflow handoff root must be a non-empty path",
    );
  }
  const root = resolve(input);
  mkdirSync(root, { recursive: true, mode: ARTIFACT_ROOT_MODE });
  const lexical = lstatSync(root, { bigint: true });
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    throw storeError(
      "WORKFLOW_HANDOFF_UNSAFE_ROOT",
      `workflow handoff root must be a real directory: ${root}`,
    );
  }
  if (process.platform !== "win32") {
    chmodSync(root, ARTIFACT_ROOT_MODE);
  } else {
    assertWindowsPrivatePath(root, "directory", true);
  }
  const canonical = realpathSync(root);
  const final = statSync(canonical, { bigint: true });
  if (!safePrivateDirectory(final) || !sameIdentity(lexical, final)) {
    throw storeError(
      "WORKFLOW_HANDOFF_UNSAFE_ROOT",
      `workflow handoff root is not private or changed during setup: ${root}`,
    );
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    final.uid !== BigInt(process.getuid())
  ) {
    throw storeError(
      "WORKFLOW_HANDOFF_UNSAFE_ROOT",
      `workflow handoff root is not owned by the current user: ${root}`,
    );
  }
  if (process.platform === "win32") {
    assertWindowsPrivatePath(canonical, "directory", false);
  }
  return canonical;
}

function validateOwner(owner: WorkflowHandoffOwner): WorkflowHandoffOwner {
  if (owner === null || typeof owner !== "object") {
    throw storeError(
      "WORKFLOW_HANDOFF_INVALID",
      "workflow handoff owner must be an object",
    );
  }
  return Object.freeze({
    run_id: validateBoundedString(
      owner.run_id,
      "workflow handoff run ID",
      MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
    ),
    workflow_id: validateBoundedString(
      owner.workflow_id,
      "workflow handoff workflow ID",
      MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
    ),
    producer_step_id: validateBoundedString(
      owner.producer_step_id,
      "workflow handoff producer step ID",
      MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES,
    ),
  });
}

function validateBoundedString(
  value: string,
  label: string,
  maximumUtf8Bytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isWellFormedUnicode(value) ||
    Buffer.byteLength(value, "utf8") > maximumUtf8Bytes
  ) {
    throw storeError(
      "WORKFLOW_HANDOFF_INVALID",
      `${label} must contain 1-${maximumUtf8Bytes} well-formed UTF-8 bytes`,
    );
  }
  return value;
}

function artifactIdFor(
  owner: WorkflowHandoffOwner,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256").update(
    ARTIFACT_ID_DIGEST_DOMAIN,
    "utf8",
  );
  for (const component of [
    owner.run_id,
    owner.workflow_id,
    owner.producer_step_id,
    idempotencyKey,
  ]) {
    updateLengthPrefixedUtf8(digest, component);
  }
  return `wh_${digest.digest("hex").slice(0, 48)}`;
}

function updateLengthPrefixedUtf8(hash: Hash, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength, 0);
  hash.update(length).update(bytes);
}

function contentDigest(bytes: Uint8Array): string {
  return `${SHA256_PREFIX}${createHash("sha256")
    .update(ARTIFACT_CONTENT_DIGEST_DOMAIN, "utf8")
    .update(bytes)
    .digest("hex")}`;
}

function storageReference(artifactId: string): string {
  return `workflow-handoff:${artifactId}`;
}

function parseArtifactIdentity(value: string): string {
  if (typeof value !== "string") {
    throw storeError(
      "WORKFLOW_HANDOFF_INVALID",
      "workflow handoff identity must be a string",
    );
  }
  const artifactId = value.startsWith("workflow-handoff:")
    ? value.slice("workflow-handoff:".length)
    : value;
  if (!/^wh_[0-9a-f]{48}$/u.test(artifactId)) {
    throw storeError(
      "WORKFLOW_HANDOFF_INVALID",
      "workflow handoff identity is invalid",
    );
  }
  return artifactId;
}

function artifactFilename(artifactId: string): string {
  const parsed = parseArtifactIdentity(artifactId);
  const name = `${parsed}${ARTIFACT_FILE_SUFFIX}`;
  if (basename(name) !== name) {
    throw storeError(
      "WORKFLOW_HANDOFF_INVALID",
      "workflow handoff filename is invalid",
    );
  }
  return name;
}

function metadataFromRow(row: WorkflowHandoffRow): WorkflowHandoffArtifact {
  if (
    row.status !== "committed" ||
    row.committed_at_ms === null ||
    row.commit_sequence === null
  ) {
    throw storeError(
      "WORKFLOW_HANDOFF_NOT_COMMITTED",
      `workflow handoff ${row.artifact_id} has no committed metadata`,
    );
  }
  return validateWorkflowHandoffArtifactValue({
    format_version: row.format_version,
    kind: row.kind,
    compatibility_epoch: row.compatibility_epoch,
    artifact_id: row.artifact_id,
    owner: rowOwner(row),
    digest: row.digest,
    byte_length: row.byte_length,
    token_count: row.token_count,
    media_type: WORKFLOW_HANDOFF_MEDIA_TYPE,
    encoding: WORKFLOW_HANDOFF_ENCODING,
    storage_ref: row.storage_ref,
    created_at_ms: row.created_at_ms,
    committed_at_ms: row.committed_at_ms,
    commit_sequence: row.commit_sequence,
    preview: row.preview,
    preview_truncated: row.preview_truncated === 1,
  });
}

function operatorEntry(
  row: WorkflowHandoffRow,
  referenceCount: number,
): WorkflowHandoffOperatorEntry {
  if (!Number.isSafeInteger(referenceCount) || referenceCount < 0) {
    throw storeError(
      "WORKFLOW_HANDOFF_CORRUPT",
      `workflow handoff ${row.artifact_id} has an invalid reference count`,
    );
  }
  return Object.freeze({
    artifact_id: row.artifact_id,
    format_version: row.format_version,
    kind: row.kind,
    compatibility_epoch: row.compatibility_epoch,
    owner: rowOwner(row),
    digest: row.digest,
    byte_length: row.byte_length,
    token_count: row.token_count,
    storage_ref: row.storage_ref,
    status: row.status,
    created_at_ms: row.created_at_ms,
    committed_at_ms: row.committed_at_ms,
    commit_sequence: row.commit_sequence,
    last_access_at_ms: row.last_access_at_ms,
    unreferenced_at_ms: row.unreferenced_at_ms,
    reference_count: referenceCount,
  });
}

function rowOwner(row: WorkflowHandoffRow): WorkflowHandoffOwner {
  return Object.freeze({
    run_id: row.run_id,
    workflow_id: row.workflow_id,
    producer_step_id: row.producer_step_id,
  });
}

function sameOwner(
  left: WorkflowHandoffOwner,
  right: WorkflowHandoffOwner,
): boolean {
  return (
    left.run_id === right.run_id &&
    left.workflow_id === right.workflow_id &&
    left.producer_step_id === right.producer_step_id
  );
}

function assertSameIntent(
  existing: WorkflowHandoffRow,
  desired: {
    readonly artifactId: string;
    readonly owner: WorkflowHandoffOwner;
    readonly digest: string;
    readonly byteLength: number;
    readonly tokenCount: number;
    readonly storageRef: string;
    readonly preview: string;
    readonly previewTruncated: boolean;
  },
): void {
  if (
    existing.artifact_id !== desired.artifactId ||
    !sameOwner(rowOwner(existing), desired.owner) ||
    existing.digest !== desired.digest ||
    existing.byte_length !== desired.byteLength ||
    existing.token_count !== desired.tokenCount ||
    existing.storage_ref !== desired.storageRef ||
    existing.preview !== desired.preview ||
    existing.preview_truncated !== (desired.previewTruncated ? 1 : 0)
  ) {
    throw storeError(
      "WORKFLOW_HANDOFF_CONFLICT",
      `workflow handoff idempotency key conflicts with ${existing.artifact_id}`,
    );
  }
}

function assertQuotaAvailable(
  used: QuotaRow,
  requestedBytes: number,
  maximumCount: number,
  maximumBytes: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(used.artifact_count) ||
    used.artifact_count < 0 ||
    !Number.isSafeInteger(used.artifact_bytes) ||
    used.artifact_bytes < 0
  ) {
    throw storeError(
      "WORKFLOW_HANDOFF_CORRUPT",
      `${label} workflow handoff quota ledger is invalid`,
    );
  }
  if (
    used.artifact_count >= maximumCount ||
    used.artifact_bytes > maximumBytes - requestedBytes
  ) {
    throw storeError(
      "WORKFLOW_HANDOFF_QUOTA",
      `${label} workflow handoff byte/count quota is exhausted`,
    );
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw storeError(
      "WORKFLOW_HANDOFF_INVALID",
      `${label} must be valid UTF-8`,
      cause,
    );
  }
}

function boundedUtf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let codeUnits = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    codeUnits += character.length;
  }
  return value.slice(0, codeUnits);
}

function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw storeError(
      "WORKFLOW_HANDOFF_INVALID",
      "workflow handoff clock must return a non-negative safe integer",
    );
  }
  return value;
}

function cleanupBatchSize(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH
  ) {
    throw storeError(
      "WORKFLOW_HANDOFF_INVALID",
      `workflow handoff cleanup batch must be between 1 and ${MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH}`,
    );
  }
  return value;
}

function positiveSafeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return selected;
}

function nonNegativeSafeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return selected;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function safePrivateDirectory(stats: BigIntStats): boolean {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    (process.platform === "win32" || (stats.mode & 0o077n) === 0n)
  );
}

function privateFileMode(stats: BigIntStats): boolean {
  return process.platform === "win32" || (stats.mode & 0o077n) === 0n;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function noFollowFlag(): number {
  return (
    (fsConstants as typeof fsConstants & { readonly O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0
  );
}

function directoryOpenFlags(): number {
  const directory =
    (fsConstants as typeof fsConstants & { readonly O_DIRECTORY?: number })
      .O_DIRECTORY ?? 0;
  return fsConstants.O_RDONLY | directory | noFollowFlag();
}

async function descriptorOperationRoot(
  handle: FileHandle,
  canonicalRoot: string,
): Promise<string | undefined> {
  const candidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${handle.fd}`];
  for (const candidate of candidates) {
    try {
      if ((await realpath(candidate)) === canonicalRoot) return candidate;
    } catch {
      // An unavailable descriptor alias is not permission for lexical fallback.
    }
  }
  return undefined;
}

async function commitWindowsArtifactAtomically(
  targetPath: string,
  trustedRoot: string,
  bytes: Uint8Array,
): Promise<void> {
  const rootBefore = lstatSync(trustedRoot, { bigint: true });
  const canonicalRoot = realpathSync(trustedRoot);
  if (!safePrivateDirectory(rootBefore)) {
    throw storeError(
      "WORKFLOW_HANDOFF_UNSAFE_ROOT",
      "workflow handoff Windows root is not a real directory",
    );
  }
  assertWindowsPrivatePath(canonicalRoot, "directory", false);
  if (
    resolve(join(canonicalRoot, basename(targetPath))) !== resolve(targetPath) ||
    resolve(targetPath) === canonicalRoot
  ) {
    throw storeError(
      "WORKFLOW_HANDOFF_UNSAFE_ROOT",
      "workflow handoff Windows target is outside its trusted root",
    );
  }

  const expected = Buffer.from(bytes);
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  try {
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollowFlag(),
      ARTIFACT_FILE_MODE,
    );
    temporaryExists = true;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw storeError(
          "WORKFLOW_HANDOFF_UNSAFE_ROOT",
          "workflow handoff Windows temporary file is unsafe",
        );
      }
      await handle.writeFile(expected);
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (!sameIdentity(before, after) || after.size !== BigInt(expected.byteLength)) {
        throw storeError(
          "WORKFLOW_HANDOFF_UNSAFE_ROOT",
          "workflow handoff Windows temporary file changed while writing",
        );
      }
    } finally {
      await handle.close();
    }
    assertWindowsPrivatePath(temporaryPath, "file", true);

    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readWindowsArtifactCandidate(targetPath);
      if (existing === undefined || !existing.equals(expected)) {
        throw storeError(
          "WORKFLOW_HANDOFF_CONFLICT",
          "workflow handoff Windows target already contains different bytes",
          error,
        );
      }
    }
    await unlink(temporaryPath);
    temporaryExists = false;
    assertWindowsPrivatePath(targetPath, "file", false);

    const rootAfter = lstatSync(trustedRoot, { bigint: true });
    const canonicalAfter = realpathSync(trustedRoot);
    assertWindowsPrivatePath(canonicalAfter, "directory", false);
    if (
      canonicalAfter !== canonicalRoot ||
      !sameIdentity(rootBefore, rootAfter) ||
      !safePrivateDirectory(rootAfter)
    ) {
      throw storeError(
        "WORKFLOW_HANDOFF_UNSAFE_ROOT",
        "workflow handoff Windows root changed during publication",
      );
    }
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => {});
  }
}

async function readWindowsArtifactCandidate(
  path: string,
): Promise<Buffer | undefined> {
  let pathBefore: BigIntStats;
  try {
    pathBefore = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return undefined;
  assertWindowsPrivatePath(path, "file", false);
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameSnapshot(pathBefore, opened)) return undefined;
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    return sameSnapshot(opened, after) && sameSnapshot(opened, pathAfter)
      ? bytes
      : undefined;
  } finally {
    await handle.close();
  }
}

function assertWindowsPrivatePath(
  path: string,
  role: "directory" | "file",
  initialize: boolean,
): void {
  if (process.platform !== "win32") return;
  const workingDirectory = win32.join(WINDOWS_SYSTEM_ROOT, "System32");
  const executable = win32.join(
    workingDirectory,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let output: Buffer;
  try {
    output = execFileSync(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        WINDOWS_HANDOFF_SECURITY_SCRIPT_BASE64,
      ],
      {
        cwd: workingDirectory,
        encoding: "buffer",
        env: {
          AGENC_HANDOFF_SECURITY_INITIALIZE: initialize ? "1" : "0",
          AGENC_HANDOFF_SECURITY_PATH: path,
          AGENC_HANDOFF_SECURITY_ROLE: role,
          APPDATA: "",
          COMSPEC: "",
          HOMEDRIVE: "",
          HOMEPATH: "",
          LOCALAPPDATA: "",
          LOGONSERVER: "",
          PATH: workingDirectory,
          PATHEXT: ".EXE",
          PSMODULEPATH: "",
          SYSTEMROOT: WINDOWS_SYSTEM_ROOT,
          TEMP: workingDirectory,
          TMP: workingDirectory,
          USERDOMAIN: "",
          USERNAME: "",
          USERPROFILE: workingDirectory,
          WINDIR: WINDOWS_SYSTEM_ROOT,
        },
        maxBuffer: WINDOWS_SECURITY_MAX_OUTPUT_BYTES,
        timeout: WINDOWS_SECURITY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (cause) {
    throw storeError(
      "WORKFLOW_HANDOFF_UNSAFE_ROOT",
      `workflow handoff Windows ACL validation failed for ${path}`,
      cause,
    );
  }
  if (output.toString("utf8") !== "OK") {
    throw storeError(
      "WORKFLOW_HANDOFF_UNSAFE_ROOT",
      `workflow handoff Windows ACL validation returned an invalid response for ${path}`,
    );
  }
}

function storeError(
  code: ConstructorParameters<typeof WorkflowHandoffStoreError>[0],
  message: string,
  cause?: unknown,
): WorkflowHandoffStoreError {
  return new WorkflowHandoffStoreError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

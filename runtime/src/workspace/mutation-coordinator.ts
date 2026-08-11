import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { resolveAgencHome } from "../config/env.js";

const DEFAULT_LEASE_TTL_MS = 10_000;
const MAX_SYNCED_BUFFERS = 512;
// Keep this aligned with the Editor buffer provider's 5 MiB file ceiling.
// Unloaded files may still use the larger tool-specific write limits.
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const MAX_SYNC_BYTES = 16 * 1024 * 1024;
const MAX_CHANGE_EVENTS = 64;
// Every unresolved commitment must retain one discoverable proposed event.
// Keep the admission ceiling within both the durable delivery queue and the
// TUI's bounded review store.
const MAX_PENDING_PROPOSALS = 32;
const MAX_PROPOSAL_RECEIPTS = 512;
const MAX_QUARANTINE_BYTES = 512 * 1024;
const MAX_PERSISTED_QUARANTINE_DIRECTORIES = 4_096;
const MAX_QUARANTINE_ROOT_PREFIX_BYTES = 64 * 1024;
const MAX_PERSISTED_WORKSPACE_ROOT_BYTES = 4_096;
const MAX_PERSISTED_WORKSPACE_ROOT_SEGMENTS = 1_024;
// The persistent daemon client rejects an unterminated JSON frame once its
// receive buffer exceeds 16 MiB. Count the trailing newline as part of that
// budget because the client observes it before splitting the complete frame.
export const WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type WorkspacePathAuthority =
  "disk_authoritative" | "editor_dirty" | "stale_dirty";

export interface EditorBufferSync {
  readonly path: string;
  readonly bufferHandle: number;
  readonly changedtick: number;
  readonly contentSha256: string;
  /** Exact UTF-8 byte length, including for clean buffers. */
  readonly contentBytes?: number;
  readonly dirty: boolean;
  /**
   * Required for dirty buffers. Clean buffers intentionally omit source
   * contents: disk remains authoritative and no duplicate source snapshot is
   * retained by the daemon.
   */
  readonly content?: string;
}

export interface WorkspaceEditorAcquireInput {
  readonly workspaceRoot: string;
  readonly editorInstanceId: string;
  readonly takeover?: boolean;
  /**
   * Atomically refuse acquisition when any active, stale, quarantined, or
   * unreadable Editor authority overlaps the workspace. Uncoordinated shell
   * surfaces use this before borrowing the lease as a lifetime fence; real
   * Editors omit it so they can reconnect and recover quarantined revisions.
   */
  readonly requireUnprotectedWorkspace?: boolean;
}

export interface WorkspaceEditorLease {
  readonly workspaceRoot: string;
  readonly editorInstanceId: string;
  readonly leaseToken: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly expiresAt: number;
}

export interface WorkspaceEditorSyncInput {
  readonly workspaceRoot: string;
  readonly editorInstanceId: string;
  readonly leaseToken: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly buffers: readonly EditorBufferSync[];
}

export interface WorkspaceEditorHeartbeatInput {
  readonly workspaceRoot: string;
  readonly editorInstanceId: string;
  readonly leaseToken: string;
  readonly epoch: number;
}

export interface WorkspaceEditorReleaseInput extends WorkspaceEditorHeartbeatInput {
  readonly abandonDirty?: boolean;
}

export interface WorkspaceEditorProposalInput extends WorkspaceEditorHeartbeatInput {
  readonly proposalId: string;
}

export interface WorkspaceEditorProposalApplyInput extends WorkspaceEditorProposalInput {
  readonly changedtick: number;
  readonly contentSha256: string;
  readonly content: string;
}

export interface WorkspaceChangeEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly source: WorkspaceMutationSource;
  readonly status:
    "applied" | "proposed" | "blocked" | "discarded" | "unknown_outcome";
  readonly beforeSha256: string;
  readonly afterSha256?: string;
  readonly proposalId?: string;
}

export interface WorkspaceEditorSyncResult {
  readonly accepted: true;
  readonly sequence: number;
  readonly expiresAt: number;
  readonly dirtyPaths: readonly string[];
  readonly stalePaths: readonly string[];
}

export interface WorkspaceAuthoritativeRead {
  readonly authority: "editor_dirty";
  readonly path: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly changedtick: number;
  readonly bufferHandle: number;
  readonly epoch: number;
}

/**
 * One immutable aggregate-read snapshot of an Editor-owned dirty buffer.
 *
 * `version` is coordinator-local and changes whenever the authoritative
 * revision is republished, even if a later revision happens to carry the same
 * bytes. Aggregate readers use it to reject ABA-style changes while a search
 * is running.
 */
export interface WorkspaceAuthoritativeDirtySnapshot extends WorkspaceAuthoritativeRead {
  readonly version: number;
}

export interface WorkspaceMutationProposal {
  readonly proposalId: string;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly beforeText: string;
  readonly afterText: string;
  readonly baseContentSha256: string;
  readonly baseChangedtick: number;
  readonly bufferHandle: number;
  readonly source: WorkspaceMutationSource;
}

export type WorkspaceEditorProposalStatus =
  | {
      readonly status: "reviewable";
      readonly proposal: WorkspaceMutationProposal;
    }
  | {
      readonly status: "committed";
      readonly proposalId: string;
      readonly path: string;
      readonly source: WorkspaceMutationSource;
      readonly baseContentSha256: string;
      readonly afterContentSha256: string;
      readonly baseChangedtick: number;
      readonly bufferHandle: number;
      readonly acceptedChangedtick?: number;
    }
  | {
      readonly status: "applied";
      readonly proposalId: string;
      readonly path: string;
      readonly changedtick: number;
      readonly contentSha256: string;
    }
  | {
      readonly status: "discarded";
      readonly proposalId: string;
      readonly path: string;
    }
  | {
      readonly status: "missing";
      readonly proposalId: string;
    };

interface WorkspaceProposalCommitment {
  readonly proposalId: string;
  readonly path: string;
  readonly source: WorkspaceMutationSource;
  readonly baseContentSha256: string;
  readonly afterContentSha256: string;
  readonly baseChangedtick: number;
  readonly bufferHandle: number;
  /**
   * Exact reviewed replacement bytes recovered from a fresh Editor process
   * before its daemon acknowledgement. This process-local tick makes the
   * explicit acknowledgement retryable without pretending it is the base
   * revision.
   */
  readonly acceptedChangedtick?: number;
}

type WorkspaceProposalReceipt =
  | {
      readonly action: "applied";
      readonly changedtick: number;
      readonly contentSha256: string;
      readonly result: {
        readonly applied: true;
        readonly proposalId: string;
        readonly path: string;
        readonly changedtick: number;
        readonly contentSha256: string;
      };
    }
  | {
      readonly action: "discarded";
      readonly result: {
        readonly discarded: true;
        readonly proposalId: string;
        readonly path: string;
      };
    };

export type WorkspaceMutationSource =
  | "file_edit"
  | "file_multi_edit"
  | "file_write"
  | "apply_patch"
  | "notebook_edit"
  | "rewind"
  | "shell"
  | "editor"
  | "unknown";

export interface WorkspaceMutationToken {
  readonly tokenId: string;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly source: WorkspaceMutationSource;
  readonly beforeSha256: string;
  readonly intendedAfterSha256: string;
  readonly authorityVersion: number;
  readonly createdAt: number;
  /** Internal batch fence that admitted this token, when present. */
  readonly topologyTokenId?: string;
}

export interface WorkspaceTopologyMutationTarget {
  readonly path: string;
  readonly includeDescendants?: boolean;
  /**
   * Only authenticated Editor topology RPCs may set this. It permits the
   * owning lease to reserve a clean loaded path while dirty/stale revisions
   * remain fail-closed.
   */
  readonly allowOwnedClean?: boolean;
}

export interface WorkspaceTopologyMutationToken {
  readonly tokenId: string;
  readonly workspaceRoot: string;
  readonly targets: readonly {
    readonly path: string;
    readonly includeDescendants: boolean;
  }[];
  readonly source: WorkspaceMutationSource;
  readonly createdAt: number;
}

export interface WorkspaceTopologyMutationReservation {
  readonly tokens: readonly WorkspaceTopologyMutationToken[];
}

export interface WorkspaceEditorTopologyMutationInput extends WorkspaceEditorHeartbeatInput {
  readonly targets: readonly WorkspaceTopologyMutationTarget[];
  readonly source?: WorkspaceMutationSource;
}

export interface WorkspaceEditorTopologyMutationFinalizeInput extends WorkspaceEditorHeartbeatInput {
  readonly tokenId: string;
  readonly sequence: number;
  readonly buffers: readonly EditorBufferSync[];
}

export interface WorkspaceRecoveredEditorTopologyMutation {
  readonly tokenId: string;
  readonly workspaceRoot: string;
  readonly targets: WorkspaceTopologyMutationToken["targets"];
  readonly source: WorkspaceMutationSource;
  readonly createdAt: number;
}

export interface WorkspaceRecoveredEditorTopologyMutationResolveInput extends WorkspaceEditorHeartbeatInput {
  readonly tokenId: string;
}

export type WorkspaceMutationAdmission =
  | {
      readonly decision: "allow";
      readonly token: WorkspaceMutationToken;
    }
  | {
      readonly decision: "proposal";
      readonly proposal: WorkspaceMutationProposal;
    }
  | {
      readonly decision: "blocked";
      readonly code: "STALE_EDITOR_BUFFER" | "EDITOR_PROPOSAL_LIMIT";
      readonly message: string;
    };

export interface WorkspaceChangeLedgerEntry {
  readonly version: 1;
  readonly entryId: string;
  readonly timestamp: string;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly source: WorkspaceMutationSource;
  readonly status:
    "applied" | "proposed" | "blocked" | "discarded" | "unknown_outcome";
  readonly beforeSha256: string;
  readonly afterSha256?: string;
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly proposalId?: string;
}

export type WorkspaceChangeLedgerAppendInput = Omit<
  WorkspaceChangeLedgerEntry,
  "version" | "entryId" | "timestamp" | "workspaceRoot"
>;

interface EditorBufferState {
  readonly path: string;
  readonly bufferHandle: number;
  readonly changedtick: number;
  readonly contentSha256: string;
  readonly contentBytes: number;
  readonly authority: WorkspacePathAuthority;
  readonly content?: string;
  readonly epoch: number;
  readonly editorInstanceId: string;
  readonly quarantinedFrom?: "disk_authoritative" | "editor_dirty";
  /**
   * A dead/released owner may be replaced by a new TUI instance only when that
   * instance proves an exact persisted revision. Active-owner takeover and
   * same-lease omission remain bound to the originating instance.
   */
  readonly crossInstanceRecoveryAllowed?: boolean;
  readonly version: number;
}

interface ActiveLease {
  readonly editorInstanceId: string;
  readonly leaseToken: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly expiresAt: number;
}

interface WorkspaceMutationIntent {
  readonly tokenId: string;
  readonly path: string;
  readonly source: WorkspaceMutationSource;
  readonly beforeSha256: string;
  readonly intendedAfterSha256: string;
}

interface WorkspaceTopologyMutationIntent {
  readonly tokenId: string;
  readonly source: WorkspaceMutationSource;
  readonly targets: WorkspaceTopologyMutationToken["targets"];
  readonly contentions: readonly {
    readonly path: string;
    readonly beforeSha256: string;
  }[];
}

interface WorkspaceQuarantineSnapshot {
  readonly entries: readonly {
    readonly path: string;
    readonly contentSha256: string;
    readonly contentBytes: number;
    readonly changedtick: number;
    readonly epoch: number;
    readonly editorInstanceId: string;
    readonly authority: "disk_authoritative" | "editor_dirty";
  }[];
  readonly proposalCommitments: readonly WorkspaceProposalCommitment[];
  readonly proposalReceipts: readonly (
    | {
        readonly proposalId: string;
        readonly action: "applied";
        readonly path: string;
        readonly changedtick: number;
        readonly contentSha256: string;
      }
    | {
        readonly proposalId: string;
        readonly action: "discarded";
        readonly path: string;
      }
  )[];
  readonly mutationIntents: readonly WorkspaceMutationIntent[];
  readonly topologyIntents: readonly WorkspaceTopologyMutationIntent[];
  readonly changeSequence: number;
  readonly changes: readonly WorkspaceChangeEvent[];
}

export class WorkspaceMutationCoordinatorError extends Error {
  readonly code:
    | "INVALID_WORKSPACE"
    | "INVALID_EDITOR_SYNC"
    | "EDITOR_LEASE_CONFLICT"
    | "EDITOR_LEASE_EXPIRED"
    | "EDITOR_LEASE_MISMATCH"
    | "MUTATION_AUDIT_FAILED";

  constructor(
    code: WorkspaceMutationCoordinatorError["code"],
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceMutationCoordinatorError";
    this.code = code;
  }
}

export function workspaceEditorProposalResponseFrameBytes(
  proposal: WorkspaceMutationProposal,
  requestId: string | number = Number.MAX_SAFE_INTEGER,
): number {
  const response = {
    jsonrpc: "2.0",
    id: requestId,
    result: proposal,
  };
  return Buffer.byteLength(`${JSON.stringify(response)}\n`, "utf8");
}

export function assertWorkspaceEditorProposalResponseFitsFrame(
  proposal: WorkspaceMutationProposal,
  requestId: string | number = Number.MAX_SAFE_INTEGER,
): void {
  const frameBytes = workspaceEditorProposalResponseFrameBytes(
    proposal,
    requestId,
  );
  if (frameBytes > WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES) {
    throw new WorkspaceMutationCoordinatorError(
      "INVALID_EDITOR_SYNC",
      `Editor proposal inspection requires ${frameBytes} serialized bytes, exceeding the ${WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES}-byte daemon peer frame limit: ${proposal.path}`,
    );
  }
}

export function assertWorkspaceEditorProposalStatusResponseFitsFrame(
  status: WorkspaceEditorProposalStatus,
  requestId: string | number = Number.MAX_SAFE_INTEGER,
): void {
  const frameBytes = Buffer.byteLength(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: status,
    })}\n`,
    "utf8",
  );
  if (frameBytes > WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES) {
    const proposalId =
      status.status === "reviewable"
        ? status.proposal.proposalId
        : status.proposalId;
    throw new WorkspaceMutationCoordinatorError(
      "INVALID_EDITOR_SYNC",
      `Editor proposal status requires ${frameBytes} serialized bytes, exceeding the ${WORKSPACE_EDITOR_PROPOSAL_MAX_FRAME_BYTES}-byte daemon peer frame limit: ${proposalId}`,
    );
  }
}

export class WorkspaceMutationRejectedError extends Error {
  readonly toolResult: {
    readonly content: string;
    readonly isError: true;
    readonly metadata: Record<string, unknown>;
  };

  constructor(toolResult: WorkspaceMutationRejectedError["toolResult"]) {
    super(toolResult.content);
    this.name = "WorkspaceMutationRejectedError";
    this.toolResult = toolResult;
  }
}

export interface WorkspaceMutationCoordinatorOptions {
  readonly workspaceRoot: string;
  readonly agencHome?: string;
  readonly now?: () => number;
  readonly leaseTtlMs?: number;
  /** Deterministic capacity seam for proposal-admission race tests. */
  readonly maxPendingProposals?: number;
  /** Optional durability seam used by fault/race harnesses. */
  readonly appendLedger?: (
    input: WorkspaceChangeLedgerAppendInput,
  ) => Promise<void>;
}

export interface WorkspaceToolOperationToken {
  readonly tokenId: string;
  readonly workspacePath: string;
  readonly workspaceRoot: string;
  readonly toolName: string;
}

export interface WorkspaceReadToolOperation {
  readonly token: WorkspaceToolOperationToken;
  readonly requiresStrictCandidateReads: boolean;
}

export type WorkspaceMutationObservedState =
  | { readonly kind: "content"; readonly content: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

/**
 * One daemon-owned coherence boundary for a workspace. Source contents live in
 * memory only; durable state stores hashes and provenance, never editor text.
 */
export class WorkspaceMutationCoordinator {
  readonly workspaceRoot: string;
  readonly #now: () => number;
  readonly #leaseTtlMs: number;
  readonly #maxPendingProposals: number;
  readonly #ledger: WorkspaceChangeLedger;
  readonly #appendLedger: (
    input: WorkspaceChangeLedgerAppendInput,
  ) => Promise<void>;
  readonly #buffers = new Map<string, EditorBufferState>();
  readonly #tokens = new Map<
    string,
    { readonly token: WorkspaceMutationToken; readonly executing: boolean }
  >();
  readonly #topologyTokens = new Map<string, WorkspaceTopologyMutationToken>();
  readonly #recoveredTopologyTokens = new Set<string>();
  readonly #editorTopologyOwners = new Map<
    string,
    { readonly editorInstanceId: string; readonly epoch: number }
  >();
  readonly #mutationIntents = new Map<string, WorkspaceMutationIntent>();
  readonly #topologyIntents = new Map<
    string,
    WorkspaceTopologyMutationIntent
  >();
  readonly #proposals = new Map<string, WorkspaceMutationProposal>();
  readonly #proposalCommitments = new Map<
    string,
    WorkspaceProposalCommitment
  >();
  readonly #proposalReceipts = new Map<string, WorkspaceProposalReceipt>();
  readonly #proposalResolutionOperations = new Map<string, Promise<unknown>>();
  readonly #changes: WorkspaceChangeEvent[] = [];
  #lease: ActiveLease | null = null;
  #nextEpoch = 1;
  #authorityVersion = 0;
  #changeSequence = 0;
  #quarantineHydrationFailed = false;
  #pendingQuarantinePersistence: Promise<void> = Promise.resolve();
  #mutationAdmissionTail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceMutationCoordinatorOptions) {
    if (!isAbsolute(options.workspaceRoot)) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_WORKSPACE",
        "workspaceRoot must be absolute",
      );
    }
    this.workspaceRoot = canonicalizePathSync(options.workspaceRoot);
    this.#now = options.now ?? Date.now;
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const maxPendingProposals =
      options.maxPendingProposals ?? MAX_PENDING_PROPOSALS;
    if (
      !Number.isSafeInteger(maxPendingProposals) ||
      maxPendingProposals < 1 ||
      maxPendingProposals > MAX_PENDING_PROPOSALS
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_WORKSPACE",
        `maxPendingProposals must be between 1 and ${MAX_PENDING_PROPOSALS}`,
      );
    }
    this.#maxPendingProposals = maxPendingProposals;
    const agencHome = options.agencHome ?? resolveAgencHome(process.env);
    this.#ledger = new WorkspaceChangeLedger({
      workspaceRoot: this.workspaceRoot,
      agencHome,
    });
    this.#appendLedger =
      options.appendLedger ?? ((input) => this.#ledger.append(input));
    try {
      const quarantine = this.#ledger.readQuarantine();
      if (quarantine !== null && this.#hydrateQuarantine(quarantine)) {
        this.#scheduleQuarantinePersistence();
      }
    } catch {
      // The durable record exists specifically to prevent a daemon restart
      // from forgetting unresolved unsaved editor state. If it cannot be
      // trusted, block workspace reads/writes until an editor explicitly
      // abandons the quarantine rather than silently falling back to disk.
      this.#quarantineHydrationFailed = true;
    }
  }

  acquire(input: WorkspaceEditorAcquireInput): WorkspaceEditorLease {
    this.#expireLeaseIfNeeded();
    const editorInstanceId = requiredIdentifier(
      input.editorInstanceId,
      "editorInstanceId",
    );
    if (
      this.#lease !== null &&
      this.#lease.editorInstanceId !== editorInstanceId &&
      input.takeover !== true
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_CONFLICT",
        `workspace already has an authoritative editor: ${this.#lease.editorInstanceId}`,
      );
    }
    if (
      this.#lease !== null &&
      this.#lease.editorInstanceId === editorInstanceId
    ) {
      this.#lease = {
        ...this.#lease,
        expiresAt: this.#now() + this.#leaseTtlMs,
      };
      return this.#leaseResult(this.#lease);
    }

    if (this.#lease !== null) this.#quarantineLoadedBuffers(false);
    const lease: ActiveLease = {
      editorInstanceId,
      leaseToken: randomUUID(),
      epoch: this.#nextEpoch++,
      sequence: -1,
      expiresAt: this.#now() + this.#leaseTtlMs,
    };
    this.#lease = lease;
    return this.#leaseResult(lease);
  }

  sync(
    input: WorkspaceEditorSyncInput,
    options: { readonly allowTopologyTokenId?: string } = {},
  ): WorkspaceEditorSyncResult {
    const lease = this.#assertLease(input);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "sequence must be a non-negative safe integer",
      );
    }
    if (input.sequence <= lease.sequence) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        `editor sync sequence ${input.sequence} is not newer than ${lease.sequence}`,
      );
    }
    if (input.buffers.length > MAX_SYNCED_BUFFERS) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        `editor sync exceeds ${MAX_SYNCED_BUFFERS} buffers`,
      );
    }

    let totalBytes = 0;
    const next = new Map<string, EditorBufferState>();
    const nextProposalCommitments = new Map(this.#proposalCommitments);
    const recoveryChanges: Omit<
      WorkspaceChangeEvent,
      "sequence" | "timestamp" | "workspaceRoot"
    >[] = [];
    for (const buffer of input.buffers) {
      const path = this.resolvePath(buffer.path);
      if (
        [...this.#tokens.values()].some(
          (entry) => entry.executing && entry.token.path === path,
        )
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot synchronize ${path} while an admitted workspace write is committing`,
        );
      }
      validateBufferRevision(buffer);
      if (next.has(path)) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          `editor sync contains duplicate path: ${path}`,
        );
      }
      if (buffer.dirty && typeof buffer.content !== "string") {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          `dirty buffer is missing content: ${path}`,
        );
      }
      if (!buffer.dirty && buffer.content !== undefined) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          `clean buffer must not include content: ${path}`,
        );
      }
      const bytes =
        typeof buffer.content === "string"
          ? Buffer.byteLength(buffer.content, "utf8")
          : 0;
      const contentBytes = buffer.contentBytes ?? bytes;
      if (
        !isNonNegativeSafeInteger(contentBytes) ||
        contentBytes > MAX_BUFFER_BYTES ||
        (buffer.dirty && contentBytes !== bytes)
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          `buffer has an invalid or oversized UTF-8 byte length: ${path}`,
        );
      }
      totalBytes += bytes;
      if (totalBytes > MAX_SYNC_BYTES) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          `editor sync exceeds ${MAX_SYNC_BYTES} content bytes`,
        );
      }
      if (
        typeof buffer.content === "string" &&
        sha256(buffer.content) !== buffer.contentSha256
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          `contentSha256 does not match dirty buffer content: ${path}`,
        );
      }
      const topologyConflict = this.#topologyConflictForPath(path);
      if (
        topologyConflict !== null &&
        topologyConflict.tokenId !== options.allowTopologyTokenId
      ) {
        this.#recordTopologyContention(
          topologyConflict,
          path,
          buffer.contentSha256,
        );
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot synchronize ${path} while a workspace path operation is committing`,
        );
      }
      const quarantined = this.#buffers.get(path);
      if (quarantined?.authority === "stale_dirty") {
        const sameEditor =
          quarantined.editorInstanceId === lease.editorInstanceId;
        const crossInstanceRecoveryAllowed =
          quarantined.crossInstanceRecoveryAllowed === true;
        const quarantinedWasDirty =
          quarantined.quarantinedFrom !== "disk_authoritative";
        const recoveredBaseContent =
          buffer.dirty &&
          typeof buffer.content === "string" &&
          buffer.contentSha256 === quarantined.contentSha256;
        const recoveredBaseRevision =
          recoveredBaseContent &&
          (sameEditor
            ? buffer.changedtick >= quarantined.changedtick
            : crossInstanceRecoveryAllowed);
        const recoveredNewerOwnedRevision =
          sameEditor &&
          buffer.dirty &&
          typeof buffer.content === "string" &&
          buffer.changedtick > quarantined.changedtick;
        const reconnectDiskSha256 = !buffer.dirty
          ? boundedDiskSha256Sync(path)
          : null;
        const recoveredSavedOwnedRevision =
          sameEditor &&
          !buffer.dirty &&
          buffer.changedtick >= quarantined.changedtick &&
          reconnectDiskSha256 === buffer.contentSha256;
        const recoveredAcceptedCommitment = [
          ...nextProposalCommitments.values(),
        ].find(
          (commitment) =>
            commitment.path === path &&
            buffer.dirty &&
            typeof buffer.content === "string" &&
            buffer.contentSha256 === commitment.afterContentSha256 &&
            ((commitment.baseContentSha256 === quarantined.contentSha256 &&
              commitment.baseChangedtick === quarantined.changedtick) ||
              (commitment.afterContentSha256 === quarantined.contentSha256 &&
                commitment.acceptedChangedtick === quarantined.changedtick)) &&
            (sameEditor
              ? buffer.changedtick > commitment.baseChangedtick
              : crossInstanceRecoveryAllowed),
        );
        const recoveredAcceptedProposal =
          recoveredAcceptedCommitment !== undefined;
        const recoveredCleanRevision =
          !buffer.dirty &&
          buffer.contentSha256 === quarantined.contentSha256 &&
          (sameEditor
            ? buffer.changedtick >= quarantined.changedtick
            : crossInstanceRecoveryAllowed);
        const exactCrossInstanceRecovery =
          crossInstanceRecoveryAllowed &&
          (quarantinedWasDirty
            ? recoveredBaseContent || recoveredAcceptedProposal
            : recoveredCleanRevision);
        if (sameEditor && buffer.changedtick < quarantined.changedtick) {
          throw new WorkspaceMutationCoordinatorError(
            "EDITOR_LEASE_MISMATCH",
            `Cannot reconcile quarantined editor buffer ${path}: recovered changedtick ${buffer.changedtick} is older than ${quarantined.changedtick}.`,
          );
        }
        if (!sameEditor && !exactCrossInstanceRecovery) {
          throw new WorkspaceMutationCoordinatorError(
            "EDITOR_LEASE_MISMATCH",
            `Cannot reconcile quarantined editor buffer ${path}: it belongs to a different editor instance, which must prove the exact persisted revision or reviewed proposal replacement.`,
          );
        }
        if (
          quarantinedWasDirty &&
          !recoveredBaseRevision &&
          !recoveredNewerOwnedRevision &&
          !recoveredSavedOwnedRevision &&
          !recoveredAcceptedProposal
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "EDITOR_LEASE_MISMATCH",
            `Cannot reconcile quarantined editor buffer ${path}: reconnect with the recovered dirty revision or explicitly abandon it.`,
          );
        }
        if (
          !quarantinedWasDirty &&
          !recoveredCleanRevision &&
          !recoveredNewerOwnedRevision &&
          !recoveredSavedOwnedRevision &&
          !recoveredAcceptedProposal
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "EDITOR_LEASE_MISMATCH",
            `Cannot reconcile quarantined editor buffer ${path}: reconnect with its last known revision or explicitly abandon it.`,
          );
        }
        if (recoveredCleanRevision) {
          const diskSha256 = reconnectDiskSha256;
          if (diskSha256 !== quarantined.contentSha256) {
            recoveryChanges.push({
              path,
              source: "unknown",
              status: "unknown_outcome",
              beforeSha256: quarantined.contentSha256,
              ...(diskSha256 !== null ? { afterSha256: diskSha256 } : {}),
            });
          }
        }
        if (!sameEditor && exactCrossInstanceRecovery && recoveredBaseContent) {
          // Neovim's changedtick is process-local. :recover proves the
          // unsaved revision with exact bytes/hash, but a fresh Nvim process
          // legitimately assigns that content a different (even lower) tick.
          // Rebind durable proposal bases to the newly authenticated process
          // revision only after that exact-content proof. Live-owner takeover
          // never reaches this path because its quarantine is not marked
          // cross-instance recoverable.
          for (const [proposalId, commitment] of nextProposalCommitments) {
            if (
              commitment.path === path &&
              commitment.baseContentSha256 === quarantined.contentSha256 &&
              commitment.baseChangedtick === quarantined.changedtick
            ) {
              nextProposalCommitments.set(proposalId, {
                ...commitment,
                baseChangedtick: buffer.changedtick,
                bufferHandle: buffer.bufferHandle,
              });
            }
          }
        }
        if (
          !sameEditor &&
          crossInstanceRecoveryAllowed &&
          recoveredAcceptedCommitment !== undefined
        ) {
          nextProposalCommitments.set(recoveredAcceptedCommitment.proposalId, {
            ...recoveredAcceptedCommitment,
            bufferHandle: buffer.bufferHandle,
            acceptedChangedtick: buffer.changedtick,
          });
        }
      }
      next.set(path, {
        path,
        bufferHandle: buffer.bufferHandle,
        changedtick: buffer.changedtick,
        contentSha256: buffer.contentSha256,
        contentBytes,
        authority: buffer.dirty ? "editor_dirty" : "disk_authoritative",
        ...(buffer.content !== undefined ? { content: buffer.content } : {}),
        epoch: lease.epoch,
        editorInstanceId: lease.editorInstanceId,
        crossInstanceRecoveryAllowed: false,
        version: ++this.#authorityVersion,
      });
    }

    // Omitted clean paths stop being tracked. Omitted dirty paths become
    // quarantined: omission is not proof that their unsaved state was saved or
    // deliberately abandoned.
    for (const previous of this.#buffers.values()) {
      if (!next.has(previous.path) && previous.authority === "editor_dirty") {
        next.set(previous.path, {
          ...previous,
          authority: "stale_dirty",
          content: undefined,
          quarantinedFrom: "editor_dirty",
          crossInstanceRecoveryAllowed: false,
          version: ++this.#authorityVersion,
        });
      }
      if (!next.has(previous.path) && previous.authority === "stale_dirty") {
        next.set(previous.path, previous);
      }
    }
    const aggregateDirtyBytes = [...next.values()].reduce(
      (total, state) =>
        state.authority === "disk_authoritative"
          ? total
          : total + state.contentBytes,
      0,
    );
    if (aggregateDirtyBytes > MAX_SYNC_BYTES) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        `editor sync exceeds ${MAX_SYNC_BYTES} content bytes`,
      );
    }
    const projectedChanges = this.#projectChanges(recoveryChanges);
    this.#ledger.assertQuarantineFits(
      this.#quarantineSnapshot({
        buffers: next,
        proposalCommitments: nextProposalCommitments,
        changes: projectedChanges.changes,
        changeSequence: projectedChanges.sequence,
      }),
    );
    this.#buffers.clear();
    for (const [path, state] of next) this.#buffers.set(path, state);
    this.#proposalCommitments.clear();
    for (const [proposalId, commitment] of nextProposalCommitments) {
      this.#proposalCommitments.set(proposalId, commitment);
    }
    this.#changes.splice(0, this.#changes.length, ...projectedChanges.changes);
    this.#changeSequence = projectedChanges.sequence;

    this.#lease = {
      ...lease,
      sequence: input.sequence,
      expiresAt: this.#now() + this.#leaseTtlMs,
    };
    this.#scheduleQuarantinePersistence();
    return {
      accepted: true,
      sequence: input.sequence,
      expiresAt: this.#lease.expiresAt,
      dirtyPaths: this.dirtyPaths(),
      stalePaths: this.stalePaths(),
    };
  }

  heartbeat(input: WorkspaceEditorHeartbeatInput): WorkspaceEditorLease {
    const lease = this.#assertLease(input);
    this.#lease = {
      ...lease,
      expiresAt: this.#now() + this.#leaseTtlMs,
    };
    return this.#leaseResult(this.#lease);
  }

  async release(input: WorkspaceEditorReleaseInput): Promise<{
    readonly released: true;
    readonly stalePaths: readonly string[];
  }> {
    let lease = this.#assertLease(input);
    if (input.abandonDirty === true) {
      for (const tokenId of [...this.#recoveredTopologyTokens]) {
        const token = this.#topologyTokens.get(tokenId);
        if (token !== undefined) {
          await this.releaseTopologyMutation(token);
        }
      }
      lease = this.#assertLease(input);
      this.#buffers.clear();
      this.#proposals.clear();
      this.#proposalCommitments.clear();
      this.#quarantineHydrationFailed = false;
    } else {
      for (const [path, state] of this.#buffers) {
        if (state.authority === "disk_authoritative") {
          this.#buffers.delete(path);
        } else if (state.authority === "editor_dirty") {
          this.#buffers.set(path, {
            ...state,
            authority: "stale_dirty",
            content: undefined,
            quarantinedFrom: "editor_dirty",
            crossInstanceRecoveryAllowed: true,
            version: ++this.#authorityVersion,
          });
        } else if (
          state.epoch === lease.epoch &&
          state.editorInstanceId === lease.editorInstanceId &&
          state.crossInstanceRecoveryAllowed !== true
        ) {
          this.#buffers.set(path, {
            ...state,
            crossInstanceRecoveryAllowed: true,
            version: ++this.#authorityVersion,
          });
        }
      }
    }
    this.#orphanEditorTopologyTokens(lease);
    this.#lease = null;
    this.#scheduleQuarantinePersistence();
    await this.flushQuarantinePersistence();
    return { released: true, stalePaths: this.stalePaths() };
  }

  authorityForPath(path: string): WorkspacePathAuthority {
    this.#expireLeaseIfNeeded();
    const authority = this.#buffers.get(this.resolvePath(path))?.authority;
    return (
      authority ??
      (this.#quarantineHydrationFailed ? "stale_dirty" : "disk_authoritative")
    );
  }

  authoritativeRead(path: string): WorkspaceAuthoritativeRead | null {
    this.#expireLeaseIfNeeded();
    const resolvedPath = this.resolvePath(path);
    const state = this.#buffers.get(resolvedPath);
    if (state?.authority === "editor_dirty" && state.content !== undefined) {
      return {
        authority: "editor_dirty",
        path: resolvedPath,
        content: state.content,
        contentSha256: state.contentSha256,
        changedtick: state.changedtick,
        bufferHandle: state.bufferHandle,
        epoch: state.epoch,
      };
    }
    if (
      !this.#quarantineHydrationFailed &&
      (state === undefined || state.authority === "disk_authoritative")
    ) {
      return null;
    }
    throw new WorkspaceMutationCoordinatorError(
      "EDITOR_LEASE_EXPIRED",
      `Cannot read ${resolvedPath}: its editor buffer may contain unsaved changes and must reconnect before AgenC can use it.`,
    );
  }

  authoritativeDirtySnapshotsUnder(
    path: string,
  ): readonly WorkspaceAuthoritativeDirtySnapshot[] {
    const target = this.resolvePath(path);
    return this.authoritativeDirtySnapshotsUnderIdentity(target);
  }

  authoritativeDirtySnapshotsUnderIdentity(
    path: string,
  ): readonly WorkspaceAuthoritativeDirtySnapshot[] {
    this.#expireLeaseIfNeeded();
    const target = normalizePathIdentity(path);
    const rel = relative(this.workspaceRoot, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_WORKSPACE",
        `path is outside workspace: ${path}`,
      );
    }
    if (this.#quarantineHydrationFailed) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_EXPIRED",
        `Cannot scan ${target}: Editor quarantine is unreadable and must be reconciled before AgenC can use workspace contents.`,
      );
    }

    const snapshots: WorkspaceAuthoritativeDirtySnapshot[] = [];
    for (const state of this.#buffers.values()) {
      if (!isSameOrDescendantPath(target, state.path)) continue;
      if (state.authority === "stale_dirty") {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_EXPIRED",
          `Cannot scan ${target}: ${state.path} may contain unsaved Editor changes and must reconnect before AgenC can use workspace contents.`,
        );
      }
      if (state.authority !== "editor_dirty") continue;
      if (state.content === undefined) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_EXPIRED",
          `Cannot scan ${target}: ${state.path} has no authoritative Editor source snapshot.`,
        );
      }
      snapshots.push({
        authority: "editor_dirty",
        path: state.path,
        content: state.content,
        contentSha256: state.contentSha256,
        changedtick: state.changedtick,
        bufferHandle: state.bufferHandle,
        epoch: state.epoch,
        version: state.version,
      });
    }
    return snapshots.sort((left, right) => left.path.localeCompare(right.path));
  }

  async prepareMutation(
    input: {
      readonly path: string;
      readonly source: WorkspaceMutationSource;
      readonly beforeText: string;
      readonly afterText: string;
      readonly sessionId?: string;
      readonly toolCallId?: string;
    },
    options: { readonly allowTopologyTokenId?: string } = {},
  ): Promise<WorkspaceMutationAdmission> {
    return this.#serializeProposalState(() =>
      this.#prepareMutation(input, options),
    );
  }

  async #prepareMutation(
    input: {
      readonly path: string;
      readonly source: WorkspaceMutationSource;
      readonly beforeText: string;
      readonly afterText: string;
      readonly sessionId?: string;
      readonly toolCallId?: string;
    },
    options: { readonly allowTopologyTokenId?: string },
  ): Promise<WorkspaceMutationAdmission> {
    this.#expireLeaseIfNeeded();
    await this.flushQuarantinePersistence();
    const path = this.resolvePath(input.path);
    const topologyConflict = this.#topologyConflictForPath(path);
    if (
      topologyConflict !== null &&
      topologyConflict.tokenId !== options.allowTopologyTokenId
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        `Cannot modify ${path} while a workspace path operation is committing`,
      );
    }
    const state = this.#buffers.get(path);
    const lease = this.#lease;
    if (
      state?.authority === "stale_dirty" ||
      (this.#quarantineHydrationFailed && state?.authority !== "editor_dirty")
    ) {
      const message =
        `Cannot modify ${path}: its editor buffer may contain unsaved changes ` +
        "and must reconnect before AgenC can write it.";
      await this.#appendLedger({
        path,
        source: input.source,
        status: "blocked",
        beforeSha256: sha256(input.beforeText),
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
        ...(input.toolCallId !== undefined
          ? { toolCallId: input.toolCallId }
          : {}),
      });
      this.#recordChange({
        path,
        source: input.source,
        status: "blocked",
        beforeSha256: sha256(input.beforeText),
      });
      return { decision: "blocked", code: "STALE_EDITOR_BUFFER", message };
    }
    if (state !== undefined && lease !== null && state.epoch === lease.epoch) {
      const beforeContentSha256 = sha256(input.beforeText);
      if (beforeContentSha256 !== state.contentSha256) {
        const message =
          `Cannot modify ${path}: the loaded Editor revision no longer ` +
          "matches the disk revision used to plan this edit. Reload or save the buffer, then retry.";
        await this.#appendLedger({
          path,
          source: input.source,
          status: "blocked",
          beforeSha256: beforeContentSha256,
          ...(input.sessionId !== undefined
            ? { sessionId: input.sessionId }
            : {}),
          ...(input.toolCallId !== undefined
            ? { toolCallId: input.toolCallId }
            : {}),
        });
        this.#recordChange({
          path,
          source: input.source,
          status: "blocked",
          beforeSha256: beforeContentSha256,
        });
        return { decision: "blocked", code: "STALE_EDITOR_BUFFER", message };
      }
      if (
        this.#proposalCommitments.size >= this.#maxPendingProposals ||
        !this.#hasProposalDeliveryCapacity()
      ) {
        const message =
          `Cannot propose another change for ${path}: Editor already has ` +
          "the maximum durable unresolved proposal queue. Accept or reject an existing proposal, then retry.";
        await this.#appendLedger({
          path,
          source: input.source,
          status: "blocked",
          beforeSha256: beforeContentSha256,
          ...(input.sessionId !== undefined
            ? { sessionId: input.sessionId }
            : {}),
          ...(input.toolCallId !== undefined
            ? { toolCallId: input.toolCallId }
            : {}),
        });
        this.#recordChange({
          path,
          source: input.source,
          status: "blocked",
          beforeSha256: beforeContentSha256,
        });
        return {
          decision: "blocked",
          code: "EDITOR_PROPOSAL_LIMIT",
          message,
        };
      }
      this.#assertProposalSize(path, input.afterText);
      const afterContentSha256 = sha256(input.afterText);
      const proposal: WorkspaceMutationProposal = {
        proposalId: randomUUID(),
        workspaceRoot: this.workspaceRoot,
        path,
        beforeText: input.beforeText,
        afterText: input.afterText,
        baseContentSha256: state.contentSha256,
        baseChangedtick: state.changedtick,
        bufferHandle: state.bufferHandle,
        source: input.source,
      };
      // Both source snapshots are returned by proposal.get. Measure the exact
      // escaped JSON response before recording any durable proposal state:
      // control characters can expand to six bytes each on the wire.
      assertWorkspaceEditorProposalResponseFitsFrame(proposal);
      const commitment: WorkspaceProposalCommitment = {
        proposalId: proposal.proposalId,
        path,
        source: input.source,
        baseContentSha256: state.contentSha256,
        afterContentSha256,
        baseChangedtick: state.changedtick,
        bufferHandle: state.bufferHandle,
      };
      const projectedCommitments = new Map(this.#proposalCommitments);
      projectedCommitments.set(commitment.proposalId, commitment);
      const projectedChanges = this.#projectChanges([
        {
          path,
          source: input.source,
          status: "proposed",
          beforeSha256: state.contentSha256,
          afterSha256: afterContentSha256,
          proposalId: proposal.proposalId,
        },
      ]);
      this.#ledger.assertQuarantineFits(
        this.#quarantineSnapshot({
          proposalCommitments: projectedCommitments,
          changes: projectedChanges.changes,
          changeSequence: projectedChanges.sequence,
        }),
      );
      const projectedAppliedCommitments = new Map(projectedCommitments);
      projectedAppliedCommitments.delete(commitment.proposalId);
      const projectedAppliedReceipts = new Map(this.#proposalReceipts);
      projectedAppliedReceipts.set(commitment.proposalId, {
        action: "applied",
        changedtick: Number.MAX_SAFE_INTEGER,
        contentSha256: afterContentSha256,
        result: {
          applied: true,
          proposalId: commitment.proposalId,
          path,
          changedtick: Number.MAX_SAFE_INTEGER,
          contentSha256: afterContentSha256,
        },
      });
      while (projectedAppliedReceipts.size > MAX_PROPOSAL_RECEIPTS) {
        const oldest = projectedAppliedReceipts.keys().next().value;
        if (typeof oldest !== "string") break;
        projectedAppliedReceipts.delete(oldest);
      }
      const projectedAppliedBuffers = new Map(this.#buffers);
      projectedAppliedBuffers.set(path, {
        ...state,
        changedtick: Number.MAX_SAFE_INTEGER,
        contentSha256: afterContentSha256,
        contentBytes: Buffer.byteLength(input.afterText, "utf8"),
        authority: "editor_dirty",
        content: input.afterText,
      });
      const projectedAppliedChanges = this.#projectChanges(
        [
          {
            path,
            source: input.source,
            status: "applied",
            beforeSha256: state.contentSha256,
            afterSha256: afterContentSha256,
            proposalId: proposal.proposalId,
          },
        ],
        {
          changes: projectedChanges.changes,
          sequence: projectedChanges.sequence,
        },
      );
      this.#ledger.assertQuarantineFits(
        this.#quarantineSnapshot({
          buffers: projectedAppliedBuffers,
          proposalCommitments: projectedAppliedCommitments,
          proposalReceipts: projectedAppliedReceipts,
          changes: projectedAppliedChanges.changes,
          changeSequence: projectedAppliedChanges.sequence,
        }),
      );
      const previousProposals = new Map(this.#proposals);
      const previousCommitments = new Map(this.#proposalCommitments);
      const previousChanges = [...this.#changes];
      const previousChangeSequence = this.#changeSequence;
      try {
        await this.#appendLedger({
          path,
          source: input.source,
          status: "proposed",
          beforeSha256: state.contentSha256,
          afterSha256: afterContentSha256,
          proposalId: proposal.proposalId,
          ...(input.sessionId !== undefined
            ? { sessionId: input.sessionId }
            : {}),
          ...(input.toolCallId !== undefined
            ? { toolCallId: input.toolCallId }
            : {}),
        });
        this.#proposals.set(proposal.proposalId, proposal);
        this.#rememberProposalCommitment(commitment);
        this.#changes.splice(
          0,
          this.#changes.length,
          ...projectedChanges.changes,
        );
        this.#changeSequence = projectedChanges.sequence;
        // The content-free commitment must be durable before the proposal can
        // escape to the tool result. This lets a surviving editor safely
        // acknowledge or discard it after a daemon restart without persisting
        // either the dirty buffer or the proposed replacement.
        this.#scheduleQuarantinePersistence();
        await this.flushQuarantinePersistence();
      } catch (error) {
        this.#proposals.clear();
        for (const [id, previous] of previousProposals) {
          this.#proposals.set(id, previous);
        }
        this.#proposalCommitments.clear();
        for (const [id, previous] of previousCommitments) {
          this.#proposalCommitments.set(id, previous);
        }
        this.#changes.splice(0, this.#changes.length, ...previousChanges);
        this.#changeSequence = previousChangeSequence;
        this.#scheduleQuarantinePersistence();
        await this.flushQuarantinePersistence().catch(() => {});
        throw error;
      }
      return { decision: "proposal", proposal };
    }
    if ([...this.#tokens.values()].some((entry) => entry.token.path === path)) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        `Cannot modify ${path}: another workspace mutation already owns this path`,
      );
    }
    const pendingDeliveryCount =
      this.#changes.filter(isEditorReloadChange).length;
    if (
      pendingDeliveryCount +
        this.#tokens.size +
        this.#pendingTopologyReloadCount() >=
      MAX_CHANGE_EVENTS
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "Cannot admit another workspace mutation until Editor acknowledges pending disk changes",
      );
    }
    const token: WorkspaceMutationToken = {
      tokenId: randomUUID(),
      workspaceRoot: this.workspaceRoot,
      path,
      source: input.source,
      beforeSha256: sha256(input.beforeText),
      intendedAfterSha256: sha256(input.afterText),
      authorityVersion: state?.version ?? this.#authorityVersion,
      createdAt: this.#now(),
      ...(options.allowTopologyTokenId !== undefined
        ? { topologyTokenId: options.allowTopologyTokenId }
        : {}),
    };
    const intent: WorkspaceMutationIntent = {
      tokenId: token.tokenId,
      path: token.path,
      source: token.source,
      beforeSha256: token.beforeSha256,
      intendedAfterSha256: token.intendedAfterSha256,
    };
    const projectedIntents = new Map(this.#mutationIntents);
    projectedIntents.set(intent.tokenId, intent);
    this.#ledger.assertQuarantineFits(
      this.#quarantineSnapshot({
        mutationIntents: projectedIntents,
      }),
    );
    // Admission also reserves enough durable space for the eventual reload
    // event. This is the last pre-effect boundary available to callers.
    const projectedChanges = this.#projectChanges([
      {
        path: token.path,
        source: token.source,
        status: "unknown_outcome",
        beforeSha256: token.beforeSha256,
        afterSha256: token.intendedAfterSha256,
      },
    ]);
    this.#ledger.assertQuarantineFits(
      this.#quarantineSnapshot({
        changes: projectedChanges.changes,
        changeSequence: projectedChanges.sequence,
      }),
    );
    this.#tokens.set(token.tokenId, { token, executing: false });
    this.#mutationIntents.set(token.tokenId, intent);
    this.#scheduleQuarantinePersistence();
    try {
      await this.flushQuarantinePersistence();
    } catch (error) {
      this.#tokens.delete(token.tokenId);
      this.#mutationIntents.delete(token.tokenId);
      this.#scheduleQuarantinePersistence();
      await this.flushQuarantinePersistence().catch(() => {});
      throw error;
    }
    return { decision: "allow", token };
  }

  beginMutation(token: WorkspaceMutationToken): void {
    const current = this.#tokens.get(token.tokenId);
    if (current === undefined || current.token.path !== token.path) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "workspace mutation token is missing or already consumed",
      );
    }
    const state = this.#buffers.get(token.path);
    if (
      state?.authority === "editor_dirty" ||
      state?.authority === "stale_dirty" ||
      (state !== undefined && state.version !== token.authorityVersion)
    ) {
      this.#tokens.delete(token.tokenId);
      this.#mutationIntents.delete(token.tokenId);
      this.#scheduleQuarantinePersistence();
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        `editor authority changed before ${token.path} could be committed`,
      );
    }
    this.#tokens.set(token.tokenId, { token, executing: true });
  }

  async commitMutation(
    token: WorkspaceMutationToken,
    afterText: string,
    metadata: {
      readonly sessionId?: string;
      readonly toolCallId?: string;
    } = {},
  ): Promise<void> {
    const current = this.#tokens.get(token.tokenId);
    if (
      current === undefined ||
      current.token.path !== token.path ||
      !current.executing
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace mutation token is missing or already consumed",
      );
    }
    const afterSha256 = sha256(afterText);
    const markUnknownOutcome = async (detail: string): Promise<never> => {
      // commitMutation is a post-effect boundary: callers invoke it only after
      // the filesystem operation has completed. Once the executing token is
      // consumed, any coherence or audit failure must therefore be reported as
      // an unknown outcome, never as a failed write.
      try {
        await this.reconcileUnknownMutation(
          token,
          { kind: "content", content: afterText },
          metadata,
        );
      } catch {}
      throw new WorkspaceMutationCoordinatorError(
        "MUTATION_AUDIT_FAILED",
        `Disk mutation completed for ${token.path}, but AgenC could not persist its workspace coherence audit (${detail}). The outcome is marked unknown; re-read the file before another mutation.`,
      );
    };
    const state = this.#buffers.get(token.path);
    if (
      state?.authority === "editor_dirty" ||
      state?.authority === "stale_dirty" ||
      (state !== undefined && state.version !== token.authorityVersion)
    ) {
      return markUnknownOutcome(
        "editor authority changed after the disk operation",
      );
    }
    try {
      await this.#appendLedger({
        path: token.path,
        source: token.source,
        status: "applied",
        beforeSha256: token.beforeSha256,
        afterSha256,
        ...(metadata.sessionId !== undefined
          ? { sessionId: metadata.sessionId }
          : {}),
        ...(metadata.toolCallId !== undefined
          ? { toolCallId: metadata.toolCallId }
          : {}),
      });
    } catch (error) {
      return markUnknownOutcome(
        error instanceof Error ? error.message : String(error),
      );
    }
    const previousChanges = [...this.#changes];
    const previousChangeSequence = this.#changeSequence;
    const intent = this.#mutationIntents.get(token.tokenId);
    const projectedChanges = this.#projectChanges([
      {
        path: token.path,
        source: token.source,
        status: "applied",
        beforeSha256: token.beforeSha256,
        afterSha256,
      },
    ]);
    const projectedIntents = new Map(this.#mutationIntents);
    projectedIntents.delete(token.tokenId);
    try {
      this.#ledger.assertQuarantineFits(
        this.#quarantineSnapshot({
          mutationIntents: projectedIntents,
          changes: projectedChanges.changes,
          changeSequence: projectedChanges.sequence,
        }),
      );
    } catch (error) {
      return markUnknownOutcome(
        error instanceof Error ? error.message : String(error),
      );
    }
    this.#mutationIntents.delete(token.tokenId);
    this.#changes.splice(0, this.#changes.length, ...projectedChanges.changes);
    this.#changeSequence = projectedChanges.sequence;
    this.#scheduleQuarantinePersistence();
    try {
      await this.flushQuarantinePersistence();
    } catch (error) {
      this.#changes.splice(0, this.#changes.length, ...previousChanges);
      this.#changeSequence = previousChangeSequence;
      if (intent !== undefined) {
        this.#mutationIntents.set(token.tokenId, intent);
      }
      return markUnknownOutcome(
        error instanceof Error ? error.message : String(error),
      );
    }
    this.#tokens.delete(token.tokenId);
  }

  async reconcileUnknownMutation(
    token: WorkspaceMutationToken,
    observed: WorkspaceMutationObservedState,
    metadata: {
      readonly sessionId?: string;
      readonly toolCallId?: string;
    } = {},
  ): Promise<void> {
    const current = this.#tokens.get(token.tokenId);
    if (
      current === undefined ||
      current.token.path !== token.path ||
      !current.executing
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace mutation token is missing or already consumed",
      );
    }
    // Release authority first and never put the token back: this API exists
    // for a filesystem effect whose exact transactional outcome is no longer
    // provable.
    this.#tokens.delete(token.tokenId);
    this.#mutationIntents.delete(token.tokenId);
    const afterSha256 =
      observed.kind === "content" ? sha256(observed.content) : undefined;
    const projectedChanges = this.#projectChanges([
      {
        path: token.path,
        source: token.source,
        status: "unknown_outcome",
        beforeSha256: token.beforeSha256,
        ...(afterSha256 !== undefined ? { afterSha256 } : {}),
      },
    ]);
    this.#ledger.assertQuarantineFits(
      this.#quarantineSnapshot({
        mutationIntents: this.#mutationIntents,
        changes: projectedChanges.changes,
        changeSequence: projectedChanges.sequence,
      }),
    );
    this.#changes.splice(0, this.#changes.length, ...projectedChanges.changes);
    this.#changeSequence = projectedChanges.sequence;
    let ledgerError: unknown;
    try {
      await this.#appendLedger({
        path: token.path,
        source: token.source,
        status: "unknown_outcome",
        beforeSha256: token.beforeSha256,
        ...(afterSha256 !== undefined ? { afterSha256 } : {}),
        ...(metadata.sessionId !== undefined
          ? { sessionId: metadata.sessionId }
          : {}),
        ...(metadata.toolCallId !== undefined
          ? { toolCallId: metadata.toolCallId }
          : {}),
      });
    } catch (error) {
      ledgerError = error;
    }
    this.#scheduleQuarantinePersistence();
    let quarantineError: unknown;
    try {
      await this.flushQuarantinePersistence();
    } catch (error) {
      quarantineError = error;
    }
    if (ledgerError !== undefined || quarantineError !== undefined) {
      const details = [ledgerError, quarantineError]
        .filter((error) => error !== undefined)
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("; ");
      throw new WorkspaceMutationCoordinatorError(
        "MUTATION_AUDIT_FAILED",
        `The disk outcome for ${token.path} is unknown and its coherence record could not be fully persisted (${details}). Re-read the path before another mutation.`,
      );
    }
  }

  cancelMutation(token: WorkspaceMutationToken): void {
    this.#tokens.delete(token.tokenId);
    if (this.#mutationIntents.delete(token.tokenId)) {
      this.#scheduleQuarantinePersistence();
    }
  }

  async reserveTopologyMutation(
    targets: readonly WorkspaceTopologyMutationTarget[],
    source: WorkspaceMutationSource = "unknown",
  ): Promise<WorkspaceTopologyMutationToken> {
    return this.#reserveTopologyMutation(targets, source, null);
  }

  async reserveEditorTopologyMutation(
    input: WorkspaceEditorTopologyMutationInput,
  ): Promise<WorkspaceTopologyMutationToken> {
    const lease = this.#assertLease(input);
    const token = await this.#reserveTopologyMutation(
      input.targets,
      input.source ?? "editor",
      lease,
    );
    try {
      const activeLease = this.#assertLease(input);
      if (activeLease.epoch !== lease.epoch) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          "editor lease changed while reserving the workspace path operation",
        );
      }
      this.#editorTopologyOwners.set(token.tokenId, {
        editorInstanceId: lease.editorInstanceId,
        epoch: lease.epoch,
      });
      return token;
    } catch (error) {
      await this.releaseTopologyMutation(token).catch(() => {});
      throw error;
    }
  }

  listRecoveredEditorTopologyMutations(
    input: WorkspaceEditorHeartbeatInput,
  ): readonly WorkspaceRecoveredEditorTopologyMutation[] {
    this.#assertLease(input);
    const recovered: WorkspaceRecoveredEditorTopologyMutation[] = [];
    for (const tokenId of this.#recoveredTopologyTokens) {
      const token = this.#topologyTokens.get(tokenId);
      if (
        token === undefined ||
        this.#topologyIntents.get(tokenId) === undefined ||
        this.#editorTopologyOwners.has(tokenId)
      ) {
        continue;
      }
      recovered.push({
        tokenId: token.tokenId,
        workspaceRoot: token.workspaceRoot,
        targets: token.targets,
        source: token.source,
        createdAt: token.createdAt,
      });
    }
    return recovered;
  }

  async resolveRecoveredEditorTopologyMutation(
    input: WorkspaceRecoveredEditorTopologyMutationResolveInput,
  ): Promise<{
    readonly resolved: true;
    readonly tokenId: string;
    readonly status: "unknown_outcome";
  }> {
    const lease = this.#assertLease(input);
    const token = this.#topologyTokens.get(input.tokenId);
    if (
      token === undefined ||
      this.#topologyIntents.get(input.tokenId) === undefined ||
      !this.#recoveredTopologyTokens.has(input.tokenId) ||
      this.#editorTopologyOwners.has(input.tokenId)
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "workspace path recovery token is not a durable orphan owned by the active editor recovery flow",
      );
    }

    // Claim the orphan synchronously so two recovery clicks cannot both
    // consume it. This owner is only a retry lock: the durable intent remains
    // fenced until completeTopologyMutation first persists the explicit
    // unknown_outcome reconciliation and then consumes the token.
    const recoveryOwner = {
      editorInstanceId: lease.editorInstanceId,
      epoch: lease.epoch,
    };
    this.#editorTopologyOwners.set(token.tokenId, recoveryOwner);
    try {
      await this.completeTopologyMutation(token, "unknown_outcome");
      return {
        resolved: true,
        tokenId: token.tokenId,
        status: "unknown_outcome",
      };
    } catch (error) {
      const activeOwner = this.#editorTopologyOwners.get(token.tokenId);
      if (
        this.#topologyTokens.has(token.tokenId) &&
        activeOwner?.editorInstanceId === recoveryOwner.editorInstanceId &&
        activeOwner.epoch === recoveryOwner.epoch
      ) {
        this.#editorTopologyOwners.delete(token.tokenId);
      }
      throw error;
    }
  }

  async #reserveTopologyMutation(
    targets: readonly WorkspaceTopologyMutationTarget[],
    source: WorkspaceMutationSource,
    editorLease: ActiveLease | null,
  ): Promise<WorkspaceTopologyMutationToken> {
    this.#expireLeaseIfNeeded();
    await this.flushQuarantinePersistence();
    if (this.#quarantineHydrationFailed) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "Cannot reserve a workspace path operation while editor quarantine is unreadable",
      );
    }
    if (targets.length === 0) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace path operation requires at least one target",
      );
    }
    if (this.#topologyIntents.size >= MAX_CHANGE_EVENTS) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "Cannot reserve another workspace path operation until pending operations complete",
      );
    }
    const resolvedTargets = targets.map((target) => ({
      path: this.resolvePath(target.path),
      includeDescendants: target.includeDescendants === true,
      allowOwnedClean: target.allowOwnedClean === true,
    }));
    for (const target of resolvedTargets) {
      const editorConflict = this.#bufferConflictForTopologyTarget(
        target,
        editorLease,
      );
      if (editorConflict !== null) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot mutate ${target.path}: ${editorConflict} is loaded or quarantined in Editor`,
        );
      }
      const admittedConflict = [...this.#tokens.values()].find((entry) =>
        topologyTargetContainsPath(target, entry.token.path),
      );
      if (admittedConflict !== undefined) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot mutate ${target.path}: ${admittedConflict.token.path} has an admitted workspace write`,
        );
      }
      const topologyConflict = this.#topologyConflictForTarget(target);
      if (topologyConflict !== null) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot mutate ${target.path}: an overlapping workspace path operation is committing`,
        );
      }
    }
    const initialContentions = new Map<
      string,
      { readonly path: string; readonly beforeSha256: string }
    >();
    if (editorLease !== null) {
      for (const target of resolvedTargets) {
        if (!target.allowOwnedClean) continue;
        for (const state of this.#buffers.values()) {
          if (
            state.epoch === editorLease.epoch &&
            state.authority === "disk_authoritative" &&
            topologyTargetContainsPath(target, state.path)
          ) {
            initialContentions.set(state.path, {
              path: state.path,
              beforeSha256: state.contentSha256,
            });
          }
        }
      }
    }
    const token: WorkspaceTopologyMutationToken = {
      tokenId: randomUUID(),
      workspaceRoot: this.workspaceRoot,
      targets: resolvedTargets.map(({ path, includeDescendants }) => ({
        path,
        includeDescendants,
      })),
      source,
      createdAt: this.#now(),
    };
    const intent: WorkspaceTopologyMutationIntent = {
      tokenId: token.tokenId,
      source,
      targets: token.targets,
      contentions: [...initialContentions.values()],
    };
    const projectedIntents = new Map(this.#topologyIntents);
    projectedIntents.set(intent.tokenId, intent);
    this.#ledger.assertQuarantineFits(
      this.#quarantineSnapshot({
        topologyIntents: projectedIntents,
      }),
    );
    const pendingDeliveryCount =
      this.#changes.filter(isEditorReloadChange).length;
    const projectedTopologyReloadCount = [...projectedIntents.values()].reduce(
      (total, projected) => total + projected.contentions.length,
      0,
    );
    if (
      pendingDeliveryCount + this.#tokens.size + projectedTopologyReloadCount >
      MAX_CHANGE_EVENTS
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "MUTATION_AUDIT_FAILED",
        "Editor has not acknowledged the pending workspace change queue",
      );
    }
    this.#topologyTokens.set(token.tokenId, token);
    this.#topologyIntents.set(token.tokenId, intent);
    this.#scheduleQuarantinePersistence();
    try {
      await this.flushQuarantinePersistence();
      return token;
    } catch (error) {
      this.#topologyTokens.delete(token.tokenId);
      this.#topologyIntents.delete(token.tokenId);
      this.#scheduleQuarantinePersistence();
      await this.flushQuarantinePersistence().catch(() => {});
      throw error;
    }
  }

  async releaseTopologyMutation(
    token: WorkspaceTopologyMutationToken,
  ): Promise<void> {
    for (;;) {
      await this.flushQuarantinePersistence();
      const activeToken = this.#topologyTokens.get(token.tokenId);
      if (activeToken === undefined) {
        this.#editorTopologyOwners.delete(token.tokenId);
        this.#recoveredTopologyTokens.delete(token.tokenId);
        return;
      }
      if (
        token.workspaceRoot !== this.workspaceRoot ||
        activeToken.workspaceRoot !== token.workspaceRoot
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          "workspace topology mutation token belongs to another workspace",
        );
      }
      const intent = this.#topologyIntents.get(token.tokenId);
      if (intent === undefined) {
        // No durable intent means there is no crash-recovery fence left to
        // preserve. Clear the matching in-memory token idempotently.
        this.#topologyTokens.delete(token.tokenId);
        this.#editorTopologyOwners.delete(token.tokenId);
        this.#recoveredTopologyTokens.delete(token.tokenId);
        return;
      }
      const projectedIntents = new Map(this.#topologyIntents);
      projectedIntents.delete(token.tokenId);
      const persistence = this.#scheduleQuarantineSnapshot(
        this.#quarantineSnapshot({ topologyIntents: projectedIntents }),
      );
      await persistence;
      // A rejected concurrent sync may have expanded the intent while the
      // deletion snapshot was queued. Persist deletion of that exact latest
      // intent before opening the fence.
      if (
        this.#pendingQuarantinePersistence !== persistence ||
        this.#topologyIntents.get(token.tokenId) !== intent
      ) {
        continue;
      }
      this.#topologyIntents.delete(token.tokenId);
      this.#topologyTokens.delete(token.tokenId);
      this.#editorTopologyOwners.delete(token.tokenId);
      this.#recoveredTopologyTokens.delete(token.tokenId);
      return;
    }
  }

  async releaseEditorTopologyMutation(
    input: WorkspaceEditorTopologyMutationFinalizeInput,
  ): Promise<{
    readonly released: true;
    readonly tokenId: string;
    readonly sync: WorkspaceEditorSyncResult;
  }> {
    const token = this.#assertEditorTopologyToken(input);
    const sync = this.sync(
      {
        workspaceRoot: input.workspaceRoot,
        editorInstanceId: input.editorInstanceId,
        leaseToken: input.leaseToken,
        epoch: input.epoch,
        sequence: input.sequence,
        buffers: input.buffers,
      },
      { allowTopologyTokenId: token.tokenId },
    );
    // The final Editor manifest must be durable while the topology fence still
    // exists. Only then may an aborted pre-effect transaction release it.
    await this.flushQuarantinePersistence();
    await this.releaseTopologyMutation(token);
    return { released: true, tokenId: token.tokenId, sync };
  }

  async completeEditorTopologyMutation(
    input: WorkspaceEditorTopologyMutationFinalizeInput & {
      readonly status: "applied" | "unknown_outcome";
    },
  ): Promise<{
    readonly completed: true;
    readonly tokenId: string;
    readonly status: "applied" | "unknown_outcome";
    readonly sync: WorkspaceEditorSyncResult;
  }> {
    const token = this.#assertEditorTopologyToken(input);
    const sync = this.sync(
      {
        workspaceRoot: input.workspaceRoot,
        editorInstanceId: input.editorInstanceId,
        leaseToken: input.leaseToken,
        epoch: input.epoch,
        sequence: input.sequence,
        buffers: input.buffers,
      },
      { allowTopologyTokenId: token.tokenId },
    );
    // Publish Neovim's post-operation manifest without opening a destination
    // path race: the topology token remains visible to all other writers until
    // completeTopologyMutation consumes it below.
    await this.flushQuarantinePersistence();
    await this.completeTopologyMutation(token, input.status);
    return {
      completed: true,
      tokenId: token.tokenId,
      status: input.status,
      sync,
    };
  }

  async completeTopologyMutation(
    token: WorkspaceTopologyMutationToken,
    status: "applied" | "unknown_outcome",
  ): Promise<void> {
    if (
      token.workspaceRoot !== this.workspaceRoot ||
      this.#topologyTokens.get(token.tokenId) === undefined
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace topology mutation token is missing or already consumed",
      );
    }
    for (;;) {
      await this.flushQuarantinePersistence();
      const intent = this.#topologyIntents.get(token.tokenId);
      if (intent === undefined) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          "workspace topology mutation intent is missing or already consumed",
        );
      }
      const changeInputs = intent.contentions.map((contention) => {
        const afterSha256 = boundedDiskSha256Sync(contention.path);
        return {
          path: contention.path,
          source: intent.source,
          status,
          beforeSha256: contention.beforeSha256,
          ...(afterSha256 !== null ? { afterSha256 } : {}),
        } satisfies Omit<
          WorkspaceChangeEvent,
          "sequence" | "timestamp" | "workspaceRoot"
        >;
      });
      const projectedChanges = this.#projectChanges(changeInputs);
      const projectedIntents = new Map(this.#topologyIntents);
      projectedIntents.delete(token.tokenId);
      const snapshot = this.#quarantineSnapshot({
        topologyIntents: projectedIntents,
        changes: projectedChanges.changes,
        changeSequence: projectedChanges.sequence,
      });
      this.#ledger.assertQuarantineFits(snapshot);
      const persistence = this.#scheduleQuarantineSnapshot(snapshot);
      await persistence;
      // A concurrent rejected sync queues a newer intent snapshot. Let it
      // finish, then rebuild completion with that exact-path contention too.
      if (
        this.#pendingQuarantinePersistence !== persistence ||
        this.#topologyIntents.get(token.tokenId) !== intent
      ) {
        continue;
      }
      this.#changes.splice(
        0,
        this.#changes.length,
        ...projectedChanges.changes,
      );
      this.#changeSequence = projectedChanges.sequence;
      this.#topologyIntents.delete(token.tokenId);
      this.#topologyTokens.delete(token.tokenId);
      this.#editorTopologyOwners.delete(token.tokenId);
      this.#recoveredTopologyTokens.delete(token.tokenId);
      let ledgerError: unknown;
      for (const change of projectedChanges.changes.slice(
        projectedChanges.changes.length - changeInputs.length,
      )) {
        try {
          await this.#appendLedger({
            path: change.path,
            source: change.source,
            status: change.status,
            beforeSha256: change.beforeSha256,
            ...(change.afterSha256 !== undefined
              ? { afterSha256: change.afterSha256 }
              : {}),
          });
        } catch (error) {
          ledgerError ??= error;
        }
      }
      if (ledgerError !== undefined) {
        throw new WorkspaceMutationCoordinatorError(
          "MUTATION_AUDIT_FAILED",
          `Workspace path operation completed, but AgenC could not append its audit ledger (${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}). Reload affected Editor buffers before continuing.`,
        );
      }
      return;
    }
  }

  getProposal(proposalId: string): WorkspaceMutationProposal | null {
    return this.#proposals.get(proposalId) ?? null;
  }

  discardProposal(proposalId: string): boolean {
    const deleted =
      this.#proposals.delete(proposalId) ||
      this.#proposalCommitments.delete(proposalId);
    if (deleted) {
      this.#proposalCommitments.delete(proposalId);
      this.#scheduleQuarantinePersistence();
    }
    return deleted;
  }

  inspectProposal(
    input: WorkspaceEditorProposalInput,
  ): WorkspaceMutationProposal {
    const lease = this.#assertLease(input);
    const proposal = this.#proposals.get(input.proposalId);
    if (proposal === undefined) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        `workspace mutation proposal not found: ${input.proposalId}`,
      );
    }
    const state = this.#buffers.get(proposal.path);
    if (
      state === undefined ||
      state.authority === "stale_dirty" ||
      state.epoch !== lease.epoch ||
      state.contentSha256 !== proposal.baseContentSha256 ||
      state.changedtick !== proposal.baseChangedtick
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        `workspace mutation proposal is stale: ${input.proposalId}`,
      );
    }
    return proposal;
  }

  async proposalStatus(
    input: WorkspaceEditorProposalInput,
  ): Promise<WorkspaceEditorProposalStatus> {
    this.#assertLease(input);
    return this.#serializeProposalState(async () => {
      // Status participates in the same global proposal transaction chain as
      // admission/apply/discard. A response-lost apply must therefore become
      // visible as its terminal receipt instead of racing an older proposed
      // event and reporting it as reviewable.
      let lease = this.#assertLease(input);
      await this.flushQuarantinePersistence();
      lease = this.#assertLease(input);

      const receipt = this.#proposalReceipts.get(input.proposalId);
      if (receipt?.action === "applied") {
        return {
          status: "applied",
          proposalId: receipt.result.proposalId,
          path: receipt.result.path,
          changedtick: receipt.result.changedtick,
          contentSha256: receipt.result.contentSha256,
        };
      }
      if (receipt?.action === "discarded") {
        return {
          status: "discarded",
          proposalId: receipt.result.proposalId,
          path: receipt.result.path,
        };
      }

      const proposal = this.#proposals.get(input.proposalId);
      if (proposal !== undefined) {
        const state = this.#buffers.get(proposal.path);
        if (
          state !== undefined &&
          state.authority !== "stale_dirty" &&
          state.epoch === lease.epoch &&
          state.contentSha256 === proposal.baseContentSha256 &&
          state.changedtick === proposal.baseChangedtick
        ) {
          return { status: "reviewable", proposal };
        }
      }

      const commitment = this.#proposalCommitments.get(input.proposalId);
      if (commitment !== undefined) {
        return {
          status: "committed",
          proposalId: commitment.proposalId,
          path: commitment.path,
          source: commitment.source,
          baseContentSha256: commitment.baseContentSha256,
          afterContentSha256: commitment.afterContentSha256,
          baseChangedtick: commitment.baseChangedtick,
          bufferHandle: commitment.bufferHandle,
          ...(commitment.acceptedChangedtick !== undefined
            ? { acceptedChangedtick: commitment.acceptedChangedtick }
            : {}),
        };
      }

      return { status: "missing", proposalId: input.proposalId };
    });
  }

  async applyProposal(input: WorkspaceEditorProposalApplyInput): Promise<{
    readonly applied: true;
    readonly proposalId: string;
    readonly path: string;
    readonly changedtick: number;
    readonly contentSha256: string;
  }> {
    this.#assertLease(input);
    return this.#serializeProposalState(() =>
      this.#serializeProposalResolution(input.proposalId, async () => {
        this.#assertLease(input);
        const receipt = this.#proposalReceipts.get(input.proposalId);
        if (receipt?.action === "discarded") {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            `workspace mutation proposal was already discarded: ${input.proposalId}`,
          );
        }
        if (receipt?.action === "applied") {
          if (
            receipt.changedtick !== input.changedtick ||
            receipt.contentSha256 !== input.contentSha256 ||
            sha256(input.content) !== input.contentSha256
          ) {
            throw new WorkspaceMutationCoordinatorError(
              "INVALID_EDITOR_SYNC",
              `workspace mutation proposal acknowledgement conflicts with its applied receipt: ${input.proposalId}`,
            );
          }
          this.#scheduleQuarantinePersistence();
          await this.flushQuarantinePersistence();
          return receipt.result;
        }
        const proposal = this.#proposals.get(input.proposalId);
        const commitment = this.#proposalCommitments.get(input.proposalId);
        if (proposal === undefined && commitment === undefined) {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            `workspace mutation proposal not found: ${input.proposalId}`,
          );
        }
        const resolvedCommitment =
          commitment ??
          (proposal === undefined
            ? undefined
            : {
                proposalId: proposal.proposalId,
                path: proposal.path,
                source: proposal.source,
                baseContentSha256: proposal.baseContentSha256,
                afterContentSha256: sha256(proposal.afterText),
                baseChangedtick: proposal.baseChangedtick,
                bufferHandle: proposal.bufferHandle,
              });
        if (resolvedCommitment === undefined) {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            `workspace mutation proposal commitment not found: ${input.proposalId}`,
          );
        }
        const recoveredAcceptedTickMatches =
          resolvedCommitment.acceptedChangedtick !== undefined &&
          input.changedtick === resolvedCommitment.acceptedChangedtick;
        if (
          !Number.isSafeInteger(input.changedtick) ||
          (input.changedtick <= resolvedCommitment.baseChangedtick &&
            !recoveredAcceptedTickMatches)
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            "accepted proposal changedtick must advance beyond its base revision",
          );
        }
        if (
          sha256(input.content) !== input.contentSha256 ||
          input.contentSha256 !== resolvedCommitment.afterContentSha256 ||
          (proposal !== undefined && input.content !== proposal.afterText)
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            "accepted proposal content does not match the reviewed replacement",
          );
        }
        this.#assertProposalSize(resolvedCommitment.path, input.content);
        const previous = this.#buffers.get(resolvedCommitment.path);
        const exactCrossInstanceProposalRecovery =
          previous?.authority === "stale_dirty" &&
          previous.crossInstanceRecoveryAllowed === true &&
          ((previous.contentSha256 === resolvedCommitment.baseContentSha256 &&
            previous.changedtick === resolvedCommitment.baseChangedtick) ||
            (previous.contentSha256 === resolvedCommitment.afterContentSha256 &&
              previous.changedtick === resolvedCommitment.acceptedChangedtick));
        if (
          previous?.authority === "stale_dirty" &&
          previous.editorInstanceId !== input.editorInstanceId &&
          !exactCrossInstanceProposalRecovery
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "EDITOR_LEASE_MISMATCH",
            `Cannot acknowledge workspace mutation proposal ${input.proposalId}: a new editor instance must match its exact durable workspace scope and base revision.`,
          );
        }
        const atBaseRevision =
          previous !== undefined &&
          previous.contentSha256 === resolvedCommitment.baseContentSha256 &&
          previous.changedtick === resolvedCommitment.baseChangedtick;
        const atAcceptedRevision =
          previous !== undefined &&
          previous.authority === "editor_dirty" &&
          previous.contentSha256 === resolvedCommitment.afterContentSha256 &&
          previous.changedtick === input.changedtick;
        if (!atBaseRevision && !atAcceptedRevision) {
          throw new WorkspaceMutationCoordinatorError(
            "EDITOR_LEASE_MISMATCH",
            `workspace mutation proposal is stale: ${input.proposalId}`,
          );
        }
        const result = {
          applied: true as const,
          proposalId: resolvedCommitment.proposalId,
          path: resolvedCommitment.path,
          changedtick: input.changedtick,
          contentSha256: input.contentSha256,
        };
        // Append before consuming the proposal. A durable-ledger failure leaves
        // the original proposal retryable instead of creating an unreceipted
        // in-memory commit.
        await this.#appendLedger({
          path: resolvedCommitment.path,
          source: resolvedCommitment.source,
          status: "applied",
          beforeSha256: resolvedCommitment.baseContentSha256,
          afterSha256: input.contentSha256,
          proposalId: resolvedCommitment.proposalId,
        });
        const activeLease = this.#assertLease(input);
        const latest = this.#buffers.get(resolvedCommitment.path);
        const latestAtBaseRevision =
          latest !== undefined &&
          latest.contentSha256 === resolvedCommitment.baseContentSha256 &&
          latest.changedtick === resolvedCommitment.baseChangedtick;
        const latestAtAcceptedRevision =
          latest !== undefined &&
          latest.authority === "editor_dirty" &&
          latest.contentSha256 === resolvedCommitment.afterContentSha256 &&
          latest.changedtick === input.changedtick &&
          latest.epoch === activeLease.epoch;
        const latestIsNewerEditorRevision =
          latest !== undefined &&
          latest.authority === "editor_dirty" &&
          latest.changedtick > input.changedtick &&
          latest.epoch === activeLease.epoch;
        if (
          !latestAtBaseRevision &&
          !latestAtAcceptedRevision &&
          !latestIsNewerEditorRevision
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "EDITOR_LEASE_MISMATCH",
            `workspace mutation proposal authority changed while its acknowledgement was being committed: ${input.proposalId}`,
          );
        }
        const nextBuffers = new Map(this.#buffers);
        if (latestAtBaseRevision) {
          nextBuffers.set(resolvedCommitment.path, {
            ...latest,
            path: resolvedCommitment.path,
            bufferHandle:
              latest.bufferHandle === 0
                ? resolvedCommitment.bufferHandle
                : latest.bufferHandle,
            changedtick: input.changedtick,
            contentSha256: input.contentSha256,
            contentBytes: Buffer.byteLength(input.content, "utf8"),
            content: input.content,
            authority: "editor_dirty",
            epoch: activeLease.epoch,
            editorInstanceId: activeLease.editorInstanceId,
            crossInstanceRecoveryAllowed: false,
            version: ++this.#authorityVersion,
          });
        }
        const nextCommitments = new Map(this.#proposalCommitments);
        nextCommitments.delete(resolvedCommitment.proposalId);
        const nextReceipts = new Map(this.#proposalReceipts);
        nextReceipts.delete(resolvedCommitment.proposalId);
        nextReceipts.set(resolvedCommitment.proposalId, {
          action: "applied",
          changedtick: input.changedtick,
          contentSha256: input.contentSha256,
          result,
        });
        while (nextReceipts.size > MAX_PROPOSAL_RECEIPTS) {
          const oldest = nextReceipts.keys().next().value;
          if (typeof oldest !== "string") break;
          nextReceipts.delete(oldest);
        }
        const nextChanges = this.#projectChanges([
          {
            path: resolvedCommitment.path,
            source: resolvedCommitment.source,
            status: "applied",
            beforeSha256: resolvedCommitment.baseContentSha256,
            afterSha256: input.contentSha256,
            proposalId: resolvedCommitment.proposalId,
          },
        ]);
        this.#ledger.assertQuarantineFits(
          this.#quarantineSnapshot({
            buffers: nextBuffers,
            proposalCommitments: nextCommitments,
            proposalReceipts: nextReceipts,
            changes: nextChanges.changes,
            changeSequence: nextChanges.sequence,
          }),
        );
        this.#buffers.clear();
        for (const [path, state] of nextBuffers) this.#buffers.set(path, state);
        this.#proposals.delete(resolvedCommitment.proposalId);
        this.#proposalCommitments.clear();
        for (const [id, next] of nextCommitments) {
          this.#proposalCommitments.set(id, next);
        }
        this.#proposalReceipts.clear();
        for (const [id, next] of nextReceipts) {
          this.#proposalReceipts.set(id, next);
        }
        this.#changes.splice(0, this.#changes.length, ...nextChanges.changes);
        this.#changeSequence = nextChanges.sequence;
        this.#scheduleQuarantinePersistence();
        await this.flushQuarantinePersistence();
        return result;
      }),
    );
  }

  async discardProposalForEditor(input: WorkspaceEditorProposalInput): Promise<{
    readonly discarded: true;
    readonly proposalId: string;
    readonly path: string;
  }> {
    this.#assertLease(input);
    return this.#serializeProposalState(() =>
      this.#serializeProposalResolution(input.proposalId, async () => {
        this.#assertLease(input);
        const receipt = this.#proposalReceipts.get(input.proposalId);
        if (receipt?.action === "applied") {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            `workspace mutation proposal was already applied: ${input.proposalId}`,
          );
        }
        if (receipt?.action === "discarded") {
          this.#scheduleQuarantinePersistence();
          await this.flushQuarantinePersistence();
          return receipt.result;
        }
        const proposal = this.#proposals.get(input.proposalId);
        const commitment = this.#proposalCommitments.get(input.proposalId);
        if (proposal === undefined && commitment === undefined) {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            `workspace mutation proposal not found: ${input.proposalId}`,
          );
        }
        const resolvedCommitment =
          commitment ??
          (proposal === undefined
            ? undefined
            : {
                proposalId: proposal.proposalId,
                path: proposal.path,
                source: proposal.source,
                baseContentSha256: proposal.baseContentSha256,
                afterContentSha256: sha256(proposal.afterText),
                baseChangedtick: proposal.baseChangedtick,
                bufferHandle: proposal.bufferHandle,
              });
        if (resolvedCommitment === undefined) {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            `workspace mutation proposal commitment not found: ${input.proposalId}`,
          );
        }
        const result = {
          discarded: true as const,
          proposalId: resolvedCommitment.proposalId,
          path: resolvedCommitment.path,
        };
        await this.#appendLedger({
          path: resolvedCommitment.path,
          source: resolvedCommitment.source,
          status: "discarded",
          beforeSha256: resolvedCommitment.baseContentSha256,
          afterSha256: resolvedCommitment.afterContentSha256,
          proposalId: resolvedCommitment.proposalId,
        });
        // The ledger append is asynchronous. A release or takeover during it
        // invalidates this acknowledgement; leave the commitment intact so the
        // surviving editor can retry under its new lease.
        this.#assertLease(input);
        const nextCommitments = new Map(this.#proposalCommitments);
        nextCommitments.delete(resolvedCommitment.proposalId);
        const nextReceipts = new Map(this.#proposalReceipts);
        nextReceipts.delete(resolvedCommitment.proposalId);
        nextReceipts.set(resolvedCommitment.proposalId, {
          action: "discarded",
          result,
        });
        while (nextReceipts.size > MAX_PROPOSAL_RECEIPTS) {
          const oldest = nextReceipts.keys().next().value;
          if (typeof oldest !== "string") break;
          nextReceipts.delete(oldest);
        }
        const nextChanges = this.#projectChanges([
          {
            path: resolvedCommitment.path,
            source: resolvedCommitment.source,
            status: "discarded",
            beforeSha256: resolvedCommitment.baseContentSha256,
            afterSha256: resolvedCommitment.afterContentSha256,
            proposalId: resolvedCommitment.proposalId,
          },
        ]);
        this.#ledger.assertQuarantineFits(
          this.#quarantineSnapshot({
            proposalCommitments: nextCommitments,
            proposalReceipts: nextReceipts,
            changes: nextChanges.changes,
            changeSequence: nextChanges.sequence,
          }),
        );
        this.#proposals.delete(resolvedCommitment.proposalId);
        this.#proposalCommitments.clear();
        for (const [id, next] of nextCommitments) {
          this.#proposalCommitments.set(id, next);
        }
        this.#proposalReceipts.clear();
        for (const [id, next] of nextReceipts) {
          this.#proposalReceipts.set(id, next);
        }
        this.#changes.splice(0, this.#changes.length, ...nextChanges.changes);
        this.#changeSequence = nextChanges.sequence;
        this.#scheduleQuarantinePersistence();
        await this.flushQuarantinePersistence();
        return result;
      }),
    );
  }

  dirtyPaths(): readonly string[] {
    return [...this.#buffers.values()]
      .filter((state) => state.authority === "editor_dirty")
      .map((state) => state.path)
      .sort();
  }

  stalePaths(): readonly string[] {
    const paths = [...this.#buffers.values()]
      .filter((state) => state.authority === "stale_dirty")
      .map((state) => state.path)
      .sort();
    return this.#quarantineHydrationFailed && paths.length === 0
      ? [this.workspaceRoot]
      : paths;
  }

  loadedEditorPathConflict(
    path: string,
    options: { readonly includeDescendants?: boolean } = {},
  ): string | null {
    this.#expireLeaseIfNeeded();
    const lease = this.#lease;
    if (lease === null) return null;
    const target = this.resolvePath(path);
    for (const state of this.#buffers.values()) {
      // Stale entries are quarantined revisions, not buffers known to still
      // be loaded by the current editor. They are handled by the stronger
      // dirty/stale mutation conflict gate.
      if (state.epoch !== lease.epoch || state.authority === "stale_dirty") {
        continue;
      }
      if (
        state.path === target ||
        (options.includeDescendants === true &&
          isSameOrDescendantPath(target, state.path))
      ) {
        return state.path;
      }
    }
    return null;
  }

  hasActiveEditorLease(): boolean {
    this.#expireLeaseIfNeeded();
    return this.#lease !== null;
  }

  hasProtectedEditorPaths(): boolean {
    this.#expireLeaseIfNeeded();
    return (
      this.#quarantineHydrationFailed ||
      this.#lease !== null ||
      this.#hasProtectedBuffer() ||
      this.#topologyTokens.size > 0
    );
  }

  /**
   * A `disk_authoritative` buffer holds nothing an editor could lose: it says
   * the file on disk IS the truth, which is exactly what `authorityForPath`
   * reports for a path with no buffer entry at all. Counting those as
   * protection meant a TUI that died without releasing its lease left its
   * quarantine entries behind and, from the next daemon start on, every tool
   * in that workspace was refused with "Tool 'exec_command' is blocked while
   * this workspace has protected Editor authority" — with no live editor
   * anywhere and nothing at risk.
   *
   * `editor_dirty` (unsaved editor content) and `stale_dirty` (quarantined,
   * provenance unknown) still protect: a tool writing over either destroys
   * state that exists nowhere else. A live lease is handled by the caller.
   */
  #hasProtectedBuffer(): boolean {
    for (const state of this.#buffers.values()) {
      // Hydration rewrites every persisted entry to `stale_dirty` and keeps
      // what it actually was in `quarantinedFrom` — the same discriminator
      // #synchronize uses to decide whether a quarantined path was dirty.
      if (state.authority === "stale_dirty") {
        if (state.quarantinedFrom !== "disk_authoritative") return true;
        continue;
      }
      if (state.authority !== "disk_authoritative") return true;
    }
    return false;
  }

  #bufferConflictForTopologyTarget(
    target: WorkspaceTopologyMutationToken["targets"][number] & {
      readonly allowOwnedClean?: boolean;
    },
    editorLease: ActiveLease | null = null,
  ): string | null {
    const lease = this.#lease;
    for (const state of this.#buffers.values()) {
      const isQuarantined = state.authority === "stale_dirty";
      const isLoadedByActiveEditor =
        lease !== null &&
        state.epoch === lease.epoch &&
        state.authority !== "stale_dirty";
      const isAllowedOwnedClean =
        editorLease !== null &&
        target.allowOwnedClean === true &&
        state.epoch === editorLease.epoch &&
        state.editorInstanceId === editorLease.editorInstanceId &&
        state.authority === "disk_authoritative";
      if (
        (isQuarantined || isLoadedByActiveEditor) &&
        !isAllowedOwnedClean &&
        topologyTargetContainsPath(target, state.path)
      ) {
        return state.path;
      }
    }
    return null;
  }

  #topologyConflictForPath(
    path: string,
  ): WorkspaceTopologyMutationToken | null {
    for (const token of this.#topologyTokens.values()) {
      if (
        token.targets.some((target) => topologyTargetContainsPath(target, path))
      ) {
        return token;
      }
    }
    return null;
  }

  #topologyConflictForTarget(
    target: WorkspaceTopologyMutationToken["targets"][number],
  ): WorkspaceTopologyMutationToken | null {
    for (const token of this.#topologyTokens.values()) {
      if (
        token.targets.some((active) => topologyTargetsOverlap(active, target))
      ) {
        return token;
      }
    }
    return null;
  }

  #recordTopologyContention(
    token: WorkspaceTopologyMutationToken,
    path: string,
    beforeSha256: string,
  ): void {
    const current = this.#topologyIntents.get(token.tokenId);
    if (
      current === undefined ||
      current.contentions.some((contention) => contention.path === path)
    ) {
      return;
    }
    const intent: WorkspaceTopologyMutationIntent = {
      ...current,
      contentions: [...current.contentions, { path, beforeSha256 }],
    };
    const projectedIntents = new Map(this.#topologyIntents);
    projectedIntents.set(token.tokenId, intent);
    this.#ledger.assertQuarantineFits(
      this.#quarantineSnapshot({
        topologyIntents: projectedIntents,
      }),
    );
    // Persist the expanded fail-closed intent before checking whether all
    // completion events currently fit. If delivery capacity is exhausted,
    // the topology fence must remain unresolved rather than forgetting this
    // rejected Editor path.
    this.#topologyIntents.set(token.tokenId, intent);
    this.#scheduleQuarantinePersistence();
    // A topology effect can happen immediately after the rejected sync is
    // delivered, so reserve the exact reload-event representation now too.
    const projectedChanges = this.#projectChanges(
      intent.contentions.map((contention) => ({
        path: contention.path,
        source: intent.source,
        status: "unknown_outcome" as const,
        beforeSha256: contention.beforeSha256,
      })),
    );
    const completionIntents = new Map(projectedIntents);
    completionIntents.delete(token.tokenId);
    this.#ledger.assertQuarantineFits(
      this.#quarantineSnapshot({
        topologyIntents: completionIntents,
        changes: projectedChanges.changes,
        changeSequence: projectedChanges.sequence,
      }),
    );
  }

  #pendingTopologyReloadCount(): number {
    return [...this.#topologyIntents.values()].reduce(
      (total, intent) => total + intent.contentions.length,
      0,
    );
  }

  flushQuarantinePersistence(): Promise<void> {
    return this.#pendingQuarantinePersistence;
  }

  listChanges(
    input: WorkspaceEditorHeartbeatInput & { readonly afterSequence?: number },
  ): {
    readonly sequence: number;
    readonly changes: readonly WorkspaceChangeEvent[];
  } {
    this.#assertLease(input);
    const afterSequence =
      input.afterSequence !== undefined &&
      Number.isSafeInteger(input.afterSequence) &&
      input.afterSequence >= 0
        ? input.afterSequence
        : 0;
    if (afterSequence > 0 && afterSequence <= this.#changeSequence) {
      const retained = this.#changes.filter(
        (change) =>
          change.sequence > afterSequence ||
          (change.status === "proposed" &&
            change.proposalId !== undefined &&
            this.#proposalCommitments.has(change.proposalId)),
      );
      if (retained.length !== this.#changes.length) {
        this.#changes.splice(0, this.#changes.length, ...retained);
        this.#scheduleQuarantinePersistence();
      }
    }
    return {
      sequence: this.#changeSequence,
      changes: this.#changes.filter(
        (change) => change.sequence > afterSequence,
      ),
    };
  }

  resolvePath(path: string): string {
    const candidate = canonicalizePathSync(
      isAbsolute(path) ? resolve(path) : resolve(this.workspaceRoot, path),
    );
    const rel = relative(this.workspaceRoot, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_WORKSPACE",
        `path is outside workspace: ${path}`,
      );
    }
    return candidate;
  }

  async #serializeProposalResolution<Result>(
    proposalId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#proposalResolutionOperations.get(proposalId);
    // Publish the successor before waiting. If several callers arrive behind
    // one in-flight resolution they must form one chain, not all wake and run
    // concurrently when their shared predecessor settles.
    const running = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.#proposalResolutionOperations.set(proposalId, running);
    try {
      return await running;
    } finally {
      if (this.#proposalResolutionOperations.get(proposalId) === running) {
        this.#proposalResolutionOperations.delete(proposalId);
      }
    }
  }

  #serializeProposalState<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    // Admissions and resolutions project complete snapshots of commitments,
    // receipts, and the review feed before awaiting durable I/O. They must
    // therefore share one process-local transaction chain: per-proposal
    // serialization alone lets an unrelated admission restore a stale
    // snapshot after an apply/discard settles.
    const running = this.#mutationAdmissionTail.then(operation, operation);
    this.#mutationAdmissionTail = running.then(
      () => {},
      () => {},
    );
    return running;
  }

  #assertEditorTopologyToken(
    input: WorkspaceEditorTopologyMutationFinalizeInput,
  ): WorkspaceTopologyMutationToken {
    const lease = this.#assertLease(input);
    const token = this.#topologyTokens.get(input.tokenId);
    let owner = this.#editorTopologyOwners.get(input.tokenId);
    if (
      token !== undefined &&
      owner === undefined &&
      this.#recoveredTopologyTokens.has(input.tokenId)
    ) {
      owner = {
        editorInstanceId: lease.editorInstanceId,
        epoch: lease.epoch,
      };
      this.#editorTopologyOwners.set(input.tokenId, owner);
    }
    if (
      token === undefined ||
      owner === undefined ||
      owner.editorInstanceId !== lease.editorInstanceId ||
      owner.epoch !== lease.epoch
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "workspace path operation does not belong to the active editor lease",
      );
    }
    return token;
  }

  #rememberProposalCommitment(commitment: WorkspaceProposalCommitment): void {
    if (
      !this.#proposalCommitments.has(commitment.proposalId) &&
      this.#proposalCommitments.size >= this.#maxPendingProposals
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "Editor proposal capacity changed before the proposal could be committed",
      );
    }
    this.#proposalCommitments.delete(commitment.proposalId);
    this.#proposalCommitments.set(commitment.proposalId, commitment);
  }

  #assertLease(input: WorkspaceEditorHeartbeatInput): ActiveLease {
    this.#expireLeaseIfNeeded();
    if (canonicalizePathSync(input.workspaceRoot) !== this.workspaceRoot) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "editor lease belongs to a different durable workspace scope",
      );
    }
    const lease = this.#lease;
    if (lease === null) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_EXPIRED",
        "editor lease is not active",
      );
    }
    if (
      lease.editorInstanceId !== input.editorInstanceId ||
      lease.leaseToken !== input.leaseToken ||
      lease.epoch !== input.epoch
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "editor lease token, instance, or epoch does not match",
      );
    }
    return lease;
  }

  #expireLeaseIfNeeded(): void {
    if (this.#lease !== null && this.#now() >= this.#lease.expiresAt) {
      this.#quarantineLoadedBuffers(true);
      this.#orphanEditorTopologyTokens(this.#lease);
      this.#lease = null;
      this.#scheduleQuarantinePersistence();
    }
  }

  #quarantineLoadedBuffers(crossInstanceRecoveryAllowed: boolean): void {
    const epoch = this.#lease?.epoch;
    for (const [path, state] of this.#buffers) {
      if (
        state.authority === "stale_dirty" &&
        epoch !== undefined &&
        state.epoch === epoch &&
        state.crossInstanceRecoveryAllowed !== crossInstanceRecoveryAllowed
      ) {
        this.#buffers.set(path, {
          ...state,
          crossInstanceRecoveryAllowed,
          version: ++this.#authorityVersion,
        });
        continue;
      }
      if (
        state.authority !== "stale_dirty" &&
        (epoch === undefined || state.epoch === epoch)
      ) {
        this.#buffers.set(path, {
          ...state,
          authority: "stale_dirty",
          content: undefined,
          quarantinedFrom:
            state.authority === "disk_authoritative"
              ? "disk_authoritative"
              : "editor_dirty",
          crossInstanceRecoveryAllowed,
          version: ++this.#authorityVersion,
        });
      }
    }
  }

  #orphanEditorTopologyTokens(lease: ActiveLease): void {
    for (const [tokenId, owner] of this.#editorTopologyOwners) {
      if (
        owner.editorInstanceId === lease.editorInstanceId &&
        owner.epoch === lease.epoch
      ) {
        this.#editorTopologyOwners.delete(tokenId);
        if (this.#topologyTokens.has(tokenId)) {
          this.#recoveredTopologyTokens.add(tokenId);
        }
      }
    }
  }

  #leaseResult(lease: ActiveLease): WorkspaceEditorLease {
    return {
      workspaceRoot: this.workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: lease.sequence,
      expiresAt: lease.expiresAt,
    };
  }

  #recordChange(
    input: Omit<
      WorkspaceChangeEvent,
      "sequence" | "timestamp" | "workspaceRoot"
    >,
  ): void {
    const projected = this.#projectChanges([input]);
    this.#changes.splice(0, this.#changes.length, ...projected.changes);
    this.#changeSequence = projected.sequence;
  }

  #projectChanges(
    inputs: readonly Omit<
      WorkspaceChangeEvent,
      "sequence" | "timestamp" | "workspaceRoot"
    >[],
    base: {
      readonly changes?: readonly WorkspaceChangeEvent[];
      readonly sequence?: number;
    } = {},
  ): {
    readonly changes: readonly WorkspaceChangeEvent[];
    readonly sequence: number;
  } {
    const changes = [...(base.changes ?? this.#changes)];
    let sequence = base.sequence ?? this.#changeSequence;
    for (const input of inputs) {
      if (
        input.proposalId !== undefined &&
        (input.status === "applied" || input.status === "discarded")
      ) {
        // Once a proposal is durably resolved, its resolution event replaces
        // the discovery event. This keeps one bounded delivery slot per
        // unresolved commitment without orphaning source that still needs
        // review.
        for (let index = changes.length - 1; index >= 0; index -= 1) {
          const change = changes[index];
          if (
            change?.status === "proposed" &&
            change.proposalId === input.proposalId
          ) {
            changes.splice(index, 1);
          }
        }
      }
      const reloadChange = isEditorReloadChange(input);
      while (changes.length >= MAX_CHANGE_EVENTS) {
        const disposableIndex = changes.findIndex(
          (change) =>
            !isEditorReloadChange(change) && change.status !== "proposed",
        );
        if (disposableIndex >= 0) {
          changes.splice(disposableIndex, 1);
          continue;
        }
        if (!reloadChange) {
          return { changes, sequence };
        }
        throw new WorkspaceMutationCoordinatorError(
          "MUTATION_AUDIT_FAILED",
          "Editor has not acknowledged the pending workspace change queue",
        );
      }
      changes.push({
        sequence: ++sequence,
        timestamp: new Date(this.#now()).toISOString(),
        workspaceRoot: this.workspaceRoot,
        ...input,
      });
    }
    return { changes, sequence };
  }

  #hasProposalDeliveryCapacity(): boolean {
    return (
      this.#changes.length < MAX_CHANGE_EVENTS ||
      this.#changes.some(
        (change) =>
          !isEditorReloadChange(change) && change.status !== "proposed",
      )
    );
  }

  #assertProposalSize(path: string, content: string): void {
    const candidateBytes = Buffer.byteLength(content, "utf8");
    if (candidateBytes > MAX_BUFFER_BYTES) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        `Editor proposal exceeds ${MAX_BUFFER_BYTES} bytes: ${path}`,
      );
    }
    let totalBytes = candidateBytes;
    for (const state of this.#buffers.values()) {
      if (state.path !== path && state.authority !== "disk_authoritative") {
        totalBytes += state.contentBytes;
      }
    }
    if (totalBytes > MAX_SYNC_BYTES) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        `Editor proposal would exceed ${MAX_SYNC_BYTES} live dirty bytes`,
      );
    }
  }

  #quarantineSnapshot(
    overrides: {
      readonly buffers?: ReadonlyMap<string, EditorBufferState>;
      readonly proposalCommitments?: ReadonlyMap<
        string,
        WorkspaceProposalCommitment
      >;
      readonly proposalReceipts?: ReadonlyMap<string, WorkspaceProposalReceipt>;
      readonly mutationIntents?: ReadonlyMap<string, WorkspaceMutationIntent>;
      readonly topologyIntents?: ReadonlyMap<
        string,
        WorkspaceTopologyMutationIntent
      >;
      readonly changes?: readonly WorkspaceChangeEvent[];
      readonly changeSequence?: number;
    } = {},
  ): WorkspaceQuarantineSnapshot {
    const buffers = overrides.buffers ?? this.#buffers;
    const proposalCommitments =
      overrides.proposalCommitments ?? this.#proposalCommitments;
    const proposalReceipts =
      overrides.proposalReceipts ?? this.#proposalReceipts;
    const mutationIntents = overrides.mutationIntents ?? this.#mutationIntents;
    const topologyIntents = overrides.topologyIntents ?? this.#topologyIntents;
    return {
      entries: [...buffers.values()]
        // Persist every loaded revision identity, never source text. A hard
        // daemon crash can land between a local keystroke and the next sync,
        // so even the last-known-clean loaded paths must restart quarantined.
        .map((state) => ({
          path: state.path,
          contentSha256: state.contentSha256,
          contentBytes: state.contentBytes,
          changedtick: state.changedtick,
          epoch: state.epoch,
          editorInstanceId: state.editorInstanceId,
          authority:
            state.authority === "stale_dirty"
              ? (state.quarantinedFrom ?? "editor_dirty")
              : state.authority,
        })),
      proposalCommitments: [...proposalCommitments.values()],
      proposalReceipts: [...proposalReceipts.entries()].map(
        ([proposalId, receipt]) =>
          receipt.action === "applied"
            ? {
                proposalId,
                action: receipt.action,
                path: receipt.result.path,
                changedtick: receipt.changedtick,
                contentSha256: receipt.contentSha256,
              }
            : {
                proposalId,
                action: receipt.action,
                path: receipt.result.path,
              },
      ),
      mutationIntents: [...mutationIntents.values()],
      topologyIntents: [...topologyIntents.values()],
      changeSequence: overrides.changeSequence ?? this.#changeSequence,
      changes: overrides.changes ?? this.#changes,
    };
  }

  async #persistQuarantine(): Promise<void> {
    if (this.#quarantineHydrationFailed) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace quarantine is unreadable or unsafe; explicitly abandon dirty quarantine before replacing it",
      );
    }
    await this.#ledger.writeQuarantine(this.#quarantineSnapshot());
  }

  #scheduleQuarantineSnapshot(
    snapshot: WorkspaceQuarantineSnapshot,
  ): Promise<void> {
    const pending = this.#ledger.writeQuarantine(snapshot);
    this.#pendingQuarantinePersistence = pending;
    void pending.catch(() => {});
    return pending;
  }

  #scheduleQuarantinePersistence(): void {
    const pending = this.#persistQuarantine();
    this.#pendingQuarantinePersistence = pending;
    // Preserve the rejected promise for the next daemon/mutation boundary,
    // while preventing an unhandled rejection if no boundary arrives before
    // process shutdown.
    void pending.catch(() => {});
  }

  #hydrateQuarantine(value: unknown): boolean {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      typeof value.workspaceRoot !== "string" ||
      canonicalizePathSync(value.workspaceRoot) !== this.workspaceRoot ||
      !Array.isArray(value.entries) ||
      value.entries.length > MAX_SYNCED_BUFFERS ||
      (value.proposalCommitments !== undefined &&
        (!Array.isArray(value.proposalCommitments) ||
          value.proposalCommitments.length > MAX_PENDING_PROPOSALS)) ||
      (value.proposalReceipts !== undefined &&
        (!Array.isArray(value.proposalReceipts) ||
          value.proposalReceipts.length > MAX_PROPOSAL_RECEIPTS)) ||
      (value.mutationIntents !== undefined &&
        (!Array.isArray(value.mutationIntents) ||
          value.mutationIntents.length > MAX_CHANGE_EVENTS)) ||
      (value.topologyIntents !== undefined &&
        (!Array.isArray(value.topologyIntents) ||
          value.topologyIntents.length > MAX_CHANGE_EVENTS)) ||
      (value.changeSequence !== undefined &&
        !isNonNegativeSafeInteger(value.changeSequence)) ||
      (value.changes !== undefined &&
        (!Array.isArray(value.changes) ||
          value.changes.length > MAX_CHANGE_EVENTS))
    ) {
      throw new Error("invalid workspace quarantine");
    }
    const hydrated = new Map<string, EditorBufferState>();
    let nextAuthorityVersion = this.#authorityVersion;
    for (const candidate of value.entries) {
      if (
        !isRecord(candidate) ||
        typeof candidate.path !== "string" ||
        !isAbsolute(candidate.path) ||
        typeof candidate.contentSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(candidate.contentSha256) ||
        !isNonNegativeSafeInteger(candidate.contentBytes) ||
        candidate.contentBytes > MAX_BUFFER_BYTES ||
        !Number.isSafeInteger(candidate.changedtick) ||
        (candidate.changedtick as number) < 0 ||
        !Number.isSafeInteger(candidate.epoch) ||
        (candidate.epoch as number) < 1 ||
        !isValidPersistedIdentifier(candidate.editorInstanceId) ||
        (candidate.authority !== undefined &&
          candidate.authority !== "disk_authoritative" &&
          candidate.authority !== "editor_dirty")
      ) {
        throw new Error("invalid workspace quarantine entry");
      }
      const path = this.resolvePath(candidate.path);
      if (hydrated.has(path)) {
        throw new Error("duplicate workspace quarantine entry");
      }
      hydrated.set(path, {
        path,
        bufferHandle: 0,
        changedtick: candidate.changedtick as number,
        contentSha256: candidate.contentSha256,
        contentBytes: candidate.contentBytes,
        authority: "stale_dirty",
        epoch: candidate.epoch as number,
        editorInstanceId: candidate.editorInstanceId,
        quarantinedFrom:
          candidate.authority === "disk_authoritative"
            ? "disk_authoritative"
            : "editor_dirty",
        crossInstanceRecoveryAllowed: true,
        version: ++nextAuthorityVersion,
      });
    }
    this.#authorityVersion = nextAuthorityVersion;
    for (const [path, state] of hydrated) this.#buffers.set(path, state);

    const commitments = value.proposalCommitments ?? [];
    for (const candidate of commitments) {
      if (
        !isRecord(candidate) ||
        !isValidPersistedIdentifier(candidate.proposalId) ||
        typeof candidate.path !== "string" ||
        !isAbsolute(candidate.path) ||
        !isWorkspaceMutationSource(candidate.source) ||
        !isSha256Digest(candidate.baseContentSha256) ||
        !isSha256Digest(candidate.afterContentSha256) ||
        !isNonNegativeSafeInteger(candidate.baseChangedtick) ||
        !isNonNegativeSafeInteger(candidate.bufferHandle) ||
        (candidate.acceptedChangedtick !== undefined &&
          !isNonNegativeSafeInteger(candidate.acceptedChangedtick))
      ) {
        throw new Error("invalid workspace proposal commitment");
      }
      const proposalId = candidate.proposalId;
      const path = this.resolvePath(candidate.path);
      if (this.#proposalCommitments.has(proposalId)) {
        throw new Error("duplicate workspace proposal commitment");
      }
      this.#proposalCommitments.set(proposalId, {
        proposalId,
        path,
        source: candidate.source,
        baseContentSha256: candidate.baseContentSha256,
        afterContentSha256: candidate.afterContentSha256,
        baseChangedtick: candidate.baseChangedtick,
        bufferHandle: candidate.bufferHandle,
        ...(candidate.acceptedChangedtick !== undefined
          ? { acceptedChangedtick: candidate.acceptedChangedtick }
          : {}),
      });
    }

    const receipts = value.proposalReceipts ?? [];
    for (const candidate of receipts) {
      if (
        !isRecord(candidate) ||
        !isValidPersistedIdentifier(candidate.proposalId) ||
        typeof candidate.path !== "string" ||
        !isAbsolute(candidate.path) ||
        (candidate.action !== "applied" && candidate.action !== "discarded")
      ) {
        throw new Error("invalid workspace proposal receipt");
      }
      const proposalId = candidate.proposalId;
      const path = this.resolvePath(candidate.path);
      if (
        this.#proposalReceipts.has(proposalId) ||
        this.#proposalCommitments.has(proposalId)
      ) {
        throw new Error("duplicate workspace proposal resolution");
      }
      if (candidate.action === "applied") {
        if (
          !isNonNegativeSafeInteger(candidate.changedtick) ||
          !isSha256Digest(candidate.contentSha256)
        ) {
          throw new Error("invalid applied workspace proposal receipt");
        }
        this.#proposalReceipts.set(proposalId, {
          action: "applied",
          changedtick: candidate.changedtick,
          contentSha256: candidate.contentSha256,
          result: {
            applied: true,
            proposalId,
            path,
            changedtick: candidate.changedtick,
            contentSha256: candidate.contentSha256,
          },
        });
      } else {
        this.#proposalReceipts.set(proposalId, {
          action: "discarded",
          result: {
            discarded: true,
            proposalId,
            path,
          },
        });
      }
    }

    const changeSequence = value.changeSequence ?? 0;
    const changes = value.changes ?? [];
    let previousSequence = 0;
    for (const candidate of changes) {
      if (
        !isRecord(candidate) ||
        !isPositiveSafeInteger(candidate.sequence) ||
        candidate.sequence <= previousSequence ||
        candidate.sequence > changeSequence ||
        typeof candidate.timestamp !== "string" ||
        Number.isNaN(Date.parse(candidate.timestamp)) ||
        typeof candidate.workspaceRoot !== "string" ||
        canonicalizePathSync(candidate.workspaceRoot) !== this.workspaceRoot ||
        typeof candidate.path !== "string" ||
        !isAbsolute(candidate.path) ||
        !isWorkspaceMutationSource(candidate.source) ||
        !isWorkspaceChangeStatus(candidate.status) ||
        !isSha256Digest(candidate.beforeSha256) ||
        (candidate.afterSha256 !== undefined &&
          !isSha256Digest(candidate.afterSha256)) ||
        (candidate.proposalId !== undefined &&
          !isValidPersistedIdentifier(candidate.proposalId))
      ) {
        throw new Error("invalid persisted workspace change");
      }
      const path = this.resolvePath(candidate.path);
      this.#changes.push({
        sequence: candidate.sequence,
        timestamp: candidate.timestamp,
        workspaceRoot: this.workspaceRoot,
        path,
        source: candidate.source,
        status: candidate.status,
        beforeSha256: candidate.beforeSha256,
        ...(candidate.afterSha256 !== undefined
          ? { afterSha256: candidate.afterSha256 }
          : {}),
        ...(candidate.proposalId !== undefined
          ? { proposalId: candidate.proposalId }
          : {}),
      });
      previousSequence = candidate.sequence;
    }
    this.#changeSequence = changeSequence;

    const mutationIntents = value.mutationIntents ?? [];
    for (const candidate of mutationIntents) {
      if (
        !isRecord(candidate) ||
        !isValidPersistedIdentifier(candidate.tokenId) ||
        typeof candidate.path !== "string" ||
        !isAbsolute(candidate.path) ||
        !isWorkspaceMutationSource(candidate.source) ||
        !isSha256Digest(candidate.beforeSha256) ||
        !isSha256Digest(candidate.intendedAfterSha256)
      ) {
        throw new Error("invalid workspace mutation intent");
      }
      this.#recordChange({
        path: this.resolvePath(candidate.path),
        source: candidate.source,
        status: "unknown_outcome",
        beforeSha256: candidate.beforeSha256,
        afterSha256: candidate.intendedAfterSha256,
      });
    }

    const topologyIntents = value.topologyIntents ?? [];
    for (const candidate of topologyIntents) {
      if (
        !isRecord(candidate) ||
        !isValidPersistedIdentifier(candidate.tokenId) ||
        !isWorkspaceMutationSource(candidate.source) ||
        !Array.isArray(candidate.targets) ||
        candidate.targets.length === 0 ||
        !Array.isArray(candidate.contentions) ||
        candidate.contentions.length > MAX_SYNCED_BUFFERS
      ) {
        throw new Error("invalid workspace topology mutation intent");
      }
      const targets = candidate.targets.map((target) => {
        if (
          !isRecord(target) ||
          typeof target.path !== "string" ||
          !isAbsolute(target.path) ||
          typeof target.includeDescendants !== "boolean"
        ) {
          throw new Error("invalid workspace topology mutation target");
        }
        return {
          path: this.resolvePath(target.path),
          includeDescendants: target.includeDescendants,
        };
      });
      if (
        this.#topologyIntents.has(candidate.tokenId) ||
        this.#topologyTokens.has(candidate.tokenId)
      ) {
        throw new Error("duplicate workspace topology mutation intent");
      }
      const seenContentions = new Set<string>();
      const contentions: WorkspaceTopologyMutationIntent["contentions"][number][] =
        [];
      for (const contention of candidate.contentions) {
        if (
          !isRecord(contention) ||
          typeof contention.path !== "string" ||
          !isAbsolute(contention.path) ||
          !isSha256Digest(contention.beforeSha256)
        ) {
          throw new Error("invalid workspace topology contention");
        }
        const path = this.resolvePath(contention.path);
        if (
          seenContentions.has(path) ||
          !targets.some((target) => topologyTargetContainsPath(target, path))
        ) {
          throw new Error("invalid workspace topology contention path");
        }
        seenContentions.add(path);
        contentions.push({
          path,
          beforeSha256: contention.beforeSha256,
        });
      }
      const intent: WorkspaceTopologyMutationIntent = {
        tokenId: candidate.tokenId,
        source: candidate.source,
        targets,
        contentions,
      };
      const token: WorkspaceTopologyMutationToken = {
        tokenId: candidate.tokenId,
        workspaceRoot: this.workspaceRoot,
        targets,
        source: candidate.source,
        createdAt: this.#now(),
      };
      this.#topologyIntents.set(intent.tokenId, intent);
      this.#topologyTokens.set(token.tokenId, token);
      this.#recoveredTopologyTokens.add(token.tokenId);
    }
    return mutationIntents.length > 0;
  }
}

function readPersistedWorkspaceRoot(quarantinePath: string): string {
  const descriptor = openSync(quarantinePath, "r");
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > MAX_QUARANTINE_BYTES
    ) {
      throw new Error(`invalid workspace quarantine: ${quarantinePath}`);
    }
    const prefix = Buffer.allocUnsafe(
      Math.min(before.size, MAX_QUARANTINE_ROOT_PREFIX_BYTES),
    );
    let offset = 0;
    while (offset < prefix.byteLength) {
      const bytesRead = readSync(
        descriptor,
        prefix,
        offset,
        prefix.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size) {
      throw new Error(
        `workspace quarantine changed during discovery: ${quarantinePath}`,
      );
    }
    const match = /"workspaceRoot":("(?:[^"\\]|\\.)*")/u.exec(
      prefix.subarray(0, offset).toString("utf8"),
    );
    if (match?.[1] === undefined) {
      throw new Error(
        `workspace quarantine is missing its root: ${quarantinePath}`,
      );
    }
    const workspaceRoot = JSON.parse(match[1]) as unknown;
    if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) {
      throw new Error(
        `workspace quarantine has an invalid root: ${quarantinePath}`,
      );
    }
    return workspaceRoot;
  } finally {
    closeSync(descriptor);
  }
}

type PersistedWorkspaceRootDiscovery =
  | {
      readonly kind: "verified";
      readonly workspaceRoot: string;
    }
  | {
      readonly kind: "unresolved";
      readonly directoryName: string;
      readonly persistedWorkspaceRoot: string;
    };

function inspectPersistedWorkspaceRoot(
  directory: string,
  directoryName: string,
): PersistedWorkspaceRootDiscovery | null {
  const quarantinePath = join(directory, directoryName, "quarantine-v1.json");
  if (!existsSync(quarantinePath)) return null;
  const persistedWorkspaceRoot = readPersistedWorkspaceRoot(quarantinePath);
  const persistedKey = createHash("sha256")
    .update(persistedWorkspaceRoot)
    .digest("hex")
    .slice(0, 32);
  if (!persistedWorkspaceRootWithinBounds(resolve(persistedWorkspaceRoot))) {
    throw new Error(
      `workspace quarantine path identity changed: ${directoryName}`,
    );
  }
  const workspaceRoot = canonicalPersistedWorkspaceRoot(persistedWorkspaceRoot);
  if (workspaceRoot === null) {
    let observedKey: string | null = null;
    try {
      observedKey = createHash("sha256")
        .update(canonicalizePathSync(persistedWorkspaceRoot))
        .digest("hex")
        .slice(0, 32);
    } catch {
      // Preserve the persisted spelling as the only available identity. A
      // later operation that may overlap it will still fail closed below.
    }
    if (directoryName !== persistedKey && directoryName !== observedKey) {
      throw new Error(
        `workspace quarantine root does not match its directory: ${directoryName}`,
      );
    }
    return {
      kind: "unresolved",
      directoryName,
      persistedWorkspaceRoot,
    };
  }
  const runtimeKey = createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 32);
  if (directoryName !== persistedKey && directoryName !== runtimeKey) {
    throw new Error(
      `workspace quarantine root does not match its directory: ${directoryName}`,
    );
  }
  if (runtimeKey !== directoryName) {
    const legacyDirectory = join(directory, directoryName);
    const runtimeDirectory = join(directory, runtimeKey);
    if (existsSync(runtimeDirectory)) {
      throw new Error(
        `workspace quarantine normalization collides with existing state: ${runtimeKey}`,
      );
    }
    renameSync(legacyDirectory, runtimeDirectory);
    const descriptor = openSync(directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  return { kind: "verified", workspaceRoot };
}

function discoverPersistedWorkspaceRoots(
  agencHome: string,
): PersistedWorkspaceRootDiscovery[] {
  const directory = join(agencHome, "workspace-mutations");
  const entries = (() => {
    try {
      return readdirSync(directory, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  })();
  if (entries.length > MAX_PERSISTED_QUARANTINE_DIRECTORIES) {
    throw new Error(
      `workspace quarantine directory exceeds ${MAX_PERSISTED_QUARANTINE_DIRECTORIES} entries`,
    );
  }

  const roots: PersistedWorkspaceRootDiscovery[] = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]{32}$/u.test(entry.name)) continue;
    const quarantinePath = join(directory, entry.name, "quarantine-v1.json");
    if (!existsSync(quarantinePath)) continue;
    if (!entry.isDirectory()) {
      throw new Error(`unsafe workspace quarantine directory: ${entry.name}`);
    }
    const root = inspectPersistedWorkspaceRoot(directory, entry.name);
    if (root !== null) roots.push(root);
  }
  return roots;
}

function persistedWorkspaceAuthorityFailure(
  error: unknown,
): WorkspaceMutationCoordinatorError {
  return new WorkspaceMutationCoordinatorError(
    "EDITOR_LEASE_EXPIRED",
    `Cannot verify persisted Editor authority: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function unresolvedPersistedWorkspaceRootMayOverlap(
  target: string,
  persistedWorkspaceRoot: string,
): boolean {
  const persistedIdentity = normalizePathIdentity(persistedWorkspaceRoot);
  if (workspaceRootsOverlap(target, persistedIdentity)) return true;
  try {
    return workspaceRootsOverlap(
      target,
      canonicalizePathSync(persistedWorkspaceRoot),
    );
  } catch {
    // If the current identity cannot be observed, retain the original
    // fail-closed behavior because the record cannot be proven unrelated.
    return true;
  }
}

export class WorkspaceMutationCoordinatorRegistry {
  readonly #coordinators = new Map<string, WorkspaceMutationCoordinator>();
  readonly #probedQuarantineKeys = new Set<string>();
  readonly #persistedWorkspaceRootsByHome = new Map<
    string,
    PersistedWorkspaceRootDiscovery[]
  >();
  readonly #persistedWorkspaceRootScanFailures = new Map<string, Error>();
  readonly #toolOperations = new Map<string, WorkspaceToolOperationToken>();
  readonly #options: {
    readonly agencHome?: string;
    readonly now?: () => number;
    readonly leaseTtlMs?: number;
  };

  constructor(
    options: {
      readonly agencHome?: string;
      readonly now?: () => number;
      readonly leaseTtlMs?: number;
    } = {},
  ) {
    this.#options = options;
  }

  getOrCreate(workspaceRoot: string): WorkspaceMutationCoordinator {
    const root = canonicalizePathSync(workspaceRoot);
    this.#hydratePersistedCoordinatorsOverlapping(root);
    return this.#getOrCreateCanonical(root);
  }

  #getOrCreateCanonical(root: string): WorkspaceMutationCoordinator {
    let coordinator = this.#coordinators.get(root);
    if (coordinator === undefined) {
      coordinator = new WorkspaceMutationCoordinator({
        workspaceRoot: root,
        ...this.#options,
      });
      this.#coordinators.set(root, coordinator);
    }
    return coordinator;
  }

  /**
   * Resolve a token back to the exact coordinator identity that issued it.
   *
   * Token roots are canonical when minted. Re-running realpath here would let
   * a later ancestor symlink exchange redirect commit/cancel/reconciliation
   * to another workspace after the filesystem effect already happened.
   */
  findForWorkspaceRootIdentity(
    workspaceRoot: string,
  ): WorkspaceMutationCoordinator | null {
    return this.#coordinators.get(normalizePathIdentity(workspaceRoot)) ?? null;
  }

  findForPath(path: string): WorkspaceMutationCoordinator | null {
    const target = canonicalizePathSync(path);
    this.#hydratePersistedCoordinatorsOverlapping(target);
    let bestAuthoritative: WorkspaceMutationCoordinator | null = null;
    let bestProtected: WorkspaceMutationCoordinator | null = null;
    let bestContaining: WorkspaceMutationCoordinator | null = null;
    for (const coordinator of this.#coordinators.values()) {
      const rel = relative(coordinator.workspaceRoot, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        continue;
      }
      if (
        bestContaining === null ||
        coordinator.workspaceRoot.length > bestContaining.workspaceRoot.length
      ) {
        bestContaining = coordinator;
      }
      if (
        coordinator.hasProtectedEditorPaths() &&
        (bestProtected === null ||
          coordinator.workspaceRoot.length > bestProtected.workspaceRoot.length)
      ) {
        bestProtected = coordinator;
      }
      if (
        coordinator.authorityForPath(target) !== "disk_authoritative" &&
        (bestAuthoritative === null ||
          coordinator.workspaceRoot.length >
            bestAuthoritative.workspaceRoot.length)
      ) {
        bestAuthoritative = coordinator;
      }
    }
    // A nested, clean coordinator must never shadow protected authority owned
    // by an ancestor workspace. Prefer exact dirty/stale authority first,
    // followed by any containing protected Editor workspace, then the ordinary
    // most-specific coordinator.
    return bestAuthoritative ?? bestProtected ?? bestContaining;
  }

  findOverlappingPathIdentities(
    path: string,
    options: { readonly includeDescendants?: boolean } = {},
  ): readonly WorkspaceMutationCoordinator[] {
    // The caller supplies the identity captured at admission. Re-running
    // realpath here would move the snapshot fence after a pathname exchange.
    const target = normalizePathIdentity(path);
    return [...this.#coordinators.values()]
      .filter((coordinator) => {
        const targetRelativeToCoordinator = relative(
          coordinator.workspaceRoot,
          target,
        );
        if (
          targetRelativeToCoordinator !== ".." &&
          !targetRelativeToCoordinator.startsWith(`..${sep}`) &&
          !isAbsolute(targetRelativeToCoordinator)
        ) {
          return true;
        }
        if (options.includeDescendants !== true) return false;
        const coordinatorRelativeToTarget = relative(
          target,
          coordinator.workspaceRoot,
        );
        return (
          coordinatorRelativeToTarget !== ".." &&
          !coordinatorRelativeToTarget.startsWith(`..${sep}`) &&
          !isAbsolute(coordinatorRelativeToTarget)
        );
      })
      .sort((left, right) =>
        left.workspaceRoot.localeCompare(right.workspaceRoot),
      );
  }

  acquireEditor(
    workspaceRoot: string,
    input: WorkspaceEditorAcquireInput,
  ): WorkspaceEditorLease {
    const root = canonicalizePathSync(workspaceRoot);
    // A pathname-only overlap check is insufficient while an admitted tool
    // keeps a directory inode alive: the directory can be renamed and reached
    // through a new pathname before the tool releases its descriptor. Fence
    // all new Editor authority during that short operation window so no
    // topology exchange can create an unobserved nested coordinator.
    const crossingOperation = this.#toolOperations.values().next().value as
      | WorkspaceToolOperationToken
      | undefined;
    if (crossingOperation !== undefined) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_CONFLICT",
        `Editor is waiting for active tool '${crossingOperation.toolName}' to finish before it can own this workspace`,
      );
    }
    this.#hydratePersistedCoordinatorsOverlapping(root);
    const overlappingEditor = [...this.#coordinators.values()].find(
      (coordinator) =>
        coordinator.workspaceRoot !== root &&
        workspaceRootsOverlap(root, coordinator.workspaceRoot) &&
        coordinator.hasProtectedEditorPaths(),
    );
    if (overlappingEditor !== undefined) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_CONFLICT",
        `Editor cannot own ${root}: it overlaps protected Editor authority at ${overlappingEditor.workspaceRoot}`,
      );
    }
    if (
      input.requireUnprotectedWorkspace === true &&
      this.hasProtectedEditorAuthority(root)
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_CONFLICT",
        "Shell execution is blocked because this workspace has protected Editor authority. Reconnect or explicitly abandon the Editor workspace before running Bash.",
      );
    }
    return this.getOrCreate(root).acquire(input);
  }

  beginToolOperation(
    workspaceRoot: string,
    toolName: string,
  ): WorkspaceToolOperationToken {
    const root = canonicalizePathSync(workspaceRoot);
    if (this.hasProtectedEditorAuthority(root)) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_CONFLICT",
        `Tool '${toolName}' is blocked while this workspace has protected Editor authority`,
      );
    }
    const token: WorkspaceToolOperationToken = {
      tokenId: randomUUID(),
      workspacePath: normalizePathIdentity(workspaceRoot),
      workspaceRoot: root,
      toolName,
    };
    this.#toolOperations.set(token.tokenId, token);
    return token;
  }

  beginReadToolOperation(
    workspaceRoot: string,
    toolName: string,
  ): WorkspaceReadToolOperation {
    const root = canonicalizePathSync(workspaceRoot);
    const requiresStrictCandidateReads =
      this.hasProtectedEditorAuthority(root);
    const token: WorkspaceToolOperationToken = {
      tokenId: randomUUID(),
      workspacePath: normalizePathIdentity(workspaceRoot),
      workspaceRoot: root,
      toolName,
    };
    this.#toolOperations.set(token.tokenId, token);
    return { token, requiresStrictCandidateReads };
  }

  endToolOperation(token: WorkspaceToolOperationToken): void {
    const current = this.#toolOperations.get(token.tokenId);
    if (
      current?.workspaceRoot === token.workspaceRoot &&
      current.workspacePath === token.workspacePath &&
      current.toolName === token.toolName
    ) {
      this.#toolOperations.delete(token.tokenId);
    }
  }

  hasProtectedEditorAuthority(path: string): boolean {
    const target = canonicalizePathSync(path);
    this.#hydratePersistedCoordinatorsOverlapping(target);
    return [...this.#coordinators.values()].some(
      (coordinator) =>
        workspaceRootsOverlap(target, coordinator.workspaceRoot) &&
        coordinator.hasProtectedEditorPaths(),
    );
  }

  clearForTests(): void {
    this.#coordinators.clear();
    this.#probedQuarantineKeys.clear();
    this.#persistedWorkspaceRootsByHome.clear();
    this.#persistedWorkspaceRootScanFailures.clear();
    this.#toolOperations.clear();
  }

  #hydratePersistedCoordinatorsOverlapping(target: string): void {
    this.#hydratePersistedCoordinatorForPath(target);
    const agencHome = resolve(
      this.#options.agencHome ?? resolveAgencHome(process.env),
    );
    const previousFailure =
      this.#persistedWorkspaceRootScanFailures.get(agencHome);
    if (previousFailure !== undefined) {
      throw previousFailure;
    }

    let persistedRoots = this.#persistedWorkspaceRootsByHome.get(agencHome);
    if (persistedRoots === undefined) {
      try {
        persistedRoots = discoverPersistedWorkspaceRoots(agencHome);
        this.#persistedWorkspaceRootsByHome.set(agencHome, persistedRoots);
      } catch (error) {
        const failure = persistedWorkspaceAuthorityFailure(error);
        this.#persistedWorkspaceRootScanFailures.set(agencHome, failure);
        throw failure;
      }
    }
    const directory = join(agencHome, "workspace-mutations");
    for (let index = 0; index < persistedRoots.length; index += 1) {
      let discovered = persistedRoots[index];
      if (discovered === undefined) continue;
      if (discovered.kind === "unresolved") {
        if (
          !unresolvedPersistedWorkspaceRootMayOverlap(
            target,
            discovered.persistedWorkspaceRoot,
          )
        ) {
          continue;
        }
        try {
          const refreshed = inspectPersistedWorkspaceRoot(
            directory,
            discovered.directoryName,
          );
          if (refreshed === null) {
            persistedRoots.splice(index, 1);
            index -= 1;
            continue;
          }
          persistedRoots[index] = refreshed;
          discovered = refreshed;
        } catch (error) {
          throw persistedWorkspaceAuthorityFailure(error);
        }
        if (discovered.kind === "unresolved") {
          throw persistedWorkspaceAuthorityFailure(
            new Error(
              `workspace quarantine path identity changed: ${discovered.directoryName}`,
            ),
          );
        }
      }
      if (workspaceRootsOverlap(target, discovered.workspaceRoot)) {
        this.#getOrCreateCanonical(discovered.workspaceRoot);
      }
    }
  }

  #hydratePersistedCoordinatorForPath(target: string): void {
    const agencHome = this.#options.agencHome ?? resolveAgencHome(process.env);
    let candidate = target;
    for (;;) {
      const key = createHash("sha256")
        .update(candidate)
        .digest("hex")
        .slice(0, 32);
      const probeKey = `${resolve(agencHome)}\0${key}`;
      if (!this.#probedQuarantineKeys.has(probeKey)) {
        this.#probedQuarantineKeys.add(probeKey);
        const quarantinePath = join(
          resolve(agencHome),
          "workspace-mutations",
          key,
          "quarantine-v1.json",
        );
        if (existsSync(quarantinePath)) {
          this.#getOrCreateCanonical(candidate);
        }
      }
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
}

class WorkspaceChangeLedger {
  readonly #workspaceRoot: string;
  readonly #directory: string;
  readonly #ledgerPath: string;
  readonly #quarantinePath: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: {
    readonly workspaceRoot: string;
    readonly agencHome: string;
  }) {
    this.#workspaceRoot = input.workspaceRoot;
    const key = createHash("sha256")
      .update(input.workspaceRoot)
      .digest("hex")
      .slice(0, 32);
    this.#directory = join(
      resolve(input.agencHome),
      "workspace-mutations",
      key,
    );
    this.#ledgerPath = join(this.#directory, "ledger-v1.jsonl");
    this.#quarantinePath = join(this.#directory, "quarantine-v1.json");
  }

  append(
    input: Omit<
      WorkspaceChangeLedgerEntry,
      "version" | "entryId" | "timestamp" | "workspaceRoot"
    >,
  ): Promise<void> {
    const entry: WorkspaceChangeLedgerEntry = {
      version: 1,
      entryId: randomUUID(),
      timestamp: new Date().toISOString(),
      workspaceRoot: this.#workspaceRoot,
      ...input,
    };
    return this.#serialize(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await appendFile(this.#ledgerPath, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const handle = await open(this.#ledgerPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  assertQuarantineFits(input: WorkspaceQuarantineSnapshot): void {
    this.#serializeQuarantine(input);
  }

  writeQuarantine(input: WorkspaceQuarantineSnapshot): Promise<void> {
    const serialized = this.#serializeQuarantine(input);
    return this.#serialize(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const temp = `${this.#quarantinePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, serialized, { encoding: "utf8", mode: 0o600 });
      const fileHandle = await open(temp, "r+");
      try {
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      await rename(temp, this.#quarantinePath);
      await fsyncDirectory(this.#directory);
    });
  }

  #serializeQuarantine(input: WorkspaceQuarantineSnapshot): string {
    const serialized = `${JSON.stringify({
      version: 1,
      workspaceRoot: this.#workspaceRoot,
      entries: input.entries,
      proposalCommitments: input.proposalCommitments,
      proposalReceipts: input.proposalReceipts,
      mutationIntents: input.mutationIntents,
      topologyIntents: input.topologyIntents,
      changeSequence: input.changeSequence,
      changes: input.changes,
    })}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_QUARANTINE_BYTES) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        `workspace quarantine exceeds ${MAX_QUARANTINE_BYTES} bytes`,
      );
    }
    return serialized;
  }

  readQuarantine(): unknown | null {
    let descriptor: number;
    try {
      descriptor = openSync(this.#quarantinePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const size = fstatSync(descriptor).size;
      if (size > MAX_QUARANTINE_BYTES) {
        throw new Error("workspace quarantine exceeds size limit");
      }
      const raw = Buffer.allocUnsafe(
        Math.min(MAX_QUARANTINE_BYTES + 1, Math.max(1, size + 1)),
      );
      let offset = 0;
      while (offset < raw.byteLength) {
        const bytesRead = readSync(
          descriptor,
          raw,
          offset,
          raw.byteLength - offset,
          null,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_QUARANTINE_BYTES) {
        throw new Error("workspace quarantine exceeds size limit");
      }
      return JSON.parse(raw.subarray(0, offset).toString("utf8")) as unknown;
    } finally {
      closeSync(descriptor);
    }
  }

  #serialize(task: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export const workspaceMutationCoordinators =
  new WorkspaceMutationCoordinatorRegistry();

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function boundedDiskSha256Sync(path: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_BUFFER_BYTES) return null;
    const content = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const bytesRead = readSync(
        descriptor,
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size) return null;
    return createHash("sha256")
      .update(content.subarray(0, offset))
      .digest("hex");
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

function canonicalizePathSync(path: string): string {
  const resolved = resolve(path);
  const missingSegments: string[] = [];
  let cursor = resolved;
  for (;;) {
    try {
      const canonicalParent = realpathSync.native(cursor);
      return normalizePathIdentity(
        resolve(canonicalParent, ...missingSegments.reverse()),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) return normalizePathIdentity(resolved);
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

function normalizePathIdentity(path: string): string {
  const resolved = resolve(path);
  // POSIX pathname spelling is identity unless realpath above proved an alias.
  // This includes normalization-sensitive filesystems mounted on macOS.
  return process.platform === "win32" ? resolved.normalize("NFC") : resolved;
}

function canonicalPersistedWorkspaceRoot(path: string): string | null {
  const resolved = resolve(path);
  try {
    if (!persistedWorkspaceRootWithinBounds(resolved)) return null;
    // A persisted spelling may be an APFS normalization alias, but a symlink
    // replacement is not continuity of the workspace that owned the state.
    const beforePrefixes = snapshotPathPrefixesSync(resolved);
    if (beforePrefixes === null) return null;
    const beforeLeaf = beforePrefixes[beforePrefixes.length - 1];
    if (beforeLeaf === undefined || !beforeLeaf.isDirectory) return null;
    const canonical = normalizePathIdentity(realpathSync.native(resolved));
    const requestedIdentity = statSync(resolved, { bigint: true });
    const canonicalIdentity = statSync(canonical, { bigint: true });
    if (
      !statMatchesPathPrefixIdentity(requestedIdentity, beforeLeaf) ||
      !statMatchesPathPrefixIdentity(canonicalIdentity, beforeLeaf) ||
      !requestedIdentity.isDirectory() ||
      !canonicalIdentity.isDirectory() ||
      requestedIdentity.dev !== canonicalIdentity.dev ||
      requestedIdentity.ino !== canonicalIdentity.ino
    ) {
      return null;
    }
    const afterPrefixes = snapshotPathPrefixesSync(resolved);
    if (
      afterPrefixes === null ||
      !pathPrefixSnapshotsEqual(beforePrefixes, afterPrefixes)
    ) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

interface PathPrefixIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly isDirectory: boolean;
}

function snapshotPathPrefixesSync(
  path: string,
): readonly PathPrefixIdentity[] | null {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  if (root.length === 0) return null;
  const displacement = relative(root, resolved);
  const segments = displacement.length === 0 ? [] : displacement.split(sep);
  const identities: PathPrefixIdentity[] = [];
  let prefix = root;
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) {
      const segment = segments[index - 1];
      if (segment === undefined) return null;
      prefix = join(prefix, segment);
    }
    const identity = lstatSync(prefix, { bigint: true });
    if (identity.isSymbolicLink()) return null;
    identities.push({
      dev: identity.dev,
      ino: identity.ino,
      mode: identity.mode,
      isDirectory: identity.isDirectory(),
    });
  }
  return identities;
}

function pathPrefixSnapshotsEqual(
  left: readonly PathPrefixIdentity[],
  right: readonly PathPrefixIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every((identity, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        identity.dev === candidate.dev &&
        identity.ino === candidate.ino &&
        identity.mode === candidate.mode &&
        identity.isDirectory === candidate.isDirectory
      );
    })
  );
}

function persistedWorkspaceRootWithinBounds(path: string): boolean {
  if (Buffer.byteLength(path, "utf8") > MAX_PERSISTED_WORKSPACE_ROOT_BYTES) {
    return false;
  }
  const root = parse(path).root;
  if (root.length === 0) return false;
  const displacement = relative(root, path);
  if (displacement.length === 0) return true;
  return (
    displacement.split(sep).length <= MAX_PERSISTED_WORKSPACE_ROOT_SEGMENTS
  );
}

function statMatchesPathPrefixIdentity(
  stat: { readonly dev: bigint; readonly ino: bigint; readonly mode: bigint },
  prefix: PathPrefixIdentity,
): boolean {
  return (
    stat.dev === prefix.dev &&
    stat.ino === prefix.ino &&
    stat.mode === prefix.mode
  );
}

function isSameOrDescendantPath(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function workspaceRootsOverlap(left: string, right: string): boolean {
  return (
    isSameOrDescendantPath(left, right) || isSameOrDescendantPath(right, left)
  );
}

function topologyTargetContainsPath(
  target: {
    readonly path: string;
    readonly includeDescendants: boolean;
  },
  path: string,
): boolean {
  return (
    target.path === path ||
    (target.includeDescendants && isSameOrDescendantPath(target.path, path))
  );
}

function topologyTargetsOverlap(
  left: {
    readonly path: string;
    readonly includeDescendants: boolean;
  },
  right: {
    readonly path: string;
    readonly includeDescendants: boolean;
  },
): boolean {
  return (
    topologyTargetContainsPath(left, right.path) ||
    topologyTargetContainsPath(right, left.path)
  );
}

function requiredIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new WorkspaceMutationCoordinatorError(
      "INVALID_EDITOR_SYNC",
      `${field} must contain 1-256 characters`,
    );
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidPersistedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.trim() === value
  );
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isWorkspaceChangeStatus(
  value: unknown,
): value is WorkspaceChangeEvent["status"] {
  return (
    value === "applied" ||
    value === "proposed" ||
    value === "blocked" ||
    value === "discarded" ||
    value === "unknown_outcome"
  );
}

function isEditorReloadChange(
  change: Pick<WorkspaceChangeEvent, "status" | "proposalId">,
): boolean {
  return (
    change.proposalId === undefined &&
    (change.status === "applied" || change.status === "unknown_outcome")
  );
}

function isWorkspaceMutationSource(
  value: unknown,
): value is WorkspaceMutationSource {
  return (
    value === "file_edit" ||
    value === "file_multi_edit" ||
    value === "file_write" ||
    value === "apply_patch" ||
    value === "notebook_edit" ||
    value === "rewind" ||
    value === "shell" ||
    value === "editor" ||
    value === "unknown"
  );
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      (code === "EISDIR" ||
        code === "EINVAL" ||
        code === "ENOTSUP" ||
        code === "EPERM")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateBufferRevision(buffer: EditorBufferSync): void {
  if (!Number.isSafeInteger(buffer.bufferHandle) || buffer.bufferHandle < 0) {
    throw new WorkspaceMutationCoordinatorError(
      "INVALID_EDITOR_SYNC",
      "bufferHandle must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(buffer.changedtick) || buffer.changedtick < 0) {
    throw new WorkspaceMutationCoordinatorError(
      "INVALID_EDITOR_SYNC",
      "changedtick must be a non-negative safe integer",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(buffer.contentSha256)) {
    throw new WorkspaceMutationCoordinatorError(
      "INVALID_EDITOR_SYNC",
      "contentSha256 must be a lowercase SHA-256 digest",
    );
  }
}

/**
 * Resolve a workspace root without requiring it to be new or free of symlinks.
 * Existing directories are canonicalized; test/new paths fall back to resolve.
 */
export async function canonicalWorkspaceRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new WorkspaceMutationCoordinatorError(
      "INVALID_WORKSPACE",
      "workspaceRoot must be absolute",
    );
  }
  const resolved = resolve(path);
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_WORKSPACE",
        "workspaceRoot must be a directory",
      );
    }
    return await realpath(resolved);
  } catch (error) {
    if (error instanceof WorkspaceMutationCoordinatorError) throw error;
    throw new WorkspaceMutationCoordinatorError(
      "INVALID_WORKSPACE",
      `workspaceRoot is not accessible: ${resolved}`,
    );
  }
}

export function workspaceMutationProposalToolResult(
  proposal: WorkspaceMutationProposal,
): {
  readonly content: string;
  readonly isError: true;
  readonly metadata: Record<string, unknown>;
} {
  return {
    content:
      `AgenC did not write ${proposal.path} because it is loaded in Editor. ` +
      "The requested edit is available as a reviewable Editor proposal.",
    isError: true,
    metadata: {
      workspaceMutation: {
        kind: "editor_proposal",
        proposalId: proposal.proposalId,
        workspaceRoot: proposal.workspaceRoot,
        path: proposal.path,
        source: proposal.source,
        baseContentSha256: proposal.baseContentSha256,
        afterContentSha256: sha256(proposal.afterText),
        baseChangedtick: proposal.baseChangedtick,
        bufferHandle: proposal.bufferHandle,
      },
    },
  };
}

export function workspaceMutationBlockedToolResult(message: string): {
  readonly content: string;
  readonly isError: true;
  readonly metadata: Record<string, unknown>;
} {
  return {
    content: message,
    isError: true,
    metadata: {
      workspaceMutation: {
        kind: "blocked",
        reason: "stale_editor_buffer",
      },
    },
  };
}

export function workspaceMutationAdmissionToolResult(
  admission:
    WorkspaceMutationAdmission | { readonly decision: "uncoordinated" },
):
  | ReturnType<typeof workspaceMutationProposalToolResult>
  | ReturnType<typeof workspaceMutationBlockedToolResult>
  | null {
  if (admission.decision === "proposal") {
    return workspaceMutationProposalToolResult(admission.proposal);
  }
  if (admission.decision === "blocked") {
    return workspaceMutationBlockedToolResult(admission.message);
  }
  return null;
}

export function workspaceAuthoritativeRead(
  path: string,
): WorkspaceAuthoritativeRead | null {
  return (
    workspaceMutationCoordinators.findForPath(path)?.authoritativeRead(path) ??
    null
  );
}

export function workspaceAuthoritativeDirtySnapshots(
  path: string,
): readonly WorkspaceAuthoritativeDirtySnapshot[] {
  return (
    workspaceMutationCoordinators
      .findForPath(path)
      ?.authoritativeDirtySnapshotsUnder(path) ?? []
  );
}

export interface WorkspaceAuthoritativeDirtySnapshotCapture {
  readonly snapshots: readonly WorkspaceAuthoritativeDirtySnapshot[];
  readonly isCurrent: () => boolean;
}

export function captureWorkspaceAuthoritativeDirtySnapshots(
  path: string,
  options: { readonly includeDescendants?: boolean } = {},
): WorkspaceAuthoritativeDirtySnapshotCapture {
  // Preserve the once-admitted identity across later rename/symlink exchange.
  const target = normalizePathIdentity(path);
  const captures = workspaceMutationCoordinators
    .findOverlappingPathIdentities(target, options)
    .map((coordinator) => {
      const scope = isSameOrDescendantPath(coordinator.workspaceRoot, target)
        ? target
        : coordinator.workspaceRoot;
      return {
        coordinator,
        scope,
        snapshots:
          coordinator.authoritativeDirtySnapshotsUnderIdentity(scope),
      };
    });
  const snapshots = captures
    .flatMap((capture) => capture.snapshots)
    .sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; index < snapshots.length; index += 1) {
    if (snapshots[index - 1]?.path === snapshots[index]?.path) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_CONFLICT",
        `multiple Editor workspaces claim authority for ${snapshots[index]?.path}`,
      );
    }
  }
  return {
    snapshots,
    isCurrent: () =>
      captures.every((capture) =>
        workspaceAuthoritativeDirtySnapshotsEqual(
          capture.snapshots,
          capture.coordinator.authoritativeDirtySnapshotsUnderIdentity(
            capture.scope,
          ),
        ),
      ),
  };
}

export function workspaceAuthoritativeDirtySnapshotsEqual(
  left: readonly WorkspaceAuthoritativeDirtySnapshot[],
  right: readonly WorkspaceAuthoritativeDirtySnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((snapshot, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        snapshot.path === candidate.path &&
        snapshot.contentSha256 === candidate.contentSha256 &&
        snapshot.changedtick === candidate.changedtick &&
        snapshot.bufferHandle === candidate.bufferHandle &&
        snapshot.epoch === candidate.epoch &&
        snapshot.version === candidate.version
      );
    })
  );
}

export function workspaceMutationPathConflict(
  path: string,
  options: { readonly includeDescendants?: boolean } = {},
): {
  readonly path: string;
  readonly authority: "editor_dirty" | "stale_dirty";
} | null {
  const coordinator = workspaceMutationCoordinators.findForPath(path);
  if (coordinator === null) return null;
  const target = coordinator.resolvePath(path);
  const directAuthority = coordinator.authorityForPath(target);
  if (directAuthority !== "disk_authoritative") {
    return { path: target, authority: directAuthority };
  }
  if (options.includeDescendants !== true) return null;
  for (const candidate of coordinator.dirtyPaths()) {
    if (isSameOrDescendantPath(target, candidate)) {
      return { path: candidate, authority: "editor_dirty" };
    }
  }
  for (const candidate of coordinator.stalePaths()) {
    if (isSameOrDescendantPath(target, candidate)) {
      return { path: candidate, authority: "stale_dirty" };
    }
  }
  return null;
}

export function workspaceLoadedEditorPathConflict(
  path: string,
  options: { readonly includeDescendants?: boolean } = {},
): { readonly path: string } | null {
  const coordinator = workspaceMutationCoordinators.findForPath(path);
  if (coordinator === null) return null;
  const conflict = coordinator.loadedEditorPathConflict(path, options);
  return conflict === null ? null : { path: conflict };
}

export function workspaceHasProtectedEditorPaths(path: string): boolean {
  return workspaceMutationCoordinators.hasProtectedEditorAuthority(path);
}

export function beginWorkspaceToolOperation(
  workspaceRoot: string,
  toolName: string,
): WorkspaceToolOperationToken {
  return workspaceMutationCoordinators.beginToolOperation(
    workspaceRoot,
    toolName,
  );
}

export function beginWorkspaceReadToolOperation(
  workspaceRoot: string,
  toolName: string,
): WorkspaceReadToolOperation {
  return workspaceMutationCoordinators.beginReadToolOperation(
    workspaceRoot,
    toolName,
  );
}

export function endWorkspaceToolOperation(
  token: WorkspaceToolOperationToken,
): void {
  workspaceMutationCoordinators.endToolOperation(token);
}

export async function reserveWorkspaceTopologyMutation(
  targets: readonly WorkspaceTopologyMutationTarget[],
  source: WorkspaceMutationSource = "unknown",
): Promise<WorkspaceTopologyMutationReservation> {
  const grouped = new Map<
    WorkspaceMutationCoordinator,
    WorkspaceTopologyMutationTarget[]
  >();
  for (const target of targets) {
    const coordinator = workspaceMutationCoordinators.findForPath(target.path);
    if (coordinator === null) continue;
    const existing = grouped.get(coordinator);
    if (existing === undefined) grouped.set(coordinator, [target]);
    else existing.push(target);
  }
  const tokens: WorkspaceTopologyMutationToken[] = [];
  try {
    for (const [coordinator, coordinatorTargets] of grouped) {
      tokens.push(
        await coordinator.reserveTopologyMutation(coordinatorTargets, source),
      );
    }
  } catch (error) {
    for (const token of tokens) {
      await workspaceMutationCoordinators
        .findForWorkspaceRootIdentity(token.workspaceRoot)
        ?.releaseTopologyMutation(token)
        .catch(() => {});
    }
    throw error;
  }
  return { tokens };
}

export async function releaseWorkspaceTopologyMutation(
  reservation: WorkspaceTopologyMutationReservation,
): Promise<void> {
  for (const token of reservation.tokens) {
    await workspaceMutationCoordinators
      .findForWorkspaceRootIdentity(token.workspaceRoot)
      ?.releaseTopologyMutation(token);
  }
}

export async function completeWorkspaceTopologyMutation(
  reservation: WorkspaceTopologyMutationReservation,
  status: "applied" | "unknown_outcome",
): Promise<void> {
  const errors: unknown[] = [];
  for (const token of reservation.tokens) {
    const coordinator =
      workspaceMutationCoordinators.findForWorkspaceRootIdentity(
        token.workspaceRoot,
      );
    if (coordinator === null) continue;
    try {
      await coordinator.completeTopologyMutation(token, status);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "multiple workspace topology audits failed",
    );
  }
}

export function getWorkspaceMutationProposal(
  workspaceRoot: string,
  proposalId: string,
): WorkspaceMutationProposal | null {
  return workspaceMutationCoordinators
    .getOrCreate(workspaceRoot)
    .getProposal(proposalId);
}

export function discardWorkspaceMutationProposal(
  workspaceRoot: string,
  proposalId: string,
): boolean {
  return workspaceMutationCoordinators
    .getOrCreate(workspaceRoot)
    .discardProposal(proposalId);
}

export async function prepareWorkspaceMutation(
  input: {
    readonly path: string;
    readonly source: WorkspaceMutationSource;
    readonly beforeText: string;
    readonly afterText: string;
    readonly sessionId?: string;
    readonly toolCallId?: string;
  },
  options: {
    readonly topologyReservation?: WorkspaceTopologyMutationReservation;
  } = {},
): Promise<
  WorkspaceMutationAdmission | { readonly decision: "uncoordinated" }
> {
  const coordinator = workspaceMutationCoordinators.findForPath(input.path);
  if (coordinator === null) return { decision: "uncoordinated" };
  const topologyToken = options.topologyReservation?.tokens.find(
    (token) =>
      token.workspaceRoot === coordinator.workspaceRoot &&
      token.targets.some((target) =>
        topologyTargetContainsPath(target, coordinator.resolvePath(input.path)),
      ),
  );
  return coordinator.prepareMutation(input, {
    ...(topologyToken !== undefined
      ? { allowTopologyTokenId: topologyToken.tokenId }
      : {}),
  });
}

export async function commitWorkspaceMutation(
  admission:
    WorkspaceMutationAdmission | { readonly decision: "uncoordinated" },
  afterText: string,
  metadata: {
    readonly sessionId?: string;
    readonly toolCallId?: string;
  } = {},
): Promise<void> {
  if (admission.decision !== "allow") return;
  const coordinator =
    workspaceMutationCoordinators.findForWorkspaceRootIdentity(
      admission.token.workspaceRoot,
    );
  if (coordinator === null) {
    throw new WorkspaceMutationCoordinatorError(
      "EDITOR_LEASE_MISMATCH",
      "workspace mutation coordinator disappeared before commit",
    );
  }
  await coordinator.commitMutation(admission.token, afterText, metadata);
}

export async function reconcileUnknownMutation(
  token: WorkspaceMutationToken,
  observed: WorkspaceMutationObservedState,
  metadata: {
    readonly sessionId?: string;
    readonly toolCallId?: string;
  } = {},
): Promise<void> {
  const coordinator =
    workspaceMutationCoordinators.findForWorkspaceRootIdentity(
      token.workspaceRoot,
    );
  if (coordinator === null) {
    throw new WorkspaceMutationCoordinatorError(
      "EDITOR_LEASE_MISMATCH",
      "workspace mutation coordinator disappeared before reconciliation",
    );
  }
  await coordinator.reconcileUnknownMutation(token, observed, metadata);
}

export function beginWorkspaceMutation(
  admission:
    WorkspaceMutationAdmission | { readonly decision: "uncoordinated" },
): void {
  if (admission.decision !== "allow") return;
  const coordinator =
    workspaceMutationCoordinators.findForWorkspaceRootIdentity(
      admission.token.workspaceRoot,
    );
  if (coordinator === null) {
    throw new WorkspaceMutationCoordinatorError(
      "EDITOR_LEASE_MISMATCH",
      "workspace mutation coordinator disappeared before commit",
    );
  }
  coordinator.beginMutation(admission.token);
}

export function cancelWorkspaceMutation(
  admission:
    WorkspaceMutationAdmission | { readonly decision: "uncoordinated" },
): void {
  if (admission.decision !== "allow") return;
  workspaceMutationCoordinators
    .findForWorkspaceRootIdentity(admission.token.workspaceRoot)
    ?.cancelMutation(admission.token);
}

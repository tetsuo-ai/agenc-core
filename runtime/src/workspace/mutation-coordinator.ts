import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
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
  readFile,
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
import { createInterface as createReadlineInterface } from "node:readline";

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
const MAX_AUDIT_OUTBOX_ENTRIES = MAX_SYNCED_BUFFERS + MAX_PENDING_PROPOSALS;
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
  readonly staleAuthority?: readonly WorkspaceEditorStaleAuthorityEntry[];
}

export interface WorkspaceEditorStaleAuthorityEntry {
  readonly path: string;
  readonly editorContentSha256: string;
  readonly editorContentBytes: number;
  readonly changedtick: number;
  readonly editorInstanceId: string;
  readonly epoch: number;
  readonly editorState: "dirty" | "clean";
  readonly diskState: "content" | "missing" | "unavailable";
  readonly diskContentSha256?: string;
  readonly diskContentBytes?: number;
}

export interface WorkspaceEditorSyncInput {
  readonly workspaceRoot: string;
  readonly editorInstanceId: string;
  readonly leaseToken: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly buffers: readonly EditorBufferSync[];
  readonly abandonStaleAuthority?: readonly WorkspaceEditorStaleAuthorityEntry[];
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
  /** Omitted by legacy exact-path events. */
  readonly kind?: "path" | "topology";
  readonly status:
    "applied" | "proposed" | "blocked" | "discarded" | "unknown_outcome";
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly proposalId?: string;
  readonly topologyTokenId?: string;
  readonly includeDescendants?: boolean;
}

export interface WorkspaceEditorSyncResult {
  readonly accepted: true;
  readonly sequence: number;
  readonly expiresAt: number;
  readonly dirtyPaths: readonly string[];
  readonly stalePaths: readonly string[];
  readonly staleAuthority: readonly WorkspaceEditorStaleAuthorityEntry[];
}

export interface WorkspaceEditorStaleAuthorityRefreshResult {
  readonly refreshed: true;
  readonly staleAuthority: readonly WorkspaceEditorStaleAuthorityEntry[];
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

export interface WorkspaceRecoveredEditorTopologyMutationResolveInput extends WorkspaceEditorTopologyMutationFinalizeInput {}

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
  readonly kind?: "path" | "topology";
  readonly status:
    "applied" | "proposed" | "blocked" | "discarded" | "unknown_outcome";
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly proposalId?: string;
  readonly topologyTokenId?: string;
  readonly includeDescendants?: boolean;
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
  readonly auditOutbox: readonly WorkspaceChangeLedgerEntry[];
}

interface WorkspaceQuarantineStateOverrides {
  readonly buffers?: ReadonlyMap<string, EditorBufferState>;
  readonly proposalCommitments?: ReadonlyMap<
    string,
    WorkspaceProposalCommitment
  >;
  readonly proposalReceipts?: ReadonlyMap<string, WorkspaceProposalReceipt>;
  readonly auditOutbox?: ReadonlyMap<string, WorkspaceChangeLedgerEntry>;
  readonly mutationIntents?: ReadonlyMap<string, WorkspaceMutationIntent>;
  readonly topologyIntents?: ReadonlyMap<
    string,
    WorkspaceTopologyMutationIntent
  >;
  readonly changes?: readonly WorkspaceChangeEvent[];
  readonly changeSequence?: number;
}

interface WorkspaceEditorSyncPlan {
  readonly lease: ActiveLease;
  readonly sequence: number;
  readonly buffers: ReadonlyMap<string, EditorBufferState>;
  readonly proposalCommitments: ReadonlyMap<
    string,
    WorkspaceProposalCommitment
  >;
  readonly proposalReceipts: ReadonlyMap<string, WorkspaceProposalReceipt>;
  readonly auditOutbox: ReadonlyMap<string, WorkspaceChangeLedgerEntry>;
  readonly abandonedPaths: ReadonlySet<string>;
  readonly changes: readonly WorkspaceChangeEvent[];
  readonly changeSequence: number;
  readonly quarantineSnapshot: WorkspaceQuarantineSnapshot;
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
  /** Optional append-once projection seam used by crash/race harnesses. */
  readonly appendLedgerOnce?: (
    entries: readonly WorkspaceChangeLedgerEntry[],
  ) => Promise<void>;
  /** Optional pre-write durability seam used by fault/race harnesses. */
  readonly beforePersistQuarantine?: () => Promise<void>;
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
  readonly #appendLedgerOnce: (
    entries: readonly WorkspaceChangeLedgerEntry[],
  ) => Promise<void>;
  readonly #beforePersistQuarantine: (() => Promise<void>) | undefined;
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
  readonly #auditOutbox = new Map<string, WorkspaceChangeLedgerEntry>();
  readonly #proposalResolutionOperations = new Map<string, Promise<unknown>>();
  readonly #changes: WorkspaceChangeEvent[] = [];
  #lease: ActiveLease | null = null;
  #nextEpoch = 1;
  #authorityVersion = 0;
  #changeSequence = 0;
  #quarantineHydrationFailed = false;
  #staleAuthorityResolutionPending = false;
  #proposalTerminalPersistencePending = false;
  #topologyFinalizationPending = false;
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
    this.#appendLedgerOnce =
      options.appendLedgerOnce ??
      ((entries) => this.#ledger.appendOnce(entries));
    this.#beforePersistQuarantine = options.beforePersistQuarantine;
    try {
      const quarantine = this.#ledger.readQuarantine();
      if (quarantine !== null) {
        if (this.#hydrateQuarantine(quarantine)) {
          this.#scheduleQuarantinePersistence();
        }
        if (this.#auditOutbox.size > 0) {
          void this.#serializeProposalState(() =>
            this.#drainAuditOutbox(),
          ).catch(() => {});
        }
      }
    } catch {
      // The durable record exists specifically to prevent a daemon restart
      // from forgetting unresolved unsaved editor state. If it cannot be
      // trusted, block workspace reads/writes until an editor explicitly
      // abandons the quarantine rather than silently falling back to disk.
      this.#buffers.clear();
      this.#tokens.clear();
      this.#topologyTokens.clear();
      this.#recoveredTopologyTokens.clear();
      this.#editorTopologyOwners.clear();
      this.#mutationIntents.clear();
      this.#topologyIntents.clear();
      this.#proposals.clear();
      this.#proposalCommitments.clear();
      this.#proposalReceipts.clear();
      this.#auditOutbox.clear();
      this.#changes.splice(0);
      this.#authorityVersion = 0;
      this.#changeSequence = 0;
      this.#quarantineHydrationFailed = true;
    }
  }

  acquire(input: WorkspaceEditorAcquireInput): WorkspaceEditorLease {
    this.#assertNoStaleAuthorityResolution();
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
      return this.#leaseResult(this.#lease, true);
    }

    const lease: ActiveLease = {
      editorInstanceId,
      leaseToken: randomUUID(),
      epoch: this.#nextEpoch,
      sequence: -1,
      expiresAt: this.#now() + this.#leaseTtlMs,
    };
    // Revalidate recovered proposal capacity before publishing a new owner.
    // The invariant reserves a worst-case future identity, so this exact
    // lease can never require more durable terminal space.
    if (!this.#quarantineHydrationFailed) {
      this.#assertQuarantineTransitionFits();
    }
    if (this.#lease !== null) this.#quarantineLoadedBuffers(false);
    this.#nextEpoch += 1;
    this.#lease = lease;
    return this.#leaseResult(lease, true);
  }

  sync(
    input: WorkspaceEditorSyncInput,
    options: { readonly allowTopologyTokenId?: string } = {},
  ): WorkspaceEditorSyncResult {
    if (input.abandonStaleAuthority !== undefined) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "stale Editor authority abandonment requires the durable asynchronous sync transaction",
      );
    }
    const plan = this.#prepareEditorSync(input, options);
    const result = this.#commitEditorSync(plan);
    this.#scheduleQuarantinePersistence();
    return result;
  }

  async syncAbandoningStaleAuthority(
    input: WorkspaceEditorSyncInput,
    options: { readonly allowTopologyTokenId?: string } = {},
  ): Promise<WorkspaceEditorSyncResult> {
    if (input.abandonStaleAuthority === undefined) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "durable stale Editor authority abandonment requires exact confirmation evidence",
      );
    }
    return this.#serializeProposalState(async () => {
      if (this.#staleAuthorityResolutionPending) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          "another stale Editor authority resolution is already in progress",
        );
      }
      // Validate and expire the lease before freezing coordinator state for
      // the durability boundary. Once a valid transaction starts, its fsync
      // may legitimately run past the ordinary heartbeat deadline.
      this.#assertLease(input);
      this.#staleAuthorityResolutionPending = true;
      try {
        await this.#clearPendingAuditFence("resolve stale Editor authority");
        // Drain any older write, then establish a freshly fsynced conservative
        // checkpoint before installing the destructive replacement. If the
        // replacement's directory fsync is ambiguous, a crash can therefore
        // reveal only this protected checkpoint or the exact replacement.
        await this.flushQuarantinePersistence().catch(() => {});
        const conservativePersistence = this.#scheduleQuarantineSnapshot(
          this.#quarantineSnapshot(),
        );
        await conservativePersistence;
        const plan = this.#prepareEditorSync(input, options, true);
        const proposalTerminalEntries = [...plan.auditOutbox.values()].filter(
          (entry) => workspaceProposalTerminalKey(entry) !== null,
        );
        try {
          await this.#ledger.assertAppendOnceCompatible(
            proposalTerminalEntries,
          );
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Editor authority was not resolved because a proposal already has a conflicting terminal audit outcome (${error instanceof Error ? error.message : String(error)}). Reconnect and reconcile the recorded proposal decision.`,
          );
        }
        const persistence = this.#scheduleQuarantineSnapshot(
          plan.quarantineSnapshot,
          { acceptInstalledWithDurableFallback: true },
        );
        await persistence;
        const result = this.#commitEditorSync(plan);
        try {
          await this.#drainAuditOutbox();
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Editor authority was resolved, but its durable audit projection is pending (${error instanceof Error ? error.message : String(error)}). Reconnect to retry the audit safely.`,
          );
        }
        return result;
      } finally {
        this.#staleAuthorityResolutionPending = false;
      }
    });
  }

  #prepareEditorSync(
    input: WorkspaceEditorSyncInput,
    options: {
      readonly allowTopologyTokenId?: string;
      readonly topologyFinalization?: {
        readonly tokenId: string;
        readonly changes: readonly Omit<
          WorkspaceChangeEvent,
          "sequence" | "timestamp" | "workspaceRoot"
        >[];
        readonly auditEntries: readonly WorkspaceChangeLedgerEntry[];
      };
    },
    allowStaleAuthorityResolution = false,
  ): WorkspaceEditorSyncPlan {
    if (this.#quarantineHydrationFailed) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace quarantine is unreadable or unsafe; explicitly abandon dirty quarantine before synchronizing Editor authority",
      );
    }
    const lease = this.#assertLease(
      input,
      allowStaleAuthorityResolution,
      options.topologyFinalization !== undefined,
    );
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

    const abandonedStaleAuthority = this.#validateStaleAuthorityAbandonments(
      input.abandonStaleAuthority,
    );

    let totalBytes = 0;
    const next = new Map<string, EditorBufferState>();
    const nextProposalCommitments = new Map(this.#proposalCommitments);
    const nextProposalReceipts = new Map(this.#proposalReceipts);
    const nextAuditOutbox = new Map(this.#auditOutbox);
    for (const entry of options.topologyFinalization?.auditEntries ?? []) {
      rememberAuditOutboxEntry(nextAuditOutbox, entry);
    }
    const recoveryChanges: Omit<
      WorkspaceChangeEvent,
      "sequence" | "timestamp" | "workspaceRoot"
    >[] = [];
    const auditTimestamp = new Date(this.#now()).toISOString();
    for (const entry of abandonedStaleAuthority.values()) {
      const change = {
        path: entry.path,
        source: "editor" as const,
        status: "discarded" as const,
        beforeSha256: entry.editorContentSha256,
        ...(entry.diskContentSha256 !== undefined
          ? { afterSha256: entry.diskContentSha256 }
          : {}),
      };
      recoveryChanges.push(change);
      rememberAuditOutboxEntry(
        nextAuditOutbox,
        staleAuthorityDiscardLedgerEntry(
          this.workspaceRoot,
          entry,
          change,
          auditTimestamp,
        ),
      );
    }
    for (const [proposalId, commitment] of nextProposalCommitments) {
      if (!abandonedStaleAuthority.has(commitment.path)) continue;
      nextProposalCommitments.delete(proposalId);
      const result = {
        discarded: true as const,
        proposalId,
        path: commitment.path,
      };
      nextProposalReceipts.delete(proposalId);
      nextProposalReceipts.set(proposalId, { action: "discarded", result });
      recoveryChanges.push({
        path: commitment.path,
        source: commitment.source,
        status: "discarded",
        beforeSha256: commitment.baseContentSha256,
        afterSha256: commitment.afterContentSha256,
        proposalId,
      });
      rememberAuditOutboxEntry(
        nextAuditOutbox,
        proposalTerminalLedgerEntry(
          this.workspaceRoot,
          commitment,
          "discarded",
          auditTimestamp,
        ),
      );
    }
    while (nextProposalReceipts.size > MAX_PROPOSAL_RECEIPTS) {
      const oldest = nextProposalReceipts.keys().next().value;
      if (typeof oldest !== "string") break;
      nextProposalReceipts.delete(oldest);
    }
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
      const abandoned = abandonedStaleAuthority.get(path);
      if (abandoned !== undefined) {
        if (
          buffer.dirty ||
          abandoned.diskState !== "content" ||
          buffer.contentSha256 !== abandoned.diskContentSha256 ||
          contentBytes !== abandoned.diskContentBytes
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "EDITOR_LEASE_MISMATCH",
            `Cannot use disk for quarantined editor buffer ${path}: the loaded Editor buffer is not the exact reviewed disk revision. Reload or close that buffer, then confirm again.`,
          );
        }
      } else if (quarantined?.authority === "stale_dirty") {
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
    // deliberately abandoned. Exact, user-confirmed stale abandonments are the
    // sole exception and are committed atomically with this replacement
    // manifest.
    for (const previous of this.#buffers.values()) {
      if (abandonedStaleAuthority.has(previous.path)) continue;
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
    // Buffer validation above can be comparatively expensive. This final
    // descriptor-bound re-read is the filesystem linearization point for the
    // user's decision: an external write before it invalidates confirmation;
    // one after it is a later disk revision. Coordinator-owned writers remain
    // frozen until the replacement authority manifest is durable.
    this.#assertStaleAuthorityStillMatches(abandonedStaleAuthority);
    const projectedChanges = this.#projectChanges([
      ...recoveryChanges,
      ...(options.topologyFinalization?.changes ?? []),
    ]);
    const nextTopologyIntents = new Map(this.#topologyIntents);
    if (options.topologyFinalization !== undefined) {
      nextTopologyIntents.delete(options.topologyFinalization.tokenId);
    }
    const quarantineSnapshot = this.#assertQuarantineTransitionFits({
      buffers: next,
      proposalCommitments: nextProposalCommitments,
      proposalReceipts: nextProposalReceipts,
      auditOutbox: nextAuditOutbox,
      topologyIntents: nextTopologyIntents,
      changes: projectedChanges.changes,
      changeSequence: projectedChanges.sequence,
    });
    return {
      lease: {
        ...lease,
        sequence: input.sequence,
        expiresAt: this.#now() + this.#leaseTtlMs,
      },
      sequence: input.sequence,
      buffers: next,
      proposalCommitments: nextProposalCommitments,
      proposalReceipts: nextProposalReceipts,
      auditOutbox: nextAuditOutbox,
      abandonedPaths: new Set(abandonedStaleAuthority.keys()),
      changes: projectedChanges.changes,
      changeSequence: projectedChanges.sequence,
      quarantineSnapshot,
    };
  }

  #commitEditorSync(plan: WorkspaceEditorSyncPlan): WorkspaceEditorSyncResult {
    this.#buffers.clear();
    for (const [path, state] of plan.buffers) this.#buffers.set(path, state);
    this.#proposalCommitments.clear();
    for (const [proposalId, commitment] of plan.proposalCommitments) {
      this.#proposalCommitments.set(proposalId, commitment);
    }
    this.#proposalReceipts.clear();
    for (const [proposalId, receipt] of plan.proposalReceipts) {
      this.#proposalReceipts.set(proposalId, receipt);
    }
    this.#auditOutbox.clear();
    for (const [entryId, entry] of plan.auditOutbox) {
      this.#auditOutbox.set(entryId, entry);
    }
    for (const [proposalId, proposal] of this.#proposals) {
      if (plan.abandonedPaths.has(proposal.path)) {
        this.#proposals.delete(proposalId);
      }
    }
    this.#changes.splice(0, this.#changes.length, ...plan.changes);
    this.#changeSequence = plan.changeSequence;
    const committedLease = {
      ...plan.lease,
      expiresAt: this.#now() + this.#leaseTtlMs,
    };
    this.#lease = committedLease;
    return {
      accepted: true,
      sequence: plan.sequence,
      expiresAt: committedLease.expiresAt,
      dirtyPaths: this.dirtyPaths(),
      stalePaths: this.stalePaths(),
      staleAuthority: this.#currentStaleAuthority(),
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

  /**
   * Re-read only the external disk evidence shown by stale-authority recovery.
   * This deliberately does not synchronize Editor buffers, advance the lease
   * sequence, renew the lease, or alter any quarantined authority.
   */
  refreshStaleAuthority(
    input: WorkspaceEditorHeartbeatInput,
  ): WorkspaceEditorStaleAuthorityRefreshResult {
    this.#assertLease(input);
    return {
      refreshed: true,
      staleAuthority: this.#currentStaleAuthority(),
    };
  }

  async release(input: WorkspaceEditorReleaseInput): Promise<{
    readonly released: true;
    readonly stalePaths: readonly string[];
  }> {
    if (input.abandonDirty === true) {
      this.#assertLease(input);
      for (const tokenId of [...this.#recoveredTopologyTokens]) {
        const token = this.#topologyTokens.get(tokenId);
        if (token !== undefined) await this.releaseTopologyMutation(token);
      }
      return this.#serializeProposalState(() =>
        this.#releaseAbandoningDirty(input),
      );
    }
    if (this.#quarantineHydrationFailed) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace quarantine is unreadable or unsafe; release requires explicit dirty-authority abandonment",
      );
    }
    const lease = this.#assertLease(input);
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
    this.#orphanEditorTopologyTokens(lease);
    this.#lease = null;
    this.#scheduleQuarantinePersistence();
    await this.flushQuarantinePersistence();
    return { released: true, stalePaths: this.stalePaths() };
  }

  async #releaseAbandoningDirty(input: WorkspaceEditorReleaseInput): Promise<{
    readonly released: true;
    readonly stalePaths: readonly string[];
  }> {
    this.#assertLease(input);
    if (this.#staleAuthorityResolutionPending) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "another stale Editor authority resolution is already in progress",
      );
    }
    this.#assertLease(input);
    if (this.#tokens.size > 0 || this.#topologyTokens.size > 0) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "dirty Editor authority cannot be abandoned while another workspace mutation is committing",
      );
    }

    this.#staleAuthorityResolutionPending = true;
    try {
      await this.#clearPendingAuditFence("abandon dirty Editor authority");
      await this.flushQuarantinePersistence().catch(() => {});
      const conservativePersistence = this.#scheduleQuarantineSnapshot(
        this.#quarantineSnapshot(),
      );
      await conservativePersistence;
      const replacement = this.#quarantineSnapshot({
        buffers: new Map(),
        proposalCommitments: new Map(),
      });
      const persistence = this.#scheduleQuarantineSnapshot(replacement, {
        acceptInstalledWithDurableFallback: true,
      });
      await persistence;

      this.#buffers.clear();
      this.#proposals.clear();
      this.#proposalCommitments.clear();
      this.#quarantineHydrationFailed = false;
      this.#lease = null;
      return { released: true, stalePaths: [] };
    } finally {
      this.#staleAuthorityResolutionPending = false;
    }
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
    this.#assertNoStaleAuthorityResolution();
    this.#expireLeaseIfNeeded();
    await this.flushQuarantinePersistence();
    await this.#clearPendingAuditFence("prepare another workspace mutation");
    this.#assertNoStaleAuthorityResolution();
    this.#expireLeaseIfNeeded();
    const path = this.resolvePath(input.path);
    if (this.#topologyInvalidationConflictForPath(path) !== null) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        `Cannot modify ${path} until Editor acknowledges the completed workspace path operation`,
      );
    }
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
      if (this.#topologyTokens.size > 0) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot propose a change for ${path} while a workspace path operation is committing`,
        );
      }
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
      this.#assertQuarantineTransitionFits({
        proposalCommitments: projectedCommitments,
        changes: projectedChanges.changes,
        changeSequence: projectedChanges.sequence,
      });
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
    // This is the last pre-effect boundary. Reserve both the durable intent
    // and its largest crash/completion event without consuming any proposal's
    // terminal receipt capacity.
    this.#assertQuarantineTransitionFits({
      mutationIntents: projectedIntents,
    });
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
    this.#assertNoStaleAuthorityResolution();
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
      this.#assertQuarantineTransitionFits({
        mutationIntents: projectedIntents,
        changes: projectedChanges.changes,
        changeSequence: projectedChanges.sequence,
      });
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
    // This API follows a filesystem effect whose exact transactional outcome
    // is no longer provable. Keep the executing token as a coordinator-wide
    // fence until both audit writes settle: stale-authority resolution must
    // not snapshot pre-reconciliation buffers or proposal state in between
    // those writes and then report a destructive decision as durable.
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
    const projectedIntents = new Map(this.#mutationIntents);
    projectedIntents.delete(token.tokenId);
    this.#assertQuarantineTransitionFits({
      mutationIntents: projectedIntents,
      changes: projectedChanges.changes,
      changeSequence: projectedChanges.sequence,
    });
    this.#mutationIntents.delete(token.tokenId);
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
    // Never put a consumed post-effect token back. At this point the in-memory
    // unknown-outcome state is complete and every durability attempt has
    // settled, so opening the fence cannot race a stale-authority snapshot.
    this.#tokens.delete(token.tokenId);
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
    return this.#serializeProposalState(() =>
      this.#reserveTopologyMutation(targets, source, null),
    );
  }

  async reserveEditorTopologyMutation(
    input: WorkspaceEditorTopologyMutationInput,
  ): Promise<WorkspaceTopologyMutationToken> {
    return this.#serializeProposalState(async () => {
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
    });
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
    readonly sync: WorkspaceEditorSyncResult;
  }> {
    const finalized = await this.#finalizeEditorTopologyMutation(
      input,
      "unknown_outcome",
      true,
    );
    return {
      resolved: true,
      tokenId: finalized.token.tokenId,
      status: "unknown_outcome",
      sync: finalized.sync,
    };
  }

  #assertRecoveredTopologyCleanBuffersMatchDisk(
    token: WorkspaceTopologyMutationToken,
    buffers: readonly EditorBufferSync[],
  ): void {
    for (const buffer of buffers) {
      if (
        buffer.dirty ||
        !token.targets.some((target) =>
          topologyTargetContainsPath(target, this.resolvePath(buffer.path)),
        )
      ) {
        continue;
      }
      const path = this.resolvePath(buffer.path);
      const disk = boundedDiskAuthorityStateSync(path);
      if (
        disk.diskState !== "content" ||
        disk.diskContentSha256 !== buffer.contentSha256 ||
        disk.diskContentBytes !== buffer.contentBytes
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot reconcile recovered workspace path ${path}: the loaded clean Editor buffer does not match the descriptor-verified disk revision. Reload or unload it and retry.`,
        );
      }
    }
  }

  async #finalizeEditorTopologyMutation(
    input: WorkspaceEditorTopologyMutationFinalizeInput,
    status: "applied" | "unknown_outcome" | null,
    recovered: boolean,
  ): Promise<{
    readonly token: WorkspaceTopologyMutationToken;
    readonly sync: WorkspaceEditorSyncResult;
  }> {
    const lease = this.#assertLease(input);
    const token = this.#topologyTokens.get(input.tokenId);
    const intent = this.#topologyIntents.get(input.tokenId);
    if (
      token === undefined ||
      intent === undefined ||
      (recovered
        ? !this.#recoveredTopologyTokens.has(input.tokenId) ||
          this.#editorTopologyOwners.has(input.tokenId)
        : this.#recoveredTopologyTokens.has(input.tokenId) ||
          this.#editorTopologyOwners.get(input.tokenId)?.editorInstanceId !==
            lease.editorInstanceId ||
          this.#editorTopologyOwners.get(input.tokenId)?.epoch !== lease.epoch)
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        recovered
          ? "workspace path recovery token is not a durable orphan owned by the active editor recovery flow"
          : "workspace path operation does not belong to the active editor lease",
      );
    }
    if (this.#topologyFinalizationPending || this.#tokens.size > 0) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "workspace path operation cannot finalize while another filesystem effect is committing",
      );
    }
    const recoveryOwner = {
      editorInstanceId: lease.editorInstanceId,
      epoch: lease.epoch,
    };
    if (recovered) {
      this.#editorTopologyOwners.set(token.tokenId, recoveryOwner);
    }
    // Close the sync/contention race synchronously, before the first durable
    // wait. The final snapshot below carries the exact post-operation Editor
    // manifest and consumes the target intent in one filesystem transaction.
    this.#topologyFinalizationPending = true;
    try {
      return await this.#serializeProposalState(async () => {
        await this.flushQuarantinePersistence().catch(() => {});
        await this.#clearPendingAuditFence(
          "finalize another workspace path operation",
        );
        const currentIntent = this.#topologyIntents.get(token.tokenId);
        if (currentIntent === undefined) {
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            "workspace topology mutation intent is missing or already consumed",
          );
        }
        const conservativeIntents = new Map(this.#topologyIntents);
        conservativeIntents.set(token.tokenId, {
          ...currentIntent,
          contentions: [],
        });
        await this.#scheduleQuarantineSnapshot(
          this.#quarantineSnapshot({ topologyIntents: conservativeIntents }),
        );
        if (recovered) {
          this.#assertRecoveredTopologyCleanBuffersMatchDisk(
            token,
            input.buffers,
          );
        }
        const terminalTimestamp = new Date(this.#now()).toISOString();
        const targetChanges =
          status === null
            ? []
            : token.targets.map((target) => ({
                kind: "topology" as const,
                topologyTokenId: token.tokenId,
                path: target.path,
                includeDescendants: target.includeDescendants,
                source: currentIntent.source,
                status,
              }));
        const pathChanges =
          status === null
            ? []
            : currentIntent.contentions.map((contention) => {
                const afterSha256 = boundedDiskSha256Sync(contention.path);
                return {
                  path: contention.path,
                  source: currentIntent.source,
                  status,
                  beforeSha256: contention.beforeSha256,
                  ...(afterSha256 !== null ? { afterSha256 } : {}),
                } satisfies Omit<
                  WorkspaceChangeEvent,
                  "sequence" | "timestamp" | "workspaceRoot"
                >;
              });
        const changes = [...targetChanges, ...pathChanges];
        const auditEntries =
          status === null
            ? []
            : token.targets.map((target) =>
                topologyTerminalLedgerEntry(
                  this.workspaceRoot,
                  token,
                  target,
                  status,
                  terminalTimestamp,
                ),
              );
        try {
          await this.#ledger.assertAppendOnceCompatible(auditEntries);
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Workspace path operation was not finalized because its durable audit identity conflicts with an existing outcome (${error instanceof Error ? error.message : String(error)}).`,
          );
        }
        const plan = this.#prepareEditorSync(
          {
            workspaceRoot: input.workspaceRoot,
            editorInstanceId: input.editorInstanceId,
            leaseToken: input.leaseToken,
            epoch: input.epoch,
            sequence: input.sequence,
            buffers: input.buffers,
          },
          {
            allowTopologyTokenId: token.tokenId,
            topologyFinalization: {
              tokenId: token.tokenId,
              changes,
              auditEntries,
            },
          },
        );
        await this.#scheduleQuarantineSnapshot(plan.quarantineSnapshot, {
          acceptInstalledWithDurableFallback: true,
        });
        const sync = this.#commitEditorSync(plan);
        this.#topologyIntents.delete(token.tokenId);
        this.#topologyTokens.delete(token.tokenId);
        this.#editorTopologyOwners.delete(token.tokenId);
        this.#recoveredTopologyTokens.delete(token.tokenId);
        try {
          await this.#drainAuditOutbox();
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Workspace path operation completed, but its durable audit projection remains pending (${error instanceof Error ? error.message : String(error)}). Reconnect to retry safely.`,
          );
        }
        return { token, sync };
      });
    } catch (error) {
      const activeOwner = this.#editorTopologyOwners.get(token.tokenId);
      if (
        recovered &&
        this.#topologyTokens.has(token.tokenId) &&
        activeOwner?.editorInstanceId === recoveryOwner.editorInstanceId &&
        activeOwner.epoch === recoveryOwner.epoch
      ) {
        this.#editorTopologyOwners.delete(token.tokenId);
      }
      throw error;
    } finally {
      this.#topologyFinalizationPending = false;
    }
  }

  async #reserveTopologyMutation(
    targets: readonly WorkspaceTopologyMutationTarget[],
    source: WorkspaceMutationSource,
    editorLease: ActiveLease | null,
  ): Promise<WorkspaceTopologyMutationToken> {
    this.#assertNoStaleAuthorityResolution();
    this.#expireLeaseIfNeeded();
    await this.flushQuarantinePersistence();
    await this.#clearPendingAuditFence("reserve a workspace path operation");
    this.#assertNoStaleAuthorityResolution();
    this.#expireLeaseIfNeeded();
    if (editorLease !== null) {
      const activeLease = this.#lease;
      if (
        activeLease === null ||
        activeLease.editorInstanceId !== editorLease.editorInstanceId ||
        activeLease.leaseToken !== editorLease.leaseToken ||
        activeLease.epoch !== editorLease.epoch
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          "editor lease changed while reserving the workspace path operation",
        );
      }
    }
    if (this.#quarantineHydrationFailed) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "Cannot reserve a workspace path operation while editor quarantine is unreadable",
      );
    }
    if (this.#recoveredTopologyTokens.size > 0) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "Cannot reserve another workspace path operation until recovered path fences are reconciled",
      );
    }
    if (this.#proposalCommitments.size > 0) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "Cannot reserve a workspace path operation while Editor proposals are awaiting review",
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
      if (this.#topologyInvalidationConflictForTarget(target) !== null) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot mutate ${target.path}: Editor has not acknowledged an overlapping completed workspace path operation`,
        );
      }
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
    const mergedTargets = new Map<string, boolean>();
    for (const target of resolvedTargets) {
      mergedTargets.set(
        target.path,
        (mergedTargets.get(target.path) ?? false) || target.includeDescendants,
      );
    }
    const durableTargets = [...mergedTargets].map(
      ([path, includeDescendants]) => ({ path, includeDescendants }),
    );
    const token: WorkspaceTopologyMutationToken = {
      tokenId: randomUUID(),
      workspaceRoot: this.workspaceRoot,
      targets: durableTargets.filter(
        (target) =>
          !durableTargets.some(
            (other) =>
              other.path !== target.path &&
              topologyTargetContainsPath(other, target.path),
          ),
      ),
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
    this.#assertQuarantineTransitionFits({
      topologyIntents: projectedIntents,
    });
    const pendingDeliveryCount =
      this.#changes.filter(isEditorReloadChange).length;
    const projectedTopologyReloadCount = [...projectedIntents.values()].reduce(
      (total, projected) =>
        total + projected.targets.length + projected.contentions.length,
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
    await this.#finalizeTopologyMutation(token, null);
  }

  async #finalizeTopologyMutation(
    token: WorkspaceTopologyMutationToken,
    status: "applied" | "unknown_outcome" | null,
  ): Promise<void> {
    const activeToken = this.#topologyTokens.get(token.tokenId);
    if (activeToken === undefined) {
      if (status === null) return;
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace topology mutation token is missing or already consumed",
      );
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
    if (this.#topologyFinalizationPending || this.#tokens.size > 0) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "workspace path operation cannot finalize while another filesystem effect is committing",
      );
    }
    this.#topologyFinalizationPending = true;
    try {
      await this.#serializeProposalState(async () => {
        await this.flushQuarantinePersistence().catch(() => {});
        await this.#clearPendingAuditFence(
          "finalize another workspace path operation",
        );
        const intent = this.#topologyIntents.get(token.tokenId);
        if (intent === undefined) {
          if (status === null) return;
          throw new WorkspaceMutationCoordinatorError(
            "INVALID_EDITOR_SYNC",
            "workspace topology mutation intent is missing or already consumed",
          );
        }
        const conservativeIntents = new Map(this.#topologyIntents);
        conservativeIntents.set(token.tokenId, {
          ...intent,
          contentions: [],
        });
        await this.#scheduleQuarantineSnapshot(
          this.#quarantineSnapshot({ topologyIntents: conservativeIntents }),
        );
        const targetChanges =
          status === null
            ? []
            : token.targets.map((target) => ({
                kind: "topology" as const,
                topologyTokenId: token.tokenId,
                path: target.path,
                includeDescendants: target.includeDescendants,
                source: intent.source,
                status,
              }));
        const pathChanges =
          status === null
            ? []
            : intent.contentions.map((contention) => {
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
        let projectedChanges;
        try {
          projectedChanges = this.#projectChanges([
            ...targetChanges,
            ...pathChanges,
          ]);
        } catch {
          // Exact contention events are an optimization; target-scoped
          // invalidations are the bounded, durable correctness record.
          projectedChanges = this.#projectChanges(targetChanges);
        }
        const auditTimestamp = new Date(this.#now()).toISOString();
        const auditEntries =
          status === null
            ? []
            : token.targets.map((target) =>
                topologyTerminalLedgerEntry(
                  this.workspaceRoot,
                  token,
                  target,
                  status,
                  auditTimestamp,
                ),
              );
        await this.#ledger.assertAppendOnceCompatible(auditEntries);
        const projectedOutbox = new Map(this.#auditOutbox);
        for (const entry of auditEntries) {
          rememberAuditOutboxEntry(projectedOutbox, entry);
        }
        const projectedIntents = new Map(this.#topologyIntents);
        projectedIntents.delete(token.tokenId);
        let snapshot: WorkspaceQuarantineSnapshot;
        try {
          snapshot = this.#assertQuarantineTransitionFits({
            topologyIntents: projectedIntents,
            auditOutbox: projectedOutbox,
            changes: projectedChanges.changes,
            changeSequence: projectedChanges.sequence,
          });
        } catch (error) {
          if (pathChanges.length === 0) throw error;
          projectedChanges = this.#projectChanges(targetChanges);
          snapshot = this.#assertQuarantineTransitionFits({
            topologyIntents: projectedIntents,
            auditOutbox: projectedOutbox,
            changes: projectedChanges.changes,
            changeSequence: projectedChanges.sequence,
          });
        }
        await this.#scheduleQuarantineSnapshot(snapshot, {
          acceptInstalledWithDurableFallback: true,
        });
        this.#changes.splice(
          0,
          this.#changes.length,
          ...projectedChanges.changes,
        );
        this.#changeSequence = projectedChanges.sequence;
        this.#auditOutbox.clear();
        for (const [entryId, entry] of projectedOutbox) {
          this.#auditOutbox.set(entryId, entry);
        }
        this.#topologyIntents.delete(token.tokenId);
        this.#topologyTokens.delete(token.tokenId);
        this.#editorTopologyOwners.delete(token.tokenId);
        this.#recoveredTopologyTokens.delete(token.tokenId);
        try {
          await this.#drainAuditOutbox();
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Workspace path operation completed, but its durable audit projection remains pending (${error instanceof Error ? error.message : String(error)}). Reconnect to retry safely.`,
          );
        }
      });
    } finally {
      this.#topologyFinalizationPending = false;
    }
  }

  async releaseEditorTopologyMutation(
    input: WorkspaceEditorTopologyMutationFinalizeInput,
  ): Promise<{
    readonly released: true;
    readonly tokenId: string;
    readonly sync: WorkspaceEditorSyncResult;
  }> {
    const finalized = await this.#finalizeEditorTopologyMutation(
      input,
      null,
      false,
    );
    return {
      released: true,
      tokenId: finalized.token.tokenId,
      sync: finalized.sync,
    };
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
    const finalized = await this.#finalizeEditorTopologyMutation(
      input,
      input.status,
      false,
    );
    return {
      completed: true,
      tokenId: finalized.token.tokenId,
      status: input.status,
      sync: finalized.sync,
    };
  }

  async completeTopologyMutation(
    token: WorkspaceTopologyMutationToken,
    status: "applied" | "unknown_outcome",
  ): Promise<void> {
    await this.#finalizeTopologyMutation(token, status);
  }

  getProposal(proposalId: string): WorkspaceMutationProposal | null {
    return this.#proposals.get(proposalId) ?? null;
  }

  discardProposal(proposalId: string): boolean {
    this.#assertNoStaleAuthorityResolution();
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
          try {
            await this.#drainAuditOutbox();
          } catch (error) {
            throw new WorkspaceMutationCoordinatorError(
              "MUTATION_AUDIT_FAILED",
              `Workspace mutation proposal ${input.proposalId} is applied, but its durable audit transaction is still pending (${error instanceof Error ? error.message : String(error)}). Retry the exact acknowledgement to complete it safely.`,
            );
          }
          this.#assertLease(input);
          return receipt.result;
        }
        await this.#clearPendingAuditFence(
          `apply workspace mutation proposal ${input.proposalId}`,
        );
        const activeLease = this.#assertLease(input);
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
        const nextBuffers = new Map(this.#buffers);
        let nextAuthorityVersion = this.#authorityVersion;
        if (atBaseRevision) {
          nextBuffers.set(resolvedCommitment.path, {
            ...previous,
            path: resolvedCommitment.path,
            bufferHandle:
              previous.bufferHandle === 0
                ? resolvedCommitment.bufferHandle
                : previous.bufferHandle,
            changedtick: input.changedtick,
            contentSha256: input.contentSha256,
            contentBytes: Buffer.byteLength(input.content, "utf8"),
            content: input.content,
            authority: "editor_dirty",
            epoch: activeLease.epoch,
            editorInstanceId: activeLease.editorInstanceId,
            crossInstanceRecoveryAllowed: false,
            version: ++nextAuthorityVersion,
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
        const nextAuditOutbox = new Map(this.#auditOutbox);
        const terminalEntry = proposalTerminalLedgerEntry(
          this.workspaceRoot,
          resolvedCommitment,
          "applied",
          new Date(this.#now()).toISOString(),
        );
        rememberAuditOutboxEntry(nextAuditOutbox, terminalEntry);
        const terminalSnapshot = this.#assertQuarantineTransitionFits({
          buffers: nextBuffers,
          proposalCommitments: nextCommitments,
          proposalReceipts: nextReceipts,
          auditOutbox: nextAuditOutbox,
          changes: nextChanges.changes,
          changeSequence: nextChanges.sequence,
        });
        this.#assertProposalTerminalPersistenceCanStart();
        this.#proposalTerminalPersistencePending = true;
        try {
          // Establish a durable retryable checkpoint, then replace it with the
          // complete terminal state. During these fsyncs all Editor mutations
          // retry, while reads continue to observe the checkpoint state.
          await this.flushQuarantinePersistence().catch(() => {});
          await this.#scheduleQuarantineSnapshot(this.#quarantineSnapshot());
          await this.#ledger.assertAppendOnceCompatible([terminalEntry]);
          await this.#scheduleQuarantineSnapshot(terminalSnapshot, {
            acceptInstalledWithDurableFallback: true,
          });

          // Only after the terminal snapshot is installed do live structures
          // move together. Ledger projection happens later from its outbox.
          this.#buffers.clear();
          for (const [path, state] of nextBuffers) {
            this.#buffers.set(path, state);
          }
          this.#authorityVersion = nextAuthorityVersion;
          this.#proposals.delete(resolvedCommitment.proposalId);
          this.#proposalCommitments.clear();
          for (const [id, next] of nextCommitments) {
            this.#proposalCommitments.set(id, next);
          }
          this.#proposalReceipts.clear();
          for (const [id, next] of nextReceipts) {
            this.#proposalReceipts.set(id, next);
          }
          this.#auditOutbox.clear();
          for (const [entryId, entry] of nextAuditOutbox) {
            this.#auditOutbox.set(entryId, entry);
          }
          this.#changes.splice(0, this.#changes.length, ...nextChanges.changes);
          this.#changeSequence = nextChanges.sequence;
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Workspace mutation proposal ${input.proposalId} could not persist its applied decision (${error instanceof Error ? error.message : String(error)}). The live proposal remains retryable.`,
          );
        } finally {
          this.#proposalTerminalPersistencePending = false;
        }
        try {
          await this.#drainAuditOutbox();
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Workspace mutation proposal ${input.proposalId} is durably applied, but its append-only audit projection is pending (${error instanceof Error ? error.message : String(error)}). Retry the exact acknowledgement to complete it safely.`,
          );
        }
        this.#assertLease(input);
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
          try {
            await this.#drainAuditOutbox();
          } catch (error) {
            throw new WorkspaceMutationCoordinatorError(
              "MUTATION_AUDIT_FAILED",
              `Workspace mutation proposal ${input.proposalId} is discarded, but its durable audit transaction is still pending (${error instanceof Error ? error.message : String(error)}). Retry the exact acknowledgement to complete it safely.`,
            );
          }
          this.#assertLease(input);
          return receipt.result;
        }
        await this.#clearPendingAuditFence(
          `discard workspace mutation proposal ${input.proposalId}`,
        );
        this.#assertLease(input);
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
        const nextAuditOutbox = new Map(this.#auditOutbox);
        const terminalEntry = proposalTerminalLedgerEntry(
          this.workspaceRoot,
          resolvedCommitment,
          "discarded",
          new Date(this.#now()).toISOString(),
        );
        rememberAuditOutboxEntry(nextAuditOutbox, terminalEntry);
        const terminalSnapshot = this.#assertQuarantineTransitionFits({
          proposalCommitments: nextCommitments,
          proposalReceipts: nextReceipts,
          auditOutbox: nextAuditOutbox,
          changes: nextChanges.changes,
          changeSequence: nextChanges.sequence,
        });
        this.#assertProposalTerminalPersistenceCanStart();
        this.#proposalTerminalPersistencePending = true;
        try {
          await this.flushQuarantinePersistence().catch(() => {});
          await this.#scheduleQuarantineSnapshot(this.#quarantineSnapshot());
          await this.#ledger.assertAppendOnceCompatible([terminalEntry]);
          await this.#scheduleQuarantineSnapshot(terminalSnapshot, {
            acceptInstalledWithDurableFallback: true,
          });

          this.#proposals.delete(resolvedCommitment.proposalId);
          this.#proposalCommitments.clear();
          for (const [id, next] of nextCommitments) {
            this.#proposalCommitments.set(id, next);
          }
          this.#proposalReceipts.clear();
          for (const [id, next] of nextReceipts) {
            this.#proposalReceipts.set(id, next);
          }
          this.#auditOutbox.clear();
          for (const [entryId, entry] of nextAuditOutbox) {
            this.#auditOutbox.set(entryId, entry);
          }
          this.#changes.splice(0, this.#changes.length, ...nextChanges.changes);
          this.#changeSequence = nextChanges.sequence;
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Workspace mutation proposal ${input.proposalId} could not persist its discarded decision (${error instanceof Error ? error.message : String(error)}). The live proposal remains retryable.`,
          );
        } finally {
          this.#proposalTerminalPersistencePending = false;
        }
        try {
          await this.#drainAuditOutbox();
        } catch (error) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `Workspace mutation proposal ${input.proposalId} is durably discarded, but its append-only audit projection is pending (${error instanceof Error ? error.message : String(error)}). Retry the exact acknowledgement to complete it safely.`,
          );
        }
        this.#assertLease(input);
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

  staleAuthority(): readonly WorkspaceEditorStaleAuthorityEntry[] {
    this.#expireLeaseIfNeeded();
    return this.#currentStaleAuthority();
  }

  #currentStaleAuthority(): readonly WorkspaceEditorStaleAuthorityEntry[] {
    const states = [...this.#buffers.values()]
      .filter((state) => state.authority === "stale_dirty")
      .sort((left, right) => left.path.localeCompare(right.path));
    let remainingDiskBytes = MAX_SYNC_BYTES;
    return states.map((state) => {
      const entry = workspaceEditorStaleAuthorityEntry(
        state,
        remainingDiskBytes,
      );
      if (
        entry.diskState === "content" &&
        entry.diskContentBytes !== undefined
      ) {
        remainingDiskBytes -= entry.diskContentBytes;
      }
      return entry;
    });
  }

  #validateStaleAuthorityAbandonments(
    candidates: readonly WorkspaceEditorStaleAuthorityEntry[] | undefined,
  ): ReadonlyMap<string, WorkspaceEditorStaleAuthorityEntry> {
    if (candidates === undefined) return new Map();
    if (candidates.length === 0 || candidates.length > MAX_SYNCED_BUFFERS) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        `stale Editor authority confirmation must contain between 1 and ${MAX_SYNCED_BUFFERS} entries`,
      );
    }
    if (this.#quarantineHydrationFailed) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "unreadable Editor quarantine cannot be abandoned through a revision-specific confirmation",
      );
    }
    if (this.#tokens.size > 0 || this.#topologyTokens.size > 0) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "stale Editor authority cannot be abandoned while another workspace mutation is committing",
      );
    }

    const confirmed = new Map<string, WorkspaceEditorStaleAuthorityEntry>();
    for (const candidate of candidates) {
      if (!isWorkspaceEditorStaleAuthorityEntry(candidate)) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          "stale Editor authority confirmation is malformed",
        );
      }
      const path = this.resolvePath(candidate.path);
      if (candidate.path !== path || confirmed.has(path)) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          `stale Editor authority confirmation contains a duplicate or non-canonical path: ${candidate.path}`,
        );
      }
      const state = this.#buffers.get(path);
      if (state?.authority !== "stale_dirty") {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `stale Editor authority changed before confirmation: ${path}`,
        );
      }
      const current = workspaceEditorStaleAuthorityEntry(state);
      if (!workspaceEditorStaleAuthorityEntriesEqual(candidate, current)) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `stale Editor or disk authority changed before confirmation: ${path}. Review the current recovery evidence and confirm again.`,
        );
      }
      if (current.diskState === "unavailable") {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `Cannot use disk for quarantined editor buffer ${path}: the disk path is not a readable bounded regular file. Restore it or remove it, then review again.`,
        );
      }
      confirmed.set(path, current);
    }
    return confirmed;
  }

  #assertStaleAuthorityStillMatches(
    confirmed: ReadonlyMap<string, WorkspaceEditorStaleAuthorityEntry>,
  ): void {
    for (const [path, reviewed] of confirmed) {
      const state = this.#buffers.get(path);
      if (
        state?.authority !== "stale_dirty" ||
        !workspaceEditorStaleAuthorityEntriesEqual(
          reviewed,
          workspaceEditorStaleAuthorityEntry(state),
        )
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "EDITOR_LEASE_MISMATCH",
          `stale Editor or disk authority changed while confirming: ${path}. Review the current recovery evidence and confirm again.`,
        );
      }
    }
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
   * A live `disk_authoritative` buffer holds nothing an editor could lose.
   * Hydration deliberately rewrites persisted entries to `stale_dirty`,
   * including entries that were last known clean: disk may have changed while
   * the daemon was stopped, so those entries stay protected until the user
   * resolves their exact recovery evidence.
   */
  #hasProtectedBuffer(): boolean {
    for (const state of this.#buffers.values()) {
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

  #topologyInvalidationConflictForPath(
    path: string,
  ): WorkspaceChangeEvent | null {
    return (
      this.#changes.find(
        (change) =>
          change.kind === "topology" &&
          topologyTargetContainsPath(
            {
              path: change.path,
              includeDescendants: change.includeDescendants === true,
            },
            path,
          ),
      ) ?? null
    );
  }

  #topologyInvalidationConflictForTarget(
    target: WorkspaceTopologyMutationTarget & { readonly path: string },
  ): WorkspaceChangeEvent | null {
    return (
      this.#changes.find(
        (change) =>
          change.kind === "topology" &&
          topologyTargetsOverlap(
            {
              path: change.path,
              includeDescendants: change.includeDescendants === true,
            },
            {
              path: target.path,
              includeDescendants: target.includeDescendants === true,
            },
          ),
      ) ?? null
    );
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
    const expandedIntent: WorkspaceTopologyMutationIntent = {
      ...current,
      contentions: [...current.contentions, { path, beforeSha256 }],
    };
    const expandedIntents = new Map(this.#topologyIntents);
    expandedIntents.set(token.tokenId, expandedIntent);
    try {
      this.#assertQuarantineTransitionFits({
        topologyIntents: expandedIntents,
      });
    } catch (error) {
      if (
        error instanceof WorkspaceMutationCoordinatorError &&
        (error.code === "INVALID_EDITOR_SYNC" ||
          error.code === "MUTATION_AUDIT_FAILED")
      ) {
        // Exact contention evidence is an optimization. The durable target
        // fence is the conservative correctness record, and finalization
        // replaces it with an unacknowledged target-scoped invalidation. Do
        // not let an exact path consume capacity reserved for that terminal.
        return;
      }
      throw error;
    }
    this.#topologyIntents.set(token.tokenId, expandedIntent);
    this.#scheduleQuarantinePersistence();
  }

  #pendingTopologyReloadCount(): number {
    return [...this.#topologyIntents.values()].reduce(
      (total, intent) =>
        total + intent.targets.length + intent.contentions.length,
      0,
    );
  }

  flushQuarantinePersistence(): Promise<void> {
    return this.#pendingQuarantinePersistence;
  }

  async flushPendingAuditOutbox(): Promise<void> {
    try {
      await this.#serializeProposalState(() => this.#drainAuditOutbox());
    } catch (error) {
      throw new WorkspaceMutationCoordinatorError(
        "MUTATION_AUDIT_FAILED",
        `The pending workspace audit could not be completed (${error instanceof Error ? error.message : String(error)}). Editor authority remains fenced; reconnect to retry safely.`,
      );
    }
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

  #assertLease(
    input: WorkspaceEditorHeartbeatInput,
    allowStaleAuthorityResolution = false,
    allowTopologyFinalization = false,
  ): ActiveLease {
    if (
      this.#proposalTerminalPersistencePending ||
      (this.#staleAuthorityResolutionPending &&
        !allowStaleAuthorityResolution) ||
      (this.#topologyFinalizationPending && !allowTopologyFinalization)
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "a durable Editor resolution is committing; retry after it finishes",
      );
    }
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
    if (
      this.#staleAuthorityResolutionPending ||
      this.#proposalTerminalPersistencePending ||
      this.#topologyFinalizationPending
    ) {
      return;
    }
    if (this.#lease !== null && this.#now() >= this.#lease.expiresAt) {
      this.#quarantineLoadedBuffers(true);
      this.#orphanEditorTopologyTokens(this.#lease);
      this.#lease = null;
      this.#scheduleQuarantinePersistence();
    }
  }

  #assertNoStaleAuthorityResolution(): void {
    if (
      this.#staleAuthorityResolutionPending ||
      this.#proposalTerminalPersistencePending ||
      this.#topologyFinalizationPending
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "a durable Editor resolution is committing; retry after it finishes",
      );
    }
  }

  #assertProposalTerminalPersistenceCanStart(): void {
    if (this.#tokens.size > 0 || this.#topologyTokens.size > 0) {
      throw new WorkspaceMutationCoordinatorError(
        "EDITOR_LEASE_MISMATCH",
        "workspace mutation proposal cannot be resolved while another filesystem effect is committing",
      );
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

  #leaseResult(
    lease: ActiveLease,
    includeStaleAuthority = false,
  ): WorkspaceEditorLease {
    return {
      workspaceRoot: this.workspaceRoot,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: lease.sequence,
      expiresAt: lease.expiresAt,
      ...(includeStaleAuthority
        ? { staleAuthority: this.#currentStaleAuthority() }
        : {}),
    };
  }

  #recordChange(
    input: Omit<
      WorkspaceChangeEvent,
      "sequence" | "timestamp" | "workspaceRoot"
    >,
  ): void {
    const projected = this.#projectChanges([input]);
    try {
      this.#assertQuarantineTransitionFits({
        changes: projected.changes,
        changeSequence: projected.sequence,
      });
    } catch (error) {
      // Blocked/terminal informational events are disposable delivery-cache
      // entries backed by the permanent ledger. Omit one that would consume a
      // live proposal's resolution reserve instead of changing the caller's
      // already-audited blocked result.
      if (!isEditorReloadChange(input) && input.status !== "proposed") return;
      throw error;
    }
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

  /**
   * Validate both the candidate durable snapshot and the state from which all
   * surviving proposals can eventually resolve. Proposal terminals first
   * drain the audit outbox and cannot start until mutation/topology fences are
   * gone, so their capacity base is the candidate after every pending effect
   * has produced its largest possible reload event.
   */
  #assertQuarantineTransitionFits(
    overrides: WorkspaceQuarantineStateOverrides = {},
  ): WorkspaceQuarantineSnapshot {
    const snapshot = this.#quarantineSnapshot(overrides);
    this.#ledger.assertQuarantineFits(snapshot);

    const proposalCommitments =
      overrides.proposalCommitments ?? this.#proposalCommitments;
    const buffers = overrides.buffers ?? this.#buffers;
    const proposalReceipts =
      overrides.proposalReceipts ?? this.#proposalReceipts;
    const mutationIntents = overrides.mutationIntents ?? this.#mutationIntents;
    const topologyIntents = overrides.topologyIntents ?? this.#topologyIntents;
    const changes = overrides.changes ?? this.#changes;
    const changeSequence = overrides.changeSequence ?? this.#changeSequence;
    const pendingEffectChanges: Omit<
      WorkspaceChangeEvent,
      "sequence" | "timestamp" | "workspaceRoot"
    >[] = [];
    const terminalReadyAuditOutbox = new Map<
      string,
      WorkspaceChangeLedgerEntry
    >();
    for (const intent of mutationIntents.values()) {
      pendingEffectChanges.push({
        path: intent.path,
        source: intent.source,
        status: "unknown_outcome",
        beforeSha256: intent.beforeSha256,
        afterSha256: intent.intendedAfterSha256,
      });
    }
    for (const intent of topologyIntents.values()) {
      const token = this.#topologyTokens.get(intent.tokenId) ?? {
        tokenId: intent.tokenId,
        workspaceRoot: this.workspaceRoot,
        targets: intent.targets,
        source: intent.source,
        createdAt: 0,
      };
      for (const target of intent.targets) {
        pendingEffectChanges.push({
          kind: "topology",
          topologyTokenId: intent.tokenId,
          path: target.path,
          includeDescendants: target.includeDescendants,
          source: intent.source,
          status: "unknown_outcome",
        });
        rememberAuditOutboxEntry(
          terminalReadyAuditOutbox,
          topologyTerminalLedgerEntry(
            this.workspaceRoot,
            token,
            target,
            "unknown_outcome",
            new Date(this.#now()).toISOString(),
          ),
        );
      }
      for (const contention of intent.contentions) {
        pendingEffectChanges.push({
          path: contention.path,
          source: intent.source,
          status: "unknown_outcome",
          beforeSha256: contention.beforeSha256,
          // A completion may discover readable disk content. Reserve the
          // digest field even when the current path is absent or unreadable.
          afterSha256: contention.beforeSha256,
        });
      }
    }
    const terminalReadyChanges = this.#projectChanges(pendingEffectChanges, {
      changes,
      sequence: changeSequence,
    });
    const terminalReadySnapshot = this.#quarantineSnapshot({
      buffers,
      proposalCommitments,
      proposalReceipts,
      auditOutbox: terminalReadyAuditOutbox,
      mutationIntents: new Map(),
      topologyIntents: new Map(),
      changes: terminalReadyChanges.changes,
      changeSequence: terminalReadyChanges.sequence,
    });
    this.#ledger.assertQuarantineFits(terminalReadySnapshot);
    if (proposalCommitments.size === 0) return snapshot;
    // Admission must remain valid after a hard restart, when proposal source
    // text and the next Editor identity are unavailable. Reserve the largest
    // valid serialized identity, epoch, changedtick, and content-byte width;
    // source contents themselves are never written to quarantine.
    const terminalLease = {
      editorInstanceId: "\u0000".repeat(256),
      leaseToken: "",
      epoch: Number.MAX_SAFE_INTEGER,
      sequence: -1,
      expiresAt: 0,
    } satisfies ActiveLease;
    this.#assertAllProposalTerminalOutcomesFit({
      buffers,
      proposalCommitments,
      proposalReceipts,
      auditOutbox: new Map(),
      mutationIntents: new Map(),
      topologyIntents: new Map(),
      changes: terminalReadyChanges.changes,
      changeSequence: terminalReadyChanges.sequence,
      appliedContentBytes: new Map(),
      activeLease: terminalLease,
    });
    return snapshot;
  }

  #repairHydratedProposalTerminalCapacity(): boolean {
    let pruned = false;
    for (;;) {
      try {
        this.#assertQuarantineTransitionFits();
        return pruned;
      } catch (error) {
        // Older snapshots predate terminal-capacity reservation. The review
        // feed is a bounded cache backed by the append-only ledger, and these
        // are the same disposable events ordinary projection evicts. Preserve
        // proposal discovery and Editor reload events; if those alone cannot
        // satisfy the invariant, hydration remains fail-closed.
        const disposableIndex = this.#changes.findIndex(
          (change) =>
            !isEditorReloadChange(change) && change.status !== "proposed",
        );
        if (disposableIndex >= 0) {
          this.#changes.splice(disposableIndex, 1);
          pruned = true;
          continue;
        }
        const optionalContention = [...this.#topologyIntents.values()].find(
          (intent) => intent.contentions.length > 0,
        );
        if (optionalContention === undefined) throw error;
        // Pre-target-invalidation snapshots could spend their remaining byte
        // budget on exact contention hints. The target scope is the durable
        // correctness fence in the current schema, so discard only those
        // optional hints during migration and preserve every target/token.
        this.#topologyIntents.set(optionalContention.tokenId, {
          ...optionalContention,
          contentions: [],
        });
        pruned = true;
      }
    }
  }

  #assertAllProposalTerminalOutcomesFit(input: {
    readonly buffers: ReadonlyMap<string, EditorBufferState>;
    readonly proposalCommitments: ReadonlyMap<
      string,
      WorkspaceProposalCommitment
    >;
    readonly proposalReceipts: ReadonlyMap<string, WorkspaceProposalReceipt>;
    readonly auditOutbox: ReadonlyMap<string, WorkspaceChangeLedgerEntry>;
    readonly mutationIntents: ReadonlyMap<string, WorkspaceMutationIntent>;
    readonly topologyIntents: ReadonlyMap<
      string,
      WorkspaceTopologyMutationIntent
    >;
    readonly changes: readonly WorkspaceChangeEvent[];
    readonly changeSequence: number;
    readonly appliedContentBytes: ReadonlyMap<string, number>;
    readonly activeLease: ActiveLease;
  }): void {
    const terminalTimestamp = new Date(this.#now()).toISOString();
    const projectWorstAppliedTerminal = (
      commitment: WorkspaceProposalCommitment,
      state: {
        readonly buffers: ReadonlyMap<string, EditorBufferState>;
        readonly proposalCommitments: ReadonlyMap<
          string,
          WorkspaceProposalCommitment
        >;
        readonly proposalReceipts: ReadonlyMap<
          string,
          WorkspaceProposalReceipt
        >;
        readonly changes: readonly WorkspaceChangeEvent[];
        readonly changeSequence: number;
      },
    ) => {
      const proposalCommitments = new Map(state.proposalCommitments);
      proposalCommitments.delete(commitment.proposalId);
      const existingBuffer = state.buffers.get(commitment.path);
      const buffers = new Map(state.buffers);
      buffers.set(commitment.path, {
        path: commitment.path,
        bufferHandle: existingBuffer?.bufferHandle ?? commitment.bufferHandle,
        changedtick: Number.MAX_SAFE_INTEGER,
        contentSha256: commitment.afterContentSha256,
        contentBytes:
          input.appliedContentBytes.get(commitment.proposalId) ??
          MAX_BUFFER_BYTES,
        authority: "editor_dirty",
        epoch: input.activeLease.epoch,
        editorInstanceId: input.activeLease.editorInstanceId,
        crossInstanceRecoveryAllowed: false,
        version: existingBuffer?.version ?? this.#authorityVersion,
      });
      const proposalReceipts = new Map(state.proposalReceipts);
      proposalReceipts.set(commitment.proposalId, {
        action: "applied",
        changedtick: Number.MAX_SAFE_INTEGER,
        contentSha256: commitment.afterContentSha256,
        result: {
          applied: true,
          proposalId: commitment.proposalId,
          path: commitment.path,
          changedtick: Number.MAX_SAFE_INTEGER,
          contentSha256: commitment.afterContentSha256,
        },
      });
      evictOldestProposalReceipts(proposalReceipts);
      const projectedChanges = this.#projectChanges(
        [
          {
            path: commitment.path,
            source: commitment.source,
            status: "applied",
            beforeSha256: commitment.baseContentSha256,
            afterSha256: commitment.afterContentSha256,
            proposalId: commitment.proposalId,
          },
        ],
        { changes: state.changes, sequence: state.changeSequence },
      );
      return {
        buffers,
        proposalCommitments,
        proposalReceipts,
        changes: projectedChanges.changes,
        changeSequence: projectedChanges.sequence,
      };
    };
    const projectAppliedEnvelope = (
      commitment: WorkspaceProposalCommitment,
      state: {
        readonly buffers: ReadonlyMap<string, EditorBufferState>;
        readonly proposalCommitments: ReadonlyMap<
          string,
          WorkspaceProposalCommitment
        >;
        readonly proposalReceipts: ReadonlyMap<
          string,
          WorkspaceProposalReceipt
        >;
        readonly changes: readonly WorkspaceChangeEvent[];
        readonly changeSequence: number;
      },
      removeCommitment: boolean,
    ) => {
      const proposalCommitments = new Map(state.proposalCommitments);
      if (removeCommitment) {
        proposalCommitments.delete(commitment.proposalId);
      }
      const existingBuffer = state.buffers.get(commitment.path);
      const buffers = new Map(state.buffers);
      buffers.set(commitment.path, {
        path: commitment.path,
        bufferHandle: existingBuffer?.bufferHandle ?? commitment.bufferHandle,
        changedtick: Number.MAX_SAFE_INTEGER,
        contentSha256: commitment.afterContentSha256,
        contentBytes:
          input.appliedContentBytes.get(commitment.proposalId) ??
          MAX_BUFFER_BYTES,
        authority: "editor_dirty",
        epoch: input.activeLease.epoch,
        editorInstanceId: input.activeLease.editorInstanceId,
        crossInstanceRecoveryAllowed: false,
        version: existingBuffer?.version ?? this.#authorityVersion,
      });
      const proposalReceipts = new Map(state.proposalReceipts);
      proposalReceipts.set(commitment.proposalId, {
        action: "applied",
        changedtick: Number.MAX_SAFE_INTEGER,
        contentSha256: commitment.afterContentSha256,
        result: {
          applied: true,
          proposalId: commitment.proposalId,
          path: commitment.path,
          changedtick: Number.MAX_SAFE_INTEGER,
          contentSha256: commitment.afterContentSha256,
        },
      });
      const changeSequence = state.changeSequence + 1;
      const changes = [
        ...state.changes,
        {
          sequence: changeSequence,
          timestamp: terminalTimestamp,
          workspaceRoot: this.workspaceRoot,
          path: commitment.path,
          source: commitment.source,
          // `discarded` is the longest terminal status spelling. The phantom
          // receipt above remains the larger applied representation.
          status: "discarded" as const,
          beforeSha256: commitment.baseContentSha256,
          afterSha256: commitment.afterContentSha256,
          proposalId: commitment.proposalId,
        },
      ];
      return {
        buffers,
        proposalCommitments,
        proposalReceipts,
        changes,
        changeSequence,
      };
    };

    for (const commitment of input.proposalCommitments.values()) {
      const immediateBase = {
        buffers: input.buffers,
        proposalCommitments: input.proposalCommitments,
        proposalReceipts: input.proposalReceipts,
        changes: input.changes,
        changeSequence: input.changeSequence,
      };
      let terminalBase = immediateBase;
      // Proposal terminals are serialized and drain their outbox between
      // decisions. Reserve the target after every other live commitment has
      // already reached its larger applied steady state; checking each one
      // against the shared unresolved base misses cumulative receipt/buffer
      // growth across a sequence of terminals and can strand the last review.
      for (const prior of input.proposalCommitments.values()) {
        if (prior.proposalId === commitment.proposalId) continue;
        terminalBase = projectAppliedEnvelope(prior, terminalBase, false);
      }
      for (const [candidateBase, envelope] of [
        [immediateBase, false] as const,
        [terminalBase, true] as const,
      ]) {
        const applied = envelope
          ? projectAppliedEnvelope(commitment, candidateBase, true)
          : projectWorstAppliedTerminal(commitment, candidateBase);
        const appliedAuditOutbox = new Map(input.auditOutbox);
        rememberAuditOutboxEntry(
          appliedAuditOutbox,
          proposalTerminalLedgerEntry(
            this.workspaceRoot,
            commitment,
            "applied",
            terminalTimestamp,
          ),
        );
        this.#ledger.assertQuarantineFits(
          this.#quarantineSnapshot({
            buffers: applied.buffers,
            proposalCommitments: applied.proposalCommitments,
            proposalReceipts: applied.proposalReceipts,
            auditOutbox: appliedAuditOutbox,
            mutationIntents: input.mutationIntents,
            topologyIntents: input.topologyIntents,
            changes: applied.changes,
            changeSequence: applied.changeSequence,
          }),
          { allowProjectedShapeOverflow: envelope },
        );

        const remainingCommitments = new Map(candidateBase.proposalCommitments);
        remainingCommitments.delete(commitment.proposalId);
        const discardedReceipts = new Map(candidateBase.proposalReceipts);
        discardedReceipts.set(commitment.proposalId, {
          action: "discarded",
          result: {
            discarded: true,
            proposalId: commitment.proposalId,
            path: commitment.path,
          },
        });
        if (!envelope) evictOldestProposalReceipts(discardedReceipts);
        const discardedChanges = envelope
          ? {
              changes: [
                ...candidateBase.changes,
                {
                  sequence: candidateBase.changeSequence + 1,
                  timestamp: terminalTimestamp,
                  workspaceRoot: this.workspaceRoot,
                  path: commitment.path,
                  source: commitment.source,
                  status: "discarded" as const,
                  beforeSha256: commitment.baseContentSha256,
                  afterSha256: commitment.afterContentSha256,
                  proposalId: commitment.proposalId,
                },
              ],
              sequence: candidateBase.changeSequence + 1,
            }
          : this.#projectChanges(
              [
                {
                  path: commitment.path,
                  source: commitment.source,
                  status: "discarded",
                  beforeSha256: commitment.baseContentSha256,
                  afterSha256: commitment.afterContentSha256,
                  proposalId: commitment.proposalId,
                },
              ],
              {
                changes: candidateBase.changes,
                sequence: candidateBase.changeSequence,
              },
            );
        const discardedAuditOutbox = new Map(input.auditOutbox);
        rememberAuditOutboxEntry(
          discardedAuditOutbox,
          proposalTerminalLedgerEntry(
            this.workspaceRoot,
            commitment,
            "discarded",
            terminalTimestamp,
          ),
        );
        this.#ledger.assertQuarantineFits(
          this.#quarantineSnapshot({
            buffers: candidateBase.buffers,
            proposalCommitments: remainingCommitments,
            proposalReceipts: discardedReceipts,
            auditOutbox: discardedAuditOutbox,
            mutationIntents: input.mutationIntents,
            topologyIntents: input.topologyIntents,
            changes: discardedChanges.changes,
            changeSequence: discardedChanges.sequence,
          }),
          { allowProjectedShapeOverflow: envelope },
        );
      }
    }
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
    overrides: WorkspaceQuarantineStateOverrides = {},
  ): WorkspaceQuarantineSnapshot {
    const buffers = overrides.buffers ?? this.#buffers;
    const proposalCommitments =
      overrides.proposalCommitments ?? this.#proposalCommitments;
    const proposalReceipts =
      overrides.proposalReceipts ?? this.#proposalReceipts;
    const auditOutbox = overrides.auditOutbox ?? this.#auditOutbox;
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
      auditOutbox: [...auditOutbox.values()],
    };
  }

  async #drainAuditOutbox(): Promise<void> {
    await this.flushQuarantinePersistence();
    if (this.#auditOutbox.size === 0) return;
    const entries = [...this.#auditOutbox.values()];
    await this.#appendLedgerOnce(entries);

    for (const entry of entries) {
      const current = this.#auditOutbox.get(entry.entryId);
      if (
        current !== undefined &&
        workspaceChangeLedgerEntriesSemanticallyEqual(current, entry)
      ) {
        this.#auditOutbox.delete(entry.entryId);
      }
    }
    this.#scheduleQuarantinePersistence();
    try {
      await this.flushQuarantinePersistence();
    } catch (error) {
      // The append-only ledger is already durable. Restore the outbox in
      // memory so a later retry proves append-once and retries cleanup; a
      // concurrently installed cleanup snapshot is also safe because it can
      // only omit entries already present in the permanent ledger.
      for (const entry of entries) {
        if (!this.#auditOutbox.has(entry.entryId)) {
          this.#auditOutbox.set(entry.entryId, entry);
        }
      }
      throw error;
    }
  }

  async #clearPendingAuditFence(action: string): Promise<void> {
    if (this.#auditOutbox.size === 0) return;
    try {
      await this.#drainAuditOutbox();
    } catch (error) {
      throw new WorkspaceMutationCoordinatorError(
        "MUTATION_AUDIT_FAILED",
        `Cannot ${action} while a previous durable workspace audit is still pending (${error instanceof Error ? error.message : String(error)}). Retry after audit projection recovers.`,
      );
    }
    if (this.#auditOutbox.size !== 0) {
      throw new WorkspaceMutationCoordinatorError(
        "MUTATION_AUDIT_FAILED",
        `Cannot ${action} while a previous durable workspace audit is still pending.`,
      );
    }
  }

  async #writeQuarantine(
    snapshot: WorkspaceQuarantineSnapshot,
    options: {
      readonly acceptInstalledWithDurableFallback?: boolean;
    } = {},
  ): Promise<void> {
    if (this.#beforePersistQuarantine !== undefined) {
      await this.#beforePersistQuarantine();
    }
    await this.#ledger.writeQuarantine(snapshot, options);
  }

  #scheduleQuarantineSnapshot(
    snapshot: WorkspaceQuarantineSnapshot,
    options: {
      readonly acceptInstalledWithDurableFallback?: boolean;
    } = {},
  ): Promise<void> {
    let pending: Promise<void>;
    try {
      // Transaction callers already validate terminal headroom from their
      // map projections. Keep a non-recursive raw-size guard at the final
      // scheduling boundary as defense in depth.
      this.#ledger.assertQuarantineFits(snapshot);
      pending = this.#writeQuarantine(snapshot, options);
    } catch (error) {
      pending = Promise.reject(error);
    }
    this.#pendingQuarantinePersistence = pending;
    void pending.catch(() => {});
    return pending;
  }

  #scheduleQuarantinePersistence(): void {
    let pending: Promise<void>;
    try {
      if (this.#quarantineHydrationFailed) {
        throw new WorkspaceMutationCoordinatorError(
          "INVALID_EDITOR_SYNC",
          "workspace quarantine is unreadable or unsafe; explicitly abandon dirty quarantine before replacing it",
        );
      }
      pending = this.#writeQuarantine(this.#assertQuarantineTransitionFits());
    } catch (error) {
      pending = Promise.reject(error);
    }
    this.#pendingQuarantinePersistence = pending;
    // Preserve the rejected promise for the next daemon/mutation boundary,
    // while preventing an unhandled rejection if no boundary arrives before
    // process shutdown.
    void pending.catch(() => {});
  }

  #hydrateQuarantine(value: unknown): boolean {
    if (
      !isRecord(value) ||
      (value.version !== 1 && value.version !== 2) ||
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
          value.changes.length > MAX_CHANGE_EVENTS)) ||
      (value.version === 1 && value.auditOutbox !== undefined) ||
      (value.version === 2 &&
        (!Array.isArray(value.auditOutbox) ||
          value.auditOutbox.length > MAX_AUDIT_OUTBOX_ENTRIES))
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
      const topologyChange =
        isRecord(candidate) && candidate.kind === "topology";
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
        (topologyChange
          ? (candidate.status !== "applied" &&
              candidate.status !== "unknown_outcome") ||
            !isValidPersistedIdentifier(candidate.topologyTokenId) ||
            typeof candidate.includeDescendants !== "boolean" ||
            candidate.beforeSha256 !== undefined ||
            candidate.afterSha256 !== undefined ||
            candidate.proposalId !== undefined
          : (candidate.kind !== undefined && candidate.kind !== "path") ||
            !isSha256Digest(candidate.beforeSha256) ||
            candidate.topologyTokenId !== undefined ||
            candidate.includeDescendants !== undefined) ||
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
        ...(topologyChange
          ? { kind: "topology" as const }
          : candidate.kind === "path"
            ? { kind: "path" as const }
            : {}),
        status: candidate.status,
        ...(candidate.beforeSha256 !== undefined
          ? { beforeSha256: candidate.beforeSha256 as string }
          : {}),
        ...(candidate.afterSha256 !== undefined
          ? { afterSha256: candidate.afterSha256 }
          : {}),
        ...(candidate.proposalId !== undefined
          ? { proposalId: candidate.proposalId }
          : {}),
        ...(topologyChange
          ? { topologyTokenId: candidate.topologyTokenId as string }
          : {}),
        ...(topologyChange
          ? { includeDescendants: candidate.includeDescendants as boolean }
          : {}),
      });
      previousSequence = candidate.sequence;
    }
    this.#changeSequence = changeSequence;

    const auditOutbox =
      value.version === 2 && Array.isArray(value.auditOutbox)
        ? value.auditOutbox
        : [];
    for (const candidate of auditOutbox) {
      const entry = persistedWorkspaceChangeLedgerEntry(
        candidate,
        this.workspaceRoot,
      );
      if (entry === null) {
        throw new Error("invalid workspace audit outbox entry");
      }
      if (
        entry.proposalId !== undefined &&
        (entry.status === "applied" || entry.status === "discarded")
      ) {
        const receipt = this.#proposalReceipts.get(entry.proposalId);
        if (
          receipt === undefined ||
          this.#proposalCommitments.has(entry.proposalId) ||
          receipt.action !== entry.status ||
          receipt.result.path !== entry.path ||
          entry.afterSha256 === undefined ||
          (receipt.action === "applied" &&
            receipt.contentSha256 !== entry.afterSha256)
        ) {
          throw new Error(
            "workspace proposal receipt conflicts with its terminal audit outbox entry",
          );
        }
      }
      const existing = this.#auditOutbox.get(entry.entryId);
      if (existing !== undefined) {
        if (!workspaceChangeLedgerEntriesSemanticallyEqual(existing, entry)) {
          throw new Error("conflicting workspace audit outbox entry");
        }
        continue;
      }
      this.#auditOutbox.set(entry.entryId, entry);
    }

    const mutationIntents = value.mutationIntents ?? [];
    const recoveredMutationChanges: Omit<
      WorkspaceChangeEvent,
      "sequence" | "timestamp" | "workspaceRoot"
    >[] = [];
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
      recoveredMutationChanges.push({
        path: this.resolvePath(candidate.path),
        source: candidate.source,
        status: "unknown_outcome",
        beforeSha256: candidate.beforeSha256,
        afterSha256: candidate.intendedAfterSha256,
      });
    }
    const recoveredChanges = this.#projectChanges(recoveredMutationChanges);
    this.#changes.splice(0, this.#changes.length, ...recoveredChanges.changes);
    this.#changeSequence = recoveredChanges.sequence;

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
    const prunedDisposableChanges =
      this.#repairHydratedProposalTerminalCapacity();
    return mutationIntents.length > 0 || prunedDisposableChanges;
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
      WorkspaceToolOperationToken | undefined;
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
    const requiresStrictCandidateReads = this.hasProtectedEditorAuthority(root);
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

  assertAppendOnceCompatible(
    entries: readonly WorkspaceChangeLedgerEntry[],
  ): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    const requestedIds = new Set<string>();
    const requestedProposalTerminals = new Map<
      string,
      WorkspaceChangeLedgerEntry
    >();
    for (const entry of entries) {
      if (
        entry.workspaceRoot !== this.#workspaceRoot ||
        persistedWorkspaceChangeLedgerEntry(entry, this.#workspaceRoot) === null
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "MUTATION_AUDIT_FAILED",
          "invalid workspace audit outbox entry",
        );
      }
      requestedIds.add(entry.entryId);
      const terminalKey = workspaceProposalTerminalKey(entry);
      if (terminalKey === null) continue;
      const previous = requestedProposalTerminals.get(terminalKey);
      if (
        previous !== undefined &&
        !workspaceProposalTerminalEntriesSemanticallyEqual(previous, entry)
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "MUTATION_AUDIT_FAILED",
          `conflicting terminal workspace audit outcomes for proposal ${entry.proposalId}`,
        );
      }
      requestedProposalTerminals.set(terminalKey, entry);
    }

    return this.#serialize(async () => {
      const existing = await this.#readLedgerEntries(
        requestedIds,
        new Set(requestedProposalTerminals.keys()),
      );
      for (const entry of entries) {
        const previous = existing.byEntryId.get(entry.entryId);
        if (
          previous !== undefined &&
          !workspaceChangeLedgerEntriesSemanticallyEqual(previous, entry)
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `workspace audit entry id has a different terminal payload: ${entry.entryId}`,
          );
        }
        const terminalKey = workspaceProposalTerminalKey(entry);
        const previousTerminal =
          terminalKey === null
            ? undefined
            : existing.byProposalTerminal.get(terminalKey);
        if (
          previousTerminal !== undefined &&
          !workspaceProposalTerminalEntriesSemanticallyEqual(
            previousTerminal,
            entry,
          )
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `workspace proposal ${entry.proposalId} already has a different terminal audit outcome`,
          );
        }
      }
    });
  }

  appendOnce(entries: readonly WorkspaceChangeLedgerEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    const requested = new Map<string, WorkspaceChangeLedgerEntry>();
    const requestedProposalTerminals = new Map<
      string,
      WorkspaceChangeLedgerEntry
    >();
    for (const entry of entries) {
      if (
        entry.workspaceRoot !== this.#workspaceRoot ||
        persistedWorkspaceChangeLedgerEntry(entry, this.#workspaceRoot) === null
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "MUTATION_AUDIT_FAILED",
          "invalid workspace audit outbox entry",
        );
      }
      const previous = requested.get(entry.entryId);
      if (
        previous !== undefined &&
        !workspaceChangeLedgerEntriesSemanticallyEqual(previous, entry)
      ) {
        throw new WorkspaceMutationCoordinatorError(
          "MUTATION_AUDIT_FAILED",
          `conflicting workspace audit entry id: ${entry.entryId}`,
        );
      }
      requested.set(entry.entryId, entry);
      const terminalKey = workspaceProposalTerminalKey(entry);
      if (terminalKey !== null) {
        const previousTerminal = requestedProposalTerminals.get(terminalKey);
        if (
          previousTerminal !== undefined &&
          !workspaceProposalTerminalEntriesSemanticallyEqual(
            previousTerminal,
            entry,
          )
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `conflicting terminal workspace audit outcomes for proposal ${entry.proposalId}`,
          );
        }
        requestedProposalTerminals.set(terminalKey, entry);
      }
    }

    return this.#serialize(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const existing = await this.#readLedgerEntries(
        new Set(requested.keys()),
        new Set(requestedProposalTerminals.keys()),
      );
      const missing: WorkspaceChangeLedgerEntry[] = [];
      for (const entry of requested.values()) {
        const previous = existing.byEntryId.get(entry.entryId);
        if (
          previous !== undefined &&
          !workspaceChangeLedgerEntriesSemanticallyEqual(previous, entry)
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `workspace audit entry id has a different terminal payload: ${entry.entryId}`,
          );
        }
        const terminalKey = workspaceProposalTerminalKey(entry);
        const previousTerminal =
          terminalKey === null
            ? undefined
            : existing.byProposalTerminal.get(terminalKey);
        if (
          previousTerminal !== undefined &&
          !workspaceProposalTerminalEntriesSemanticallyEqual(
            previousTerminal,
            entry,
          )
        ) {
          throw new WorkspaceMutationCoordinatorError(
            "MUTATION_AUDIT_FAILED",
            `workspace proposal ${entry.proposalId} already has a different terminal audit outcome`,
          );
        }
        if (previous === undefined && previousTerminal === undefined) {
          missing.push(entry);
        }
      }
      if (missing.length > 0) {
        await appendFile(
          this.#ledgerPath,
          missing.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
          { encoding: "utf8", mode: 0o600 },
        );
      }
      const handle = await open(this.#ledgerPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(this.#directory);
    });
  }

  async #readLedgerEntries(
    requestedIds: ReadonlySet<string>,
    requestedProposalTerminals: ReadonlySet<string>,
  ): Promise<{
    readonly byEntryId: ReadonlyMap<string, WorkspaceChangeLedgerEntry>;
    readonly byProposalTerminal: ReadonlyMap<
      string,
      WorkspaceChangeLedgerEntry
    >;
  }> {
    let handle;
    try {
      handle = await open(this.#ledgerPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { byEntryId: new Map(), byProposalTerminal: new Map() };
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new Error("workspace mutation ledger is not a regular file");
      }
      if (stats.size > 0) {
        const lastByte = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(lastByte, 0, 1, stats.size - 1);
        if (bytesRead !== 1 || lastByte[0] !== 0x0a) {
          throw new Error("workspace mutation ledger has an incomplete record");
        }
      }
      const byEntryId = new Map<string, WorkspaceChangeLedgerEntry>();
      const byProposalTerminal = new Map<string, WorkspaceChangeLedgerEntry>();
      const stream = handle.createReadStream({
        encoding: "utf8",
        autoClose: false,
        start: 0,
      });
      const lines = createReadlineInterface({
        input: stream,
        crlfDelay: Infinity,
      });
      try {
        for await (const line of lines) {
          if (line.length === 0) {
            throw new Error(
              "workspace mutation ledger contains an empty record",
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            throw new Error("workspace mutation ledger contains invalid JSON");
          }
          const entry = persistedWorkspaceChangeLedgerEntry(
            parsed,
            this.#workspaceRoot,
          );
          if (entry === null) {
            throw new Error(
              "workspace mutation ledger contains an invalid record",
            );
          }
          if (requestedIds.has(entry.entryId)) {
            const previous = byEntryId.get(entry.entryId);
            if (
              previous !== undefined &&
              !workspaceChangeLedgerEntriesSemanticallyEqual(previous, entry)
            ) {
              throw new Error(
                `workspace mutation ledger contains conflicting entry id ${entry.entryId}`,
              );
            }
            byEntryId.set(entry.entryId, entry);
          }
          const terminalKey = workspaceProposalTerminalKey(entry);
          if (
            terminalKey !== null &&
            requestedProposalTerminals.has(terminalKey)
          ) {
            const previousTerminal = byProposalTerminal.get(terminalKey);
            if (
              previousTerminal !== undefined &&
              !workspaceProposalTerminalEntriesSemanticallyEqual(
                previousTerminal,
                entry,
              )
            ) {
              throw new Error(
                `workspace mutation ledger contains conflicting terminal outcomes for proposal ${entry.proposalId}`,
              );
            }
            byProposalTerminal.set(terminalKey, entry);
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      return { byEntryId, byProposalTerminal };
    } finally {
      await handle.close();
    }
  }

  assertQuarantineFits(
    input: WorkspaceQuarantineSnapshot,
    options: { readonly allowProjectedShapeOverflow?: boolean } = {},
  ): void {
    this.#serializeQuarantine(input, options);
  }

  writeQuarantine(
    input: WorkspaceQuarantineSnapshot,
    options: {
      readonly acceptInstalledWithDurableFallback?: boolean;
    } = {},
  ): Promise<void> {
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
      try {
        await fsyncDirectory(this.#directory);
      } catch (error) {
        if (options.acceptInstalledWithDurableFallback !== true) throw error;
        // The caller fsynced a conservative snapshot at this pathname before
        // this rename. The replacement file was also fsynced before rename, so
        // a crash can expose either the protected fallback or this exact new
        // snapshot. Accept the installed replacement in the live process only
        // after proving that it is byte-for-byte the requested snapshot.
        let installed: string;
        try {
          installed = await readFile(this.#quarantinePath, "utf8");
        } catch {
          throw error;
        }
        if (installed !== serialized) throw error;
      }
    });
  }

  #serializeQuarantine(
    input: WorkspaceQuarantineSnapshot,
    options: { readonly allowProjectedShapeOverflow?: boolean } = {},
  ): string {
    if (
      options.allowProjectedShapeOverflow !== true &&
      (input.entries.length > MAX_SYNCED_BUFFERS ||
        input.proposalCommitments.length > MAX_PENDING_PROPOSALS ||
        input.proposalReceipts.length > MAX_PROPOSAL_RECEIPTS ||
        input.mutationIntents.length > MAX_CHANGE_EVENTS ||
        input.topologyIntents.length > MAX_CHANGE_EVENTS ||
        input.changes.length > MAX_CHANGE_EVENTS ||
        input.auditOutbox.length > MAX_AUDIT_OUTBOX_ENTRIES)
    ) {
      throw new WorkspaceMutationCoordinatorError(
        "INVALID_EDITOR_SYNC",
        "workspace quarantine exceeds persisted collection limits",
      );
    }
    const version = input.auditOutbox.length > 0 ? 2 : 1;
    const serialized = `${JSON.stringify({
      version,
      workspaceRoot: this.#workspaceRoot,
      entries: input.entries,
      proposalCommitments: input.proposalCommitments,
      proposalReceipts: input.proposalReceipts,
      mutationIntents: input.mutationIntents,
      topologyIntents: input.topologyIntents,
      changeSequence: input.changeSequence,
      changes: input.changes,
      ...(version === 2 ? { auditOutbox: input.auditOutbox } : {}),
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

function evictOldestProposalReceipts(
  receipts: Map<string, WorkspaceProposalReceipt>,
): void {
  while (receipts.size > MAX_PROPOSAL_RECEIPTS) {
    const oldest = receipts.keys().next().value;
    if (typeof oldest !== "string") break;
    receipts.delete(oldest);
  }
}

function rememberAuditOutboxEntry(
  outbox: Map<string, WorkspaceChangeLedgerEntry>,
  entry: WorkspaceChangeLedgerEntry,
): void {
  const previous = outbox.get(entry.entryId);
  if (previous !== undefined) {
    if (!workspaceChangeLedgerEntriesSemanticallyEqual(previous, entry)) {
      throw new WorkspaceMutationCoordinatorError(
        "MUTATION_AUDIT_FAILED",
        `workspace audit entry id has a different terminal payload: ${entry.entryId}`,
      );
    }
    return;
  }
  if (outbox.size >= MAX_AUDIT_OUTBOX_ENTRIES) {
    throw new WorkspaceMutationCoordinatorError(
      "MUTATION_AUDIT_FAILED",
      "workspace audit outbox is full; retry after pending audit records are projected",
    );
  }
  outbox.set(entry.entryId, entry);
}

function staleAuthorityDiscardLedgerEntry(
  workspaceRoot: string,
  evidence: WorkspaceEditorStaleAuthorityEntry,
  change: WorkspaceChangeLedgerAppendInput,
  timestamp: string,
): WorkspaceChangeLedgerEntry {
  const entryId = createHash("sha256")
    .update(
      JSON.stringify([
        "stale-editor-authority-discard-v1",
        workspaceRoot,
        evidence.path,
        evidence.editorContentSha256,
        evidence.editorContentBytes,
        evidence.changedtick,
        evidence.editorInstanceId,
        evidence.epoch,
        evidence.editorState,
        evidence.diskState,
        evidence.diskContentSha256 ?? null,
        evidence.diskContentBytes ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
  return {
    version: 1,
    entryId,
    timestamp,
    workspaceRoot,
    ...change,
  };
}

function proposalTerminalLedgerEntry(
  workspaceRoot: string,
  commitment: WorkspaceProposalCommitment,
  status: "applied" | "discarded",
  timestamp: string,
): WorkspaceChangeLedgerEntry {
  // Applied and discarded terminal outcomes deliberately share this semantic
  // id namespace. If opposite outcomes are ever projected for one proposal,
  // appendOnce rejects the collision instead of recording a contradiction.
  const entryId = createHash("sha256")
    .update(
      JSON.stringify([
        "workspace-proposal-terminal-v1",
        workspaceRoot,
        commitment.proposalId,
      ]),
      "utf8",
    )
    .digest("hex");
  return {
    version: 1,
    entryId,
    timestamp,
    workspaceRoot,
    path: commitment.path,
    source: commitment.source,
    status,
    beforeSha256: commitment.baseContentSha256,
    afterSha256: commitment.afterContentSha256,
    proposalId: commitment.proposalId,
  };
}

function topologyTerminalLedgerEntry(
  workspaceRoot: string,
  token: WorkspaceTopologyMutationToken,
  target: WorkspaceTopologyMutationToken["targets"][number],
  status: "applied" | "unknown_outcome",
  timestamp: string,
): WorkspaceChangeLedgerEntry {
  const entryId = createHash("sha256")
    .update(
      JSON.stringify([
        "workspace-topology-terminal-v1",
        workspaceRoot,
        token.tokenId,
        target.path,
        target.includeDescendants,
      ]),
    )
    .digest("hex");
  return {
    version: 1,
    entryId,
    timestamp,
    workspaceRoot,
    path: target.path,
    source: token.source,
    kind: "topology",
    status,
    topologyTokenId: token.tokenId,
    includeDescendants: target.includeDescendants,
  };
}

function workspaceProposalTerminalKey(
  entry: WorkspaceChangeLedgerEntry,
): string | null {
  if (
    entry.proposalId === undefined ||
    (entry.status !== "applied" && entry.status !== "discarded")
  ) {
    return null;
  }
  return JSON.stringify([entry.workspaceRoot, entry.proposalId]);
}

function workspaceProposalTerminalEntriesSemanticallyEqual(
  left: WorkspaceChangeLedgerEntry,
  right: WorkspaceChangeLedgerEntry,
): boolean {
  return (
    workspaceProposalTerminalKey(left) !== null &&
    workspaceProposalTerminalKey(left) ===
      workspaceProposalTerminalKey(right) &&
    left.version === right.version &&
    left.workspaceRoot === right.workspaceRoot &&
    left.path === right.path &&
    left.source === right.source &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.beforeSha256 === right.beforeSha256 &&
    left.afterSha256 === right.afterSha256 &&
    left.sessionId === right.sessionId &&
    left.toolCallId === right.toolCallId &&
    left.proposalId === right.proposalId &&
    left.topologyTokenId === right.topologyTokenId &&
    left.includeDescendants === right.includeDescendants
  );
}

function workspaceChangeLedgerEntriesSemanticallyEqual(
  left: WorkspaceChangeLedgerEntry,
  right: WorkspaceChangeLedgerEntry,
): boolean {
  return (
    left.version === right.version &&
    left.entryId === right.entryId &&
    left.workspaceRoot === right.workspaceRoot &&
    left.path === right.path &&
    left.source === right.source &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.beforeSha256 === right.beforeSha256 &&
    left.afterSha256 === right.afterSha256 &&
    left.sessionId === right.sessionId &&
    left.toolCallId === right.toolCallId &&
    left.proposalId === right.proposalId &&
    left.topologyTokenId === right.topologyTokenId &&
    left.includeDescendants === right.includeDescendants
  );
}

function persistedWorkspaceChangeLedgerEntry(
  value: unknown,
  workspaceRoot: string,
): WorkspaceChangeLedgerEntry | null {
  const topologyEntry = isRecord(value) && value.kind === "topology";
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isValidPersistedIdentifier(value.entryId) ||
    typeof value.timestamp !== "string" ||
    Number.isNaN(Date.parse(value.timestamp)) ||
    typeof value.workspaceRoot !== "string" ||
    !isAbsolute(value.workspaceRoot) ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    !isWorkspaceMutationSource(value.source) ||
    !isWorkspaceChangeStatus(value.status) ||
    (topologyEntry
      ? (value.status !== "applied" && value.status !== "unknown_outcome") ||
        !isValidPersistedIdentifier(value.topologyTokenId) ||
        typeof value.includeDescendants !== "boolean" ||
        value.beforeSha256 !== undefined ||
        value.afterSha256 !== undefined ||
        value.proposalId !== undefined
      : (value.kind !== undefined && value.kind !== "path") ||
        !isSha256Digest(value.beforeSha256) ||
        value.topologyTokenId !== undefined ||
        value.includeDescendants !== undefined) ||
    (value.afterSha256 !== undefined && !isSha256Digest(value.afterSha256)) ||
    (value.sessionId !== undefined &&
      !isValidPersistedIdentifier(value.sessionId)) ||
    (value.toolCallId !== undefined &&
      !isValidPersistedIdentifier(value.toolCallId)) ||
    (value.proposalId !== undefined &&
      !isValidPersistedIdentifier(value.proposalId))
  ) {
    return null;
  }
  let persistedWorkspaceRoot: string;
  let path: string;
  try {
    persistedWorkspaceRoot = canonicalizePathSync(value.workspaceRoot);
    const persistedRootSpelling = normalizePathIdentity(
      resolve(value.workspaceRoot),
    );
    const persistedPathSpelling = normalizePathIdentity(resolve(value.path));
    const relativePath = relative(persistedRootSpelling, persistedPathSpelling);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return null;
    }
    // Ledger paths are historical identities. Resolve only the persisted root
    // alias against today's filesystem, then preserve its lexical suffix so a
    // descendant symlink changing or disappearing cannot poison old records.
    path = normalizePathIdentity(resolve(workspaceRoot, relativePath));
  } catch {
    return null;
  }
  if (persistedWorkspaceRoot !== workspaceRoot) return null;
  if (!isAbsolute(path) || !isSameOrDescendantPath(workspaceRoot, path)) {
    return null;
  }
  return {
    version: 1,
    entryId: value.entryId,
    timestamp: value.timestamp,
    workspaceRoot,
    path,
    source: value.source,
    ...(topologyEntry
      ? { kind: "topology" as const }
      : value.kind === "path"
        ? { kind: "path" as const }
        : {}),
    status: value.status,
    ...(value.beforeSha256 !== undefined
      ? { beforeSha256: value.beforeSha256 as string }
      : {}),
    ...(value.afterSha256 !== undefined
      ? { afterSha256: value.afterSha256 }
      : {}),
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(value.toolCallId !== undefined ? { toolCallId: value.toolCallId } : {}),
    ...(value.proposalId !== undefined ? { proposalId: value.proposalId } : {}),
    ...(topologyEntry
      ? { topologyTokenId: value.topologyTokenId as string }
      : {}),
    ...(topologyEntry
      ? { includeDescendants: value.includeDescendants as boolean }
      : {}),
  };
}

type WorkspaceEditorDiskAuthorityState =
  | {
      readonly diskState: "content";
      readonly diskContentSha256: string;
      readonly diskContentBytes: number;
    }
  | { readonly diskState: "missing" }
  | { readonly diskState: "unavailable" };

function boundedDiskAuthorityStateSync(
  path: string,
  maxContentBytes = MAX_BUFFER_BYTES,
): WorkspaceEditorDiskAuthorityState {
  let descriptor: number;
  try {
    // A quarantined path is external state and may have been replaced while
    // the daemon was stopped. O_NONBLOCK lets fstat classify FIFOs/devices as
    // unavailable without ever blocking the daemon event loop on open().
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { diskState: "missing" }
      : { diskState: "unavailable" };
  }
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size > MAX_BUFFER_BYTES ||
      before.size > maxContentBytes
    ) {
      return { diskState: "unavailable" };
    }
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
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      return { diskState: "unavailable" };
    }
    return {
      diskState: "content",
      diskContentSha256: createHash("sha256")
        .update(content.subarray(0, offset))
        .digest("hex"),
      diskContentBytes: offset,
    };
  } catch {
    return { diskState: "unavailable" };
  } finally {
    closeSync(descriptor);
  }
}

function boundedDiskSha256Sync(path: string): string | null {
  const state = boundedDiskAuthorityStateSync(path);
  return state.diskState === "content" ? state.diskContentSha256 : null;
}

function workspaceEditorStaleAuthorityEntry(
  state: EditorBufferState,
  maxDiskBytes = MAX_BUFFER_BYTES,
): WorkspaceEditorStaleAuthorityEntry {
  return {
    path: state.path,
    editorContentSha256: state.contentSha256,
    editorContentBytes: state.contentBytes,
    changedtick: state.changedtick,
    editorInstanceId: state.editorInstanceId,
    epoch: state.epoch,
    editorState:
      state.quarantinedFrom === "disk_authoritative" ? "clean" : "dirty",
    ...boundedDiskAuthorityStateSync(state.path, maxDiskBytes),
  };
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

function isWorkspaceEditorStaleAuthorityEntry(
  value: unknown,
): value is WorkspaceEditorStaleAuthorityEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value.path !== "string" ||
    !isSha256Digest(value.editorContentSha256) ||
    !isNonNegativeSafeInteger(value.editorContentBytes) ||
    !isNonNegativeSafeInteger(value.changedtick) ||
    !isValidPersistedIdentifier(value.editorInstanceId) ||
    !isPositiveSafeInteger(value.epoch) ||
    (value.editorState !== "dirty" && value.editorState !== "clean") ||
    (value.diskState !== "content" &&
      value.diskState !== "missing" &&
      value.diskState !== "unavailable")
  ) {
    return false;
  }
  if (value.diskState === "content") {
    return (
      isSha256Digest(value.diskContentSha256) &&
      isNonNegativeSafeInteger(value.diskContentBytes)
    );
  }
  return (
    value.diskContentSha256 === undefined &&
    value.diskContentBytes === undefined
  );
}

function workspaceEditorStaleAuthorityEntriesEqual(
  left: WorkspaceEditorStaleAuthorityEntry,
  right: WorkspaceEditorStaleAuthorityEntry,
): boolean {
  return (
    left.path === right.path &&
    left.editorContentSha256 === right.editorContentSha256 &&
    left.editorContentBytes === right.editorContentBytes &&
    left.changedtick === right.changedtick &&
    left.editorInstanceId === right.editorInstanceId &&
    left.epoch === right.epoch &&
    left.editorState === right.editorState &&
    left.diskState === right.diskState &&
    left.diskContentSha256 === right.diskContentSha256 &&
    left.diskContentBytes === right.diskContentBytes
  );
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
  change: Pick<WorkspaceChangeEvent, "kind" | "status" | "proposalId">,
): boolean {
  return (
    change.kind === "topology" ||
    (change.proposalId === undefined &&
      (change.status === "applied" || change.status === "unknown_outcome"))
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
        snapshots: coordinator.authoritativeDirtySnapshotsUnderIdentity(scope),
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

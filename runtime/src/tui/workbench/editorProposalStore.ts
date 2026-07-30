import type {
  BufferEditorProposal,
  BufferEditorProposalResolution,
} from "./buffer/providers/types.js";

export type EditorProposalRecord = {
  readonly id: string;
  readonly proposal: BufferEditorProposal;
  readonly status:
    | "staged"
    | "unavailable"
    | "recovery"
    | "accepting"
    | "rejecting"
    | "acknowledgement"
    | "accepted"
    | "rejected"
    | "stale"
    | "error";
  readonly message?: string;
  readonly changedtick?: number;
  readonly acknowledgementAction?: "accept" | "reject";
  /**
   * A daemon restart restores only the proposal's content-free commitment.
   * A mismatched live buffer permits only explicit discard. An exact committed
   * after-hash permits explicit acceptance acknowledgement without restoring
   * or inventing source bytes.
   */
  readonly reviewMode?:
    "accept_or_reject" | "discard_only" | "acceptance_recovery";
  readonly recovery?: {
    readonly kind: "content_free_acceptance";
    readonly afterContentSha256: string;
    readonly liveContentSha256: string;
  };
  readonly resolve?: (
    action: "accept" | "reject",
  ) => Promise<BufferEditorProposalResolution>;
  /**
   * Workspace-backed proposals remain durable after their Neovim shadow goes
   * stale. They require an authenticated daemon discard instead of the local
   * stale-record dismissal used by ephemeral editor-only proposals.
   */
  readonly discardStale?: () => Promise<BufferEditorProposalResolution>;
  readonly staleDiscardActive?: boolean;
};

export type UnavailableEditorProposalRecordInput = {
  readonly id: string;
  readonly path: string;
  readonly sourceLabel: string;
  readonly baseContentSha256: string;
  readonly message: string;
  readonly discard: () => Promise<BufferEditorProposalResolution>;
};

export type ContentFreeEditorProposalRecoveryInput = {
  readonly id: string;
  readonly path: string;
  readonly sourceLabel: string;
  readonly baseContentSha256: string;
  readonly afterContentSha256: string;
  readonly baseChangedtick: number;
  readonly bufferHandle: number;
  readonly liveContentSha256: string;
  readonly message?: string;
  readonly acknowledge: () => Promise<BufferEditorProposalResolution>;
  readonly discard: () => Promise<BufferEditorProposalResolution>;
};

let records = new Map<string, EditorProposalRecord>();
let revision = 0;
const listeners = new Set<() => void>();
const MAX_EDITOR_PROPOSAL_RECORDS = 32;

export function editorProposalRecord(
  proposalId: string,
): EditorProposalRecord | null {
  return records.get(proposalId) ?? null;
}

export function editorProposalStoreRevision(): number {
  return revision;
}

export function activeEditorProposalId(): string | null {
  for (const [id, record] of records) {
    if (
      record.status === "staged" ||
      record.status === "unavailable" ||
      record.status === "recovery" ||
      record.status === "accepting" ||
      record.status === "rejecting" ||
      record.status === "acknowledgement" ||
      record.status === "error" ||
      (record.staleDiscardActive === true && record.status === "stale") ||
      ((record.reviewMode === "discard_only" ||
        record.reviewMode === "acceptance_recovery") &&
        (record.status === "error" || record.status === "stale"))
    ) {
      return id;
    }
  }
  return null;
}

export function subscribeEditorProposalStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function stageEditorProposalRecord(
  proposal: BufferEditorProposal,
  resolve?: EditorProposalRecord["resolve"],
  discardStale?: EditorProposalRecord["discardStale"],
): EditorProposalRecord {
  const id = proposalId(proposal);
  const record: EditorProposalRecord = {
    id,
    proposal,
    status: "staged",
    reviewMode: "accept_or_reject",
    ...(resolve !== undefined ? { resolve } : {}),
    ...(discardStale !== undefined ? { discardStale } : {}),
  };
  return rememberRecord(record);
}

/**
 * Surface a durable proposal commitment whose before/after source disappeared
 * with the daemon process. The placeholder contains no source bytes and its
 * resolver permits only explicit discard.
 */
export function stageUnavailableEditorProposalRecord(
  input: UnavailableEditorProposalRecordInput,
): EditorProposalRecord {
  const record: EditorProposalRecord = {
    id: input.id,
    proposal: {
      version: 1,
      interaction_id: input.id,
      path: input.path,
      buffer_handle: 1,
      base_changedtick: 0,
      base_content_sha256: input.baseContentSha256,
      summary: `${input.sourceLabel} proposal recovery`,
      edits: [],
    },
    status: "unavailable",
    message: input.message,
    reviewMode: "discard_only",
    resolve: (action) =>
      action === "reject"
        ? input.discard()
        : Promise.resolve({
            ok: false,
            proposalId: input.id,
            reason:
              "This recovered proposal has no reviewable source and can only be discarded.",
          }),
  };
  return rememberRecord(record);
}

/**
 * Surface a content-free durable commitment after restart.
 *
 * Acceptance recovery is offered only when the caller's exact live-buffer
 * digest matches the committed replacement digest. Otherwise this falls back
 * to the existing discard-only recovery mode; source text is never invented
 * or reconstructed in either path.
 */
export function stageContentFreeEditorProposalRecoveryRecord(
  input: ContentFreeEditorProposalRecoveryInput,
): EditorProposalRecord {
  assertSha256(input.baseContentSha256, "baseContentSha256");
  assertSha256(input.afterContentSha256, "afterContentSha256");
  assertSha256(input.liveContentSha256, "liveContentSha256");
  if (input.liveContentSha256 !== input.afterContentSha256) {
    return stageUnavailableEditorProposalRecord({
      id: input.id,
      path: input.path,
      sourceLabel: input.sourceLabel,
      baseContentSha256: input.baseContentSha256,
      message:
        input.message ??
        "The live Editor buffer does not match the committed replacement; only explicit discard is safe.",
      discard: input.discard,
    });
  }
  if (
    !Number.isSafeInteger(input.baseChangedtick) ||
    input.baseChangedtick < 0
  ) {
    throw new Error(
      "Editor proposal recovery baseChangedtick must be a non-negative safe integer.",
    );
  }
  if (!Number.isSafeInteger(input.bufferHandle) || input.bufferHandle <= 0) {
    throw new Error(
      "Editor proposal recovery bufferHandle must be a positive safe integer.",
    );
  }
  const record: EditorProposalRecord = {
    id: input.id,
    proposal: {
      version: 1,
      interaction_id: input.id,
      path: input.path,
      buffer_handle: input.bufferHandle,
      base_changedtick: input.baseChangedtick,
      base_content_sha256: input.baseContentSha256,
      summary: `${input.sourceLabel} acceptance recovery`,
      edits: [],
    },
    status: "recovery",
    ...(input.message !== undefined ? { message: input.message } : {}),
    reviewMode: "acceptance_recovery",
    recovery: {
      kind: "content_free_acceptance",
      afterContentSha256: input.afterContentSha256,
      liveContentSha256: input.liveContentSha256,
    },
    resolve: (action) =>
      action === "accept" ? input.acknowledge() : input.discard(),
  };
  return rememberRecord(record);
}

function rememberRecord(record: EditorProposalRecord): EditorProposalRecord {
  const next = new Map(records);
  // Re-staging the same revision should become the newest entry.
  next.delete(record.id);
  if (next.size >= MAX_EDITOR_PROPOSAL_RECORDS) {
    throw new Error(
      `Editor already has ${MAX_EDITOR_PROPOSAL_RECORDS} unresolved proposals. ` +
        "Accept or reject an existing proposal before staging another.",
    );
  }
  next.set(record.id, record);
  records = next;
  publish();
  return record;
}

export function markEditorProposalPending(
  proposalIdValue: string,
  status: "accepting" | "rejecting",
): void {
  const current = records.get(proposalIdValue);
  if (!current) return;
  records = new Map(records).set(proposalIdValue, {
    ...current,
    status,
    message: undefined,
  });
  publish();
}

export function resolveEditorProposalRecord(
  result: BufferEditorProposalResolution,
): void {
  const current = records.get(result.proposalId);
  if (!current) return;
  if (
    result.ok &&
    (result.action === "accepted" || result.action === "rejected")
  ) {
    // Once the rail closes, retain no old/new source text in this process.
    records = new Map(records);
    records.delete(result.proposalId);
    publish();
    return;
  }
  records = new Map(records).set(result.proposalId, {
    ...current,
    status: result.ok
      ? result.action === "accepted"
        ? "accepted"
        : result.action === "rejected"
          ? "rejected"
          : "staged"
      : result.stale === true
        ? "stale"
        : result.acknowledgementPending === true
          ? "acknowledgement"
          : "error",
    ...(!result.ok ? { message: result.reason } : {}),
    ...(!result.ok && result.acknowledgementAction !== undefined
      ? { acknowledgementAction: result.acknowledgementAction }
      : {}),
    ...(!result.ok &&
    result.stale === true &&
    current.discardStale !== undefined
      ? { staleDiscardActive: true }
      : {}),
    ...(result.ok && result.changedtick !== undefined
      ? { changedtick: result.changedtick }
      : {}),
  });
  publish();
}

/**
 * Drop a proposal whose editor shadow has already become unusable.
 *
 * This is deliberately narrower than a general record delete: a local accept
 * or reject that is awaiting daemon acknowledgement must remain review-gated
 * until that acknowledgement succeeds.
 */
export function dismissStaleEditorProposalRecord(
  proposalIdValue: string,
): boolean {
  const current = records.get(proposalIdValue);
  if (current?.status !== "stale" || current.discardStale !== undefined) {
    return false;
  }
  records = new Map(records);
  records.delete(proposalIdValue);
  publish();
  return true;
}

export function clearEditorProposalRecords(): void {
  if (records.size === 0) return;
  records = new Map();
  publish();
}

export function proposalId(proposal: BufferEditorProposal): string {
  return `${proposal.interaction_id}:${proposal.base_changedtick}`;
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(
      `Editor proposal recovery ${field} must be a lowercase SHA-256 digest.`,
    );
  }
}

function publish(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

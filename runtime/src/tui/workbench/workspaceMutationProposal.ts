import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type {
  WorkspaceEditorChangeResult,
  WorkspaceEditorProposalResult,
  WorkspaceEditorProposalStatusResult,
} from "../../app-server/protocol/index.js";
import type { EditorProposalPayload } from "../../tools/system/editor-proposal.js";

export type WorkspaceMutationProposalReference = {
  readonly proposalId: string;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly source: string;
  readonly baseContentSha256: string;
  readonly afterContentSha256: string;
  /**
   * Live tool events include the exact editor revision. Durable change records
   * retain only content-free hashes, so these fields are absent when a
   * surviving proposal is rediscovered after a daemon restart.
   */
  readonly baseChangedtick?: number;
  readonly bufferHandle?: number;
};

export type WorkspaceMutationProposalLocalOutcome =
  | {
      readonly action: "accept";
      readonly result: {
        readonly ok: true;
        readonly action: "accepted";
        readonly proposalId: string;
        readonly changedtick: number;
      };
      readonly proposal: WorkspaceEditorProposalResult;
    }
  | {
      readonly action: "reject";
      readonly result: {
        readonly ok: true;
        readonly action: "rejected";
        readonly proposalId: string;
      };
    };

/**
 * A local accept/reject is irreversible even if the daemon reply is lost.
 * Preserve the first outcome monotonically so an opposite retry can never
 * rewrite the recovery decision.
 */
export function adoptWorkspaceMutationProposalLocalOutcome(
  outcomes: Map<string, WorkspaceMutationProposalLocalOutcome>,
  proposalId: string,
  next: WorkspaceMutationProposalLocalOutcome,
): WorkspaceMutationProposalLocalOutcome {
  const retained = outcomes.get(proposalId);
  if (retained !== undefined) return retained;
  outcomes.set(proposalId, next);
  return next;
}

export function workspaceMutationTerminalResolutionAction(
  status: "applied" | "discarded" | "missing",
  localAction: WorkspaceMutationProposalLocalOutcome["action"] | undefined,
): "accepted" | "rejected" {
  return status === "applied" ||
    (status === "missing" && localAction === "accept")
    ? "accepted"
    : "rejected";
}

export function workspaceMutationTerminalStatusMatchesLocalOutcome(
  status: "applied" | "discarded" | "missing",
  localAction: WorkspaceMutationProposalLocalOutcome["action"] | undefined,
): boolean {
  return (
    localAction === undefined ||
    status === "missing" ||
    (status === "applied" && localAction === "accept") ||
    (status === "discarded" && localAction === "reject")
  );
}

/**
 * Extracts only the opaque, content-free proposal reference emitted by an
 * ordinary mutating Agent tool. Full before/after source is fetched through
 * the authenticated editor lease and never placed in the transcript event.
 */
export function workspaceMutationProposalFromTuiEvent(
  event: unknown,
): WorkspaceMutationProposalReference | null {
  if (!isRecord(event) || event.type !== "tool_call_completed") return null;
  const payload = isRecord(event.payload) ? event.payload : null;
  if (payload?.isError !== true) return null;
  const metadata = isRecord(payload.metadata) ? payload.metadata : null;
  const mutation = isRecord(metadata?.workspaceMutation)
    ? metadata.workspaceMutation
    : null;
  if (mutation?.kind !== "editor_proposal") return null;
  if (
    !nonEmptyString(mutation.proposalId) ||
    !nonEmptyString(mutation.workspaceRoot) ||
    !nonEmptyString(mutation.path) ||
    !nonEmptyString(mutation.source) ||
    !sha256Digest(mutation.baseContentSha256) ||
    !sha256Digest(mutation.afterContentSha256) ||
    !nonNegativeInteger(mutation.baseChangedtick) ||
    !positiveInteger(mutation.bufferHandle)
  ) {
    return null;
  }
  return {
    proposalId: mutation.proposalId,
    workspaceRoot: mutation.workspaceRoot,
    path: mutation.path,
    source: mutation.source,
    baseContentSha256: mutation.baseContentSha256,
    afterContentSha256: mutation.afterContentSha256,
    baseChangedtick: mutation.baseChangedtick,
    bufferHandle: mutation.bufferHandle,
  };
}

/**
 * Adapts the durable, content-free mutation feed to the same proposal staging
 * path as live tool events. Returning null for a malformed proposed record is
 * deliberate: the caller must leave its durable cursor unacknowledged rather
 * than silently skipping a proposal it cannot safely identify.
 */
export function workspaceMutationProposalFromChange(
  change: WorkspaceEditorChangeResult,
): WorkspaceMutationProposalReference | null {
  if (
    change.status !== "proposed" ||
    !nonEmptyString(change.proposalId) ||
    !nonEmptyString(change.workspaceRoot) ||
    !nonEmptyString(change.path) ||
    !nonEmptyString(change.source) ||
    !sha256Digest(change.beforeSha256) ||
    !sha256Digest(change.afterSha256)
  ) {
    return null;
  }
  return {
    proposalId: change.proposalId,
    workspaceRoot: change.workspaceRoot,
    path: change.path,
    source: change.source,
    baseContentSha256: change.beforeSha256,
    afterContentSha256: change.afterSha256,
  };
}

/**
 * Adapts the daemon's exact whole-buffer candidate to the existing Neovim
 * shadow-proposal renderer. The final newline is represented as an explicit
 * buffer option so every source byte remains round-trippable.
 */
export function editorProposalFromWorkspaceMutation(
  proposal: WorkspaceEditorProposalResult,
): EditorProposalPayload {
  const before = splitFinalNewline(proposal.beforeText);
  const after = splitFinalNewline(proposal.afterText);
  const beforeLines = before.body.split("\n");
  const lastLine = beforeLines[beforeLines.length - 1] ?? "";
  return {
    version: 1,
    interaction_id: `workspace-mutation:${proposal.proposalId}`,
    path: proposal.path,
    buffer_handle: proposal.bufferHandle,
    base_changedtick: proposal.baseChangedtick,
    base_content_sha256: proposal.baseContentSha256,
    base_end_of_line: before.endOfLine,
    new_end_of_line: after.endOfLine,
    summary: `${workspaceMutationSourceLabel(proposal.source)} requested by Agent`,
    edits: [
      {
        id: `workspace-mutation:${proposal.proposalId}`,
        start_line: 1,
        start_column: 0,
        end_line: beforeLines.length,
        end_column: Buffer.byteLength(lastLine, "utf8"),
        old_text: before.body,
        new_text: after.body,
      },
    ],
  };
}

export function workspaceMutationReferenceMatchesProposal(
  reference: WorkspaceMutationProposalReference,
  proposal: WorkspaceEditorProposalResult,
): boolean {
  return (
    proposal.proposalId === reference.proposalId &&
    proposal.workspaceRoot === reference.workspaceRoot &&
    proposal.path === reference.path &&
    proposal.source === reference.source &&
    proposal.baseContentSha256 === reference.baseContentSha256 &&
    sha256(proposal.afterText) === reference.afterContentSha256 &&
    (reference.baseChangedtick === undefined ||
      proposal.baseChangedtick === reference.baseChangedtick) &&
    (reference.bufferHandle === undefined ||
      proposal.bufferHandle === reference.bufferHandle)
  );
}

export function workspaceMutationReferenceMatchesCommitment(
  reference: WorkspaceMutationProposalReference,
  status: Extract<
    WorkspaceEditorProposalStatusResult,
    { readonly status: "committed" }
  >,
): boolean {
  return (
    status.proposalId === reference.proposalId &&
    status.path === reference.path &&
    status.source === reference.source &&
    status.baseContentSha256 === reference.baseContentSha256 &&
    status.afterContentSha256 === reference.afterContentSha256 &&
    (reference.baseChangedtick === undefined ||
      status.baseChangedtick === reference.baseChangedtick) &&
    (reference.bufferHandle === undefined ||
      status.bufferHandle === reference.bufferHandle)
  );
}

/**
 * A terminal daemon receipt may dismiss the review rail only when it proves
 * that it belongs to the exact proposal announced to this Editor. Applied
 * receipts additionally bind the resulting revision and bytes whenever the
 * announcement carried those fields.
 */
export function workspaceMutationReferenceMatchesTerminalStatus(
  reference: WorkspaceMutationProposalReference,
  status: Extract<
    WorkspaceEditorProposalStatusResult,
    { readonly status: "applied" | "discarded" }
  >,
): boolean {
  if (
    status.proposalId !== reference.proposalId ||
    status.path !== reference.path
  ) {
    return false;
  }
  if (status.status === "discarded") return true;
  return (
    positiveInteger(status.changedtick) &&
    sha256Digest(status.contentSha256) &&
    status.contentSha256 === reference.afterContentSha256 &&
    (reference.baseChangedtick === undefined ||
      status.changedtick > reference.baseChangedtick)
  );
}

function splitFinalNewline(content: string): {
  readonly body: string;
  readonly endOfLine: boolean;
} {
  return content.endsWith("\n")
    ? { body: content.slice(0, -1), endOfLine: true }
    : { body: content, endOfLine: false };
}

function workspaceMutationSourceLabel(source: string): string {
  switch (source) {
    case "file_edit":
      return "Edit";
    case "file_multi_edit":
      return "MultiEdit";
    case "file_write":
      return "Write";
    case "apply_patch":
      return "ApplyPatch";
    case "notebook_edit":
      return "NotebookEdit";
    case "rewind":
      return "Rewind";
    case "shell":
      return "Shell";
    default:
      return "File mutation";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/u.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

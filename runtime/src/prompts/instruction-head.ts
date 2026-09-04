/**
 * Keep the instruction head of the prompt byte-stable for a session.
 *
 * The workspace instructions (AGENC.md tiers) and the persistent memory
 * indexes (MEMORY.md) open the system prompt, ahead of the trusted base
 * prompt so they can never shadow it. They were re-read every turn, and the
 * memory extraction child rewrites MEMORY.md every few turns, so the first
 * bytes of the prompt changed and the provider's cache missed from byte zero
 * at the next turn (measured: cached 0 of 46k tokens right after an
 * extraction run). The head now keeps the version the session started with;
 * a change is delivered once as a system-reminder near the end of the
 * prompt (`instruction_update`), which the attachment ledger then keeps in
 * place. Compaction rewrites the history anyway, so the head is re-snapshotted
 * there (see `resetRelevantMemoryBudget`).
 *
 * @module
 */

import type { AttachmentTrackingState } from "../session/attachment-state.js";

export interface InstructionHeadTexts {
  readonly workspaceText: string;
  readonly memoryText: string;
}

export interface InstructionHeadUpdate {
  readonly workspaceText?: string;
  readonly memoryText?: string;
}

/**
 * Returns the texts to put at the head of the prompt for this turn: the
 * session's first version. When `fresh` differs from what the model was last
 * told, the difference is queued for the update producer.
 */
export function stabilizeInstructionHead(
  tracking: AttachmentTrackingState,
  fresh: InstructionHeadTexts,
  scope: string,
): InstructionHeadTexts {
  // A turn in another workspace is another set of instructions, not a change
  // to this one: start a fresh head for it instead of announcing a diff.
  if (
    tracking.instructionHead === undefined ||
    tracking.instructionHeadScope !== scope
  ) {
    tracking.instructionHead = fresh;
    tracking.instructionHeadScope = scope;
    tracking.instructionAnnounced = fresh;
    tracking.pendingInstructionUpdate = undefined;
    return fresh;
  }
  const announced = tracking.instructionAnnounced ?? tracking.instructionHead;
  const pending: { workspaceText?: string; memoryText?: string } = {};
  if (fresh.workspaceText !== announced.workspaceText) {
    pending.workspaceText = fresh.workspaceText;
  }
  if (fresh.memoryText !== announced.memoryText) {
    pending.memoryText = fresh.memoryText;
  }
  tracking.pendingInstructionUpdate =
    pending.workspaceText === undefined && pending.memoryText === undefined
      ? undefined
      : pending;
  return tracking.instructionHead;
}

/** Take the queued update, marking its content as told to the model. */
export function takeInstructionHeadUpdate(
  tracking: AttachmentTrackingState,
): InstructionHeadUpdate | undefined {
  const pending = tracking.pendingInstructionUpdate;
  if (pending === undefined) return undefined;
  tracking.pendingInstructionUpdate = undefined;
  const announced = tracking.instructionAnnounced ?? tracking.instructionHead;
  tracking.instructionAnnounced = {
    workspaceText: pending.workspaceText ?? announced?.workspaceText ?? "",
    memoryText: pending.memoryText ?? announced?.memoryText ?? "",
  };
  return pending;
}

/** Forget the snapshot; the next turn re-reads and starts a new head. */
export function resetInstructionHead(tracking: AttachmentTrackingState): void {
  tracking.instructionHead = undefined;
  tracking.instructionHeadScope = undefined;
  tracking.instructionAnnounced = undefined;
  tracking.pendingInstructionUpdate = undefined;
}

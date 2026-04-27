/**
 * Memory citation metadata.
 *
 * Codex uses explicit citation blocks so memory-derived claims can be
 * audited and usage can be tracked. AgenC keeps the same data model but
 * stores it as structured metadata on the session state before choosing
 * any user-visible rendering.
 *
 * @module
 */

import { getAttachmentTrackingState } from "../../session/attachment-state.js";

export interface MemoryCitationEntry {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly note: string;
  readonly rolloutIds: readonly string[];
}

export function recordMemoryCitation(
  sessionKey: object,
  citation: MemoryCitationEntry,
): void {
  const state = getAttachmentTrackingState(sessionKey);
  const existing = state.memoryCitations.find(
    (entry) =>
      entry.path === citation.path &&
      entry.lineStart === citation.lineStart &&
      entry.lineEnd === citation.lineEnd &&
      entry.note === citation.note,
  );
  if (existing !== undefined) return;
  state.memoryCitations.push(citation);
}

export function getMemoryCitations(
  sessionKey: object,
): readonly MemoryCitationEntry[] {
  return getAttachmentTrackingState(sessionKey).memoryCitations;
}

export function clearMemoryCitations(sessionKey: object): void {
  getAttachmentTrackingState(sessionKey).memoryCitations.length = 0;
}

export function lineCount(text: string): number {
  if (text.length === 0) return 1;
  return text.split("\n").length;
}


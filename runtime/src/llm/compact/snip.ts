/**
 * Snip layer — drops the oldest messages from a long-idle session
 * before any model call. Mirrors `claude_code/services/compact/snip.ts`.
 *
 * Snip is a non-summarizing trim. It just removes messages from the
 * head of the array when the session has been idle for `gapMs` and
 * the history is longer than `keepRecent`. The intent is to keep
 * cold sessions cheap to resume without paying compaction overhead.
 *
 * Cut 5.1 of the claude_code-alignment refactor.
 *
 * @module
 */

import type { LLMMessage } from "../types.js";
import {
  collectPreservedAttachments,
  type PreservedAttachment,
} from "./attachments.js";
import {
  COMPACT_BOUNDARY_SUBTYPE,
  DEFAULT_SNIP_GAP_MS,
  DEFAULT_SNIP_KEEP_RECENT,
} from "./constants.js";

export interface SnipState {
  readonly lastTouchMs: number;
  readonly snipCount: number;
}

export function createSnipState(): SnipState {
  return { lastTouchMs: 0, snipCount: 0 };
}

interface SnipInput {
  readonly messages: readonly LLMMessage[];
  readonly state: SnipState;
  readonly nowMs: number;
  readonly gapMs?: number;
  readonly keepRecent?: number;
}

interface SnipResult {
  readonly action: "noop" | "snipped";
  readonly messages: readonly LLMMessage[];
  readonly state: SnipState;
  readonly boundary?: LLMMessage;
  readonly preservedAttachments: readonly PreservedAttachment[];
}

export function applySnip(input: SnipInput): SnipResult {
  const gapMs = input.gapMs ?? DEFAULT_SNIP_GAP_MS;
  const keepRecent = input.keepRecent ?? DEFAULT_SNIP_KEEP_RECENT;
  const messages = input.messages;
  const idleFor = input.nowMs - input.state.lastTouchMs;

  // Always touch the timestamp on entry — even no-ops should reset the
  // idle clock so the next snip decision uses the latest activity time.
  const nextState: SnipState = {
    lastTouchMs: input.nowMs,
    snipCount: input.state.snipCount,
  };

  if (
    input.state.lastTouchMs === 0 ||
    idleFor < gapMs ||
    messages.length <= keepRecent
  ) {
    return {
      action: "noop",
      messages,
      state: nextState,
      preservedAttachments: [],
    };
  }

  const dropped = messages.length - keepRecent;
  const trimmed = messages.slice(messages.length - keepRecent);

  return {
    action: "snipped",
    messages: trimmed,
    state: { ...nextState, snipCount: input.state.snipCount + 1 },
    boundary: makeBoundary(dropped, idleFor),
    preservedAttachments: collectPreservedAttachments(messages.slice(0, dropped)),
  };
}

function makeBoundary(dropped: number, idleMs: number): LLMMessage {
  // Boundary messages use the `[<layer>]` content prefix as their tag —
  // see COMPACT_BOUNDARY_SUBTYPE for the canonical layer string. The
  // executor filters these out before sending to the model.
  void COMPACT_BOUNDARY_SUBTYPE;
  return {
    role: "system",
    content:
      `[snip] dropped ${dropped} oldest messages after ${Math.round(idleMs / 1000)}s of idle time`,
  };
}

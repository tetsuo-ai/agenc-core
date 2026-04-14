/**
 * Reactive compact layer — fired when a model call returns a withheld
 * 413 (`prompt_too_long`) or `max_output_tokens` overflow. Mirrors
 * `claude_code/services/compact/reactiveCompact.ts`.
 *
 * Unlike autocompact, this is suffix-preserving: it walks the head of
 * the message array and trims the *oldest* messages first, then
 * retries the model call. The first attempt drops the oldest 25%; if
 * that still 413s, drop another 25%; etc.
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
import { COMPACT_BOUNDARY_SUBTYPE } from "./constants.js";

const REACTIVE_COMPACT_TRIM_FRACTIONS = [0.25, 0.5, 0.75] as const;

export interface ReactiveCompactState {
  readonly attemptIndex: number;
  readonly lastTriggerMs: number | null;
}

export function createReactiveCompactState(): ReactiveCompactState {
  return { attemptIndex: 0, lastTriggerMs: null };
}

interface ReactiveCompactInput {
  readonly messages: readonly LLMMessage[];
  readonly state: ReactiveCompactState;
  readonly nowMs?: number;
}

interface ReactiveCompactResult {
  readonly action: "noop" | "trimmed" | "exhausted";
  readonly messages: readonly LLMMessage[];
  readonly state: ReactiveCompactState;
  readonly boundary?: LLMMessage;
  readonly preservedAttachments: readonly PreservedAttachment[];
}

/**
 * Drops a fraction of the oldest messages to make the next model call
 * fit within the prompt cap. Returns `exhausted` once we've dropped as
 * much as we're willing to — at that point the runtime should surface
 * an error to the user rather than continue trimming.
 */
export function applyReactiveCompact(
  input: ReactiveCompactInput,
): ReactiveCompactResult {
  if (input.state.attemptIndex >= REACTIVE_COMPACT_TRIM_FRACTIONS.length) {
    return {
      action: "exhausted",
      messages: input.messages,
      state: input.state,
      preservedAttachments: [],
    };
  }
  const fraction =
    REACTIVE_COMPACT_TRIM_FRACTIONS[input.state.attemptIndex] ?? 0.25;
  const dropCount = Math.floor(input.messages.length * fraction);
  if (dropCount <= 0) {
    return {
      action: "noop",
      messages: input.messages,
      state: input.state,
      preservedAttachments: [],
    };
  }

  const trimmed = input.messages.slice(dropCount);
  return {
    action: "trimmed",
    messages: trimmed,
    state: {
      attemptIndex: input.state.attemptIndex + 1,
      lastTriggerMs: input.nowMs ?? Date.now(),
    },
    preservedAttachments: collectPreservedAttachments(
      input.messages.slice(0, dropCount),
    ),
    boundary: {
      role: "system",
      content:
        `[reactive-compact] trimmed ${dropCount} oldest messages (attempt ${input.state.attemptIndex + 1})`,
    },
  };
}

// Boundary tagging is encoded in the `[reactive-compact]` content prefix.
void COMPACT_BOUNDARY_SUBTYPE;

/**
 * Reset the attempt counter once a model call succeeds — the next
 * 413 should start fresh from the smallest trim fraction.
 */

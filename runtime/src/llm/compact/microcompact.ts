/**
 * Microcompact layer — replaces the body of cold tool-result messages
 * with a placeholder so the model doesn't pay token cost to recall
 * stale tool output.
 *
 * Mirrors `claude_code/services/compact/microcompact.ts` (cached path).
 *
 * Cut 5.1 of the claude_code-alignment refactor.
 *
 * @module
 */

import type { LLMMessage } from "../types.js";
import type { PreservedAttachment } from "./attachments.js";
import {
  COMPACT_BOUNDARY_SUBTYPE,
  DEFAULT_MICROCOMPACT_GAP_MS,
} from "./constants.js";

const STALE_TOOL_RESULT_PLACEHOLDER =
  "[microcompact] tool result content cleared (cold)";

export interface MicrocompactState {
  readonly lastTouchMs: number;
  readonly clearedToolUseIds: ReadonlySet<string>;
  readonly compactCount: number;
}

export function createMicrocompactState(): MicrocompactState {
  return {
    lastTouchMs: 0,
    clearedToolUseIds: new Set<string>(),
    compactCount: 0,
  };
}

interface MicrocompactInput {
  readonly messages: readonly LLMMessage[];
  readonly state: MicrocompactState;
  readonly nowMs: number;
  readonly gapMs?: number;
}

interface MicrocompactResult {
  readonly action: "noop" | "microcompacted";
  readonly messages: readonly LLMMessage[];
  readonly state: MicrocompactState;
  readonly boundary?: LLMMessage;
  readonly preservedAttachments: readonly PreservedAttachment[];
}

/**
 * If the gap since the previous touch exceeds `gapMs`, walk every
 * tool-result message older than the most recent few turns and
 * replace its content with a short placeholder. The result is
 * deterministic across calls — re-running on a previously
 * microcompacted history is a no-op.
 */
export function applyMicrocompact(
  input: MicrocompactInput,
): MicrocompactResult {
  const gapMs = input.gapMs ?? DEFAULT_MICROCOMPACT_GAP_MS;
  const idleFor = input.nowMs - input.state.lastTouchMs;
  const nextState: MicrocompactState = {
    lastTouchMs: input.nowMs,
    clearedToolUseIds: input.state.clearedToolUseIds,
    compactCount: input.state.compactCount,
  };

  if (input.state.lastTouchMs === 0 || idleFor < gapMs) {
    return {
      action: "noop",
      messages: input.messages,
      state: nextState,
      preservedAttachments: [],
    };
  }

  const messages = input.messages.slice();
  const cleared = new Set<string>(input.state.clearedToolUseIds);
  let clearedNow = 0;
  // Don't touch the most recent 6 messages — those carry the active
  // turn's tool input/output and the model still needs them.
  const cutoff = Math.max(0, messages.length - 6);
  for (let i = 0; i < cutoff; i++) {
    const message = messages[i];
    if (!message || message.role !== "tool") continue;
    const toolUseId = (message as { tool_call_id?: string }).tool_call_id;
    if (toolUseId && cleared.has(toolUseId)) continue;
    if (typeof message.content === "string" && message.content.length > 256) {
      messages[i] = {
        ...message,
        content: STALE_TOOL_RESULT_PLACEHOLDER,
      };
      if (toolUseId) cleared.add(toolUseId);
      clearedNow++;
    }
  }

  if (clearedNow === 0) {
    return {
      action: "noop",
      messages: input.messages,
      state: nextState,
      preservedAttachments: [],
    };
  }

  return {
    action: "microcompacted",
    messages,
    state: {
      lastTouchMs: input.nowMs,
      clearedToolUseIds: cleared,
      compactCount: input.state.compactCount + 1,
    },
    preservedAttachments: [],
    boundary: {
      role: "system",
      content:
        `[microcompact] cleared ${clearedNow} cold tool result(s) after ${Math.round(idleFor / 1000)}s idle`,
    },
  };
}

// Boundary tagging is encoded in the `[microcompact]` content prefix —
// see COMPACT_BOUNDARY_SUBTYPE for the canonical layer name. Executor
// filters boundary messages by prefix before sending to the model.
void COMPACT_BOUNDARY_SUBTYPE;
